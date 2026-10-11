import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSnapshot } from './q10-fixtures.js';
import { formatProbe, runNode, sqliteSnapshotHash, withMysqlDatabase } from './q10-helpers.js';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'haiyu-q10-import-'));
  const sourcePath = path.join(directory, 'synthetic-source.sqlite');
  let sourceHash;
  try {
    createSqliteSnapshot(sourcePath, 'synthetic');
    sourceHash = sqliteSnapshotHash(sourcePath);
    const source = new DatabaseSync(sourcePath, { readOnly: true });
    let guestHash;
    let sourceMessages;
    try {
      guestHash = source.prepare("SELECT password_hash FROM users WHERE id='synthetic_guest_001'").get().password_hash;
      sourceMessages = source.prepare('SELECT id,role,content,created_at FROM assistant_messages ORDER BY id').all();
    } finally { source.close(); }

    await withMysqlDatabase(async ({ env, pool }) => {
      const importer = path.join(projectDirectory, 'scripts', 'import-sqlite-to-mysql.js');
      // The CLI is invoked as a child process so the MySQL pool is owned and closed by the importer.
      const result = runNode(`
        const { spawnSync } = await import('node:child_process');
        const child = spawnSync(process.execPath, [${JSON.stringify(importer)}, ${JSON.stringify(sourcePath)}], {
          cwd: ${JSON.stringify(projectDirectory)}, env: process.env, encoding: 'utf8', timeout: 30000
        });
        process.stdout.write(child.stdout || '');
        process.stderr.write(child.stderr || '');
        process.exitCode = child.status ?? 1;
      `, { ...env, DB_DRIVER: 'mysql', DEMO_SEED: '0' });
      const first = formatProbe(result, 'SQLITE_IMPORT=');
      assert.equal(Object.keys(first.sourceCounts).length, 17);
      assert.deepEqual(first.sourceCounts, first.targetCounts);
      assert.equal(first.relationshipViolations, 0);
      assert.equal(first.relationshipsChecked, 30);
      const insertedTotal = Object.values(first.imported).reduce((sum, count) => sum + count, 0);
      const sourceTotal = Object.values(first.sourceCounts).reduce((sum, count) => sum + count, 0);
      assert.equal(insertedTotal, sourceTotal);
      assert.deepEqual(Object.values(first.duplicates), Array(17).fill(0));
      const importedSlot = (await pool.execute("SELECT project_id,local_start,capacity FROM activity_slots WHERE id='synthetic_slot_001'"))[0][0];
      assert.deepEqual(importedSlot, { project_id: 'project-sea-bath', local_start: '09:00', capacity: 8 });
      const importedReservation = (await pool.execute("SELECT guest_id,slot_id,status,environment_snapshot_id,is_demo FROM reservations WHERE id='synthetic_reservation_001'"))[0][0];
      assert.deepEqual(importedReservation, {
        guest_id: 'synthetic_guest_001', slot_id: 'synthetic_slot_001', status: 'confirmed',
        environment_snapshot_id: 'stage15-controlled-snapshot', is_demo: 1
      });
      const importedHealth = (await pool.execute(`SELECT value_text,unit,note,source,created_at,recorded_at,
        JSON_UNQUOTE(JSON_EXTRACT(structured_value_json,'$.parseStatus')) AS parse_status,
        JSON_UNQUOTE(JSON_EXTRACT(structured_value_json,'$.rawValue')) AS structured_raw,
        voided_at,voided_by,void_reason FROM health_records WHERE id=71`))[0][0];
      assert.equal(importedHealth.value_text, '138/86');
      assert.equal(importedHealth.unit, 'mmHg');
      assert.equal(importedHealth.note, 'synthetic fixture');
      assert.equal(importedHealth.source, 'staff');
      assert.equal(importedHealth.created_at, importedHealth.recorded_at);
      assert.equal(importedHealth.parse_status, 'unparsed_legacy');
      assert.equal(importedHealth.structured_raw, '138/86');
      assert.deepEqual([importedHealth.voided_at, importedHealth.voided_by, importedHealth.void_reason], [null, null, null]);

      await pool.execute("UPDATE users SET phone='13998760001' WHERE id='synthetic_guest_001'");
      const secondResult = runNode(`
        const { spawnSync } = await import('node:child_process');
        const child = spawnSync(process.execPath, [${JSON.stringify(importer)}, ${JSON.stringify(sourcePath)}], {
          cwd: ${JSON.stringify(projectDirectory)}, env: process.env, encoding: 'utf8', timeout: 30000
        });
        process.stdout.write(child.stdout || '');
        process.stderr.write(child.stderr || '');
        process.exitCode = child.status ?? 1;
      `, { ...env, DB_DRIVER: 'mysql', DEMO_SEED: '0' });
      const second = formatProbe(secondResult, 'SQLITE_IMPORT=');
      assert.deepEqual(Object.values(second.imported), Array(17).fill(0));
      assert.deepEqual(second.duplicates, first.sourceCounts);
      assert.equal((await pool.execute("SELECT phone,password_hash FROM users WHERE id='synthetic_guest_001'"))[0][0].phone, '13998760001');
      assert.equal((await pool.execute("SELECT password_hash FROM users WHERE id='synthetic_guest_001'"))[0][0].password_hash, guestHash);
      const targetMessages = (await pool.execute('SELECT id,sender_role,content,created_at FROM assistant_messages ORDER BY id'))[0];
      assert.deepEqual(targetMessages.map(message => [message.id, message.sender_role, message.content]),
        sourceMessages.map(message => [message.id, message.role, message.content]));
      const targetTimes = targetMessages.map(message => {
        const timestamp = message.created_at.replace(' ', 'T');
        return (timestamp.includes('.') ? timestamp : timestamp + '.000') + 'Z';
      });
      assert.deepEqual(targetTimes, sourceMessages.map(message => message.created_at));
      const targetProfile = (await pool.execute("SELECT check_in_date FROM guest_profiles WHERE user_id='synthetic_guest_001'"))[0][0];
      assert.equal(targetProfile.check_in_date, '2026-09-10');
      const targetAssignment = (await pool.execute("SELECT status FROM staff_guest_assignments WHERE id=61"))[0][0];
      assert.equal(targetAssignment.status, 'closed');
      const targetIntake = (await pool.execute("SELECT raw_content,review_status,session_id FROM health_intakes WHERE guest_id='synthetic_guest_001'"))[0][0];
      assert.deepEqual([targetIntake.raw_content, targetIntake.review_status, targetIntake.session_id],
        ['Synthetic pending health intake.', 'pending', 'as_123e4567-e89b-12d3-a456-426614174000']);
      const detail = (await pool.execute("SELECT JSON_UNQUOTE(detail_json) AS detail FROM audit_logs WHERE id=101"))[0][0].detail;
      assert.equal(detail, 'synthetic audit detail');
      assert.deepEqual(second.targetCounts, first.targetCounts);
    });

    assert.equal(sqliteSnapshotHash(sourcePath), sourceHash, 'source SQLite snapshot changed during import');
    return { output: ['all 17 imported table counts and 30 relationships verified, including Stage15 reservations, Stage16 menu/order tables, and Stage17 health record retractor', 'legacy health values imported with raw text intact, conservative parse status, source and record/create times', 'second import inserted zero rows and preserved a custom phone', 'IDs, password hash, role/order, JSON text and UTC millisecond timestamps preserved', 'source SQLite SHA-256 unchanged'] };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
