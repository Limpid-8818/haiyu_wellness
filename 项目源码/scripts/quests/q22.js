import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { withBothDatabaseApis, withDatabaseApi, databaseExec, databaseQuery, login } from './q10-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordedModel = path.join(projectRoot, 'scripts/resources/q22-recorded-model-server.js');
const evidencePath = path.join(projectRoot, 'output/resource-audit/stage22-execution-evidence-20261004.jsonl');
const fixedInstant = '2026-10-05T00:00:00.000Z';
const today = '2026-10-05';
let activeResourceSession;

function dateOffset(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function sqlTime(context, value) {
  return context.driver === 'mysql' ? value.replace('T', ' ').replace('Z', '') : value;
}

function appendEvidence(entry) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ recordedAt: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...entry });
  const bytes = Buffer.byteLength(line, 'utf8') + 1;
  const current = fs.existsSync(evidencePath) ? fs.statSync(evidencePath).size : 0;
  if (bytes > 48 * 1024 || current + bytes > 8 * 1024 * 1024) throw new Error('Stage22 execution evidence reached its configured limit');
  fs.appendFileSync(evidencePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function api(context, route, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${context.baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

function assertStatus(result, status, label) {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function readbackWellnessGraph(context, user, generated, expectedExecutionMode) {
  const graph = assertStatus(await api(context, `/assistant/runs/${generated.evidence.parentRunId}?role=guest`,
    { token: user.guest.token }), 200, 'Q22.9 persisted assistant graph readback');
  const collaboration = graph.collaboration;
  assert.ok(collaboration?.parent && collaboration.agents?.length >= 2, 'persisted graph has a real parent and child agents');
  assert.equal(graph.executionMode, expectedExecutionMode);
  assert.equal(collaboration.executionMode, expectedExecutionMode);
  const selection = collaboration.selectionValidation || {};
  assert.equal(selection.schemaValid, true, 'coordinator selection passed the response schema');
  assert.equal(selection.allowlistValid, true, 'coordinator selected only allowlisted candidates');
  assert.equal(selection.semanticValid, true, 'coordinator selection passed semantic validation');
  const budget = collaboration.graphBudget;
  assert.ok(budget, 'persisted graph includes actual budget counters');
  const tools = collaboration.agents.flatMap(agent => agent.tools || []);
  const modelSteps = [...(collaboration.parent.modelSteps || []),
    ...collaboration.agents.flatMap(agent => agent.modelSteps || [])];
  const tokenTotal = Number(budget.inputTokens || 0) + Number(budget.outputTokens || 0);
  assert.ok(Number(budget.modelCalls) <= 5, 'graph stays within the five-model-call budget');
  assert.ok(Number(budget.toolCalls) <= 12, 'graph stays within the twelve-tool-call budget');
  assert.ok(modelSteps.length <= 5, 'persisted model-step count stays within the five-call budget');
  assert.ok(tools.length <= 12, 'persisted tool count stays within the twelve-call budget');
  assert.ok(tokenTotal <= 8_192, 'graph stays within the 8,192-token budget');
  assert.ok(Number(budget.estimatedCostUsd || 0) <= 0.10, 'graph stays within the $0.10 estimated-cost budget');
  assert.ok(Number(collaboration.graphDurationMs || 0) <= 90_000, 'graph stays within the 90-second runtime budget');
  assert.ok(tools.every(tool => Number(tool.durationMs || 0) <= 15_000), 'each recorded tool call stays within its 15-second timeout');
  assert.ok(collaboration.agents.every(agent => agent.executionMode === expectedExecutionMode));
  return { parentRunId: graph.runId, executionMode: graph.executionMode, model: graph.model, provider: graph.provider,
    selectionSource: collaboration.selectionSource, selectionValidation: selection,
    modelCalls: Number(budget.modelCalls), toolCalls: Number(budget.toolCalls), inputTokens: Number(budget.inputTokens || 0),
    outputTokens: Number(budget.outputTokens || 0), tokenTotal, estimatedCostUsd: Number(budget.estimatedCostUsd || 0),
    graphDurationMs: Number(collaboration.graphDurationMs || 0),
    agents: collaboration.agents.map(agent => ({ runId: agent.runId, agentId: agent.agentId, status: agent.status,
      executionMode: agent.executionMode, live: agent.live, model: agent.model, provider: agent.provider,
      modelCallCount: (agent.modelSteps || []).length, toolCalls: (agent.tools || []).map(tool => ({ name: tool.toolName,
        status: tool.status, durationMs: tool.durationMs })) })) };
}

async function users(context) {
  const [guest, clinician, dean] = await Promise.all([
    login(context.baseUrl, 'guest'), login(context.baseUrl, 'staff'), login(context.baseUrl, 'dean')
  ]);
  assertStatus(guest, 200, `${context.driver}: guest login`);
  assertStatus(clinician, 200, `${context.driver}: clinician login`);
  assertStatus(dean, 200, `${context.driver}: administrator login`);
  return {
    guest: { id: guest.data.user.id, token: guest.data.token },
    clinician: { id: clinician.data.user.id, token: clinician.data.token },
    dean: { id: dean.data.user.id, token: dean.data.token }
  };
}

async function setStay(context, guestId, days = 7, start = dateOffset(today, 1)) {
  const checkIn = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const checkOut = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  await databaseQuery(context, `UPDATE guest_profiles SET ${checkIn}=?,${checkOut}=? WHERE user_id=?`,
    [start, dateOffset(start, days), guestId], 'run');
  return { start, end: dateOffset(start, days) };
}

async function setHealth(context, guestId, { chronic = [], allergies = [], skin = null } = {}) {
  const profile = {
    chronic: { status: chronic.length ? 'reported' : 'none', items: chronic },
    medications: { status: 'none', items: [] },
    allergies: { status: allergies.length ? 'reported' : 'none', items: allergies },
    dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'independent', details: '可独立行走' },
    sleep: { status: 'unanswered', details: '' },
    skin: skin ? { status: 'reported', details: skin } : { status: 'unanswered', details: '' },
    audienceTags: { status: 'none', items: [] }
  };
  await databaseQuery(context, `UPDATE guest_profiles SET chronic_json=?,allergies_json=?,mobility=?,health_profile_json=? WHERE user_id=?`,
    [JSON.stringify(chronic), JSON.stringify(allergies), '可独立行走', JSON.stringify(profile), guestId], 'run');
}

async function setCompleteLowRiskHealth(context, guestId) {
  const profile = {
    chronic: { status: 'none', items: [] },
    medications: { status: 'none', items: [] },
    allergies: { status: 'none', items: [] },
    dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'independent', details: '可独立行走' },
    sleep: { status: 'reported', details: '睡眠正常' },
    skin: { status: 'reported', details: '皮肤完整，无破损' },
    audienceTags: { status: 'none', items: [] }
  };
  await databaseQuery(context, `UPDATE guest_profiles SET chronic_json='[]',allergies_json='[]',mobility=?,health_profile_json=?,
    health_profile_version=health_profile_version+1 WHERE user_id=?`, ['可独立行走', JSON.stringify(profile), guestId], 'run');
}

function slotId(projectId, date, start, end) {
  const digest = crypto.createHash('sha256').update(`${projectId}\u0000${date}\u0000${start}\u0000${end}`).digest('hex').slice(0, 32);
  return `slot_${digest}`;
}

function selectedProjectSlot(sourceIds) {
  return [...(sourceIds || [])].reverse().find(source => source?.type === 'project_slot' && source.id)?.id || null;
}

function parseJsonColumn(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function insertSlot(context, { projectId, date, start, end, capacity = 2 }) {
  const slot = slotId(projectId, date, start, end);
  const startsAt = sqlTime(context, new Date(`${date}T${start}:00+08:00`).toISOString());
  const endsAt = sqlTime(context, new Date(`${date}T${end}:00+08:00`).toISOString());
  const stamp = sqlTime(context, fixedInstant);
  const existing = await databaseQuery(context, 'SELECT id FROM activity_slots WHERE id=?', [slot], 'get');
  if (existing) {
    await databaseQuery(context, `UPDATE activity_slots SET project_id=?,business_date=?,starts_at=?,ends_at=?,local_start=?,local_end=?,
      capacity=?,is_closed=0,updated_at=? WHERE id=?`, [projectId, date, startsAt, endsAt, start, end, capacity, stamp, slot], 'run');
  } else {
    await databaseQuery(context, `INSERT INTO activity_slots
      (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,0,?,?)`, [slot, projectId, date, startsAt, endsAt, start, end, capacity, stamp, stamp], 'run');
  }
  return slot;
}

function snapshotKey(locationId, stationId, date, domain) {
  return `env:${crypto.createHash('sha256').update(JSON.stringify([locationId, stationId, date, domain])).digest('hex').slice(0, 48)}`;
}

async function seedEnvironment(context, date) {
  const demo = makeDemoEnvironment(date, fixedInstant, DEMO_ENVIRONMENT_LOCATION);
  const payloads = [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]];
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
      [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, payload.sourceName || 'Stage22 合成环境快照', payload.sourceUrl || '',
        sqlTime(context, fixedInstant), sqlTime(context, '2026-10-05T02:00:00.000Z'), hash, json,
        sqlTime(context, fixedInstant), sqlTime(context, fixedInstant)], 'run');
  }
}

async function seedDraft(context, guestId, { version = 1, date = dateOffset(today, 1), slotId: actualSlotId = null,
  title = '沙滩漫步', itemStatus = 'pending_review', status = 'pending_review', reviewStatus = status,
  reason = '基于当前档案与来源记录，待医护审核。', threadId = null, items = null } = {}) {
  const draftId = `wellness_draft_q22_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const reviewThreadId = threadId || draftId;
  const stamp = sqlTime(context, fixedInstant);
  await databaseQuery(context, `INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
     evidence_json,created_at,review_status,review_thread_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,?, ?,NULL,?,?,?,'auto',0,?,?,?,?,?,?,?)`,
    [draftId, guestId, version, `q22:fixture:${draftId}`, date, dateOffset(date, 5), status,
      JSON.stringify({ parentRunId: null, traceStatus: 'fixture-no-source-run' }), stamp, reviewStatus, reviewThreadId,
      status === 'returned' || reviewStatus === 'returned' ? reason : null,
      status === 'returned' || status === 'active' ? 'staff_001' : null,
      status === 'returned' || status === 'active' ? stamp : null], 'run');
  const itemList = items || [{ type: 'activity', slotId: actualSlotId, title, date, slotKey: 'morning', status: itemStatus, reason }];
  for (let index = 0; index < itemList.length; index += 1) {
    const item = itemList[index];
    const itemId = `wellness_item_q22_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
    const sourceIds = item.sourceIds || (item.slotId ? [{ type: 'project_slot', id: item.slotId, label: `${item.date || date} 项目时段` }] : []);
    await databaseQuery(context, `INSERT INTO wellness_draft_items
      (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
       rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [itemId, draftId, item.date || date,
        item.slotKey || (item.type === 'activity' ? 'morning' : 'breakfast'), item.type || 'activity',
        item.candidateId || (item.slotId ? 'project-beach-walk' : null), item.title || `证据项目${index + 1}`,
        item.localStart || '07:30', item.localEnd || '08:30', item.status || itemStatus, item.reason || reason,
        item.location || '海屿服务区（演示地点）', JSON.stringify(item.ruleIds || []), JSON.stringify(sourceIds),
        item.environmentSnapshotId || null, JSON.stringify(item.evidence || {})], 'run');
  }
  return draftId;
}

async function addGuest(context, clinicianId, { id: guestId = `guest_q22_${crypto.randomUUID().slice(0, 8)}`, username = `q22_guest_${crypto.randomUUID().slice(0, 8)}` } = {}) {
  const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
  assert.ok(source?.password_hash, `${context.driver}: demo guest password hash exists`);
  const stamp = sqlTime(context, fixedInstant);
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,?,?,'guest',?,'', 'active',?)`, [guestId, username, source.password_hash, 'Q22 并发客人', stamp], 'run');
  const inField = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const outField = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  await databaseQuery(context, `INSERT INTO guest_profiles
    (user_id,gender,birth_date,room_no,${inField},${outField},emergency_contact,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0)`, [guestId, '', null, 'Q22-02', dateOffset(today, 1), dateOffset(today, 8), '', '[]', '[]', '可独立行走',
      JSON.stringify({})], 'run');
  const dean = await databaseQuery(context, "SELECT id FROM users WHERE role='dean' LIMIT 1", [], 'get');
  await databaseQuery(context, `INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at) VALUES(?,?,?,NULL,'active',?,?,?)`,
    [clinicianId, guestId, stamp, dean.id, stamp, stamp], 'run');
  await setHealth(context, guestId);
  return { id: guestId, username };
}

