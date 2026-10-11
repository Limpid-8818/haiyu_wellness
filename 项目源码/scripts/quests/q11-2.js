import { assert, assertOk, createStaff, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const clinician = assertOk(await login(context.baseUrl, 'staff')).token;
    const coachAccount = await createStaff(context.baseUrl, dean, 'coach');
    const coach = assertOk(coachAccount.result, 201).id;
    const coachLogin = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: coachAccount.result.data.username, password: 'stage11-pass-2026', role: 'staff'
    } }), 200);
    const clinicianCaps = assertOk(await request(context.baseUrl, '/me/capabilities', { token: clinician }));
    const coachCaps = assertOk(await request(context.baseUrl, '/me/capabilities', { token: coachLogin.token }));
    const deanCaps = assertOk(await request(context.baseUrl, '/me/capabilities', { token: dean }));
    assert.equal(clinicianCaps.medicalAdvicePublish, true);
    assert.equal(coachCaps.medicalAdvicePublish, false);
    assert.equal(deanCaps.staffManagement, true);
    assert.equal(deanCaps.medicalAdvicePublish, false);
    assert.equal((await request(context.baseUrl, '/dean/staff', { token: coachLogin.token })).status, 403);
    const deniedAdvice = await request(context.baseUrl, '/staff/guests/guest_001/advice', {
      method: 'POST', token: coachLogin.token, body: { title: '不应发布', content: '越权校验' }
    });
    assert.equal(deniedAdvice.status, 403);
    assert.equal(deniedAdvice.data.code, 'CAPABILITY_FORBIDDEN');
    assert.equal((await request(context.baseUrl, '/dean/staff', { token: dean })).status, 200);
    assert.ok(coach);
  });
  return { output: ['clinician can publish medical advice; coach and dean cannot', 'staff management requires the manager capability and returns 403 when absent'] };
}
