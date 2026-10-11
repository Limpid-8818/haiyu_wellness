import { assert, assertOk, createStaff, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    for (const [role, username, expectedId, jobType] of [
      ['guest', 'guest_demo', 'guest_001', null],
      ['staff', 'staff_demo', 'staff_001', 'clinician'],
      ['dean', 'dean_demo', 'dean_001', null]
    ]) {
      const logged = assertOk(await login(context.baseUrl, role), 200, `${role} demo login`);
      assert.equal(logged.user.id, expectedId, `${username} keeps its original ID`);
      assert.equal(logged.user.jobType, jobType);
    }
    const dean = (await login(context.baseUrl, 'dean')).data.token;
    for (const type of ['clinician', 'administrator', 'coach', 'therapist', 'dietitian']) {
      const { result } = await createStaff(context.baseUrl, dean, type);
      const member = assertOk(result, 201, `${type} staff fixture`);
      assert.equal(member.jobType, type);
      const logged = assertOk(await request(context.baseUrl, '/auth/login', {
        method: 'POST', body: { username: member.username, password: 'stage11-pass-2026', role: 'staff' }
      }), 200, `${type} login`);
      assert.equal(logged.user.jobType, type);
    }
  });
  return { output: ['all five staff job types are stored and returned', 'guest_demo, staff_demo and dean_demo IDs are unchanged; staff_demo maps to clinician'] };
}
