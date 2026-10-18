import test from 'node:test';
import assert from 'node:assert/strict';
import { recordedProvider } from '../../scripts/bugfix-stage3b/recorded-provider.js';
Object.assign(process.env, { DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0', ASSISTANT_MODEL_SOURCE: 'recorded_fixture',
  BUSINESS_CLOCK_NOW: '2030-01-01T04:00:00.000Z' });
const model = await recordedProvider();
Object.assign(process.env, { LLM_BASE_URL: model.url, LLM_API_KEY: 'local-fixture-only', LLM_MODEL: 'local-recorded-fixture' });
const { db, transaction, now } = await import('../src/db.js');
const followup = await import('../src/wellness-followup.js');
const planner = await import('../src/wellness-planner.js');
const queries = await import('../src/wellness-draft-queries.js');
const changes = await import('../src/wellness-draft-changes.js');
const sources = await import('../src/wellness-source-events.js');
const operations = await import('../src/operations.js');
const { createHealthRecord, validateHealthMetricInput } = await import('../src/health-metrics.js');
const { createMoodRecord, updateMoodRecord } = await import('../src/mood.js');
const user = { id: 'g46-guest', role: 'guest' };
const rollback = new Error('synthetic outer rollback');
test.after(async () => { await model.close(); await db.close(); });
await db.prepare("INSERT INTO users(id,username,password_hash,role,name) VALUES(?,?,?,'guest',?)")
  .run(user.id, user.id, 'synthetic-unused-hash', 'G46合成客人');
await db.prepare(`INSERT INTO guest_profiles(user_id,check_in,check_out,room_no,chronic_json,allergies_json,health_profile_json)
  VALUES(?,'2030-01-01','2030-01-04','SYNTHETIC','[]','[]','{}')`).run(user.id);

async function count(table) { return Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n); }
async function reservation(name, date = '2030-01-01') {
  const slotId = `g46-slot-${name}`, reservationId = `g46-res-${name}`;
  const minute = String(['feedback', 'rest', 'no-show', 'weather'].indexOf(name) + 1).padStart(2, '0');
  await db.prepare(`INSERT INTO activity_slots(id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,created_at,updated_at)
    VALUES(?,'project-beach-walk',?,?,?,?,?,4,?,?)`)
    .run(slotId, date, `${date}T00:${minute}:00.000Z`, `${date}T01:${minute}:00.000Z`, `08:${minute}`, `09:${minute}`, now(), now());
  await db.prepare(`INSERT INTO reservations(id,guest_id,slot_id,idempotency_key,request_fingerprint,status,created_at,
    environment_snapshot_id,availability_status,availability_reason)
    VALUES(?,?,?,?,?,'confirmed',?,'g46-synthetic','available','synthetic fixture only')`)
    .run(reservationId, user.id, slotId, name, name, now());
  return { reservationId, slotId };
}

test('G46: legacy business exports are identical function references to their lower layers', async () => {
  for (const name of ['getWellnessDraft', 'listWellnessDrafts', 'wellnessTimeline']) assert.equal(planner[name], queries[name]);
  assert.equal(planner.createRestChangeDraft, changes.createRestChangeDraft);
  for (const name of ['recordReplanSourceEvent', 'markReplanDraftActive']) assert.equal(followup[name], sources[name]);
  const old = await import('../src/stage26-operations.js');
  assert.deepEqual(Object.keys(old), Object.keys(operations));
  for (const name of Object.keys(old)) assert.equal(old[name], operations[name]);
});

test('G46: source identity is versioned and immutable, and joins an outer rollback', async () => {
  const input = { guestId: user.id, sourceType: 'feedback', sourceId: 'g46-source', sourceVersion: 1,
    sourceLabel: 'synthetic snapshot', sourceSnapshot: { feeling: 'uncomfortable' }, requiresAttention: true };
  const first = await sources.recordReplanSourceEvent(input);
  assert.equal((await sources.recordReplanSourceEvent({ ...input, sourceSnapshot: { replaced: true } })).id, first.id);
  assert.deepEqual(JSON.parse((await db.prepare('SELECT source_snapshot_json FROM wellness_replan_events WHERE id=?').get(first.id)).source_snapshot_json), input.sourceSnapshot);
  await assert.rejects(transaction(async () => {
    await sources.recordReplanSourceEvent({ ...input, sourceVersion: 2 }); throw rollback;
  }), error => error === rollback);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM wellness_replan_events WHERE source_id=?').get(input.sourceId)).n, 1);
  await assert.rejects(sources.recordReplanSourceEvent({ ...input, sourceType: 'unsupported' }), /unsupported/);
  await assert.rejects(sources.recordReplanSourceEvent({ ...input, sourceVersion: 0 }), /positive integer/);
});

