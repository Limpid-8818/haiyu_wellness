import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { addAdvice, addAudit, addStaff, login, request, withDatabase } from './q6-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    addListFixtures(databasePath);
    const deanToken = await login(baseUrl, 'dean_demo', 'dean2026', 'dean');
    const guestToken = await login(baseUrl, 'guest_demo', 'guest2026', 'guest');
    const staffToken = await login(baseUrl, 'staff_demo', 'staff2026', 'staff');

    const allowed = await request(baseUrl, '/dean/staff', { token: deanToken });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.length, 2, 'only staff accounts should be listed');
    const doctor = allowed.data.find(row => row.id === 'staff_001');
    const sample = allowed.data.find(row => row.id === 'staff_q6_1');
    assert.ok(doctor);
    assert.equal(doctor.guestViews, 2);
    assert.equal(doctor.adviceCount, 1, 'seeded advice authored by staff_001 should be counted');
    assert.ok(sample);
    assert.equal(sample.guestViews, 1);
    assert.equal(sample.adviceCount, 1);
    assert.ok(allowed.data.every(row => row.role === 'staff' && !Object.hasOwn(row, 'password_hash')),
      'response exposes the current safe public staff role and omits credential fields');

    const guestDenied = await request(baseUrl, '/dean/staff', { token: guestToken });
    assert.equal(guestDenied.status, 403);
    assert.equal(guestDenied.data.code, 'CAPABILITY_FORBIDDEN');
    const staffDenied = await request(baseUrl, '/dean/staff', { token: staffToken });
    assert.equal(staffDenied.status, 403);
    assert.equal(staffDenied.data.code, 'CAPABILITY_FORBIDDEN');

    return { output: [
      'dean GET /dean/staff HTTP 200; staffRows=2',
      'staff_001 guestViews=2 adviceCount=1',
      'staff_q6_1 guestViews=1 adviceCount=1',
      'guest GET /dean/staff HTTP 403 CAPABILITY_FORBIDDEN',
      'staff GET /dean/staff HTTP 403 CAPABILITY_FORBIDDEN'
    ] };
  }, 'haiyu-quest-q6-1-');
}

function addListFixtures(databasePath) {
  withDatabase(databasePath, database => {
    addStaff(database, { id: 'staff_q6_1', username: 'staff_q6_1', name: '验收工作人员甲' });
    addAudit(database, { actorId: 'staff_001', action: 'guest.view', targetType: 'guest', targetId: 'guest_001', detail: 'Q6.1 staff_001 view one', createdAt: '2026-01-01T00:00:00.000Z' });
    addAudit(database, { actorId: 'staff_001', action: 'guest.view', targetType: 'guest', targetId: 'guest_001', detail: 'Q6.1 staff_001 view two', createdAt: '2026-01-02T00:00:00.000Z' });
    addAudit(database, { actorId: 'staff_q6_1', action: 'guest.view', targetType: 'guest', targetId: 'guest_001', detail: 'Q6.1 fixture staff view', createdAt: '2026-01-03T00:00:00.000Z' });
    addAdvice(database, { authorId: 'staff_q6_1', title: 'Q6.1 count fixture' });
  });
}
