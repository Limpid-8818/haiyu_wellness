import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withDatabase, addGuest } from './q5-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    withDatabase(databasePath, database => addGuest(database, { id: 'guest_q5_8_unassigned', name: '未授权详情样本' }));
    const staffToken = await login(baseUrl);

    const assigned = await request(baseUrl, '/staff/guests/guest_001', { token: staffToken });
    assert.equal(assigned.status, 200);
    assert.equal(assigned.data.name, '林海宁');
    assert.equal(assigned.data.profile.room_no, 'A-203');
    assert.ok(assigned.data.health.some(row => row.record_type === '血压' && row.value === '138/86'));
    assert.ok(assigned.data.advice.some(row => row.title === '近期温泉安排'));

    const unassigned = await request(baseUrl, '/staff/guests/guest_q5_8_unassigned', { token: staffToken });
    assert.equal(unassigned.status, 403);
    assert.equal(unassigned.data.code, 'GUEST_NOT_ASSIGNED');
    const missing = await request(baseUrl, '/staff/guests/guest_q5_8_missing', { token: staffToken });
    assert.equal(missing.status, 404);
    assert.equal(missing.data.code, 'GUEST_NOT_FOUND');

    return { output: [
      'assigned detail HTTP 200 profile/health/existing advice verified',
      'unassigned detail HTTP 403 GUEST_NOT_ASSIGNED',
      'missing guest HTTP 404 GUEST_NOT_FOUND'
    ] };
  }, 'haiyu-quest-q5-8-');
}
