import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import {
  databaseQuery, formatProbe, login, request, runNodeManaged, withBothDatabaseApis, withMysqlDatabase
} from './q10-helpers.js';

const TEST_NOW = '2026-10-01T10:00:00.000Z';
const TEST_DATE = '2026-10-01';
let activeResourceSession;

function withMetricApis(callback) {
  return withBothDatabaseApis(callback, { env: { BUSINESS_CLOCK_NOW: TEST_NOW }, resourceSession: activeResourceSession });
}

function assertOk(result, status = 200, label = 'health metrics request') {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function guestLogin(context) { return assertOk(await login(context.baseUrl, 'guest'), 200, 'guest login'); }
async function staffLogin(context) { return assertOk(await login(context.baseUrl, 'staff'), 200, 'staff login'); }
async function deanLogin(context) { return assertOk(await login(context.baseUrl, 'dean'), 200, 'dean login'); }

function metricStructured(metric, value, unit) {
  const metricKey = metric;
  const values = metric === 'blood_pressure' ? value : { value };
  const rawValue = metric === 'blood_pressure' ? `${value.systolic}/${value.diastolic}` : String(value);
  return JSON.stringify({ schemaVersion: 1, metricKey, unit, values, rawValue, parseStatus: 'valid', ruleVersion: 'health-metric-v1' });
}

async function insertMetric(context, { guestId = 'guest_001', recorderId = guestId, source = 'guest', metric, value, unit, recordedAt, note = '' }) {
  const physicalValue = context.driver === 'mysql' ? 'value_text' : 'value';
  const jsonValue = context.driver === 'mysql' ? 'CAST(? AS JSON)' : '?';
  const timestamp = context.driver === 'mysql' ? recordedAt.replace('T', ' ').replace(/Z$/, '') : recordedAt;
  const rawValue = metric === 'blood_pressure' ? `${value.systolic}/${value.diastolic}` : String(value);
  await databaseQuery(context, `INSERT INTO health_records
    (guest_id,record_type,${physicalValue},unit,note,recorded_at,recorded_by,source,created_at,structured_value_json)
    VALUES(?,?,?,?,?,?,?,?,?,${jsonValue})`, [
    guestId, ({ blood_pressure: '血压', sleep: '睡眠时长', steps: '步数', weight: '体重' })[metric],
    rawValue, unit, note, timestamp, recorderId, source, timestamp, metricStructured(metric, value, unit)
  ], 'run');
  const row = await databaseQuery(context, `SELECT id FROM health_records WHERE guest_id=? AND record_type=? AND recorded_at=? ORDER BY id DESC LIMIT 1`, [
    guestId, ({ blood_pressure: '血压', sleep: '睡眠时长', steps: '步数', weight: '体重' })[metric], timestamp
  ], 'get');
  return row.id;
}

function input(metric, value, unit, recordedAt = '2026-10-01T09:00:00.000Z') {
  return { metric, value, unit, recordedAt, note: 'Q17 合成记录' };
}

function parseStructured(value) { return typeof value === 'string' ? JSON.parse(value) : value; }

async function q171() {
  const fixtureDirectory = await activeResourceSession.allocateDir('q17-migration-sqlite');
  const fixture = { path: path.join(fixtureDirectory, 'legacy.sqlite'), cleanup: async () => {} };
  try {
    const legacy = new DatabaseSync(fixture.path);
    legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
      CREATE TABLE users(id TEXT PRIMARY KEY);
      CREATE TABLE health_records(id INTEGER PRIMARY KEY,guest_id TEXT NOT NULL,record_type TEXT NOT NULL,value TEXT NOT NULL,
        unit TEXT DEFAULT '',note TEXT DEFAULT '',recorded_at TEXT NOT NULL,recorded_by TEXT NOT NULL);
      INSERT INTO users(id) VALUES('legacy_guest'),('legacy_staff');`);
    for (let version = 1; version <= 10; version += 1) {
      legacy.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(version, `v${version}`, '2026-10-01T00:00:00.000Z');
    }
    legacy.prepare(`INSERT INTO health_records(id,guest_id,record_type,value,unit,note,recorded_at,recorded_by)
      VALUES(?,?,?,?,?,?,?,?)`).run(77, 'legacy_guest', '血压', '138/86', 'mmHg', '晨起测量', '2026-09-14T07:30:00.000Z', 'legacy_staff');
    legacy.prepare(`INSERT INTO health_records(id,guest_id,record_type,value,unit,note,recorded_at,recorded_by)
      VALUES(?,?,?,?,?,?,?,?)`).run(78, 'legacy_guest', '血压', '原样保留，不可解析', 'mmHg', '旧备注', '2026-09-14T08:00:00.000Z', 'legacy_staff');
    legacy.close();

    const first = await runNodeManaged(`const { db, migrationResult } = await import('./src/db.js');
      const rows = await db.prepare('SELECT id,guest_id,record_type,value,unit,note,recorded_at,recorded_by,source,created_at,structured_value_json,voided_at,voided_by,void_reason FROM health_records ORDER BY id').all();
      console.log('Q17_MIGRATION ' + JSON.stringify({ migrationResult, rows }));`, {
      DB_DRIVER: 'sqlite', DB_PATH: fixture.path, DEMO_SEED: '0'
    }, activeResourceSession, 'q17-sqlite-migration');
    const migrated = formatProbe(first, 'Q17_MIGRATION ');
    assert.equal(migrated.migrationResult.applied, 1);
    const parsed = migrated.rows.find(row => row.id === 77);
    assert.deepEqual(parseStructured(parsed.structured_value_json).values, { systolic: 138, diastolic: 86 });
    assert.equal(parseStructured(parsed.structured_value_json).rawValue, '138/86');
    assert.equal(parsed.value, '138/86');
    assert.equal(parsed.guest_id, 'legacy_guest');
    assert.equal(Date.parse(parsed.recorded_at), Date.parse('2026-09-14T07:30:00.000Z'));
    assert.equal(parsed.recorded_by, 'legacy_staff');
    assert.equal(parsed.source, 'staff');
    assert.equal(parsed.note, '晨起测量');
    assert.equal(parsed.created_at, parsed.recorded_at);
    assert.equal(parsed.voided_at, null);
    assert.equal(parsed.voided_by, null);
    assert.equal(parsed.void_reason, null);
    const unparsed = migrated.rows.find(row => row.id === 78);
    assert.equal(parseStructured(unparsed.structured_value_json).parseStatus, 'unparsed_legacy');
    assert.equal(parseStructured(unparsed.structured_value_json).rawValue, '原样保留，不可解析');
    assert.equal(unparsed.value, '原样保留，不可解析');

    const second = await runNodeManaged(`const { db, migrationResult } = await import('./src/db.js');
      const rows = await db.prepare('SELECT id,value,structured_value_json FROM health_records ORDER BY id').all();
      console.log('Q17_RERUN ' + JSON.stringify({ migrationResult, rows }));`, {
      DB_DRIVER: 'sqlite', DB_PATH: fixture.path, DEMO_SEED: '0'
    }, activeResourceSession, 'q17-sqlite-migration-rerun');
    const rerun = formatProbe(second, 'Q17_RERUN ');
    assert.equal(rerun.migrationResult.applied, 0);
    assert.equal(rerun.rows.length, 2);
    assert.equal(parseStructured(rerun.rows[0].structured_value_json).metricKey, 'blood_pressure');
    assert.equal(rerun.rows[0].value, '138/86');
  } finally { await fixture.cleanup(); }

  await withMysqlDatabase(async ({ database, pool, env }) => {
    await pool.query('CREATE TABLE schema_migrations(version INT PRIMARY KEY,name VARCHAR(160) NOT NULL,applied_at DATETIME(3) NOT NULL)');
    await pool.query('CREATE TABLE users(id VARCHAR(36) PRIMARY KEY)');
    await pool.query(`CREATE TABLE health_records(id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,guest_id VARCHAR(36) NOT NULL,
        record_type VARCHAR(64) NOT NULL,value_text VARCHAR(128) NOT NULL,unit VARCHAR(32) NULL,note VARCHAR(1000) NULL,
        source VARCHAR(24) NOT NULL DEFAULT 'staff',recorded_at DATETIME(3) NOT NULL,recorded_by VARCHAR(36) NOT NULL,
        created_at DATETIME(3) NULL)`);
    for (let version = 1; version <= 10; version += 1) {
      await pool.execute('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)', [version, `v${version}`, '2026-10-01 00:00:00.000']);
    }
    await pool.query("INSERT INTO users(id) VALUES('legacy_guest'),('legacy_staff')");
    for (const row of [
      [77, '138/86', '晨起测量', '2026-09-14 07:30:00.000'],
      [78, '原样保留，不可解析', '旧备注', '2026-09-14 08:00:00.000']
    ]) {
      await pool.execute(`INSERT INTO health_records(id,guest_id,record_type,value_text,unit,note,source,recorded_at,recorded_by,created_at)
        VALUES(?,?,?,?,? ,?,'staff',?,'legacy_staff',?)`, [row[0], 'legacy_guest', '血压', row[1], 'mmHg', row[2], row[3], row[3]]);
    }
    const code = `const { db, migrationResult } = await import('./src/db.js');
      const rows = await db.prepare('SELECT id,guest_id,record_type,value,unit,note,recorded_at,recorded_by,source,created_at,structured_value_json,voided_at,voided_by,void_reason FROM health_records ORDER BY id').all();
      console.log('Q17_MYSQL_MIGRATION ' + JSON.stringify({ migrationResult, rows })); await db.close();`;
    const migrated = formatProbe(await runNodeManaged(code, { ...env, DB_DRIVER: 'mysql', DEMO_SEED: '0' },
      activeResourceSession, 'q17-mysql-migration'), 'Q17_MYSQL_MIGRATION ');
    assert.equal(migrated.migrationResult.applied, 1);
    const parsed = migrated.rows.find(row => Number(row.id) === 77);
    assert.deepEqual(parseStructured(parsed.structured_value_json).values, { systolic: 138, diastolic: 86 });
    assert.equal(parsed.value, '138/86');
    assert.equal(parsed.guest_id, 'legacy_guest');
    assert.equal(parsed.recorded_by, 'legacy_staff');
    assert.equal(parsed.source, 'staff');
    assert.equal(Date.parse(parsed.recorded_at), Date.parse('2026-09-14T07:30:00.000Z'));
    assert.equal(Date.parse(parsed.created_at), Date.parse(parsed.recorded_at));
    assert.equal(parsed.voided_at, null);
    assert.equal(parsed.voided_by, null);
    assert.equal(parsed.void_reason, null);
    const unparsed = migrated.rows.find(row => Number(row.id) === 78);
    assert.equal(parseStructured(unparsed.structured_value_json).parseStatus, 'unparsed_legacy');
    assert.equal(unparsed.value, '原样保留，不可解析');
    const rerun = formatProbe(await runNodeManaged(`const { db, migrationResult } = await import('./src/db.js');
      const rows = await db.prepare('SELECT id,value,structured_value_json FROM health_records ORDER BY id').all();
      console.log('Q17_MYSQL_RERUN ' + JSON.stringify({ migrationResult, rows })); await db.close();`, {
      ...env, DB_DRIVER: 'mysql', DEMO_SEED: '0'
    }, activeResourceSession, 'q17-mysql-migration-rerun'), 'Q17_MYSQL_RERUN ');
    assert.equal(rerun.migrationResult.applied, 0);
    assert.equal(rerun.rows.length, 2);
  });

  await withMetricApis(async context => {
    const guest = await guestLogin(context);
    const records = assertOk(await request(context.baseUrl, '/me/health-records', { token: guest.token }));
    const legacyBp = records.find(row => row.id === 1);
    assert.ok(legacyBp, `${context.driver}: seeded source BP record missing`);
    assert.deepEqual(legacyBp.values, { systolic: 138, diastolic: 86 });
    assert.equal(legacyBp.value, '138/86');
    assert.equal(legacyBp.unit, 'mmHg');
    assert.equal(legacyBp.note, '晨起测量');
    assert.equal(legacyBp.source, 'staff');
    assert.equal(legacyBp.recordedBy, 'staff_001');
  });
  return { output: ['v11 adds structure without changing legacy raw values; ID, note, unit, timestamp and recorder remain intact', 'legacy 138/86 parses to systolic/diastolic; malformed legacy values remain raw and unparsed; re-running v11 applies no changes', 'SQLite and MySQL guest APIs expose the migrated demo sample with source and recorder metadata'] };
}

async function q172() {
  await withMetricApis(async context => {
    const guest = await guestLogin(context);
    const staff = await staffLogin(context);
    const dean = await deanLogin(context);
    const countBefore = Number((await databaseQuery(context, "SELECT COUNT(*) AS count FROM health_records WHERE guest_id='guest_001' AND source='guest'", [], 'get')).count);
    const created = assertOk(await request(context.baseUrl, '/me/health-records', {
      method: 'POST', token: guest.token, body: input('blood_pressure', { systolic: 126, diastolic: 78 }, 'mmHg')
    }), 201, 'valid BP input');
    assert.deepEqual(created.values, { systolic: 126, diastolic: 78 });
    assert.equal(created.source, 'guest');
    assert.equal(created.recordedBy, guest.user.id);
    assert.equal(Date.parse(created.recordedAt), Date.parse('2026-10-01T09:00:00.000Z'));

    const invalid = [
      { ...input('blood_pressure', { systolic: 120, diastolic: 80 }, 'kPa'), code: 'HEALTH_METRIC_UNIT_INVALID', field: 'unit' },
      { ...input('blood_pressure', { systolic: 110, diastolic: 120 }, 'mmHg'), code: 'HEALTH_METRIC_FIELD_INVALID', field: 'diastolic' },
      { ...input('blood_pressure', { systolic: -1, diastolic: 70 }, 'mmHg'), code: 'HEALTH_METRIC_FIELD_INVALID', field: 'systolic' },
      { ...input('blood_pressure', { systolic: null, diastolic: 70 }, 'mmHg'), code: 'HEALTH_METRIC_FIELD_INVALID', field: 'systolic' },
      { ...input('sleep', 24.1, 'h'), code: 'HEALTH_METRIC_FIELD_INVALID', field: 'value' },
      { ...input('steps', 2.5, '步'), code: 'HEALTH_METRIC_FIELD_INVALID', field: 'value' },
      { ...input('steps', 100001, '步'), code: 'HEALTH_METRIC_FIELD_INVALID', field: 'value' },
      { ...input('weight', -1, 'kg'), code: 'HEALTH_METRIC_FIELD_INVALID', field: 'value' },
      { ...input('weight', 60, 'kg', '2026-10-02T09:00:00.000Z'), code: 'HEALTH_METRIC_TIME_OUT_OF_RANGE', field: 'recordedAt' }
    ];
    for (const item of invalid) {
      const { code, field, ...body } = item;
      const result = await request(context.baseUrl, '/me/health-records', { method: 'POST', token: guest.token, body });
      assert.equal(result.status, 400, `${context.driver} rejected sample: ${JSON.stringify(result.data)}`);
      assert.equal(result.data.code, code, `${context.driver}: ${JSON.stringify(result.data)}`);
      assert.equal(result.data.details?.field, field);
    }
    for (const account of [staff, dean]) {
      const forbidden = await request(context.baseUrl, '/me/health-records', {
        method: 'POST', token: account.token, body: input('steps', 42, '步')
      });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.data.code, 'GUEST_ONLY');
    }
    const forged = await request(context.baseUrl, '/me/health-records', {
      method: 'POST', token: guest.token,
      body: { ...input('sleep', 7, 'h'), source: 'staff', recordedBy: 'staff_001' }
    });
    assert.equal(forged.status, 400);
    assert.equal(forged.data.code, 'HEALTH_METRIC_FIELD_NOT_ALLOWED');
    const countAfter = Number((await databaseQuery(context, "SELECT COUNT(*) AS count FROM health_records WHERE guest_id='guest_001' AND source='guest'", [], 'get')).count);
    assert.equal(countAfter, countBefore + 1, `${context.driver}: invalid requests must not create records`);
  });
  return { output: ['a valid structured blood pressure returns HTTP 201 with auth-derived source and recorder', 'wrong units, reversed BP, negative/null values, sleep over 24 h, fractional/out-of-range steps and future samples are rejected with field details', 'staff/dean cannot write; forged source/recorder is rejected; invalid requests add no rows on SQLite or MySQL'] };
}

async function q173() {
  await withMetricApis(async context => {
    const guest = await guestLogin(context);
    for (const [metric, value, unit] of [
      ['blood_pressure', { systolic: 120, diastolic: 80 }, 'mmHg'], ['sleep', 7.5, 'h'], ['steps', 8300, '步'], ['weight', 62.4, 'kg']
    ]) {
      const record = assertOk(await request(context.baseUrl, '/me/health-records', {
        method: 'POST', token: guest.token, body: input(metric, value, unit)
      }), 201, `${metric} entry`);
      assert.equal(record.metric, metric);
      assert.equal(record.unit, unit);
      const persisted = assertOk(await request(context.baseUrl, '/me/health-records', { token: guest.token }))
        .find(row => row.id === record.id);
      assert.ok(persisted, `${context.driver}: ${metric} did not persist after reload`);
      assert.equal(persisted.recordedBy, guest.user.id);
    }
    const blocked = await request(context.baseUrl, '/me/health-records', {
      method: 'POST', token: guest.token,
      body: { ...input('steps', 2.2, '步'), recordedAt: '2026-10-01T09:00:00.000Z' }
    });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.data.details.field, 'value');
  });
  return { output: ['all four form contracts persist across a fresh records read on both database drivers', 'invalid step input returns an exact field key for the form error state', 'the live responsive form, Asia/Shanghai rendering and invalid-field presentation are verified by the Stage17 browser evidence'] };
}

async function q174() {
  await withMetricApis(async context => {
    const guest = await guestLogin(context);
    const current = assertOk(await request(context.baseUrl, '/me/health-records', {
      method: 'POST', token: guest.token, body: input('weight', 61.8, 'kg')
    }), 201, 'today record');
    assert.equal(current.source, 'guest');
    assert.equal(current.recordedBy, guest.user.id);
    assert.ok(current.recorderName);
    assert.equal(healthDate(current.recordedAt), TEST_DATE);
    assertOk(await request(context.baseUrl, `/me/health-records/${current.id}`, {
      method: 'DELETE', token: guest.token, body: { reason: '重复录入，保留更准确的一条' }
    }), 200, 'today soft retraction');
    assert.equal((await request(context.baseUrl, '/me/health-records', { token: guest.token })).data.find(row => row.id === current.id).voidReason, '重复录入，保留更准确的一条');
    assert.ok(!(await request(context.baseUrl, '/me/health', { token: guest.token })).data.some(row => row.id === current.id));
    assert.ok(!(await request(context.baseUrl, '/me/health-trends?metric=weight&days=7', { token: guest.token })).data.points.some(point => point.recordIds.includes(current.id)));

    const yesterdayId = await insertMetric(context, {
      guestId: guest.user.id, recorderId: guest.user.id, source: 'guest', metric: 'steps', value: 500,
      unit: '步', recordedAt: '2026-09-30T09:00:00.000Z'
    });
    const yesterday = await request(context.baseUrl, `/me/health-records/${yesterdayId}`, {
      method: 'DELETE', token: guest.token, body: { reason: '迟到的撤回请求' }
    });
    assert.equal(yesterday.status, 409);
    assert.equal(yesterday.data.code, 'HEALTH_RECORD_RETRACT_WINDOW_CLOSED');

    const staffId = await insertMetric(context, {
      guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'steps', value: 700,
      unit: '步', recordedAt: '2026-10-01T08:00:00.000Z'
    });
    const staffRetract = await request(context.baseUrl, `/me/health-records/${staffId}`, {
      method: 'DELETE', token: guest.token, body: { reason: '不能撤回工作人员的记录' }
    });
    assert.equal(staffRetract.status, 403);
    assert.equal(staffRetract.data.code, 'HEALTH_RECORD_RETRACT_FORBIDDEN');
    const auditDetail = context.driver === 'mysql' ? 'detail_json AS detail' : 'detail';
    const audit = await databaseQuery(context, `SELECT actor_id,action,target_type,target_id,${auditDetail} FROM audit_logs
      WHERE action='health_record.retract' ORDER BY id DESC LIMIT 1`, [], 'get');
    assert.equal(audit.actor_id, guest.user.id);
    assert.equal(audit.target_id, String(current.id));
    assert.equal(audit.detail, '重复录入，保留更准确的一条');
  });
  return { output: ['record reads include source, recorder and stable newest-first order; own current-day retraction stores actor and reason', 'retracted records remain visible in history but disappear from active records and trend samples', 'yesterday and staff-source retractions are rejected on SQLite and MySQL'] };
}

function healthDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

async function q175() {
  await withMetricApis(async context => {
    const guest = await guestLogin(context);
    await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'blood_pressure', value: { systolic: 121, diastolic: 81 }, unit: 'mmHg', recordedAt: '2026-09-28T03:00:00.000Z' });
    const laterSameDayId = await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'blood_pressure', value: { systolic: 131, diastolic: 84 }, unit: 'mmHg', recordedAt: '2026-09-28T15:00:00.000Z' });
    const sameTimeFirstId = await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'blood_pressure', value: { systolic: 132, diastolic: 85 }, unit: 'mmHg', recordedAt: '2026-09-29T04:00:00.000Z' });
    const sameTimeWinnerId = await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'blood_pressure', value: { systolic: 133, diastolic: 86 }, unit: 'mmHg', recordedAt: '2026-09-29T04:00:00.000Z' });
    await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'blood_pressure', value: { systolic: 118, diastolic: 78 }, unit: 'mmHg', recordedAt: '2026-09-25T16:30:00.000Z' });
    await insertMetric(context, { guestId: guest.user.id, recorderId: guest.user.id, source: 'guest', metric: 'blood_pressure', value: { systolic: 124, diastolic: 82 }, unit: 'mmHg', recordedAt: '2026-09-30T16:10:00.000Z' });
    const currentLatest = assertOk(await request(context.baseUrl, '/me/health-records', {
      method: 'POST', token: guest.token,
      body: input('blood_pressure', { systolic: 139, diastolic: 89 }, 'mmHg', '2026-10-01T02:00:00.000Z')
    }), 201, 'business midnight BP');
    await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'blood_pressure', value: { systolic: 120, diastolic: 80 }, unit: 'mmHg', recordedAt: '2026-10-01T03:00:00.000Z', note: 'deliberately malformed structured legacy fixture' });
    await databaseQuery(context, `UPDATE health_records SET structured_value_json=${context.driver === 'mysql' ? 'CAST(? AS JSON)' : '?'} WHERE id=?`, [JSON.stringify({ metricKey: 'blood_pressure', values: null, rawValue: '原始未解析', parseStatus: 'unparsed_legacy', unit: 'mmHg' }), Number((await databaseQuery(context, `SELECT id FROM health_records WHERE guest_id=? AND note=? ORDER BY id DESC LIMIT 1`, [guest.user.id, 'deliberately malformed structured legacy fixture'], 'get')).id)], 'run');

    const trend = assertOk(await request(context.baseUrl, '/me/health-trends?metric=blood_pressure&days=7', { token: guest.token }));
    assert.equal(trend.points.length, 7);
    assert.equal(trend.series.length, 2);
    assert.equal(trend.series[0].unit, 'mmHg');
    assert.equal(trend.series[1].unit, 'mmHg');
    assert.equal(trend.aggregation.includes('记录时间最新'), true);
    const byDate = Object.fromEntries(trend.points.map(point => [point.date, point]));
    assert.equal(byDate['2026-09-28'].systolic, 131);
    assert.deepEqual(byDate['2026-09-28'].recordIds, [laterSameDayId]);
    assert.equal(byDate['2026-09-29'].systolic, 133);
    assert.deepEqual(byDate['2026-09-29'].recordIds, [sameTimeWinnerId]);
    assert.notEqual(sameTimeFirstId, sameTimeWinnerId);
    assert.equal(byDate['2026-09-26'].systolic, 118, 'UTC Sep 25 sample belongs to Asia/Shanghai Sep 26');
    assert.equal(byDate['2026-10-01'].systolic, 139);
    assert.deepEqual(byDate['2026-10-01'].recordIds, [currentLatest.id]);
    assert.equal(byDate['2026-09-27'].systolic, null);
    assert.equal(byDate['2026-09-30'].systolic, null);
    assert.equal(trend.series[0].points.find(point => point.date === '2026-09-27').value, null);
    assert.equal(trend.unparsedCount, 1);

    assertOk(await request(context.baseUrl, `/me/health-records/${currentLatest.id}`, {
      method: 'DELETE', token: guest.token, body: { reason: '趋势样本撤回验证' }
    }));
    const afterRetract = assertOk(await request(context.baseUrl, '/me/health-trends?metric=blood_pressure&days=7', { token: guest.token }));
    assert.equal(afterRetract.points.find(point => point.date === '2026-10-01').systolic, 124, 'next-newest active valid sample should be used');
  });
  return { output: ['7-day BP trends use two separate mmHg series and Shanghai business dates, including the UTC/Shanghai midnight boundary', 'daily aggregation selects the newest valid sample; same-time ties select the highest stable ID; every sample links back to its source ID', 'missing days remain null and unparsed legacy values are excluded; retracting newest sample falls back to the next newest valid sample'] };
}

async function q176() {
  await withMetricApis(async context => {
    const guest = await guestLogin(context);
    await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'sleep', value: 7, unit: 'h', recordedAt: '2026-09-26T04:00:00.000Z' });
    await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'sleep', value: 8, unit: 'h', recordedAt: '2026-09-28T04:00:00.000Z' });
    await insertMetric(context, { guestId: guest.user.id, recorderId: 'staff_001', source: 'staff', metric: 'sleep', value: 6.5, unit: 'h', recordedAt: '2026-09-30T04:00:00.000Z' });
    const sleep = assertOk(await request(context.baseUrl, '/me/health-trends?metric=sleep&days=7', { token: guest.token }));
    assert.equal(sleep.series.length, 1);
    assert.equal(sleep.series[0].unit, 'h');
    assert.equal(sleep.points.find(point => point.date === '2026-09-27').value, null);
    assert.equal(sleep.points.find(point => point.date === '2026-09-29').value, null);
    assert.ok(sleep.points.filter(point => point.recordIds.length).every(point => point.recordIds.length === 1));
    const empty = assertOk(await request(context.baseUrl, '/me/health-trends?metric=weight&days=7', { token: guest.token }));
    assert.equal(empty.points.length, 7);
    assert.ok(empty.points.every(point => point.value === null && point.recordIds.length === 0));
    const month = assertOk(await request(context.baseUrl, '/me/health-trends?metric=sleep&days=30', { token: guest.token }));
    assert.equal(month.points.length, 30);
    assert.equal(month.points[0].date, '2026-09-02');
    assert.equal(month.points.at(-1).date, TEST_DATE);
    assert.ok(month.points.filter(point => point.recordIds.length).every(point => point.recordIds.length === 1));
    const steps = assertOk(await request(context.baseUrl, '/me/health-records', {
      method: 'POST', token: guest.token, body: input('steps', 42000, '步')
    }), 201, 'demo outlier record');
    assert.equal(steps.demoOutlier, true);
    assert.equal(steps.demoRule.scope, 'demo-display-only');
    assert.match(steps.demoRule.note, /不代表诊断/);
    const invalidWindow = await request(context.baseUrl, '/me/health-trends?metric=sleep&days=14', { token: guest.token });
    assert.equal(invalidWindow.status, 400);
    assert.equal(invalidWindow.data.code, 'HEALTH_TREND_WINDOW_INVALID');
  });
  return { output: ['sleep and empty metric series keep null gaps with no zero fill; record references remain on every valid point', 'demo outlier is labeled with its display-only rule id/version and non-diagnostic scope', '7/30-day selector contracts reject unsupported windows; custom SVG separates runs at missing dates'] };
}

async function q177() {
  await withMetricApis(async context => {
    const guest = await guestLogin(context);
    const insufficient = assertOk(await request(context.baseUrl, '/me/health-summary?metric=weight&days=7', { token: guest.token }));
    assert.equal(insufficient.status, 'insufficient_data');
    assert.match(insufficient.reason, /至少需要 3 个不同业务日/);
    assert.equal(insufficient.sourceRecordIds.length, 0);
    assert.deepEqual(insufficient.window, { start: '2026-09-25', end: TEST_DATE, timeZone: 'Asia/Shanghai' });
    for (const [recordedAt, weight] of [
      ['2026-09-28T04:00:00.000Z', 61], ['2026-09-29T04:00:00.000Z', 62], ['2026-10-01T08:00:00.000Z', 60.5]
    ]) await insertMetric(context, { guestId: guest.user.id, recorderId: guest.user.id, source: 'guest', metric: 'weight', value: weight, unit: 'kg', recordedAt });
    const ready = assertOk(await request(context.baseUrl, '/me/health-summary?metric=weight&days=7', { token: guest.token }));
    assert.equal(ready.status, 'ready');
    assert.equal(ready.window.start, '2026-09-25');
    assert.equal(ready.window.end, TEST_DATE);
    assert.equal(ready.sampleCount, 3);
    assert.equal(ready.missingDayCount, 4);
    assert.match(ready.changeDescription, /增加|减少/);
    assert.equal(ready.demoRule.id, 'demo-metric-outlier');
    assert.equal(ready.demoRule.version, '1.0.0');
    assert.equal(ready.sourceRecordIds.length, 3);
    assert.equal(new Set(ready.sourceRecordIds).size, 3);
    const summaryAfterRetract = await request(context.baseUrl, `/me/health-records/${ready.sourceRecordIds[2]}`, {
      method: 'DELETE', token: guest.token, body: { reason: '有效摘要撤回一致性验证' }
    });
    assert.equal(summaryAfterRetract.status, 200, JSON.stringify(summaryAfterRetract.data));
    const afterRetract = assertOk(await request(context.baseUrl, '/me/health-summary?metric=weight&days=7', { token: guest.token }));
    assert.equal(afterRetract.status, 'insufficient_data', 'retracted sample must leave the valid summary set');
  });
  return { output: ['read-only summaries report insufficient_data and a documented three-distinct-day minimum', 'ready summaries expose the window, sample/missing-day counts, change description, demo rule id/version and exact source record IDs', 'summary and trend read from the same active sample set without changing therapy/advice or making model calls'] };
}

export async function run({ questId, resourceSession }) {
  if (!resourceSession) throw new Error('Stage17 acceptance requires a managed ResourceSession');
  activeResourceSession = resourceSession;
  const runners = {
    'Q17.1': q171, 'Q17.2': q172, 'Q17.3': q173, 'Q17.4': q174,
    'Q17.5': q175, 'Q17.6': q176, 'Q17.7': q177
  };
  const runQuest = runners[questId];
  if (!runQuest) throw new Error(`Unsupported Stage17 quest: ${questId}`);
  return await runQuest();
}
