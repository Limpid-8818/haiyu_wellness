import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as database from '../../server/src/db-infrastructure.js';
import { migrate } from '../../server/src/migrations.js';
import { sqlDialectContract } from '../../server/test/support/sql-dialect-contract.js';
const file = process.argv[2];
const result = { driver: database.driver, status: 'FAIL', stage: 'application-initialize' };
try {
  assert.equal(database.driver, 'mysql');
  await database.initializeConnection();
  result.stage = 'initial-migrate';
  result.migration = await migrate();
  assert.equal(result.migration.applied, 29);
  result.stage = 'repeat-migrate'; result.repeat = await migrate(); assert.equal(result.repeat.applied, 0);
  result.stage = 'shared-seven-table-contract';
  Object.assign(result, await sqlDialectContract(database), { status: 'PASS' });
} catch (error) {
  result.error = error.stack; result.cause = error.cause?.stack;
  result.errorChain = [];
  for (let cause = error; cause && result.errorChain.length < 5; cause = cause.cause) {
    result.errorChain.push({ message: cause.message, code: cause.code, errno: cause.errno,
      sqlState: cause.sqlState, sqlMessage: cause.sqlMessage, sql: cause.sql });
  }
  process.exitCode = 1;
} finally {
  await database.db.close(); result.connectionClosed = true;
  fs.writeFileSync(file, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(result));
}
