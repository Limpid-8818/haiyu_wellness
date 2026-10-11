import { assert, assertOk, createStaff, databaseQuery, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const member = assertOk((await createStaff(context.baseUrl, dean, 'coach')).result, 201);
    const userLogin = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: member.username, password: 'stage11-pass-2026', role: 'staff'
    } }), 200);
    const before = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id=?', [member.id], 'get');
    assert.ok(Number(before.count) >= 1);
    assert.equal(assertOk(await request(context.baseUrl, '/me', { token: userLogin.token })).jobType, 'coach');
    assertOk(await request(context.baseUrl, `/dean/staff/${member.id}`, { method: 'PATCH', token: dean, body: { status: 'disabled' } }));
    const stale = await request(context.baseUrl, '/me', { token: userLogin.token });
    assert.equal(stale.status, 401);
    const afterDisable = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id=?', [member.id], 'get');
    assert.equal(Number(afterDisable.count), Number(before.count));
    assertOk(await request(context.baseUrl, `/dean/staff/${member.id}`, { method: 'PATCH', token: dean, body: { status: 'active', jobType: 'clinician' } }));
    const reLogin = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: member.username, password: 'stage11-pass-2026', role: 'staff'
    } }), 200);
    assert.equal(reLogin.user.jobType, 'clinician');
    assert.equal(reLogin.user.capabilities.medicalAdvicePublish, true);
  });
  return { output: ['disabled account rejects its existing token with 401', 'historical audit rows remain unchanged', 're-enabled clinician receives the clinician capability matrix'] };
}
