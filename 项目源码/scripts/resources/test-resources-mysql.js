import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_LIMITS, ResourceSession, processMatches, readResourceLogTail
} from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const auditRoot = path.join(projectRoot, 'output', 'resource-audit');
const taskId = process.env.CODEX_TASK_ID || '01a0f69e-15d3-7650-a7c1-61a92de38422';
const baseDir = '/opt/homebrew/opt/mysql@8.4';
const mysqld = path.join(baseDir, 'bin', 'mysqld');
const mysql = path.join(baseDir, 'bin', 'mysql');
const mysqladmin = path.join(baseDir, 'bin', 'mysqladmin');
const port = 33421;

function registryTail(maxBytes = 1024 * 1024) {
  const target = path.join(auditRoot, 'registry.jsonl');
  if (!fs.existsSync(target)) return [];
  const size = fs.statSync(target).size;
  const count = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(count);
  const fd = fs.openSync(target, 'r');
  try { fs.readSync(fd, buffer, 0, count, size - count); }
  finally { fs.closeSync(fd); }
  return buffer.toString('utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function assertPortAvailable(targetPort) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(targetPort, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

function runOk(result, label) {
  assert.equal(result.status, 'exited', `${label} status: ${result.status}; ${result.tail || ''}`);
  assert.equal(result.exitCode, 0, `${label} exit=${result.exitCode}; ${result.tail || ''}`);
  assert.equal(result.timedOut, false, `${label} timed out; ${result.tail || ''}`);
}

async function main() {
  for (const executable of [mysqld, mysql, mysqladmin]) {
    assert.ok(fs.existsSync(executable), `required MySQL 8.4 client/server binary is missing: ${executable}`);
  }
  await assertPortAvailable(port);

  const session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
  const instanceId = session.instanceId;
  const tempDir = session.tempDir;
  const dataDir = await session.allocateDir('mysql-data');
  const socket = path.join(tempDir, 'mysql.sock');
  const pidFile = path.join(tempDir, 'mysql.pid');
  let bodyError = null;
  let closeError = null;
  let binaryVersion = '';
  let sqlResult = '';
  let failureLogs = [];

  try {
    const version = await session.runProcess({
      label: 'mysql-8.4-version', kind: 'probe', role: 'probe', command: mysqld,
      args: ['--version'], cwd: projectRoot, leaseMs: session.limits.leaseMs
    }, { timeoutMs: 5000 });
    runOk(version, 'MySQL version check');
    binaryVersion = version.tail.trim();
    assert.match(binaryVersion, /Ver 8\.4\.11\b/, `unexpected server binary: ${binaryVersion}`);

    const initialize = await session.runProcess({
      label: 'mysql-initialize-insecure', kind: 'mysql', role: 'test', command: mysqld,
      args: ['--no-defaults', `--basedir=${baseDir}`, `--datadir=${dataDir}`,
        '--initialize-insecure', '--innodb-buffer-pool-size=48M', '--innodb-redo-log-capacity=48M',
        '--skip-log-bin', '--console'],
      cwd: projectRoot, datadir: dataDir, leaseMs: session.limits.leaseMs
    }, { timeoutMs: 120_000 });
    runOk(initialize, 'MySQL isolated initialization');

    await assertPortAvailable(port);
    const server = await session.startProcess({
      label: 'mysql-server', kind: 'mysql', role: 'mysql', command: mysqld,
      args: ['--no-defaults', `--basedir=${baseDir}`, `--datadir=${dataDir}`,
        `--port=${port}`, '--bind-address=127.0.0.1', '--mysqlx=0', `--socket=${socket}`,
        `--pid-file=${pidFile}`, '--innodb-buffer-pool-size=48M', '--innodb-redo-log-capacity=48M',
        '--skip-log-bin', '--skip-name-resolve', '--console'],
      cwd: projectRoot, datadir: dataDir, socket, port,
      shutdownCommand: {
        command: mysqladmin,
        args: ['--no-defaults', '--protocol=SOCKET', `--socket=${socket}`, '--user=root',
          '--connect-timeout=3', '--shutdown-timeout=10', 'shutdown']
      },
      shutdownTimeoutMs: 12_000, leaseMs: session.limits.leaseMs
    });
    assert.equal(server.status, 'running', `mysqld did not stay running: ${JSON.stringify(server)}`);

    const ready = await session.runProcess({
      label: 'mysql-socket-readiness', kind: 'probe', role: 'probe', command: mysqladmin,
      args: ['--no-defaults', '--protocol=SOCKET', `--socket=${socket}`, '--user=root',
        '--connect-timeout=1', '--wait=10', 'ping'],
      cwd: projectRoot, socket, port, datadir: dataDir, leaseMs: session.limits.leaseMs
    }, { timeoutMs: 15_000 });
    runOk(ready, 'MySQL socket readiness');
    assert.match(ready.tail, /mysqld is alive/i);

    const query = 'SELECT VERSION(), @@transaction_isolation, @@log_bin, @@innodb_buffer_pool_size, @@innodb_redo_log_capacity';
    const check = await session.runProcess({
      label: 'mysql-isolation-settings', kind: 'probe', role: 'probe', command: mysql,
      args: ['--no-defaults', '--protocol=SOCKET', `--socket=${socket}`, '--user=root', '--batch',
        '--skip-column-names', '--execute', query],
      cwd: projectRoot, socket, port, datadir: dataDir, leaseMs: session.limits.leaseMs
    }, { timeoutMs: 10_000 });
    runOk(check, 'MySQL settings query');
    sqlResult = check.tail.trim().split('\n').at(-1) || '';
    const [serverVersion, isolation, logBin, bufferPool, redoCapacity] = sqlResult.split('\t');
    assert.equal(serverVersion, '8.4.11');
    assert.equal(isolation, 'REPEATABLE-READ');
    assert.equal(logBin, '0', 'binary logging must be disabled');
    assert.equal(Number(bufferPool), 48 * 1024 * 1024);
    assert.equal(Number(redoCapacity), 48 * 1024 * 1024);

    const liveStatus = await session.status();
    assert.ok(liveStatus.currentDirectoryBytes <= RESOURCE_LIMITS.directoryBytes);
    assert.ok(liveStatus.resources.every(resource => resource.logBytes <= RESOURCE_LIMITS.logBytes));
  } catch (error) {
    bodyError = error;
    try {
      const status = await session.status();
      failureLogs = status.resources.filter(resource => /mysql/i.test(resource.label) && resource.logPath)
        .map(resource => ({ label: resource.label, pid: resource.pid, logPath: resource.logPath,
          logBytes: resource.logBytes, tail: readResourceLogTail(resource.logPath, 4096) }));
    } catch (logError) { failureLogs = [{ error: `could not read bounded MySQL log tails: ${logError.message}` }]; }
  }

  try { await session.close(bodyError ? 'mysql-smoke-failure' : 'mysql-smoke-complete'); }
  catch (error) { closeError = error; }

  const events = registryTail().filter(event => event.instanceId === instanceId);
  const cleanup = events.findLast(event => ['instance_cleaned', 'instance_cleanup_preserved', 'instance_cleanup_blocked'].includes(event.event));
  const started = events.filter(event => ['process_started', 'child_process_started'].includes(event.event) && Number.isInteger(event.pid));
  const exited = events.filter(event => event.event === 'pid_exit_confirmed' && event.exactIdentityExited === true);
  const missingExitEvidence = started.filter(resource => !exited.some(event => event.pid === resource.pid &&
    event.processFingerprint === resource.processFingerprint && event.processStartTime === resource.processStartTime));
  const liveIdentities = started.filter(resource => processMatches(resource.pid, {
    startTime: resource.processStartTime, fingerprint: resource.processFingerprint
  }));
  const mysqlResource = events.findLast(event => event.event === 'resource_cleanup_summary' &&
    event.label === 'mysql-server');
  const shutdownEvent = events.findLast(event => event.event === 'mysql_graceful_exit_confirmed');
  const shutdownCommand = events.findLast(event => event.event === 'shutdown_command_exit' &&
    event.resourceId === mysqlResource?.resourceId);
  const mysqlLogTail = mysqlResource?.logTail || '';
  const forbiddenLog = /(\[ERROR\]|MY-012592|MY-012593|MY-012646)/i.test(mysqlLogTail);

  const evidence = {
    taskId, instanceId, status: !bodyError && !closeError && cleanup?.event === 'instance_cleaned' && !missingExitEvidence.length && !liveIdentities.length &&
      Boolean(shutdownEvent) && shutdownCommand?.exitCode === 0 && mysqlResource?.exitCode === 0 &&
      !mysqlResource.signal && !forbiddenLog ? 'PASS' : 'FAIL',
    binaryVersion, sqlResult, port, datadir: dataDir, socket, pidFile, tempDir,
    cleanupEvent: cleanup?.event || null, cleanupReason: cleanup?.reason || null,
    directoryBytesBeforeDelete: cleanup?.directoryBytesBeforeDelete ?? null,
    peakDirectoryBytes: cleanup?.peakDirectoryBytes ?? null,
    openHandleCheck: cleanup?.openHandleCheck || null,
    mysqlPid: mysqlResource?.pid ?? null, mysqlExitCode: mysqlResource?.exitCode ?? null,
    mysqlSignal: mysqlResource?.signal ?? null, shutdownPid: shutdownCommand?.pid ?? null,
    shutdownExitCode: shutdownCommand?.exitCode ?? null, gracefulShutdownConfirmed: Boolean(shutdownEvent),
    registeredProcessCount: started.length, missingExitEvidence: missingExitEvidence.map(item => ({
      pid: item.pid, processStartTime: item.processStartTime, command: item.command
    })), liveIdentities: liveIdentities.map(item => ({
      pid: item.pid, processStartTime: item.processStartTime, command: item.command
    })),
    logBytes: mysqlResource?.logBytes ?? null, forbiddenLog, tempDirRemoved: !fs.existsSync(tempDir),
    failureLogs,
    registryPath: path.join(auditRoot, 'registry.jsonl'),
    bodyError: bodyError?.message || null, cleanupError: closeError?.message || null
  };
  console.log(JSON.stringify(evidence, null, 2));

  if (bodyError || closeError || evidence.status !== 'PASS') {
    throw new Error(`isolated MySQL resource smoke failed; diagnostic path preserved when shutdown/cleanup failed: ${tempDir}`);
  }
  assert.equal(fs.existsSync(tempDir), false, 'successful MySQL smoke left the isolated temp directory');
  await assertPortAvailable(port);
}

main().catch(error => {
  console.error(`MYSQL_RESOURCE_TEST_FAIL ${error.stack || error.message}`);
  process.exitCode = 1;
});
