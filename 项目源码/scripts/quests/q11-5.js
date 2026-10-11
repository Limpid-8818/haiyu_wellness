import { assert, assertOk, checkWebSource, createStaff, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const created = assertOk((await createStaff(context.baseUrl, dean, 'dietitian')).result, 201);
    const list = assertOk(await request(context.baseUrl, '/dean/staff', { token: dean }));
    assert.ok(list.some(row => row.id === created.id && row.jobTypeLabel === '配餐员' && row.role === 'staff'));
    assertOk(await request(context.baseUrl, `/dean/staff/${created.id}`, { method: 'PATCH', token: dean, body: { status: 'disabled' } }));
    assert.equal((await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: created.username, password: 'stage11-pass-2026', role: 'staff'
    } })).status, 401);
  });
  await checkWebSource(['function StaffManagement(', 'window.confirm(`确认停用', '停用只影响后续登录和访问']);
  return { output: ['employee management contract creates, refreshes and disables employee accounts', 'UI includes confirmation before disabling and leaves historical records readable'] };
}
