import assert from 'node:assert/strict';
import { formatProbe, runNode, withMysqlDatabase } from './q10-helpers.js';

const probeCode = `
  import { db, migrationResult } from './src/db.js';
  const check = await db.prepare('SELECT 1 AS ok, VERSION() AS version').get();
  console.log('Q10_MYSQL=' + JSON.stringify({driver: db.driver, ok: check.ok, version: check.version, migrations: migrationResult.applied}));
  await db.close();
  console.log('Q10_POOL_CLOSED=true');
`;

export async function run() {
  let version;
  await withMysqlDatabase(async ({ env }) => {
    const result = runNode(probeCode, env);
    assert.equal(result.status, 0, result.combined);
    const probe = formatProbe(result, 'Q10_MYSQL=');
    assert.equal(probe.driver, 'mysql');
    assert.equal(Number(probe.ok), 1);
    assert.match(String(probe.version), /^8\./, 'test server must be MySQL 8.x');
    version = probe.version;
    assert.ok(result.stdout.includes('Q10_POOL_CLOSED=true'), 'process must close the mysql2 pool');

    const unavailable = runNode("import './src/db.js';", {
      ...env, MYSQL_PORT: '1', MYSQL_DATABASE: 'haiyu_unavailable_probe'
    });
    assert.notEqual(unavailable.status, 0, 'unavailable MySQL address must fail');
    assert.match(unavailable.combined, /MySQL connection 127\.0\.0\.1:1\/haiyu_unavailable_probe failed/);
    assert.match(unavailable.combined, /no SQLite fallback was attempted/);
  });
  return { output: [`mysql2/promise pool connected to MySQL ${version}; SELECT 1=1`, 'pool close and unavailable-address failure verified without fallback'] };
}
