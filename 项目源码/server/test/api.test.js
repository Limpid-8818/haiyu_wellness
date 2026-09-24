import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from '../src/password.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('password hashes are salted and verifiable without opening the demo database', () => {
  const stored = hashPassword('correct-password');
  assert.notEqual(stored, 'correct-password');
  assert.notEqual(stored, hashPassword('correct-password'));
  assert.equal(verifyPassword('correct-password', stored), true);
  assert.equal(verifyPassword('wrong-password', stored), false);
  assert.equal(verifyPassword({ password: 'correct-password' }, stored), false);
});

async function startApi(dbPath, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      DB_PATH: dbPath,
      PORT: '0',
      AUTH_SECRET: 'integration-test-secret',
      LLM_BASE_URL: '',
      LLM_API_KEY: '',
      LLM_TIMEOUT_MS: '20000',
      ASSISTANT_SESSION_TTL_MS: '28800000',
      ...extraEnv
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const started = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`API start timeout\n${stdout}\n${stderr}`)), 8_000);
    const onExit = code => reject(new Error(`API exited before start (${code})\n${stdout}\n${stderr}`));
    child.once('exit', onExit);
    const check = () => {
      const match = stdout.match(/API running at http:\/\/localhost:(\d+)\/api/);
      if (!match) return setTimeout(check, 10);
      clearTimeout(timeout);
      child.off('exit', onExit);
      resolve(`http://127.0.0.1:${match[1]}/api`);
    };
    check();
  });
  return { child, base: started };
}

async function stopApi(fixture) {
  if (!fixture?.child || fixture.child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      fixture.child.kill('SIGKILL');
      resolve();
    }, 4_000);
    fixture.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    fixture.child.kill('SIGTERM');
  });
}

