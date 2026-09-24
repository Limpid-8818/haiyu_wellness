import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { addAssignment, addGuest, login, request, withDatabase } from './q7-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    withDatabase(databasePath, database => {
      addGuest(database, { id: 'guest_q7_assigned', username: 'guest_q7_assigned', name: 'Q7 已分工客人' });
      addAssignment(database, { guestId: 'guest_q7_assigned' });
      addGuest(database, { id: 'guest_q7_unassigned', username: 'guest_q7_unassigned', name: 'Q7 未分工客人' });
    });
    const token = await login(baseUrl, 'staff_demo', 'staff2026', 'staff');
    const allowed = await request(baseUrl, '/assistant/chat', {
      method: 'POST', token, body: { guestId: 'guest_001', text: '整理已授权客人的工作观察' }
    });
    assert.equal(allowed.status, 200);
    const session = withDatabase(databasePath, database => database.prepare('SELECT related_guest_id FROM assistant_sessions WHERE id=?').get(allowed.data.sessionId));
    assert.equal(session.related_guest_id, 'guest_001');

    const crossContext = await request(baseUrl, '/assistant/chat', {
      method: 'POST', token, body: { sessionId: allowed.data.sessionId, guestId: 'guest_q7_assigned', text: '切换已绑定客人上下文' }
    });
    assert.equal(crossContext.status, 409);
    assert.equal(crossContext.data.code, 'ASSISTANT_GUEST_CONTEXT_MISMATCH');

    const unassigned = await request(baseUrl, '/assistant/chat', {
      method: 'POST', token, body: { guestId: 'guest_q7_unassigned', text: '尝试访问未分工客人' }
    });
    assert.equal(unassigned.status, 403);
    assert.equal(unassigned.data.code, 'GUEST_NOT_ASSIGNED');
    const storedSessions = withDatabase(databasePath, database => database.prepare('SELECT COUNT(*) AS count FROM assistant_sessions WHERE user_id=?').get('staff_001').count);
    assert.equal(storedSessions, 1, 'rejected contexts must not create another session');
    for (const privateMarker of ['Q7 已分工客人', 'Q7 未分工客人']) {
      assert.equal(allowed.data.reply.includes(privateMarker), false);
    }
    return { output: [
      'staff chat for assigned guest HTTP 200 related_guest_id=guest_001',
      'reusing session with another assigned guest HTTP 409 ASSISTANT_GUEST_CONTEXT_MISMATCH',
      'new session for unassigned guest HTTP 403 GUEST_NOT_ASSIGNED; rejected sessions created=0'
    ] };
  }, 'haiyu-quest-q7-7-');
}
