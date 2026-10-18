// OFFLINE construction and virtual-time checks only; no MySQL executable is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixtureApplication, validateApplication, rootSocketArgs, applicationTcpArgs, rootPreparationSql,
  verifyTcpIdentity, prepareFixtureAccount, clientIsolation } from './mysql-fixture-config.js';
const id = '01a14cff-5566-7971-8b0c-4153a8ab6b00';
const config = fixtureApplication(id, 'mysql04', 55432);
const ok = tail => ({ status: 'exited', exitCode: 0, signal: null, timedOut: false, tail });
const output = `${config.user}@127.0.0.1\t${config.database}\n`;
const settings = '8.4.11\t0\t50331648\t50331648\tSTRICT_TRANS_TABLES\n';

test('offline own schema derives only from actual ID/attempt and grants one exact database', () => {
  assert.equal(config.database, `g23${id.replaceAll('-', '')}mysql04`); assert.ok(config.database.length <= 64);
  const sql = rootPreparationSql(config);
  assert.ok(sql.includes(`GRANT ALL PRIVILEGES ON \`${config.database}\`.* TO 'g23_probe'@'127.0.0.1'`));
  assert.doesNotMatch(sql, /ON \*\.\*|WITH GRANT OPTION|root@|@'%'/);
});
test('offline invalid names, host/user wildcards, global grant fragments and old ports reject', () => {
  for (const database of ['*', '*.*', 'g23%', 'g23_test', 'g23`.* TO root;--', 'g23'+'a'.repeat(62), 'otherdb']) {
    assert.throws(() => rootPreparationSql({ ...config, database }));
  }
  for (const patch of [{ host: '%' }, { host: 'localhost' }, { host: '0.0.0.0' }, { user: 'root' },
    { user: 'g23_probe%' }, { password: 'external' }, ...[3306,50634,51016,64525,64812].map(port => ({ port }))]) {
    assert.throws(() => validateApplication({ ...config, ...patch }));
  }
  assert.throws(() => fixtureApplication(id, 'mysql04; DROP DATABASE x', 55432));
});
test('offline root is socket-only, app is exact TCP identity and both isolate login files/password prompts', () => {
  const root = rootSocketArgs('/tmp/haiyu-resource-offline/mysql.sock'), tcp = applicationTcpArgs(config);
  for (const args of [root, tcp]) {
    assert.deepEqual(args.slice(0,3), clientIsolation);
    assert.equal(args[0], '--no-defaults'); assert.ok(args.includes('--no-login-paths') && args.includes('--skip-password'));
    assert.equal(args.some(arg => arg.startsWith('--password=')), false);
    assert.equal(args.includes('--password'), false); assert.equal(args.includes('-p'), false);
  }
  assert.ok(root.includes('--protocol=SOCKET') && root.includes('--user=root'));
  assert.ok(!root.some(s => s.startsWith('--host=') || s.startsWith('--port=')));
  assert.ok(tcp.includes('--protocol=TCP') && tcp.includes('--user=g23_probe'));
  assert.equal(tcp.includes('--user=root'), false);
});
test('offline TCP CURRENT_USER/DATABASE must match exactly, not root or another schema', () => {
  assert.deepEqual(verifyTcpIdentity(ok(output), config).parsed, { currentUser: 'g23_probe@127.0.0.1', database: config.database });
  for (const actual of [output.replace('g23_probe','root'), output.replace('127.0.0.1','localhost'),
    output.replace(config.database,'otherdb'), output+'extra\n', '']) assert.throws(() => verifyTcpIdentity(ok(actual), config));
});
test('offline root+TCP share one two-second deadline and TCP gets only remaining time', async () => {
  let now = 0; const timeouts = [];
  const result = await prepareFixtureAccount({ config, deadline: 2000, now: () => now,
    root: async (sql, timeout) => { timeouts.push(timeout); now += 1200; return ok(settings); },
    tcp: async (sql, timeout) => { timeouts.push(timeout); assert.equal(sql, 'SELECT CURRENT_USER(),DATABASE()'); now += 600; return ok(output); }
  });
  assert.deepEqual(timeouts, [2000,800]); assert.equal(result.elapsedMs, 1800);
});
test('offline setup failure/timeout/mismatched identity never passes or retries permissions', async () => {
  for (const result of [{ ...ok(''), status: 'failed', exitCode: 1 }, { ...ok(''), timedOut: true }]) {
    let tcp = 0;
    await assert.rejects(prepareFixtureAccount({ config, deadline: 2000, now: () => 0,
      root: async () => result, tcp: async () => { tcp++; return ok(output); } })); assert.equal(tcp, 0);
  }
  let now = 0, tcpCalls = 0;
  await assert.rejects(prepareFixtureAccount({ config, deadline: 2000, now: () => now,
    root: async () => { now=2000; return ok(settings); }, tcp: async () => { tcpCalls++; return ok(output); } }), /exhausted/);
  assert.equal(tcpCalls, 0);
  await assert.rejects(prepareFixtureAccount({ config, deadline: 2000, now: () => 0,
    root: async () => ok(settings), tcp: async () => ok('wrong\tidentity') }), /identity mismatch/);
});
