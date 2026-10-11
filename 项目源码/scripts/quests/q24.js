import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { withBothDatabaseApis, databaseQuery, login, request } from './q10-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordedModel = path.join(projectRoot, 'scripts/resources/q22-recorded-model-server.js');
const day = '2026-10-09';
const initialInstant = '2026-10-08T23:00:00.000Z'; // 07:00 Shanghai, before the morning activity window
const checkout = '2026-10-14';
const sourceEvidencePath = path.join(projectRoot, 'output/resource-audit/stage24-luna-execution-evidence-20261008.jsonl');
let backendResultPromise;
let browserResultPromise;

function appendEvidence(entry) {
  fs.mkdirSync(path.dirname(sourceEvidencePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ at: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...entry })}\n`;
  const current = fs.existsSync(sourceEvidencePath) ? fs.statSync(sourceEvidencePath).size : 0;
  if (Buffer.byteLength(line) > 48 * 1024 || current + Buffer.byteLength(line) > 8 * 1024 * 1024) {
    throw new Error('Stage24 execution evidence exceeded the 8 MiB append limit');
  }
  fs.appendFileSync(sourceEvidencePath, line, { encoding: 'utf8', mode: 0o600 });
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

function success(result, status, label) {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

function sqlTime(context, value) {
  return context.driver === 'mysql' ? value.replace('T', ' ').replace(/Z$/, '') : value;
}

function parseUtc(value) {
  if (value instanceof Date) return value.getTime();
  const text = String(value || '').trim();
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}

function currentBusinessInstant(context) {
  return context.businessClockNow || initialInstant;
}

async function restartApiWithClock(context, instant, extra = {}) {
  const previous = parseUtc(currentBusinessInstant(context));
  const next = parseUtc(instant);
  assert.ok(Number.isFinite(next) && next >= previous,
    `${context.driver} institution clock cannot move backwards (${currentBusinessInstant(context)} -> ${instant})`);
  context.businessClockNow = new Date(next).toISOString();
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: context.businessClockNow, ...extra });
  return context.baseUrl;
}

async function restartApiAtCurrentClock(context, extra = {}) {
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: currentBusinessInstant(context), ...extra });
  return context.baseUrl;
}

function dateOffset(date, offset) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function setStayAndHealth(context, guestId, { chronic = [], allergies = [], unverified = false } = {}) {
  const inColumn = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const outColumn = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  const profile = {
    chronic: { status: chronic.length ? 'reported' : 'none', items: chronic },
    medications: { status: 'none', items: [] }, allergies: { status: 'none', items: [] },
    dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'independent', details: '可独立行走' },
    sleep: { status: unverified ? 'unknown' : 'reported', details: unverified ? '' : '睡眠正常' },
    skin: { status: unverified ? 'unknown' : 'reported', details: unverified ? '' : '皮肤完整' },
    audienceTags: { status: 'none', items: [] }
  };
  profile.allergies = { status: allergies.length ? 'reported' : 'none', items: allergies };
  await databaseQuery(context, `UPDATE guest_profiles SET ${inColumn}=?,${outColumn}=?,chronic_json=?,allergies_json=?,
    mobility=?,health_profile_json=?,health_profile_version=health_profile_version+1,updated_at=? WHERE user_id=?`,
    [day, checkout, JSON.stringify(chronic), JSON.stringify(allergies), '可独立行走', JSON.stringify(profile),
      sqlTime(context, currentBusinessInstant(context)), guestId], 'run');
}

async function seedEnvironment(context, targetDate = day) {
  const observedAt = currentBusinessInstant(context);
  const expiresAt = new Date(Date.parse(`${targetDate}T00:00:00.000Z`) + 36 * 60 * 60 * 1000).toISOString();
  const demo = makeDemoEnvironment(targetDate, observedAt, DEMO_ENVIRONMENT_LOCATION);
  const payloads = [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]];
  for (const [domain, stationId, payload] of payloads) {
    const key = `env:${crypto.createHash('sha256').update(JSON.stringify([DEMO_ENVIRONMENT_LOCATION.id, stationId, targetDate, domain])).digest('hex').slice(0, 48)}`;
    const json = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    const insert = `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,payload_hash,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)`;
    const upsert = context.driver === 'mysql'
      ? ` ON DUPLICATE KEY UPDATE status=VALUES(status),source_name=VALUES(source_name),source_url=VALUES(source_url),
        observed_at=VALUES(observed_at),expires_at=VALUES(expires_at),payload_hash=VALUES(payload_hash),payload_json=VALUES(payload_json),updated_at=VALUES(updated_at)`
      : ` ON CONFLICT(snapshot_key) DO UPDATE SET status=excluded.status,source_name=excluded.source_name,source_url=excluded.source_url,
        observed_at=excluded.observed_at,expires_at=excluded.expires_at,payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`;
    await databaseQuery(context, `${insert}${upsert}`,
      [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, targetDate, domain, payload.sourceName || 'Stage24 本地合成快照', payload.sourceUrl || '',
        sqlTime(context, observedAt), sqlTime(context, expiresAt), hash, json,
        sqlTime(context, observedAt), sqlTime(context, observedAt)], 'run');
  }
}

function slotKeyForTime(value) {
  const [hour, minute] = String(value || '00:00').split(':').map(Number);
  const minutes = hour * 60 + minute;
  return minutes < 12 * 60 ? 'morning' : minutes < 17 * 60 ? 'afternoon' : 'evening';
}

async function seedBaseline(context, guestId, appointments) {
  const draftId = `wellness_draft_q24_fixture_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const stamp = sqlTime(context, currentBusinessInstant(context));
  await databaseQuery(context, `INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
     evidence_json,created_at,review_status,review_thread_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,1,?,NULL,?,?,'active','auto',0,?,?,'active',?,NULL,NULL,NULL)`,
    [draftId, guestId, `q24-fixture:${draftId}`, day, checkout,
      JSON.stringify({ sourceMode: 'recorded_fixture', fixturePurpose: 'Q24 active baseline with completed participation and a committed future appointment' }), stamp, draftId], 'run');
  const items = [];
  for (const [index, appointment] of appointments.entries()) {
    const itemId = `wellness_item_q24_fixture_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const { reservation, slot, label } = appointment;
    await databaseQuery(context, `INSERT INTO wellness_draft_items
      (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
       rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
      VALUES(?,?,?,?,?,'project-beach-walk',?,?,?,'proposed',?,'海屿服务区（演示地点）','[]',?,NULL,?)`,
    [itemId, draftId, slot.businessDate || day, slotKeyForTime(slot.localStart), 'activity', label, slot.localStart, slot.localEnd,
      `${label}：既有已确认预约，激活新版本时继续保留。`,
      JSON.stringify([{ type: 'project_slot', id: reservation.slotId, label }]),
      JSON.stringify({ sourceMode: 'recorded_fixture', reservationId: reservation.id,
        disposition: index === 0 ? 'attended_history_retained' : 'future_commitment_retained' })], 'run');
    await databaseQuery(context, 'UPDATE reservations SET wellness_draft_id=?,wellness_draft_item_id=? WHERE id=?',
      [draftId, itemId, reservation.id], 'run');
    items.push({ itemId, reservationId: reservation.id, slotId: reservation.slotId,
      businessDate: slot.businessDate || day, localStart: slot.localStart, localEnd: slot.localEnd, label });
  }
  assert.ok(items.length >= 2, `${context.driver} active baseline contains the attended entry and a future commitment`);
  return { draftId, items };
}

async function createReviewPolicyGuest(context, clinicianId) {
  const guestId = `guest_q24_capacity_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const username = `q24_capacity_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
  assert.ok(source?.password_hash, `${context.driver} demo password fixture exists for the capacity competitor`);
  const stamp = sqlTime(context, currentBusinessInstant(context));
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,?,?,'guest','阶段24容量竞争样本','', 'active',?)`, [guestId, username, source.password_hash, stamp], 'run');
  const inColumn = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const outColumn = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  await databaseQuery(context, `INSERT INTO guest_profiles
    (user_id,gender,birth_date,room_no,${inColumn},${outColumn},emergency_contact,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version)
    VALUES(?,?,NULL,?,?,?,?,?,?,?,?,0)`, [guestId, '', 'Q24-CAPACITY', day, checkout, '', '[]', '[]', '可独立行走', JSON.stringify({})], 'run');
  const dean = await databaseQuery(context, "SELECT id FROM users WHERE role='dean' LIMIT 1", [], 'get');
  assert.ok(dean?.id, `${context.driver} dean fixture exists for capacity-competitor assignment`);
  await databaseQuery(context, `INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
    VALUES(?,?,?,NULL,'active',?,?,?)`, [clinicianId, guestId, stamp, dean.id, stamp, stamp], 'run');
  await setStayAndHealth(context, guestId);
  return { id: guestId, username };
}

