// OFFLINE replay of the frozen mysql04 merged output; no MySQL binary is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseRootSettings, parseTcpIdentity, knownPasswordDiagnostic as diagnostic } from './mysql-cli-output.js';
const file = path.resolve('output/resource-audit/engineering-20261018/g23/01a14cff-5566-7971-8b0c-4153a8ab6b00/mysql04-fixture-evidence.json');
const bytes = fs.readFileSync(file), frozen = JSON.parse(bytes);
const root = frozen.processes.find(p => p.label === 'mysql-settings-schema-account');
const tcp = frozen.processes.find(p => p.label === 'mysql-tcp-account-identity');
const config = frozen.setupPlan.application;
const settingsRow = '8.4.11\t0\t50331648\t50331648\tONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const identityRow = `g23_probe@127.0.0.1\t${config.database}`;
const ok = tail => ({ status: 'exited', exitCode: 0, signal: null, timedOut: false, tail });
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

test('offline actual mysql04 root/TCP tails parse, preserve original bytes, and identify the one diagnostic', () => {
  const before = JSON.stringify([root,tcp]);
  const a = parseRootSettings(root), b = parseTcpIdentity(tcp, config);
  assert.equal(a.rawTail, root.tail); assert.equal(b.rawTail, tcp.tail);
  assert.equal(a.dataLine, settingsRow); assert.equal(b.dataLine, identityRow);
  assert.deepEqual(a.diagnostics, [diagnostic]); assert.deepEqual(b.diagnostics, [diagnostic]);
  assert.equal(JSON.stringify([root,tcp]), before); assert.deepEqual(fs.readFileSync(file), bytes);
  if (process.env.G23_AUDIT_ROOT) fs.writeFileSync(path.join(process.env.G23_AUDIT_ROOT,
    `${process.env.G23_ATTEMPT}-actual-replay.json`), JSON.stringify({ offline: true, sourceFile: file, sourceSha256: sha(bytes),
      rootTailSha256: sha(root.tail), tcpTailSha256: sha(tcp.tail), parsedRoot: a, parsedTcp: b,
      meaning: 'format regression using frozen worker mysql04 output, not a new live MySQL run' }, null, 2)+'\n', { flag: 'wx' });
});
test('offline both entries accept bare data or exact observed diagnostic and blank lines only', () => {
  for (const prefix of ['', `${diagnostic}\n`]) {
    const a = parseRootSettings(ok(`\n${prefix}${settingsRow}\n\n`));
    const b = parseTcpIdentity(ok(`\n${prefix}${identityRow}\n\n`), config);
    assert.equal(a.parsed.version, '8.4.11'); assert.equal(b.parsed.currentUser, 'g23_probe@127.0.0.1');
    assert.equal(a.diagnostics.length, prefix ? 1 : 0); assert.equal(b.diagnostics.length, prefix ? 1 : 0);
  }
});
test('offline wrong identities/settings, missing or extra columns and invalid modes reject', () => {
  for (const row of [identityRow.replace('g23_probe','root'), identityRow.replace(config.database,'other'),
    identityRow.replace('127.0.0.1','localhost'), identityRow.split('\t')[0], identityRow+'\textra']) {
    assert.throws(() => parseTcpIdentity(ok(row), config));
  }
  for (const row of [settingsRow.replace('8.4.11','8.4.10'), settingsRow.replace('\t0\t','\t1\t'),
    settingsRow.replace('50331648','67108864'), settingsRow+'\textra', settingsRow.split('\t').slice(0,4).join('\t'),
    settingsRow.replace('ONLY_FULL_GROUP_BY','UNKNOWN_MODE'), settingsRow.replace('ONLY_FULL_GROUP_BY','ANSI_QUOTES'),
    settingsRow.replace('ONLY_FULL_GROUP_BY','NO_BACKSLASH_ESCAPES'), settingsRow.replace('ONLY_FULL_GROUP_BY','STRICT_TRANS_TABLES')]) {
    assert.throws(() => parseRootSettings(ok(row)), row);
  }
});
test('offline missing data, unknown warning/ERROR, repeated diagnostic or extra data are never discarded', () => {
  for (const [parser,row] of [[r => parseRootSettings(r), settingsRow], [r => parseTcpIdentity(r,config), identityRow]]) {
    for (const output of ['', `${diagnostic}\n`, `mysql: [Warning] unknown\n${row}`, `ERROR 1045\n${row}`,
      `${row}\n${row}`, `${diagnostic}\n${diagnostic}\n${row}`, `${diagnostic} \n${row}`, `${row}\nextra`]) {
      assert.throws(() => parser(ok(output)), output);
    }
  }
});
test('offline successful-looking data never masks nonzero exit, timeout, signal or invalid terminal', () => {
  for (const [parser,row] of [[r => parseRootSettings(r), settingsRow], [r => parseTcpIdentity(r,config), identityRow]]) {
    for (const patch of [{ status:'failed',exitCode:1 }, { timedOut:true }, { signal:'SIGTERM' },
      { status:'stopped' }, { status:'spawn_failed',exitCode:null }]) assert.throws(() => parser({ ...ok(row),...patch }));
  }
});
test('offline projections preserve every raw byte including CRLF and do not mutate successful process records', () => {
  const result = Object.freeze(ok(`\r\n${diagnostic}\r\n${identityRow}\r\n`));
  const parsed = parseTcpIdentity(result,config);
  assert.equal(parsed.rawTail, result.tail); assert.equal(sha(parsed.rawTail),sha(result.tail));
  assert.deepEqual(parsed.columns,identityRow.split('\t')); assert.equal(result.status,'exited');
});
