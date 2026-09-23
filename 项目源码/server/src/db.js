import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../data');
const dbPath = process.env.DB_PATH || path.join(dataDir, 'community-v2.sqlite');
fs.mkdirSync(dataDir, { recursive: true });
export const db = new DatabaseSync(dbPath);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('guest','staff','dean')), name TEXT NOT NULL,
    phone TEXT DEFAULT '', avatar TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS guest_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    gender TEXT DEFAULT '', birth_date TEXT DEFAULT '', room_no TEXT DEFAULT '',
    check_in TEXT DEFAULT '', check_out TEXT DEFAULT '', emergency_contact TEXT DEFAULT '',
    chronic_json TEXT NOT NULL DEFAULT '[]', allergies_json TEXT NOT NULL DEFAULT '[]',
    mobility TEXT DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS health_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    record_type TEXT NOT NULL, value TEXT NOT NULL, unit TEXT DEFAULT '', note TEXT DEFAULT '',
    recorded_at TEXT NOT NULL, recorded_by TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS medical_advice (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, content TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','important','urgent')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS news (
    id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL,
    summary TEXT NOT NULL, body TEXT NOT NULL, cover TEXT DEFAULT '', published_at TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
    target_type TEXT DEFAULT '', target_id TEXT DEFAULT '', detail TEXT DEFAULT '', created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS staff_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    dean_id TEXT NOT NULL REFERENCES users(id), content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS assistant_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    user_id TEXT, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS health_intakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'assistant', created_at TEXT NOT NULL
  );
`);

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}
export function verifyPassword(password, stored) {
  const [salt, expected] = String(stored || '').split(':');
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
export function id(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
export function now() { return new Date().toISOString(); }
export function json(value, fallback = []) { try { return JSON.parse(value); } catch { return fallback; } }
export function log(actorId, action, targetType = '', targetId = '', detail = '') {
  db.prepare('INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(actorId || null, action, targetType, targetId, detail, now());
}

function seed() {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (count) return;
  const guestId = 'guest_001';
  const staffId = 'staff_001';
  const deanId = 'dean_001';
  db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)')
    .run(guestId, 'guest_demo', hashPassword('guest2026'), 'guest', '林海宁', '13800000001');
  db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)')
    .run(staffId, 'staff_demo', hashPassword('staff2026'), 'staff', '王医生', '13800000002');
  db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)')
    .run(deanId, 'dean_demo', hashPassword('dean2026'), 'dean', '周院长', '13800000003');
  db.prepare(`INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(guestId, '女', '1958-06-18', 'A-203', '2026-09-12', '2026-09-26', '林先生 13900000001', JSON.stringify(['高血压']), JSON.stringify(['虾']), '可独立行走');
  const t = now();
  const rows = [
    ['健康管理','入住后的第一件事：建立自己的康养档案','先完成基础资料与健康状况登记，工作人员会据此安排服务。','欢迎来到海屿康养社区。完整的档案能帮助工作人员了解您的需要，所有信息仅在授权范围内使用。','2026-09-13T08:00:00Z',1],
    ['滨海活动','本周末海风漫步活动开放报名','沿着东湾海岸线慢行 90 分钟，适合大多数客人。','活动由康养服务团队带队，出发前会根据天气与身体情况进行确认。','2026-09-12T10:00:00Z',0],
    ['营养膳食','秋季海滨膳食菜单更新','低盐、易消化、时令食材，本周已上线。','餐单由营养师与配餐团队共同更新，客人可在个人空间查看适合自己的饮食提醒。','2026-09-10T09:00:00Z',0]
  ];
  const stmt = db.prepare('INSERT INTO news(category,title,summary,body,published_at,pinned) VALUES(?,?,?,?,?,?)');
  rows.forEach(r => stmt.run(...r));
  db.prepare('INSERT INTO health_records(guest_id,record_type,value,unit,note,recorded_at,recorded_by) VALUES(?,?,?,?,?,?,?)')
    .run(guestId, '血压', '138/86', 'mmHg', '晨起测量', '2026-09-14T07:30:00Z', staffId);
  db.prepare('INSERT INTO medical_advice(guest_id,author_id,title,content,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(guestId, staffId, '近期温泉安排', '近期血压略高，建议选择低温、短时温泉，单次不超过 15 分钟；如出现头晕或胸闷请立即停止并联系工作人员。', 'important', 'active', t, t);
}
seed();

export function publicUser(row) { return { id: row.id, username: row.username, role: row.role, name: row.name, phone: row.phone || '', avatar: row.avatar || '' }; }
export function guestProfile(userId) {
  const row = db.prepare('SELECT * FROM guest_profiles WHERE user_id=?').get(userId);
  if (!row) return null;
  return { ...row, chronic: json(row.chronic_json), allergies: json(row.allergies_json), chronic_json: undefined, allergies_json: undefined };
}
export function guestSummary(userId) {
  const user = db.prepare('SELECT id,name,username,phone,role,status FROM users WHERE id=?').get(userId);
  const profile = guestProfile(userId);
  const latestHealth = db.prepare('SELECT * FROM health_records WHERE guest_id=? ORDER BY recorded_at DESC LIMIT 5').all(userId);
  const advice = db.prepare("SELECT id,title,content,priority,status,created_at,updated_at FROM medical_advice WHERE guest_id=? AND status='active' ORDER BY created_at DESC").all(userId);
  return { ...publicUser(user), profile, health: latestHealth, advice };
}
