import { AppError } from './errors.js';
import { db, log, now, transaction } from './db.js';
import { shiftDateKey, systemBusinessClock } from './clock.js';
import { recordReplanSourceEvent } from './wellness-source-events.js';

import { HEALTH_METRIC_RULE_VERSION, HEALTH_DEMO_RULE, HEALTH_METRICS, metricKey, legacyStructuredValue } from './health-metric-values.js';
export { HEALTH_METRIC_RULE_VERSION, HEALTH_DEMO_RULE, HEALTH_METRICS, legacyStructuredValue } from './health-metric-values.js';

function strictNumber(value, field, { min, max, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AppError(400, 'HEALTH_METRIC_FIELD_INVALID', `${field} 必须是有限数字`, { field });
  }
  if (integer && !Number.isInteger(value)) {
    throw new AppError(400, 'HEALTH_METRIC_FIELD_INVALID', `${field} 必须是整数`, { field });
  }
  if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
    const range = `${min ?? '无下限'} 至 ${max ?? '无上限'}`;
    throw new AppError(400, 'HEALTH_METRIC_FIELD_INVALID', `${field} 超出演示录入范围（${range}）`, { field, min, max });
  }
  return value;
}

function asStructured(row) {
  const raw = row.structuredValueJson ?? row.structured_value_json;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { /* fallback to conservative legacy parser */ }
  }
  return legacyStructuredValue(row);
}

function demoOutlier(key, values) {
  if (!values) return false;
  if (key === 'blood_pressure') return values.systolic >= 180 || values.diastolic >= 120;
  if (key === 'sleep') return values.value >= 16;
  if (key === 'steps') return values.value >= 40000;
  if (key === 'weight') return values.value <= 30 || values.value >= 200;
  return false;
}

export function publicHealthRecord(row) {
  const structured = asStructured(row);
  const key = structured.metricKey || metricKey(row.record_type ?? row.type);
  const definition = key ? HEALTH_METRICS[key] : null;
  const valid = structured.parseStatus === 'valid' && structured.values && definition;
  return {
    id: row.id,
    type: row.record_type ?? row.type ?? '',
    metric: key,
    metricLabel: definition?.label || row.record_type || row.type || '其他记录',
    value: row.value ?? structured.rawValue ?? '',
    displayValue: valid && key === 'blood_pressure'
      ? `${structured.values.systolic}/${structured.values.diastolic}`
      : valid ? String(structured.values.value) : String(row.value ?? structured.rawValue ?? ''),
    values: valid ? structured.values : null,
    unit: row.unit || structured.unit || '',
    note: row.note || '',
    parseStatus: valid ? 'valid' : 'unparsed_legacy',
    source: row.source || 'staff',
    recordedAt: row.recordedAt ?? row.recorded_at ?? '',
    createdAt: row.createdAt ?? row.created_at ?? '',
    recordedBy: row.recordedBy ?? row.recorded_by ?? '',
    sourceSessionId: row.sourceSessionId ?? row.source_session_id ?? null,
    recorderName: row.recorderName ?? row.recorder_name ?? '',
    voidedAt: row.voidedAt ?? row.voided_at ?? null,
    voidedBy: row.voidedBy ?? row.voided_by ?? null,
    voidReason: row.voidReason ?? row.void_reason ?? '',
    demoOutlier: Boolean(valid && demoOutlier(key, structured.values)),
    demoRule: HEALTH_DEMO_RULE
  };
}

