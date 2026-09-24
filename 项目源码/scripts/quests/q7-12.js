import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { request, withModelStub } from './q7-helpers.js';

export async function run() {
  let stubMode = 'error';
  return withModelStub(async () => stubMode === 'error'
    ? { status: 503, body: { error: { message: 'local stub failure' } } }
    : { status: 200, delayMs: 600, body: { choices: [{ message: { role: 'assistant', content: 'LATE-REPLY-MUST-NOT-BE-USED' } }] } },
  async stub => withTemporaryApi(async ({ baseUrl }) => {
    const ask = text => request(baseUrl, '/assistant/chat', { method: 'POST', body: { role: 'public', text } });
    const failed = await ask('Q7.12 stub HTTP error');
    assert.equal(failed.status, 200);
    assert.equal(failed.data.live, false);
    assert.equal(failed.data.mode, '安全引导模式');
    assert.match(failed.data.reply, /欢迎来到海屿康养社区/);

    stubMode = 'timeout';
    const timedOut = await ask('Q7.12 stub timeout');
    assert.equal(timedOut.status, 200);
    assert.equal(timedOut.data.live, false);
    assert.equal(timedOut.data.mode, '安全引导模式');
    assert.match(timedOut.data.reply, /欢迎来到海屿康养社区/);
    assert.equal(timedOut.data.reply.includes('LATE-REPLY-MUST-NOT-BE-USED'), false);
    assert.equal(stub.received.length, 2);
    return { output: [
      'stub HTTP 503: local fallback HTTP 200, mode=安全引导模式',
      'stub delay 600ms exceeded configured 120ms timeout: local fallback HTTP 200, mode=安全引导模式',
      'no retry and late stub response not used=true'
    ] };
  }, 'haiyu-quest-q7-12-', {
    LLM_BASE_URL: stub.baseUrl,
    LLM_API_KEY: 'q7-local-stub-secret',
    LLM_MODEL: 'q7-local-stub-model',
    LLM_TIMEOUT_MS: '120'
  }));
}
