import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const listResponse = await fetch(`${baseUrl}/news`);
    const news = await listResponse.json();
    assert.equal(listResponse.status, 200, 'public news list must return HTTP 200');
    assert.ok(news.length > 0, 'temporary database must contain a known news item');

    const known = news[0];
    const detailResponse = await fetch(`${baseUrl}/news/${known.id}`);
    const detail = await detailResponse.json();
    assert.equal(detailResponse.status, 200, 'known news ID must return HTTP 200');
    assert.equal(detail.id, known.id);
    assert.equal(detail.title, known.title);
    assert.equal(typeof detail.body, 'string');
    assert.ok(detail.body.trim(), 'known news detail must contain its full body');

    const missingResponse = await fetch(`${baseUrl}/news/quest-q2-5-missing-id`);
    const missing = await missingResponse.json();
    assert.equal(missingResponse.status, 404, 'unknown news ID must return HTTP 404');
    assert.equal(missing.code, 'NEWS_NOT_FOUND');

    return {
      output: [
        'known HTTP 200',
        `knownTitle=${detail.title}`,
        `bodyCharacters=${detail.body.length}`,
        `missing HTTP 404 code=${missing.code}`
      ]
    };
  }, 'haiyu-quest-q2-5-');
}
