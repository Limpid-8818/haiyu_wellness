import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { request } from './q7-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const result = await request(baseUrl, '/assistant/status');
    assert.equal(result.status, 200);
    assert.equal(result.data.live, false);
    assert.equal(result.data.fallback, '安全引导模式');
    return { output: ['GET /assistant/status HTTP 200', `live=${result.data.live}`, `fallback=${result.data.fallback}`] };
  }, 'haiyu-quest-q7-2-');
}
