import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { withTemporaryApi } from './helpers.js';
import { assertActiveResourceSession } from '../resources/resource-runtime.js';

const questDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectDirectory = path.resolve(questDirectory, '../..');
export const serverDirectory = path.join(projectDirectory, 'server');

function mysqlEnvironment(database) {
  const host = process.env.MYSQL_HOST || '127.0.0.1';
  const port = Number(process.env.MYSQL_PORT);
  const user = process.env.MYSQL_USER;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error('Stage 10 integration tests require an isolated loopback MySQL 8.x instance');
  }
  if (!Number.isInteger(port) || port < 1 || !user) {
    throw new Error('Set MYSQL_HOST=127.0.0.1, MYSQL_PORT and MYSQL_USER for an isolated MySQL 8.x test instance');
  }
  return {
    host, port, user, password: process.env.MYSQL_PASSWORD || '', database,
    timezone: 'Z', dateStrings: true, waitForConnections: true, connectionLimit: 5
  };
}

export async function withMysqlDatabase(callback, { resourceSession } = {}) {
  assertActiveResourceSession(resourceSession, 'withMysqlDatabase');
  const database = `haiyu_q10_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;
  const config = mysqlEnvironment(database);
  const admin = await mysql.createConnection({ ...config, database: undefined });
  let pool;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    pool = mysql.createPool(config);
    const env = {
      DB_DRIVER: 'mysql', DEMO_SEED: '1', MYSQL_HOST: config.host,
      MYSQL_PORT: String(config.port), MYSQL_USER: config.user,
      MYSQL_PASSWORD: config.password, MYSQL_DATABASE: database
    };
    return await callback({ database, pool, env, config });
  } finally {
    if (pool) await pool.end();
    try { await admin.query(`DROP DATABASE IF EXISTS \`${database}\``); }
    finally { await admin.end(); }
  }
}

export async function withDatabaseApi(driver, callback, { seed = true, env: extraEnv = {}, resourceSession } = {}) {
  assertActiveResourceSession(resourceSession, 'withDatabaseApi');
  if (driver === 'sqlite') {
    return withTemporaryApi(
      context => callback({ ...context, driver, pool: null, dbEnv: {
        ...extraEnv, DB_DRIVER: 'sqlite', DB_PATH: context.databasePath, DEMO_SEED: seed ? '1' : '0'
      } }),
      'haiyu-q10-sqlite-',
      { ...extraEnv, DB_DRIVER: 'sqlite', DEMO_SEED: seed ? '1' : '0' },
      { resourceSession }
    );
  }
  if (driver !== 'mysql') throw new Error(`Unsupported test driver: ${driver}`);
  return withMysqlDatabase(({ database, pool, env }) => withTemporaryApi(
    context => callback({ ...context, driver, pool, database, dbEnv: {
      ...env, ...extraEnv, DB_DRIVER: 'mysql', DEMO_SEED: seed ? '1' : '0'
    } }),
    'haiyu-q10-mysql-',
    { ...extraEnv, ...env, DEMO_SEED: seed ? '1' : '0' },
    { resourceSession }
  ), { resourceSession });
}

export async function withBothDatabaseApis(callback, options = {}) {
  assertActiveResourceSession(options.resourceSession, 'withBothDatabaseApis');
  for (const driver of ['sqlite', 'mysql']) {
    await withDatabaseApi(driver, context => callback(context), options);
  }
}

export async function databaseQuery(context, sql, params = [], mode = 'all') {
  if (context.driver === 'mysql') {
    const [rows] = await context.pool.execute(sql, params);
    if (mode === 'run') return rows;
    return mode === 'get' ? rows[0] : rows;
  }
  const database = new DatabaseSync(context.databasePath);
  try {
    const statement = database.prepare(sql);
    if (mode === 'run') return statement.run(...params);
    return mode === 'get' ? statement.get(...params) : statement.all(...params);
  } finally { database.close(); }
}

export async function databaseExec(context, sql) {
  if (context.driver === 'mysql') {
    await context.pool.query(sql);
    return;
  }
  const database = new DatabaseSync(context.databasePath);
  try { database.exec(sql); }
  finally { database.close(); }
}

export async function request(baseUrl, route, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

export async function login(baseUrl, role, password = `${role}2026`) {
  const credentials = { guest: 'guest_demo', staff: 'staff_demo', dean: 'dean_demo' };
  const result = await request(baseUrl, '/auth/login', {
    method: 'POST', body: { username: credentials[role], password, role }
  });
  return result;
}

export function assertOk(result, expected = 200, label = 'request') {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

export function runNode(code, env = {}) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: serverDirectory,
    env: { ...process.env, ...env, LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '' },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024
  });
  return { ...result, combined: `${result.stdout || ''}${result.stderr || ''}` };
}

export async function runNodeManaged(code, env = {}, resourceSession, label = 'quest-node-probe') {
  if (!resourceSession) throw new Error('runNodeManaged requires a ResourceSession');
  const safeEnvironment = Object.fromEntries(
    ['DB_DRIVER', 'DB_PATH', 'DEMO_SEED', 'BUSINESS_CLOCK_NOW', 'MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_USER', 'MYSQL_PASSWORD', 'MYSQL_DATABASE']
      .filter(key => Object.hasOwn(env, key))
      .map(key => [key, String(env[key])])
  );
  const result = await resourceSession.runProcess({
    label, kind: 'probe', role: 'probe', command: process.execPath,
    args: ['--input-type=module', '-e', code], cwd: serverDirectory,
    env: { PATH: process.env.PATH || '', LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '', ...safeEnvironment },
    leaseMs: resourceSession.limits.leaseMs
  }, { timeoutMs: 30_000 });
  return {
    status: result.status === 'exited' && !result.signal && !result.timedOut ? result.exitCode : null,
    stdout: result.tail || '', stderr: '', combined: result.tail || '', resource: result
  };
}

export function runSqliteImporter(sourcePath, env = {}) {
  const importer = path.join(projectDirectory, 'scripts', 'import-sqlite-to-mysql.js');
  const code = [
    "const { spawnSync } = await import('node:child_process');",
    "const child = spawnSync(process.execPath, [" + JSON.stringify(importer) + ', ' + JSON.stringify(sourcePath) + "], {",
    "  cwd: " + JSON.stringify(projectDirectory) + ", env: process.env, encoding: 'utf8', timeout: 30000",
    '});',
    "process.stdout.write(child.stdout || '');",
    "process.stderr.write(child.stderr || '');",
    'process.exitCode = child.status ?? 1;'
  ].join('\n');
  return runNode(code, { ...env, DB_DRIVER: 'mysql', DEMO_SEED: '0' });
}

export async function freshSqlitePath(prefix = 'haiyu-q10-probe-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { directory, path: path.join(directory, 'probe.sqlite'), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export function sqliteSnapshotHash(snapshotPath) {
  return crypto.createHash('sha256').update(readFileSync(snapshotPath)).digest('hex');
}

export function formatProbe(result, marker) {
  assert.equal(result.status, 0, result.combined);
  const line = result.combined.split('\n').find(item => item.startsWith(marker));
  assert.ok(line, `expected ${marker} output, got: ${result.combined}`);
  return JSON.parse(line.slice(marker.length));
}