test('G46: actual health and mood writes retain source snapshots and share caller transactions', async () => {
  const healthInput = { ...validateHealthMetricInput({ metric: 'steps', value: 9000, unit: '步',
    recordedAt: '2030-01-01T03:00:00.000Z' }, user), source: 'guest' };
  const before = { health: await count('health_records'), mood: await count('mood_records'), events: await count('wellness_replan_events') };
  await assert.rejects(transaction(async () => {
    await createHealthRecord(healthInput);
    await createMoodRecord({ guestId: user.id, actorId: user.id, score: 2, note: 'synthetic rollback' });
    throw rollback;
  }), error => error === rollback);
  assert.equal(await count('health_records'), before.health); assert.equal(await count('mood_records'), before.mood);
  assert.equal(await count('wellness_replan_events'), before.events);
  const health = await createHealthRecord(healthInput);
  const mood = await createMoodRecord({ guestId: user.id, actorId: user.id, score: 2, note: 'synthetic first' });
  const revised = await updateMoodRecord({ guestId: user.id, actorId: user.id, recordId: mood.id, score: 3, note: 'synthetic revision' });
  assert.equal(revised.revision, 2);
  const rows = await db.prepare('SELECT * FROM wellness_replan_events WHERE guest_id=? AND source_type IN (\'health_metric\',\'mood\') ORDER BY source_type,source_version').all(user.id);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].source_id, String(health.id));
  assert.deepEqual(rows.slice(1).map(row => [row.source_version, JSON.parse(row.source_snapshot_json).score]), [[1, 2], [2, 3]]);
  assert.equal(await count('agent_runs'), 0, 'recording a source must not invoke the planning/model chain');
});

test('G46: check-in feedback revisions, service projection and source creation remain atomic', async () => {
  const { reservationId } = await reservation('feedback');
  const checkin = await followup.createGuestCheckin({ guestId: user.id, reservationId });
  assert.equal((await followup.createGuestCheckin({ guestId: user.id, reservationId })).replayed, true);
  const feedback = await followup.createGuestFeedback({ guestId: user.id, reservationId, body: { feeling: 'uncomfortable', note: 'synthetic feedback' } });
  assert.equal(feedback.checkinId, checkin.id);
  const update = await followup.updateGuestFeedback({ guestId: user.id, feedbackId: feedback.id, body: { feeling: 'general', note: 'synthetic corrected' } });
  assert.equal(update.revision, 2); assert.deepEqual(update.revisions.map(row => row.feeling), ['uncomfortable', 'general']);
  const row = (await followup.listGuestCheckins(user.id)).items.find(item => item.reservationId === reservationId);
  assert.equal(row.feedback.id, feedback.id); assert.deepEqual(row.executions, []);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM wellness_replan_events WHERE source_type='feedback' AND source_id=?").get(feedback.id)).n, 2);
});

let evaluated;
test('G46: actual replan evaluation calls the local recorded coordinator once and preserves source evidence', async () => {
  const source = await sources.recordReplanSourceEvent({ guestId: user.id, sourceType: 'mood', sourceId: 'g46-evaluate',
    sourceVersion: 1, sourceLabel: '合成来源', sourceSnapshot: { score: 2 }, requiresAttention: true });
  evaluated = await followup.evaluateReplanEvent({ user, eventId: source.id });
  assert.ok(evaluated.candidate.draftId); assert.equal(evaluated.status, 'pending_review');
  assert.equal(evaluated.candidate.evidence.replanning.eventId, source.id);
  assert.equal(evaluated.candidate.evidence.replanning.sourceVersion, 1);
  const runs = await count('agent_runs'); assert.ok(runs > 0);
  assert.equal((await followup.evaluateReplanEvent({ user, eventId: source.id })).candidate.draftId, evaluated.candidate.draftId);
  assert.equal(await count('agent_runs'), runs);
  assert.equal((await queries.getWellnessDraft(user.id, evaluated.candidate.draftId)).draftId, evaluated.candidate.draftId);
  assert.ok((await queries.listWellnessDrafts(user.id)).some(row => row.draftId === evaluated.candidate.draftId));
  assert.ok((await followup.listReplanEvents(user.id)).items.some(row => row.id === source.id));
  await assert.rejects(queries.getWellnessDraft('different-guest', evaluated.candidate.draftId), error => error.code === 'WELLNESS_DRAFT_NOT_FOUND');
});

