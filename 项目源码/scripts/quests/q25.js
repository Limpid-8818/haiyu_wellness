import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { withBothDatabaseApis, databaseQuery, databaseExec, login, request, runNodeManaged } from './q10-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const evidencePath = path.join(projectRoot, 'output/resource-audit/stage25-luna-execution-evidence-20261009.jsonl');
const initialInstant = '2026-10-06T22:59:00.000Z'; // 2026-10-07 06:59 Asia/Shanghai
const morning = [
  { before: '2026-10-06T22:59:00.000Z', after: '2026-10-06T23:00:00.000Z', date: '2026-10-07' },
  { before: '2026-10-07T22:59:00.000Z', after: '2026-10-07T23:00:00.000Z', date: '2026-10-08' },
  { before: '2026-10-08T22:59:00.000Z', after: '2026-10-08T23:00:00.000Z', date: '2026-10-09' }
];
let backendPromise;
let browserPromise;

function appendEvidence(entry) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ at: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...entry })}\n`;
  const current = fs.existsSync(evidencePath) ? fs.statSync(evidencePath).size : 0;
  if (Buffer.byteLength(line) > 48 * 1024 || current + Buffer.byteLength(line) > 8 * 1024 * 1024) {
    throw new Error('Stage25 execution evidence append would exceed its 8 MiB limit');
  }
  fs.appendFileSync(evidencePath, line, { encoding: 'utf8', mode: 0o600 });
}

async function api(context, route, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${context.baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

function ok(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data).slice(0, 1200)}`);
  return result.data;
}

function sqlTime(context, value) { return context.driver === 'mysql' ? value.replace('T', ' ').replace(/Z$/, '') : value; }
function utc(date, time) { return new Date(`${date}T${time}:00+08:00`).toISOString(); }
function slotId(date, start, end, projectId) {
  return `slot_${crypto.createHash('sha256').update(`${projectId}\0${date}\0${start}\0${end}`).digest('hex').slice(0, 32)}`;
}

function reminderWindow(context, localTime) {
  const start = utc('2026-10-09', localTime);
  const end = new Date(Date.parse(start) + 15 * 60 * 1000).toISOString();
  return { start: sqlTime(context, start), end: sqlTime(context, end) };
}
function normalizeTimestamp(value) {
  const normalized = String(value || '').trim().replace('T', ' ').replace(/Z$/, '');
  const match = normalized.match(/^(.+?)(?:\.(\d+))?$/);
  if (!match) return normalized;
  return `${match[1]}.${(match[2] || '').padEnd(3, '0').slice(0, 3)}`;
}

async function waitForInitialSchedulerTick(context, expectedLocalTime) {
  const deadline = Date.now() + 12_000;
  const marker = '[stage25-scheduler] initial tick completed ';
  let lastState = 'API resource not found';
  let lastTail = '';
  while (Date.now() < deadline) {
    const status = await context.resourceSession.status();
    const apiResource = (status.resources || []).findLast(resource =>
      resource.label === 'quest-api-' + context.driver && resource.status === 'running');
    if (apiResource) {
      const response = await context.resourceSession.rpc({ op: 'log-tail', id: apiResource.id, maxBytes: 4096 });
      lastTail = String(response.tail || '').slice(-4096);
      const line = lastTail.split(/\r?\n/).findLast(value => value.startsWith(marker));
      if (line) {
        const tick = JSON.parse(line.slice(marker.length));
        lastState = { resourceId: apiResource.id, tick };
        if (tick.localTime === expectedLocalTime) return tick;
      } else lastState = { resourceId: apiResource.id, status: apiResource.status, initialTick: 'pending' };
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(context.driver + ' initial scheduler tick did not complete at ' + expectedLocalTime
    + '; state=' + JSON.stringify(lastState) + '; apiLogTail=' + lastTail.slice(-1600));
}

async function reminderSourceRow(context, reservationId) {
  const sql = [
    'SELECT r.id AS reservationId,r.status,s.business_date AS businessDate,',
    's.local_start AS localStart,CAST(s.starts_at AS CHAR) AS storedStartsAt',
    'FROM reservations r JOIN activity_slots s ON s.id=r.slot_id WHERE r.id=?'
  ].join(' ');
  const rows = await databaseQuery(context, sql, [reservationId], 'all');
  return rows[0] || null;
}

async function reminderWindowMatch(context, reservationId, localTime) {
  const window = reminderWindow(context, localTime);
  const sql = [
    'SELECT r.id AS reservationId,r.status,CAST(s.starts_at AS CHAR) AS storedStartsAt',
    'FROM reservations r JOIN activity_slots s ON s.id=r.slot_id',
    "WHERE r.id=? AND r.status='confirmed' AND s.starts_at>? AND s.starts_at<=?"
  ].join(' ');
  const rows = await databaseQuery(context, sql, [reservationId, window.start, window.end], 'all');
  return { window, rows };
}

async function seedEnvironment(context, date, observedAt = initialInstant) {
  const demo = makeDemoEnvironment(date, observedAt, DEMO_ENVIRONMENT_LOCATION);
  const records = [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]];
  for (const [domain, stationId, payload] of records) {
    const key = `env:${crypto.createHash('sha256').update(JSON.stringify([DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain])).digest('hex').slice(0, 48)}`;
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
      [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, payload.sourceName || 'Stage25 本地环境快照',
        payload.sourceUrl || '', sqlTime(context, observedAt), sqlTime(context, '2026-10-16T00:00:00.000Z'), hash, encoded,
        sqlTime(context, observedAt), sqlTime(context, observedAt)], 'run');
  }
}

