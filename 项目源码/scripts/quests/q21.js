import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { withBothDatabaseApis, withDatabaseApi, databaseQuery, login } from './q10-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordedModel = path.join(projectRoot, 'scripts/resources/q21-recorded-model-server.js');
const evidencePath = process.env.STAGE21_EVIDENCE_PATH
  || path.join(projectRoot, 'output/resource-audit/stage21-execution-evidence-20261003.jsonl');
const fixedInstant = '2026-10-05T00:00:00.000Z';
const today = '2026-10-05';
let activeResourceSession;

function dateOffset(date, days) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function tomorrowInShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date());
  const date = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return dateOffset(`${date.year}-${date.month}-${date.day}`, 1);
}

function databaseTimestamp(driver, value) {
  return driver === 'mysql' ? value.replace('T', ' ').replace('Z', '') : value;
}

function appendEvidence(entry) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ recordedAt: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...entry });
  const bytes = Buffer.byteLength(line, 'utf8') + 1;
  const current = fs.existsSync(evidencePath) ? fs.statSync(evidencePath).size : 0;
  if (bytes > 48 * 1024 || current + bytes > 8 * 1024 * 1024) throw new Error('Stage21 execution evidence reached its configured limit');
  fs.appendFileSync(evidencePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('Q21 could not reserve a loopback port')));
    });
  });
}

async function startRecordedModel() {
  if (!activeResourceSession) throw new Error('Stage21 fixture requires a managed ResourceSession');
  const port = await availablePort();
  const resource = await activeResourceSession.startProcess({ label: `q21-recorded-model-${crypto.randomUUID().slice(0, 8)}`,
    kind: 'stub', role: 'model-provider', command: process.execPath, args: [recordedModel], cwd: projectRoot,
    port, env: { PATH: process.env.PATH || '', PORT: String(port) } });
  if (resource.status !== 'running') throw new Error(`Stage21 recorded model failed to start: ${JSON.stringify(resource)}`);
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { resource, baseUrl: `http://127.0.0.1:${port}/v1` };
      } catch { /* bounded readiness retry */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Stage21 recorded model readiness timed out');
  } catch (error) {
    await activeResourceSession.stop(resource.id, 'q21-model-start-failure').catch(() => {});
    await activeResourceSession.waitProcess(resource.id, 10_000).catch(() => {});
    throw error;
  }
}

async function stopRecordedModel(handle, reason = 'q21-model-complete') {
  if (!handle) return null;
  const state = await activeResourceSession.status();
  const current = state.resources?.find(item => item.id === handle.resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await activeResourceSession.stop(current.id, reason);
    if (!stopped.ok) throw new Error(`Q21 recorded model stop failed: ${stopped.error || 'unknown error'}`);
  }
  const result = await activeResourceSession.waitProcess(handle.resource.id, 10_000);
  if (result.timedOut || result.unavailable || ['starting', 'running'].includes(result.status)) {
    throw new Error(`Q21 recorded model did not exit: ${JSON.stringify(result)}`);
  }
  return result;
}

function fixtureEnvironment(provider, extra = {}) {
  return { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: fixedInstant,
    LLM_BASE_URL: provider.baseUrl, LLM_API_KEY: 'q21-recorded-fixture-only', LLM_MODEL: 'recorded-stage21',
    LLM_TIMEOUT_MS: '30000', ASSISTANT_MODEL_SOURCE: 'recorded_fixture', Q21_ACCEPTANCE_HOOKS: '1', ...extra };
}

async function request(baseUrl, route, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

function assertStatus(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

async function profileFingerprint(context, guestId) {
  const row = await databaseQuery(context, 'SELECT health_profile_json,health_profile_version FROM guest_profiles WHERE user_id=?', [guestId], 'get');
  return { version: Number(row?.health_profile_version || 0), sha256: sha256(row?.health_profile_json || '') };
}

async function intakeCounts(context, guestId) {
  const statusColumn = context.driver === 'mysql' ? 'review_status' : 'status';
  const row = await databaseQuery(context, `SELECT COUNT(*) AS total,
    SUM(CASE WHEN ${statusColumn}='pending' THEN 1 ELSE 0 END) AS pending FROM health_intakes WHERE guest_id=?`, [guestId], 'get');
  return { total: Number(row?.total || 0), pending: Number(row?.pending || 0) };
}

async function guest(context) {
  const result = await login(context.baseUrl, 'guest');
  assertStatus(result, 200, `${context.driver}: login guest_demo`);
  return { id: result.data.user.id, token: result.data.token };
}

async function setStay(context, guestId, days, { start = today } = {}) {
  const end = dateOffset(start, days);
  const checkIn = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const checkOut = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  await databaseQuery(context, `UPDATE guest_profiles SET ${checkIn}=?,${checkOut}=? WHERE user_id=?`, [start, end, guestId], 'run');
  return { start, end };
}

async function setHealth(context, guestId, { chronic = ['高血压'], allergies = ['虾'], mobility = '可独立行走', healthProfile = {} } = {}) {
  await databaseQuery(context, `UPDATE guest_profiles SET chronic_json=?,allergies_json=?,mobility=?,health_profile_json=? WHERE user_id=?`,
    [JSON.stringify(chronic), JSON.stringify(allergies), mobility, JSON.stringify(healthProfile), guestId], 'run');
}

function completeLowRiskHealthProfile() {
  return {
    chronic: { status: 'none', items: [] },
    medications: { status: 'none', items: [] },
    allergies: { status: 'none', items: [] },
    dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'independent', details: '可独立行走' },
    sleep: { status: 'reported', details: '睡眠正常' },
    skin: { status: 'reported', details: '皮肤完整，无破损' },
    audienceTags: { status: 'none', items: [] }
  };
}

function slotId(projectId, date, start, end) {
  const digest = crypto.createHash('sha256').update(`${projectId}\u0000${date}\u0000${start}\u0000${end}`).digest('hex').slice(0, 32);
  return `slot_${digest}`;
}

async function insertSlot(context, { projectId, date, start, end, id = slotId(projectId, date, start, end) }) {
  const utcValue = (time) => new Date(`${date}T${time}:00+08:00`).toISOString();
  const startsAt = databaseTimestamp(context.driver, utcValue(start));
  const endsAt = databaseTimestamp(context.driver, utcValue(end));
  const updatedAt = databaseTimestamp(context.driver, fixedInstant);
  const existing = await databaseQuery(context, 'SELECT id FROM activity_slots WHERE id=?', [id], 'get');
  if (existing) {
    await databaseQuery(context, `UPDATE activity_slots SET project_id=?,business_date=?,starts_at=?,ends_at=?,local_start=?,local_end=?,
      capacity=2,is_closed=0,updated_at=? WHERE id=?`, [projectId, date, startsAt, endsAt, start, end, updatedAt, id], 'run');
  } else {
    await databaseQuery(context, `INSERT INTO activity_slots
      (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,2,0,?,?)`, [id, projectId, date, startsAt, endsAt, start, end, updatedAt, updatedAt], 'run');
  }
  return id;
}

function snapshotKey(locationId, stationId, date, domain) {
  return `env:${crypto.createHash('sha256').update(JSON.stringify([locationId, stationId, date, domain])).digest('hex').slice(0, 48)}`;
}

async function seedEnvironment(context, date, marineCase = 'safe') {
  const demo = makeDemoEnvironment(date, fixedInstant, DEMO_ENVIRONMENT_LOCATION);
  if (marineCase === 'unsafe') {
    for (const sample of demo.marine.hourly) if (sample.time.endsWith('T15:00') || sample.time.endsWith('T16:00')) sample.waveHeightM = 2.2;
  }
  if (marineCase === 'unknown') {
    demo.tide.hourly = demo.tide.hourly.filter(sample => !sample.localTime.endsWith('T15:00') && !sample.localTime.endsWith('T16:00'));
    demo.marine.hourly = demo.marine.hourly.filter(sample => !sample.time.endsWith('T15:00') && !sample.time.endsWith('T16:00'));
  }
  const payloads = [
    ['weather', '', demo.weather],
    ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide],
    ['marine', '', demo.marine]
  ];
  for (const [domain, stationId, payload] of payloads) {
    const key = snapshotKey(DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain);
    const json = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    const insertSql = `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,payload_hash,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)`;
    const updateSql = context.driver === 'mysql'
      ? ` ON DUPLICATE KEY UPDATE status=VALUES(status),source_name=VALUES(source_name),source_url=VALUES(source_url),
          observed_at=VALUES(observed_at),expires_at=VALUES(expires_at),payload_hash=VALUES(payload_hash),payload_json=VALUES(payload_json),updated_at=VALUES(updated_at)`
      : ` ON CONFLICT(snapshot_key) DO UPDATE SET status=excluded.status,source_name=excluded.source_name,source_url=excluded.source_url,
          observed_at=excluded.observed_at,expires_at=excluded.expires_at,payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`;
    await databaseQuery(context, `${insertSql}${updateSql}`,
    [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, payload.sourceName || 'Stage21 合成快照', payload.sourceUrl || '',
      databaseTimestamp(context.driver, fixedInstant), databaseTimestamp(context.driver, '2026-10-05T02:00:00.000Z'), hash, json,
      databaseTimestamp(context.driver, fixedInstant), databaseTimestamp(context.driver, fixedInstant)], 'run');
  }
}

async function counts(context, guestId) {
  const queries = await Promise.all([
    databaseQuery(context, 'SELECT COUNT(*) AS count FROM reservations WHERE guest_id=?', [guestId], 'get'),
    databaseQuery(context, 'SELECT COUNT(*) AS count FROM meal_menus WHERE guest_id=?', [guestId], 'get'),
    databaseQuery(context, 'SELECT COUNT(*) AS count FROM meal_orders WHERE guest_id=?', [guestId], 'get'),
    databaseQuery(context, 'SELECT COUNT(*) AS count FROM activity_slots', [], 'get')
  ]);
  return { reservations: Number(queries[0]?.count || 0), menus: Number(queries[1]?.count || 0),
    orders: Number(queries[2]?.count || 0), slots: Number(queries[3]?.count || 0) };
}

async function postDraft(context, guest, label, { request = '' } = {}) {
  return await requestResult(context, guest, label, request);
}

