// G47：助手运行生命周期与预算模块，自 assistant.js 纯搬运；行为不变。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { classifyAssistantIntent, runAssistantTool } from './assistant-tools.js';
import { MAX_MODEL_CALLS, MAX_RUN_COST_USD, MAX_RUN_MS, MAX_RUN_TOKENS, MAX_TOOL_CALLS, TOOL_TIMEOUT_MS, assistantExecutionMode, estimatedModelCost, finiteDurationMs, measuredDurationMs, modelRates, modelTimeoutMs, q19AcceptanceHooksEnabled, safeProviderResponseId } from './assistant-config.js';
import { db, json, now, transaction } from './db.js';
import { AppError } from './errors.js';
import { decideGraphModelReservation, estimateGraphInput, graphBudgetRemaining, releaseGraphCostReservation } from './graph-budget.js';
import { ModelRequestError, requestChatCompletion } from './model-adapter.js';
import { assertSessionOwner, assertSessionStatus, contextForExistingSession, getOrCreateSession, normalizedClientRequestId, recordGuestHealthIntake, validateText } from './assistant-session.js';
import { stableJson } from './stable-json.js';
import { WELLNESS_DRAFT_COORDINATION_TASK } from './assistant-agents.js';

export async function createAssistantRun({ user, role, sessionId, text, guestId, clientRequestId, coordinationTask = null,
  forceDomainCollaboration = false }) {
  const value = validateText(text);
  const requestId = normalizedClientRequestId(clientRequestId);
  const existing = await db.prepare('SELECT * FROM agent_runs WHERE client_request_id=?').get(requestId);
  if (existing) {
    const session = await db.prepare('SELECT * FROM assistant_sessions WHERE id=?').get(existing.session_id);
    if (!session) throw new AppError(404, 'ASSISTANT_RUN_NOT_FOUND', '助手运行记录不存在');
    assertSessionOwner(session, user, role);
    await assertSessionStatus(session);
    await contextForExistingSession(session, user, role, guestId);
    return { run: existing, session, duplicate: true, text: value };
  }
  // getOrCreateSession checks the caller's identity and guest assignment before
  // either the message or the run is persisted.
  const { row, relatedGuestId } = await getOrCreateSession({ user, role, sessionId, guestId });
  const runId = `run_${crypto.randomUUID()}`;
  const timestamp = now();
  const intent = classifyAssistantIntent(value);
  const q20ReadOnlyGraph = process.env.NODE_ENV === 'test' && process.env.Q20_ACCEPTANCE_HOOKS === '1'
    && forceDomainCollaboration === true;
  const agentInput = role === 'guest' && coordinationTask === WELLNESS_DRAFT_COORDINATION_TASK
    ? JSON.stringify({ coordinationTask })
    : q20ReadOnlyGraph ? JSON.stringify({ q20ReadOnlyGraph: true }) : JSON.stringify({});
  // G25：run/用户消息/会话时间戳三条写入原子化，避免部分写入后失败留下半截运行。
  await transaction(async () => {
    await db.prepare(`INSERT INTO agent_runs
      (id,session_id,actor_id,assistant_role,client_request_id,intent_category,status,input_text,created_at,updated_at,agent_input_json)
      VALUES(?,?,?,?,?,?,'queued',?,?,?,?)`)
      .run(runId, row.id, user?.id || null, role, requestId, intent.category, value, timestamp, timestamp, agentInput);
    await db.prepare('INSERT INTO assistant_messages(session_id,user_id,role,content,created_at,run_id) VALUES(?,?,?,?,?,?)')
      .run(row.id, user?.id || null, 'user', value, timestamp, runId);
    await db.prepare('UPDATE assistant_sessions SET last_message_at=? WHERE id=?').run(timestamp, row.id);
  });
  // Coordination prompts are generated from persisted source records. They are
  // not guest-authored statements and must not become new pending health intake.
  if (!coordinationTask) await recordGuestHealthIntake({ user, sessionId: row.id, text: value });
  const run = await db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId);
  return { run, session: row, relatedGuestId, duplicate: false, text: value };
}

export async function nextStepIndex(runId) {
  const row = await db.prepare('SELECT COALESCE(MAX(step_index),0) AS stepIndex FROM agent_steps WHERE run_id=?').get(runId);
  return Number(row?.stepIndex || 0) + 1;
}

