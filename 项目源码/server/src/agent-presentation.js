import { HEALTH_PROFILE_FIELDS, normalizeHealthProfile } from './health-profile.js';

export function collaborationState(run) {
  if (!run) return 'not_run';
  if (['queued', 'running'].includes(run.status)) return run.status;
  if (['failed', 'interrupted'].includes(run.status)) return run.status;
  if (run.collaboration?.gaps?.length || run.collaboration?.coordinatorError) return 'partial_failure';
  return run.status;
}

export function healthDisclosure(profile, version, guestId) {
  const health = normalizeHealthProfile(profile);
  const missing = HEALTH_PROFILE_FIELDS.filter(field => ['unanswered', 'unknown'].includes(health[field.key].status));
  const known = HEALTH_PROFILE_FIELDS.filter(field => !missing.includes(field));
  return {
    text: [
      `资料依据：正式健康档案版本 ${version}；已核实项目：${known.map(field => field.label).join('、') || '尚无'}。`,
      missing.length ? `尚未提供或核实：${missing.map(field => field.label).join('、')}。未知不代表没有相关问题。请向负责医护补充并核实这些信息。` : '健康信息仍需结合现场情况确认。',
      '理疗依据项目禁忌和有效健康约束；营养依据食物限制、餐食目录和营养知识；运动依据行动能力、项目目录及安全规则；心理陪伴依据情绪记录、人工关注项和陪伴资源。各域实际查询来源见下方来源及协作详情；未完成领域不视为已评估。',
      '资料不足时以上建议仅供候选；理疗、饮食安全与活动强度须待医护确认。'
    ].join('\n'),
    source: { type: 'guest_profile', id: guestId, label: `正式健康档案版本 ${version}（缺项待确认）` }
  };
}
