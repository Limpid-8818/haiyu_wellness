// Isolated synthetic app.listen only; never import index.js or run schedulers.
import app from '../../server/src/app.js';
import { db } from '../../server/src/db.js';
import { generateGuestMenu } from '../../server/src/meals.js';
import { systemBusinessClock } from '../../server/src/clock.js';
import { hashPasswordAsync } from '../../server/src/password.js';
const stamp = new Date().toISOString();
const password = await hashPasswordAsync('Synthetic-G28-123');
for (const [id, role, name, job] of [['g28-guest', 'guest', '合成G28客人', null], ['g28-admin', 'staff', '合成G28管理员', 'administrator'], ['g28-coach', 'staff', '合成G28教练', 'coach']]) {
  await db.prepare('INSERT INTO users(id,username,password_hash,role,name,status,job_type,created_at) VALUES(?,?,?,?,?,\'active\',?,?)').run(id, id, password, role, name, job, stamp);
}
await db.prepare(`INSERT INTO guest_profiles(user_id,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility,updated_at)
  VALUES('g28-guest','G28','2026-10-19','2099-10-20','','[]','[]','可独立行走',?)`).run(stamp);
const project = await db.prepare('SELECT id FROM projects WHERE outdoor=0 AND active=1 LIMIT 1').get();
if (!project) throw new Error('synthetic catalog has no indoor project');
await db.prepare(`INSERT INTO activity_slots(id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,created_at,updated_at)
  VALUES('g28-slot',?,'2099-10-19','2099-10-19T02:00:00.000Z','2099-10-19T03:00:00.000Z','10:00','11:00',4,?,?)`).run(project.id, stamp, stamp);
await db.prepare(`INSERT INTO reservations(id,guest_id,slot_id,idempotency_key,request_fingerprint,status,created_at,environment_snapshot_id,availability_status,availability_reason)
  VALUES('g28-res','g28-guest','g28-slot','g28-key','g28-fixture','confirmed',?,'g28-synthetic','available','合成验收')`).run(stamp);
await generateGuestMenu('g28-guest', systemBusinessClock.dateKey());
const server = app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('G28_API_READY'));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
  await db.close();
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
