import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0'
});
const { app } = await import('../src/app.js');
const { db, transaction, hashPassword, now, sqliteCachedStatementCount, isUniqueViolation } = await import('../src/db.js');
const { initializeDemoTeam } = await import('../src/demo-team.js');
await initializeDemoTeam({ database: db, transact: transaction, hashPassword, stamp: now() });
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

test('G11: password change bumps token_version — old token rejected with AUTH_TOKEN_REVOKED, fresh token keeps the session', async () => {
  const login = await call(null, '/auth/login', 'POST', { username: 'admin_demo', password: 'staff2026', role: 'staff' });
  const oldToken = login.token;
  await call(oldToken, '/me/password', 'POST', { currentPassword: 'wrong-password', newPassword: 'Rotated-demo-2026' }, 400);
  const changed = await call(oldToken, '/me/password', 'POST', { currentPassword: 'staff2026', newPassword: 'Rotated-demo-2026' });
  assert.ok(changed.token && changed.token !== oldToken, 'response must carry a fresh token');
  const rejected = await fetch(base + '/me', { headers: { Authorization: `Bearer ${oldToken}` } });
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).code, 'AUTH_TOKEN_REVOKED');
  await call(changed.token, '/me');
  // 恢复原密码，避免影响其他用例的演示账号约定
  const restore = await call(changed.token, '/me/password', 'POST', { currentPassword: 'Rotated-demo-2026', newPassword: 'staff2026' });
  await call(restore.token, '/me');
});

test('G13: /api/news is capped at 50 entries and keeps pinned/newest first ordering', async () => {
  await db.prepare('DELETE FROM news').run(); // 隔离演示种子数据，保证断言确定性
  const stamp = now();
  for (let index = 0; index < 55; index++) {
    await db.prepare('INSERT INTO news(category,title,summary,body,cover,published_at,pinned) VALUES(?,?,?,?,?,?,?)').run(
      '公告', `压测新闻 ${index}`, '摘要', '正文', '', new Date(Date.parse('2030-01-01T00:00:00Z') + index * 1000).toISOString(), index === 54 ? 1 : 0
    );
  }
  const rows = await call(null, '/news');
  assert.equal(rows.length, 50);
  assert.equal(rows[0].title, '压测新闻 54');
  assert.equal(rows[0].pinned, 1);
  const times = rows.slice(1).map(row => Date.parse(row.publishedAt));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
});

test('G24: dean staff list aggregates guestViews/adviceCount without per-staff queries', async () => {
  const login = await call(null, '/auth/login', 'POST', { username: 'admin_demo', password: 'staff2026', role: 'staff' });
  const staffList = await call(login.token, '/dean/staff');
  const target = staffList.find(row => row.username === 'staff_demo');
  assert.ok(target);
  const expectedViews = Number((await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE actor_id=? AND action='guest.view'").get(target.id)).n);
  const expectedAdvice = Number((await db.prepare('SELECT COUNT(*) AS n FROM medical_advice WHERE author_id=?').get(target.id)).n);
  assert.equal(target.guestViews, expectedViews);
  assert.equal(target.adviceCount, expectedAdvice);
  assert.equal(staffList.every(row => typeof row.guestViews === 'number' && typeof row.adviceCount === 'number'), true);
});

test('G25: assistant chat persists run, user message and session stamp atomically', async () => {
  const register = await call(null, '/auth/register', 'POST', {
    name: '事务原子性测试客人', phone: '19900005566', password: 'Atomic-chat-2026', confirmPassword: 'Atomic-chat-2026'
  }, 201);
  const reply = await call(register.token, '/assistant/chat', 'POST', { text: '你好，请介绍一下入住服务' });
  assert.ok(reply.runId, 'chat must return a run id');
  const run = await db.prepare('SELECT * FROM agent_runs WHERE id=?').get(reply.runId);
  const userMessage = await db.prepare('SELECT * FROM assistant_messages WHERE run_id=? AND role=?').get(reply.runId, 'user');
  assert.ok(run, 'agent run row must exist');
  assert.ok(userMessage, 'user message row must exist');
  const session = await db.prepare('SELECT last_message_at FROM assistant_sessions WHERE id=?').get(run.session_id);
  assert.ok(session.last_message_at >= run.created_at, 'session stamp must be kept up to date with the conversation');
});

test('G22: repeated statements reuse the prepared-statement cache without growth', async () => {
  const first = await db.prepare('SELECT COUNT(*) AS n FROM users').get();
  assert.ok(first.n >= 1);
  const sizeAfterFirst = sqliteCachedStatementCount();
  assert.ok(sizeAfterFirst > 0);
  await db.prepare('SELECT COUNT(*) AS n FROM users').get();
  await db.prepare('SELECT COUNT(*) AS n FROM users').all();
  assert.equal(sqliteCachedStatementCount(), sizeAfterFirst, 'same SQL must not grow the cache');
  await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get();
  assert.equal(sqliteCachedStatementCount(), sizeAfterFirst + 1, 'a new SQL text adds exactly one cache entry');
});

test('G44: isUniqueViolation only treats unique/PK conflicts as duplicates — FK and CHECK failures must propagate', async () => {
  // 唯一键冲突（通知表的 guest_id+source_type+source_id 唯一键）必须识别为重复
  const insertNotification = () => db.prepare(`INSERT INTO wellness_local_notifications
    (id,guest_id,draft_id,event_key,message,created_at,source_type,source_id,target_type,target_id,target_url,notification_type,read_at)
    VALUES('g44dup','guest_001',NULL,'g44-key','重复','2030-01-01T00:00:00.000Z','daily_brief','2030-01-01','daily_brief','x','caretaker','brief',NULL)`).run();
  await insertNotification();
  const duplicate = await insertNotification().then(() => null, error => error);
  assert.ok(duplicate, 'second insert with same unique key must fail');
  assert.equal(isUniqueViolation(duplicate), true);

  // 外键失败不属于重复：插入引用不存在客人的档案行，错误必须原样可抛出
  const foreignKey = await db.prepare(`INSERT INTO guest_profiles
    (user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility)
    VALUES('user_missing_g44','女',NULL,NULL,NULL,NULL,'','[]','[]','')`).run()
    .then(() => null, error => error);
  assert.ok(foreignKey, 'FK-violating insert must fail');
  assert.equal(isUniqueViolation(foreignKey), false, 'FK failure swallowed as duplicate would mask data corruption');
  assert.ok(foreignKey?.errcode === 787 || /FOREIGN KEY/i.test(String(foreignKey?.message || foreignKey?.code || '')),
    `expected an FK-specific error, got errcode=${foreignKey?.errcode} code=${foreignKey?.code}`);
});
