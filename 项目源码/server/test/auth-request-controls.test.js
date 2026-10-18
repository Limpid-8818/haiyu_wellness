import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
Object.assign(process.env, {
  NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  AUTH_SECRET: 'g05-g37-synthetic-fixture-only', LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0', BUSINESS_CLOCK_NOW: '2030-01-01T00:00:00.000Z'
});
const { createApp } = await import('../src/app.js');
const { db, transaction, hashPassword, hasActiveTransaction, now } = await import('../src/db.js');
const { verifyPasswordAsync } = await import('../src/password.js');
const { signToken } = await import('../src/auth.js');
const { createRequestControls, readRequestControlConfig } = await import('../src/request-controls.js');
await (await import('../src/demo-team.js')).initializeDemoTeam({ database: db, transact: transaction, hashPassword, stamp: now() });
await (await import('../../scripts/bugfix-stage2/catalog-fixture.js')).prepareSyntheticIndoorExercise();
const fixtureHash = hashPassword('Synthetic-only-123');
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
let time = 0;
function controls(env = {}) {
  app.locals.requestControls = createRequestControls({ config: readRequestControlConfig(env), clock: () => time });
  return app.locals.requestControls;
}
test.beforeEach(t => {
  time = 0;
  controls();
  t.mock.method(crypto, 'scryptSync', () => { throw new Error('HTTP must never use synchronous scrypt'); });
});
async function call(route, { body, token, headers = {}, method = 'POST' } = {}) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json(), retryAfter: response.headers.get('Retry-After') };
}
function limited(result) {
  assert.equal(result.status, 429, JSON.stringify(result.data));
  assert.equal(result.data.code, 'REQUEST_LIMIT_EXCEEDED');
  assert.match(result.data.error, /请求过于频繁/);
  assert.match(result.retryAfter, /^[1-9]\d*$/);
}
const loginBody = (username = 'guest_demo', password = 'guest2026', role = 'guest') => ({ username, password, role });
const registerBody = phone => ({ phone, name: '合成注册客人', password: 'Synthetic-only-123', confirmPassword: 'Synthetic-only-123', role: 'dean' });
async function user(id) { return await db.prepare('SELECT * FROM users WHERE id=?').get(id); }
async function token(id = 'guest_001') { return signToken(await user(id)); }
async function syntheticUser(role = 'guest') {
  const id = `g05-${crypto.randomUUID()}`;
  await db.prepare("INSERT INTO users(id,username,password_hash,role,name,status) VALUES(?,?,?,?,?,'active')")
    .run(id, id, fixtureHash, role, '合成并发账号');
  return await user(id);
}
async function effects() {
  const counts = {};
  for (const table of ['users', 'guest_profiles', 'audit_logs', 'agent_runs', 'assistant_sessions', 'assistant_messages']) {
    counts[table] = Number((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);
  }
  return counts;
}
function traceDerivations(t) {
  const original = crypto.scrypt;
  const calls = [];
  t.mock.method(crypto, 'scrypt', (...args) => {
    calls.push({ password: args[0], inTransaction: hasActiveTransaction() });
    return original(...args);
  });
  return calls;
}

test('real login: missing, wrong, damaged hash use one async derive and identical 401; valid roles remain usable', async t => {
  const damaged = await syntheticUser();
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run('broken-hash', damaged.id);
  const calls = traceDerivations(t);
  let failure;
  for (const body of [loginBody('unknown-account', 'wrong'), loginBody('guest_demo', 'wrong'), loginBody(damaged.username, 'wrong')]) {
    const before = calls.length;
    const result = await call('/auth/login', { body });
    assert.equal(result.status, 401);
    assert.equal(calls.length - before, 1);
    if (failure) assert.deepEqual(result.data, failure); else failure = result.data;
  }
  for (const [username, role, password] of [
    ['guest_demo', 'guest', 'guest2026'], ['dean_demo', 'dean', 'dean2026'],
    ...['admin_demo', 'staff_demo', 'coach_demo', 'therapist_demo', 'dietitian_demo'].map(name => [name, 'staff', 'staff2026'])
  ]) {
    const result = await call('/auth/login', { body: loginBody(username, password, role) });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.user.role, role);
    assert.equal((await call('/me', { token: result.data.token, method: 'GET' })).status, 200);
  }
  assert.equal(calls.some(item => item.inTransaction), false);
});

