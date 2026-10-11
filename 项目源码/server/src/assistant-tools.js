import { AppError } from './errors.js';
import { performance } from 'node:perf_hooks';
import { db, guestProfile, json, now } from './db.js';
import { authorizeGuestAccess } from './authorization.js';
import { listProjects, getProject, listKnowledge, listRules } from './catalog.js';
import { listGuestSchedule } from './booking.js';
import { getGuestMenu, getNutritionRecommendationContext } from './meals.js';
import { getMoodSummary, listMoodResources } from './mood.js';
import { listHealthRecords, publicHealthRecord } from './health-metrics.js';
import { effectiveHealthConstraints, normalizeHealthProfile } from './health-profile.js';
import { evaluateProjectRules } from './rules-engine.js';
import { proposeGuestAction } from './assistant-actions.js';
import { searchOperationsCapacity, searchStaffReviewContext } from './stage26-operations.js';

const allRoles = ['public', 'guest', 'staff', 'dean'];
const privateRoles = ['guest', 'staff', 'dean'];

function measuredToolDurationMs(startedAt) {
  const elapsed = performance.now() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? Math.max(1, Math.ceil(elapsed)) : null;
}

export function isRealCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function shanghaiDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now()));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function uniqueSources(items) {
  const seen = new Set();
  return items.filter(item => {
    if (!item?.type || item.id === undefined || item.id === null) return false;
    const key = `${item.type}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function guestRuleInputs(guestId) {
  const profile = await guestProfile(guestId);
  if (!profile) throw new AppError(404, 'GUEST_NOT_FOUND', '客人档案不存在');
  const pendingRows = await db.prepare(`SELECT id,source,structured_json AS structuredJson FROM health_intakes
    WHERE guest_id=? AND status='pending' ORDER BY revision DESC,id DESC LIMIT 20`).all(guestId);
  const pendingIntakes = pendingRows.map(row => ({ id: row.id, source: row.source || 'pending-intake',
    profile: normalizeHealthProfile(json(row.structuredJson, {})) }));
  const constraints = effectiveHealthConstraints({ verified: profile.health_profile, pendingIntakes,
    legacyAllergies: profile.allergies });
  const rules = await listRules();
  return { profile, pendingIntakes, constraints, rules };
}

function projectDecision(project, { profile, pendingIntakes, constraints, rules }) {
  return evaluateProjectRules({ project, verifiedProfile: profile.health_profile, legacyProfile: profile,
    pendingIntakes, effectiveHealthConstraints: constraints, rules, environment: {} });
}

function decisionSources(project, decision, guestId) {
  const matched = decision.decisions.filter(item => item.matched);
  const sourceIds = matched.flatMap(item => item.fieldSources.map(source => source.sourceId).filter(Boolean));
  return uniqueSources([
    { type: 'project', id: project.id, label: project.name },
    { type: 'guest_profile', id: guestId, label: '客人有效档案与现存限制' },
    ...matched.map(item => ({ type: 'safety_rule', id: item.ruleId, label: item.reason })),
    ...sourceIds.map(id => ({ type: 'health_intake', id, label: '待核实的健康自述' }))
  ]);
}

function matchingWindows(project, date) {
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${date}T12:00:00.000Z`));
  const aliases = { 星期一: '周一', 星期二: '周二', 星期三: '周三', 星期四: '周四', 星期五: '周五', 星期六: '周六', 星期日: '周日' };
  const day = aliases[weekday] || weekday;
  return (project.openWindows || []).filter(window => window.days?.includes('每日') || window.days?.includes(day))
    .map(window => ({ start: window.start, end: window.end, days: window.days }));
}

