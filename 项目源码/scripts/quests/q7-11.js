import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withModelStub } from './q7-helpers.js';

export async function run() {
  return withModelStub(async () => ({
    status: 200,
    body: { id: 'q7-stub-completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Q7.11-STUB-REPLY' } }] }
  }), async stub => withTemporaryApi(async ({ baseUrl }) => {
    const token = await login(baseUrl, 'guest_demo', 'guest2026', 'guest');
    const result = await request(baseUrl, '/assistant/chat', {
      method: 'POST', token, body: { text: 'Q7.11 指定消息参数' }
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.live, true);
    assert.equal(result.data.mode, '真实模型服务');
    assert.equal(result.data.reply, 'Q7.11-STUB-REPLY');
    assert.equal(stub.received.length, 1);
    assert.equal(stub.received[0].method, 'POST');
    assert.equal(stub.received[0].url, '/v1/chat/completions');
    assert.equal(stub.received[0].headers.authorization, 'Bearer q7-local-stub-secret');
    assert.equal(stub.received[0].body.model, 'q7-local-stub-model');
    assert.ok(stub.received[0].body.messages.some(message => message.role === 'user' && message.content === 'Q7.11 指定消息参数'));
    return { output: [
      'local model stub POST /v1/chat/completions received HTTP-compatible JSON',
      `authorization=${stub.received[0].headers.authorization}`,
      `model=${stub.received[0].body.model}; user message received=true`,
      `assistant reply parsed=${result.data.reply}; live=true`
    ] };
  }, 'haiyu-quest-q7-11-', {
    LLM_BASE_URL: stub.baseUrl,
    LLM_API_KEY: 'q7-local-stub-secret',
    LLM_MODEL: 'q7-local-stub-model',
    LLM_TIMEOUT_MS: '2000'
  }));
}
