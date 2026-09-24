import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../../server/src/password.js';

export async function login(baseUrl, username = 'staff_demo', password = 'staff2026', role = 'staff') {
  const result = await request(baseUrl, '/auth/login', {
    method: 'POST',
    body: { username, password, role }
  });
  if (result.status !== 200) throw new Error(`login ${username} failed: HTTP ${result.status} ${JSON.stringify(result.data)}`);
  return result.data.token;
}

export async function request(baseUrl, route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

export function withDatabase(databasePath, callback) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys=ON');
    return callback(database);
  } finally {
    database.close();
  }
}

export function addUser(database, { id, username, role, name, status = 'active', password = 'quest-test-password', phone = '' }) {
  database.prepare('INSERT INTO users(id,username,password_hash,role,name,status,phone) VALUES(?,?,?,?,?,?,?)')
    .run(id, username, hashPassword(password), role, name, status, phone);
}

export function addGuest(database, { id, username = `${id}_user`, name = '验收客人', status = 'active', roomNo = 'Q5-001' }) {
  addUser(database, { id, username, role: 'guest', name, status, phone: '13900000000' });
  database.prepare(`INSERT INTO guest_profiles
    (user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, '女', '1958-06-18', roomNo, '2026-09-01', '2026-10-01', '验收联系人 13900000001',
    JSON.stringify(['高血压']), JSON.stringify(['虾']), '需陪同', new Date().toISOString()
  );
  return id;
}

export function addAssignment(database, { staffId = 'staff_001', guestId, startAt = new Date(Date.now() - 60_000).toISOString(), endAt = null, status = 'active', createdBy = 'dean_001' }) {
  const stamp = new Date().toISOString();
  const result = database.prepare(`INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(staffId, guestId, startAt, endAt, status, createdBy, stamp, stamp);
  return Number(result.lastInsertRowid);
}

export function addAdvice(database, { guestId, authorId = 'staff_001', title, content = '独立 Quest 测试建议内容。', status = 'active', createdAt = new Date().toISOString() }) {
  const result = database.prepare(`INSERT INTO medical_advice
    (guest_id,author_id,title,content,priority,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(guestId, authorId, title, content, 'normal', status, createdAt, createdAt);
  return Number(result.lastInsertRowid);
}

export function addHealthRecord(database, { guestId, type = '血压', value = '128/82', recordedAt = new Date().toISOString() }) {
  database.prepare(`INSERT INTO health_records
    (guest_id,record_type,value,unit,note,recorded_at,recorded_by)
    VALUES(?,?,?,?,?,?,?)`).run(guestId, type, value, 'mmHg', 'Q5 独立 Quest 健康样本', recordedAt, 'staff_001');
}