async function evaluateFeedbackCandidate(context, guest, feedbackId, expectedRevision, label) {
  const events = success(await api(context, '/me/replanning-events', { token: guest.token }), 200,
    `${context.driver} ${label} feedback source event readback`);
  const event = events.items.find(item => item.sourceType === 'feedback'
    && String(item.sourceId) === String(feedbackId) && Number(item.sourceVersion) === expectedRevision);
  assert.ok(event?.requiresAttention, `${context.driver} ${label} actual feedback revision has a review-worthy source event`);
  const candidate = success(await api(context, `/me/replanning-events/${encodeURIComponent(event.id)}/evaluate`, {
    method: 'POST', token: guest.token, body: {}
  }), 200, `${context.driver} ${label} candidate through the existing coordinator`);
  assert.ok(candidate.candidate?.draftId, `${context.driver} ${label} policy evaluation persists an actual candidate`);
  assert.equal(candidate.candidate.evidence.replanning.sourceId, feedbackId);
  assert.equal(Number(candidate.candidate.evidence.replanning.sourceVersion), expectedRevision);
  const persistedBaseline = await databaseQuery(context, `SELECT review_status FROM wellness_drafts
    WHERE id=? AND guest_id=?`, [candidate.baseline.draftId, guest.id], 'get');
  assert.equal(persistedBaseline?.review_status, 'active', `${context.driver} ${label} candidate starts from an active persisted plan`);
  assert.ok(candidate.baseline.items.length > 0, `${context.driver} ${label} active baseline has actual plan entries`);
  return { event, candidate };
}

async function feedbackReplan(context, guest, feedbackId, { expectedRevision, feeling, note, label }) {
  const savedFeedback = success(await api(context, `/me/feedback/${encodeURIComponent(feedbackId)}`, { method: 'PUT', token: guest.token,
    body: { feeling, note } }), 200, `${context.driver} ${label} real feedback revision`);
  assert.equal(Number(savedFeedback.revision), expectedRevision, `${context.driver} ${label} feedback revision is monotonic`);
  const evaluated = await evaluateFeedbackCandidate(context, guest, feedbackId, expectedRevision, label);
  return { feedback: savedFeedback, ...evaluated };
}

