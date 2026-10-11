import assert from 'node:assert/strict';
import { access, stat } from 'node:fs/promises';
import { withTemporaryApi } from './helpers.js';

export async function run({ resourceSession } = {}) {
  return await withTemporaryApi(async ({ baseUrl, databasePath }) => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();

    assert.equal(response.status, 200, 'health endpoint must return HTTP 200');
    assert.equal(body.ok, true, 'health response must contain ok=true');
    await access(databasePath);
    assert.ok((await stat(databasePath)).size > 0, 'API must create the temporary SQLite file');
    return { output: ['HTTP 200', 'ok=true'] };
  }, 'haiyu-quest-q1-6-', {}, { resourceSession });
}
