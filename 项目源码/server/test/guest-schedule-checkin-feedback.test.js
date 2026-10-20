import test from 'node:test';
import assert from 'node:assert/strict';
process.env.BUSINESS_CLOCK_NOW = '2026-10-13T02:00:00.000Z'; // 上海时间 10:00：当日 11:00 时段可订但未开始
Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0'
});
const { db, transaction, hashPassword, now } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { initializeDemoTeam } = await import('../src/demo-team.js');
const { prepareSyntheticIndoorExercise } = await import('../../scripts/bugfix-stage2/catalog-fixture.js');
const { createGuestCheckin } = await import('../src/wellness-followup.js');
const { createBusinessClock } = await import('../src/clock.js');
// 冻结时钟下已开始的时段不可预订（SLOT_PAST），与 staff-journeys 相同：跨时间签到分支用注入时钟的领域函数，
// 其余分支与幂等回放全部走 HTTP 路由。
const afterSlotStart = createBusinessClock({ now: () => new Date('2026-10-13T03:30:00.000Z') });
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });

async function call(token, route, method = 'GET', body, expected = 200, idempotencyKey) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}

await initializeDemoTeam({ database: db, transact: transaction, hashPassword, stamp: now() });
await prepareSyntheticIndoorExercise();

const administrator = (await call(null, '/auth/login', 'POST', { username: 'admin_demo', password: 'staff2026', role: 'staff' })).token;
const registered = await call(null, '/auth/register', 'POST', { name: '签到反馈客人', phone: '19900007701', password: 'Synthetic-only-123', confirmPassword: 'Synthetic-only-123' }, 201);
const guest = registered.token;
const guestId = registered.user.id;
await call(administrator, `/dean/guests/${guestId}/stay`, 'PATCH', { roomNo: 'B-201', checkIn: '2026-10-13', checkOut: '2026-10-16', stayPlan: 'three_night' });

async function bookTomorrowSlot(key, index = 0) {
  const slots = await call(guest, '/projects/stage2-indoor-exercise/slots?date=2026-10-14');
  const slot = slots.slots.filter(item => item.bookable)[index];
  assert.ok(slot, `次日第 ${index} 个可订时段应存在`);
  return (await call(guest, '/reservations', 'POST', { slotId: slot.id }, 201, key)).reservation;
}

test('客人日程：返回入住区间内已确认预约的关键字段', async () => {
  const todaySlots = await call(guest, '/projects/stage2-indoor-exercise/slots?date=2026-10-13');
  assert.ok(todaySlots.slots.some(item => item.bookable), '冻结时钟 10:00 时 11:00 时段应可预订');
  const futureReservation = await bookTomorrowSlot('schedule-view-01', 0);
  const schedule = await call(guest, '/schedule');
  const row = schedule.items.find(item => item.id === futureReservation.id);
  assert.ok(row, 'GET /api/schedule 应包含本人已确认预约');
  assert.equal(row.businessDate, '2026-10-14');
  assert.equal(row.projectName, '合成室内教练指导');
  assert.ok(row.localStart && row.localEnd);
});

test('签到：未开始/不存在分支拒绝，开始后成功且 HTTP 重复签到幂等', async () => {
  const slots = await call(guest, '/projects/stage2-indoor-exercise/slots?date=2026-10-13');
  const slot = slots.slots.find(item => item.bookable);
  const reservation = (await call(guest, '/reservations', 'POST', { slotId: slot.id }, 201, 'schedule-checkin-01')).reservation;
  assert.equal((await call(guest, `/me/reservations/${reservation.id}/checkin`, 'POST', undefined, 409)).code, 'CHECKIN_TOO_EARLY');
  assert.equal((await call(guest, '/me/reservations/resv_none/checkin', 'POST', undefined, 404)).code, 'RESERVATION_NOT_FOUND');

  const created = await createGuestCheckin({ guestId, reservationId: reservation.id, clock: afterSlotStart });
  assert.equal(created.replayed, false);
  assert.equal(created.businessDate, '2026-10-13');
  const replay = await call(guest, `/me/reservations/${reservation.id}/checkin`, 'POST', undefined, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.id, created.id, 'HTTP 重复签到必须返回同一条签到记录');
  assert.equal((await call(guest, '/me/checkins')).items.filter(item => item.reservationId === reservation.id).length, 1);
});

test('反馈：需先签到，提交/幂等/当日修改留版本，非法输入拒绝', async () => {
  const futureReservation = await bookTomorrowSlot('feedback-pre-01', 1);
  assert.equal((await call(guest, `/me/reservations/${futureReservation.id}/feedback`, 'POST', { feeling: 'comfortable' }, 409)).code, 'FEEDBACK_CHECKIN_REQUIRED');

  const checkins = await call(guest, '/me/checkins');
  const checked = checkins.items.find(item => item.businessDate === '2026-10-13');
  assert.ok(checked, '依赖上一用例的已签到预约');
  const feedback = await call(guest, `/me/reservations/${checked.reservationId}/feedback`, 'POST', { feeling: 'comfortable', note: '流程顺畅' }, 201);
  assert.equal(feedback.revision, 1);
  assert.equal(feedback.replayed, false);
  const replay = await call(guest, `/me/reservations/${checked.reservationId}/feedback`, 'POST', { feeling: 'comfortable', note: '流程顺畅' }, 200);
  assert.equal(replay.replayed, true);
  assert.equal(replay.id, feedback.id);

  const updated = await call(guest, `/me/feedback/${feedback.id}`, 'PUT', { feeling: 'general', note: '补充修改后的感受' });
  assert.equal(updated.revision, 2);
  assert.equal(updated.revisions.length, 2, '修改必须保留历史版本');
  assert.equal(updated.revisions[0].feeling, 'comfortable');

  assert.equal((await call(guest, `/me/reservations/${checked.reservationId}/feedback`, 'POST', { feeling: 'great', note: '' }, 400)).code, 'WELLNESS_FEELING_INVALID');
  assert.equal((await call(guest, `/me/feedback/${feedback.id}`, 'PUT', { feeling: 'comfortable', extra: 1 }, 400)).code, 'WELLNESS_FEEDBACK_FIELD_NOT_ALLOWED');
  assert.equal((await call(guest, `/me/feedback/${feedback.id}`, 'PUT', { feeling: 'comfortable', note: 'x'.repeat(501) }, 400)).code, 'WELLNESS_FEEDBACK_NOTE_INVALID');
  assert.equal((await call(guest, '/me/feedback/fb_none', 'PUT', { feeling: 'comfortable' }, 404)).code, 'WELLNESS_FEEDBACK_NOT_FOUND');
});

test('取消预约：未来时段可取消且取消后不可签到、不出现在日程', async () => {
  const reservation = await bookTomorrowSlot('schedule-cancel-01', 2);
  const cancelled = await call(guest, `/reservations/${reservation.id}`, 'DELETE');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await call(guest, `/me/reservations/${reservation.id}/checkin`, 'POST', undefined, 409)).code, 'CHECKIN_RESERVATION_INACTIVE');
  const schedule = await call(guest, '/schedule');
  assert.ok(!schedule.items.some(item => item.id === reservation.id), '已取消预约不应出现在客人日程');
  assert.equal((await call(guest, `/reservations/${reservation.id}`, 'DELETE')).status, 'cancelled', '重复取消幂等返回已取消状态');
});
