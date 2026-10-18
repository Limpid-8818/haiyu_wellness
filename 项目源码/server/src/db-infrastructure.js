import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import { now } from './db-values.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../data');
export const driver = String(process.env.DB_DRIVER || 'sqlite').toLowerCase();
if (!['sqlite', 'mysql'].includes(driver)) throw new Error(`Unsupported DB_DRIVER: ${driver}`);

// G40：LIKE 通配符转义。用户输入中的 %/_/\ 不再被当作通配符；
// SQLite 必须带显式 ESCAPE 子句反斜杠转义才生效（MySQL 默认即支持，子句同样兼容）。
export function escapeLikeValue(value) {
  return `%${String(value ?? '').replace(/[\\%_]/g, char => `\\${char}`)}%`;
}
export function likeEscapeClause() {
  return driver === 'mysql' ? " ESCAPE '\\\\'" : " ESCAPE '\\'";
}

const transactionContext = new AsyncLocalStorage();
let sqliteHandle;
let mysqlPool;
let sqliteTransactionTail = Promise.resolve();

function mysqlConfig() {
  const host = process.env.MYSQL_HOST || '127.0.0.1';
  const port = Number(process.env.MYSQL_PORT);
  const user = process.env.MYSQL_USER;
  const database = process.env.MYSQL_DATABASE;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !user || !database) {
    throw new Error('DB_DRIVER=mysql requires MYSQL_PORT, MYSQL_USER, and MYSQL_DATABASE; no SQLite fallback is attempted');
  }
  return { host, port, user, database };
}

function hasTable(sql, table) {
  return new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+[\\x60"]?${table}[\\x60"]?\\b`, 'i').test(sql);
}

function replaceIdentifier(sql, from, to) {
  return sql.replace(new RegExp(`(^|[^A-Za-z0-9_])${from}([^A-Za-z0-9_]|$)`, 'g'), `$1${to}$2`);
}

function mysqlSql(sql) {
  let translated = sql;
  const mappings = [
    ['guest_profiles', [['check_in', 'check_in_date'], ['check_out', 'check_out_date']]],
    ['health_records', [['value', 'value_text']]],
    ['users', [['avatar', 'avatar_url']]],
    ['news', [['cover', 'cover_url']]],
    ['audit_logs', [['detail', 'detail_json']]],
    ['assistant_messages', [['role', 'sender_role']]],
    ['health_intakes', [['content', 'raw_content'], ['status', 'review_status']]]
  ];
  for (const [table, fields] of mappings) {
    if (!hasTable(translated, table)) continue;
    for (const [from, to] of fields) translated = replaceIdentifier(translated, from, to);
  }
  return translated;
}

function mysqlParams(sql, params) {
  const values = [...params].map(value => {
    if (typeof value === 'string') {
      const timestamp = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
      if (timestamp) {
        const fraction = timestamp[3] || '';
        if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) {
          throw new Error(`MySQL DATETIME(3) cannot preserve SQLite timestamp precision: ${value}`);
        }
        return `${timestamp[1]} ${timestamp[2]}${fraction ? `.${fraction.slice(0, 3)}` : ''}`;
      }
    }
    return value;
  });
  const insertFields = sql.match(/INSERT\s+(?:IGNORE\s+)?INTO\s+[\x60"]?audit_logs[\x60"]?\s*\(([^)]+)\)/i)?.[1];
  if (insertFields) {
    const detailIndex = insertFields.split(',').findIndex(field => field.trim().replaceAll('`', '') === 'detail_json');
    if (detailIndex >= 0 && typeof values[detailIndex] === 'string') values[detailIndex] = JSON.stringify(values[detailIndex]);
  }
  return values;
}

