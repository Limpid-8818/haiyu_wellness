import { assert, assertOk, checkWebSource, registerGuest, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const { body, result } = await registerGuest(context.baseUrl);
    const registered = assertOk(result, 201);
    assertOk(await request(context.baseUrl, '/me', { token: registered.token }));
    assert.equal(registered.admissionStatus, 'pending');
  });
  await checkWebSource(['没有账号？客人注册', '确认密码', '两次输入的密码不一致', "onLogin(data.user, 'profile')", '已有账号？返回登录']);
  return { output: ['registration enters the newly created guest profile; login switch remains available', 'password mismatch is shown inline before submission'] };
}
