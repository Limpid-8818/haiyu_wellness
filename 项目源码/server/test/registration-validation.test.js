import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0',
  // 本文件只测注册/登录校验分支；限流行为由 auth-request-controls.test.js 专项覆盖，这里放宽以连续触发分支。
  REQUEST_LIMIT_REGISTER_IP: '1000', REQUEST_LIMIT_REGISTER_IDENTITY: '1000'
});
const { app } = await import('../src/app.js');
const { db } = await import('../src/db.js');
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

const valid = { phone: '13911112222', password: 'guest2026x', confirmPassword: 'guest2026x', name: '注册校验客人' };

test('注册校验：非法手机号、密码长度、两次不一致、姓名越界逐项拒绝且不创建账号', async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='guest'").get().n;
  assert.equal((await call(null, '/auth/register', 'POST', { ...valid, phone: '12345' }, 400)).code, 'REGISTER_PHONE_INVALID');
  assert.equal((await call(null, '/auth/register', 'POST', { ...valid, password: '1234567', confirmPassword: '1234567' }, 400)).code, 'REGISTER_PASSWORD_INVALID');
  assert.equal((await call(null, '/auth/register', 'POST', { ...valid, password: 'x'.repeat(129), confirmPassword: 'x'.repeat(129) }, 400)).code, 'REGISTER_PASSWORD_INVALID');
  assert.equal((await call(null, '/auth/register', 'POST', { ...valid, confirmPassword: 'different9' }, 400)).code, 'REGISTER_PASSWORD_MISMATCH');
  assert.equal((await call(null, '/auth/register', 'POST', { ...valid, name: ' '.repeat(65) }, 400)).code, 'REGISTER_NAME_INVALID');
  await call(null, '/auth/register', 'POST', ['not-an-object'], 400);
  const after = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='guest'").get().n;
  assert.equal(after, before, '全部非法注册不得创建账号');
});

test('合法注册：201 待入住，可直接登录并携带能力清单', async () => {
  const registered = await call(null, '/auth/register', 'POST', valid, 201);
  assert.equal(registered.admissionStatus, 'pending');
  assert.equal(registered.user.role, 'guest');
  assert.equal(registered.user.name, '注册校验客人');
  assert.equal((await call(null, '/auth/register', 'POST', valid, 409)).code, 'REGISTER_PHONE_TAKEN');
  const login = await call(null, '/auth/login', 'POST', { username: valid.phone, password: valid.password, role: 'guest' });
  assert.ok(login.token);
  const guestCapabilities = await call(login.token, '/me/capabilities');
  assert.equal(guestCapabilities.staffManagement, false);
  assert.equal(guestCapabilities.operationsSummaryView, false);
  assert.equal(guestCapabilities.medicalAdvicePublish, false);
});

test('三角色能力矩阵：医护可发医嘱、院长可看运营概览、客人全部为否', async () => {
  const staff = (await call(null, '/auth/login', 'POST', { username: 'staff_demo', password: 'staff2026', role: 'staff' })).token;
  const dean = (await call(null, '/auth/login', 'POST', { username: 'dean_demo', password: 'dean2026', role: 'dean' })).token;
  assert.equal((await call(staff, '/me/capabilities')).medicalAdvicePublish, true);
  assert.equal((await call(staff, '/me/capabilities')).staffManagement, false);
  const deanCapabilities = await call(dean, '/me/capabilities');
  assert.equal(deanCapabilities.operationsSummaryView, true);
  assert.equal(deanCapabilities.staffManagement, true);
  assert.equal(deanCapabilities.medicalAdvicePublish, false);
});

test('登录失败：错误密码与错误身份同码 401，不泄露差异', async () => {
  assert.equal((await call(null, '/auth/login', 'POST', { username: 'guest_demo', password: 'wrong-pass', role: 'guest' }, 401)).code, 'AUTH_INVALID_CREDENTIALS');
  assert.equal((await call(null, '/auth/login', 'POST', { username: 'guest_demo', password: 'guest2026', role: 'dean' }, 401)).code, 'AUTH_INVALID_CREDENTIALS');
  assert.equal((await call(null, '/auth/login', 'POST', { username: 'no_such_user', password: 'whatever1', role: 'staff' }, 401)).code, 'AUTH_INVALID_CREDENTIALS');
});

test('预约请求体只接受时段编号：未知字段与非字符串 slotId 拒绝', async () => {
  const { token } = await call(null, '/auth/login', 'POST', { username: 'guest_demo', password: 'guest2026', role: 'guest' });
  assert.equal((await call(token, '/reservations', 'POST', { slotId: 'slot_x', extra: 1 }, 400)).code, 'RESERVATION_INPUT_INVALID');
  assert.equal((await call(token, '/reservations', 'POST', { slotId: 123 }, 400)).code, 'RESERVATION_INPUT_INVALID');
});
