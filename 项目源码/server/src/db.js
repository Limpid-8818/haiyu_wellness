import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2/promise';
import { hashPassword as makePasswordHash, verifyPassword as checkPassword } from './password.js';
import { systemBusinessClock } from './clock.js';
import { mysqlCoreSchema, sqliteCoreSchema } from './schema.js';
import { mysqlCatalogSchema, sqliteCatalogSchema } from './catalog-schema.js';
import { mysqlEnvironmentSchema, sqliteEnvironmentSchema } from './environment-schema.js';
import { mysqlBookingSchema, sqliteBookingSchema } from './booking-schema.js';
import { mysqlMealSchema, sqliteMealSchema, mysqlMealReviewSchema, sqliteMealReviewSchema } from './meal-schema.js';
import { sqliteServiceSchema, mysqlServiceSchema } from './service-schema.js';
import { mysqlMoodSchema, sqliteMoodSchema } from './mood-schema.js';
import { mysqlAssistantRunsSchema, sqliteAssistantRunsSchema } from './assistant-runs-schema.js';
import { mysqlStage21Schema, sqliteStage21Schema } from './stage21-schema.js';
import { mysqlStage22Schema, sqliteStage22Schema } from './stage22-schema.js';
import { mysqlStage23Schema, sqliteStage23Schema } from './stage23-schema.js';
import { mysqlStage24Schema, sqliteStage24Schema } from './stage24-schema.js';
import { mysqlStage25Schema, sqliteStage25Schema } from './stage25-schema.js';
import { mysqlStage26Schema, sqliteStage26Schema } from './stage26-schema.js';
import { DISH_SEEDS } from './meal-data.js';
import { KNOWLEDGE_SEEDS, PROJECT_SEEDS, RULE_SEEDS } from './catalog-data.js';
import { JOB_TYPES, stayStatus } from './staffing.js';
import { legacyStructuredValue } from './health-metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../data');
export const driver = String(process.env.DB_DRIVER || 'sqlite').toLowerCase();
if (!['sqlite', 'mysql'].includes(driver)) throw new Error(`Unsupported DB_DRIVER: ${driver}`);

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

