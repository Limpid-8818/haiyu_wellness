// Synthetic fixture only. Do not use against a persistent or user database.
import assert from 'node:assert/strict';
import path from 'node:path';
assert.equal(process.env.DB_DRIVER, 'sqlite');
assert.ok(process.env.DB_PATH?.startsWith('/tmp/haiyu-resource-'));
assert.equal(process.env.DEMO_SEED, '0');
assert.equal(process.env.LLM_API_KEY, '');
const { app } = await import('../../server/src/app.js');
const { db, hashPassword, now } = await import('../../server/src/db.js');
const { systemBusinessClock } = await import('../../server/src/clock.js');
const date = systemBusinessClock.dateKey();
const last = new Date(`${date}T00:00:00Z`); last.setUTCDate(last.getUTCDate() + 3);
const users = [
  ['stage1_mixed', 'guest', '合成限制核对客人', null],
  ['stage1_order', 'guest', '合成订单恢复客人', null],
  ['stage1_clinician', 'staff', '合成负责医护', 'clinician'],
  ['stage1_dietitian', 'staff', '合成负责配餐员', 'dietitian']
];
for (const [id, role, name, job] of users) {
  await db.prepare(`INSERT INTO users(id,username,password_hash,role,name,phone,status,job_type,created_at)
    VALUES(?,?,?,?,?,'','active',?,?)`).run(id, id, hashPassword('Synthetic-stage1-only-123'), role, name, job, now());
  if (role === 'guest') await db.prepare(`INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,stay_plan,
    emergency_contact,chronic_json,allergies_json,mobility,updated_at) VALUES(?,'','',?,?,?,'three_night','','[]','[]','',?)`)
    .run(id, '合成房间', date, last.toISOString().slice(0, 10), now());
}
for (const guest of ['stage1_mixed', 'stage1_order']) for (const staff of ['stage1_clinician', 'stage1_dietitian']) {
  await db.prepare(`INSERT INTO staff_guest_assignments(staff_id,guest_id,start_at,status,created_by,created_at,updated_at)
    VALUES(?,?,'2020-01-01T00:00:00.000Z','active',?,?,?)`).run(staff, guest, 'stage1_clinician', now(), now());
}
const server = app.listen(Number(process.env.PORT), '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
const post = async (route, body, token) => {
  const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.ok(response.ok, `${route}: ${await response.clone().text()}`); return response.json();
};
const clinician = await post('/auth/login', { username: 'stage1_clinician', role: 'staff', password: 'Synthetic-stage1-only-123' });
const list = (...items) => ({ status: items.length ? 'reported' : 'none', items });
for (const [username, profile] of [
  ['stage1_mixed', { chronic: list('高血压'), allergies: list('海鲜', '空气'), dietaryRestrictions: list('鸡蛋', '海鲜') }],
  ['stage1_order', { allergies: list(), dietaryRestrictions: list() }]
]) {
  const guest = await post('/auth/login', { username, role: 'guest', password: 'Synthetic-stage1-only-123' });
  const intake = await post('/me/health-intakes', { profile, baseProfileVersion: 0 }, guest.token);
  await post(`/staff/health-intakes/${intake.pendingIntakes[0].id}/confirm`, { baseProfileVersion: 0 }, clinician.token);
}
console.log('STAGE1_READY ' + JSON.stringify({ date, database: path.basename(process.env.DB_PATH), users: users.map(user => user[0]) }));
let closing = false;
const shutdown = () => { if (closing) return; closing = true; server.close(async () => { await db.close(); process.exit(0); }); };
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
