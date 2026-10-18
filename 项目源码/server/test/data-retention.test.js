import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runDataRetention, utcMillis } from '../src/data-retention.js';
import { retentionCli } from '../scripts/data-retention.js';
import { retentionContract } from './support/data-retention-contract.js';

test('disabled/invalid/apply gate opens no database, including CLI with absent configuration', async () => {
  let opened = 0;
  const openDatabase = async () => { opened++; throw new Error('must never open'); };
  assert.equal((await runDataRetention({ openDatabase })).status, 'DISABLED');
  assert.equal((await retentionCli([], {}, { openDatabase })).status, 'DISABLED');
  for (const input of [{ runDays: 0 }, { runDays: -1 }, { runDays: NaN }, { runDays: 1.2 }, { batchSize: 1001 },
    { enabled: 'true' }, { auditEnabled: 1 }, { surprise: true }, { scanRows: 20001 }]) {
    await assert.rejects(runDataRetention({ config: input, openDatabase }), /RETENTION_INVALID/);
  }
  await assert.rejects(runDataRetention({ config: { enabled: true }, mode: 'apply', openDatabase }), /explicit maintenance/);
  await assert.rejects(runDataRetention({ mode: 'apply', maintenance: true, openDatabase }), /requires enabled/);
  for (const flags of [['--apply'], ['--enabled', '--apply'], ['--run-days', 'NaN'], ['--enabled', '--preview', '--apply'], ['--enabled', '--unknown']]) {
    await assert.rejects(retentionCli(flags, {}, { openDatabase }), /RETENTION_INVALID/);
  }
  assert.equal(opened, 0);
  for (const value of ['2020-02-30T00:00:00Z', '2020-01-01', '2020-01-01T00:00:00+00:00', 'unknown']) assert.ok(Number.isNaN(utcMillis(value)));
});

test('existing-only adapter refuses default/missing DB and preview is enforced read-only', async () => {
  const { existingDatabaseConfig, openExistingRetentionDatabase } = await import('../src/data-retention-connection.js');
  const { DatabaseSync } = await import('node:sqlite');
  const directory = fs.mkdtempSync(path.join(process.env.RESOURCE_TMPDIR || os.tmpdir(), 'g42-connection-'));
  const filename = path.join(directory, 'existing.sqlite'), missing = path.join(directory, 'missing.sqlite');
  let opened;
  try {
    assert.throws(() => existingDatabaseConfig({}), /explicit DB_DRIVER/);
    assert.throws(() => existingDatabaseConfig({ DB_DRIVER: 'sqlite' }), /absolute existing/);
    assert.throws(() => existingDatabaseConfig({ DB_DRIVER: 'sqlite', DB_PATH: ':memory:' }), /absolute existing/);
    assert.throws(() => existingDatabaseConfig({ DB_DRIVER: 'mysql', MYSQL_PORT: '3306' }), /explicit MYSQL/);
    await assert.rejects(retentionCli(['--enabled'], {}), /RETENTION_DATABASE_CONFIG/);
    await assert.rejects(openExistingRetentionDatabase({ driver: 'sqlite', filename: missing }, { readOnly: false }));
    assert.equal(fs.existsSync(missing), false);
    const original = new DatabaseSync(filename); original.exec('CREATE TABLE guard(id INTEGER PRIMARY KEY); INSERT INTO guard VALUES(1)'); original.close();
    const before = fs.readFileSync(filename);
    opened = await openExistingRetentionDatabase({ driver: 'sqlite', filename }, { readOnly: true });
    await assert.rejects(opened.db.prepare('DELETE FROM guard WHERE id=?').run(1), /readonly/);
    await opened.close(); opened = null;
    assert.deepEqual(fs.readFileSync(filename), before);
  } finally { if (opened) await opened.close(); fs.rmSync(directory, { recursive: true }); }
});

test('actual SQLite v29 shared retention contract', async t => {
  Object.assign(process.env, { DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '0' });
  const database = await import('../src/db.js');
  try {
    const result = await retentionContract(database, (name, action) => t.test(name, action));
    assert.equal(result.passed, 20); t.diagnostic(JSON.stringify(result));
  } finally { await database.db.close(); }
});
