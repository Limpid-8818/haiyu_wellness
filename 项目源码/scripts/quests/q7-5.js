import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request } from './q7-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, restartApi }) => {
    const token = await login(baseUrl, 'guest_demo', 'guest2026', 'guest');
    const sent = await request(baseUrl, '/assistant/chat', {
      method: 'POST', token, body: { text: 'Q7.5 持久化问答标记' }
    });
    assert.equal(sent.status, 200);
    assert.ok(sent.data.sessionId);

    const readHistory = async currentBaseUrl => request(currentBaseUrl,
      `/assistant/history?sessionId=${encodeURIComponent(sent.data.sessionId)}`, { token });
    const firstRead = await readHistory(baseUrl);
    assert.equal(firstRead.status, 200);
    assert.deepEqual(firstRead.data.messages.map(message => message.role), ['user', 'assistant']);

    const restartedBaseUrl = await restartApi();
    const afterRestart = await readHistory(restartedBaseUrl);
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.data.messages.length, 2);
    assert.equal(afterRestart.data.messages[0].content, 'Q7.5 持久化问答标记');
    assert.equal(afterRestart.data.messages[1].content, sent.data.reply);
    return { output: [
      'one POST /assistant/chat HTTP 200 created one user and one assistant message',
      'API restarted with the same temporary SQLite database',
      'GET /assistant/history after restart HTTP 200, messages=2'
    ] };
  }, 'haiyu-quest-q7-5-');
}
