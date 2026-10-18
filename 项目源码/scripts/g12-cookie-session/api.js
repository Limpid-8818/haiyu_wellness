// Synthetic app.listen fixture only: never imports index.js or starts scheduler.
import app from '../../server/src/app.js';
import { db } from '../../server/src/db.js';
import { hashPasswordAsync } from '../../server/src/password.js';
const id = 'g12-browser-guest';
const stamp = new Date().toISOString();
await db.prepare("INSERT INTO users(id,username,password_hash,role,name,status,created_at) VALUES(?,?,?,'guest',?,'active',?)")
  .run(id, 'g12_browser', await hashPasswordAsync('Synthetic-G12-123'), '合成G12浏览器客人', stamp);
await db.prepare(`INSERT INTO guest_profiles(user_id,emergency_contact,chronic_json,allergies_json,mobility,updated_at)
  VALUES(?,'','[]','[]','',?)`).run(id, stamp);
const server = app.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('G12_API_READY'));
let closing = false;
async function close() {
  if (closing) return; closing = true;
  server.closeIdleConnections();
  await new Promise(resolve => server.close(resolve));
  await db.close();
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