export function validateHealthMetricInput(body, user, clock = systemBusinessClock) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'HEALTH_METRIC_INVALID_BODY', '健康指标请求体必须是对象');
  }
  const allowed = ['metric', 'value', 'unit', 'recordedAt', 'note'];
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) throw new AppError(400, 'HEALTH_METRIC_FIELD_NOT_ALLOWED', '请求中包含不允许的字段', { fields: unknown });
  const definition = HEALTH_METRICS[body.metric];
  if (!definition) throw new AppError(400, 'HEALTH_METRIC_TYPE_INVALID', '请选择支持的健康指标', { field: 'metric' });
  if (body.unit !== definition.unit) {
    throw new AppError(400, 'HEALTH_METRIC_UNIT_INVALID', `${definition.label}单位必须为 ${definition.unit}`, { field: 'unit', expected: definition.unit });
  }

  let values;
  if (body.metric === 'blood_pressure') {
    if (!body.value || typeof body.value !== 'object' || Array.isArray(body.value)) {
      throw new AppError(400, 'HEALTH_METRIC_FIELD_INVALID', '请填写收缩压和舒张压', { field: 'value' });
    }
    const keys = Object.keys(body.value);
    if (keys.some(key => !['systolic', 'diastolic'].includes(key))) {
      throw new AppError(400, 'HEALTH_METRIC_FIELD_INVALID', '血压只接受收缩压和舒张压', { field: 'value' });
    }
    const systolic = strictNumber(body.value.systolic, 'systolic', { min: 30, max: 400 });
    const diastolic = strictNumber(body.value.diastolic, 'diastolic', { min: 20, max: 300 });
    if (diastolic > systolic) {
      throw new AppError(400, 'HEALTH_METRIC_FIELD_INVALID', '舒张压不能高于收缩压', { field: 'diastolic' });
    }
    values = { systolic, diastolic };
  } else {
    const ranges = {
      sleep: { min: 0, max: 24 },
      steps: { min: 0, max: 100000, integer: true },
      weight: { min: 0.1, max: 500 }
    };
    values = { value: strictNumber(body.value, 'value', ranges[body.metric]) };
  }

  if (typeof body.recordedAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(body.recordedAt)) {
    throw new AppError(400, 'HEALTH_METRIC_TIME_INVALID', '记录时间必须包含时区并使用有效的 ISO 时间格式', { field: 'recordedAt' });
  }
  const instant = new Date(body.recordedAt);
  const time = instant.getTime();
  if (!Number.isFinite(time)) throw new AppError(400, 'HEALTH_METRIC_TIME_INVALID', '记录时间格式不正确', { field: 'recordedAt' });
  const nowMs = clock.instant().getTime();
  if (time < Date.parse('2000-01-01T00:00:00.000Z') || time > nowMs + 5 * 60_000) {
    throw new AppError(400, 'HEALTH_METRIC_TIME_OUT_OF_RANGE', '记录时间必须在演示日期范围内且不能超过当前时间 5 分钟', { field: 'recordedAt' });
  }
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.trim().length > 500)) {
    throw new AppError(400, 'HEALTH_METRIC_FIELD_INVALID', '备注不能超过 500 个字符', { field: 'note' });
  }

  const rawValue = body.metric === 'blood_pressure' ? `${values.systolic}/${values.diastolic}` : String(values.value);
  return {
    guestId: user.id,
    recordType: definition.type,
    metric: body.metric,
    values,
    rawValue,
    unit: definition.unit,
    note: (body.note || '').trim(),
    recordedAt: instant.toISOString(),
    recordedBy: user.id,
    source: 'guest',
    structuredValueJson: JSON.stringify({
      schemaVersion: 1, metricKey: body.metric, unit: definition.unit,
      values, rawValue, parseStatus: 'valid', ruleVersion: HEALTH_METRIC_RULE_VERSION
    })
  };
}

const RECORD_SELECT = `SELECT r.id,r.guest_id AS guestId,r.record_type,r.value,r.unit,r.note,
  r.recorded_at AS recordedAt,r.recorded_by AS recordedBy,r.source,r.created_at AS createdAt,
  r.source_session_id AS sourceSessionId,
  r.structured_value_json AS structuredValueJson,r.voided_at AS voidedAt,r.voided_by AS voidedBy,
  r.void_reason AS voidReason,u.name AS recorderName
  FROM health_records r LEFT JOIN users u ON u.id=r.recorded_by`;

export async function listHealthRecords(guestId, { includeRetracted = false, limit = 100 } = {}) {
  const rows = await db.prepare(`${RECORD_SELECT} WHERE r.guest_id=? ${includeRetracted ? '' : 'AND r.voided_at IS NULL'}
    ORDER BY r.recorded_at DESC,r.id DESC LIMIT ?`).all(guestId, limit);
  return rows.map(publicHealthRecord);
}

