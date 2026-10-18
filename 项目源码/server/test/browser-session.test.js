import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
Object.assign(process.env, {
  NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '0',
  AUTH_SECRET: 'g12-synthetic-http-fixture-only', LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0'
});
const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db.js');
const { hashPasswordAsync } = await import('../src/password.js');
const { signToken } = await import('../src/auth.js');
const { allowedBrowserOrigins } = await import('../src/browser-session.js');
const { createRequestControls } = await import('../src/request-controls.js');
const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(async () => { server.closeIdleConnections(); await new Promise(resolve => server.close(resolve)); await db.close(); });
test.beforeEach(() => { app.locals.requestControls = createRequestControls(); });
const trusted = { Origin: 'http://127.0.0.1:5180', 'X-Community-Request': '1' };
const web = { ...trusted, 'X-Session-Transport': 'cookie' };
const password = 'Synthetic-G12-123';
let serial = 0;
async function call(route, { method = 'GET', body, headers = {}, cookie, token } = {}) {
  const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json',
    ...(cookie === undefined ? {} : { Cookie: cookie }), ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const setCookie = r.headers.get('Set-Cookie');
  return { status: r.status, data: await r.json(), setCookie, cookie: setCookie?.split(';')[0], headers: r.headers };
}
async function register(headers = web) {
  const phone = `1990001${String(++serial).padStart(4, '0')}`;
  return call('/auth/register', { method: 'POST', headers, body: { name: '合成G12客人', phone, password, confirmPassword: password } });
}
async function effects() {
  const data = {};
  for (const table of ['users', 'guest_profiles', 'audit_logs', 'assistant_sessions', 'assistant_messages', 'agent_runs', 'reservations']) {
    data[table] = await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
  }
  return data;
}
async function fixtureUser(role, job = null) {
  const id = 'g12-' + crypto.randomUUID();
  await db.prepare("INSERT INTO users(id,username,password_hash,role,name,status,job_type,created_at) VALUES(?,?,?,?,?,'active',?,?)")
    .run(id, id, await hashPasswordAsync(password), role, '合成G12岗位', job, new Date().toISOString());
  return await db.prepare('SELECT * FROM users WHERE id=?').get(id);
}
async function login(user, headers = web) {
  return call('/auth/login', { method: 'POST', headers, body: { username: user.username, password, role: user.role } });
}

