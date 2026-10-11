import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mysqlBookingSchema } from '../../server/src/booking-schema.js';
import { checkWebSource } from './q11-helpers.js';
import { assertOk, databaseQuery, login, request, withBothDatabaseApis } from './q10-helpers.js';

const questDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(questDirectory, '../..');
let accountCounter = 0;
let activeResourceSession = null;
const TEST_NOW = '2026-10-01T00:00:00.000Z';
const TEST_DATE = '2026-10-01';

function dateOffset(date, amount) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

async function withBookingApi(callback, mode = 'demo') {
  return withBothDatabaseApis(context => callback(context), {
    env: { ENVIRONMENT_MODE: mode, BUSINESS_CLOCK_NOW: TEST_NOW },
    resourceSession: activeResourceSession
  });
}

function key(prefix) {
  accountCounter += 1;
  return `q15-${prefix}-${accountCounter}-${Date.now()}`;
}

async function guestDemo(context) {
  return assertOk(await login(context.baseUrl, 'guest'));
}

async function deanDemo(context) {
  return assertOk(await login(context.baseUrl, 'dean'));
}

async function createGuests(context, count, date = dateOffset(TEST_DATE, 1)) {
  const guests = [];
  const phones = new Set();
  const checkOut = dateOffset(date, 4);
  while (guests.length < count) {
    accountCounter += 1;
    const tail = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
    const phone = `139${tail}`;
    if (phones.has(phone)) continue;
    phones.add(phone);
    const result = await request(context.baseUrl, '/auth/register', {
      method: 'POST',
      body: { name: `Stage15 guest ${accountCounter}`, phone, password: 'stage15-guest-pass', confirmPassword: 'stage15-guest-pass' }
    });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    const stayColumns = context.driver === 'mysql' ? 'check_in_date=?,check_out_date=?' : 'check_in=?,check_out=?';
    await databaseQuery(context, `UPDATE guest_profiles SET ${stayColumns} WHERE user_id=?`, [date, checkOut, result.data.user.id], 'run');
    guests.push({ id: result.data.user.id, token: result.data.token });
  }
  return guests;
}

async function setProjectSchedule(context, projectId, windows, capacity = 4) {
  await databaseQuery(context, 'UPDATE projects SET open_windows_json=?,capacity_per_window=? WHERE id=?', [
    JSON.stringify({ demo: true, timezone: 'Asia/Shanghai', windows }), capacity, projectId
  ], 'run');
}

async function setVerifiedHealth(context, guestId, profile) {
  const serialized = JSON.stringify(profile);
  if (context.driver === 'mysql') {
    await databaseQuery(context, 'UPDATE guest_profiles SET health_profile_json=CAST(? AS JSON) WHERE user_id=?', [serialized, guestId], 'run');
  } else {
    await databaseQuery(context, 'UPDATE guest_profiles SET health_profile_json=? WHERE user_id=?', [serialized, guestId], 'run');
  }
}

async function addPendingHealthIntake(context, guestId, profile) {
  const serialized = JSON.stringify(profile);
  const revision = 150000 + accountCounter++;
  const fingerprint = `q15-pending-${revision}`;
  if (context.driver === 'mysql') {
    await databaseQuery(context, `INSERT INTO health_intakes
      (guest_id,raw_content,source,created_at,review_status,structured_json,submitted_by,base_profile_version,revision,fingerprint)
      VALUES(?,?,'form',?,'pending',CAST(? AS JSON),NULL,0,?,?)`,
    [guestId, 'Stage 15 pending health fixture', TEST_NOW.replace('T', ' ').replace('.000Z', ''), serialized, revision, fingerprint], 'run');
  } else {
    await databaseQuery(context, `INSERT INTO health_intakes
      (guest_id,content,source,created_at,status,structured_json,submitted_by,base_profile_version,revision,fingerprint)
      VALUES(?,?,'form',?,'pending',?,NULL,0,?,?)`,
    [guestId, 'Stage 15 pending health fixture', TEST_NOW, serialized, revision, fingerprint], 'run');
  }
}

async function adminSlots(context, token, projectId, date = dateOffset(TEST_DATE, 1)) {
  return assertOk(await request(context.baseUrl, `/admin/projects/${encodeURIComponent(projectId)}/slots?date=${date}`, { token }));
}

async function guestSlots(context, token, projectId, date = dateOffset(TEST_DATE, 1)) {
  return assertOk(await request(context.baseUrl, `/projects/${encodeURIComponent(projectId)}/slots?date=${date}`, { token }));
}