function sqliteStatement(sql) {
  return {
    async get(...params) {
      await awaitSqliteTransaction();
      return sqliteHandle.prepare(sql).get(...params);
    },
    async all(...params) {
      await awaitSqliteTransaction();
      return sqliteHandle.prepare(sql).all(...params);
    },
    async run(...params) {
      await awaitSqliteTransaction();
      return sqliteHandle.prepare(sql).run(...params);
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
    if (driver === 'sqlite' && sqliteHandle) sqliteHandle.close();
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

async function migrationRecord(version) {
  return db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version);
}

export async function runVersionedMigration(version, name, action) {
  try { return await action(); }
  catch (error) {
    throw new Error(`migration v${String(version).padStart(3, '0')} (${name}) failed: ${error.message}`, { cause: error });
  }
}

async function seedStage13Catalog(ignoreClause) {
  const stamp = now();
  const projectInsert = `INSERT ${ignoreClause} INTO projects
    (id,slug,name,category,intensity,location,description,suitable_people,contraindications,
      open_windows_json,capacity_per_window,sea_entry,outdoor,activity_tag,active,is_demo,source_reference,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?)`;
  for (const project of PROJECT_SEEDS) {
    await db.prepare(projectInsert).run(
      project.id, project.slug, project.name, project.category, project.intensity,
      project.location, project.description, project.suitablePeople, project.contraindications,
      JSON.stringify({ demo: true, timezone: 'Asia/Shanghai', windows: project.openWindows }),
      project.capacityPerWindow, project.seaEntry ? 1 : 0, project.outdoor ? 1 : 0,
      project.activityTag, '项目依据/基于多智能体的海滨疗养智能康养服务系统.docx 表3；地点、说明补充、窗口与容量为演示数据。', stamp, stamp
    );
  }

  const knowledgeInsert = `INSERT ${ignoreClause} INTO domain_knowledge
    (knowledge_id,domain,title,summary,body,keywords_json,source_name,source_url,source_checked_at,active,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,1,?)`;
  for (const item of KNOWLEDGE_SEEDS) {
    await db.prepare(knowledgeInsert).run(
      item.id, item.domain, item.title, item.summary, item.body, JSON.stringify(item.keywords),
      item.sourceName, item.sourceUrl, stamp, stamp
    );
  }

  const ruleInsert = `INSERT ${ignoreClause} INTO safety_rules
    (rule_id,title,scope,trigger_condition,conditions_json,action,version,source_reference,source_url,demo_note,active,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,?)`;
  for (const rule of RULE_SEEDS) {
    await db.prepare(ruleInsert).run(
      rule.id, rule.title, rule.scope, rule.triggerCondition, JSON.stringify(rule.conditions),
      rule.action, rule.version, rule.sourceReference, rule.sourceUrl, rule.demoNote, stamp
    );
  }
}

async function seedMealCatalog(ignoreClause) {
  for (const dish of DISH_SEEDS) {
    await db.prepare(`INSERT ${ignoreClause} INTO dishes
      (id,name,ingredients_json,allergens_json,dietary_tags_json,audience_tags_json,meal_types_json,slot,
       nutrition_labels_json,source_reference,supply_status,non_seafood_alternative_id,is_demo)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      dish.id, dish.name, JSON.stringify(dish.ingredients), JSON.stringify(dish.allergens),
      JSON.stringify(dish.dietaryTags), JSON.stringify(dish.audienceTags), JSON.stringify(dish.mealTypes),
      dish.slot, JSON.stringify(dish.nutritionLabels), dish.sourceReference, dish.supplyStatus,
      dish.nonSeafoodAlternativeId, dish.isDemo ? 1 : 0
    );
  }
}

async function correctOlderAdultActivityKnowledgeSource() {
  const item = KNOWLEDGE_SEEDS.find(seed => seed.id === 'knowledge-exercise-02');
  if (!item) throw new Error('knowledge-exercise-02 seed is missing');
  const stamp = now();
  await db.prepare(`UPDATE domain_knowledge
    SET source_name=?,source_url=?,source_checked_at=?,updated_at=?
    WHERE knowledge_id=? AND source_name=? AND source_url=?`).run(
    item.sourceName, item.sourceUrl, stamp, stamp, item.id,
    'WHO Physical activity fact sheet',
    'https://www.who.int/news-room/fact-sheets/detail/physical-activity'
  );
}

async function applyMysqlMigration(version, name, up) {
  return runVersionedMigration(version, name, async () => {
    await up();
    await db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
      .run(version, name, now());
  });
}

export async function migrate() {
  let applied = 0;
  if (driver === 'sqlite') {
    await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
    )`);
    const migrations = [
      { version: 1, name: 'core-11-tables', up: async () => db.exec(sqliteCoreSchema) },
      { version: 2, name: 'health-intake-review-state', up: async () => {
        const columns = await db.prepare('PRAGMA table_info(health_intakes)').all();
        if (!columns.some(column => column.name === 'status')) {
          await db.exec("ALTER TABLE health_intakes ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'");
        }
      } },
      { version: 3, name: 'health-intake-session-link', up: async () => {
        const columns = await db.prepare('PRAGMA table_info(health_intakes)').all();
        if (!columns.some(column => column.name === 'session_id')) {
          await db.exec('ALTER TABLE health_intakes ADD COLUMN session_id TEXT REFERENCES assistant_sessions(id) ON DELETE SET NULL');
        }
      } },
      { version: 4, name: 'staff-job-type-capabilities-admission-plan', up: async () => {
        const userColumns = await db.prepare('PRAGMA table_info(users)').all();
        if (!userColumns.some(column => column.name === 'job_type')) {
          await db.exec('ALTER TABLE users ADD COLUMN job_type TEXT');
        }
        const profileColumns = await db.prepare('PRAGMA table_info(guest_profiles)').all();
        if (!profileColumns.some(column => column.name === 'stay_plan')) {
          await db.exec('ALTER TABLE guest_profiles ADD COLUMN stay_plan TEXT');
        }
        await db.exec(`UPDATE users SET job_type='clinician' WHERE role='staff' AND (job_type IS NULL OR job_type='')`);
        await db.exec(`UPDATE users SET job_type=NULL WHERE role<>'staff' AND job_type IS NOT NULL`);
        await db.exec('CREATE INDEX IF NOT EXISTS idx_users_job_type_status ON users(job_type,status)');
        await db.exec(`CREATE TABLE IF NOT EXISTS job_capability_settings (
          job_type TEXT NOT NULL CHECK (job_type IN ('clinician','administrator','coach','therapist','dietitian')),
          capability_key TEXT NOT NULL CHECK (capability_key='operations.summary.view'),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
          updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(job_type,capability_key)
        )`);
        for (const { value } of JOB_TYPES) {
          await db.prepare(`INSERT OR IGNORE INTO job_capability_settings(job_type,capability_key,enabled,updated_by,updated_at)
            VALUES(?,?,1,NULL,?)`).run(value, 'operations.summary.view', now());
        }
      } },
      { version: 5, name: 'structured-health-self-report-review', up: async () => {
        const profileColumns = await db.prepare('PRAGMA table_info(guest_profiles)').all();
        const profileNames = new Set(profileColumns.map(column => column.name));
        if (!profileNames.has('health_profile_json')) {
          await db.exec("ALTER TABLE guest_profiles ADD COLUMN health_profile_json TEXT NOT NULL DEFAULT '{}'");
        }
        if (!profileNames.has('health_profile_version')) {
          await db.exec('ALTER TABLE guest_profiles ADD COLUMN health_profile_version INTEGER NOT NULL DEFAULT 0');
        }

        const intakeColumns = await db.prepare('PRAGMA table_info(health_intakes)').all();
        const intakeNames = new Set(intakeColumns.map(column => column.name));
        const additions = [
          ['structured_json', 'TEXT'],
          ['risk_level', "TEXT NOT NULL DEFAULT 'normal'"],
          ['reviewed_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL'],
          ['reviewed_at', 'TEXT'],
          ['review_note', 'TEXT'],
          ['submitted_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL'],
          ['base_profile_version', 'INTEGER NOT NULL DEFAULT 0'],
          ['revision', 'INTEGER NOT NULL DEFAULT 0'],
          ['fingerprint', 'TEXT'],
          ['before_json', 'TEXT'],
          ['after_json', 'TEXT'],
          ['verified_before_json', 'TEXT'],
          ['verified_after_json', 'TEXT']
        ];
        for (const [column, definition] of additions) {
          if (!intakeNames.has(column)) await db.exec(`ALTER TABLE health_intakes ADD COLUMN ${column} ${definition}`);
        }
        await db.exec('UPDATE health_intakes SET revision=id WHERE revision=0');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_intakes_guest_status_revision ON health_intakes(guest_id,status,revision)');
        await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_intakes_guest_revision ON health_intakes(guest_id,revision)');
        await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_intakes_form_fingerprint ON health_intakes(guest_id,submitted_by,fingerprint)');
      } },
      { version: 6, name: 'projects-knowledge-and-deterministic-rules', up: async () => {
        await db.exec(sqliteCatalogSchema);
        await seedStage13Catalog('OR IGNORE');
      } },
      { version: 7, name: 'correct-older-adult-activity-knowledge-source', up: correctOlderAdultActivityKnowledgeSource },
      { version: 8, name: 'environment-provider-snapshots', up: async () => db.exec(sqliteEnvironmentSchema) },
      { version: 9, name: 'project-slots-and-guest-reservations', up: async () => db.exec(sqliteBookingSchema) },
      { version: 10, name: 'meal-menus-orders-and-demo-dish-catalog', up: async () => {
        await db.exec(sqliteMealSchema);
        await seedMealCatalog('OR IGNORE');
      } },
      { version: 11, name: 'structured-health-metrics-and-retraction-audit', up: async () => {
        const columns = await db.prepare('PRAGMA table_info(health_records)').all();
        const names = new Set(columns.map(column => column.name));
        const additions = [
          ['source', "TEXT NOT NULL DEFAULT 'staff'"],
          ['created_at', 'TEXT'],
          ['structured_value_json', 'TEXT'],
          ['voided_at', 'TEXT'],
          ['voided_by', 'TEXT REFERENCES users(id) ON DELETE SET NULL'],
          ['void_reason', 'TEXT']
        ];
        for (const [column, definition] of additions) {
          if (!names.has(column)) await db.exec(`ALTER TABLE health_records ADD COLUMN ${column} ${definition}`);
        }
        await db.exec(`UPDATE health_records SET created_at=recorded_at WHERE created_at IS NULL OR created_at=''`);
        await db.exec('CREATE INDEX IF NOT EXISTS idx_health_guest_void_recorded ON health_records(guest_id,voided_at,recorded_at,id)');
        const legacyRows = await db.prepare('SELECT id,record_type,value,unit FROM health_records WHERE structured_value_json IS NULL').all();
        for (const row of legacyRows) {
          await db.prepare('UPDATE health_records SET structured_value_json=? WHERE id=? AND structured_value_json IS NULL')
            .run(JSON.stringify(legacyStructuredValue(row)), row.id);
        }
      } },
      { version: 12, name: 'daily-mood-focus-and-resource-use', up: async () => db.exec(sqliteMoodSchema) },
      { version: 13, name: 'assistant-agent-runs-and-tool-checkpoints', up: async () => db.exec(sqliteAssistantRunsSchema) },
      { version: 14, name: 'assistant-persisted-clarification-state', up: async () => {
        const columns = await db.prepare('PRAGMA table_info(agent_runs)').all();
        if (!columns.some(column => column.name === 'clarification_state_json')) {
          await db.exec("ALTER TABLE agent_runs ADD COLUMN clarification_state_json TEXT NOT NULL DEFAULT '{}'");
        }
      } },
      { version: 15, name: 'stage20-agent-graph-and-source-mode', up: async () => {
        const runColumns = await db.prepare('PRAGMA table_info(agent_runs)').all();
        const runNames = new Set(runColumns.map(column => column.name));
        const additions = [
          ['parent_run_id', 'TEXT'],
          ['agent_id', 'TEXT'],
          ['instruction_version', 'TEXT'],
          ['agent_input_json', "TEXT NOT NULL DEFAULT '{}'"],
          ['structured_output_json', "TEXT NOT NULL DEFAULT '{}'"],
          ['orchestration_json', "TEXT NOT NULL DEFAULT '{}'"],
          ['execution_mode', "TEXT NOT NULL DEFAULT 'unknown'"]
        ];
        for (const [column, definition] of additions) {
          if (!runNames.has(column)) await db.exec(`ALTER TABLE agent_runs ADD COLUMN ${column} ${definition}`);
        }
        const messageColumns = await db.prepare('PRAGMA table_info(assistant_messages)').all();
        if (!messageColumns.some(column => column.name === 'run_id')) {
          await db.exec('ALTER TABLE assistant_messages ADD COLUMN run_id TEXT');
        }
        await db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs(parent_run_id,created_at,id)');
        await db.exec('CREATE INDEX IF NOT EXISTS idx_assistant_messages_run ON assistant_messages(run_id)');
      } },
      { version: 16, name: 'model-provider-safe-error-diagnostics', up: async () => {
        const columns = await db.prepare('PRAGMA table_info(agent_steps)').all();
        if (!columns.some(column => column.name === 'diagnostic_json')) {
          await db.exec("ALTER TABLE agent_steps ADD COLUMN diagnostic_json TEXT NOT NULL DEFAULT '{}'");
        }
      } },
      { version: 17, name: 'stage21-resumable-assessment-and-inactive-itinerary-drafts', up: async () => db.exec(sqliteStage21Schema) },
      { version: 18, name: 'stage22-clinician-review-versioning-and-activation', up: async () => db.exec(sqliteStage22Schema) },
      { version: 19, name: 'stage22-review-request-replay-index', up: async () => {
        await db.exec('CREATE INDEX IF NOT EXISTS idx_wellness_review_request ON wellness_review_events(actor_id,action,request_key,created_at)');
      } },
      { version: 20, name: 'stage22-distinguish-approval-after-clinician-revision', up: async () => {
        const existing = await db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='wellness_review_events'").get();
        if (!existing) throw new Error('wellness_review_events is missing');
        if (existing.sql.includes('approved_after_revision')) return;
        await db.exec('ALTER TABLE wellness_review_events RENAME TO wellness_review_events_v20_old');
        await db.exec(`CREATE TABLE wellness_review_events (
          id TEXT PRIMARY KEY,
          draft_id TEXT NOT NULL REFERENCES wellness_drafts(id) ON DELETE RESTRICT,
          review_thread_id TEXT NOT NULL,
          guest_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          actor_role TEXT NOT NULL CHECK (actor_role IN ('clinician','administrator','guest','system')),
          action TEXT NOT NULL CHECK (action IN ('revision','approved','approved_after_revision','returned','auto_activated','corrected')),
          reason TEXT NOT NULL DEFAULT '',
          from_version INTEGER,
          to_version INTEGER,
          request_key TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          UNIQUE(draft_id,actor_id,action,request_key)
        )`);
        await db.exec(`INSERT INTO wellness_review_events
          (id,draft_id,review_thread_id,guest_id,actor_id,actor_role,action,reason,from_version,to_version,request_key,payload_json,created_at)
          SELECT id,draft_id,review_thread_id,guest_id,actor_id,actor_role,action,reason,from_version,to_version,request_key,payload_json,created_at
          FROM wellness_review_events_v20_old`);
        await db.exec('DROP TABLE wellness_review_events_v20_old');
        await db.exec('CREATE INDEX idx_wellness_review_events_guest_time ON wellness_review_events(guest_id,created_at DESC)');
        await db.exec('CREATE INDEX idx_wellness_review_events_thread ON wellness_review_events(review_thread_id,created_at,id)');
        await db.exec('CREATE INDEX idx_wellness_review_request ON wellness_review_events(actor_id,action,request_key,created_at)');
      } },
      { version: 21, name: 'stage23-assistant-confirmed-business-actions', up: async () => {
        const columns = await db.prepare('PRAGMA table_info(health_records)').all();
        if (!columns.some(column => column.name === 'source_session_id')) {
          await db.exec('ALTER TABLE health_records ADD COLUMN source_session_id TEXT REFERENCES assistant_sessions(id) ON DELETE SET NULL');
        }
        await db.exec('CREATE INDEX IF NOT EXISTS idx_health_source_session ON health_records(source_session_id)');
        await db.exec(sqliteStage23Schema);
      } },
      { version: 22, name: 'assistant-run-explicit-stop-reasons', up: async () => {
        const columns = await db.prepare('PRAGMA table_info(agent_runs)').all();
        if (!columns.some(column => column.name === 'stop_reason')) {
          await db.exec('ALTER TABLE agent_runs ADD COLUMN stop_reason TEXT');
        }
      } },
      { version: 23, name: 'stage24-execution-feedback-and-replanning-events', up: async () => {
        const columns = await db.prepare('PRAGMA table_info(mood_records)').all();
        if (!columns.some(column => column.name === 'revision')) {
          await db.exec('ALTER TABLE mood_records ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
        }
        await db.exec(sqliteStage24Schema);
      } },
      { version: 24, name: 'stage25-daily-briefs-and-notifications', up: async () => {
        await db.exec(sqliteStage25Schema);
      } },
      { version: 25, name: 'stage26-operations-schedules-and-incidents', up: async () => {
        await db.exec(sqliteStage26Schema);
      } },
      { version: 26, name: 'meal-restriction-and-order-review', up: async () => {
        await db.exec(sqliteMealReviewSchema);
      } },
      { version: 27, name: 'staff-service-execution', up: async () => { await db.exec(sqliteServiceSchema); } }
    ];
    for (const migration of migrations) {
      if (await migrationRecord(migration.version)) continue;
      await runVersionedMigration(migration.version, migration.name, async () => {
        await transaction(async () => {
          await migration.up();
          await db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)')
            .run(migration.version, migration.name, now());
        });
      });
      applied += 1;
    }
    return { applied };
  }

  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INT NOT NULL PRIMARY KEY, name VARCHAR(160) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  const migrations = [
    { version: 1, name: 'core-11-tables', up: async () => {
      for (const statement of mysqlCoreSchema) await db.exec(statement);
    } },
    { version: 2, name: 'health-intake-review-state', up: async () => {
      const column = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='health_intakes' AND COLUMN_NAME='review_status'`).get();
      if (!column) {
        await db.exec("ALTER TABLE health_intakes ADD COLUMN review_status VARCHAR(24) NOT NULL DEFAULT 'pending', ADD INDEX idx_intakes_review_status(review_status), ADD CONSTRAINT chk_intakes_review_status CHECK (review_status IN ('pending','confirmed','rejected'))");
      }
    } },
    { version: 3, name: 'health-intake-session-link', up: async () => {
      const column = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='health_intakes' AND COLUMN_NAME='session_id'`).get();
      if (!column) {
        await db.exec('ALTER TABLE health_intakes ADD COLUMN session_id VARCHAR(64) NULL, ADD INDEX idx_intakes_session(session_id), ADD CONSTRAINT fk_intakes_session FOREIGN KEY(session_id) REFERENCES assistant_sessions(id) ON DELETE SET NULL');
      }
    } },
    { version: 4, name: 'staff-job-type-capabilities-admission-plan', up: async () => {
      const userColumn = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='job_type'`).get();
      if (!userColumn) await db.exec('ALTER TABLE users ADD COLUMN job_type VARCHAR(24) NULL');
      const profileColumn = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='guest_profiles' AND COLUMN_NAME='stay_plan'`).get();
      if (!profileColumn) await db.exec('ALTER TABLE guest_profiles ADD COLUMN stay_plan VARCHAR(16) NULL');
      await db.exec(`UPDATE users SET job_type='clinician' WHERE role='staff' AND (job_type IS NULL OR job_type='')`);
      await db.exec(`UPDATE users SET job_type=NULL WHERE role<>'staff' AND job_type IS NOT NULL`);
      const userIndex = await db.prepare(`SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND INDEX_NAME='idx_users_job_type_status'`).get();
      if (!userIndex) await db.exec('CREATE INDEX idx_users_job_type_status ON users(job_type,status)');
      const userConstraint = await db.prepare(`SELECT CONSTRAINT_NAME AS name FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_users_job_type'`).get();
      if (!userConstraint) await db.exec(`ALTER TABLE users ADD CONSTRAINT chk_users_job_type
        CHECK (job_type IS NULL OR job_type IN ('clinician','administrator','coach','therapist','dietitian'))`);
      const stayConstraint = await db.prepare(`SELECT CONSTRAINT_NAME AS name FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_guest_profiles_stay_plan'`).get();
      if (!stayConstraint) await db.exec(`ALTER TABLE guest_profiles ADD CONSTRAINT chk_guest_profiles_stay_plan
        CHECK (stay_plan IS NULL OR stay_plan IN ('three_night','ten_night'))`);
      await db.exec(`CREATE TABLE IF NOT EXISTS job_capability_settings (
        job_type VARCHAR(24) NOT NULL,
        capability_key VARCHAR(64) NOT NULL,
        enabled TINYINT(1) NOT NULL DEFAULT 1,
        updated_by VARCHAR(36) NULL,
        updated_at DATETIME(3) NOT NULL,
        PRIMARY KEY(job_type,capability_key),
        CONSTRAINT chk_job_capability_type CHECK (job_type IN ('clinician','administrator','coach','therapist','dietitian')),
        CONSTRAINT chk_job_capability_key CHECK (capability_key='operations.summary.view'),
        CONSTRAINT chk_job_capability_enabled CHECK (enabled IN (0,1)),
        CONSTRAINT fk_job_capability_updater FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
      for (const { value } of JOB_TYPES) {
        await db.prepare(`INSERT IGNORE INTO job_capability_settings(job_type,capability_key,enabled,updated_by,updated_at)
          VALUES(?,?,1,NULL,?)`).run(value, 'operations.summary.view', now());
      }
    } },
    { version: 5, name: 'structured-health-self-report-review', up: async () => {
      const columnExists = async (table, column) => db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`).get(table, column);
      const addColumn = async (table, column, definition) => {
        if (!await columnExists(table, column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      };
      await addColumn('guest_profiles', 'health_profile_json', 'JSON NULL');
      await addColumn('guest_profiles', 'health_profile_version', 'INT UNSIGNED NOT NULL DEFAULT 0');
      const intakeColumns = [
        ['structured_json', 'JSON NULL'],
        ['risk_level', "VARCHAR(16) NOT NULL DEFAULT 'normal'"],
        ['reviewed_by', 'VARCHAR(36) NULL'],
        ['reviewed_at', 'DATETIME(3) NULL'],
        ['review_note', 'VARCHAR(1000) NULL'],
        ['submitted_by', 'VARCHAR(36) NULL'],
        ['base_profile_version', 'INT UNSIGNED NOT NULL DEFAULT 0'],
        ['revision', 'BIGINT UNSIGNED NOT NULL DEFAULT 0'],
        ['fingerprint', 'CHAR(64) NULL'],
        ['before_json', 'JSON NULL'],
        ['after_json', 'JSON NULL'],
        ['verified_before_json', 'JSON NULL'],
        ['verified_after_json', 'JSON NULL']
      ];
      for (const [column, definition] of intakeColumns) await addColumn('health_intakes', column, definition);
      await db.exec('UPDATE health_intakes SET revision=id WHERE revision=0');

      const fkSubmitter = await db.prepare(`SELECT CONSTRAINT_NAME AS name FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='health_intakes' AND CONSTRAINT_NAME='fk_intakes_submitter'`).get();
      if (!fkSubmitter) await db.exec('ALTER TABLE health_intakes ADD CONSTRAINT fk_intakes_submitter FOREIGN KEY(submitted_by) REFERENCES users(id) ON DELETE SET NULL');

      const sourceConstraint = await db.prepare(`SELECT CONSTRAINT_NAME AS name FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_intakes_source'`).get();
      if (sourceConstraint) await db.exec('ALTER TABLE health_intakes DROP CHECK chk_intakes_source');
      await db.exec("ALTER TABLE health_intakes ADD CONSTRAINT chk_intakes_source CHECK (source IN ('assistant','manual','import','form'))");

      const hasIndex = async name => db.prepare(`SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='health_intakes' AND INDEX_NAME=?`).get(name);
      if (!await hasIndex('idx_intakes_guest_status_revision')) await db.exec('CREATE INDEX idx_intakes_guest_status_revision ON health_intakes(guest_id,review_status,revision)');
      if (!await hasIndex('uq_intakes_guest_revision')) await db.exec('CREATE UNIQUE INDEX uq_intakes_guest_revision ON health_intakes(guest_id,revision)');
      if (!await hasIndex('uq_intakes_form_fingerprint')) await db.exec('CREATE UNIQUE INDEX uq_intakes_form_fingerprint ON health_intakes(guest_id,submitted_by,fingerprint)');
    } },
    { version: 6, name: 'projects-knowledge-and-deterministic-rules', up: async () => {
      for (const statement of mysqlCatalogSchema) await db.exec(statement);
      await seedStage13Catalog('IGNORE');
    } },
    { version: 7, name: 'correct-older-adult-activity-knowledge-source', up: correctOlderAdultActivityKnowledgeSource },
    { version: 8, name: 'environment-provider-snapshots', up: async () => {
      for (const statement of mysqlEnvironmentSchema) await db.exec(statement);
    } },
    { version: 9, name: 'project-slots-and-guest-reservations', up: async () => {
      for (const statement of mysqlBookingSchema) await db.exec(statement);
    } },
    { version: 10, name: 'meal-menus-orders-and-demo-dish-catalog', up: async () => {
      for (const statement of mysqlMealSchema) await db.exec(statement);
      await seedMealCatalog('IGNORE');
    } },
    { version: 11, name: 'structured-health-metrics-and-retraction-audit', up: async () => {
      const columnExists = async column => db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='health_records' AND COLUMN_NAME=?`).get(column);
      const addColumn = async (column, definition) => {
        if (!await columnExists(column)) await db.exec(`ALTER TABLE health_records ADD COLUMN ${column} ${definition}`);
      };
      await addColumn('created_at', 'DATETIME(3) NULL');
      await addColumn('structured_value_json', 'JSON NULL');
      await addColumn('voided_at', 'DATETIME(3) NULL');
      await addColumn('voided_by', 'VARCHAR(36) NULL');
      await addColumn('void_reason', 'VARCHAR(500) NULL');
      await db.exec('UPDATE health_records SET created_at=recorded_at WHERE created_at IS NULL');
      const indexExists = await db.prepare(`SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='health_records' AND INDEX_NAME='idx_health_guest_void_recorded'`).get();
      if (!indexExists) await db.exec('CREATE INDEX idx_health_guest_void_recorded ON health_records(guest_id,voided_at,recorded_at,id)');
      const fkExists = await db.prepare(`SELECT CONSTRAINT_NAME AS name FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='health_records' AND CONSTRAINT_NAME='fk_health_voider'`).get();
      if (!fkExists) await db.exec('ALTER TABLE health_records ADD CONSTRAINT fk_health_voider FOREIGN KEY(voided_by) REFERENCES users(id) ON DELETE SET NULL');
      const legacyRows = await db.prepare('SELECT id,record_type,value,unit FROM health_records WHERE structured_value_json IS NULL').all();
      for (const row of legacyRows) {
        await db.prepare('UPDATE health_records SET structured_value_json=? WHERE id=? AND structured_value_json IS NULL')
          .run(JSON.stringify(legacyStructuredValue(row)), row.id);
      }
    } },
    { version: 12, name: 'daily-mood-focus-and-resource-use', up: async () => {
      for (const statement of mysqlMoodSchema) await db.exec(statement);
    } },
    { version: 13, name: 'assistant-agent-runs-and-tool-checkpoints', up: async () => {
      for (const statement of mysqlAssistantRunsSchema) await db.exec(statement);
    } },
    { version: 14, name: 'assistant-persisted-clarification-state', up: async () => {
      const column = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_runs' AND COLUMN_NAME='clarification_state_json'`).get();
      if (!column) await db.exec('ALTER TABLE agent_runs ADD COLUMN clarification_state_json JSON NULL');
    } },
    { version: 15, name: 'stage20-agent-graph-and-source-mode', up: async () => {
      const columnExists = async (table, column) => db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`).get(table, column);
      const addColumn = async (table, column, definition) => {
        if (!await columnExists(table, column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      };
      await addColumn('agent_runs', 'parent_run_id', 'VARCHAR(64) NULL');
      await addColumn('agent_runs', 'agent_id', 'VARCHAR(64) NULL');
      await addColumn('agent_runs', 'instruction_version', 'VARCHAR(32) NULL');
      await addColumn('agent_runs', 'agent_input_json', 'JSON NULL');
      await addColumn('agent_runs', 'structured_output_json', 'JSON NULL');
      await addColumn('agent_runs', 'orchestration_json', 'JSON NULL');
      await addColumn('agent_runs', 'execution_mode', "VARCHAR(24) NOT NULL DEFAULT 'unknown'");
      await addColumn('assistant_messages', 'run_id', 'VARCHAR(64) NULL');
      const sessionModeConstraint = await db.prepare(`SELECT CONSTRAINT_NAME AS name FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_sessions_mode'`).get();
      if (sessionModeConstraint) await db.exec('ALTER TABLE assistant_sessions DROP CHECK chk_sessions_mode');
      await db.exec(`ALTER TABLE assistant_sessions ADD CONSTRAINT chk_sessions_mode
        CHECK (mode IN ('live','safe_guidance','fallback','recorded_fixture'))`);
      const indexExists = async (table, index) => db.prepare(`SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?`).get(table, index);
      if (!await indexExists('agent_runs', 'idx_agent_runs_parent')) {
        await db.exec('CREATE INDEX idx_agent_runs_parent ON agent_runs(parent_run_id,created_at,id)');
      }
      if (!await indexExists('assistant_messages', 'idx_assistant_messages_run')) {
        await db.exec('CREATE INDEX idx_assistant_messages_run ON assistant_messages(run_id)');
      }
    } },
    { version: 16, name: 'model-provider-safe-error-diagnostics', up: async () => {
      const column = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_steps' AND COLUMN_NAME='diagnostic_json'`).get();
      if (!column) await db.exec('ALTER TABLE agent_steps ADD COLUMN diagnostic_json JSON NULL');
    } },
    { version: 17, name: 'stage21-resumable-assessment-and-inactive-itinerary-drafts', up: async () => {
      for (const statement of mysqlStage21Schema) await db.exec(statement);
    } },
    { version: 18, name: 'stage22-clinician-review-versioning-and-activation', up: async () => {
      for (const statement of mysqlStage22Schema) await db.exec(statement);
    } },
    { version: 19, name: 'stage22-review-request-replay-index', up: async () => {
      const index = await db.prepare(`SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='wellness_review_events' AND INDEX_NAME='idx_wellness_review_request'`).get();
      if (!index) await db.exec('CREATE INDEX idx_wellness_review_request ON wellness_review_events(actor_id,action,request_key,created_at)');
    } },
    { version: 20, name: 'stage22-distinguish-approval-after-clinician-revision', up: async () => {
      const constraint = await db.prepare(`SELECT CONSTRAINT_NAME AS name,CHECK_CLAUSE AS clause FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_wellness_review_action'`).get();
      if (constraint?.clause && !constraint.clause.includes('approved_after_revision')) {
        await db.exec('ALTER TABLE wellness_review_events DROP CHECK chk_wellness_review_action');
      }
      if (!constraint?.clause || !constraint.clause.includes('approved_after_revision')) {
        await db.exec(`ALTER TABLE wellness_review_events ADD CONSTRAINT chk_wellness_review_action
          CHECK(action IN ('revision','approved','approved_after_revision','returned','auto_activated','corrected'))`);
      }
    } },
    { version: 21, name: 'stage23-assistant-confirmed-business-actions', up: async () => {
      const column = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='health_records' AND COLUMN_NAME='source_session_id'`).get();
      if (!column) await db.exec('ALTER TABLE health_records ADD COLUMN source_session_id VARCHAR(64) NULL');
      const index = await db.prepare(`SELECT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='health_records' AND INDEX_NAME='idx_health_source_session'`).get();
      if (!index) await db.exec('CREATE INDEX idx_health_source_session ON health_records(source_session_id)');
      const constraint = await db.prepare(`SELECT CONSTRAINT_NAME AS name FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='health_records' AND CONSTRAINT_NAME='fk_health_source_session'`).get();
      if (!constraint) await db.exec(`ALTER TABLE health_records ADD CONSTRAINT fk_health_source_session
        FOREIGN KEY(source_session_id) REFERENCES assistant_sessions(id) ON DELETE SET NULL`);
      for (const statement of mysqlStage23Schema) await db.exec(statement);
    } },
    { version: 22, name: 'assistant-run-explicit-stop-reasons', up: async () => {
      const column = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='agent_runs' AND COLUMN_NAME='stop_reason'`).get();
      if (!column) await db.exec('ALTER TABLE agent_runs ADD COLUMN stop_reason VARCHAR(96) NULL');
    } },
    { version: 23, name: 'stage24-execution-feedback-and-replanning-events', up: async () => {
      const column = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='mood_records' AND COLUMN_NAME='revision'`).get();
      if (!column) await db.exec('ALTER TABLE mood_records ADD COLUMN revision INT UNSIGNED NOT NULL DEFAULT 1');
      for (const statement of mysqlStage24Schema) await db.exec(statement);
    } },
    { version: 24, name: 'stage25-daily-briefs-and-notifications', up: async () => {
      for (const statement of mysqlStage25Schema) await db.exec(statement);
    } },
    { version: 25, name: 'stage26-operations-schedules-and-incidents', up: async () => {
      for (const statement of mysqlStage26Schema) await db.exec(statement);
    } },
    { version: 26, name: 'meal-restriction-and-order-review', up: async () => {
      for (const statement of mysqlMealReviewSchema) await db.exec(statement);
    } },
    { version: 27, name: 'staff-service-execution', up: async () => { await db.exec(mysqlServiceSchema); } }
  ];
  for (const migration of migrations) {
    if (await migrationRecord(migration.version)) continue;
    await applyMysqlMigration(migration.version, migration.name, migration.up);
    applied += 1;
  }
  return { applied };
}

export function hashPassword(password) { return makePasswordHash(password); }
export function verifyPassword(password, stored) { return checkPassword(password, stored); }
export function id(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
export function now() { return systemBusinessClock.utc(); }
export function json(value, fallback = []) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; }
  catch { return fallback; }
}

export async function log(actorId, action, targetType = '', targetId = '', detail = '') {
  return db.prepare('INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?)')
    .run(actorId || null, action, targetType, targetId, detail, now());
}

async function seedDemo() {
  const count = Number((await db.prepare('SELECT COUNT(*) AS count FROM users').get()).count);
  if (count) return { seeded: false, reason: 'users already exist' };
  const guestId = 'guest_001';
  const staffId = 'staff_001';
  const deanId = 'dean_001';
  const stamp = now();
  const demoCheckIn = systemBusinessClock.dateKey();
  const demoCheckOutDate = new Date(`${demoCheckIn}T12:00:00Z`);
  demoCheckOutDate.setUTCDate(demoCheckOutDate.getUTCDate() + 14);
  const demoCheckOut = demoCheckOutDate.toISOString().slice(0, 10);
  await transaction(async () => {
    await db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)')
      .run(guestId, 'guest_demo', hashPassword('guest2026'), 'guest', '林海宁', '13800000001');
    await db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone,job_type) VALUES(?,?,?,?,?,?,?)')
      .run(staffId, 'staff_demo', hashPassword('staff2026'), 'staff', '王医生', '13800000002', 'clinician');
    await db.prepare('INSERT INTO users(id,username,password_hash,role,name,phone) VALUES(?,?,?,?,?,?)')
      .run(deanId, 'dean_demo', hashPassword('dean2026'), 'dean', '周院长', '13800000003');
    await db.prepare(`INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(guestId, '女', '1958-06-18', 'A-203', demoCheckIn, demoCheckOut, '林先生 13900000001', JSON.stringify(['高血压']), JSON.stringify(['虾']), '可独立行走');
    await db.prepare(`INSERT INTO staff_guest_assignments
      (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(staffId, guestId, stamp, null, 'active', deanId, stamp, stamp);
    const rows = [
      ['健康管理','入住后的第一件事：建立自己的康养档案','先完成基础资料与健康状况登记，工作人员会据此安排服务。','欢迎来到海屿康养社区。完整的档案能帮助工作人员了解您的需要，所有信息仅在授权范围内使用。','2026-09-13T08:00:00.000Z',1],
      ['滨海活动','本周末海风漫步活动开放报名','沿着东湾海岸线慢行 90 分钟，适合大多数客人。','活动由康养服务团队带队，出发前会根据天气与身体情况进行确认。','2026-09-12T10:00:00.000Z',0],
      ['营养膳食','秋季海滨膳食菜单更新','低盐、易消化、时令食材，本周已上线。','餐单由营养师与配餐团队共同更新，客人可在个人空间查看适合自己的饮食提醒。','2026-09-10T09:00:00.000Z',0]
    ];
    for (const row of rows) {
      await db.prepare('INSERT INTO news(category,title,summary,body,published_at,pinned) VALUES(?,?,?,?,?,?)').run(...row);
    }
    await db.prepare(`INSERT INTO health_records
      (guest_id,record_type,value,unit,note,recorded_at,recorded_by,source,created_at,structured_value_json)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      guestId, '血压', '138/86', 'mmHg', '晨起测量', '2026-09-14T07:30:00.000Z', staffId, 'staff', stamp,
      JSON.stringify({ schemaVersion: 1, metricKey: 'blood_pressure', unit: 'mmHg', values: { systolic: 138, diastolic: 86 }, rawValue: '138/86', parseStatus: 'valid', ruleVersion: 'health-metric-v1' })
    );
    await db.prepare('INSERT INTO medical_advice(guest_id,author_id,title,content,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(guestId, staffId, '近期温泉安排', '近期血压略高，建议选择低温、短时温泉，单次不超过 15 分钟；如出现头晕或胸闷请立即停止并联系工作人员。', 'important', 'active', stamp, stamp);
  });
  return { seeded: true };
}

export const demoSeed = process.env.DEMO_SEED === '1';
export let migrationResult = { applied: 0 };
export let demoSeedResult = { seeded: false, reason: 'DEMO_SEED is not enabled' };

async function initialize() {
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
  migrationResult = await migrate();
  if (demoSeed) demoSeedResult = await seedDemo();
}

await initialize();

export function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, role: row.role, name: row.name, phone: row.phone || '', avatar: row.avatar || '',
    jobType: row.role === 'staff' ? (row.job_type || 'clinician') : null
  };
}