async function runHealthReviewPolicyAcceptance(context, clinicianId) {
  const healthDay = dateOffset(day, 1);
  for (let offset = 0; offset < 4; offset += 1) await seedEnvironment(context, dateOffset(healthDay, offset));
  const fixtureGuest = await createReviewPolicyGuest(context, clinicianId);
  const healthIntakeStatusColumn = context.driver === 'mysql' ? 'review_status' : 'status';
  const loginResult = success(await api(context, '/auth/login', { method: 'POST', body: {
    username: fixtureGuest.username, password: 'guest2026', role: 'guest'
  } }), 200, `${context.driver} isolated real-feedback guest login`);
  const guest = { id: loginResult.user.id, token: loginResult.token };
  assert.equal(guest.id, fixtureGuest.id, `${context.driver} policy evaluation uses the isolated synthetic guest`);
  const healthProfileRow = await databaseQuery(context,
    'SELECT health_profile_json FROM guest_profiles WHERE user_id=?', [guest.id], 'get');
  const savedHealthProfile = typeof healthProfileRow?.health_profile_json === 'string'
    ? JSON.parse(healthProfileRow.health_profile_json) : healthProfileRow?.health_profile_json;
  const pendingHealthIntakes = Number((await databaseQuery(context,
    `SELECT COUNT(*) AS total FROM health_intakes WHERE guest_id=? AND ${healthIntakeStatusColumn}='pending'`, [guest.id], 'get')).total);
  const savedHealthStatuses = Object.fromEntries(Object.entries(savedHealthProfile || {})
    .map(([field, value]) => [field, value?.status || 'missing']));
  const requiredHealthFields = ['chronic', 'medications', 'allergies', 'dietaryRestrictions', 'mobility', 'sleep', 'skin', 'audienceTags'];
  const missingHealthFields = requiredHealthFields.filter(field => !Object.hasOwn(savedHealthStatuses, field)
    || ['missing', 'unanswered', 'unknown'].includes(savedHealthStatuses[field]));
  assert.ok(missingHealthFields.length === 0 && pendingHealthIntakes === 0,
    `${context.driver} healthy policy fixture has all eight persisted health answers and no pending intakes: ${JSON.stringify({ savedHealthStatuses, missingHealthFields, pendingHealthIntakes })}`);
  const attendedSlots = success(await api(context, `/projects/project-beach-walk/slots?date=${healthDay}`, { token: guest.token }), 200,
    `${context.driver} real-feedback guest next-day slots`);
  const attendedSlot = attendedSlots.slots.find(item => item.bookable
    && parseUtc(item.startsAt) > parseUtc(currentBusinessInstant(context)));
  assert.ok(attendedSlot, `${context.driver} real-feedback guest has a genuine future participation slot`);
  const attendedBooking = success(await api(context, '/reservations', { method: 'POST', token: guest.token,
    headers: { 'Idempotency-Key': `q24-policy-attended-${context.driver}-0001` }, body: { slotId: attendedSlot.id } }), 201,
  `${context.driver} policy guest actual appointment`);
  const attendedReservation = { ...attendedBooking.reservation, slotId: attendedSlot.id, businessDate: healthDay,
    localStart: attendedSlot.localStart, localEnd: attendedSlot.localEnd };
  const futureDate = dateOffset(healthDay, 2);
  const futureSlots = success(await api(context, `/projects/project-beach-walk/slots?date=${futureDate}`, { token: guest.token }), 200,
    `${context.driver} policy guest future commitment slots`);
  const futureSlot = futureSlots.slots.find(item => item.bookable && parseUtc(item.startsAt) > parseUtc(attendedSlot.startsAt));
  assert.ok(futureSlot, `${context.driver} policy guest can retain a second actual future appointment`);
  const futureBooking = success(await api(context, '/reservations', { method: 'POST', token: guest.token,
    headers: { 'Idempotency-Key': `q24-policy-future-${context.driver}-0001` }, body: { slotId: futureSlot.id } }), 201,
  `${context.driver} policy guest committed future appointment`);
  const futureReservation = { ...futureBooking.reservation, slotId: futureSlot.id, businessDate: futureDate,
    localStart: futureSlot.localStart, localEnd: futureSlot.localEnd };

  const healthAfterStart = new Date(parseUtc(attendedReservation.startsAt || attendedSlot.startsAt) + 60_000).toISOString();
  await restartApiWithClock(context, healthAfterStart, {
    WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '100'
  });
  const checkin = success(await api(context, `/me/reservations/${encodeURIComponent(attendedReservation.id)}/checkin`, {
    method: 'POST', token: guest.token, body: {}
  }), 201, `${context.driver} policy guest real check-in after appointment start`);
  const baseline = await seedBaseline(context, guest.id, [
    { reservation: attendedReservation, slot: attendedSlot, label: '策略样本已参加并签到的基线项目' },
    { reservation: futureReservation, slot: futureSlot, label: '策略样本原计划的未来已确认预约' }
  ]);
  const healthProfileReadback = success(await api(context, '/me/health-profile', { token: guest.token }), 200,
    `${context.driver} complete healthy profile readback after API restart`);
  assert.equal(healthProfileReadback.completeness.percent, 100,
    `${context.driver} policy guest health profile remains complete after clock restart`);
  assert.equal(healthProfileReadback.pendingIntakes.length, 0,
    `${context.driver} policy guest has no pending health intake after clock restart`);
  const actualFeedback = success(await api(context, `/me/reservations/${encodeURIComponent(attendedReservation.id)}/feedback`, {
    method: 'POST', token: guest.token, body: { feeling: 'uncomfortable', note: '本地离线策略验收：参加项目后的实际反馈。' }
  }), 201, `${context.driver} policy guest feedback from actual participation`);
  assert.equal(actualFeedback.checkinId, checkin.id);
  const initial = await evaluateFeedbackCandidate(context, guest, actualFeedback.id, 1, 'sampled-real-feedback');
  assert.equal(initial.candidate.baseline.draftId, baseline.draftId);
  assert.equal(initial.candidate.baseline.items.length, 2, `${context.driver} sampled policy uses a nonempty active schedule`);
  assert.equal(initial.candidate.candidate.reviewPolicy.mode, 'sampled_review');
  assert.equal(Number(initial.candidate.candidate.reviewPolicy.samplePercent), 100);
  const sampledActivities = initial.candidate.candidate.items.filter(item => item.type === 'activity');
  const pendingHealthIntakesAfterEvaluation = Number((await databaseQuery(context,
    `SELECT COUNT(*) AS total FROM health_intakes WHERE guest_id=? AND ${healthIntakeStatusColumn}='pending'`, [guest.id], 'get')).total);
  const sampledActivitySummary = sampledActivities.map(item => ({ date: item.businessDate, status: item.status,
    hard: item.evidence?.healthRisk?.hard, unverified: item.evidence?.healthRisk?.unverified }));
  assert.equal(pendingHealthIntakesAfterEvaluation, 0,
    `${context.driver} internally generated wellness replan text is not recorded as guest-authored health intake`);
  assert.ok(sampledActivities.some(item => item.status === 'sampled_review' && item.evidence?.healthRisk?.hard === false),
    `${context.driver} healthy actual-feedback activity follows the configured sample review policy; fixture: ${JSON.stringify({
      savedHealthStatuses, healthProfileCompleteness: healthProfileReadback.completeness,
      pendingHealthIntakesBefore: healthProfileReadback.pendingIntakes.length,
      pendingHealthIntakesAfterEvaluation, activityStates: sampledActivitySummary })}`);
  const sampledActivation = success(await api(context, `/me/replanning-events/${encodeURIComponent(initial.event.id)}/auto-activate`, {
    method: 'POST', token: guest.token, body: {}
  }), 200, `${context.driver} healthy sampled candidate remains pending`);
  assert.equal(sampledActivation.activated, false);
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM reservations WHERE wellness_draft_id=?',
    [initial.candidate.candidate.draftId], 'get')).total), 0,
  `${context.driver} sampled candidate leaves actual future schedule unchanged`);
  await assertRetainedBaselineAppointments(context, guest.id, baseline.items.map(item => ({ ...item })), baseline.draftId,
    'after sampled real-feedback candidate');

  await restartApiAtCurrentClock(context, { WELLNESS_DRAFT_REVIEW_POLICY: 'auto', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '0' });
  let revision = 1;
  const verifyRisk = async ({ label, profile, sourceNote, expectedRisk }) => {
    await setStayAndHealth(context, guest.id, profile);
    revision += 1;
    const scenario = await feedbackReplan(context, guest, actualFeedback.id, { expectedRevision: revision,
      feeling: 'uncomfortable', note: sourceNote, label });
    assert.equal(scenario.candidate.baseline.draftId, baseline.draftId,
      `${context.driver} ${label} actual-feedback replan retains the same active source schedule`);
    assert.equal(scenario.candidate.candidate.reviewPolicy.mode, 'auto');
    const reviewableItems = scenario.candidate.candidate.items.filter(item => ['activity', 'meal'].includes(item.type));
    const riskItems = reviewableItems.filter(item => item.status === 'mandatory_review'
      && item.evidence?.healthRisk?.[expectedRisk] === true);
    const persistedDraft = await databaseQuery(context, 'SELECT review_status FROM wellness_drafts WHERE id=? AND guest_id=?',
      [scenario.candidate.candidate.draftId, guest.id], 'get');
    const healthProfileEvidence = await databaseQuery(context, `SELECT chronic_json,allergies_json,health_profile_json
      FROM guest_profiles WHERE user_id=?`, [guest.id], 'get');
    assert.ok(reviewableItems.some(item => item.type === 'activity'), `${context.driver} ${label} source candidate contains actual activity items`);
    assert.ok(riskItems.some(item => item.type === 'activity') && persistedDraft?.review_status === 'pending_review', `${context.driver} ${label} profile forces actual activity candidates into mandatory review: ${JSON.stringify({
      profile: healthProfileEvidence, persistedReviewStatus: persistedDraft?.review_status,
      candidates: reviewableItems.map(item => ({ type: item.type, status: item.status,
        healthRisk: item.evidence?.healthRisk, mandatoryReasons: item.evidence?.mandatoryReasons,
        domainCandidateStatus: item.evidence?.domainCandidateStatus, rules: item.evidence?.rules?.map(rule => ({ ruleId: rule.ruleId, action: rule.action })) })),
      allItems: scenario.candidate.candidate.items.map(item => ({ type: item.type, status: item.status,
        healthRisk: item.evidence?.healthRisk, mandatoryReasons: item.evidence?.mandatoryReasons }))
    }).slice(0, 6000)}`);
    const blocked = success(await api(context, `/me/replanning-events/${encodeURIComponent(scenario.event.id)}/auto-activate`, {
      method: 'POST', token: guest.token, body: {}
    }), 200, `${context.driver} ${label} auto-activation rejection`);
    assert.equal(blocked.activated, false, `${context.driver} ${label} candidate remains clinician-only`);
    assert.equal(Number((await databaseQuery(context, `SELECT COUNT(*) AS total FROM reservations
      WHERE wellness_draft_id=? AND status='confirmed'`, [scenario.candidate.candidate.draftId], 'get')).total), 0,
    `${context.driver} ${label} rejection does not reserve appointment capacity`);
    return { sourceEventId: scenario.event.id, sourceType: 'feedback', sourceVersion: scenario.feedback.revision,
      baselineDraftId: scenario.candidate.baseline.draftId, candidateDraftId: scenario.candidate.candidate.draftId,
      forcedReviewItemCount: riskItems.length, forcedReviewItemTypes: [...new Set(riskItems.map(item => item.type))],
      autoActivated: blocked.activated };
  };

  const chronic = await verifyRisk({ label: 'chronic', profile: { chronic: ['高血压'] },
    sourceNote: '本地离线策略验收：慢病信息待医护结合已参加项目后的反馈核对。', expectedRisk: 'chronic' });
  const allergy = await verifyRisk({ label: 'contraindication', profile: { allergies: ['虾'] },
    sourceNote: '本地离线策略验收：过敏限制需逐项核对实际反馈。', expectedRisk: 'allergyOrRestriction' });
  const unknown = await verifyRisk({ label: 'unverified', profile: { unverified: true },
    sourceNote: '本地离线策略验收：健康自述仍有未核实项目，保留反馈来源。', expectedRisk: 'unverified' });

  await setStayAndHealth(context, guest.id);
  revision += 1;
  const healthy = await feedbackReplan(context, guest, actualFeedback.id, { expectedRevision: revision,
    feeling: 'uncomfortable', note: '本地离线策略验收：档案核实后，仍基于真实参与反馈重新评估。', label: 'healthy-auto' });
  assert.equal(healthy.candidate.baseline.draftId, baseline.draftId);
  assert.equal(healthy.candidate.candidate.reviewPolicy.mode, 'auto');
  assert.equal(Number(healthy.candidate.candidate.reviewPolicy.samplePercent), 0);
  const healthyActivities = healthy.candidate.candidate.items.filter(item => item.type === 'activity');
  assert.ok(healthyActivities.length > 0, `${context.driver} healthy real-feedback candidate has actual activities`);
  assert.ok(healthyActivities.every(item => item.status === 'pending_review'
    && item.evidence?.healthRisk?.hard === false), `${context.driver} healthy activities remain eligible under auto policy`);
  const autoResult = success(await api(context, `/me/replanning-events/${encodeURIComponent(healthy.event.id)}/auto-activate`, {
    method: 'POST', token: guest.token, body: {}
  }), 200, `${context.driver} healthy real-feedback automatic activation`);
  assert.equal(autoResult.activated, true, `${context.driver} eligible healthy candidate follows configured auto policy`);
  assert.equal(autoResult.detail.candidate.reviewStatus, 'auto_activated');
  const healthyReservations = await databaseQuery(context, `SELECT r.id,r.status,s.starts_at AS startsAt FROM reservations r
    JOIN activity_slots s ON s.id=r.slot_id WHERE r.wellness_draft_id=? ORDER BY s.starts_at`,
  [healthy.candidate.candidate.draftId]);
  assert.ok(healthyReservations.length > 0 && healthyReservations.every(item => item.status === 'confirmed'
    && parseUtc(item.startsAt) > parseUtc(currentBusinessInstant(context))),
  `${context.driver} healthy auto activation creates real confirmed future reservations`);
  await assertRetainedBaselineAppointments(context, guest.id, baseline.items.map(item => ({ ...item })), baseline.draftId,
    'after healthy real-feedback auto activation');

  return { flowGuestId: guest.id, attendedReservationId: attendedReservation.id, checkinId: checkin.id,
    feedbackId: actualFeedback.id, finalFeedbackRevision: revision, baselineDraftId: baseline.draftId,
    baselineItemCount: baseline.items.length, futureReservationId: futureReservation.id,
    sampledCandidateDraftId: initial.candidate.candidate.draftId,
    healthySourceEventId: healthy.event.id, healthySourceVersion: healthy.feedback.revision,
    healthyCandidateDraftId: autoResult.detail.candidate.draftId, healthyAutoReservationCount: healthyReservations.length,
    chronic, allergy, unknown };
}