async function startRecordedModel(resourceSession) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address()?.port;
      server.close(error => error ? reject(error) : value ? resolve(value) : reject(new Error('Q22 could not reserve a loopback port')));
    });
  });
  const resource = await resourceSession.startProcess({ label: `q22-recorded-model-${crypto.randomUUID().slice(0, 8)}`,
    kind: 'stub', role: 'model-provider', command: process.execPath, args: [recordedModel], cwd: projectRoot,
    port, env: { PATH: process.env.PATH || '', PORT: String(port) } });
  if (resource.status !== 'running') throw new Error(`Stage22 recorded model failed to start: ${JSON.stringify(resource)}`);
  try {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return { resource, baseUrl: `http://127.0.0.1:${port}/v1` };
      } catch { /* bounded readiness retry */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Stage22 recorded model readiness timed out');
  } catch (error) {
    await resourceSession.stop(resource.id, 'q22-recorded-model-start-failure').catch(() => {});
    await resourceSession.waitProcess(resource.id, 10_000).catch(() => {});
    throw error;
  }
}

async function stopRecordedModel(resourceSession, handle) {
  if (!handle) return;
  const state = await resourceSession.status();
  const current = state.resources?.find(item => item.id === handle.resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const result = await resourceSession.stop(current.id, 'q22-recorded-model-complete');
    if (!result.ok) throw new Error(`Stage22 recorded model stop failed: ${result.error || 'unknown error'}`);
  }
  const waited = await resourceSession.waitProcess(handle.resource.id, 10_000);
  if (waited.timedOut || waited.unavailable || ['starting', 'running'].includes(waited.status)) {
    throw new Error(`Stage22 recorded model did not exit: ${JSON.stringify(waited)}`);
  }
}

function modelEnvironment(provider, extra = {}) {
  return { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: fixedInstant,
    LLM_BASE_URL: provider.baseUrl, LLM_API_KEY: 'q22-recorded-fixture-only', LLM_MODEL: 'recorded-stage22',
    LLM_TIMEOUT_MS: '30000', ASSISTANT_MODEL_SOURCE: 'recorded_fixture',
    WELLNESS_DRAFT_REVIEW_POLICY: 'auto', ...extra };
}

async function withBoth(contextFn, resourceSession, env = {}) {
  let details;
  await withBothDatabaseApis(async context => {
    details = await contextFn(context);
    appendEvidence({ quest: details.quest, scenario: details.scenario, driver: context.driver,
      status: 'PASS', evidence: details.evidence || {} });
  }, { resourceSession, env: { BUSINESS_CLOCK_NOW: fixedInstant, ...env } });
  return details;
}

async function withModelBoth(contextFn, resourceSession, env = {}) {
  const provider = await startRecordedModel(resourceSession);
  try { return await withBoth(contextFn, resourceSession, modelEnvironment(provider, env)); }
  finally { await stopRecordedModel(resourceSession, provider); }
}

async function clinicianAction(context, clinician, draftId, action, body, key) {
  return api(context, `/staff/therapy-drafts/${draftId}/${action}`, { method: 'POST', token: clinician.token,
    headers: { 'Idempotency-Key': key }, body });
}

async function q221(context, user) {
  const stay = await setStay(context, user.guest.id);
  const one = await seedDraft(context, user.guest.id, { version: 1, date: stay.start, title: '待审方案甲' });
  const two = await seedDraft(context, user.guest.id, { version: 2, date: stay.start, title: '待审方案乙' });
  const complete = await seedDraft(context, user.guest.id, { version: 3, date: stay.start, title: '已通过方案', status: 'active', reviewStatus: 'active' });
  const queue = assertStatus(await api(context, '/staff/therapy-drafts?status=pending_review', { token: user.clinician.token }), 200, 'Q22.1 queue');
  assert.equal(queue.counts.pending, 2);
  assert.equal(queue.counts.complete, 1);
  assert.deepEqual(new Set(queue.items.map(item => item.draftId)), new Set([one, two]));
  await databaseQuery(context, "UPDATE users SET job_type='coach' WHERE id=?", [user.clinician.id], 'run');
  const denied = await api(context, '/staff/therapy-drafts', { token: user.clinician.token });
  assert.equal(denied.status, 403, 'ordinary staff cannot enter the medical review queue');
  return { quest: 'Q22.1', scenario: 'queue-counts-and-role', evidence: { pending: 2, complete: 1,
    itemIds: [one, two], completedId: complete, ordinaryStaffStatus: denied.status } };
}

async function q222(context, user) {
  const stay = await setStay(context, user.guest.id);
  const first = await seedDraft(context, user.guest.id, { version: 1, date: stay.start, title: '高风险建议',
    itemStatus: 'mandatory_review', reason: '慢病信息需要医护核对。' });
  const second = await seedDraft(context, user.guest.id, { version: 2, date: stay.start, title: '常规建议' });
  await seedDraft(context, user.guest.id, { version: 3, date: dateOffset(stay.start, 1), title: '其他日期建议', status: 'active', reviewStatus: 'active' });
  const filtered = assertStatus(await api(context, `/staff/therapy-drafts?status=pending_review&guestId=${user.guest.id}&date=${stay.start}&risk=high`,
    { token: user.clinician.token }), 200, 'Q22.2 filtered queue');
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0].draftId, first);
  assert.equal(filtered.items[0].riskLevel, 'high');
  const completed = assertStatus(await api(context, `/staff/therapy-drafts?status=complete&guestId=${user.guest.id}&date=${dateOffset(stay.start, 1)}`,
    { token: user.clinician.token }), 200, 'Q22.2 completed filter');
  assert.equal(completed.items.length, 1);
  assert.equal((await api(context, `/staff/therapy-drafts/${second}`, { token: user.clinician.token })).status, 200);
  return { quest: 'Q22.2', scenario: 'filter-and-detail-link', evidence: { highRiskDraftId: first,
    normalPendingDraftId: second, openMatches: filtered.items.length, completedMatches: completed.items.length } };
}

async function q223(context, user) {
  const stay = await setStay(context, user.guest.id);
  const date = stay.start;
  const slot = await insertSlot(context, { projectId: 'project-beach-walk', date, start: '07:30', end: '08:30' });
  const sourceRecord = await databaseQuery(context, 'SELECT id FROM health_records WHERE guest_id=? ORDER BY id LIMIT 1', [user.guest.id], 'get');
  assert.ok(sourceRecord?.id, `${context.driver}: seeded health record source exists`);
  const draftId = await seedDraft(context, user.guest.id, { date, slotId: slot, items: [{ type: 'activity', slotId: slot,
    title: '沙滩漫步', candidateId: 'project-beach-walk', status: 'mandatory_review', ruleIds: ['R2'],
    sourceIds: [{ type: 'project_slot', id: slot, label: '实际项目时段' },
      { type: 'health_record', id: String(sourceRecord.id), label: '正式健康记录' }, { type: 'rule', id: 'R2', label: '皮肤破损规则' }],
    evidence: { parentRunId: null, missingSource: '知识来源未保存在此演示记录中' } }] });
  const detail = assertStatus(await api(context, `/staff/therapy-drafts/${draftId}`, { token: user.clinician.token }), 200, 'Q22.3 evidence detail');
  const item = detail.items[0];
  assert.deepEqual(item.sourceIds.map(source => `${source.type}:${source.id}`), [
    `project_slot:${slot}`, `health_record:${sourceRecord.id}`, 'rule:R2'
  ]);
  assert.match(item.evidence.missingSource, /未保存在/u, 'missing citations are shown, not fabricated');
  return { quest: 'Q22.3', scenario: 'evidence-sources-and-missing-citation', evidence: { draftId, slot,
    healthRecordId: sourceRecord.id, ruleId: 'R2', missingSourceMarked: true } };
}

async function q224(context, user) {
  const stay = await setStay(context, user.guest.id);
  await setHealth(context, user.guest.id, { skin: '开放性伤口' });
  await seedEnvironment(context, stay.start);
  const unsafe = await insertSlot(context, { projectId: 'project-sea-bath', date: stay.start, start: '09:00', end: '10:00' });
  const safe = await insertSlot(context, { projectId: 'project-marine-hot-spring', date: stay.start, start: '10:00', end: '11:00' });
  const draftId = await seedDraft(context, user.guest.id, { date: stay.start, slotId: unsafe, title: '海水浴' });
  const alternatives = assertStatus(await api(context, `/staff/therapy-drafts/${draftId}/alternatives?itemId=${(await databaseQuery(context,
    'SELECT id FROM wellness_draft_items WHERE draft_id=? LIMIT 1', [draftId], 'get')).id}`, { token: user.clinician.token }), 200, 'Q22.4 actual alternatives');
  assert.ok(alternatives.alternatives.some(item => item.slotId === safe), 'indoor actual slot is a legal alternative');
  const itemId = (await databaseQuery(context, 'SELECT id FROM wellness_draft_items WHERE draft_id=? LIMIT 1', [draftId], 'get')).id;
  const invalid = await api(context, `/staff/therapy-drafts/${draftId}/revisions`, { method: 'PUT', token: user.clinician.token,
    headers: { 'Idempotency-Key': 'q22:revise:invalid:0001' }, body: { version: 1, reason: 'R2 安全替代核验',
      edits: [{ itemId, slotId: unsafe, reason: '必须遵守 R2' }] } });
  assert.equal(invalid.status, 409, `R2 sea-bath replacement should fail: ${JSON.stringify(invalid.data)}`);
  const revised = assertStatus(await api(context, `/staff/therapy-drafts/${draftId}/revisions`, { method: 'PUT', token: user.clinician.token,
    headers: { 'Idempotency-Key': 'q22:revise:valid:0001' }, body: { version: 1, reason: 'R2：皮肤破损时排除海水浴，改为室内项目。',
      edits: [{ itemId, slotId: safe, reason: '依 R2 排除海水浴，改选当前开放的室内海洋温泉。' }] } }), 200, 'Q22.4 save revision');
  assert.equal(revised.version, 2);
  assert.equal(revised.reviewStatus, 'pending_review');
  assert.equal(revised.items[0].sourceIds[0].id, safe);
  assert.equal((await api(context, `/staff/therapy-drafts/${draftId}`, { token: user.clinician.token })).data.items[0].sourceIds[0].id, unsafe,
    'prior draft version remains readable');
  const beforeBookings = await databaseQuery(context, 'SELECT COUNT(*) AS total FROM reservations WHERE guest_id=?', [user.guest.id], 'get');
  assert.equal(Number(beforeBookings.total), 0, 'revision does not reserve a slot');
  return { quest: 'Q22.4', scenario: 'versioned-safe-revision', evidence: { originalDraftId: draftId,
    revisedDraftId: revised.draftId, unsafeSeaBathSlot: unsafe, legalIndoorSlot: safe, invalidStatus: invalid.status,
    reservationCountAfterRevision: Number(beforeBookings.total) } };
}

