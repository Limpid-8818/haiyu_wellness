import { assert, assertOk, checkWebSource, createStaff, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const coach = assertOk((await createStaff(context.baseUrl, dean, 'coach')).result, 201);
    const token = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: coach.username, password: 'stage11-pass-2026', role: 'staff'
    } }), 200).token;
    const toggled = assertOk(await request(context.baseUrl, '/dean/job-capabilities', {
      method: 'PATCH', token: dean, body: { jobType: 'coach', capability: 'operations.summary.view', enabled: false }
    }));
    const row = toggled.matrix.find(item => item.jobType === 'coach');
    assert.equal(row.capabilities['operations.summary.view'], false);
    assert.equal(row.capabilities['medical_advice.publish'], false);
    assert.equal((await request(context.baseUrl, '/staff/overview', { token })).status, 403);
    const relogin = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
      username: coach.username, password: 'stage11-pass-2026', role: 'staff'
    } }), 200);
    assert.equal(relogin.user.capabilities.operationsSummaryView, false);
    const attemptedMedicalGrant = await request(context.baseUrl, '/dean/job-capabilities', {
      method: 'PATCH', token: dean, body: { jobType: 'coach', capability: 'medical_advice.publish', enabled: true }
    });
    assert.equal(attemptedMedicalGrant.status, 400);
    assert.equal(attemptedMedicalGrant.data.code, 'CAPABILITY_FIXED');
  });
  await checkWebSource(['function CapabilitiesMatrix(', '查看运营汇总', '医护建议发布', 'aria-label={`${row.jobTypeLabel} 查看运营汇总`}']);
  return { output: ['coach summary toggle updates the matrix and /me capability result; overview API returns 403', 'medical publishing is fixed and cannot be granted by the toggle'] };
}