async function insertSlot(context, date, start, end, projectId) {
  const id = slotId(date, start, end, projectId);
  const values = [id, projectId, date, sqlTime(context, utc(date, start)), sqlTime(context, utc(date, end)), start, end,
    sqlTime(context, initialInstant), sqlTime(context, initialInstant)];
  const statement = `INSERT INTO activity_slots
    (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,5,0,?,?)`;
  if (context.driver === 'mysql') await databaseQuery(context, `${statement} ON DUPLICATE KEY UPDATE capacity=5,is_closed=0`, values, 'run');
  else await databaseQuery(context, `${statement} ON CONFLICT(id) DO UPDATE SET capacity=5,is_closed=0`, values, 'run');
  return { id, projectId, date, start, end };
}

async function createSyntheticGuest(context, { suffix, username, name, checkIn = '2026-10-07', checkOut = '2026-10-14' }) {
  const id = `guest_q25_${suffix}`;
  const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
  assert.ok(source?.password_hash, `${context.driver} demo password fixture exists`);
  const stamp = sqlTime(context, initialInstant);
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,?,?,'guest',?,'','active',?)`, [id, username, source.password_hash, name, stamp], 'run');
  const inColumn = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const outColumn = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  await databaseQuery(context, `INSERT INTO guest_profiles(user_id,room_no,${inColumn},${outColumn},chronic_json,allergies_json,mobility,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`, [id, `Q25-${suffix}`, checkIn, checkOut, '[]', '[]', '可独立行走', stamp], 'run');
  const loggedIn = ok(await api(context, '/auth/login', { method: 'POST', body: { username, password: 'guest2026', role: 'guest' } }),
    200, `${context.driver} synthetic guest login`);
  assert.equal(loggedIn.user.id, id);
  return { id, username, token: loggedIn.token, name };
}

async function createAssignment(context, staffId, guestId) {
  const dean = await databaseQuery(context, "SELECT id FROM users WHERE role='dean' LIMIT 1", [], 'get');
  assert.ok(dean?.id, `${context.driver} demo dean exists`);
  const stamp = sqlTime(context, initialInstant);
  await databaseQuery(context, `INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
    VALUES(?,?,?,NULL,'active',?,?,?)`, [staffId, guestId, stamp, dean.id, stamp, stamp], 'run');
}

async function createReviewDraft(context, guestId, slot) {
  const draftId = `wellness_draft_q25_${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const itemId = `wellness_item_q25_${crypto.randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const at = sqlTime(context, initialInstant);
  await databaseQuery(context, `INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
     evidence_json,created_at,review_status,review_thread_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,1,?,NULL,?,?,'pending_review','auto',0,?,?,'pending_review',?,NULL,NULL,NULL)`,
  [draftId, guestId, `q25-source:${draftId}`, '2026-10-07', '2026-10-14',
    JSON.stringify({ sourceMode: 'stage25_local_fixture', purpose: 'real staff approval and correction acceptance' }), at, draftId], 'run');
  await databaseQuery(context, `INSERT INTO wellness_draft_items
    (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
     rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
    VALUES(?,?,?,'morning','activity',?,'滨海漫步',?,?,'pending_review',?,'海屿服务区（本地验收）','[]',?,NULL,?)`,
  [itemId, draftId, slot.date, slot.projectId, slot.start, slot.end, '阶段25的真实医护审核与提醒验收。',
    JSON.stringify([{ type: 'project_slot', id: slot.id, label: `${slot.date} ${slot.start} 项目时段` }]),
    JSON.stringify({ sourceMode: 'stage25_local_fixture' })], 'run');
  return { draftId, itemId };
}

async function waitForBrief(context, guestId, date, expected) {
  const deadline = Date.now() + 12_000;
  let count = 0;
  while (Date.now() < deadline) {
    count = Number((await databaseQuery(context, `SELECT COUNT(*) AS total FROM daily_briefs
      WHERE guest_id=? AND business_date=?`, [guestId, date], 'get')).total);
    if (count === expected) return count;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert.equal(count, expected, `${context.driver} scheduled brief count for ${guestId} ${date}`);
}

async function waitForBriefCount(context, date, expected) {
  const deadline = Date.now() + 12_000;
  let count = 0;
  while (Date.now() < deadline) {
    count = Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM daily_briefs WHERE business_date=?', [date], 'get')).total);
    if (count === expected) return count;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const instant = morning.find(item => item.date === date)?.after;
  let tickDiagnostic = 'unavailable';
  if (instant) {
    const code = `import { db } from './src/db.js';\nimport { runStage25Tick } from './src/daily-brief.js';\ntry { console.log('Q25_TICK_DIAGNOSTIC='+JSON.stringify(await runStage25Tick(new Date(${JSON.stringify(instant)})))); } finally { await db.close(); }`;
    const result = await runNodeManaged(code, context.dbEnv, context.resourceSession, `q25-${context.driver}-scheduler-diagnostic`);
    const line = result.combined.split(/\r?\n/).findLast(value => value.startsWith('Q25_TICK_DIAGNOSTIC='));
    tickDiagnostic = result.status === 0 && line
      ? line.slice('Q25_TICK_DIAGNOSTIC='.length) : `${result.status}: ${result.combined.slice(-1200)}`;
    appendEvidence({ quest: 'Q25.scheduler-diagnostic', driver: context.driver, businessDate: date,
      status: result.status === 0 && line ? 'DIAGNOSTIC' : 'DIAGNOSTIC_FAILED', tick: tickDiagnostic });
  }
  assert.equal(count, expected, `${context.driver} scheduled guest/day count for ${date}; manual bounded tick diagnostic: ${tickDiagnostic}`);
}

async function runNodeSnapshotProbe(context, scenarios) {
  const code = `import { db } from './src/db.js';\nimport { buildDailyBriefSnapshot } from './src/daily-brief.js';\nconst input=${JSON.stringify(scenarios)};\ntry { const out=[]; for (const item of input) out.push({ key:item.key, brief:await buildDailyBriefSnapshot(item.guestId,item.date) }); console.log('Q25_SOURCE_PROBE='+JSON.stringify(out)); } finally { await db.close(); }`;
  const result = await runNodeManaged(code, context.dbEnv, context.resourceSession, `q25-${context.driver}-source-projection`);
  assert.equal(result.status, 0, `${context.driver} deterministic brief source probe: ${result.combined.slice(-1200)}`);
  const line = result.combined.split(/\r?\n/).findLast(value => value.startsWith('Q25_SOURCE_PROBE='));
  assert.ok(line, `${context.driver} source probe returned its bounded JSON marker: ${result.combined.slice(-1200)}`);
  return JSON.parse(line.slice('Q25_SOURCE_PROBE='.length));
}

async function stage25Driver(context, resourceSession) {
  context.resourceSession = resourceSession;
  const main = await createSyntheticGuest(context, { suffix: `main_${context.driver}`, username: `q25_main_${context.driver}`,
    name: '阶段25客人', checkIn: '2026-10-07', checkOut: '2026-10-14' });
  const other = await createSyntheticGuest(context, { suffix: `other_${context.driver}`, username: `q25_other_${context.driver}`,
    name: '另一位客人', checkIn: '2026-10-07', checkOut: '2026-10-14' });
  const clinician = ok(await login(context.baseUrl, 'staff'), 200, `${context.driver} clinician login`);
  assert.equal(clinician.user.jobType, 'clinician');
  await createAssignment(context, clinician.user.id, main.id);
  for (const date of ['2026-10-09', '2026-10-10', '2026-10-11']) await seedEnvironment(context, date);

  const reminderSlot = await insertSlot(context, '2026-10-09', '16:00', '17:00', 'project-seaside-photography');
  const cancelledSlot = await insertSlot(context, '2026-10-09', '17:00', '18:00', 'project-seaside-photography');
  const approvalSlot = await insertSlot(context, '2026-10-10', '10:00', '11:00', 'project-marine-hot-spring');
  const correctionSlot = await insertSlot(context, '2026-10-10', '11:00', '12:00', 'project-marine-hot-spring');
  const validBooking = ok(await api(context, '/reservations', { method: 'POST', token: main.token,
    headers: { 'Idempotency-Key': `q25-booking-${context.driver}-1600-001` }, body: { slotId: reminderSlot.id } }),
  201, `${context.driver} confirmed 16:00 reservation`);
  const cancelledBooking = ok(await api(context, '/reservations', { method: 'POST', token: main.token,
    headers: { 'Idempotency-Key': `q25-booking-${context.driver}-1700-001` }, body: { slotId: cancelledSlot.id } }),
  201, `${context.driver} reservation to cancel`);
  const cancelled = ok(await api(context, `/reservations/${encodeURIComponent(cancelledBooking.reservation.id)}`,
    { method: 'DELETE', token: main.token }), 200, `${context.driver} cancelled reservation`);
  assert.equal(cancelled.status, 'cancelled');

  const draft = await createReviewDraft(context, main.id, approvalSlot);
  const approved = ok(await api(context, `/staff/therapy-drafts/${encodeURIComponent(draft.draftId)}/approve`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': `q25-approve-${context.driver}-0001` }, body: { version: 1 }
  }), 200, `${context.driver} actual clinician approval`);
  assert.equal(approved.reviewStatus, 'active');
  assert.equal(approved.reservations.length, 1);
  const approvedReplay = ok(await api(context, `/staff/therapy-drafts/${encodeURIComponent(draft.draftId)}/approve`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': `q25-approve-${context.driver}-0001` }, body: { version: 1 }
  }), 200, `${context.driver} repeated approval consume`);
  assert.equal(approvedReplay.replayed, true);
  let approvalNotices = await databaseQuery(context, `SELECT id,source_type AS sourceType,source_id AS sourceId,target_type AS targetType,
      target_id AS targetId,target_url AS targetUrl FROM wellness_local_notifications
    WHERE guest_id=? AND source_type='wellness_review_event' AND source_id=?`, [main.id, approved.eventId], 'all');
  assert.equal(approvalNotices.length, 1, `${context.driver} approval source notification is unique`);

  const corrected = ok(await api(context, `/staff/therapy-drafts/${encodeURIComponent(draft.draftId)}/correction`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': `q25-correct-${context.driver}-0001` },
    body: { version: 1, reason: '阶段25真实纠正路径复核。', edits: [{ itemId: draft.itemId, slotId: correctionSlot.id,
      title: '调整后的滨海漫步', reason: '按客人安排调整时段。' }] }
  }), 200, `${context.driver} actual clinician correction`);
  assert.equal(corrected.reviewStatus, 'active');
  assert.equal(corrected.correctedFromDraftId, draft.draftId);
  const correctionEventId = corrected.eventId;
  const correctionReplay = ok(await api(context, `/staff/therapy-drafts/${encodeURIComponent(draft.draftId)}/correction`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': `q25-correct-${context.driver}-0001` },
    body: { version: 1, reason: '阶段25真实纠正路径复核。', edits: [{ itemId: draft.itemId, slotId: correctionSlot.id,
      title: '调整后的滨海漫步', reason: '按客人安排调整时段。' }] }
  }), 200, `${context.driver} repeated correction consume`);
  assert.equal(correctionReplay.replayed, true);
  const correctionNotices = await databaseQuery(context, `SELECT id,source_type AS sourceType,source_id AS sourceId,target_type AS targetType,
      target_id AS targetId,target_url AS targetUrl FROM wellness_local_notifications
    WHERE guest_id=? AND source_type='wellness_review_event' AND source_id=?`, [main.id, correctionEventId], 'all');
  assert.equal(correctionNotices.length, 1, `${context.driver} correction source notification is unique`);
  const correctionTasks = await databaseQuery(context, `SELECT id,assignee_id AS assigneeId,source_type AS sourceType,source_id AS sourceId,status
    FROM care_follow_up_tasks WHERE guest_id=? AND source_type='wellness_review_event' AND source_id=?`, [main.id, correctionEventId], 'all');
  assert.equal(correctionTasks.length, 1, `${context.driver} correction produces one follow-up task`);
  assert.equal(correctionTasks[0].assigneeId, clinician.user.id);

  const advice = ok(await api(context, `/staff/guests/${encodeURIComponent(main.id)}/advice`, { method: 'POST', token: clinician.token,
    body: { title: '散步前先补水', content: '按医护建议随身携带饮水；此提示来自已发布的个人医嘱。', priority: 'important' }
  }), 201, `${context.driver} actual published advice`);
  const adviceNotice = await databaseQuery(context, `SELECT source_type AS sourceType,source_id AS sourceId,target_url AS targetUrl
    FROM wellness_local_notifications WHERE guest_id=? AND source_type='medical_advice' AND source_id=?`, [main.id, String(advice.id)], 'get');
  assert.equal(adviceNotice?.targetUrl, 'advice');

  const menu = ok(await api(context, '/meals/menus', { method: 'POST', token: main.token,
    body: { businessDate: '2026-10-09' } }), 201, `${context.driver} generated meal menu`);
  const breakfast = ok(await api(context, '/meals/orders', { method: 'POST', token: main.token,
    headers: { 'Idempotency-Key': `q25-meal-${context.driver}-breakfast-001` },
    body: { menuId: menu.menu.id, businessDate: '2026-10-09', mealType: 'breakfast', version: menu.menu.version }
  }), 201, `${context.driver} actual breakfast order`);

  const initialBrief = ok(await api(context, '/me/daily-brief', { token: main.token }), 200, `${context.driver} brief at 06:59`);
  assert.equal(initialBrief.status, 'not_ready', `${context.driver} brief is unavailable before 07:00`);
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: morning[0].after });
  const firstMorning = ok(await api(context, '/me/daily-brief', { token: main.token }), 200, `${context.driver} 07:00 brief`);
  assert.equal(firstMorning.status, 'ready');
  assert.equal(firstMorning.businessDate, morning[0].date);
  const repeatedMorning = ok(await api(context, '/me/daily-brief', { token: main.token }), 200, `${context.driver} repeated 07:00 read`);
  assert.equal(repeatedMorning.id, firstMorning.id);
  let firstBriefRows = Number((await databaseQuery(context, `SELECT COUNT(*) AS total FROM daily_briefs
    WHERE guest_id=? AND business_date=?`, [main.id, morning[0].date], 'get')).total);
  assert.equal(firstBriefRows, 1, `${context.driver} one guest/day row after duplicate request`);

  const createdMoods = [];
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: '2026-10-06T23:01:00.000Z' });
  createdMoods.push(ok(await api(context, '/me/moods', { method: 'POST', token: main.token, body: { score: 1, note: '阶段25本地三日记录一。' } }),
    201, `${context.driver} first real negative mood`).id);

  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: morning[1].before });
  const secondBefore = ok(await api(context, '/me/daily-brief', { token: main.token }), 200, `${context.driver} second date 06:59 brief`);
  assert.equal(secondBefore.status, 'not_ready');
  const triggerName = `q25_partial_${context.driver}`;
  const secondGuest = other.id;
  const createTrigger = context.driver === 'mysql'
    ? `CREATE TRIGGER ${triggerName} BEFORE INSERT ON daily_briefs FOR EACH ROW BEGIN IF NEW.guest_id='${secondGuest}' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='stage25 controlled partial failure'; END IF; END`
    : `CREATE TRIGGER ${triggerName} BEFORE INSERT ON daily_briefs WHEN NEW.guest_id='${secondGuest}' BEGIN SELECT RAISE(FAIL,'stage25 controlled partial failure'); END`;
  await databaseExec(context, createTrigger);
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: morning[1].after });
  const activeGuests = Number((await databaseQuery(context, "SELECT COUNT(*) AS total FROM users WHERE role='guest' AND status='active'", [], 'get')).total);
  await waitForBriefCount(context, morning[1].date, activeGuests - 1);
  const partialCount = Number((await databaseQuery(context, `SELECT COUNT(*) AS total FROM daily_briefs
    WHERE guest_id=? AND business_date=?`, [secondGuest, morning[1].date], 'get')).total);
  assert.equal(partialCount, 0, `${context.driver} injected failure leaves only that guest/date missing`);
  await databaseExec(context, `DROP TRIGGER ${triggerName}`);
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: morning[1].after });
  await waitForBrief(context, secondGuest, morning[1].date, 1);
  const recoveredCount = Number((await databaseQuery(context, `SELECT COUNT(*) AS total FROM daily_briefs
    WHERE guest_id=? AND business_date=?`, [secondGuest, morning[1].date], 'get')).total);
  assert.equal(recoveredCount, 1, `${context.driver} repeated lifecycle tick fills only the missing guest/day`);
  const recoveredNotices = await databaseQuery(context, `SELECT id FROM wellness_local_notifications
    WHERE guest_id=? AND source_type='daily_brief' AND source_id=?`, [secondGuest, morning[1].date], 'all');
  assert.equal(recoveredNotices.length, 1, `${context.driver} recovered brief creates one notification`);
  createdMoods.push(ok(await api(context, '/me/moods', { method: 'POST', token: main.token, body: { score: 2, note: '阶段25本地三日记录二。' } }),
    201, `${context.driver} second real negative mood`).id);

  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: morning[2].before });
  const thirdBefore = ok(await api(context, '/me/daily-brief', { token: main.token }), 200, `${context.driver} third date 06:59 brief`);
  assert.equal(thirdBefore.status, 'not_ready');
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: morning[2].after });
  await waitForBrief(context, main.id, morning[2].date, 1);
  createdMoods.push(ok(await api(context, '/me/moods', { method: 'POST', token: main.token, body: { score: 1, note: '阶段25本地三日记录三。' } }),
    201, `${context.driver} third real negative mood`).id);
  const refreshedBrief = ok(await api(context, '/me/daily-brief', { token: main.token }), 200, `${context.driver} refreshed same-day brief`);
  assert.equal(refreshedBrief.brief.stay.dayNumber, 3, `${context.driver} actual check-in yields third stay day`);
  assert.ok(refreshedBrief.brief.activities.some(item => item.reservationId === validBooking.reservation.id),
    `${context.driver} brief points to the confirmed activity reservation`);
  assert.ok(refreshedBrief.brief.meals.some(item => item.orderId === breakfast.order.id),
    `${context.driver} brief points to the real meal order`);
  assert.ok(refreshedBrief.brief.advice.some(item => Number(item.id) === Number(advice.id)), `${context.driver} brief reads the published advice`);
  assert.equal(refreshedBrief.brief.environment.filter(item => item.available).length, 3);
  assert.ok(refreshedBrief.brief.careItems.some(item => item.sourceType === 'mood_focus_item'), `${context.driver} three-day focus appears in brief`);
  assert.ok(refreshedBrief.brief.careItems.some(item => item.sourceType === 'wellness_review_event' && item.sourceId === correctionEventId),
    `${context.driver} correction event appears in brief`);

  const snapshots = await runNodeSnapshotProbe(context, [
    { key: 'advice-and-environment', guestId: main.id, date: '2026-10-09' },
    { key: 'environment-only', guestId: other.id, date: '2026-10-09' },
    { key: 'advice-only', guestId: main.id, date: '2026-10-12' },
    { key: 'neither', guestId: other.id, date: '2026-10-12' }
  ]);
  const byScenario = new Map(snapshots.map(item => [item.key, item.brief]));
  assert.equal(byScenario.get('advice-and-environment').advice.length > 0, true);
  assert.equal(byScenario.get('advice-and-environment').environment.every(item => item.available), true);
  assert.equal(byScenario.get('environment-only').advice.length, 0);
  assert.equal(byScenario.get('environment-only').environment.every(item => item.available), true);
  assert.equal(byScenario.get('advice-only').advice.length > 0, true);
  assert.equal(byScenario.get('advice-only').environment.every(item => !item.available), true);
  assert.equal(byScenario.get('neither').advice.length, 0);
  assert.equal(byScenario.get('neither').environment.every(item => !item.available), true);
  assert.ok(byScenario.get('neither').missing.some(item => item.includes('医护建议')));
  assert.ok(byScenario.get('neither').missing.some(item => item.includes('天气')));

  const staffTasks = ok(await api(context, '/staff/care-follow-up-tasks', { token: clinician.token }), 200,
    `${context.driver} assigned clinician follow-up tasks`);
  const moodTask = staffTasks.items.find(item => item.guestId === main.id && item.sourceType === 'mood_focus_item');
  const correctionTask = staffTasks.items.find(item => item.guestId === main.id && item.sourceType === 'wellness_review_event'
    && item.sourceId === correctionEventId);
  assert.ok(moodTask, `${context.driver} assigned staff can see the three-day mood task`);
  assert.ok(correctionTask, `${context.driver} assigned staff can see the correction task`);
  assert.ok(staffTasks.items.every(item => item.guestId === main.id), `${context.driver} task list stays in the current assignment scope`);
  const forbidden = await api(context, `/staff/guests/${encodeURIComponent(other.id)}`, { token: clinician.token });
  assert.equal(forbidden.status, 403, `${context.driver} staff cannot open unassigned guest details`);
  const otherNotices = ok(await api(context, '/me/wellness-notifications', { token: other.token }), 200,
    `${context.driver} second guest notification list`);
  assert.ok(!otherNotices.items.some(item => item.sourceType === 'wellness_review_event' && item.sourceId === correctionEventId),
    `${context.driver} second guest does not see the first guest correction notification`);
  const readCorrection = correctionNotices[0];
  ok(await api(context, `/me/wellness-notifications/${encodeURIComponent(readCorrection.id)}/read`, {
    method: 'PATCH', token: main.token, body: {}
  }), 200, `${context.driver} owner marks correction notification read`);
  const readback = ok(await api(context, '/me/wellness-notifications', { token: main.token }), 200,
    `${context.driver} notification read-state readback`);
  assert.ok(readback.items.find(item => item.id === readCorrection.id)?.readAt, `${context.driver} read state persists`);

  const reminderSource = await reminderSourceRow(context, validBooking.reservation.id);
  assert.equal(reminderSource?.status, 'confirmed', context.driver + ' reminder source stays confirmed');
  assert.equal(reminderSource?.businessDate, '2026-10-09', context.driver + ' reminder source business date');
  assert.equal(reminderSource?.localStart, '16:00', context.driver + ' reminder source local start');
  const beforeWindowCandidate = await reminderWindowMatch(context, validBooking.reservation.id, '15:44');
  assert.equal(beforeWindowCandidate.rows.length, 0, context.driver + ' 16:00 reservation is outside the 15:44 reminder window');
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: '2026-10-09T07:44:00.000Z' }); // 15:44 Shanghai
  const beforeWindowTick = await waitForInitialSchedulerTick(context, '15:44');
  let reminderRows = await databaseQuery(context, `SELECT id FROM wellness_local_notifications
    WHERE guest_id=? AND source_type='reservation_reminder' AND source_id=?`, [main.id, validBooking.reservation.id], 'all');
  assert.equal(reminderRows.length, 0, `${context.driver} no reminder before 15:45`);
  appendEvidence({ quest: 'Q25.reminder-window', driver: context.driver, status: 'PASS',
    source: reminderSource, candidateAt1544: beforeWindowCandidate, startupTick: beforeWindowTick, notificationCount: 0 });
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: '2026-10-09T07:45:00.000Z' }); // 15:45 Shanghai
  const reminderTick = await waitForInitialSchedulerTick(context, '15:45');
  const dueAt1545 = await reminderWindowMatch(context, validBooking.reservation.id, '15:45');
  assert.equal(dueAt1545.rows.length, 1, context.driver + ' persisted 16:00 source matches the inclusive 15:45 reminder window');
  reminderRows = await databaseQuery(context, `SELECT id,target_type AS targetType,target_id AS targetId,target_url AS targetUrl
    FROM wellness_local_notifications WHERE guest_id=? AND source_type='reservation_reminder' AND source_id=?`,
  [main.id, validBooking.reservation.id], 'all');
  assert.equal(reminderRows.length, 1, `${context.driver} confirmed appointment gets one 15-minute reminder`);
  assert.deepEqual({ targetType: reminderRows[0].targetType, targetId: reminderRows[0].targetId, targetUrl: reminderRows[0].targetUrl },
    { targetType: 'reservation', targetId: validBooking.reservation.id, targetUrl: 'reservations' });
  assert.ok(reminderTick.remindersCreated >= 1, context.driver + ' real startup tick reports created reminders');
  const reminderEvidenceSql = [
    'SELECT id,source_type AS sourceType,source_id AS sourceId,target_type AS targetType,',
    'target_id AS targetId,target_url AS targetUrl,created_at AS createdAt',
    'FROM wellness_local_notifications WHERE guest_id=? AND source_type=? AND source_id=?'
  ].join(' ');
  const reminderEvidenceRows = await databaseQuery(context, reminderEvidenceSql,
    [main.id, 'reservation_reminder', validBooking.reservation.id], 'all');
  assert.equal(reminderEvidenceRows.length, 1, context.driver + ' persisted reminder source row is unique');
  assert.deepEqual({ sourceType: reminderEvidenceRows[0].sourceType, sourceId: reminderEvidenceRows[0].sourceId,
    targetType: reminderEvidenceRows[0].targetType, targetId: reminderEvidenceRows[0].targetId,
    targetUrl: reminderEvidenceRows[0].targetUrl },
  { sourceType: 'reservation_reminder', sourceId: validBooking.reservation.id, targetType: 'reservation',
    targetId: validBooking.reservation.id, targetUrl: 'reservations' });
  assert.equal(normalizeTimestamp(reminderEvidenceRows[0].createdAt), normalizeTimestamp(utc('2026-10-09', '15:45')),
    context.driver + ' reminder created_at records the scheduler tick instant');
  appendEvidence({ quest: 'Q25.reminder-trigger', driver: context.driver, status: 'PASS',
    source: reminderSource, candidateAt1545: dueAt1545, startupTick: reminderTick, notification: reminderEvidenceRows[0] });
  const reminderId = reminderRows[0].id;
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: '2026-10-09T07:45:00.000Z' });
  const repeatedReminderTick = await waitForInitialSchedulerTick(context, '15:45');
  reminderRows = await databaseQuery(context, `SELECT id FROM wellness_local_notifications
    WHERE guest_id=? AND source_type='reservation_reminder' AND source_id=?`, [main.id, validBooking.reservation.id], 'all');
  assert.equal(reminderRows.length, 1, `${context.driver} repeated reminder tick is idempotent`);
  assert.equal(reminderRows[0]?.id, reminderId, context.driver + ' repeated tick preserves reminder identity');
  assert.equal(repeatedReminderTick.remindersCreated, 0, context.driver + ' repeated startup tick creates no duplicate');
  appendEvidence({ quest: 'Q25.reminder-idempotency', driver: context.driver, status: 'PASS',
    startupTick: repeatedReminderTick, reminderId, notificationCount: reminderRows.length });
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: '2026-10-09T08:45:00.000Z' }); // 16:45 Shanghai
  const cancelledReminderTick = await waitForInitialSchedulerTick(context, '16:45');
  const cancelledSource = await reminderSourceRow(context, cancelledBooking.reservation.id);
  assert.equal(cancelledSource?.status, 'cancelled', context.driver + ' 17:00 reservation is cancelled before 16:45');
  const cancelledWindowCandidate = await reminderWindowMatch(context, cancelledBooking.reservation.id, '16:45');
  assert.equal(cancelledWindowCandidate.rows.length, 0, context.driver + ' cancelled reservation is excluded from the due window');
  const cancelledReminders = await databaseQuery(context, `SELECT id FROM wellness_local_notifications
    WHERE guest_id=? AND source_type='reservation_reminder' AND source_id=?`, [main.id, cancelledBooking.reservation.id], 'all');
  assert.equal(cancelledReminders.length, 0, `${context.driver} cancelled 17:00 appointment gets no 16:45 reminder`);

  appendEvidence({ quest: 'Q25.reminder-cancelled', driver: context.driver, status: 'PASS',
    source: cancelledSource, candidateAt1645: cancelledWindowCandidate, startupTick: cancelledReminderTick,
    notificationCount: cancelledReminders.length });

  const counts = {
    guest: main.id, otherGuest: other.id, approvalEventId: approved.eventId, correctionEventId,
    reservationId: validBooking.reservation.id, cancelledReservationId: cancelledBooking.reservation.id,
    mealOrderId: breakfast.order.id, adviceId: advice.id, moodRecordIds: createdMoods,
    briefId: refreshedBrief.id, moodFocusSourceId: moodTask.sourceId, followUpTaskIds: [moodTask.id, correctionTask.id],
    reminderNotificationId: reminderRows[0]?.id, approvalNotificationCount: approvalNotices.length,
    correctionNotificationCount: correctionNotices.length, recoveredBriefCount: recoveredCount,
    projectionScenarios: snapshots.map(item => ({ key: item.key, advice: item.brief.advice.length,
      environmentAvailable: item.brief.environment.filter(source => source.available).length,
      missing: item.brief.missing.length }))
  };
  return counts;
}

async function runBackendAcceptance(resourceSession) {
  const results = [];
  try {
    await withBothDatabaseApis(async context => {
      const result = await stage25Driver(context, resourceSession);
      results.push({ driver: context.driver, ...result });
      appendEvidence({ quest: 'Q25.backend', driver: context.driver, status: 'PASS', fixtures: result });
    }, { resourceSession, env: { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: initialInstant } });
    return results;
  } catch (error) {
    appendEvidence({ quest: 'Q25.backend', status: 'FAIL', failure: String(error.stack || error).slice(0, 14_000) });
    throw error;
  }
}

export async function run({ questId, stage, resourceSession }) {
  if (!resourceSession) throw new Error('Stage25 acceptance requires a ResourceSession');
  if (process.env.QUEST_LIVE === '1') throw new Error('Stage25 forbids live provider and external notification calls');
  if (!backendPromise) backendPromise = runBackendAcceptance(resourceSession);
  const backend = await backendPromise;
  if (!browserPromise) browserPromise = import('../resources/stage25-browser-acceptance.js')
    .then(module => module.runStage25BrowserAcceptance({ resourceSession }))
    .then(result => {
      appendEvidence({ quest: 'Q25.browser', status: 'PASS', fixtureMode: 'local-records-only', evidence: {
        evidencePath: result.evidencePath, screenshotDirectory: result.screenshotDirectory,
        guestId: result.guestId, briefId: result.briefId, firstNotificationId: result.firstNotificationId,
        targetActivityId: result.targetActivityId, mealOrderId: result.mealOrderId,
        permissionPaths: result.permissionPaths, layout: result.layout, screenshots: result.screenshots,
        resourceIds: result.resources.map(item => item.id), disk: { before: result.dfBefore, after: result.dfAfter }
      } });
      return result;
    }).catch(error => {
      appendEvidence({ quest: 'Q25.browser', status: 'FAIL', failure: String(error.stack || error).slice(0, 14_000) });
      throw error;
    });
  const browser = await browserPromise;
  const brief = backend.map(item => `${item.driver}: 简报 ${item.briefId}；审批 ${item.approvalEventId}；纠正 ${item.correctionEventId}；预约提醒 ${item.reminderNotificationId}`).join('；');
  const visual = `浏览器客人 ${browser.guestId}，首条通知 ${browser.firstNotificationId}，活动 ${browser.targetActivityId}，膳食订单 ${browser.mealOrderId}`;
  if (questId === 'Q25.1') return { output: [`Q25.1 双库真实审批/纠正事件通知、原始来源/目标、重复消费唯一及本人已读持久化通过；${brief}`] };
  if (questId === 'Q25.2') return { output: [`Q25.2 刷新两次后通知中心和助手仍指向同一首条事件，未将提醒写成聊天记录；${visual}`] };
  if (questId === 'Q25.3') return { output: [`Q25.3 双库四组合验证真实医嘱/环境快照存在与缺失；活动、膳食、来源和缺项按真实记录汇总，不补造建议或环境值；${brief}`] };
  if (questId === 'Q25.4') return { output: [`Q25.4 客人浏览器读取实际预约、餐单、医嘱、环境来源并进入预约/膳食页面；1280/1920自然排布无横向溢出；${visual}`] };
  if (questId === 'Q25.5') return { output: [`Q25.5 Asia/Shanghai 06:59→07:00、真实API重启、单客部分失败后恢复与重复tick均通过；${brief}`] };
  if (questId === 'Q25.6') return { output: [`Q25.6 16:00确认预约在15:45仅一条可追溯提醒；17:00已取消预约在16:45无提醒；${brief}`] };
  if (questId === 'Q25.7') return { output: [`Q25.7 浏览器仅在显式点击后走实际 Notifications API，许可/拒绝均记录；拒绝仍保留站内查看且不宣称关闭浏览器后推送；${visual}`] };
  if (questId === 'Q25.8') return { output: [`Q25.8 三日低分心情和真实医护纠正进入客人简报及负责医护待办；未分配客人拒绝访问且另一客人通知隔离；${brief}`] };
  return { output: [`${questId} 阶段25受管验收通过；${brief}；${visual}`,
    `资源与截图明细：${path.relative(projectRoot, browser.evidencePath)}；执行收据：${path.relative(projectRoot, evidencePath)}。`] };
}
