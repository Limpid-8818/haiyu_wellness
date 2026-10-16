import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0',
  // 固定业务时钟：上海时间 2026-10-16 09:00，使窗口/时序断言完全确定
  BUSINESS_CLOCK_NOW: '2026-10-16T09:00:00+08:00'
});
const { app } = await import('../src/app.js');
const { db, now } = await import('../src/db.js');
const { shiftDateKey } = await import('../src/clock.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });

const today = '2026-10-16';
const yesterday = shiftDateKey(today, -1);
const dayBefore = shiftDateKey(today, -2);

async function call(token, route, method = 'GET', body, expected = 200) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}

function structuredJson(metricKey, unit, values) {
  return JSON.stringify({ schemaVersion: 1, metricKey, unit, values,
    rawValue: metricKey === 'blood_pressure' ? `${values.systolic}/${values.diastolic}` : String(values.value),
    parseStatus: 'valid', ruleVersion: 'health-metric-v1' });
}

async function insertRecord({ type, value, unit, recordedAt, source = 'guest', structured = null, recordedBy = 'guest_001' }) {
  await db.prepare(`INSERT INTO health_records
    (guest_id,record_type,value,unit,note,recorded_at,recorded_by,source,created_at,structured_value_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    'guest_001', type, value, unit, '', recordedAt, recordedBy, source, now(), structured);
}

const guest = (await call(null, '/auth/login', 'POST', { username: 'guest_demo', password: 'guest2026', role: 'guest' })).token;

test('录入校验：指标、单位、数值、时区与时间范围逐项拒绝', async () => {
  const base8601 = `${today}T08:00:00+08:00`;
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'blood_pressure', value: { systolic: 120, diastolic: 80 }, unit: 'mmHg', recordedAt: base8601, foo: 1 }, 400)).code, 'HEALTH_METRIC_FIELD_NOT_ALLOWED');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'blood_sugar', value: 5, unit: 'mmol/L', recordedAt: base8601 }, 400)).code, 'HEALTH_METRIC_TYPE_INVALID');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'blood_pressure', value: { systolic: 120, diastolic: 80 }, unit: 'kPa', recordedAt: base8601 }, 400)).code, 'HEALTH_METRIC_UNIT_INVALID');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'blood_pressure', value: { systolic: 120, diastolic: 130 }, unit: 'mmHg', recordedAt: base8601 }, 400)).code, 'HEALTH_METRIC_FIELD_INVALID');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'blood_pressure', value: '120/80', unit: 'mmHg', recordedAt: base8601 }, 400)).code, 'HEALTH_METRIC_FIELD_INVALID');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'sleep', value: '7', unit: 'h', recordedAt: base8601 }, 400)).code, 'HEALTH_METRIC_FIELD_INVALID');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'steps', value: 8000.5, unit: '步', recordedAt: base8601 }, 400)).code, 'HEALTH_METRIC_FIELD_INVALID');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'steps', value: 100001, unit: '步', recordedAt: base8601 }, 400)).code, 'HEALTH_METRIC_FIELD_INVALID');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'sleep', value: 7, unit: 'h', recordedAt: '2026-10-16 08:00' }, 400)).code, 'HEALTH_METRIC_TIME_INVALID');
  assert.equal((await call(guest, '/me/health-records', 'POST',
    { metric: 'sleep', value: 7, unit: 'h', recordedAt: '2030-01-01T00:00:00Z' }, 400)).code, 'HEALTH_METRIC_TIME_OUT_OF_RANGE');
});

let morningBpId;
test('血压与体重结构化录入成功，演示离群值被标记', async () => {
  const morning = await call(guest, '/me/health-records', 'POST',
    { metric: 'blood_pressure', value: { systolic: 138, diastolic: 86 }, unit: 'mmHg',
      recordedAt: `${today}T08:00:00+08:00`, note: '晨起测量' }, 201);
  assert.equal(morning.parseStatus, 'valid');
  assert.equal(morning.displayValue, '138/86');
  assert.deepEqual(morning.values, { systolic: 138, diastolic: 86 });
  assert.equal(morning.demoOutlier, false);
  assert.equal(morning.source, 'guest');
  morningBpId = morning.id;

  const evening = await call(guest, '/me/health-records', 'POST',
    { metric: 'blood_pressure', value: { systolic: 158, diastolic: 95 }, unit: 'mmHg',
      recordedAt: `${today}T08:50:00+08:00` }, 201);
  assert.equal(evening.displayValue, '158/95');

  const weight = await call(guest, '/me/health-records', 'POST',
    { metric: 'weight', value: 205.2, unit: 'kg', recordedAt: `${today}T08:55:00+08:00` }, 201);
  assert.equal(weight.demoOutlier, true, '触及演示阈值的记录必须带标记');
  assert.ok(weight.demoRule.note.includes('不代表诊断'));
});

test('当日列表返回全部本人记录（含演示种子的一条血压）', async () => {
  const items = await call(guest, '/me/health');
  assert.equal(items.length, 4);
  assert.ok(items.every(item => !item.voidedAt));
});

test('趋势每个业务日取最晚有效样本，无解析样本单独计数', async () => {
  const bp = await call(guest, '/me/health-trends?metric=blood_pressure&days=7');
  assert.equal(bp.metric, 'blood_pressure');
  assert.equal(bp.metricLabel, '血压');
  assert.equal(bp.timeZone, 'Asia/Shanghai');
  assert.equal(bp.points.length, 7);
  assert.equal(bp.sampleCount, 1);
  assert.equal(bp.missingDayCount, 6);
  assert.equal(bp.unparsedCount, 0);
  assert.equal(bp.points[6].date, today);
  assert.equal(bp.points[6].systolic, 158, '同日两次录入必须取更晚的一次');
  assert.equal(bp.points[6].diastolic, 95);
  assert.deepEqual(bp.points[6].recordIds, [bp.points[6].recordIds[0]]);
  assert.equal(bp.series.length, 2);
  assert.equal(bp.series[0].key, 'systolic');
  assert.equal(bp.series[0].points[6].value, 158);

  const weight = await call(guest, '/me/health-trends?metric=weight&days=7');
  assert.equal(weight.points[6].value, 205.2);
  assert.equal(weight.points[6].demoOutlier, true);

  assert.equal((await call(guest, '/me/health-trends?metric=heart_rate&days=7', 'GET', undefined, 400)).code, 'HEALTH_METRIC_TYPE_INVALID');
  assert.equal((await call(guest, '/me/health-trends?metric=weight&days=8', 'GET', undefined, 400)).code, 'HEALTH_TREND_WINDOW_INVALID');
});

test('摘要样本不足时明确说明，补齐三日样本后给出区间变化', async () => {
  const insufficient = await call(guest, '/me/health-summary?metric=weight&days=7');
  assert.equal(insufficient.status, 'insufficient_data');
  assert.ok(insufficient.reason.includes('至少需要 3'));
  assert.equal(insufficient.minimumSampleDays, 3);
  assert.equal(insufficient.changeDescription, null);

  for (const [date, value] of [[dayBefore, '71'], [yesterday, '70.2']]) {
    await insertRecord({ type: '体重', value, unit: 'kg', recordedAt: `${date}T12:00:00+08:00`,
      structured: structuredJson('weight', 'kg', { value: Number(value) }) });
  }
  const ready = await call(guest, '/me/health-summary?metric=weight&days=7');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.sampleCount, 3);
  assert.match(ready.changeDescription, /增加134\.2 kg/);
  assert.equal(ready.seriesChanges.length, 1);
  assert.equal(ready.seriesChanges[0].difference, 134.2);
  assert.equal(ready.window.start, shiftDateKey(today, -6));
  assert.equal(ready.window.end, today);
});

test('撤回：必填原因、限本人当日记录、幂等防重复', async () => {
  assert.equal((await call(guest, `/me/health-records/${morningBpId}`, 'DELETE', {}, 400)).code, 'HEALTH_RECORD_RETRACT_REASON_REQUIRED');
  const retracted = await call(guest, `/me/health-records/${morningBpId}`, 'DELETE', { reason: '早上量错了' });
  assert.equal(retracted.voidedBy, 'guest_001');
  assert.equal(retracted.voidReason, '早上量错了');
  assert.ok(retracted.voidedAt);
  assert.equal((await call(guest, `/me/health-records/${morningBpId}`, 'DELETE', { reason: '再次撤回' }, 409)).code, 'HEALTH_RECORD_ALREADY_RETRACTED');

  const active = await call(guest, '/me/health');
  assert.equal(active.length, 5, '已撤回记录不再出现在默认列表');
  const all = await call(guest, '/me/health-records');
  assert.equal(all.length, 6);
  const voided = all.find(item => item.id === morningBpId);
  assert.ok(voided.voidedAt && voided.voidReason === '早上量错了');
});

test('只能撤回本人录入、上海时间当天录入的记录', async () => {
  await insertRecord({ type: '血压', value: '120/80', unit: 'mmHg', recordedAt: `${today}T08:30:00+08:00`,
    source: 'staff', recordedBy: 'staff_001', structured: structuredJson('blood_pressure', 'mmHg', { systolic: 120, diastolic: 80 }) });
  const staffRecord = (await call(guest, '/me/health-records')).find(item => item.source === 'staff');
  assert.equal((await call(guest, `/me/health-records/${staffRecord.id}`, 'DELETE', { reason: '不是我的记录' }, 403)).code, 'HEALTH_RECORD_RETRACT_FORBIDDEN');

  await insertRecord({ type: '体重', value: '70', unit: 'kg', recordedAt: `${yesterday}T10:00:00+08:00`,
    structured: structuredJson('weight', 'kg', { value: 70 }) });
  const oldRecord = (await call(guest, '/me/health-records')).find(item => item.recordedAt.startsWith(yesterday));
  assert.equal((await call(guest, `/me/health-records/${oldRecord.id}`, 'DELETE', { reason: '隔日补录' }, 409)).code, 'HEALTH_RECORD_RETRACT_WINDOW_CLOSED');
});

test('旧格式无法解析的记录不进入趋势样本，但计入未解析数', async () => {
  await insertRecord({ type: '血压', value: '偏高', unit: 'mmHg', recordedAt: `${today}T08:20:00+08:00` });
  const bp = await call(guest, '/me/health-trends?metric=blood_pressure&days=7');
  assert.equal(bp.unparsedCount, 1);
  assert.equal(bp.points[6].systolic, 158, '无法解析的历史记录不得顶替有效样本');
  const listed = (await call(guest, '/me/health-records')).find(item => item.value === '偏高');
  assert.equal(listed.parseStatus, 'unparsed_legacy');
  assert.equal(listed.values, null);
});