async function q225(context, user) {
  const firstStay = await setStay(context, user.guest.id);
  await setHealth(context, user.guest.id);
  const second = await addGuest(context, user.clinician.id);
  await setStay(context, second.id);
  const date = firstStay.start;
  await seedEnvironment(context, date);
  const slot = await insertSlot(context, { projectId: 'project-beach-walk', date, start: '07:30', end: '08:30', capacity: 1 });
  const firstDraft = await seedDraft(context, user.guest.id, { date, slotId: slot, title: '并发疗程甲' });
  const secondDraft = await seedDraft(context, second.id, { date, slotId: slot, title: '并发疗程乙' });
  const [first, other] = await Promise.all([
    clinicianAction(context, user.clinician, firstDraft, 'approve', { version: 1 }, 'q22:approve:race:guest1'),
    clinicianAction(context, user.clinician, secondDraft, 'approve', { version: 1 }, 'q22:approve:race:guest2')
  ]);
  const statuses = [first.status, other.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], 'only one version can claim the last seat');
  const successful = first.status === 200 ? { result: first, draftId: firstDraft } : { result: other, draftId: secondDraft };
  const successfulKey = first.status === 200 ? 'q22:approve:race:guest1' : 'q22:approve:race:guest2';
  const losingDraftId = successful.draftId === firstDraft ? secondDraft : firstDraft;
  const replay = await clinicianAction(context, user.clinician, successful.draftId, 'approve', { version: 1 }, successfulKey);
  assert.equal(replay.status, 200, 'same activation key replays successfully');
  const reservations = await databaseQuery(context, `SELECT r.id,r.status,r.slot_id,r.wellness_draft_id,r.wellness_draft_item_id,
      s.project_id,s.business_date,s.local_start,s.local_end FROM reservations r JOIN activity_slots s ON s.id=r.slot_id WHERE r.slot_id=?`, [slot]);
  assert.equal(reservations.filter(item => item.status === 'confirmed').length, 1);
  assert.ok(reservations.some(item => item.wellness_draft_id === successful.draftId && item.wellness_draft_item_id));
  const plannedItems = await databaseQuery(context, "SELECT id,source_ids_json FROM wellness_draft_items WHERE draft_id=? AND item_type='activity'", [successful.draftId]);
  const successfulReservation = reservations.find(item => item.status === 'confirmed');
  const selectedSourceItem = plannedItems.find(item => item.id === successfulReservation.wellness_draft_item_id);
  assert.ok(selectedSourceItem);
  assert.equal(selectedProjectSlot(parseJsonColumn(selectedSourceItem.source_ids_json, [])), slot,
    'booking links to the selected project slot on the exact approved item');
  assert.equal(successfulReservation.project_id, 'project-beach-walk');
  assert.equal(String(successfulReservation.business_date).slice(0, 10), date);
  const losingReservations = await databaseQuery(context, 'SELECT id FROM reservations WHERE wellness_draft_id=?', [losingDraftId]);
  assert.equal(losingReservations.length, 0, 'losing draft has no associated project booking');
  const draftStates = await databaseQuery(context, 'SELECT id,status,review_status FROM wellness_drafts WHERE id IN (?,?)', [firstDraft, secondDraft]);
  assert.equal(draftStates.find(row => row.id === losingDraftId).status, 'pending_review');
  assert.equal(draftStates.find(row => row.id === losingDraftId).review_status, 'pending_review');
  const active = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_drafts WHERE status='active' AND id IN (?,?)", [firstDraft, secondDraft], 'get');
  assert.equal(Number(active.total), 1, 'losing plan remains pending and no orphan draft is active');
  const events = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_review_events WHERE action='approved' AND draft_id IN (?,?)", [firstDraft, secondDraft], 'get');
  assert.equal(Number(events.total), 1, 'only successful activation created an audit event');
  const revisedApprovalEvents = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_review_events WHERE action='approved_after_revision' AND draft_id IN (?,?)", [firstDraft, secondDraft], 'get');
  assert.equal(Number(revisedApprovalEvents.total), 0, 'ordinary last-seat approval keeps the ordinary approval action');
  const successfulDetail = assertStatus(await api(context, `/staff/therapy-drafts/${successful.draftId}`, { token: user.clinician.token }),
    200, 'Q22.5 ordinary approval detail');
  assert.equal(successfulDetail.approvalAction, 'approved', 'an ordinary approval is not classified as a clinician-revision approval');
  const bookingAudits = await databaseQuery(context, "SELECT COUNT(*) AS total FROM audit_logs WHERE action='reservation.create' AND target_id=?", [successfulReservation.id], 'get');
  assert.equal(Number(bookingAudits.total), 1, 'successful project booking has exactly one linked audit row');
  return { quest: 'Q22.5', scenario: 'last-seat-atomic-approval', evidence: { slotId: slot,
    draftIds: [firstDraft, secondDraft], responseStatuses: [first.status, other.status], confirmedReservationId: reservations.find(item => item.status === 'confirmed').id,
    linkedDraftId: successful.draftId, linkedItemId: successfulReservation.wellness_draft_item_id,
    projectId: successfulReservation.project_id, businessDate: String(successfulReservation.business_date).slice(0, 10),
    replayStatus: replay.status, losingDraftId, losingReservations: losingReservations.length,
    activeDraftCount: Number(active.total), reviewEvents: Number(events.total), revisedApprovalEvents: Number(revisedApprovalEvents.total),
    approvalAction: successfulDetail.approvalAction, bookingAuditRows: Number(bookingAudits.total) } };
}

