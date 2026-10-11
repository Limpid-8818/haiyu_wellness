import { systemBusinessClock } from './clock.js';

export const JOB_TYPES = Object.freeze([
  { value: 'clinician', label: '医护' },
  { value: 'administrator', label: '管理员' },
  { value: 'coach', label: '教练' },
  { value: 'therapist', label: '理疗师' },
  { value: 'dietitian', label: '配餐员' }
]);

export const SUMMARY_CAPABILITY = 'operations.summary.view';
export const MEDICAL_CAPABILITY = 'medical_advice.publish';

export function jobTypeFor(user) {
  if (user?.role !== 'staff') return null;
  return user.job_type || 'clinician';
}

export function jobTypeLabel(value) {
  return JOB_TYPES.find(type => type.value === value)?.label || '';
}

export function canManageStaff(user) {
  return user?.role === 'dean' || (user?.role === 'staff' && jobTypeFor(user) === 'administrator');
}

export async function capabilitiesFor(database, user) {
  const jobType = jobTypeFor(user);
  let operationsSummaryView = user?.role === 'dean';
  if (user?.role === 'staff' && jobType) {
    const setting = await database.prepare(`SELECT enabled FROM job_capability_settings
      WHERE job_type=? AND capability_key=?`).get(jobType, SUMMARY_CAPABILITY);
    operationsSummaryView = setting ? Boolean(Number(setting.enabled)) : true;
  }
  return {
    jobType,
    jobTypeLabel: jobTypeLabel(jobType),
    staffManagement: canManageStaff(user),
    operationsSummaryView,
    medicalAdvicePublish: user?.role === 'staff' && jobType === 'clinician'
  };
}

export function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function nightsBetween(checkIn, checkOut) {
  if (!isDateOnly(checkIn) || !isDateOnly(checkOut)) return null;
  const start = Date.parse(`${checkIn}T00:00:00.000Z`);
  const end = Date.parse(`${checkOut}T00:00:00.000Z`);
  return (end - start) / 86_400_000;
}

export function stayStatus(checkIn, checkOut, today = systemBusinessClock.dateKey()) {
  if (!isDateOnly(checkIn)) return 'pending';
  if (isDateOnly(checkOut) && checkOut <= today) return 'checked_out';
  if (checkIn > today) return 'pending';
  return 'in_house';
}

export async function capabilityMatrix(database) {
  const rows = await database.prepare(`SELECT job_type AS jobType, enabled FROM job_capability_settings
    WHERE capability_key=?`).all(SUMMARY_CAPABILITY);
  const configured = new Map(rows.map(row => [row.jobType, Boolean(Number(row.enabled))]));
  return {
    jobTypes: JOB_TYPES,
    capabilities: [
      { key: MEDICAL_CAPABILITY, label: '医护建议发布', editable: false },
      { key: SUMMARY_CAPABILITY, label: '查看运营汇总', editable: true }
    ],
    matrix: JOB_TYPES.map(type => ({
      jobType: type.value,
      jobTypeLabel: type.label,
      capabilities: {
        [MEDICAL_CAPABILITY]: type.value === 'clinician',
        [SUMMARY_CAPABILITY]: configured.has(type.value) ? configured.get(type.value) : true
      }
    }))
  };
}
