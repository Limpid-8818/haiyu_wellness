import http from 'node:http';
import { hashPassword } from '../../server/src/password.js';
export { login, request, withDatabase } from './q6-helpers.js';

export function addGuest(database, { id, username, name, password = 'quest-q7-guest-password', allergies = [] }) {
  database.prepare('INSERT INTO users(id,username,password_hash,role,name,status,phone) VALUES(?,?,?,?,?,?,?)')
    .run(id, username, hashPassword(password), 'guest', name, 'active', '13800000009');
  database.prepare(`INSERT INTO guest_profiles
    (user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, '女', '1960-01-01', 'Q7-01', '2026-09-01', '2026-09-30', '', '[]', JSON.stringify(allergies), '可独立行走');
}

export function addAssignment(database, { staffId = 'staff_001', guestId, deanId = 'dean_001' }) {
  const stamp = '2026-09-01T00:00:00.000Z';
  database.prepare(`INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(staffId, guestId, stamp, null, 'active', deanId, stamp, stamp);
}

export async function withModelStub(handler, callback) {
  const received = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', async () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* preserve empty body */ }
      const captured = { method: request.method, url: request.url, headers: request.headers, body };
      received.push(captured);
      try {
        const plan = await handler(captured);
        if (plan.delayMs) await new Promise(resolve => setTimeout(resolve, plan.delayMs));
        if (response.destroyed) return;
        response.statusCode = plan.status || 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(plan.body ?? {}));
      } catch {
        if (!response.destroyed) {
          response.statusCode = 500;
          response.end('{}');
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    return await callback({ baseUrl: `http://127.0.0.1:${address.port}/v1`, received });
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}
