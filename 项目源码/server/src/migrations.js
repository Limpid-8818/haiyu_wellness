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
import { db, driver, transaction } from './db-infrastructure.js';
import { now } from './db-values.js';
import { JOB_TYPES } from './staffing.js';
import { legacyStructuredValue } from './health-metric-values.js';
import { seedStage13Catalog, seedMealCatalog, correctOlderAdultActivityKnowledgeSource } from './catalog-seed.js';

async function migrationRecord(version) {
  return db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(version);
}

export async function runVersionedMigration(version, name, action) {
  try { return await action(); }
  catch (error) {
    throw new Error(`migration v${String(version).padStart(3, '0')} (${name}) failed: ${error.message}`, { cause: error });
  }
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
      { version: 27, name: 'staff-service-execution', up: async () => { await db.exec(sqliteServiceSchema); } },
      { version: 28, name: 'hot-query-performance-indexes', up: async () => {
        // G09/G13：environment_snapshots 按 target_date 的查询此前只有 (location_id,…) 前导索引可用；
        // audit_logs / medical_advice / agent_runs 在 SQLite 建表时无索引（MySQL 已有）。
        await db.exec(`CREATE INDEX IF NOT EXISTS idx_environment_target_date ON environment_snapshots(target_date,domain,updated_at);
          CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_created ON audit_logs(actor_id,created_at);
          CREATE INDEX IF NOT EXISTS idx_medical_advice_guest_status ON medical_advice(guest_id,status);
          CREATE INDEX IF NOT EXISTS idx_agent_runs_client_request ON agent_runs(client_request_id);
          CREATE INDEX IF NOT EXISTS idx_agent_runs_actor_role_created ON agent_runs(actor_id,assistant_role,created_at);`);
      } },
      { version: 29, name: 'user-token-version', up: async () => {
        // G11：令牌版本号。修改密码时递增，使该用户已签发的旧 token 立即失效。
        const columns = await db.prepare('PRAGMA table_info(users)').all();
        if (!columns.some(column => column.name === 'token_version')) {
          await db.exec('ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0');
        }
      } }
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
    { version: 27, name: 'staff-service-execution', up: async () => { await db.exec(mysqlServiceSchema); } },
    { version: 28, name: 'hot-query-performance-indexes', up: async () => {
      const indexExists = async (table, indexName) => Number((await db.prepare(
        `SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME=?`
      ).get(table, indexName)).n || 0) > 0;
      const ensureIndex = async (table, indexName, ddl) => {
        if (!(await indexExists(table, indexName))) await db.exec(ddl);
      };
      await ensureIndex('environment_snapshots', 'idx_environment_target_date',
        'CREATE INDEX idx_environment_target_date ON environment_snapshots(target_date,domain,updated_at)');
      await ensureIndex('audit_logs', 'idx_audit_logs_actor_created',
        'CREATE INDEX idx_audit_logs_actor_created ON audit_logs(actor_id,created_at)');
      await ensureIndex('medical_advice', 'idx_medical_advice_guest_status',
        'CREATE INDEX idx_medical_advice_guest_status ON medical_advice(guest_id,status)');
      await ensureIndex('agent_runs', 'idx_agent_runs_client_request',
        'CREATE INDEX idx_agent_runs_client_request ON agent_runs(client_request_id)');
      await ensureIndex('agent_runs', 'idx_agent_runs_actor_role_created',
        'CREATE INDEX idx_agent_runs_actor_role_created ON agent_runs(actor_id,assistant_role,created_at)');
    } },
    { version: 29, name: 'user-token-version', up: async () => {
      // G11：令牌版本号。修改密码时递增，使该用户已签发的旧 token 立即失效。
      const column = await db.prepare(`SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='token_version'`).get();
      if (!column) await db.exec('ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0');
    } }
  ];
  for (const migration of migrations) {
    if (await migrationRecord(migration.version)) continue;
    await applyMysqlMigration(migration.version, migration.name, migration.up);
    applied += 1;
  }
  return { applied };
}