async function requestResult(context, user, label, requestText = '') {
  const result = await request(context.baseUrl, '/me/therapy-drafts', { method: 'POST', token: user.token,
    headers: { 'Idempotency-Key': `q21:${label}` }, body: { request: requestText } });
  assert.ok([200, 201].includes(result.status), `${context.driver}: Q21 draft ${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function compactEvidenceRejection(value) {
  if (!value || typeof value !== 'object') return null;
  const compact = {};
  if (typeof value.condition === 'string') compact.condition = value.condition.slice(0, 96);
  if (typeof value.agentId === 'string') compact.agentId = value.agentId.slice(0, 96);
  if (typeof value.coordinatorError === 'string') compact.coordinatorError = value.coordinatorError.slice(0, 96);
  if (typeof value.observed === 'string') compact.observed = value.observed.slice(0, 96);
  if (typeof value.errorCode === 'string') compact.errorCode = value.errorCode.slice(0, 96);
  if (Array.isArray(value.missingTools)) compact.missingTools = value.missingTools.slice(0, 8).map(item => String(item).slice(0, 96));
  if (Array.isArray(value.observedTools)) compact.observedTools = value.observedTools.slice(0, 8).map(item => ({
    toolName: String(item?.toolName || '').slice(0, 96), status: String(item?.status || '').slice(0, 48),
    errorCode: item?.errorCode ? String(item.errorCode).slice(0, 96) : null
  }));
  if (value.observed && typeof value.observed === 'object') compact.observed = {
    schemaValid: value.observed.schemaValid ?? null, allowlistValid: value.observed.allowlistValid ?? null,
    responseComplete: value.observed.responseComplete ?? null
  };
  if (value.candidateCounts && typeof value.candidateCounts === 'object') compact.candidateCounts = Object.fromEntries(
    Object.entries(value.candidateCounts).filter(([, count]) => Number.isFinite(Number(count))).slice(0, 8)
      .map(([key, count]) => [key, Number(count)]));
  if (value.toolContext && typeof value.toolContext === 'object') compact.toolContext = Object.fromEntries(
    Object.entries(value.toolContext).filter(([, item]) => item === null || ['string', 'number', 'boolean'].includes(typeof item))
      .slice(0, 12).map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 96) : item]));
  return compact;
}

function compactSourceRefs(items, limit = 80) {
  return (Array.isArray(items) ? items : []).slice(0, limit).flatMap(item => {
    if (!item || typeof item.type !== 'string' || item.id === undefined || item.id === null) return [];
    return [{ type: item.type.slice(0, 64), id: String(item.id).slice(0, 160) }];
  });
}

function safeMetricObject(value, keys) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of keys) {
    const item = value[key];
    if (item === null || typeof item === 'boolean' || typeof item === 'string') result[key] = typeof item === 'string' ? item.slice(0, 96) : item;
    else if (Number.isFinite(Number(item))) result[key] = Number(item);
  }
  return result;
}

function compactBudgetState(value) {
  if (!value || typeof value !== 'object') return null;
  const numericFields = fields => Object.fromEntries(Object.entries(fields || {})
    .filter(([, amount]) => Number.isFinite(Number(amount))).map(([key, amount]) => [key, Number(amount)]));
  return {
    consumed: numericFields(value.consumed), inFlight: numericFields(value.inFlight), remaining: numericFields(value.remaining),
    modelCalls: numericFields(value.modelCalls), toolCalls: numericFields(value.toolCalls), limits: numericFields(value.limits),
    runtimeRemainingMs: Number.isFinite(Number(value.runtimeRemainingMs)) ? Number(value.runtimeRemainingMs) : null
  };
}

function compactBudgetDecision(item) {
  const request = item?.request || {};
  const reservation = item?.reservation || {};
  const actualUsage = item?.actualUsage || {};
  return {
    phase: String(item?.phase || '').slice(0, 32), outcome: String(item?.outcome || '').slice(0, 32),
    agentId: String(item?.agentId || '').slice(0, 96),
    reservationId: String(item?.reservationId || '').slice(0, 120),
    rejectionCode: item?.rejectionCode ? String(item.rejectionCode).slice(0, 96) : null,
    providerRequestSent: typeof item?.providerRequestSent === 'boolean' ? item.providerRequestSent : null,
    request: safeMetricObject(request, ['messageBytes', 'estimatedInputTokens', 'requestedOutputTokens', 'toolCount']),
    reservation: safeMetricObject(reservation, ['tokens', 'costUsd', 'maxOutputTokens']),
    actualUsage: safeMetricObject(actualUsage, ['inputTokens', 'outputTokens', 'estimatedCostUsd']),
    stateAfter: compactBudgetState(item?.stateAfter)
  };
}

function safeQ215GraphSummary(run) {
  if (!run || typeof run !== 'object') return { available: false };
  const collaboration = run.collaboration && typeof run.collaboration === 'object' ? run.collaboration : null;
  const validation = collaboration?.selectionValidation || {};
  const parent = collaboration?.parent || {};
  const modelStep = step => ({
    stepIndex: Number.isFinite(Number(step?.stepIndex)) ? Number(step.stepIndex) : null,
    status: String(step?.status || '').slice(0, 32),
    finishReason: String(step?.finishReason || step?.diagnostic?.finishReason || '').slice(0, 48) || null,
    responseFormat: String(step?.diagnostic?.responseFormat || '').slice(0, 48) || null,
    errorCode: String(step?.errorCode || '').slice(0, 96) || null,
    durationMs: Number.isFinite(Number(step?.durationMs)) ? Number(step.durationMs) : null,
    inputTokens: Number.isFinite(Number(step?.inputTokens)) ? Number(step.inputTokens) : null,
    outputTokens: Number.isFinite(Number(step?.outputTokens)) ? Number(step.outputTokens) : null,
    estimatedCostUsd: Number.isFinite(Number(step?.estimatedCostUsd)) ? Number(step.estimatedCostUsd) : null
  });
  const candidate = item => ({ candidateId: String(item?.candidateId || '').slice(0, 160),
    domain: String(item?.domain || '').slice(0, 48), status: String(item?.status || '').slice(0, 48),
    sourceIds: compactSourceRefs(item?.sourceIds, 30) });
  return {
    available: true, sourceRunId: /^run_[0-9a-f-]{36}$/u.test(String(run.runId || '')) ? run.runId : null,
    parent: { status: String(run.status || '').slice(0, 32), errorCode: String(run.errorCode || '').slice(0, 96) || null,
      executionMode: String(run.executionMode || '').slice(0, 32), model: String(run.model || '').slice(0, 96) || null,
      coordinatorStatus: String(collaboration?.coordinatorStatus || '').slice(0, 32) || null,
      coordinatorError: String(collaboration?.coordinatorError || '').slice(0, 96) || null,
      selectionSource: String(collaboration?.selectionSource || '').slice(0, 48) || null,
      fallbackSource: String(collaboration?.fallbackSource || '').slice(0, 48) || null,
      selectionValidation: { schemaValid: validation.schemaValid ?? null, allowlistValid: validation.allowlistValid ?? null,
        responseComplete: validation.responseComplete ?? null, semanticValid: validation.semanticValid ?? null },
      coordinatorEvidence: collaboration?.coordinatorEvidence || null,
      modelSteps: (Array.isArray(parent.modelSteps) ? parent.modelSteps : []).slice(0, 8).map(modelStep),
      validationSteps: (Array.isArray(parent.validationSteps) ? parent.validationSteps : []).slice(0, 8).map(step => ({
        status: String(step?.status || '').slice(0, 32), errorCode: String(step?.errorCode || '').slice(0, 96) || null,
        schemaValid: step?.diagnostic?.schemaValid ?? null, allowlistValid: step?.diagnostic?.allowlistValid ?? null,
        responseComplete: step?.diagnostic?.responseComplete ?? null,
        finishReason: String(step?.diagnostic?.finishReason || '').slice(0, 48) || null
      })) },
    selectedCandidateIds: (Array.isArray(collaboration?.selectedCandidateIds) ? collaboration.selectedCandidateIds : []).slice(0, 80)
      .map(item => String(item).slice(0, 160)),
    finalAdoptedCandidateIds: (Array.isArray(collaboration?.finalAdoptedCandidateIds) ? collaboration.finalAdoptedCandidateIds : []).slice(0, 80)
      .map(item => String(item).slice(0, 160)),
    candidates: (Array.isArray(collaboration?.candidates) ? collaboration.candidates : []).slice(0, 120).map(candidate),
    children: (Array.isArray(collaboration?.agents) ? collaboration.agents : []).slice(0, 4).map(agent => ({
      runId: String(agent?.runId || '').slice(0, 64), agentId: String(agent?.agentId || '').slice(0, 96),
      status: String(agent?.status || '').slice(0, 32), executionMode: String(agent?.executionMode || '').slice(0, 32),
      model: String(agent?.model || '').slice(0, 96) || null, errorCode: String(agent?.errorCode || '').slice(0, 96) || null,
      modelSteps: (Array.isArray(agent?.modelSteps) ? agent.modelSteps : []).slice(0, 8).map(modelStep),
      tools: (Array.isArray(agent?.tools) ? agent.tools : []).slice(0, 12).map(tool => ({
        toolName: String(tool?.toolName || '').slice(0, 80), status: String(tool?.status || '').slice(0, 32),
        errorCode: String(tool?.errorCode || '').slice(0, 96) || null,
        durationMs: Number.isFinite(Number(tool?.durationMs)) ? Number(tool.durationMs) : null,
        resultSummary: tool?.resultSummary && typeof tool.resultSummary === 'object' ? tool.resultSummary : null
      })),
      candidateIds: (Array.isArray(agent?.candidateIds) ? agent.candidateIds : []).slice(0, 80).map(item => String(item).slice(0, 160)),
      sources: compactSourceRefs(agent?.sources)
    })),
    graphBudget: safeMetricObject(collaboration?.graphBudget, ['maxRuntimeMs', 'maxModelCalls', 'maxToolCalls', 'maxTokens',
      'maxEstimatedCostUsd', 'modelCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'estimatedCostUsd',
      'reservedTokens', 'reservedCostUsd', 'elapsedMs']),
    budgetDecisions: (Array.isArray(collaboration?.budgetDecisions) ? collaboration.budgetDecisions : []).slice(0, 24).map(compactBudgetDecision)
  };
}

async function fetchQ215SourceGraph(context, user, apiFailure) {
  const runId = apiFailure?.details?.sourceRunId;
  if (!runId) return { available: false, reason: 'source_run_id_missing' };
  try {
    const result = await request(context.baseUrl, `/assistant/runs/${encodeURIComponent(runId)}?role=guest`, { token: user.token });
    if (result.status !== 200) return { available: false, httpStatus: result.status };
    return safeQ215GraphSummary(result.data);
  } catch (error) {
    return { available: false, fetchFailure: { name: String(error?.name || 'Error').slice(0, 48),
      code: String(error?.code || '').slice(0, 96) || null } };
  }
}

function compactDraftApiFailure(status, data) {
  const details = data?.details && typeof data.details === 'object' ? data.details : {};
  const sourceRunId = typeof details.sourceRunId === 'string' && /^run_[0-9a-f-]{36}$/u.test(details.sourceRunId)
    ? details.sourceRunId : null;
  return {
    httpStatus: Number(status), code: String(data?.code || '').slice(0, 96) || null,
    message: String(data?.error || data?.message || '').slice(0, 300),
    details: { sourceRunId, executionMode: String(details.executionMode || '').slice(0, 32) || null,
      status: String(details.status || '').slice(0, 32) || null,
      evidenceRejection: compactEvidenceRejection(details.evidenceRejection) }
  };
}

async function postDraftWithApiEvidence(context, user, label, requestText = '') {
  const result = await request(context.baseUrl, '/me/therapy-drafts', { method: 'POST', token: user.token,
    headers: { 'Idempotency-Key': `q21:${label}` }, body: { request: requestText } });
  if ([200, 201].includes(result.status)) return result.data;
  const apiFailure = compactDraftApiFailure(result.status, result.data);
  const error = new Error(`${context.driver}: Q21 draft ${label}: ${JSON.stringify(apiFailure)}`);
  error.name = 'AssertionError';
  error.code = apiFailure.code || 'Q21_DRAFT_REQUEST_FAILED';
  error.apiFailure = apiFailure;
  throw error;
}

async function runQuestionnaire(context, user) {
  const first = assertStatus(await request(context.baseUrl, '/me/health-assessment', { token: user.token }), 200, 'initial assessment read');
  assert.ok(first.missing.some(item => item.key === 'sleep'));
  let current = first;
  const answers = {
    chronic: { status: 'reported', items: ['慢病本人确认'] },
    medications: { status: 'none', items: [] },
    allergies: { status: 'reported', items: ['虾'] },
    dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'independent', details: '可以独立行走' },
    skin: { status: 'unknown', details: '' },
    audienceTags: { status: 'none', items: [] }
  };
  for (const [field, answer] of Object.entries(answers)) {
    current = assertStatus(await request(context.baseUrl, '/me/health-assessment/answers', { method: 'PUT', token: user.token,
      body: { field, answer, baseVersion: current.version } }), 200, `assessment answer ${field}`);
  }
  assert.equal(current.nextQuestion?.key, 'sleep');
  const restarted = await context.restartApi();
  context.baseUrl = restarted;
  const resumed = assertStatus(await request(context.baseUrl, '/me/health-assessment', { token: user.token }), 200, 'assessment resume after API restart');
  assert.equal(resumed.version, current.version);
  assert.equal(resumed.nextQuestion?.key, 'sleep');
  assert.equal(resumed.profile.chronic.status, 'reported');
  const completed = assertStatus(await request(context.baseUrl, '/me/health-assessment/answers', { method: 'PUT', token: user.token,
    body: { field: 'sleep', answer: { status: 'unknown', details: '' }, baseVersion: resumed.version } }), 200, 'finish initial assessment');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.missing.length, 0);
  return { version: completed.version, completed: completed.progress.completed };
}

async function runExtraction(context, user, options = {}) {
  const expectedExecutionMode = options.expectedExecutionMode || 'recorded_fixture';
  const utterance = options.utterance || '最近睡不好、对虾过敏';
  const scenarioId = options.scenarioId || (expectedExecutionMode === 'live' ? 'q21-2-live-main-path' : 'q21-2-recorded-fixture');
  const businessEvidence = {
    scenarioId, expectedExecutionMode, utterance: utterance.slice(0, 1200), driver: context.driver,
    tokenAccounting: 'API token fields use provider usage when returned and otherwise a server character-based estimate; per-field provenance is not exposed. estimatedCostUsd is a server rate-table estimate, not an invoice.'
  };
  try {
    const before = await profileFingerprint(context, user.id);
    const pendingBefore = await intakeCounts(context, user.id);
    businessEvidence.profileBefore = before;
    businessEvidence.intakeCountsBefore = pendingBefore;

    const extractionResponse = await request(context.baseUrl, '/me/health-intake-extractions', { method: 'POST', token: user.token,
      body: { utterance } });
    businessEvidence.extractionHttpStatus = extractionResponse.status;
    const extraction = assertStatus(extractionResponse, 201, 'health utterance extraction');
    businessEvidence.extraction = {
      id: extraction.id, sessionId: extraction.sessionId, executionMode: extraction.executionMode,
      model: String(extraction.model || '').slice(0, 128),
      tokens: { input: Number(extraction.inputTokens || 0), output: Number(extraction.outputTokens || 0),
        estimatedCostUsd: Number(extraction.estimatedCostUsd || 0) },
      sourceUtterance: String(extraction.source?.utterance || '').slice(0, 1200),
      candidates: (Array.isArray(extraction.candidates) ? extraction.candidates : []).slice(0, 8).map(candidate => ({
        candidateId: String(candidate.candidateId || '').slice(0, 96), field: String(candidate.field || '').slice(0, 64),
        status: String(candidate.status || '').slice(0, 48), value: String(candidate.value || '').slice(0, 500),
        evidenceText: String(candidate.evidenceText || '').slice(0, 500),
        source: { type: String(candidate.source?.type || '').slice(0, 48), id: String(candidate.source?.id || '').slice(0, 96),
          sessionId: String(candidate.source?.sessionId || '').slice(0, 96), excerpt: String(candidate.source?.excerpt || '').slice(0, 500) }
      }))
    };
    assert.equal(extraction.source.utterance, utterance);
    assert.ok(extraction.sessionId);
    assert.equal(extraction.executionMode, expectedExecutionMode);
    if (expectedExecutionMode === 'live') assert.ok(extraction.model, 'live extraction identifies the selected model');
    else assert.equal(extraction.model, 'recorded-stage21', 'fixture execution identifies the recorded model');
    assert.ok(extraction.inputTokens > 0 && extraction.outputTokens > 0);
    assert.ok(extraction.inputTokens + extraction.outputTokens <= 8_192, 'extraction usage stays within its token budget');
    assert.equal(extraction.candidates.length, 2);
    for (const candidate of extraction.candidates) {
      assert.ok(utterance.includes(candidate.evidenceText), 'candidate evidence is an exact substring of the source utterance');
      assert.equal(candidate.source.sessionId, extraction.sessionId);
      assert.equal(candidate.source.type, 'guest_utterance');
      assert.equal(candidate.source.id, extraction.id);
      assert.equal(candidate.source.excerpt, candidate.evidenceText);
      assert.ok(candidate.value && candidate.evidenceText.includes(candidate.value));
      assert.ok(candidate.candidateId);
    }
    const sleep = extraction.candidates.find(item => item.field === 'sleep');
    const allergy = extraction.candidates.find(item => item.field === 'allergies');
    assert.ok(sleep && allergy);
    assert.equal(sleep.status, 'reported');
    assert.equal(allergy.status, 'reported');
    assert.ok(allergy.evidenceText.includes('虾') && allergy.evidenceText.includes('过敏'),
      'allergy source text retains the shrimp-allergy fact');
    if (options.expectedAllergyValue !== undefined) assert.equal(allergy.value, options.expectedAllergyValue);
    const decisions = [{ candidateId: allergy.candidateId, decision: 'confirm' }, { candidateId: sleep.candidateId, decision: 'reject' }]
      .sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    businessEvidence.decisions = decisions.map(item => ({ ...item }));

    const firstResponse = await request(context.baseUrl, `/me/health-intake-extractions/${encodeURIComponent(extraction.id)}/confirm`, {
      method: 'POST', token: user.token, body: { decisions }
    });
    businessEvidence.firstConfirmation = { httpStatus: firstResponse.status,
      intakeId: firstResponse.data?.intake?.id ?? null, intakeStatus: firstResponse.data?.intake?.status ?? null,
      deduplicated: firstResponse.data?.deduplicated ?? null };
    const first = assertStatus(firstResponse, 201, 'confirm one candidate and reject one');

    const repeatedResponse = await request(context.baseUrl, `/me/health-intake-extractions/${encodeURIComponent(extraction.id)}/confirm`, {
      method: 'POST', token: user.token, body: { decisions }
    });
    businessEvidence.repeatedConfirmation = { httpStatus: repeatedResponse.status,
      intakeId: repeatedResponse.data?.intake?.id ?? null, intakeStatus: repeatedResponse.data?.intake?.status ?? null,
      deduplicated: repeatedResponse.data?.deduplicated ?? null };
    const repeated = assertStatus(repeatedResponse, 200, 'idempotent repeated confirmation');
    assert.equal(first.intake.id, repeated.intake.id);
    assert.equal(repeated.deduplicated, true);
    assert.equal(first.intake.status, 'pending');
    const candidateProfile = parseJson(first.intake.candidate);
    assert.deepEqual(candidateProfile.allergies, { status: 'reported', items: [allergy.value] });
    assert.deepEqual(candidateProfile.sleep, { status: 'unanswered', details: '' });
    assert.deepEqual(first.extraction.decisions, { [allergy.candidateId]: 'confirm', [sleep.candidateId]: 'reject' });
    const confirmed = first.extraction.candidates.find(item => item.candidateId === allergy.candidateId);
    const rejected = first.extraction.candidates.find(item => item.candidateId === sleep.candidateId);
    assert.equal(confirmed?.decision, 'confirm');
    assert.equal(confirmed?.reviewStatus, 'pending_verification');
    assert.equal(rejected?.decision, 'reject');
    assert.equal(rejected?.reviewStatus, 'rejected_by_guest');
    businessEvidence.confirmedCandidateId = allergy.candidateId;
    businessEvidence.rejectedCandidateId = sleep.candidateId;
    businessEvidence.confirmedIntake = { id: first.intake.id, status: first.intake.status,
      allergies: { status: candidateProfile.allergies.status, items: candidateProfile.allergies.items.slice(0, 8) },
      sleep: { status: candidateProfile.sleep.status, details: String(candidateProfile.sleep.details || '').slice(0, 160) } };
    businessEvidence.idempotency = { sameIntakeId: first.intake.id === repeated.intake.id,
      repeatedHttpStatus: repeatedResponse.status, deduplicated: repeated.deduplicated };

    const after = await profileFingerprint(context, user.id);
    const pendingAfter = await intakeCounts(context, user.id);
    businessEvidence.profileAfter = after;
    businessEvidence.intakeCountsAfter = pendingAfter;
    businessEvidence.intakeCountDelta = { total: pendingAfter.total - pendingBefore.total, pending: pendingAfter.pending - pendingBefore.pending };
    assert.deepEqual(after, before, 'guest profile JSON hash and version remain unchanged');
    assert.equal(businessEvidence.intakeCountDelta.total, 1, 'one confirmation creates only one intake');
    assert.equal(businessEvidence.intakeCountDelta.pending, 1, 'exactly one new intake remains pending verification');

    const messageRoleColumn = context.driver === 'mysql' ? 'sender_role' : 'role';
    const messages = await databaseQuery(context, `SELECT ${messageRoleColumn} AS role,content FROM assistant_messages WHERE session_id=? ORDER BY id`, [extraction.sessionId]);
    assert.ok(messages.some(item => item.role === 'user' && item.content === utterance));
    businessEvidence.sourceMessagePersisted = true;
    appendEvidence({ quest: 'Q21.2', scenario: scenarioId, driver: context.driver, status: 'PASS', businessEvidence });
    return { extractionId: extraction.id, intakeId: first.intake.id, sessionId: extraction.sessionId,
      executionMode: extraction.executionMode, model: extraction.model,
      tokens: { input: extraction.inputTokens, output: extraction.outputTokens,
        estimatedCostUsd: extraction.estimatedCostUsd, accounting: businessEvidence.tokenAccounting },
      candidateValues: { allergy: allergy.value, allergyEvidence: allergy.evidenceText, sleep: sleep.value },
      profileBefore: before, profileAfter: after, intakeCountDelta: businessEvidence.intakeCountDelta,
      idempotent: businessEvidence.idempotency };
  } catch (error) {
    appendEvidence({ quest: 'Q21.2', scenario: scenarioId, driver: context.driver,
      status: expectedExecutionMode === 'live' ? 'BLOCKED' : 'FAIL', errorCode: error.code || null,
      message: String(error.message || error).slice(0, 400), businessEvidence });
    throw error;
  }
}

async function runExtractionFixtureMatrix(context, user) {
  const scenarios = [
    { scenarioId: 'q21-2-fixture-allergy-value-shrimp', utterance: '最近睡不好、虾过敏', expectedAllergyValue: '虾' },
    { scenarioId: 'q21-2-fixture-allergy-value-phrase', utterance: '最近睡不好、对虾过敏', expectedAllergyValue: '对虾过敏' }
  ];
  const results = [];
  for (const scenario of scenarios) {
    results.push(await runExtraction(context, user, { ...scenario, expectedExecutionMode: 'recorded_fixture' }));
  }
  return { executionMode: 'recorded_fixture', scenarios: results };
}

async function runMobility(context, user) {
  const unclear = assertStatus(await request(context.baseUrl, '/me/health-intake-extractions', { method: 'POST', token: user.token,
    body: { utterance: '腿不太方便' } }), 201, 'vague mobility self-report');
  assert.equal(unclear.executionMode, 'deterministic_clarification');
  assert.equal(unclear.candidates.length, 0);
  assert.match(unclear.clarificationQuestion, /拐杖|助行器|搀扶/u);
  const followupText = '平时需要拐杖';
  const followup = assertStatus(await request(context.baseUrl, '/me/health-intake-extractions', { method: 'POST', token: user.token,
    body: { utterance: followupText, sessionId: unclear.sessionId } }), 201, 'mobility clarification answer');
  const mobility = followup.candidates.find(item => item.field === 'mobility');
  assert.ok(mobility);
  assert.equal(mobility.status, 'assistance');
  assert.ok(followupText.includes(mobility.evidenceText));
  const confirmed = assertStatus(await request(context.baseUrl, `/me/health-intake-extractions/${encodeURIComponent(followup.id)}/confirm`, {
    method: 'POST', token: user.token, body: { decisions: [{ candidateId: mobility.candidateId, decision: 'confirm' }] }
  }), 201, 'confirm concrete mobility fact');
  assert.equal(parseJson(confirmed.intake.candidate).mobility.status, 'assistance');
  const stay = await setStay(context, user.id, 3);
  const activityDate = dateOffset(today, 1);
  await insertSlot(context, { projectId: 'project-swimming-training', date: activityDate, start: '15:00', end: '16:00' });
  await seedEnvironment(context, activityDate, 'safe');
  const before = await counts(context, user.id);
  const draft = await postDraft(context, user, 'q213-mobility');
  const after = await counts(context, user.id);
  assert.deepEqual(after, before, 'mobility recommendation did not create a booking/menu/order or extra slot');
  const swimItem = draft.items.find(item => item.businessDate === activityDate && item.ruleIds.includes('R4'));
  assert.ok(swimItem, `the existing Stage15 R4 mobility contraindication is visible in the draft: ${JSON.stringify({
    items: draft.items.filter(item => item.businessDate === activityDate), planningCandidates: draft.evidence.planningCandidates,
    agents: draft.evidence.domainAgents.map(agent => ({ agentId: agent.agentId, candidateIds: agent.candidateIds, tools: agent.tools }))
  })}`);
  assert.equal(swimItem.type, 'gap');
  assert.equal(swimItem.status, 'excluded');
  assert.match(swimItem.reason, /R4|行动/u);
  return { clarificationId: unclear.id, followupId: followup.id, intakeId: confirmed.intake.id,
    stay, draftId: draft.draftId, excludedRule: 'R4' };
}

async function runVersions(context, user) {
  const stay = await setStay(context, user.id, 3);
  const activityDate = dateOffset(today, 1);
  await insertSlot(context, { projectId: 'project-beach-walk', date: activityDate, start: '07:30', end: '08:30' });
  await seedEnvironment(context, activityDate, 'safe');
  const first = await postDraft(context, user, 'q214-version-1');
  const second = await postDraft(context, user, 'q214-version-2');
  assert.equal(first.status, 'pending_review'); assert.equal(first.active, false);
  assert.equal(second.status, 'pending_review'); assert.equal(second.active, false);
  assert.notEqual(first.draftId, second.draftId);
  assert.equal(first.version + 1, second.version);
  assert.notEqual(first.createdAt, second.createdAt);
  assert.notEqual(first.sourceRunId, second.sourceRunId);
  assert.ok(first.items.length && second.items.length);
  assert.ok(first.evidence.coordinator.validation.schemaValid && first.evidence.coordinator.validation.allowlistValid);
  assert.ok(first.evidence.domainAgents.every(agent => agent.tools.length === 2 && agent.sources.length));
  const old = assertStatus(await request(context.baseUrl, `/me/therapy-drafts/${encodeURIComponent(first.draftId)}`, { token: user.token }), 200, 'read prior draft version');
  assert.equal(old.draftId, first.draftId);
  assert.equal(old.sourceRunId, first.sourceRunId);
  const repeated = await request(context.baseUrl, '/me/therapy-drafts', { method: 'POST', token: user.token,
    headers: { 'Idempotency-Key': 'q21:q214-version-2' }, body: {} });
  assert.equal(repeated.status, 200, 'repeating a request key returns the prior version');
  assert.equal(repeated.data.draftId, second.draftId);
  const rows = await databaseQuery(context, 'SELECT id,version,created_at,source_run_id,status FROM wellness_drafts WHERE guest_id=? ORDER BY version', [user.id]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => Number(row.version)), [1, 2]);
  assert.ok(rows.every(row => row.source_run_id));
  return { stay, versions: rows.map(row => ({ id: row.id, version: Number(row.version), createdAt: row.created_at,
    sourceRunId: row.source_run_id, status: row.status })) };
}

const q215DailySlotKeys = ['breakfast', 'morning', 'lunch', 'afternoon', 'dinner', 'evening'];
const q215MealSlotKeys = new Set(['breakfast', 'lunch', 'dinner']);
const q215ExpectedTools = {
  'domain.nutrition': ['get_nutrition_context', 'get_nutrition_knowledge'],
  'domain.exercise': ['get_exercise_context', 'get_exercise_knowledge']
};

function safeSourceRefs(sources) {
  return (Array.isArray(sources) ? sources : []).slice(0, 32).map(source => ({
    type: String(source?.type || '').slice(0, 48), id: String(source?.id ?? '').slice(0, 120)
  }));
}

function assertSourceRefs(sources, label) {
  assert.ok(Array.isArray(sources) && sources.length > 0, `${label}: source references exist`);
  assert.ok(sources.every(source => typeof source?.type === 'string' && source.type
    && source.id !== undefined && source.id !== null && String(source.id).length > 0), `${label}: every source has a type and ID`);
  return true;
}

function compactQ215Evidence({ draft, readback, parentRun, collaboration, dates, countsBefore, countsAfter }) {
  const modelSteps = [...collaboration.parent.modelSteps, ...collaboration.agents.flatMap(agent => agent.modelSteps)];
  return {
    draft: { id: draft.draftId, status: draft.status, active: draft.active, version: draft.version,
      sourceRunId: draft.sourceRunId, executionMode: draft.evidence.executionMode, model: draft.evidence.model },
    parentRun: { runId: parentRun.runId, parentRunId: parentRun.parentRunId, status: parentRun.status,
      executionMode: parentRun.executionMode, model: parentRun.model, sources: safeSourceRefs(parentRun.sources) },
    coordinator: { status: collaboration.coordinatorStatus, selectionSource: collaboration.selectionSource,
      fallbackSource: collaboration.fallbackSource, validation: collaboration.selectionValidation,
      modelSteps: collaboration.parent.modelSteps.map(step => ({ status: step.status, inputTokens: step.inputTokens,
        outputTokens: step.outputTokens, estimatedCostUsd: step.estimatedCostUsd })),
      adoptedCandidateIds: collaboration.finalAdoptedCandidateIds.slice(0, 80),
      adoptedCandidates: collaboration.candidates.filter(item => item.status === 'adopted').slice(0, 80)
        .map(item => ({ candidateId: item.candidateId, domain: item.domain, sourceIds: safeSourceRefs(item.sourceIds) })),
      rejectedCandidates: collaboration.candidates.filter(item => item.status === 'rejected').slice(0, 80)
        .map(item => ({ candidateId: item.candidateId, domain: item.domain, sourceIds: safeSourceRefs(item.sourceIds) })) },
    children: collaboration.agents.map(agent => ({ agentId: agent.agentId, runId: agent.runId,
      status: agent.status, executionMode: agent.executionMode, model: agent.model,
      modelSteps: agent.modelSteps.map(step => ({ status: step.status, inputTokens: step.inputTokens,
        outputTokens: step.outputTokens, estimatedCostUsd: step.estimatedCostUsd })),
      tools: agent.tools.map(tool => ({ toolName: tool.toolName, status: tool.status, durationMs: tool.durationMs })),
      sources: safeSourceRefs(agent.sources) })),
    graphBudget: collaboration.graphBudget,
    budgetDecisions: collaboration.budgetDecisions.map(item => ({ phase: item.phase, outcome: item.outcome,
      reservationId: String(item.reservationId || '').slice(0, 96) })),
    tokenAccounting: 'provider-reported usage when available; server estimates when omitted. estimatedCostUsd is a server budget estimate, not an invoice.',
    stay: { start: readback.stayStart, endExclusive: readback.stayEnd },
    dates, itemCount: readback.items.length,
    items: readback.items.slice(0, 42).map(item => ({ id: item.id, businessDate: item.businessDate,
      slotKey: item.slotKey, type: item.type, status: item.status, candidateId: item.candidateId || null,
      sourceIds: safeSourceRefs(item.sourceIds), gapReason: item.type === 'gap' ? String(item.reason || '').slice(0, 200) : null })),
    domainDates: draft.evidence.domainDates,
    countsBefore, countsAfter
  };
}

async function validateMultiDayMainPath(context, user, { stay, draft, expectedExecutionMode, countsBefore, progress = {} }) {
  const trace = progress;
  trace.executionModeExpected = expectedExecutionMode;
  trace.stay = { start: stay.start, endExclusive: stay.end };
  trace.draft = { id: draft.draftId, status: draft.status, active: draft.active,
    sourceRunId: draft.sourceRunId, executionMode: draft.evidence?.executionMode, model: draft.evidence?.model };
  trace.domainDates = draft.evidence?.domainDates || null;
  trace.graphBudget = draft.evidence?.graphBudget || null;
  trace.domainAgents = (Array.isArray(draft.evidence?.domainAgents) ? draft.evidence.domainAgents : []).slice(0, 8).map(agent => ({
    agentId: agent.agentId, runId: agent.runId, status: agent.status, executionMode: agent.executionMode,
    model: agent.model, modelSteps: (agent.modelSteps || []).slice(0, 4).map(step => ({ status: step.status,
      inputTokens: step.inputTokens, outputTokens: step.outputTokens, estimatedCostUsd: step.estimatedCostUsd })),
    tools: (agent.tools || []).slice(0, 12).map(tool => ({ toolName: tool.toolName, status: tool.status })),
    sources: safeSourceRefs(agent.sources)
  }));
  try {
    assert.equal(draft.status, 'pending_review');
    assert.equal(draft.active, false);
    assert.ok(draft.sourceRunId);
    assert.equal(draft.evidence.parentRunId, draft.sourceRunId);
    assert.equal(draft.evidence.executionMode, expectedExecutionMode);
    assert.ok(draft.evidence.model);
    assert.equal(draft.evidence.domainAgents.length, 2);
    assert.ok(draft.evidence.domainAgents.every(agent => agent.executionMode === expectedExecutionMode && agent.status === 'completed'
      && agent.modelSteps.length === 2 && agent.modelSteps.every(step => step.status === 'completed')));

    const readback = assertStatus(await request(context.baseUrl,
      `/me/therapy-drafts/${encodeURIComponent(draft.draftId)}`, { token: user.token }), 200, 'Q21.5 draft persisted readback');
    trace.draftReadback = { draftId: readback.draftId, sourceRunId: readback.sourceRunId,
      status: readback.status, active: readback.active, itemCount: readback.items?.length || 0 };
    trace.items = (Array.isArray(readback.items) ? readback.items : []).slice(0, 42).map(item => ({
      id: item.id, businessDate: item.businessDate, slotKey: item.slotKey, type: item.type,
      status: item.status, candidateId: item.candidateId || null, sourceIds: safeSourceRefs(item.sourceIds),
      gapReason: item.type === 'gap' ? String(item.reason || '').slice(0, 200) : null
    }));
    assert.equal(readback.draftId, draft.draftId);
    assert.equal(readback.sourceRunId, draft.sourceRunId);
    assert.equal(readback.stayStart, stay.start);
    assert.equal(readback.stayEnd, stay.end);
    const expectedDates = Array.from({ length: 7 }, (_, index) => dateOffset(stay.start, index));
    const actualDates = [...new Set(readback.items.map(item => item.businessDate))].sort();
    assert.equal(actualDates.length, 7, 'multi-day draft is capped at seven dates');
    assert.deepEqual(actualDates, expectedDates, 'draft contains exactly the first seven stay dates');
    assert.equal(readback.items.length, 42, 'seven dates each contain six daily slots');
    for (const date of expectedDates) {
      const dayItems = readback.items.filter(item => item.businessDate === date);
      assert.equal(dayItems.length, 6, `${date}: exactly six meal/activity slots`);
      assert.equal(new Set(dayItems.map(item => item.slotKey)).size, 6, `${date}: no duplicate slot keys`);
      assert.deepEqual(dayItems.map(item => item.slotKey).sort(), [...q215DailySlotKeys].sort(), `${date}: all required daily slots`);
    }
    assert.equal(readback.items.some(item => item.businessDate >= stay.end), false, 'checkout is exclusive');
    assert.deepEqual(readback.items.map(item => item.id).sort(), draft.items.map(item => item.id).sort(),
      'persisted readback retains all generated draft item IDs');
    const sourceMealDate = draft.evidence.domainDates?.['domain.nutrition'];
    assert.match(String(sourceMealDate || ''), /^\d{4}-\d{2}-\d{2}$/, 'nutrition domain source date is explicit');
    const nonSourceMeals = readback.items.filter(item => q215MealSlotKeys.has(item.slotKey) && item.businessDate !== sourceMealDate);
    assert.equal(nonSourceMeals.length, expectedDates.includes(sourceMealDate) ? 18 : 21,
      'meal candidates do not multiply beyond the nutrition source date');
    assert.ok(nonSourceMeals.every(item => item.type === 'gap' && item.status === 'gap'),
      'dates without source-date meal candidates remain explicit gaps');
    for (const item of readback.items.filter(entry => ['activity', 'gap', 'rest'].includes(entry.type))) {
      if (item.type === 'activity') {
        assert.ok(item.sourceIds.some(source => source.type === 'project_slot'),
          'a scheduled activity must come from a persisted actual project slot');
        assert.equal(item.evidence?.availabilitySource, 'activity_slots');
      }
      if (item.type === 'gap') assert.ok(String(item.reason || '').trim(), 'activity or meal gaps explain missing/unsafe data');
    }

    const parentRun = assertStatus(await request(context.baseUrl,
      `/assistant/runs/${encodeURIComponent(draft.sourceRunId)}?role=guest`, { token: user.token }), 200, 'Q21.5 source parent run persisted readback');
    const collaboration = parentRun.collaboration;
    trace.sourceRun = { runId: parentRun.runId, parentRunId: parentRun.parentRunId,
      status: parentRun.status, executionMode: parentRun.executionMode, model: parentRun.model,
      sources: safeSourceRefs(parentRun.sources) };
    if (collaboration) {
      trace.coordinator = { status: collaboration.coordinatorStatus, selectionSource: collaboration.selectionSource,
        fallbackSource: collaboration.fallbackSource, validation: collaboration.selectionValidation,
        evidence: collaboration.coordinatorEvidence || null,
        modelSteps: (collaboration.parent?.modelSteps || []).slice(0, 8).map(step => ({ status: step.status,
          inputTokens: step.inputTokens, outputTokens: step.outputTokens, estimatedCostUsd: step.estimatedCostUsd })) };
      trace.candidates = (collaboration.candidates || []).slice(0, 120).map(item => ({ candidateId: item.candidateId,
        domain: item.domain, status: item.status, sourceIds: safeSourceRefs(item.sourceIds) }));
      trace.children = (collaboration.agents || []).slice(0, 8).map(agent => ({ agentId: agent.agentId, runId: agent.runId,
        status: agent.status, executionMode: agent.executionMode, model: agent.model,
        modelSteps: (agent.modelSteps || []).slice(0, 4).map(step => ({ status: step.status,
          inputTokens: step.inputTokens, outputTokens: step.outputTokens, estimatedCostUsd: step.estimatedCostUsd })),
        tools: (agent.tools || []).slice(0, 12).map(tool => ({ toolName: tool.toolName, status: tool.status,
          durationMs: tool.durationMs, resultSummary: tool.resultSummary || null })),
        sources: safeSourceRefs(agent.sources) }));
      trace.graphBudget = collaboration.graphBudget || null;
      trace.budgetDecisions = (collaboration.budgetDecisions || []).slice(0, 24).map(compactBudgetDecision);
    }
    assert.equal(parentRun.runId, draft.sourceRunId);
    assert.equal(parentRun.parentRunId, null, 'source run is the graph parent');
    assert.equal(parentRun.status, 'completed');
    assert.equal(parentRun.executionMode, expectedExecutionMode);
    assert.ok(parentRun.model && parentRun.reply.trim(), 'source parent run records its selected model and summary');
    assertSourceRefs(parentRun.sources, 'parent run');
    assert.equal(collaboration.parent.runId, parentRun.runId);
    assert.equal(collaboration.parent.executionMode, expectedExecutionMode);
    assert.equal(collaboration.coordinatorStatus, 'completed');
    assert.equal(collaboration.coordinatorError, null);
    assert.equal(collaboration.selectionSource, 'model');
    assert.equal(collaboration.fallbackSource, null, 'coordinator did not use a hidden fallback');
    assert.deepEqual(collaboration.selectionValidation, { schemaValid: true, allowlistValid: true,
      responseComplete: true, semanticValid: true });
    assert.equal(collaboration.coordinatorEvidence?.task, 'wellness_draft');
    assert.ok(collaboration.coordinatorEvidence.input.fieldNames.includes('adoptedCandidateIds'));
    assert.match(collaboration.coordinatorEvidence.input.sha256, /^[a-f0-9]{64}$/u);
    assert.match(collaboration.coordinatorEvidence.response.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(Object.hasOwn(collaboration.coordinatorEvidence.input, 'request'), false,
      'safe evidence does not persist the raw guest request');
    assert.equal(collaboration.parent.modelSteps.length, 1, 'coordinator completed one model round-trip');
    assert.ok(collaboration.parent.modelSteps.every(step => step.status === 'completed'));
    assert.ok(collaboration.parent.validationSteps.some(step => step.status === 'completed'
      && step.diagnostic?.schemaValid === true && step.diagnostic?.allowlistValid === true
      && step.diagnostic?.responseComplete === true && step.diagnostic?.selectionSource === 'model'));

    assert.equal(collaboration.agents.length, 2, 'source run contains exactly nutrition and exercise children');
    for (const [agentId, toolNames] of Object.entries(q215ExpectedTools)) {
      const child = collaboration.agents.find(agent => agent.agentId === agentId);
      const evidenceAgent = draft.evidence.domainAgents.find(agent => agent.agentId === agentId);
      assert.ok(child && evidenceAgent, `${agentId}: persisted child and draft evidence exist`);
      assert.ok(child.runId && child.runId !== parentRun.runId);
      assert.equal(child.status, 'completed');
      assert.equal(child.executionMode, expectedExecutionMode);
      assert.ok(child.model);
      assert.equal(child.modelSteps.length, 2, `${agentId}: two model round-trips`);
      assert.ok(child.modelSteps.every(step => step.status === 'completed'));
      assert.deepEqual(child.tools.map(tool => tool.toolName).sort(), [...toolNames].sort(), `${agentId}: required read-only tools`);
      assert.ok(child.tools.every(tool => tool.status === 'completed' && tool.toolName.startsWith('get_')));
      assert.ok(child.tools.every(tool => tool.durationMs <= 15_000), `${agentId}: each read-only tool stayed within 15 seconds`);
      assertSourceRefs(child.sources, `${agentId}: tool sources`);
      assert.equal(evidenceAgent.runId, child.runId, `${agentId}: draft evidence references the child run`);
      assert.equal(evidenceAgent.executionMode, expectedExecutionMode);
      assert.equal(evidenceAgent.modelSteps.length, 2);
      assertSourceRefs(evidenceAgent.sources, `${agentId}: draft evidence sources`);
      assert.deepEqual(safeSourceRefs(evidenceAgent.sources).map(source => `${source.type}:${source.id}`).sort(),
        safeSourceRefs(child.sources).map(source => `${source.type}:${source.id}`).sort(), `${agentId}: draft cites its persisted sources`);
    }

    const candidates = collaboration.candidates;
    const adopted = candidates.filter(candidate => candidate.status === 'adopted');
    const rejected = candidates.filter(candidate => candidate.status === 'rejected');
    assert.ok(adopted.length > 0, 'graph contains adopted candidates');
    assert.ok(rejected.length > 0, 'graph contains rejected candidates');
    assert.ok(adopted.every(candidate => assertSourceRefs(candidate.sourceIds, `${candidate.candidateId} adopted candidate`)),
      'every adopted candidate retains source IDs');
    assert.ok(rejected.every(candidate => assertSourceRefs(candidate.sourceIds, `${candidate.candidateId} rejected candidate`)),
      'every rejected candidate retains source IDs');
    assert.ok(collaboration.finalAdoptedCandidateIds.length > 0);
    assert.deepEqual(collaboration.selectedCandidateIds, collaboration.finalAdoptedCandidateIds);
    assert.ok(collaboration.finalAdoptedCandidateIds.every(candidateId =>
      adopted.some(candidate => candidate.candidateId === candidateId && candidate.sourceIds?.length > 0)),
    'coordinator selected only source-backed adopted candidates');

    const budget = collaboration.graphBudget;
    assert.deepEqual({ runtime: budget.maxRuntimeMs, models: budget.maxModelCalls, tools: budget.maxToolCalls,
      tokens: budget.maxTokens, cost: budget.maxEstimatedCostUsd },
    { runtime: 90_000, models: 5, tools: 12, tokens: 8_192, cost: 0.10 }, 'graph budget remains at the approved limits');
    assert.ok(budget.elapsedMs > 0 && budget.elapsedMs <= 90_000);
    assert.equal(budget.modelCalls, 5, 'coordinator plus two two-step domain runs use five model calls');
    assert.equal(budget.toolCalls, 4, 'both domain agents completed two read-only tool calls');
    assert.ok(budget.inputTokens + budget.outputTokens > 0 && budget.inputTokens + budget.outputTokens <= 8_192);
    assert.ok(budget.estimatedCostUsd >= 0 && budget.estimatedCostUsd <= 0.10);
    assert.equal(budget.reservedTokens, 0, 'all graph token reservations were released');
    assert.equal(budget.reservedCostUsd, 0, 'all graph cost reservations were released');
    const reservations = collaboration.budgetDecisions.filter(item => item.phase === 'reservation' && item.outcome === 'reserved');
    const settlements = collaboration.budgetDecisions.filter(item => item.phase === 'settlement');
    assert.equal(reservations.length, budget.modelCalls);
    assert.equal(settlements.length, budget.modelCalls);
    for (const reservation of reservations) {
      const settlement = settlements.find(item => item.reservationId === reservation.reservationId);
      assert.ok(settlement && settlement.outcome === 'released', 'each admitted model call reservation was released');
    }
    const modelSteps = [...collaboration.parent.modelSteps, ...collaboration.agents.flatMap(agent => agent.modelSteps)];
    assert.equal(modelSteps.length, budget.modelCalls, 'persisted model steps match the graph call count');
    assert.equal(modelSteps.reduce((sum, step) => sum + Number(step.inputTokens || 0), 0), budget.inputTokens);
    assert.equal(modelSteps.reduce((sum, step) => sum + Number(step.outputTokens || 0), 0), budget.outputTokens);

    const countsAfter = await counts(context, user.id);
    assert.deepEqual(countsAfter, countsBefore, 'draft generation does not add bookings, menus, orders, or inventory');
    const evidence = compactQ215Evidence({ draft, readback, parentRun, collaboration,
      dates: actualDates, countsBefore, countsAfter });
    Object.assign(trace, evidence);
    appendEvidence({ quest: 'Q21.5', scenario: `main-path-${expectedExecutionMode}`, driver: context.driver,
      status: 'PASS', businessEvidence: evidence });
    return { draftId: draft.draftId, sourceRunId: draft.sourceRunId, executionMode: expectedExecutionMode,
      parentRunId: parentRun.runId, childRuns: collaboration.agents.map(agent => ({ agentId: agent.agentId,
        runId: agent.runId, modelSteps: agent.modelSteps.length, tools: agent.tools.map(tool => tool.toolName), sources: agent.sources.length })),
      coordinator: { status: collaboration.coordinatorStatus, selectionSource: collaboration.selectionSource,
        validation: collaboration.selectionValidation, adoptedCandidates: adopted.length, rejectedCandidates: rejected.length },
      graphBudget: budget, days: actualDates.length, items: readback.items.length, status: draft.status,
      tokenAccounting: evidence.tokenAccounting };
  } catch (error) {
    Object.assign(trace, { status: 'validation_failed', errorCode: error.code || null,
      message: String(error.message || error).slice(0, 400) });
    appendEvidence({ quest: 'Q21.5', scenario: `main-path-${expectedExecutionMode}`, driver: context.driver,
      status: expectedExecutionMode === 'live' ? 'BLOCKED' : 'FAIL', businessEvidence: trace });
    throw error;
  }
}

async function runMultiDay(context, user) {
  const activityDate = dateOffset(today, 1);
  const actualSlotId = await insertSlot(context, { projectId: 'project-beach-walk', date: activityDate, start: '07:30', end: '08:30' });
  await seedEnvironment(context, activityDate, 'safe');
  const threeNightStay = await setStay(context, user.id, 3);
  const three = await postDraft(context, user, 'q215-three-day');
  assert.equal(new Set(three.items.map(item => item.businessDate)).size, 3);
  assert.equal(three.items.length, 18);
  for (const day of [threeNightStay.start, dateOffset(threeNightStay.start, 1), dateOffset(threeNightStay.start, 2)]) {
    const dayItems = three.items.filter(item => item.businessDate === day);
    assert.equal(dayItems.length, 6);
    assert.equal(dayItems.filter(item => ['breakfast','lunch','dinner'].includes(item.slotKey)).length, 3);
    assert.equal(dayItems.filter(item => ['morning','afternoon','evening'].includes(item.slotKey)).length, 3);
  }
  assert.equal(three.items.some(item => item.businessDate === threeNightStay.end), false, 'checkout day is exclusive');
  const tenNightStay = await setStay(context, user.id, 10);
  const countsBeforeTen = await counts(context, user.id);
  const ten = await postDraft(context, user, 'q215-seven-day-cap');
  assert.equal(new Set(ten.items.map(item => item.businessDate)).size, 7);
  assert.equal(ten.items.length, 42);
  assert.equal(ten.items.some(item => item.businessDate >= dateOffset(tenNightStay.start, 7)), false, 'ten-night stay is capped before day eight');
  assert.equal(ten.items.some(item => item.businessDate === tenNightStay.end), false, 'checkout day is exclusive for long stay');
  const actualActivity = ten.items.find(item => item.type === 'activity');
  assert.ok(actualActivity, `expected the existing registered activity slot to appear: ${JSON.stringify({
    dayItems: ten.items.filter(item => item.businessDate === activityDate), planningCandidates: ten.evidence.planningCandidates
  })}`);
  assert.equal(actualActivity.businessDate, activityDate);
  assert.ok(actualActivity.sourceIds.some(source => source.type === 'project_slot'));
  assert.equal(actualActivity.evidence.availabilitySource, 'activity_slots');
  assert.ok(ten.items.some(item => item.type === 'gap' && item.reason.includes('已登记')),
    'dates with no existing activity inventory stay explicit gaps');
  const nonSourceDates = ten.items.filter(item => ['breakfast', 'lunch', 'dinner'].includes(item.slotKey)
    && item.businessDate !== ten.evidence.domainDates['domain.nutrition']);
  assert.ok(nonSourceDates.length === 18 && nonSourceDates.every(item => item.type === 'gap' && item.status === 'gap'),
    'nutrition candidates are not copied from the model source date to other dates');
  const mainPath = await validateMultiDayMainPath(context, user, { stay: tenNightStay, draft: ten,
    expectedExecutionMode: 'recorded_fixture', countsBefore: countsBeforeTen });
  await setHealth(context, user.id, { chronic: [], allergies: ['stage21:unmapped-allergen'], mobility: '可独立行走', healthProfile: {} });
  await databaseQuery(context, 'UPDATE activity_slots SET is_closed=1,updated_at=? WHERE business_date=?',
    [databaseTimestamp(context.driver, fixedInstant), activityDate], 'run');
  const countsBeforeEmpty = await counts(context, user.id);
  const emptyCandidateDraft = await postDraft(context, user, 'q215-empty-candidate-boundary');
  const countsAfterEmpty = await counts(context, user.id);
  assert.deepEqual(countsAfterEmpty, countsBeforeEmpty,
    'empty-candidate boundary does not create reservations, menus, orders or activity slots');
  const nutritionDate = emptyCandidateDraft.evidence.domainDates['domain.nutrition'];
  const nutritionAgent = emptyCandidateDraft.evidence.domainAgents.find(agent => agent.agentId === 'domain.nutrition');
  const nutritionContext = nutritionAgent?.tools?.find(tool => tool.toolName === 'get_nutrition_context')?.resultSummary;
  assert.ok(nutritionContext, 'empty-candidate scenario retains its read-only nutrition inventory summary');
  assert.equal(nutritionContext.candidateCount, 0);
  assert.ok(nutritionContext.excludedCandidateCount > 0);
  assert.equal(nutritionContext.excludedCandidateCount, nutritionContext.catalogMainDishCount,
    'the source inventory proves every catalog candidate is excluded');
  assert.ok(nutritionContext.sources.some(source => source.type === 'nutrition_candidate_inventory'
    && source.id === 'main-dish-catalog'));
  assert.equal(emptyCandidateDraft.evidence.emptyCandidateDomains?.nutrition?.inventoryStatus, 'all_candidates_excluded');
  const emptyMealGaps = emptyCandidateDraft.items.filter(item => item.businessDate === nutritionDate && q215MealSlotKeys.has(item.slotKey));
  assert.equal(emptyMealGaps.length, 3);
  assert.ok(emptyMealGaps.every(item => item.type === 'gap' && item.status === 'gap'
    && item.reason.includes('限制排除了全部候选')
    && item.sourceIds.some(source => source.type === 'nutrition_candidate_inventory' && source.id === 'main-dish-catalog')),
  'all meals remain explicit gaps tied to the read-only inventory and restrictions');
  const exerciseDate = emptyCandidateDraft.evidence.domainDates['domain.exercise'];
  const exerciseAgent = emptyCandidateDraft.evidence.domainAgents.find(agent => agent.agentId === 'domain.exercise');
  const exerciseContext = exerciseAgent?.tools?.find(tool => tool.toolName === 'get_exercise_context')?.resultSummary;
  assert.equal(exerciseContext.date, exerciseDate);
  assert.equal(exerciseContext.potentiallyAvailableActualSlotCount, 0,
    'the only registered slot was closed before the boundary run');
  assert.ok(exerciseContext.demoOpenWindowCount > 0, 'the source contains demo windows that must not become scheduled activities');
  const exerciseDateItems = emptyCandidateDraft.items.filter(item => item.businessDate === exerciseDate
    && ['morning', 'afternoon', 'evening'].includes(item.slotKey));
  assert.equal(exerciseDateItems.length, 3);
  assert.equal(exerciseDateItems.some(item => item.type === 'activity'), false,
    'demo open windows do not become activities when no actual slot is available');
  assert.ok(exerciseDateItems.every(item => ['gap', 'rest'].includes(item.type)
    && item.sourceIds.some(source => source.type === 'activity_slot_inventory' && source.id === exerciseDate)
    && item.evidence?.demoWindowsScheduled === false));

  await databaseQuery(context, 'DELETE FROM activity_slots WHERE id=?', [actualSlotId], 'run');
  assert.ok(!await databaseQuery(context, 'SELECT id FROM activity_slots WHERE id=?', [actualSlotId], 'get'),
    'the exact Q21 activity fixture is removed before zero-inventory replay');
  await setHealth(context, user.id, { chronic: [], allergies: [], mobility: '可独立行走', healthProfile: {} });
  const zeroInventoryCountsBefore = await counts(context, user.id);
  const zeroInventoryDraft = await postDraft(context, user, 'q215-zero-inventory-unselected-exercise', {
    request: 'Q21:ZERO_ACTIVITY_INVENTORY deterministic replay of source-proven empty activity inventory'
  });
  const zeroInventoryCountsAfter = await counts(context, user.id);
  assert.deepEqual(zeroInventoryCountsAfter, zeroInventoryCountsBefore,
    'zero-inventory replay does not create reservations, menus, orders or activity slots');
  const exerciseDateAgent = zeroInventoryDraft.evidence.domainAgents.find(agent => agent.agentId === 'domain.exercise');
  const zeroExerciseContext = exerciseDateAgent?.tools?.find(tool => tool.toolName === 'get_exercise_context')?.resultSummary;
  const zeroExerciseProof = zeroInventoryDraft.evidence.emptyCandidateDomains?.exercise;
  assert.ok(zeroExerciseContext && zeroExerciseProof, 'the zero-inventory source and accepted empty domain proof are persisted');
  assert.equal(zeroExerciseContext.date, zeroInventoryDraft.evidence.domainDates['domain.exercise']);
  assert.equal(zeroExerciseContext.projectCount, 4);
  assert.equal(zeroExerciseContext.actualActivitySlotCount, 0);
  assert.equal(zeroExerciseContext.potentiallyAvailableActualSlotCount, 0);
  assert.equal(zeroExerciseContext.demoOpenWindowCount, 5);
  assert.equal(zeroExerciseProof.inventoryStatus, 'verified_no_actual_slots');
  assert.equal(zeroExerciseProof.parentRunId, zeroInventoryDraft.sourceRunId);
  assert.equal(zeroExerciseProof.childRunId, exerciseDateAgent.runId);
  assert.equal(zeroExerciseProof.childCandidateCount, 3);
  assert.equal(zeroExerciseProof.coordinatorSelectedExerciseCandidateCount, 0);
  assert.ok(zeroInventoryDraft.evidence.coordinator.selectedCandidateIds.length > 0);
  assert.ok(zeroInventoryDraft.evidence.coordinator.selectedCandidateIds.every(candidateId => !candidateId.startsWith('project-')),
    'coordinator retains nutrition-only selections and does not adopt exercise candidates');
  const zeroSourceDate = zeroExerciseContext.date;
  const exerciseSlots = zeroInventoryDraft.items.filter(item => ['morning', 'afternoon', 'evening'].includes(item.slotKey));
  assert.equal(exerciseSlots.length, 21);
  assert.ok(exerciseSlots.every(item => item.type === 'gap' && item.status === 'gap'),
    'all unselected exercise time blocks remain explicit gaps');
  const sourceDateGaps = exerciseSlots.filter(item => item.businessDate === zeroSourceDate);
  assert.equal(sourceDateGaps.length, 3);
  assert.ok(sourceDateGaps.every(item => item.evidence.inventoryStatus === 'verified_empty'
    && item.evidence.inventoryProvesThisDate === true && item.evidence.actualActivitySlotCount === 0
    && item.evidence.demoOpenWindowCount === 5 && item.evidence.demoWindowsScheduled === false
    && item.evidence.parentRunId === zeroInventoryDraft.sourceRunId && item.evidence.childRunId === exerciseDateAgent.runId
    && item.sourceIds.some(source => source.type === 'activity_slot_inventory' && source.id === zeroSourceDate)));
  const nonSourceDateGaps = exerciseSlots.filter(item => item.businessDate !== zeroSourceDate);
  assert.equal(nonSourceDateGaps.length, 18);
  assert.ok(nonSourceDateGaps.every(item => item.evidence.inventoryStatus === 'not_queried_for_date'
    && item.evidence.inventoryProvesThisDate === false && !Object.hasOwn(item.evidence, 'actualActivitySlotCount')
    && !item.sourceIds.some(source => source.type === 'activity_slot_inventory')
    && item.evidence.parentRunId === zeroInventoryDraft.sourceRunId && item.evidence.childRunId === exerciseDateAgent.runId
    && item.evidence.demoWindowsScheduled === false),
  'source-date zero inventory is not borrowed to another day');
  return { threeNightStay, threeDraftId: three.draftId, threeDays: 3, tenNightStay,
    tenDraftId: ten.draftId, tenGeneratedDays: 7, nonSourceMealGaps: nonSourceDates.length, mainPath,
    emptyCandidateBoundary: { draftId: emptyCandidateDraft.draftId, nutritionDate,
      catalogMainDishCount: nutritionContext.catalogMainDishCount,
      excludedCandidateCount: nutritionContext.excludedCandidateCount,
      mealGapCount: emptyMealGaps.length, exerciseDate, actualActivitySlotCount: exerciseContext.actualActivitySlotCount,
      potentiallyAvailableActualSlotCount: exerciseContext.potentiallyAvailableActualSlotCount,
      demoOpenWindowCount: exerciseContext.demoOpenWindowCount,
      activityGapCount: exerciseDateItems.length, countsBefore: countsBeforeEmpty, countsAfter: countsAfterEmpty },
    zeroInventoryReplay: { draftId: zeroInventoryDraft.draftId, sourceRunId: zeroInventoryDraft.sourceRunId,
      exerciseSourceDate: zeroSourceDate, childRunId: exerciseDateAgent.runId, exerciseChildCandidateCount: 3,
      coordinatorSelectedCandidateIds: zeroInventoryDraft.evidence.coordinator.selectedCandidateIds,
      projectCount: zeroExerciseContext.projectCount, actualActivitySlotCount: zeroExerciseContext.actualActivitySlotCount,
      demoOpenWindowCount: zeroExerciseContext.demoOpenWindowCount, sourceDateGapCount: sourceDateGaps.length,
      nonSourceDateGapCount: nonSourceDateGaps.length, countsBefore: zeroInventoryCountsBefore,
      countsAfter: zeroInventoryCountsAfter } };
}

async function runLunchConflict(context, user) {
  await setHealth(context, user.id, { chronic: [], allergies: [], healthProfile: {} });
  await setStay(context, user.id, 3);
  const activityDate = dateOffset(today, 1);
  await insertSlot(context, { projectId: 'project-swimming-training', date: activityDate, start: '12:30', end: '13:00' });
  await seedEnvironment(context, activityDate, 'safe');
  const before = await counts(context, user.id);
  const draft = await postDraft(context, user, 'q216-after-lunch-swim');
  const after = await counts(context, user.id);
  assert.deepEqual(after, before, 'conflict checking does not create slots or bookings');
  const conflict = draft.items.find(item => item.businessDate === activityDate && item.slotKey === 'afternoon');
  assert.ok(conflict);
  assert.equal(conflict.type, 'gap');
  assert.equal(conflict.status, 'excluded');
  assert.ok(conflict.ruleIds.includes('Q21-MEAL-REST-30M'));
  assert.match(conflict.reason, /12:30|30 分钟|30分钟/u);
  assert.equal(draft.items.some(item => item.type === 'activity' && item.localStart === '12:30'), false);
  return { draftId: draft.draftId, activityDate, ruleId: 'Q21-MEAL-REST-30M', gap: conflict.id };
}

async function runEnvironment(context, user) {
  await setHealth(context, user.id, { chronic: [], allergies: [], healthProfile: {} });
  await setStay(context, user.id, 3);
  const activityDate = dateOffset(today, 1);
  await insertSlot(context, { projectId: 'project-swimming-training', date: activityDate, start: '15:00', end: '16:00' });
  const before = await counts(context, user.id);
  await seedEnvironment(context, activityDate, 'safe');
  const safe = await postDraft(context, user, 'q217-safe');
  const safeItem = safe.items.find(item => item.candidateId === 'project-swimming-training' && item.businessDate === activityDate && item.type === 'activity');
  assert.ok(safeItem, `safe Stage15 availability remains sourced from the actual selected candidate: ${JSON.stringify({
    items: safe.items.filter(item => item.businessDate === activityDate).map(item => ({ slotKey: item.slotKey, type: item.type,
      candidateId: item.candidateId, status: item.status, ruleIds: item.ruleIds, reason: item.reason, evidence: item.evidence })),
    candidates: safe.evidence.planningCandidates
  })}`);
  assert.equal(safeItem.evidence.availabilityStatus, 'available');
  assert.equal(safeItem.evidence.availabilitySource, 'activity_slots');
  assert.ok(safeItem.environmentSnapshotId);
  assert.ok(safeItem.sourceIds.some(source => source.type === 'environment_snapshot' && source.id === safeItem.environmentSnapshotId));
  await seedEnvironment(context, activityDate, 'unsafe');
  const unsafe = await postDraft(context, user, 'q217-unsafe');
  const unsafeItem = unsafe.items.find(item => item.businessDate === activityDate && item.ruleIds.includes('R5'));
  assert.ok(unsafeItem, 'unsafe sea conditions have a traceable R5 exclusion');
  assert.equal(unsafeItem.type, 'gap');
  assert.equal(unsafeItem.status, 'excluded');
  await seedEnvironment(context, activityDate, 'unknown');
  const unknown = await postDraft(context, user, 'q217-unknown');
  const pending = unknown.items.find(item => item.candidateId === 'project-swimming-training' && item.businessDate === activityDate);
  assert.ok(pending);
  assert.equal(pending.status, 'pending_confirmation');
  assert.equal(pending.evidence.availabilityStatus, 'pending');
  assert.ok(pending.ruleIds.includes('R5'));
  assert.ok(pending.environmentSnapshotId);
  assert.deepEqual(await counts(context, user.id), before, 'environment evaluation did not change reservation/menu/order/slot counts');
  return { activityDate, safe: { draftId: safe.draftId, availability: safeItem.evidence.availabilityStatus,
      environmentSnapshotId: safeItem.environmentSnapshotId, sourceIds: safeItem.sourceIds },
    unsafe: { draftId: unsafe.draftId, type: unsafeItem.type, status: unsafeItem.status, ruleIds: unsafeItem.ruleIds },
    unknown: { draftId: unknown.draftId, status: pending.status, ruleIds: pending.ruleIds,
      environmentSnapshotId: pending.environmentSnapshotId } };
}

async function runReviewPolicy(context, user) {
  await setStay(context, user.id, 3);
  const activityDate = dateOffset(today, 1);
  await insertSlot(context, { projectId: 'project-beach-walk', date: activityDate, start: '07:30', end: '08:30' });
  await seedEnvironment(context, activityDate, 'safe');
  const constrained = await postDraft(context, user, 'q218-hard-review');
  assert.equal(constrained.reviewPolicy.mode, 'sampled_review');
  const hardItems = constrained.items.filter(item => item.type === 'meal' || item.type === 'activity');
  assert.ok(hardItems.length);
  assert.ok(hardItems.every(item => item.status === 'mandatory_review'), 'hard chronic/allergy constraints cannot be sampled around');
  assert.equal(hardItems.some(item => item.status === 'sampled_review'), false);

  await setHealth(context, user.id, { chronic: [], allergies: [], mobility: '可独立行走',
    healthProfile: completeLowRiskHealthProfile() });
  const sampled1 = await postDraft(context, user, 'q218-sampled-1');
  const sampled2 = await postDraft(context, user, 'q218-sampled-2');
  assert.equal(sampled1.reviewPolicy.mode, 'sampled_review');
  assert.equal(sampled1.reviewPolicy.samplePercent, 100);
  const sampleMap = draft => draft.items.filter(item => item.candidateId).map(item => `${item.businessDate}:${item.slotKey}:${item.candidateId}:${item.status}`).sort();
  assert.deepEqual(sampleMap(sampled1), sampleMap(sampled2), 'the configured review sample is stable for the same guest/date/candidate');
  assert.ok(sampled1.items.some(item => item.status === 'sampled_review'));
  return { hardDraftId: constrained.draftId, hardStatuses: [...new Set(hardItems.map(item => item.status))],
    sampledDrafts: [sampled1.draftId, sampled2.draftId], samplePercent: 100,
    deterministic: JSON.stringify(sampleMap(sampled1)) === JSON.stringify(sampleMap(sampled2)) };
}

async function runDraftApi(context, user) {
  await setHealth(context, user.id, { chronic: [], allergies: [], mobility: '可独立行走', healthProfile: {} });
  const stay = await setStay(context, user.id, 3);
  const activityDate = dateOffset(today, 1);
  await insertSlot(context, { projectId: 'project-beach-walk', date: activityDate, start: '07:30', end: '08:30' });
  await seedEnvironment(context, activityDate, 'safe');
  const created = await postDraft(context, user, 'q219-ui-card-data');
  const list = assertStatus(await request(context.baseUrl,
    `/me/therapy-drafts?stayStart=${stay.start}&stayEnd=${stay.end}`, { token: user.token }), 200, 'read therapy draft cards');
  assert.ok(list.items.some(item => item.draftId === created.draftId));
  const readback = assertStatus(await request(context.baseUrl, `/me/therapy-drafts/${encodeURIComponent(created.draftId)}`, { token: user.token }), 200, 'read draft item details');
  assert.equal(readback.status, 'pending_review');
  assert.equal(readback.active, false);
  assert.ok(readback.items.every(item => item.businessDate < stay.end));
  assert.ok(readback.items.every(item => typeof item.reason === 'string' && Array.isArray(item.sourceIds)));
  return { stay, draftId: created.draftId, version: created.version,
    sourceRunId: created.sourceRunId, itemDates: [...new Set(readback.items.map(item => item.businessDate))],
    itemCount: readback.items.length, statuses: [...new Set(readback.items.map(item => item.status))] };
}

async function runTimeline(context, user) {
  await setHealth(context, user.id, { chronic: [], allergies: [], mobility: '可独立行走', healthProfile: {} });
  const stay = await setStay(context, user.id, 3);
  const activityDate = dateOffset(today, 1);
  await seedEnvironment(context, activityDate, 'safe');
  const confirmedSlotId = await insertSlot(context, { projectId: 'project-beach-walk', date: activityDate, start: '07:30', end: '08:30' });
  const cancelledSlotId = await insertSlot(context, { projectId: 'project-beach-walk', date: activityDate, start: '16:30', end: '17:30' });
  const confirmedResult = await request(context.baseUrl, '/reservations', { method: 'POST', token: user.token,
    headers: { 'Idempotency-Key': 'q21:timeline:confirmed' }, body: { slotId: confirmedSlotId } });
  const confirmed = assertStatus(confirmedResult, 201, 'create isolated confirmed timeline booking');
  const cancelledResult = await request(context.baseUrl, '/reservations', { method: 'POST', token: user.token,
    headers: { 'Idempotency-Key': 'q21:timeline:cancelled' }, body: { slotId: cancelledSlotId } });
  const cancelled = assertStatus(cancelledResult, 201, 'create isolated booking to cancel');
  assertStatus(await request(context.baseUrl, `/reservations/${encodeURIComponent(cancelled.reservation.id)}`, {
    method: 'DELETE', token: user.token, body: { reason: 'Q21 timeline fixture' }
  }), 200, 'cancel isolated timeline booking');
  const beforeDraft = await counts(context, user.id);
  const draft = await postDraft(context, user, 'q2110-timeline-projection');
  const afterDraft = await counts(context, user.id);
  assert.deepEqual(afterDraft, beforeDraft, 'draft generation does not alter booking, menu, order or slot inventory');
  const timeline = assertStatus(await request(context.baseUrl, '/me/timeline', { token: user.token }), 200, 'read separated timeline');
  assert.ok(timeline.upcomingBookings.some(item => item.id === confirmed.reservation.id && item.type === 'confirmed_reservation'));
  assert.ok(timeline.cancelledHistory.some(item => item.id === cancelled.reservation.id && item.type === 'cancelled_reservation'));
  assert.equal(timeline.upcomingBookings.some(item => item.id === cancelled.reservation.id), false);
  assert.ok(timeline.proposedDrafts.some(item => item.draftId === draft.draftId && item.active === false));
  assert.equal(timeline.upcomingBookings.some(item => item.id === draft.draftId), false);
  assert.equal(timeline.cancelledHistory.some(item => item.id === draft.draftId), false);
  assert.equal(draft.active, false);
  return { stay, confirmedBookingId: confirmed.reservation.id, cancelledBookingId: cancelled.reservation.id,
    draftId: draft.draftId, countsBeforeDraft: beforeDraft, countsAfterDraft: afterDraft };
}

function evidenceError(error) {
  return { name: String(error?.name || 'Error').slice(0, 96), code: error?.code == null ? null : String(error.code).slice(0, 96),
    message: String(error?.message || error).slice(0, 600) };
}

async function resourceSnapshot(resourceSession) {
  if (!resourceSession || typeof resourceSession.status !== 'function') {
    throw new Error('Stage21 resource snapshot requires the active managed ResourceSession');
  }
  const state = await resourceSession.status();
  if (!state || !Array.isArray(state.resources)) throw new Error('Stage21 ResourceSession status did not return a resources array');
  return state.resources.map(item => ({ id: item.id, label: item.label, kind: item.kind, role: item.role,
    status: item.status, pid: item.pid, pids: item.pids, processStartTime: item.processStartTime,
    processFingerprint: item.processFingerprint, command: item.command, cwd: item.cwd, tempDir: item.tempDir,
    port: item.port, logPath: item.logPath, logBytes: item.logBytes, maxLogBytes: item.maxLogBytes,
    directoryPeakBytes: item.directoryPeakBytes, maxDirectoryBytes: item.maxDirectoryBytes, leaseExpiresAt: item.leaseExpiresAt }));
}

export async function captureResourceSnapshot(resourceSession) {
  try {
    return { ok: true, resources: await resourceSnapshot(resourceSession) };
  } catch (error) {
    return { ok: false, error: evidenceError(error), errorObject: error };
  }
}

function appendFailureEvidence(entry) {
  try {
    appendEvidence(entry);
    return { written: true, error: null };
  } catch (error) {
    return { written: false, error: evidenceError(error) };
  }
}

async function captureLiveFailureEvidence(questId, resourceSession, error, liveBusinessProgress, attemptKind) {
  const snapshot = error?.resourceSnapshotFailure
    ? { ok: false, error: error.resourceSnapshotFailure }
    : await captureResourceSnapshot(resourceSession);
  const primaryError = evidenceError(error);
  const entry = { quest: questId, scenario: 'one-shot-live-provider', attemptKind, driver: 'sqlite', status: 'BLOCKED',
    errorCode: error?.code || null, message: primaryError.message, primaryError,
    businessProgress: liveBusinessProgress,
    resourcesAtFailure: snapshot.ok ? snapshot.resources : null,
    resourceSnapshotFailure: snapshot.ok ? null : snapshot.error };
  const appendResult = appendFailureEvidence(entry);
  if (!appendResult.written) {
    const recordingFailure = { event: 'STAGE21_FAILURE_EVIDENCE_APPEND_FAILED', quest: questId,
      primaryError, resourceSnapshotFailure: entry.resourceSnapshotFailure, evidenceAppendFailure: appendResult.error };
    if (error && typeof error === 'object') error.failureEvidenceAppendFailure = appendResult.error;
    console.error(JSON.stringify(recordingFailure));
  }
}

const fixtureRunners = {
  'Q21.1': async context => runQuestionnaire(context, await guest(context)),
  'Q21.2': async context => runExtractionFixtureMatrix(context, await guest(context)),
  'Q21.3': async context => runMobility(context, await guest(context)),
  'Q21.4': async context => runVersions(context, await guest(context)),
  'Q21.5': async context => runMultiDay(context, await guest(context)),
  'Q21.6': async context => runLunchConflict(context, await guest(context)),
  'Q21.7': async context => runEnvironment(context, await guest(context)),
  'Q21.8': async context => runReviewPolicy(context, await guest(context)),
  'Q21.9': async context => runDraftApi(context, await guest(context)),
  'Q21.10': async context => runTimeline(context, await guest(context))
};

async function runFixtureQuest(questId, resourceSession, { reviewPolicy = 'auto', samplePercent = 0 } = {}) {
  activeResourceSession = resourceSession;
  const needsModel = questId !== 'Q21.1';
  const provider = needsModel ? await startRecordedModel() : null;
  const env = needsModel ? fixtureEnvironment(provider, { WELLNESS_DRAFT_REVIEW_POLICY: reviewPolicy,
    WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: String(samplePercent) })
    : { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: fixedInstant, WELLNESS_DRAFT_REVIEW_POLICY: reviewPolicy,
      WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: String(samplePercent) };
  const output = [];
  try {
    await withBothDatabaseApis(async context => {
      const result = await fixtureRunners[questId](context);
      const activeResources = await resourceSnapshot(resourceSession);
      appendEvidence({ quest: questId, scenario: questId, driver: context.driver, status: 'PASS',
        details: result, resourcesAtScenarioEnd: activeResources });
      output.push(`${context.driver}: ${JSON.stringify(result)}`);
    }, { resourceSession, env });
  } finally {
    if (provider) {
      const stopped = await stopRecordedModel(provider);
      appendEvidence({ quest: questId, scenario: 'recorded-model-shutdown', status: 'EXITED',
        resourceId: provider.resource.id, pid: provider.resource.pid, processStartTime: provider.resource.processStartTime,
        exitStatus: stopped.status, exitCode: stopped.exitCode, signal: stopped.signal || null });
    }
  }
  return output;
}

async function runLiveQuest(questId, resourceSession, liveConfig, attemptKind) {
  if (!liveConfig || typeof liveConfig.LLM_BASE_URL !== 'string' || !liveConfig.LLM_BASE_URL) {
    const error = new Error('approved live-provider configuration is unavailable');
    error.stageBlocked = true;
    throw error;
  }
  const env = { ...liveConfig, BUSINESS_CLOCK_NOW: '', NODE_ENV: 'production', ENVIRONMENT_MODE: 'demo', ENVIRONMENT_LIVE: '0' };
  let liveBusinessProgress = null;
  try {
    let result;
    await withDatabaseApi('sqlite', async context => {
      const user = await guest(context);
      if (questId === 'Q21.2') {
        result = await runExtraction(context, user, { expectedExecutionMode: 'live', scenarioId: 'q21-2-live-main-path' });
      } else if (questId === 'Q21.5') {
        const stay = await setStay(context, user.id, 10, { start: tomorrowInShanghai() });
        const countsBefore = await counts(context, user.id);
        liveBusinessProgress = { stage: 'before_draft_request', attemptKind, stay,
          countsBefore, expectedExecutionMode: 'live' };
        let draft;
        try {
          draft = await postDraftWithApiEvidence(context, user, 'q215-live-main-path');
        } catch (error) {
          liveBusinessProgress.stage = 'draft_request_failed';
          liveBusinessProgress.apiFailure = error?.apiFailure || null;
          if (error?.apiFailure?.details?.sourceRunId) {
            liveBusinessProgress.sourceRunGraph = await fetchQ215SourceGraph(context, user, error.apiFailure);
          }
          throw error;
        }
        liveBusinessProgress.stage = 'draft_created';
        result = await validateMultiDayMainPath(context, user, { stay, draft, expectedExecutionMode: 'live',
          countsBefore, progress: liveBusinessProgress });
      }
      const snapshot = await captureResourceSnapshot(resourceSession);
      if (!snapshot.ok) {
        const error = snapshot.errorObject instanceof Error ? snapshot.errorObject : new Error(snapshot.error.message);
        error.stageBlocked = true;
        error.resourceSnapshotFailure = snapshot.error;
        throw error;
      }
      appendEvidence({ quest: questId, scenario: 'one-shot-live-provider', driver: 'sqlite', status: 'PASS', details: result,
        attemptKind, resourcesAtScenarioEnd: snapshot.resources });
    }, { resourceSession, env });
    return [`sqlite live: ${JSON.stringify(result)}`];
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    primaryError.stageBlocked = true;
    try {
      await captureLiveFailureEvidence(questId, resourceSession, primaryError, liveBusinessProgress, attemptKind);
    } catch (recordingError) {
      const recordingFailure = { event: 'STAGE21_FAILURE_DIAGNOSTIC_CAPTURE_FAILED', quest: questId,
        primaryError: evidenceError(primaryError), diagnosticCaptureFailure: evidenceError(recordingError) };
      primaryError.failureDiagnosticCaptureFailure = recordingFailure.diagnosticCaptureFailure;
      console.error(JSON.stringify(recordingFailure));
    }
    throw primaryError;
  }
}

export async function run({ questId, live = false, liveConfig = null, resourceSession }) {
  if (!resourceSession) throw new Error('Stage21 requires a managed ResourceSession');
  const runner = fixtureRunners[questId];
  if (!runner) throw new Error(`Unsupported Stage21 Quest: ${questId}`);
  const attemptKind = ['diagnostic', 'repair-validation'].includes(process.env.STAGE21_LIVE_ATTEMPT_KIND)
    ? process.env.STAGE21_LIVE_ATTEMPT_KIND : 'unspecified';
  // Q21.5 is the legacy pending/no-reservation regression. Stage21's schema
  // supports only auto or sampled_review; pin this fixture to 100% sampling
  // so it exercises an explicit manual-review policy after Stage22 adds the
  // stricter health completeness gate.
  const output = live ? await runLiveQuest(questId, resourceSession, liveConfig, attemptKind)
    : await runFixtureQuest(questId, resourceSession,
      ['Q21.5', 'Q21.8'].includes(questId) ? { reviewPolicy: 'sampled_review', samplePercent: 100 } : {});
  return { output };
}
