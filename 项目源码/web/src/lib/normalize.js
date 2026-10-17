// 服务端行数据到前端展示结构的映射与基础取值工具。
// snake_case → camelCase 兜底与列表归一化集中在此，供各域组件共用。

export const asText = (value) => typeof value === 'string' ? value : value == null ? '' : String(value);

export const initials = (name = '') => name.slice(0, 1);

export function normalizeHealthRecord(row = {}) {
  return {
    ...row,
    type: row.type ?? row.record_type ?? '',
    recordedAt: row.recordedAt ?? row.recorded_at ?? '',
    recordedBy: row.recordedBy ?? row.recorded_by ?? ''
  };
}

export function normalizeAdvice(row = {}) {
  return {
    ...row,
    createdAt: row.createdAt ?? row.created_at ?? '',
    updatedAt: row.updatedAt ?? row.updated_at ?? '',
    authorName: row.authorName ?? row.author_name ?? ''
  };
}

export function normalizeGuestSummary(data) {
  if (!data || typeof data !== 'object') return data;
  const source = data.profile || {};
  const profile = data.profile ? {
    ...source,
    birthDate: source.birthDate ?? source.birth_date ?? '',
    roomNo: source.roomNo ?? source.room_no ?? '',
    checkIn: source.checkIn ?? source.check_in ?? '',
    checkOut: source.checkOut ?? source.check_out ?? '',
    stayPlan: source.stayPlan ?? source.stay_plan ?? '',
    emergencyContact: source.emergencyContact ?? source.emergency_contact ?? '',
    chronic: Array.isArray(source.chronic) ? source.chronic : [],
    allergies: Array.isArray(source.allergies) ? source.allergies : []
  } : data.profile;
  return {
    ...data,
    profile,
    health: Array.isArray(data.health) ? data.health.map(normalizeHealthRecord) : [],
    advice: Array.isArray(data.advice) ? data.advice.map(normalizeAdvice) : []
  };
}

export function normalizeGuestList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    ...row,
    roomNo: row.roomNo ?? row.room_no ?? '',
    chronic: Array.isArray(row.chronic) ? row.chronic : [],
    allergies: Array.isArray(row.allergies) ? row.allergies : []
  }));
}
