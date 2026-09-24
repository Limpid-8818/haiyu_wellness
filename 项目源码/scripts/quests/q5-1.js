import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withDatabase, addGuest, addAssignment } from './q5-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath, restartApi }) => {
    const initial = readAssignments(databasePath);
    assert.equal(initial.length, 1, 'fresh database must seed one demo staff to guest assignment');
    assert.equal(initial[0].staff_id, 'staff_001');
    assert.equal(initial[0].guest_id, 'guest_001');
    assert.equal(initial[0].status, 'active');

    addClosedAssignment(databasePath);
    const firstRestartUrl = await restartApi();
    assert.equal(readAssignments(databasePath).length, 2);
    const firstStaff = await login(firstRestartUrl);
    const firstMe = await request(firstRestartUrl, '/me', { token: firstStaff });
    assert.equal(firstMe.status, 200);
    assert.equal(firstMe.data.assignedCount, 1, 'active seeded assignment must persist; closed assignment is ineffective');
    assert.equal(readAssignments(databasePath).find(row => row.guest_id === 'guest_q5_1_closed').status, 'closed');

    withDatabase(databasePath, database => {
      database.prepare("DELETE FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'").run();
    });
    const secondRestartUrl = await restartApi();
    const afterDelete = readAssignments(databasePath);
    assert.equal(afterDelete.length, 1, 'deleting the demo assignment must persist through restart');
    assert.equal(afterDelete[0].guest_id, 'guest_q5_1_closed');
    assert.equal(afterDelete[0].status, 'closed', 'revoked assignment must not be reopened on restart');
    const secondStaff = await login(secondRestartUrl);
    const secondMe = await request(secondRestartUrl, '/me', { token: secondStaff });
    assert.equal(secondMe.status, 200);
    assert.equal(secondMe.data.assignedCount, 0, 'deleted demo assignment must not be recreated on restart');

    return { output: [
      'fresh seed: exactly one active staff_001 → guest_001 assignment',
      'restart 1: seeded assignment persists; closed fixture stays closed; assignedCount=1',
      'restart 2: deleted seeded assignment stays deleted; closed assignment remains revoked; assignedCount=0'
    ] };
  }, 'haiyu-quest-q5-1-');
}

function addClosedAssignment(databasePath) {
  withDatabase(databasePath, database => {
    addGuest(database, { id: 'guest_q5_1_closed', username: 'guest_q5_1_closed', name: '撤销分配样本' });
    addAssignment(database, { guestId: 'guest_q5_1_closed' });
    database.prepare("UPDATE staff_guest_assignments SET status='closed' WHERE staff_id='staff_001' AND guest_id='guest_q5_1_closed'").run();
  });
}

function readAssignments(databasePath) {
  return withDatabase(databasePath, database => database.prepare(`SELECT staff_id,guest_id,status
    FROM staff_guest_assignments ORDER BY guest_id`).all());
}
