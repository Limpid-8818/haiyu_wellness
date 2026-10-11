import assert from 'node:assert/strict';
import { assertOk, login, request, withBothDatabaseApis } from './q10-helpers.js';
import { databaseQuery } from './q10-helpers.js';

export async function run() {
  const observed = [];
  await withBothDatabaseApis(async context => {
    const roleUsers = [];
    const tokens = {};
    for (const role of ['guest', 'staff', 'dean']) {
      const result = await login(context.baseUrl, role);
      const data = assertOk(result, 200, `${context.driver} ${role} login`);
      roleUsers.push({ id: data.user.id, username: data.user.username, role: data.user.role, name: data.user.name, phone: data.user.phone, avatar: data.user.avatar });
      tokens[role] = data.token;
    }
    assert.deepEqual(roleUsers.map(user => user.role), ['guest', 'staff', 'dean']);
    const wrongRole = await request(context.baseUrl, '/auth/login', {
      method: 'POST', body: { username: 'guest_demo', password: 'guest2026', role: 'staff' }
    });
    assert.equal(wrongRole.status, 401);

    const changed = await request(context.baseUrl, '/me/password', {
      method: 'POST', token: tokens.guest,
      body: { currentPassword: 'guest2026', newPassword: 'guest-new-2026' }
    });
    assertOk(changed, 200, 'password change');
    assert.equal((await login(context.baseUrl, 'guest')).status, 401, 'old password must stop working');
    const newLogin = await request(context.baseUrl, '/auth/login', {
      method: 'POST', body: { username: 'guest_demo', password: 'guest-new-2026', role: 'guest' }
    });
    assertOk(newLogin, 200, 'new password login');

    await databaseQuery(context, "UPDATE users SET status='disabled' WHERE id='staff_001'", [], 'run');
    const inactiveLogin = await login(context.baseUrl, 'staff');
    assert.equal(inactiveLogin.status, 401, 'disabled account login must be denied');
    const inactiveToken = await request(context.baseUrl, '/me', { token: tokens.staff });
    assert.equal(inactiveToken.status, 401, 'disabled account token must be rejected');
    observed.push(roleUsers);
  });
  assert.deepEqual(observed[0], observed[1], 'SQLite and MySQL login response fields must match');
  return { output: ['guest, staff and dean login response fields match on SQLite/MySQL', 'password change, invalid role and disabled account checks passed'] };
}