test('G46: replan activation rejects an obsolete candidate and activates only the current version', async () => {
  const draftId = 'g46-current-rest';
  const latest = Number((await db.prepare('SELECT MAX(version) AS version FROM wellness_drafts WHERE guest_id=?').get(user.id)).version);
  await db.prepare(`INSERT INTO wellness_drafts(id,guest_id,version,request_key,stay_start,stay_end,status,review_policy,
    review_sample_percent,evidence_json,created_at,review_status,review_thread_id)
    VALUES(?,?,?,'g46-current-rest','2030-01-01','2030-01-04','pending_review','auto',0,'{}',?,'pending_review',?)`)
    .run(draftId, user.id, latest + 1, now(), draftId);
  const old = await followup.activateReplanEvent({ user, eventId: evaluated.id });
  assert.equal(old.activated, false);
  const source = await sources.recordReplanSourceEvent({ guestId: user.id, sourceType: 'feedback', sourceId: 'g46-current-event' });
  await db.prepare('UPDATE wellness_replan_events SET candidate_draft_id=? WHERE id=?').run(draftId, source.id);
  const active = await followup.activateReplanEvent({ user, eventId: source.id });
  assert.equal(active.activated, true); assert.equal(active.detail.status, 'active');
  assert.equal(active.detail.candidate.reviewStatus, 'auto_activated');
  assert.equal((await followup.activateReplanEvent({ user, eventId: source.id })).activated, false);
  await assert.rejects(followup.evaluateReplanEvent({ user: { role: 'staff' }, eventId: source.id }), error => error.status === 403);
});

test('G46: rest-change joins rollback and replays without duplicating draft or audit history', async () => {
  const { reservationId } = await reservation('rest');
  await db.prepare("UPDATE reservations SET status='cancelled' WHERE id=?").run(reservationId);
  const input = { user, reservationId, sessionId: null, sourceRunId: null, actionCardId: 'g46-synthetic-action',
    reason: '合成休息调整', requestKey: 'g46-rest-change' };
  const countBefore = await count('wellness_drafts');
  await assert.rejects(transaction(async () => { await changes.createRestChangeDraft(input); throw rollback; }), error => error === rollback);
  assert.equal(await count('wellness_drafts'), countBefore);
  const first = await changes.createRestChangeDraft(input);
  assert.equal(first.reviewStatus, 'pending_review'); assert.equal(first.evidence.sourceReservationId, reservationId);
  const audits = await count('audit_logs');
  const again = await planner.createRestChangeDraft(input);
  assert.equal(again.draftId, first.draftId); assert.equal(again.deduplicated, true);
  assert.equal(await count('audit_logs'), audits); assert.equal(await count('wellness_drafts'), countBefore + 1);
});

test('G46: domain operations retain no-show guards and atomic weather cancellation with notices', async () => {
  const noShow = await reservation('no-show');
  assert.equal((await operations.markReservationNoShow({ ...noShow, actorId: 'staff_001' })).replayed, false);
  assert.equal((await operations.markReservationNoShow({ ...noShow, actorId: 'staff_001' })).replayed, true);
  await assert.rejects(followup.createGuestCheckin({ guestId: user.id, reservationId: noShow.reservationId }), error => error.code === 'CHECKIN_NO_SHOW_RECORDED');
  const weather = await reservation('weather', '2030-01-02');
  await db.prepare(`INSERT INTO environment_snapshots(snapshot_key,location_id,target_date,domain,status,source_name,
    expires_at,payload_hash,payload_json,created_at,updated_at) VALUES('g46-weather','synthetic','2030-01-02','weather','demo','synthetic fixture',?,'synthetic','{}',?,?)`)
    .run('2030-01-03T00:00:00.000Z', now(), now());
  const input = { actorId: 'staff_001', slotIds: [weather.slotId], snapshotKey: 'g46-weather', requestKey: 'g46-weather-cancel', reason: '合成天气处理' };
  assert.equal((await operations.previewWeatherCancellation(input)).totalReservations, 1);
  const notices = await count('wellness_local_notifications');
  await assert.rejects(transaction(async () => { await operations.cancelWeatherAffectedSlots(input); throw rollback; }), error => error === rollback);
  assert.equal((await db.prepare('SELECT status FROM reservations WHERE id=?').get(weather.reservationId)).status, 'confirmed');
  assert.equal(await count('wellness_local_notifications'), notices);
  const result = await operations.cancelWeatherAffectedSlots(input);
  assert.equal(result.cancelledCount, 1); assert.ok(result.items[0].notificationId);
  assert.equal((await operations.cancelWeatherAffectedSlots(input)).replayed, true);
  assert.equal(await count('wellness_local_notifications'), notices + 1);
  assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);
});
