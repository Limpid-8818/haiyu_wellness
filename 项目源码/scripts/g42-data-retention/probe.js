import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { retentionContract } from '../../server/test/support/data-retention-contract.js';
import { retentionSchemaTables } from '../../server/src/data-retention.js';
import { existingDatabaseConfig, openExistingRetentionDatabase } from '../../server/src/data-retention-connection.js';

const out = process.env.G42_AUDIT_ROOT, attempt = process.env.G42_ATTEMPT;
assert.ok(out && attempt && process.env.RESOURCE_TMPDIR && process.env.CODEX_TASK_ID);
const destination = process.argv[2] || path.join(out, `${attempt}-contract.json`);
if (process.env.DB_DRIVER !== 'mysql') process.env.DB_PATH = path.join(process.env.RESOURCE_TMPDIR, 'g42-synthetic.sqlite');
const report = { status: 'FAIL', taskId: process.env.CODEX_TASK_ID, hostId: 'local', cli: [] };
let database;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
async function snapshot() {
  const connection = await openExistingRetentionDatabase(existingDatabaseConfig(process.env), { readOnly: true });
  try {
    const all = {};
    for (const table of retentionSchemaTables) all[table] = await connection.db.prepare(`SELECT * FROM ${table}`).all();
    return digest(JSON.stringify(all));
  } finally { await connection.close(); }
}
function cli(name, flags, expected) {
  const result = spawnSync(process.execPath, ['server/scripts/data-retention.js', ...flags], {
    env: process.env, cwd: process.cwd(), encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024
  });
  const stdout = path.join(out, `${attempt}-cli-${name}.stdout.json`), stderr = path.join(out, `${attempt}-cli-${name}.stderr.txt`);
  fs.writeFileSync(stdout, result.stdout, { flag: 'wx' }); fs.writeFileSync(stderr, result.stderr, { flag: 'wx' });
  report.cli.push({ name, flags, exitCode: result.status, signal: result.signal, stdout, stdoutBytes: Buffer.byteLength(result.stdout),
    stderr, stderrBytes: Buffer.byteLength(result.stderr) });
  assert.equal(result.status, expected, result.stdout + result.stderr); assert.equal(result.signal, null);
  return expected === 0 ? JSON.parse(result.stdout) : null;
}
try {
  database = await import('../../server/src/db.js');
  report.driver = database.driver; report.migrations = database.migrationResult;
  assert.equal(report.migrations.applied, 29); assert.equal((await database.migrate()).applied, 0); report.repeatMigrations = 0;
  const fixture = `as_${crypto.randomUUID()}`, old = '2020-01-01T00:00:00.000Z';
  await database.db.prepare(`INSERT INTO assistant_sessions(id,assistant_role,status,started_at,last_message_at,expires_at)
    VALUES(?,'public','closed',?,?,?)`).run(fixture, old, old, old);
  await database.db.close(); report.applicationConnectionClosedForCli = true;
  const before = await snapshot();
  const preview = cli('preview', ['--enabled'], 0);
  assert.equal(preview.status, 'PREVIEW'); assert.equal(preview.tables.assistant_sessions.selected, 1);
  report.previewRowsUnchanged = before === await snapshot(); assert.equal(report.previewRowsUnchanged, true);
  cli('apply-refused', ['--enabled', '--apply'], 1); assert.equal(await snapshot(), before);
  const applied = cli('apply', ['--enabled', '--apply', '--maintenance'], 0);
  assert.equal(applied.status, 'APPLIED'); assert.equal(applied.tables.assistant_sessions.deleted, 1);
  const repeated = cli('repeat', ['--enabled', '--apply', '--maintenance'], 0);
  assert.equal(Object.values(repeated.tables).reduce((sum, row) => sum + row.deleted, 0), 0);
  report.cliCounts = { previewSelected: preview.tables.assistant_sessions.selected, applyDeleted: applied.tables.assistant_sessions.deleted,
    repeatedDeleted: Object.values(repeated.tables).reduce((sum, row) => sum + row.deleted, 0) };
  // The real CLI uses its real clock. Run it on the initial isolated old fixture,
  // before the fixed-clock contract introduces a deliberate cutoff-equality row.
  await (await import('../../server/src/db-infrastructure.js')).initializeConnection();
  report.caseProgress = [];
  report.contract = await retentionContract(database, async (name, action) => { await action(); report.caseProgress.push(name); });
  assert.equal(report.contract.passed, 20);
  report.status = 'PASS';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  if (database) await database.db.close();
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, driver: report.driver, cases: report.contract?.passed, cli: report.cliCounts,
    destination, error: report.error }));
}