test('cookie registration: host-only HttpOnly Lax eight-hour HTTP cookie, no body token; /me real pending identity', async () => {
  const r = await register();
  assert.equal(r.status, 201);
  assert.equal(Object.hasOwn(r.data, 'token'), false);
  assert.match(r.setCookie, /HttpOnly/); assert.match(r.setCookie, /SameSite=Lax/);
  assert.match(r.setCookie, /Path=\//); assert.match(r.setCookie, /Max-Age=28800/); assert.match(r.setCookie, /Expires=/);
  assert.doesNotMatch(r.setCookie, /Domain=|Secure/);
  const me = await call('/me', { cookie: r.cookie });
  assert.equal(me.status, 200); assert.equal(me.data.id, r.data.user.id); assert.equal(me.data.admissionStatus, 'pending');
  assert.equal((await db.prepare('SELECT user_id FROM guest_profiles WHERE user_id=?').get(me.data.id)).user_id, me.data.id);
});

test('cookie login for three identities and all five jobs preserves capabilities and separates identities', async () => {
  const guest = await register();
  const users = [await db.prepare('SELECT * FROM users WHERE id=?').get(guest.data.user.id), await fixtureUser('dean'),
    ...await Promise.all(['administrator', 'clinician', 'coach', 'therapist', 'dietitian'].map(job => fixtureUser('staff', job)))];
  const cookies = new Set();
  for (const user of users) {
    const r = await login(user);
    assert.equal(r.status, 200); assert.equal(Object.hasOwn(r.data, 'token'), false); cookies.add(r.cookie);
    const me = await call('/me', { cookie: r.cookie });
    assert.equal(me.status, 200); assert.equal(me.data.id, user.id); assert.equal(me.data.role, user.role);
    if (user.role === 'staff') {
      assert.equal(me.data.jobType, user.job_type);
      assert.equal(me.data.capabilities.medicalAdvicePublish, user.job_type === 'clinician');
    }
    const management = await call('/dean/staff', { cookie: r.cookie });
    assert.equal(management.status, user.role === 'dean' || user.job_type === 'administrator' ? 200 : 403);
  }
  assert.equal(cookies.size, 7);
});

test('explicit/default Bearer response stays compatible, Bearer wins over cookie and invalid Bearer never falls back', async () => {
  const guest = await register(); const dean = await fixtureUser('dean');
  for (const headers of [{}, { 'X-Session-Transport': 'bearer' }]) {
    const r = await login(dean, headers);
    assert.equal(r.status, 200); assert.equal(typeof r.data.token, 'string'); assert.equal(r.setCookie, null);
    assert.equal((await call('/me', { cookie: guest.cookie, token: r.data.token })).data.id, dean.id);
  }
  for (const authorization of ['Bearer broken', 'Basic broken', '']) {
    assert.equal((await call('/me', { cookie: guest.cookie, headers: { Authorization: authorization } })).status, 401);
    assert.equal((await call('/assistant/status', { cookie: guest.cookie, headers: { Authorization: authorization } })).status, 401);
  }
  const bearerGuest = await register({});
  assert.equal(bearerGuest.status, 201); assert.equal(typeof bearerGuest.data.token, 'string'); assert.equal(bearerGuest.setCookie, null);
});

test('bad, duplicate, empty, tampered and expired cookies cannot become anonymous, valid token syntax is exact', async () => {
  const guest = await register();
  const user = await db.prepare('SELECT * FROM users WHERE id=?').get(guest.data.user.id);
  const body = Buffer.from(JSON.stringify({ sub: user.id, exp: Date.now() - 1000 })).toString('base64url');
  const expired = body + '.' + crypto.createHmac('sha256', process.env.AUTH_SECRET).update(body).digest('base64url');
  const before = await effects();
  for (const cookie of ['haiyu_session=', 'haiyu_session=bad', 'haiyu_session=%zz', `haiyu_session=${expired}`, guest.cookie + '.extra', guest.cookie + ';' + guest.cookie]) {
    assert.equal((await call('/me', { cookie })).status, 401);
    assert.equal((await call('/assistant/status', { cookie })).status, 401);
    assert.equal((await call('/assistant/chat', { method: 'POST', cookie, headers: trusted, body: { role: 'public', text: '你好' } })).status, 401);
  }
  assert.deepEqual(await effects(), before);
  assert.equal((await call('/me')).status, 401);
  assert.equal((await call('/assistant/status')).status, 200);
});

test('cookie login and registration reject cross-site, null, missing Origin or protection header before any database effects', async () => {
  const user = await fixtureUser('dean');
  for (const headers of [
    { 'X-Session-Transport': 'cookie' },
    { 'X-Session-Transport': 'cookie', Origin: trusted.Origin },
    { ...web, Origin: 'https://evil.example' }, { ...web, Origin: 'null' },
    { ...web, Origin: 'http://localhost:3020' },
    { ...web, 'X-Community-Request': '0' }
  ]) {
    const before = await effects();
    assert.equal((await register(headers)).status, 403);
    assert.equal((await login(user, headers)).status, 403);
    assert.deepEqual(await effects(), before);
  }
  assert.equal((await login(user, { ...web, Origin: 'http://localhost:5180' })).status, 200);
  assert.equal((await login(user, { ...web, 'X-Session-Transport': 'invalid' })).status, 400);
});

test('cookie profile writes require Origin and header, reject CSRF with unchanged data; trusted write succeeds', async () => {
  const guest = await register();
  for (const headers of [{}, { Origin: trusted.Origin }, { 'X-Community-Request': '1' }, { ...trusted, Origin: 'https://evil.example' }]) {
    const before = await effects();
    const r = await call('/me/profile', { method: 'PATCH', cookie: guest.cookie, headers, body: { emergencyContact: 'must-not-write' } });
    assert.equal(r.status, 403); assert.equal(r.data.code, 'CSRF_REJECTED'); assert.deepEqual(await effects(), before);
  }
  const r = await call('/me/profile', { method: 'PATCH', cookie: guest.cookie, headers: trusted, body: { emergencyContact: '合成紧急联系人' } });
  assert.equal(r.status, 200);
  assert.equal((await db.prepare('SELECT emergency_contact FROM guest_profiles WHERE user_id=?').get(guest.data.user.id)).emergency_contact, '合成紧急联系人');
});

test('cookie password change renews only current browser, old cookie/Bearer revoked, API password contract stays usable', async () => {
  const guest = await register(); const user = await db.prepare('SELECT * FROM users WHERE id=?').get(guest.data.user.id);
  const oldToken = signToken(user);
  const body = { currentPassword: password, newPassword: 'Synthetic-G12-456' };
  const before = await effects();
  assert.equal((await call('/me/password', { method: 'POST', cookie: guest.cookie, body })).status, 403);
  assert.deepEqual(await effects(), before);
  const r = await call('/me/password', { method: 'POST', cookie: guest.cookie, headers: web, body });
  assert.equal(r.status, 200); assert.deepEqual(r.data, { ok: true }); assert.notEqual(r.cookie, guest.cookie);
  assert.equal((await call('/me', { cookie: r.cookie })).status, 200);
  for (const credentials of [{ cookie: guest.cookie }, { token: oldToken }]) {
    const old = await call('/me', credentials); assert.equal(old.status, 401); assert.equal(old.data.code, 'AUTH_TOKEN_REVOKED');
  }
  assert.equal((await db.prepare('SELECT token_version FROM users WHERE id=?').get(user.id)).token_version, 1);
  const token = signToken(await db.prepare('SELECT * FROM users WHERE id=?').get(user.id));
  const api = await call('/me/password', { method: 'POST', token, body: { currentPassword: body.newPassword, newPassword: 'Synthetic-G12-789' } });
  assert.equal(api.status, 200); assert.equal(typeof api.data.token, 'string'); assert.equal(api.setCookie, null);
  assert.equal((await call('/me', { token: api.data.token })).status, 200);
  assert.equal((await call('/me', { cookie: r.cookie })).status, 401);
});

test('logout clears current cookie with matching attributes; denied logout has no effect, copied credentials remain valid', async () => {
  const guest = await register();
  const before = await effects();
  for (const route of ['/auth/logout', '/AUTH/LOGOUT/']) {
    const crossSite = await call(route, { method: 'POST', headers: { Origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403); assert.equal(crossSite.setCookie, null);
  }
  const denied = await call('/auth/logout', { method: 'POST', cookie: guest.cookie });
  assert.equal(denied.status, 403); assert.equal(denied.setCookie, null);
  assert.equal((await call('/me', { cookie: guest.cookie })).status, 200);
  const out = await call('/auth/logout', { method: 'POST', cookie: guest.cookie, headers: web });
  assert.equal(out.status, 200); assert.match(out.setCookie, /haiyu_session=;/); assert.match(out.setCookie, /HttpOnly/);
  assert.match(out.setCookie, /Expires=Thu, 01 Jan 1970/); assert.doesNotMatch(out.setCookie, /Domain=/);
  assert.equal((await call('/me')).status, 401);
  assert.equal((await call('/me', { cookie: guest.cookie })).status, 200);
  assert.equal((await call('/auth/logout', { method: 'POST', cookie: 'haiyu_session=expired', headers: web })).status, 200);
  assert.deepEqual(await effects(), before);
});

test('anonymous and authenticated assistants stay distinct and cookie requests retain G05 limits', async () => {
  const guest = await register();
  for (const [cookie, headers, role] of [[undefined, {}, 'public'], [guest.cookie, web, 'guest']]) {
    const result = await call('/assistant/chat', { method: 'POST', cookie, headers, body: { role, text: '你好' } });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const session = await db.prepare('SELECT user_id FROM assistant_sessions WHERE id=?').get(result.data.sessionId);
    assert.equal(session.user_id, cookie ? guest.data.user.id : null);
  }
  app.locals.requestControls = createRequestControls({ config: (await import('../src/request-controls.js')).readRequestControlConfig({ REQUEST_LIMIT_ASSISTANT_IP: '1' }) });
  assert.equal((await call('/assistant/chat', { method: 'POST', cookie: guest.cookie, headers: web, body: { role: 'guest', text: '你好' } })).status, 200);
  const before = await effects();
  const limited = await call('/assistant/chat', { method: 'POST', cookie: guest.cookie, headers: web, body: { role: 'guest', text: '你好' } });
  assert.equal(limited.status, 429); assert.match(limited.headers.get('Retry-After'), /^[1-9]\d*$/); assert.deepEqual(await effects(), before);
});

test('pending cookie guest cannot reserve a real slot after confirmed health intake', async () => {
  await (await import('../../scripts/bugfix-stage2/catalog-fixture.js')).prepareSyntheticIndoorExercise();
  const guest = await register();
  const admin = await fixtureUser('staff', 'administrator'); const clinician = await fixtureUser('staff', 'clinician');
  assert.equal((await call(`/dean/guests/${guest.data.user.id}/assignments`, { method: 'POST', token: signToken(admin), body: { staffId: clinician.id } })).status, 201);
  const none = { status: 'none', items: [] };
  const intake = await call('/me/health-intakes', { method: 'POST', cookie: guest.cookie, headers: web, body: { baseProfileVersion: 0,
    profile: { chronic: none, medications: none, allergies: none, dietaryRestrictions: none,
      mobility: { status: 'independent', details: '合成可独立活动' }, sleep: { status: 'reported', details: '合成正常' },
      skin: { status: 'reported', details: '合成完整' }, audienceTags: none } } });
  assert.equal(intake.status, 201, JSON.stringify(intake.data));
  const confirmed = await call(`/staff/health-intakes/${intake.data.pendingIntakes[0].id}/confirm`, { method: 'POST', token: signToken(clinician), body: { baseProfileVersion: 0 } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  const { systemBusinessClock } = await import('../src/clock.js');
  const slots = await call('/projects/stage2-indoor-exercise/slots?date=' + new Date(Date.parse(systemBusinessClock.dateKey() + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10), { cookie: guest.cookie });
  assert.equal(slots.status, 200); assert.ok(slots.data.slots.length);
  const before = await effects();
  const denied = await call('/reservations', { method: 'POST', cookie: guest.cookie,
    headers: { ...web, 'Idempotency-Key': 'g12-pending-admission' }, body: { slotId: slots.data.slots[0].id } });
  assert.equal(denied.status, 409, JSON.stringify(denied.data)); assert.equal(denied.data.code, 'STAY_NOT_ACTIVE');
  assert.deepEqual(await effects(), before);
});

test('production cookie is Secure and invalid origin configuration fails explicitly', async () => {
  for (const bad of ['*', 'null', 'https://ok.example/path', 'https://ok.example/', 'http://u:p@localhost:5180', '']) {
    assert.throws(() => allowedBrowserOrigins(bad), /CORS_ALLOWED_ORIGINS/);
  }
  process.env.NODE_ENV = 'production';
  try {
    const r = await register(); assert.equal(r.status, 201); assert.match(r.setCookie, /Secure/); assert.match(r.setCookie, /HttpOnly/);
  } finally { process.env.NODE_ENV = 'test'; }
});
