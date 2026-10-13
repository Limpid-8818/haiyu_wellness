import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
// Explicit target is mandatory, with no .env loading and no default user database.
const index = process.argv.indexOf('--database');
const target = index >= 0 ? process.argv[index + 1] : '';
if (!target || process.argv.indexOf('--local-demo') < 0) throw new Error('Usage: npm run demo:team -- --local-demo --database /absolute/path/to/dedicated-demo.sqlite');
if (!path.isAbsolute(target) || target === ':memory:') throw new Error('Pass an absolute dedicated demo SQLite path');
const marker = target + '.demo-team.json';
if (fs.existsSync(target)) {
  if (fs.lstatSync(target).isSymbolicLink()) throw new Error('Do not use a database symlink');
  if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker)).database !== target) {
    throw new Error('Existing database is not a dedicated demo created by this command; use normal employee management');
  }
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    const allowed = new Set(['guest_001','staff_001','dean_001','demo_admin','demo_coach','demo_therapist','demo_dietitian']);
    if (check.prepare('SELECT id FROM users').all().some(row => !allowed.has(row.id))) throw new Error('Non-demo accounts found; no database writes allowed');
  } finally { check.close(); }
} else if (fs.existsSync(marker)) throw new Error('Existing marker without database; choose a new dedicated path');
Object.assign(process.env, { DB_DRIVER: 'sqlite', DB_PATH: target, DEMO_SEED: '1', LLM_API_KEY: '', LLM_BASE_URL: '', ENVIRONMENT_LIVE: '0' });
const { db, transaction, hashPassword, now } = await import('../server/src/db.js');
const { initializeDemoTeam } = await import('../server/src/demo-team.js');
try {
  console.log(JSON.stringify(await initializeDemoTeam({ database: db, transact: transaction, hashPassword, stamp: now() })));
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ format: 'haiyu-dedicated-demo-v1', database: target }), { flag: 'wx' });
}
finally { await db.close(); }