export async function guestProfile(userId) {
  const row = await db.prepare(`SELECT user_id,gender,birth_date,room_no,check_in,check_out,stay_plan,
    emergency_contact,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at
    FROM guest_profiles WHERE user_id=?`).get(userId);
  if (!row) return null;
  return {
    ...row,
    chronic: json(row.chronic_json),
    allergies: json(row.allergies_json),
    health_profile: json(row.health_profile_json, {}),
    health_profile_version: Number(row.health_profile_version || 0),
    chronic_json: undefined,
    allergies_json: undefined,
    health_profile_json: undefined
  };
}

export async function guestSummary(userId) {
  const user = await db.prepare("SELECT id,name,username,phone,role,status,avatar FROM users WHERE id=? AND role='guest' AND status='active'").get(userId);
  if (!user) return null;
  const profile = await guestProfile(userId);
  const latestHealth = await db.prepare(`SELECT id,guest_id,record_type,value,unit,note,recorded_at,recorded_by,source,
    structured_value_json,created_at FROM health_records WHERE guest_id=? AND voided_at IS NULL
    ORDER BY recorded_at DESC,id DESC LIMIT 5`).all(userId);
  const health = latestHealth.map(row => ({ ...row, structured_value_json: json(row.structured_value_json, null) }));
  const advice = await db.prepare(`SELECT a.id,a.title,a.content,a.priority,a.status,a.created_at,a.updated_at,u.name AS author_name
    FROM medical_advice a JOIN users u ON u.id=a.author_id
    WHERE a.guest_id=? AND a.status='active' ORDER BY a.created_at DESC`).all(userId);
  return { ...publicUser(user), profile, admissionStatus: stayStatus(profile?.check_in, profile?.check_out), health, advice };
}
