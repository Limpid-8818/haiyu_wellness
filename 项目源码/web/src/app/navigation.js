// 工作区导航与角色文案的元数据（G16 拆分时的共享落点）。

export const STAFF_JOB_LABELS = {
  clinician: '医护',
  administrator: '管理员',
  coach: '教练',
  therapist: '理疗师',
  dietitian: '配餐员'
};

export function defaultStaffSection(user) {
  if (user.role === 'dean') return 'overview';
  return ({
    clinician: 'wellness-review',
    administrator: 'overview',
    coach: 'daily',
    therapist: 'therapy',
    dietitian: 'meal-prep'
  })[user.jobType] || 'review';
}

export function staffSectionLabel(section, user) {
  return ({ review: '医护审核台', daily: '每日安排', therapy: '理疗工作台', 'meal-prep': '备餐单', operations: '机构运营',
    'projects-admin': '项目维护', rules: '禁忌规则' })[section] || (user.role === 'dean' ? '院长空间' : '工作台');
}

export function admissionLabel(status) {
  return ({ pending: '待入住', in_house: '在住', checked_out: '已离店' })[status] || '待入住';
}

// 站内提醒/助手的 targetUrl → 客人 section 映射。
export function wellnessTargetSection(targetUrl) {
  return ({ caretaker: 'caretaker', schedule: 'schedule', reservations: 'reservations',
    projects: 'projects', meals: 'meals', mood: 'mood', advice: 'advice' })[targetUrl] || null;
}
