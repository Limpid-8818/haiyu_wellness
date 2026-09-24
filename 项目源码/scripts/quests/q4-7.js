import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../../server/src/password.js';
import { withTemporaryApi } from './helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    addAdviceFixtures(databasePath);

    const anonymous = await request(baseUrl, '/me/advice');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.code, 'AUTH_REQUIRED');

    const token = await guestToken(baseUrl);
    const own = await request(baseUrl, '/me/advice', { token });
    assert.equal(own.status, 200);
    assert.equal(own.data.length, 1, 'only active advice for this guest should be returned');
    assert.equal(own.data[0].title, '近期温泉安排');
    assert.match(own.data[0].content, /低温/);
    assert.equal(own.data[0].authorName, '王医生');
    assert.equal(own.data[0].status, 'active');
    assert.equal(own.data.some(row => row.title === '已关闭建议'), false);
    assert.equal(own.data.some(row => row.title === '其他客人建议'), false);

    const summary = await request(baseUrl, '/me', { token });
    assert.equal(summary.status, 200);
    assert.equal(summary.data.advice[0].author_name, '王医生', 'guest summary must include the advice author');

    const crossGuest = await request(baseUrl, '/me/advice?guestId=guest_002', { token });
    assert.equal(crossGuest.status, 403);
    assert.equal(crossGuest.data.code, 'GUEST_FORBIDDEN');

    return {
      output: [
        'anonymous HTTP 401 AUTH_REQUIRED',
        `own HTTP 200 active=${own.data.length} title=${own.data[0].title} author=${own.data[0].authorName}`,
        `summary HTTP 200 author=${summary.data.advice[0].author_name}`,
        'closedAdvice excluded=true',
        'guestId=guest_002 HTTP 403 GUEST_FORBIDDEN otherAdviceVisible=false'
      ]
    };
  }, 'haiyu-quest-q4-7-');
}

function addAdviceFixtures(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys=ON');
    database.prepare('INSERT INTO users(id,username,password_hash,role,name) VALUES(?,?,?,?,?)')
      .run('guest_002', 'other_guest', hashPassword('other-guest-password'), 'guest', '测试客人');
    const insertAdvice = database.prepare(`INSERT INTO medical_advice
      (guest_id,author_id,title,content,priority,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`);
    const later = new Date(Date.now() + 60_000).toISOString();
    insertAdvice.run('guest_001', 'staff_001', '已关闭建议', '不可向客人展示', 'normal', 'closed', later, later);
    insertAdvice.run('guest_002', 'staff_001', '其他客人建议', '仅属于其他客人', 'normal', 'active', later, later);
  } finally {
    database.close();
  }
}

async function guestToken(baseUrl) {
  const result = await request(baseUrl, '/auth/login', {
    method: 'POST',
    body: { username: 'guest_demo', password: 'guest2026', role: 'guest' }
  });
  assert.equal(result.status, 200);
  return result.data.token;
}

async function request(baseUrl, route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}
