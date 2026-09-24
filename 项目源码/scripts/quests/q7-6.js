import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { addGuest, login, request, withDatabase } from './q7-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    withDatabase(databasePath, database => addGuest(database, {
      id: 'guest_q7_other', username: 'guest_q7_other', name: 'Q7 其他客人'
    }));
    const ownerToken = await login(baseUrl, 'guest_demo', 'guest2026', 'guest');
    const otherGuestToken = await login(baseUrl, 'guest_q7_other', 'quest-q7-guest-password', 'guest');
    const staffToken = await login(baseUrl, 'staff_demo', 'staff2026', 'staff');
    const sent = await request(baseUrl, '/assistant/chat', {
      method: 'POST', token: ownerToken, body: { text: 'Q7.6 私有历史标记' }
    });
    assert.equal(sent.status, 200);
    const historyPath = `/assistant/history?sessionId=${encodeURIComponent(sent.data.sessionId)}`;

    const ownHistory = await request(baseUrl, historyPath, { token: ownerToken });
    assert.equal(ownHistory.status, 200);
    assert.equal(ownHistory.data.messages.length, 2);
    for (const [label, token] of [['other guest', otherGuestToken], ['staff', staffToken], ['anonymous', undefined]]) {
      const denied = await request(baseUrl, historyPath, { token });
      assert.equal(denied.status, 403, `${label} must not read the owner's session`);
      assert.equal(denied.data.code, 'ASSISTANT_SESSION_FORBIDDEN');
    }
    return { output: [
      'owner GET /assistant/history HTTP 200 messages=2',
      'other guest, staff and anonymous session-ID guesses HTTP 403 ASSISTANT_SESSION_FORBIDDEN'
    ] };
  }, 'haiyu-quest-q7-6-');
}
