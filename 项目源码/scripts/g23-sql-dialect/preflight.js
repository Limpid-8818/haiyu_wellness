import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compileMysqlStatement } from '../../server/src/mysql-dialect.js';
const out = process.env.G23_AUDIT_ROOT, attempt = process.env.G23_ATTEMPT;
const result = { status: 'PASS', syntax: [], corpus: [] };
const files = ['server/src/mysql-dialect.js', 'server/src/db-infrastructure.js', 'server/test/mysql-dialect.test.js',
  'server/test/sql-dialect-execution.test.js', 'server/test/support/sql-dialect-contract.js',
  ...fs.readdirSync('scripts/g23-sql-dialect').filter(f => f.endsWith('.js')).map(f => `scripts/g23-sql-dialect/${f}`)];
for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 3000 });
  result.syntax.push({ file, exit: check.status, signal: check.signal, output: check.stdout + check.stderr });
  assert.equal(check.status, 0, `${file}: ${check.stderr}`);
}
const source = fs.readFileSync('scripts/g23-sql-dialect/mysql-fixture.js', 'utf8');
const object = source.match(/export const budget = (\{[\s\S]*?\});/)[1];
const budget = JSON.parse(object.replace(/(\w+):/g, '"$1":'));
assert.equal(budget.work + budget.closeReserve + budget.outerReserve, budget.runner);
assert.equal(budget.runner, 45000); assert.ok(budget.closeReserve >= 14000);
const steps = budget.version * 3 + budget.initialize + budget.ready + budget.setup + budget.contract;
assert.ok(steps + 4000 <= budget.work); assert.ok(budget.ping <= 1200 && budget.ready <= 4000 && budget.pingAttempts <= 6);
assert.doesNotMatch(source, /--wait=/); result.budget = { ...budget, childWork: steps, rpcWorkReserve: budget.work - steps };
for (const query of JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))) {
  const compiled = compileMysqlStatement(query.sql);
  result.corpus.push({ ...query, translated: compiled.sql });
}
assert.ok(result.corpus.length > 400, 'must cover the current repository prepared SQL corpus');
fs.writeFileSync(path.join(out, `${attempt}-details.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, syntax: files.length, statements: result.corpus.length, budget: result.budget }));
