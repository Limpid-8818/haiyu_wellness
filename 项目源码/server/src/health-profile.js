import { AppError } from './errors.js';

export const HEALTH_PROFILE_FIELDS = Object.freeze([
  { key: 'chronic', label: '慢病史' },
  { key: 'medications', label: '长期用药说明' },
  { key: 'allergies', label: '过敏源' },
  { key: 'dietaryRestrictions', label: '饮食忌口' },
  { key: 'mobility', label: '行动能力' },
  { key: 'sleep', label: '睡眠情况' },
  { key: 'skin', label: '皮肤状况' },
  { key: 'audienceTags', label: '客群标签' }
]);

const LIST_FIELDS = ['chronic', 'allergies', 'dietaryRestrictions', 'audienceTags'];
const ANSWERED_LIST_STATUSES = ['none', 'reported', 'unknown'];
const ALL_LIST_STATUSES = ['unanswered', ...ANSWERED_LIST_STATUSES];
const MAX_ITEMS = 20;

export function emptyHealthProfile() {
  return {
    chronic: { status: 'unanswered', items: [] },
    medications: { status: 'unanswered', items: [] },
    allergies: { status: 'unanswered', items: [] },
    dietaryRestrictions: { status: 'unanswered', items: [] },
    mobility: { status: 'unanswered', details: '' },
    sleep: { status: 'unanswered', details: '' },
    skin: { status: 'unanswered', details: '' },
    audienceTags: { status: 'unanswered', items: [] }
  };
}

function invalidField(path, message) {
  throw new AppError(400, 'HEALTH_PROFILE_FIELD_INVALID', message, { fields: { [path]: message } });
}

function exactKeys(value, allowed, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidField(path, '字段格式不正确');
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) {
    throw new AppError(400, 'HEALTH_PROFILE_FIELD_NOT_ALLOWED', '健康自述包含未允许字段', {
      fields: unknown.map(key => path ? `${path}.${key}` : key)
    });
  }
}

function text(value, path, maxLength = 300, { allowBlank = false } = {}) {
  if (typeof value !== 'string') invalidField(path, '必须是文本');
  const result = value.trim();
  if (!allowBlank && !result) invalidField(path, '请填写此项，或明确选择“无”/“不确定”');
  if (result.length > maxLength) invalidField(path, `不能超过 ${maxLength} 个字符`);
  return result;
}

