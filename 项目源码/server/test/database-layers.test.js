import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, { DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '0' });
const api = await import('../src/db.js');
const infrastructure = await import('../src/db-infrastructure.js');
const migrations = await import('../src/migrations.js');
const queries = await import('../src/guest-queries.js');
const { db, transaction, inTransaction, now } = api;
test.after(async () => { await db.close(); assert.equal(api.sqliteCachedStatementCount(), 0); });

test('G45: facade shares lower-layer instances and initialized result bindings', async () => {
  assert.equal(db, infrastructure.db);
  assert.equal(api.transaction, infrastructure.transaction);
  assert.equal(api.migrate, migrations.migrate);
  assert.equal(api.guestSummary, queries.guestSummary);
  assert.deepEqual(api.migrationResult, { applied: 29 });
  assert.deepEqual(api.demoSeedResult, { seeded: false, reason: 'DEMO_SEED is not enabled' });
  assert.deepEqual(await api.migrate(), { applied: 0 });
  assert.equal((await import('../src/db.js')).migrationResult, api.migrationResult);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM news').get()).n, 0);
});

test('G45: rollback, joining, nested rejection and await isolation survive the split', async () => {
  await db.exec('CREATE TABLE g45_isolation (n INTEGER PRIMARY KEY)');
  await assert.rejects(transaction(async () => {
    assert.equal(api.hasActiveTransaction(), true);
    await inTransaction(() => db.prepare('INSERT INTO g45_isolation VALUES(?)').run(1));
    await assert.rejects(transaction(async () => {}), /Nested database transactions/);
    throw new Error('rollback marker');
  }), /rollback marker/);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM g45_isolation').get()).n, 0);
  let entered, release;
  const ready = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const first = transaction(async () => {
    await db.prepare('INSERT INTO g45_isolation VALUES(?)').run(2);
    entered(); await gate; events.push('commit');
  });
  await ready;
  const outside = db.prepare('SELECT n FROM g45_isolation').all().then(rows => { events.push('read'); return rows; });
  const next = transaction(async () => { events.push('next'); await db.prepare('INSERT INTO g45_isolation VALUES(?)').run(3); });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, []);
  release();
  await Promise.all([first, next]);
  assert.equal((await outside)[0].n, 2);
  assert.equal(events[0], 'commit');
  assert.equal(api.hasActiveTransaction(), false);
});

test('G45: real v28 users schema upgrades atomically to v29, preserves data and labels failure', async () => {
  // Reconstruct the physical v28 boundary, not just its ledger: v28 has NO token_version column.
  await db.exec('ALTER TABLE users DROP COLUMN token_version');
  await db.prepare('DELETE FROM schema_migrations WHERE version=?').run(29);
  await db.prepare("INSERT INTO users(id,username,password_hash,role,name) VALUES(?,?,?,'guest',?)")
    .run('g45-legacy', 'g45-legacy', 'synthetic-legacy-password', '旧版样本');
  assert.equal((await db.prepare('PRAGMA table_info(users)').all()).some(row => row.name === 'token_version'), false);
  assert.equal((await db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).v, 28);
  await db.exec(`CREATE TRIGGER g45_reject_v29 BEFORE INSERT ON schema_migrations
    WHEN NEW.version=29 BEGIN SELECT RAISE(ABORT, 'synthetic ledger failure'); END`);
  await assert.rejects(api.migrate(), error => {
    assert.match(error.message, /migration v029 \(user-token-version\) failed: synthetic ledger failure/);
    assert.ok(error.cause); return true;
  });
  assert.equal((await db.prepare('PRAGMA table_info(users)').all()).some(row => row.name === 'token_version'), false);
  assert.equal(await db.prepare('SELECT version FROM schema_migrations WHERE version=29').get(), undefined);
  await db.exec('DROP TRIGGER g45_reject_v29');
  assert.deepEqual(await api.migrate(), { applied: 1 });
  const user = await db.prepare('SELECT * FROM users WHERE id=?').get('g45-legacy');
  assert.equal(user.token_version, 0);
  assert.equal(user.name, '旧版样本');
  assert.equal(user.password_hash, 'synthetic-legacy-password');
  assert.deepEqual(await api.migrate(), { applied: 0 });
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).n, 29);
});

test('G45: guest projections keep JSON fallback, active guest filter, stay status and health ordering', async () => {
  assert.equal(await api.guestProfile('missing'), null);
  assert.equal(await api.guestSummary('missing'), null);
  assert.equal(api.publicUser(null), null);
  assert.equal(api.publicUser({ role: 'staff' }).jobType, 'clinician');
  await db.prepare(`INSERT INTO guest_profiles(user_id,check_in,check_out,chronic_json,allergies_json,health_profile_json)
    VALUES(?,?,?,?,?,?)`).run('g45-legacy', '2099-01-01', '2099-01-15', 'broken', '["虾"]', 'broken');
  const profile = await api.guestProfile('g45-legacy');
  assert.deepEqual(profile.chronic, []);
  assert.deepEqual(profile.allergies, ['虾']);
  assert.deepEqual(profile.health_profile, {});
  assert.equal(profile.health_profile_version, 0);
  assert.equal(profile.chronic_json, undefined);
  for (let n = 1; n <= 7; n++) await db.prepare(`INSERT INTO health_records
    (guest_id,record_type,value,unit,recorded_at,recorded_by,structured_value_json,voided_at)
    VALUES(?,?,?,?,?,?,?,?)`).run('g45-legacy', '步数', String(n), '步', '2030-01-01T00:00:00.000Z',
    'g45-legacy', n === 6 ? 'invalid-json' : JSON.stringify({ n }), n === 7 ? now() : null);
  const summary = await api.guestSummary('g45-legacy');
  assert.equal(summary.admissionStatus, 'pending');
  assert.deepEqual(summary.health.map(row => row.value), ['6', '5', '4', '3', '2']);
  assert.equal(summary.health[0].structured_value_json, null);
  assert.deepEqual(summary.health[1].structured_value_json, { n: 5 });
  await db.prepare('UPDATE users SET status=? WHERE id=?').run('disabled', 'g45-legacy');
  assert.equal(await api.guestSummary('g45-legacy'), null);
  assert.ok(await api.guestProfile('g45-legacy'));
});