async function startRecordedModel(resourceSession) {
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address()?.port;
      server.close(error => error ? reject(error) : value ? resolve(value) : reject(new Error('Q24 could not reserve a model fixture port')));
    });
  });
  const resource = await resourceSession.startProcess({ label: 'q24-recorded-model-fixture', kind: 'stub', role: 'model-provider',
    command: process.execPath, args: [recordedModel], cwd: projectRoot, port,
    env: { PATH: process.env.PATH || '', PORT: String(port) } });
  assert.equal(resource.status, 'running', `Stage24 recorded model fixture did not start: ${JSON.stringify(resource)}`);
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return { resource, baseUrl: `http://127.0.0.1:${port}/v1` };
    } catch { /* bounded local fixture readiness check */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await resourceSession.stop(resource.id, 'q24-recorded-model-readiness-failed').catch(() => {});
  await resourceSession.waitProcess(resource.id, 10_000).catch(() => {});
  throw new Error('Stage24 recorded model fixture readiness timed out');
}

async function stopRecordedModel(resourceSession, handle) {
  const current = (await resourceSession.status()).resources?.find(item => item.id === handle.resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await resourceSession.stop(current.id, 'q24-recorded-model-complete');
    if (!stopped.ok) throw new Error(`Stage24 recorded model stop failed: ${stopped.error || 'unknown error'}`);
  }
  const exited = await resourceSession.waitProcess(handle.resource.id, 10_000);
  assert.ok(!exited.timedOut && !exited.unavailable && !['starting', 'running'].includes(exited.status),
    `Stage24 recorded model failed to exit: ${JSON.stringify(exited)}`);
}

async function guestSchedule(context, guestId) {
  return databaseQuery(context, `SELECT r.id,r.slot_id AS slotId,r.status,r.wellness_draft_id AS draftId,
      r.wellness_draft_item_id AS itemId,s.business_date AS businessDate,s.starts_at AS startsAt,s.ends_at AS endsAt
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id
    WHERE r.guest_id=? AND r.status='confirmed' ORDER BY s.starts_at,r.id`, [guestId]);
}

async function assertRetainedBaselineAppointments(context, guestId, appointments, baselineDraftId, label) {
  for (const appointment of appointments) {
    const actual = await databaseQuery(context, `SELECT r.status,r.wellness_draft_id AS draftId,
        r.wellness_draft_item_id AS itemId FROM reservations r WHERE r.id=? AND r.guest_id=?`,
    [appointment.reservationId, guestId], 'get');
    assert.equal(actual?.status, 'confirmed', `${context.driver} ${label} retains ${appointment.label}`);
    assert.equal(actual.draftId, baselineDraftId, `${context.driver} ${label} keeps ${appointment.label} attached to its source plan`);
    assert.equal(actual.itemId, appointment.itemId, `${context.driver} ${label} preserves the original plan item for ${appointment.label}`);
  }
}

async function candidateActivitySlots(context, draftId) {
  const rows = await databaseQuery(context, `SELECT id,item_type,business_date,local_start,local_end,status,source_ids_json
    FROM wellness_draft_items WHERE draft_id=? AND item_type='activity' ORDER BY business_date,local_start,id`, [draftId]);
  const result = [];
  for (const item of rows) {
    const sourceIds = typeof item.source_ids_json === 'string' ? JSON.parse(item.source_ids_json) : item.source_ids_json;
    const slotId = [...(Array.isArray(sourceIds) ? sourceIds : [])].reverse()
      .find(source => source?.type === 'project_slot' && source.id)?.id;
    if (!slotId) continue;
    const slot = await databaseQuery(context, `SELECT id,business_date AS businessDate,starts_at AS startsAt,
        ends_at AS endsAt,local_start AS localStart,local_end AS localEnd,capacity,is_closed AS isClosed,
        (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=activity_slots.id AND r.status='confirmed') AS booked
      FROM activity_slots WHERE id=?`, [slotId], 'get');
    if (slot) result.push({ itemId: item.id, slotId, ...slot, activityStatus: item.status });
  }
  return result;
}

