import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureApplication, rootPreparationSql, rootSocketArgs, applicationTcpArgs, prepareFixtureAccount } from './mysql-fixture-config.js';
import { knownPasswordDiagnostic } from '../g23-sql-dialect/mysql-cli-output.js';
const task = '01a14ea4-49cd-7e53-a95e-dd287bc7bde4';
const successful = tail => ({ status: 'exited', exitCode: 0, signal: null, timedOut: false, tail });
test('G42 uses its own exact 127 account/schema and shares verified output and lifecycle helpers', async () => {
  const config = fixtureApplication(task, 'mysql01', 55231), sql = rootPreparationSql(config);
  assert.equal(config.user, 'g42_probe'); assert.match(config.database, /^g42[a-z0-9]+$/);
  assert.match(sql, /'g42_probe'@'127\.0\.0\.1'/); assert.doesNotMatch(sql, /GRANT.*\*\.\*/);
  assert.deepEqual(rootSocketArgs('/tmp/g42/mysql.sock').slice(0, 3), ['--no-defaults', '--no-login-paths', '--skip-password']);
  assert.ok(applicationTcpArgs(config).includes('--protocol=TCP'));
  const settings = '8.4.11\t0\t50331648\t50331648\tSTRICT_TRANS_TABLES\n';
  const identity = `${config.user}@127.0.0.1\t${config.database}\n`;
  for (const prefix of ['', `${knownPasswordDiagnostic}\n`]) {
    const result = await prepareFixtureAccount({ config, deadline: Date.now() + 2000,
      root: async () => successful(prefix + settings), tcp: async () => successful(prefix + identity) });
    assert.equal(result.identity.parsed.currentUser, 'g42_probe@127.0.0.1'); assert.equal(result.settings.parsed.version, '8.4.11');
  }
  for (const tail of [identity + 'extra\n', 'unknown warning\n' + identity, identity.replace('g42_probe', 'root')]) {
    await assert.rejects(prepareFixtureAccount({ config, deadline: Date.now() + 2000,
      root: async () => successful(settings), tcp: async () => successful(tail) }));
  }
});
