import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withDatabase, addGuest } from './q5-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    withDatabase(databasePath, database => addGuest(database, { id: 'guest_q5_5_unassigned', name: '未授权客人', roomNo: 'Q5-505' }));
    const staffToken = await login(baseUrl);
    const result = await request(baseUrl, '/staff/guests', { token: staffToken });
    assert.equal(result.status, 200);
    assert.ok(Array.isArray(result.data));
    assert.ok(result.data.some(guest => guest.id === 'guest_001' && guest.name === '林海宁'));
    assert.equal(result.data.some(guest => guest.id === 'guest_q5_5_unassigned'), false);

    return { output: [
      'GET /staff/guests HTTP 200',
      'assigned guest 林海宁 included=true',
      'unassigned guest omitted=true'
    ] };
  }, 'haiyu-quest-q5-5-');
}
