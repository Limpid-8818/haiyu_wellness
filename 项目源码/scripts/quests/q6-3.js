import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { addAudit, addStaff, login, request, withDatabase } from './q6-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    addLogFixtures(databasePath);
    const deanToken = await login(baseUrl, 'dean_demo', 'dean2026', 'dean');
    const staffToken = await login(baseUrl, 'staff_demo', 'staff2026', 'staff');

    const allowed = await request(baseUrl, '/dean/staff/staff_001/logs', { token: deanToken });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.staff.id, 'staff_001');
    const latest = allowed.data.logs.findIndex(row => row.detail === 'Q6.3 latest timestamp marker');
    const earlier = allowed.data.logs.findIndex(row => row.detail === 'Q6.3 earlier timestamp marker');
    assert.ok(latest >= 0 && earlier >= 0, 'both operation types/timestamps should be included');
    assert.ok(latest < earlier, 'logs should be ordered by created_at, not insertion id');
    assert.equal(allowed.data.logs.find(row => row.detail === 'Q6.3 latest timestamp marker').action, 'advice.create');
    assert.equal(allowed.data.logs.find(row => row.detail === 'Q6.3 earlier timestamp marker').createdAt, '2020-01-01T00:00:00.000Z');
    assert.equal(allowed.data.logs.some(row => row.detail === 'Q6.3 other staff private marker'), false);

    const denied = await request(baseUrl, '/dean/staff/staff_001/logs', { token: staffToken });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, 'ROLE_FORBIDDEN');

    return { output: [
      'dean GET /dean/staff/staff_001/logs HTTP 200',
      'action=advice.create, operation timestamps returned and sorted newest first',
      'other employee marker excluded=true',
      'staff GET /dean/staff/staff_001/logs HTTP 403 ROLE_FORBIDDEN'
    ] };
  }, 'haiyu-quest-q6-3-');
}

function addLogFixtures(databasePath) {
  withDatabase(databasePath, database => {
    addStaff(database, { id: 'staff_q6_3_other', username: 'staff_q6_3_other', name: '另一工作人员' });
    // Insert the timestamp-newer row first so ordering by the auto-increment ID would fail this assertion.
    addAudit(database, { actorId: 'staff_001', action: 'advice.create', targetType: 'guest', targetId: 'guest_001', detail: 'Q6.3 latest timestamp marker', createdAt: '2030-01-02T00:00:00.000Z' });
    addAudit(database, { actorId: 'staff_001', action: 'guest.view', targetType: 'guest', targetId: 'guest_001', detail: 'Q6.3 earlier timestamp marker', createdAt: '2020-01-01T00:00:00.000Z' });
    addAudit(database, { actorId: 'staff_q6_3_other', action: 'staff.review', targetType: 'staff', targetId: 'staff_001', detail: 'Q6.3 other staff private marker', createdAt: '2040-01-01T00:00:00.000Z' });
  });
}
