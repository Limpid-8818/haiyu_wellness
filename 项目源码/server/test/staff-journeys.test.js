import { test, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.DB_DRIVER = 'sqlite'; process.env.DB_PATH = ':memory:'; process.env.DEMO_SEED = '1';
process.env.BUSINESS_CLOCK_NOW = '2026-10-13T00:00:00.000Z';
process.env.ENVIRONMENT_MODE = 'unavailable'; process.env.ENVIRONMENT_LIVE = '0';
process.env.LLM_API_KEY = ''; process.env.LLM_BASE_URL = '';
process.env.AUTH_SECRET = 'synthetic-stage2-tests-only';
const { db, transaction, hashPassword, now } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { initializeDemoTeam } = await import('../src/demo-team.js');
const { prepareSyntheticIndoorExercise } = await import('../../scripts/bugfix-stage2/catalog-fixture.js');
const { recordStaffExecution } = await import('../src/service-execution.js');
const { createGuestCheckin } = await import('../src/wellness-followup.js');
const { createBusinessClock } = await import('../src/clock.js');
const late = createBusinessClock({ now: () => new Date('2026-10-13T09:00:00.000Z') });
const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
const auth = {};
async function call(role, route, method = 'GET', body, expected = 200, key) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json',
    ...(auth[role] ? { Authorization: `Bearer ${auth[role]}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`); return data;
}
const none = { status: 'none', items: [] };
let guestId, coachReservation, therapistReservation, noShowReservation;

test('explicit demonstration team initialization creates missing roles once and preserves old clinician', async () => {
  const before = await db.prepare("SELECT password_hash,job_type FROM users WHERE id='staff_001'").get();
  const init = () => initializeDemoTeam({ database: db, transact: transaction, hashPassword, stamp: now() });
  assert.equal((await init()).created, 4); assert.equal((await init()).created, 0);
  assert.deepEqual(await db.prepare("SELECT password_hash,job_type FROM users WHERE id='staff_001'").get(), before);
  assert.equal((await db.prepare("SELECT COUNT(DISTINCT job_type) AS count FROM users WHERE role='staff'").get()).count, 5);
  for (const [role, username] of Object.entries({ administrator: 'admin_demo', clinician: 'staff_demo', coach: 'coach_demo', therapist: 'therapist_demo', dietitian: 'dietitian_demo', dean: 'dean_demo' })) {
    const result = await call(null, '/auth/login', 'POST', { username, password: role === 'dean' ? 'dean2026' : 'staff2026', role: role === 'dean' ? 'dean' : 'staff' });
    auth[role] = result.token;
    if (role !== 'dean') assert.equal(result.user.jobType, role);
  }
  await prepareSyntheticIndoorExercise();
});

test('five actual accounts perform management, medical and meal transactions with same guest readbacks', async () => {
  const created = await call('administrator', '/dean/staff', 'POST', { username: 'stage2_extra_coach', password: 'Synthetic-only-123', name: '合成新增教练', phone: '', jobType: 'coach' }, 201);
  await call('administrator', '/dean/staff', 'POST', { username: 'stage2_extra_coach', password: 'Synthetic-only-123', name: '合成新增教练', jobType: 'coach' }, 409);
  const registered = await call(null, '/auth/register', 'POST', { name: '阶段2合成客人', phone: '19900006501', password: 'Synthetic-only-123', confirmPassword: 'Synthetic-only-123' }, 201);
  auth.guest = registered.token; guestId = registered.user.id;
  await call('administrator', `/dean/guests/${guestId}/stay`, 'PATCH', { roomNo: '合成房间', checkIn: '2026-10-13', checkOut: '2026-10-16', stayPlan: 'three_night' });
  const staff = await call('administrator', '/dean/staff');
  for (const job of ['administrator','clinician','coach','therapist','dietitian']) {
    const member = staff.find(item => item.jobType === job && item.username !== 'stage2_extra_coach');
    await call('administrator', `/dean/guests/${guestId}/assignments`, 'POST', { staffId: member.id }, 201);
  }
  assert.equal((await call('administrator', `/dean/guests/${guestId}/assignments`)).length, 5);
  const submitted = await call('guest', '/me/health-intakes', 'POST', { baseProfileVersion: 0, profile: { chronic: none, allergies: { status: 'reported', items: ['空气'] }, dietaryRestrictions: none, skin: { status: 'reported', details: '皮肤完好' } } }, 201);
  await call('clinician', `/staff/health-intakes/${submitted.pendingIntakes[0].id}/confirm`, 'POST', { baseProfileVersion: 0 });
  const requested = await call('guest', '/meals/restriction-review', 'POST', {});
  await call('clinician', `/staff/meal-restriction-reviews/${requested.review.id}/resolve`, 'POST', { decisions: [{ classification: 'non_food' }], note: '合成客人与医护明确核对环境描述，原文保持' });
  await call('clinician', `/staff/guests/${guestId}/advice`, 'POST', { title: '合成医护跟进', content: '仅合成业务回读记录，非医疗指导', priority: 'normal' }, 201);
  assert.ok((await call('guest', '/me')).advice.some(item => item.title === '合成医护跟进'));
  await call('coach', `/staff/guests/${guestId}/advice`, 'POST', { title: '不得发布', content: '拒绝代表用例' }, 403);
  const menu = await call('guest', '/meals/menus', 'POST', { businessDate: '2026-10-13' }, 201);
  const order = await call('guest', '/meals/orders', 'POST', { menuId: menu.menu.id, businessDate: '2026-10-13', mealType: 'breakfast', version: menu.menu.version }, 201, 'stage2-breakfast');
  await call('dietitian', `/staff/meals/orders/${order.order.id}/status`, 'PATCH', { status: 'preparing' });
  await call('dietitian', `/staff/meals/orders/${order.order.id}/status`, 'PATCH', { status: 'delivered' });
  assert.equal((await call('guest', '/meals/orders?date=2026-10-13'))[0].status, 'delivered');
  await assert.rejects(() => initializeDemoTeam({ database: db, transact: transaction, hashPassword, stamp: now() }), error => error.code === 'DEMO_TEAM_DATABASE_NOT_ISOLATED');
  assert.equal((await db.prepare('SELECT job_type FROM users WHERE id=?').get(created.id)).job_type, 'coach');
});

test('coach and therapist are assigned, process real reservations and read guest checkins/feedback; director reads their actual logs', async () => {
  const coachSlots = await call('guest', '/projects/stage2-indoor-exercise/slots?date=2026-10-13');
  const therapySlots = await call('guest', '/projects/project-spa/slots?date=2026-10-13');
  for (const [job, slot, target] of [['coach',coachSlots.slots.find(item => item.bookable),'coach'],['therapist',therapySlots.slots.find(item => item.bookable),'therapist'],['coach',coachSlots.slots.filter(item => item.bookable)[1],'no-show']]) {
    assert.ok(slot, `${job} needs genuine bookable slot`);
    const reservation = await call('guest', '/reservations', 'POST', { slotId: slot.id }, 201, `stage2-${target}-reservation`);
    const staffId = job === 'coach' ? 'demo_coach' : 'demo_therapist';
    await call('administrator', `/admin/operations/slots/${slot.id}/assignments`, 'POST', { staffId, jobType: job }, 201);
    if (target === 'coach') coachReservation = reservation.reservation.id;
    else if (target === 'therapist') therapistReservation = reservation.reservation.id;
    else { noShowReservation = reservation.reservation.id; continue; }
    await call(job, `/staff/schedule/${reservation.reservation.id}/execution`, 'POST', { status: 'completed', note: '尚未结束' }, 409);
    await createGuestCheckin({ guestId, reservationId: reservation.reservation.id, clock: late });
    const feedback = await call('guest', `/me/reservations/${reservation.reservation.id}/feedback`, 'POST', { feeling: 'comfortable', note: '合成项目感受' }, 201);
    const user = await db.prepare('SELECT * FROM users WHERE id=?').get(staffId);
    const result = await recordStaffExecution({ user, reservationId: reservation.reservation.id, status: 'completed', note: `${job}合成服务完成`, clock: late });
    assert.equal((await recordStaffExecution({ user, reservationId: reservation.reservation.id, status: 'completed', note: `${job}合成服务完成`, clock: late })).replayed, true);
    const schedule = await call(job, '/staff/schedule?date=2026-10-13');
    const row = schedule.items.find(item => item.reservationId === reservation.reservation.id);
    assert.equal(row.feedback.id, feedback.id); assert.equal(row.feedback.revision, 1);
    assert.equal(row.executions[0].id, result.execution.id);
    const guest = (await call('guest', '/me/checkins')).items.find(item => item.reservationId === reservation.reservation.id);
    assert.equal(guest.executions[0].id, result.execution.id);
    const logs = await call('dean', `/dean/staff/${staffId}/logs`);
    assert.equal(logs.logs.filter(item => item.action === 'service.execution.record').length, 1);
  }
});

test('service scope and no-show remain consistent with guest state and cannot overwrite participation', async () => {
  await call('coach', `/staff/schedule/${therapistReservation}/execution`, 'POST', { status: 'completed', note: '时段分工不符' }, 403);
  await call('clinician', `/staff/schedule/${coachReservation}/execution`, 'POST', { status: 'completed', note: '岗位不符' }, 403);
  const outsider = await call(null, '/auth/login', 'POST', { username: 'stage2_extra_coach', password: 'Synthetic-only-123', role: 'staff' }); auth.outsider = outsider.token;
  await call('outsider', `/staff/guests/${guestId}`, 'GET', undefined, 403);
  const coach = await db.prepare("SELECT * FROM users WHERE id='demo_coach'").get();
  await assert.rejects(() => recordStaffExecution({ user: coach, reservationId: coachReservation, status: 'no_show', note: '不许回退', clock: late }), error => error.code === 'SERVICE_ALREADY_RECORDED');
  await recordStaffExecution({ user: coach, reservationId: noShowReservation, status: 'no_show', note: '合成客人未参加，保留预约容量', clock: late });
  await assert.rejects(() => createGuestCheckin({ guestId, reservationId: noShowReservation, clock: late }), error => error.code === 'CHECKIN_NO_SHOW_RECORDED');
  assert.equal((await call('guest', '/reservations')).items.find(item => item.id === noShowReservation).status, 'no_show');
  assert.equal((await call('guest', '/me/checkins')).items.find(item => item.reservationId === noShowReservation).reservationStatus, 'no_show');
  assert.equal((await call('dean', '/admin/operations/summary?date=2026-10-13')).metrics.find(item => item.key === 'reservations').value, 3);
});
