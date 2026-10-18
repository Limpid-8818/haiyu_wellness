// Pure projections of successful fixed-query CLI output. Preserve the raw merged
// tail; recognize only the exact diagnostic observed in the frozen mysql04 logs.
import assert from 'node:assert/strict';
import { classifyProcessResult } from './mysql-lifecycle.js';
export const knownPasswordDiagnostic = 'mysql: [Warning] Using a password on the command line interface can be insecure.';
export function singleCliRow(result, columnCount) {
  classifyProcessResult(result);
  assert.equal(typeof result.tail, 'string');
  const diagnostics = [], rows = [];
  for (const line of result.tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line === knownPasswordDiagnostic) {
      assert.equal(diagnostics.length, 0, 'duplicate CLI diagnostic'); diagnostics.push(line);
    } else rows.push(line);
  }
  assert.equal(rows.length, 1, 'CLI must contain exactly one data row and only recognized diagnostics');
  const columns = rows[0].split('\t');
  assert.equal(columns.length, columnCount, 'CLI data column count mismatch');
  return { rawTail: result.tail, diagnostics, dataLine: rows[0], columns };
}
export function parseRootSettings(result) {
  const output = singleCliRow(result, 5);
  const [version, binlog, buffer, redo, mode] = output.columns;
  assert.equal(version, '8.4.11'); assert.equal(binlog, '0');
  assert.equal(buffer, '50331648'); assert.equal(redo, '50331648');
  // This fixture uses the observed, supported default-mode vocabulary. Other
  // modes require explicit review; do not accept opaque or string-quoting modes.
  const allowed = new Set(['ONLY_FULL_GROUP_BY','STRICT_TRANS_TABLES','STRICT_ALL_TABLES','NO_ZERO_IN_DATE',
    'NO_ZERO_DATE','ERROR_FOR_DIVISION_BY_ZERO','NO_ENGINE_SUBSTITUTION']);
  const sqlModes = mode.split(',');
  assert.ok(sqlModes.every(m => allowed.has(m)), 'unreviewed/invalid fixture SQL mode');
  assert.equal(new Set(sqlModes).size, sqlModes.length, 'duplicate SQL mode');
  return { ...output, parsed: { version, logBin: 0, bufferPoolBytes: 50331648, redoBytes: 50331648, sqlModes } };
}
export function parseTcpIdentity(result, config) {
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.user, 'g23_probe');
  assert.match(config.database, /^g23[a-z0-9]{1,61}$/);
  const output = singleCliRow(result, 2);
  assert.equal(output.columns[0], `${config.user}@127.0.0.1`, 'fixture TCP account identity mismatch');
  assert.equal(output.columns[1], config.database, 'fixture TCP database identity mismatch');
  return { ...output, parsed: { currentUser: output.columns[0], database: output.columns[1] } };
}