export async function insertStep(runId, stepIndex, { type, status, summary = '', sources = [], diagnostic = null, inputTokens = 0, outputTokens = 0, cost = 0, errorCode = null, startedAt, completedAt, durationMs }) {
  await db.prepare(`INSERT INTO agent_steps
    (run_id,step_index,step_type,status,summary,source_json,diagnostic_json,input_tokens,output_tokens,estimated_cost_usd,error_code,started_at,completed_at,duration_ms)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, stepIndex, type, status, summary,
    JSON.stringify(sources), JSON.stringify(diagnostic || {}), inputTokens, outputTokens, cost, errorCode, startedAt, completedAt || null, durationMs ?? null);
  return await db.prepare('SELECT id FROM agent_steps WHERE run_id=? AND step_index=?').get(runId, stepIndex);
}

export async function loadActorForRun(run) {
  if (!run.actor_id) return null;
  const user = await db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(run.actor_id);
  if (!user || user.role !== run.assistant_role) throw new AppError(403, 'ASSISTANT_RUN_IDENTITY_INVALID', '运行身份已失效');
  return user;
}

export async function loadCompletedToolExecution(runId, idempotencyKey) {
  return await db.prepare('SELECT * FROM tool_executions WHERE run_id=? AND idempotency_key=?').get(runId, idempotencyKey);
}

export async function saveToolExecution({ runId, stepId, toolName, callId, idempotencyKey, args, outcome, startedAt }) {
  const existing = await loadCompletedToolExecution(runId, idempotencyKey);
  if (existing?.status === 'completed') {
    const data = json(existing.result_json, {});
    const sources = json(existing.source_json, []);
    await insertStep(runId, await nextStepIndex(runId), {
      type: 'tool', status: 'reused', summary: `复用已完成的只读查询：${toolName}`,
      sources, startedAt: now(), completedAt: now(), durationMs: finiteDurationMs(existing.duration_ms)
    });
    return { toolCallId: callId, data, sources, status: 'completed', reused: true };
  }
  const stepIndex = await nextStepIndex(runId);
  const startStamp = startedAt || now();
  const endStamp = now();
  const step = await insertStep(runId, stepIndex, {
    type: 'tool', status: outcome.status === 'completed' ? 'completed' : 'failed',
    summary: outcome.status === 'completed' ? `完成只读查询：${toolName}` : `只读查询未完成：${toolName}`,
    sources: outcome.sources, errorCode: outcome.errorCode,
    startedAt: startStamp, completedAt: endStamp, durationMs: finiteDurationMs(outcome.durationMs)
  });
  const executionId = `tool_${crypto.randomUUID()}`;
  if (existing) {
    await db.prepare(`UPDATE tool_executions SET step_id=?,tool_call_id=?,arguments_json=?,result_json=?,source_json=?,status=?,error_code=?,started_at=?,completed_at=?,duration_ms=?
      WHERE id=?`).run(step.id, callId, JSON.stringify(args), JSON.stringify(outcome.data), JSON.stringify(outcome.sources), outcome.status,
      outcome.errorCode || null, startStamp, endStamp, finiteDurationMs(outcome.durationMs), existing.id);
  } else {
    await db.prepare(`INSERT INTO tool_executions
      (id,run_id,step_id,tool_name,tool_call_id,idempotency_key,arguments_json,result_json,source_json,status,error_code,started_at,completed_at,duration_ms)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(executionId, runId, step.id, toolName, callId, idempotencyKey,
      JSON.stringify(args), JSON.stringify(outcome.data), JSON.stringify(outcome.sources), outcome.status,
      outcome.errorCode || null, startStamp, endStamp, finiteDurationMs(outcome.durationMs));
  }
  return { toolCallId: callId, data: outcome.data, sources: outcome.sources, status: outcome.status, reused: false };
}

