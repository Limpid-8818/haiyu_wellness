import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { runStage23BrowserAcceptance } from '../resources/stage23-browser-acceptance.js';
import { withBothDatabaseApis, databaseQuery, login } from './q10-helpers.js';
import { withApiAtDatabase } from './helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordedModel = path.join(projectRoot, 'scripts/resources/q23-recorded-model-server.js');
const evidencePath = path.join(projectRoot, 'output/resource-audit/stage23-execution-evidence-20261005.jsonl');
const fixedInstant = '2026-10-05T00:00:00.000Z';
const today = '2026-10-05';
const liveConversationLimits = Object.freeze({
  maxSessionRuntimeMs: 90_000,
  cleanupReserveMs: 10_000,
  postRunReserveMs: 10_000,
  apiStartupReserveMs: 5_000,
  maxProviderRuns: 2,
  maxProviderRequests: 8,
  maxToolCalls: 12,
  maxTokens: 32_768,
  maxEstimatedCostUsd: 0.10,
  maxRunRuntimeMs: 30_000,
  maxModelCallsPerRun: 8,
  maxToolCallsPerRun: 12,
  maxTokensPerRun: 32_768,
  maxEstimatedCostUsdPerRun: 0.10,
  modelTimeoutMs: 15_000,
  toolTimeoutMs: 15_000,
  minAdmittedRunRuntimeMs: 15_000
});
const legacy8192RegressionLimits = Object.freeze({
  ...liveConversationLimits,
  maxTokens: 8_192,
  maxTokensPerRun: 8_192
});

function parseToolEvidence(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function validateReadOnlySlotQueries(toolRows, { projectId, date, bookableSlots: availableSlots }) {
  assert.equal(toolRows.length, 2, 'the no-card path must contain exactly two successful read-only query rows');
  assert.deepEqual(toolRows.map(row => row.toolName).sort(), ['list_project_slots', 'list_projects']);
  assert.ok(toolRows.every(row => row.status === 'completed' && row.errorCode === null));
  const projectTool = toolRows.find(row => row.toolName === 'list_projects');
  const slotTool = toolRows.find(row => row.toolName === 'list_project_slots');
  const projects = parseToolEvidence(projectTool.resultJson);
  const slotArgs = parseToolEvidence(slotTool.argumentsJson);
  const slotResult = parseToolEvidence(slotTool.resultJson);
  assert.ok(Array.isArray(projects) && projects.some(project => project.id === projectId));
  assert.deepEqual([slotArgs.projectId, slotArgs.date, slotResult.project?.id, slotResult.date],
    [projectId, date, projectId, date]);
  assert.ok(Array.isArray(slotResult.slots));
  const offeredSlots = slotResult.slots.filter(slot => slot && typeof slot.id === 'string'
    && slot.status === 'listed' && Number(slot.availableCount) > 0);
  const currentlyBookableIds = new Set(availableSlots.filter(slot => slot.bookable && slot.businessDate === date)
    .map(slot => slot.id));
  assert.ok(offeredSlots.length > 0, 'the actual read-only slot query returned an available candidate');
  assert.ok(offeredSlots.every(slot => currentlyBookableIds.has(slot.id)),
    'every offered candidate remains bookable in the isolated service database');
  return { projects, slotArgs, slotResult, offeredSlots };
}

function aggregateLiveUsage(runs) {
  const normalizedRuns = runs.map(run => run && Object.hasOwn(run, 'usageKnown') ? run : usageFromAssistantRun(run));
  const sumKnown = key => normalizedRuns.length && normalizedRuns.every(run => Number.isFinite(run[key]))
    ? normalizedRuns.reduce((sum, run) => sum + run[key], 0) : null;
  const toolCounts = {};
  for (const run of normalizedRuns) for (const [name, count] of Object.entries(run.toolCounts || {})) {
    toolCounts[name] = (toolCounts[name] || 0) + Number(count || 0);
  }
  const inputTokens = sumKnown('inputTokens');
  const outputTokens = sumKnown('outputTokens');
  const usageKnown = normalizedRuns.every(run => run.usageKnown !== false && run.usageReported !== false);
  const usageDiagnostics = normalizedRuns.flatMap(run => run.usageDiagnostics || []);
  const uniqueSources = key => [...new Set(usageDiagnostics.map(item => item[key]).filter(Boolean))];
  return { modelCallCount: sumKnown('modelCallCount'), toolCallCount: sumKnown('toolCallCount'),
    inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    estimatedCostUsd: sumKnown('estimatedCostUsd'), durationMs: sumKnown('durationMs'), toolCounts,
    usageKnown, usageReported: usageKnown && normalizedRuns.every(run => run.usageReported !== false),
    unknownUsageRunCount: normalizedRuns.filter(run => run.usageKnown === false || run.usageReported === false).length,
    unknownUsageAttemptCount: sumKnown('unknownUsageAttemptCount'),
    providerRequestAttemptedCount: sumKnown('providerRequestAttemptedCount'),
    requestCountMatchesUsage: normalizedRuns.every(run => run.requestCountMatchesUsage === true),
    inputUsageSources: uniqueSources('inputUsageSource'), outputUsageSources: uniqueSources('outputUsageSource'),
    usageDiagnostics };
}

function planConversationRunBudget(currentUsage, elapsedMs, completedRuns, limits = liveConversationLimits) {
  const usageKeys = ['modelCallCount', 'toolCallCount', 'totalTokens', 'estimatedCostUsd'];
  const usageKnown = currentUsage?.usageKnown !== false && currentUsage?.usageReported !== false
    && usageKeys.every(key => Number.isFinite(currentUsage?.[key]) && currentUsage[key] >= 0)
    && Number.isInteger(currentUsage.modelCallCount) && Number.isInteger(currentUsage.toolCallCount)
    && Number.isInteger(currentUsage.totalTokens);
  const elapsedKnown = Number.isFinite(elapsedMs) && elapsedMs >= 0;
  const remaining = usageKnown ? {
    modelCalls: Math.max(0, limits.maxProviderRequests - currentUsage.modelCallCount),
    toolCalls: Math.max(0, limits.maxToolCalls - currentUsage.toolCallCount),
    tokens: Math.max(0, limits.maxTokens - currentUsage.totalTokens),
    estimatedCostUsd: Math.max(0, limits.maxEstimatedCostUsd - currentUsage.estimatedCostUsd)
  } : { modelCalls: null, toolCalls: null, tokens: null, estimatedCostUsd: null };
  const runtimeAvailableMs = elapsedKnown ? Math.floor(limits.maxSessionRuntimeMs - elapsedMs
    - limits.cleanupReserveMs - limits.postRunReserveMs - limits.apiStartupReserveMs) : null;
  const candidateLimits = usageKnown && elapsedKnown && Number.isInteger(completedRuns)
    && completedRuns >= 0 && completedRuns < limits.maxProviderRuns ? {
      maxRuntimeMs: Math.min(limits.maxRunRuntimeMs, runtimeAvailableMs),
      maxModelCalls: Math.min(limits.maxModelCallsPerRun, remaining.modelCalls),
      maxToolCalls: Math.min(limits.maxToolCallsPerRun, remaining.toolCalls),
      maxTokens: Math.min(limits.maxTokensPerRun, remaining.tokens),
      maxEstimatedCostUsd: Math.floor(Math.min(limits.maxEstimatedCostUsdPerRun,
        remaining.estimatedCostUsd) * 1e12) / 1e12
    } : null;
  if (candidateLimits) candidateLimits.maxToolRounds = Math.min(2, candidateLimits.maxToolCalls);
  const positiveLimits = candidateLimits && candidateLimits.maxRuntimeMs >= limits.minAdmittedRunRuntimeMs
    && candidateLimits.maxModelCalls > 0 && candidateLimits.maxToolCalls > 0
    && candidateLimits.maxTokens > 0 && candidateLimits.maxEstimatedCostUsd > 0
    && candidateLimits.maxToolRounds > 0;
  const projectedUsage = candidateLimits && usageKnown ? {
    modelCalls: currentUsage.modelCallCount + candidateLimits.maxModelCalls,
    toolCalls: currentUsage.toolCallCount + candidateLimits.maxToolCalls,
    tokens: currentUsage.totalTokens + candidateLimits.maxTokens,
    estimatedCostUsd: currentUsage.estimatedCostUsd + candidateLimits.maxEstimatedCostUsd,
    runtimeMs: elapsedKnown ? elapsedMs + candidateLimits.maxRuntimeMs
      + limits.postRunReserveMs + limits.cleanupReserveMs : null
  } : { modelCalls: null, toolCalls: null, tokens: null, estimatedCostUsd: null, runtimeMs: null };
  const checks = {
    observedUsageKnown: usageKnown,
    elapsedKnown,
    providerRunAvailable: Number.isInteger(completedRuns) && completedRuns >= 0
      && completedRuns < limits.maxProviderRuns,
    modelCallsWithinLimit: usageKnown && candidateLimits?.maxModelCalls > 0
      && projectedUsage.modelCalls <= limits.maxProviderRequests,
    toolCallsWithinLimit: usageKnown && candidateLimits?.maxToolCalls > 0
      && projectedUsage.toolCalls <= limits.maxToolCalls,
    tokensWithinLimit: usageKnown && candidateLimits?.maxTokens > 0
      && projectedUsage.tokens <= limits.maxTokens,
    estimatedCostWithinLimit: usageKnown && candidateLimits?.maxEstimatedCostUsd > 0
      && projectedUsage.estimatedCostUsd <= limits.maxEstimatedCostUsd + 1e-12,
    runtimeAndReservesWithinLimit: elapsedKnown && candidateLimits?.maxRuntimeMs >= limits.minAdmittedRunRuntimeMs
      && projectedUsage.runtimeMs <= limits.maxSessionRuntimeMs
  };
  const admitted = Object.values(checks).every(Boolean) && positiveLimits;
  return { admitted, checks, currentUsage, remaining, effectiveLimits: admitted ? candidateLimits : null,
    projectedUsage, completedRuns, elapsedMs: elapsedKnown ? Math.ceil(elapsedMs) : null,
    cleanupReserveMs: limits.cleanupReserveMs,
    postRunReserveMs: limits.postRunReserveMs,
    apiStartupReserveMs: limits.apiStartupReserveMs };
}

function usageFromAssistantRun(run) {
  const inputTokens = run?.traceUsage?.inputTokens ?? run?.inputTokens;
  const outputTokens = run?.traceUsage?.outputTokens ?? run?.outputTokens;
  const totalTokens = run?.traceUsage?.totalTokens ?? (Number.isFinite(inputTokens) && Number.isFinite(outputTokens)
    ? inputTokens + outputTokens : null);
  const estimatedCostUsd = run?.traceUsage?.estimatedCostUsd ?? run?.estimatedCostUsd;
  const modelUsage = Array.isArray(run?.modelUsage) ? run.modelUsage : null;
  const attemptedItems = modelUsage ? modelUsage.filter(item => item?.requestAttempted === true) : [];
  const modelCallCount = Number.isInteger(run?.modelCallCount) ? run.modelCallCount : null;
  const attempted = modelUsage ? attemptedItems.length
    : Number.isInteger(run?.providerRequestAttemptedCount) ? run.providerRequestAttemptedCount
      : modelCallCount === 0 ? 0 : null;
  const unknownUsageAttemptCount = attempted === null ? null
    : attemptedItems.filter(item => item?.usageReported !== true).length;
  const requestCountMatchesUsage = attempted !== null && attempted === modelCallCount;
  const rootUsageUnknown = run?.usageReported === false || run?.traceUsage?.usageReported === false;
  const usageReported = attempted === 0 || (!rootUsageUnknown && attempted !== null
    && unknownUsageAttemptCount === 0 && attemptedItems.length === attempted);
  const usageKnown = requestCountMatchesUsage && (attempted === 0 || usageReported);
  const usageDiagnostics = attemptedItems.map(item => ({ stepIndex: item.stepIndex ?? null,
    usageReported: item.usageReported === true,
    usageUnavailableReason: item.usageUnavailableReason || null,
    inputTokens: Number.isFinite(item.inputTokens) ? item.inputTokens : null,
    outputTokens: Number.isFinite(item.outputTokens) ? item.outputTokens : null,
    estimatedCostUsd: Number.isFinite(item.estimatedCostUsd) ? item.estimatedCostUsd : null,
    usageFieldsReported: item.usageFieldsReported || null,
    inputUsageSource: item.inputUsageSource || null,
    outputUsageSource: item.outputUsageSource || null }));
  return { modelCallCount, toolCallCount: Number.isInteger(run?.toolCallCount) ? run.toolCallCount : null,
    inputTokens: Number.isInteger(inputTokens) ? inputTokens : null,
    outputTokens: Number.isInteger(outputTokens) ? outputTokens : null,
    totalTokens: Number.isInteger(totalTokens) ? totalTokens : null,
    estimatedCostUsd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null,
    usageKnown, usageReported, unknownUsageRunCount: usageKnown ? 0 : 1, unknownUsageAttemptCount,
    usageDiagnostics,
    inputUsageSources: [...new Set(usageDiagnostics.map(item => item.inputUsageSource).filter(Boolean))],
    outputUsageSources: [...new Set(usageDiagnostics.map(item => item.outputUsageSource).filter(Boolean))],
    providerRequestAttemptedCount: attempted,
    requestCountMatchesUsage };
}

function isCompleteReportedUsage(usage) {
  return usage?.usageKnown === true && usage?.usageReported === true
    && usage?.unknownUsageRunCount === 0 && usage?.unknownUsageAttemptCount === 0
    && usage?.requestCountMatchesUsage === true
    && Number.isInteger(usage.modelCallCount)
    && Number.isInteger(usage.providerRequestAttemptedCount);
}

function makeBudgetedApiEnvironment(limits, { seed, liveConfig = {}, modelSource = 'live' }) {
  if (!limits || Object.values(limits).some(value => !Number.isFinite(value) || value <= 0)) {
    throw Object.assign(new Error('refusing to start an API with missing, unknown, or non-positive per-run budget limits'),
      { stageBlocked: true });
  }
  return { DB_DRIVER: 'sqlite', DEMO_SEED: seed ? '1' : '0', BUSINESS_CLOCK_NOW: fixedInstant,
    ...liveConfig,
    ...(modelSource === 'recorded_fixture' ? { ASSISTANT_MODEL_SOURCE: 'recorded_fixture' } : {}),
    LLM_TIMEOUT_MS: String(liveConversationLimits.modelTimeoutMs),
    ASSISTANT_TOOL_TIMEOUT_MS: String(liveConversationLimits.toolTimeoutMs),
    ASSISTANT_MAX_RUNTIME_MS: String(limits.maxRuntimeMs),
    ASSISTANT_MAX_MODEL_CALLS: String(limits.maxModelCalls),
    ASSISTANT_MAX_TOOL_ROUNDS: String(limits.maxToolRounds),
    ASSISTANT_MAX_TOOL_CALLS: String(limits.maxToolCalls),
    ASSISTANT_MAX_TOKENS: String(limits.maxTokens),
    ASSISTANT_MAX_ESTIMATED_COST_USD: String(limits.maxEstimatedCostUsd) };
}

function assertRunFitsRemainingConversation(admission, startedAt) {
  const elapsedMs = performance.now() - startedAt;
  requireBudgetCondition(admission?.admitted && admission.effectiveLimits,
    'remaining conversation usage is unknown, exhausted, or cannot be safely admitted');
  requireBudgetCondition(elapsedMs + admission.effectiveLimits.maxRuntimeMs
    + liveConversationLimits.postRunReserveMs + liveConversationLimits.cleanupReserveMs
    <= liveConversationLimits.maxSessionRuntimeMs,
  'the already-started API left insufficient wall-clock budget for this bounded run and cleanup');
  return Math.ceil(elapsedMs);
}

function requireBudgetCondition(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { stageBlocked: true });
}

function dateOffset(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}
function sqlTime(context, value) { return context.driver === 'mysql' ? value.replace('T', ' ').replace('Z', '') : value; }
function assertStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}
function appendEvidence(entry) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ recordedAt: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...entry });
  const bytes = Buffer.byteLength(line, 'utf8') + 1;
  const current = fs.existsSync(evidencePath) ? fs.statSync(evidencePath).size : 0;
  if (bytes > 48 * 1024 || current + bytes > 8 * 1024 * 1024) throw new Error('Stage23 execution evidence reached its configured limit');
  fs.appendFileSync(evidencePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  return { path: path.relative(projectRoot, evidencePath), offset: current, bytes,
    sha256: crypto.createHash('sha256').update(line).digest('hex') };
}

function readEvidenceAt(reference) {
  if (!reference || reference.path !== path.relative(projectRoot, evidencePath)
    || !Number.isSafeInteger(reference.offset) || !Number.isSafeInteger(reference.bytes)
    || reference.bytes < 2 || reference.bytes > 48 * 1024) throw new Error('invalid bounded evidence reference');
  const buffer = Buffer.alloc(reference.bytes);
  const fd = fs.openSync(evidencePath, 'r');
  try {
    const count = fs.readSync(fd, buffer, 0, buffer.length, reference.offset);
    if (count !== buffer.length) throw new Error('evidence record was not fully persisted');
  } finally { fs.closeSync(fd); }
  const raw = buffer.toString('utf8');
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (crypto.createHash('sha256').update(line).digest('hex') !== reference.sha256) {
    throw new Error('evidence record digest did not match its append receipt');
  }
  return JSON.parse(line);
}

async function api(context, route, { method = 'GET', token, body, headers = {}, signal } = {}) {
  const remainingRequestMs = Number.isFinite(context.requestDeadlineAt)
    ? Math.floor(context.requestDeadlineAt - performance.now()) : null;
  if (remainingRequestMs !== null && remainingRequestMs <= 0) {
    throw Object.assign(new Error('the Q23 conversation request deadline was reached before dispatch'), { stageBlocked: true });
  }
  const deadlineSignal = remainingRequestMs === null ? null : AbortSignal.timeout(remainingRequestMs);
  const requestSignal = signal && deadlineSignal ? AbortSignal.any([signal, deadlineSignal]) : signal || deadlineSignal;
  const response = await fetch(`${context.baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers
  }, body: body === undefined ? undefined : JSON.stringify(body), ...(requestSignal ? { signal: requestSignal } : {}) });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

async function startRecordedModel(resourceSession) {
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const value = probe.address()?.port;
      probe.close(error => error ? reject(error) : value ? resolve(value) : reject(new Error('Q23 could not allocate a fixture port')));
    });
  });
  const resource = await resourceSession.startProcess({ label: `q23-recorded-model-${crypto.randomUUID().slice(0, 8)}`,
    kind: 'stub', role: 'model-provider', command: process.execPath, args: [recordedModel], cwd: projectRoot,
    port, env: { PATH: process.env.PATH || '', PORT: String(port) } });
  if (resource.status !== 'running') throw new Error(`Stage23 recorded model failed to start: ${JSON.stringify(resource)}`);
  try {
    const deadline = performance.now() + 8_000;
    while (performance.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { resource, baseUrl: `http://127.0.0.1:${port}/v1` };
      } catch { /* bounded readiness retry */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Stage23 recorded model readiness timed out');
  } catch (error) {
    await resourceSession.stop(resource.id, 'q23-model-start-failure').catch(() => {});
    await resourceSession.waitProcess(resource.id, 10_000).catch(() => {});
    throw error;
  }
}

async function stopRecordedModel(resourceSession, handle) {
  if (!handle) return;
  const state = await resourceSession.status();
  const current = state.resources?.find(item => item.id === handle.resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await resourceSession.stop(current.id, 'q23-model-complete');
    if (!stopped.ok) throw new Error(`Stage23 model stop failed: ${stopped.error || 'unknown error'}`);
  }
  const waited = await resourceSession.waitProcess(handle.resource.id, 10_000);
  if (waited.timedOut || waited.unavailable || ['starting', 'running'].includes(waited.status)) {
    throw new Error(`Stage23 model did not exit: ${JSON.stringify(waited)}`);
  }
}

function modelEnvironment(provider) {
  return { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: fixedInstant, LLM_BASE_URL: provider.baseUrl,
    LLM_API_KEY: 'q23-recorded-fixture-only', LLM_MODEL: 'q23-recorded-fixture', LLM_TIMEOUT_MS: '20000',
    ASSISTANT_MODEL_SOURCE: 'recorded_fixture' };
}

async function recordedModelRequestCount(baseUrl) {
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.pathname = '/stats';
  url.search = '';
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`recorded model stats returned HTTP ${response.status}`);
  const result = await response.json();
  if (!Number.isSafeInteger(result?.requestCount) || result.requestCount < 0) {
    throw new Error('recorded model stats returned an invalid request count');
  }
  return result.requestCount;
}

async function withBoth(contextFn, resourceSession, env = {}) {
  let details;
  await withBothDatabaseApis(async context => {
    details = await contextFn({ ...context, resourceSession,
      recordedModelBaseUrl: env.LLM_BASE_URL || null, recordedModelName: env.LLM_MODEL || null });
    appendEvidence({ quest: details.quest, scenario: details.scenario, driver: context.driver,
      status: 'PASS', evidence: details.evidence || {} });
  }, { resourceSession, env: { BUSINESS_CLOCK_NOW: fixedInstant, ...env } });
  return details;
}

async function withModelBoth(contextFn, resourceSession) {
  const provider = await startRecordedModel(resourceSession);
  try { return await withBoth(contextFn, resourceSession, modelEnvironment(provider)); }
  finally { await stopRecordedModel(resourceSession, provider); }
}

async function guestUser(context) {
  const loginResult = assertStatus(await login(context.baseUrl, 'guest'), 200, `${context.driver} guest login`);
  return { id: loginResult.user.id, token: loginResult.token };
}

