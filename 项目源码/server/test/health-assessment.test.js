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
const registered = await call(null, '/auth/register', 'POST', { name: '问卷客人', phone: '19900007704', password: 'Synthetic-only-123', confirmPassword: 'Synthetic-only-123' }, 201);
const guest = registered.token;
const guestId = registered.user.id;
await call(administrator, `/dean/guests/${guestId}/stay`, 'PATCH', { roomNo: 'B-204', checkIn: '2026-10-13', checkOut: '2026-10-16', stayPlan: 'three_night' });
const staffRows = await call(administrator, '/dean/staff');
const clinicianId = (Array.isArray(staffRows) ? staffRows : staffRows.items).find(item => item.jobType === 'clinician').id;
await call(administrator, `/dean/guests/${guestId}/assignments`, 'POST', { staffId: clinicianId }, 201);

test('健康问卷：进度读取、逐题作答版本递增、过期版本与非法输入拒绝', async () => {
  const progress = await call(guest, '/me/health-assessment');
  assert.ok('version' in progress, '问卷进度应包含版本号');

  const answered = await call(guest, '/me/health-assessment/answers', 'PUT', { field: 'chronic', answer: { status: 'reported', items: ['高血压（演示）'] }, baseVersion: progress.version });
  assert.equal(answered.version, Number(progress.version) + 1);
  const after = await call(guest, '/me/health-assessment');
  assert.equal(after.version, answered.version, '进度读取应反映最新版本');

  assert.equal((await call(guest, '/me/health-assessment/answers', 'PUT', { field: 'chronic', answer: { status: 'reported', items: ['高血脂（演示）'] }, baseVersion: 0 }, 409)).code, 'HEALTH_ASSESSMENT_STALE_VERSION');
  assert.equal((await call(guest, '/me/health-assessment/answers', 'PUT', { field: 'not_a_field', answer: { status: 'none' } }, 400)).code, 'HEALTH_ASSESSMENT_FIELD_INVALID');
  assert.equal((await call(guest, '/me/health-assessment/answers', 'PUT', { field: 'chronic', answer: { status: 'none' }, extra: 1 }, 400)).code, 'HEALTH_ASSESSMENT_INPUT_INVALID');
  assert.equal((await call(guest, '/me/health-assessment/answers', 'PUT', { field: 'chronic', answer: { status: 'unanswered' } }, 400)).code, 'HEALTH_ASSESSMENT_ANSWER_REQUIRED');
  await call(clinician, '/me/health-assessment', 'GET', undefined, 403);
});

test('自述提取：输入校验与列表读取', async () => {
  assert.equal((await call(guest, '/me/health-intake-extractions', 'POST', { utterance: '最近睡得不太好', extra: 1 }, 400)).code, 'HEALTH_EXTRACTION_INPUT_INVALID');
  const list = await call(guest, '/me/health-intake-extractions');
  assert.ok(Array.isArray(list.items));
  await call(guest, '/me/health-intake-extractions/ext_none/confirm', 'POST', { decisions: [] }, 404);
});

test('医护核实驳回：原因必填、驳回后队列状态流转且留痕', async () => {
  const none = { status: 'none', items: [] };
  const submitted = await call(guest, '/me/health-intakes', 'POST', { baseProfileVersion: 0, profile: { chronic: none, allergies: { status: 'reported', items: ['尘螨（演示）'] }, dietaryRestrictions: none, skin: { status: 'reported', details: '皮肤完好' } } }, 201);
  const intakeId = submitted.pendingIntakes[0].id;

  assert.equal((await call(clinician, `/staff/health-intakes/${intakeId}/reject`, 'POST', { reason: '' }, 400)).code, 'HEALTH_REVIEW_REASON_REQUIRED');
  assert.equal((await call(clinician, `/staff/health-intakes/${intakeId}/reject`, 'POST', { reason: '描述与档案不一致（演示驳回）', extra: 1 }, 400)).code, 'HEALTH_REVIEW_FIELD_NOT_ALLOWED');
  await call(coach, `/staff/health-intakes/${intakeId}/reject`, 'POST', { reason: '教练无权核实' }, 403);

  const rejected = await call(clinician, `/staff/health-intakes/${intakeId}/reject`, 'POST', { reason: '描述与档案不一致（演示驳回）' });
  assert.ok(rejected.intake || rejected.review || rejected.status, '驳回结果应返回处理对象');
  const queue = await call(clinician, `/staff/guests/${guestId}/health-intakes`);
  const row = [...(queue.pendingIntakes || []), ...(queue.history || [])].find(item => item.id === intakeId);
  assert.ok(row, '医护应能查看该客人的采集记录');
  assert.equal(queue.pendingIntakes?.length || 0, 0, '驳回后不得残留在待核实队列');
});
