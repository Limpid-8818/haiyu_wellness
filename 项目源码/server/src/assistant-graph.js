// G47：助手四领域图编排模块，自 assistant.js 纯搬运；行为不变。
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { modelToolReply } from './agent-context-projection.js';
import { healthDisclosure } from './agent-presentation.js';
import { getAssistantToolDefinitions, runAssistantTool } from './assistant-tools.js';
import { MAX_MODEL_CALLS, MAX_RUN_COST_USD, MAX_RUN_MS, MAX_RUN_TOKENS, MAX_TOOL_CALLS, TOOL_TIMEOUT_MS, assistantExecutionMode, measuredDurationMs } from './assistant-config.js';
import { db, guestProfile, now } from './db.js';
import { toConversationMessage } from './model-adapter.js';
import { GraphBudgetError, agentCandidateIds, createGraphBudget, finishRun, insertStep, nextStepIndex, requestGraphModel, saveToolExecution } from './assistant-run.js';
import { stableJson } from './stable-json.js';
import { HOUSEHOLD_AGENT, WELLNESS_DRAFT_COORDINATION_TASK, buildCoordinatorSelectionContract, nextBusinessDate, parseStructuredAgentOutput, summarizeCoordinatorSelectionEvidence, validateCoordinatorSelection, validateCoordinatorSelectionForTask } from './assistant-agents.js';


export async function finishAgentRun(runId, { status, errorCode = null, stopReason = null, output = '', structuredOutput = {}, usage,
  runtimeStartedAt = null }) {
  const timestamp = now();
  const terminalReason = stopReason || errorCode || (status === 'completed' ? 'AGENT_COMPLETED' : status === 'failed' ? 'AGENT_FAILED' : null);
  const runtimeDurationMs = measuredDurationMs(runtimeStartedAt);
  const savedStructuredOutput = runtimeDurationMs === null ? structuredOutput
    : { ...structuredOutput, runtimeDurationMs };
  await db.prepare(`UPDATE agent_runs SET status=?,output_text=?,structured_output_json=?,error_code=?,stop_reason=?,model_name=?,provider=?,is_live=?,execution_mode=?,
      input_tokens=?,output_tokens=?,estimated_cost_usd=?,updated_at=?,completed_at=? WHERE id=?`)
    .run(status, output, JSON.stringify(savedStructuredOutput), errorCode, terminalReason, usage.model, usage.provider,
      usage.executionMode === 'live' ? 1 : 0, usage.executionMode, usage.inputTokens, usage.outputTokens,
      usage.estimatedCostUsd, timestamp, timestamp, runId);
  return await db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId);
}

export function failureText(code) {
  if (code === 'MODEL_NOT_CONFIGURED') return '模型服务未配置';
  if (code === 'GRAPH_RUNTIME_BUDGET') return '已达到本次协作运行时限';
  if (code === 'GRAPH_MODEL_CALL_BUDGET') return '已达到本次协作模型调用上限';
  if (code === 'GRAPH_TOKEN_BUDGET') return '已达到本次协作 token 预算上限';
  if (code === 'GRAPH_COST_BUDGET') return '已达到本次协作费用估算上限';
  if (code === 'AGENT_REQUIRED_TOOL_MISSING') return '必要的只读工具没有全部完成';
  if (code === 'AGENT_OUTPUT_INVALID') return '智能体没有返回有效的结构化候选';
  if (code === 'RUN_ABORTED') return '本次协作已停止';
  return '模型或只读数据暂时不可用';
}

