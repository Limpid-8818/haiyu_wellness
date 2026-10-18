import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { classifyProcessResult, waitForMysqlReady, coordinateMysqlClose, shutdownDecision } from '../g23-sql-dialect/mysql-lifecycle.js';
import { ResourceSession } from '../resources/resource-runtime.js';
import { clientIsolation, fixtureApplication, rootSocketArgs, applicationTcpArgs, rootPreparationSql,
  identitySql, prepareFixtureAccount } from './mysql-fixture-config.js';

// Child work <=25s, with 4s for session/RPC overhead, 14s for graceful exit,
// identity/handle checks and cleanup, plus 2s outer-runner startup reserve =45s.
// Each step also checks the absolute work deadline before it can start.
export const budget = { version: 1000, initialize: 6000, ready: 4000, ping: 1200,
  pingAttempts: 6, pingInterval: 150, setup: 2000, contract: 10000, shutdown: 12000,
  work: 29000, closeReserve: 14000, outerReserve: 2000, runner: 45000 };

export async function main() {
  const out = process.env.G42_AUDIT_ROOT, attempt = process.env.G42_ATTEMPT, taskId = process.env.CODEX_TASK_ID;
  assert.ok(out && attempt && taskId);
  const base = '/opt/homebrew/opt/mysql@8.4';
  const mysqld = `${base}/bin/mysqld`, mysql = `${base}/bin/mysql`, admin = `${base}/bin/mysqladmin`;
  const start = Date.now();
  const workDeadline = start + budget.work;
  const session = await ResourceSession.create({ taskId, auditRoot: path.join(out, 'runtime', `${attempt}-fixture`),
    limits: { leaseMs: 900000, logBytes: 8388608, directoryBytes: 536870912 } });
  const evidence = { taskId, hostId: 'local', budget, instanceId: session.instanceId, status: 'FAIL',
    processes: [], versions: [], sessionPeakBound: 2 };
  let mysqlServer, serverReady = false, closeProbe;
  const file = path.join(out, `${attempt}-fixture-evidence.json`);
  assert.equal(fs.existsSync(file), false);
  async function run(label, command, args, timeoutMs, extra = {}, allowNotReady = false) {
    assert.ok(workDeadline - Date.now() >= timeoutMs, `${label}: insufficient work budget; preserve exit reserve`);
    const result = await session.runProcess({ label, command, args, kind: 'probe', role: 'probe', cwd: process.cwd(), ...extra }, { timeoutMs });
    evidence.processes.push({ label, ...result });
    classifyProcessResult(result, { allowPending: allowNotReady });
    return result;
  }
  async function freePort() {
    return await new Promise((resolve, reject) => {
      const server = net.createServer(); server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(e => e ? reject(e) : resolve(port)); });
    });
  }
  try {
    for (const binary of [mysqld, mysql, admin]) {
      const version = await run(path.basename(binary) + '-version', binary,
        binary === mysqld ? ['--no-defaults', '--version'] : [...clientIsolation, '--version'], budget.version);
      assert.match(version.tail, /8\.4\.11/); evidence.versions.push(version.tail.trim());
    }
    const datadir = await session.allocateDir('mysql-data'), socket = path.join(session.tempDir, 'mysql.sock');
    const pidfile = path.join(session.tempDir, 'mysql.pid'), port = await freePort();
    const application = fixtureApplication(taskId, attempt, port), schema = application.database;
    Object.assign(evidence, { datadir, socket, pidfile, port, schema, tempDir: session.tempDir });
    const small = ['--innodb-buffer-pool-size=48M', '--innodb-redo-log-capacity=48M', '--skip-log-bin'];
    await run('mysql-initialize', mysqld, ['--no-defaults', `--basedir=${base}`, `--datadir=${datadir}`,
      '--initialize-insecure', ...small, '--console'], budget.initialize, { kind: 'mysql', role: 'mysql', datadir });
    assert.ok(workDeadline - Date.now() >= budget.ready + budget.setup + budget.contract,
      'insufficient remaining work budget before starting mysqld');
    mysqlServer = await session.startProcess({ label: 'mysql-server', command: mysqld,
      args: ['--no-defaults', `--basedir=${base}`, `--datadir=${datadir}`, `--socket=${socket}`, `--pid-file=${pidfile}`,
        `--port=${port}`, '--bind-address=127.0.0.1', '--mysqlx=0', '--skip-name-resolve', ...small, '--console'],
      kind: 'mysql', role: 'mysql', cwd: process.cwd(), datadir, socket, port,
      shutdownCommand: { command: admin, args: [...clientIsolation, '--protocol=SOCKET', `--socket=${socket}`, '--user=root',
        '--connect-timeout=3', '--shutdown-timeout=10', 'shutdown'] }, shutdownTimeoutMs: budget.shutdown });
    assert.equal(mysqlServer.status, 'running'); evidence.mysqlPid = mysqlServer.pid;
    const client = rootSocketArgs(socket);
    closeProbe = async (timeoutMs, index) => {
      const result = await session.runProcess({ label: `mysql-close-ready-${index}`, command: admin,
        args: [...client, 'ping'], kind: 'probe', role: 'probe', cwd: process.cwd(), socket, port, datadir }, { timeoutMs });
      evidence.processes.push({ label: `mysql-close-ready-${index}`, ...result });
      return result;
    };
    const readiness = await waitForMysqlReady({
      probe: (timeoutMs, index) => run(`mysql-ready-${index}`, admin, [...client, 'ping'], timeoutMs,
        { socket, port, datadir }, true),
      deadline: Math.min(workDeadline, Date.now() + budget.ready),
      attempts: budget.pingAttempts, perProbeMs: budget.ping, intervalMs: budget.pingInterval
    });
    serverReady = true; evidence.readyElapsedMs = readiness.elapsedMs; evidence.readyProbes = readiness.probes;
    evidence.setupPlan = { rootSql: rootPreparationSql(application), rootParams: [], identitySql, identityParams: [],
      rootArgs: client, applicationArgs: applicationTcpArgs(application), application };
    evidence.stage = 'root-preparation-and-tcp-identity';
    const prepared = await prepareFixtureAccount({ config: application,
      deadline: Math.min(workDeadline, Date.now() + budget.setup),
      root: (sql, timeoutMs) => run('mysql-settings-schema-account', mysql,
        [...client, '--batch', '--skip-column-names', '--execute', sql], timeoutMs, { socket, port, datadir }),
      tcp: (sql, timeoutMs) => run('mysql-tcp-account-identity', mysql,
        [...applicationTcpArgs(application), '--batch', '--skip-column-names', '--execute', sql], timeoutMs, { port, datadir })
    });
    evidence.cliOutput = { rootSettings: prepared.settings, tcpIdentity: prepared.identity };
    evidence.settings = prepared.settings.parsed; evidence.tcpIdentity = prepared.identity.parsed; evidence.setupElapsedMs = prepared.elapsedMs;
    evidence.stage = 'application-retention-contract-and-cli';
    await run('mysql-retention-contract-and-cli', process.execPath,
      ['scripts/g42-data-retention/probe.js', path.join(out, `${attempt}-contract.json`)], budget.contract,
      { kind: 'test', role: 'test', socket, port, datadir, env: { ...process.env, DB_DRIVER: 'mysql', DB_PATH: ':memory:',
        MYSQL_HOST: application.host, MYSQL_PORT: String(port), MYSQL_DATABASE: schema, MYSQL_USER: application.user, MYSQL_PASSWORD: '', MYSQL_POOL_SIZE: '2' } });
    evidence.contract = JSON.parse(fs.readFileSync(path.join(out, `${attempt}-contract.json`), 'utf8'));
    assert.equal(evidence.contract.status, 'PASS');
    evidence.liveStatus = await session.status();
    assert.ok(Date.now() <= workDeadline, 'work budget exceeded before cleanup');
    evidence.status = 'PASS';
  } catch (error) {
    evidence.error = error.stack; process.exitCode = 1;
  } finally {
    evidence.elapsedBeforeCloseMs = Date.now() - start;
    try {
      evidence.closeSchedule = await coordinateMysqlClose({
        started: Boolean(mysqlServer), ready: serverReady, workDeadline,
        getState: async timeoutMs => (await session.rpc({ op: 'status' }, timeoutMs)).resources.find(resource => resource.id === mysqlServer.id)?.status,
        probe: closeProbe, close: reason => session.close(reason),
        reason: evidence.status === 'PASS' ? 'g42-mysql-complete' : 'g42-mysql-failure'
      });
      evidence.cleanup = evidence.closeSchedule.cleanup;
      if (evidence.closeSchedule.cleanupError) throw new Error(evidence.closeSchedule.cleanupError);
      assert.equal(evidence.closeSchedule.workReserveExceeded, false, 'close started after the reserved deadline');
      assert.equal(evidence.closeSchedule.cleanupBudgetExceeded, false, 'close exceeded its fourteen-second reserve');
      assert.equal(evidence.cleanup?.ok, true);
      const events = fs.readFileSync(session.registryPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const mysqlExit = events.findLast(e => e.event === 'resource_cleanup_summary' && e.label === 'mysql-server');
      const shutdown = events.findLast(e => e.event === 'shutdown_command_exit');
      evidence.mysqlExit = mysqlExit; evidence.shutdown = shutdown;
      if (evidence.mysqlPid) {
        evidence.shutdownDecision = shutdownDecision({ mysqlExit, shutdown,
          graceful: events.some(e => e.event === 'mysql_graceful_exit_confirmed'), cleanup: evidence.cleanup });
        assert.equal(evidence.shutdownDecision.socketShutdownSucceeded, true);
        assert.equal(evidence.shutdownDecision.preserveDiagnostic, false);
      }
      evidence.tempRemoved = !fs.existsSync(session.tempDir); assert.equal(evidence.tempRemoved, true);
      if (evidence.port) {
        await new Promise((resolve, reject) => {
          const server = net.createServer(); server.once('error', reject);
          server.listen(evidence.port, '127.0.0.1', () => server.close(e => e ? reject(e) : resolve()));
        });
        evidence.portReleased = true;
      }
    } catch (error) { evidence.cleanupError = error.stack; evidence.status = 'FAIL'; process.exitCode = 1; }
    evidence.elapsedMs = Date.now() - start;
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: evidence.status, file, error: evidence.error, cleanupError: evidence.cleanupError,
      elapsedMs: evidence.elapsedMs, tempRemoved: evidence.tempRemoved, portReleased: evidence.portReleased }));
  }

}

// Importing this module for offline tests never creates a ResourceSession or process.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