function restoreMysqlAliases(rows, sql) {
  if (!Array.isArray(rows)) return rows;
  const mappings = [
    ['guest_profiles', [['check_in_date', 'check_in'], ['check_out_date', 'check_out']]],
    ['health_records', [['value_text', 'value']]],
    ['users', [['avatar_url', 'avatar']]],
    ['news', [['cover_url', 'cover']]],
    ['audit_logs', [['detail_json', 'detail']]],
    ['assistant_messages', [['sender_role', 'role']]],
    ['health_intakes', [['raw_content', 'content'], ['review_status', 'status']]]
  ];
  return rows.map(source => {
    const row = { ...source };
    for (const [table, fields] of mappings) {
      if (!hasTable(sql, table)) continue;
      for (const [physical, logical] of fields) {
        if (Object.hasOwn(row, physical) && !Object.hasOwn(row, logical)) row[logical] = row[physical];
        if (physical !== logical) delete row[physical];
      }
    }
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') continue;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value)) row[key] = `${value.replace(' ', 'T')}Z`;
    }
    if (Object.hasOwn(row, 'detail')) {
      try {
        const decoded = JSON.parse(row.detail);
        row.detail = typeof decoded === 'string' ? decoded : JSON.stringify(decoded);
      } catch { /* preserve a legacy non-JSON audit detail */ }
    }
    return row;
  });
}

async function mysqlConnection() {
  const context = transactionContext.getStore();
  if (context?.connection) return { connection: context.connection, owned: false };
  const connection = await mysqlPool.getConnection();
  try {
    await connection.query("SET time_zone = '+00:00'");
  } catch (error) {
    connection.release();
    throw error;
  }
  return { connection, owned: true };
}

async function awaitSqliteTransaction() {
  if (transactionContext.getStore()?.driver === 'sqlite') return;
  await sqliteTransactionTail;
}

// G22：SQLite 预编译语句缓存。node:sqlite 的 prepare 是每次执行的主要固定开销；
// 按最终 SQL 文本缓存 StatementSync（线程内复用）。带可变 IN 占位符数量的语句
// 会按占位符个数产生少量缓存条目，规模受各查询 LIMIT 约束。
const sqliteStatementCache = new Map();
function preparedSqliteStatement(sql) {
  let statement = sqliteStatementCache.get(sql);
  if (!statement) {
    statement = sqliteHandle.prepare(sql);
    sqliteStatementCache.set(sql, statement);
  }
  return statement;
}
export function sqliteCachedStatementCount() {
  return sqliteStatementCache.size;
}

function sqliteStatement(sql) {
  return {
    async get(...params) {
      await awaitSqliteTransaction();
      return preparedSqliteStatement(sql).get(...params);
    },
    async all(...params) {
      await awaitSqliteTransaction();
      return preparedSqliteStatement(sql).all(...params);
    },
    async run(...params) {
      await awaitSqliteTransaction();
      return preparedSqliteStatement(sql).run(...params);
    }
  };
}

async function mysqlQuery(sql, params = []) {
  const translated = mysqlSql(sql);
  const { connection, owned } = await mysqlConnection();
  try {
    const [rows] = await connection.execute(translated, mysqlParams(translated, params));
    return restoreMysqlAliases(rows, sql);
  } finally {
    if (owned) connection.release();
  }
}

export const db = {
  driver,
  prepare(sql) {
    if (driver === 'sqlite') return sqliteStatement(sql);
    return {
      get: async (...params) => (await mysqlQuery(sql, params))[0],
      all: async (...params) => mysqlQuery(sql, params),
      run: async (...params) => {
        const translated = mysqlSql(sql);
        const { connection, owned } = await mysqlConnection();
        try {
          const [result] = await connection.execute(translated, mysqlParams(translated, params));
          return { lastInsertRowid: result.insertId, changes: result.affectedRows };
        } finally {
          if (owned) connection.release();
        }
      }
    };
  },
  async exec(sql) {
    if (driver === 'sqlite') {
      await awaitSqliteTransaction();
      return sqliteHandle.exec(sql);
    }
    const { connection, owned } = await mysqlConnection();
    try { return await connection.query(sql); }
    finally { if (owned) connection.release(); }
  },
  async close() {
    if (driver === 'mysql' && mysqlPool) await mysqlPool.end();
    if (driver === 'sqlite' && sqliteHandle) {
      sqliteHandle.close();
      sqliteStatementCache.clear();
    }
  }
};

