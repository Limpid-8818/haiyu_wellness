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
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });

async function call(token, route, method = 'GET', body, expected = 200, idempotencyKey) {
  const response = await fetch(base + route, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
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

const registered = await call(null, '/auth/register', 'POST', { name: '复核尾部客人', phone: '19900007705', password: 'Synthetic-only-123', confirmPassword: 'Synthetic-only-123' }, 201);
const guest = registered.token;
const guestId = registered.user.id;
await call(administrator, `/dean/guests/${guestId}/stay`, 'PATCH', { roomNo: 'B-205', checkIn: '2026-10-13', checkOut: '2026-10-16', stayPlan: 'three_night' });
const staffRows = await call(administrator, '/dean/staff');
const clinicianId = (Array.isArray(staffRows) ? staffRows : staffRows.items).find(item => item.jobType === 'clinician').id;
await call(administrator, `/dean/guests/${guestId}/assignments`, 'POST', { staffId: clinicianId }, 201);

// 复核尾部用例的草案前置：与 demo-mock-data 相同的隔离 SQL 夹具（目录级前置，不伪造审批事件）。
// 复核按版本链最新版操作，草案按真实生命周期逐版本插入。
const threadId = 'wellness_thread_review_tails';
const evidence = JSON.stringify({ fixture: 'review-tails', parentRunId: 'review-tails-parent', environmentSnapshots: {} });
function insertDraft(id, version, status, supersedes) {
  return db.prepare(`INSERT INTO wellness_drafts(id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,evidence_json,created_at,review_status,review_thread_id,supersedes_draft_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,?,?,NULL,'2026-10-13','2026-10-16',?,'sampled_review',100,?,?,?,?,?,NULL,NULL,NULL)`)
    .run(id, guestId, version, `tail-${id}`, status, evidence, now(), status, threadId, supersedes || null);
}
async function insertItem(id, draftId, type, slotKey, title) {
  await db.prepare(`INSERT INTO wellness_draft_items(id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
    VALUES(?,?,?,?,?,?,?,'19:00','20:00','proposed','复核尾部夹具条目',NULL,'[]','[]',NULL,'{}')`)
    .run(id, draftId, '2026-10-13', slotKey, type, null, title);
}

test('退回：链上最新待审版本可退回、幂等重放、重复退回拒绝', async () => {
  insertDraft('draft_tail_1', 1, 'pending_review');
  await insertItem('item_tail_1', 'draft_tail_1', 'rest', 'evening', '晚间静养（退回夹具）');
  const returned = await call(clinician, '/staff/therapy-drafts/draft_tail_1/return', 'POST', { version: 1, reason: '首版条目证据不足（演示退回）' }, 200, 'tail-return-01');
  assert.equal(returned.replayed, false);
  const replay = await call(clinician, '/staff/therapy-drafts/draft_tail_1/return', 'POST', { version: 1, reason: '首版条目证据不足（演示退回）' }, 200, 'tail-return-01');
  assert.equal(replay.replayed, true);
  assert.equal((await call(clinician, '/staff/therapy-drafts/draft_tail_1/return', 'POST', { version: 1, reason: '再次退回' }, 409, 'tail-return-02')).code, 'WELLNESS_REVIEW_STATE');
  assert.equal((await call(clinician, '/staff/therapy-drafts/draft_tail_1/return', 'POST', { version: 1, reason: '' }, 400)).code, 'WELLNESS_REASON_REQUIRED');
  await call(coach, '/staff/therapy-drafts/draft_tail_1/return', 'POST', { version: 1, reason: '教练无权复核' }, 403);
});

test('复核历史：医护与管理员可查，动作过滤与权限边界正确', async () => {
  insertDraft('draft_tail_2', 2, 'pending_review', 'draft_tail_1');
  await insertItem('item_tail_2', 'draft_tail_2', 'rest', 'evening', '晚间静养（二版夹具）');
  await call(clinician, '/staff/therapy-drafts/draft_tail_2/return', 'POST', { version: 2, reason: '第二版仍需补充（演示退回）' }, 200, 'tail-return-03');

  const history = await call(clinician, '/staff/therapy-review-history');
  const rows = Array.isArray(history) ? history : history.items;
  assert.equal(rows.filter(item => item.action === 'returned' && item.guestId === guestId).length, 2, '两次退回应留痕');
  const filtered = await call(clinician, '/staff/therapy-review-history?action=returned');
  const filteredRows = (Array.isArray(filtered) ? filtered : filtered.items).filter(item => item.guestId === guestId);
  assert.ok(filteredRows.length >= 2 && filteredRows.every(item => item.action === 'returned'), '动作过滤应只含退回');
  assert.equal((await call(clinician, '/staff/therapy-review-history?from=2026-13-01', 'GET', undefined, 400)).code, 'WELLNESS_HISTORY_DATE_INVALID');
  await call(coach, '/staff/therapy-review-history', 'GET', undefined, 403);
  await call(administrator, '/staff/therapy-review-history');
});

test('连续退回触发管理员关注；站内通知可标记已读', async () => {
  insertDraft('draft_tail_3', 3, 'pending_review', 'draft_tail_2');
  await insertItem('item_tail_3', 'draft_tail_3', 'rest', 'evening', '晚间静养（三版夹具）');
  const third = await call(clinician, '/staff/therapy-drafts/draft_tail_3/return', 'POST', { version: 3, reason: '同一链多次退回（演示）' }, 200, 'tail-return-04');
  assert.ok(third.attentionId, '同一版本链两次以上退回应创建管理员关注项');
  const attention = await call(administrator, '/staff/therapy-review-attention');
  const attentionRows = Array.isArray(attention) ? attention : attention.items;
  assert.ok(attentionRows.some(item => item.guest_id === guestId || item.guestId === guestId), '关注列表应包含该客人');
});

test('纠错：对生效版本的活动条目选择真实时段修订且幂等', async () => {
  const { prepareSyntheticIndoorExercise } = await import('../../scripts/bugfix-stage2/catalog-fixture.js');
  await prepareSyntheticIndoorExercise();
  const guestToken = guest;
  const slots = await call(guestToken, '/projects/stage2-indoor-exercise/slots?date=2026-10-13');
  const slot = slots.slots.find(item => item.bookable);
  assert.ok(slot, '需要合成室内项目时段');
  insertDraft('draft_tail_active', 4, 'active', 'draft_tail_3');
  await insertItem('item_tail_a4', 'draft_tail_active', 'activity', 'morning', '室内教练指导（纠正对象）');
  assert.equal((await call(clinician, '/staff/therapy-drafts/draft_tail_active/correction', 'POST', { version: 4, reason: '无编辑', edits: [] }, 400)).code, 'WELLNESS_REVISION_INVALID');

  const edits = [{ itemId: 'item_tail_a4', slotId: slot.id, reason: '调整到当日另一时段' }];
  const corrected = await call(clinician, '/staff/therapy-drafts/draft_tail_active/correction', 'POST', { version: 4, reason: '时段调整（演示纠错）', edits }, 200, 'tail-correct-01');
  assert.equal(corrected.replayed, false);
  assert.ok(Number(corrected.version) > 4, '纠错应生成更新版本');
  const replay = await call(clinician, '/staff/therapy-drafts/draft_tail_active/correction', 'POST', { version: 4, reason: '时段调整（演示纠错）', edits }, 200, 'tail-correct-01');
  assert.equal(replay.replayed, true);
  assert.equal(replay.version, corrected.version, '重放应指向同一条纠错版本');

  const notifications = await call(guest, '/me/wellness-notifications');
  const target = notifications.items[0];
  assert.ok(target, '纠错生效后客人应收到站内通知');
  const marked = await call(guest, `/me/wellness-notifications/${target.id}/read`, 'PATCH');
  assert.ok(marked.item && (marked.item.readAt || marked.item.read === true), '标记已读应返回已读条目');
  assert.equal(typeof marked.unreadCount, 'number', '应返回未读计数');
  await call(guest, `/me/wellness-notifications/${target.id}/read`, 'PATCH');
});

test('关怀任务列表：返回员工本人未结任务结构', async () => {
  const tasks = await call(clinician, '/staff/care-follow-up-tasks');
  assert.ok(Array.isArray(tasks.items));
  await call(guest, '/staff/care-follow-up-tasks', 'GET', undefined, 403);
});
