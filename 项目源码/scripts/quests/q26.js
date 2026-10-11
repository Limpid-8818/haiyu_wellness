import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { withBothDatabaseApis, databaseQuery, databaseExec, login } from './q10-helpers.js';
import { runStage26BrowserAcceptance } from '../resources/stage26-browser-acceptance.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixturePath = path.join(projectRoot, 'scripts/quests/fixtures/stage26-model-fixture.js');
const evidencePath = path.join(projectRoot, 'output/resource-audit/stage26-luna-execution-evidence-20261009.jsonl');
let activeEvidencePath = evidencePath;
const baseInstant = '2026-10-09T00:00:00.000Z'; // 08:00 Asia/Shanghai
const today = '2026-10-09';
const tomorrow = '2026-10-10';
let backendPromise;

function appendEvidence(entry) {
  if (entry.quest === 'Q27.lifecycle' && !entry.businessEvidence) {
    const { quest, driver, result, ...businessEvidence } = entry;
    entry = { quest, driver, result, businessEvidence };
  }
  fs.mkdirSync(path.dirname(activeEvidencePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ at: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...entry })}\n`;
  const bytes = Buffer.byteLength(line);
  const current = fs.existsSync(activeEvidencePath) ? fs.statSync(activeEvidencePath).size : 0;
  if (bytes > 48 * 1024 || current + bytes > 8 * 1024 * 1024) throw new Error('Stage26 evidence append exceeds its 8 MiB limit');
  fs.appendFileSync(activeEvidencePath, line, { encoding: 'utf8', mode: 0o600 });
}

function recordQuest(driver, id, details = {}) {
  appendEvidence({ quest: id, driver, result: 'PASS', ...details });
}

function api(context, route, { method = 'GET', token, body, headers = {} } = {}) {
  return fetch(`${context.baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers
  }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async response => {
    let data;
    try { data = await response.json(); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
    return { status: response.status, data };
  });
}

function expect(result, status, label) {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data).slice(0, 1200)}`);
  return result.data;
}

function sqlTime(context, value) { return context.driver === 'mysql' ? value.replace('T', ' ').replace(/Z$/, '') : value; }
function utc(date, time) { return new Date(`${date}T${time}:00+08:00`).toISOString(); }
function slotId(projectId, date, start, end) {
  return `slot_${crypto.createHash('sha256').update(`${projectId}\0${date}\0${start}\0${end}`).digest('hex').slice(0, 32)}`;
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('could not reserve fixture port')));
    });
  });
}

async function waitFixture(resourceSession, resourceId, url) {
  const deadline = Date.now() + 12_000;
  let last = 'not ready';
  while (Date.now() < deadline) {
    const state = (await resourceSession.status()).resources?.find(item => item.id === resourceId);
    if (!state || !['starting', 'running'].includes(state.status)) {
      const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error(`Stage26 model fixture exited before readiness: ${tail.tail || state?.status || 'missing'}`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(800) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Stage26 local model fixture readiness timed out: ${last}`);
}

async function stopFixture(resourceSession, resource) {
  if (!resource) return;
  const status = (await resourceSession.status()).resources?.find(item => item.id === resource.id);
  if (status && ['starting', 'running'].includes(status.status)) {
    const stopped = await resourceSession.stop(resource.id, 'stage26-fixture-complete');
    assert.ok(stopped.ok, `fixture stop succeeded: ${JSON.stringify(stopped)}`);
  }
  const exit = await resourceSession.waitProcess(resource.id, 10_000);
  assert.ok(!exit.timedOut && !exit.unavailable && !['starting', 'running'].includes(exit.status),
    `fixture exact process exited: ${JSON.stringify(exit)}`);
  appendEvidence({ resource: 'stage26-model-fixture', result: 'EXITED', resourceId: resource.id,
    pid: resource.pid, processStartTime: resource.processStartTime, processFingerprint: resource.processFingerprint,
    exitCode: exit.exitCode, signal: exit.signal, status: exit.status, tempDir: resource.tempDir, logPath: resource.logPath });
}

async function seedEnvironment(context, date) {
  const observedAt = baseInstant;
  const demo = makeDemoEnvironment(date, observedAt, DEMO_ENVIRONMENT_LOCATION);
  const payloads = [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]];
  for (const [domain, stationId, payload] of payloads) {
    const snapshotKey = `env:${crypto.createHash('sha256').update(JSON.stringify([DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain])).digest('hex').slice(0, 48)}`;
    const encoded = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(encoded).digest('hex');
    const insert = `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,
       payload_hash,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)`;
    const upsert = context.driver === 'mysql'
      ? ` ON DUPLICATE KEY UPDATE status=VALUES(status),source_name=VALUES(source_name),source_url=VALUES(source_url),
          observed_at=VALUES(observed_at),expires_at=VALUES(expires_at),payload_hash=VALUES(payload_hash),payload_json=VALUES(payload_json),updated_at=VALUES(updated_at)`
      : ` ON CONFLICT(snapshot_key) DO UPDATE SET status=excluded.status,source_name=excluded.source_name,source_url=excluded.source_url,
          observed_at=excluded.observed_at,expires_at=excluded.expires_at,payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`;
    await databaseQuery(context, `${insert}${upsert}`,
      [snapshotKey, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, payload.sourceName || 'Stage26 隔离天气快照',
        payload.sourceUrl || '', sqlTime(context, observedAt), sqlTime(context, '2026-10-16T00:00:00.000Z'), hash, encoded,
        sqlTime(context, observedAt), sqlTime(context, observedAt)], 'run');
  }
}

async function weatherKey(context, date) {
  const row = await databaseQuery(context, `SELECT snapshot_key AS snapshotKey FROM environment_snapshots WHERE target_date=? AND domain='weather'`, [date], 'get');
  assert.ok(row?.snapshotKey, `${context.driver} weather source snapshot exists for ${date}`);
  return row.snapshotKey;
}

async function insertSlot(context, date, start, end, projectId = 'project-sea-bath', capacity = 8) {
  const id = slotId(projectId, date, start, end);
  const stamp = sqlTime(context, baseInstant);
  const sql = `INSERT INTO activity_slots(id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,0,?,?)`;
  const values = [id, projectId, date, sqlTime(context, utc(date, start)), sqlTime(context, utc(date, end)), start, end, capacity, stamp, stamp];
  const upsert = context.driver === 'mysql'
    ? ' ON DUPLICATE KEY UPDATE capacity=VALUES(capacity),is_closed=0'
    : ' ON CONFLICT(id) DO UPDATE SET capacity=excluded.capacity,is_closed=0';
  await databaseQuery(context, `${sql}${upsert}`, values, 'run');
  return { id, projectId, date, start, end };
}

