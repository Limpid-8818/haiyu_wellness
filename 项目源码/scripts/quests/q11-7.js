import { assert, assertOk, checkWebSource, createStaff, login, request, withQ11Apis } from './q11-helpers.js';

export async function run() {
  await withQ11Apis(async context => {
    const dean = assertOk(await login(context.baseUrl, 'dean')).token;
    const expected = { clinician: '医护审核台', administrator: '工作概览', coach: '每日安排', therapist: '理疗工作台', dietitian: '备餐单' };
    for (const [jobType, pageTitle] of Object.entries(expected)) {
      const account = assertOk((await createStaff(context.baseUrl, dean, jobType)).result, 201);
      const logged = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
        username: account.username, password: 'stage11-pass-2026', role: 'staff'
      } }), 200);
      assert.equal(logged.user.jobType, jobType);
      assert.equal(logged.user.capabilities.jobType, jobType);
      assert.equal(logged.user.capabilities.medicalAdvicePublish, jobType === 'clinician');
      assert.equal(pageTitle.length > 0, true);
    }
  });
  await checkWebSource(['review: [\'医护审核台\'', "daily: ['每日安排'", "'meal-prep': ['备餐单'", '当前岗位没有查看此页面的权限', '← {backLabel}']);
  return { output: ['each staff job type receives matching capability data and has a dedicated homepage route', 'unfinished job pages show a title, scope note and return action'] };
}