export async function createHealthRecord(input) {
  const createdAt = now();
  const result = await db.prepare(`INSERT INTO health_records
    (guest_id,record_type,value,unit,note,recorded_at,recorded_by,source,created_at,structured_value_json,source_session_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    input.guestId, input.recordType, input.rawValue, input.unit, input.note,
    input.recordedAt, input.recordedBy, input.source, createdAt, input.structuredValueJson, input.sourceSessionId || null
  );
  await log(input.recordedBy, 'health_record.create', 'health_record', String(result.lastInsertRowid), `客人录入${input.recordType}`);
  const row = await db.prepare(`${RECORD_SELECT} WHERE r.id=?`).get(result.lastInsertRowid);
  const record = publicHealthRecord(row);
  await recordReplanSourceEvent({ guestId: input.guestId, sourceType: 'health_metric', sourceId: String(record.id),
    sourceVersion: 1, sourceLabel: `${record.metricLabel}记录 · ${record.recordedAt}`,
    sourceSnapshot: { recordId: record.id, metric: record.metric, metricLabel: record.metricLabel,
      value: record.value, displayValue: record.displayValue, unit: record.unit, values: record.values,
      note: record.note, recordedAt: record.recordedAt, source: record.source, demoOutlier: record.demoOutlier,
      ruleVersion: record.demoRule?.version || HEALTH_METRIC_RULE_VERSION },
    triggerReason: record.demoOutlier ? `${record.metricLabel}触及演示阈值，需由工作人员结合完整档案复核；该规则不构成诊断。` : '',
    requiresAttention: record.demoOutlier });
  return record;
}

export async function retractHealthRecord({ guestId, actorId, recordId, reason, clock = systemBusinessClock }) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
    throw new AppError(400, 'HEALTH_RECORD_RETRACT_REASON_REQUIRED', '请填写撤回原因（最多 500 个字符）', { field: 'reason' });
  }
  return transaction(async () => {
    const row = await db.prepare(`SELECT id,guest_id AS guestId,source,recorded_by AS recordedBy,
      recorded_at AS recordedAt,voided_at AS voidedAt FROM health_records WHERE id=? AND guest_id=?`).get(recordId, guestId);
    if (!row) throw new AppError(404, 'HEALTH_RECORD_NOT_FOUND', '健康记录不存在');
    if (row.voidedAt) throw new AppError(409, 'HEALTH_RECORD_ALREADY_RETRACTED', '这条记录已撤回');
    if (row.source !== 'guest' || row.recordedBy !== actorId) {
      throw new AppError(403, 'HEALTH_RECORD_RETRACT_FORBIDDEN', '只能撤回本人录入的记录');
    }
    if (clock.dateKey(row.recordedAt) !== clock.dateKey()) {
      throw new AppError(409, 'HEALTH_RECORD_RETRACT_WINDOW_CLOSED', '只能撤回上海时间今天录入的记录');
    }
    const retractedAt = clock.utc();
    const update = await db.prepare(`UPDATE health_records SET voided_at=?,voided_by=?,void_reason=?
      WHERE id=? AND guest_id=? AND voided_at IS NULL`).run(retractedAt, actorId, reason.trim(), recordId, guestId);
    if (!update.changes) throw new AppError(409, 'HEALTH_RECORD_ALREADY_RETRACTED', '这条记录已撤回');
    await log(actorId, 'health_record.retract', 'health_record', String(recordId), reason.trim());
    return { id: row.id, voidedAt: retractedAt, voidedBy: actorId, voidReason: reason.trim() };
  });
}

function businessDateStartUtc(dateKey) {
  return new Date(`${dateKey}T00:00:00+08:00`).toISOString();
}

function compareIdsDescending(a, b) {
  const left = String(a);
  const right = String(b);
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const delta = BigInt(right) - BigInt(left);
    return delta > 0n ? 1 : delta < 0n ? -1 : 0;
  }
  return right.localeCompare(left);
}

function validMetricSample(row, key) {
  const record = publicHealthRecord(row);
  return record.metric === key && record.parseStatus === 'valid' ? record : null;
}

export async function getHealthTrend(guestId, key, days, clock = systemBusinessClock) {
  if (!HEALTH_METRICS[key]) throw new AppError(400, 'HEALTH_METRIC_TYPE_INVALID', '指标类型不受支持', { field: 'metric' });
  if (![7, 30].includes(days)) throw new AppError(400, 'HEALTH_TREND_WINDOW_INVALID', '趋势窗口只能是 7 或 30 天', { field: 'days' });
  const today = clock.dateKey();
  const dateKeys = Array.from({ length: days }, (_, index) => shiftDateKey(today, index - days + 1));
  const startUtc = businessDateStartUtc(dateKeys[0]);
  const endUtc = businessDateStartUtc(shiftDateKey(today, 1));
  const rows = await db.prepare(`${RECORD_SELECT} WHERE r.guest_id=? AND r.voided_at IS NULL
    AND r.recorded_at>=? AND r.recorded_at<? ORDER BY r.recorded_at DESC,r.id DESC`).all(guestId, startUtc, endUtc);
  const chosenByDay = new Map();
  let unparsedCount = 0;
  for (const row of rows) {
    const record = validMetricSample(row, key);
    if (!record) {
      if (metricKey(row.record_type) === key) unparsedCount += 1;
      continue;
    }
    const day = clock.dateKey(record.recordedAt);
    if (!dateKeys.includes(day)) continue;
    const previous = chosenByDay.get(day);
    if (!previous || Date.parse(record.recordedAt) > Date.parse(previous.recordedAt) ||
        (Date.parse(record.recordedAt) === Date.parse(previous.recordedAt) && compareIdsDescending(record.id, previous.id) < 0)) {
      chosenByDay.set(day, record);
    }
  }
  const points = dateKeys.map(date => {
    const sample = chosenByDay.get(date);
    const base = { date, value: null, systolic: null, diastolic: null, unit: HEALTH_METRICS[key].unit, recordIds: [], sourceRecordIds: [], sampleCount: 0, demoOutlier: false };
    if (!sample) return base;
    return {
      ...base,
      value: key === 'blood_pressure' ? null : sample.values.value,
      systolic: key === 'blood_pressure' ? sample.values.systolic : undefined,
      diastolic: key === 'blood_pressure' ? sample.values.diastolic : undefined,
      recordIds: [sample.id], sourceRecordIds: [sample.id], sampleCount: 1,
      source: sample.source, recordedAt: sample.recordedAt,
      demoOutlier: sample.demoOutlier
    };
  });
  const definition = HEALTH_METRICS[key];
  const series = key === 'blood_pressure'
    ? [
      { key: 'systolic', label: '收缩压', unit: 'mmHg', points: points.map(point => ({ date: point.date, value: point.systolic ?? null, unit: point.unit, recordIds: point.recordIds, sourceRecordIds: point.sourceRecordIds, demoOutlier: point.demoOutlier })) },
      { key: 'diastolic', label: '舒张压', unit: 'mmHg', points: points.map(point => ({ date: point.date, value: point.diastolic ?? null, unit: point.unit, recordIds: point.recordIds, sourceRecordIds: point.sourceRecordIds, demoOutlier: point.demoOutlier })) }
    ]
    : [{ key: 'value', label: definition.label, unit: definition.unit, points: points.map(point => ({ date: point.date, value: point.value ?? null, unit: point.unit, recordIds: point.recordIds, sourceRecordIds: point.sourceRecordIds, demoOutlier: point.demoOutlier })) }];
  const sampleDays = points.filter(point => point.sampleCount).length;
  return {
    metric: key, metricLabel: definition.label, days, timeZone: clock.timeZone,
    aggregation: '每个业务日取记录时间最新的有效样本；时间相同按记录 ID 降序取一条。',
    missingDayCount: days - sampleDays, sampleCount: sampleDays, unparsedCount,
    points, series, demoRule: HEALTH_DEMO_RULE
  };
}

export async function getHealthSummary(guestId, key, days, clock = systemBusinessClock) {
  const trend = await getHealthTrend(guestId, key, days, clock);
  const minimumSampleDays = 3;
  const sourceRecordIds = [...new Set(trend.points.flatMap(point => point.recordIds))];
  if (trend.sampleCount < minimumSampleDays) {
    return {
      status: 'insufficient_data', reason: `至少需要 ${minimumSampleDays} 个不同业务日的有效样本；当前有 ${trend.sampleCount} 个。`,
      metric: key, days, sampleCount: trend.sampleCount, missingDayCount: trend.missingDayCount,
      minimumSampleDays, window: { start: trend.points[0].date, end: trend.points.at(-1).date, timeZone: trend.timeZone },
      changeDescription: null, demoRule: HEALTH_DEMO_RULE,
      sourceRecordIds, timeZone: trend.timeZone
    };
  }
  const seriesChanges = trend.series.map(item => {
    const values = item.points.filter(point => point.value !== null);
    const first = values[0];
    const last = values.at(-1);
    const difference = Number((last.value - first.value).toFixed(2));
    const direction = difference > 0 ? '增加' : difference < 0 ? '减少' : '无变化';
    return { key: item.key, label: item.label, unit: item.unit, firstDate: first.date, lastDate: last.date, difference, description: `${first.date} 至 ${last.date} ${item.label}${direction}${Math.abs(difference)} ${item.unit}` };
  });
  return {
    status: 'ready', metric: key, days, sampleCount: trend.sampleCount, missingDayCount: trend.missingDayCount,
    window: { start: trend.points[0].date, end: trend.points.at(-1).date, timeZone: trend.timeZone },
    changeDescription: seriesChanges.map(item => item.description).join('；'), seriesChanges,
    demoRule: HEALTH_DEMO_RULE, sourceRecordIds, minimumSampleDays
  };
}
