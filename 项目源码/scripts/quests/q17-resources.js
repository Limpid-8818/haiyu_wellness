import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mysqlBase = (process.platform === 'darwin'
  ? ['/opt/homebrew/opt/mysql@8.4', '/usr/local/opt/mysql@8.4']
  : ['/usr/local/mysql', '/usr'])
  .find(candidate => existsSync(path.join(candidate, 'bin', 'mysqld')));
const mysqld = mysqlBase ? path.join(mysqlBase, 'bin', 'mysqld') : '';
const mysql = mysqlBase ? path.join(mysqlBase, 'bin', 'mysql') : '';
const mysqladmin = mysqlBase ? path.join(mysqlBase, 'bin', 'mysqladmin') : '';

function assertCommand(result, label) {
  assert.equal(result.status, 'exited', `${label} status=${result.status}: ${result.tail || ''}`);
  assert.equal(result.exitCode, 0, `${label} exit=${result.exitCode}: ${result.tail || ''}`);
  assert.equal(result.timedOut, false, `${label} timed out: ${result.tail || ''}`);
}

async function availableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('could not allocate MySQL loopback port')));
    });
  });
}

export async function startQ17Mysql(session, resourcePrefix = 'q17') {
  if (!/^q\d{1,2}$/.test(resourcePrefix)) throw new Error('resourcePrefix must identify a numbered Quest stage');
  const resourceLabel = suffix => `${resourcePrefix}-mysql-${suffix}`;
  assert.ok(mysqlBase, 'isolated MySQL 8.4 server binary is missing');
  for (const executable of [mysqld, mysql, mysqladmin]) {
    assert.ok(existsSync(executable),
      `isolated MySQL 8.4 binary is missing: ${executable}`);
  }

  const version = await session.runProcess({
    label: resourceLabel('version'), kind: 'probe', role: 'probe', command: mysqld,
    args: ['--version'], cwd: projectRoot, env: { PATH: process.env.PATH || '' }
  }, { timeoutMs: 5000 });
  assertCommand(version, 'MySQL version check');
  assert.match(version.tail, /Ver 8\.4\.11\b/, `unexpected isolated MySQL server: ${version.tail}`);

  const dataDir = await session.allocateDir('mysql-data');
  const port = await availableLoopbackPort();
  const socket = path.join(session.tempDir, 'mysql.sock');
  const pidFile = path.join(session.tempDir, 'mysql.pid');
  const initialize = await session.runProcess({
    label: resourceLabel('initialize'), kind: 'mysql', role: 'test', command: mysqld,
    args: ['--no-defaults', `--basedir=${mysqlBase}`, `--datadir=${dataDir}`, '--initialize-insecure',
      '--innodb-buffer-pool-size=48M', '--innodb-redo-log-capacity=48M', '--skip-log-bin', '--console'],
    cwd: projectRoot, datadir: dataDir, env: { PATH: process.env.PATH || '' }
  }, { timeoutMs: 120_000 });
  assertCommand(initialize, 'isolated MySQL initialization');

  const server = await session.startProcess({
    label: resourceLabel('server'), kind: 'mysql', role: 'mysql', command: mysqld,
    args: ['--no-defaults', `--basedir=${mysqlBase}`, `--datadir=${dataDir}`, `--port=${port}`,
      '--bind-address=127.0.0.1', '--mysqlx=0', `--socket=${socket}`, `--pid-file=${pidFile}`,
      '--innodb-buffer-pool-size=48M', '--innodb-redo-log-capacity=48M', '--skip-log-bin',
      '--skip-name-resolve', '--console'],
    cwd: projectRoot, datadir: dataDir, socket, port, env: { PATH: process.env.PATH || '' },
    shutdownCommand: {
      command: mysqladmin,
      args: ['--no-defaults', '--protocol=SOCKET', `--socket=${socket}`, '--user=root',
        '--connect-timeout=3', '--shutdown-timeout=10', 'shutdown']
    },
    shutdownTimeoutMs: 12_000
  });
  assert.equal(server.status, 'running', `isolated MySQL did not stay running: ${JSON.stringify(server)}`);

  const ready = await session.runProcess({
    label: resourceLabel('readiness'), kind: 'probe', role: 'probe', command: mysqladmin,
    args: ['--no-defaults', '--protocol=SOCKET', `--socket=${socket}`, '--user=root',
      '--connect-timeout=2', '--wait=20', 'ping'],
    cwd: projectRoot, socket, port, datadir: dataDir, env: { PATH: process.env.PATH || '' }
  }, { timeoutMs: 30_000 });
  assertCommand(ready, 'isolated MySQL readiness');
  assert.match(ready.tail, /mysqld is alive/i);

  const loopbackAccount = await session.runProcess({
    label: resourceLabel('loopback-test-account'), kind: 'probe', role: 'probe', command: mysql,
    args: ['--no-defaults', '--protocol=SOCKET', `--socket=${socket}`, '--user=root', '--batch',
      '--skip-column-names', '--execute', "CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY ''; GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION"],
    cwd: projectRoot, socket, port, datadir: dataDir, env: { PATH: process.env.PATH || '' }
  }, { timeoutMs: 10_000 });
  assertCommand(loopbackAccount, 'isolated MySQL loopback test account setup');

  const query = 'SELECT VERSION(), @@transaction_isolation, @@log_bin, @@innodb_buffer_pool_size, @@innodb_redo_log_capacity';
  const settings = await session.runProcess({
    label: resourceLabel('settings'), kind: 'probe', role: 'probe', command: mysql,
    args: ['--no-defaults', '--protocol=TCP', '--host=127.0.0.1', `--port=${port}`, '--user=root', '--batch',
      '--skip-column-names', '--execute', query],
    cwd: projectRoot, socket, port, datadir: dataDir, env: { PATH: process.env.PATH || '' }
  }, { timeoutMs: 10_000 });
  assertCommand(settings, 'isolated MySQL settings query');
  const [serverVersion, isolation, logBin, bufferPool, redoCapacity] = settings.tail.trim().split('\t');
  assert.equal(serverVersion, '8.4.11');
  assert.equal(isolation, 'REPEATABLE-READ');
  assert.equal(logBin, '0');
  assert.equal(Number(bufferPool), 48 * 1024 * 1024);
  assert.equal(Number(redoCapacity), 48 * 1024 * 1024);

  return {
    port, dataDir, socket, pidFile,
    env: {
      DB_DRIVER: 'mysql', DEMO_SEED: '1', MYSQL_HOST: '127.0.0.1', MYSQL_PORT: String(port),
      MYSQL_USER: 'root', MYSQL_PASSWORD: '', MYSQL_DATABASE: 'mysql'
    },
    version: serverVersion, isolation, logBin: Number(logBin), bufferPool: Number(bufferPool), redoCapacity: Number(redoCapacity)
  };
}
