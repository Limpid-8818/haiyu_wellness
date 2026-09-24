import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const login = await postLogin(baseUrl, 'guest_demo', 'guest2026');
    assert.equal(login.response.status, 200);
    const authorization = { authorization: `Bearer ${login.data.token}` };
    const wrongCurrent = await postPassword(baseUrl, authorization, 'wrong-password', 'quest-new-guest-password');
    assert.equal(wrongCurrent.response.status, 400);
    assert.equal(wrongCurrent.data.code, 'PASSWORD_CURRENT_INVALID');

    const invalidNew = await postPassword(baseUrl, authorization, 'guest2026', 'short');
    assert.equal(invalidNew.response.status, 400);
    assert.equal(invalidNew.data.code, 'PASSWORD_NEW_INVALID');

    const unchanged = await postLogin(baseUrl, 'guest_demo', 'guest2026');
    assert.equal(unchanged.response.status, 200, 'failed change attempts must not alter the current password');

    const newPassword = 'quest-3-8-guest-password';
    const changed = await postPassword(baseUrl, authorization, 'guest2026', newPassword);
    assert.equal(changed.response.status, 200);
    assert.equal(changed.data.ok, true);

    const oldLogin = await postLogin(baseUrl, 'guest_demo', 'guest2026');
    assert.equal(oldLogin.response.status, 401);
    assert.equal(oldLogin.data.code, 'AUTH_INVALID_CREDENTIALS');
    const newLogin = await postLogin(baseUrl, 'guest_demo', newPassword);
    assert.equal(newLogin.response.status, 200);
    assert.equal(newLogin.data.user.role, 'guest');

    return {
      output: [
        'wrongCurrent HTTP 400 PASSWORD_CURRENT_INVALID',
        'invalidNew HTTP 400 PASSWORD_NEW_INVALID',
        'changed HTTP 200 ok=true',
        'oldPassword HTTP 401 AUTH_INVALID_CREDENTIALS',
        'newPassword HTTP 200 token=true'
      ]
    };
  }, 'haiyu-quest-q3-8-');
}

async function postLogin(baseUrl, username, password) {
  const response = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password, role: 'guest' })
  });
  return { response, data: await response.json() };
}

async function postPassword(baseUrl, authorization, currentPassword, newPassword) {
  const response = await fetch(`${baseUrl}/me/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorization },
    body: JSON.stringify({ currentPassword, newPassword })
  });
  return { response, data: await response.json() };
}