async function q226(context, user) {
  const firstStay = await setStay(context, user.guest.id);
  await setCompleteLowRiskHealth(context, user.guest.id);
  const dates = Array.from({ length: 7 }, (_, offset) => dateOffset(firstStay.start, offset));
  for (const date of dates) await seedEnvironment(context, date);
  const firstSlot = await insertSlot(context, { projectId: 'project-beach-walk', date: firstStay.start,
    start: '07:30', end: '08:30', capacity: 2 });
  const secondSlot = await insertSlot(context, { projectId: 'project-beach-walk', date: firstStay.start,
    start: '16:30', end: '17:30', capacity: 2 });
  const response = await api(context, '/me/therapy-drafts', { method: 'POST', token: user.guest.token,
    headers: { 'Idempotency-Key': 'q22:auto:low-risk:0001' }, body: {} });
  const draft = assertStatus(response, 201, 'Q22.6 low-risk generated draft');
  const generated = await databaseQuery(context, 'SELECT id,status,review_status,review_policy,review_sample_percent FROM wellness_drafts WHERE id=?', [draft.draftId], 'get');
  assert.equal(generated.review_policy, 'auto');
  assert.equal(Number(generated.review_sample_percent), 0);
  if (generated.review_status !== 'auto_activated') {
    const manualProbe = await clinicianAction(context, user.clinician, draft.draftId, 'approve', { version: draft.version }, 'q22:auto:diagnostic:0001');
    assert.fail(`complete low-risk, unblocked plan did not auto-activate: ${JSON.stringify({ autoActivation: draft.autoActivation,
      reviewPolicy: draft.evidence?.reviewPolicy, statuses: draft.items.map(item => ({ type: item.type, status: item.status,
        candidateId: item.candidateId, date: item.businessDate, localStart: item.localStart, localEnd: item.localEnd,
        slotIds: (item.sourceIds || []).filter(source => source.type === 'project_slot').map(source => source.id)
      })).filter(item => item.candidateId || item.status !== 'gap'),
      manualProbe: { status: manualProbe.status, data: manualProbe.data } })}`);
  }
  const plannedActivities = await databaseQuery(context, "SELECT id,candidate_id,status,source_ids_json FROM wellness_draft_items WHERE draft_id=? AND item_type='activity' AND candidate_id IS NOT NULL", [draft.draftId]);
  assert.ok(plannedActivities.length >= 2, 'low-risk positive case evaluates both real same-day activity windows');
  const linked = await databaseQuery(context, `SELECT r.id,r.slot_id,r.status,r.wellness_draft_id,r.wellness_draft_item_id,
      s.project_id,s.business_date,s.capacity,(SELECT COUNT(*) FROM reservations active WHERE active.slot_id=s.id AND active.status='confirmed') AS booked
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id WHERE r.wellness_draft_id=? AND r.status='confirmed' ORDER BY s.starts_at`, [draft.draftId]);
  assert.ok(linked.length >= 1, 'low-risk activation wrote real reservations');
  assert.ok(linked.every(row => row.wellness_draft_id === draft.draftId && row.wellness_draft_item_id
    && row.slot_id && Number(row.booked) <= Number(row.capacity)), 'every reservation is linked to a real plan item and within capacity');
  const plannedById = new Map(plannedActivities.map(item => [item.id, item]));
  assert.ok(linked.every(row => selectedProjectSlot(parseJsonColumn(plannedById.get(row.wellness_draft_item_id)?.source_ids_json, [])) === row.slot_id),
    'each reservation uses the slot selected for its exact draft item');
  assert.deepEqual(new Set(linked.map(row => row.slot_id)), new Set([firstSlot, secondSlot]), 'both selected windows were booked once');
  const activatedEvents = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_review_events WHERE draft_id=? AND action='auto_activated'", [draft.draftId], 'get');
  const reservationAudits = await databaseQuery(context, "SELECT COUNT(*) AS total FROM audit_logs WHERE action='reservation.create' AND target_id IN (SELECT id FROM reservations WHERE wellness_draft_id=?)", [draft.draftId], 'get');
  assert.equal(Number(activatedEvents.total), 1, 'activation has one persisted review event');
  assert.equal(Number(reservationAudits.total), linked.length, 'each real reservation has one audit log');
  assert.equal(draft.evidence?.executionMode, 'recorded_fixture');

  const chronic = await addGuest(context, user.clinician.id);
  const chronicStay = await setStay(context, chronic.id);
  await setHealth(context, chronic.id, { chronic: ['高血压'], skin: '皮肤完整' });
  await seedEnvironment(context, chronicStay.start);
  await insertSlot(context, { projectId: 'project-beach-walk', date: chronicStay.start, start: '07:30', end: '08:30', capacity: 2 });
  const chronicLogin = assertStatus(await api(context, '/auth/login', { method: 'POST', body: { username: chronic.username,
    password: 'guest2026', role: 'guest' } }), 200, 'Q22.6 chronic-risk guest login');
  const chronicDraft = assertStatus(await api(context, '/me/therapy-drafts', { method: 'POST', token: chronicLogin.token,
    headers: { 'Idempotency-Key': 'q22:auto:chronic:0001' }, body: {} }), 201, 'Q22.6 chronic-risk draft');
  const chronicItems = await databaseQuery(context, "SELECT item_type,candidate_id,status FROM wellness_draft_items WHERE draft_id=? AND item_type='activity' AND candidate_id IS NOT NULL", [chronicDraft.draftId]);
  assert.ok(chronicItems.length > 0, 'chronic counterexample includes an evaluable real activity');
  assert.ok(chronicItems.every(item => item.status === 'mandatory_review'), 'chronic activities require clinician review');
  assert.equal(chronicDraft.reviewStatus, 'pending_review');
  const chronicReservations = await databaseQuery(context, "SELECT id FROM reservations WHERE wellness_draft_id=? AND status='confirmed'", [chronicDraft.draftId]);
  assert.equal(chronicReservations.length, 0, 'chronic review writes no reservations');

  const unknown = await addGuest(context, user.clinician.id);
  const unknownStay = await setStay(context, unknown.id);
  await seedEnvironment(context, unknownStay.start);
  await insertSlot(context, { projectId: 'project-beach-walk', date: unknownStay.start, start: '07:30', end: '08:30', capacity: 2 });
  const unknownLogin = assertStatus(await api(context, '/auth/login', { method: 'POST', body: { username: unknown.username,
    password: 'guest2026', role: 'guest' } }), 200, 'Q22.6 unverified guest login');
  const unknownDraft = assertStatus(await api(context, '/me/therapy-drafts', { method: 'POST', token: unknownLogin.token,
    headers: { 'Idempotency-Key': 'q22:auto:unknown:0001' }, body: {} }), 201, 'Q22.6 unverified health draft');
  const unknownItems = await databaseQuery(context, "SELECT item_type,candidate_id,status FROM wellness_draft_items WHERE draft_id=? AND item_type='activity' AND candidate_id IS NOT NULL", [unknownDraft.draftId]);
  assert.ok(unknownItems.length > 0, 'unverified counterexample includes an evaluable real activity');
  assert.ok(unknownItems.every(item => item.status === 'mandatory_review'), 'incomplete health profile requires clinician review');
  assert.equal(unknownDraft.reviewStatus, 'pending_review');
  const unknownReservations = await databaseQuery(context, "SELECT id FROM reservations WHERE wellness_draft_id=? AND status='confirmed'", [unknownDraft.draftId]);
  assert.equal(unknownReservations.length, 0, 'unverified health writes no reservations');

  const ruleGuest = await addGuest(context, user.clinician.id);
  const ruleStay = await setStay(context, ruleGuest.id);
  await setHealth(context, ruleGuest.id, { skin: '开放性伤口' });
  await seedEnvironment(context, ruleStay.start);
  const seaSlot = await insertSlot(context, { projectId: 'project-sea-bath', date: ruleStay.start,
    start: '09:00', end: '10:00', capacity: 2 });
  const safeRuleSlot = await insertSlot(context, { projectId: 'project-beach-walk', date: ruleStay.start,
    start: '16:30', end: '17:30', capacity: 2 });
  const ruleLogin = assertStatus(await api(context, '/auth/login', { method: 'POST', body: { username: ruleGuest.username,
    password: 'guest2026', role: 'guest' } }), 200, 'Q22.6 rule counterexample guest login');
  const ruleDraft = assertStatus(await api(context, '/me/therapy-drafts', { method: 'POST', token: ruleLogin.token,
    headers: { 'Idempotency-Key': 'q22:auto:rule:0001' }, body: {} }), 201, 'Q22.6 R2 rule counterexample');
  const ruleItems = await databaseQuery(context, "SELECT candidate_id,status,reason,rule_ids_json FROM wellness_draft_items WHERE draft_id=? AND item_type='activity'", [ruleDraft.draftId]);
  assert.ok(ruleItems.length > 0, 'R2 scenario includes at least one evaluable activity candidate');
  assert.ok(ruleItems.every(item => item.candidate_id !== 'project-sea-bath'), 'the generated plan excludes the R2-prohibited sea bath candidate');
  assert.ok(ruleItems.some(item => item.candidate_id === 'project-beach-walk'), `safe comparison candidate exists from ${safeRuleSlot}`);
  const ruleReservations = await databaseQuery(context, "SELECT id FROM reservations WHERE wellness_draft_id=? AND status='confirmed'", [ruleDraft.draftId]);
  assert.equal(ruleReservations.length, 0, 'R2 rule counterexample writes no reservations');

  const blockedGuest = await addGuest(context, user.clinician.id);
  const blockedStay = await setStay(context, blockedGuest.id);
  const blockedDraftId = await seedDraft(context, blockedGuest.id, { date: blockedStay.start, slotId: seaSlot,
    title: 'R2 禁用活动', itemStatus: 'excluded', reason: 'R2：开放性伤口时禁止海水浴。',
    items: [{ type: 'activity', candidateId: 'project-sea-bath', slotId: seaSlot, title: '海水浴',
      date: blockedStay.start, slotKey: 'morning', status: 'excluded', reason: 'R2：开放性伤口时禁止海水浴。' }] });
  const deniedActivation = await clinicianAction(context, user.clinician, blockedDraftId, 'approve', { version: 1 }, 'q22:r2:blocked:0001');
  assert.equal(deniedActivation.status, 409, `R2 excluded item is rejected by activation: ${JSON.stringify(deniedActivation.data)}`);
  assert.equal(deniedActivation.data.code, 'WELLNESS_ITEM_NOT_READY');
  const blockedReservations = await databaseQuery(context, "SELECT id FROM reservations WHERE wellness_draft_id=? AND status='confirmed'", [blockedDraftId]);
  assert.equal(blockedReservations.length, 0, 'R2 excluded item cannot create a reservation');
  const blockedActivationEvents = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_review_events WHERE draft_id=? AND action='approved'", [blockedDraftId], 'get');
  assert.equal(Number(blockedActivationEvents.total), 0, 'rejected R2 activation writes no approval event');

  const rollback = await runAutoActivationRollbackCase(context, user, { mode: 'capacity', start: dateOffset(today, 2) });
  const ruleRollback = await runAutoActivationRollbackCase(context, user, { mode: 'slot_closed', start: dateOffset(today, 3) });
  return { quest: 'Q22.6', scenario: 'real-auto-activation-risk-gates-and-transaction-rollback', evidence: {
    positive: { draftId: draft.draftId, reviewStatus: generated.review_status, plannedActivityCount: plannedActivities.length,
      reservationRows: linked, activationEvents: Number(activatedEvents.total), reservationAuditCount: Number(reservationAudits.total),
      executionMode: draft.evidence.executionMode },
    chronic: { draftId: chronicDraft.draftId, evaluatedActivities: chronicItems.length, statuses: chronicItems.map(item => item.status),
      reservationCount: chronicReservations.length },
    unverified: { draftId: unknownDraft.draftId, evaluatedActivities: unknownItems.length, statuses: unknownItems.map(item => item.status),
      reservationCount: unknownReservations.length },
    safetyRule: { draftId: ruleDraft.draftId, seaSlot, safeRuleSlot, items: ruleItems,
      generatedActivityCandidates: ruleItems.map(item => item.candidate_id), reservationCount: ruleReservations.length,
      excludedDraftId: blockedDraftId, activationStatus: deniedActivation.status, activationError: deniedActivation.data.code,
      excludedReservationCount: blockedReservations.length, approvalEvents: Number(blockedActivationEvents.total) },
    capacityRollback: rollback, slotRuleRollback: ruleRollback } };
}

async function runAutoActivationRollbackCase(context, user, { mode, start }) {
  const guest = await addGuest(context, user.clinician.id);
  const stay = await setStay(context, guest.id, 7, start);
  await setCompleteLowRiskHealth(context, guest.id);
  for (let offset = 0; offset < 7; offset += 1) await seedEnvironment(context, dateOffset(start, offset));
  const firstSlot = await insertSlot(context, { projectId: 'project-beach-walk', date: start, start: '07:30', end: '08:30', capacity: 1 });
  const secondSlot = await insertSlot(context, { projectId: 'project-beach-walk', date: start, start: '16:30', end: '17:30', capacity: 1 });
  const guestLogin = assertStatus(await api(context, '/auth/login', { method: 'POST', body: { username: guest.username,
    password: 'guest2026', role: 'guest' } }), 200, `Q22.6 ${mode} guest login`);
  const requestKey = mode === 'capacity' ? 'q22:auto:capacity:rollback' : 'q22:auto:rule:rollback';
  const competitor = await addGuest(context, user.clinician.id);
  const trigger = await installActivationFailureTrigger(context, { mode, requestKey, targetSlot: secondSlot,
    competitorGuestId: competitor.id, date: start });
  try {
    const generated = assertStatus(await api(context, '/me/therapy-drafts', { method: 'POST', token: guestLogin.token,
      headers: { 'Idempotency-Key': requestKey }, body: {} }), 201, `Q22.6 ${mode} multi-item plan`);
    const planned = await databaseQuery(context, `SELECT id,candidate_id,status,source_ids_json FROM wellness_draft_items
      WHERE draft_id=? AND item_type='activity' AND candidate_id IS NOT NULL ORDER BY business_date,slot_key`, [generated.draftId]);
    assert.ok(planned.some(item => item.candidate_id === 'project-beach-walk'), `${mode}: first item was planned`);
    assert.ok(planned.length >= 2 && planned.filter(item => item.candidate_id === 'project-beach-walk').length >= 2,
      `${mode}: both same-project morning and afternoon items were planned: ${JSON.stringify(planned)}`);
    assert.ok(planned.some(item => selectedProjectSlot(parseJsonColumn(item.source_ids_json, [])) === firstSlot)
      && planned.some(item => selectedProjectSlot(parseJsonColumn(item.source_ids_json, [])) === secondSlot),
    `${mode}: planned items retain the two distinct selected slot ids`);
    const storedDraft = await databaseQuery(context, 'SELECT status,review_status FROM wellness_drafts WHERE id=?', [generated.draftId], 'get');
    assert.equal(storedDraft.status, 'pending_review', `${mode}: failed activation leaves draft pending`);
    assert.equal(storedDraft.review_status, 'pending_review');
    const draftReservations = await databaseQuery(context, "SELECT id,slot_id,status FROM reservations WHERE wellness_draft_id=? AND status='confirmed'", [generated.draftId]);
    assert.equal(draftReservations.length, 0, `${mode}: rollback removes the first reservation written inside the activation transaction`);
    const events = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_review_events WHERE draft_id=? AND action='auto_activated'", [generated.draftId], 'get');
    const audits = await databaseQuery(context, "SELECT COUNT(*) AS total FROM audit_logs WHERE action='reservation.create' AND target_id IN (SELECT id FROM reservations WHERE wellness_draft_id=?)", [generated.draftId], 'get');
    assert.equal(Number(events.total), 0, `${mode}: failed activation emits no success event`);
    assert.equal(Number(audits.total), 0, `${mode}: rolled-back reservations leave no reservation audit`);
    const firstSeat = await databaseQuery(context, `SELECT COUNT(*) AS total FROM reservations WHERE slot_id=? AND status='confirmed'`, [firstSlot], 'get');
    assert.equal(Number(firstSeat.total), 0, `${mode}: the first slot is released after rollback`);
    let blocker = null;
    if (mode === 'capacity') {
      blocker = await databaseQuery(context, `SELECT r.id,r.guest_id,r.status,s.capacity,
          (SELECT COUNT(*) FROM reservations active WHERE active.slot_id=s.id AND active.status='confirmed') AS booked
        FROM reservations r JOIN activity_slots s ON s.id=r.slot_id WHERE r.slot_id=? AND r.guest_id=?`, [secondSlot, competitor.id], 'get');
      assert.ok(blocker, 'capacity race trigger inserted a competing real reservation');
      assert.equal(blocker.status, 'confirmed');
      assert.equal(Number(blocker.booked), Number(blocker.capacity));
    } else {
      blocker = await databaseQuery(context, 'SELECT is_closed FROM activity_slots WHERE id=?', [secondSlot], 'get');
      assert.equal(Number(blocker.is_closed), 1, 'rule-change trigger closed the second slot after planning and before activation');
    }
    return { mode, draftId: generated.draftId, plannedActivityIds: planned.map(item => item.id),
      plannedCandidates: planned.map(item => item.candidate_id), firstSlot, secondSlot, draftReservationCount: draftReservations.length,
      autoActivationEvents: Number(events.total), reservationAudits: Number(audits.total), releasedFirstSlotCount: Number(firstSeat.total),
      blockingState: blocker, status: storedDraft.review_status };
  } finally {
    await databaseExec(context, `DROP TRIGGER IF EXISTS ${trigger}`);
  }
}

