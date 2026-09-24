import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { request } from './q7-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const result = await request(baseUrl, '/assistant/chat', {
      method: 'POST', body: { role: 'public', text: '如何入住' }
    });
    assert.equal(result.status, 200);
    assert.match(result.data.sessionId, /^as_[0-9a-f-]{36}$/);
    assert.equal(result.data.live, false);
    assert.equal(result.data.mode, '安全引导模式');
    assert.match(result.data.reply, /海屿康养社区/);
    assert.match(result.data.reply, /入住|客人|工作人员/);
    for (const privateMarker of ['林海宁', '13800000001', 'A-203', '高血压']) {
      assert.equal(result.data.reply.includes(privateMarker), false, `public reply must not contain ${privateMarker}`);
    }
    return { output: ['anonymous POST /assistant/chat HTTP 200', `sessionId=${result.data.sessionId}`, `reply=${result.data.reply}`, 'demo guest private markers absent=true'] };
  }, 'haiyu-quest-q7-3-');
}
