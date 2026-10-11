import assert from 'node:assert/strict';
import { formatProbe, freshSqlitePath, login, request, runNode, withBothDatabaseApis } from './q10-helpers.js';
import { databaseQuery } from './q10-helpers.js';

const probeCode = `
  import { db, migrationResult, migrate, runVersionedMigration } from './src/db.js';
  const first = await migrate();
  const second = await migrate();
  await db.prepare('UPDATE domain_knowledge SET source_name=?,source_url=? WHERE knowledge_id=?')
    .run('WHO Physical activity fact sheet', 'https://www.who.int/news-room/fact-sheets/detail/physical-activity', 'knowledge-exercise-02');
  await db.prepare('DELETE FROM schema_migrations WHERE version=7').run();
  const correction = await migrate();
  const correctedSource = await db.prepare('SELECT source_name,source_url FROM domain_knowledge WHERE knowledge_id=?')
    .get('knowledge-exercise-02');
  await db.prepare('UPDATE domain_knowledge SET source_name=?,source_url=? WHERE knowledge_id=?')
    .run('Reviewer-edited source', 'https://example.test/custom-source', 'knowledge-exercise-02');
  await db.prepare('DELETE FROM schema_migrations WHERE version=7').run();
  const preserveCustom = await migrate();
  const preservedSource = await db.prepare('SELECT source_name,source_url FROM domain_knowledge WHERE knowledge_id=?')
    .get('knowledge-exercise-02');
  let failure = '';
  try { await runVersionedMigration(98, 'synthetic-failure', async () => { throw new Error('expected migration failure'); }); }
  catch (error) { failure = error.message; }
  const bookingTables = Number((await db.prepare('SELECT COUNT(*) AS count FROM activity_slots').get()).count) === 0 &&
    Number((await db.prepare('SELECT COUNT(*) AS count FROM reservations').get()).count) === 0 &&
    Number((await db.prepare('SELECT COUNT(*) AS count FROM dishes').get()).count) > 0 &&
    Number((await db.prepare('SELECT COUNT(*) AS count FROM meal_menus').get()).count) === 0 &&
    Number((await db.prepare('SELECT COUNT(*) AS count FROM meal_orders').get()).count) === 0 ? 1 : 0;
  console.log('Q10_MIGRATION=' + JSON.stringify({initial: migrationResult.applied, first: first.applied, second: second.applied, correction: correction.applied, correctedSource, preserveCustom: preserveCustom.applied, preservedSource, bookingTables, failure}));
  await db.close();
`;

async function verifyMigrationProbe(driver, env) {
  const result = runNode(probeCode, { ...env, DB_DRIVER: driver, DEMO_SEED: '0' });
  const probe = formatProbe(result, 'Q10_MIGRATION=');
  assert.equal(probe.initial, 11, `${driver} fresh database should apply eleven versioned migrations`);
  assert.equal(probe.first, 0, `${driver} first rerun must apply zero migrations`);
  assert.equal(probe.second, 0, `${driver} second rerun must apply zero migrations`);
  assert.equal(probe.correction, 1, `${driver} v7 source correction should apply once`);
  assert.deepEqual(probe.correctedSource, {
    source_name: 'WHO Regional Office for Europe: Physical activity',
    source_url: 'https://www.who.int/europe/news-room/fact-sheets/item/physical-activity'
  });
  assert.equal(probe.preserveCustom, 1, `${driver} v7 should remain idempotent after simulating a source edit`);
  assert.deepEqual(probe.preservedSource, {
    source_name: 'Reviewer-edited source',
    source_url: 'https://example.test/custom-source'
  });
  assert.equal(probe.bookingTables, 1, `${driver} v9/v10 should create booking and meal tables without creating business records`);
  assert.match(probe.failure, /migration v098 \(synthetic-failure\) failed/);
}

export async function run() {
  const sqlite = await freshSqlitePath('haiyu-q10-migration-');
  try {
    await verifyMigrationProbe('sqlite', { DB_PATH: sqlite.path });
  } finally { await sqlite.cleanup(); }

  await withBothDatabaseApis(async context => {
    const guestLogin = await login(context.baseUrl, 'guest');
    const staffLogin = await login(context.baseUrl, 'staff');
    assert.equal(guestLogin.status, 200);
    assert.equal(staffLogin.status, 200);
    const changed = await request(context.baseUrl, '/me/profile', {
      method: 'PATCH', token: guestLogin.data.token, body: { phone: '13987650001' }
    });
    assert.equal(changed.status, 200);
    await databaseQuery(context, "DELETE FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'", [], 'run');
    const restartedBaseUrl = await context.restartApi();
    const revoked = await request(restartedBaseUrl, '/staff/guests/guest_001', { token: staffLogin.data.token });
    assert.equal(revoked.status, 403);
    assert.equal(revoked.data.code, 'GUEST_NOT_ASSIGNED');
    const profile = await request(restartedBaseUrl, '/me', { token: guestLogin.data.token });
    assert.equal(profile.data.phone, '13987650001');
    const count = await databaseQuery(context, "SELECT COUNT(*) AS count FROM staff_guest_assignments WHERE staff_id='staff_001' AND guest_id='guest_001'", [], 'get');
    assert.equal(Number(count.count), 0);
  });

  return { output: ['SQLite and MySQL v1–v11 migration repeats returned applied=0; v10 dish catalog seed remained idempotent', 'migration errors include the failed version', 'custom phone and revoked assignment survived restart'] };
}