test('real login: trusted socket IP caps rotating accounts and forged proxy headers, rejects before derive or audit, restores at expiry', async t => {
  controls({ REQUEST_LIMIT_LOGIN_IP: '2', REQUEST_LIMIT_LOGIN_WINDOW_MS: '1500' });
  const calls = traceDerivations(t);
  assert.equal((await call('/auth/login', { body: loginBody() })).status, 200);
  assert.equal((await call('/auth/login', { body: loginBody('missing') })).status, 401);
  const before = await effects();
  const result = await call('/auth/login', { body: loginBody('new-account'), headers: {
    'X-Forwarded-For': '203.0.113.1', Forwarded: 'for=203.0.113.2', 'X-Real-IP': '203.0.113.3'
  } });
  limited(result); assert.equal(result.retryAfter, '2');
  assert.equal(calls.length, 2); assert.deepEqual(await effects(), before);
  time = 1500;
  assert.equal((await call('/auth/login', { body: loginBody() })).status, 200);
});

test('real login: account bucket survives a different IP and role/case/whitespace variants; other account remains usable', async t => {
  const limiter = controls({ REQUEST_LIMIT_LOGIN_IDENTITY: '1' });
  limiter.consume('login', { ip: 'synthetic-other-ip', identity: 'guest_demo' });
  const calls = traceDerivations(t);
  limited(await call('/auth/login', { body: loginBody(' GUEST_DEMO ', 'wrong', 'dean') }));
  assert.equal(calls.length, 0);
  assert.equal((await call('/auth/login', { body: loginBody('dean_demo', 'dean2026', 'dean') })).status, 200);
});

test('real concurrent login admits exactly the IP quota before async derivation', async t => {
  controls({ REQUEST_LIMIT_LOGIN_IP: '2' });
  const calls = traceDerivations(t);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => call('/auth/login', { body: loginBody(`parallel-${i}`, 'wrong') })));
  assert.equal(results.filter(result => result.status === 401).length, 2);
  results.filter(result => result.status !== 401).forEach(limited);
  assert.equal(calls.length, 2);
});

test('registration retains format, password, name and duplicate checks; new accounts remain guests pending admission', async t => {
  const calls = traceDerivations(t);
  for (const [index, patch] of [
    { phone: '12800000000' }, { phone: '1380000000' }, { phone: '1380000000a' },
    { password: 'short' }, { confirmPassword: 'wrong' }, { name: '' }, { name: '名'.repeat(65) }
  ].entries()) assert.equal((await call('/auth/register', { body: { ...registerBody(`1990000940${index}`), ...patch } })).status, 400);
  assert.equal(calls.length, 0);
  const result = await call('/auth/register', { body: registerBody('19900009001') });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal(result.data.user.role, 'guest'); assert.equal(result.data.admissionStatus, 'pending');
  assert.equal(calls.length, 1); assert.equal(calls[0].inTransaction, false);
  const row = await user(result.data.user.id);
  assert.equal(typeof row.password_hash, 'string');
  assert.equal(await verifyPasswordAsync('Synthetic-only-123', row.password_hash), true);
  const profile = await db.prepare('SELECT * FROM guest_profiles WHERE user_id=?').get(row.id);
  assert.equal(profile.check_in, null); assert.equal(profile.check_out, null);
  assert.equal((await call('/dean/staff', { token: result.data.token, method: 'GET' })).status, 403);
  const before = await effects();
  assert.equal((await call('/auth/register', { body: registerBody('19900009001') })).status, 409);
  assert.deepEqual(await effects(), before);
});

test('registration IP quota prevents parallel writes; phone quota spans IPs and expiry restores registration', async t => {
  let limiter = controls({ REQUEST_LIMIT_REGISTER_IP: '2', REQUEST_LIMIT_REGISTER_WINDOW_MS: '1000' });
  const calls = traceDerivations(t);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => call('/auth/register', { body: registerBody(`1990000910${i}`) })));
  assert.equal(results.filter(result => result.status === 201).length, 2);
  results.filter(result => result.status !== 201).forEach(limited);
  assert.equal(calls.length, 2);
  const before = await effects();
  limited(await call('/auth/register', { body: registerBody('19900009200') }));
  assert.deepEqual(await effects(), before); assert.equal(calls.length, 2);
  time = 1000;
  assert.equal((await call('/auth/register', { body: registerBody('19900009200') })).status, 201);
  limiter = controls({ REQUEST_LIMIT_REGISTER_IDENTITY: '1' });
  limiter.consume('register', { ip: 'synthetic-other-ip', identity: '19900009201' });
  const count = calls.length;
  limited(await call('/auth/register', { body: registerBody(' 19900009201 ') }));
  assert.equal(calls.length, count);
});