async function createGuest(context, suffix, { name = `阶段26客人${suffix}`, risk = false } = {}) {
  const id = `guest_q26_${suffix}`;
  const username = `q26_${suffix}`;
  const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
  assert.ok(source?.password_hash, `${context.driver} seeded guest password fixture exists`);
  const stamp = sqlTime(context, baseInstant);
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,?,?,'guest',?,'','active',?)`, [id, username, source.password_hash, name, stamp], 'run');
  const inColumn = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const outColumn = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  await databaseQuery(context, `INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,${inColumn},${outColumn},
    chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at)
    VALUES(?,'女','1949-05-01',?,?,?,?,?,'可独立行走',?,0,?)`,
  [id, `Q26-${suffix}`, '2026-10-09', '2026-10-16', JSON.stringify(risk ? ['高血压'] : []), '[]',
    JSON.stringify({ chronic: { status: risk ? 'reported' : 'none', items: risk ? ['高血压'] : [] },
      allergies: { status: 'none', items: [] }, mobility: { status: 'independent' } }), stamp], 'run');
  const result = expect(await api(context, '/auth/login', { method: 'POST', body: { username, password: 'guest2026', role: 'guest' } }), 200,
    `${context.driver} guest fixture login`);
  return { id, username, name, token: result.token };
}

async function createStaff(context, dean, suffix, jobType) {
  const username = `q26_${jobType}_${context.driver}`;
  const created = expect(await api(context, '/dean/staff', { method: 'POST', token: dean.token,
    body: { name: `阶段26${suffix}`, username, phone: '', password: 'Stage26-fixture-pass', jobType } }), 201,
  `${context.driver} create ${jobType} staff`);
  const signed = expect(await api(context, '/auth/login', { method: 'POST', body: { username, password: 'Stage26-fixture-pass', role: 'staff' } }), 200,
    `${context.driver} ${jobType} login`);
  assert.equal(signed.user.id, created.id);
  return { id: created.id, username, name: created.name, jobType, token: signed.token, user: signed.user };
}

async function assignGuest(context, staffId, guestId) {
  const dean = await databaseQuery(context, "SELECT id FROM users WHERE role='dean' LIMIT 1", [], 'get');
  const stamp = sqlTime(context, baseInstant);
  await databaseQuery(context, `INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at) VALUES(?,?,?,NULL,'active',?,?,?)`,
  [staffId, guestId, stamp, dean.id, stamp, stamp], 'run');
}

async function reserve(context, guest, slot, key) {
  return expect(await api(context, '/reservations', { method: 'POST', token: guest.token,
    headers: { 'Idempotency-Key': key }, body: { slotId: slot.id } }), 201, `${context.driver} reserve ${slot.date} ${slot.start}`);
}

async function insertPendingDraft(context, guestId, suffix, { sourceSlotId = null } = {}) {
  const draftId = `wellness_draft_q26_${suffix}`;
  const itemId = `wellness_item_q26_${suffix}`;
  const stamp = sqlTime(context, baseInstant);
  await databaseQuery(context, `INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
     evidence_json,created_at,review_status,review_thread_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,1,?,NULL,?,?,'pending_review','auto',0,?,?,'pending_review',?,NULL,NULL,NULL)`,
  [draftId, guestId, `q26:${draftId}`, today, '2026-10-16', JSON.stringify({ sourceMode: 'stage26_local_fixture', ruleIds: ['R2'], riskCategory: 'allergy' }), stamp, draftId], 'run');
  await databaseQuery(context, `INSERT INTO wellness_draft_items
    (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
     rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
    VALUES(?,?,?,'afternoon','activity','project-sea-bath','海水浴体验计划','14:00','15:00','mandatory_review',?,?,'["R2"]',?,NULL,?)`,
  [itemId, draftId, tomorrow, '存在待核实健康风险，需医护复核。', '东湾体验区',
    JSON.stringify(sourceSlotId ? [{ type: 'project_slot', id: sourceSlotId, label: '实际隔离项目时段' }] : []),
    JSON.stringify({ sourceMode: 'stage26_local_fixture' })], 'run');
  return { draftId, itemId };
}

async function pollRun(context, token, runId, role = 'staff') {
  const deadline = Date.now() + 25_000;
  let run;
  while (Date.now() < deadline) {
    run = expect(await api(context, `/assistant/runs/${encodeURIComponent(runId)}?role=${role}`, { token }), 200, `${context.driver} assistant run readback`);
    if (!['queued', 'running'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`${context.driver} assistant run did not reach a terminal state: ${JSON.stringify(run).slice(0, 1200)}`);
}

async function startAssistant(context, staff, { text, guestId = '', clientRequestId = crypto.randomUUID() }) {
  const started = expect(await api(context, '/assistant/chat', { method: 'POST', token: staff.token,
    headers: { 'Idempotency-Key': clientRequestId }, body: { role: 'staff', text, async: true, clientRequestId, ...(guestId ? { guestId } : {}) } }), 202,
  `${context.driver} start assistant run`);
  return await pollRun(context, staff.token, started.runId);
}

async function runStage27Lifecycle(context, { main, clinician, dietitian }) {
  const profileState = expect(await api(context, '/me/health-profile', { token: main.token }), 200,
    `${context.driver} guest reads their current health profile`);
  const intakeProfile = {
    chronic: { status: 'reported', items: ['高血压（隔离验收自述）'] },
    medications: { status: 'reported', items: [{ originalText: '氨氯地平 5mg', timing: '早餐后' }] },
    allergies: { status: 'none', items: [] },
    dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'assistance', details: '步行需要陪同' },
    sleep: { status: 'unknown', details: '' },
    skin: { status: 'unknown', details: '' },
    audienceTags: { status: 'reported', items: ['首次入住'] }
  };
  const intake = expect(await api(context, '/me/health-intakes', { method: 'POST', token: main.token,
    headers: { 'Idempotency-Key': `q27:${context.driver}:${main.id}:health-intake` },
    body: { profile: intakeProfile, baseProfileVersion: profileState.profileVersion } }), 201,
  `${context.driver} guest submits the same-ID structured health intake`);
  assert.equal(intake.intake.guestId, main.id);
  assert.equal(intake.intake.status, 'pending');
  const intakeReadback = expect(await api(context, '/me/health-profile', { token: main.token }), 200,
    `${context.driver} guest refreshes the pending health profile`);
  assert.ok(intakeReadback.pendingIntakes.some(item => item.id === intake.intake.id));

  let assessment = expect(await api(context, '/me/health-assessment', { token: main.token }), 200,
    `${context.driver} guest resumes the initial assessment`);
  const answers = {
    chronic: { status: 'reported', items: ['高血压'] },
    medications: { status: 'reported', items: [{ originalText: '氨氯地平 5mg', timing: '早餐后' }] },
    allergies: { status: 'none', items: [] },
    dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'assistance', details: '步行需要陪同' },
    skin: { status: 'unknown', details: '' },
    audienceTags: { status: 'reported', items: ['首次入住'] },
    sleep: { status: 'unknown', details: '' }
  };
  for (const [field, answer] of Object.entries(answers)) {
    assessment = expect(await api(context, '/me/health-assessment/answers', { method: 'PUT', token: main.token,
      body: { field, answer, baseVersion: assessment.version } }), 200,
    `${context.driver} guest saves assessment field ${field}`);
  }
  assert.equal(assessment.status, 'completed');
  assert.equal(assessment.progress?.completed, 8);

  const planningInstant = context.businessClockNow || baseInstant;
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: planningInstant,
    LLM_BASE_URL: `${context.fixtureBase}/tools`, LLM_API_KEY: 'stage26-local-fixture-key',
    LLM_MODEL: 'stage26-local-fixture', ASSISTANT_MODEL_SOURCE: 'recorded_fixture', Q21_ACCEPTANCE_HOOKS: '1',
    WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '100' });
  const draft = expect(await api(context, '/me/therapy-drafts', { method: 'POST', token: main.token,
    headers: { 'Idempotency-Key': `q27:${context.driver}:${main.id}:plan` },
    body: { request: '根据当前入住期间、健康初评和海边活动库存生成可审核疗程。' } }), 201,
  `${context.driver} guest creates a plan from the same guest profile and assessment`);
  appendEvidence({ quest: 'Q27.plan-draft', driver: context.driver, result: 'OBSERVED', draftId: draft.draftId,
    guestId: draft.guestId, version: draft.version, reviewStatus: draft.reviewStatus, reviewPolicy: draft.reviewPolicy,
    sourceRunId: draft.sourceRunId, itemCount: draft.items?.length || 0,
    items: (draft.items || []).map(item => ({ id: item.id, businessDate: item.businessDate, slotKey: item.slotKey,
      type: item.type, candidateId: item.candidateId, title: item.title, status: item.status,
      sourceIds: item.sourceIds, mandatoryReasons: item.evidence?.mandatoryReasons || [] })) });
  assert.equal(draft.guestId, main.id);
  assert.ok(draft.items?.length > 0, `${context.driver} generated plan must contain at least one sourced meal or activity item`);
  assert.equal(draft.reviewStatus, 'pending_review', `${context.driver} health risk requires a real clinician review`);
  assert.ok(draft.draftId && draft.version >= 1 && draft.sourceRunId);
  const review = expect(await api(context, `/staff/therapy-drafts/${encodeURIComponent(draft.draftId)}`, { token: clinician.token }), 200,
    `${context.driver} assigned clinician reads the generated same-ID plan`);
  assert.equal(review.guestId, main.id);
  assert.equal(review.reviewStatus, 'pending_review');
  const approval = expect(await api(context, `/staff/therapy-drafts/${encodeURIComponent(draft.draftId)}/approve`, {
    method: 'POST', token: clinician.token,
    headers: { 'Idempotency-Key': `q27:${context.driver}:${draft.draftId}:approve:v${review.version}` },
    body: { version: review.version }
  }), 200, `${context.driver} assigned clinician approves the generated plan`);
  const planReadback = expect(await api(context, `/me/therapy-drafts/${encodeURIComponent(draft.draftId)}`, { token: main.token }), 200,
    `${context.driver} guest refreshes the approved plan`);
  assert.equal(planReadback.draftId, draft.draftId);
  assert.equal(planReadback.guestId, main.id);
  assert.equal(planReadback.reviewStatus, 'active');

  const menu = expect(await api(context, '/meals/menus', { method: 'POST', token: main.token,
    body: { businessDate: '2026-10-12' } }), 201, `${context.driver} guest creates the linked meal menu`);
  const order = expect(await api(context, '/meals/orders', { method: 'POST', token: main.token,
    headers: { 'Idempotency-Key': `q27:${context.driver}:${main.id}:meal-order` },
    body: { menuId: menu.menu.id, businessDate: '2026-10-12', mealType: 'lunch', version: menu.menu.version } }), 201,
  `${context.driver} same-ID guest creates the meal order`);
  const orderBefore = expect(await api(context, '/staff/meals/orders?date=2026-10-12&mealType=lunch', { token: dietitian.token }), 200,
    `${context.driver} assigned dietitian reads the actual order`);
  assert.equal(orderBefore.find(item => item.id === order.order.id)?.guestId, main.id);
  const mealStarted = expect(await api(context, `/staff/meals/orders/${encodeURIComponent(order.order.id)}/status`, {
    method: 'PATCH', token: dietitian.token, body: { status: 'preparing' }
  }), 200, `${context.driver} dietitian starts the same guest order`);
  const preparingReadback = expect(await api(context, '/staff/meals/orders?date=2026-10-12&mealType=lunch', { token: dietitian.token }), 200,
    `${context.driver} dietitian refreshes the preparing order`);
  assert.equal(preparingReadback.find(item => item.id === order.order.id)?.status, 'preparing');
  const mealDelivered = expect(await api(context, `/staff/meals/orders/${encodeURIComponent(order.order.id)}/status`, {
    method: 'PATCH', token: dietitian.token, body: { status: 'delivered' }
  }), 200, `${context.driver} dietitian delivers the same guest order`);
  const deliveredReadback = expect(await api(context, '/staff/meals/orders?date=2026-10-12&mealType=lunch', { token: dietitian.token }), 200,
    `${context.driver} dietitian refreshes the delivered order`);
  assert.equal(deliveredReadback.find(item => item.id === order.order.id)?.status, 'delivered');

  const checkinBusinessDate = '2026-10-12';
  const checkinClockUtc = '2026-10-12T01:05:00.000Z';
  const checkinSlot = await insertSlot(context, checkinBusinessDate, '09:00', '10:00');
  const attendanceReservation = await reserve(context, main, checkinSlot, `q27-${context.driver}-${main.id}-checkin`);
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: checkinClockUtc,
    LLM_BASE_URL: `${context.fixtureBase}/tools`, LLM_API_KEY: 'stage26-local-fixture-key',
    LLM_MODEL: 'stage26-local-fixture', ASSISTANT_MODEL_SOURCE: 'recorded_fixture', Q21_ACCEPTANCE_HOOKS: '1' });
  const checkin = expect(await api(context, `/me/reservations/${encodeURIComponent(attendanceReservation.reservation.id)}/checkin`, {
    method: 'POST', token: main.token, body: {}
  }), 201, `${context.driver} guest checks in when the real business clock reaches the slot`);
  assert.equal(checkin.reservationId, attendanceReservation.reservation.id);
  assert.equal(checkin.businessDate, checkinBusinessDate);
  const checkinList = expect(await api(context, '/me/checkins', { token: main.token }), 200,
    `${context.driver} guest refreshes the attendance list`);
  assert.ok(checkinList.items.some(item => item.reservationId === attendanceReservation.reservation.id && item.checkin?.id === checkin.id));
  const feedback = expect(await api(context, `/me/reservations/${encodeURIComponent(attendanceReservation.reservation.id)}/feedback`, {
    method: 'POST', token: main.token, body: { feeling: 'uncomfortable', note: '阶段27双库验收：活动后不适，要求医护复核。' }
  }), 201, `${context.driver} guest saves feedback after check-in`);
  const feedbackList = expect(await api(context, '/me/checkins', { token: main.token }), 200,
    `${context.driver} guest refreshes feedback by the same reservation ID`);
  const feedbackItem = feedbackList.items.find(item => item.reservationId === attendanceReservation.reservation.id);
  assert.equal(feedbackItem?.feedback?.id, feedback.id);
  const replanList = expect(await api(context, '/me/replanning-events', { token: main.token }), 200,
    `${context.driver} guest refreshes the feedback source list`);
  const replanEvent = replanList.items.find(item => item.sourceType === 'feedback' && item.sourceId === feedback.id);
  assert.ok(replanEvent?.requiresAttention);
  const evaluated = expect(await api(context, `/me/replanning-events/${encodeURIComponent(replanEvent.id)}/evaluate`, {
    method: 'POST', token: main.token, body: {}
  }), 200, `${context.driver} feedback source generates a reviewable candidate plan`);
  assert.equal(evaluated.sourceId, feedback.id);
  assert.ok(evaluated.candidate?.draftId || evaluated.candidateDraftId);
  assert.equal(evaluated.status, 'pending_review');

  const notifications = expect(await api(context, '/me/wellness-notifications', { token: main.token }), 200,
    `${context.driver} guest reads in-app notifications after the linked journey`);
  const notificationItems = notifications.items || [];
  const guestRows = await databaseQuery(context, `SELECT id,guest_id AS guestId,status,review_status AS reviewStatus,version
    FROM wellness_drafts WHERE id=?`, [draft.draftId], 'get');
  const orderRow = await databaseQuery(context, `SELECT id,guest_id AS guestId,status,menu_id AS menuId,
    business_date AS businessDate,menu_version AS menuVersion
    FROM meal_orders WHERE id=?`, [order.order.id], 'get');
  const reservationRow = await databaseQuery(context, `SELECT r.id,r.guest_id AS guestId,r.status,s.id AS slotId,
    s.business_date AS businessDate,s.starts_at AS startsAt,s.ends_at AS endsAt,s.local_start AS localStart,s.local_end AS localEnd
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id WHERE r.id=?`, [attendanceReservation.reservation.id], 'get');
  const checkinRow = await databaseQuery(context, `SELECT id,guest_id AS guestId,reservation_id AS reservationId,
    business_date AS businessDate FROM wellness_checkins WHERE id=?`, [checkin.id], 'get');
  const feedbackRow = await databaseQuery(context, `SELECT id,guest_id AS guestId,reservation_id AS reservationId,
    revision,feeling FROM wellness_feedback WHERE id=?`, [feedback.id], 'get');
  assert.equal(guestRows.guestId, main.id); assert.equal(orderRow.guestId, main.id);
  assert.equal(reservationRow.guestId, main.id); assert.equal(checkinRow.guestId, main.id);
  assert.equal(feedbackRow.guestId, main.id); assert.equal(checkinRow.reservationId, reservationRow.id);
  assert.equal(feedbackRow.reservationId, reservationRow.id);

  appendEvidence({ quest: 'Q27.lifecycle', driver: context.driver, result: 'PASS', executionMode: 'offline_rules_and_local_model_fixture',
    guest: { id: main.id, username: main.username, profileVersion: profileState.profileVersion,
      intakeId: intake.intake.id, intakeRevision: intake.intake.revision, intakeStatus: intake.intake.status,
      intakePendingReadback: true, assessmentVersion: assessment.version, assessmentStatus: assessment.status,
      assessmentCompletedFields: assessment.progress?.completed },
    plan: { id: draft.draftId, guestId: draft.guestId, sourceRunId: draft.sourceRunId, versionBefore: review.version,
      versionAfter: Number(guestRows.version), statusBefore: review.reviewStatus, statusAfter: planReadback.reviewStatus,
      approval: approval.action || approval.reviewStatus || 'approved', databaseReadback: guestRows },
    meal: { menuId: menu.menu.id, menuVersion: menu.menu.version, orderId: order.order.id, guestId: main.id,
      statusBefore: order.order.status, transitions: [mealStarted.order.status, mealDelivered.order.status],
      readbackStatus: deliveredReadback.find(item => item.id === order.order.id)?.status, databaseReadback: orderRow },
    attendance: { reservationId: reservationRow.id, guestId: reservationRow.guestId, slotId: reservationRow.slotId,
      businessDate: reservationRow.businessDate, startsAtUtc: new Date(reservationRow.startsAt).toISOString(),
      endsAtUtc: new Date(reservationRow.endsAt).toISOString(), localStart: reservationRow.localStart, localEnd: reservationRow.localEnd,
      clockBeforeJourneyUtc: planningInstant, clockAtCheckinUtc: checkinClockUtc, clockTimeZone: 'Asia/Shanghai', checkinId: checkin.id,
      checkinBusinessDate: checkin.businessDate, checkinDatabaseReadback: checkinRow,
      feedbackId: feedback.id, feedbackRevision: feedback.revision, feedbackDatabaseReadback: feedbackRow,
      replanEventId: replanEvent.id, candidateDraftId: evaluated.candidate?.draftId || evaluated.candidateDraftId,
      candidateStatus: evaluated.status },
    notifications: notificationItems.map(item => ({ id: item.id, sourceType: item.sourceType, sourceId: item.sourceId })) });
}

async function runDriver(context, resourceSession, fixtureBase, { includeStage27Lifecycle = false } = {}) {
  context.businessClockNow = baseInstant;
  context.fixtureBase = fixtureBase;
  const passes = [];
  const deanLogin = expect(await login(context.baseUrl, 'dean'), 200, `${context.driver} dean login`);
  const dean = { id: deanLogin.user.id, token: deanLogin.token };
  const clinicianLogin = expect(await login(context.baseUrl, 'staff'), 200, `${context.driver} clinician login`);
  const clinician = { id: clinicianLogin.user.id, token: clinicianLogin.token, jobType: clinicianLogin.user.jobType };
  assert.equal(clinician.jobType, 'clinician');
  const coach = await createStaff(context, dean, '教练', 'coach');
  const therapist = await createStaff(context, dean, '理疗师', 'therapist');
  const dietitian = await createStaff(context, dean, '配餐员', 'dietitian');
  const admin = await createStaff(context, dean, '管理员', 'administrator');
  const main = await createGuest(context, 'main', { name: '林海月阶段26', risk: true });
  const other = await createGuest(context, 'other', { name: '陈湾阶段26' });
  const metricsGuest = await createGuest(context, 'metrics', { name: '汇总样本阶段26' });
  await assignGuest(context, clinician.id, main.id);
  await assignGuest(context, coach.id, main.id);
  await assignGuest(context, therapist.id, main.id);
  await assignGuest(context, dietitian.id, main.id);
  await assignGuest(context, clinician.id, metricsGuest.id);
  await insertPendingDraft(context, main.id, `${context.driver}_clinician`);
  for (let offset = 0; offset <= 6; offset += 1) {
    const date = new Date(`${today}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + offset);
    await seedEnvironment(context, date.toISOString().slice(0, 10));
  }
  const noShowSlot = await insertSlot(context, today, '09:00', '10:00');
  const primarySlot = await insertSlot(context, tomorrow, '14:00', '15:00');
  const secondWeatherSlot = await insertSlot(context, tomorrow, '15:00', '16:00');
  const manualHistorySlot = await insertSlot(context, '2026-10-12', '14:00', '15:00');
  const staffCoachSlot = await insertSlot(context, '2026-10-11', '14:00', '15:00');
  const staffDietSlot = await insertSlot(context, '2026-10-11', '15:00', '16:00');
  const staffTherapySlot = await insertSlot(context, '2026-10-11', '10:00', '11:00', 'project-marine-hot-spring');
  const metricsSlot = await insertSlot(context, '2026-10-12', '15:00', '16:00');
  const stamp = sqlTime(context, baseInstant);
  const healthValueColumn = context.driver === 'mysql' ? 'value_text' : 'value';
  await databaseQuery(context, `INSERT INTO health_records(guest_id,record_type,${healthValueColumn},unit,note,recorded_at,recorded_by)
    VALUES(?,'blood_pressure','128/78','mmHg','Stage26 read-only history fixture',?,?)`, [main.id, stamp, clinician.id], 'run');

  // Q26.1 — institutional guest search and role-scoped health history.
  const guestRows = expect(await api(context, `/admin/operations/guests?q=${encodeURIComponent('林海月')}&date=${today}`, { token: dean.token }), 200,
    `${context.driver} operations guest search`);
  const guestRow = guestRows.items.find(item => item.id === main.id);
  assert.ok(guestRow && guestRow.gender === '女' && guestRow.age === 77 && guestRow.roomNo === 'Q26-main'
    && guestRow.status === 'in_house' && guestRow.riskFlags.length > 0, 'guest list includes minimum identity, stay, and risk fields');
  const history = expect(await api(context, `/staff/operations/guests/${main.id}/health-history`, { token: clinician.token }), 200,
    `${context.driver} clinician read-only guest history`);
  assert.equal(history.items[0].note, 'Stage26 read-only history fixture');
  assert.equal((await api(context, `/staff/operations/guests/${main.id}/health-history`, { token: coach.token })).status, 403,
    'service staff cannot access clinical history');
  const adminHistory = expect(await api(context, `/admin/operations/guests/${main.id}/health-history`, { token: dean.token }), 200,
    `${context.driver} administrator health history`);
  assert.equal(adminHistory.items.length, 1);
  recordQuest(context.driver, 'Q26.1', { searchFields: ['gender', 'age', 'roomNo', 'status', 'riskFlags'], clinicianReadOnly: true, serviceRoleDenied: true }); passes.push('Q26.1');

  // Q26.2 — real capacity, order count and closed-slot behavior.
  const first = await reserve(context, main, primarySlot, `q26-${context.driver}-capacity-001`);
  const week = expect(await api(context, `/admin/operations/slots?date=${today}&days=7&projectId=project-sea-bath`, { token: dean.token }), 200,
    `${context.driver} seven-day capacity board`);
  const boardSlot = week.items.find(item => item.id === primarySlot.id);
  assert.equal(Number(boardSlot.booked), 1); assert.equal(Number(boardSlot.remaining), 7);
  const guestSlots = expect(await api(context, `/projects/project-sea-bath/slots?date=${tomorrow}`, { token: main.token }), 200,
    `${context.driver} guest capacity readback`);
  const guestSlot = guestSlots.slots.find(item => item.id === primarySlot.id);
  assert.equal(Number(guestSlot.remaining), Number(boardSlot.remaining));
  const closed = expect(await api(context, `/admin/projects/project-sea-bath/slots/${primarySlot.id}`, { method: 'PATCH', token: dean.token, body: { closed: true } }), 200,
    `${context.driver} close slot`);
  assert.equal(closed.status, 'closed');
  assert.equal((await api(context, `/reservations`, { method: 'POST', token: other.token,
    headers: { 'Idempotency-Key': `q26-${context.driver}-closed-001` }, body: { slotId: primarySlot.id } })).status, 409,
  'closed slot rejects new booking');
  expect(await api(context, `/admin/projects/project-sea-bath/slots/${primarySlot.id}`, { method: 'PATCH', token: dean.token, body: { closed: false } }), 200,
    `${context.driver} reopen slot for weather workflow`);
  recordQuest(context.driver, 'Q26.2', { reservationId: first.reservation.id, capacity: Number(boardSlot.capacity), booked: 1, remaining: 7, closedRejectsBooking: true }); passes.push('Q26.2');

  // Q26.3 — daily/project views share the same reservation source and cancelled rows leave active work.
  const manual = await reserve(context, main, manualHistorySlot, `q26-${context.driver}-manual-001`);
  const daily = expect(await api(context, `/admin/operations/reservations?date=2026-10-12&status=active`, { token: dean.token }), 200,
    `${context.driver} daily reservations`);
  const byProject = expect(await api(context, `/admin/operations/reservations?from=2026-10-12&to=2026-10-12&projectId=project-sea-bath&status=active`, { token: dean.token }), 200,
    `${context.driver} project reservations`);
  assert.ok(daily.items.some(item => item.id === manual.reservation.id));
  assert.ok(byProject.items.some(item => item.id === manual.reservation.id));
  expect(await api(context, `/reservations/${manual.reservation.id}`, { method: 'DELETE', token: main.token }), 200, `${context.driver} guest cancellation`);
  const afterCancel = expect(await api(context, `/admin/operations/reservations?date=2026-10-12&status=all`, { token: dean.token }), 200,
    `${context.driver} reservation history`);
  assert.equal(afterCancel.items.find(item => item.id === manual.reservation.id).status, 'cancelled');
  const stillActive = expect(await api(context, `/admin/operations/reservations?date=2026-10-12&status=active`, { token: dean.token }), 200,
    `${context.driver} active reservations after cancellation`);
  assert.ok(!stillActive.items.some(item => item.id === manual.reservation.id));
  recordQuest(context.driver, 'Q26.3', { reservationId: manual.reservation.id, dailyAndProjectViewsMatch: true, cancelledRemovedFromActive: true, historyRetained: true }); passes.push('Q26.3');

  // Q26.4 — no-show is rejected before start, recorded after start, and capacity remains consumed.
  const noShow = await reserve(context, other, noShowSlot, `q26-${context.driver}-no-show-001`);
  assert.equal((await api(context, `/admin/operations/reservations/${noShow.reservation.id}/no-show`, { method: 'POST', token: dean.token, body: {} })).status, 409,
    'no-show cannot be marked before the appointment begins');
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: '2026-10-09T01:01:00.000Z' });
  context.businessClockNow = '2026-10-09T01:01:00.000Z';
  const marked = expect(await api(context, `/admin/operations/reservations/${noShow.reservation.id}/no-show`, { method: 'POST', token: dean.token, body: {} }), 200,
    `${context.driver} after-start no-show`);
  assert.equal(marked.checkinStatus, 'not_attended'); assert.equal(marked.capacityReleased, false);
  const noShowHistory = expect(await api(context, `/admin/operations/reservations?date=${today}&status=history`, { token: dean.token }), 200,
    `${context.driver} no-show history`);
  assert.ok(noShowHistory.items.some(item => item.id === noShow.reservation.id && item.status === 'no_show'));
  const guestSchedule = expect(await api(context, '/schedule', { token: other.token }), 200, `${context.driver} guest schedule no-show`);
  const scheduleItem = guestSchedule.items?.find(item => item.id === noShow.reservation.id || item.reservationId === noShow.reservation.id);
  assert.ok(scheduleItem && scheduleItem.status === 'no_show', 'guest schedule visibly carries no-show status');
  const todayBoard = expect(await api(context, `/admin/operations/slots?date=${today}&days=1&projectId=project-sea-bath`, { token: dean.token }), 200,
    `${context.driver} no-show capacity remains consumed`);
  assert.equal(Number(todayBoard.items.find(item => item.id === noShowSlot.id).booked), 1);
  recordQuest(context.driver, 'Q26.4', { reservationId: noShow.reservation.id, earlyRejected: true, noShowHistory: true, guestScheduleStatus: scheduleItem.status, capacityRetained: true }); passes.push('Q26.4');

  // Q26.5 — two same-snapshot outdoor slots; injected second-write failure rolls back all effects.
  const otherWeather = await reserve(context, other, secondWeatherSlot, `q26-${context.driver}-weather-002`);
  const snapshotKey = await weatherKey(context, tomorrow);
  const preview = expect(await api(context, '/admin/operations/weather-cancellations/preview', { method: 'POST', token: dean.token,
    body: { slotIds: [primarySlot.id, secondWeatherSlot.id], snapshotKey } }), 200, `${context.driver} weather batch preview`);
  assert.equal(preview.totalReservations, 2); assert.equal(preview.snapshot.snapshotKey, snapshotKey);
  assert.deepEqual(preview.affectedReservations.map(item => item.id), [first.reservation.id, otherWeather.reservation.id],
    `${context.driver} preview follows the same ascending slot start order used by the batch processor`);
  assert.ok(preview.affectedReservations[0].localStart < preview.affectedReservations[1].localStart,
    `${context.driver} first reservation is processed before the injected second reservation`);
  const capacityBeforeRollback = expect(await api(context,
    `/admin/operations/slots?date=${tomorrow}&days=1&projectId=${primarySlot.projectId}`, { token: dean.token }), 200,
  `${context.driver} capacity before injected rollback`);
  const bookedBeforeRollback = new Map(capacityBeforeRollback.items.filter(item => [primarySlot.id, secondWeatherSlot.id].includes(item.id))
    .map(item => [item.id, Number(item.booked)]));
  assert.deepEqual([...bookedBeforeRollback.values()], [1, 1]);
  const batchesBeforeRollback = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM stage26_weather_batches', [], 'get')).count);
  const itemsBeforeRollback = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM stage26_weather_batch_items', [], 'get')).count);
  const scheduleAssignmentsBeforeRollback = Number((await databaseQuery(context,
    'SELECT COUNT(*) AS count FROM stage26_staff_slot_assignments WHERE slot_id IN (?,?)', [primarySlot.id, secondWeatherSlot.id], 'get')).count);
  const priorWeatherNotifications = Number((await databaseQuery(context,
    "SELECT COUNT(*) AS count FROM wellness_local_notifications WHERE source_type='weather_cancellation'", [], 'get')).count);
  assert.equal(priorWeatherNotifications, 0, `${context.driver} injected failure starts without prior weather notifications`);
  const triggerName = `stage26_fail_weather_${context.driver}`;
  if (context.driver === 'sqlite') {
    await databaseExec(context, `CREATE TRIGGER ${triggerName} BEFORE INSERT ON stage26_weather_batch_items
      WHEN NEW.reservation_id='${otherWeather.reservation.id}' BEGIN
        SELECT CASE WHEN (SELECT COUNT(*) FROM wellness_local_notifications
          WHERE guest_id='${main.id}' AND source_type='weather_cancellation')<>1
          THEN RAISE(ABORT,'stage26 first reservation notification missing') END;
        SELECT RAISE(ABORT,'stage26 injected second reservation item failure');
      END`);
  } else {
    await databaseExec(context, `CREATE TRIGGER ${triggerName} BEFORE INSERT ON stage26_weather_batch_items FOR EACH ROW
      BEGIN
        DECLARE first_notification_count INT DEFAULT 0;
        IF NEW.reservation_id='${otherWeather.reservation.id}' THEN
          SELECT COUNT(*) INTO first_notification_count FROM wellness_local_notifications
            WHERE guest_id='${main.id}' AND source_type='weather_cancellation';
          IF first_notification_count<>1 THEN
            SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='stage26 first reservation notification missing';
          END IF;
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='stage26 injected second reservation item failure';
        END IF;
      END`);
  }
  let failedBatch;
  try {
    failedBatch = await api(context, '/admin/operations/weather-cancellations', { method: 'POST', token: dean.token,
      headers: { 'Idempotency-Key': `q26-${context.driver}-weather-fail-001` },
      body: { slotIds: [primarySlot.id, secondWeatherSlot.id], snapshotKey, reason: '同一天气快照触发事务回滚验收' } });
  } finally {
    await databaseExec(context, `DROP TRIGGER IF EXISTS ${triggerName}`);
  }
  assert.equal(failedBatch.status, 500, `${context.driver} injected DB failure is visible`);
  const afterRollback = await databaseQuery(context, `SELECT id,status FROM reservations WHERE id IN (?,?) ORDER BY id`,
    [first.reservation.id, otherWeather.reservation.id], 'all');
  assert.equal(afterRollback.length, 2); assert.ok(afterRollback.every(row => row.status === 'confirmed'));
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM stage26_weather_batches', [], 'get')).count), batchesBeforeRollback,
    `${context.driver} failed batch header rolled back`);
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM stage26_weather_batch_items', [], 'get')).count), itemsBeforeRollback,
    `${context.driver} first batch item rolled back`);
  assert.equal(Number((await databaseQuery(context, "SELECT COUNT(*) AS count FROM wellness_local_notifications WHERE source_type='weather_cancellation'", [], 'get')).count), priorWeatherNotifications,
    `${context.driver} first notification rolled back`);
  const capacityAfterRollback = expect(await api(context,
    `/admin/operations/slots?date=${tomorrow}&days=1&projectId=${primarySlot.projectId}`, { token: dean.token }), 200,
  `${context.driver} capacity after injected rollback`);
  assert.deepEqual(new Map(capacityAfterRollback.items.filter(item => [primarySlot.id, secondWeatherSlot.id].includes(item.id))
    .map(item => [item.id, Number(item.booked)])), bookedBeforeRollback, `${context.driver} capacity is unchanged after rollback`);
  assert.equal(Number((await databaseQuery(context,
    'SELECT COUNT(*) AS count FROM stage26_staff_slot_assignments WHERE slot_id IN (?,?)', [primarySlot.id, secondWeatherSlot.id], 'get')).count),
    scheduleAssignmentsBeforeRollback, `${context.driver} staff schedule assignments are unchanged after rollback`);
  const committed = expect(await api(context, '/admin/operations/weather-cancellations', { method: 'POST', token: dean.token,
    headers: { 'Idempotency-Key': `q26-${context.driver}-weather-ok-001` },
    body: { slotIds: [primarySlot.id, secondWeatherSlot.id], snapshotKey, reason: '隔离天气快照触发活动调整' } }), 201,
  `${context.driver} successful atomic weather batch`);
  assert.equal(committed.cancelledCount, 2); assert.equal(committed.items.filter(item => item.notificationId).length, 2);
  const replayed = expect(await api(context, '/admin/operations/weather-cancellations', { method: 'POST', token: dean.token,
    headers: { 'Idempotency-Key': `q26-${context.driver}-weather-ok-001` },
    body: { slotIds: [primarySlot.id, secondWeatherSlot.id], snapshotKey, reason: '隔离天气快照触发活动调整' } }), 200,
  `${context.driver} weather batch replay`);
  assert.equal(replayed.replayed, true);
  assert.equal(Number((await databaseQuery(context, "SELECT COUNT(*) AS count FROM wellness_local_notifications WHERE source_type='weather_cancellation'", [], 'get')).count), 2);
  recordQuest(context.driver, 'Q26.5', { sourceSnapshot: snapshotKey, processingOrder: preview.affectedReservations.map(item => item.id),
    injectedSecondReservationId: otherWeather.reservation.id, firstReservationNotificationVisibleBeforeInjection: true,
    rollback: { reservations: 'confirmed', batches: batchesBeforeRollback, batchItems: itemsBeforeRollback,
      notifications: priorWeatherNotifications, capacityUnchanged: true, scheduleAssignmentsUnchanged: true },
    committedNotifications: 2, replayDidNotDuplicate: true }); passes.push('Q26.5');

  // Q26.6 — current policy/capacity produce alternatives; explicit guest confirmation links the orders.
  const candidates = expect(await api(context, `/reservations/${first.reservation.id}/reschedule-candidates`, { token: main.token }), 200,
    `${context.driver} weather reschedule candidates`);
  const candidate = candidates.candidates.find(item => item.projectId === primarySlot.projectId && Number(item.remaining) > 0);
  assert.ok(candidate, `${context.driver} one safe, available same-project alternative exists`);
  assert.ok(candidate.reason || candidate.safety || candidate.environmentSnapshotId, 'candidate carries a policy/environment reason');
  const moved = expect(await api(context, `/reservations/${first.reservation.id}/reschedule`, { method: 'POST', token: main.token,
    headers: { 'Idempotency-Key': `q26-${context.driver}-reschedule-001` }, body: { slotId: candidate.id } }), 201,
  `${context.driver} explicit reschedule confirmation`);
  assert.equal(moved.previousReservationId, first.reservation.id); assert.ok(moved.newReservationId);
  const movedReplay = expect(await api(context, `/reservations/${first.reservation.id}/reschedule`, { method: 'POST', token: main.token,
    headers: { 'Idempotency-Key': `q26-${context.driver}-reschedule-001` }, body: { slotId: candidate.id } }), 200,
  `${context.driver} reschedule replay`);
  assert.equal(movedReplay.newReservationId, moved.newReservationId);
  const links = await databaseQuery(context, `SELECT previous_reservation_id AS oldId,new_reservation_id AS newId
    FROM stage26_reschedule_links WHERE previous_reservation_id=?`, [first.reservation.id], 'get');
  assert.equal(links.newId, moved.newReservationId);
  assert.equal(Number((await databaseQuery(context, "SELECT COUNT(*) AS count FROM wellness_local_notifications WHERE source_type='weather_reschedule'", [], 'get')).count), 1);
  recordQuest(context.driver, 'Q26.6', { oldReservationId: links.oldId, newReservationId: links.newId, selectedCandidate: candidate.id, explicitConfirmation: true, notificationCreated: true }); passes.push('Q26.6');

  // Q26.7/Q26.8 — operational assignments and scoped schedules share bookings; meal-prep uses the live order source.
  const coachAssigned = expect(await api(context, `/admin/operations/slots/${staffCoachSlot.id}/assignments`, { method: 'POST', token: dean.token,
    body: { staffId: coach.id, jobType: 'coach' } }), 201, `${context.driver} coach slot task assignment`);
  const therapistAssigned = expect(await api(context, `/admin/operations/slots/${staffTherapySlot.id}/assignments`, { method: 'POST', token: dean.token,
    body: { staffId: therapist.id, jobType: 'therapist' } }), 201, `${context.driver} therapist slot task assignment`);
  const dietitianAssigned = expect(await api(context, `/admin/operations/slots/${staffDietSlot.id}/assignments`, { method: 'POST', token: dean.token,
    body: { staffId: dietitian.id, jobType: 'dietitian' } }), 201, `${context.driver} dietitian slot task assignment`);
  const coachBooking = await reserve(context, main, staffCoachSlot, `q26-${context.driver}-coach-001`);
  const dietBooking = await reserve(context, other, staffDietSlot, `q26-${context.driver}-dietitian-001`);
  const coachSchedule = expect(await api(context, '/staff/schedule?date=2026-10-11', { token: coach.token }), 200, `${context.driver} coach daily schedule`);
  assert.ok(coachSchedule.items.some(item => item.slotId === staffCoachSlot.id && item.reservationId === coachBooking.reservation.id
    && item.projectName && item.guestName && item.localStart === '14:00' && item.jobType === 'coach'));
  assert.ok(!JSON.stringify(coachSchedule).includes('磺胺类') && !JSON.stringify(coachSchedule).includes('health'));
  const therapistSchedule = expect(await api(context, '/staff/schedule?date=2026-10-11', { token: therapist.token }), 200, `${context.driver} therapist daily schedule`);
  assert.ok(therapistSchedule.items.some(item => item.slotId === staffTherapySlot.id && item.jobType === 'therapist'));
  const coachCapabilities = expect(await api(context, '/me/capabilities', { token: coach.token }), 200, `${context.driver} coach role capabilities`);
  assert.equal(coachCapabilities.medicalAdvicePublish, false);
  assert.equal((await api(context, `/staff/operations/guests/${main.id}/health-history`, { token: coach.token })).status, 403);
  recordQuest(context.driver, 'Q26.7', { assigned: [coachAssigned.id, therapistAssigned.id, dietitianAssigned.id], coachTask: coachBooking.reservation.id, serviceRoleHealthDenied: true }); passes.push('Q26.7');

  await assignGuest(context, dietitian.id, other.id);
  const menu = expect(await api(context, '/meals/menus', { method: 'POST', token: other.token, body: { businessDate: '2026-10-11' } }), 201,
    `${context.driver} generate source meal menu`);
  const order = expect(await api(context, '/meals/orders', { method: 'POST', token: other.token,
    headers: { 'Idempotency-Key': `q26-${context.driver}-meal-001` },
    body: { menuId: menu.menu.id, businessDate: '2026-10-11', mealType: 'lunch', version: menu.menu.version } }), 201,
  `${context.driver} guest meal order`);
  const mealOrders = expect(await api(context, '/staff/meals/orders?date=2026-10-11&mealType=lunch', { token: dietitian.token }), 200,
    `${context.driver} dietitian order list`);
  assert.ok(mealOrders.some(item => item.id === order.order.id && item.guestId === other.id && item.guestName === other.name));
  recordQuest(context.driver, 'Q26.8', { dietitianTask: dietitianAssigned.id, sourceOrderId: order.order.id, sameStatusSource: true }); passes.push('Q26.8');

  // Q26.9 — dashboard metrics are live counts and each drill-down contains the row that changed the count.
  const before = expect(await api(context, `/admin/operations/summary?date=2026-10-12`, { token: dean.token }), 200, `${context.driver} summary before`);
  const beforeCount = Object.fromEntries(before.metrics.map(item => [item.key, Number(item.value)]));
  const metricGuest = await createGuest(context, 'metric_added', { name: '运营新客人阶段26' });
  if (includeStage27Lifecycle) await assignGuest(context, clinician.id, metricGuest.id);
  const metricBooking = await reserve(context, metricGuest, metricsSlot, `q26-${context.driver}-metric-booking`);
  const metricDraft = await insertPendingDraft(context, metricGuest.id, `${context.driver}_metric`,
    includeStage27Lifecycle ? { sourceSlotId: primarySlot.id } : {});
  const after = expect(await api(context, `/admin/operations/summary?date=2026-10-12`, { token: dean.token }), 200, `${context.driver} summary after`);
  const afterCount = Object.fromEntries(after.metrics.map(item => [item.key, Number(item.value)]));
  assert.equal(afterCount.guests, beforeCount.guests + 1); assert.equal(afterCount.reservations, beforeCount.reservations + 1);
  assert.equal(afterCount.pendingReviews, beforeCount.pendingReviews + 1);
  for (const [key, id] of [['guests', metricGuest.id], ['reservations', metricBooking.reservation.id], ['pendingReviews', metricDraft.draftId]]) {
    const detail = expect(await api(context, `/admin/operations/summary?date=2026-10-12&detail=${key}`, { token: dean.token }), 200,
      `${context.driver} ${key} summary drill-down`);
    assert.ok(detail.items.some(item => item.id === id || item.guestId === id), `${key} detail identifies the changed row`);
  }
  recordQuest(context.driver, 'Q26.9', { metricsDelta: { guests: 1, reservations: 1, pendingReviews: 1 }, drillDownsMatchRows: true }); passes.push('Q26.9');

  // Q26.10 — actual provider failures become one incident at threshold, then success recovers it.
  const provider = new URL(fixtureBase).host;
  const failureBase = `${fixtureBase}/fail`;
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: context.businessClockNow, LLM_BASE_URL: failureBase,
    LLM_API_KEY: 'stage26-local-fixture-key', LLM_MODEL: 'stage26-local-fixture', OPERATIONS_FAILURE_THRESHOLD: '3' });
  for (let index = 1; index <= 3; index += 1) {
    const failed = await startAssistant(context, admin, { text: `核对运营服务状态失败验收 ${index}` });
    assert.equal(failed.status, 'failed', `provider failure ${index} yields a failed real run`);
    const incidents = expect(await api(context, '/admin/operations/incidents', { token: dean.token }), 200, `${context.driver} incidents after failure ${index}`);
    assert.equal(incidents.items.filter(item => item.supplier === '127.0.0.1' && item.feature === 'assistant.chat').length, index < 3 ? 0 : 1);
  }
  const openIncident = (await api(context, '/admin/operations/incidents', { token: dean.token })).data.items.find(item => item.supplier === '127.0.0.1' && item.feature === 'assistant.chat');
  assert.ok(openIncident?.firstFailedAt && openIncident.lastFailedAt && openIncident.impactSummary);
  assert.equal((await api(context, '/admin/operations/incidents/close', { method: 'POST', token: dean.token,
    body: { supplier: provider.split(':')[0], feature: 'assistant.chat' } })).status, 409, 'incident cannot close before recovery');
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: context.businessClockNow, LLM_BASE_URL: `${fixtureBase}/success`,
    LLM_API_KEY: 'stage26-local-fixture-key', LLM_MODEL: 'stage26-local-fixture', OPERATIONS_FAILURE_THRESHOLD: '3' });
  const recoveredRun = await startAssistant(context, admin, { text: '恢复后的运营工作状态' });
  assert.equal(recoveredRun.status, 'completed');
  const recovered = expect(await api(context, '/admin/operations/incidents', { token: dean.token }), 200, `${context.driver} recovered incident`);
  assert.ok(recovered.items.find(item => item.supplier === '127.0.0.1' && item.feature === 'assistant.chat')?.recoveredAt);
  const closedIncident = expect(await api(context, '/admin/operations/incidents/close', { method: 'POST', token: dean.token,
    body: { supplier: provider.split(':')[0], feature: 'assistant.chat' } }), 200, `${context.driver} close recovered incident`);
  assert.equal(closedIncident.status, 'closed');
  expect(await api(context, `/admin/operations/summary?date=2026-10-12`, { token: dean.token }), 200, `${context.driver} other operations remain available`);
  recordQuest(context.driver, 'Q26.10', { provider: '127.0.0.1', feature: 'assistant.chat', threshold: 3,
    failures: 3, incidentRows: 1, recoveryObserved: true, closeRequiresRecovery: true, otherOperationsAvailable: true }); passes.push('Q26.10');

  // Q26.11/Q26.12 — real assistant runs invoke role-filtered read-only tools with source IDs.
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: context.businessClockNow, LLM_BASE_URL: `${fixtureBase}/tools`,
    LLM_API_KEY: 'stage26-local-fixture-key', LLM_MODEL: 'stage26-local-fixture', OPERATIONS_FAILURE_THRESHOLD: '3' });
  const adviceBefore = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM medical_advice WHERE guest_id=?', [main.id], 'get')).count);
  const clinicalRun = await startAssistant(context, clinician, { guestId: main.id, text: '请读取当前客人的本周待审方案、风险摘要和规则编号。' });
  assert.equal(clinicalRun.status, 'completed');
  assert.match(clinicalRun.reply, new RegExp(`wellness_draft_q26_${context.driver}_clinician`));
  assert.match(clinicalRun.reply, /R2/);
  const toolRows = await databaseQuery(context, `SELECT tool_name AS name,status,error_code AS errorCode FROM tool_executions
    WHERE run_id=? ORDER BY started_at`, [clinicalRun.runId], 'all');
  assert.ok(toolRows.some(item => item.name === 'search_staff_review_context' && item.status === 'completed'));
  const deniedRun = await startAssistant(context, coach, { guestId: main.id, text: '查询这位客人的待审疗程和风险规则。' });
  const deniedTools = await databaseQuery(context, `SELECT tool_name AS name,status,error_code AS errorCode FROM tool_executions
    WHERE run_id=? ORDER BY started_at`, [deniedRun.runId], 'all');
  assert.ok(!deniedTools.some(item => item.name === 'search_staff_review_context' && item.status === 'completed'));
  assert.ok(!deniedRun.reply.includes('磺胺类') && !deniedRun.reply.includes(`wellness_draft_q26_${context.driver}_clinician`));
  recordQuest(context.driver, 'Q26.11', { runId: clinicalRun.runId, draftSourceId: `wellness_draft_q26_${context.driver}_clinician`, ruleId: 'R2', toolName: 'search_staff_review_context', clinicianScoped: true, unauthorizedServiceDenied: true }); passes.push('Q26.11');

  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: context.businessClockNow, LLM_BASE_URL: `${fixtureBase}/tools`,
    LLM_API_KEY: 'stage26-local-fixture-key', LLM_MODEL: 'stage26-local-fixture', OPERATIONS_FAILURE_THRESHOLD: '3',
    STAGE26_FIXTURE_PROJECT_ID: 'project-sea-bath', STAGE26_FIXTURE_DATE: tomorrow });
  const opsRun = await startAssistant(context, admin, { text: '明天下午海水浴还剩几个名额？' });
  assert.equal(opsRun.status, 'completed'); assert.match(opsRun.reply, /project-sea-bath|slot_/); assert.match(opsRun.reply, /余量/);
  const opsTools = await databaseQuery(context, `SELECT tool_name AS name,status FROM tool_executions WHERE run_id=?`, [opsRun.runId], 'all');
  assert.ok(opsTools.some(item => item.name === 'search_operations_capacity' && item.status === 'completed'));
  const expectedBoard = expect(await api(context, `/admin/operations/slots?date=${tomorrow}&days=1&projectId=project-sea-bath`, { token: dean.token }), 200,
    `${context.driver} assistant capacity source cross-check`);
  const sourceSlot = expectedBoard.items.find(item => item.id === primarySlot.id);
  assert.ok(opsRun.reply.includes(primarySlot.id) || opsRun.reply.includes(expectedBoard.items[0]?.id));
  assert.ok(opsRun.reply.includes(String(sourceSlot.remaining)));
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM medical_advice WHERE guest_id=?', [main.id], 'get')).count), adviceBefore,
    'assistant read-only runs do not publish medical advice');
  recordQuest(context.driver, 'Q26.12', { runId: opsRun.runId, toolName: 'search_operations_capacity', date: tomorrow,
    projectId: 'project-sea-bath', sourceSlotId: expectedBoard.items[0]?.id, remaining: Number(expectedBoard.items[0]?.remaining), readOnly: true,
    medicalAdviceUnchanged: adviceBefore }); passes.push('Q26.12');

  // Q26.13 — assistant text stays a client-side editable draft until the existing clinician publish endpoint is submitted.
  const adviceCreated = expect(await api(context, `/staff/guests/${main.id}/advice`, { method: 'POST', token: clinician.token,
    body: { title: '阶段26医护草稿标题', content: clinicalRun.reply, priority: 'normal' } }), 201,
  `${context.driver} explicit clinician publish of edited assistant draft`);
  const adviceAfter = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM medical_advice WHERE guest_id=?', [main.id], 'get')).count);
  assert.equal(adviceAfter, adviceBefore + 1);
  const guestAdvice = expect(await api(context, '/me/advice', { token: main.token }), 200, `${context.driver} guest advice readback`);
  const published = (Array.isArray(guestAdvice) ? guestAdvice : guestAdvice.items || [])
    .find(item => Number(item.id) === adviceCreated.id);
  assert.ok(published && published.authorName && published.createdAt);
  assert.match(published.content, /不会自动批准/);
  recordQuest(context.driver, 'Q26.13', { adviceId: adviceCreated.id, clinicianPublisher: clinician.id,
    createdAt: published.createdAt, authorName: published.authorName, guestVisible: true, explicitSubmitRequired: true }); passes.push('Q26.13');
  if (includeStage27Lifecycle) {
    await runStage27Lifecycle(context, { main, clinician, dietitian });
  }
  assert.deepEqual(passes, Array.from({ length: 13 }, (_, index) => `Q26.${index + 1}`));
}