const tools = [
  {
    name: 'list_projects', description: '按关键词查找当前开放的康养项目目录。', roles: allRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: { search: { type: 'string', maxLength: 80, description: '项目名称或关键词，可留空。' } }, additionalProperties: false },
    execute: async ({ search = '' }) => {
      const items = await listProjects({ search });
      return { data: items.slice(0, 8).map(item => ({ id: item.id, name: item.name, category: item.category,
        description: String(item.description || '').slice(0, 180), intensity: item.intensity, isDemo: Boolean(item.isDemo) })),
        sources: items.slice(0, 8).map(item => ({ type: 'project', id: item.id, label: item.name })) };
    }
  },
  {
    name: 'list_project_slots', description: '查询某个项目在指定日期的演示时段与名额信息；结果不能作为预约确认。', roles: allRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: { projectId: { type: 'string', minLength: 1, maxLength: 64 }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, required: ['projectId'], additionalProperties: false },
    execute: async ({ projectId, date }) => {
      const project = await getProject(projectId);
      if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
      const targetDate = date || shanghaiDate();
      const slots = await db.prepare(`SELECT s.id,s.business_date AS businessDate,s.starts_at AS startsAt,s.ends_at AS endsAt,
          s.local_start AS localStart,s.local_end AS localEnd,s.capacity,s.is_closed AS isClosed,
          (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS reservedCount
        FROM activity_slots s WHERE s.project_id=? AND s.business_date=? ORDER BY s.starts_at,s.ends_at LIMIT 30`).all(projectId, targetDate);
      const items = slots.map(item => ({ id: String(item.id),
        localStart: item.localStart, localEnd: item.localEnd,
        availableCount: Math.max(0, Number(item.capacity) - Number(item.reservedCount || 0)),
        status: Number(item.isClosed) ? 'closed' : Number(item.reservedCount || 0) >= Number(item.capacity) ? 'full' : 'listed' }));
      return { data: { project: { id: project.id, name: project.name }, date: targetDate, isDemo: Boolean(project.isDemo),
        note: '只读时段列表；名额与预约状态为本地资料，不能作为预约确认。', slots: items },
        sources: items.map(item => ({ type: 'project_slot', id: item.id, label: `${project.name} ${item.localStart}` })) };
    }
  },
  {
    name: 'get_guest_profile', description: '读取当前会话已授权客人的非身份识别档案摘要。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ user, guestId }) => {
      const profile = await guestProfile(guestId);
      if (!profile) throw new AppError(404, 'GUEST_NOT_FOUND', '客人档案不存在');
      return { data: { gender: profile.gender || '', chronic: profile.chronic || [], allergies: profile.allergies || [], mobility: profile.mobility || '', stayPlan: profile.stay_plan || null,
        healthProfile: profile.health_profile || {}, healthProfileVersion: Number(profile.health_profile_version || 0) },
        sources: [{ type: 'guest_profile', id: guestId, label: '客人档案' }] };
    }
  },
  {
    name: 'get_health_summary', description: '读取当前会话已授权客人的近期有效健康指标摘要；只提供记录，不作诊断。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ guestId }) => {
      const rows = await listHealthRecords(guestId, { limit: 10 });
      const records = rows.map(publicHealthRecord).filter(item => item.parseStatus === 'valid')
        .map(item => ({ id: item.id, type: item.type, value: item.values, unit: item.unit, recordedAt: item.recordedAt }));
      return { data: { records, interpretationBoundary: '只显示已记录数据；不据此诊断或调整治疗。' },
        sources: records.map(item => ({ type: 'health_record', id: String(item.id), label: `${item.type} · ${item.recordedAt}` })) };
    }
  },
  {
    name: 'get_guest_schedule', description: '读取当前会话已授权客人的预约与日程。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ guestId }) => {
      const items = await listGuestSchedule(guestId);
      return { data: { items: items.slice(0, 20) },
        sources: items.slice(0, 20).map(item => ({ type: 'schedule', id: String(item.id), label: item.projectName || item.title || '日程记录' })) };
    }
  },
  {
    name: 'get_meal_menu', description: '读取当前会话已授权客人的既有餐单，不会生成或修改餐单。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false },
    execute: async ({ guestId, date }) => {
      const targetDate = date || shanghaiDate();
      const menu = await getGuestMenu(guestId, targetDate);
      return { data: menu, sources: menu?.menuId ? [{ type: 'meal_menu', id: String(menu.menuId), label: `餐单 ${targetDate}` }] : [] };
    }
  },
  {
    name: 'get_mood_summary', description: '读取当前会话已授权客人的心情记录摘要；不作心理诊断。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ guestId }) => {
      const summary = await getMoodSummary(guestId);
      return { data: summary, sources: (summary?.recentMoods || []).map(item => ({ type: 'mood_record', id: String(item.id), label: `心情记录 ${item.businessDate}` })) };
    }
  },
  {
    name: 'get_environment_snapshot', description: '读取指定日期的环境快照；缺失、过期或演示数据不能作为安全或可参加结论。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, additionalProperties: false },
    execute: async ({ date }) => {
      const targetDate = date || shanghaiDate();
      const rows = await db.prepare(`SELECT snapshot_key AS snapshotKey,domain,status,source_name AS sourceName,observed_at AS observedAt,
          expires_at AS expiresAt,payload_json AS payloadJson
        FROM environment_snapshots WHERE target_date=? ORDER BY domain,updated_at DESC`).all(targetDate);
      const domains = {};
      for (const row of rows) {
        if (domains[row.domain]) continue;
        let payload = {};
        try { payload = typeof row.payloadJson === 'string' ? JSON.parse(row.payloadJson) : row.payloadJson; } catch { payload = {}; }
        domains[row.domain] = { status: row.status, sourceName: row.sourceName, observedAt: row.observedAt,
          expiresAt: row.expiresAt, payload };
      }
      return { data: { targetDate, status: Object.keys(domains).length === 3 ? 'available' : 'incomplete', domains,
          safetyBoundary: '环境快照仅供参考；缺失、过期或演示数据不能作为安全或可参加结论。' },
        sources: rows.slice(0, 3).map(row => ({ type: 'environment_snapshot', id: row.snapshotKey, label: `${row.domain} 环境快照 ${targetDate}` })) };
    }
  },
  {
    name: 'get_therapy_knowledge', description: '读取项目中实际保存的理疗领域知识条目及其来源。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const items = await listKnowledge({ domain: 'therapy' });
      return { data: items.map(item => ({ knowledgeId: item.knowledgeId, title: item.title, summary: item.summary,
        sourceName: item.sourceName, sourceUrl: item.sourceUrl, sourceReference: item.body })),
        sources: items.map(item => ({ type: 'domain_knowledge', id: item.knowledgeId, label: item.title })) };
    }
  },
  {
    name: 'get_physio_context', description: '读取理疗项目目录、客人限制和已配置的确定性规则结果。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ guestId }) => {
      const [projects, inputs] = await Promise.all([listProjects({ category: 'water_therapy' }), guestRuleInputs(guestId)]);
      const evaluations = projects.map(project => {
        const result = projectDecision(project, inputs);
        const matchedRules = result.decisions.filter(item => item.matched).map(item => ({ ruleId: item.ruleId,
          action: item.action, reason: item.reason, reviewRequired: item.reviewRequired }));
        return { projectId: project.id, name: project.name, category: project.category, activityTag: project.activityTag,
          description: project.description, contraindications: project.contraindications, outcome: result.outcome,
          reviewRequired: result.reviewRequired, matchedRules };
      });
      const sources = uniqueSources(evaluations.flatMap(item => decisionSources(projects.find(project => project.id === item.projectId),
        projectDecision(projects.find(project => project.id === item.projectId), inputs), guestId)));
      return { data: { evaluations, boundary: 'R1/R2及其余项目规则由服务端确定性复核；模型建议不能改变规则状态。无预约或医护批准。' }, sources };
    }
  },
  {
    name: 'get_nutrition_knowledge', description: '读取项目中实际保存的营养领域知识条目及其来源。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const items = await listKnowledge({ domain: 'nutrition' });
      return { data: items.map(item => ({ knowledgeId: item.knowledgeId, title: item.title, summary: item.summary,
        sourceName: item.sourceName, sourceUrl: item.sourceUrl, sourceReference: item.body })),
        sources: items.map(item => ({ type: 'domain_knowledge', id: item.knowledgeId, label: item.title })) };
    }
  },
  {
    name: 'get_nutrition_context', description: '读取过敏/忌口约束、菜单食材、演示供货状态及确定性筛选结果；不会写入餐单。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ guestId }) => {
      const context = await getNutritionRecommendationContext(guestId);
      return { data: context, sources: uniqueSources([
        { type: 'nutrition_candidate_inventory', id: 'main-dish-catalog', label: '主菜营养候选只读目录查询' },
        { type: 'guest_profile', id: guestId, label: '有效过敏与饮食限制' },
        ...context.restrictions.filter(item => item.sourceId).map(item => ({ type: 'health_intake', id: item.sourceId, label: '待核实的过敏或饮食限制' })),
        ...context.candidates.map(item => ({ type: 'dish', id: item.dish.id, label: item.dish.name })),
        ...context.excluded.map(item => ({ type: 'dish', id: item.dishId, label: item.dishName }))
      ]) };
    }
  },
  {
    name: 'get_exercise_knowledge', description: '读取项目中实际保存的运动领域知识条目及其来源。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const items = await listKnowledge({ domain: 'exercise' });
      return { data: items.map(item => ({ knowledgeId: item.knowledgeId, title: item.title, summary: item.summary,
        sourceName: item.sourceName, sourceUrl: item.sourceUrl, sourceReference: item.body })),
        sources: items.map(item => ({ type: 'domain_knowledge', id: item.knowledgeId, label: item.title })) };
    }
  },
  {
    name: 'get_exercise_context', description: '读取行动能力、已预约日程、项目开放窗口和指定日期时段；不改变预约。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: { date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, required: ['date'], additionalProperties: false },
    execute: async ({ guestId, date }) => {
      const [projects, schedule, inputs] = await Promise.all([
        listProjects({ category: 'exercise' }), listGuestSchedule(guestId), guestRuleInputs(guestId)
      ]);
      const slots = await db.prepare(`SELECT s.id,s.project_id AS projectId,s.local_start AS localStart,s.local_end AS localEnd,
          s.capacity,s.is_closed AS isClosed,(SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS reservedCount
        FROM activity_slots s WHERE s.business_date=? ORDER BY s.starts_at`).all(date);
      const activities = projects.map(project => {
        const rule = projectDecision(project, inputs);
        const actualSlots = slots.filter(slot => slot.projectId === project.id).map(slot => ({ id: String(slot.id),
          start: slot.localStart, end: slot.localEnd, capacity: Number(slot.capacity), reservedCount: Number(slot.reservedCount || 0),
          availableCount: Math.max(0, Number(slot.capacity) - Number(slot.reservedCount || 0)), closed: Boolean(Number(slot.isClosed)) }));
        return { projectId: project.id, name: project.name, intensity: project.intensity, activityTag: project.activityTag,
          seaEntry: project.seaEntry, openWindows: actualSlots.length ? actualSlots : matchingWindows(project, date),
          availabilitySource: actualSlots.length ? 'activity_slots' : 'project.openWindows.demo',
          outcome: rule.outcome, reviewRequired: rule.reviewRequired,
          matchedRules: rule.decisions.filter(item => item.matched).map(item => ({ ruleId: item.ruleId,
            action: item.action, reason: item.reason, reviewRequired: item.reviewRequired })) };
      });
      const scheduled = (schedule.items || []).filter(item => String(item.businessDate).slice(0, 10) === date);
      return { data: { date, activities, existingSchedule: scheduled.map(item => ({ id: String(item.id), projectId: item.projectId,
        projectName: item.projectName, startsAt: item.startsAt, endsAt: item.endsAt, localStart: item.localStart, localEnd: item.localEnd })),
        mobility: { legacy: inputs.profile.mobility || '', verified: inputs.profile.health_profile?.mobility || { status: 'unanswered' } },
        boundary: '开放窗口或容量资料是只读演示数据；既有预约不修改，候选也不代表成功预约。' },
      sources: uniqueSources([
        { type: 'activity_slot_inventory', id: date, label: `${date} 已登记活动时段只读查询` },
        { type: 'guest_profile', id: guestId, label: '行动能力档案' },
        ...activities.flatMap(item => [
          { type: 'project', id: item.projectId, label: item.name },
          ...item.matchedRules.map(rule => ({ type: 'safety_rule', id: rule.ruleId, label: rule.reason })),
          ...(item.availabilitySource === 'activity_slots' ? item.openWindows.map(slot => ({ type: 'project_slot', id: slot.id, label: `${item.name} ${slot.start}` })) : [])
        ]),
        ...scheduled.map(item => ({ type: 'schedule', id: String(item.id), label: item.projectName || '已预约日程' }))
      ]) };
    }
  },
  {
    name: 'get_companionship_knowledge', description: '读取项目中实际保存的心理陪伴知识条目及其来源。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const items = await listKnowledge({ domain: 'companionship' });
      return { data: items.map(item => ({ knowledgeId: item.knowledgeId, title: item.title, summary: item.summary,
        sourceName: item.sourceName, sourceUrl: item.sourceUrl, sourceReference: item.body })),
        sources: items.map(item => ({ type: 'domain_knowledge', id: item.knowledgeId, label: item.title })) };
    }
  },
  {
    name: 'get_psychology_context', description: '读取已记录心情、待人工关注项和现有可播放课程目录；不作诊断。', roles: privateRoles, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ guestId }) => {
      const summary = await getMoodSummary(guestId);
      const resources = listMoodResources().filter(item => item.category === 'guided').map(item => ({
        id: item.id, title: item.title, subtitle: item.subtitle, durationSeconds: item.durationSeconds, audioUrl: item.audioUrl,
        source: item.source, license: item.license
      }));
      const recentMoods = summary.recentMoods.map(item => ({ id: item.id, businessDate: item.businessDate,
        score: item.score, label: item.label, note: item.note }));
      const focusItems = summary.focusItems.map(item => ({ id: item.id, ruleId: item.ruleId,
        startDate: item.startDate, endDate: item.endDate, sourceRecordIds: item.sourceRecordIds, status: item.status }));
      return { data: { recentMoods, focusItems, resources, dataSufficiency: summary.dataSufficiency,
        rule: focusItems[0]?.rule || null,
        boundary: '连续低分是项目演示规则触发的待人工关注项，不是心理诊断；课程链接指向现有本地播放器资源。' },
      sources: uniqueSources([
        ...recentMoods.map(item => ({ type: 'mood_record', id: String(item.id), label: `心情记录 ${item.businessDate}` })),
        ...focusItems.map(item => ({ type: 'mood_focus', id: String(item.id), label: `待人工关注 ${item.startDate}–${item.endDate}` })),
        ...focusItems.flatMap(item => item.sourceRecordIds.map(id => ({ type: 'mood_record', id: String(id), label: '关注项关联心情记录' }))),
        ...resources.map(item => ({ type: 'mood_resource', id: item.id, label: item.title }))
      ]) };
    }
  },
  {
    name: 'search_staff_review_context', description: '医护只读查询当前负责客人的真实待审疗程、风险摘要和命中规则；不能批准或修改。',
    roles: ['staff'], jobTypes: ['clinician'], requiresGuestContext: true, timeoutMs: 15_000,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async ({ user, guestId }) => await searchStaffReviewContext({ user, guestId })
  },
  {
    name: 'search_operations_capacity', description: '管理员只读查询已登记项目时段、容量、有效预约和余量；不能修改订单或员工权限。',
    roles: ['staff'], jobTypes: ['administrator'], timeoutMs: 15_000,
    parameters: { type: 'object', properties: {
      projectId: { type: 'string', minLength: 1, maxLength: 64 },
      date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
    }, required: ['projectId', 'date'], additionalProperties: false },
    execute: async ({ projectId, date }) => await searchOperationsCapacity({ projectId, date })
  }
];