function uniqueItems(items, path, maxLength = 120) {
  if (!Array.isArray(items)) invalidField(path, '请选择列表或明确选择“无”/“不确定”');
  if (items.length > MAX_ITEMS) invalidField(path, `最多填写 ${MAX_ITEMS} 项`);
  const values = items.map((item, index) => text(item, `${path}.${index}`, maxLength));
  const seen = new Set();
  return values.filter(item => {
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeListDomain(value, key) {
  exactKeys(value, ['status', 'items'], key);
  const status = value.status;
  if (!ALL_LIST_STATUSES.includes(status)) invalidField(`${key}.status`, '请选择已填、无、不确定，或暂不回答');
  const items = uniqueItems(value.items ?? [], `${key}.items`);
  if (status === 'reported' && !items.length) invalidField(`${key}.items`, '请至少填写一项');
  if (status !== 'reported' && items.length) invalidField(`${key}.items`, '选择“无/不确定/暂不回答”时不能附带项目');
  return { status, items };
}

function normalizeMedications(value) {
  exactKeys(value, ['status', 'items'], 'medications');
  const status = value.status;
  if (!ALL_LIST_STATUSES.includes(status)) invalidField('medications.status', '请选择用药情况');
  if (!Array.isArray(value.items ?? [])) invalidField('medications.items', '请填写药品原文和使用时段');
  const entries = (value.items ?? []).map((entry, index) => {
    exactKeys(entry, ['originalText', 'timing'], `medications.items.${index}`);
    return {
      originalText: text(entry.originalText, `medications.items.${index}.originalText`, 500),
      timing: text(entry.timing, `medications.items.${index}.timing`, 120)
    };
  });
  if (entries.length > MAX_ITEMS) invalidField('medications.items', `最多填写 ${MAX_ITEMS} 项`);
  if (status === 'reported' && !entries.length) invalidField('medications.items', '请填写药品原文和使用时段');
  if (status !== 'reported' && entries.length) invalidField('medications.items', '选择“无/不确定/暂不回答”时不能附带用药');
  const seen = new Set();
  const items = entries.filter(entry => {
    const key = `${entry.originalText.toLocaleLowerCase()}\u0000${entry.timing.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { status, items };
}

function normalizeMobility(value) {
  exactKeys(value, ['status', 'details'], 'mobility');
  const statuses = ['unanswered', 'independent', 'assistance', 'unknown'];
  if (!statuses.includes(value.status)) invalidField('mobility.status', '请选择行动能力');
  return { status: value.status, details: text(value.details ?? '', 'mobility.details', 300, { allowBlank: true }) };
}

function normalizeTextDomain(value, key) {
  exactKeys(value, ['status', 'details'], key);
  if (!['unanswered', 'reported', 'unknown'].includes(value.status)) invalidField(`${key}.status`, '请选择填写内容或不确定');
  const details = text(value.details ?? '', `${key}.details`, 500, { allowBlank: true });
  if (value.status === 'reported' && !details) invalidField(`${key}.details`, '请填写具体情况');
  if (value.status !== 'reported' && details) invalidField(`${key}.details`, '选择“不确定/暂不回答”时请留空');
  return { status: value.status, details };
}

export function normalizeHealthProfile(value) {
  if (value === undefined || value === null) return emptyHealthProfile();
  const allowed = HEALTH_PROFILE_FIELDS.map(field => field.key);
  exactKeys(value, allowed, 'profile');
  const profile = emptyHealthProfile();
  for (const key of LIST_FIELDS) if (value[key] !== undefined) profile[key] = normalizeListDomain(value[key], key);
  if (value.medications !== undefined) profile.medications = normalizeMedications(value.medications);
  if (value.mobility !== undefined) profile.mobility = normalizeMobility(value.mobility);
  if (value.sleep !== undefined) profile.sleep = normalizeTextDomain(value.sleep, 'sleep');
  if (value.skin !== undefined) profile.skin = normalizeTextDomain(value.skin, 'skin');
  return profile;
}

export function healthProfileCompleteness(value) {
  const profile = normalizeHealthProfile(value);
  const missing = HEALTH_PROFILE_FIELDS.filter(field => profile[field.key].status === 'unanswered');
  const completed = HEALTH_PROFILE_FIELDS.length - missing.length;
  return {
    completed,
    total: HEALTH_PROFILE_FIELDS.length,
    percent: Math.round((completed / HEALTH_PROFILE_FIELDS.length) * 100),
    missing: missing.map(field => ({ ...field }))
  };
}

export function mergeVerifiedHealthProfile(current, candidate) {
  const verified = normalizeHealthProfile(current);
  const submitted = normalizeHealthProfile(candidate);
  for (const field of HEALTH_PROFILE_FIELDS) {
    if (submitted[field.key].status !== 'unanswered') verified[field.key] = submitted[field.key];
  }
  return verified;
}

function domainItems(value) {
  return value?.status === 'reported' && Array.isArray(value.items) ? value.items : [];
}

export function effectiveHealthConstraints({ verified, pendingIntakes = [], legacyAllergies = [] }) {
  const formal = normalizeHealthProfile(verified);
  const fields = ['allergies', 'dietaryRestrictions'];
  const result = { allergies: [], dietaryRestrictions: [], conflicts: [], conflictState: 'clear' };
  const legacy = Array.isArray(legacyAllergies) ? legacyAllergies : [];
  for (const value of legacy) {
    if (typeof value !== 'string' || !value.trim()) continue;
    result.allergies.push({ value: value.trim(), source: 'legacy-profile', sourceId: null, status: 'existing', conflictsWithVerified: false });
  }
  for (const field of fields) {
    const confirmed = new Set(domainItems(formal[field]).map(item => item.toLocaleLowerCase()));
    for (const item of domainItems(formal[field])) {
      result[field].push({ value: item, source: 'verified-profile', sourceId: null, status: 'confirmed', conflictsWithVerified: false });
    }
    for (const intake of pendingIntakes) {
      const candidate = normalizeHealthProfile(intake.profile);
      const submitted = candidate[field];
      if (submitted.status !== 'reported') continue;
      const explicitlyNone = formal[field].status === 'none';
      for (const item of submitted.items) {
        const conflictsWithVerified = explicitlyNone || (formal[field].status === 'reported' && !confirmed.has(item.toLocaleLowerCase()));
        const entry = {
          value: item,
          source: intake.source,
          sourceId: intake.id,
          status: 'pending',
          conflictsWithVerified
        };
        result[field].push(entry);
        if (conflictsWithVerified) result.conflicts.push({ field, ...entry });
      }
    }
    const seen = new Set();
    result[field] = result[field].filter(entry => {
      const key = `${entry.value.toLocaleLowerCase()}\u0000${entry.status}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (result.conflicts.length) result.conflictState = 'conflict';
  else if (result.allergies.some(item => item.status === 'pending') || result.dietaryRestrictions.some(item => item.status === 'pending')) {
    result.conflictState = 'pending-review';
  }
  return result;
}

export function recommendationHealthContext(constraints) {
  return { effectiveHealthConstraints: constraints };
}
