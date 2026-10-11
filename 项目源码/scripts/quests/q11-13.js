import { assert, assertOk, checkWebSource, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const first = await request(context.baseUrl, '/dean/guests/guest_001/assignments', {
      method: 'POST', token: dean, body: { staffId: 'staff_001' }
    });
    assert.equal(first.status, 409, 'the active demo assignment must prevent a duplicate');
    const history = assertOk(await request(context.baseUrl, '/dean/guests/guest_001/assignments', { token: dean }));
    const active = history.find(row => row.staffId === 'staff_001' && row.status === 'active');
    assert.ok(active);
    assert.ok(active.startAt);
    await request(context.baseUrl, `/dean/guests/guest_001/assignments/${active.id}`, { method: 'PATCH', token: dean, body: { status: 'closed' } });
    const restarted = assertOk(await request(context.baseUrl, '/dean/guests/guest_001/assignments', {
      method: 'POST', token: dean, body: { staffId: 'staff_001' }
    }), 201);
    assert.equal(restarted.status, 'active');
    const nextHistory = assertOk(await request(context.baseUrl, '/dean/guests/guest_001/assignments', { token: dean }));
    assert.ok(nextHistory.some(row => row.id === active.id && row.status === 'closed' && row.endAt));
    assert.equal(nextHistory.filter(row => row.staffId === 'staff_001' && row.status === 'active').length, 1);
  });
  await checkWebSource(['function AssignmentManagement(', '建立负责关系', '结束关系', '持续中', '已结束']);
  return { output: ['repeat assignment click returns 409 instead of making duplicate active relations', 'end and restart create a new interval while preserving the ended relationship in history'] };
}
