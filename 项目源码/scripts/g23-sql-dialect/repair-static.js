// Tool-only checks: no SQL corpus, application imports, database or full test suite.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { budget } from './mysql-fixture.js';
const out = process.env.G23_AUDIT_ROOT, attempt = process.env.G23_ATTEMPT;
assert.ok(out && attempt);
const result = { status: 'PASS', scope: 'tool-only syntax/budget/product freeze', syntax: [], frozenProducts: {} };
for (const name of ['cleanup-mysql02.js', 'mysql-fixture.js', 'mysql-lifecycle.js', 'mysql-lifecycle.test.js', 'repair-static.js',
  'mysql-fixture-config.js', 'mysql-fixture-config.test.js', 'mysql-contract.js', 'mysql-cli-output.js', 'mysql-cli-output.test.js']) {
  const file = `scripts/g23-sql-dialect/${name}`;
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 2000 });
  assert.equal(check.status, 0, check.stderr); assert.equal(check.signal, null);
  result.syntax.push({ file, exit: check.status });
}
const python = spawnSync('python3', ['-c', 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())',
  'scripts/g23-sql-dialect/posthoc-after.py'], { encoding: 'utf8', timeout: 2000 });
assert.equal(python.status, 0, python.stderr); result.pythonSyntaxExit = python.status;
assert.equal(budget.runner, 45000); assert.equal(budget.closeReserve, 14000);
assert.equal(budget.work + budget.closeReserve + budget.outerReserve, budget.runner);
assert.ok(budget.version * 3 + budget.initialize + budget.ready + budget.setup + budget.contract + 4000 <= budget.work);
result.budget = budget;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const frozen = JSON.parse(fs.readFileSync(path.join(out, 'resume01-final-packet.json'), 'utf8')).files;
for (const [file, expected] of Object.entries(frozen)) {
  if (!file.startsWith('项目源码/server/')) continue;
  const actual = sha(fs.readFileSync(path.resolve('..', file)));
  assert.equal(actual, expected.sha256, file); result.frozenProducts[file] = actual;
}
assert.equal(Object.keys(result.frozenProducts).length, 5);
fs.writeFileSync(path.join(out, `${attempt}-details.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, jsSyntax: result.syntax.length, pythonSyntax: 1, frozenProducts: 5, budget: result.budget }));