export function executeQ19WriteOnce(args) {
  const startedAt = performance.now();
  const effectPath = process.env.Q19_TEST_EFFECT_PATH;
  const effectRoot = process.env.Q19_TEST_EFFECT_ROOT;
  const root = effectRoot ? path.resolve(effectRoot) : '';
  const target = effectPath && root ? path.resolve(root, effectPath.replaceAll('{driver}', process.env.DB_DRIVER || 'sqlite')) : '';
  if (!q19AcceptanceHooksEnabled() || !target || !root || !target.startsWith(`${root}${path.sep}`)) {
    return { status: 'failed', errorCode: 'TOOL_FORBIDDEN', data: { error: '测试写入桩不可用。' }, sources: [] };
  }
  if (!args || Object.keys(args).some(key => key !== 'note') || typeof args.note !== 'string' || args.note.length > 80) {
    return { status: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID', data: { error: '测试写入参数无效。' }, sources: [] };
  }
  let writeCount = 0;
  try {
    const previous = JSON.parse(fs.readFileSync(target, 'utf8'));
    writeCount = Number(previous.writeCount || 0);
  } catch { /* the first call creates the test-only side effect */ }
  writeCount += 1;
  const data = { writeCount, note: args.note, committed: true };
  fs.writeFileSync(target, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  return { status: 'completed', data, sources: [{ type: 'test_fixture', id: 'q19-write-once', label: '隔离验收写入桩' }],
    durationMs: measuredDurationMs(startedAt) };
}

export async function executeToolCall({ runId, sessionId, call, user, role, guestId, timeoutMs = TOOL_TIMEOUT_MS }) {
  const callId = typeof call.id === 'string' && call.id && call.id.length <= 128 ? call.id : `invalid-${crypto.randomUUID()}`;
  let args;
  try {
    if (typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments, 'utf8') > 16_384) throw new Error('invalid arguments');
    args = JSON.parse(call.arguments);
  } catch {
    return await saveToolExecution({ runId, toolName: String(call.name || 'unknown').slice(0, 64), callId,
      idempotencyKey: crypto.createHash('sha256').update(`${runId}\0invalid\0${callId}`).digest('hex'), args: {},
      outcome: { status: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID', data: { error: '工具参数格式不正确。' }, sources: [] } });
  }
  let idempotencyKey;
  try {
    idempotencyKey = crypto.createHash('sha256').update(`${runId}\0${call.name}\0${stableJson(args)}`).digest('hex');
  } catch { idempotencyKey = crypto.createHash('sha256').update(`${runId}\0${callId}`).digest('hex'); }
  const prior = await loadCompletedToolExecution(runId, idempotencyKey);
  if (prior?.status === 'completed') {
    const data = json(prior.result_json, {});
    const sources = json(prior.source_json, []);
    await insertStep(runId, await nextStepIndex(runId), { type: 'tool', status: 'reused', summary: `复用已完成的只读查询：${call.name}`, sources, startedAt: now(), completedAt: now(), durationMs: finiteDurationMs(prior.duration_ms) });
    return { toolCallId: callId, data, sources, status: 'completed', reused: true };
  }
  const start = now();
  let outcome;
  if (call.name === 'q19_test_write_once' && role === 'public' && q19AcceptanceHooksEnabled()) {
    outcome = executeQ19WriteOnce(args);
  } else {
    const injectEnvironmentTimeout = q19AcceptanceHooksEnabled()
      && call.name === 'get_environment_snapshot'
      && process.env.Q19_TEST_ENV_TOOL_TIMEOUT_MS;
    const testExecutor = injectEnvironmentTimeout ? async (_tool, _args, _context, signal) => await new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ data: { injected: true }, sources: [] }), 60_000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('TOOL_TIMEOUT')); }, { once: true });
    }) : undefined;
    outcome = await runAssistantTool(call.name, args, { user, role, guestId, sessionId, runId,
      timeoutMs: injectEnvironmentTimeout ? Number(process.env.Q19_TEST_ENV_TOOL_TIMEOUT_MS) : timeoutMs,
      executor: testExecutor });
  }
  return await saveToolExecution({ runId, toolName: String(call.name || 'unknown').slice(0, 64), callId, idempotencyKey, args, outcome, startedAt: start });
}

export async function finishRun(runId, { status, output, errorCode = null, stopReason = null, live = false,
  executionMode = null, model = null, provider = null, inputTokens = 0, outputTokens = 0, estimatedCost = 0 }) {
  const timestamp = now();
  const sourceMode = executionMode || (live ? assistantExecutionMode() : (errorCode === 'MODEL_NOT_CONFIGURED' ? 'fallback' : 'safe_guidance'));
  const terminalReason = stopReason || errorCode || (status === 'completed' ? 'RESPONSE_COMPLETED' : status === 'failed' ? 'RUN_FAILED' : null);
  await db.prepare(`UPDATE agent_runs SET status=?,output_text=?,error_code=?,stop_reason=?,is_live=?,execution_mode=?,model_name=?,provider=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,updated_at=?,completed_at=? WHERE id=?`)
    .run(status, output, errorCode, terminalReason, sourceMode === 'live' ? 1 : 0, sourceMode, model, provider,
      inputTokens, outputTokens, estimatedCost, timestamp, timestamp, runId);
  const run = await db.prepare('SELECT session_id,actor_id,assistant_role FROM agent_runs WHERE id=?').get(runId);
  if (output) {
    await db.prepare('INSERT INTO assistant_messages(session_id,user_id,role,content,created_at,run_id) VALUES(?,?,?,?,?,?)')
      .run(run.session_id, run.actor_id, 'assistant', output, timestamp, runId);
    await db.prepare('UPDATE assistant_sessions SET last_message_at=?,mode=?,model_name=? WHERE id=?')
      .run(timestamp, sourceMode, model, run.session_id);
  }
  return await db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId);
}