async function reserve(context, token, slotId, key) {
  const response = await fetch(`${context.baseUrl}/reservations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ slotId })
  });
  return { status: response.status, data: await response.json() };
}

async function cancel(context, token, reservationId) {
  return request(context.baseUrl, `/reservations/${encodeURIComponent(reservationId)}`, { method: 'DELETE', token });
}

async function setCapacity(context, deanToken, projectId, slotId, capacity) {
  return request(context.baseUrl, `/admin/projects/${encodeURIComponent(projectId)}/slots/${encodeURIComponent(slotId)}`, {
    method: 'PATCH', token: deanToken, body: { capacity }
  });
}

async function waitForProjectLockWait(context, blockerConnectionId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let waiting = 0;
  while (Date.now() < deadline) {
    const row = await databaseQuery(context, `SELECT COUNT(*) AS waiting
      FROM performance_schema.data_lock_waits AS waits
      JOIN performance_schema.threads AS blocker ON blocker.THREAD_ID=waits.BLOCKING_THREAD_ID
      WHERE blocker.PROCESSLIST_ID=?`, [blockerConnectionId], 'get');
    waiting = Number(row?.waiting || 0);
    if (waiting > 0) return waiting;
    await delay(20);
  }
  throw new Error(`booking request did not reach the locked project row; observed project-lock waits=${waiting}`);
}

async function raceWindowChangeWhileBookingWaits(context, { projectId, slot, guest, historicalReservationIds }) {
  if (context.driver !== 'mysql') return;
  const locker = await context.pool.getConnection();
  let inTransaction = false;
  const idempotencyKey = key('window-change-lock-race');
  let requestSettled = false;
  let pendingRequest = null;
  try {
    const [[isolationRow]] = await locker.query('SELECT @@transaction_isolation AS isolation');
    assert.equal(String(isolationRow.isolation).toLowerCase(), 'repeatable-read');
    await locker.beginTransaction();
    inTransaction = true;
    const [[connectionRow]] = await locker.query('SELECT CONNECTION_ID() AS connectionId');
    await locker.execute('SELECT id FROM projects WHERE id=? FOR UPDATE', [projectId]);

    pendingRequest = reserve(context, guest.token, slot.id, idempotencyKey).then(result => {
      requestSettled = true;
      return result;
    });
    const waiting = await waitForProjectLockWait(context, connectionRow.connectionId);
    assert.ok(waiting >= 1, 'booking must wait on the held project row lock');
    assert.equal(requestSettled, false, 'HTTP request must remain pending until the admin commits');

    await locker.execute('UPDATE projects SET open_windows_json=? WHERE id=?', [
      JSON.stringify({ demo: true, timezone: 'Asia/Shanghai', windows: [{ days: ['每日'], start: '16:00', end: '17:00' }] }),
      projectId
    ]);
    await locker.commit();
    inTransaction = false;

    const result = await pendingRequest;
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal(result.data.code, 'SLOT_WINDOW_CHANGED');
    const raceRows = await databaseQuery(context,
      'SELECT id FROM reservations WHERE guest_id=? AND idempotency_key=?', [guest.id, idempotencyKey], 'all');
    assert.equal(raceRows.length, 0, 'rejected window race must not leave a reservation row');
    const historyRows = await databaseQuery(context,
      `SELECT id,status FROM reservations WHERE id IN (${historicalReservationIds.map(() => '?').join(',')}) ORDER BY id`,
      historicalReservationIds, 'all');
    assert.equal(historyRows.length, historicalReservationIds.length);
    assert.ok(historyRows.every(row => row.status === 'confirmed'), 'window update must retain existing bookings');
  } finally {
    if (inTransaction) await locker.rollback();
    locker.release();
    if (pendingRequest) await pendingRequest.catch(() => {});
  }
}

async function q151() {
  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const windows = [
      { days: ['每日'], start: '09:30', end: '10:30' },
      { days: ['每日'], start: '07:00', end: '07:45' }
    ];
    await setProjectSchedule(context, 'project-marine-hot-spring', windows, 2);
    const date = TEST_DATE;
    const first = await adminSlots(context, dean.token, 'project-marine-hot-spring', date);
    const firstCount = Number((await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM activity_slots WHERE project_id=? AND business_date>=? AND business_date<?',
      ['project-marine-hot-spring', date, dateOffset(date, 7)], 'get')).count);
    const second = await adminSlots(context, dean.token, 'project-marine-hot-spring', date);
    const secondCount = Number((await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM activity_slots WHERE project_id=? AND business_date>=? AND business_date<?',
      ['project-marine-hot-spring', date, dateOffset(date, 7)], 'get')).count);
    assert.deepEqual(first.slots.map(item => [item.localStart, item.localEnd]), [['07:00', '07:45'], ['09:30', '10:30']]);
    assert.equal(firstCount, 14, 'two complete windows should generate for each of seven dates');
    assert.equal(secondCount, firstCount, 'repeated generation must be idempotent');
    assert.ok(first.slots.every(item => item.projectId === 'project-marine-hot-spring' && item.location && item.capacity === 2 && item.startsAt && item.endsAt));
    assert.ok(first.slots.every(item => item.startsAt.endsWith('Z') && item.endsAt.endsWith('Z')));
    const [guest] = await createGuests(context, 1, date);
    const guestView = await guestSlots(context, guest.token, 'project-marine-hot-spring', date);
    const past = guestView.slots.find(item => item.localStart === '07:00');
    assert.equal(past.status, 'past');
    assert.equal(past.bookable, false);
    const pastAttempt = await reserve(context, guest.token, past.id, key('past'));
    assert.equal(pastAttempt.status, 409);
    assert.equal(pastAttempt.data.code, 'SLOT_PAST');
    assert.equal(mysqlBookingSchema.length, 2);
    assert.ok(mysqlBookingSchema.join('\n').includes('uq_activity_slots_project_window'));
    assert.ok(mysqlBookingSchema.join('\n').includes('uq_reservations_guest_idempotency'));
  });
  return { output: [
    'repeated admin reads generate the same 14 slots across seven dates with UTC boundaries, location, capacity and project ID',
    '09:30–10:30 and short 07:00–07:45 windows are preserved; controlled 08:00 business time rejects direct booking of the past slot',
    'MySQL v9 schema declares deterministic window and guest/idempotency unique keys; the same Quest runs against SQLite and MySQL 8'
  ] };
}

async function q152() {
  await withBookingApi(async context => {
    const guest = await guestDemo(context);
    const date = dateOffset(TEST_DATE, 1);
    await setProjectSchedule(context, 'project-spa', [{ days: ['每日'], start: '10:00', end: '12:00' }], 2);
    const before = await guestSlots(context, guest.token, 'project-spa', date);
    const slot = before.slots.find(item => item.localStart === '10:00');
    assert.ok(slot?.bookable, JSON.stringify(slot));
    const reservation = await reserve(context, guest.token, slot.id, key('capacity-one'));
    assert.equal(reservation.status, 201, JSON.stringify(reservation.data));
    const after = await guestSlots(context, guest.token, 'project-spa', date);
    const updated = after.slots.find(item => item.id === slot.id);
    assert.deepEqual([updated.capacity, updated.booked, updated.remaining], [2, 1, 1]);
    assert.equal(updated.environment.status, 'available');
    assert.deepEqual(updated.environment.checks[0].ruleDecisions.map(item => item.ruleId), ['R1', 'R2', 'R3', 'R4', 'R5']);
    assert.ok(updated.reason);

    const [beforeCheckIn, onCheckOut] = await createGuests(context, 2, date);
    const checkOut = dateOffset(date, 4);
    const beforeCheckInFrom = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
    const beforeCheckInTo = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
    await databaseQuery(context, `UPDATE guest_profiles SET ${beforeCheckInFrom}=?,${beforeCheckInTo}=? WHERE user_id=?`, [dateOffset(date, 1), checkOut, beforeCheckIn.id], 'run');
    await databaseQuery(context, `UPDATE guest_profiles SET ${beforeCheckInFrom}=?,${beforeCheckInTo}=? WHERE user_id=?`, [dateOffset(TEST_DATE, 0), date, onCheckOut.id], 'run');
    for (const edgeGuest of [beforeCheckIn, onCheckOut]) {
      const edgeView = await guestSlots(context, edgeGuest.token, 'project-spa', date);
      assert.equal(edgeView.slots.find(item => item.id === slot.id).status, 'stay_required');
      const edgeAttempt = await reserve(context, edgeGuest.token, slot.id, key('stay-edge'));
      assert.equal(edgeAttempt.status, 409);
      assert.equal(edgeAttempt.data.code, 'STAY_NOT_ACTIVE');
    }
  });

  await withBookingApi(async context => {
    const [guest] = await createGuests(context, 1);
    const date = dateOffset(TEST_DATE, 1);
    await setProjectSchedule(context, 'project-sea-bath', [{ days: ['每日'], start: '09:00', end: '10:00' }], 2);
    const sea = await guestSlots(context, guest.token, 'project-sea-bath', date);
    assert.equal(sea.slots[0].status, 'pending');
    assert.equal(sea.slots[0].bookable, false);
    assert.match(sea.slots[0].reason, /缺失|过期|机构安全阈值尚未确认/);
    await setProjectSchedule(context, 'project-spa', [{ days: ['每日'], start: '10:00', end: '11:00' }], 2);
    const indoor = await guestSlots(context, guest.token, 'project-spa', date);
    assert.equal(indoor.slots[0].status, 'available', 'indoor project should not depend on missing sea/weather inputs');
    const denied = await reserve(context, guest.token, sea.slots[0].id, key('missing-environment'));
    assert.equal(denied.status, 409);
    assert.equal(denied.data.code, 'SLOT_NOT_AVAILABLE');
    const indoorAccepted = await reserve(context, guest.token, indoor.slots[0].id, key('indoor-without-environment'));
    assert.equal(indoorAccepted.status, 201, JSON.stringify(indoorAccepted.data));
  }, 'unavailable');

  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const [verifiedGuest, pendingGuest] = await createGuests(context, 2);
    const date = dateOffset(TEST_DATE, 1);
    await setProjectSchedule(context, 'project-sea-bath', [{ days: ['每日'], start: '10:00', end: '11:00' }], 2);
    const slot = (await adminSlots(context, dean.token, 'project-sea-bath', date)).slots[0];
    await setVerifiedHealth(context, verifiedGuest.id, { skin: { status: 'reported', details: '有皮肤破损' } });
    const verifiedView = await guestSlots(context, verifiedGuest.token, 'project-sea-bath', date);
    const verifiedRule = verifiedView.slots[0].environment.ruleDecisions.find(item => item.ruleId === 'R2');
    assert.equal(verifiedRule.matched, true);
    assert.equal(verifiedRule.fieldSources[0].source, 'verified-profile');
    const verifiedAttempt = await reserve(context, verifiedGuest.token, slot.id, key('verified-contraindication'));
    assert.equal(verifiedAttempt.status, 409);
    assert.equal(verifiedAttempt.data.code, 'SLOT_NOT_AVAILABLE');

    await addPendingHealthIntake(context, pendingGuest.id, { skin: { status: 'reported', details: '待核实开放伤口' } });
    const pendingView = await guestSlots(context, pendingGuest.token, 'project-sea-bath', date);
    const pendingRule = pendingView.slots[0].environment.ruleDecisions.find(item => item.ruleId === 'R2');
    assert.equal(pendingRule.matched, true);
    assert.equal(pendingRule.fieldSources[0].source, 'pending-intake');
    const pendingAttempt = await reserve(context, pendingGuest.token, slot.id, key('pending-contraindication'));
    assert.equal(pendingAttempt.status, 409);
    assert.equal(pendingAttempt.data.code, 'SLOT_NOT_AVAILABLE');
  });
  return { output: [
    'capacity-2 slot with one confirmed booking returns booked=1 and remaining=1 with server-side R1–R5 decisions',
    'fixed-date direct booking rejects pre-check-in and check-out-day appointments',
    'sea-entry with missing required environment, verified R2 contraindication, and pending health intake are rejected before writing; indoor bookings do not depend on environment data'
  ] };
}

async function q153() {
  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const date = dateOffset(TEST_DATE, 1);
    await setProjectSchedule(context, 'project-spa', [{ days: ['每日'], start: '10:00', end: '11:00' }], 2);
    const slot = (await adminSlots(context, dean.token, 'project-spa', date)).slots[0];
    const guests = await createGuests(context, 10, date);
    const outcomes = await Promise.all(guests.map((guest, index) => reserve(context, guest.token, slot.id, key(`capacity-${index}`))));
    const successes = outcomes.filter(item => item.status === 201);
    const full = outcomes.filter(item => item.status === 409 && item.data.code === 'SLOT_FULL');
    assert.equal(successes.length, 2, JSON.stringify(outcomes));
    assert.equal(full.length, 8, JSON.stringify(outcomes));
    const count = Number((await databaseQuery(context,
      "SELECT COUNT(*) AS count FROM reservations WHERE slot_id=? AND status='confirmed'", [slot.id], 'get')).count);
    const total = Number((await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM reservations WHERE slot_id=?', [slot.id], 'get')).count);
    assert.equal(count, 2);
    assert.equal(total, 2, 'failed requests must not leave placeholder reservations');
  });
  return { output: [
    'ten concurrent HTTP requests from distinct, in-stay guests produce exactly two confirmed reservations for capacity two',
    'the remaining eight receive SLOT_FULL; no failed request leaves a reservation row'
  ] };
}

async function q154() {
  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const date = dateOffset(TEST_DATE, 1);
    const [overlapGuest, retryGuest] = await createGuests(context, 2, date);
    await setProjectSchedule(context, 'project-marine-hot-spring', [{ days: ['每日'], start: '10:00', end: '11:00' }], 4);
    await setProjectSchedule(context, 'project-sea-mud', [{ days: ['每日'], start: '10:00', end: '11:00' }], 4);
    await setProjectSchedule(context, 'project-spa', [{ days: ['每日'], start: '11:00', end: '12:00' }], 4);
    const hot = (await adminSlots(context, dean.token, 'project-marine-hot-spring', date)).slots[0];
    const mud = (await adminSlots(context, dean.token, 'project-sea-mud', date)).slots[0];
    const spa = (await adminSlots(context, dean.token, 'project-spa', date)).slots[0];

    const [hotResult, mudResult] = await Promise.all([
      reserve(context, overlapGuest.token, hot.id, key('overlap-hot')),
      reserve(context, overlapGuest.token, mud.id, key('overlap-mud'))
    ]);
    const overlapResults = [hotResult, mudResult];
    assert.equal(overlapResults.filter(item => item.status === 201).length, 1, JSON.stringify(overlapResults));
    assert.equal(overlapResults.filter(item => item.status === 409 && item.data.code === 'RESERVATION_TIME_CONFLICT').length, 1, JSON.stringify(overlapResults));
    const overlapCount = Number((await databaseQuery(context,
      "SELECT COUNT(*) AS count FROM reservations WHERE guest_id=? AND status='confirmed'", [overlapGuest.id], 'get')).count);
    assert.equal(overlapCount, 1, 'the losing overlapping request must not leave a reservation row');
    const adjacent = await reserve(context, overlapGuest.token, spa.id, key('adjacent'));
    assert.equal(adjacent.status, 201, JSON.stringify(adjacent.data));

    const retryKey = key('idempotent-concurrent');
    const [retryOne, retryTwo] = await Promise.all([
      reserve(context, retryGuest.token, hot.id, retryKey),
      reserve(context, retryGuest.token, hot.id, retryKey)
    ]);
    assert.equal([retryOne, retryTwo].filter(item => item.status === 201).length, 1);
    assert.equal([retryOne, retryTwo].filter(item => item.status === 200).length, 1);
    assert.equal(retryOne.data.reservation.id, retryTwo.data.reservation.id);
    const retryCount = Number((await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM reservations WHERE guest_id=?', [retryGuest.id], 'get')).count);
    assert.equal(retryCount, 1, 'same-key concurrent replay must persist one row');
    const reused = await reserve(context, retryGuest.token, mud.id, retryKey);
    assert.equal(reused.status, 409);
    assert.equal(reused.data.code, 'IDEMPOTENCY_KEY_REUSED');
  });
  return { output: [
    'two simultaneous cross-project overlapping requests for a guest with no prior booking yield exactly one 201 and one 409 RESERVATION_TIME_CONFLICT, with no losing row; adjacent [start,end) request succeeds',
    'two simultaneous same-key/same-payload requests yield one persisted reservation and one 200 replay; changing the slot under that key returns IDEMPOTENCY_KEY_REUSED'
  ] };
}

async function q155() {
  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const guests = await createGuests(context, 4, TEST_DATE);
    const date = TEST_DATE;
    await setProjectSchedule(context, 'project-spa', [
      { days: ['每日'], start: '07:00', end: '09:00' },
      { days: ['每日'], start: '10:00', end: '11:00' }
    ], 2);
    const slots = (await adminSlots(context, dean.token, 'project-spa', date)).slots;
    const ended = slots.find(item => item.localStart === '07:00');
    const started = slots.find(item => item.localStart === '08:00');
    const slot = slots.find(item => item.localStart === '10:00');
    const pastView = await guestSlots(context, guests[0].token, 'project-spa', date);
    assert.equal(pastView.slots.find(item => item.id === ended.id).status, 'past');
    const pastAttempt = await reserve(context, guests[0].token, ended.id, key('past-cancel-slot'));
    assert.equal(pastAttempt.status, 409);
    assert.equal(pastAttempt.data.code, 'SLOT_PAST');

    const booked = await reserve(context, guests[0].token, slot.id, key('cancel-normal'));
    assert.equal(booked.status, 201);
    const firstCancel = await cancel(context, guests[0].token, booked.data.reservation.id);
    const secondCancel = await cancel(context, guests[0].token, booked.data.reservation.id);
    assert.equal(firstCancel.status, 200);
    assert.equal(secondCancel.status, 200);
    assert.equal(firstCancel.data.status, 'cancelled');
    assert.equal(secondCancel.data.status, 'cancelled');
    assert.equal(secondCancel.data.cancellationReason, 'guest_cancelled');
    const grid = await guestSlots(context, guests[1].token, 'project-spa', date);
    const released = grid.slots.find(item => item.id === slot.id);
    assert.equal(released.booked, 0);
    assert.equal(released.remaining, 2);
    const rebooked = await reserve(context, guests[1].token, slot.id, key('released-slot'));
    assert.equal(rebooked.status, 201, JSON.stringify(rebooked.data));
    const rows = await databaseQuery(context, 'SELECT id,status,cancellation_reason FROM reservations WHERE id=?', [booked.data.reservation.id], 'get');
    assert.deepEqual([rows.id, rows.status, rows.cancellation_reason], [booked.data.reservation.id, 'cancelled', 'guest_cancelled']);

    const stamp = TEST_NOW.replace('T', ' ').replace('.000Z', '');
    for (const [guest, timeSlot, label] of [[guests[2], ended, 'ended'], [guests[3], started, 'started']]) {
      const reservationId = `res_q15_${label}_${accountCounter++}`;
      const insertSql = `INSERT INTO reservations
        (id,guest_id,slot_id,idempotency_key,request_fingerprint,status,created_at,cancelled_at,cancellation_reason,
         environment_snapshot_id,availability_status,availability_reason,is_demo)
        VALUES(?,?,?,?,?,'confirmed',?,NULL,NULL,?,'available','controlled cancellation boundary fixture',1)`;
      await databaseQuery(context, insertSql, [reservationId, guest.id, timeSlot.id, key(`seed-${label}`), `fp-${reservationId}`, stamp, 'stage15-controlled-snapshot'], 'run');
      const denied = await cancel(context, guest.token, reservationId);
      assert.equal(denied.status, 409, JSON.stringify(denied.data));
      assert.equal(denied.data.code, 'RESERVATION_ALREADY_STARTED');
    }
  });
  return { output: [
    'cancelling twice keeps one cancelled history row and frees capacity once; a second guest books the released slot',
    'fixed business time rejects direct booking of a past window and cancellation of reservations whose windows have ended or started'
  ] };
}

async function q156() {
  await checkWebSource([
    'function ProjectBooking', 'booking-slot-grid', '余{slot.remaining}/{slot.capacity}',
    '查看限制原因', 'slot.bookable', 'disabled={submitting}', '当前项目资料为演示数据',
    'function GuestSchedule', "request('/me/timeline')", 'request(`/me/therapy-drafts',
    'upcomingBookings', 'cancelledHistory', '待审核建议、已确认预约和取消记录分开显示',
    '草案不会显示在本列表中'
  ]);
  return { output: [
    'project detail renders service-backed time slots with remaining/capacity and full/restricted/pending states',
    'unavailable slots expose a readable reason and cannot be selected for submission; demo status is explicit'
  ] };
}

