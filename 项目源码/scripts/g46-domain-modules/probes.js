import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ResourceSession } from '../resources/resource-runtime.js';
const out = process.env.G46_AUDIT_ROOT, attempt = process.env.G46_ATTEMPT;
const mode = process.argv[2];
assert.ok(out && attempt && process.env.CODEX_TASK_ID);
if (mode === 'migration') {
  const { db, migrate, migrationResult, sqliteCachedStatementCount } = await import('../../server/src/db.js');
  const phase = process.argv[3];
  const structure = {};
  for (const { name } of await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    structure[name] = { columns: await db.prepare(`PRAGMA table_info(${name})`).all(),
      foreignKeys: await db.prepare(`PRAGMA foreign_key_list(${name})`).all(), indexes: await db.prepare(`PRAGMA index_list(${name})`).all() };
  }
  const ledger = await db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
  assert.equal(ledger.length, 29); assert.deepEqual(await migrate(), { applied: 0 });
  assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal((await db.prepare('PRAGMA foreign_keys').get()).foreign_keys, 1);
  const file = path.join(out, `${attempt}-${phase}.json`);
  if (phase === 'new') {
    assert.deepEqual(migrationResult, { applied: 29 });
    await db.prepare("INSERT INTO users(id,username,password_hash,role,name) VALUES('g46-legacy','g46-legacy','synthetic','guest','合成旧版')").run();
    // Physical v28 boundary: remove both the added column and v29 ledger entry.
    await db.exec('ALTER TABLE users DROP COLUMN token_version');
    await db.prepare('DELETE FROM schema_migrations WHERE version=?').run(29);
    assert.ok(!(await db.prepare('PRAGMA table_info(users)').all()).some(c => c.name === 'token_version'));
  } else {
    assert.deepEqual(migrationResult, { applied: phase === 'upgrade' ? 1 : 0 });
    assert.equal((await db.prepare("SELECT token_version FROM users WHERE id='g46-legacy'").get()).token_version, 0);
    const before = JSON.parse(fs.readFileSync(path.join(out, `${attempt}-new.json`)));
    assert.deepEqual(JSON.parse(JSON.stringify(structure)), before.structure);
    assert.deepEqual(JSON.parse(JSON.stringify(ledger)), before.ledger);
  }
  await db.close(); assert.equal(sqliteCachedStatementCount(), 0);
  fs.writeFileSync(file, JSON.stringify({ status: 'PASS', phase, migrationResult, repeat: { applied: 0 },
    structure, ledger, physicalV28Created: phase === 'new', foreignKeys: true, cacheAfterClose: 0 }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'PASS', phase, migrationResult, tables: Object.keys(structure).length, file }));
} else if (mode === 'build') {
  const directory = process.env.G46_BUILD_ROOT;
  assert.ok(directory && directory.startsWith('/tmp/haiyu-resource-'));
  const { build } = await import('vite');
  const result = await build({ root: path.resolve('web'), envDir: directory,
    cacheDir: path.join(directory, 'cache'), build: { outDir: path.join(directory, 'dist'), emptyOutDir: true } });
  assert.ok(fs.existsSync(path.join(directory, 'dist/index.html')));
  console.log(JSON.stringify({ status: 'PASS', outputFiles: result.output.length, outDir: path.join(directory, 'dist'), privateEnvRead: false }));
} else {
  assert.ok(['migrations', 'web'].includes(mode));
  const session = await ResourceSession.create({ taskId: process.env.CODEX_TASK_ID,
    auditRoot: path.join(out, 'runtime', `${attempt}-probes`),
    limits: { leaseMs: 900000, logBytes: 8388608, directoryBytes: 536870912 } });
  try {
    const directory = await session.allocateDir(mode === 'web' ? 'web-build' : 'synthetic-databases');
    const phases = mode === 'web' ? ['build'] : ['new', 'upgrade', 'restart'];
    for (const phase of phases) {
      const result = await session.runProcess({ command: process.execPath,
        args: ['scripts/g46-domain-modules/probes.js', mode === 'web' ? 'build' : 'migration', phase],
        label: phase, kind: 'test', role: 'test', cwd: process.cwd(), datadir: directory,
        env: { ...process.env, DB_PATH: path.join(directory, 'nested/fresh/community.sqlite'),
          G46_BUILD_ROOT: directory, HAIYU_VITE_CACHE_DIR: path.join(directory, 'cache'), DEMO_SEED: '0' }
      }, { timeoutMs: 35000 });
      fs.writeFileSync(path.join(out, `${attempt}-${phase}-process.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      assert.equal(result.exitCode, 0, result.tail); assert.equal(result.timedOut, false); assert.equal(result.signal, null);
    }
  } finally {
    const cleanup = await session.close('g46-probes-complete'); assert.equal(cleanup.ok, true);
  }
}
