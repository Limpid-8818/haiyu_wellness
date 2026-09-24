import { hashPassword } from '../../server/src/password.js';
import { DatabaseSync } from 'node:sqlite';

export async function login(baseUrl, username, password, role) {
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
  return { status: response.status, data: await response.json().catch(() => ({})) };
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

export function addStaff(database, { id, username, name, password = 'quest-q6-staff-password' }) {
  database.prepare('INSERT INTO users(id,username,password_hash,role,name,status,phone) VALUES(?,?,?,?,?,?,?)')
    .run(id, username, hashPassword(password), 'staff', name, 'active', '13900000000');
}

export function addAudit(database, { actorId, action, targetType = 'staff', targetId = actorId, detail, createdAt }) {
  database.prepare(`INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at)
    VALUES(?,?,?,?,?,?)`).run(actorId, action, targetType, targetId, detail, createdAt);
}

export function addAdvice(database, { guestId = 'guest_001', authorId, title, createdAt = new Date().toISOString() }) {
  database.prepare(`INSERT INTO medical_advice
    (guest_id,author_id,title,content,priority,status,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(guestId, authorId, title, 'Q6 count fixture', 'normal', 'active', createdAt, createdAt);
}