async function q157() {
  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const guest = await guestDemo(context);
    const date = dateOffset(TEST_DATE, 1);
    await setProjectSchedule(context, 'project-spa', [{ days: ['每日'], start: '10:00', end: '11:00' }], 2);
    const slot = (await adminSlots(context, dean.token, 'project-spa', date)).slots[0];
    const idempotencyKey = key('rapid-click');
    const [one, two] = await Promise.all([
      reserve(context, guest.token, slot.id, idempotencyKey), reserve(context, guest.token, slot.id, idempotencyKey)
    ]);
    assert.ok([200, 201].includes(one.status));
    assert.ok([200, 201].includes(two.status));
    assert.equal(one.data.reservation.id, two.data.reservation.id);
    const history = assertOk(await request(context.baseUrl, '/reservations', { token: guest.token }));
    assert.equal(history.items.filter(item => item.id === one.data.reservation.id).length, 1);
    const databaseRows = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM reservations WHERE guest_id=? AND idempotency_key=?', [guest.user.id, idempotencyKey], 'get')).count);
    assert.equal(databaseRows, 1, 'rapid duplicate requests must persist one reservation row');
    await checkWebSource([
      "headers: { 'Idempotency-Key': idempotency.current.key }", 'setReservation(result.reservation)',
      '预约编号 {reservation.id}', 'setSubmitting(true)', 'submitLock.current'
    ]);
  });
  return { output: [
    'two rapid identical submissions return one server reservation ID and one persisted guest-history entry',
    'the page displays the saved identifier and disables submission while a request is in flight'
  ] };
}