export async function executeDomainAgent({ run, user, role, guestId, contract, agentInput, budget }) {
  const runtimeStartedAt = performance.now();
  const executionMode = assistantExecutionMode();
  const usage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
    model: process.env.LLM_MODEL || null, provider: null, executionMode };
  await db.prepare("UPDATE agent_runs SET status='running',execution_mode=?,updated_at=? WHERE id=?")
    .run(executionMode, now(), run.id);
  try {
    if (process.env.NODE_ENV === 'test' && process.env.Q20_ACCEPTANCE_HOOKS === '1'
      && process.env.Q20_TEST_FAIL_AGENT === contract.agentId) {
      return { run: await finishAgentRun(run.id, { status: 'failed', errorCode: 'INJECTED_AGENT_FAILURE',
        output: '领域子任务在验收注入点失败。', usage, runtimeStartedAt }), context: null, knowledge: null, structuredOutput: null };
    }
    const toolDefinitions = getAssistantToolDefinitions(role, { guestId, toolNames: contract.allowedTools, user });
    if (toolDefinitions.length !== contract.allowedTools.length) throw Object.assign(new Error('agent tool allowlist is unavailable'), { code: 'AGENT_TOOL_ALLOWLIST_UNAVAILABLE' });
    const system = `${contract.instruction}\nagentId=${contract.agentId}\ninstructionVersion=${contract.instructionVersion}\n` +
      `输入 schema：${JSON.stringify(contract.inputSchema)}\n输出 schema：${JSON.stringify(contract.outputSchema)}\n` +
      '先逐一调用白名单内的只读上下文工具与知识工具，再仅依据其结果返回候选 ID。不要回显个人身份信息或内部推理。';
    const userContent = JSON.stringify(agentInput);
    const firstMessages = [{ role: 'system', content: system }, { role: 'user', content: userContent }];
    const firstResponse = await requestGraphModel({ runId: run.id, agentId: contract.agentId,
      messages: firstMessages, tools: toolDefinitions,
      toolChoice: 'required', budget, usage, summary: `${contract.name}独立模型调用` });
    if (!firstResponse.message.toolCalls.length) throw Object.assign(new Error('model omitted the required read-only tools'), { code: 'AGENT_REQUIRED_TOOL_MISSING' });
    const results = [];
    const called = new Set();
    for (const call of firstResponse.message.toolCalls) {
      if (budget.signal.aborted || performance.now() >= budget.deadlineAt) throw new GraphBudgetError('GRAPH_RUNTIME_BUDGET');
      if (budget.toolCalls >= budget.maxToolCalls) throw new GraphBudgetError('GRAPH_TOOL_CALL_BUDGET');
      budget.toolCalls += 1;
      let args = {};
      try {
        if (typeof call.arguments !== 'string' || Buffer.byteLength(call.arguments, 'utf8') > 16_384) throw new Error('invalid arguments');
        args = JSON.parse(call.arguments);
        if (call.name === 'get_exercise_context') args.date = agentInput.date;
      } catch { args = null; }
      let outcome;
      if (!contract.allowedTools.includes(call.name)) {
        outcome = { status: 'failed', errorCode: 'TOOL_AGENT_FORBIDDEN', data: { error: '该领域任务不能使用此工具。' }, sources: [] };
      } else if (!args) {
        outcome = { status: 'failed', errorCode: 'TOOL_ARGUMENTS_INVALID', data: { error: '工具参数格式不正确。' }, sources: [] };
      } else {
        const remainingMs = Math.max(1, budget.deadlineAt - performance.now());
        outcome = await runAssistantTool(call.name, args, { user, role, guestId, timeoutMs: Math.min(TOOL_TIMEOUT_MS, remainingMs), signal: budget.signal });
      }
      called.add(call.name);
      const callId = typeof call.id === 'string' && call.id && call.id.length <= 128 ? call.id : `invalid-${crypto.randomUUID()}`;
      const idempotencyKey = crypto.createHash('sha256').update(`${run.id}\0${call.name}\0${stableJson(args || {})}`).digest('hex');
      const saved = await saveToolExecution({ runId: run.id, toolName: String(call.name || 'unknown').slice(0, 64), callId,
        idempotencyKey, args: args || {}, outcome, startedAt: now() });
      results.push({ ...saved, toolName: String(call.name || 'unknown').slice(0, 64) });
    }
    for (const name of contract.allowedTools) {
      if (!called.has(name) || !results.some(item => item.toolName === name && item.status === 'completed')) {
        throw Object.assign(new Error(`required tool did not complete: ${name}`), { code: 'AGENT_REQUIRED_TOOL_MISSING' });
      }
    }
    const contextTool = contract.allowedTools.find(name => name.endsWith('_context'));
    const knowledgeTool = contract.allowedTools.find(name => name.endsWith('_knowledge'));
    const contextResult = results.find(item => item.toolName === contextTool && item.status === 'completed');
    const knowledgeResult = results.find(item => item.toolName === knowledgeTool && item.status === 'completed');
    if (!contextResult || !knowledgeResult) throw Object.assign(new Error('required domain source unavailable'), { code: 'AGENT_REQUIRED_TOOL_MISSING' });
    const context = contextResult.data;
    const knowledge = knowledgeResult.data;
    const allowedIds = agentCandidateIds(contract.agentId, context);
    const secondMessages = [
      { role: 'system', content: `${system}\n现已取得全部工具结果。只返回 JSON: {"candidateIds":[...]}。只能选择上下文候选列表中的 ID；营养需覆盖早餐、午餐、晚餐（若存在安全候选），运动若存在安全候选至少选择一个，心理只选可播放的 guided 课程。被拒绝或要求复核的候选不得选择；没有安全候选时留空，不得编造。` },
      { role: 'user', content: userContent },
      toConversationMessage(firstResponse.message),
      ...results.map(item => ({ role: 'tool', toolCallId: item.toolCallId,
        content: JSON.stringify(modelToolReply(contract.agentId, item)) }))
    ];
    const secondResponse = await requestGraphModel({ runId: run.id, agentId: contract.agentId,
      messages: secondMessages, budget, usage,
      summary: `${contract.name}依据工具结果形成结构化候选`, maxTokens: 384 });
    const structuredOutput = parseStructuredAgentOutput(secondResponse.message.content, { allowedIds });
    if (!structuredOutput) throw Object.assign(new Error('model response does not match the structured output contract'), { code: 'AGENT_OUTPUT_INVALID' });
    const output = JSON.stringify(structuredOutput);
    return { run: await finishAgentRun(run.id, { status: 'completed', output, structuredOutput, usage, runtimeStartedAt }),
      context, knowledge, structuredOutput, toolResults: results };
  } catch (error) {
    const code = error?.code || (budget.signal.aborted ? 'RUN_ABORTED' : 'AGENT_RUN_FAILED');
    return { run: await finishAgentRun(run.id, { status: 'failed', errorCode: code,
      stopReason: code, output: failureText(code), structuredOutput: {}, usage, runtimeStartedAt }), context: null, knowledge: null, structuredOutput: null,
      toolResults: [] };
  }
}

