import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';

const accounts = [
  { username: 'guest_demo', password: 'guest2026', role: 'guest' },
  { username: 'staff_demo', password: 'staff2026', role: 'staff' },
  { username: 'dean_demo', password: 'dean2026', role: 'dean' }
];

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const results = [];
    for (const account of accounts) {
      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(account)
      });
      const data = await response.json();
      assert.equal(response.status, 200, `${account.role} login must return HTTP 200`);
      assert.equal(data.user.role, account.role);
      assert.equal(data.user.username, account.username);
      assert.ok(data.token, `${account.role} login must return a token`);
      results.push(`${account.role} HTTP 200 token=true`);
    }

    const badPassword = await postLogin(baseUrl, { ...accounts[0], password: 'wrong-password' });
    assert.equal(badPassword.response.status, 401);
    assert.equal(badPassword.data.code, 'AUTH_INVALID_CREDENTIALS');

    const wrongRole = await postLogin(baseUrl, { ...accounts[0], role: 'staff' });
    assert.equal(wrongRole.response.status, 401);
    assert.equal(wrongRole.data.code, 'AUTH_INVALID_CREDENTIALS');

    return {
      output: [
        ...results,
        'badPassword HTTP 401 AUTH_INVALID_CREDENTIALS',
        'wrongRole HTTP 401 AUTH_INVALID_CREDENTIALS'
      ]
    };
  }, 'haiyu-quest-q3-2-');
}

async function postLogin(baseUrl, credentials) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(credentials)
  });
  return { response, data: await response.json() };
}