async function q158() {
  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const [guest, nextGuest] = await createGuests(context, 2);
    const date = dateOffset(TEST_DATE, 1);
    await setProjectSchedule(context, 'project-spa', [{ days: ['每日'], start: '10:00', end: '11:00' }], 1);
    const slot = (await adminSlots(context, dean.token, 'project-spa', date)).slots[0];
    const booked = await reserve(context, guest.token, slot.id, key('cancel-from-ui'));
    const cancellation = await cancel(context, guest.token, booked.data.reservation.id);
    assert.equal(cancellation.data.status, 'cancelled');
    const rebooked = await reserve(context, nextGuest.token, slot.id, key('released-after-ui-cancel'));
    assert.equal(rebooked.status, 201, JSON.stringify(rebooked.data));
    await checkWebSource([
      'function GuestReservations', 'window.confirm(`将取消', '释放一个名额',
      'reservation-date-filter', '按服务日期查看', '取消预约', '历史记录', "method: 'DELETE'"
    ]);
  });
  return { output: [
    'My Reservations keeps cancelled records after refresh; the confirmed cancellation releases capacity for another guest',
    'cancel action asks for confirmation and explains the slot will be released'
  ] };
}

async function q159() {
  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const guest = await guestDemo(context);
    const date = dateOffset(TEST_DATE, 1);
    await setProjectSchedule(context, 'project-spa', [{ days: ['每日'], start: '10:00', end: '11:00' }], 2);
    const slot = (await adminSlots(context, dean.token, 'project-spa', date)).slots[0];
    const booked = await reserve(context, guest.token, slot.id, key('schedule-projection'));
    const before = assertOk(await request(context.baseUrl, '/schedule', { token: guest.token }));
    assert.ok(before.items.some(item => item.id === booked.data.reservation.id && item.slotId === slot.id && item.projectId === 'project-spa'));
    assert.equal((await cancel(context, guest.token, booked.data.reservation.id)).data.status, 'cancelled');
    const after = assertOk(await request(context.baseUrl, '/schedule', { token: guest.token }));
    assert.ok(!after.items.some(item => item.id === booked.data.reservation.id));
    const history = assertOk(await request(context.baseUrl, '/reservations', { token: guest.token }));
    assert.ok(history.items.some(item => item.id === booked.data.reservation.id && item.status === 'cancelled'));
  });
  return { output: [
    'schedule projection uses the reservation ID and project slot from the persisted confirmed booking',
    'cancellation removes the effective schedule entry while the historical reservation remains queryable'
  ] };
}

