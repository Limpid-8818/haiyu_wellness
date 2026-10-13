import { AppError } from './errors.js';

export const DEMO_TEAM = Object.freeze([
  { id: 'demo_admin', username: 'admin_demo', name: '演示管理员', jobType: 'administrator' },
  { id: 'demo_coach', username: 'coach_demo', name: '演示教练', jobType: 'coach' },
  { id: 'demo_therapist', username: 'therapist_demo', name: '演示理疗师', jobType: 'therapist' },
  { id: 'demo_dietitian', username: 'dietitian_demo', name: '演示配餐员', jobType: 'dietitian' }
]);

// Called only by an explicit local CLI. Startup DEMO_SEED retains its original behavior.
export async function initializeDemoTeam({ database, transact, hashPassword, stamp }) {
  return transact(async () => {
    const users = await database.prepare('SELECT id,username,role,job_type FROM users').all();
    const allowed = new Map([['guest_001', ['guest_demo', 'guest', null]], ['staff_001', ['staff_demo', 'staff', 'clinician']],
      ['dean_001', ['dean_demo', 'dean', null]], ...DEMO_TEAM.map(user => [user.id, [user.username, 'staff', user.jobType]])]);
    if (users.some(user => {
      const expected = allowed.get(user.id);
      return !expected || user.username !== expected[0] || user.role !== expected[1] || (user.job_type || null) !== expected[2];
    }) || !['guest_001', 'staff_001', 'dean_001'].every(id => users.some(user => user.id === id))) {
      throw new AppError(409, 'DEMO_TEAM_DATABASE_NOT_ISOLATED', '仅允许专门新建的基础演示库；已有开发/运营库请通过员工账号页面正常创建与分工');
    }
    let created = 0;
    for (const user of DEMO_TEAM) {
      if (users.some(row => row.id === user.id)) continue;
      await database.prepare(`INSERT INTO users(id,username,password_hash,role,name,phone,status,job_type,created_at)
        VALUES(?,?,?,'staff',?,'','active',?,?)`).run(user.id, user.username, hashPassword('staff2026'), user.name, user.jobType, stamp);
      created++;
    }
    return { created, existing: DEMO_TEAM.length - created, assignedGuests: 0,
      note: '仅本地演示。已有账号密码/岗位不改；通过管理员入住管理及客人分工明确安排负责关系。' };
  });
}