export async function transaction(callback) {
  if (transactionContext.getStore()) throw new Error('Nested database transactions are not supported');
  if (driver === 'mysql') {
    const connection = await mysqlPool.getConnection();
    try {
      await connection.query("SET time_zone = '+00:00'");
      await connection.beginTransaction();
      const result = await transactionContext.run({ driver, connection }, callback);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch { /* preserve the original error */ }
      throw error;
    } finally { connection.release(); }
  }

  let release;
  const previous = sqliteTransactionTail;
  sqliteTransactionTail = new Promise(resolve => { release = resolve; });
  await previous;
  try {
    sqliteHandle.exec('BEGIN IMMEDIATE');
    const result = await transactionContext.run({ driver }, callback);
    sqliteHandle.exec('COMMIT');
    return result;
  } catch (error) {
    try { sqliteHandle.exec('ROLLBACK'); } catch { /* preserve the original error */ }
    throw error;
  } finally { release(); }
}

export function hasActiveTransaction() {
  return Boolean(transactionContext.getStore());
}

// G44：以下三个基础设施工具此前在 9+ 个业务模块各有一份本地拷贝且语义漂移，统一于此导出。
// 已处于事务内则加入当前事务，否则开启新事务执行 callback。
export function inTransaction(callback) {
  return hasActiveTransaction() ? callback() : transaction(callback);
}

// MySQL 侧行锁后缀；SQLite 依赖全局事务串行链，无需 FOR UPDATE。
export function mysqlLockSuffix() {
  return driver === 'mysql' ? ' FOR UPDATE' : '';
}

// 仅把唯一键/主键冲突识别为“重复”（SQLITE_CONSTRAINT_UNIQUE、SQLite errcode 2067/1555、
// MySQL ER_DUP_ENTRY/1062，外加 better-sqlite3 风格消息）。外键/CHECK/NOT NULL 等
// SQLITE_CONSTRAINT_* 兄弟错误不属于重复，必须原样抛出，不允许被幂等路径吞掉。
export function isUniqueViolation(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'ER_DUP_ENTRY'
    || error?.errcode === 2067 || error?.errcode === 1555 || error?.errno === 1062
    || /UNIQUE constraint failed/i.test(String(error?.message || ''));
}

export async function log(actorId, action, targetType = '', targetId = '', detail = '') {
  return db.prepare('INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(actorId || null, action, targetType, targetId, detail, now());
}

export async function initializeConnection() {
  if (driver === 'sqlite') {
    const configuredPath = process.env.DB_PATH || path.join(dataDir, 'community-v2.sqlite');
    if (configuredPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(configuredPath)), { recursive: true });
    sqliteHandle = new DatabaseSync(configuredPath);
    sqliteHandle.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  } else {
    const config = mysqlConfig();
    mysqlPool = mysql.createPool({
      ...config,
      password: process.env.MYSQL_PASSWORD || '',
      waitForConnections: true,
      connectionLimit: Math.min(20, Math.max(1, Number(process.env.MYSQL_POOL_SIZE) || 10)),
      queueLimit: 0,
      timezone: 'Z',
      dateStrings: true,
      supportBigNumbers: false,
      charset: 'utf8mb4'
    });
    try {
      const [rows] = await mysqlPool.query('SELECT 1 AS ok, VERSION() AS version');
      if (!String(rows[0].version).startsWith('8.')) {
        throw new Error(`unsupported server version ${rows[0].version}; stage 10 requires MySQL 8.x`);
      }
      console.log(`[community] DB_DRIVER=mysql SELECT 1=${rows[0].ok} server=${rows[0].version}`);
    } catch (error) {
      await mysqlPool.end();
      mysqlPool = undefined;
      throw new Error(`MySQL connection ${config.host}:${config.port}/${config.database} failed (${error.code || 'DB_ERROR'}): ${error.message}; no SQLite fallback was attempted`, { cause: error });
    }
  }
}
