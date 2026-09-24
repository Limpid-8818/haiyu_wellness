import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';

const accounts = [
  { username: 'guest_demo', password: 'guest2026', role: 'guest', name: '林海宁' },
  { username: 'staff_demo', password: 'staff2026', role: 'staff', name: '王医生' },
  { username: 'dean_demo', password: 'dean2026', role: 'dean', name: '周院长' }
];

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const anonymous = await fetch(`${baseUrl}/me`);
    const anonymousBody = await anonymous.json();
    assert.equal(anonymous.status, 401);
    assert.equal(anonymousBody.code, 'AUTH_REQUIRED');

    const results = [];
    for (const account of accounts) {
      const loginResponse = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(account)
      });
      const login = await loginResponse.json();
      assert.equal(loginResponse.status, 200);

      const response = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ${login.token}` } });
      const user = await response.json();
      assert.equal(response.status, 200, `${account.role} bearer must return HTTP 200`);
      assert.equal(user.id, login.user.id);
      assert.equal(user.username, account.username);
      assert.equal(user.name, account.name);
      assert.equal(user.role, account.role);
      if (account.role !== 'guest') {
        assert.equal(Object.hasOwn(user, 'profile'), false);
        assert.equal(Object.hasOwn(user, 'health'), false);
        assert.equal(Object.hasOwn(user, 'advice'), false);
      }
      results.push(`${account.role} HTTP 200 self=${user.name} role=${user.role}`);
    }

    return {
      output: [
        'anonymous HTTP 401 AUTH_REQUIRED',
        ...results
      ]
    };
  }, 'haiyu-quest-q3-5-');
}