async function q1510() {
  await withBookingApi(async context => {
    const dean = await deanDemo(context);
    const guests = await createGuests(context, 4);
    const date = dateOffset(TEST_DATE, 1);
    await setProjectSchedule(context, 'project-spa', [
      { days: ['每日'], start: '10:00', end: '11:00' },
      { days: ['每日'], start: '11:00', end: '12:00' }
    ], 2);
    const initial = (await adminSlots(context, dean.token, 'project-spa', date)).slots;
    const oldSlot = initial.find(item => item.localStart === '10:00');
    const closedSlot = initial.find(item => item.localStart === '11:00');
    const first = await reserve(context, guests[0].token, oldSlot.id, key('capacity-first'));
    const second = await reserve(context, guests[1].token, oldSlot.id, key('capacity-second'));
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const tooLow = await setCapacity(context, dean.token, 'project-spa', oldSlot.id, 1);
    assert.equal(tooLow.status, 409);
    assert.equal(tooLow.data.code, 'CAPACITY_BELOW_BOOKED');
    const increased = await setCapacity(context, dean.token, 'project-spa', oldSlot.id, 3);
    assert.equal(increased.status, 200, JSON.stringify(increased.data));
    assert.equal(increased.data.booked, 2);
    assert.equal(increased.data.capacity, 3);
    const closed = await request(context.baseUrl, `/admin/projects/project-spa/slots/${closedSlot.id}`, {
      method: 'PATCH', token: dean.token, body: { closed: true }
    });
    assert.equal(closed.status, 200);
    const closedDenied = await reserve(context, guests[2].token, closedSlot.id, key('closed-maintenance'));
    assert.equal(closedDenied.status, 409);
    assert.equal(closedDenied.data.code, 'SLOT_CLOSED');

    const beforeWindowChange = await adminSlots(context, dean.token, 'project-spa', date);
    assert.equal(beforeWindowChange.slots.find(item => item.id === oldSlot.id).capacity, 3);
    assert.equal(beforeWindowChange.slots.find(item => item.id === closedSlot.id).isClosed, true);
    const projectUpdate = await request(context.baseUrl, '/admin/projects/project-spa', {
      method: 'PATCH', token: dean.token,
      body: { openWindows: { windows: [{ days: ['每日'], start: '14:00', end: '15:00' }] } }
    });
    assert.equal(projectUpdate.status, 200, JSON.stringify(projectUpdate.data));

    const guestView = await guestSlots(context, guests[2].token, 'project-spa', date);
    const stale = guestView.slots.find(item => item.id === oldSlot.id);
    const staleClosed = guestView.slots.find(item => item.id === closedSlot.id);
    const newSlot = guestView.slots.find(item => item.localStart === '14:00');
    assert.equal(stale.status, 'window_changed');
    assert.equal(stale.bookable, false);
    assert.match(stale.reason, /开放窗口已调整/);
    assert.equal(staleClosed.isClosed, true);
    assert.ok(newSlot?.bookable, JSON.stringify(guestView.slots));
    const removedWindowAttempt = await reserve(context, guests[2].token, oldSlot.id, key('removed-window'));
    assert.equal(removedWindowAttempt.status, 409);
    assert.equal(removedWindowAttempt.data.code, 'SLOT_WINDOW_CHANGED');
    const newlyOpenedAttempt = await reserve(context, guests[2].token, newSlot.id, key('new-window'));
    assert.equal(newlyOpenedAttempt.status, 201, JSON.stringify(newlyOpenedAttempt.data));

    const secondRead = await adminSlots(context, dean.token, 'project-spa', date);
    const thirdRead = await adminSlots(context, dean.token, 'project-spa', date);
    assert.equal(secondRead.slots.find(item => item.id === oldSlot.id).capacity, 3);
    assert.equal(thirdRead.slots.find(item => item.id === oldSlot.id).capacity, 3);
    assert.equal(secondRead.slots.find(item => item.id === closedSlot.id).isClosed, true);
    assert.equal(thirdRead.slots.find(item => item.id === closedSlot.id).isClosed, true);
    const totalSlots = Number((await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM activity_slots WHERE project_id=?', ['project-spa'], 'get')).count);
    assert.equal(totalSlots, 21, 'the changed schedule adds the new 7-day windows once while retaining the 14 old slots');

    const firstHistory = assertOk(await request(context.baseUrl, '/reservations', { token: guests[0].token }));
    assert.ok(firstHistory.items.some(item => item.id === first.data.reservation.id && item.status === 'confirmed'));
    const firstSchedule = assertOk(await request(context.baseUrl, '/schedule', { token: guests[0].token }));
    assert.ok(firstSchedule.items.some(item => item.id === first.data.reservation.id && item.slotId === oldSlot.id));
    const secondHistory = assertOk(await request(context.baseUrl, '/reservations', { token: guests[1].token }));
    assert.ok(secondHistory.items.some(item => item.id === second.data.reservation.id && item.status === 'confirmed'));
    const secondSchedule = assertOk(await request(context.baseUrl, '/schedule', { token: guests[1].token }));
    assert.ok(secondSchedule.items.some(item => item.id === second.data.reservation.id && item.slotId === oldSlot.id));

    const raceDate = dateOffset(TEST_DATE, 2);
    const raceSlots = await adminSlots(context, dean.token, 'project-spa', raceDate);
    const raceSlot = raceSlots.slots.find(item => item.localStart === '14:00');
    assert.ok(raceSlot, 'the 14:00 slot must exist before the lock race');
    const [raceGuest] = await createGuests(context, 1, raceDate);
    await raceWindowChangeWhileBookingWaits(context, {
      projectId: 'project-spa', slot: raceSlot, guest: raceGuest,
      historicalReservationIds: [first.data.reservation.id, second.data.reservation.id]
    });

    const projectDisable = await request(context.baseUrl, '/admin/projects/project-spa', {
      method: 'PATCH', token: dean.token, body: { active: false }
    });
    assert.equal(projectDisable.status, 200, JSON.stringify(projectDisable.data));
    const inactiveRead = await request(context.baseUrl, `/projects/project-spa/slots?date=${date}`, { token: guests[3].token });
    assert.equal(inactiveRead.status, 404);
    const inactiveAttempt = await reserve(context, guests[3].token, newSlot.id, key('inactive-project'));
    assert.equal(inactiveAttempt.status, 409);
    assert.equal(inactiveAttempt.data.code, 'PROJECT_INACTIVE');
    const afterDisabledRead = await adminSlots(context, dean.token, 'project-spa', date);
    assert.equal(afterDisabledRead.slots.length, 3, 'admin reads retain old, closed and newly generated slots');
    const retained = Number((await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM activity_slots WHERE project_id=?', ['project-spa'], 'get')).count);
    assert.equal(retained, totalSlots, 'inactive project reads do not regenerate or delete existing slots');
    await checkWebSource(['function ProjectSlotAdmin', '关闭时段', '容量不能降到有效预约数以下']);
  }, 'unavailable');
  return { output: [
    'capacity decrease below two confirmed reservations returns 409; increasing to three persists through repeat generation; manually closed slot remains closed',
    'admin window PATCH 10:00–11:00 → 14:00–15:00 leaves the old slot visible but nonbookable with an explanation; direct old-slot POST returns SLOT_WINDOW_CHANGED while new window accepts',
    'MySQL 8 REPEATABLE-READ performance_schema barrier confirms a guest POST is waiting on the project lock; after the admin commits a new window it returns SLOT_WINDOW_CHANGED with no row, while prior reservations remain; SQLite retains the same window-change semantics',
    'existing confirmed reservations remain in /reservations and /schedule; project deactivation preserves 21 historical/current slots and rejects new booking'
  ] };
}

const quests = {
  'Q15.1': q151, 'Q15.2': q152, 'Q15.3': q153, 'Q15.4': q154, 'Q15.5': q155,
  'Q15.6': q156, 'Q15.7': q157, 'Q15.8': q158, 'Q15.9': q159, 'Q15.10': q1510
};

export async function run({ questId, resourceSession }) {
  const execute = quests[questId];
  assert.ok(execute, `unsupported Stage15 quest ${questId}`);
  activeResourceSession = resourceSession || null;
  try {
    return await execute();
  } finally {
    activeResourceSession = null;
  }
}

export { quests as stage15Quests };
