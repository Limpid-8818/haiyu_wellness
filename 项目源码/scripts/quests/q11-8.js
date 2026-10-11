import { assert, assertOk, loginAccount, registerGuest, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const { body, result } = await registerGuest(context.baseUrl);
    const registered = assertOk(result, 201, 'guest registration');
    assert.equal(registered.admissionStatus, 'pending');
    assert.equal(registered.user.role, 'guest');
    const logged = assertOk(await loginAccount(context.baseUrl, body.phone, body.password, 'guest'), 200);
    const profile = assertOk(await request(context.baseUrl, '/me', { token: logged.token }));
    assert.equal(profile.phone, body.phone);
    assert.equal(profile.admissionStatus, 'pending');
    assert.deepEqual([profile.profile.room_no, profile.profile.check_in, profile.profile.check_out], [null, null, null]);
    const duplicate = await request(context.baseUrl, '/auth/register', { method: 'POST', body });
    assert.equal(duplicate.status, 409);
    const invalidPhone = await request(context.baseUrl, '/auth/register', { method: 'POST', body: { ...body, phone: '12345' } });
    assert.equal(invalidPhone.status, 400);
    const mismatch = await request(context.baseUrl, '/auth/register', { method: 'POST', body: { ...body, phone: '13800009999', confirmPassword: 'different-stage11' } });
    assert.equal(mismatch.status, 400);
  });
  return { output: ['valid guest phone registration returns 201 and phone login returns 200', 'duplicate phone, invalid phone and password mismatch are rejected; new account starts as pending'] };
}
