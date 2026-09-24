import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request } from './q6-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const deanToken = await login(baseUrl, 'dean_demo', 'dean2026', 'dean');
    const staffToken = await login(baseUrl, 'staff_demo', 'staff2026', 'staff');
    const route = '/dean/staff/staff_001/reviews';
    const initial = await request(baseUrl, '/dean/staff/staff_001/logs', { token: deanToken });
    assert.equal(initial.status, 200);
    const beforeCount = initial.data.reviews.length;

    const created = await request(baseUrl, route, {
      method: 'POST', token: deanToken, body: { content: 'Q6.5 请继续保持清晰的客人交接记录。' }
    });
    assert.equal(created.status, 201);
    assert.ok(created.data.id);

    const empty = await request(baseUrl, route, { method: 'POST', token: deanToken, body: { content: '' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.data.code, 'REVIEW_INVALID');
    const whitespace = await request(baseUrl, route, { method: 'POST', token: deanToken, body: { content: '   ' } });
    assert.equal(whitespace.status, 400);
    assert.equal(whitespace.data.code, 'REVIEW_INVALID');

    const unauthorized = await request(baseUrl, route, {
      method: 'POST', token: staffToken, body: { content: '普通员工不得提交院长意见。' }
    });
    assert.equal(unauthorized.status, 403);
    assert.equal(unauthorized.data.code, 'ROLE_FORBIDDEN');

    const after = await request(baseUrl, '/dean/staff/staff_001/logs', { token: deanToken });
    assert.equal(after.status, 200);
    assert.equal(after.data.reviews.length, beforeCount + 1, 'only the valid review should be saved');
    const persisted = after.data.reviews.find(row => row.id === created.data.id);
    assert.ok(persisted);
    assert.equal(persisted.content, 'Q6.5 请继续保持清晰的客人交接记录。');
    assert.ok(Number.isFinite(Date.parse(persisted.createdAt)));

    return { output: [
      `dean POST /dean/staff/staff_001/reviews HTTP 201 id=${created.data.id}`,
      'follow-up GET /dean/staff/staff_001/logs HTTP 200 review persisted=true',
      'empty and whitespace opinions HTTP 400 REVIEW_INVALID; no extra rows',
      'staff POST review HTTP 403 ROLE_FORBIDDEN'
    ] };
  }, 'haiyu-quest-q6-5-');
}