const proposalParameters = {
  propose_program_booking: { projectId: { type: 'string', maxLength: 64 }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, slotId: { type: 'string', maxLength: 64 } },
  propose_booking_cancellation: { reservationId: { type: 'string', maxLength: 64 } },
  propose_meal_order: { businessDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, mealType: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'] } },
  propose_dish_swap: { businessDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, itemId: { type: 'string', maxLength: 64 }, dishId: { type: 'string', maxLength: 64 }, reason: { type: 'string', maxLength: 500 } },
  propose_health_metric: { metric: { type: 'string', enum: ['blood_pressure', 'sleep', 'steps', 'weight'] }, systolic: { type: 'number' }, diastolic: { type: 'number' }, value: { type: 'number' }, unit: { type: 'string', maxLength: 32 }, recordedAt: { type: 'string', maxLength: 40 }, note: { type: 'string', maxLength: 500 } },
  propose_rest_change: { reservationId: { type: 'string', maxLength: 64 }, reason: { type: 'string', maxLength: 500 } }
};
const proposalTypes = {
  propose_program_booking: 'book_program', propose_booking_cancellation: 'cancel_booking',
  propose_meal_order: 'book_meal', propose_dish_swap: 'swap_dish',
  propose_health_metric: 'record_metric', propose_rest_change: 'rest_change'
};
for (const [name, properties] of Object.entries(proposalParameters)) {
  tools.push({
    name, description: name === 'propose_program_booking'
      ? '客人已明确提出预约时，依据已核实的项目信息生成结构化待确认卡。仅传客人明确提供的项目、日期和时段；时段未选时省略 slotId，服务端会返回 needs_input 与可选时段。绝不猜选时段或提交预约。'
      : '只生成客人本人待确认操作卡；此工具不会提交预约、订单、健康记录或疗程变更。',
    roles: ['guest'], timeoutMs: 15_000,
    parameters: { type: 'object', properties, additionalProperties: false },
    execute: async ({ user, guestId, sessionId, runId, signal: _signal, ...parameters }) => await proposeGuestAction({
      actionType: proposalTypes[name], parameters, user, role: user?.role, guestId, sessionId, runId
    })
  });
}

export function classifyAssistantIntent(text) {
  const value = String(text || '');
  const matched = [];
  if (/日程|预约|排期|空位|名额|可约/.test(value)) matched.push({ category: 'schedule', tools: ['get_guest_schedule', 'list_project_slots'], privateContext: /日程|预约/.test(value) });
  if (/项目|疗程|活动|服务|放松|轻松|休闲|舒缓/.test(value)) matched.push({ category: 'projects', tools: ['list_projects', 'list_project_slots'], privateContext: false });
  if (/餐|膳食|菜单|食谱|吃什么/.test(value)) matched.push({ category: 'meals', tools: ['get_meal_menu'], privateContext: true });
  if (/健康|病|指标|血压|用药|过敏|睡眠|疼痛/.test(value)) matched.push({ category: 'health', tools: ['get_health_summary', 'get_guest_profile'], privateContext: true });
  if (/心情|情绪|烦闷|压力/.test(value)) matched.push({ category: 'mood', tools: ['get_mood_summary'], privateContext: true });
  if (/档案|资料|个人信息/.test(value)) matched.push({ category: 'profile', tools: ['get_guest_profile'], privateContext: true });
  if (/天气|潮汐|海况|环境/.test(value)) matched.push({ category: 'environment', tools: ['get_environment_snapshot'], privateContext: true });
  if (/待审|审核|审批|疗程|方案/.test(value)) matched.push({ category: 'staff_review', tools: ['search_staff_review_context'], privateContext: true });
  if (/名额|剩余|余量|运营|异常|时段/.test(value)) matched.push({ category: 'operations', tools: ['search_operations_capacity'], privateContext: false });
  if (!matched.length) return { category: 'general', toolNames: [], privateContext: false, categories: ['general'] };
  const toolNames = [...new Set(matched.flatMap(item => item.tools))];
  const categories = matched.map(item => item.category);
  return { category: categories.length === 1 ? categories[0] : 'mixed', toolNames,
    privateContext: matched.some(item => item.privateContext), categories };
}

export function getAssistantToolDefinitions(role, { guestId = null, toolNames = null, user = null } = {}) {
  const allowList = toolNames ? new Set(toolNames) : null;
  const allowed = tools.filter(tool => tool.roles.includes(role)
    && (!tool.jobTypes || tool.jobTypes.includes(user?.job_type || ''))
    && (!privateRoles.includes(role) || !tool.name.startsWith('get_') || Boolean(guestId))
    && (!allowList || allowList.has(tool.name)));
  return allowed.map(({ name, description, parameters }) => ({ type: 'function', function: { name, description, parameters } }));
}

export function validateToolArguments(toolName, input, role) {
  const tool = tools.find(item => item.name === toolName);
  if (!tool || !tool.roles.includes(role)) throw new AppError(403, 'TOOL_FORBIDDEN', '当前助手身份不能使用此查询工具');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', '工具参数必须是 JSON 对象');
  const schema = tool.parameters;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema.properties, key)) throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', '工具参数包含不允许的字段');
  }
  for (const key of schema.required || []) {
    if (input[key] === undefined) throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', `缺少工具参数 ${key}`);
  }
  for (const [key, value] of Object.entries(input)) {
    const spec = schema.properties[key];
    if (spec.type === 'string' && typeof value !== 'string') throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', `工具参数 ${key} 必须是文本`);
    if (spec.type === 'string' && spec.minLength && value.length < spec.minLength) throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', `工具参数 ${key} 不能为空`);
    if (spec.type === 'string' && spec.maxLength && value.length > spec.maxLength) throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', `工具参数 ${key} 超出长度限制`);
    if (spec.pattern && !new RegExp(spec.pattern).test(value)) throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', `工具参数 ${key} 格式不正确`);
    if (spec.enum && !spec.enum.includes(value)) throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', `工具参数 ${key} 不是允许的选项`);
    if (key === 'date' && !isRealCalendarDate(value)) throw new AppError(400, 'TOOL_ARGUMENTS_INVALID', `工具参数 ${key} 不是有效日历日期`);
  }
  return { tool, args: { ...input } };
}

