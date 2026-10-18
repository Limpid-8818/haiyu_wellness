import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const out = process.env.G42_AUDIT_ROOT, attempt = process.env.G42_ATTEMPT;
assert.ok(out && attempt);
const args = process.argv.slice(2);
const files = args.length ? args : fs.readdirSync('server/test').filter(file => file.endsWith('.test.js')).sort().map(file => `server/test/${file}`);
const command = ['--test', '--test-concurrency=1', ...files];
const result = spawnSync(process.execPath, command, { env: process.env, encoding: 'utf8', timeout: 39000, maxBuffer: 8388608 });
const stdout = path.join(out, `${attempt}.tap`), stderr = path.join(out, `${attempt}.stderr.txt`);
fs.writeFileSync(stdout, result.stdout, { flag: 'wx' }); fs.writeFileSync(stderr, result.stderr, { flag: 'wx' });
const summary = { command: [process.execPath, ...command], exitCode: result.status, signal: result.signal,
  stdout, bytes: Buffer.byteLength(result.stdout), stderr, stderrBytes: Buffer.byteLength(result.stderr),
  counts: Object.fromEntries([...result.stdout.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(match => [match[1], Number(match[2])])) };
fs.writeFileSync(path.join(out, `${attempt}-suite.json`), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary));
assert.equal(result.status, 0); assert.equal(result.signal, null);
assert.ok(summary.counts.pass > 0); assert.equal(summary.counts.fail, 0); assert.equal(summary.counts.skipped, 0); assert.equal(summary.counts.cancelled, 0);