export class GraphBudgetError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function createGraphBudget(signal, maxModelCalls = MAX_MODEL_CALLS) {
  const startedAt = performance.now();
  return {
    graphRunId: null,
    startedAt,
    deadlineAt: startedAt + MAX_RUN_MS,
    maxModelCalls,
    maxToolCalls: MAX_TOOL_CALLS,
    maxTokens: MAX_RUN_TOKENS,
    maxCost: MAX_RUN_COST_USD,
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    reservedTokens: 0,
    reservedCostUsd: 0,
    decisions: [],
    persistenceTail: Promise.resolve(),
    signal
  };
}

export function graphBudgetState(budget) {
  const remaining = graphBudgetRemaining(budget);
  return {
    consumed: { inputTokens: budget.inputTokens, outputTokens: budget.outputTokens,
      totalTokens: budget.inputTokens + budget.outputTokens, estimatedCostUsd: budget.estimatedCostUsd },
    inFlight: { reservedTokens: budget.reservedTokens, reservedCostUsd: budget.reservedCostUsd },
    remaining: { tokens: remaining.tokens, estimatedCostUsd: remaining.costUsd },
    modelCalls: { used: budget.modelCalls, limit: budget.maxModelCalls,
      remaining: Math.max(0, budget.maxModelCalls - budget.modelCalls) },
    toolCalls: { used: budget.toolCalls, limit: budget.maxToolCalls,
      remaining: Math.max(0, budget.maxToolCalls - budget.toolCalls) },
    limits: { maxRuntimeMs: MAX_RUN_MS, maxModelCalls: budget.maxModelCalls,
      maxToolCalls: budget.maxToolCalls, maxTokens: budget.maxTokens, maxEstimatedCostUsd: budget.maxCost },
    runtimeRemainingMs: Math.max(0, budget.deadlineAt - performance.now())
  };
}