async function stage24Driver(context) {
  context.businessClockNow = initialInstant;
  const guestLogin = success(await login(context.baseUrl, 'guest'), 200, `${context.driver} guest login`);
  const staffLogin = success(await login(context.baseUrl, 'staff'), 200, `${context.driver} clinician login`);
  const guest = { id: guestLogin.user.id, token: guestLogin.token };
  const clinician = { id: staffLogin.user.id, token: staffLogin.token };
  await setStayAndHealth(context, guest.id);
  for (let offset = 0; offset < 5; offset += 1) await seedEnvironment(context, dateOffset(day, offset));

  const slots = success(await api(context, `/projects/project-beach-walk/slots?date=${day}`, { token: guest.token }), 200,
    `${context.driver} actual project slots`);
  const chosen = slots.slots.find(item => item.bookable);
  assert.ok(chosen, `${context.driver} project exposes a real bookable slot`);
  const createdReservation = success(await api(context, '/reservations', { method: 'POST', token: guest.token,
    body: { slotId: chosen.id }, headers: { 'Idempotency-Key': `q24-booking-${context.driver}-0001` } }), 201, `${context.driver} real appointment`);
  const reservation = { ...createdReservation.reservation, slotId: chosen.id, businessDate: day,
    localStart: chosen.localStart, localEnd: chosen.localEnd };

  const futureDate = dateOffset(day, 2);
  const futureSlots = success(await api(context, `/projects/project-beach-walk/slots?date=${futureDate}`, { token: guest.token }), 200,
    `${context.driver} actual later-date project slots`);
  const futureChosen = futureSlots.slots.find(item => item.bookable && parseUtc(item.startsAt) > parseUtc(currentBusinessInstant(context)));
  assert.ok(futureChosen, `${context.driver} active baseline has an actual bookable future appointment`);
  const futureCreated = success(await api(context, '/reservations', { method: 'POST', token: guest.token,
    body: { slotId: futureChosen.id }, headers: { 'Idempotency-Key': `q24-future-booking-${context.driver}-0001` } }), 201,
  `${context.driver} retained later-date appointment`);
  const futureReservation = { ...futureCreated.reservation, slotId: futureChosen.id, businessDate: futureDate,
    localStart: futureChosen.localStart, localEnd: futureChosen.localEnd };
  const early = await api(context, `/me/reservations/${encodeURIComponent(reservation.id)}/checkin`, { method: 'POST', token: guest.token, body: {} });
  assert.equal(early.status, 409, `${context.driver} check-in is rejected before the appointment starts`);
  assert.equal(early.data.code, 'CHECKIN_TOO_EARLY');
  const nonGuest = await api(context, `/me/reservations/${encodeURIComponent(reservation.id)}/checkin`, { method: 'POST', token: clinician.token, body: {} });
  assert.equal(nonGuest.status, 403, `${context.driver} nonparticipant role cannot check in`);

  const startsAtMs = parseUtc(reservation.startsAt || chosen.startsAt);
  assert.ok(Number.isFinite(startsAtMs), `${context.driver} reservation has a parseable actual start time`);
  const afterStart = new Date(startsAtMs + 60_000).toISOString();
  await restartApiWithClock(context, afterStart);
  const checkedIn = success(await api(context, `/me/reservations/${encodeURIComponent(reservation.id)}/checkin`, { method: 'POST', token: guest.token, body: {} }), 201,
    `${context.driver} check-in after appointment start`);
  const duplicateCheckin = success(await api(context, `/me/reservations/${encodeURIComponent(reservation.id)}/checkin`, { method: 'POST', token: guest.token, body: {} }), 200,
    `${context.driver} idempotent repeated check-in`);
  assert.equal(duplicateCheckin.id, checkedIn.id, `${context.driver} duplicate check-in returns same record`);
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM wellness_checkins WHERE reservation_id=?', [reservation.id], 'get')).total), 1);
  const baseline = await seedBaseline(context, guest.id, [
    { reservation, slot: chosen, label: '已参加并签到的基线项目' },
    { reservation: futureReservation, slot: futureChosen, label: '原计划的未来已确认预约' }
  ]);
  const baselineSchedule = await guestSchedule(context, guest.id);
  assert.equal(baselineSchedule.length, 2, `${context.driver} active baseline has two real confirmed appointments`);
  const baselineAppointments = baseline.items.map(item => ({ ...item,
    reservationId: item.reservationId,
    label: item.label }));
  await assertRetainedBaselineAppointments(context, guest.id, baselineAppointments, baseline.draftId, 'before feedback');

  const firstFeedback = success(await api(context, `/me/reservations/${encodeURIComponent(reservation.id)}/feedback`, { method: 'POST', token: guest.token,
    body: { feeling: 'uncomfortable', note: '本地验收：项目后感到不适。' } }), 201, `${context.driver} actual appointment feedback`);
  assert.equal(firstFeedback.reservationId, reservation.id);
  assert.equal(firstFeedback.checkinId, checkedIn.id);
  const editedFeedback = success(await api(context, `/me/feedback/${encodeURIComponent(firstFeedback.id)}`, { method: 'PUT', token: guest.token,
    body: { feeling: 'general', note: '本地验收：当日更正为一般。' } }), 200, `${context.driver} same-day feedback edit`);
  assert.equal(editedFeedback.id, firstFeedback.id);
  assert.equal(editedFeedback.revision, 2);
  assert.equal(editedFeedback.revisions.length, 2);
  const checkins = success(await api(context, '/me/checkins', { token: guest.token }), 200, `${context.driver} check-in and feedback readback`);
  const persistedAppointment = checkins.items.find(item => item.reservationId === reservation.id);
  assert.equal(persistedAppointment.checkin.id, checkedIn.id);
  assert.equal(persistedAppointment.feedback.id, firstFeedback.id);
  assert.equal(persistedAppointment.feedback.feeling, 'general');
  assert.equal(persistedAppointment.feedback.revision, 2);

  const healthRecord = success(await api(context, '/me/health-records', { method: 'POST', token: guest.token,
    body: { metric: 'blood_pressure', value: { systolic: 190, diastolic: 125 }, unit: 'mmHg', recordedAt: afterStart,
      note: '本地离线验收合成读数。' } }), 201, `${context.driver} outlier health record`);
  assert.equal(healthRecord.demoOutlier, true);
  const moodRecord = success(await api(context, '/me/moods', { method: 'POST', token: guest.token,
    body: { score: 2, note: '本地离线验收合成记录。' } }), 201, `${context.driver} mood record`);
  assert.equal(moodRecord.revision, 1);
  const moodUpdated = success(await api(context, `/me/moods/${moodRecord.id}`, { method: 'PUT', token: guest.token,
    body: { score: 1, note: '同一记录的第二版本。' } }), 200, `${context.driver} mood revision`);
  assert.equal(moodUpdated.id, moodRecord.id);
  assert.equal(moodUpdated.revision, 2);

  const events = success(await api(context, '/me/replanning-events', { token: guest.token }), 200, `${context.driver} source event list`);
  const feedbackEvent = events.items.find(item => item.sourceType === 'feedback' && item.sourceId === firstFeedback.id
    && Number(item.sourceVersion) === 1);
  const metricEvent = events.items.find(item => item.sourceType === 'health_metric' && item.sourceId === String(healthRecord.id) && item.requiresAttention);
  const moodEvent = events.items.find(item => item.sourceType === 'mood' && item.sourceId === String(moodRecord.id) && item.sourceVersion === 2);
  assert.ok(feedbackEvent, `${context.driver} feedback revision has an auditable source event`);
  assert.equal(feedbackEvent.requiresAttention, true, `${context.driver} actual uncomfortable feedback is the source that triggers replanning`);
  assert.ok(metricEvent, `${context.driver} outlier metric has an auditable source event`);
  assert.ok(moodEvent, `${context.driver} mood version has an auditable source event`);

  const beforeDrafts = Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM wellness_drafts WHERE guest_id=?', [guest.id], 'get')).total);
  const candidate = success(await api(context, `/me/replanning-events/${feedbackEvent.id}/evaluate`, { method: 'POST', token: guest.token, body: {} }), 200,
    `${context.driver} recorded-coordinator candidate`);
  assert.ok(candidate.candidate?.draftId, `${context.driver} replan evaluation creates a persisted candidate draft`);
  assert.equal(candidate.candidate.reviewStatus, 'pending_review', `${context.driver} replan candidate remains pending review`);
  assert.equal(candidate.candidate.reviewPolicy.mode, 'sampled_review');
  assert.equal(Number(candidate.candidate.reviewPolicy.samplePercent), 100);
  assert.equal(candidate.baseline.draftId, baseline.draftId);
  assert.equal(candidate.baseline.items.length, 2, `${context.driver} feedback replan compares against a nonempty active plan`);
  assert.ok(candidate.candidate.evidence.replanning?.sourceId === firstFeedback.id,
    `${context.driver} candidate evidence preserves source feedback ID`);
  assert.equal(Number(candidate.candidate.evidence.replanning.sourceVersion), 1);
  const afterFirstEvaluation = Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM wellness_drafts WHERE guest_id=?', [guest.id], 'get')).total);
  assert.equal(afterFirstEvaluation, beforeDrafts + 1, `${context.driver} one source version creates one candidate version`);
  const repeatedCandidate = success(await api(context, `/me/replanning-events/${feedbackEvent.id}/evaluate`, { method: 'POST', token: guest.token, body: {} }), 200,
    `${context.driver} repeated source consumption`);
  assert.equal(repeatedCandidate.candidate.draftId, candidate.candidate.draftId);
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM wellness_drafts WHERE guest_id=?', [guest.id], 'get')).total), afterFirstEvaluation,
    `${context.driver} repeat does not create another draft version`);
  assert.ok(candidate.changes.length > 0, `${context.driver} diff compares original and candidate items`);
  const reservationRows = await guestSchedule(context, guest.id);
  assert.equal(reservationRows.length, 2, `${context.driver} pending candidate leaves the original two-appointment schedule unchanged`);
  await assertRetainedBaselineAppointments(context, guest.id, baselineAppointments, baseline.draftId, 'while candidate is pending');
  const candidateSlots = await candidateActivitySlots(context, candidate.candidate.draftId);
  const candidateActivitySummary = candidate.candidate.items.filter(item => item.type === 'activity').map(item => ({
    businessDate: item.businessDate, title: item.title, status: item.status, localStart: item.localStart,
    sourceTypes: (item.sourceIds || []).map(source => source.type), reason: item.reason
  }));
  assert.ok(candidateSlots.length >= 1, `${context.driver} candidate has an actual future project slot for availability, overlap, and capacity rechecks; actual activity items: ${JSON.stringify(candidateActivitySummary)}`);
  assert.ok(candidateSlots.every(item => parseUtc(item.startsAt) > parseUtc(currentBusinessInstant(context))),
    `${context.driver} all candidate activity slots occur after the monotonic feedback time`);
  const futureStartMs = parseUtc(futureChosen.startsAt);
  const futureEndMs = parseUtc(futureChosen.endsAt);
  assert.ok(candidateSlots.every(item => !(parseUtc(item.startsAt) < futureEndMs && futureStartMs < parseUtc(item.endsAt))),
    `${context.driver} candidate plan avoids the committed future baseline appointment`);

  const sampledAuto = success(await api(context, `/me/replanning-events/${feedbackEvent.id}/auto-activate`, {
    method: 'POST', token: guest.token, body: {}
  }), 200, `${context.driver} sampled policy uses the shared activation gate`);
  assert.equal(sampledAuto.activated, false, `${context.driver} 100% sampled candidate stays pending for clinician review`);
  const assignment = await databaseQuery(context, `SELECT staff_id FROM staff_guest_assignments
    WHERE staff_id=? AND guest_id=? AND status='active' LIMIT 1`, [clinician.id, guest.id], 'get');
  if (!assignment) {
    const dean = await databaseQuery(context, "SELECT id FROM users WHERE role='dean' LIMIT 1", [], 'get');
    await databaseQuery(context, `INSERT INTO staff_guest_assignments
      (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at) VALUES(?,?,?,NULL,'active',?,?,?)`,
      [clinician.id, guest.id, sqlTime(context, afterStart), dean.id, sqlTime(context, afterStart), sqlTime(context, afterStart)], 'run');
  }
  const closedSlot = candidateSlots[0];
  const capacitySlot = candidateSlots[0];
  const conflictSlot = candidateSlots.at(-1);
  await databaseQuery(context, 'UPDATE activity_slots SET is_closed=1,updated_at=? WHERE id=?',
    [sqlTime(context, currentBusinessInstant(context)), closedSlot.slotId], 'run');
  const closedApproval = await api(context, `/staff/therapy-drafts/${encodeURIComponent(candidate.candidate.draftId)}/approve`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': `q24-approve-closed-${context.driver}-0001` },
    body: { version: candidate.candidate.version }
  });
  assert.equal(closedApproval.status, 409, `${context.driver} activation is rejected after the selected project slot closes`);
  const pendingAfterClosure = await databaseQuery(context, 'SELECT review_status,status FROM wellness_drafts WHERE id=?',
    [candidate.candidate.draftId], 'get');
  assert.equal(pendingAfterClosure.review_status, 'pending_review');
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM reservations WHERE wellness_draft_id=?',
    [candidate.candidate.draftId], 'get')).total), 0, `${context.driver} closed-slot failure rolls back every candidate reservation`);
  await assertRetainedBaselineAppointments(context, guest.id, baselineAppointments, baseline.draftId, 'after closed-slot failure');
  await databaseQuery(context, 'UPDATE activity_slots SET is_closed=0,updated_at=? WHERE id=?',
    [sqlTime(context, currentBusinessInstant(context)), closedSlot.slotId], 'run');

  const conflictBooking = success(await api(context, '/reservations', { method: 'POST', token: guest.token,
    headers: { 'Idempotency-Key': `q24-concurrent-conflict-${context.driver}-0001` }, body: { slotId: conflictSlot.slotId } }),
  201, `${context.driver} concurrent reservation occupies a candidate time`);
  const conflictApproval = await api(context, `/staff/therapy-drafts/${encodeURIComponent(candidate.candidate.draftId)}/approve`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': `q24-approve-conflict-${context.driver}-0001` },
    body: { version: candidate.candidate.version }
  });
  assert.equal(conflictApproval.status, 409, `${context.driver} approval rechecks guest reservation overlap in the shared transaction`);
  assert.equal(conflictApproval.data.code, 'RESERVATION_TIME_CONFLICT');
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM reservations WHERE wellness_draft_id=?',
    [candidate.candidate.draftId], 'get')).total), 0, `${context.driver} mid-plan time-conflict failure rolls back earlier candidate bookings`);
  const pendingAfterConflict = await databaseQuery(context, 'SELECT review_status,status FROM wellness_drafts WHERE id=?',
    [candidate.candidate.draftId], 'get');
  assert.equal(pendingAfterConflict.review_status, 'pending_review');
  await assertRetainedBaselineAppointments(context, guest.id, baselineAppointments, baseline.draftId, 'after overlap failure');
  const conflictCanceled = success(await api(context, `/reservations/${encodeURIComponent(conflictBooking.reservation.id)}`,
    { method: 'DELETE', token: guest.token }), 200, `${context.driver} unstarted conflict fixture is released through the normal cancellation path`);
  assert.equal(conflictCanceled.status, 'cancelled');
  assert.equal(conflictCanceled.id, conflictBooking.reservation.id);

  const capacityBefore = await databaseQuery(context, `SELECT capacity,is_closed,
      (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=activity_slots.id AND r.status='confirmed') AS booked
    FROM activity_slots WHERE id=?`, [capacitySlot.slotId], 'get');
  assert.equal(Number(capacityBefore.is_closed), 0);
  assert.ok(Number(capacityBefore.capacity) > Number(capacityBefore.booked), `${context.driver} candidate slot has a real remaining seat before recheck`);
  const competitor = await createReviewPolicyGuest(context, clinician.id);
  const competitorLogin = success(await api(context, '/auth/login', { method: 'POST', body: {
    username: competitor.username, password: 'guest2026', role: 'guest'
  } }), 200, `${context.driver} isolated capacity-competitor login`);
  await databaseQuery(context, 'UPDATE activity_slots SET capacity=?,updated_at=? WHERE id=?',
    [Number(capacityBefore.booked) + 1, sqlTime(context, currentBusinessInstant(context)), capacitySlot.slotId], 'run');
  const competitorBooking = success(await api(context, '/reservations', { method: 'POST', token: competitorLogin.token,
    headers: { 'Idempotency-Key': `q24-capacity-fill-${context.driver}-0001` }, body: { slotId: capacitySlot.slotId } }),
  201, `${context.driver} second guest consumes the last actual capacity`);
  const fullSlot = await databaseQuery(context, `SELECT capacity,
      (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=activity_slots.id AND r.status='confirmed') AS booked
    FROM activity_slots WHERE id=?`, [capacitySlot.slotId], 'get');
  assert.equal(Number(fullSlot.capacity), Number(fullSlot.booked), `${context.driver} capacity competitor fills the candidate slot`);
  const capacityApproval = await api(context, `/staff/therapy-drafts/${encodeURIComponent(candidate.candidate.draftId)}/approve`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': `q24-approve-full-${context.driver}-0001` },
    body: { version: candidate.candidate.version }
  });
  assert.equal(capacityApproval.status, 409, `${context.driver} approval rechecks actual slot capacity in the shared transaction`);
  assert.equal(capacityApproval.data.code, 'SLOT_FULL');
  assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM reservations WHERE wellness_draft_id=?',
    [candidate.candidate.draftId], 'get')).total), 0, `${context.driver} capacity failure rolls back every candidate reservation`);
  const pendingAfterCapacity = await databaseQuery(context, 'SELECT review_status,status FROM wellness_drafts WHERE id=?',
    [candidate.candidate.draftId], 'get');
  assert.equal(pendingAfterCapacity.review_status, 'pending_review');
  await assertRetainedBaselineAppointments(context, guest.id, baselineAppointments, baseline.draftId, 'after capacity failure');
  const competitorCanceled = success(await api(context, `/reservations/${encodeURIComponent(competitorBooking.reservation.id)}`,
    { method: 'DELETE', token: competitorLogin.token }), 200, `${context.driver} unstarted capacity fixture is released`);
  assert.equal(competitorCanceled.status, 'cancelled');
  await databaseQuery(context, 'UPDATE activity_slots SET capacity=?,is_closed=0,updated_at=? WHERE id=?',
    [Number(capacitySlot.capacity), sqlTime(context, currentBusinessInstant(context)), capacitySlot.slotId], 'run');

  const approved = success(await api(context, `/staff/therapy-drafts/${encodeURIComponent(candidate.candidate.draftId)}/approve`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': `q24-approve-after-rechecks-${context.driver}-0001` },
    body: { version: candidate.candidate.version }
  }), 200, `${context.driver} clinician approval after current time, overlap, capacity, and availability rechecks`);
  assert.equal(approved.reviewStatus, 'active', `${context.driver} clinician activation is persisted`);
  assert.ok(approved.reservations?.length > 0, `${context.driver} approved candidate creates actual appointments`);
  const approvedReservationIds = approved.reservations.map(item => item.id || item.reservation?.id || item.reservationId).filter(Boolean);
  assert.equal(approvedReservationIds.length, approved.reservations.length,
    `${context.driver} activation response identifies every linked reservation`);
  assert.ok(approved.reservations.every(item => item.status === 'confirmed' || item.reservation?.status === 'confirmed'),
    `${context.driver} activation response shows every linked reservation confirmed`);
  const actualCandidateReservations = await databaseQuery(context, `SELECT id,status,wellness_draft_id AS draftId
    FROM reservations WHERE wellness_draft_id=? ORDER BY id`, [candidate.candidate.draftId], 'all');
  assert.ok(actualCandidateReservations.length > 0, `${context.driver} approval persists candidate-linked reservations`);
  assert.ok(actualCandidateReservations.every(item => item.status === 'confirmed' && item.draftId === candidate.candidate.draftId),
    `${context.driver} approval persists only confirmed reservations linked to its candidate`);
  assert.deepEqual([...approvedReservationIds].sort(), actualCandidateReservations.map(item => item.id).sort(),
    `${context.driver} activation response IDs match the actual database reservations`);
  const reviewEvent = await databaseQuery(context, `SELECT action,from_version,to_version,payload_json FROM wellness_review_events
    WHERE draft_id=? AND actor_id=? ORDER BY created_at DESC LIMIT 1`, [candidate.candidate.draftId, clinician.id], 'get');
  assert.equal(reviewEvent.action, 'approved');
  assert.equal(Number(reviewEvent.from_version), Number(candidate.candidate.version));
  assert.equal(Number(reviewEvent.to_version), Number(candidate.candidate.version));
  const approvalPayload = typeof reviewEvent.payload_json === 'string' ? JSON.parse(reviewEvent.payload_json) : reviewEvent.payload_json;
  assert.ok(approvalPayload.reservations.length > 0, `${context.driver} immutable approval event stores reservation business IDs`);
  assert.deepEqual(approvalPayload.reservations.map(item => item.reservationId).sort(),
    actualCandidateReservations.map(item => item.id).sort(), `${context.driver} immutable approval event IDs match database reservations`);

  const baselineAfterApproval = await databaseQuery(context, 'SELECT review_status,status FROM wellness_drafts WHERE id=?',
    [baseline.draftId], 'get');
  assert.equal(baselineAfterApproval.review_status, 'active', `${context.driver} prior plan remains auditable as the source version`);
  await assertRetainedBaselineAppointments(context, guest.id, baselineAppointments, baseline.draftId,
    'after approved additive replan');
  const sourceEventAfterApproval = await databaseQuery(context, `SELECT source_type AS sourceType,source_id AS sourceId,
      source_version AS sourceVersion,baseline_draft_id AS baselineDraftId,candidate_draft_id AS candidateDraftId
    FROM wellness_replan_events WHERE id=? AND guest_id=?`, [feedbackEvent.id, guest.id], 'get');
  assert.equal(sourceEventAfterApproval.sourceType, 'feedback');
  assert.equal(sourceEventAfterApproval.sourceId, firstFeedback.id);
  assert.equal(Number(sourceEventAfterApproval.sourceVersion), Number(feedbackEvent.sourceVersion));
  assert.equal(sourceEventAfterApproval.baselineDraftId, baseline.draftId);
  assert.equal(sourceEventAfterApproval.candidateDraftId, candidate.candidate.draftId);
  const sourceEventReadback = success(await api(context, '/me/replanning-events', { token: guest.token }), 200,
    `${context.driver} post-approval source event readback`);
  const activeSourceEvent = sourceEventReadback.items.find(item => item.id === feedbackEvent.id);
  assert.equal(activeSourceEvent.status, 'active');
  assert.equal(activeSourceEvent.candidateStatus, 'active');
  assert.equal(activeSourceEvent.candidate.version, candidate.candidate.version);
  const candidateDraftAfterApproval = await databaseQuery(context, 'SELECT version,review_status,status FROM wellness_drafts WHERE id=?',
    [candidate.candidate.draftId], 'get');
  assert.equal(Number(candidateDraftAfterApproval.version), Number(candidate.candidate.version));
  assert.equal(candidateDraftAfterApproval.review_status, 'active');
  assert.equal(candidateDraftAfterApproval.status, 'active');
  const approvedFutureRows = await databaseQuery(context, `SELECT r.id,r.status,r.wellness_draft_id AS draftId,
      s.starts_at AS startsAt,s.business_date AS businessDate FROM reservations r
    JOIN activity_slots s ON s.id=r.slot_id WHERE r.wellness_draft_id=? ORDER BY s.starts_at`,
  [candidate.candidate.draftId]);
  assert.ok(approvedFutureRows.every(item => parseUtc(item.startsAt) > parseUtc(currentBusinessInstant(context))),
    `${context.driver} newly activated candidate reservations are genuinely future appointments`);
  const approvedEventCount = Number((await databaseQuery(context, `SELECT COUNT(*) AS total FROM wellness_review_events
    WHERE draft_id=? AND action='approved'`, [candidate.candidate.draftId], 'get')).total);
  assert.equal(approvedEventCount, 1, `${context.driver} successful activation has exactly one immutable approval event`);
  const scheduleAfterApproval = await guestSchedule(context, guest.id);
  assert.equal(scheduleAfterApproval.length, baselineAppointments.length + actualCandidateReservations.length,
    `${context.driver} latest plan adds non-conflicting future commitments without replacing earlier reservations`);
  const attendedFeedbackRows = await databaseQuery(context, `SELECT c.id AS checkinId,f.id AS feedbackId,f.revision
    FROM wellness_checkins c JOIN wellness_feedback f ON f.reservation_id=c.reservation_id
    WHERE c.reservation_id=? AND f.id=?`, [reservation.id, firstFeedback.id], 'get');
  assert.equal(attendedFeedbackRows.checkinId, checkedIn.id);
  assert.equal(attendedFeedbackRows.feedbackId, firstFeedback.id);
  assert.equal(Number(attendedFeedbackRows.revision), 2,
    `${context.driver} approved replan preserves the attended reservation check-in and feedback history`);

  const moodTrend = success(await api(context, '/me/mood-trends?days=30', { token: guest.token }), 200,
    `${context.driver} mood trend with replan markers`);
  const trendMarker = moodTrend.replanEvents.find(item => item.id === moodEvent.id);
  assert.equal(trendMarker.sourceId, moodRecord.id);
  assert.ok(trendMarker.candidateVersion == null, 'mood marker does not claim an unrelated candidate version');

  const midnight = new Date(Date.parse(`${day}T16:01:00.000Z`)).toISOString(); // 00:01 Shanghai on the next day
  await restartApiWithClock(context, midnight);
  const staleEdit = await api(context, `/me/feedback/${encodeURIComponent(firstFeedback.id)}`, { method: 'PUT', token: guest.token,
    body: { feeling: 'comfortable', note: '跨日必须拒绝。' } });
  assert.equal(staleEdit.status, 409, `${context.driver} feedback edit is rejected after Shanghai midnight`);
  assert.equal(staleEdit.data.code, 'WELLNESS_FEEDBACK_EDIT_WINDOW_CLOSED');
  const revisionCount = Number((await databaseQuery(context, 'SELECT COUNT(*) AS total FROM wellness_feedback_revisions WHERE feedback_id=?', [firstFeedback.id], 'get')).total);
  assert.equal(revisionCount, 2, `${context.driver} rejected cross-day update leaves revision history unchanged`);
  const healthPolicy = await runHealthReviewPolicyAcceptance(context, clinician.id);

  return { driver: context.driver, reservationId: reservation.id, slotId: reservation.slotId, checkinId: checkedIn.id,
    feedbackId: firstFeedback.id, feedbackRevisions: revisionCount, moodRecordId: moodRecord.id,
    healthRecordId: healthRecord.id, feedbackSourceEventId: feedbackEvent.id, metricSourceEventId: metricEvent.id,
    moodSourceEventId: moodEvent.id, baselineDraftId: baseline.draftId, baselineItemCount: baseline.items.length,
    futureReservationId: futureReservation.id, candidateDraftId: candidate.candidate.draftId,
    candidateVersion: candidate.candidate.version, diffRows: candidate.changes.length, pendingAppointmentCount: reservationRows.length,
    exactCheckinDuplicate: duplicateCheckin.id === checkedIn.id, repeatedEvaluationDeduplicated: repeatedCandidate.candidate.draftId === candidate.candidate.draftId,
    sampledAutoActivationBlocked: !sampledAuto.activated, capacityRecheckSlotId: capacitySlot.slotId,
    closedSlotFailureStatus: closedApproval.status, overlapFailureStatus: conflictApproval.status,
    overlapFailureCode: conflictApproval.data.code, overlapConflictReservationId: conflictBooking.reservation.id,
    overlapConflictReservationRetainedAsCancelledHistory: conflictCanceled.status === 'cancelled',
    capacityFailureStatus: capacityApproval.status, capacityFailureCode: capacityApproval.data.code,
    capacityCompetitorReservationId: competitorBooking.reservation.id,
    capacityCompetitorRetainedAsCancelledHistory: competitorCanceled.status === 'cancelled',
    successfulApprovalStatus: 200, approvedReservationCount: approved.reservations.length,
    legacyFutureDisposition: 'confirmed and linked to prior active baseline; new version adds non-overlapping future commitments',
    attendedReservationStatusAfterApproval: 'confirmed', healthPolicy,
  };
}