test('concurrent duplicate registration creates exactly one complete account/profile/audit', async () => {
  const before = await effects();
  const results = await Promise.all([1, 2].map(() => call('/auth/register', { body: registerBody('19900009300') })));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const after = await effects();
  for (const table of ['users', 'guest_profiles', 'audit_logs']) assert.equal(after[table] - before[table], 1);
});

test('a registered guest with confirmed health data still cannot reserve before admission', async () => {
  const registered = await call('/auth/register', { body: registerBody('19900009501') });
  assert.equal(registered.status, 201);
  const guestId = registered.data.user.id, guestToken = registered.data.token;
  assert.equal((await call(`/dean/guests/${guestId}/assignments`, { token: await token('demo_admin'), body: { staffId: 'staff_001' } })).status, 201);
  const none = { status: 'none', items: [] };
  const intake = await call('/me/health-intakes', { token: guestToken, body: { baseProfileVersion: 0,
    profile: { chronic: none, medications: none, allergies: none, dietaryRestrictions: none,
      mobility: { status: 'independent', details: '合成可独立活动' }, sleep: { status: 'reported', details: '合成正常' },
      skin: { status: 'reported', details: '合成完整' }, audienceTags: none } } });
  assert.equal(intake.status, 201, JSON.stringify(intake.data));
  assert.equal((await call(`/staff/health-intakes/${intake.data.pendingIntakes[0].id}/confirm`, { token: await token('staff_001'), body: { baseProfileVersion: 0 } })).status, 200);
  const slots = await call('/projects/stage2-indoor-exercise/slots?date=2030-01-02', { token: guestToken, method: 'GET' });
  assert.equal(slots.status, 200);
  const denied = await call('/reservations', { token: guestToken, body: { slotId: slots.data.slots[0].id }, headers: { 'Idempotency-Key': 'g05-pending-admission' } });
  assert.equal(denied.status, 409, JSON.stringify(denied.data));
  assert.equal(denied.data.code, 'STAY_NOT_ACTIVE');
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE guest_id=?').get(guestId)).n, 0);
});

test('anonymous chat, async chat and changing retry run IDs share the IP quota without new run/message writes', async () => {
  controls({ REQUEST_LIMIT_ASSISTANT_IP: '1', REQUEST_LIMIT_ASSISTANT_WINDOW_MS: '1000' });
  const reply = await call('/assistant/chat', { body: { role: 'public', text: '你好' } });
  assert.equal(reply.status, 200); assert.ok(reply.data.runId);
  const before = await effects();
  for (const id of [reply.data.runId, 'invented-run']) limited(await call(`/assistant/runs/${id}/retry`, { body: { role: 'public', guestId: crypto.randomUUID() } }));
  limited(await call('/assistant/chat', { body: { role: 'public', text: '你好', async: true, guestId: crypto.randomUUID(), clientRequestId: crypto.randomUUID() }, headers: { 'X-Forwarded-For': '203.0.113.9' } }));
  assert.deepEqual(await effects(), before);
  time = 1000;
  const retry = await call(`/assistant/runs/${reply.data.runId}/retry`, { body: { role: 'public' } });
  assert.equal(retry.status, 200);
  assert.equal((await call('/assistant/status', { method: 'GET' })).status, 200);
});

test('authenticated assistant buckets use the verified subject across IPs, chat/retry and self-reported guest IDs', async () => {
  const limiter = controls({ REQUEST_LIMIT_ASSISTANT_IDENTITY: '1' });
  limiter.consume('assistant', { ip: 'synthetic-other-ip', identity: 'guest_001' });
  const before = await effects();
  const guestToken = await token();
  limited(await call('/assistant/chat', { token: guestToken, body: { text: '你好', guestId: 'different-guest' } }));
  limited(await call('/assistant/runs/another-run/retry', { token: guestToken, body: { role: 'guest' } }));
  assert.deepEqual(await effects(), before);
  assert.equal((await call('/assistant/chat', { body: { role: 'public', text: '你好', guestId: 'guest_001' } })).status, 401);
  assert.deepEqual(await effects(), before);
  assert.equal((await call('/assistant/chat', { body: { role: 'public', text: '你好' } })).status, 200);
  assert.equal((await call('/assistant/chat', { token: 'invalid-token', body: { text: '你好' } })).status, 401);
});