async function installActivationFailureTrigger(context, { mode, requestKey, targetSlot, competitorGuestId, date }) {
  const triggerName = `q22_${mode === 'capacity' ? 'capacity' : 'slot_closed'}_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const quote = value => `'${String(value).replaceAll("'", "''")}'`;
  if (mode === 'capacity') {
    const environment = await databaseQuery(context, "SELECT snapshot_key FROM environment_snapshots WHERE target_date=? AND domain='weather' LIMIT 1", [date], 'get');
    assert.ok(environment?.snapshot_key, `${context.driver}: weather snapshot seeded for competing reservation`);
    const reservationId = `res_q22_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const idempotencyKey = `q22-competing-${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const fingerprint = crypto.createHash('sha256').update(`${requestKey}:${targetSlot}:${competitorGuestId}`).digest('hex');
    const values = [reservationId, competitorGuestId, targetSlot, idempotencyKey, fingerprint,
      sqlTime(context, fixedInstant), environment.snapshot_key, 'available', 'Q22 multi-item capacity race fixture', 1];
    const insert = `INSERT INTO reservations (id,guest_id,slot_id,idempotency_key,request_fingerprint,status,created_at,
      cancelled_at,cancellation_reason,environment_snapshot_id,availability_status,availability_reason,is_demo,wellness_draft_id,wellness_draft_item_id)
      VALUES(${values.slice(0, 5).map(quote).join(',')},'confirmed',${quote(values[5])},NULL,NULL,${values.slice(6).map(quote).join(',')},NULL,NULL)`;
    if (context.driver === 'mysql') {
      await databaseExec(context, `CREATE TRIGGER ${triggerName} AFTER INSERT ON wellness_drafts FOR EACH ROW
        BEGIN IF NEW.request_key=${quote(requestKey)} THEN ${insert}; END IF; END`);
    } else {
      await databaseExec(context, `CREATE TRIGGER ${triggerName} AFTER INSERT ON wellness_drafts
        WHEN NEW.request_key=${quote(requestKey)} BEGIN ${insert}; END`);
    }
  } else {
    if (context.driver === 'mysql') {
      await databaseExec(context, `CREATE TRIGGER ${triggerName} AFTER INSERT ON wellness_drafts FOR EACH ROW
        BEGIN IF NEW.request_key=${quote(requestKey)} THEN UPDATE activity_slots SET is_closed=1 WHERE id=${quote(targetSlot)}; END IF; END`);
    } else {
      await databaseExec(context, `CREATE TRIGGER ${triggerName} AFTER INSERT ON wellness_drafts
        WHEN NEW.request_key=${quote(requestKey)} BEGIN UPDATE activity_slots SET is_closed=1 WHERE id=${quote(targetSlot)}; END`);
    }
  }
  return triggerName;
}

async function q227(context, user) {
  const stay = await setStay(context, user.guest.id, 3);
  await setHealth(context, user.guest.id, { skin: '皮肤有开放性伤口' });
  const dates = Array.from({ length: 3 }, (_, offset) => dateOffset(stay.start, offset));
  for (const date of dates) {
    await seedEnvironment(context, date);
    await insertSlot(context, { projectId: 'project-beach-walk', date, start: '07:30', end: '08:30', capacity: 8 });
    await insertSlot(context, { projectId: 'project-sea-bath', date, start: '09:00', end: '10:00', capacity: 8 });
    await insertSlot(context, { projectId: 'project-marine-hot-spring', date, start: '10:00', end: '11:00', capacity: 8 });
  }
  const oldSlot = slotId('project-beach-walk', stay.start, '07:30', '08:30');
  const newSlot = slotId('project-marine-hot-spring', stay.start, '10:00', '11:00');
  const unsafeSlot = slotId('project-sea-bath', stay.start, '09:00', '10:00');

  const ordinaryDraftId = await seedDraft(context, user.guest.id, { version: 1, date: stay.start, slotId: oldSlot, title: '普通批准活动' });
  const ordinaryKey = 'q22:approve:ordinary:0001';
  const ordinary = assertStatus(await clinicianAction(context, user.clinician, ordinaryDraftId, 'approve', { version: 1 }, ordinaryKey),
    200, 'Q22.7 ordinary approval');
  assert.equal(ordinary.reviewStatus, 'active');
  assert.equal(ordinary.approvalAction, 'approved');
  const ordinaryEvents = await databaseQuery(context, "SELECT id,action FROM wellness_review_events WHERE draft_id=? AND action IN ('approved','approved_after_revision')",
    [ordinaryDraftId]);
  assert.deepEqual(ordinaryEvents.map(item => item.action), ['approved']);
  const ordinaryReservations = await databaseQuery(context, 'SELECT id,status,wellness_draft_id FROM reservations WHERE wellness_draft_id=?', [ordinaryDraftId]);
  assert.equal(ordinaryReservations.length, 1);
  assert.equal(ordinaryReservations[0].status, 'confirmed');

  const draftId = await seedDraft(context, user.guest.id, { version: 2, date: stay.start, slotId: oldSlot, title: '修订前活动' });
  const itemId = (await databaseQuery(context, 'SELECT id FROM wellness_draft_items WHERE draft_id=? LIMIT 1', [draftId], 'get')).id;
  const revised = assertStatus(await api(context, `/staff/therapy-drafts/${draftId}/revisions`, { method: 'PUT', token: user.clinician.token,
    headers: { 'Idempotency-Key': 'q22:revision:approve:0001' }, body: { version: 2, reason: '调整服务时间和场地，保留修订记录。',
      edits: [{ itemId, slotId: newSlot, reason: '改为室内时段，避开原活动时间。' }] } }), 200, 'Q22.7 create revision');
  const revisionReplay = assertStatus(await api(context, `/staff/therapy-drafts/${draftId}/revisions`, { method: 'PUT', token: user.clinician.token,
    headers: { 'Idempotency-Key': 'q22:revision:approve:0001' }, body: { version: 2, reason: '调整服务时间和场地，保留修订记录。',
      edits: [{ itemId, slotId: newSlot, reason: '改为室内时段，避开原活动时间。' }] } }), 200, 'Q22.7 replay revision');
  assert.equal(revisionReplay.draftId, revised.draftId, 'revision replay returns the original version');
  assert.equal(revisionReplay.replayed, true);
  const changedRevisionReplay = await api(context, `/staff/therapy-drafts/${draftId}/revisions`, { method: 'PUT', token: user.clinician.token,
    headers: { 'Idempotency-Key': 'q22:revision:approve:0001' }, body: { version: 2, reason: '替换为不同原因。',
      edits: [{ itemId, slotId: newSlot, reason: '改为室内时段，避开原活动时间。' }] } });
  assert.equal(changedRevisionReplay.status, 409, 'reused revision key with changed content is rejected');
  const revisionEvents = await databaseQuery(context, "SELECT id,draft_id,actor_role,action,reason,from_version,to_version,payload_json FROM wellness_review_events WHERE draft_id=? AND action='revision'",
    [revised.draftId], 'get');
  assert.equal(revisionEvents.action, 'revision');
  assert.equal(revisionEvents.actor_role, 'clinician');
  assert.equal(Number(revisionEvents.from_version), 2);
  assert.equal(Number(revisionEvents.to_version), 3);
  const revisionPayload = parseJsonColumn(revisionEvents.payload_json, {});
  assert.equal(revisionPayload.supersedesDraftId, draftId);
  assert.equal(revisionPayload.correction, false);
  const pendingDetail = assertStatus(await api(context, `/staff/therapy-drafts/${revised.draftId}`, { token: user.clinician.token }),
    200, 'Q22.7 revised pending detail');
  assert.equal(pendingDetail.approvalAction, 'approved_after_revision');
  assert.equal(pendingDetail.approvalContext.revisionEventId, revisionEvents.id);
  assert.equal(pendingDetail.approvalContext.supersedesDraftId, draftId);
  assert.equal(pendingDetail.approvalContext.fromVersion, 2);
  assert.equal(pendingDetail.approvalContext.toVersion, 3);
  const approvalKey = 'q22:approve:revision:0001';
  const approved = assertStatus(await clinicianAction(context, user.clinician, revised.draftId, 'approve', { version: 3 }, approvalKey),
    200, 'Q22.7 approve revised version');
  assert.equal(approved.reviewStatus, 'active');
  assert.equal(approved.approvalAction, 'approved_after_revision');
  const revisionApproval = approved.history.filter(event => event.action === 'approved_after_revision');
  assert.equal(revisionApproval.length, 1);
  assert.equal(revisionApproval[0].payload.revisionEventId, revisionEvents.id);
  assert.equal(revisionApproval[0].payload.supersedesDraftId, draftId);
  assert.equal(revisionApproval[0].payload.fromVersion, 2);
  assert.equal(revisionApproval[0].payload.toVersion, 3);
  assert.match(revisionApproval[0].reason, new RegExp(revisionEvents.id));
  assert.match(revisionApproval[0].reason, /调整服务时间/u);
  const approvalReplay = assertStatus(await clinicianAction(context, user.clinician, revised.draftId, 'approve', { version: 3 }, approvalKey),
    200, 'Q22.7 replay revised approval');
  assert.equal(approvalReplay.replayed, true);
  const approvalCounts = await databaseQuery(context, `SELECT action,COUNT(*) AS total FROM wellness_review_events
    WHERE draft_id=? AND action IN ('approved','approved_after_revision') GROUP BY action`, [revised.draftId]);
  assert.equal(Number(approvalCounts.find(event => event.action === 'approved_after_revision')?.total || 0), 1);
  assert.equal(Number(approvalCounts.find(event => event.action === 'approved')?.total || 0), 0);
  const rows = await databaseQuery(context, 'SELECT id,status,wellness_draft_id,wellness_draft_item_id FROM reservations WHERE wellness_draft_id=?', [revised.draftId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'confirmed');
  assert.ok(rows[0].wellness_draft_item_id);
  const guestReadback = assertStatus(await api(context, `/me/therapy-drafts/${revised.draftId}`, { token: user.guest.token }),
    200, 'Q22.7 guest sees active revised plan');
  assert.equal(guestReadback.version, 3);
  assert.equal(guestReadback.reviewStatus, 'active');
  const revisedVersionRows = await databaseQuery(context, 'SELECT id,version FROM wellness_drafts WHERE review_thread_id=? ORDER BY version', [draftId]);
  assert.deepEqual(revisedVersionRows.map(row => Number(row.version)), [2, 3],
    'approval replay does not create another draft version in the review thread');
  const history = assertStatus(await api(context, `/staff/therapy-review-history?guestId=${user.guest.id}&action=approved_after_revision`,
    { token: user.clinician.token }), 200, 'Q22.7 revised-approval history filter');
  assert.equal(history.total, 1);
  assert.equal(history.items[0].draftId, revised.draftId);
  assert.equal(history.items[0].payload.revisionEventId, revisionEvents.id);

  const regeneratedSourceId = await seedDraft(context, user.guest.id, { version: 4, date: stay.start, slotId: unsafeSlot,
    title: '待重新生成的海水浴', reason: 'R2：皮肤有开放性伤口时排除海水浴。' });
  const returnReason = 'R2：皮肤有开放性伤口时必须排除海水浴；请客人重新生成。';
  assertStatus(await clinicianAction(context, user.clinician, regeneratedSourceId, 'return', { version: 4, reason: returnReason },
    'q22:guest-regeneration:return:0001'), 200, 'Q22.7 return source before guest regeneration');
  const generatedResponse = await api(context, '/me/therapy-drafts', { method: 'POST', token: user.guest.token,
    headers: { 'Idempotency-Key': 'q22:guest-regeneration:create:0001' }, body: { regenerateFromDraftId: regeneratedSourceId } });
  if (generatedResponse.status !== 201) {
    const recentRuns = await databaseQuery(context, `SELECT id,parent_run_id AS parentRunId,agent_id AS agentId,status,error_code AS errorCode,
      execution_mode AS executionMode FROM agent_runs WHERE actor_id=? ORDER BY created_at DESC,id DESC LIMIT 8`, [user.guest.id], 'all');
    const runIds = recentRuns.map(row => row.id);
    const placeholders = runIds.map(() => '?').join(',');
    const steps = runIds.length ? await databaseQuery(context, `SELECT run_id AS runId,step_index AS stepIndex,step_type AS type,status,
      error_code AS errorCode,summary FROM agent_steps WHERE run_id IN (${placeholders}) ORDER BY run_id,step_index`, runIds, 'all') : [];
    throw new Error(`Q22.7 guest-owned regeneration HTTP ${generatedResponse.status}: ${JSON.stringify({
      response: generatedResponse.data, recentRuns: recentRuns.map(({ id,parentRunId,agentId,status,errorCode,executionMode }) =>
        ({ id,parentRunId,agentId,status,errorCode,executionMode })),
      steps: steps.map(({ runId,stepIndex,type,status,errorCode }) => ({ runId,stepIndex,type,status,errorCode }))
    })}`);
  }
  const generated = generatedResponse.data;
  assert.equal(generated.supersedesDraftId, regeneratedSourceId);
  assert.equal(generated.version, 5);
  assert.equal(generated.reviewStatus, 'pending_review');
  const generatedDetail = assertStatus(await api(context, `/staff/therapy-drafts/${generated.draftId}`, { token: user.clinician.token }),
    200, 'Q22.7 guest-generated draft detail');
  assert.equal(generatedDetail.approvalAction, 'approved', 'guest regeneration is not a clinician revision');
  assert.equal(generatedDetail.approvalContext, null);
  assert.ok(!generatedDetail.history.some(event => event.action === 'revision' && event.actorRole === 'clinician'),
    'guest-generated version carries no clinician revision event');
  const generatedRevisionEvents = await databaseQuery(context, `SELECT id,actor_id,actor_role,action,from_version,to_version,payload_json
    FROM wellness_review_events WHERE draft_id=? AND action='revision'`, [generated.draftId]);
  assert.equal(generatedRevisionEvents.length, 1, 'guest regeneration keeps its own version-link event');
  assert.equal(generatedRevisionEvents[0].actor_id, user.guest.id);
  assert.equal(generatedRevisionEvents[0].actor_role, 'guest', 'guest regeneration is not recorded as a clinician revision');
  assert.equal(generatedRevisionEvents[0].action, 'revision');
  assert.equal(Number(generatedRevisionEvents[0].from_version), 4);
  assert.equal(Number(generatedRevisionEvents[0].to_version), 5);
  assert.equal(parseJsonColumn(generatedRevisionEvents[0].payload_json, {}).regeneratedFromDraftId, regeneratedSourceId);
  assert.ok(generatedDetail.history.some(event => event.action === 'revision' && event.actorRole === 'guest'),
    'guest history shows who created the regenerated version');
  const generatedApproval = assertStatus(await clinicianAction(context, user.clinician, generated.draftId, 'approve',
    { version: generated.version }, 'q22:guest-regeneration:approve:0001'), 200, 'Q22.7 approve guest-generated version normally');
  assert.equal(generatedApproval.history.find(event => ['approved','approved_after_revision'].includes(event.action))?.action, 'approved');
  const generatedApprovalEvents = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_review_events WHERE draft_id=? AND action='approved_after_revision'",
    [generated.draftId], 'get');
  assert.equal(Number(generatedApprovalEvents.total), 0);

  return { quest: 'Q22.7', scenario: 'ordinary-revised-and-guest-generated-approval-audit', evidence: {
    ordinaryApproval: { draftId: ordinaryDraftId, action: ordinary.approvalAction, reservationId: ordinaryReservations[0].id },
    originalDraftId: draftId, revisedDraftId: revised.draftId, oldSlot, newSlot, approvedStatus: approved.reviewStatus,
    revisionEvent: { id: revisionEvents.id, action: revisionEvents.action, fromVersion: revisionEvents.from_version,
      toVersion: revisionEvents.to_version, reason: revisionEvents.reason },
    revisedApproval: { action: revisionApproval[0].action, eventCountAfterReplay: Number(approvalCounts.find(event => event.action === 'approved_after_revision')?.total || 0),
      replayed: approvalReplay.replayed, reservationId: rows[0].id, guestVersion: guestReadback.version,
      revisionEventId: revisionApproval[0].payload.revisionEventId },
    guestRegeneration: { sourceDraftId: regeneratedSourceId, generatedDraftId: generated.draftId, version: generatedDetail.version,
      supersedesDraftId: generatedDetail.supersedesDraftId, approvalAction: generatedDetail.approvalAction,
      persistedApprovalAction: generatedApproval.history.find(event => ['approved','approved_after_revision'].includes(event.action))?.action,
      guestVersionLinkEvents: generatedRevisionEvents.length, revisionActorRole: generatedRevisionEvents[0].actor_role,
      revisedApprovalEvents: Number(generatedApprovalEvents.total) },
    revisionReplay: { sameDraftId: revisionReplay.draftId, replayed: revisionReplay.replayed, changedContentStatus: changedRevisionReplay.status },
    historyActions: history.items.map(item => item.action) } };
}

async function q228(context, user) {
  const stay = await setStay(context, user.guest.id);
  await setHealth(context, user.guest.id);
  await seedEnvironment(context, stay.start);
  const planSlot = await insertSlot(context, { projectId: 'project-sea-bath', date: stay.start, start: '09:00', end: '10:00' });
  const otherSlot = await insertSlot(context, { projectId: 'project-beach-walk', date: stay.start, start: '16:30', end: '17:30' });
  const otherReservation = assertStatus(await api(context, '/reservations', { method: 'POST', token: user.guest.token,
    headers: { 'Idempotency-Key': 'q22:unrelated:reservation:0001' }, body: { slotId: otherSlot } }), 201, 'Q22.8 unrelated reservation');
  const draftId = await seedDraft(context, user.guest.id, { date: stay.start, slotId: planSlot, title: '待退回海水浴' });
  const returned = assertStatus(await clinicianAction(context, user.clinician, draftId, 'return', { version: 1,
    reason: 'R2：皮肤有开放性伤口，必须排除海水浴；请重新生成并遵守 R2。' }, 'q22:return:r2:0001'), 200, 'Q22.8 return with reason');
  assert.equal(returned.reviewStatus, 'returned');
  assert.match(returned.reviewReason, /R2/u);
  assert.ok(returned.reviewedAt);
  const unrelated = await databaseQuery(context, 'SELECT status,cancellation_reason FROM reservations WHERE id=?', [otherReservation.reservation.id], 'get');
  assert.equal(unrelated.status, 'confirmed', 'returning a plan preserves unrelated bookings');
  assert.equal(unrelated.cancellation_reason, null);
  assert.ok(planSlot);
  return { quest: 'Q22.8', scenario: 'return-and-preserve-unrelated-booking', evidence: { draftId,
    reviewStatus: returned.reviewStatus, reason: returned.reviewReason, reviewedAt: returned.reviewedAt,
    unrelatedReservationId: otherReservation.reservation.id, unrelatedReservationStatus: unrelated.status } };
}

async function q229(context, user, { expectedExecutionMode = 'recorded_fixture' } = {}) {
  const stay = await setStay(context, user.guest.id);
  await setHealth(context, user.guest.id, { skin: '开放性伤口' });
  await seedEnvironment(context, stay.start);
  await insertSlot(context, { projectId: 'project-sea-bath', date: stay.start, start: '09:00', end: '10:00' });
  await insertSlot(context, { projectId: 'project-marine-hot-spring', date: stay.start, start: '10:00', end: '11:00' });
  await insertSlot(context, { projectId: 'project-beach-walk', date: stay.start, start: '07:30', end: '08:30' });
  const threadId = `q22_thread_${crypto.randomUUID().slice(0, 8)}`;
  const rejectedId = await seedDraft(context, user.guest.id, { date: stay.start, slotId: slotId('project-sea-bath', stay.start, '09:00', '10:00'),
    title: '海水浴', threadId, reason: 'R2：因皮肤破损排除海水浴及海泥敷体；请按规则删除该项并引用 R2。' });
  await databaseQuery(context, 'UPDATE wellness_drafts SET review_thread_id=? WHERE id=?', [threadId, rejectedId], 'run');
  assertStatus(await clinicianAction(context, user.clinician, rejectedId, 'return', { version: 1,
    reason: 'R2：因皮肤破损排除海水浴及海泥敷体；请按规则删除该项并引用 R2。' }, 'q22:return:thread:first'), 200, 'Q22.9 first return');
  const generatedResponse = await api(context, '/me/therapy-drafts', { method: 'POST', token: user.guest.token,
    headers: { 'Idempotency-Key': 'q22:regenerate:r2:0001' }, body: { regenerateFromDraftId: rejectedId } });
  if (generatedResponse.status !== 201) {
    const runRows = await databaseQuery(context, 'SELECT id,parent_run_id,agent_id,status,agent_input_json FROM agent_runs ORDER BY created_at DESC LIMIT 20');
    throw new Error(`Q22.9 regeneration failed ${generatedResponse.status}: ${JSON.stringify({ error: generatedResponse.data,
      runs: runRows.map(row => ({ id: row.id, parent: row.parent_run_id, agent: row.agent_id, status: row.status,
        input: typeof row.agent_input_json === 'string' ? JSON.parse(row.agent_input_json) : row.agent_input_json })) })}`);
  }
  const generated = generatedResponse.data;
  assert.equal(generated.evidence?.executionMode, expectedExecutionMode,
    `Q22.9 uses ${expectedExecutionMode} parent model execution`);
  assert.deepEqual(generated.evidence?.regeneration, { draftId: rejectedId, version: 1,
    reason: 'R2：因皮肤破损排除海水浴及海泥敷体；请按规则删除该项并引用 R2。', threadId });
  assert.ok(generated.evidence?.parentRunId && generated.evidence?.domainAgents?.length >= 2,
    'real recorded parent/child source graph is retained');
  assert.ok(generated.evidence.domainAgents.every(agent => agent.executionMode === expectedExecutionMode),
    `Q22.9 child agents use ${expectedExecutionMode} model execution`);
  const rejectedReadback = assertStatus(await api(context, `/me/therapy-drafts/${rejectedId}`, { token: user.guest.token }), 200,
    'Q22.9 rejected version readback');
  assert.equal(rejectedReadback.reviewStatus, 'returned');
  assert.equal(rejectedReadback.reviewReason, 'R2：因皮肤破损排除海水浴及海泥敷体；请按规则删除该项并引用 R2。');
  const regeneratedReadback = assertStatus(await api(context, `/me/therapy-drafts/${generated.draftId}`, { token: user.guest.token }), 200,
    'Q22.9 regenerated version readback');
  assert.equal(regeneratedReadback.version, 2, 'regeneration advances the review thread version');
  assert.equal(regeneratedReadback.supersedesDraftId, rejectedId);
  assert.equal(regeneratedReadback.reviewStatus, 'pending_review');
  const graphReadback = await readbackWellnessGraph(context, user, generated, expectedExecutionMode);
  assert.ok(generated.items.every(item => item.title !== '海水浴' && item.candidateId !== 'project-sea-bath'),
    'regenerated draft does not copy the rejected sea-bath item');
  const childRunIds = generated.evidence.domainAgents.map(agent => agent.runId);
  assert.ok(childRunIds.every(Boolean));
  const secondReturn = await clinicianAction(context, user.clinician, generated.draftId, 'return', { version: generated.version,
    reason: 'R2：再次核对时仍须排除海水浴；请医护复核来源。' }, 'q22:return:thread:second');
  assert.equal(secondReturn.status, 200, `second return should succeed: ${JSON.stringify(secondReturn.data)}`);
  const replay = await clinicianAction(context, user.clinician, generated.draftId, 'return', { version: generated.version,
    reason: 'R2：再次核对时仍须排除海水浴；请医护复核来源。' }, 'q22:return:thread:second');
  assert.equal(replay.status, 200);
  const attention = assertStatus(await api(context, '/staff/therapy-review-attention', { token: user.dean.token }), 200, 'Q22.9 administrator attention');
  const threadAttention = attention.items.filter(item => item.review_thread_id === threadId);
  assert.equal(threadAttention.length, 1, 'two returns produce exactly one deduplicated attention item');
  const events = await databaseQuery(context, "SELECT action,COUNT(*) AS total FROM wellness_review_events WHERE review_thread_id=? GROUP BY action", [threadId]);
  assert.equal(Number(events.find(item => item.action === 'returned')?.total || 0), 2, 'return replay is idempotent');
  return { quest: 'Q22.9', scenario: 'regenerate-from-r2-rejection-and-deduplicate-attention', evidence: {
    rejectedDraftId: rejectedId, regeneratedDraftId: generated.draftId, regeneration: generated.evidence.regeneration,
    parentRunId: generated.evidence.parentRunId, executionMode: generated.evidence.executionMode, graphReadback,
    rejectedReadback: { draftId: rejectedReadback.draftId, version: rejectedReadback.version,
      reviewStatus: rejectedReadback.reviewStatus, reviewReason: rejectedReadback.reviewReason },
    regeneratedReadback: { draftId: regeneratedReadback.draftId, version: regeneratedReadback.version,
      supersedesDraftId: regeneratedReadback.supersedesDraftId, reviewStatus: regeneratedReadback.reviewStatus,
      regenerationReason: regeneratedReadback.evidence.regeneration?.reason },
    childAgents: generated.evidence.domainAgents.map(agent => ({ runId: agent.runId, agentId: agent.agentId,
      executionMode: agent.executionMode, status: agent.status })), childRunIds, itemTitles: generated.items.map(item => item.title),
    returnedEventCount: 2, adminAttentionId: threadAttention[0].id, attentionCount: 1
  } };
}

function safeLiveFailure(error) {
  const text = String(error?.stack || error?.message || error || 'unknown').slice(0, 16_384);
  return { name: String(error?.name || 'Error').slice(0, 48), code: String(error?.code || '').slice(0, 96) || null,
    digest: crypto.createHash('sha256').update(text).digest('hex') };
}

async function runQ229Entry(resourceSession, { liveConfig = null, preflight = false } = {}) {
  activeResourceSession = resourceSession;
  const provider = preflight ? await startRecordedModel(resourceSession) : null;
  const expectedExecutionMode = preflight ? 'recorded_fixture' : 'live';
  const env = preflight
    ? modelEnvironment(provider, { WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '100' })
    : { ...liveConfig, NODE_ENV: 'production', BUSINESS_CLOCK_NOW: fixedInstant,
      ENVIRONMENT_MODE: 'demo', ENVIRONMENT_LIVE: '0', LLM_TIMEOUT_MS: '30000',
      WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '100' };
  let result;
  let progress = preflight ? 'starting-managed-recorded-provider' : 'starting-isolated-sqlite-api';
  try {
    await withDatabaseApi('sqlite', async context => {
      progress = 'seeding-synthetic-r2-returned-draft';
      const user = await users(context);
      progress = preflight ? 'running-recorded-entrypoint-preflight' : 'running-single-live-regeneration-graph';
      result = await q229(context, user, { expectedExecutionMode });
      progress = preflight ? 'checking-preflight-graph-and-business-evidence' : 'checking-live-graph-and-business-evidence';
      const snapshot = await resourceSession.status();
      const activeResources = (snapshot.resources || []).map(item => ({ id: item.id, label: item.label, kind: item.kind,
        role: item.role, pid: item.pid, processStartTime: item.processStartTime, port: item.port, status: item.status }));
      appendEvidence({ quest: 'Q22.9', scenario: preflight ? 'managed-live-entry-preflight' : 'one-shot-live-provider',
        driver: 'sqlite', status: 'PASS', externalModelCalls: preflight ? 0 : undefined,
        evidence: result.evidence, resourcesAtScenarioEnd: activeResources });
    }, { resourceSession, env });
    return { output: [preflight
      ? `Q22.9 managed entry preflight (recorded fixture; no external model): ${JSON.stringify(result.evidence)}`
      : `Q22.9 one-shot live SQLite: ${JSON.stringify(result.evidence)}`] };
  } catch (error) {
    const failure = safeLiveFailure(error);
    try {
      const snapshot = await resourceSession.status();
      const resources = (snapshot.resources || []).map(item => ({ id: item.id, label: item.label, kind: item.kind,
        role: item.role, pid: item.pid, processStartTime: item.processStartTime, port: item.port, status: item.status }));
      appendEvidence({ quest: 'Q22.9', scenario: preflight ? 'managed-live-entry-preflight' : 'one-shot-live-provider',
        driver: 'sqlite', status: preflight ? 'FAIL' : 'BLOCKED', failureStage: progress, failure, resourcesAtFailure: resources });
    } catch { /* the ResourceSession registry remains the primary cleanup evidence */ }
    if (preflight) throw new Error(`Q22.9 managed entry preflight failed at ${progress}; safe diagnostic ${failure.digest}`);
    const blocked = new Error(`Q22.9 one-shot live acceptance stopped at ${progress}; safe diagnostic ${failure.digest}`);
    blocked.stageBlocked = true;
    blocked.code = failure.code;
    throw blocked;
  } finally {
    if (provider) await stopRecordedModel(resourceSession, provider);
  }
}

async function q2210(context, user) {
  const start = dateOffset(today, 1);
  const dates = Array.from({ length: 7 }, (_, offset) => dateOffset(start, offset));
  for (const date of dates) {
    await seedEnvironment(context, date);
    await insertSlot(context, { projectId: 'project-beach-walk', date, start: '07:30', end: '08:30', capacity: 30 });
    await insertSlot(context, { projectId: 'project-beach-walk', date, start: '16:30', end: '17:30', capacity: 30 });
  }
  const sampleMap = draft => draft.items.filter(item => item.candidateId)
    .map(item => `${item.businessDate}:${item.candidateId}:${item.status}`).sort();
  const ordinaryPlans = [];
  for (let index = 0; index < 10; index += 1) {
    const guest = index === 0 ? { id: user.guest.id, username: 'guest_demo' } : await addGuest(context, user.clinician.id);
    const stay = await setStay(context, guest.id, 7, start);
    await setCompleteLowRiskHealth(context, guest.id);
    const loggedIn = index === 0 ? user.guest : assertStatus(await api(context, '/auth/login', { method: 'POST', body: {
      username: guest.username, password: 'guest2026', role: 'guest' } }), 200, `Q22.10 ordinary guest ${index + 1} login`);
    const first = assertStatus(await api(context, '/me/therapy-drafts', { method: 'POST', token: loggedIn.token,
      headers: { 'Idempotency-Key': `q22:sample:${String(index + 1).padStart(2, '0')}:one` }, body: {} }), 201, `Q22.10 ordinary sample ${index + 1} first run`);
    const second = assertStatus(await api(context, '/me/therapy-drafts', { method: 'POST', token: loggedIn.token,
      headers: { 'Idempotency-Key': `q22:sample:${String(index + 1).padStart(2, '0')}:two` }, body: {} }), 201, `Q22.10 ordinary sample ${index + 1} second run`);
    const firstActivityRows = await databaseQuery(context, "SELECT candidate_id,status FROM wellness_draft_items WHERE draft_id=? AND item_type='activity' AND candidate_id IS NOT NULL", [first.draftId]);
    const secondActivityRows = await databaseQuery(context, "SELECT candidate_id,status FROM wellness_draft_items WHERE draft_id=? AND item_type='activity' AND candidate_id IS NOT NULL", [second.draftId]);
    assert.ok(firstActivityRows.length > 0 && secondActivityRows.length > 0, `ordinary plan ${index + 1} has an evaluable activity in both runs`);
    assert.deepEqual(sampleMap(first), sampleMap(second), `ordinary guest ${index + 1} repeats the same date/candidate sample decision`);
    const firstSampled = firstActivityRows.filter(item => item.status === 'sampled_review');
    assert.ok(firstActivityRows.every(item => ['sampled_review', 'pending_review'].includes(item.status)),
      `ordinary guest ${index + 1} follows sampled review policy`);
    ordinaryPlans.push({ guestId: guest.id, stayStart: stay.start, firstDraftId: first.draftId, secondDraftId: second.draftId,
      activityCount: firstActivityRows.length, sampleMap: sampleMap(first), sampledCount: firstSampled.length });
  }
  assert.equal(ordinaryPlans.length, 10, 'the sampling claim uses ten distinct ordinary guest plans');
  assert.ok(ordinaryPlans.reduce((total, plan) => total + plan.sampledCount, 0) > 0,
    'at least one evaluable ordinary activity is actually sampled into review');

  const chronicGuest = await addGuest(context, user.clinician.id);
  await setStay(context, chronicGuest.id, 7, start);
  await setHealth(context, chronicGuest.id, { chronic: ['高血压'], skin: '皮肤完整' });
  const chronicLogin = assertStatus(await api(context, '/auth/login', { method: 'POST', body: { username: chronicGuest.username,
    password: 'guest2026', role: 'guest' } }), 200, 'Q22.10 chronic-risk guest login');
  const chronicDraft = assertStatus(await api(context, '/me/therapy-drafts', { method: 'POST', token: chronicLogin.token,
    headers: { 'Idempotency-Key': 'q22:sample:chronic:one' }, body: {} }), 201, 'Q22.10 chronic forced review');
  const chronicActivities = await databaseQuery(context, "SELECT candidate_id,status FROM wellness_draft_items WHERE draft_id=? AND item_type='activity' AND candidate_id IS NOT NULL", [chronicDraft.draftId]);
  assert.ok(chronicActivities.length > 0, 'chronic risk decision uses an actual evaluable activity');
  assert.ok(chronicActivities.every(item => item.status === 'mandatory_review'), 'chronic-risk activities are always forced to clinician review');
  assert.equal(chronicDraft.reviewStatus, 'pending_review');
  const chronicReservations = await databaseQuery(context, "SELECT id FROM reservations WHERE wellness_draft_id=? AND status='confirmed'", [chronicDraft.draftId]);
  assert.equal(chronicReservations.length, 0, 'chronic forced review does not auto-reserve activity capacity');
  return { quest: 'Q22.10', scenario: 'ten-ordinary-plan-stable-sampling-and-forced-chronic-review', evidence: {
    ordinaryPlanPairs: ordinaryPlans.length, ordinaryPlans,
    chronicDraftId: chronicDraft.draftId, chronicEvaluatedActivities: chronicActivities.length,
    chronicItemStatuses: chronicActivities.map(item => item.status), chronicReservations: chronicReservations.length } };
}

async function q2211(context, user) {
  const stay = await setStay(context, user.guest.id);
  await setHealth(context, user.guest.id);
  await seedEnvironment(context, stay.start);
  const oldSlot = await insertSlot(context, { projectId: 'project-beach-walk', date: stay.start, start: '07:30', end: '08:30' });
  const correctedSlot = await insertSlot(context, { projectId: 'project-marine-hot-spring', date: stay.start, start: '10:00', end: '11:00' });
  const unrelatedSlot = await insertSlot(context, { projectId: 'project-beach-walk', date: stay.start, start: '16:30', end: '17:30' });
  const unrelated = assertStatus(await api(context, '/reservations', { method: 'POST', token: user.guest.token,
    headers: { 'Idempotency-Key': 'q22:correction:unrelated:0001' }, body: { slotId: unrelatedSlot } }), 201, 'Q22.11 unrelated booking');
  const draftId = await seedDraft(context, user.guest.id, { date: stay.start, slotId: oldSlot, title: '待纠正疗程' });
  assertStatus(await clinicianAction(context, user.clinician, draftId, 'approve', { version: 1 }, 'q22:correction:initial:0001'), 200, 'Q22.11 initial activation');
  const itemId = (await databaseQuery(context, 'SELECT id FROM wellness_draft_items WHERE draft_id=? LIMIT 1', [draftId], 'get')).id;
  const correctionBody = { version: 1, reason: '纠正项目时段，原预约仅按旧疗程版本补偿。',
    edits: [{ itemId, slotId: correctedSlot, reason: '医护复核后改为室内项目时段。' }] };
  const correctionKey = 'q22:correction:fix:0001';
  const corrected = assertStatus(await api(context, `/staff/therapy-drafts/${draftId}/correction`, { method: 'POST', token: user.clinician.token,
    headers: { 'Idempotency-Key': correctionKey }, body: correctionBody }), 200, 'Q22.11 correction');
  assert.equal(corrected.reviewStatus, 'active');
  const correctionReplay = assertStatus(await api(context, `/staff/therapy-drafts/${draftId}/correction`, { method: 'POST', token: user.clinician.token,
    headers: { 'Idempotency-Key': correctionKey }, body: correctionBody }), 200, 'Q22.11 replay correction');
  assert.equal(correctionReplay.draftId, corrected.draftId);
  assert.equal(correctionReplay.replayed, true, 'correction retry replays the already activated version');
  const changedCorrectionReplay = await api(context, `/staff/therapy-drafts/${draftId}/correction`, { method: 'POST', token: user.clinician.token,
    headers: { 'Idempotency-Key': correctionKey }, body: { ...correctionBody, reason: '把同一幂等键用于不同修订内容。' } });
  assert.equal(changedCorrectionReplay.status, 409, 'reused correction key with changed content is rejected');
  const oldRows = await databaseQuery(context, 'SELECT id,status,cancellation_reason,wellness_draft_id FROM reservations WHERE wellness_draft_id=?', [draftId]);
  assert.equal(oldRows.length, 1);
  assert.equal(oldRows[0].status, 'cancelled');
  assert.equal(oldRows[0].cancellation_reason, 'wellness_corrected');
  const newRows = await databaseQuery(context, `SELECT r.id,r.status,r.wellness_draft_id,r.wellness_draft_item_id,r.slot_id,
      s.project_id,s.business_date FROM reservations r JOIN activity_slots s ON s.id=r.slot_id
      WHERE r.wellness_draft_id=? AND r.status='confirmed'`, [corrected.draftId]);
  assert.equal(newRows.length, 1);
  assert.equal(newRows[0].project_id, 'project-marine-hot-spring');
  assert.ok(newRows[0].wellness_draft_item_id);
  const unrelatedAfter = await databaseQuery(context, 'SELECT status FROM reservations WHERE id=?', [unrelated.reservation.id], 'get');
  assert.equal(unrelatedAfter.status, 'confirmed');
  const correctionEvent = corrected.history.find(event => event.action === 'corrected');
  assert.ok(correctionEvent?.id, 'correction history exposes its source event ID');
  const notices = await databaseQuery(context, `SELECT id,event_key,message FROM wellness_local_notifications
    WHERE guest_id=? AND source_type='wellness_review_event' AND source_id=?`, [user.guest.id, correctionEvent.id]);
  assert.equal(notices.length, 1, 'correction replay keeps one local notification for its source event');
  assert.ok(notices[0].message.includes('纠正项目时段'));
  const correctedEvents = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_review_events WHERE draft_id=? AND action='corrected'", [corrected.draftId], 'get');
  assert.equal(Number(correctedEvents.total), 1, 'correction replay persists one corrected event');
  const revisedApprovalEvents = await databaseQuery(context, "SELECT COUNT(*) AS total FROM wellness_review_events WHERE draft_id=? AND action='approved_after_revision'", [corrected.draftId], 'get');
  assert.equal(Number(revisedApprovalEvents.total), 0, 'a correction version is not mislabeled as a clinician revision approval');
  assert.ok(corrected.history.some(event => event.action === 'corrected'), 'correction keeps its corrected history action');
  const compensationAudits = await databaseQuery(context, "SELECT COUNT(*) AS total FROM audit_logs WHERE action='reservation.correct' AND target_id=?", [oldRows[0].id], 'get');
  assert.equal(Number(compensationAudits.total), 1, 'only the old reservation associated with this plan receives compensation audit');
  const allScopedReservations = await databaseQuery(context, 'SELECT id,status,wellness_draft_id FROM reservations WHERE guest_id=?', [user.guest.id]);
  assert.equal(allScopedReservations.filter(row => row.wellness_draft_id === draftId && row.status === 'cancelled').length, 1);
  assert.equal(allScopedReservations.filter(row => row.wellness_draft_id === corrected.draftId && row.status === 'confirmed').length, 1);
  assert.ok(allScopedReservations.some(row => row.id === unrelated.reservation.id && row.status === 'confirmed'),
    'the unrelated confirmed booking remains intact after correction replay');
  return { quest: 'Q22.11', scenario: 'version-correction-and-scoped-compensation', evidence: {
    previousDraftId: draftId, correctedDraftId: corrected.draftId, oldReservationId: oldRows[0].id,
    oldReservationStatus: oldRows[0].status, oldCancellationReason: oldRows[0].cancellation_reason,
    newReservation: newRows[0], correctedEvents: Number(correctedEvents.total), compensationAudits: Number(compensationAudits.total),
    correctionReplay: { sameDraftId: correctionReplay.draftId, replayed: correctionReplay.replayed,
      changedContentStatus: changedCorrectionReplay.status },
    newReservationCount: newRows.length, revisedApprovalEvents: Number(revisedApprovalEvents.total), unrelatedReservationId: unrelated.reservation.id, unrelatedStatus: unrelatedAfter.status,
    notificationEventId: notices[0].id, notificationEventKey: notices[0].event_key
  } };
}

async function q2212(context, user) {
  const stay = await setStay(context, user.guest.id);
  const slot = await insertSlot(context, { projectId: 'project-beach-walk', date: stay.start, start: '07:30', end: '08:30' });
  const draftId = await seedDraft(context, user.guest.id, { date: stay.start, slotId: slot });
  assertStatus(await clinicianAction(context, user.clinician, draftId, 'return', { version: 1,
    reason: '历史查询过滤测试：R2 需要再次核对。' }, 'q22:history:return:0001'), 200, 'Q22.12 create history row');
  const clinicianHistory = assertStatus(await api(context, `/staff/therapy-review-history?guestId=${user.guest.id}&action=returned`,
    { token: user.clinician.token }), 200, 'Q22.12 clinician history');
  const revisedApprovalFilter = assertStatus(await api(context,
    `/staff/therapy-review-history?guestId=${user.guest.id}&action=approved_after_revision`, { token: user.clinician.token }),
  200, 'Q22.12 revised-approval action filter');
  assert.equal(revisedApprovalFilter.total, 0, 'new audit action is accepted by the history filter');
  assert.equal(clinicianHistory.total, 1);
  assert.equal(clinicianHistory.items[0].draftId, draftId);
  assert.equal(clinicianHistory.items[0].actorName, '王医生');
  assert.match(clinicianHistory.items[0].reason, /R2/u);
  const adminHistory = assertStatus(await api(context, `/staff/therapy-review-history?guestId=${user.guest.id}&action=returned`,
    { token: user.dean.token }), 200, 'Q22.12 administrator history');
  assert.equal(adminHistory.total, 1);
  await databaseQuery(context, "UPDATE users SET job_type='coach' WHERE id=?", [user.clinician.id], 'run');
  const denied = await api(context, '/staff/therapy-review-history', { token: user.clinician.token });
  assert.equal(denied.status, 403, 'ordinary staff cannot read medical history');
  return { quest: 'Q22.12', scenario: 'filtered-immutable-history-permissions', evidence: {
    draftId, clinicianHistoryCount: clinicianHistory.total, adminHistoryCount: adminHistory.total,
    revisedApprovalFilterCount: revisedApprovalFilter.total,
    actor: clinicianHistory.items[0].actorName, ordinaryStaffStatus: denied.status
  } };
}

const fixtureRunners = {
  'Q22.1': q221, 'Q22.2': q222, 'Q22.3': q223, 'Q22.4': q224, 'Q22.5': q225,
  'Q22.6': q226, 'Q22.7': q227, 'Q22.8': q228, 'Q22.9': q229, 'Q22.10': q2210,
  'Q22.11': q2211, 'Q22.12': q2212
};

export async function run({ questId, live = false, preflight = false, liveConfig = null, resourceSession }) {
  if (!resourceSession) throw new Error('Stage22 requires a managed ResourceSession');
  if (preflight) {
    if (questId !== 'Q22.9' || live) throw new Error('Only Q22.9 supports an offline managed entry preflight');
    return await runQ229Entry(resourceSession, { preflight: true });
  }
  if (live) {
    if (questId !== 'Q22.9' || !liveConfig) throw new Error('Only Q22.9 accepts one approved live-provider run');
    return await runQ229Entry(resourceSession, { liveConfig });
  }
  const runner = fixtureRunners[questId];
  if (!runner) throw new Error(`Unsupported Stage22 Quest: ${questId}`);
  activeResourceSession = resourceSession;
  const env = questId === 'Q22.10'
    ? { WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '50' }
    : questId === 'Q22.9'
      ? { WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '100' }
      : {};
  const callback = async context => {
    const user = await users(context);
    return runner(context, user);
  };
  let result;
  if (['Q22.6', 'Q22.7', 'Q22.9', 'Q22.10'].includes(questId)) {
    result = await withModelBoth(callback, resourceSession, env);
  } else {
    result = await withBoth(callback, resourceSession, env);
  }
  return { output: [`${questId} dual-database fixture: ${JSON.stringify(result.evidence)}`] };
}
