import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlDialectContract } from './support/sql-dialect-contract.js';
Object.assign(process.env, { DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '0' });
const database = await import('../src/db.js');
test.after(() => database.db.close());
test('SQLite executes the shared seven-table dialect contract on all 29 migrations', async t => {
  assert.equal(database.migrationResult.applied, 29);
  assert.equal((await database.migrate()).applied, 0);
  const result = await sqlDialectContract(database);
  assert.equal(result.passed, 9);
  t.diagnostic(JSON.stringify(result));
});
