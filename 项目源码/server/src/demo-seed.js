import { db, transaction } from './db-infrastructure.js';
import { hashPassword, now } from './db-values.js';
import { shiftDateKey, systemBusinessClock } from './clock.js';

export async function seedDemo() {
  const count = Number((await db.prepare('SELECT COUNT(*) AS count FROM users').get()).count);
  if (count) return { seeded: false, reason: 'users already exist' };
  const guestId = 'guest_001';
  const staffId = 'staff_001';
  const deanId = 'dean_001';
  const stamp = now();
  const demoCheckIn = systemBusinessClock.dateKey();
  const demoCheckOut = shiftDateKey(demoCheckIn, 14);
  await transaction(async () => {
    await db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)')
      .run(guestId, 'guest_demo', hashPassword('guest2026'), 'guest', '林海宁', '13800000001');
    await db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone,job_type) VALUES(?,?,?,?,?,?,?)')
      .run(staffId, 'staff_demo', hashPassword('staff2026'), 'staff', '王医生', '13800000002', 'clinician');
    await db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)')
      .run(deanId, 'dean_demo', hashPassword('dean2026'), 'dean', '周院长', '13800000003');
    await db.prepare(`INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(guestId, '女', '1958-06-18', 'A-203', demoCheckIn, demoCheckOut, '林先生 13900000001', JSON.stringify(['高血压']), JSON.stringify(['虾']), '可独立行走');
    await db.prepare(`INSERT INTO staff_guest_assignments
      (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(staffId, guestId, stamp, null, 'active', deanId, stamp, stamp);
    const rows = [
      ['健康管理','入住后的第一件事：建立自己的康养档案','先完成基础资料与健康状况登记，工作人员会据此安排服务。','欢迎来到海屿康养社区。完整的档案能帮助工作人员了解您的需要，所有信息仅在授权范围内使用。','2026-09-13T08:00:00.000Z',1],
      ['滨海活动','本周末海风漫步活动开放报名','沿着东湾海岸线慢行 90 分钟，适合大多数客人。','活动由康养服务团队带队，出发前会根据天气与身体情况进行确认。','2026-09-12T10:00:00.000Z',0],
      ['营养膳食','秋季海滨膳食菜单更新','低盐、易消化、时令食材，本周已上线。','餐单由营养师与配餐团队共同更新，客人可在个人空间查看适合自己的饮食提醒。','2026-09-10T09:00:00.000Z',0]
    ];
    for (const row of rows) {
      await db.prepare('INSERT INTO news(category,title,summary,body,published_at,pinned) VALUES(?,?,?,?,?,?)').run(...row);
    }
    await db.prepare(`INSERT INTO health_records
      (guest_id,record_type,value,unit,note,recorded_at,recorded_by,source,created_at,structured_value_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      guestId, '血压', '138/86', 'mmHg', '晨起测量', '2026-09-14T07:30:00.000Z', staffId, 'staff', stamp,
      JSON.stringify({ schemaVersion: 1, metricKey: 'blood_pressure', unit: 'mmHg', values: { systolic: 138, diastolic: 86 }, rawValue: '138/86', parseStatus: 'valid', ruleVersion: 'health-metric-v1' })
    );
    await db.prepare('INSERT INTO medical_advice(guest_id,author_id,title,content,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(guestId, staffId, '近期温泉安排', '近期血压略高，建议选择低温、短时温泉，单次不超过 15 分钟；如出现头晕或胸闷请立即停止并联系工作人员。', 'important', 'active', stamp, stamp);
  });
  return { seeded: true };
}