async function backendAcceptance(resourceSession, { includeBrowser = true, includeBackend = true, evidenceDestination = evidencePath,
  browserArtifactPrefix = 'stage26', includeStage27Lifecycle = false, browserRunId = null, browserCodeFingerprint = null } = {}) {
  activeEvidencePath = evidenceDestination;
  const port = await availablePort();
  const fixture = await resourceSession.startProcess({ label: 'stage26-local-model-fixture', kind: 'test', role: 'provider-fixture',
    command: process.execPath, args: [fixturePath], cwd: projectRoot, port,
    env: { PATH: process.env.PATH || '', STAGE26_FIXTURE_PORT: String(port), STAGE26_FIXTURE_PROJECT_ID: 'project-sea-bath', STAGE26_FIXTURE_DATE: tomorrow } });
  let fixtureStopped = false;
  const fixtureBase = `http://127.0.0.1:${port}`;
  try {
    await waitFixture(resourceSession, fixture.id, fixtureBase);
    appendEvidence({ resource: 'stage26-local-model-fixture', result: 'STARTED', resourceId: fixture.id, pid: fixture.pid,
      processStartTime: fixture.processStartTime, processFingerprint: fixture.processFingerprint, command: fixture.command,
      tempDir: fixture.tempDir, logPath: fixture.logPath, port });
    if (includeBackend) {
      await withBothDatabaseApis(async context => {
        context.businessClockNow = baseInstant;
        const base = await context.restartApi({ BUSINESS_CLOCK_NOW: baseInstant });
        context.baseUrl = base;
        await runDriver(context, resourceSession, fixtureBase, { includeStage27Lifecycle });
      }, { resourceSession, env: { BUSINESS_CLOCK_NOW: baseInstant } });
    } else appendEvidence({ quest: 'Q26.database', result: 'SKIPPED_FOR_BROWSER_ITERATION' });
    if (!includeBrowser) {
      await stopFixture(resourceSession, fixture); fixtureStopped = true;
      return ['SQLite', 'MySQL', 'Q26.1–Q26.13 each passed through fresh isolated API and database flows.'];
    }
    const browser = await runStage26BrowserAcceptance({ resourceSession, fixtureBase, artifactPrefix: browserArtifactPrefix,
      runId: browserRunId, codeFingerprint: browserCodeFingerprint });
    appendEvidence({ quest: 'Q26.browser', driver: 'SQLite', result: browser.status, evidencePath: browser.evidencePath,
      screenshotDirectory: browser.screenshotDirectory, screenshots: browser.screenshots,
      layout: browser.layout, coachLayout: browser.coachLayout, guestReadback: browser.guestReadback,
      dfBefore: browser.dfBefore, dfAfter: browser.dfAfter });
    await stopFixture(resourceSession, fixture); fixtureStopped = true;
    if (!includeBackend) return browser;
    return ['SQLite', 'MySQL', 'Q26.1–Q26.13 each passed through real API and database flows.',
      `browser business flow, layout, and four screenshots passed (${browser.screenshotDirectory}).`];
  } finally {
    if (!fixtureStopped) await stopFixture(resourceSession, fixture);
  }
}

export async function run({ questId, resourceSession }) {
  if (!resourceSession) throw new Error(`${questId} requires the Stage26 ResourceSession`);
  backendPromise ||= backendAcceptance(resourceSession);
  const output = await backendPromise;
  return { output: [`${questId}: ${output.join(' · ')}`] };
}

export async function runStage27BackendRegression({ resourceSession, evidenceDestination }) {
  if (!resourceSession || typeof evidenceDestination !== 'string') {
    throw new Error('Stage27 backend regression requires a ResourceSession and a separate evidence path');
  }
  return await backendAcceptance(resourceSession, { includeBrowser: false, evidenceDestination, includeStage27Lifecycle: true });
}

export async function runStage27BrowserAcceptance({ resourceSession, evidenceDestination, runId, codeFingerprint }) {
  if (!resourceSession || typeof evidenceDestination !== 'string') {
    throw new Error('Stage27 browser acceptance requires a ResourceSession and a separate evidence path');
  }
  return await backendAcceptance(resourceSession, { includeBrowser: true, includeBackend: false, evidenceDestination,
    browserArtifactPrefix: 'stage27', browserRunId: runId, browserCodeFingerprint: codeFingerprint });
}
