import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { budget } from './mysql-fixture.js';
const out = process.env.G42_AUDIT_ROOT, attempt = process.env.G42_ATTEMPT;
const files = ['server/src/data-retention.js', 'server/src/data-retention-connection.js', 'server/scripts/data-retention.js',
  'server/test/data-retention.test.js', 'server/test/support/data-retention-contract.js',
  ...fs.readdirSync('scripts/g42-data-retention').filter(file => file.endsWith('.js')).map(file => `scripts/g42-data-retention/${file}`)];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 0, result.stderr);
}
assert.equal(budget.work + budget.closeReserve + budget.outerReserve, 45000);
assert.equal(budget.closeReserve, 14000);
assert.ok(budget.version * 3 + budget.initialize + budget.ready + budget.setup + budget.contract + 4000 <= budget.work);
const source = fs.readFileSync('scripts/g42-data-retention/mysql-fixture.js', 'utf8');
assert.doesNotMatch(source, /G23_|g23_probe|seven-table|mysql-contract\.js|--wait=/);
assert.match(source, /g42-data-retention\/probe\.js/);
assert.doesNotMatch(fs.readFileSync('server/src/data-retention.js', 'utf8'), /from ['"].*db\.js/);
const result = { status: 'PASS', syntax: files.length, files, budget, importHasNoSessionSideEffects: true };
fs.writeFileSync(path.join(out, `${attempt}-details.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(result));
