import test from 'node:test';
import assert from 'node:assert/strict';
process.env.BUSINESS_CLOCK_NOW = '2026-10-13T02:00:00.000Z';
Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0'
});
const { db, transaction, hashPassword, now } = await import('../src/db.js');
const { app } = await import('../src/app.js');
const { initializeDemoTeam } = await import('../src/demo-team.js');
const { recordProviderFailure, recordProviderSuccess } = await import('../src/operations.js');
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
const coach = (await call(null, '/auth/login', 'POST', { username: 'coach_demo', password: 'staff2026', role: 'staff' })).token;

test('运营工作台列表：客人/时段/预约视图返回授权数据结构', async () => {
  const guests = await call(administrator, '/admin/operations/guests');
  assert.ok(Array.isArray(guests.items), '客人视图应返回 items');
  const slots = await call(administrator, '/admin/operations/slots?days=7');
  const slotItems = Array.isArray(slots) ? slots : slots.items;
  assert.ok(Array.isArray(slotItems) && slotItems.length > 0, '七天时段容量应有数据');
  assert.ok('remaining' in (slotItems[0] || {}) || 'booked' in (slotItems[0] || {}), '时段应含余量字段');
  const reservations = await call(administrator, '/admin/operations/reservations');
  assert.ok(Array.isArray((Array.isArray(reservations) ? reservations : reservations.items) || []));
  await call(coach, '/admin/operations/guests', 'GET', undefined, 403);
});

test('运营事故：连续失败开单后可关闭，列表状态一致', async () => {
  for (let i = 0; i < 3; i += 1) {
    const result = await recordProviderFailure({ supplier: 'probe-supplier', feature: 'probe.feature', errorCode: 'PROBE_DOWN', impact: '演示：探针供应商连续失败。' });
    var thresholdReached = result.incidentCreated;
  }
  assert.equal(thresholdReached, true, '达到阈值应创建未关闭运营事项');
  const open = await call(administrator, '/admin/operations/incidents');
  const openRows = Array.isArray(open) ? open : open.items;
  const row = openRows.find(item => item.supplier === 'probe-supplier' && item.feature === 'probe.feature');
  assert.ok(row, '未关闭事项应出现在列表');
  assert.equal(row.status, 'open');
  assert.equal((await call(administrator, '/admin/operations/incidents/close', 'POST', { supplier: 'probe-supplier', feature: 'probe.feature' }, 409)).code, 'OPERATIONS_INCIDENT_NOT_RECOVERED', '未恢复不得关闭');
  await recordProviderSuccess({ supplier: 'probe-supplier', feature: 'probe.feature' });
  const closed = await call(administrator, '/admin/operations/incidents/close', 'POST', { supplier: 'probe-supplier', feature: 'probe.feature' });
  assert.equal(closed.status || closed.incident?.status, 'closed');
  assert.equal((await call(administrator, '/admin/operations/incidents/close', 'POST', { supplier: 'probe-supplier' }, 400)).code, 'OPERATIONS_INCIDENT_INPUT_INVALID');
  const after = await call(administrator, '/admin/operations/incidents');
  const afterRows = Array.isArray(after) ? after : after.items;
  const closedRow = afterRows.find(item => item.supplier === 'probe-supplier' && item.feature === 'probe.feature');
  assert.ok(closedRow && closedRow.status === 'closed', '关闭后记录状态应为 closed');
});