test('staff creation and password changes use async derives outside transactions; quota rejects both write paths before scrypt', async t => {
  const adminToken = await token('demo_admin');
  const calls = traceDerivations(t);
  const result = await call('/dean/staff', { token: adminToken, body: { username: 'g05_created_coach', password: 'Synthetic-only-123', name: '合成新教练', jobType: 'coach' } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.equal((await call('/auth/login', { body: loginBody('g05_created_coach', 'Synthetic-only-123', 'staff') })).status, 200);
  const row = await syntheticUser(); const oldToken = signToken(row);
  assert.equal((await call('/me/password', { token: oldToken, body: { currentPassword: 'wrong', newPassword: 'Synthetic-rotated-123' } })).status, 400);
  const changed = await call('/me/password', { token: oldToken, body: { currentPassword: 'Synthetic-only-123', newPassword: 'Synthetic-rotated-123' } });
  assert.equal(changed.status, 200); assert.equal((await user(row.id)).token_version, 1);
  assert.equal((await call('/me', { token: oldToken, method: 'GET' })).status, 401);
  assert.equal((await call('/me', { token: changed.data.token, method: 'GET' })).status, 200);
  assert.equal((await call('/auth/login', { body: loginBody(row.username, 'Synthetic-rotated-123') })).status, 200);
  assert.equal(calls.some(item => item.inTransaction), false);
  const limiter = controls({ REQUEST_LIMIT_PASSWORD_IP: '1' });
  limiter.consume('password', { ip: '127.0.0.1', identity: 'synthetic-other-subject' });
  const before = await effects(); const count = calls.length;
  limited(await call('/me/password', { token: changed.data.token, body: { currentPassword: 'Synthetic-rotated-123', newPassword: 'Another-password-123' } }));
  limited(await call('/dean/staff', { token: adminToken, body: { username: 'never-created', name: '合成', password: 'Synthetic-only-123', jobType: 'coach' } }));
  assert.deepEqual(await effects(), before); assert.equal(calls.length, count);
});

test('concurrent async password changes cannot overwrite the winning hash or mint a second valid token', { timeout: 10000 }, async t => {
  const row = await syntheticUser(); const oldToken = signToken(row);
  const original = crypto.scrypt;
  const releases = [];
  let bothReady;
  const ready = new Promise(resolve => { bothReady = resolve; });
  t.mock.method(crypto, 'scrypt', (password, salt, length, callback) => original(password, salt, length, (error, derived) => {
    if (password.startsWith('Concurrent-new-') && releases.length < 2) {
      assert.equal(hasActiveTransaction(), false);
      releases.push(() => callback(error, derived));
      if (releases.length === 2) bothReady();
    } else callback(error, derived);
  }));
  const pending = [1, 2].map(i => call('/me/password', { token: oldToken, body: { currentPassword: 'Synthetic-only-123', newPassword: `Concurrent-new-${i}` } }));
  await ready;
  releases.forEach(release => release());
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
  const winner = results.findIndex(result => result.status === 200);
  const updated = await user(row.id);
  assert.equal(updated.token_version, 1);
  assert.equal(await verifyPasswordAsync(`Concurrent-new-${winner + 1}`, updated.password_hash), true);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id=? AND action='password.change'").get(row.id)).n, 1);
  assert.equal((await call('/me', { token: results[winner].data.token, method: 'GET' })).status, 200);
  assert.equal((await call('/me', { token: oldToken, method: 'GET' })).status, 401);
});

test('staff creator disabled during async derivation cannot write an account', { timeout: 10000 }, async t => {
  const creator = await syntheticUser('dean');
  const original = crypto.scrypt;
  let release, reached;
  const ready = new Promise(resolve => { reached = resolve; });
  t.mock.method(crypto, 'scrypt', (password, salt, length, callback) => original(password, salt, length, (error, derived) => {
    release = () => callback(error, derived); reached();
  }));
  const before = await effects();
  const pending = call('/dean/staff', { token: signToken(creator), body: { username: 'g05_revoked_creator', password: 'Synthetic-only-123', name: '合成', jobType: 'coach' } });
  await ready;
  await transaction(async () => { await db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(creator.id); });
  release();
  assert.equal((await pending).status, 401);
  assert.deepEqual(await effects(), before);
});
