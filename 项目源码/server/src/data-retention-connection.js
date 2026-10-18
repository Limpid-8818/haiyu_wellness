// Dedicated existing-database adapter: no migrations, seed, mkdir, or default DB path.
import fs from 'node:fs';
import path from 'node:path';
import { compileMysqlStatement, mysqlParams, restoreMysqlRows } from './mysql-dialect.js';

export function existingDatabaseConfig(env) {
  if (env.DB_DRIVER === 'sqlite') {
    if (!env.DB_PATH || env.DB_PATH === ':memory:' || !path.isAbsolute(env.DB_PATH)) throw new Error('RETENTION_DATABASE_CONFIG: explicit absolute existing DB_PATH required');
    return { driver: 'sqlite', filename: env.DB_PATH };
  }
  if (env.DB_DRIVER === 'mysql') {
    const port = Number(env.MYSQL_PORT);
    if (!env.MYSQL_HOST || !env.MYSQL_USER || !env.MYSQL_DATABASE || !Number.isInteger(port) || port < 1 || port > 65535
      || env.MYSQL_PASSWORD === undefined) throw new Error('RETENTION_DATABASE_CONFIG: explicit MYSQL_HOST/PORT/USER/DATABASE/PASSWORD required');
    return { driver: 'mysql', host: env.MYSQL_HOST, port, user: env.MYSQL_USER, database: env.MYSQL_DATABASE, password: env.MYSQL_PASSWORD };
  }
  throw new Error('RETENTION_DATABASE_CONFIG: explicit DB_DRIVER=sqlite or mysql required');
}

export async function openExistingRetentionDatabase(config, { readOnly }) {
  if (config.driver === 'sqlite') {
    if (!fs.statSync(config.filename).isFile()) throw new Error('RETENTION_DATABASE_CONFIG: existing regular database required');
    const { DatabaseSync } = await import('node:sqlite');
    // readOnly prevents preview writes, including accidental SQL from future changes.
    // URI mode=rw also refuses to create a missing file if it disappears after stat.
    const handle = new DatabaseSync(`file:${encodeURI(config.filename).replaceAll('?', '%3F').replaceAll('#', '%23')}?mode=${readOnly ? 'ro' : 'rw'}`, { readOnly });
    handle.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000;');
    const db = { driver: 'sqlite', prepare(sql) {
      const statement = handle.prepare(sql);
      return { all: async (...args) => statement.all(...args), get: async (...args) => statement.get(...args), run: async (...args) => statement.run(...args) };
    } };
    return { db, async transaction(callback, options) {
      handle.exec(options.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
      try { const result = await callback(); handle.exec('COMMIT'); return result; }
      catch (error) { try { handle.exec('ROLLBACK'); } catch { /* preserve original */ } throw error; }
    }, async close() { handle.close(); } };
  }
  const { default: mysql } = await import('mysql2/promise');
  const { driver: _driver, ...credentials } = config;
  const handle = await mysql.createConnection({ ...credentials, timezone: 'Z', dateStrings: true, charset: 'utf8mb4', connectTimeout: 1000 });
  try {
    const [rows] = await handle.query('SELECT VERSION() AS version,@@SESSION.sql_mode AS mode');
    if (!String(rows[0].version).startsWith('8.') || /(?:^|,)(ANSI_QUOTES|NO_BACKSLASH_ESCAPES)(?:,|$)/.test(rows[0].mode)) throw new Error('RETENTION_DATABASE_CONFIG: supported MySQL 8 quoting mode required');
    await handle.query("SET time_zone = '+00:00'");
    const db = { driver: 'mysql', prepare(sql) {
      const plan = compileMysqlStatement(sql);
      async function all(args) {
        const [values, fields] = await handle.execute({ sql: plan.sql, rowsAsArray: true }, mysqlParams(plan, args));
        return restoreMysqlRows(values, fields, plan);
      }
      return { all: (...args) => all(args), get: async (...args) => (await all(args))[0], run: async (...args) => {
        const [result] = await handle.execute(plan.sql, mysqlParams(plan, args));
        return { changes: result.affectedRows, lastInsertRowid: result.insertId };
      } };
    } };
    return { db, async transaction(callback, options) {
      await handle.query(options.readOnly ? 'START TRANSACTION READ ONLY' : 'START TRANSACTION');
      try { const result = await callback(); await handle.commit(); return result; }
      catch (error) { try { await handle.rollback(); } catch { /* preserve original */ } throw error; }
    }, async close() { await handle.end(); } };
  } catch (error) { await handle.end(); throw error; }
}
