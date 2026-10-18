import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as api from '../../server/src/db.js';
import { initializeDemoTeam } from '../../server/src/demo-team.js';

const { db, migrate, guestProfile, guestSummary, publicUser } = api;
try {
  const schema = await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  const tables = schema.filter(row => row.type === 'table').map(row => row.name);
  const structure = {};
  for (const table of tables) structure[table] = {
    columns: await db.prepare(`PRAGMA table_info(${table})`).all(),
    foreignKeys: await db.prepare(`PRAGMA foreign_key_list(${table})`).all(),
    indexes: await db.prepare(`PRAGMA index_list(${table})`).all()
  };
  // Normalize only generated salts and identified wall-clock fields; preserve every other field.
  const stampFields = new Set(['created_at', 'updated_at', 'source_checked_at', 'applied_at']);
  const normalize = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key, key === 'password_hash' ? '<salted-password>' : stampFields.has(key) && value ? '<generated-stamp>' : value])));
  const data = {};
  for (const table of ['schema_migrations', 'projects', 'domain_knowledge', 'safety_rules', 'dishes',
    'job_capability_settings', 'users', 'news']) {
    data[table] = normalize(await db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
  }
  const summary = await guestSummary('guest_001');
  if (summary) {
    summary.health = normalize(summary.health);
    summary.advice = normalize(summary.advice);
    summary.profile = normalize([summary.profile])[0];
  }
  const result = { exports: Object.keys(api), migrationResult: api.migrationResult, demoSeed: api.demoSeed,
    demoSeedResult: api.demoSeedResult, schema, structure, data, summary,
    missingProfile: await guestProfile('missing'), missingSummary: await guestSummary('missing'),
    publicNull: publicUser(null), publicStaff: publicUser({ id: 's', role: 'staff', name: 'staff' }),
    repeat: await migrate(), foreignKeyCheck: await db.prepare('PRAGMA foreign_key_check').all() };
  assert.deepEqual(result.repeat, { applied: 0 });
  assert.equal(data.schema_migrations.length, 29);
  if (api.demoSeed) {
    result.passwords = await Promise.all([['guest_demo', 'guest2026'], ['staff_demo', 'staff2026'], ['dean_demo', 'dean2026']]
      .map(async ([name, password]) => api.verifyPassword(password,
        (await db.prepare('SELECT password_hash FROM users WHERE username=?').get(name)).password_hash)));
    assert.ok(result.passwords.every(Boolean));
    result.team = await initializeDemoTeam({ database: db, transact: api.transaction, hashPassword: api.hashPassword, stamp: api.now() });
  } else {
    await assert.rejects(initializeDemoTeam({ database: db, transact: api.transaction, hashPassword: api.hashPassword, stamp: api.now() }),
      { code: 'DEMO_TEAM_DATABASE_NOT_ISOLATED' });
    result.teamRejected = true;
  }
  fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ snapshot: process.argv[2], migrations: data.schema_migrations.length,
    applied: api.migrationResult.applied, users: data.users.length, news: data.news.length }));
} finally {
  await db.close();
  assert.equal(api.sqliteCachedStatementCount(), 0);
}
