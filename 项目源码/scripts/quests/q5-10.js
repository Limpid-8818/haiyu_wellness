import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withDatabase, addUser } from './q5-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    withDatabase(databasePath, database => addUser(database, {
      id: 'staff_q5_10_unassigned', username: 'staff_q5_10_unassigned', role: 'staff', name: '未授权工作人员'
    }));
    const staffToken = await login(baseUrl);
    const guestToken = await login(baseUrl, 'guest_demo', 'guest2026', 'guest');

    const created = await request(baseUrl, '/staff/guests/guest_001/advice', {
      method: 'POST', token: staffToken,
      body: { title: 'Q5.10 Quest 建议', content: '建议按计划进行晨间轻度活动。', priority: 'important' }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.ok, true);

    const guestAdvice = await request(baseUrl, '/me/advice', { token: guestToken });
    assert.equal(guestAdvice.status, 200);
    assert.ok(guestAdvice.data.some(entry => entry.id === created.data.id && entry.title === 'Q5.10 Quest 建议'));

    const unauthorizedToken = await login(baseUrl, 'staff_q5_10_unassigned', 'quest-test-password', 'staff');
    const unauthorized = await request(baseUrl, '/staff/guests/guest_001/advice', {
      method: 'POST', token: unauthorizedToken,
      body: { title: '越权建议', content: '此内容不应保存。' }
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.data.code, 'GUEST_NOT_ASSIGNED');

    const empty = await request(baseUrl, '/staff/guests/guest_001/advice', {
      method: 'POST', token: staffToken,
      body: { title: '空内容验证', content: '   ' }
    });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.code, 'ADVICE_INVALID');
    const guestAfterEmpty = await request(baseUrl, '/me/advice', { token: guestToken });
    assert.equal(guestAfterEmpty.data.some(entry => entry.title === '空内容验证'), false);

    return { output: [
      'authorized POST /staff/guests/guest_001/advice HTTP 201',
      `guest GET /me/advice HTTP 200; newAdviceVisible=${guestAdvice.data.some(entry => entry.id === created.data.id)}`,
      'unassigned staff POST HTTP 403 GUEST_NOT_ASSIGNED',
      'blank content POST HTTP 400 ADVICE_INVALID; no guest record created'
    ] };
  }, 'haiyu-quest-q5-10-');
}