export async function runAssistantTool(toolName, input, { user, guestId = null, role, sessionId = null, runId = null, timeoutMs, executor, signal } = {}) {
  let validated;
  try { validated = validateToolArguments(toolName, input, role); }
  catch (error) { return { status: 'failed', errorCode: error.code || 'TOOL_ARGUMENTS_INVALID', data: { error: error.message }, sources: [] }; }
  const { tool, args } = validated;
  if (tool.jobTypes && !tool.jobTypes.includes(user?.job_type || '')) {
    return { status: 'failed', errorCode: 'TOOL_FORBIDDEN', data: { error: '当前岗位不能使用此只读工具。' }, sources: [] };
  }
  const isGuestProposal = tool.name.startsWith('propose_') && role === 'guest';
  const requiresGuestScope = tool.requiresGuestContext || (tool.roles.some(item => privateRoles.includes(item)) && tool.name.startsWith('get_'));
  const scopedGuestId = isGuestProposal || requiresGuestScope ? guestId : null;
  if (requiresGuestScope && privateRoles.includes(role)) {
    if (!scopedGuestId) return { status: 'failed', errorCode: 'GUEST_CONTEXT_REQUIRED', data: { error: '当前会话需要先选择有权限的客人档案。' }, sources: [] };
    try {
      const guest = await authorizeGuestAccess(user, scopedGuestId);
      if (guest.id !== scopedGuestId) throw new AppError(403, 'GUEST_CONTEXT_MISMATCH', '当前会话关联客人不匹配');
    } catch (error) {
      return { status: 'failed', errorCode: error.code || 'GUEST_ACCESS_DENIED', data: { error: '无权读取当前客人信息。' }, sources: [] };
    }
  }
  const start = performance.now();
  const controller = new AbortController();
  const timeout = Math.min(15_000, Math.max(1, Number(timeoutMs || tool.timeoutMs)));
  const timer = setTimeout(() => controller.abort(), timeout);
  const toolSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const context = { user, guestId: scopedGuestId, sessionId, runId };
    const operation = executor ? executor(tool, args, context, toolSignal) : tool.execute({ ...args, ...context, signal: toolSignal });
    const result = await Promise.race([
      operation,
      new Promise((_, reject) => toolSignal.addEventListener('abort', () => reject(new Error(signal?.aborted ? 'RUN_ABORTED' : 'TOOL_TIMEOUT')), { once: true }))
    ]);
    return { status: 'completed', data: result?.data ?? result, sources: result?.sources || [],
      durationMs: measuredToolDurationMs(start) };
  } catch (error) {
    const timedOut = controller.signal.aborted;
    const canceled = Boolean(signal?.aborted);
    return { status: 'failed', errorCode: canceled ? 'RUN_ABORTED' : timedOut ? 'TOOL_TIMEOUT' : (error.code || 'TOOL_EXECUTION_FAILED'),
      data: { error: canceled ? '本次协作已停止。' : timedOut ? '查询超时，当前结果暂不可用。' : (error.expose ? error.message : '助手工具暂时不可用。') },
      sources: [], durationMs: measuredToolDurationMs(start) };
  } finally { clearTimeout(timer); }
}