async function runBackendAcceptance(resourceSession) {
  let model;
  try {
    model = await startRecordedModel(resourceSession);
    const results = [];
    await withBothDatabaseApis(async context => {
      context.modelBaseUrl = model.baseUrl;
      const detail = await stage24Driver(context);
      results.push(detail);
      appendEvidence({ quest: 'Q24.backend', driver: context.driver, status: 'PASS', fixtureMode: 'recorded_fixture', evidence: detail });
    }, { resourceSession, env: { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: initialInstant,
      LLM_BASE_URL: model.baseUrl, LLM_API_KEY: 'q24-recorded-fixture-only', LLM_MODEL: 'recorded-stage22-fixture',
      LLM_TIMEOUT_MS: '30000', ASSISTANT_MODEL_SOURCE: 'recorded_fixture',
      WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '100' } });
    return results;
  } catch (error) {
    appendEvidence({ quest: 'Q24.backend', status: 'FAIL', fixtureMode: 'recorded_fixture', failure: String(error.stack || error).slice(0, 12_000) });
    throw error;
  } finally { if (model) await stopRecordedModel(resourceSession, model); }
}

export async function run({ questId, stage, resourceSession }) {
  if (!resourceSession) throw new Error('Stage24 acceptance requires a ResourceSession');
  if (process.env.QUEST_LIVE === '1') throw new Error('Stage24 cannot run with provider credentials or live mode');
  if (!backendResultPromise) backendResultPromise = runBackendAcceptance(resourceSession);
  const backend = await backendResultPromise;
  const backendSummary = backend.map(item => `${item.driver}: 예약 ${item.reservationId}，签到 ${item.checkinId}，反馈 ${item.feedbackId}，候选 ${item.candidateDraftId}`).join('；');
  const policySummary = backend.map(item => `${item.driver}: 健康自动 ${item.healthPolicy.healthyCandidateDraftId} / ${item.healthPolicy.healthyAutoReservationCount} 个确认预约；强制待审候选 慢病 ${item.healthPolicy.chronic.candidateDraftId}、过敏 ${item.healthPolicy.allergy.candidateDraftId}、未核实 ${item.healthPolicy.unknown.candidateDraftId}`).join('；');
  if (questId === 'Q24.1') return { output: [`Q24.1 双库开始前拒绝、本人签到、重复签到与真实预约归属通过；${backendSummary}`] };
  if (questId === 'Q24.3') return { output: [`Q24.3 双库反馈关联、当天版本保留、跨日拒绝无痕改写通过；${backendSummary}`] };
  if (questId === 'Q24.5') return { output: [`Q24.5 双库反馈/指标/心情源事件及同来源版本幂等通过；${backendSummary}`] };
  if (questId === 'Q24.6' && stage !== 24) return { output: [`Q24.6 双库候选与活动时段差异、待审不占用、重复来源去重通过；${backendSummary}`] };
  if (questId === 'Q24.7') return { output: [`Q24.7 双库使用真实参与反馈与非空计划；关闭时段、同客预约冲突和容量满额均在统一审批事务内重核并完整回滚，成功版本只追加不冲突的未来预约且保留原已参加与未来承诺；健康抽检、auto激活及慢病/过敏/未核实强制待审均通过；${policySummary}；${backendSummary}`] };

  if (!browserResultPromise) {
    browserResultPromise = import('../resources/stage24-browser-acceptance.js')
      .then(module => module.runStage24BrowserAcceptance({ resourceSession }))
      .then(result => {
        appendEvidence({ quest: 'Q24.browser', status: 'PASS', fixtureMode: 'recorded_fixture', evidence: {
          evidencePath: result.evidencePath, screenshotDirectory: result.screenshotDirectory,
          appointmentId: result.currentAppointmentId, checkinId: result.checkinId, feedbackId: result.feedbackId,
          feedbackRevision: result.feedbackRevision, moodSourceEventId: result.moodSourceEventId,
          candidateDraftId: result.candidateDraftId, candidateVersion: result.candidateVersion,
          diffRows: result.diffRows, layout: result.layout, screenshots: result.screenshots,
          resourceIds: result.resources.map(item => item.id), disk: { before: result.dfBefore, after: result.dfAfter }
        } });
        return result;
      });
  }
  const browser = await browserResultPromise;
  const browserSummary = `预约 ${browser.currentAppointmentId}，签到 ${browser.checkinId}，反馈 v${browser.feedbackRevision}，心情 ${browser.moodRecordId}，候选 ${browser.candidateDraftId} v${browser.candidateVersion}，差异 ${browser.diffRows} 项`;
  if (questId === 'Q24.2') return { output: [`Q24.2 浏览器点击真实已开始预约签到，刷新后仍显示实际签到ID；${browserSummary}`] };
  if (questId === 'Q24.4') return { output: [`Q24.4 浏览器提交不适、刷新并当天更正为一般；旧日反馈只读；${browserSummary}`] };
  if (questId === 'Q24.6') return { output: [`Q24.6 双库候选与活动时段差异、待审不占用、重复来源去重通过；浏览器差异卡显示原版、来源、候选版本和待审核状态；${backendSummary}；${browserSummary}`] };
  if (questId === 'Q24.8') return { output: [`Q24.8 双库30日趋势关联真实心情来源；浏览器显示来源ID、候选版本和审核状态，且不作因果表述；${backendSummary}；${browserSummary}`] };
  return { output: [`${questId} 阶段24受管验收数据已由共享双库和浏览器流程覆盖；${backendSummary}；截图目录 ${path.relative(projectRoot, browser.screenshotDirectory)}。`,
    `Recorded model fixture only; no provider request. Evidence appended to ${path.relative(projectRoot, sourceEvidencePath)}.`] };
}