export function candidateSources(...groups) {
  const output = [];
  const seen = new Set();
  for (const group of groups) for (const source of group || []) {
    if (!source?.type || source.id === undefined || source.id === null) continue;
    const key = `${source.type}:${source.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(source);
  }
  return output;
}

export function mergeDomainResult(contract, result) {
  if (!result.run || result.run.status !== 'completed' || !result.context || !result.structuredOutput) return [];
  const proposed = new Set(result.structuredOutput.candidateIds);
  const sources = (result.toolResults || []).flatMap(item => item.sources || []);
  const candidates = [];
  if (contract.agentId === 'domain.physio') {
    for (const item of result.context.evaluations || []) {
      const candidateId = item.projectId;
      if (!proposed.has(candidateId) && !item.matchedRules?.length) continue;
      const ruleReasons = (item.matchedRules || []).map(rule => `${rule.ruleId}：${rule.reason}`);
      const status = item.outcome === 'reject' ? 'rejected' : item.outcome === 'restrict' ? 'requires_review' : proposed.has(candidateId) ? 'adopted' : 'not_proposed';
      candidates.push({ candidateId, domain: 'physio', title: item.name, status,
        reason: status === 'rejected' ? `确定性规则拒绝：${ruleReasons.join('；')}`
          : status === 'requires_review' ? `确定性规则要求医护复核：${ruleReasons.join('；')}`
            : status === 'adopted' ? '项目目录与有效规则未发现需自动排除的命中；仍须现场核实。'
              : `模型未提出该项目；规则记录：${ruleReasons.join('；')}`,
        sourceIds: candidateSources(sources.filter(source => source.type === 'project' && source.id === candidateId),
          sources.filter(source => source.type === 'safety_rule' && (item.matchedRules || []).some(rule => rule.ruleId === source.id)),
          sources.filter(source => source.type === 'domain_knowledge'),
          sources.filter(source => source.type === 'guest_profile' || source.type === 'health_intake')),
        details: { projectId: candidateId, matchedRules: item.matchedRules || [], reviewRequired: item.reviewRequired } });
    }
  } else if (contract.agentId === 'domain.nutrition') {
    const selectedMeals = new Set();
    for (const item of result.context.candidates || []) {
      if (!proposed.has(item.candidateId)) continue;
      const duplicateMeal = selectedMeals.has(item.mealType);
      if (!duplicateMeal) selectedMeals.add(item.mealType);
      candidates.push({ candidateId: item.candidateId, domain: 'nutrition', title: item.dish.name,
        status: duplicateMeal ? 'rejected' : 'adopted', reason: duplicateMeal ? '同一餐次只保留一个候选。'
          : '菜品来自当前餐次目录；过敏、忌口和演示供货状态已由服务端确定性复核。',
        sourceIds: candidateSources(sources.filter(source => source.type === 'dish' && source.id === item.dish.id),
          sources.filter(source => source.type === 'domain_knowledge' || source.type === 'guest_profile' || source.type === 'health_intake')),
        details: { mealType: item.mealType, dishId: item.dish.id, dish: item.dish, supplyBoundary: result.context.supplyBoundary } });
    }
    for (const item of result.context.excluded || []) {
      const mealLabel = item.mealType === 'breakfast' ? '早餐' : item.mealType === 'lunch' ? '午餐' : '晚餐';
      candidates.push({ candidateId: `${item.mealType}:${item.dishId}`, domain: 'nutrition', title: item.dishName,
        status: 'rejected', reason: `${item.reason}；限制来源 ${item.restrictionSourceId || '客人档案'}`,
        sourceIds: candidateSources(sources.filter(source => source.type === 'dish' && source.id === item.dishId),
          sources.filter(source => (source.type === 'guest_profile' && source.id === item.restrictionSourceId)
            || (source.type === 'health_intake' && source.id === item.restrictionSourceId)
            || source.type === 'domain_knowledge')),
        details: { mealType: item.mealType, mealLabel, dishId: item.dishId, restrictionSourceId: item.restrictionSourceId } });
    }
  } else if (contract.agentId === 'domain.exercise') {
    const date = result.context.date;
    const existingSchedule = result.context.existingSchedule || [];
    for (const item of result.context.activities || []) {
      const proposedItem = proposed.has(item.projectId);
      const blockedRule = item.matchedRules?.some(rule => rule.action === 'reject');
      const restrictedRule = item.matchedRules?.some(rule => rule.action === 'restrict');
      if (!proposedItem && !blockedRule && !restrictedRule) continue;
      let status = 'adopted';
      let reason = '项目开放时间来自只读目录；系统没有创建预约。';
      if (blockedRule) {
        status = 'rejected';
        reason = `确定性规则拒绝：${item.matchedRules.filter(rule => rule.action === 'reject').map(rule => `${rule.ruleId}：${rule.reason}`).join('；')}`;
      } else if (restrictedRule) {
        status = 'requires_review';
        reason = `确定性规则要求人工复核：${item.matchedRules.filter(rule => rule.action === 'restrict').map(rule => `${rule.ruleId}：${rule.reason}`).join('；')}`;
      } else if (!proposedItem) {
        status = 'not_proposed';
        reason = '运动智能体未提出此项目。';
      } else if (item.availabilitySource === 'activity_slots'
        && !(item.openWindows || []).some(slot => !slot.closed && slot.availableCount > 0)) {
        status = 'rejected';
        reason = '指定日期没有开放且有余量的只读时段。';
      } else {
        const windows = item.openWindows || [];
        const overlaps = windows.some(window => existingSchedule.some(booked => {
          if (booked.projectId === item.projectId && item.availabilitySource === 'activity_slots') return true;
          const bookedStart = booked.localStart || String(booked.startsAt || '').slice(11, 16);
          const bookedEnd = booked.localEnd || String(booked.endsAt || '').slice(11, 16);
          return window.start < bookedEnd && bookedStart < window.end;
        }));
        if (overlaps) {
          status = 'rejected';
          reason = '與同日已確認日程的時間重疊，候選不採用。';
        } else if (item.availabilitySource === 'project.openWindows.demo') {
          reason = '時段來自項目演示开放窗口，尚非指定日期的实际排期，也不是预约确认。';
        }
      }
      candidates.push({ candidateId: item.projectId, domain: 'exercise', title: item.name, status, reason,
        sourceIds: candidateSources(sources.filter(source => source.type === 'project' && source.id === item.projectId),
          sources.filter(source => source.type === 'project_slot' || source.type === 'schedule'
            || source.type === 'guest_profile' || source.type === 'safety_rule' || source.type === 'domain_knowledge')),
        details: { projectId: item.projectId, date, windows: item.openWindows || [], availabilitySource: item.availabilitySource,
          matchedRules: item.matchedRules || [] } });
    }
  } else if (contract.agentId === 'domain.psychology') {
    const resources = new Map((result.context.resources || []).map(item => [item.id, item]));
    for (const candidateId of result.structuredOutput.candidateIds) {
      const resource = resources.get(candidateId);
      if (!resource) continue;
      candidates.push({ candidateId, domain: 'psychology', title: resource.title, status: 'adopted',
        reason: '课程来自当前可播放的引导资源目录；播放或使用次数不表示心理改善。',
        sourceIds: candidateSources(sources.filter(source => source.type === 'mood_resource' && source.id === candidateId),
          sources.filter(source => source.type === 'domain_knowledge' || source.type === 'mood_record' || source.type === 'mood_focus')),
        details: { resourceId: resource.id, audioUrl: resource.audioUrl, durationSeconds: resource.durationSeconds,
          resourceSource: resource.source, license: resource.license, humanAttentionItems: result.context.focusItems || [] } });
    }
  }
  return candidates;
}

export function candidateLabel(domain) {
  return ({ physio: '理疗', nutrition: '营养', exercise: '运动', psychology: '心理陪伴' })[domain] || domain;
}

export function deterministicGraphReply({ candidates, selectedIds, gaps, targetDate, executionMode, coordinatorError, fallbackSource }) {
  const selected = candidates.filter(item => item.status === 'adopted' && selectedIds.includes(item.candidateId));
  const lines = [];
  if (coordinatorError) {
    lines.push(`管家选择未完成（${coordinatorError}）。`);
    lines.push('回退来源：已完成专业领域智能体提供的只读安全候选；以下候选未经管家选择。');
    const fallbackCandidates = candidates.filter(item => item.status === 'adopted');
    for (const item of fallbackCandidates) lines.push(`• ${candidateLabel(item.domain)}领域候选：${item.title}`);
    if (!fallbackCandidates.length) lines.push(`目前没有可展示的领域候选（回退来源：${fallbackSource || 'none'}）。`);
  }
  const nutrition = selected.filter(item => item.domain === 'nutrition');
  if (nutrition.length) {
    lines.push(`${targetDate} 餐食候选（演示目录，未写入餐单）：`);
    for (const item of nutrition) {
      const meal = item.details.mealType === 'breakfast' ? '早餐' : item.details.mealType === 'lunch' ? '午餐' : '晚餐';
      lines.push(`• ${meal}：${item.title}`);
    }
  }
  const exercise = selected.filter(item => item.domain === 'exercise');
  if (exercise.length) {
    lines.push(`${targetDate} 活动候选：`);
    for (const item of exercise) {
      const windows = (item.details.windows || []).map(window => `${window.start}–${window.end}`).join('、');
      lines.push(`• ${item.title}${windows ? `，目录时间 ${windows}` : ''}（${item.details.availabilitySource === 'activity_slots' ? '只读排期' : '演示开放窗口'}）`);
    }
  }
  const physio = candidates.filter(item => item.domain === 'physio' && ['rejected', 'requires_review'].includes(item.status));
  if (physio.length) {
    lines.push('理疗项目复核：');
    for (const item of physio) lines.push(`• ${item.title}：${item.reason}`);
  }
  const nutritionRejected = candidates.filter(item => item.domain === 'nutrition' && item.status === 'rejected');
  if (nutritionRejected.length) {
    const shown = [...new Map(nutritionRejected.map(item => [item.details.dishId, item])).values()];
    lines.push(`已按明确限制排除：${shown.map(item => `${item.title}（${item.reason.split('；')[0]}）`).join('、')}。`);
  }
  const exerciseRejected = candidates.filter(item => item.domain === 'exercise' && item.status === 'rejected');
  if (exerciseRejected.length) {
    lines.push(`运动限制：${exerciseRejected.map(item => `${item.title}（${item.reason}）`).join('；')}`);
  }
  const psychology = selected.filter(item => item.domain === 'psychology');
  if (psychology.length) {
    lines.push(`陪伴资源：${psychology.map(item => item.title).join('、')}。可在下方展开协作轨迹后打开现有播放器。`);
    const focusItems = psychology.flatMap(item => item.details.humanAttentionItems || []);
    if (focusItems.some(item => item.status === 'open')) lines.push('记录中有按社区演示规则生成的待人工关注项，建议联系现场工作人员关心；这不是心理诊断。');
  }
  const other = selected.filter(item => !['nutrition', 'exercise', 'psychology'].includes(item.domain));
  if (other.length) lines.push(`理疗目录候选：${other.map(item => item.title).join('、')}。仍需现场核实，不代表医护批准或预约。`);
  for (const gap of gaps) lines.push(`${candidateLabel(gap.domain)}智能体未完成：${failureText(gap.errorCode)}；该领域结果仍缺失。`);
  if (!lines.length) lines.push('当前没有可采用的候选结果。请联系工作人员核对资料后再试。');
  lines.push('以上均为只读候选，不会创建预约、餐单或改变既有日程。');
  if (executionMode === 'recorded_fixture') lines.push('本次结果来自录制模型夹具，不是外部真实模型调用。');
  return lines.join('\n');
}

export async function executeCoordinatedRun({ run, user, role, guestId, contracts, controller, stopAt, started, coordinationTask = null }) {
  const executionMode = assistantExecutionMode();
  // Domain agents and the coordinator share the configured per-run call cap.
  const graphModelCallLimit = MAX_MODEL_CALLS;
  const budget = createGraphBudget(controller.signal, graphModelCallLimit);
  budget.graphRunId = run.id;
  await db.prepare(`UPDATE agent_runs SET agent_id=?,instruction_version=?,agent_input_json=?,execution_mode=?,is_live=?,updated_at=? WHERE id=?`)
    .run(HOUSEHOLD_AGENT.agentId, HOUSEHOLD_AGENT.instructionVersion,
      JSON.stringify({ request: run.input_text, selectedAgentIds: contracts.map(item => item.agentId),
        ...(coordinationTask === WELLNESS_DRAFT_COORDINATION_TASK ? { coordinationTask } : {}) }), executionMode,
      executionMode === 'live' ? 1 : 0, now(), run.id);
  const date = nextBusinessDate(now());
  const children = [];
  for (const contract of contracts) {
    const childRunId = `run_${crypto.randomUUID()}`;
    const childInput = { request: run.input_text, ...(contract.domain === 'nutrition' || contract.domain === 'exercise' ? { date } : {}) };
    const timestamp = now();
    const childText = JSON.stringify(childInput);
    await db.prepare(`INSERT INTO agent_runs
      (id,session_id,actor_id,assistant_role,client_request_id,intent_category,status,input_text,created_at,updated_at,
       parent_run_id,agent_id,instruction_version,agent_input_json,structured_output_json,orchestration_json,execution_mode)
      VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?,?,?,'{}','{}','unknown')`)
      .run(childRunId, run.session_id, user?.id || null, role, `graph:${run.id}:${contract.agentId}:${crypto.randomUUID()}`,
        contract.domain, childText, timestamp, timestamp, run.id, contract.agentId, contract.instructionVersion, JSON.stringify(childInput));
    children.push({ contract, run: await db.prepare('SELECT * FROM agent_runs WHERE id=?').get(childRunId), agentInput: childInput });
  }
  const results = new Array(children.length);
  let cursor = 0;
  const concurrencyLimit = Math.min(2, children.length);
  await Promise.all(Array.from({ length: concurrencyLimit }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= children.length) return;
      const item = children[index];
      results[index] = await executeDomainAgent({ run: item.run, user, role, guestId,
        contract: item.contract, agentInput: item.agentInput, budget });
    }
  }));

  const gaps = results.map((result, index) => ({ result, contract: children[index].contract }))
    .filter(item => item.result.run?.status !== 'completed')
    .map(item => ({ agentId: item.contract.agentId, domain: item.contract.domain,
      runId: item.result.run?.id, errorCode: item.result.run?.error_code || 'AGENT_RUN_FAILED' }));
  const merged = results.flatMap((result, index) => mergeDomainResult(children[index].contract, result));
  const safeCandidates = merged.filter(item => item.status === 'adopted');
  const parentUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0,
    model: process.env.LLM_MODEL || null, provider: null, executionMode };
  let selectedIds = [];
  let coordinatorError = null;
  let selectionSource = null;
  const fallbackSource = 'completed_domain_candidates';
  let selectionValidation = { schemaValid: null, allowlistValid: null, responseComplete: false };
  let coordinatorContract = null;
  let responseContent = null;
  let parsedValidation = null;
  let finishReason = null;
  try {
    const sourceDates = Object.fromEntries(children
      .map(item => [item.contract.agentId.replace('domain.', ''), item.agentInput.date])
      .filter(([, sourceDate]) => typeof sourceDate === 'string'));
    coordinatorContract = buildCoordinatorSelectionContract({ request: run.input_text, candidates: safeCandidates,
      gaps, task: coordinationTask, sourceDates });
    const parentMessages = [
      { role: 'system', content: coordinatorContract.systemPrompt },
      { role: 'user', content: JSON.stringify(coordinatorContract.payload) }
    ];
    const response = await requestGraphModel({ runId: run.id, agentId: HOUSEHOLD_AGENT.agentId,
      messages: parentMessages, budget, usage: parentUsage,
      summary: '管家依据专业候选和合并规则作选择', maxTokens: 384,
      responseFormat: { type: 'json_object' }, thinkingMode: 'disabled' });
    finishReason = response.finishReason || null;
    responseContent = response.message.content;
    const baseValidation = validateCoordinatorSelection(responseContent, coordinatorContract.allowedCandidateIds);
    const validation = validateCoordinatorSelectionForTask(baseValidation, coordinatorContract);
    parsedValidation = validation;
    selectionValidation = { schemaValid: validation.schemaValid, allowlistValid: validation.allowlistValid,
      responseComplete: finishReason !== 'length',
      ...(coordinatorContract.task ? { semanticValid: validation.semanticValid ?? null } : {}) };
    if (finishReason === 'length') coordinatorError = 'COORDINATOR_OUTPUT_TRUNCATED';
    else if (!validation.ok) coordinatorError = validation.errorCode;
    else {
      selectedIds = validation.selectedCandidateIds;
      selectionSource = 'model';
    }
  } catch (error) {
    coordinatorError = error?.code || 'COORDINATOR_MODEL_FAILED';
  }
  const validationStartedAt = performance.now();
  const coordinatorEvidence = summarizeCoordinatorSelectionEvidence({ contract: coordinatorContract,
    responseContent, validation: parsedValidation, errorCode: coordinatorError, finishReason });
  const validationStatus = coordinatorError ? 'failed' : 'completed';
  const coordinatorValidationDiagnostic = { kind: 'coordinator_selection_validation',
    schemaValid: selectionValidation.schemaValid, allowlistValid: selectionValidation.allowlistValid,
    responseComplete: selectionValidation.responseComplete, finishReason,
    ...(coordinatorContract?.task ? { semanticValid: selectionValidation.semanticValid } : {}),
    coordinatorStatus: coordinatorError ? 'failed' : 'completed', coordinatorError,
    selectionSource, fallbackSource: coordinatorError ? fallbackSource : null, evidence: coordinatorEvidence };
  await insertStep(run.id, await nextStepIndex(run.id), { type: 'final', status: validationStatus,
    summary: coordinatorError
      ? '管家选择未完成；专业领域候选保留但未标为管家采用'
      : '管家选择通过结构化 schema 与安全候选白名单校验',
    diagnostic: coordinatorValidationDiagnostic,
    errorCode: coordinatorError, startedAt: now(), completedAt: now(), durationMs: measuredDurationMs(validationStartedAt) });
  const finalCandidates = merged;
  const selectedCandidateIds = coordinatorError ? [] : safeCandidates.filter(item => selectedIds.includes(item.candidateId)).map(item => item.candidateId);
  const totalDurationMs = measuredDurationMs(started);
  const orchestration = {
    selectedAgentIds: contracts.map(item => item.agentId),
    selectedCandidateIds,
    finalAdoptedCandidateIds: selectedCandidateIds,
    candidates: finalCandidates,
    gaps,
    coordinatorError,
    coordinatorStatus: coordinatorError ? 'failed' : 'completed',
    selectionSource,
    fallbackSource: coordinatorError ? fallbackSource : null,
    selectionValidation,
    coordinatorEvidence,
    concurrencyLimit,
    graphDurationMs: totalDurationMs,
    graphBudget: { maxRuntimeMs: MAX_RUN_MS, maxModelCalls: budget.maxModelCalls, maxToolCalls: MAX_TOOL_CALLS,
      maxTokens: MAX_RUN_TOKENS, maxEstimatedCostUsd: MAX_RUN_COST_USD,
      modelCalls: budget.modelCalls, toolCalls: budget.toolCalls, inputTokens: budget.inputTokens,
      outputTokens: budget.outputTokens, estimatedCostUsd: budget.estimatedCostUsd,
      reservedTokens: budget.reservedTokens, reservedCostUsd: budget.reservedCostUsd,
      elapsedMs: totalDurationMs,
      deadlineAt: new Date(Date.now() + Math.max(0, budget.deadlineAt - performance.now())).toISOString() },
    budgetDecisions: budget.decisions,
    executionMode
  };
  await budget.persistenceTail;
  await db.prepare('UPDATE agent_runs SET orchestration_json=?,structured_output_json=?,updated_at=? WHERE id=?')
    .run(JSON.stringify(orchestration), JSON.stringify({ selectedCandidateIds, coordinatorError,
      coordinatorStatus: orchestration.coordinatorStatus, selectionSource, fallbackSource: orchestration.fallbackSource,
      selectionValidation }), now(), run.id);
  const profile = await guestProfile(guestId);
  const disclosure = healthDisclosure(profile?.health_profile, profile?.health_profile_version || 0, guestId);
  const reply = deterministicGraphReply({ candidates: finalCandidates, selectedIds: selectedCandidateIds,
    gaps, targetDate: date, executionMode, coordinatorError, fallbackSource }) + '\n' + disclosure.text;
  const completedChildren = results.filter(result => result.run?.status === 'completed').length;
  const status = completedChildren > 0 || contracts.length === 0 ? 'completed' : 'failed';
  const errorCode = status === 'failed' ? (gaps[0]?.errorCode || 'AGENT_GRAPH_EMPTY') : null;
  await insertStep(run.id, await nextStepIndex(run.id), { type: 'final', status: 'completed',
    summary: coordinatorError ? `保留领域候选；管家选择未完成（${coordinatorError}）`
      : gaps.length ? `专业候选已复核；${gaps.length} 个领域结果有缺口` : '专业候选已完成确定性复核',
    diagnostic: { kind: 'graph_final_response', coordinatorStatus: coordinatorError ? 'failed' : 'completed',
      selectionSource, fallbackSource: coordinatorError ? fallbackSource : null,
      finalAdoptedCandidateIds: selectedCandidateIds },
    sources: candidateSources([disclosure.source], ...finalCandidates.map(item => item.sourceIds)), startedAt: now(), completedAt: now(), durationMs: totalDurationMs });
  await finishRun(run.id, { status, output: reply, errorCode, live: executionMode === 'live', executionMode,
    model: parentUsage.model, provider: parentUsage.provider, inputTokens: parentUsage.inputTokens,
    outputTokens: parentUsage.outputTokens, estimatedCost: parentUsage.estimatedCostUsd,
    stopReason: errorCode || (coordinatorError ? 'COORDINATOR_SELECTION_FAILED' : 'DOMAIN_SELECTION_COMPLETED') });
  return await db.prepare('SELECT * FROM agent_runs WHERE id=?').get(run.id);
}
