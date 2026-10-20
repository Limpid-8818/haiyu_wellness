import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0'
});
const { db, transaction, hashPassword, now } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { initializeDemoTeam } = await import('../src/demo-team.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });

async function call(token, route, method = 'GET', body, expected = 200) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}

await initializeDemoTeam({ database: db, transact: transaction, hashPassword, stamp: now() });
const administrator = (await call(null, '/auth/login', 'POST', { username: 'admin_demo', password: 'staff2026', role: 'staff' })).token;
const clinician = (await call(null, '/auth/login', 'POST', { username: 'staff_demo', password: 'staff2026', role: 'staff' })).token;
const coach = (await call(null, '/auth/login', 'POST', { username: 'coach_demo', password: 'staff2026', role: 'staff' })).token;
const dean = (await call(null, '/auth/login', 'POST', { username: 'dean_demo', password: 'dean2026', role: 'dean' })).token;

const registered = await call(null, '/auth/register', 'POST', { name: '院长管理客人', phone: '19900007703', password: 'Synthetic-only-123', confirmPassword: 'Synthetic-only-123' }, 201);
const guestId = registered.user.id;
await call(administrator, `/dean/guests/${guestId}/stay`, 'PATCH', { roomNo: 'B-203', checkIn: '2026-10-13', checkOut: '2026-10-16', stayPlan: 'three_night' });
const staffRows = await call(administrator, '/dean/staff');
const clinicianId = (Array.isArray(staffRows) ? staffRows : staffRows.items).find(item => item.jobType === 'clinician').id;
await call(administrator, `/dean/guests/${guestId}/assignments`, 'POST', { staffId: clinicianId }, 201);

test('院长与管理员客人视图：列表与分配查询一致', async () => {
  const guests = await call(administrator, '/dean/guests');
  const row = guests.find ? guests.find(item => item.id === guestId) : guests.items?.find(item => item.id === guestId);
  assert.ok(row, 'GET /dean/guests 应包含已入住客人');
  const assignments = await call(administrator, `/dean/guests/${guestId}/assignments`);
  const list = Array.isArray(assignments) ? assignments : assignments.items;
  assert.ok(list.some(item => item.staffId === clinicianId || item.staff?.id === clinicianId), '分配记录应可查询');
  await call(coach, '/dean/guests', 'GET', undefined, 403);
});

test('员工停启用：停用后禁止登录，恢复后可登录，非法字段拒绝', async () => {
  const updated = await call(administrator, '/dean/staff/demo_coach', 'PATCH', { status: 'disabled' });
  assert.equal(updated.status, 'disabled');
  await call(null, '/auth/login', 'POST', { username: 'coach_demo', password: 'staff2026', role: 'staff' }, 401);
  assert.equal((await call(administrator, '/dean/staff/demo_coach', 'PATCH', { status: 'frozen' }, 400)).code, 'STAFF_STATUS_INVALID');
  assert.equal((await call(administrator, '/dean/staff/demo_coach', 'PATCH', { nickname: 'x' }, 400)).code, 'STAFF_UPDATE_INVALID');
  assert.equal((await call(administrator, '/dean/staff/staff_none', 'PATCH', { status: 'active' }, 404)).code, 'STAFF_NOT_FOUND');
  await call(administrator, '/dean/staff/demo_coach', 'PATCH', { status: 'active' });
  const relaunch = await call(null, '/auth/login', 'POST', { username: 'coach_demo', password: 'staff2026', role: 'staff' });
  assert.ok(relaunch.token, '恢复后应能重新登录');
});

test('岗位能力矩阵：读写一致并实时影响该岗位员工能力，医护建议权限固定', async () => {
  const before = await call(administrator, '/dean/job-capabilities');
  assert.ok(Array.isArray(before.matrix) && before.matrix.length > 0, '岗位能力矩阵应返回矩阵');

  await call(administrator, '/dean/job-capabilities', 'PATCH', { jobType: 'coach', capability: 'operations.summary.view', enabled: false });
  assert.equal((await call(coach, '/me/capabilities')).operationsSummaryView, false, '关闭后教练应即时失去运营概览权限');
  await call(administrator, '/dean/job-capabilities', 'PATCH', { jobType: 'coach', capability: 'operations.summary.view', enabled: true });
  assert.equal((await call(coach, '/me/capabilities')).operationsSummaryView, true, '重新开启后权限恢复');

  assert.equal((await call(administrator, '/dean/job-capabilities', 'PATCH', { jobType: 'coach', capability: 'medical_advice.publish', enabled: true }, 400)).code, 'CAPABILITY_FIXED');
  assert.equal((await call(administrator, '/dean/job-capabilities', 'PATCH', { jobType: 'coach', capability: 'operations.summary.view', enabled: 'yes' }, 400)).code, 'CAPABILITY_UPDATE_INVALID');
  await call(clinician, '/dean/job-capabilities', 'PATCH', { jobType: 'coach', capability: 'operations.summary.view', enabled: false }, 403);
  assert.equal((await call(dean, '/me/capabilities')).staffManagement, true, '院长始终具备管理权限');
});
