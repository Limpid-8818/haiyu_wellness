import test from 'node:test';
import assert from 'node:assert/strict';
process.env.BUSINESS_CLOCK_NOW = '2026-10-13T02:00:00.000Z'; // 上海时间 10:00
Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0'
});
const { db, transaction, hashPassword, now } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { initializeDemoTeam } = await import('../src/demo-team.js');
const { fixtureContext, fixtureLocation, seedCurrent } = await import('../../scripts/bugfix-stage5/fixtures.js');
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
const administrator = (await call(null, '/auth/login', 'POST', { username: 'admin_demo', password: 'staff2026', role: 'staff' })).token;
const registered = await call(null, '/auth/register', 'POST', { name: '改期客人', phone: '19900007702', password: 'Synthetic-only-123', confirmPassword: 'Synthetic-only-123' }, 201);
const guest = registered.token;
const guestId = registered.user.id;
await call(administrator, `/dean/guests/${guestId}/stay`, 'PATCH', { roomNo: 'B-202', checkIn: '2026-10-13', checkOut: '2026-10-18', stayPlan: 'ten_night' });

async function beachWalkSlots(date) {
  const data = await call(guest, `/projects/project-beach-walk/slots?date=${date}`);
  return data.slots.filter(item => item.bookable);
}

const rescheduleContext = {};

test('天气批量取消：环境缺失拦截户外预订，演示环境补齐后预览只读、执行取消留痕且幂等', async () => {
  const gated = await call(guest, '/projects/project-beach-walk/slots?date=2026-10-14');
  assert.ok(gated.slots.length > 0);
  assert.ok(gated.slots.every(item => !item.bookable), '环境快照缺失时户外时段不得开放预订');
  assert.match(String(gated.slots[0].reason || ''), /环境字段缺失/, '拦截原因必须明示环境数据缺失');

  // 切换到显式演示环境（合成数据+演示阈值，全链标注演示），户外时段方可评估
  process.env.ENVIRONMENT_MODE = 'demo';
  process.env.ENVIRONMENT_MOCK_SCENARIO = 'normal';
  const slots = await beachWalkSlots('2026-10-14');
  assert.ok(slots.length >= 1, '演示环境下沙滩漫步次日应存在可订时段');
  const booked = await call(guest, '/reservations', 'POST', { slotId: slots[0].id }, 201, 'weather-cancel-book-01');
  const reservationId = booked.reservation.id;

  // 天气批量预览需要一条与时段日期匹配的已保存天气快照（离线夹具直写，非外部服务）
  const { weather: snapshotKey } = await seedCurrent(fixtureContext('2026-10-14', '2026-10-13T02:00:00.000Z', fixtureLocation));

  const preview = await call(administrator, '/admin/operations/weather-cancellations/preview', 'POST', { slotIds: [slots[0].id], snapshotKey });
  assert.equal(preview.totalReservations, 1);
  assert.equal(preview.affectedReservations[0].id, reservationId);
  assert.equal(preview.slots[0].outdoor, true);
  assert.equal((await call(guest, '/reservations')).items.find(item => item.id === reservationId).status, 'confirmed', '预览不得改动预约');

  assert.equal((await call(administrator, '/admin/operations/weather-cancellations/preview', 'POST', { slotIds: [], snapshotKey }, 400)).code, 'WEATHER_BATCH_SLOTS_INVALID');
  assert.equal((await call(administrator, '/admin/operations/weather-cancellations/preview', 'POST', { slotIds: [slots[0].id], snapshotKey: 'no-such-snapshot' }, 409)).code, 'WEATHER_SNAPSHOT_MISMATCH');

  const executed = await call(administrator, '/admin/operations/weather-cancellations', 'POST', { slotIds: [slots[0].id], snapshotKey, reason: '合成天气过程演示批量取消' }, 201, 'weather-cancel-exec-01');
  assert.equal(executed.replayed, false);
  const cancelled = (await call(guest, '/reservations')).items.find(item => item.id === reservationId);
  assert.equal(cancelled.status, 'cancelled');
  assert.match(String(cancelled.cancellationReason || cancelled.reason || ''), /^weather_batch:/);
  const replay = await call(administrator, '/admin/operations/weather-cancellations', 'POST', { slotIds: [slots[0].id], snapshotKey, reason: '合成天气过程演示批量取消' }, 200, 'weather-cancel-exec-01');
  assert.equal(replay.replayed, true);

  rescheduleContext.reservationId = reservationId;
  rescheduleContext.weatherSlotId = slots[0].id;
});

test('改期：候选列表与成功改期、幂等重放、旧预约保持取消并通知', async () => {
  const { reservationId } = rescheduleContext;
  assert.ok(reservationId, '依赖上一用例的天气取消预约');

  const candidates = await call(guest, `/reservations/${reservationId}/reschedule-candidates`);
  assert.ok(Array.isArray(candidates.candidates));
  assert.ok(candidates.candidates.length >= 1, '应存在可用替代时段');
  const target = candidates.candidates.find(item => item.businessDate === '2026-10-14') || candidates.candidates[0];
  assert.ok(target, '应存在可用替代时段');

  assert.equal((await call(guest, `/reservations/${reservationId}/reschedule`, 'POST', { slotId: target.id, extra: 1 }, 400)).code, 'RESCHEDULE_INPUT_INVALID');

  const rescheduled = await call(guest, `/reservations/${reservationId}/reschedule`, 'POST', { slotId: target.id }, 201, 'guest-reschedule-01');
  assert.equal(rescheduled.replayed, false);
  assert.equal(rescheduled.notificationCreated, true);
  const replay = await call(guest, `/reservations/${reservationId}/reschedule`, 'POST', { slotId: target.id }, 200, 'guest-reschedule-01');
  assert.equal(replay.replayed, true);
  assert.equal(replay.newReservationId, rescheduled.newReservationId, '重放必须指向同一条新预约');

  const reservations = await call(guest, '/reservations');
  assert.equal(reservations.items.find(item => item.id === reservationId).status, 'cancelled', '原预约保持取消');
  assert.equal(reservations.items.find(item => item.id === rescheduled.newReservationId).status, 'confirmed', '新预约已确认');

  const notifications = await call(guest, '/me/wellness-notifications');
  assert.ok(notifications.items.some(item => String(item.message || '').includes('已改到')), '改约后应收到站内通知');
});

test('改期分支：非天气取消的预约不可改约，不存在预约 404', async () => {
  const slots = await beachWalkSlots('2026-10-15');
  assert.ok(slots.length >= 1, '演示环境下次日应存在可订时段');
  const booked = await call(guest, '/reservations', 'POST', { slotId: slots[0].id }, 201, 'reschedule-negative-01');
  assert.equal((await call(guest, `/reservations/${booked.reservation.id}/reschedule-candidates`, 'GET', undefined, 409)).code, 'RESCHEDULE_NOT_AVAILABLE');
  assert.equal((await call(guest, '/reservations/resv_none/reschedule-candidates', 'GET', undefined, 404)).code, 'RESERVATION_NOT_FOUND');
});
