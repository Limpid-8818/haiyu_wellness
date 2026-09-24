import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withDatabase, addGuest, addAssignment, addAdvice, addUser } from './q5-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    addOverviewFixtures(databasePath);
    const staffToken = await login(baseUrl);
    const result = await request(baseUrl, '/staff/overview', { token: staffToken });
    assert.equal(result.status, 200);
    assert.equal(result.data.guests, 2, 'overview guest count must include only the two currently assigned active guests');
    assert.equal(result.data.activeAdvice, 2, 'active advice count must exclude the future-start guest');
    assert.ok(result.data.recent.some(entry => entry.detail === 'Q5.3 authorized staff log marker'));
    assert.equal(result.data.recent.some(entry => entry.detail === 'Q5.3 another staff private marker'), false);
    assert.equal(result.data.recent.some(entry => entry.detail === 'Q5.3 future guest marker'), false);

    return { output: [
      'GET /staff/overview HTTP 200',
      'authorizedGuests=2',
      'activeAdvice=2 (future assignment advice excluded)',
      'authorized staff scoped recent marker included=true',
      'another staff private marker excluded=true',
      'future guest audit marker excluded=true'
    ] };
  }, 'haiyu-quest-q5-3-');
}

function addOverviewFixtures(databasePath) {
  withDatabase(databasePath, database => {
    addGuest(database, { id: 'guest_q5_3_assigned', name: '总览负责客人', roomNo: 'Q5-301' });
    addAssignment(database, { guestId: 'guest_q5_3_assigned' });
    addAdvice(database, { guestId: 'guest_q5_3_assigned', title: 'Q5.3 assigned active advice' });

    addGuest(database, { id: 'guest_q5_3_future', name: '总览未来客人', roomNo: 'Q5-302' });
    addAssignment(database, { guestId: 'guest_q5_3_future', startAt: new Date(Date.now() + 3_600_000).toISOString() });
    addAdvice(database, { guestId: 'guest_q5_3_future', title: 'Q5.3 future active advice' });

    addUser(database, { id: 'staff_q5_3_other', username: 'staff_q5_3_other', role: 'staff', name: '其他工作人员' });
    const createdAt = new Date().toISOString();
    const addLog = database.prepare(`INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at)
      VALUES(?,?,?,?,?,?)`);
    addLog.run('staff_001', 'guest.view', 'guest', 'guest_q5_3_assigned', 'Q5.3 authorized staff log marker', createdAt);
    addLog.run('staff_q5_3_other', 'guest.view', 'guest', 'guest_q5_3_assigned', 'Q5.3 another staff private marker', createdAt);
    addLog.run('staff_001', 'guest.view', 'guest', 'guest_q5_3_future', 'Q5.3 future guest marker', createdAt);
  });
}
