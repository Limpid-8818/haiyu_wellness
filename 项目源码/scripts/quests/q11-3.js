import { assert, assertOk, createStaff, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const admin = assertOk((await createStaff(context.baseUrl, dean, 'administrator')).result, 201);
    const adminToken = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: admin.username, password: 'stage11-pass-2026', role: 'staff'
    } }), 200).token;
    const { input, result } = await createStaff(context.baseUrl, adminToken, 'coach');
    const coach = assertOk(result, 201, 'administrator creates coach');
    assert.equal(coach.name, input.name);
    assert.equal(coach.jobType, 'coach');
    const duplicate = await request(context.baseUrl, '/dean/staff', { method: 'POST', token: adminToken, body: input });
    assert.equal(duplicate.status, 409);
    const guest = assertOk(await login(context.baseUrl, 'guest')).token;
    assert.equal((await request(context.baseUrl, '/dean/staff', { method: 'POST', token: guest, body: input })).status, 403);
    const coachLogin = await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: coach.username, password: input.password, role: 'staff'
    } });
    assert.equal(coachLogin.status, 200);
  });
  return { output: ['administrator created and authenticated a coach account (HTTP 201/200)', 'duplicate username returns 409; guest creation attempt returns 403'] };
}
