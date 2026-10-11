import test from 'node:test';
import assert from 'node:assert/strict';
import { buildChatCompletionPayload, normalizeChatCompletion, requestChatCompletion } from '../src/model-adapter.js';

test('DeepSeek structured coordinator requests use JSON mode with thinking disabled', () => {
  const payload = buildChatCompletionPayload({ messages: [{ role: 'system', content: 'return json' }],
    model: 'deepseek-flash', maxTokens: 384, deepSeek: true, thinkingMode: 'disabled',
    responseFormat: { type: 'json_object' } });
  assert.deepEqual(payload.response_format, { type: 'json_object' });
  assert.deepEqual(payload.thinking, { type: 'disabled' });
  assert.equal(payload.max_tokens, 384);
  assert.equal(Object.hasOwn(payload, 'tool_choice'), false);
});

test('model adapter sends structured output options through the provider boundary and preserves safe finish reason', async () => {
  let captured;
  const result = await requestChatCompletion({
    baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-only-key', model: 'deepseek-flash', maxTokens: 384,
    messages: [{ role: 'system', content: 'return JSON only' }, { role: 'user', content: 'select from allowed candidates' }],
    thinkingMode: 'disabled', responseFormat: { type: 'json_object' },
    fetchImpl: async (_url, options) => {
      captured = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"selectedCandidateIds":[]}' },
        finish_reason: 'stop' }], model: 'deepseek-flash', usage: { prompt_tokens: 50, completion_tokens: 6, total_tokens: 56 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.deepEqual(captured.response_format, { type: 'json_object' });
  assert.deepEqual(captured.thinking, { type: 'disabled' });
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.message.reasoningContent, null);
});

test('model request audit completes before the provider fetch begins', async () => {
  const events = [];
  await requestChatCompletion({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-only-key', model: 'deepseek-flash',
    messages: [{ role: 'user', content: 'bounded offline fixture' }],
    onRequestAttempt: async () => { await Promise.resolve(); events.push('attempt-recorded'); },
    fetchImpl: async () => {
      events.push('fetch-invoked');
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }],
        usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    } });
  assert.deepEqual(events, ['attempt-recorded', 'fetch-invoked']);
});

test('model request audit failure prevents calling the provider', async () => {
  let fetchCalled = false;
  await assert.rejects(requestChatCompletion({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'test-only-key',
    messages: [{ role: 'user', content: 'do not send' }],
    onRequestAttempt: async () => { throw new Error('offline audit failure'); },
    fetchImpl: async () => { fetchCalled = true; throw new Error('must not fetch'); } }),
  error => error.code === 'MODEL_REQUEST_AUDIT_FAILED');
  assert.equal(fetchCalled, false);
});

test('normalized completion records finish reason without exposing reasoning in selection output', () => {
  const result = normalizeChatCompletion({ choices: [{ message: { role: 'assistant', content: '{}',
    reasoning_content: 'must not be persisted as a public selection field' }, finish_reason: 'length' }] });
  assert.equal(result.finishReason, 'length');
  assert.equal(Object.hasOwn(result, 'reasoningContent'), false);
  assert.equal(Object.hasOwn(result.message, 'reasoningContent'), true);
  assert.equal(result.message.content, '{}');
});

test('normalized completion distinguishes complete zero usage from missing, null, and partial usage', () => {
  const completion = usage => normalizeChatCompletion({ choices: [{ message: { role: 'assistant', content: 'ok' } }],
    ...(usage === undefined ? {} : { usage }) });

  const missing = completion(undefined);
  assert.deepEqual(missing.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.equal(missing.usageReported, false);
  assert.deepEqual(missing.usageFieldsReported, { inputTokens: false, outputTokens: false, totalTokens: false });

  const explicitNull = completion({ prompt_tokens: null, completion_tokens: null, total_tokens: null });
  assert.deepEqual(explicitNull.usage, { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.equal(explicitNull.usageReported, false);

  const partial = completion({ prompt_tokens: 0, total_tokens: 0 });
  assert.deepEqual(partial.usage, { inputTokens: 0, outputTokens: null, totalTokens: 0 });
  assert.equal(partial.usageReported, false);
  assert.deepEqual(partial.usageFieldsReported, { inputTokens: true, outputTokens: false, totalTokens: true });

  const reportedZero = completion({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  assert.deepEqual(reportedZero.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(reportedZero.usageReported, true);

  const completeBudgetUsageWithoutTotal = completion({ prompt_tokens: 1, completion_tokens: 2 });
  assert.equal(completeBudgetUsageWithoutTotal.usageReported, true,
    'input and output counts are the required complete budget usage fields');
  assert.equal(completeBudgetUsageWithoutTotal.usageFieldsReported.totalTokens, false);
});