export async function persistGraphBudgetDecision(budget, { runId, agentId, ...details }) {
  const decision = { index: budget.decisions.length + 1, graphRunId: budget.graphRunId,
    runId, agentId, recordedAt: now(), ...details };
  budget.decisions.push(decision);
  const persist = budget.persistenceTail.then(async () => {
    const row = await db.prepare('SELECT orchestration_json AS orchestrationJson FROM agent_runs WHERE id=?').get(budget.graphRunId);
    if (!row) throw new Error('graph budget audit parent run is missing');
    const orchestration = json(row.orchestrationJson, {});
    orchestration.budgetDecisions = budget.decisions;
    await db.prepare('UPDATE agent_runs SET orchestration_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(orchestration), now(), budget.graphRunId);
  });
  budget.persistenceTail = persist;
  try {
    await persist;
  } catch (error) {
    throw Object.assign(new Error('graph budget decision could not be persisted'), {
      code: 'GRAPH_BUDGET_AUDIT_PERSIST_FAILED', cause: error
    });
  }
  return decision;
}

export async function reserveGraphModelCall(budget, { runId, agentId, messages, tools, toolChoice, responseFormat, desiredOutputTokens }) {
  const input = estimateGraphInput(messages, tools, toolChoice, responseFormat);
  const rates = modelRates(process.env.LLM_MODEL);
  const decision = decideGraphModelReservation({ budget, estimatedInputTokens: input.estimatedInputTokens,
    requestedOutputTokens: desiredOutputTokens, rates, signalAborted: budget.signal.aborted });
  const reservationId = `${budget.graphRunId}:${budget.decisions.length + 1}`;
  const before = graphBudgetState(budget);
  if (decision.allowed) {
    budget.modelCalls += 1;
    budget.reservedTokens += decision.reservation.tokens;
    budget.reservedCostUsd += decision.reservation.costUsd;
  }
  const after = graphBudgetState(budget);
  try {
    await persistGraphBudgetDecision(budget, {
      runId, agentId, reservationId, phase: 'reservation',
      outcome: decision.allowed ? 'reserved' : 'rejected',
      rejectionCode: decision.rejectionCode,
      providerRequestSent: false,
      request: { messageBytes: input.messageBytes, estimatedInputTokens: input.estimatedInputTokens,
        requestedOutputTokens: desiredOutputTokens, toolCount: tools.length },
      reservation: decision.reservation ? { ...decision.reservation, maxOutputTokens: decision.maxOutputTokens } : null,
      remainingBefore: decision.remainingBefore,
      remainingAfterInput: decision.remainingAfterInput,
      remainingAfterReservation: decision.remainingAfterReservation || null,
      stateBefore: before, stateAfter: after
    });
  } catch (error) {
    if (decision.allowed) {
      budget.modelCalls = Math.max(0, budget.modelCalls - 1);
      budget.reservedTokens = Math.max(0, budget.reservedTokens - decision.reservation.tokens);
      budget.reservedCostUsd = releaseGraphCostReservation(budget.reservedCostUsd, decision.reservation.costUsd);
    }
    throw error;
  }
  if (!decision.allowed) throw new GraphBudgetError(decision.rejectionCode);
  return { maxTokens: decision.maxOutputTokens, reservation: decision.reservation, reservationId,
    estimatedInputTokens: input.estimatedInputTokens,
    timeoutMs: Math.max(1, Math.min(modelTimeoutMs, budget.deadlineAt - performance.now())) };
}

export function recordGraphModelUsage(budget, response, estimatedInputTokens, maxTokens, reservation) {
  const inputTokens = response.usage.inputTokens ?? estimatedInputTokens;
  const outputTokens = response.usage.outputTokens ?? maxTokens;
  const estimatedCostUsd = estimatedModelCost(inputTokens, outputTokens, response.model || process.env.LLM_MODEL);
  budget.reservedTokens = Math.max(0, budget.reservedTokens - reservation.tokens);
  budget.reservedCostUsd = releaseGraphCostReservation(budget.reservedCostUsd, reservation.costUsd);
  budget.inputTokens += inputTokens;
  budget.outputTokens += outputTokens;
  budget.estimatedCostUsd += estimatedCostUsd;
  return { inputTokens, outputTokens, estimatedCostUsd };
}

export async function requestGraphModel({ runId, agentId, messages, tools = [], toolChoice = 'auto', responseFormat = null,
  thinkingMode, budget, summary, maxTokens = 512, usage }) {
  const reserved = await reserveGraphModelCall(budget, { runId, agentId, messages, tools, toolChoice, responseFormat,
    desiredOutputTokens: maxTokens });
  const stepStart = performance.now();
  let stepIndex = null;
  let stepInserted = false;
  let requestAttempted = false;
  let reservationReleased = false;
  let modelResponseReceived = false;
  let providerRequestStartedAt = null;
  let providerResponseReceivedAt = null;
  try {
    stepIndex = await nextStepIndex(runId);
    await insertStep(runId, stepIndex, { type: 'model', status: 'running', summary,
      diagnostic: { providerRequestAttempted: false }, startedAt: now() });
    stepInserted = true;
    providerRequestStartedAt = new Date().toISOString();
    await db.prepare('UPDATE agent_steps SET diagnostic_json=? WHERE run_id=? AND step_index=?')
      .run(JSON.stringify({ providerRequestAttempted: true, providerRequestStartedAt }), runId, stepIndex);
    requestAttempted = true;
    const response = await requestChatCompletion({ messages, tools, toolChoice, timeoutMs: reserved.timeoutMs,
      signal: budget.signal, maxTokens: reserved.maxTokens, responseFormat, thinkingMode });
    providerResponseReceivedAt = new Date().toISOString();
    modelResponseReceived = true;
    const cost = recordGraphModelUsage(budget, response, reserved.estimatedInputTokens,
      reserved.maxTokens, reserved.reservation);
    reservationReleased = true;
    const inputUsageReported = Number.isSafeInteger(response.usage?.inputTokens) && response.usage.inputTokens >= 0;
    const outputUsageReported = Number.isSafeInteger(response.usage?.outputTokens) && response.usage.outputTokens >= 0;
    const usageSource = process.env.ASSISTANT_MODEL_SOURCE === 'recorded_fixture'
      ? 'recorded_fixture' : 'provider_reported';
    await db.prepare(`UPDATE agent_steps SET status='completed',summary=?,diagnostic_json=?,input_tokens=?,output_tokens=?,estimated_cost_usd=?,completed_at=?,duration_ms=?
      WHERE run_id=? AND step_index=?`).run(
      response.message.toolCalls.length ? `${summary}；产生 ${response.message.toolCalls.length} 个只读工具调用` : `${summary}；模型响应完成`,
      JSON.stringify({ providerRequestAttempted: true, finishReason: response.finishReason || null,
        providerResponseId: safeProviderResponseId(response.id),
        providerRequestStartedAt, providerResponseReceivedAt,
        responseFormat: responseFormat?.type || null,
        usageReported: inputUsageReported && outputUsageReported,
        inputUsageSource: inputUsageReported ? usageSource : 'server_estimate',
        outputUsageSource: outputUsageReported ? usageSource : 'server_estimate' }),
      cost.inputTokens, cost.outputTokens, cost.estimatedCostUsd, now(), measuredDurationMs(stepStart), runId, stepIndex);
    await persistGraphBudgetDecision(budget, {
      runId, agentId, reservationId: reserved.reservationId, phase: 'settlement', outcome: 'released',
      requestAttempted, providerRequestSent: true,
      actualUsage: { inputTokens: cost.inputTokens, outputTokens: cost.outputTokens,
        estimatedCostUsd: cost.estimatedCostUsd },
      reservation: reserved.reservation, stateAfter: graphBudgetState(budget)
    });
    usage.inputTokens += cost.inputTokens;
    usage.outputTokens += cost.outputTokens;
    usage.estimatedCostUsd += cost.estimatedCostUsd;
    usage.model = response.model || usage.model;
    usage.provider = response.provider || usage.provider;
    await db.prepare(`UPDATE agent_runs SET input_tokens=?,output_tokens=?,estimated_cost_usd=?,model_name=?,provider=?,execution_mode=?,is_live=?,updated_at=? WHERE id=?`)
      .run(usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd, usage.model, usage.provider,
        usage.executionMode, usage.executionMode === 'live' ? 1 : 0, now(), runId);
    return response;
  } catch (error) {
    if (!reservationReleased) {
      budget.reservedTokens = Math.max(0, budget.reservedTokens - reserved.reservation.tokens);
      budget.reservedCostUsd = releaseGraphCostReservation(budget.reservedCostUsd, reserved.reservation.costUsd);
      reservationReleased = true;
      await persistGraphBudgetDecision(budget, {
        runId, agentId, reservationId: reserved.reservationId, phase: 'settlement', outcome: 'released',
        requestAttempted, providerRequestSent: null,
        rejectionCode: error?.code || 'MODEL_REQUEST_FAILED', reservation: reserved.reservation,
        stateAfter: graphBudgetState(budget)
      });
    }
    const code = error?.code || (error instanceof ModelRequestError || error instanceof GraphBudgetError
      ? error.code : 'MODEL_REQUEST_FAILED');
    if (stepInserted && !modelResponseReceived) {
      await db.prepare(`UPDATE agent_steps SET status='failed',summary=?,error_code=?,diagnostic_json=?,completed_at=?,duration_ms=? WHERE run_id=? AND step_index=?`)
        .run(`${summary}未完成（${code}）`, code,
          JSON.stringify({ ...(error?.diagnostic || {}), providerRequestAttempted: requestAttempted,
            providerRequestStartedAt, providerResponseReceivedAt,
            usageReported: false, usageUnavailableReason: 'provider_request_did_not_return_usage' }),
          now(), measuredDurationMs(stepStart), runId, stepIndex);
    }
    throw error instanceof Error ? Object.assign(error, { code }) : new GraphBudgetError(code);
  }
}

export function agentCandidateIds(agentId, context) {
  if (!context) return [];
  if (agentId === 'domain.physio') return (context.evaluations || []).map(item => item.projectId);
  if (agentId === 'domain.nutrition') return (context.candidates || []).map(item => item.candidateId);
  if (agentId === 'domain.exercise') return (context.activities || []).map(item => item.projectId);
  if (agentId === 'domain.psychology') return (context.resources || []).map(item => item.id);
  return [];
}
