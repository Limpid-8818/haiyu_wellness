// Pure legacy value conversion shared by migrations and health projections.
export const HEALTH_METRIC_RULE_VERSION = 'health-metric-v1';
export const HEALTH_DEMO_RULE = Object.freeze({
  id: 'demo-metric-outlier', version: '1.0.0', scope: 'demo-display-only',
  note: '演示阈值，仅用于界面说明，不代表诊断或治疗建议。'
});

export const HEALTH_METRICS = Object.freeze({
  blood_pressure: { label: '血压', type: '血压', unit: 'mmHg', series: ['systolic', 'diastolic'] },
  sleep: { label: '睡眠时长', type: '睡眠时长', unit: 'h', series: ['value'] },
  steps: { label: '步数', type: '步数', unit: '步', series: ['value'] },
  weight: { label: '体重', type: '体重', unit: 'kg', series: ['value'] }
});

const TYPE_ALIASES = new Map([
  ['血压', 'blood_pressure'], ['blood_pressure', 'blood_pressure'], ['blood pressure', 'blood_pressure'],
  ['睡眠时长', 'sleep'], ['睡眠时间', 'sleep'], ['睡眠', 'sleep'], ['sleep', 'sleep'],
  ['步数', 'steps'], ['steps', 'steps'], ['体重', 'weight'], ['weight', 'weight']
]);

export function metricKey(value) {
  return TYPE_ALIASES.get(String(value || '').trim().toLowerCase()) || null;
}

function parseLegacyValues(key, raw, unit) {
  const definition = HEALTH_METRICS[key];
  if (!definition || String(unit || '') !== definition.unit || typeof raw !== 'string') return null;
  if (key === 'blood_pressure') {
    const match = raw.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
    if (!match) return null;
    const systolic = Number(match[1]);
    const diastolic = Number(match[2]);
    if (!Number.isFinite(systolic) || !Number.isFinite(diastolic)) return null;
    return { systolic, diastolic };
  }
  const parsed = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(parsed) || parsed < 0 || (key === 'steps' && !Number.isInteger(parsed))) return null;
  return { value: parsed };
}

export function legacyStructuredValue(row) {
  const key = metricKey(row.record_type ?? row.type);
  const unit = row.unit || '';
  const values = key ? parseLegacyValues(key, String(row.value ?? ''), unit) : null;
  return {
    schemaVersion: 1,
    metricKey: key,
    unit,
    values,
    rawValue: String(row.value ?? ''),
    parseStatus: values ? 'valid' : 'unparsed_legacy',
    ruleVersion: HEALTH_METRIC_RULE_VERSION
  };
}