async function request(base, route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function login(base, role) {
  const credentials = {
    guest: ['guest_demo', 'guest2026'],
    staff: ['staff_demo', 'staff2026'],
    dean: ['dean_demo', 'dean2026']
  }[role];
  const result = await request(base, '/auth/login', {
    method: 'POST',
    body: { username: credentials[0], password: credentials[1], role }
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data.token;
}

function mutateDatabase(dbPath, callback) {
  const database = new DatabaseSync(dbPath);
  try { return callback(database); } finally { database.close(); }
}

function createLegacyDemoDatabase(dbPath) {
  const database = new DatabaseSync(dbPath);
  try {
    database.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('guest','staff','dean')), name TEXT NOT NULL,
      phone TEXT DEFAULT '', avatar TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    const insert = database.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)');
    insert.run('guest_001', 'guest_demo', hashPassword('guest2026'), 'guest', '林海宁', '13800000001');
    insert.run('staff_001', 'staff_demo', hashPassword('staff2026'), 'staff', '王医生', '13800000002');
    insert.run('dean_001', 'dean_demo', hashPassword('dean2026'), 'dean', '周院长', '13800000003');
  } finally { database.close(); }
}

function addGuest(database, { id, username, name, status = 'active', room = '' }) {
  database.prepare('INSERT INTO users(id,username,password_hash,role,name,phone,status) VALUES(?,?,?,?,?,?,?)')
    .run(id, username, hashPassword('guest-password'), 'guest', name, '', status);
  database.prepare(`INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(id, '女', '', room, '', '', '', '[]', '[]', '');
}

test('legacy demo database upgrade seeds its assignment once and preserves revocation', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'haiyu-legacy-upgrade-'));
  const dbPath = path.join(tempDir, 'legacy.sqlite');
  let fixture;
  try {
    createLegacyDemoDatabase(dbPath);
    const assignmentTableBeforeUpgrade = mutateDatabase(dbPath, database => database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='staff_guest_assignments'").get());
    assert.equal(assignmentTableBeforeUpgrade, undefined);

    fixture = await startApi(dbPath);
    const staffToken = await login(fixture.base, 'staff');
    const guest = await request(fixture.base, '/staff/guests/guest_001', { token: staffToken });
    assert.equal(guest.status, 200);
    let count = mutateDatabase(dbPath, database => database.prepare("SELECT COUNT(*) AS count FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'").get().count);
    assert.equal(count, 1);

    mutateDatabase(dbPath, database => database.prepare("DELETE FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'").run());
    await stopApi(fixture);
    fixture = await startApi(dbPath);
    const restartedStaff = await login(fixture.base, 'staff');
    const revokedGuest = await request(fixture.base, '/staff/guests/guest_001', { token: restartedStaff });
    assert.equal(revokedGuest.status, 403);
    assert.equal(revokedGuest.data.code, 'GUEST_NOT_ASSIGNED');
    count = mutateDatabase(dbPath, database => database.prepare("SELECT COUNT(*) AS count FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'").get().count);
    assert.equal(count, 0);
  } finally {
    await stopApi(fixture);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('legacy health intake rows gain pending status during database migration', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'haiyu-health-intake-upgrade-'));
  const dbPath = path.join(tempDir, 'legacy-intakes.sqlite');
  let fixture;
  try {
    mutateDatabase(dbPath, database => {
      database.exec(`CREATE TABLE health_intakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL, content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'assistant', created_at TEXT NOT NULL
      )`);
      database.prepare('INSERT INTO health_intakes(guest_id,content,source,created_at) VALUES(?,?,?,?)')
        .run('guest_001', 'legacy intake marker', 'assistant', '2026-09-20T00:00:00.000Z');
    });

    fixture = await startApi(dbPath);
    const intake = mutateDatabase(dbPath, database => database.prepare('SELECT guest_id,content,status FROM health_intakes').get());
    assert.deepEqual({ ...intake }, { guest_id: 'guest_001', content: 'legacy intake marker', status: 'pending' });
  } finally {
    await stopApi(fixture);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('API enforces role/resource boundaries, assignment lifecycle, profile validation and session ownership', async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'haiyu-api-'));
  const dbPath = path.join(tempDir, 'integration.sqlite');
  let fixture;
  try {
    fixture = await startApi(dbPath);
    const guestToken = await login(fixture.base, 'guest');
    const staffToken = await login(fixture.base, 'staff');
    const deanToken = await login(fixture.base, 'dean');
    const invalidLogin = await request(fixture.base, '/auth/login', {
      method: 'POST', body: { username: 'guest_demo', password: { not: 'text' }, role: 'guest' }
    });
    assert.equal(invalidLogin.status, 401);
    assert.equal(invalidLogin.data.code, 'AUTH_INVALID_CREDENTIALS');

    await t.test('new seed is usable and each role sees the correct scope', async () => {
      const staffMe = await request(fixture.base, '/me', { token: staffToken });
      assert.equal(staffMe.status, 200);
      assert.equal(staffMe.data.assignedCount, 1);
      const guestMe = await request(fixture.base, '/me', { token: guestToken });
      assert.equal(guestMe.status, 200);
      assert.equal(guestMe.data.id, 'guest_001');
      const deanMe = await request(fixture.base, '/me', { token: deanToken });
      assert.equal(deanMe.status, 200);
      assert.equal(deanMe.data.assignedCount, 1);
      const rows = mutateDatabase(dbPath, database => database.prepare('SELECT staff_id,guest_id,status FROM staff_guest_assignments').all());
      assert.deepEqual(rows.map(row => ({ ...row })), [{ staff_id: 'staff_001', guest_id: 'guest_001', status: 'active' }]);
    });

    mutateDatabase(dbPath, database => {
      addGuest(database, { id: 'guest_002', username: 'guest_two', name: '未分配客人', room: 'B-101' });
      addGuest(database, { id: 'guest_003', username: 'guest_three', name: '停用客人', status: 'disabled', room: 'B-102' });
      database.prepare('INSERT INTO users(id,username,password_hash,role,name,phone,status) VALUES(?,?,?,?,?,?,?)')
        .run('staff_002', 'staff_two', hashPassword('staff-password'), 'staff', '另一位工作人员', '', 'active');
      database.prepare('INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?)')
        .run('staff_002', 'secret.audit', 'guest', 'guest_001', 'other staff private audit', new Date().toISOString());
    });

    await t.test('staff resources are assignment-scoped and dean retains hospital scope', async () => {
      const list = await request(fixture.base, '/staff/guests', { token: staffToken });
      assert.equal(list.status, 200);
      assert.deepEqual(list.data.map(row => row.id), ['guest_001']);
      const cross = await request(fixture.base, '/staff/guests/guest_002', { token: staffToken });
      assert.equal(cross.status, 403);
      assert.equal(cross.data.code, 'GUEST_NOT_ASSIGNED');
      const crossHealth = await request(fixture.base, '/me/health?guestId=guest_002', { token: staffToken });
      assert.equal(crossHealth.status, 403);
      assert.equal(crossHealth.data.code, 'GUEST_NOT_ASSIGNED');
      const crossAdvice = await request(fixture.base, '/me/advice?guestId=guest_002', { token: staffToken });
      assert.equal(crossAdvice.status, 403);
      assert.equal(crossAdvice.data.code, 'GUEST_NOT_ASSIGNED');
      const crossAgent = await request(fixture.base, '/agent/status?guestId=guest_002', { token: staffToken });
      assert.equal(crossAgent.status, 403);
      assert.equal(crossAgent.data.code, 'GUEST_NOT_ASSIGNED');
      const deanList = await request(fixture.base, '/staff/guests', { token: deanToken });
      assert.equal(deanList.status, 200);
      assert.deepEqual(deanList.data.map(row => row.id), ['guest_002', 'guest_001']);
      const deanHealth = await request(fixture.base, '/me/health?guestId=guest_002', { token: deanToken });
      assert.equal(deanHealth.status, 200);
      const disabled = await request(fixture.base, '/staff/guests/guest_003', { token: deanToken });
      assert.equal(disabled.status, 403);
      assert.equal(disabled.data.code, 'GUEST_INACTIVE');
      const missing = await request(fixture.base, '/staff/guests/no-such-guest', { token: deanToken });
      assert.equal(missing.status, 404);
      assert.equal(missing.data.code, 'GUEST_NOT_FOUND');
      const overview = await request(fixture.base, '/staff/overview', { token: staffToken });
      assert.equal(overview.status, 200);
      assert.equal(overview.data.guests, 1);
      assert.equal(overview.data.recent.some(row => row.detail === 'other staff private audit'), false);
    });

    await t.test('profile patch is allowlisted, fully validated and atomic', async () => {
      const before = await request(fixture.base, '/me', { token: guestToken });
      const forbidden = await request(fixture.base, '/me/profile', {
        method: 'PATCH', token: guestToken, body: { name: '不应写入', phone: '13900000000' }
      });
      assert.equal(forbidden.status, 400);
      assert.equal(forbidden.data.code, 'PROFILE_FIELD_NOT_ALLOWED');
      const afterForbidden = await request(fixture.base, '/me', { token: guestToken });
      assert.equal(afterForbidden.data.phone, before.data.phone);
      const invalid = await request(fixture.base, '/me/profile', {
        method: 'PATCH', token: guestToken, body: { phone: { value: 'bad' }, mobility: '不应部分写入' }
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.data.code, 'PROFILE_FIELD_INVALID');
      const afterInvalid = await request(fixture.base, '/me', { token: guestToken });
      assert.equal(afterInvalid.data.profile.mobility, before.data.profile.mobility);
      const updated = await request(fixture.base, '/me/profile', {
        method: 'PATCH', token: guestToken, body: { phone: '13900000000', emergencyContact: '林先生 13900000002', mobility: '需陪同' }
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.data.phone, '13900000000');
      assert.equal(updated.data.profile.emergency_contact, '林先生 13900000002');
      assert.equal(updated.data.profile.mobility, '需陪同');
      const auditCount = mutateDatabase(dbPath, database => database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id='guest_001' AND action='profile.update'").get().count);
      assert.equal(auditCount, 1);
    });

    await t.test('session IDs are server-generated, owner-bound and guest-context-bound', async () => {
      const publicChat = await request(fixture.base, '/assistant/chat', {
        method: 'POST', body: { role: 'public', text: '你好' }
      });
      assert.equal(publicChat.status, 200);
      assert.match(publicChat.data.sessionId, /^as_[0-9a-f-]{36}$/);
      const publicReplay = await request(fixture.base, '/assistant/chat', {
        method: 'POST', body: { role: 'public', text: '继续', sessionId: publicChat.data.sessionId }
      });
      assert.equal(publicReplay.status, 200);
      const guestChat = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: guestToken, body: { role: 'guest', text: '最近睡眠不好' }
      });
      assert.equal(guestChat.status, 200);
      const publicReadsGuest = await request(fixture.base, '/assistant/history?sessionId=' + encodeURIComponent(guestChat.data.sessionId));
      assert.equal(publicReadsGuest.status, 403);
      assert.equal(publicReadsGuest.data.code, 'ASSISTANT_SESSION_FORBIDDEN');
      const guestReadsPublic = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: guestToken, body: { role: 'guest', text: '不应读取公开历史', sessionId: publicChat.data.sessionId }
      });
      assert.equal(guestReadsPublic.status, 403);
      assert.equal(guestReadsPublic.data.code, 'ASSISTANT_SESSION_FORBIDDEN');
      const unknown = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: guestToken,
        body: { role: 'guest', text: '未知会话', sessionId: 'as_00000000-0000-0000-0000-000000000000' }
      });
      assert.equal(unknown.status, 404);
      assert.equal(unknown.data.code, 'ASSISTANT_SESSION_NOT_FOUND');
      const malformed = await request(fixture.base, '/assistant/chat', {
        method: 'POST', body: { role: 'public', text: '不创建客户端指定会话', sessionId: 'client-chosen-id' }
      });
      assert.equal(malformed.status, 404);
      assert.equal(malformed.data.code, 'ASSISTANT_SESSION_NOT_FOUND');
      const roleMismatch = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: staffToken, body: { role: 'guest', text: '角色伪造' }
      });
      assert.equal(roleMismatch.status, 403);
      assert.equal(roleMismatch.data.code, 'ASSISTANT_ROLE_FORBIDDEN');
      const guestContextSpoof = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: guestToken, body: { role: 'guest', text: '跨客人上下文', guestId: 'guest_002' }
      });
      assert.equal(guestContextSpoof.status, 403);
      assert.equal(guestContextSpoof.data.code, 'GUEST_FORBIDDEN');
      const legacyId = 'as_11111111-1111-1111-1111-111111111111';
      mutateDatabase(dbPath, database => database.prepare('INSERT INTO assistant_messages(session_id,user_id,role,content,created_at) VALUES(?,?,?,?,?)')
        .run(legacyId, 'guest_001', 'user', 'legacy private message', new Date().toISOString()));
      const legacy = await request(fixture.base, '/assistant/history?sessionId=' + legacyId, { token: guestToken });
      assert.equal(legacy.status, 404);
      assert.equal(legacy.data.code, 'ASSISTANT_SESSION_NOT_FOUND');

      const guestTwoAssignment = new Date(Date.now() - 1_000).toISOString();
      const guestTwoEnd = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      mutateDatabase(dbPath, database => database.prepare(`INSERT INTO staff_guest_assignments
        (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run('staff_001', 'guest_002', guestTwoAssignment, guestTwoEnd, 'active', 'dean_001', guestTwoAssignment, guestTwoAssignment));
      const staffGuestChat = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: staffToken, body: { role: 'staff', guestId: 'guest_001', text: '查看一号客人' }
      });
      assert.equal(staffGuestChat.status, 200);
      const switchedGuest = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: staffToken, body: { role: 'staff', guestId: 'guest_002', text: '切换客人', sessionId: staffGuestChat.data.sessionId }
      });
      assert.equal(switchedGuest.status, 409);
      assert.equal(switchedGuest.data.code, 'ASSISTANT_GUEST_CONTEXT_MISMATCH');
      const closedChat = await request(fixture.base, '/assistant/chat', {
        method: 'POST', body: { role: 'public', text: '待关闭会话' }
      });
      assert.equal(closedChat.status, 200);
      mutateDatabase(dbPath, database => database.prepare("UPDATE assistant_sessions SET status='closed' WHERE id=?").run(closedChat.data.sessionId));
      const closedSession = await request(fixture.base, '/assistant/chat', {
        method: 'POST', body: { role: 'public', text: '访问关闭会话', sessionId: closedChat.data.sessionId }
      });
      assert.equal(closedSession.status, 409);
      assert.equal(closedSession.data.code, 'ASSISTANT_SESSION_INACTIVE');
      const expiredChat = await request(fixture.base, '/assistant/chat', {
        method: 'POST', body: { role: 'public', text: '待过期会话' }
      });
      assert.equal(expiredChat.status, 200);
      mutateDatabase(dbPath, database => database.prepare('UPDATE assistant_sessions SET expires_at=? WHERE id=?')
        .run(new Date(Date.now() - 1_000).toISOString(), expiredChat.data.sessionId));
      const expiredSession = await request(fixture.base, '/assistant/chat', {
        method: 'POST', body: { role: 'public', text: '访问过期会话', sessionId: expiredChat.data.sessionId }
      });
      assert.equal(expiredSession.status, 409);
      assert.equal(expiredSession.data.code, 'ASSISTANT_SESSION_INACTIVE');
      const intakeCount = mutateDatabase(dbPath, database => database.prepare("SELECT COUNT(*) AS count FROM health_intakes WHERE guest_id='guest_001'").get().count);
      assert.equal(intakeCount, 1);
    });

    await t.test('assignment start/end/status are enforced and survive restart without auto-revival', async () => {
      const futureStart = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const futureEnd = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
      mutateDatabase(dbPath, database => database.prepare('UPDATE staff_guest_assignments SET start_at=?,end_at=? WHERE staff_id=? AND guest_id=?')
        .run(futureStart, futureEnd, 'staff_001', 'guest_002'));
      const beforeStart = await request(fixture.base, '/staff/guests/guest_002', { token: staffToken });
      assert.equal(beforeStart.status, 403);
      assert.equal(beforeStart.data.code, 'GUEST_NOT_ASSIGNED');
      mutateDatabase(dbPath, database => database.prepare('UPDATE staff_guest_assignments SET start_at=?,end_at=? WHERE staff_id=? AND guest_id=?')
        .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), futureEnd, 'staff_001', 'guest_002'));
      const active = await request(fixture.base, '/staff/guests/guest_002', { token: staffToken });
      assert.equal(active.status, 200);
      mutateDatabase(dbPath, database => database.prepare("UPDATE staff_guest_assignments SET status='closed',updated_at=? WHERE staff_id=? AND guest_id=?")
        .run(new Date().toISOString(), 'staff_001', 'guest_002'));
      const closed = await request(fixture.base, '/staff/guests/guest_002', { token: staffToken });
      assert.equal(closed.status, 403);
      assert.equal(closed.data.code, 'GUEST_NOT_ASSIGNED');
      const genericStaffChat = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: staffToken, body: { role: 'staff', text: '记录一般工作事项' }
      });
      assert.equal(genericStaffChat.status, 200);
      await stopApi(fixture);
      fixture = await startApi(dbPath);
      const restartedStaff = await login(fixture.base, 'staff');
      const persistedProfile = await request(fixture.base, '/me', { token: guestToken });
      assert.equal(persistedProfile.status, 200);
      assert.equal(persistedProfile.data.phone, '13900000000');
      const persistedSession = await request(fixture.base, '/assistant/chat', {
        method: 'POST', token: restartedStaff, body: { role: 'staff', text: '重启后继续', sessionId: genericStaffChat.data.sessionId }
      });
      assert.equal(persistedSession.status, 200);
      const staffMeAfterRestart = await request(fixture.base, '/me', { token: restartedStaff });
      assert.equal(staffMeAfterRestart.data.assignedCount, 1);
      const rows = mutateDatabase(dbPath, database => database.prepare("SELECT status FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_002'").all());
      assert.deepEqual(rows.map(row => ({ ...row })), [{ status: 'closed' }]);
      const revokedStart = new Date(Date.now() - 2_000).toISOString();
      const revokedEnd = new Date(Date.now() - 1_000).toISOString();
      mutateDatabase(dbPath, database => database.prepare('UPDATE staff_guest_assignments SET start_at=?,end_at=?,updated_at=? WHERE staff_id=? AND guest_id=?')
        .run(revokedStart, revokedEnd, new Date().toISOString(), 'staff_001', 'guest_001'));
      await stopApi(fixture);
      fixture = await startApi(dbPath);
      const afterRevokedRestart = await login(fixture.base, 'staff');
      const revoked = await request(fixture.base, '/staff/guests/guest_001', { token: afterRevokedRestart });
      assert.equal(revoked.status, 403);
      assert.equal(revoked.data.code, 'GUEST_NOT_ASSIGNED');
      const assignments = mutateDatabase(dbPath, database => database.prepare("SELECT COUNT(*) AS count FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'").get().count);
      assert.equal(assignments, 1);
    });

    await t.test('deleting the demo assignment stays revoked after a fresh process restart', async () => {
      mutateDatabase(dbPath, database => database.prepare("DELETE FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'").run());
      await stopApi(fixture);
      fixture = await startApi(dbPath);

      const restartedStaff = await login(fixture.base, 'staff');
      const revokedGuest = await request(fixture.base, '/staff/guests/guest_001', { token: restartedStaff });
      assert.equal(revokedGuest.status, 403);
      assert.equal(revokedGuest.data.code, 'GUEST_NOT_ASSIGNED');
      const staffMe = await request(fixture.base, '/me', { token: restartedStaff });
      assert.equal(staffMe.data.assignedCount, 0);
      const assignments = mutateDatabase(dbPath, database => database.prepare("SELECT COUNT(*) AS count FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'").get().count);
      assert.equal(assignments, 0);
    });
  } finally {
    await stopApi(fixture);
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('model timeout falls back safely using only a local stub', async () => {
  const stub = createServer((req, res) => {
    req.resume();
    setTimeout(() => {
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'late response' } }] }));
      }
    }, 250);
  });
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = stub.address().port;
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'haiyu-timeout-'));
  const dbPath = path.join(tempDir, 'timeout.sqlite');
  let fixture;
  try {
    fixture = await startApi(dbPath, {
      LLM_BASE_URL: `http://127.0.0.1:${stubPort}/v1`,
      LLM_API_KEY: 'local-stub-key',
      LLM_TIMEOUT_MS: '50'
    });
    const guestToken = await login(fixture.base, 'guest');
    const status = await request(fixture.base, '/assistant/status');
    assert.equal(status.data.live, true);
    assert.equal(status.data.timeoutMs, 50);
    const started = Date.now();
    const result = await request(fixture.base, '/assistant/chat', {
      method: 'POST', token: guestToken, body: { role: 'guest', text: '睡眠不好' }
    });
    const elapsed = Date.now() - started;
    assert.equal(result.status, 200);
    assert.equal(result.data.live, false);
    assert.equal(result.data.mode, '安全引导模式');
    assert.ok(elapsed < 220, `timeout took ${elapsed}ms`);
  } finally {
    await stopApi(fixture);
    await new Promise(resolve => stub.close(resolve));
    await rm(tempDir, { recursive: true, force: true });
  }
});
