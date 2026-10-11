import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../../server/src/password.js';
import { sqliteCoreSchema } from '../../server/src/schema.js';
import { sqliteCatalogSchema } from '../../server/src/catalog-schema.js';
import { sqliteBookingSchema } from '../../server/src/booking-schema.js';
import { sqliteMealSchema } from '../../server/src/meal-schema.js';

const synthetic = {
  guest: { id: 'synthetic_guest_001', username: 'synthetic_guest', role: 'guest', name: '合成客人', phone: '13912345678', password: 'synthetic-guest-pass' },
  unassignedGuest: { id: 'synthetic_guest_002', username: 'synthetic_guest_two', role: 'guest', name: '未分配合成客人', phone: '13912345677', password: 'synthetic-guest-two-pass' },
  staff: { id: 'synthetic_staff_001', username: 'synthetic_staff', role: 'staff', name: '合成工作人员', phone: '13912345679', password: 'synthetic-staff-pass' },
  dean: { id: 'synthetic_dean_001', username: 'synthetic_dean', role: 'dean', name: '合成院长', phone: '13912345680', password: 'synthetic-dean-pass' }
};

const demo = {
  guest: { id: 'guest_001', username: 'guest_demo', role: 'guest', name: '演示客人', phone: '13800000001', password: 'guest2026' },
  unassignedGuest: { id: 'guest_002', username: 'guest_demo_two', role: 'guest', name: '未分配演示客人', phone: '13800000004', password: 'guesttwo2026' },
  staff: { id: 'staff_001', username: 'staff_demo', role: 'staff', name: '演示工作人员', phone: '13800000002', password: 'staff2026' },
  dean: { id: 'dean_001', username: 'dean_demo', role: 'dean', name: '演示院长', phone: '13800000003', password: 'dean2026' }
};

export function fixtureAccounts(mode = 'synthetic') {
  return structuredClone(mode === 'demo' ? demo : synthetic);
}

export function createSqliteSnapshot(snapshotPath, mode = 'synthetic') {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  const accounts = fixtureAccounts(mode);
    const guest = accounts.guest;
    const unassignedGuest = accounts.unassignedGuest;
    const staff = accounts.staff;
  const dean = accounts.dean;
  const db = new DatabaseSync(snapshotPath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(sqliteCoreSchema);
    db.exec(sqliteCatalogSchema);
    db.exec(sqliteBookingSchema);
    db.exec(sqliteMealSchema);
    db.exec("ALTER TABLE health_intakes ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
    const stamp = '2026-09-20T09:00:00.000Z';
    db.prepare(`INSERT INTO projects(id,slug,name,category,intensity,location,description,suitable_people,contraindications,
      open_windows_json,capacity_per_window,sea_entry,outdoor,activity_tag,active,is_demo,source_reference,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'project-sea-bath', 'sea-bath', '合成海水浴', 'water_therapy', null, '合成体验区', 'Synthetic project.',
      'Synthetic visitors.', 'Synthetic restrictions.', JSON.stringify({ windows: [{ days: ['每日'], start: '09:00', end: '11:00' }], demo: true }),
      8, 1, 1, 'sea_bath', 1, 1, 'Synthetic fixture only.', stamp, stamp
    );
    const insertUser = db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)');
    for (const user of [guest, unassignedGuest, staff, dean]) {
      insertUser.run(user.id, user.username, hashPassword(user.password), user.role, user.name, user.phone);
    }
    db.prepare(`INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(guest.id, '未知', '1950-01-01', 'S-001', '2026-09-10', '2026-10-10', '合成紧急联系人', '["synthetic-condition"]', '["synthetic-allergy"]', '可独立行走', stamp);
    db.prepare("INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(unassignedGuest.id, '未知', '1955-02-02', 'S-002', '2026-09-11', '2026-10-11', '', '[]', '[]', '可独立行走', stamp);
    db.prepare(`INSERT INTO staff_guest_assignments(id,staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(61, staff.id, guest.id, '2026-09-01T00:00:00.000Z', null, 'closed', dean.id, stamp, stamp);
    db.prepare(`INSERT INTO health_records(id,guest_id,record_type,value,unit,note,recorded_at,recorded_by)
      VALUES(?,?,?,?,?,?,?,?)`).run(71, guest.id, 'synthetic-vital', '138/86', 'mmHg', 'synthetic fixture', stamp, staff.id);
    db.prepare(`INSERT INTO medical_advice(id,guest_id,author_id,title,content,priority,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(81, guest.id, staff.id, 'synthetic advice', 'Synthetic advisory text.', 'normal', 'active', stamp, stamp);
    db.prepare(`INSERT INTO news(id,category,title,summary,body,cover,published_at,pinned)
      VALUES(?,?,?,?,?,?,?,?)`).run(91, 'synthetic', 'synthetic news', 'synthetic summary', 'Synthetic news body.', '', stamp, 1);
    db.prepare(`INSERT INTO audit_logs(id,actor_id,action,target_type,target_id,detail,created_at)
      VALUES(?,?,?,?,?,?,?)`).run(101, staff.id, 'synthetic.action', 'guest', guest.id, 'synthetic audit detail', stamp);
    db.prepare(`INSERT INTO staff_reviews(id,staff_id,dean_id,content,created_at)
      VALUES(?,?,?,?,?)`).run(111, staff.id, dean.id, 'Synthetic review.', stamp);
    const sessionId = 'as_123e4567-e89b-12d3-a456-426614174000';
    db.prepare(`INSERT INTO assistant_sessions(id,user_id,assistant_role,related_guest_id,status,started_at,last_message_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(sessionId, guest.id, 'guest', guest.id, 'active', stamp, stamp, '2027-01-01T00:00:00.000Z');
    db.prepare(`INSERT INTO assistant_messages(id,session_id,user_id,role,content,created_at) VALUES(?,?,?,?,?,?)`)
      .run(121, sessionId, guest.id, 'user', 'Synthetic user message.', stamp);
    db.prepare(`INSERT INTO assistant_messages(id,session_id,user_id,role,content,created_at) VALUES(?,?,?,?,?,?)`)
      .run(122, sessionId, guest.id, 'assistant', 'Synthetic assistant reply.', '2026-09-20T09:00:01.000Z');
    db.prepare(`INSERT INTO health_intakes(id,guest_id,session_id,content,source,created_at,status) VALUES(?,?,?,?,?,?,?)`)
      .run(131, guest.id, sessionId, 'Synthetic pending health intake.', 'assistant', stamp, 'pending');
    db.prepare(`INSERT INTO activity_slots(id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      'synthetic_slot_001', 'project-sea-bath', '2026-09-21', '2026-09-21T01:00:00.000Z', '2026-09-21T02:00:00.000Z',
      '09:00', '10:00', 8, 0, stamp, stamp
    );
    db.prepare(`INSERT INTO reservations(id,guest_id,slot_id,idempotency_key,request_fingerprint,status,created_at,cancelled_at,
      cancellation_reason,environment_snapshot_id,availability_status,availability_reason,is_demo)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      'synthetic_reservation_001', guest.id, 'synthetic_slot_001', 'synthetic-key-001', 'a'.repeat(64), 'confirmed', stamp,
      null, null, 'stage15-controlled-snapshot', 'available', 'Synthetic fixture booking.', 1
    );
    const issues = db.prepare('PRAGMA foreign_key_check').all();
    if (issues.length) throw new Error(`synthetic snapshot contains ${issues.length} foreign-key violations`);
  } finally { db.close(); }
  return { accounts, sessionId: 'as_123e4567-e89b-12d3-a456-426614174000' };
}
