// Pure fixture configuration. No process, account or database is created on import.
import assert from 'node:assert/strict';
import path from 'node:path';
import { classifyProcessResult } from '../g23-sql-dialect/mysql-lifecycle.js';
import { parseRootSettings, singleCliRow } from '../g23-sql-dialect/mysql-cli-output.js';
export const clientIsolation = ['--no-defaults', '--no-login-paths', '--skip-password'];
export const identitySql = 'SELECT CURRENT_USER(),DATABASE()';

export function validateApplication(config) {
  assert.equal(config.host, '127.0.0.1'); assert.equal(config.user, 'g42_probe'); assert.equal(config.password, '');
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port <= 65535);
  assert.ok(![3306, 50634, 51016, 64525, 64812].includes(config.port), 'default/previous fixture port forbidden');
  // No '_' or '%' in database names: grant scope must not contain database wildcards.
  assert.match(config.database, /^g42[a-z0-9]{1,61}$/);
  return config;
}
export function fixtureApplication(taskId, attempt, port) {
  assert.match(taskId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.match(attempt, /^mysql[0-9]{2}$/);
  return validateApplication({ host: '127.0.0.1', port, user: 'g42_probe', password: '',
    database: `g42${taskId.replaceAll('-', '')}${attempt}` });
}
export function rootSocketArgs(socket) {
  assert.ok(path.isAbsolute(socket) && path.normalize(socket) === socket && socket.endsWith('/mysql.sock'));
  return [...clientIsolation, '--protocol=SOCKET', `--socket=${socket}`, '--user=root', '--connect-timeout=1'];
}
export function applicationTcpArgs(config) {
  validateApplication(config);
  return [...clientIsolation, '--protocol=TCP', '--host=127.0.0.1', `--port=${config.port}`,
    `--user=${config.user}`, `--database=${config.database}`, '--connect-timeout=1'];
}
export function rootPreparationSql(config) {
  validateApplication(config);
  return `SELECT VERSION(),@@log_bin,@@innodb_buffer_pool_size,@@innodb_redo_log_capacity,@@sql_mode; `
    + `CREATE DATABASE \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; `
    + "CREATE USER 'g42_probe'@'127.0.0.1' IDENTIFIED BY ''; "
    + `GRANT ALL PRIVILEGES ON \`${config.database}\`.* TO 'g42_probe'@'127.0.0.1';`;
}
export function verifyTcpIdentity(result, config) {
  const output = singleCliRow(result, 2);
  assert.equal(output.columns[0], `${config.user}@127.0.0.1`);
  assert.equal(output.columns[1], config.database);
  return { ...output, parsed: { currentUser: output.columns[0], database: output.columns[1] } };
}
export async function prepareFixtureAccount({ config, root, tcp, deadline, now = Date.now }) {
  validateApplication(config);
  const started = now(); assert.ok(deadline > started && deadline - started <= 2000, 'setup must share <=2000ms');
  function remaining() { const ms = deadline - now(); assert.ok(ms > 0, 'shared setup deadline exhausted'); return ms; }
  const prepared = await root(rootPreparationSql(config), remaining());
  classifyProcessResult(prepared); assert.ok(now() <= deadline, 'root setup exceeded shared deadline');
  const settings = parseRootSettings(prepared);
  const identity = await tcp(identitySql, remaining());
  classifyProcessResult(identity); assert.ok(now() <= deadline, 'TCP identity exceeded shared setup deadline');
  return { settings, identity: verifyTcpIdentity(identity, config), elapsedMs: now() - started };
}