async function assistantText(context, user, text, sessionId = null, { expectActionCard = true, onRunObserved = null,
  failureSummary = null, onAssertionFailure = null, sessionStartedAt = null, readbackFaultOnce = false,
  expectedRunStatus = 'completed' } = {}) {
  const turnStartedAt = performance.now();
  const businessRowsBefore = await guestBusinessCounts(context, user.id);
  const clientRequestId = crypto.randomUUID();
  let startResponse = null;
  let startError = null;
  try {
    startResponse = await api(context, '/assistant/chat', { method: 'POST', token: user.token,
      headers: { 'Idempotency-Key': clientRequestId },
      body: { role: 'guest', text, async: true, clientRequestId, ...(sessionId ? { sessionId } : {}) } });
  } catch (error) { startError = error; }
  if (startError || startResponse?.status !== 202) {
    let after = null;
    let businessRowsReadError = null;
    try { after = await guestBusinessCounts(context, user.id); }
    catch (error) { businessRowsReadError = String(error?.message || error).slice(0, 300); }
    const startObservation = { receiptStage: 'assistant_start', receiptStatus: 'START_REJECTED',
      runId: null, sessionId: null, requestedSessionId: sessionId || null, clientRequestId,
      httpStatus: startResponse?.status ?? null, errorCode: startResponse?.data?.code || startError?.code || null,
      readError: startError ? { stage: 'POST /assistant/chat', kind: 'request_error',
        message: String(startError.message || startError).slice(0, 300) }
        : { stage: 'POST /assistant/chat', kind: 'http_rejection', status: startResponse?.status ?? null,
          errorCode: startResponse?.data?.code || null },
      runStatus: null, durationMs: null, modelCallCount: null, toolCallCount: null, toolCounts: null,
      inputTokens: null, outputTokens: null, totalTokens: null, estimatedCostUsd: null, actionCardStates: null,
      clarificationCount: null, clarificationState: null, stopReason: null, stepStates: null,
      turnElapsedMs: Math.max(0, Math.round(performance.now() - turnStartedAt)),
      businessRowsBeforeAfter: { before: businessRowsBefore, after, readError: businessRowsReadError },
      noBusinessWrite: after ? JSON.stringify(businessRowsBefore) === JSON.stringify(after) : null };
    const receiptRef = appendEvidence({ quest: 'Q23', scenario: 'assistant-run-usage-and-no-business-write-receipt',
      driver: context.driver, status: 'START_REJECTED', evidence: startObservation });
    const error = startError || new Error(`start assistant proposal run returned HTTP ${startResponse?.status ?? 'unknown'} (${startResponse?.data?.code || 'no error code'})`);
    appendAssistantFailureSummary({ observation: { ...startObservation, evidenceRef: receiptRef }, error,
      sessionStartedAt: Number.isFinite(sessionStartedAt) ? sessionStartedAt : null,
      failureSummary: { ...failureSummary, phase: failureSummary?.phase || 'assistant_start_rejected' },
      driver: context.driver, onAssertionFailure });
    throw error;
  }
  const started = startResponse.data;
  const deadline = performance.now() + 25_000;
  let run;
  let readError = null;
  let readbackFaultInjected = false;
  while (performance.now() < deadline) {
    if (readbackFaultOnce && !readbackFaultInjected) {
      readbackFaultInjected = true;
      readError = { stage: 'GET /assistant/runs/:runId', kind: 'injected_acceptance_readback_error',
        status: null, errorCode: null };
      break;
    }
    let response;
    try {
      response = await api(context, `/assistant/runs/${encodeURIComponent(started.runId)}?role=guest`, {
        token: user.token, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      readError = { stage: 'GET /assistant/runs/:runId', kind: 'request_error', status: null,
        errorCode: error?.name === 'TimeoutError' ? 'RUN_READBACK_TIMEOUT' : error?.code || null,
        message: String(error?.message || error).slice(0, 300) };
      break;
    }
    if (response.status !== 200) {
      readError = { stage: 'GET /assistant/runs/:runId', kind: 'http_error', status: response.status,
        errorCode: response.data?.code || null };
      break;
    }
    run = response.data;
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  let businessRowsAfter = null;
  let businessRowsReadError = null;
  try { businessRowsAfter = await guestBusinessCounts(context, user.id); }
  catch (error) { businessRowsReadError = String(error?.message || error).slice(0, 300); }
  const runCards = run?.actionCards || [];
  const terminal = Boolean(run && !['queued', 'running'].includes(run.status));
  const observedEvidence = { receiptStage: 'run_readback', receiptStatus: terminal ? 'OBSERVED' : 'INCOMPLETE',
    runId: run?.runId || started.runId, sessionId: started.sessionId, clientRequestId,
    readError, timedOut: Boolean(!readError && run && ['queued', 'running'].includes(run.status)),
    executionMode: run?.executionMode || null, provider: run?.provider || null, model: run?.model || null,
    modelCallCount: run?.modelCallCount ?? null, toolCallCount: run?.toolCallCount ?? null,
    toolCounts: run?.toolCounts ?? null, inputTokens: run?.traceUsage?.inputTokens ?? run?.inputTokens ?? null,
    outputTokens: run?.traceUsage?.outputTokens ?? run?.outputTokens ?? null,
    totalTokens: run?.traceUsage?.totalTokens ?? null,
    estimatedCostUsd: run?.traceUsage?.estimatedCostUsd ?? run?.estimatedCostUsd ?? null,
    runStatus: run?.status || null, durationMs: run?.durationMs ?? null,
    turnElapsedMs: Math.max(0, Math.round(performance.now() - turnStartedAt)),
    intentCategory: run?.intentCategory || null, clarificationCount: run?.clarificationCount ?? null,
    clarificationState: run?.clarificationState ?? null, stopReason: run?.stopReason || run?.errorCode || null,
    modelUsage: run?.modelUsage ?? null, actionCardStates: run ? runCards.map(card => ({ id: card.id,
      actionType: card.actionType, version: card.version, status: card.status, missingFields: card.missingFields || [] })) : null,
    businessRowsBeforeAfter: { before: businessRowsBefore, after: businessRowsAfter, readError: businessRowsReadError },
    noBusinessWrite: businessRowsAfter ? JSON.stringify(businessRowsBefore) === JSON.stringify(businessRowsAfter) : null,
    reachedStep: run?.steps?.at(-1) ? { stepIndex: run.steps.at(-1).stepIndex, type: run.steps.at(-1).type,
      status: run.steps.at(-1).status, summary: run.steps.at(-1).summary,
      errorCode: run.steps.at(-1).errorCode || null } : null,
    stepStates: run ? (run.steps || []).map(step => ({ stepIndex: step.stepIndex, type: step.type,
      status: step.status, summary: step.summary, errorCode: step.errorCode || null })) : null };
  const observationRef = appendEvidence({ quest: 'Q23', scenario: 'assistant-run-usage-and-no-business-write-receipt',
    driver: context.driver, status: terminal ? 'OBSERVED' : 'INCOMPLETE',
    evidence: observedEvidence });
  const observedWithEvidenceRef = { ...observedEvidence, evidenceRef: observationRef };
  if (terminal && onRunObserved) {
    await onRunObserved(run, observedWithEvidenceRef);
  }
  let actionCards = run?.actionCards || [];
  try {
    assert.ok(!readError, `${context.driver} run readback succeeded: ${JSON.stringify(readError)}`);
    assert.ok(run && run.status === expectedRunStatus,
      `${context.driver} fixture run reached expected status ${expectedRunStatus}: ${JSON.stringify(run)}`);
    actionCards = run.actionCards || [];
    if (expectActionCard) assert.ok(actionCards.length, `${context.driver} model tool call persisted an action card: ${JSON.stringify({
      status: run.status, errorCode: run.errorCode, reply: run.reply,
      toolSteps: (run.steps || []).filter(step => step.type === 'tool' || step.type === 'model').map(step => ({ type: step.type, status: step.status, summary: step.summary, errorCode: step.errorCode }))
    })}`);
  } catch (error) {
    appendAssistantFailureSummary({ observation: observedWithEvidenceRef, error,
      sessionStartedAt: Number.isFinite(sessionStartedAt) ? sessionStartedAt : null,
      failureSummary, driver: context.driver, onAssertionFailure });
    throw error;
  }
  const actionCard = actionCards.at(-1) || null;
  return { run, actionCard, sessionId: started.sessionId, observation: observedWithEvidenceRef };
}

function parseAcceptanceJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return fallback;
}

function assertSelectionInputDateCompatible(inputText, effectiveDate) {
  assert.match(effectiveDate, /^20\d{2}-\d{2}-\d{2}$/u, 'the source card or clarification supplies a valid effective date');
  const explicitDates = [...String(inputText || '').matchAll(/\b20\d{2}-\d{2}-\d{2}\b/gu)]
    .map(match => match[0]);
  assert.ok(explicitDates.every(value => value === effectiveDate),
    `an explicitly supplied selection date must match the same-session offered date ${effectiveDate}: ${explicitDates.join(',')}`);
  return { effectiveDate, source: 'same-session verified source card or read-only clarification', explicitDates,
    inheritedFromSource: explicitDates.length === 0 };
}

async function assertDeterministicSlotSelectionContract(context, user, result, {
  firstTurnKind, sourceRun, sourceCard = null, selectedSlot, projectId, date,
  expectedBusinessRows, bookableSlots
}) {
  const run = result?.run;
  const card = result?.actionCard;
  assert.ok(run && card, 'selection response contains its actual terminal run and action card');
  assert.equal(run.status, 'completed');
  assert.equal(run.executionMode, 'safe_guidance', 'selection is a server-side deterministic run');
  assert.equal(run.live, false, 'deterministic selection is never labeled live');
  assert.equal(run.stopReason, 'APPOINTMENT_SLOT_REVALIDATED', 'the selected slot passed server revalidation');
  assert.equal(run.errorCode, null);
  assert.equal(run.model, null);
  assert.equal(run.provider, null);
  assert.equal(run.modelCallCount, 0);
  assert.equal(run.toolCallCount, 0);
  assert.deepEqual(run.toolCounts, {});
  assert.deepEqual(run.modelUsage, [], 'the run records no provider request attempts');
  assert.equal(run.inputTokens, 0);
  assert.equal(run.outputTokens, 0);
  assert.equal(run.estimatedCostUsd, 0);
  assert.deepEqual(run.traceUsage && {
    inputTokens: run.traceUsage.inputTokens,
    outputTokens: run.traceUsage.outputTokens,
    totalTokens: run.traceUsage.totalTokens,
    estimatedCostUsd: run.traceUsage.estimatedCostUsd
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });
  assert.equal(run.intentCategory, 'schedule');
  assert.equal(run.clarificationCount, 0);
  assert.deepEqual(run.clarificationState, {});
  assert.equal(run.sessionId, result.sessionId);
  assert.equal(result.sessionId, sourceRun.sessionId);
  assert.equal(sourceRun.status, 'completed');
  assert.ok(Array.isArray(run.steps));
  assert.ok(run.steps.every(step => !['model', 'tool'].includes(step.type)),
    'the deterministic run contains no model or tool step');
  assert.ok(run.steps.every(step => Number(step.inputTokens || 0) === 0
    && Number(step.outputTokens || 0) === 0 && Number(step.estimatedCostUsd || 0) === 0),
  'all deterministic run steps have zero token and cost usage');
  assert.ok(!run.steps.some(step => step.diagnostic?.providerRequestAttempted === true
    || step.diagnostic?.modelToolCallRecorded === true),
  'step diagnostics contain no model request or fabricated model tool call');
  assert.equal(card.actionType, 'book_program');
  assert.equal(card.status, 'pending_confirmation');
  assert.equal(card.errorCode, null);
  assert.deepEqual(card.missingFields, []);
  assert.equal(card.parameters?.projectId, projectId);
  assert.equal(card.parameters?.date, date);
  assert.equal(card.parameters?.slotId, selectedSlot.id);
  assert.equal(card.impact?.slot?.id, selectedSlot.id);
  assert.equal(card.impact?.slot?.localStart || card.impact?.slot?.start, selectedSlot.localStart);
  assert.equal(card.impact?.slot?.localEnd || card.impact?.slot?.end, selectedSlot.localEnd);
  assert.ok(Number.isSafeInteger(Number(card.version)) && Number(card.version) > 0);
  assert.equal(typeof sourceRun?.runId, 'string');
  assert.equal(typeof result.sessionId, 'string');
  const currentBookableSlot = Array.isArray(bookableSlots)
    ? bookableSlots.find(item => item?.id === selectedSlot.id && item.bookable === true
      && item.businessDate === date) : null;
  assert.ok(currentBookableSlot, 'the expected slot belongs to the same-date live booking query for this isolated database');
  assert.deepEqual([currentBookableSlot.localStart, currentBookableSlot.localEnd],
    [selectedSlot.localStart, selectedSlot.localEnd]);

  const revalidationSteps = run.steps.filter(step => step.type === 'clarification'
    && step.diagnostic?.kind === 'appointment_slot_selection_revalidation');
  assert.equal(revalidationSteps.length, 1, 'one successful revalidation diagnostic is present');
  const diagnostic = revalidationSteps[0].diagnostic;
  assert.equal(revalidationSteps[0].status, 'completed');
  assert.equal(diagnostic.sourceRunId, sourceRun.runId);
  assert.equal(diagnostic.source, 'verified_read_only_slot_results');
  assert.equal(diagnostic.selectedSlotId, selectedSlot.id);
  assert.equal(diagnostic.actionCardId, card.id);
  assert.equal(diagnostic.actionCardStatus, 'pending_confirmation');
  assert.equal(diagnostic.modelToolCallRecorded, false);
  assert.equal(diagnostic.confirmationRequired, true);
  const finalStep = run.steps.at(-1);
  assert.equal(finalStep?.type, 'final');
  assert.equal(finalStep?.status, 'completed');
  assert.equal(finalStep?.diagnostic?.stopReason, 'APPOINTMENT_SLOT_REVALIDATED');
  assert.equal(finalStep?.diagnostic?.actionCardId, card.id);

  const sourceRunRow = await databaseQuery(context, `SELECT id,session_id AS sessionId,actor_id AS actorId,
      assistant_role AS assistantRole,status,intent_category AS intentCategory,
      clarification_count AS clarificationCount,clarification_state_json AS clarificationStateJson,
      stop_reason AS stopReason
    FROM agent_runs WHERE id=?`, [sourceRun.runId], 'get');
  assert.ok(sourceRunRow, 'the source run has a durable database row');
  assert.deepEqual([sourceRunRow.sessionId, sourceRunRow.actorId, sourceRunRow.assistantRole, sourceRunRow.status],
    [result.sessionId, user.id, 'guest', 'completed']);
  let sourceLogicalActionId = null;
  if (firstTurnKind === 'needs_input_action_card') {
    assert.ok(sourceCard, 'the needs_input path provides its original card');
    const sourceCardRow = await databaseQuery(context, `SELECT id,logical_action_id AS logicalActionId,
        parent_card_id AS parentCardId,guest_id AS guestId,session_id AS sessionId,
        source_run_id AS sourceRunId,action_type AS actionType,version,status,
        parameters_json AS parametersJson,impact_json AS impactJson
      FROM assistant_action_cards WHERE id=?`, [sourceCard.id], 'get');
    assert.ok(sourceCardRow, 'the source needs_input card has a durable row');
    sourceLogicalActionId = sourceCardRow.logicalActionId;
    const sourceParameters = parseAcceptanceJson(sourceCardRow.parametersJson);
    const sourceImpact = parseAcceptanceJson(sourceCardRow.impactJson);
    assert.deepEqual([sourceCardRow.guestId, sourceCardRow.sessionId, sourceCardRow.sourceRunId,
      sourceCardRow.actionType, sourceCardRow.status, Number(sourceCardRow.version)],
    [user.id, result.sessionId, sourceRun.runId, 'book_program', 'superseded', Number(sourceCard.version)]);
    assert.deepEqual([sourceParameters.projectId, sourceParameters.date], [projectId, date]);
    assert.ok((sourceImpact.availableSlots || []).some(slot => slot.id === selectedSlot.id),
      'the selected slot was offered by the source needs_input card');
  } else {
    assert.equal(firstTurnKind, 'verified_read_only_queries_awaiting_guest_slot_selection');
    assert.equal(sourceRunRow.intentCategory, 'schedule');
    assert.equal(Number(sourceRunRow.clarificationCount), 0);
    assert.equal(sourceRunRow.stopReason, 'APPOINTMENT_SLOT_SELECTION_REQUESTED');
    assert.equal(sourceRun.stopReason, 'APPOINTMENT_SLOT_SELECTION_REQUESTED');
    assert.deepEqual(sourceRun.actionCards || [], [], 'read-only clarification has no action card');
    assert.deepEqual(sourceRun.toolCounts, { list_projects: 1, list_project_slots: 1 });
    const sourceState = parseAcceptanceJson(sourceRunRow.clarificationStateJson);
    assert.deepEqual([sourceState.flow, sourceState.status, sourceState.sourceRunId,
      sourceState.projectId, sourceState.date], ['appointment', 'awaiting_guest_slot_selection',
      sourceRun.runId, projectId, date]);
    assert.deepEqual(sourceRun.clarificationState, sourceState,
      'source clarification API readback matches its persisted provenance');
    assert.deepEqual(sourceState.readOnlyTools, ['list_projects', 'list_project_slots']);
    assert.ok((sourceState.offeredSlots || []).some(slot => slot.id === selectedSlot.id
      && slot.localStart === selectedSlot.localStart && slot.localEnd === selectedSlot.localEnd),
    'the selected slot was offered by the source read-only clarification');
    const sourceToolRows = await databaseQuery(context, `SELECT tool_name AS toolName,status,
        error_code AS errorCode,arguments_json AS argumentsJson,result_json AS resultJson
      FROM tool_executions WHERE run_id=? ORDER BY started_at,id`, [sourceRun.runId]);
    const readOnlyEvidence = validateReadOnlySlotQueries(sourceToolRows,
      { projectId, date, bookableSlots });
    assert.ok(readOnlyEvidence.offeredSlots.some(slot => slot.id === selectedSlot.id),
      'the selected slot is backed by both successful read-only database queries');
  }

  const runRow = await databaseQuery(context, `SELECT id,session_id AS sessionId,actor_id AS actorId,
      assistant_role AS assistantRole,status,input_text AS inputText,model_name AS model,
      provider,execution_mode AS executionMode,is_live AS isLive,input_tokens AS inputTokens,
      output_tokens AS outputTokens,estimated_cost_usd AS estimatedCostUsd,
      intent_category AS intentCategory,clarification_count AS clarificationCount,
      clarification_state_json AS clarificationStateJson,stop_reason AS stopReason
    FROM agent_runs WHERE id=?`, [run.runId], 'get');
  assert.ok(runRow, 'the selected run has a durable database row');
  assert.deepEqual([runRow.sessionId, runRow.actorId, runRow.assistantRole, runRow.status,
    Number(runRow.isLive), Number(runRow.inputTokens), Number(runRow.outputTokens),
    Number(runRow.estimatedCostUsd), runRow.stopReason],
  [result.sessionId, user.id, 'guest', 'completed', 0, 0, 0, 0, 'APPOINTMENT_SLOT_REVALIDATED']);
  assert.ok(String(runRow.inputText || '').includes(selectedSlot.id),
    'the durable natural selection input names the guest-selected slot');
  const selectionDateEvidence = assertSelectionInputDateCompatible(runRow.inputText, date);
  assert.equal(runRow.model, null);
  assert.equal(runRow.provider, null);
  assert.equal(runRow.intentCategory, 'schedule');
  assert.equal(Number(runRow.clarificationCount), 0);
  assert.deepEqual(parseAcceptanceJson(runRow.clarificationStateJson), {});
  const stepRows = await databaseQuery(context, `SELECT step_index AS stepIndex,step_type AS type,status,
      diagnostic_json AS diagnosticJson,input_tokens AS inputTokens,output_tokens AS outputTokens,
      estimated_cost_usd AS estimatedCostUsd FROM agent_steps WHERE run_id=? ORDER BY step_index`, [run.runId]);
  assert.equal(stepRows.length, run.steps.length, 'API readback and stored run steps have matching cardinality');
  assert.ok(stepRows.every(step => !['model', 'tool'].includes(step.type)
    && Number(step.inputTokens) === 0 && Number(step.outputTokens) === 0
    && Number(step.estimatedCostUsd) === 0), 'stored steps confirm no model, tool, token, or cost usage');
  const storedRevalidation = stepRows.find(step => step.type === 'clarification'
    && parseAcceptanceJson(step.diagnosticJson).kind === 'appointment_slot_selection_revalidation');
  assert.deepEqual(parseAcceptanceJson(storedRevalidation?.diagnosticJson), diagnostic,
    'the API diagnostic matches its persisted database evidence');
  const storedToolRows = await databaseQuery(context,
    'SELECT tool_name AS toolName FROM tool_executions WHERE run_id=?', [run.runId]);
  assert.deepEqual(storedToolRows, [], 'the deterministic selected run persisted no tool execution');
  const cardRow = await databaseQuery(context, `SELECT id,logical_action_id AS logicalActionId,
      parent_card_id AS parentCardId,guest_id AS guestId,session_id AS sessionId,
      source_run_id AS sourceRunId,action_type AS actionType,version,status,
      parameters_json AS parametersJson,impact_json AS impactJson
    FROM assistant_action_cards WHERE id=?`, [card.id], 'get');
  assert.ok(cardRow, 'the pending confirmation card has a durable database row');
  const cardParameters = parseAcceptanceJson(cardRow.parametersJson);
  const cardImpact = parseAcceptanceJson(cardRow.impactJson);
  const expectedParentId = sourceCard?.id || null;
  const expectedVersion = sourceCard ? Number(sourceCard.version) + 1 : 1;
  assert.deepEqual([cardRow.guestId, cardRow.sessionId, cardRow.sourceRunId,
    cardRow.actionType, cardRow.status, Number(cardRow.version), cardRow.parentCardId || null],
  [user.id, result.sessionId, run.runId, 'book_program', 'pending_confirmation', expectedVersion, expectedParentId]);
  assert.ok(cardRow.logicalActionId, 'the card is linked to a durable logical action');
  if (sourceCard) assert.equal(cardRow.logicalActionId, sourceLogicalActionId);
  assert.deepEqual([cardParameters.projectId, cardParameters.date, cardParameters.slotId],
    [projectId, date, selectedSlot.id]);
  assert.deepEqual([cardImpact.slot?.id, cardImpact.slot?.localStart || cardImpact.slot?.start,
    cardImpact.slot?.localEnd || cardImpact.slot?.end],
  [selectedSlot.id, selectedSlot.localStart, selectedSlot.localEnd]);
  assert.deepEqual([card.id, card.actionType, card.status, Number(card.version)],
    [cardRow.id, cardRow.actionType, cardRow.status, Number(cardRow.version)]);

  const observation = result.observation || null;
  assert.ok(observation, 'selection acceptance includes the actual pre/post business-table observation');
  assert.equal(observation.noBusinessWrite, true);
  assert.equal(observation.businessRowsBeforeAfter?.readError, null);
  assert.deepEqual(observation.businessRowsBeforeAfter?.before, expectedBusinessRows);
  assert.deepEqual(observation.businessRowsBeforeAfter?.after, expectedBusinessRows,
    'all six guest business-table counts remain unchanged before confirmation');
  return { firstTurnKind, sourceRunId: sourceRun.runId, sourceCardId: sourceCard?.id || null,
    selectedRunId: run.runId, sessionId: result.sessionId, guestId: user.id, projectId, date,
    selectedSlotId: selectedSlot.id, actionCardId: card.id, actionCardVersion: Number(card.version),
    parentCardId: cardRow.parentCardId || null, stopReason: run.stopReason,
    executionMode: run.executionMode, live: run.live, modelCallCount: run.modelCallCount,
    toolCallCount: run.toolCallCount, inputTokens: run.traceUsage.inputTokens,
    outputTokens: run.traceUsage.outputTokens, totalTokens: run.traceUsage.totalTokens,
    estimatedCostUsd: run.traceUsage.estimatedCostUsd, noBusinessWrite: observation.noBusinessWrite,
    revalidationSource: diagnostic.source, confirmationRequired: diagnostic.confirmationRequired,
    selectionDateEvidence };
}

async function assertDeterministicSlotSelectionRejectsFaults(context, user, actual, expected) {
  const faults = [
    ['live execution mode', value => { value.run.executionMode = 'live'; }],
    ['fake live flag', value => { value.run.live = true; }],
    ['rejected revalidation', value => {
      value.run.stopReason = 'APPOINTMENT_SLOT_REVALIDATION_REJECTED';
      value.actionCard.status = 'rejected';
    }],
    ['missing revalidation diagnostic', value => {
      value.run.steps = value.run.steps.filter(step => step.type !== 'clarification');
    }],
    ['wrong session', value => { value.run.sessionId = 'session-not-the-guest-session'; }],
    ['wrong source run', value => {
      value.run.steps.find(step => step.diagnostic?.kind === 'appointment_slot_selection_revalidation')
        .diagnostic.sourceRunId = 'run-not-the-source-run';
    }],
    ['wrong selected slot', value => {
      value.actionCard.parameters.slotId = 'slot-not-offered';
      value.actionCard.impact.slot.id = 'slot-not-offered';
    }],
    ['nonzero model request count', value => { value.run.modelCallCount = 1; }],
    ['nonzero tool count', value => { value.run.toolCallCount = 1; }],
    ['nonzero token usage', value => {
      value.run.inputTokens = 1;
      value.run.traceUsage.inputTokens = 1;
      value.run.traceUsage.totalTokens = 1;
    }],
    ['nonzero estimated cost', value => {
      value.run.estimatedCostUsd = 0.000001;
      value.run.traceUsage.estimatedCostUsd = 0.000001;
    }],
    ['wrong card version', value => { value.actionCard.version += 1; }]
  ];
  for (const [label, mutate] of faults) {
    const mutated = JSON.parse(JSON.stringify(actual));
    mutate(mutated);
    await assert.rejects(() => assertDeterministicSlotSelectionContract(context, user, mutated, expected),
      assert.AssertionError, `shared slot-selection validator rejects ${label}`);
  }
  const dateFreeNaturalSelection = `我选择 ${expected.selectedSlot.localStart} 至 ${expected.selectedSlot.localEnd}，时段编号 ${expected.selectedSlot.id}`;
  assert.doesNotThrow(() => assertSelectionInputDateCompatible(dateFreeNaturalSelection, expected.date),
    'a natural selection inherits its date from the same-session verified source card or read-only clarification');
  const wrongDate = dateOffset(expected.date, 1);
  assert.throws(() => assertSelectionInputDateCompatible(`${dateFreeNaturalSelection}，日期 ${wrongDate}`,
    expected.date), assert.AssertionError, 'an explicitly conflicting date is rejected');
  return [...faults.map(([label]) => label), 'conflicting explicit date'];
}

async function assistantTool(context, user, toolName, parameters, sessionId = null, options = {}) {
  const args = parameters || {};
  const text = toolName === 'propose_dish_swap'
    ? `我想把日期 ${args.businessDate} 早餐项目行编号 ${args.itemId} 替换为菜品编号 ${args.dishId}，原因：${args.reason}`
    : `Q23ACTION ${toolName} ${JSON.stringify(args)}`;
  return assistantText(context, user, text, sessionId, options);
}

async function confirmAction(context, user, sessionId, card) {
  return assertStatus(await api(context, `/assistant/actions/${encodeURIComponent(card.id)}/confirm`, {
    method: 'POST', token: user.token, headers: { 'Idempotency-Key': `assistant-action:${card.id}:v${card.version}` },
    body: { sessionId, version: card.version }
  }), 200, 'confirm assistant action').actionCard;
}

function firstAssertionFailureSummary(observation, error, sessionStartedAt, { phase = 'first_turn_needs_input_assertion', pendingSteps = null } = {}) {
  return {
    status: 'FAIL', failurePoint: phase,
    receiptStage: observation?.receiptStage || null, receiptStatus: observation?.receiptStatus || null,
    runId: observation?.runId || null, sessionId: observation?.sessionId || null,
    requestedSessionId: observation?.requestedSessionId || null,
    session: { sessionId: observation?.sessionId || null, runId: observation?.runId || null,
      runStatus: observation?.runStatus || null, executionMode: observation?.executionMode || null,
      intentCategory: observation?.intentCategory || null, clarificationCount: observation?.clarificationCount ?? null,
      clarificationState: observation?.clarificationState ?? null, stopReason: observation?.stopReason || null,
      readError: observation?.readError || null, timedOut: observation?.timedOut ?? null,
      actionCardStates: observation?.actionCardStates ?? null, stepCount: observation?.stepStates?.length ?? null },
    executionMode: observation?.executionMode || null, provider: observation?.provider || null,
    model: observation?.model || null, intentCategory: observation?.intentCategory || null,
    clarificationCount: observation?.clarificationCount ?? null, clarificationState: observation?.clarificationState ?? null,
    stopReason: observation?.stopReason || null, readError: observation?.readError || null,
    timedOut: observation?.timedOut ?? null,
    actionCardStates: observation?.actionCardStates ?? null,
    businessRowsBeforeAfter: observation?.businessRowsBeforeAfter || null,
    noBusinessWrite: observation?.noBusinessWrite ?? null,
    usage: { modelCallCount: observation?.modelCallCount ?? null, toolCallCount: observation?.toolCallCount ?? null,
      toolCounts: observation?.toolCounts ?? null,
      inputTokens: observation?.inputTokens ?? null, outputTokens: observation?.outputTokens ?? null,
      totalTokens: observation?.totalTokens ?? null, estimatedCostUsd: observation?.estimatedCostUsd ?? null },
    elapsedMs: observation?.turnElapsedMs ?? null,
    timing: { runDurationMs: observation?.durationMs ?? null, elapsedMs: observation?.turnElapsedMs ?? null,
      turnElapsedMs: observation?.turnElapsedMs ?? null,
      sessionElapsedMs: Number.isFinite(sessionStartedAt)
        ? Math.max(0, Math.round(performance.now() - sessionStartedAt)) : null },
    reachedStep: observation?.reachedStep || null, stepStates: observation?.stepStates ?? null,
    pendingSteps: pendingSteps || [
      { step: 'guest-selects-slot', reason: 'the first needs_input card assertion failed; no slot selection was accepted' },
      { step: 'pending-confirmation-card', reason: 'blocked until a guest-selected slot is received' },
      { step: 'reservation-confirmation-and-readback', reason: 'blocked because no pending_confirmation card exists' }
    ],
    priorEvidenceRef: observation?.evidenceRef || null,
    priorObservedEvidenceRef: observation?.receiptStatus === 'OBSERVED' ? observation.evidenceRef : null,
    assertionError: String(error?.message || error).slice(0, 1200)
  };
}

function appendAssistantFailureSummary({ observation, error, sessionStartedAt, failureSummary, driver, onAssertionFailure }) {
  const config = failureSummary || {};
  const summary = firstAssertionFailureSummary(observation, error, sessionStartedAt, config);
  const failureRef = appendEvidence({ quest: config.quest || 'Q23',
    scenario: config.scenario || 'assistant-run-failure-summary', driver,
    status: config.expectedFailure === true ? 'PASS' : 'FAIL',
    evidence: { ...(config.expectedFailure === true ? { injectedAssertionFailure: 'FAIL' } : {}), failureSummary: summary } });
  onAssertionFailure?.({ failureSummary: summary, failureRef });
  return { failureSummary: summary, failureRef };
}

async function seedEnvironment(context, date) {
  const demo = makeDemoEnvironment(date, fixedInstant, DEMO_ENVIRONMENT_LOCATION);
  for (const [domain, stationId, payload] of [['weather', '', demo.weather],
    ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]]) {
    const key = `q23:${date}:${domain}:${stationId || 'default'}`;
    const data = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const sql = `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,payload_hash,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)`;
    const upsert = context.driver === 'mysql'
      ? ` ON DUPLICATE KEY UPDATE status=VALUES(status),source_name=VALUES(source_name),source_url=VALUES(source_url),observed_at=VALUES(observed_at),expires_at=VALUES(expires_at),payload_hash=VALUES(payload_hash),payload_json=VALUES(payload_json),updated_at=VALUES(updated_at)`
      : ` ON CONFLICT(snapshot_key) DO UPDATE SET status=excluded.status,source_name=excluded.source_name,source_url=excluded.source_url,observed_at=excluded.observed_at,expires_at=excluded.expires_at,payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`;
    await databaseQuery(context, `${sql}${upsert}`, [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain,
      'Stage23 合成环境快照', payload.sourceUrl || '', sqlTime(context, fixedInstant), sqlTime(context, '2026-10-07T00:00:00.000Z'),
      hash, data, sqlTime(context, fixedInstant), sqlTime(context, fixedInstant)], 'run');
  }
}

async function bookableSlots(context, user, date = dateOffset(today, 1)) {
  await seedEnvironment(context, date);
  const result = assertStatus(await api(context, `/projects/project-beach-walk/slots?date=${date}`, { token: user.token }), 200, 'prepare isolated project slots');
  const slots = (result.slots || []).filter(slot => slot.bookable);
  assert.ok(slots.length >= 3, `${context.driver} has multiple current bookable slots: ${JSON.stringify(result.slots)}`);
  return slots;
}

async function allReservationCount(context, guestId) {
  const row = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM reservations WHERE guest_id=?', [guestId], 'get');
  return Number(row.count);
}

async function guestBusinessCounts(context, guestId) {
  const row = await databaseQuery(context, `SELECT
    (SELECT COUNT(*) FROM reservations WHERE guest_id=?) AS reservations,
    (SELECT COUNT(*) FROM meal_orders WHERE guest_id=?) AS mealOrders,
    (SELECT COUNT(*) FROM health_records WHERE guest_id=?) AS healthRecords,
    (SELECT COUNT(*) FROM wellness_drafts WHERE guest_id=?) AS wellnessDrafts,
    (SELECT COUNT(*) FROM meal_menus WHERE guest_id=?) AS mealMenus,
    (SELECT COUNT(*) FROM health_intakes WHERE guest_id=?) AS healthIntakes`,
  [guestId, guestId, guestId, guestId, guestId, guestId], 'get');
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

async function readOnlyDomainProductRoutes(context, user) {
  const scenarios = [
    { agentId: 'domain.physio', text: '请介绍海水浴项目的理疗适用信息。', tools: ['get_physio_context', 'get_therapy_knowledge'] },
    { agentId: 'domain.nutrition', text: '请根据当前档案整理安全的膳食候选。', tools: ['get_nutrition_context', 'get_nutrition_knowledge'] },
    { agentId: 'domain.exercise', text: '请整理当前可参考的沙滩散步活动信息。', tools: ['get_exercise_context', 'get_exercise_knowledge'] },
    { agentId: 'domain.psychology', text: '请介绍可播放的心理陪伴资源。', tools: ['get_psychology_context', 'get_companionship_knowledge'] }
  ];
  const results = [];
  for (const scenario of scenarios) {
    const response = await assistantText(context, user, scenario.text, null, { expectActionCard: false });
    const run = response.run;
    const graph = run.collaboration;
    assert.equal(run.executionMode, 'recorded_fixture', `${scenario.agentId} is an explicitly recorded fixture run`);
    assert.ok(graph?.parent && graph.agents?.length === 1, `${scenario.agentId} has a persisted coordinator parent and one independent child`);
    assert.equal(graph.parent.runId, run.runId);
    const child = graph.agents[0];
    assert.equal(child.agentId, scenario.agentId);
    assert.equal(child.executionMode, 'recorded_fixture');
    assert.equal(child.status, 'completed', `${scenario.agentId} child completed: ${JSON.stringify(child)}`);
    assert.ok(child.model && child.provider && Number(child.inputTokens) > 0 && Number(child.outputTokens) > 0,
      `${scenario.agentId} child has actual model/provider and token usage`);
    assert.ok(child.modelSteps.length >= 2 && child.modelSteps.every(step => step.diagnostic?.providerRequestAttempted === true),
      `${scenario.agentId} child has both provider request steps`);
    assert.deepEqual(child.tools.map(tool => tool.toolName).sort(), [...scenario.tools].sort());
    assert.ok(child.tools.every(tool => tool.status === 'completed' && Number.isFinite(tool.durationMs)));
    assert.ok(graph.parent.modelSteps.length === 1 && graph.selectionSource === 'model');
    assert.equal(graph.selectionValidation?.schemaValid, true);
    assert.equal(graph.selectionValidation?.allowlistValid, true);
    assert.equal(graph.selectionValidation?.responseComplete, true);
    assert.ok(graph.selectedCandidateIds.every(id => graph.candidates.some(item => item.candidateId === id && item.status === 'adopted')));
    const childRow = await databaseQuery(context,
      'SELECT parent_run_id AS parentRunId,agent_id AS agentId,execution_mode AS executionMode FROM agent_runs WHERE id=?',
      [child.runId], 'get');
    assert.deepEqual([childRow.parentRunId, childRow.agentId, childRow.executionMode],
      [run.runId, scenario.agentId, 'recorded_fixture']);
    const toolRows = await databaseQuery(context,
      'SELECT tool_name AS toolName,result_json AS resultJson,status FROM tool_executions WHERE run_id=?', [child.runId]);
    const contextRow = toolRows.find(item => item.toolName.endsWith('_context'));
    assert.ok(contextRow && toolRows.length === 2 && toolRows.every(item => item.status === 'completed'));
    const contextData = parseJsonColumn(contextRow.resultJson, {});
    const allowedIds = scenario.agentId === 'domain.physio' ? (contextData.evaluations || []).map(item => item.projectId)
      : scenario.agentId === 'domain.nutrition' ? (contextData.candidates || []).map(item => item.candidateId)
        : scenario.agentId === 'domain.exercise' ? (contextData.activities || []).map(item => item.projectId)
          : (contextData.resources || []).map(item => item.id);
    assert.ok(child.candidateIds.every(id => allowedIds.includes(id)),
      `${scenario.agentId} only returns candidate IDs present in its own context tool result`);
    assert.ok(Number(graph.graphBudget?.modelCalls) <= 5 && Number(graph.graphBudget?.toolCalls) <= 12);
    assert.ok(Number(graph.graphBudget?.inputTokens || 0) + Number(graph.graphBudget?.outputTokens || 0) <= 8192);
    assert.ok(Number(graph.graphBudget?.estimatedCostUsd || 0) <= 0.10 && Number(graph.graphDurationMs || 0) <= 90_000);
    results.push({ agentId: scenario.agentId, runId: run.runId, childRunId: child.runId,
      childModel: child.model, childProvider: child.provider, childModelCalls: child.modelSteps.length,
      childToolNames: child.tools.map(tool => tool.toolName), childCandidateIds: child.candidateIds,
      selectedCandidateIds: graph.selectedCandidateIds, graphBudget: graph.graphBudget });
  }
  return results;
}

async function prepareGuestMenu(context, user, date = dateOffset(today, 1)) {
  const result = await api(context, '/meals/menus', { method: 'POST', token: user.token, body: { businessDate: date } });
  assert.ok([200, 201].includes(result.status), `${context.driver} creates isolated menu: ${JSON.stringify(result.data)}`);
  const menu = assertStatus(await api(context, `/meals/menu?date=${date}`, { token: user.token }), 200, 'read generated menu');
  assert.ok(menu.menu?.id && menu.items?.length >= 9, `${context.driver} meal menu has real rows`);
  return menu;
}

async function q231(context) {
  const user = await guestUser(context);
  const slots = await bookableSlots(context, user);
  const before = await allReservationCount(context, user.id);
  const proposal = await assistantTool(context, user, 'propose_program_booking', {
    projectId: 'project-beach-walk', date: slots[0].businessDate, slotId: slots[0].id
  });
  assert.equal(proposal.actionCard.status, 'pending_confirmation');
  assert.equal(proposal.actionCard.impact.slot.id, slots[0].id);
  assert.equal(await allReservationCount(context, user.id), before, 'proposal alone must not insert reservation');
  const refreshed = assertStatus(await api(context, `/assistant/runs/${proposal.run.runId}?role=guest`, { token: user.token }), 200, 'refresh unconfirmed action card');
  assert.equal(refreshed.actionCards[0].id, proposal.actionCard.id);
  const source = await databaseQuery(context, 'SELECT guest_id,session_id,source_run_id,version,status FROM assistant_action_cards WHERE id=?', [proposal.actionCard.id], 'get');
  assert.deepEqual([source.guest_id, source.session_id, source.source_run_id, Number(source.version), source.status],
    [user.id, proposal.sessionId, proposal.run.runId, 1, 'pending_confirmation']);
  return { quest: 'Q23.1', scenario: 'persist-pending-booking-card-without-business-write',
    evidence: { cardId: proposal.actionCard.id, status: proposal.actionCard.status, reservationsBeforeAfter: [before, await allReservationCount(context, user.id)] } };
}

async function enforcedBudgetStatus(context) {
  const response = await api(context, '/assistant/status');
  assert.equal(response.status, 200, `assistant budget status is readable: ${JSON.stringify(response.data)}`);
  const status = response.data;
  return { executionMode: status.executionMode, model: status.model, maxRunMs: status.maxRunMs,
    maxModelCalls: status.maxModelCalls, maxToolRounds: status.maxToolRounds,
    maxToolCalls: status.maxToolCalls, maxRunTokens: status.maxRunTokens,
    maxEstimatedCostUsd: status.maxEstimatedCostUsd, timeoutMs: status.timeoutMs,
    toolTimeoutMs: status.toolTimeoutMs, modelRateEstimate: status.modelRateEstimate };
}

function assertEnforcedBudgetStatus(status, limits, { executionMode, model } = {}) {
  assert.equal(status.executionMode, executionMode);
  if (model !== undefined) assert.equal(status.model, model);
  assert.deepEqual({ maxRunMs: status.maxRunMs, maxModelCalls: status.maxModelCalls,
    maxToolRounds: status.maxToolRounds, maxToolCalls: status.maxToolCalls,
    maxRunTokens: status.maxRunTokens, maxEstimatedCostUsd: status.maxEstimatedCostUsd }, {
    maxRunMs: limits.maxRuntimeMs, maxModelCalls: limits.maxModelCalls,
    maxToolRounds: limits.maxToolRounds, maxToolCalls: limits.maxToolCalls,
    maxRunTokens: limits.maxTokens, maxEstimatedCostUsd: limits.maxEstimatedCostUsd
  });
  assert.equal(status.timeoutMs, liveConversationLimits.modelTimeoutMs);
  assert.equal(status.toolTimeoutMs, liveConversationLimits.toolTimeoutMs);
}

async function runRecordedBudgetRollover(context, budgetLimits, profileName) {
  assert.equal(context.driver, 'sqlite');
  assert.ok(context.resourceSession && context.recordedModelBaseUrl,
    'the isolated rollover probe requires the managed Q23 recorded fixture');
  const rolloverStartedAt = performance.now();
  const budgetDirectory = await context.resourceSession.allocateDir(`q23-budget-rollover-${profileName}`);
  const databasePath = path.join(budgetDirectory, 'budget.sqlite');
  const recordedConfig = { NODE_ENV: 'test', LLM_BASE_URL: context.recordedModelBaseUrl,
    LLM_API_KEY: 'q23-recorded-fixture-only', LLM_MODEL: context.recordedModelName || 'q23-recorded-fixture' };
  const emptyUsage = { modelCallCount: 0, toolCallCount: 0, totalTokens: 0, estimatedCostUsd: 0 };
  const firstAdmission = planConversationRunBudget(emptyUsage, 0, 0, budgetLimits);
  assert.equal(firstAdmission.admitted, true);
  assert.equal(firstAdmission.effectiveLimits.maxModelCalls, 8);
  assert.equal(firstAdmission.effectiveLimits.maxTokens, budgetLimits.maxTokens,
    `${profileName} first-run tokens are injected from the selected conversation cap`);
  const firstEnvironment = makeBudgetedApiEnvironment(firstAdmission.effectiveLimits,
    { seed: true, liveConfig: recordedConfig, modelSource: 'recorded_fixture' });
  let firstStage = null;
  await withApiAtDatabase(databasePath, async apiContext => {
    const service = { ...apiContext, driver: 'sqlite', pool: null,
      requestDeadlineAt: rolloverStartedAt + budgetLimits.maxSessionRuntimeMs - budgetLimits.cleanupReserveMs };
    const actual = await enforcedBudgetStatus(service);
    assertEnforcedBudgetStatus(actual, firstAdmission.effectiveLimits,
      { executionMode: 'recorded_fixture', model: recordedConfig.LLM_MODEL });
    const user = await guestUser(service);
    const date = dateOffset(today, 1);
    const slots = await bookableSlots(service, user, date);
    const businessBefore = await guestBusinessCounts(service, user.id);
    const reservationCountBefore = await allReservationCount(service, user.id);
    assertRunFitsRemainingConversation(firstAdmission, rolloverStartedAt);
    let firstObservation = null;
    const first = await assistantText(service, user,
      `我想预约沙滩漫步项目，项目编号 project-beach-walk，日期 ${date}。请列出可选时段；我还没有选择，不要替我选。`,
      null, { onRunObserved: async (_run, observation) => { firstObservation = observation; } });
    assert.equal(first.run.executionMode, 'recorded_fixture');
    assert.equal(first.actionCard?.status, 'needs_input', 'the fixture first run asks the guest to choose a slot');
    assert.equal(first.run.clarificationCount, 0);
    assert.equal(firstObservation?.noBusinessWrite, true);
    assert.deepEqual(firstObservation?.businessRowsBeforeAfter?.before, businessBefore);
    assert.deepEqual(firstObservation?.businessRowsBeforeAfter?.after, businessBefore);
    assert.equal(await allReservationCount(service, user.id), reservationCountBefore);
    const usage = usageFromAssistantRun(first.run);
    assert.equal(usage.requestCountMatchesUsage, true,
      'first-run attempted model requests match parent plus nested model-step evidence');
    assert.equal(usage.modelCallCount, 3,
      'the first booking run exercises three recorded model requests across its multiple tool rounds');
    assert.equal(usage.toolCallCount, 3);
    assert.deepEqual(Object.keys(first.run.toolCounts).sort(),
      ['list_project_slots', 'list_projects', 'propose_program_booking'].sort());
    assert.ok(Number.isFinite(usage.totalTokens) && usage.totalTokens > 0);
    assert.ok(Number.isFinite(usage.estimatedCostUsd) && usage.estimatedCostUsd >= 0);
    assert.ok(usage.modelCallCount <= firstAdmission.effectiveLimits.maxModelCalls
      && usage.toolCallCount <= firstAdmission.effectiveLimits.maxToolCalls
      && usage.totalTokens <= firstAdmission.effectiveLimits.maxTokens
      && usage.estimatedCostUsd <= firstAdmission.effectiveLimits.maxEstimatedCostUsd + 1e-12);
    assert.ok(Number.isFinite(first.run.durationMs) && first.run.durationMs > 0
      && first.run.durationMs <= firstAdmission.effectiveLimits.maxRuntimeMs);
    const toolRows = await databaseQuery(service, `SELECT tool_name AS toolName,status,error_code AS errorCode
      FROM tool_executions WHERE run_id=? ORDER BY started_at,id`, [first.run.runId]);
    assert.deepEqual(toolRows.map(row => [row.toolName, row.status, row.errorCode])
      .sort(([left], [right]) => left.localeCompare(right)), [
      ['list_projects', 'completed', null], ['list_project_slots', 'completed', null],
      ['propose_program_booking', 'completed', null]
    ].sort(([left], [right]) => left.localeCompare(right)));
    const chosenSlot = first.actionCard.impact.availableSlots[0];
    assert.ok(chosenSlot?.id && slots.some(slot => slot.id === chosenSlot.id && slot.bookable));
    firstStage = { userId: user.id, sessionId: first.sessionId, run: first.run, usage,
      chosenSlot: { id: chosenSlot.id, localStart: chosenSlot.localStart, localEnd: chosenSlot.localEnd },
      date, reservationCountBefore, businessBefore, enforcedBudget: actual };
  }, firstEnvironment, { resourceSession: context.resourceSession });

  assert.ok(firstStage, 'the first managed API run returned its observed conversation usage');
  const elapsedBeforeSecond = performance.now() - rolloverStartedAt;
  const secondAdmission = planConversationRunBudget(firstStage.usage, elapsedBeforeSecond, 1, budgetLimits);
  assert.equal(secondAdmission.admitted, true,
    'known usage and elapsed time admit the second bounded run before its API starts');
  assert.equal(secondAdmission.remaining.modelCalls, 5);
  assert.equal(secondAdmission.effectiveLimits.maxModelCalls, 5,
    'the second service receives the five actual calls left after the first run used three');
  assert.equal(secondAdmission.remaining.tokens, budgetLimits.maxTokens - firstStage.usage.totalTokens,
    `${profileName} rollover uses the first run's actual reported token remainder`);
  assert.equal(secondAdmission.effectiveLimits.maxTokens,
    Math.min(budgetLimits.maxTokensPerRun, secondAdmission.remaining.tokens),
  `${profileName} second-run token cap equals the conversation remainder, not a display-only value`);
  const secondEnvironment = makeBudgetedApiEnvironment(secondAdmission.effectiveLimits,
    { seed: false, liveConfig: recordedConfig, modelSource: 'recorded_fixture' });
  let secondStage = null;
  await withApiAtDatabase(databasePath, async apiContext => {
    const service = { ...apiContext, driver: 'sqlite', pool: null,
      requestDeadlineAt: rolloverStartedAt + budgetLimits.maxSessionRuntimeMs - budgetLimits.cleanupReserveMs };
    const actual = await enforcedBudgetStatus(service);
    assertEnforcedBudgetStatus(actual, secondAdmission.effectiveLimits,
      { executionMode: 'recorded_fixture', model: recordedConfig.LLM_MODEL });
    const user = await guestUser(service);
    assert.equal(user.id, firstStage.userId, 'the same isolated guest survives the managed API restart');
    const beforeFollowup = await allReservationCount(service, user.id);
    assert.equal(beforeFollowup, firstStage.reservationCountBefore);
    assertRunFitsRemainingConversation(secondAdmission, rolloverStartedAt);
    let followupObservation = null;
    const requestsBeforeFollowup = await recordedModelRequestCount(context.recordedModelBaseUrl);
    const followup = await assistantText(service, user, '请简单介绍沙滩漫步。', firstStage.sessionId,
      { expectActionCard: false,
        onRunObserved: async (_run, observation) => { followupObservation = observation; } });
    const requestsAfterFollowup = await recordedModelRequestCount(context.recordedModelBaseUrl);
    assert.equal(followup.actionCard, null, 'the budget probe follow-up is read-only and creates no action card');
    assert.equal(followupObservation?.noBusinessWrite, true);
    assert.equal(await allReservationCount(service, user.id), beforeFollowup,
      'the second run does not write a reservation');
    const followupUsage = usageFromAssistantRun(followup.run);
    assert.equal(followupUsage.requestCountMatchesUsage, true,
      'second-run attempted model requests match parent plus nested model-step evidence');
    if (budgetLimits.maxTokens === legacy8192RegressionLimits.maxTokens) {
      assert.equal(followup.run.stopReason, 'GRAPH_TOKEN_BUDGET',
        'the explicit 8192-token regression blocks a request whose guarded input exceeds the actual remainder');
      assert.equal(followupUsage.modelCallCount, 0,
        'ordinary preflight spends no request when the low-budget remainder cannot fit the input');
    } else {
      assert.notEqual(followup.run.stopReason, 'GRAPH_TOKEN_BUDGET',
        'the standard 32768-token profile admits the fixture request when the actual remainder can fit it');
      assert.ok(followupUsage.modelCallCount > 0,
        'the standard profile exercises a real recorded-provider run under the injected remainder');
    }
    assert.equal(requestsAfterFollowup - requestsBeforeFollowup, followupUsage.modelCallCount,
      'the request log agrees with the actual model-call counter in either budget profile');
    const followupPreflight = followup.run.steps.map(step => step.diagnostic?.modelPreflight).find(Boolean)
      || followup.run.steps.at(-1)?.diagnostic?.modelPreflight;
    if (budgetLimits.maxTokens === legacy8192RegressionLimits.maxTokens) {
      assert.equal(followupPreflight?.providerRequestAttempted, false);
      assert.ok(followupPreflight?.request?.guardedEstimatedInputTokens > secondAdmission.effectiveLimits.maxTokens);
    }
    assert.equal(followupUsage.toolCallCount, 0);
    assert.ok(followupUsage.modelCallCount <= secondAdmission.effectiveLimits.maxModelCalls
      && followupUsage.toolCallCount <= secondAdmission.effectiveLimits.maxToolCalls
      && followupUsage.totalTokens <= secondAdmission.effectiveLimits.maxTokens
      && followupUsage.estimatedCostUsd <= secondAdmission.effectiveLimits.maxEstimatedCostUsd + 1e-12,
    'the recorded second run stays within the exact remaining aggregate caps');
    assert.equal(followup.run.sessionId, firstStage.sessionId);
    assert.ok(firstStage.run.actionCards.some(card => card.status === 'needs_input'),
      'the open booking card remains unchanged while the budget probe follows in the same conversation');
    secondStage = { run: followup.run, usage: followupUsage, observation: followupObservation,
      preflight: followupPreflight?.request ? {
        guardedEstimatedInputTokens: followupPreflight.request.guardedEstimatedInputTokens,
        providerRequestAttempted: followupPreflight.providerRequestAttempted
      } : null,
      requestLogDelta: requestsAfterFollowup - requestsBeforeFollowup,
      enforcedBudget: actual, reservationCountAfter: beforeFollowup };
  }, secondEnvironment, { resourceSession: context.resourceSession });

  assert.ok(secondStage);
  const aggregate = aggregateLiveUsage([firstStage.run, secondStage.run]);
  const aggregateProviderRequests = firstStage.usage.providerRequestAttemptedCount
    + secondStage.usage.providerRequestAttemptedCount;
  assert.equal(aggregate.modelCallCount, aggregateProviderRequests,
    'aggregate model count includes every attempted parent and nested request from both runs');
  assert.ok(aggregate.modelCallCount <= liveConversationLimits.maxProviderRequests);
  assert.ok(aggregate.toolCallCount <= liveConversationLimits.maxToolCalls);
  assert.ok(aggregate.totalTokens <= budgetLimits.maxTokens);
  assert.ok(aggregate.estimatedCostUsd <= budgetLimits.maxEstimatedCostUsd + 1e-12);
  const elapsedMs = Math.ceil(performance.now() - rolloverStartedAt);
  assert.ok(elapsedMs <= budgetLimits.maxSessionRuntimeMs);
  return { mode: 'recorded_fixture', profileName, conversationTokenLimit: budgetLimits.maxTokens,
    isolatedDatabase: path.relative(projectRoot, databasePath),
    firstRun: { runId: firstStage.run.runId, modelCallCount: firstStage.usage.modelCallCount,
      providerRequestAttemptedCount: firstStage.usage.providerRequestAttemptedCount,
      toolCallCount: firstStage.usage.toolCallCount, toolCounts: firstStage.run.toolCounts,
      actualLimits: firstStage.enforcedBudget, actionCardStatus: firstStage.run.actionCards.at(-1)?.status || null },
    secondRun: { runId: secondStage.run.runId, stopReason: secondStage.run.stopReason,
      preflight: secondStage.preflight, modelCallCount: secondStage.usage.modelCallCount,
      providerRequestAttemptedCount: secondStage.usage.providerRequestAttemptedCount,
      toolCallCount: secondStage.usage.toolCallCount, actualLimits: secondStage.enforcedBudget,
      remainingTokenBudget: secondAdmission.remaining.tokens,
      enforcedRunTokenLimit: secondAdmission.effectiveLimits.maxTokens,
      noBusinessWrite: secondStage.observation?.noBusinessWrite ?? null,
      reservationCountAfter: secondStage.reservationCountAfter },
    aggregate: { modelCallCount: aggregate.modelCallCount, providerRequestAttemptedCount: aggregateProviderRequests,
      toolCallCount: aggregate.toolCallCount, totalTokens: aggregate.totalTokens,
      estimatedCostUsd: aggregate.estimatedCostUsd, elapsedMs },
    fixtureBoundary: 'new recorded-fixture evidence for a three-request booking flow; it does not reconstruct the unrecorded live tool response' };
}

async function q232(context) {
  const user = await guestUser(context);
  const slots = await bookableSlots(context, user);
  const before = await allReservationCount(context, user.id);
  const initialBudgetAdmission = planConversationRunBudget({ modelCallCount: 0, toolCallCount: 0,
    totalTokens: 0, estimatedCostUsd: 0 }, 0, 0);
  assert.equal(initialBudgetAdmission.admitted, true);
  assert.equal(initialBudgetAdmission.effectiveLimits.maxModelCalls, 8,
    'the authorized first run is bounded by the eight-request conversation ceiling');
  assert.equal(initialBudgetAdmission.effectiveLimits.maxTokens, 32_768,
    'the standard first run receives the user-authorized 32768-token conversation cap');
  const rolloverBudgetAdmission = planConversationRunBudget({ modelCallCount: 3, toolCallCount: 3,
    totalTokens: 3_000, estimatedCostUsd: 0.01 }, 10_000, 1);
  assert.equal(rolloverBudgetAdmission.admitted, true);
  assert.equal(rolloverBudgetAdmission.remaining.modelCalls, 5);
  assert.equal(rolloverBudgetAdmission.effectiveLimits.maxModelCalls, 5,
    'a later run receives the actual five-request remainder after three attempted requests');
  assert.equal(rolloverBudgetAdmission.projectedUsage.modelCalls, 8,
    'first and remaining requests land exactly on the conversation boundary');
  assert.equal(rolloverBudgetAdmission.remaining.tokens, 29_768);
  assert.equal(rolloverBudgetAdmission.effectiveLimits.maxTokens, 29_768,
    'standard later-run token injection is capped by the true 32768-token remainder');
  const exactBoundaryAdmission = planConversationRunBudget({ modelCallCount: 7, toolCallCount: 0,
    totalTokens: 0, estimatedCostUsd: 0 }, 10_000, 1);
  assert.equal(exactBoundaryAdmission.admitted, true);
  assert.equal(exactBoundaryAdmission.effectiveLimits.maxModelCalls, 1);
  assert.equal(exactBoundaryAdmission.projectedUsage.modelCalls, 8);
  const exhaustedBudgetAdmission = planConversationRunBudget({ modelCallCount: 8, toolCallCount: 12,
    totalTokens: 32_768, estimatedCostUsd: 0.10 }, 80_000, 1);
  assert.equal(exhaustedBudgetAdmission.admitted, false,
    'the guard rejects an exhausted conversation before starting another run');
  assert.deepEqual(Object.entries(exhaustedBudgetAdmission.checks).filter(([, passed]) => !passed).map(([key]) => key),
    ['modelCallsWithinLimit', 'toolCallsWithinLimit', 'tokensWithinLimit', 'estimatedCostWithinLimit', 'runtimeAndReservesWithinLimit']);
  const overLimitBudgetAdmission = planConversationRunBudget({ modelCallCount: 9, toolCallCount: 0,
    totalTokens: 0, estimatedCostUsd: 0 }, 1_000, 1);
  assert.equal(overLimitBudgetAdmission.admitted, false, 'a nine-request recorded usage cannot receive another run');
  const unknownBudgetAdmission = planConversationRunBudget({ modelCallCount: 1, toolCallCount: 1,
    totalTokens: null, estimatedCostUsd: 0.001 }, 1_000, 1);
  assert.equal(unknownBudgetAdmission.admitted, false, 'unknown usage blocks admission instead of being treated as zero');
  const tokenExhaustionAdmission = planConversationRunBudget({ modelCallCount: 0, toolCallCount: 0,
    totalTokens: 32_768, estimatedCostUsd: 0 }, 1_000, 1);
  const legacy8192ExhaustionAdmission = planConversationRunBudget({ modelCallCount: 0, toolCallCount: 0,
    totalTokens: 8_192, estimatedCostUsd: 0 }, 1_000, 1, legacy8192RegressionLimits);
  const legacy1717RemainderAdmission = planConversationRunBudget({ modelCallCount: 3, toolCallCount: 3,
    totalTokens: 6_475, estimatedCostUsd: 0.01 }, 10_000, 1, legacy8192RegressionLimits);
  const costExhaustionAdmission = planConversationRunBudget({ modelCallCount: 0, toolCallCount: 0,
    totalTokens: 0, estimatedCostUsd: 0.10 }, 1_000, 1);
  const toolExhaustionAdmission = planConversationRunBudget({ modelCallCount: 0, toolCallCount: 12,
    totalTokens: 0, estimatedCostUsd: 0 }, 1_000, 1);
  const runtimeExhaustionAdmission = planConversationRunBudget({ modelCallCount: 0, toolCallCount: 0,
    totalTokens: 0, estimatedCostUsd: 0 }, 75_000, 1);
  assert.equal(tokenExhaustionAdmission.admitted, false);
  assert.equal(legacy8192ExhaustionAdmission.admitted, false,
    'the old 8192-token path remains an explicit low-budget rejection regression');
  assert.equal(legacy1717RemainderAdmission.admitted, true);
  assert.equal(legacy1717RemainderAdmission.remaining.tokens, 1_717);
  assert.equal(legacy1717RemainderAdmission.effectiveLimits.maxTokens, 1_717,
    'the low-budget run receives exactly 1717 remaining tokens');
  assert.equal(costExhaustionAdmission.admitted, false);
  assert.equal(toolExhaustionAdmission.admitted, false);
  assert.equal(runtimeExhaustionAdmission.admitted, false);
  assert.throws(() => makeBudgetedApiEnvironment({ ...initialBudgetAdmission.effectiveLimits, maxModelCalls: 0 },
    { seed: false }), /non-positive per-run budget limits/,
  'an exhausted dimension is rejected rather than written as zero and replaced by a server default');
  const budgetRolloverEvidence = context.driver === 'sqlite' ? {
    standard32768: await runRecordedBudgetRollover(context, liveConversationLimits, 'standard-32768'),
    legacy8192: await runRecordedBudgetRollover(context, legacy8192RegressionLimits, 'legacy-8192')
  } : null;
  const unknownUsageProviderBefore = await recordedModelRequestCount(context.recordedModelBaseUrl);
  const failedUnknownUsage = await assistantText(context, user,
    `Q23_RECORDED_FAULT=provider-no-usage-once-${context.driver} 请概括海屿康养社区的服务。`, null,
    { expectActionCard: false, expectedRunStatus: 'failed' });
  assert.equal(failedUnknownUsage.run.modelCallCount, 1, 'the controlled provider failure is recorded as one actual request');
  assert.equal(failedUnknownUsage.run.modelUsage.length, 1);
  assert.equal(failedUnknownUsage.run.modelUsage[0].requestAttempted, true);
  const unknownUsageRetryResponse = await api(context,
    `/assistant/runs/${encodeURIComponent(failedUnknownUsage.run.runId)}/retry`,
    { method: 'POST', token: user.token, body: { role: 'guest' } });
  assert.ok([200, 202].includes(unknownUsageRetryResponse.status));
  assert.equal(unknownUsageRetryResponse.data.runId, failedUnknownUsage.run.runId);
  let unknownUsageRetry = unknownUsageRetryResponse.data;
  const unknownUsageRetryDeadline = performance.now() + 15_000;
  while (performance.now() < unknownUsageRetryDeadline && ['queued', 'running'].includes(unknownUsageRetry.status)) {
    await new Promise(resolve => setTimeout(resolve, 100));
    const readback = await api(context, `/assistant/runs/${encodeURIComponent(failedUnknownUsage.run.runId)}?role=guest`,
      { token: user.token });
    assert.equal(readback.status, 200);
    unknownUsageRetry = readback.data;
  }
  assert.equal(unknownUsageRetry.status, 'completed');
  assert.equal(unknownUsageRetry.stopReason, 'GRAPH_USAGE_UNKNOWN',
    'an attempted provider request with missing usage blocks its retry before another call');
  assert.equal(unknownUsageRetry.modelCallCount, 1);
  assert.equal(unknownUsageRetry.steps.at(-1)?.diagnostic?.modelPreflight?.providerRequestAttempted, false);
  const unknownUsageProviderAfter = await recordedModelRequestCount(context.recordedModelBaseUrl);
  assert.equal(unknownUsageProviderAfter - unknownUsageProviderBefore, 1,
    'unknown usage retry adds no provider request beyond the single failed request');
  const successfulUnknownUsage = [];
  for (const mode of ['missing', 'null', 'partial']) {
    const providerBefore = await recordedModelRequestCount(context.recordedModelBaseUrl);
    const result = await assistantText(context, user,
      `Q23_RECORDED_FAULT=success-usage-${mode}-once-${context.driver} 请查询海屿康养社区的康养项目列表和服务内容。`,
      null, { expectActionCard: false });
    const providerAfter = await recordedModelRequestCount(context.recordedModelBaseUrl);
    const modelUsage = result.run.modelUsage[0];
    const usageDiagnostic = result.run.steps.find(step => step.type === 'model')?.diagnostic;
    assert.equal(result.run.status, 'completed');
    assert.equal(result.run.stopReason, 'GRAPH_USAGE_UNKNOWN', `${mode} usage blocks the next model request`);
    assert.equal(result.run.usageReported, false, 'the public run receipt labels estimated aggregates as not fully reported');
    assert.equal(result.run.modelCallCount, 1, 'exactly one successful provider request was attempted');
    assert.equal(providerAfter - providerBefore, 1, 'the recorded provider confirms exactly one actual request');
    assert.equal(result.run.toolCallCount, 0, 'the returned tool call is not executed when usage is unknown');
    assert.deepEqual(result.run.toolCounts, {});
    assert.equal(modelUsage.requestAttempted, true);
    assert.equal(modelUsage.usageReported, false);
    assert.equal(modelUsage.usageUnavailableReason, 'provider_response_usage_missing_or_incomplete');
    assert.equal(modelUsage.inputUsageSource, mode === 'partial' ? 'recorded_fixture' : 'server_estimate');
    assert.equal(modelUsage.outputUsageSource, 'server_estimate');
    assert.ok(Number.isSafeInteger(modelUsage.inputTokens) && Number.isSafeInteger(modelUsage.outputTokens),
      'estimated fallback accounting remains numeric while the reported-usage status stays unknown');
    assert.equal(usageDiagnostic?.usageReported, false);
    assert.equal(usageDiagnostic?.usageFieldsReported?.inputTokens, mode === 'partial');
    assert.equal(usageDiagnostic?.usageFieldsReported?.outputTokens, false);
    const extractedUsage = usageFromAssistantRun(result.run);
    const aggregatedUsage = aggregateLiveUsage([extractedUsage]);
    const nextRunAdmission = planConversationRunBudget(aggregatedUsage, 1_000, 1);
    assert.equal(extractedUsage.usageKnown, false,
      `${mode} actual run/trace usageReported=false remains unknown after extraction`);
    assert.equal(extractedUsage.usageReported, false);
    assert.equal(extractedUsage.modelCallCount, 1, 'the actual attempted request count is preserved');
    assert.equal(extractedUsage.providerRequestAttemptedCount, 1);
    assert.equal(extractedUsage.requestCountMatchesUsage, true);
    assert.ok(Number.isSafeInteger(extractedUsage.inputTokens) && Number.isSafeInteger(extractedUsage.outputTokens),
      'numeric actual/estimated token diagnostics remain available with their source labels');
    assert.equal(extractedUsage.usageDiagnostics[0].usageReported, false);
    assert.equal(extractedUsage.usageDiagnostics[0].inputUsageSource,
      mode === 'partial' ? 'recorded_fixture' : 'server_estimate');
    assert.equal(extractedUsage.usageDiagnostics[0].outputUsageSource, 'server_estimate');
    assert.equal(aggregatedUsage.usageKnown, false,
      `${mode} unknown status survives aggregateLiveUsage`);
    assert.equal(aggregatedUsage.unknownUsageAttemptCount, 1);
    assert.equal(aggregatedUsage.providerRequestAttemptedCount, 1);
    assert.equal(nextRunAdmission.admitted, false,
      `${mode} actual run blocks the next run before a new API environment can be created`);
    assert.equal(nextRunAdmission.checks.observedUsageKnown, false);
    assert.equal(nextRunAdmission.effectiveLimits, null);
    assert.throws(() => makeBudgetedApiEnvironment(nextRunAdmission.effectiveLimits,
      { seed: false, liveConfig: {}, modelSource: 'recorded_fixture' }), /missing, unknown/,
    'unknown usage cannot produce an API/provider startup environment');
    successfulUnknownUsage.push({ mode, stopReason: result.run.stopReason,
      modelCallCount: result.run.modelCallCount, providerRequestDelta: providerAfter - providerBefore,
      toolCallCount: result.run.toolCallCount, usageReported: modelUsage.usageReported,
      usageFieldsReported: usageDiagnostic.usageFieldsReported,
      inheritedBudgetAdmission: { usageKnown: aggregatedUsage.usageKnown,
        unknownUsageAttemptCount: aggregatedUsage.unknownUsageAttemptCount,
        admitted: nextRunAdmission.admitted, observedUsageKnown: nextRunAdmission.checks.observedUsageKnown,
        preservedRequestCount: aggregatedUsage.providerRequestAttemptedCount,
        inputUsageSources: aggregatedUsage.inputUsageSources,
        outputUsageSources: aggregatedUsage.outputUsageSources } });
  }
  const zeroUsageProviderBefore = await recordedModelRequestCount(context.recordedModelBaseUrl);
  const reportedZeroUsage = await assistantText(context, user,
    `Q23_RECORDED_FAULT=success-usage-zero-once-${context.driver} 请查询海屿康养社区的康养项目列表和服务内容。`,
    null, { expectActionCard: false });
  const zeroUsageProviderAfter = await recordedModelRequestCount(context.recordedModelBaseUrl);
  assert.equal(reportedZeroUsage.run.stopReason, 'MODEL_RESPONSE_COMPLETED');
  assert.equal(reportedZeroUsage.run.usageReported, true);
  assert.equal(reportedZeroUsage.run.modelCallCount, 2,
    'a complete reported zero is known usage and permits the tool follow-up request');
  assert.equal(reportedZeroUsage.run.modelUsage[0].usageReported, true);
  assert.equal(reportedZeroUsage.run.modelUsage[0].inputTokens, 0);
  assert.equal(reportedZeroUsage.run.modelUsage[0].outputTokens, 0);
  assert.equal(reportedZeroUsage.run.modelUsage[0].inputUsageSource, 'recorded_fixture');
  assert.equal(reportedZeroUsage.run.modelUsage[0].outputUsageSource, 'recorded_fixture');
  assert.equal(zeroUsageProviderAfter - zeroUsageProviderBefore, 2,
    'the actual recorded-provider count includes both requests after a complete zero-usage response');
  const reportedZeroExtracted = usageFromAssistantRun(reportedZeroUsage.run);
  const reportedZeroAggregate = aggregateLiveUsage([reportedZeroExtracted]);
  const reportedZeroAdmission = planConversationRunBudget(reportedZeroAggregate, 1_000, 1);
  assert.equal(reportedZeroExtracted.usageKnown, true);
  assert.equal(reportedZeroAggregate.usageKnown, true);
  assert.equal(reportedZeroExtracted.usageDiagnostics[0].inputTokens, 0);
  assert.equal(reportedZeroExtracted.usageDiagnostics[0].outputTokens, 0);
  assert.equal(reportedZeroAdmission.admitted, true,
    'a complete reported zero remains known through extraction, aggregation, and next-run admission');
  const reportedZeroUsageEvidence = { modelCallCount: reportedZeroUsage.run.modelCallCount,
    providerRequestDelta: zeroUsageProviderAfter - zeroUsageProviderBefore,
    firstUsage: reportedZeroUsage.run.modelUsage[0], stopReason: reportedZeroUsage.run.stopReason,
    inheritedBudgetAdmission: { usageKnown: reportedZeroAggregate.usageKnown,
      admitted: reportedZeroAdmission.admitted, requestCount: reportedZeroAggregate.providerRequestAttemptedCount } };
  const replayText = `我想预约沙滩漫步项目，项目编号 project-beach-walk，日期 ${slots[0].businessDate}。请列出可选时段；我还没有选择，不要替我选。`;
  const requestsBeforeReplay = await recordedModelRequestCount(context.recordedModelBaseUrl);
  const replay = await assistantText(context, user, replayText, null, { failureSummary: {
    quest: 'Q23.2', scenario: 'first-turn-needs-input-card-assertion-failure', phase: 'first_turn_needs_input_card_assertion',
    pendingSteps: [
      { step: 'guest-selects-slot', reason: 'no needs_input card was persisted, so no guest-selected slot was accepted' },
      { step: 'pending-confirmation-card', reason: 'blocked until the guest selects an offered slot' },
      { step: 'reservation-confirmation-and-readback', reason: 'blocked until a pending_confirmation card can be explicitly confirmed' }
    ]
  } });
  assert.equal(replay.actionCard?.actionType, 'book_program');
  assert.equal(replay.actionCard.status, 'needs_input');
  assert.ok(replay.actionCard.missingFields.includes('本人选择的时段'));
  assert.ok(replay.actionCard.impact.availableSlots.length > 0);
  assert.equal(replay.run.clarificationCount, 0, 'a legal missing slot is a structured clarification, not an understanding failure');
  assert.deepEqual(Object.keys(replay.run.toolCounts).sort(), ['list_project_slots', 'list_projects', 'propose_program_booking'].sort());
  const requestsAfterReplay = await recordedModelRequestCount(context.recordedModelBaseUrl);
  const replayProviderRequestDelta = requestsAfterReplay - requestsBeforeReplay;
  assert.equal(replayProviderRequestDelta, replay.run.modelCallCount,
    'ordinary execution request count agrees with actual recorded-provider request log');
  const chosenOption = replay.actionCard.impact.availableSlots[0];
  assert.ok(slots.some(item => item.id === chosenOption.id && item.bookable), 'the offered slot came from the read-only service result');
  const otherOption = replay.actionCard.impact.availableSlots.find(item => item.id !== chosenOption.id);
  assert.ok(otherOption, 'the card offers multiple candidates for ambiguity rejection');
  const invalidSelections = [
    `我不要选择沙滩漫步时段编号 ${chosenOption.id}。`,
    `我选择沙滩漫步时段编号 ${chosenOption.id} 和时段编号 ${otherOption.id}。`,
    '我选择沙滩漫步时段编号 unavailable-slot。'
  ];
  for (const invalidText of invalidSelections) {
    const requestCountBefore = await recordedModelRequestCount(context.recordedModelBaseUrl);
    const invalid = await assistantText(context, user, invalidText, replay.sessionId, { expectActionCard: false });
    assert.equal(invalid.run.modelCallCount, 0, 'an ambiguous, negative, or non-matching card selection is rejected without a model request');
    assert.equal(invalid.run.toolCallCount, 0);
    assert.equal(invalid.run.stopReason, 'APPOINTMENT_SLOT_SELECTION_REJECTED');
    assert.equal(await recordedModelRequestCount(context.recordedModelBaseUrl), requestCountBefore,
      'invalid card selection does not reach the recorded provider');
    const currentCard = await databaseQuery(context, `SELECT id,version,status FROM assistant_action_cards
      WHERE id=? AND guest_id=? AND session_id=?`, [replay.actionCard.id, user.id, replay.sessionId], 'get');
    assert.deepEqual([currentCard.id, Number(currentCard.version), currentCard.status],
      [replay.actionCard.id, replay.actionCard.version, 'needs_input'], 'rejection leaves the current card version intact');
  }
  const businessBeforeSelection = await guestBusinessCounts(context, user.id);
  let selected;
  let lowBudgetSelection = null;
  if (context.driver === 'sqlite') {
    context.baseUrl = await context.restartApi({ ASSISTANT_MAX_TOKENS: '256', DEMO_SEED: '0' });
    try {
      const status = assertStatus(await api(context, '/assistant/status'), 200, 'read low-token acceptance service status');
      assert.equal(status.maxRunTokens, 256, 'selection regression runs with a deliberately small token budget');
      const requestCountBefore = await recordedModelRequestCount(context.recordedModelBaseUrl);
      selected = await assistantText(context, user,
        `我选择沙滩漫步时段编号 ${chosenOption.id}，日期 ${slots[0].businessDate}。`, replay.sessionId);
      const requestCountAfterSelection = await recordedModelRequestCount(context.recordedModelBaseUrl);
      assert.equal(requestCountAfterSelection, requestCountBefore, 'structured-card selection does not send a provider request');
      assert.equal(selected.run.modelCallCount, 0);
      assert.equal(selected.run.toolCallCount, 0);
      assert.deepEqual(await guestBusinessCounts(context, user.id), businessBeforeSelection,
        'low-budget selection leaves all six guest business tables unchanged before confirmation');
      lowBudgetSelection = { configuredMaxTokens: status.maxRunTokens, providerRequestDelta: 0,
        modelCallCount: selected.run.modelCallCount, toolCallCount: selected.run.toolCallCount };

      const requestCountBeforeBlock = await recordedModelRequestCount(context.recordedModelBaseUrl);
      const blockedOrdinaryRun = await assistantText(context, user,
        '请详细介绍海屿康养社区的日常服务和环境特点。', selected.sessionId, { expectActionCard: false });
      assert.equal(blockedOrdinaryRun.run.stopReason, 'GRAPH_TOKEN_BUDGET',
        'an ordinary model call whose estimated input cannot fit is blocked before provider admission');
      assert.equal(blockedOrdinaryRun.run.modelCallCount, 0);
      assert.equal(await recordedModelRequestCount(context.recordedModelBaseUrl), requestCountBeforeBlock,
        'a rejected preflight leaves the actual recorded-provider request count unchanged');
      const preflight = blockedOrdinaryRun.run.steps.at(-1)?.diagnostic?.modelPreflight;
      assert.equal(preflight?.providerRequestAttempted, false);
      assert.ok(preflight?.request?.guardedEstimatedInputTokens > status.maxRunTokens,
        'the offline large-input rejection records its conservative estimate and the configured limit');
      lowBudgetSelection.ordinaryPreflight = { stopReason: blockedOrdinaryRun.run.stopReason,
        guardedEstimatedInputTokens: preflight.request.guardedEstimatedInputTokens,
        providerRequestDelta: 0, modelCallCount: blockedOrdinaryRun.run.modelCallCount };
    } finally {
      context.baseUrl = await context.restartApi();
    }
  } else {
    selected = await assistantText(context, user,
      `我选择沙滩漫步时段编号 ${chosenOption.id}，日期 ${slots[0].businessDate}。`, replay.sessionId);
    assert.equal(selected.run.modelCallCount, 0);
    assert.equal(selected.run.toolCallCount, 0);
      assert.deepEqual(await guestBusinessCounts(context, user.id), businessBeforeSelection,
        'deterministic selection leaves all six guest business tables unchanged before confirmation');
  }
  const needsInputSelectionContract = await assertDeterministicSlotSelectionContract(context, user, selected, {
    firstTurnKind: 'needs_input_action_card', sourceRun: replay.run, sourceCard: replay.actionCard,
    selectedSlot: chosenOption, projectId: 'project-beach-walk', date: slots[0].businessDate,
    expectedBusinessRows: businessBeforeSelection, bookableSlots: slots
  });
  const deterministicSelectionRejectedFaults = await assertDeterministicSlotSelectionRejectsFaults(context, user,
    selected, { firstTurnKind: 'needs_input_action_card', sourceRun: replay.run, sourceCard: replay.actionCard,
      selectedSlot: chosenOption, projectId: 'project-beach-walk', date: slots[0].businessDate,
      expectedBusinessRows: businessBeforeSelection, bookableSlots: slots });
  assert.equal(selected.actionCard.status, 'pending_confirmation');
  assert.equal(selected.actionCard.impact.slot.id, chosenOption.id, 'only the guest-selected slot enters the confirmation card');
  assert.equal(selected.actionCard.version, 2);
  assert.equal(selected.run.clarificationCount, 0);
  const replayUsage = usageFromAssistantRun(replay.run);
  const deterministicSelectionUsage = usageFromAssistantRun(selected.run);
  const deterministicSelectionAggregate = aggregateLiveUsage([replayUsage, deterministicSelectionUsage]);
  const deterministicSelectionAdmission = planConversationRunBudget(deterministicSelectionAggregate, 1_000, 1);
  assert.equal(deterministicSelectionUsage.modelCallCount, 0);
  assert.equal(deterministicSelectionUsage.toolCallCount, 0);
  assert.equal(deterministicSelectionUsage.totalTokens, 0);
  assert.equal(deterministicSelectionUsage.usageKnown, true,
    'a deterministic zero-model slot clarification contributes known zero usage');
  assert.equal(deterministicSelectionAggregate.usageKnown, true,
    'the known prior run remains known after zero-model deterministic slot clarification');
  assert.equal(deterministicSelectionAdmission.admitted, true,
    'zero-model deterministic slot clarification does not block a later bounded run');
  const deterministicSelectionBudgetEvidence = { modelCallCount: deterministicSelectionUsage.modelCallCount,
    toolCallCount: deterministicSelectionUsage.toolCallCount, totalTokens: deterministicSelectionUsage.totalTokens,
    aggregateUsageKnown: deterministicSelectionAggregate.usageKnown,
    nextRunAdmitted: deterministicSelectionAdmission.admitted };
  const selectedChain = await databaseQuery(context, `SELECT id,version,status,parent_card_id AS parentCardId
    FROM assistant_action_cards WHERE logical_action_id=(SELECT logical_action_id FROM assistant_action_cards WHERE id=?)
    ORDER BY version`, [selected.actionCard.id]);
  assert.deepEqual(selectedChain.map(item => [Number(item.version), item.status, item.parentCardId || null]),
    [[1, 'superseded', null], [2, 'pending_confirmation', replay.actionCard.id]],
    'selection creates the next card version with an explicit parent link');
  assert.equal(await allReservationCount(context, user.id), before, 'selection creates no reservation before confirmation');

  const changedCandidateCard = await assistantText(context, user, replayText);
  const changedCandidate = changedCandidateCard.actionCard.impact.availableSlots
    .find(item => item.id !== chosenOption.id) || changedCandidateCard.actionCard.impact.availableSlots[0];
  assert.ok(changedCandidate);
  const originalClosedState = await databaseQuery(context,
    'SELECT is_closed AS isClosed FROM activity_slots WHERE id=?', [changedCandidate.id], 'get');
  await databaseQuery(context, 'UPDATE activity_slots SET is_closed=1 WHERE id=?', [changedCandidate.id], 'run');
  const beforeChangedSelection = await guestBusinessCounts(context, user.id);
  const requestCountBeforeChangedSelection = await recordedModelRequestCount(context.recordedModelBaseUrl);
  let changedSelection;
  try {
    changedSelection = await assistantText(context, user,
      `我选择沙滩漫步时段编号 ${changedCandidate.id}，日期 ${slots[0].businessDate}。`, changedCandidateCard.sessionId);
  } finally {
    await databaseQuery(context, 'UPDATE activity_slots SET is_closed=? WHERE id=?',
      [originalClosedState.isClosed, changedCandidate.id], 'run');
  }
  assert.equal(changedSelection.actionCard.status, 'rejected',
    'the server revalidates a candidate that became unavailable after the needs_input card was shown');
  assert.equal(changedSelection.actionCard.errorCode, 'SLOT_NOT_AVAILABLE');
  assert.equal(changedSelection.run.modelCallCount, 0);
  assert.equal(await recordedModelRequestCount(context.recordedModelBaseUrl), requestCountBeforeChangedSelection,
    'candidate invalidation is resolved server-side without a provider request');
  assert.deepEqual(await guestBusinessCounts(context, user.id), beforeChangedSelection,
    'candidate invalidation does not write a reservation or other guest business record');

  const injectedText = `Q23_RECORDED_FAULT=first-turn-no-card ${replayText}`;
  const faultStartedAt = performance.now();
  let injectedObservation = null;
  let injectedFailureCapture = null;
  let injectedError = null;
  try {
    await assistantText(context, user, injectedText, null, {
      onRunObserved: async (_run, observation) => { injectedObservation = observation; },
      sessionStartedAt: faultStartedAt,
      failureSummary: { quest: 'Q23.2', scenario: 'offline-first-turn-no-card-failure-summary-fault-injection',
        expectedFailure: true, phase: 'first_turn_needs_input_card_assertion', pendingSteps: [
          { step: 'guest-selects-slot', reason: 'the injected response persisted no needs_input card; no slot selection was accepted' },
          { step: 'pending-confirmation-card', reason: 'blocked until the guest selects an offered slot' },
          { step: 'reservation-confirmation-and-readback', reason: 'blocked because no pending_confirmation card exists' }
        ] },
      onAssertionFailure: capture => { injectedFailureCapture = capture; }
    });
  } catch (error) { injectedError = error; }
  assert.ok(injectedError, 'the injected first-turn no-card condition reaches the original first assertion');
  assert.ok(injectedObservation, 'the completed run observation is captured before the assertion');
  assert.equal(injectedObservation.actionCardStates.length, 0);
  assert.equal(injectedObservation.runStatus, 'completed');
  assert.deepEqual(injectedObservation.toolCounts, { list_projects: 1, list_project_slots: 1 },
    'the original counterexample remains exactly two successful read-only queries');
  assert.equal(injectedObservation.clarificationCount, 0,
    'a verified missing-slot question does not increment the understanding-failure count');
  assert.equal(injectedObservation.clarificationState.status, 'awaiting_guest_slot_selection');
  assert.equal(injectedObservation.stopReason, 'APPOINTMENT_SLOT_SELECTION_REQUESTED');
  assert.ok(injectedObservation.clarificationState.offeredSlots.length > 0);
  const noCardToolRows = await databaseQuery(context, `SELECT tool_name AS toolName,status,error_code AS errorCode,
      arguments_json AS argumentsJson,result_json AS resultJson FROM tool_executions WHERE run_id=? ORDER BY started_at,id`,
  [injectedObservation.runId]);
  const noCardReadOnlyEvidence = validateReadOnlySlotQueries(noCardToolRows, {
    projectId: 'project-beach-walk', date: slots[0].businessDate, bookableSlots: slots
  });
  assert.deepEqual(injectedObservation.clarificationState.offeredSlots.map(item => item.id),
    noCardReadOnlyEvidence.offeredSlots.map(item => item.id),
    'clarification choices exactly mirror the successful read-only tool result');
  assert.ok(injectedFailureCapture, 'the original assertion path appends a failure summary automatically');
  const failureSummary = injectedFailureCapture.failureSummary;
  const failureRef = injectedFailureCapture.failureRef;
  const persistedFailure = readEvidenceAt(failureRef);
  const priorObservation = readEvidenceAt(persistedFailure.evidence.failureSummary.priorObservedEvidenceRef);
  assert.equal(priorObservation.status, 'OBSERVED');
  assert.equal(priorObservation.evidence.runId, failureSummary.runId);
  assert.ok(failureSummary.sessionId && failureSummary.runId);
  assert.ok(failureSummary.session.sessionId && failureSummary.session.runStatus === 'completed');
  assert.ok(Number.isFinite(failureSummary.elapsedMs) && failureSummary.elapsedMs >= 0);
  assert.ok(Number.isFinite(failureSummary.timing.sessionElapsedMs) && failureSummary.timing.sessionElapsedMs >= 0);
  assert.ok(failureSummary.businessRowsBeforeAfter && failureSummary.usage && failureSummary.timing);
  assert.ok(failureSummary.reachedStep && failureSummary.pendingSteps.every(item => item.reason));
  assert.equal(persistedFailure.evidence.failureSummary.status, 'FAIL', 'the injected fail summary survives a bounded readback');
  assert.equal(persistedFailure.status, 'PASS', 'expected fault injection is reported as a passing validation row');

  let startFailureCapture = null;
  let startFailureThrown = null;
  try {
    await assistantText(context, user, '', null, { failureSummary: { quest: 'Q23.2',
      scenario: 'offline-start-rejection-failure-receipt', expectedFailure: true, phase: 'assistant_start_rejected' },
      onAssertionFailure: capture => { startFailureCapture = capture; } });
  } catch (error) { startFailureThrown = error; }
  assert.ok(startFailureThrown && startFailureCapture, 'a rejected assistant start records its failure summary');
  const startFailureRecord = readEvidenceAt(startFailureCapture.failureRef);
  const startObservation = readEvidenceAt(startFailureRecord.evidence.failureSummary.priorEvidenceRef);
  assert.equal(startObservation.status, 'START_REJECTED');
  assert.equal(startObservation.evidence.runId, null);
  assert.equal(startObservation.evidence.sessionId, null);
  assert.equal(startFailureRecord.evidence.failureSummary.status, 'FAIL');
  assert.equal(startFailureRecord.evidence.failureSummary.usage.modelCallCount, null);
  assert.equal(startFailureRecord.evidence.failureSummary.timing.runDurationMs, null);
  assert.equal(startFailureRecord.evidence.failureSummary.noBusinessWrite, true);
  assert.equal(startFailureRecord.status, 'PASS', 'expected start-rejection fault injection validates the durable receipt');

  let readbackFailureCapture = null;
  let readbackFailureThrown = null;
  let runObservedCallbackCalled = false;
  try {
    await assistantText(context, user, replayText, null, { expectActionCard: false, readbackFaultOnce: true,
      onRunObserved: async () => { runObservedCallbackCalled = true; },
      failureSummary: { quest: 'Q23.2', scenario: 'offline-run-readback-error-failure-receipt',
        expectedFailure: true, phase: 'run_readback_failed', pendingSteps: [
          { step: 'read-actual-run-after-receipt', reason: 'run readback failed before a terminal observation was captured' }
        ] }, onAssertionFailure: capture => { readbackFailureCapture = capture; } });
  } catch (error) { readbackFailureThrown = error; }
  assert.ok(readbackFailureThrown && readbackFailureCapture, 'run-readback failure automatically records its failure summary');
  assert.equal(runObservedCallbackCalled, false, 'the terminal callback did not run on a readback failure');
  const readbackFailureRecord = readEvidenceAt(readbackFailureCapture.failureRef);
  const incompleteObservation = readEvidenceAt(readbackFailureRecord.evidence.failureSummary.priorEvidenceRef);
  assert.equal(incompleteObservation.status, 'INCOMPLETE');
  assert.equal(incompleteObservation.evidence.runId, readbackFailureRecord.evidence.failureSummary.runId);
  assert.ok(incompleteObservation.evidence.runId && incompleteObservation.evidence.sessionId);
  assert.equal(incompleteObservation.evidence.runStatus, null);
  assert.equal(incompleteObservation.evidence.durationMs, null);
  assert.equal(incompleteObservation.evidence.modelCallCount, null);
  assert.equal(incompleteObservation.evidence.toolCallCount, null);
  assert.equal(readbackFailureRecord.evidence.failureSummary.session.runStatus, null);
  assert.equal(readbackFailureRecord.evidence.failureSummary.timing.runDurationMs, null);
  assert.ok(Number.isFinite(readbackFailureRecord.evidence.failureSummary.elapsedMs));
  assert.equal(readbackFailureRecord.evidence.failureSummary.noBusinessWrite, true);
  assert.equal(readbackFailureRecord.status, 'PASS', 'expected readback fault validates unknown-field handling and receipt linkage');
  let readbackRun = null;
  const readbackDeadline = performance.now() + 20_000;
  while (performance.now() < readbackDeadline) {
    const response = await api(context, `/assistant/runs/${encodeURIComponent(readbackFailureRecord.evidence.failureSummary.runId)}?role=guest`,
      { token: user.token, signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 200, 'read actual run only after the INCOMPLETE failure summary was saved');
    readbackRun = response.data;
    if (!['queued', 'running'].includes(readbackRun.status)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(readbackRun?.status, 'completed', 'the actual run is polled to completion while the isolated database is still alive');
  assert.equal(readbackRun.actionCards[0].status, 'needs_input');
  assert.equal(await allReservationCount(context, user.id), before, 'readback injection did not confirm or write a reservation');

  let step = await assistantTool(context, user, 'propose_program_booking', { projectId: 'project-beach-walk' });
  assert.equal(step.actionCard.status, 'needs_input');
  assert.ok(step.actionCard.missingFields.includes('日期'));
  assert.equal(step.run.clarificationCount, 0, 'a structured legal missing field is not an understanding failure');
  step = await assistantTool(context, user, 'propose_program_booking', { date: slots[0].businessDate }, step.sessionId);
  assert.equal(step.actionCard.status, 'needs_input');
  assert.ok(step.actionCard.missingFields.includes('本人选择的时段'));
  assert.equal(step.run.clarificationCount, 0, 'the second legal field is not a failed clarification');
  step = await assistantTool(context, user, 'propose_program_booking', { slotId: slots[0].id }, step.sessionId);
  assert.equal(step.actionCard.status, 'pending_confirmation');
  assert.equal(step.run.clarificationCount, 0, 'a selected slot completes clarification without increasing a failure count');
  const chain = await databaseQuery(context, `SELECT version,status,parent_card_id FROM assistant_action_cards
    WHERE logical_action_id=(SELECT logical_action_id FROM assistant_action_cards WHERE id=?) ORDER BY version`, [step.actionCard.id]);
  assert.deepEqual(chain.map(row => [Number(row.version), row.status]), [[1, 'superseded'], [2, 'superseded'], [3, 'pending_confirmation']]);
  assert.ok(chain[1].parent_card_id && chain[2].parent_card_id);
  assert.equal(await allReservationCount(context, user.id), before);
  const misses = [];
  for (let index = 1; index <= 3; index += 1) {
    const unresolved = await assistantText(context, user,
      '我想预约沙滩漫步，但目前无法说明日期和时段，请先按我实际提供的信息理解。', step.sessionId,
      { expectActionCard: false });
    misses.push({ runId: unresolved.run.runId, count: unresolved.run.clarificationCount,
      entryPage: unresolved.run.clarificationState?.entryPage || null, stopReason: unresolved.run.stopReason });
    assert.equal(unresolved.run.stopReason, 'APPOINTMENT_UNDERSTANDING_UNRESOLVED');
    assert.equal(unresolved.run.clarificationCount, index);
    assert.equal(Boolean(unresolved.run.clarificationState?.entryPage), index === 3,
      'the booking page is offered only after the third structured-action miss');
    assert.equal(unresolved.actionCard, null);
  }
  const recovered = await assistantText(context, user,
    `我想预约沙滩漫步时段编号 ${slots[0].id}，日期 ${slots[0].businessDate}。`, step.sessionId);
  assert.equal(recovered.actionCard?.actionType, 'book_program', 'a legal answer after the third miss resumes the same booking flow');
  assert.equal(recovered.actionCard.status, 'pending_confirmation');
  assert.equal(recovered.actionCard.version, 4, 'recovery continues the pending card version chain');
  assert.equal(recovered.actionCard.impact.slot.id, slots[0].id, 'recovery uses the guest-selected slot');
  assert.equal(recovered.run.clarificationCount, 0, 'a legal recovery resets the unresolved count');
  assert.deepEqual(recovered.run.clarificationState, {}, 'a legal recovery clears the booking-page fallback state');
  const recoveredChain = await databaseQuery(context, `SELECT version,status,parent_card_id FROM assistant_action_cards
    WHERE logical_action_id=(SELECT logical_action_id FROM assistant_action_cards WHERE id=?) ORDER BY version`, [recovered.actionCard.id]);
  assert.deepEqual(recoveredChain.map(row => [Number(row.version), row.status]),
    [[1, 'superseded'], [2, 'superseded'], [3, 'superseded'], [4, 'pending_confirmation']]);
  assert.ok(recoveredChain.every((row, index) => index === 0 || row.parent_card_id), 'recovery preserves every parent link');
  assert.equal(await allReservationCount(context, user.id), before, 'neither missed understanding nor recovery writes a reservation');

  const noCardOption = injectedObservation.clarificationState.offeredSlots.find(option =>
    replay.actionCard.impact.availableSlots.some(item => item.id === option.id));
  assert.ok(noCardOption, 'the read-only option is also currently bookable under full server rules');
  const noCardSourceRun = assertStatus(await api(context,
    `/assistant/runs/${encodeURIComponent(injectedObservation.runId)}?role=guest`, { token: user.token }),
  200, 'read back the actual no-card source run before deterministic selection');
  assert.equal(noCardSourceRun.runId, injectedObservation.runId);
  const noCardSelectionBusinessBefore = await guestBusinessCounts(context, user.id);
  const selectedAfterReadOnly = await assistantText(context, user,
    `我选择沙滩漫步时段编号 ${noCardOption.id}，日期 ${slots[0].businessDate}。`, injectedObservation.sessionId);
  const noCardSelectionContract = await assertDeterministicSlotSelectionContract(context, user,
    selectedAfterReadOnly, { firstTurnKind: 'verified_read_only_queries_awaiting_guest_slot_selection',
      sourceRun: noCardSourceRun, selectedSlot: noCardOption, projectId: 'project-beach-walk',
      date: slots[0].businessDate, expectedBusinessRows: noCardSelectionBusinessBefore, bookableSlots: slots });
  const alteredNoCardSource = JSON.parse(JSON.stringify(noCardSourceRun));
  alteredNoCardSource.clarificationState.status = 'no_bookable_slots';
  await assert.rejects(() => assertDeterministicSlotSelectionContract(context, user, selectedAfterReadOnly, {
    firstTurnKind: 'verified_read_only_queries_awaiting_guest_slot_selection',
    sourceRun: alteredNoCardSource, selectedSlot: noCardOption, projectId: 'project-beach-walk',
    date: slots[0].businessDate, expectedBusinessRows: noCardSelectionBusinessBefore, bookableSlots: slots
  }), assert.AssertionError, 'the shared validator rejects a no-card source that did not offer the selected slot');
  assert.equal(selectedAfterReadOnly.actionCard.status, 'pending_confirmation');
  assert.equal(selectedAfterReadOnly.actionCard.impact.slot.id, noCardOption.id);
  assert.equal(selectedAfterReadOnly.run.clarificationCount, 0);
  assert.deepEqual(selectedAfterReadOnly.run.clarificationState, {});
  assert.equal(selectedAfterReadOnly.run.modelCallCount, 0, 'selection is server-revalidated without fabricating a model completion');
  assert.equal(selectedAfterReadOnly.run.toolCallCount, 0, 'server revalidation is not written as a model tool call');
  assert.equal(selectedAfterReadOnly.run.steps[0].diagnostic.modelToolCallRecorded, false);
  assert.equal(await allReservationCount(context, user.id), before, 'server revalidation creates no reservation before explicit confirmation');
  const noCardConfirmed = await confirmAction(context, user, selectedAfterReadOnly.sessionId, selectedAfterReadOnly.actionCard);
  assert.equal(noCardConfirmed.status, 'confirmed');
  assert.ok(noCardConfirmed.result.businessId, 'explicit confirmation returns the real reservation ID');
  const noCardReservation = await databaseQuery(context,
    'SELECT guest_id,slot_id,status FROM reservations WHERE id=?', [noCardConfirmed.result.businessId], 'get');
  assert.deepEqual([noCardReservation.guest_id, noCardReservation.slot_id, noCardReservation.status],
    [user.id, noCardOption.id, 'confirmed']);
  assert.equal(await allReservationCount(context, user.id), before + 1,
    'only the explicit confirmation writes exactly one reservation');
  return { quest: 'Q23.2', scenario: 'multi-turn-slot-clarification-and-version-chain',
    evidence: { liveAdmissionBudgetContract: { conversationModelRequestLimit: liveConversationLimits.maxProviderRequests,
      conversationTokenLimit: liveConversationLimits.maxTokens,
      perRunTokenCeiling: liveConversationLimits.maxTokensPerRun,
      standardFirstRunTokenLimit: initialBudgetAdmission.effectiveLimits.maxTokens,
      standardRolloverTokenLimitAfter3000: rolloverBudgetAdmission.effectiveLimits.maxTokens,
      explicitLegacy8192Regression: { conversationTokenLimit: legacy8192RegressionLimits.maxTokens,
        exhaustedRejected: !legacy8192ExhaustionAdmission.admitted,
        exact1717Remainder: legacy1717RemainderAdmission.remaining.tokens,
        exact1717EffectiveRunLimit: legacy1717RemainderAdmission.effectiveLimits.maxTokens,
        separatePreflightRegressionCoverage: {
          testFile: 'server/test/graph-budget.test.js',
          scenario: 'ordinary preflight rejects a 2992-token input before provider admission when only 1717 remain'
        },
        recordedLowBudgetRun: budgetRolloverEvidence?.legacy8192 || null },
      initialRunAdmission: initialBudgetAdmission.admitted,
      rolloverAfterThreeCalls: { admitted: rolloverBudgetAdmission.admitted,
        remainingModelCalls: rolloverBudgetAdmission.remaining.modelCalls,
        configuredRunLimit: rolloverBudgetAdmission.effectiveLimits.maxModelCalls,
        projectedConversationCalls: rolloverBudgetAdmission.projectedUsage.modelCalls },
      exactEightRequestBoundaryAdmitted: exactBoundaryAdmission.admitted,
      exhaustedRejected: !exhaustedBudgetAdmission.admitted,
      overEightRejected: !overLimitBudgetAdmission.admitted,
      ordinaryRequestLogMatchedRunCounter: replayProviderRequestDelta === replay.run.modelCallCount,
      ordinaryRequestLogDelta: replayProviderRequestDelta,
      rejectedDimensions: Object.entries(exhaustedBudgetAdmission.checks).filter(([, passed]) => !passed).map(([key]) => key),
      unknownUsageRejected: !unknownBudgetAdmission.admitted,
      unknownProviderUsageRetry: { firstRunStatus: failedUnknownUsage.run.status,
        firstRunModelCallCount: failedUnknownUsage.run.modelCallCount,
        retryStopReason: unknownUsageRetry.stopReason, retryModelCallCount: unknownUsageRetry.modelCallCount,
        providerRequestDelta: unknownUsageProviderAfter - unknownUsageProviderBefore },
      successfulUnknownUsage, reportedZeroUsage: reportedZeroUsageEvidence,
      deterministicSelectionBudgetAdmission: deterministicSelectionBudgetEvidence,
      deterministicSelectionContract: { needsInputCard: needsInputSelectionContract,
        noCardReadOnlyClarification: noCardSelectionContract,
        rejectedFaults: deterministicSelectionRejectedFaults,
        rejectedAlteredNoCardSource: true },
      toolLimitRejected: !toolExhaustionAdmission.admitted,
      tokenLimitRejected: !tokenExhaustionAdmission.admitted,
      estimatedCostLimitRejected: !costExhaustionAdmission.admitted,
      runtimeLimitRejected: !runtimeExhaustionAdmission.admitted,
      zeroRunLimitRejected: true, recordedRollover: budgetRolloverEvidence },
      finalCardId: step.actionCard.id, versions: chain.length, missingSlotResolved: true,
      structuredCardSelectionAtLowTokenLimit: lowBudgetSelection,
      candidateChangeSelection: { selectedSlotId: changedCandidate.id, cardStatus: changedSelection.actionCard.status,
        errorCode: changedSelection.actionCard.errorCode, modelCallCount: changedSelection.run.modelCallCount,
        providerRequestDelta: 0 },
      readOnlyReplay: { firstRunId: replay.run.runId, sessionId: replay.sessionId,
        toolCounts: replay.run.toolCounts, firstCardStatus: replay.actionCard.status,
        missingFields: replay.actionCard.missingFields, offeredSlotCount: replay.actionCard.impact.availableSlots.length,
        selectedCardStatus: selected.actionCard.status, selectedSlotId: selected.actionCard.impact.slot.id },
      firstAssertionFaultInjection: { failureRecord: failureRef, priorObservedEvidenceRef: failureSummary.priorObservedEvidenceRef,
        durableFailureSummary: true, noBusinessWrite: failureSummary.noBusinessWrite,
        clarificationCount: injectedObservation?.clarificationCount ?? null,
        noCardReadOnlyToolCounts: injectedObservation?.toolCounts || null,
        validMissingSlotState: injectedObservation?.clarificationState?.status || null },
      readOnlyClarificationSelectionConfirm: { firstRunId: injectedObservation.runId,
        sessionId: injectedObservation.sessionId, offeredSlotId: noCardOption.id,
        clarificationCount: injectedObservation.clarificationCount,
        selectedContractRunId: noCardSelectionContract.selectedRunId,
        selectedCardStatus: selectedAfterReadOnly.actionCard.status,
        selectionToolCalls: selectedAfterReadOnly.run.toolCallCount, confirmedReservationId: noCardConfirmed.result.businessId,
        reservationCountBefore: before, reservationCountAfter: before + 1 },
      failureReceiptBranches: { startRejected: startFailureCapture.failureSummary.priorEvidenceRef,
        runReadbackIncomplete: readbackFailureRecord.evidence.failureSummary.priorEvidenceRef,
        actualReadbackRunCompletedAfterSave: readbackRun.status },
      legalFieldClarificationCounts: [0, 0, 0], thirdMissBookingEntry: misses[2]?.entryPage,
      unresolvedRunIds: misses.map(item => item.runId), unresolvedCounts: misses.map(item => item.count),
      recoveryRunId: recovered.run.runId, recoveredCardId: recovered.actionCard.id,
      recoveredVersion: recovered.actionCard.version, recoveredClarificationCount: recovered.run.clarificationCount,
      recoveredFallbackState: recovered.run.clarificationState, recoveryVersionStatuses: recoveredChain.map(row => row.status),
      noBusinessWriteBeforeExplicitConfirmation: true, explicitConfirmationCreatedOneReservation: true,
      reservations: await allReservationCount(context, user.id) } };
}

async function q233(context) {
  const user = await guestUser(context);
  const slots = await bookableSlots(context, user);
  const before = await allReservationCount(context, user.id);
  const positive = await assistantTool(context, user, 'propose_program_booking', {
    projectId: 'project-beach-walk', date: slots[0].businessDate, slotId: slots[0].id
  });
  const confirmed = await confirmAction(context, user, positive.sessionId, positive.actionCard);
  assert.equal(confirmed.status, 'confirmed');
  assert.ok(confirmed.result.businessId);
  const replay = await confirmAction(context, user, positive.sessionId, positive.actionCard);
  assert.equal(replay.result.businessId, confirmed.result.businessId, 'idempotent confirm returns same reservation');

  const capacityCard = await assistantTool(context, user, 'propose_program_booking', {
    projectId: 'project-beach-walk', date: slots[1].businessDate, slotId: slots[1].id
  }, positive.sessionId);
  await databaseQuery(context, 'UPDATE activity_slots SET capacity=1 WHERE id=?', [slots[1].id], 'run');
  const competitor = assertStatus(await api(context, '/reservations', { method: 'POST', token: user.token,
    headers: { 'Idempotency-Key': `q23-fill:${slots[1].id}` }, body: { slotId: slots[1].id } }), 201, 'fill capacity after proposal');
  const fullStale = await confirmAction(context, user, capacityCard.sessionId, capacityCard.actionCard);
  assert.equal(fullStale.status, 'stale');
  assert.equal(fullStale.result, null);

  const expiredProposal = await assistantTool(context, user, 'propose_program_booking', {
    projectId: 'project-beach-walk', date: slots[2].businessDate, slotId: slots[2].id
  }, positive.sessionId);
  await databaseQuery(context, "UPDATE assistant_action_cards SET expires_at=? WHERE id=?",
    [sqlTime(context, '2026-10-04T00:00:00.000Z'), expiredProposal.actionCard.id], 'run');
  const expired = await confirmAction(context, user, expiredProposal.sessionId, expiredProposal.actionCard);
  assert.equal(expired.status, 'expired');

  const profileCard = await assistantTool(context, user, 'propose_program_booking', {
    projectId: 'project-beach-walk', date: slots[3].businessDate, slotId: slots[3].id
  }, positive.sessionId);
  await databaseQuery(context, 'UPDATE guest_profiles SET health_profile_version=health_profile_version+1 WHERE user_id=?', [user.id], 'run');
  const healthStale = await confirmAction(context, user, profileCard.sessionId, profileCard.actionCard);
  assert.equal(healthStale.status, 'stale', 'health profile version change invalidates old basis');

  const total = await allReservationCount(context, user.id);
  assert.equal(total, before + 2, 'only confirmed reservation and explicit competing reservation exist');
  assert.ok(competitor.reservation?.id);
  return { quest: 'Q23.3', scenario: 'revalidate-confirmation-expiry-capacity-health-and-replay',
    evidence: { reservationId: confirmed.result.businessId, duplicateId: replay.result.businessId,
      capacityCard: fullStale.id, competitorReservationId: competitor.reservation.id,
      expiredCard: expired.id, healthStaleCard: healthStale.id, reservations: total } };
}

async function q234(context) {
  const user = await guestUser(context);
  const slots = await bookableSlots(context, user);
  const created = assertStatus(await api(context, '/reservations', { method: 'POST', token: user.token,
    headers: { 'Idempotency-Key': `q23-cancel-setup:${crypto.randomUUID()}` }, body: { slotId: slots[0].id } }), 201, 'create cancellation fixture reservation');
  const reservationId = created.reservation.id;
  let proposal = await assistantTool(context, user, 'propose_booking_cancellation', {});
  assert.equal(proposal.actionCard.status, 'needs_input');
  assert.ok(proposal.actionCard.impact.reservations.some(item => item.reservationId === reservationId));
  proposal = await assistantTool(context, user, 'propose_booking_cancellation', { reservationId }, proposal.sessionId);
  assert.equal(proposal.actionCard.status, 'pending_confirmation');
  assert.equal(proposal.actionCard.impact.reservation.reservationId, reservationId);
  const countBefore = await allReservationCount(context, user.id);
  const cancelled = await confirmAction(context, user, proposal.sessionId, proposal.actionCard);
  assert.equal(cancelled.result.businessId, reservationId);
  assert.equal(cancelled.result.actualState, 'cancelled');
  const replay = await confirmAction(context, user, proposal.sessionId, proposal.actionCard);
  assert.equal(replay.result.businessId, reservationId);
  const row = await databaseQuery(context, 'SELECT status FROM reservations WHERE id=? AND guest_id=?', [reservationId, user.id], 'get');
  assert.equal(row.status, 'cancelled');
  assert.equal(await allReservationCount(context, user.id), countBefore, 'repeat confirm does not duplicate or compensate');
  const reservations = assertStatus(await api(context, '/reservations', { token: user.token }), 200, 'read cancelled reservation history');
  assert.ok(reservations.items.some(item => item.id === reservationId && item.status === 'cancelled'));
  return { quest: 'Q23.4', scenario: 'explicit-cancel-release-and-idempotent-replay',
    evidence: { reservationId, finalState: row.status, actionCardId: cancelled.id, scheduleShowsCancelled: true } };
}

async function q235(context) {
  const user = await guestUser(context);
  const date = dateOffset(today, 1);
  const menu = await prepareGuestMenu(context, user, date);
  const before = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM meal_orders WHERE guest_id=?', [user.id], 'get')).count);
  let proposal = await assistantTool(context, user, 'propose_meal_order', {});
  assert.equal(proposal.actionCard.status, 'needs_input');
  assert.ok(proposal.actionCard.missingFields.length >= 2);
  proposal = await assistantTool(context, user, 'propose_meal_order', { businessDate: date, mealType: 'breakfast' }, proposal.sessionId);
  assert.equal(proposal.actionCard.status, 'pending_confirmation');
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM meal_orders WHERE guest_id=?', [user.id], 'get')).count), before);
  const orderCard = await confirmAction(context, user, proposal.sessionId, proposal.actionCard);
  assert.equal(orderCard.status, 'confirmed');
  assert.ok(orderCard.result.businessId);
  assert.equal(orderCard.result.actualState, 'reserved');
  const order = await databaseQuery(context, 'SELECT id,status,menu_id,menu_version FROM meal_orders WHERE id=? AND guest_id=?',
    [orderCard.result.businessId, user.id], 'get');
  assert.ok(order && order.menu_id === menu.menu.id);
  assert.equal(order.status, 'reserved');
  return { quest: 'Q23.5', scenario: 'complete-and-confirm-menu-order-with-actual-id',
    evidence: { menuId: menu.menu.id, orderId: order.id, status: order.status, expectedDeliveryAt: orderCard.result.order.expectedDeliveryAt } };
}

async function q236(context) {
  const user = await guestUser(context);
  const date = dateOffset(today, 1);
  let menu = await prepareGuestMenu(context, user, date);
  const item = menu.items.find(row => row.mealType === 'breakfast' && row.slot === 'main');
  assert.ok(item?.id && item.dish?.id, 'breakfast main dish exists');
  const dishesResult = assertStatus(await api(context, '/meals/dishes', { token: user.token }), 200, 'read dish catalog');
  const dishes = dishesResult.items || [];
  const validDish = dishes.find(dish => dish.id !== item.dish.id && dish.slot === item.slot
    && dish.mealTypes?.includes(item.mealType) && dish.supplyStatus === 'demo_available'
    && !(dish.allergens || []).some(value => /虾|shrimp/i.test(value)));
  const shrimpDish = dishes.find(dish => dish.id !== item.dish.id && dish.slot === item.slot
    && dish.mealTypes?.includes(item.mealType) && (dish.allergens || []).some(value => /虾|shrimp/i.test(value)));
  assert.ok(validDish?.id && shrimpDish?.id, 'both eligible and shrimp-containing main dish fixtures exist');
  const orderResult = await api(context, '/meals/orders', { method: 'POST', token: user.token,
    headers: { 'Idempotency-Key': `q23-swap-order:${crypto.randomUUID()}` },
    body: { menuId: menu.menu.id, businessDate: date, mealType: 'breakfast', version: menu.menu.version } });
  assert.ok([200, 201].includes(orderResult.status), `create reserved order fixture: ${JSON.stringify(orderResult.data)}`);

  const beforeItem = item.dish.id;
  const rejected = await assistantTool(context, user, 'propose_dish_swap', {
    businessDate: date, itemId: item.id, dishId: shrimpDish.id, reason: '虾过敏，不要虾类菜品'
  });
  assert.equal(rejected.actionCard.status, 'rejected');
  assert.match(rejected.actionCard.impact.summary, /过敏|限制|虾/);
  menu = assertStatus(await api(context, `/meals/menu?date=${date}`, { token: user.token }), 200, 'verify allergy rejection leaves menu');
  assert.equal(menu.items.find(row => row.id === item.id).dish.id, beforeItem);

  const valid = await assistantTool(context, user, 'propose_dish_swap', {
    businessDate: date, itemId: item.id, dishId: validDish.id, reason: '按本人饮食偏好替换为鸡肉菜品'
  });
  assert.equal(valid.actionCard.status, 'pending_confirmation');
  const updated = await confirmAction(context, user, valid.sessionId, valid.actionCard);
  assert.equal(updated.status, 'confirmed');
  menu = assertStatus(await api(context, `/meals/menu?date=${date}`, { token: user.token }), 200, 'read replaced menu');
  assert.equal(menu.items.find(row => row.id === item.id).dish.id, validDish.id);
  const orderAfter = await databaseQuery(context, 'SELECT id,status,dishes_snapshot_json AS snapshot FROM meal_orders WHERE guest_id=? AND business_date=? AND meal_type=?',
    [user.id, date, 'breakfast'], 'get');
  assert.equal(orderAfter.status, 'reserved');
  assert.ok(JSON.stringify(orderAfter.snapshot).includes(validDish.name));

  await databaseQuery(context, "UPDATE meal_orders SET status='preparing' WHERE id=?", [orderAfter.id], 'run');
  const anotherDish = dishes.find(dish => dish.id !== validDish.id && dish.id !== beforeItem && dish.slot === item.slot
    && dish.mealTypes?.includes(item.mealType) && dish.supplyStatus === 'demo_available'
    && !(dish.allergens || []).some(value => /虾|shrimp/i.test(value)));
  assert.ok(anotherDish?.id, 'preparing negative fixture has another safe candidate');
  const preparing = await assistantTool(context, user, 'propose_dish_swap', {
    businessDate: date, itemId: item.id, dishId: anotherDish.id, reason: '再替换一次'
  }, valid.sessionId);
  assert.equal(preparing.actionCard.status, 'rejected');
  assert.match(preparing.actionCard.impact.summary, /备餐|不能/);
  const finalMenu = assertStatus(await api(context, `/meals/menu?date=${date}`, { token: user.token }), 200, 'preparing order preserves menu');
  assert.equal(finalMenu.items.find(row => row.id === item.id).dish.id, validDish.id);
  return { quest: 'Q23.6', scenario: 'safe-swap-allergy-rejection-and-preparing-lock',
    evidence: { itemId: item.id, beforeDishId: beforeItem, validDishId: validDish.id,
      allergyRejectedCardId: rejected.actionCard.id, preparingRejectedCardId: preparing.actionCard.id, orderId: orderAfter.id } };
}

async function q237(context) {
  const user = await guestUser(context);
  const before = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM health_records WHERE guest_id=?', [user.id], 'get')).count);
  let proposal = await assistantTool(context, user, 'propose_health_metric', { metric: 'blood_pressure', systolic: 130 });
  assert.equal(proposal.actionCard.status, 'needs_input');
  assert.ok(proposal.actionCard.missingFields.some(value => /舒张压/.test(value)));
  proposal = await assistantTool(context, user, 'propose_health_metric', { diastolic: 80 }, proposal.sessionId);
  assert.equal(proposal.actionCard.status, 'pending_confirmation');
  assert.equal(await databaseQuery(context, 'SELECT COUNT(*) AS count FROM health_records WHERE guest_id=?', [user.id], 'get').then(row => Number(row.count)), before);
  const saved = await confirmAction(context, user, proposal.sessionId, proposal.actionCard);
  assert.equal(saved.status, 'confirmed');
  const row = await databaseQuery(context, `SELECT id,record_type,unit,source,source_session_id,structured_value_json AS value
    FROM health_records WHERE id=? AND guest_id=?`, [Number(saved.result.businessId), user.id], 'get');
  assert.ok(row);
  assert.equal(row.unit, 'mmHg');
  assert.equal(row.source, 'guest');
  assert.equal(row.source_session_id, proposal.sessionId);
  const values = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  assert.equal(values.values.systolic, 130);
  assert.equal(values.values.diastolic, 80);
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM health_records WHERE guest_id=?', [user.id], 'get')).count), before + 1);
  const refreshed = assertStatus(await api(context, `/assistant/runs/${proposal.run.runId}?role=guest`, { token: user.token }), 200, 'refresh recorded metric card');
  assert.equal(refreshed.actionCards[0].result.businessId, String(row.id));
  return { quest: 'Q23.7', scenario: 'complete-confirm-and-source-structured-health-record',
    evidence: { actionCardId: saved.id, recordId: String(row.id), unit: row.unit, sourceSessionId: row.source_session_id, count: before + 1 } };
}

async function q238(context) {
  const user = await guestUser(context);
  const slots = await bookableSlots(context, user);
  const booking = await assistantTool(context, user, 'propose_program_booking', {
    projectId: 'project-beach-walk', date: slots[0].businessDate, slotId: slots[0].id
  });
  const booked = await confirmAction(context, user, booking.sessionId, booking.actionCard);
  const reservationId = booked.result.businessId;
  const cancellation = await assistantTool(context, user, 'propose_booking_cancellation', { reservationId }, booking.sessionId);
  const cancelled = await confirmAction(context, user, cancellation.sessionId, cancellation.actionCard);
  assert.equal(cancelled.result.actualState, 'cancelled');
  const oldRun = assertStatus(await api(context, `/assistant/runs/${booking.run.runId}?role=guest`, { token: user.token }), 200, 'refresh original booking card after cancellation');
  const oldCard = oldRun.actionCards.find(card => card.id === booking.actionCard.id);
  assert.equal(oldCard.status, 'confirmed');
  assert.equal(oldCard.result.businessId, reservationId);
  assert.equal(oldCard.result.actualState, 'cancelled');
  assert.ok(oldCard.result.reservation);
  const history = assertStatus(await api(context, `/assistant/history?sessionId=${encodeURIComponent(booking.sessionId)}&role=guest`, { token: user.token }), 200, 'refresh assistant history');
  const persisted = history.messages.flatMap(message => message.actionCards || []).find(card => card.id === booking.actionCard.id);
  assert.equal(persisted.result.actualState, 'cancelled');
  return { quest: 'Q23.8', scenario: 'refresh-result-card-with-current-cancelled-business-state',
    evidence: { originalCardId: booking.actionCard.id, cancellationCardId: cancelled.id, reservationId, actualStateAfterRefresh: oldCard.result.actualState } };
}

async function q239(context) {
  const user = await guestUser(context);
  const stayStart = dateOffset(today, 1);
  const stayEnd = dateOffset(today, 8);
  const checkInColumn = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const checkOutColumn = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  await databaseQuery(context, `UPDATE guest_profiles SET ${checkInColumn}=?,${checkOutColumn}=? WHERE user_id=?`,
    [stayStart, stayEnd, user.id], 'run');
  const firstDaySlots = await bookableSlots(context, user, stayStart);
  const remainingDay = dateOffset(stayStart, 2);
  const remainingDaySlots = await bookableSlots(context, user, remainingDay);
  const sourcePlanId = `wellness_draft_q23_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const reviewThreadId = `q23_thread_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const stamp = sqlTime(context, fixedInstant);
  const sourceEvidence = JSON.stringify({ parentRunId: null, traceStatus: 'Stage23 active-plan approval fixture',
    source: 'approved-plan-linked-reservation regression' });
  await databaseQuery(context, `INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
     evidence_json,created_at,review_status,review_thread_id)
    VALUES(?,?,1,?,NULL,?,?,'pending_review','sampled_review',100,?,?,'pending_review',?)`,
  [sourcePlanId, user.id, `q23:active-plan:${sourcePlanId}`, stayStart, stayEnd, sourceEvidence, stamp, reviewThreadId], 'run');
  const sourcePlanSlots = [firstDaySlots[0], remainingDaySlots[0]];
  const sourceItemIds = [];
  for (const [index, slot] of sourcePlanSlots.entries()) {
    const itemId = `wellness_item_q23_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
    sourceItemIds.push(itemId);
    const date = String(slot.businessDate).slice(0, 10);
    await databaseQuery(context, `INSERT INTO wellness_draft_items
      (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
       rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
      VALUES(?,?,?,?, 'activity',?,?,?,?, 'pending_review',?,'海屿服务区（演示地点）','[]',?,NULL,?)`,
    [itemId, sourcePlanId, date, index === 0 ? 'morning' : 'afternoon', 'project-beach-walk', '沙滩漫步',
      slot.localStart, slot.localEnd, 'Stage23验证既有激活计划在客人调整后保留原版本。',
      JSON.stringify([{ type: 'project_slot', id: slot.id, label: `${date} 沙滩漫步 ${slot.localStart}` }]),
      JSON.stringify({ source: 'Stage23 isolated approval fixture', slotId: slot.id })], 'run');
  }
  const clinicianLogin = assertStatus(await login(context.baseUrl, 'staff'), 200, `${context.driver} clinician login`);
  const activated = assertStatus(await api(context, `/staff/therapy-drafts/${sourcePlanId}/approve`, { method: 'POST',
    token: clinicianLogin.token, headers: { 'Idempotency-Key': `q23:activate:${sourcePlanId}` },
    body: { version: 1 } }), 200, 'approve and activate the existing plan');
  assert.equal(activated.reviewStatus, 'active');
  const sourcePlanReservations = await databaseQuery(context, `SELECT id,slot_id AS slotId,wellness_draft_item_id AS itemId,status
    FROM reservations WHERE guest_id=? AND wellness_draft_id=? ORDER BY id`, [user.id, sourcePlanId]);
  assert.equal(sourcePlanReservations.length, 2, 'approved plan creates two actual linked reservations');
  assert.ok(sourcePlanReservations.every(row => row.status === 'confirmed' && sourceItemIds.includes(row.itemId)));
  const targetReservation = sourcePlanReservations.find(row => row.slotId === sourcePlanSlots[0].id);
  const remainingReservation = sourcePlanReservations.find(row => row.slotId === sourcePlanSlots[1].id);
  assert.ok(targetReservation?.id && remainingReservation?.id);
  const sourceItemsBeforeChange = await databaseQuery(context, `SELECT id,business_date AS businessDate,slot_key AS slotKey,
    item_type AS itemType,candidate_id AS candidateId,title,local_start AS localStart,local_end AS localEnd,status,
    source_ids_json AS sourceIds,evidence_json AS evidence FROM wellness_draft_items WHERE draft_id=? ORDER BY id`, [sourcePlanId]);
  assert.equal(sourceItemsBeforeChange.length, 2);
  assert.ok(sourceItemsBeforeChange.every(row => row.status === 'pending_review'),
    'activation changes the draft review state while retaining its original item review states');
  const reservationId = targetReservation.id;
  const before = await allReservationCount(context, user.id);
  const proposal = await assistantTool(context, user, 'propose_rest_change', {
    reservationId, reason: '近期需要休息，希望医护重新评估当日安排。'
  });
  assert.equal(proposal.actionCard.status, 'pending_confirmation');
  assert.equal(proposal.actionCard.impact.reservation.reservationId, reservationId);
  assert.match(proposal.actionCard.impact.replacement, /待审核/);
  const result = await confirmAction(context, user, proposal.sessionId, proposal.actionCard);
  assert.equal(result.status, 'confirmed', `rest-change confirmation must persist: ${JSON.stringify(result)}`);
  assert.ok(result.result, `rest-change confirmation must include its outcome: ${JSON.stringify(result)}`);
  assert.equal(result.result.businessType, 'wellness_draft');
  assert.equal(result.result.actualState, 'pending_review');
  const reservation = await databaseQuery(context, 'SELECT status,wellness_draft_id AS draftId FROM reservations WHERE id=?', [reservationId], 'get');
  assert.equal(reservation.status, 'cancelled');
  const draft = await databaseQuery(context, `SELECT id,review_status AS status,version,evidence_json AS evidence,
    review_thread_id AS threadId,supersedes_draft_id AS supersedesId FROM wellness_drafts WHERE id=? AND guest_id=?`,
    [result.result.businessId, user.id], 'get');
  assert.ok(draft);
  assert.equal(draft.status, 'pending_review');
  assert.equal(Number(draft.version), 2, 'a rest request advances the existing plan version');
  assert.equal(draft.supersedesId, sourcePlanId);
  assert.equal(draft.threadId, reviewThreadId);
  assert.equal(reservation.draftId, sourcePlanId, 'cancellation leaves original plan provenance intact');
  const evidence = typeof draft.evidence === 'string' ? JSON.parse(draft.evidence) : draft.evidence;
  assert.equal(evidence.sourceAssistantSessionId, proposal.sessionId);
  assert.equal(evidence.sourceActionCardId, result.id);
  const item = await databaseQuery(context, "SELECT item_type,status FROM wellness_draft_items WHERE draft_id=?", [draft.id], 'get');
  assert.deepEqual([item.item_type, item.status], ['rest', 'pending_review']);
  const originalPlan = await databaseQuery(context, `SELECT status,review_status AS reviewStatus,version,
    review_thread_id AS threadId,supersedes_draft_id AS supersedesId FROM wellness_drafts WHERE id=?`, [sourcePlanId], 'get');
  assert.deepEqual([originalPlan.status, originalPlan.reviewStatus, Number(originalPlan.version), originalPlan.threadId,
    originalPlan.supersedesId], ['active', 'active', 1, reviewThreadId, null]);
  const originalItems = await databaseQuery(context, `SELECT id,business_date AS businessDate,slot_key AS slotKey,
    item_type AS itemType,candidate_id AS candidateId,title,local_start AS localStart,local_end AS localEnd,status,
    source_ids_json AS sourceIds,evidence_json AS evidence FROM wellness_draft_items WHERE draft_id=? ORDER BY id`, [sourcePlanId]);
  assert.equal(originalItems.length, 2, 'original plan keeps every scheduled activity item');
  assert.deepEqual(originalItems, sourceItemsBeforeChange, 'the original activated plan keeps its exact scheduled items');
  const remaining = await databaseQuery(context, `SELECT status,wellness_draft_id AS draftId FROM reservations WHERE id=?`,
    [remainingReservation.id], 'get');
  assert.deepEqual([remaining.status, remaining.draftId], ['confirmed', sourcePlanId]);
  const approvedEvent = await databaseQuery(context, `SELECT actor_role AS actorRole,action,from_version AS fromVersion,to_version AS toVersion
    FROM wellness_review_events WHERE draft_id=? AND action='approved'`, [sourcePlanId], 'get');
  assert.ok(approvedEvent && approvedEvent.actorRole === 'clinician' && Number(approvedEvent.toVersion) === 1,
    'the source plan retains its original clinician approval evidence');
  const revisionEvents = await databaseQuery(context, `SELECT actor_role AS actorRole,action,from_version AS fromVersion,to_version AS toVersion
    FROM wellness_review_events WHERE draft_id=? AND review_thread_id=? AND action='revision'`, [draft.id, reviewThreadId]);
  assert.deepEqual(revisionEvents.map(event => [event.actorRole, event.action, Number(event.fromVersion), Number(event.toVersion)]),
    [['guest', 'revision', 1, 2]]);
  assert.equal(await allReservationCount(context, user.id), before, 'rest change does not create a replacement reservation');
  const replay = await confirmAction(context, user, proposal.sessionId, proposal.actionCard);
  assert.equal(replay.result.businessId, draft.id, 'confirmation replay returns the same rest plan version');
  assert.equal(await databaseQuery(context, "SELECT COUNT(*) AS count FROM wellness_drafts WHERE guest_id=? AND review_thread_id=?",
    [user.id, reviewThreadId], 'get').then(row => Number(row.count)), 2, 'replay does not create a third plan version');
  assert.equal(await databaseQuery(context, "SELECT COUNT(*) AS count FROM wellness_review_events WHERE draft_id=? AND action='revision'",
    [draft.id], 'get').then(row => Number(row.count)), 1, 'replay does not duplicate the guest revision event');
  const timeline = assertStatus(await api(context, '/me/timeline', { token: user.token }), 200, 'read guest timeline after rest change');
  assert.ok(timeline.cancelledHistory.some(row => row.id === reservationId && row.status === 'cancelled'));
  assert.ok(timeline.upcomingBookings.some(row => row.id === remainingReservation.id && row.status === 'confirmed'));
  assert.ok(timeline.proposedDrafts.some(row => row.draftId === draft.id && row.version === 2
    && row.status === 'pending_review' && row.active === false));
  const domainRoutes = await readOnlyDomainProductRoutes(context, user);
  return { quest: 'Q23.9', scenario: 'confirmed-cancel-with-separate-pending-review-rest-version',
    evidence: { actionCardId: result.id, reservationId, draftId: draft.id, draftStatus: draft.status,
      sourcePlanId, sourcePlanStatus: originalPlan.reviewStatus, sourcePlanApproval: approvedEvent,
      sourceItemCount: originalItems.length, remainingReservationId: remainingReservation.id,
      version: Number(draft.version), supersedesId: draft.supersedesId, reviewThreadId: draft.threadId,
      itemType: item.item_type, reservationRows: before, replayActionCardId: replay.id,
      domainProductRoutes: domainRoutes } };
}

const runners = { 'Q23.1': q231, 'Q23.2': q232, 'Q23.3': q233, 'Q23.4': q234, 'Q23.5': q235,
  'Q23.6': q236, 'Q23.7': q237, 'Q23.8': q238, 'Q23.9': q239 };

function selectionReceiptRun(run) {
  if (!run || typeof run !== 'object') return null;
  return { runId: run.runId || null, sessionId: run.sessionId || null, actorId: run.actorId || null,
    assistantRole: run.assistantRole || null, status: run.status || null, inputText: run.inputText || null,
    reply: run.reply || null, executionMode: run.executionMode || null, live: run.live ?? null,
    provider: run.provider || null, model: run.model || null, stopReason: run.stopReason || null,
    errorCode: run.errorCode || null, intentCategory: run.intentCategory || null,
    clarificationCount: run.clarificationCount ?? null, clarificationState: run.clarificationState || {},
    modelCallCount: run.modelCallCount ?? null, toolCallCount: run.toolCallCount ?? null,
    toolCounts: run.toolCounts || {}, inputTokens: run.inputTokens ?? null,
    outputTokens: run.outputTokens ?? null, estimatedCostUsd: run.estimatedCostUsd ?? null,
    traceUsage: run.traceUsage || null, usageReported: run.usageReported ?? null,
    modelUsage: Array.isArray(run.modelUsage) ? run.modelUsage : [],
    steps: Array.isArray(run.steps) ? run.steps.map(step => ({ stepIndex: step.stepIndex ?? null,
      type: step.type || null, status: step.status || null, summary: step.summary || null,
      errorCode: step.errorCode || null, inputTokens: step.inputTokens ?? null,
      outputTokens: step.outputTokens ?? null, estimatedCostUsd: step.estimatedCostUsd ?? null,
      diagnostic: step.diagnostic || null })) : [],
    actionCards: Array.isArray(run.actionCards) ? run.actionCards : [] };
}

async function selectionReceiptQuery(run, context, label, query) {
  try { return { status: 'read', label, rows: await query() }; }
  catch (error) { return { status: 'read-error', label, error: String(error?.message || error).slice(0, 300) }; }
}

async function persistQ232SelectionReceipt(context, user, firstState, run, observation, selectionText,
  { modelSource, providerRequestCountBeforeSelection, providerRequestCountAfterSelection } = {}) {
  const card = run?.actionCards?.at(-1) || null;
  const sourceCard = firstState.firstActionCard || null;
  const receipt = {
    evidenceKind: 'q232-deterministic-slot-selection-before-assertions',
    modelSource, guestId: user.id, sessionId: run?.sessionId || null,
    selectionInputText: selectionText,
    dateProvenance: { effectiveDate: firstState.date, sourceRunId: firstState.firstRun?.runId || null,
      sourceCardId: sourceCard?.id || null, sourceKind: firstState.firstTurnKind },
    expected: { projectId: 'project-beach-walk', selectedSlot: firstState.chosenSlot,
      bookableSlots: (firstState.bookableSlots || []).map(slot => ({ id: slot.id,
        businessDate: slot.businessDate, localStart: slot.localStart, localEnd: slot.localEnd,
        bookable: slot.bookable, availableCount: slot.availableCount ?? null })) },
    source: { run: selectionReceiptRun(firstState.firstRun), actionCard: sourceCard },
    selectionResponse: { run: selectionReceiptRun(run), currentActionCard: card,
      publicObservation: observation || null },
    providerRequestCounts: { beforeSelection: providerRequestCountBeforeSelection ?? null,
      afterSelection: providerRequestCountAfterSelection ?? null,
      delta: Number.isSafeInteger(providerRequestCountBeforeSelection)
        && Number.isSafeInteger(providerRequestCountAfterSelection)
        ? providerRequestCountAfterSelection - providerRequestCountBeforeSelection : null },
    databaseReadback: {
      sourceRun: await selectionReceiptQuery(firstState.firstRun, context, 'source-agent-run', () => databaseQuery(context,
        `SELECT id,session_id AS sessionId,actor_id AS actorId,assistant_role AS assistantRole,status,input_text AS inputText,
          execution_mode AS executionMode,is_live AS isLive,model_name AS model,provider,clarification_state_json AS clarificationStateJson,
          stop_reason AS stopReason FROM agent_runs WHERE id=?`, [firstState.firstRun.runId], 'get')),
      selectionRun: await selectionReceiptQuery(run, context, 'selection-agent-run', () => databaseQuery(context,
        `SELECT id,session_id AS sessionId,actor_id AS actorId,assistant_role AS assistantRole,status,input_text AS inputText,
          execution_mode AS executionMode,is_live AS isLive,model_name AS model,provider,input_tokens AS inputTokens,
          output_tokens AS outputTokens,estimated_cost_usd AS estimatedCostUsd,stop_reason AS stopReason
          FROM agent_runs WHERE id=?`, [run?.runId], 'get')),
      sourceCard: sourceCard ? await selectionReceiptQuery(sourceCard, context, 'source-action-card', async () => {
        const row = await databaseQuery(context, `SELECT id,logical_action_id AS logicalActionId,parent_card_id AS parentCardId,
          guest_id AS guestId,session_id AS sessionId,source_run_id AS sourceRunId,action_type AS actionType,version,status,
          parameters_json AS parametersJson,impact_json AS impactJson FROM assistant_action_cards WHERE id=?`, [sourceCard.id], 'get');
        return row ? { ...row, parameters: parseAcceptanceJson(row.parametersJson), impact: parseAcceptanceJson(row.impactJson) } : null;
      }) : { status: 'not-applicable', label: 'source-action-card' },
      selectionCard: card ? await selectionReceiptQuery(card, context, 'current-action-card', async () => {
        const row = await databaseQuery(context, `SELECT id,logical_action_id AS logicalActionId,parent_card_id AS parentCardId,
          guest_id AS guestId,session_id AS sessionId,source_run_id AS sourceRunId,action_type AS actionType,version,status,
          parameters_json AS parametersJson,impact_json AS impactJson FROM assistant_action_cards WHERE id=?`, [card.id], 'get');
        return row ? { ...row, parameters: parseAcceptanceJson(row.parametersJson), impact: parseAcceptanceJson(row.impactJson) } : null;
      }) : { status: 'missing', label: 'current-action-card' },
      selectionSteps: await selectionReceiptQuery(run, context, 'selection-agent-steps', async () => {
        const rows = await databaseQuery(context, `SELECT step_index AS stepIndex,step_type AS type,status,
          diagnostic_json AS diagnosticJson,input_tokens AS inputTokens,output_tokens AS outputTokens,
          estimated_cost_usd AS estimatedCostUsd FROM agent_steps WHERE run_id=? ORDER BY step_index`, [run?.runId]);
        return rows.map(row => ({ ...row, diagnostic: parseAcceptanceJson(row.diagnosticJson, null) }));
      }),
      sourceTools: await selectionReceiptQuery(firstState.firstRun, context, 'source-tool-executions', async () => {
        const rows = await databaseQuery(context, `SELECT tool_name AS toolName,status,error_code AS errorCode,
          arguments_json AS argumentsJson,result_json AS resultJson FROM tool_executions WHERE run_id=? ORDER BY started_at,id`,
        [firstState.firstRun.runId]);
        return rows.map(row => ({ ...row, arguments: parseAcceptanceJson(row.argumentsJson, null),
          result: parseAcceptanceJson(row.resultJson, null) }));
      }),
      selectionTools: await selectionReceiptQuery(run, context, 'selection-tool-executions', async () =>
        databaseQuery(context, `SELECT tool_name AS toolName,status,error_code AS errorCode FROM tool_executions WHERE run_id=?`,
          [run?.runId])),
      sixGuestBusinessCounts: await selectionReceiptQuery(run, context, 'guest-business-counts-at-receipt',
        () => guestBusinessCounts(context, user.id)),
      observationBeforeAfter: observation?.businessRowsBeforeAfter || null
    }
  };
  const receiptBytes = Buffer.byteLength(JSON.stringify(receipt), 'utf8');
  if (receiptBytes > 44 * 1024) {
    throw new Error(`complete Q23.2 selection receipt exceeds the bounded evidence allowance (${receiptBytes} bytes)`);
  }
  const receiptRef = appendEvidence({ quest: 'Q23.2', scenario: 'deterministic-selection-complete-preassertion-receipt',
    driver: 'sqlite', status: 'SELECTION_RECEIPT', evidence: receipt });
  return { receipt, receiptRef };
}

async function runQ232TwoTurnBookingFlow(resourceSession, liveConfig, {
  modelSource = 'live', noCardFirstTurn = false, selectionValidator = assertDeterministicSlotSelectionContract,
  onSelectionReceiptPersisted = null, firstTurnUsageFault = null, onUsageProjectionObserved = null,
  onFailureReceiptPersisted = null
} = {}) {
  const limits = liveConversationLimits;
  const recordedFixture = modelSource === 'recorded_fixture';
  const isLiveProvider = modelSource === 'live';
  const scenario = isLiveProvider ? 'one-shot-live-multi-turn-booking-confirm-and-readback'
    : 'recorded-offline-two-turn-booking-confirm-and-readback';
  const expectedExecutionMode = isLiveProvider ? 'live' : 'recorded_fixture';
  const evidence = { modelRequested: liveConfig?.LLM_MODEL || null, executionMode: expectedExecutionMode, runIds: [], runs: [],
    testCommandAttemptLimit: 1, syntheticDatabase: 'sqlite', budgetEnvelope: {
      maxSessionRuntimeMs: limits.maxSessionRuntimeMs, cleanupReserveMs: limits.cleanupReserveMs,
      postRunReserveMs: limits.postRunReserveMs, apiStartupReserveMs: limits.apiStartupReserveMs,
      maximumProviderRuns: limits.maxProviderRuns, maximumProviderRequests: limits.maxProviderRequests,
      maximumToolCalls: limits.maxToolCalls, maximumTokens: limits.maxTokens,
      maximumEstimatedCostUsd: limits.maxEstimatedCostUsd,
      perRun: { maxRuntimeMs: limits.maxRunRuntimeMs, maxModelCalls: limits.maxModelCallsPerRun,
        maxToolCalls: limits.maxToolCallsPerRun, maxTokens: limits.maxTokensPerRun,
        maxEstimatedCostUsd: limits.maxEstimatedCostUsdPerRun, modelTimeoutMs: limits.modelTimeoutMs,
        toolTimeoutMs: limits.toolTimeoutMs }
    } };
  const liveStartedAt = performance.now();
  let phase = `${expectedExecutionMode}-preparation`;
  let pendingSteps = [{ step: 'first-turn-model-response', reason: 'initial booking turn has not completed' },
    { step: 'guest-slot-selection-turn', reason: 'waiting for a verified offered slot and explicit synthetic guest selection' },
    { step: 'pending-confirmation-card', reason: 'waiting for the guest to select a slot' },
    { step: 'confirmation-and-readback', reason: 'waiting for pending confirmation' }];
  let latestObservation = null;
  const observe = (run, observation) => {
    const modelUsage = Array.isArray(run.modelUsage) ? run.modelUsage.map(item => ({
      stepIndex: item.stepIndex ?? null, status: item.status || null,
      requestAttempted: item.requestAttempted ?? null,
      usageReported: item.usageReported ?? null,
      usageFieldsReported: item.usageFieldsReported ?? null,
      usageUnavailableReason: item.usageUnavailableReason ?? null,
      inputTokens: item.inputTokens ?? null, outputTokens: item.outputTokens ?? null,
      inputUsageSource: item.inputUsageSource || null, outputUsageSource: item.outputUsageSource || null,
      estimatedCostUsd: item.estimatedCostUsd ?? null, durationMs: item.durationMs ?? null,
      errorCode: item.errorCode || null
    })) : null;
    const requestAttemptedCount = modelUsage === null ? null
      : modelUsage.filter(item => item.requestAttempted === true).length;
    evidence.runIds.push(run.runId);
    evidence.runs.push({ runId: run.runId, sessionId: run.sessionId, provider: run.provider, model: run.model,
      executionMode: run.executionMode, live: run.live, stopReason: run.stopReason || run.errorCode,
      usageReported: run.usageReported ?? null,
      usageFieldsReported: run.usageFieldsReported ?? null,
      usageUnavailableReason: run.usageUnavailableReason ?? null,
      traceUsage: run.traceUsage ?? null,
      status: run.status, modelCallCount: run.modelCallCount, toolCallCount: run.toolCallCount,
      providerRequestAttempted: requestAttemptedCount === null ? null : requestAttemptedCount > 0,
      providerRequestAttemptedCount: requestAttemptedCount, toolCounts: run.toolCounts,
      inputTokens: run.traceUsage?.inputTokens ?? run.inputTokens,
      outputTokens: run.traceUsage?.outputTokens ?? run.outputTokens,
      totalTokens: run.traceUsage?.totalTokens ?? (Number.isFinite(run.inputTokens) && Number.isFinite(run.outputTokens)
        ? run.inputTokens + run.outputTokens : null),
      estimatedCostUsd: run.traceUsage?.estimatedCostUsd ?? run.estimatedCostUsd, durationMs: run.durationMs,
      actionCardStates: observation?.actionCardStates || [],
      businessRowsBeforeAfter: observation?.businessRowsBeforeAfter || null,
      noBusinessWrite: observation?.noBusinessWrite ?? null, reachedStep: observation?.reachedStep || null,
      stepStates: observation?.stepStates || [], modelUsage });
    latestObservation = observation || null;
  };
  try {
    if (!liveConfig?.LLM_BASE_URL || !liveConfig?.LLM_API_KEY || !liveConfig?.LLM_MODEL) {
      throw Object.assign(new Error('Q23.2 two-turn path requires an explicit bounded model configuration'), { stageBlocked: true });
    }
    let endpoint;
    try { endpoint = new URL(liveConfig.LLM_BASE_URL); }
    catch { throw Object.assign(new Error('Q23.2 model endpoint configuration is invalid'), { stageBlocked: true }); }
    if (isLiveProvider && (liveConfig.LLM_MODEL !== 'deepseek-flash' || endpoint.protocol !== 'https:'
      || !(endpoint.hostname === 'deepseek.com' || endpoint.hostname.endsWith('.deepseek.com')))) {
      throw Object.assign(new Error('Stage23 live endpoint is not the approved DeepSeek HTTPS host/model'), { stageBlocked: true });
    }
    if (recordedFixture && (liveConfig.ASSISTANT_MODEL_SOURCE !== 'recorded_fixture'
      || liveConfig.LLM_MODEL !== 'q23-recorded-fixture' || endpoint.protocol !== 'http:'
      || endpoint.hostname !== '127.0.0.1' || !endpoint.port)) {
      throw Object.assign(new Error('offline Q23.2 regression requires the exact local recorded-model fixture'), { stageBlocked: true });
    }
    if (firstTurnUsageFault !== null && (!recordedFixture
      || !['missing', 'null', 'partial'].includes(firstTurnUsageFault))) {
      throw Object.assign(new Error('the Q23.2 usage-fault control is restricted to missing/null/partial local recorded-fixture responses'),
        { stageBlocked: true });
    }
    const conversationDirectory = await resourceSession.allocateDir(`q23-${recordedFixture ? 'recorded' : 'live'}-${crypto.randomUUID()}`);
    const databasePath = path.join(conversationDirectory, 'community.sqlite');
    const firstElapsed = performance.now() - liveStartedAt;
    const firstAdmission = planConversationRunBudget({ modelCallCount: 0, toolCallCount: 0,
      totalTokens: 0, estimatedCostUsd: 0 }, firstElapsed, 0);
    requireBudgetCondition(firstAdmission.admitted, 'the bounded first live run cannot fit the remaining session and cleanup window');
    const firstEnvironment = makeBudgetedApiEnvironment(firstAdmission.effectiveLimits,
      { seed: true, liveConfig, modelSource });
    let firstState = null;
    phase = `first-turn-${expectedExecutionMode}-request`;
    pendingSteps = [{ step: 'initial-query-and-clarification', reason: 'waiting for model output and verified slot evidence' },
      { step: 'guest-slot-selection-turn', reason: 'waiting for a verified offered slot and explicit synthetic guest selection' },
      { step: 'pending-confirmation-card', reason: 'waiting for explicit guest selection to be server-revalidated' },
      { step: 'confirmation-and-readback', reason: 'waiting for the guest confirmation' }];
    await withApiAtDatabase(databasePath, async apiContext => {
      const context = { ...apiContext, driver: 'sqlite', pool: null,
        requestDeadlineAt: liveStartedAt + limits.maxSessionRuntimeMs - limits.cleanupReserveMs };
      let enforcedLimits;
      try { enforcedLimits = await enforcedBudgetStatus(context); }
      catch (error) {
        throw Object.assign(new Error(`assistant budget controls could not be read before the live request: ${String(error?.message || error).slice(0, 300)}`),
          { stageBlocked: true });
      }
      assertEnforcedBudgetStatus(enforcedLimits, firstAdmission.effectiveLimits,
        { executionMode: expectedExecutionMode, model: liveConfig.LLM_MODEL });
      if (isLiveProvider) {
        const rate = enforcedLimits.modelRateEstimate || {};
        requireBudgetCondition(rate.kind === 'budget_estimate_not_invoice'
          && Number.isFinite(rate.input) && Number.isFinite(rate.output)
          && rate.input <= 0.30 && rate.output <= 1.20,
        'the server did not report the conservative DeepSeek peak-rate estimate before the live request');
      }
      evidence.preRequestControls = { verified: true, enforcedLimits,
        remainingSessionMsBeforeFirstRequest: Math.max(0, limits.maxSessionRuntimeMs - (performance.now() - liveStartedAt)) };
      const user = await guestUser(context);
      const date = dateOffset(today, 1);
      const slots = await bookableSlots(context, user, date);
      const businessBefore = await guestBusinessCounts(context, user.id);
      const reservationCountBefore = await allReservationCount(context, user.id);
      assertRunFitsRemainingConversation(firstAdmission, liveStartedAt);
      let firstObservation = null;
      const firstText = `我想预约沙滩漫步项目，项目编号 project-beach-walk，日期 ${date}。请列出可选时段；我还没有选择，不要替我选。${noCardFirstTurn ? ' Q23_RECORDED_FAULT=first-turn-no-card' : ''}${firstTurnUsageFault ? ` Q23_RECORDED_FAULT=success-usage-${firstTurnUsageFault}-once-usageprojection` : ''}`;
      const first = await assistantText(context, user,
        firstText,
        null, { expectActionCard: false, onRunObserved: async (run, observation) => {
          observe(run, observation); firstObservation = observation;
        } });
      const firstUsage = usageFromAssistantRun(first.run);
      const firstProjectedRun = evidence.runs.at(-1);
      const firstProjectedUsage = aggregateLiveUsage([firstProjectedRun]);
      const firstProjectedAdmission = planConversationRunBudget(firstProjectedUsage,
        performance.now() - liveStartedAt, 1);
      evidence.firstRunUsageProjection = { runId: firstProjectedRun?.runId || null,
        usage: firstProjectedUsage, nextRunAdmission: firstProjectedAdmission,
        completeReportedUsage: isCompleteReportedUsage(firstProjectedUsage) };
      await onUsageProjectionObserved?.({ run: firstProjectedRun, usage: firstProjectedUsage,
        admission: firstProjectedAdmission });
      requireBudgetCondition(isCompleteReportedUsage(firstProjectedUsage)
        && firstProjectedAdmission.admitted,
      'first-run usage is missing or unknown after the shared observe/aggregate path; stop before creating the next API/provider run');
      assert.equal(first.run.executionMode, expectedExecutionMode,
        'the first booking turn uses the explicitly selected model source');
      assert.equal(first.run.live, isLiveProvider, 'recorded fixture runs cannot be mislabeled as live');
      assert.equal(first.run.model, liveConfig.LLM_MODEL);
      if (isLiveProvider) assert.equal(first.run.provider, 'deepseek', 'first booking turn reached the DeepSeek provider');
      for (const key of ['modelCallCount', 'toolCallCount', 'inputTokens', 'outputTokens', 'totalTokens',
        'estimatedCostUsd', 'usageKnown', 'usageReported', 'unknownUsageRunCount',
        'unknownUsageAttemptCount', 'providerRequestAttemptedCount', 'requestCountMatchesUsage']) {
        assert.equal(firstProjectedUsage[key], firstUsage[key],
          `shared observe/aggregate preserves actual API usage field ${key}`);
      }
      assert.equal(firstProjectedRun.usageReported, first.run.usageReported,
        'shared observe preserves the actual run-level usageReported flag');
      assert.deepEqual(firstProjectedRun.usageFieldsReported, first.run.usageFieldsReported ?? null,
        'shared observe preserves run-level usage-field completeness');
      assert.equal(firstProjectedRun.usageUnavailableReason, first.run.usageUnavailableReason ?? null,
        'shared observe preserves the run-level unavailable reason');
      assert.deepEqual(firstProjectedRun.traceUsage, first.run.traceUsage ?? null,
        'shared observe preserves the actual trace usage object');
      assert.deepEqual(firstProjectedRun.modelUsage?.map(item => ({ usageReported: item.usageReported,
        usageFieldsReported: item.usageFieldsReported, usageUnavailableReason: item.usageUnavailableReason })),
      first.run.modelUsage?.map(item => ({ usageReported: item.usageReported ?? null,
        usageFieldsReported: item.usageFieldsReported ?? null, usageUnavailableReason: item.usageUnavailableReason ?? null })),
      'shared observe preserves per-request usage completeness and unavailable-reason fields');
      assert.deepEqual(firstProjectedUsage.usageDiagnostics, firstUsage.usageDiagnostics,
        'shared observe/aggregate preserves per-request usage source and completeness diagnostics');
      if (!isLiveProvider) assert.ok(first.run.modelUsage?.filter(item => item.requestAttempted === true)
        .every(item => item.inputUsageSource === 'recorded_fixture'
          && item.outputUsageSource === 'recorded_fixture' && item.usageReported === true),
      'known offline first-turn usage is attributed to the recorded fixture');
      requireBudgetCondition(firstUsage.requestCountMatchesUsage && firstUsage.modelCallCount > 0,
        'first-run provider attempts are unknown or do not match model-step evidence');
      requireBudgetCondition(firstUsage.modelCallCount <= firstAdmission.effectiveLimits.maxModelCalls
        && firstUsage.toolCallCount <= firstAdmission.effectiveLimits.maxToolCalls
        && firstUsage.totalTokens <= firstAdmission.effectiveLimits.maxTokens
        && firstUsage.estimatedCostUsd <= firstAdmission.effectiveLimits.maxEstimatedCostUsd + 1e-12
        && Number.isFinite(first.run.durationMs) && first.run.durationMs > 0
        && first.run.durationMs <= firstAdmission.effectiveLimits.maxRuntimeMs,
      'the first model run exceeded its pre-dispatch server-enforced limits or reported incomplete usage');
      assert.ok(Array.isArray(first.run.modelUsage) && first.run.modelUsage.some(item =>
        item.requestAttempted === true && item.status === 'completed'),
      'provider-request evidence includes a completed response, not only an unattempted step');
      assert.equal(firstObservation?.noBusinessWrite, true, 'the initial live turn did not write business rows');
      assert.deepEqual(firstObservation?.businessRowsBeforeAfter?.before, businessBefore,
        'the first observation includes all six pre-run business-table counts');
      assert.deepEqual(firstObservation?.businessRowsBeforeAfter?.after, businessBefore,
        'the first observation preserves all six business-table counts');
      assert.deepEqual(await guestBusinessCounts(context, user.id), businessBefore);
      assert.equal(await allReservationCount(context, user.id), reservationCountBefore);

      let chosenSlot;
      let firstTurnKind;
      if (first.actionCard) {
        firstTurnKind = 'needs_input_action_card';
        assert.equal(first.actionCard.actionType, 'book_program');
        assert.equal(first.actionCard.status, 'needs_input');
        assert.ok(first.actionCard.missingFields.includes('本人选择的时段'));
        assert.equal(first.run.clarificationCount, 0);
        const available = first.actionCard.impact?.availableSlots || [];
        assert.ok(available.length > 0);
        chosenSlot = available[0];
        assert.ok(slots.some(item => item.id === chosenSlot.id && item.bookable && item.businessDate === date));
        const firstToolRows = await databaseQuery(context, `SELECT tool_name AS toolName,status,
          error_code AS errorCode FROM tool_executions WHERE run_id=? ORDER BY started_at,id`, [first.run.runId]);
        assert.ok(firstToolRows.some(row => row.toolName === 'propose_program_booking'
          && row.status === 'completed' && row.errorCode === null));
      } else {
        firstTurnKind = 'verified_read_only_queries_awaiting_guest_slot_selection';
        assert.equal(first.run.status, 'completed');
        assert.deepEqual(first.run.actionCards || [], []);
        assert.equal(first.run.stopReason, 'APPOINTMENT_SLOT_SELECTION_REQUESTED');
        assert.equal(first.run.clarificationCount, 0);
        assert.equal(first.run.clarificationState?.status, 'awaiting_guest_slot_selection');
        assert.equal(first.run.clarificationState?.sourceRunId, first.run.runId);
        assert.equal(first.run.clarificationState?.projectId, 'project-beach-walk');
        assert.equal(first.run.clarificationState?.date, date);
        assert.deepEqual(first.run.clarificationState?.readOnlyTools, ['list_projects', 'list_project_slots']);
        assert.deepEqual(first.run.toolCounts, { list_projects: 1, list_project_slots: 1 });
        const readOnlyRows = await databaseQuery(context, `SELECT tool_name AS toolName,status,
          error_code AS errorCode,arguments_json AS argumentsJson,result_json AS resultJson
          FROM tool_executions WHERE run_id=? ORDER BY started_at,id`, [first.run.runId]);
        const readOnly = validateReadOnlySlotQueries(readOnlyRows, { projectId: 'project-beach-walk', date, bookableSlots: slots });
        assert.deepEqual(first.run.clarificationState.offeredSlots.map(item => item.id),
          readOnly.offeredSlots.map(item => item.id));
        assert.match(first.run.reply || '', /请你明确选择一个时段/);
        assert.match(first.run.reply || '', /不会替你选择/);
        chosenSlot = first.run.clarificationState.offeredSlots[0];
        evidence.firstTurnReadOnlyEvidence = { toolNames: readOnlyRows.map(row => row.toolName),
          projectId: readOnly.slotResult.project.id, date: readOnly.slotResult.date,
          offeredSlotIds: readOnly.offeredSlots.map(item => item.id),
          clarificationOfferedSlotIds: first.run.clarificationState.offeredSlots.map(item => item.id) };
      }
      evidence.firstTurn = { runId: first.run.runId, sessionId: first.sessionId, kind: firstTurnKind,
        status: first.run.status, stopReason: first.run.stopReason || null,
        clarificationCount: first.run.clarificationCount, actionCardId: first.actionCard?.id || null,
        actionCardStatus: first.actionCard?.status || null,
        availableSlotCount: first.actionCard?.impact?.availableSlots?.length
          ?? first.run.clarificationState?.offeredSlots?.length ?? 0,
        chosenSlotCandidate: { id: chosenSlot.id, localStart: chosenSlot.localStart,
          localEnd: chosenSlot.localEnd, date, selectedBy: 'explicit synthetic guest input after server offer' },
        businessRowsBeforeAfter: firstObservation.businessRowsBeforeAfter, noBusinessWrite: firstObservation.noBusinessWrite,
        usage: firstUsage, requestAttemptedEvidence: first.run.modelUsage };
      firstState = { userId: user.id, date, chosenSlot, firstTurnKind, firstRun: first.run,
        firstActionCard: first.actionCard, firstSessionId: first.sessionId, firstUsage,
        businessBefore, reservationCountBefore, bookableSlots: slots, firstText };
      appendEvidence({ quest: 'Q23.2', scenario,
        driver: 'sqlite', status: 'OBSERVED', reachedStep: 'first-turn-complete',
        evidence: { ...evidence, pendingSteps } });
    }, firstEnvironment, { resourceSession });

    requireBudgetCondition(firstState, 'the first live run did not return complete conversation state');
    const usageAfterFirst = aggregateLiveUsage([firstState.firstRun]);
    evidence.usageAfterFirstTurn = usageAfterFirst;
    phase = 'guest-slot-selection-turn';
    pendingSteps = [{ step: 'guest-slot-selection-turn', reason: 'initial query and no-write counts were observed; synthetic guest selection is next' },
      { step: 'pending-confirmation-card', reason: 'waiting for server revalidation of the guest-selected slot' },
      { step: 'confirmation-and-readback', reason: 'waiting for explicit confirmation' }];
    const elapsedBeforeSecond = performance.now() - liveStartedAt;
    const secondRunAdmission = planConversationRunBudget(usageAfterFirst, elapsedBeforeSecond, 1);
    evidence.secondRunAdmission = secondRunAdmission;
    requireBudgetCondition(firstState.firstUsage.requestCountMatchesUsage
      && Number.isFinite(usageAfterFirst.modelCallCount) && Number.isFinite(usageAfterFirst.toolCallCount)
      && Number.isFinite(usageAfterFirst.totalTokens) && Number.isFinite(usageAfterFirst.estimatedCostUsd)
      && Number.isFinite(firstState.firstRun.durationMs) && firstState.firstRun.durationMs > 0
      && firstState.firstRun.durationMs <= firstAdmission.effectiveLimits.maxRuntimeMs,
    'first-run model/tool/token/cost/runtime usage is unknown or exceeds its actual server cap');
    requireBudgetCondition(secondRunAdmission.admitted,
      'remaining same-conversation model, tool, token, estimated-cost, or runtime budget cannot admit another bounded run');
    const secondEnvironment = makeBudgetedApiEnvironment(secondRunAdmission.effectiveLimits,
      { seed: false, liveConfig, modelSource });
    let finalUsage = null;
    await withApiAtDatabase(databasePath, async apiContext => {
      const context = { ...apiContext, driver: 'sqlite', pool: null,
        requestDeadlineAt: liveStartedAt + limits.maxSessionRuntimeMs - limits.cleanupReserveMs };
      const enforcedLimits = await enforcedBudgetStatus(context);
      assertEnforcedBudgetStatus(enforcedLimits, secondRunAdmission.effectiveLimits,
        { executionMode: expectedExecutionMode, model: liveConfig.LLM_MODEL });
      if (isLiveProvider) {
        const rate = enforcedLimits.modelRateEstimate || {};
        requireBudgetCondition(rate.kind === 'budget_estimate_not_invoice'
          && Number.isFinite(rate.input) && Number.isFinite(rate.output)
          && rate.input <= 0.30 && rate.output <= 1.20,
        'the server did not preserve the conservative DeepSeek peak-rate estimate for the remaining run');
      }
      evidence.secondRunPreRequestControls = { verified: true, enforcedLimits };
      const user = await guestUser(context);
      requireBudgetCondition(user.id === firstState.userId,
        'the synthetic guest identity changed across the managed SQLite service restart');
      const beforeConfirm = await allReservationCount(context, user.id);
      assert.equal(beforeConfirm, firstState.reservationCountBefore);
      const businessBeforeConfirm = await guestBusinessCounts(context, user.id);
      assert.deepEqual(businessBeforeConfirm, firstState.businessBefore);
      assertRunFitsRemainingConversation(secondRunAdmission, liveStartedAt);
      const selectionText = `我选择 ${firstState.chosenSlot.localStart} 至 ${firstState.chosenSlot.localEnd}，时段编号 ${firstState.chosenSlot.id}`;
      const providerRequestCountBeforeSelection = recordedFixture
        ? await recordedModelRequestCount(liveConfig.LLM_BASE_URL) : null;
      let secondObservation = null;
      const second = await assistantText(context, user,
        selectionText, firstState.firstSessionId, { onRunObserved: async (run, observation) => {
          observe(run, observation); secondObservation = observation;
          const providerRequestCountAfterSelection = recordedFixture
            ? await recordedModelRequestCount(liveConfig.LLM_BASE_URL) : null;
          const selectionReceipt = await persistQ232SelectionReceipt(context, user, firstState, run, observation,
            selectionText, { modelSource: expectedExecutionMode, providerRequestCountBeforeSelection,
              providerRequestCountAfterSelection });
          evidence.guestSelectionTurn = { runId: run.runId, sessionId: run.sessionId || firstState.firstSessionId,
            actionCardId: run.actionCards?.at(-1)?.id || null,
            actionCardStatus: run.actionCards?.at(-1)?.status || null,
            selectionInputText: selectionText, receiptRef: selectionReceipt.receiptRef,
            receiptBytes: selectionReceipt.receiptRef.bytes, receiptSha256: selectionReceipt.receiptRef.sha256,
            providerRequestCountBeforeSelection, providerRequestCountAfterSelection,
            providerRequestDelta: Number.isSafeInteger(providerRequestCountBeforeSelection)
              && Number.isSafeInteger(providerRequestCountAfterSelection)
              ? providerRequestCountAfterSelection - providerRequestCountBeforeSelection : null };
          if (onSelectionReceiptPersisted) await onSelectionReceiptPersisted(selectionReceipt);
        } });
      const secondUsage = usageFromAssistantRun(second.run);
      requireBudgetCondition(secondUsage.requestCountMatchesUsage && secondUsage.modelCallCount <= secondRunAdmission.effectiveLimits.maxModelCalls
        && secondUsage.toolCallCount <= secondRunAdmission.effectiveLimits.maxToolCalls
        && secondUsage.totalTokens <= secondRunAdmission.effectiveLimits.maxTokens
        && secondUsage.estimatedCostUsd <= secondRunAdmission.effectiveLimits.maxEstimatedCostUsd + 1e-12
        && Number.isFinite(second.run.durationMs) && second.run.durationMs > 0
        && second.run.durationMs <= secondRunAdmission.effectiveLimits.maxRuntimeMs,
      'second-run usage exceeds the pre-dispatch limits calculated from first-run remainder');
      const deterministicSelectionContract = await selectionValidator(context, user,
        { ...second, observation: secondObservation }, {
          firstTurnKind: firstState.firstTurnKind, sourceRun: firstState.firstRun,
          sourceCard: firstState.firstActionCard, selectedSlot: firstState.chosenSlot,
          projectId: 'project-beach-walk', date: firstState.date,
          expectedBusinessRows: firstState.businessBefore, bookableSlots: firstState.bookableSlots
        });
      assert.equal(second.sessionId, firstState.firstSessionId);
      assert.equal(second.actionCard.actionType, 'book_program');
      assert.equal(second.actionCard.status, 'pending_confirmation');
      assert.equal(second.actionCard.impact.slot.id, firstState.chosenSlot.id);
      assert.equal(second.actionCard.impact.slot.localStart || second.actionCard.impact.slot.start,
        firstState.chosenSlot.localStart);
      assert.equal(second.actionCard.impact.slot.localEnd || second.actionCard.impact.slot.end,
        firstState.chosenSlot.localEnd);
      assert.equal(secondObservation?.noBusinessWrite, true);
      assert.deepEqual(secondObservation?.businessRowsBeforeAfter?.before, firstState.businessBefore);
      assert.deepEqual(secondObservation?.businessRowsBeforeAfter?.after, firstState.businessBefore);
      Object.assign(evidence.guestSelectionTurn, { actionCardSlotId: second.actionCard.impact.slot.id,
        usage: secondUsage, businessRowsBeforeAfter: secondObservation?.businessRowsBeforeAfter || null,
        noBusinessWrite: secondObservation?.noBusinessWrite ?? null, deterministicSelectionContract });
      pendingSteps = [{ step: 'confirmation-and-readback', reason: 'pending_confirmation card passed; explicit guest confirmation is next' }];
      appendEvidence({ quest: 'Q23.2', scenario,
        driver: 'sqlite', status: 'OBSERVED', reachedStep: 'pending-confirmation-card',
        evidence: { ...evidence, pendingSteps } });

      phase = 'confirmation-and-readback';
      const confirmationResponse = await api(context, `/assistant/actions/${encodeURIComponent(second.actionCard.id)}/confirm`, {
        method: 'POST', token: user.token,
        headers: { 'Idempotency-Key': `assistant-action:${second.actionCard.id}:v${second.actionCard.version}` },
        body: { sessionId: second.sessionId, version: second.actionCard.version }
      });
      const confirmed = confirmationResponse.data?.actionCard || null;
      const businessId = confirmed?.result?.businessId || null;
      const reservationRow = businessId ? await databaseQuery(context, `SELECT r.id,r.status,r.slot_id AS slotId,
        r.guest_id AS guestId,s.project_id AS projectId,s.business_date AS businessDate,
        s.local_start AS localStart,s.local_end AS localEnd
        FROM reservations r JOIN activity_slots s ON s.id=r.slot_id WHERE r.id=? AND r.guest_id=?`,
      [businessId, user.id], 'get') : null;
      const reservationListResponse = await api(context, '/reservations', { token: user.token });
      const timelineResponse = await api(context, '/me/timeline', { token: user.token });
      const reservationList = reservationListResponse.status === 200 ? reservationListResponse.data.items || [] : [];
      const timeline = timelineResponse.status === 200 ? timelineResponse.data : {};
      const afterConfirm = await allReservationCount(context, user.id);
      const businessAfterConfirm = await guestBusinessCounts(context, user.id);
      const totalUsage = aggregateLiveUsage(evidence.runs);
      const attemptedProviderRequests = evidence.runs.reduce((sum, run) =>
        Number.isFinite(run.providerRequestAttemptedCount) ? sum + run.providerRequestAttemptedCount : NaN, 0);
      const elapsedMs = Math.max(0, Math.ceil(performance.now() - liveStartedAt));
      evidence.session = { sessionId: firstState.firstSessionId, date: firstState.date,
        chosenSlot: firstState.chosenSlot, actionCardId: second.actionCard.id,
        cardStatusBeforeConfirmation: second.actionCard.status, confirmationHttpStatus: confirmationResponse.status,
        confirmedStatus: confirmed?.status || null, realReservationId: businessId, reservationRow,
        reservationRowsBeforeAfter: [firstState.reservationCountBefore, afterConfirm],
        businessRowsBeforeConfirm: businessBeforeConfirm, businessRowsAfterConfirm: businessAfterConfirm,
        reservationListTotal: reservationListResponse.data?.total ?? null,
        reservationListReadback: reservationList.find(item => item.id === businessId) || null,
        timelineReadback: { upcoming: (timeline.upcomingBookings || []).find(item => item.id === businessId) || null,
          cancelled: (timeline.cancelledHistory || []).some(item => item.id === businessId) },
        aggregateUsage: totalUsage, providerRequestAttemptedCount: attemptedProviderRequests, elapsedMs };
      appendEvidence({ quest: 'Q23.2', scenario,
        driver: 'sqlite', status: 'OBSERVED', evidence });
      assert.equal(confirmationResponse.status, 200,
        `live action confirmation succeeded: ${JSON.stringify(confirmationResponse.data)}`);
      assert.equal(confirmed?.status, 'confirmed');
      assert.ok(businessId && reservationRow, 'confirmation returns an actual reservation row');
      assert.deepEqual([reservationRow.status, reservationRow.guestId, reservationRow.projectId, reservationRow.slotId,
        String(reservationRow.businessDate).slice(0, 10), reservationRow.localStart, reservationRow.localEnd],
      ['confirmed', user.id, 'project-beach-walk', firstState.chosenSlot.id, firstState.date,
        firstState.chosenSlot.localStart, firstState.chosenSlot.localEnd]);
      assert.equal(reservationListResponse.status, 200);
      assert.ok(evidence.session.reservationListReadback);
      assert.deepEqual([evidence.session.reservationListReadback.id, evidence.session.reservationListReadback.guestId,
        evidence.session.reservationListReadback.projectId, evidence.session.reservationListReadback.slotId,
        evidence.session.reservationListReadback.businessDate, evidence.session.reservationListReadback.localStart,
        evidence.session.reservationListReadback.localEnd, evidence.session.reservationListReadback.status],
      [businessId, user.id, 'project-beach-walk', firstState.chosenSlot.id, firstState.date,
        firstState.chosenSlot.localStart, firstState.chosenSlot.localEnd, 'confirmed']);
      assert.equal(timelineResponse.status, 200);
      assert.ok(evidence.session.timelineReadback.upcoming);
      assert.deepEqual([evidence.session.timelineReadback.upcoming.id,
        evidence.session.timelineReadback.upcoming.projectId, evidence.session.timelineReadback.upcoming.businessDate,
        evidence.session.timelineReadback.upcoming.localStart, evidence.session.timelineReadback.upcoming.localEnd,
        evidence.session.timelineReadback.upcoming.status],
      [businessId, 'project-beach-walk', firstState.date,
        firstState.chosenSlot.localStart, firstState.chosenSlot.localEnd, 'confirmed']);
      assert.equal(evidence.session.timelineReadback.cancelled, false);
      assert.equal(afterConfirm, firstState.reservationCountBefore + 1);
      assert.equal(Number(businessAfterConfirm.reservations), Number(firstState.businessBefore.reservations) + 1);
      for (const key of Object.keys(firstState.businessBefore)) if (key !== 'reservations') {
        assert.equal(businessAfterConfirm[key], firstState.businessBefore[key], `${key} is unchanged by confirmation`);
      }
      requireBudgetCondition(isCompleteReportedUsage(totalUsage)
        && Number.isFinite(totalUsage.modelCallCount)
        && totalUsage.modelCallCount === attemptedProviderRequests
        && Number.isFinite(totalUsage.toolCallCount) && Number.isFinite(totalUsage.totalTokens)
        && Number.isFinite(totalUsage.estimatedCostUsd),
      'the final same-conversation aggregate contains missing, unknown, or inconsistent provider-usage evidence');
      assert.ok(totalUsage.modelCallCount <= limits.maxProviderRequests
        && totalUsage.toolCallCount <= limits.maxToolCalls);
      assert.ok(totalUsage.totalTokens <= limits.maxTokens);
      assert.ok(totalUsage.estimatedCostUsd <= limits.maxEstimatedCostUsd && elapsedMs <= limits.maxSessionRuntimeMs);
      finalUsage = totalUsage;
    }, secondEnvironment, { resourceSession });
    requireBudgetCondition(finalUsage, 'the second managed API service did not return final usage evidence');
    evidence.finalUsage = finalUsage;
    appendEvidence({ quest: 'Q23.2', scenario,
      driver: 'sqlite', status: 'PASS', evidence });
    const output = [`scenario=${scenario}`, `evidence=${JSON.stringify(evidence)}`,
      `database=sqlite synthetic guest input; each API run started with its actual remaining conversation budget; modelSource=${expectedExecutionMode}`];
    return { scenario, evidence, output };
  } catch (error) {
    const failureSummary = firstAssertionFailureSummary(latestObservation, error, liveStartedAt, { phase, pendingSteps });
    evidence.failureSummary = failureSummary;
    const failureReceiptRef = appendEvidence({ quest: 'Q23.2', scenario,
      driver: 'sqlite', status: error?.stageBlocked ? 'BLOCKED' : 'FAIL',
      error: String(error?.message || error).slice(0, 2000), evidence });
    onFailureReceiptPersisted?.({ failureReceiptRef, failureSummary, error });
    throw error;
  }
}

async function runLive232(resourceSession, liveConfig) {
  const result = await runQ232TwoTurnBookingFlow(resourceSession, liveConfig, { modelSource: 'live' });
  return result.output;
}

export async function runQ232OfflineEntryRegression(resourceSession) {
  if (!resourceSession) throw new Error('Q23.2 offline entry regression requires a managed ResourceSession');
  const cases = [];
  for (const entry of [
    { name: 'needs_input-action-card', noCardFirstTurn: false,
      expectedKind: 'needs_input_action_card' },
    { name: 'verified-read-only-no-card', noCardFirstTurn: true,
      expectedKind: 'verified_read_only_queries_awaiting_guest_slot_selection' }
  ]) {
    const fixture = await startRecordedModel(resourceSession);
    try {
      const config = modelEnvironment(fixture);
      const before = await recordedModelRequestCount(config.LLM_BASE_URL);
      assert.equal(before, 0, `${entry.name} fixture starts with a fresh loopback request counter`);
      const result = await runQ232TwoTurnBookingFlow(resourceSession, config, {
        modelSource: 'recorded_fixture', noCardFirstTurn: entry.noCardFirstTurn
      });
      const after = await recordedModelRequestCount(config.LLM_BASE_URL);
      const evidence = result.evidence;
      assert.equal(evidence.firstTurn.kind, entry.expectedKind);
      assert.equal(evidence.firstRunUsageProjection.completeReportedUsage, true,
        'the first actual API usage remains complete through observe and aggregate');
      assert.equal(evidence.firstRunUsageProjection.usage.usageKnown, true);
      assert.equal(evidence.firstRunUsageProjection.usage.usageReported, true);
      assert.equal(evidence.session.aggregateUsage.usageKnown, true,
        'the final two-turn aggregate preserves the known API usage fields');
      assert.equal(evidence.session.aggregateUsage.usageReported, true);
      assert.equal(evidence.session.aggregateUsage.unknownUsageRunCount, 0);
      assert.equal(evidence.session.aggregateUsage.unknownUsageAttemptCount, 0);
      assert.ok(evidence.session.aggregateUsage.usageDiagnostics.filter(item => item.usageReported)
        .every(item => item.inputUsageSource === 'recorded_fixture'
          && item.outputUsageSource === 'recorded_fixture'));
      assert.equal(evidence.guestSelectionTurn.providerRequestDelta, 0,
        'the natural slot selection is deterministically revalidated without a model request');
      assert.equal(after - before, evidence.session.providerRequestAttemptedCount,
        'loopback model-server requests match persisted attempted-request diagnostics');
      assert.equal(evidence.session.confirmationHttpStatus, 200);
      assert.equal(evidence.session.confirmedStatus, 'confirmed');
      assert.equal(evidence.session.reservationRowsBeforeAfter[1], evidence.session.reservationRowsBeforeAfter[0] + 1);
      assert.equal(evidence.session.reservationListReadback?.status, 'confirmed');
      assert.equal(evidence.session.timelineReadback.upcoming?.status, 'confirmed');
      assert.equal(evidence.guestSelectionTurn.selectionInputText.includes(evidence.session.date), false,
        'the original natural selection text does not repeat the date');
      assert.equal(evidence.guestSelectionTurn.deterministicSelectionContract.selectionDateEvidence.inheritedFromSource,
        true);
      cases.push({ name: entry.name, status: 'PASS', firstTurnKind: evidence.firstTurn.kind,
        firstRunId: evidence.firstTurn.runId, selectionRunId: evidence.guestSelectionTurn.runId,
        selectedSlotId: evidence.session.chosenSlot.id, selectionDateInherited: true,
        confirmedReservationId: evidence.session.realReservationId,
        reservationListReadback: evidence.session.reservationListReadback?.status,
        timelineReadback: evidence.session.timelineReadback.upcoming?.status,
        providerRequestCount: after - before, providerRequestsDuringSelection: evidence.guestSelectionTurn.providerRequestDelta,
        usage: evidence.session.aggregateUsage, selectionReceiptRef: evidence.guestSelectionTurn.receiptRef });
    } finally {
      await stopRecordedModel(resourceSession, fixture);
    }
  }

  let unknownProjection = null;
  let unknownFailureReceiptRef = null;
  const unknownFixture = await startRecordedModel(resourceSession);
  try {
    const config = modelEnvironment(unknownFixture);
    const before = await recordedModelRequestCount(config.LLM_BASE_URL);
    let unknownError = null;
    try {
      await runQ232TwoTurnBookingFlow(resourceSession, config, {
        modelSource: 'recorded_fixture', firstTurnUsageFault: 'missing',
        onUsageProjectionObserved: projection => { unknownProjection = projection; },
        onFailureReceiptPersisted: ({ failureReceiptRef }) => { unknownFailureReceiptRef = failureReceiptRef; }
      });
    } catch (error) { unknownError = error; }
    const after = await recordedModelRequestCount(config.LLM_BASE_URL);
    assert.ok(unknownError?.stageBlocked, 'the shared live entry blocks a missing-usage run before starting the next API/provider run');
    assert.ok(unknownProjection, 'the actual API response reached the shared observe/aggregate/terminal gate');
    assert.ok(unknownFailureReceiptRef, 'the unknown-usage stop has a durable failure receipt');
    const projectedRun = unknownProjection.run;
    const usage = unknownProjection.usage;
    assert.equal(projectedRun.usageReported, false);
    assert.equal(projectedRun.traceUsage?.usageReported, false);
    assert.equal(projectedRun.stopReason, 'GRAPH_USAGE_UNKNOWN');
    assert.equal(projectedRun.modelUsage?.filter(item => item.requestAttempted === true).length, 1);
    assert.equal(projectedRun.modelUsage?.[0]?.usageReported, false);
    assert.equal(projectedRun.modelUsage?.[0]?.usageUnavailableReason,
      'provider_response_usage_missing_or_incomplete');
    assert.deepEqual(projectedRun.modelUsage?.[0]?.usageFieldsReported,
      { inputTokens: false, totalTokens: false, outputTokens: false });
    assert.equal(usage.usageKnown, false);
    assert.equal(usage.usageReported, false);
    assert.equal(isCompleteReportedUsage(usage), false,
      'the same complete-usage predicate used by the final acceptance gate rejects retained numeric estimates');
    assert.equal(usage.unknownUsageAttemptCount, 1);
    assert.equal(usage.requestCountMatchesUsage, true,
      'the actual attempted request count remains visible even while usage is unknown');
    assert.ok(Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens)
      && Number.isSafeInteger(usage.totalTokens) && Number.isFinite(usage.estimatedCostUsd),
    'the fixture retains finite server estimates while the usage status remains unknown');
    assert.deepEqual(usage.inputUsageSources, ['server_estimate']);
    assert.deepEqual(usage.outputUsageSources, ['server_estimate']);
    assert.equal(unknownProjection.admission.admitted, false);
    assert.equal(unknownProjection.admission.checks.observedUsageKnown, false);
    assert.equal(unknownProjection.admission.effectiveLimits, null);
    assert.equal(after - before, 1,
      'the missing-usage provider response creates no follow-up request before the flow blocks');
    const failureReceipt = readEvidenceAt(unknownFailureReceiptRef);
    assert.equal(failureReceipt.status, 'BLOCKED');
    assert.equal(failureReceipt.evidence.firstRunUsageProjection.usage.usageKnown, false);
    assert.equal(failureReceipt.evidence.firstRunUsageProjection.usage.usageReported, false);
    assert.ok(Number.isSafeInteger(failureReceipt.evidence.firstRunUsageProjection.usage.totalTokens));
    cases.push({ name: 'actual-shared-observe-aggregate-rejects-finite-estimates-with-missing-usage', status: 'PASS',
      actualApiRunId: projectedRun.runId, providerRequestCount: after - before, stopReason: projectedRun.stopReason,
      usageKnown: usage.usageKnown, usageReported: usage.usageReported,
      unknownUsageAttemptCount: usage.unknownUsageAttemptCount,
      finiteEstimatedInputTokens: usage.inputTokens, finiteEstimatedOutputTokens: usage.outputTokens,
      finiteEstimatedTotalTokens: usage.totalTokens, estimatedCostUsd: usage.estimatedCostUsd,
      finalAggregateGateWouldReject: !isCompleteReportedUsage(usage),
      nextRunAdmitted: unknownProjection.admission.admitted, durableFailureReceipt: unknownFailureReceiptRef,
      failureReceiptReadbackStatus: failureReceipt.status });
  } finally {
    await stopRecordedModel(resourceSession, unknownFixture);
  }

  let injectedReceiptRef = null;
  const injectedFixture = await startRecordedModel(resourceSession);
  try {
    const config = modelEnvironment(injectedFixture);
    const injectedValidator = async (...args) => {
      await assertDeterministicSlotSelectionContract(...args);
      assert.fail('injected Q23.2 selection-validator failure after actual validation');
    };
    let injectedFailure = null;
    try {
      await runQ232TwoTurnBookingFlow(resourceSession, config, {
        modelSource: 'recorded_fixture', selectionValidator: injectedValidator,
        onSelectionReceiptPersisted: ({ receiptRef }) => { injectedReceiptRef = receiptRef; }
      });
    } catch (error) { injectedFailure = error; }
    assert.ok(injectedFailure instanceof assert.AssertionError
      && /injected Q23\.2 selection-validator failure/u.test(injectedFailure.message),
    'the controlled validator fault is reached after the real shared contract ran');
    assert.ok(injectedReceiptRef, 'the full selection receipt reference exists before the validator is invoked');
    const persisted = readEvidenceAt(injectedReceiptRef);
    const receipt = persisted.evidence;
    assert.equal(persisted.status, 'SELECTION_RECEIPT');
    assert.equal(receipt.evidenceKind, 'q232-deterministic-slot-selection-before-assertions');
    assert.ok(receipt.selectionResponse.run.runId && receipt.selectionResponse.run.steps.length > 0);
    assert.ok(receipt.selectionResponse.run.steps.some(step =>
      step.diagnostic?.kind === 'appointment_slot_selection_revalidation'
      && step.diagnostic.selectedSlotId === receipt.expected.selectedSlot.id));
    assert.ok(receipt.source.run.runId && receipt.source.run.sessionId);
    assert.equal(receipt.source.actionCard?.id || null, receipt.dateProvenance.sourceCardId);
    assert.equal(receipt.selectionResponse.currentActionCard?.parameters?.date, receipt.dateProvenance.effectiveDate);
    assert.equal(receipt.selectionResponse.currentActionCard?.parameters?.slotId, receipt.expected.selectedSlot.id);
    assert.ok(receipt.selectionResponse.currentActionCard?.impact?.slot?.id === receipt.expected.selectedSlot.id);
    assert.equal(receipt.databaseReadback.sourceRun.status, 'read');
    assert.equal(receipt.databaseReadback.selectionRun.status, 'read');
    assert.equal(receipt.databaseReadback.selectionCard.status, 'read');
    assert.equal(receipt.databaseReadback.selectionSteps.status, 'read');
    assert.equal(receipt.databaseReadback.sixGuestBusinessCounts.status, 'read');
    assert.deepEqual(receipt.databaseReadback.observationBeforeAfter.before,
      receipt.databaseReadback.observationBeforeAfter.after);
    assert.deepEqual(receipt.databaseReadback.sixGuestBusinessCounts.rows,
      receipt.databaseReadback.observationBeforeAfter.after);
    assert.equal(receipt.providerRequestCounts.delta, 0);
    cases.push({ name: 'injected-validator-failure-receipt-recovery', status: 'PASS',
      failure: injectedFailure.message, receiptRef: injectedReceiptRef,
      receiptReadback: { evidenceKind: receipt.evidenceKind, sourceRunId: receipt.source.run.runId,
        selectionRunId: receipt.selectionResponse.run.runId,
        sourceCardId: receipt.source.actionCard?.id || null,
        selectedCardId: receipt.selectionResponse.currentActionCard.id,
        stepCount: receipt.selectionResponse.run.steps.length,
        databaseReadbackChecks: 5, businessRowsUnchanged: true, providerRequestsDuringSelection: 0 } });
  } finally {
    await stopRecordedModel(resourceSession, injectedFixture);
  }
  const result = { quest: 'Q23.2', scenario: 'offline-original-two-callback-entry-confirmation-readback-regression',
    status: 'PASS', modelSource: 'recorded_fixture', endpointBoundary: 'loopback-only',
    firstTurnKindsCovered: ['needs_input_action_card', 'verified_read_only_queries_awaiting_guest_slot_selection'],
    naturalSelectionTextRepeatsDate: false, confirmationListAndTimelineReadback: true,
    injectedValidatorFailureReceiptRetrievable: true, cases };
  appendEvidence({ quest: 'Q23.2', scenario: result.scenario, driver: 'sqlite', status: 'PASS', evidence: result });
  return { output: [`scenario=${result.scenario}`, `evidence=${JSON.stringify(result)}`], evidence: result };
}

export async function run({ questId, live = false, liveConfig = null, resourceSession }) {
  if (!resourceSession) throw new Error('Stage23 requires a managed ResourceSession');
  const runner = runners[questId];
  if (!runner) throw new Error(`Unsupported Stage23 quest: ${questId}`);
  let output;
  try {
    if (live) return { output: await runLive232(resourceSession, liveConfig || {}) };
    const details = await withModelBoth(runner, resourceSession);
    output = [`scenario=${details.scenario}`, `evidence=${JSON.stringify(details.evidence)}`, 'database=sqlite,mysql'];
    if (questId === 'Q23.9') {
      const browser = await runStage23BrowserAcceptance(resourceSession);
      output.push(`browser=${JSON.stringify({ evidencePath: browser.evidencePath, screenshots: browser.screenshots.length,
        confirmedReservationId: browser.browserFlow.confirmedReservationId, mealOrderId: browser.browserFlow.mealOrderId,
        healthRecordId: browser.browserFlow.healthRecordId, restDraftId: browser.browserFlow.restDraftId })}`);
    }
    return { output };
  } catch (error) {
    appendEvidence({ quest: questId, status: error?.stageBlocked ? 'BLOCKED' : 'FAIL', error: String(error?.message || error).slice(0, 3000) });
    throw error;
  }
}
