import crypto from 'node:crypto';
import { db, guestProfile, id, json, log, now, transaction, hasActiveTransaction } from './db.js';
import { chatWithAssistant, getAssistantRun } from './assistant.js';
import { WELLNESS_DRAFT_COORDINATION_TASK } from './assistant-agents.js';
import { evaluateExistingDraftSlot } from './booking.js';
import { getProject } from './catalog.js';
import { getGuestMenu } from './meals.js';
import { AppError } from './errors.js';
import { normalizeHealthProfile } from './health-profile.js';
import { systemBusinessClock } from './clock.js';
import { isDateOnly } from './staffing.js';
import { inspectWellnessCollaboration } from './wellness-run-evidence.js';

const MAX_STAY_DAYS = 7;
const MAX_CANDIDATE_PROJECTS = 3;
const MAX_SLOTS_PER_DAY = 18;
const DAY_BLOCKS = [
  { key: 'morning', start: 6 * 60, end: 12 * 60 },
  { key: 'afternoon', start: 12 * 60, end: 18 * 60 },
  { key: 'evening', start: 18 * 60, end: 24 * 60 }
];
const MEALS = [
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch', label: '午餐' },
  { key: 'dinner', label: '晚餐' }
];
const guestLock = () => db.driver === 'mysql' ? ' FOR UPDATE' : '';

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

export function wellnessAdoptionFingerprint(input) {
  return hash(JSON.stringify({ sourceRunId: input.sourceRunId, sessionId: input.sessionId,
    selectedCandidateIds: [...new Set(input.selectedCandidateIds)].sort() }));
}

function checkAdoptionReplay(row, input) {
  const previous = json(row.evidence_json, {}).adoption;
  if (!previous || !Array.isArray(previous.selectedCandidateIds)
    || wellnessAdoptionFingerprint(previous) !== wellnessAdoptionFingerprint(input)) {
    throw new AppError(409, 'WELLNESS_ADOPTION_KEY_CONFLICT', '同一采纳标识不能用于不同来源、会话或候选');
  }
}

function dateShift(date, days) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dateDistance(start, end) {
  return Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86_400_000);
}

function localMinutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function decodeItem(row) {
  return {
    id: row.id,
    businessDate: String(row.business_date).slice(0, 10),
    slotKey: row.slot_key,
    type: row.item_type,
    candidateId: row.candidate_id || null,
    title: row.title,
    localStart: row.local_start || null,
    localEnd: row.local_end || null,
    status: row.status,
    reason: row.reason,
    location: row.location || null,
    ruleIds: json(row.rule_ids_json, []),
    sourceIds: json(row.source_ids_json, []),
    environmentSnapshotId: row.environment_snapshot_id || null,
    evidence: json(row.evidence_json, {})
  };
}

function decodeDraft(row, items = []) {
  const evidence = json(row.evidence_json, {});
  return {
    draftId: row.id,
    guestId: row.guest_id,
    version: Number(row.version),
    sourceRunId: row.source_run_id || null,
    stayStart: String(row.stay_start).slice(0, 10),
    stayEnd: String(row.stay_end).slice(0, 10),
    status: row.status,
    reviewStatus: row.review_status || (row.status === 'active' ? 'active' : row.status === 'cancelled' ? 'returned' : 'pending_review'),
    reviewReason: row.review_reason || '',
    reviewedAt: row.reviewed_at || null,
    supersedesDraftId: row.supersedes_draft_id || null,
    reviewThreadId: row.review_thread_id || row.id,
    active: row.status === 'active',
    reviewPolicy: { mode: row.review_policy, samplePercent: Number(row.review_sample_percent || 0) },
    evidence,
    parentRunId: evidence.parentRunId || row.source_run_id || null,
    sessionId: evidence.sessionId || evidence.adoption?.sessionId || null,
    selectedCandidateIds: Array.isArray(evidence.coordinator?.selectedCandidateIds)
      ? evidence.coordinator.selectedCandidateIds : [],
    createdAt: row.created_at,
    items
  };
}

function adoptionBody(body) {
  return body && typeof body === 'object' && !Array.isArray(body)
    && body.action === 'adopt_candidate';
}

function validateAdoptionBody(body) {
  if (!adoptionBody(body)) throw new AppError(400, 'WELLNESS_ADOPTION_INPUT_INVALID', '采纳请求必须明确指定已有助手运行');
  const allowed = ['action', 'sourceRunId', 'sessionId', 'candidateId', 'selectedCandidateIds'];
  if (Object.keys(body).some(key => !allowed.includes(key))) {
    throw new AppError(400, 'WELLNESS_ADOPTION_INPUT_INVALID', '采纳请求包含不允许字段');
  }
  if (typeof body.sourceRunId !== 'string' || !/^run_[0-9a-f-]{36}$/.test(body.sourceRunId)
    || typeof body.sessionId !== 'string' || !/^as_[0-9a-f-]{36}$/.test(body.sessionId)) {
    throw new AppError(400, 'WELLNESS_ADOPTION_SOURCE_INVALID', '采纳请求缺少有效来源运行或会话');
  }
  const selectedCandidateIds = Array.isArray(body.selectedCandidateIds)
    ? [...new Set(body.selectedCandidateIds)] : [];
  if (!selectedCandidateIds.length || selectedCandidateIds.some(item => typeof item !== 'string' || item.length > 160)) {
    throw new AppError(400, 'WELLNESS_ADOPTION_CANDIDATES_INVALID', '采纳请求必须包含候选编号');
  }
  if (body.candidateId !== undefined && (typeof body.candidateId !== 'string' || !selectedCandidateIds.includes(body.candidateId))) {
    throw new AppError(400, 'WELLNESS_ADOPTION_CANDIDATE_INVALID', '当前候选不在本次管家选择中');
  }
  return { ...body, selectedCandidateIds };
}

export function validateWellnessAdoptionSelection({ sessionId, runSessionId, runStatus, selectedCandidateIds,
  candidateIds, adoptedCandidateIds }) {
  if (runStatus !== 'completed') return { ok: false, errorCode: 'WELLNESS_ADOPTION_RUN_INCOMPLETE' };
  if (sessionId !== runSessionId) return { ok: false, errorCode: 'WELLNESS_ADOPTION_SESSION_MISMATCH' };
  const allowlist = new Set(Array.isArray(candidateIds) ? candidateIds : []);
  const adopted = new Set(Array.isArray(adoptedCandidateIds) ? adoptedCandidateIds : []);
  const selected = Array.isArray(selectedCandidateIds) ? selectedCandidateIds : [];
  if (!selected.length) return { ok: false, errorCode: 'WELLNESS_ADOPTION_CANDIDATES_INVALID' };
  if (selected.some(candidateId => !allowlist.has(candidateId) || !adopted.has(candidateId))) {
    return { ok: false, errorCode: 'WELLNESS_ADOPTION_CANDIDATE_FORBIDDEN' };
  }
  return { ok: true, selectedCandidateIds: [...new Set(selected)] };
}

function loadReviewPolicy() {
  const configured = process.env.WELLNESS_DRAFT_REVIEW_POLICY === 'sampled_review' ? 'sampled_review' : 'auto';
  const sample = Number(process.env.WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT);
  const samplePercent = configured === 'sampled_review' && Number.isFinite(sample)
    ? Math.max(0, Math.min(100, Math.floor(sample))) : configured === 'sampled_review' ? 20 : 0;
  return { mode: configured, samplePercent };
}

function selectedBySample(guestId, date, candidateId, percent) {
  if (percent <= 0) return false;
  const value = Number.parseInt(hash(`${guestId}\u0000${date}\u0000${candidateId}`).slice(0, 8), 16) % 100;
  return value < percent;
}

function hardHealthState(profile, pendingIntakes = []) {
  const structured = normalizeHealthProfile(profile.health_profile);
  const legacyChronic = Array.isArray(profile.chronic) ? profile.chronic : [];
  const pendingProfiles = pendingIntakes.map(row => normalizeHealthProfile(json(row.structured_json, {})));
  const chronic = legacyChronic.length > 0 || structured.chronic.status === 'reported'
    || pendingProfiles.some(item => item.chronic.status === 'reported');
  const medicationInformation = structured.medications.status === 'reported'
    || pendingProfiles.some(item => item.medications.status === 'reported');
  const mobilityRequiresReview = structured.mobility.status === 'assistance'
    || (typeof profile.mobility === 'string' && /需|需要|协助|轮椅|拐杖|助行器/u.test(profile.mobility))
    || pendingProfiles.some(item => item.mobility.status === 'assistance');
  const allergyOrRestriction = structured.allergies.status === 'reported'
    || structured.dietaryRestrictions.status === 'reported'
    || (Array.isArray(profile.allergies) && profile.allergies.length > 0)
    || pendingProfiles.some(item => item.allergies.status === 'reported' || item.dietaryRestrictions.status === 'reported');
  const reviewFields = ['chronic', 'medications', 'allergies', 'dietaryRestrictions', 'mobility', 'sleep', 'skin'];
  const unverified = pendingIntakes.length > 0 || reviewFields.some(key =>
    ['unanswered', 'unknown'].includes(structured[key].status))
    || pendingProfiles.some(candidate => reviewFields.some(key => ['unanswered', 'unknown'].includes(candidate[key].status)));
  return { hard: chronic || medicationInformation || mobilityRequiresReview || allergyOrRestriction || unverified,
    chronic, medicationInformation, mobilityRequiresReview, allergyOrRestriction, unverified };
}

function sourceRefs(candidate, agentRunId) {
  const refs = Array.isArray(candidate.sourceIds) ? candidate.sourceIds : [];
  const unique = new Map(refs.filter(item => item?.type && item.id !== undefined)
    .map(item => [`${item.type}:${item.id}`, { type: item.type, id: String(item.id), label: item.label || item.type }]));
  unique.set(`agent_run:${agentRunId}`, { type: 'agent_run', id: agentRunId, label: '领域智能体运行' });
  return [...unique.values()];
}

async function collaborationDate(runId, domainAgent) {
  if (!domainAgent?.runId || !['domain.nutrition', 'domain.exercise'].includes(domainAgent.agentId)) return null;
  const row = await db.prepare('SELECT agent_input_json FROM agent_runs WHERE id=? AND parent_run_id=? AND agent_id=?')
    .get(domainAgent.runId, runId, domainAgent.agentId);
  const input = json(row?.agent_input_json, {});
  return isDateOnly(input.date) ? input.date : null;
}

async function createDomainRun({ user, body, requestKey }) {
  const callerText = typeof body.request === 'string' ? body.request.trim() : '';
  if (callerText.length > 1000) throw new AppError(400, 'WELLNESS_DRAFT_REQUEST_INVALID', '疗程说明最多 1000 个字符');
  const fixtureMarker = process.env.NODE_ENV === 'test' && process.env.Q21_ACCEPTANCE_HOOKS === '1'
    ? 'Q21:SCHEDULE ' : '';
  const requestText = `${fixtureMarker}请结合我的入住期间，整理每日三餐与运动/疗程候选。需要用营养与运动领域只读资料，按真实日期时段和环境规则安排；缺少实际菜单或时段时明确留空。${callerText ? ` 客人补充：${callerText}` : ''}`;
  const response = await chatWithAssistant({ user, role: 'guest', text: requestText,
    sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
    clientRequestId: `stage21:${requestKey}`, coordinationTask: WELLNESS_DRAFT_COORDINATION_TASK });
  if (!response.runId || response.status !== 'completed') {
    throw new AppError(502, 'WELLNESS_DOMAIN_RUN_FAILED', '营养或运动领域协作没有完成，未创建疗程草案');
  }
  const run = await getAssistantRun({ user, role: 'guest', runId: response.runId });
  const sourceAgents = new Map((Array.isArray(run.collaboration?.agents) ? run.collaboration.agents : [])
    .map(agent => [agent.agentId, agent]));
  const dateByAgent = {};
  for (const name of ['domain.nutrition', 'domain.exercise']) {
    dateByAgent[name] = await collaborationDate(run.runId, sourceAgents.get(name));
  }
  if (!dateByAgent['domain.nutrition'] || !dateByAgent['domain.exercise']) {
    throw new AppError(502, 'WELLNESS_DOMAIN_DATE_MISSING', '领域运行缺少可核对的业务日期，未创建疗程草案');
  }
  const validated = inspectWellnessCollaboration(run, { expectedExerciseDate: dateByAgent['domain.exercise'] });
  if (!validated.valid) {
    throw new AppError(502, 'WELLNESS_DOMAIN_EVIDENCE_INVALID', '领域工具、结构化选择或来源证据未通过校验，未创建疗程草案', {
      sourceRunId: response.runId, executionMode: run.executionMode, status: run.status,
      evidenceRejection: validated.rejection
    });
  }
  return { run, ...validated, dateByAgent };
}

function candidateIdsByMeal(candidates) {
  const map = new Map();
  for (const item of candidates.filter(candidate => candidate.domain === 'nutrition')) {
    const mealType = item.details?.mealType;
    if (!['breakfast', 'lunch', 'dinner'].includes(mealType) || !item.details?.dishId) continue;
    if (!map.has(mealType)) map.set(mealType, item);
  }
  return map;
}

async function activityCandidates(candidates, preserveSelected = false) {
  const rank = activityTag => activityTag === 'swimming_training' ? 0
    : activityTag === 'walking' ? 1 : activityTag === 'group_exercise' ? 2 : 3;
  const projects = [];
  for (const candidate of candidates.filter(item => item.domain === 'exercise' && item.details?.projectId)) {
    const project = await getProject(candidate.details.projectId);
    if (project) projects.push({ candidate, project });
  }
  const ranked = projects.sort((left, right) => rank(left.project.activityTag) - rank(right.project.activityTag)
    || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
  return preserveSelected ? ranked : ranked.slice(0, MAX_CANDIDATE_PROJECTS);
}

function matchedRules(availability) {
  const decisions = (availability?.environment?.checks || []).flatMap(check => check.ruleDecisions || []);
  const matched = decisions.filter(item => item.matched);
  return [...new Set(matched.map(item => item.ruleId).filter(Boolean))];
}

function ruleEvidence(availability) {
  return (availability?.environment?.checks || []).flatMap(check => check.ruleDecisions || [])
    .filter(item => item.matched).map(item => ({ ruleId: item.ruleId, action: item.action, reason: item.reason,
      fieldSources: item.fieldSources || [] }));
}

function unknownMarine(availability) {
  return ruleEvidence(availability).some(item => item.ruleId === 'R5'
    && item.fieldSources.some(source => source.field === 'environment.seaStatus' && source.value === 'missing'));
}

function summarizedInventorySources(summary, type, id) {
  return (Array.isArray(summary?.sources) ? summary.sources : [])
    .filter(source => source?.type === type && (id === undefined || String(source.id) === String(id)))
    .slice(0, 40).map(source => ({ type: source.type, id: String(source.id), label: `${source.type} ${source.id}` }));
}

function nutritionNoCandidateProof(agent) {
  const summary = agent?.tools?.find(tool => tool.toolName === 'get_nutrition_context')?.resultSummary;
  const source = summarizedInventorySources(summary, 'nutrition_candidate_inventory', 'main-dish-catalog')[0];
  const candidateCount = Number(summary?.candidateCount);
  const excludedCandidateCount = Number(summary?.excludedCandidateCount);
  const catalogMainDishCount = Number(summary?.catalogMainDishCount);
  if (!source || candidateCount !== 0 || !Number.isFinite(catalogMainDishCount)
    || !((catalogMainDishCount === 0 && excludedCandidateCount === 0)
      || (catalogMainDishCount > 0 && excludedCandidateCount === catalogMainDishCount))) return null;
  return { status: catalogMainDishCount === 0 ? 'catalog_empty' : 'all_candidates_excluded',
    candidateCount, excludedCandidateCount, catalogMainDishCount, sources: summary.sources };
}

function dangerousMarine(availability) {
  return ruleEvidence(availability).some(item => item.ruleId === 'R5'
    && item.fieldSources.some(source => source.field === 'environment.seaStatus' && source.value === 'unsafe'));
}

function statusForAllowedCandidate({ guestId, date, candidate, healthRisk, policy, environment }) {
  const ruleReview = ruleEvidence(environment).some(item => item.action === 'restrict' || item.action === 'reject');
  if (healthRisk.hard || ruleReview || candidate.status === 'requires_review') return 'mandatory_review';
  if (policy.mode === 'sampled_review'
    && selectedBySample(guestId, date, candidate.candidateId, policy.samplePercent)) return 'sampled_review';
  return 'pending_review';
}

function healthReviewReasons(healthRisk) {
  return [
    ...(healthRisk.chronic ? ['档案或待核实自述包含慢病信息'] : []),
    ...(healthRisk.medicationInformation ? ['档案或待核实自述包含用药信息'] : []),
    ...(healthRisk.mobilityRequiresReview ? ['行动能力需要协助或待进一步核实'] : []),
    ...(healthRisk.allergyOrRestriction ? ['存在过敏或饮食限制，须逐项核对'] : []),
    ...(healthRisk.unverified && !healthRisk.chronic && !healthRisk.medicationInformation
      && !healthRisk.mobilityRequiresReview && !healthRisk.allergyOrRestriction ? ['健康档案未完整核实'] : [])
  ];
}

function domainCandidateReviewReason(candidate) {
  if (candidate.status === 'requires_review') return candidate.reason || 'Stage20 领域规则要求人工复核。';
  return '';
}

function reviewEvidence({ healthRisk, policy, status }) {
  return { reviewStatus: status, reviewPolicy: policy.mode, reviewSamplePercent: policy.samplePercent,
    healthRisk, mandatoryReasons: status === 'mandatory_review' ? healthReviewReasons(healthRisk) : [] };
}

function makeItem({ date, slotKey, type, candidateId = null, title, localStart = null, localEnd = null,
  status, reason, location = null, ruleIds = [], sourceIds = [], environmentSnapshotId = null, evidence = {} }) {
  return { id: id('wellness_item'), date, slotKey, type, candidateId, title,
    localStart, localEnd, status, reason, location, ruleIds, sourceIds, environmentSnapshotId, evidence };
}

function existingMenuByMeal(menu) {
  if (!menu || menu.status !== 'ready' || !menu.menu) return new Map();
  const result = new Map();
  for (const item of menu.items || []) {
    if (item.slot !== 'main' || !['breakfast', 'lunch', 'dinner'].includes(item.mealType)) continue;
    if (!item.dish || item.currentlyRestricted) continue;
    result.set(item.mealType, item);
  }
  return result;
}

async function mealItemsForDate({ guestId, date, nutritionDate, nutritionCandidates, agent, healthRisk, policy, adoption = false }) {
  const result = [];
  let menu = null;
  try { menu = await getGuestMenu(guestId, date); }
  catch { menu = null; }
  const actual = existingMenuByMeal(menu);
  for (const meal of MEALS) {
    const published = adoption ? null : actual.get(meal.key);
    if (published) {
      const source = [{ type: 'meal_menu', id: String(menu.menu.id), label: `${date} 已发布餐单` },
        { type: 'dish', id: String(published.dish.id), label: published.dish.name }];
      result.push(makeItem({ date, slotKey: meal.key, type: 'meal', candidateId: `${meal.key}:${published.dish.id}`,
        title: published.dish.name, status: statusForAllowedCandidate({ guestId, date,
          candidate: { candidateId: `${meal.key}:${published.dish.id}` }, healthRisk, policy }),
        reason: `引用本人当日已发布餐单主菜；草案仍待确认，不会点餐。${healthRisk.hard ? ` ${healthReviewReasons(healthRisk).join('；')}。` : ''}`,
        sourceIds: source,
        evidence: { menuId: menu.menu.id, menuVersion: menu.menu.version, mealType: meal.key, sourceAgentRunId: agent.runId,
          healthRisk, mandatoryReviewReasons: healthReviewReasons(healthRisk) } }));
      continue;
    }
    const candidate = date === nutritionDate ? nutritionCandidates.get(meal.key) : null;
    if (candidate) {
      const reviewStatus = statusForAllowedCandidate({ guestId, date, candidate, healthRisk, policy });
      result.push(makeItem({ date, slotKey: meal.key, type: 'meal', candidateId: candidate.candidateId,
        title: candidate.title, status: reviewStatus,
        reason: `${date} 的营养候选来自真实领域工具；该日没有已发布餐单，因此只作待确认建议，不生成餐单或点餐。${reviewStatus === 'mandatory_review' ? ` ${healthReviewReasons(healthRisk).join('；')}。` : ''}`,
        sourceIds: sourceRefs(candidate, agent.runId), evidence: { mealType: meal.key, sourceRunId: agent.runId,
          sourceDate: nutritionDate, supplyBoundary: candidate.details?.supplyBoundary || '实际供应须按该日餐单确认。',
          ...reviewEvidence({ healthRisk, policy, status: reviewStatus }) } }));
    } else {
      const noCandidateProof = date === nutritionDate ? nutritionNoCandidateProof(agent) : null;
      const sourceIds = noCandidateProof
        ? noCandidateProof.sources.filter(source => ['nutrition_candidate_inventory', 'guest_profile', 'health_intake', 'dish']
          .includes(source.type)).slice(0, 40).map(source => ({ type: source.type, id: String(source.id), label: `${source.type} ${source.id}` }))
        : [{ type: 'meal_menu_lookup', id: date, label: '该日餐單只读查询' }];
      const reason = noCandidateProof?.status === 'all_candidates_excluded'
        ? `营养主菜只读目录共 ${noCandidateProof.catalogMainDishCount} 条餐次候选；当前记录的限制排除了全部候选，保留明确餐食缺口。`
        : noCandidateProof?.status === 'catalog_empty'
          ? '营养主菜只读目录当前无候选，保留明确餐食缺口。'
          : '没有该日期的已发布餐单或该日营养候选；没有复制其他日期的餐点。';
      result.push(makeItem({ date, slotKey: meal.key, type: 'gap', title: meal.label, status: 'gap',
        reason, sourceIds,
        evidence: { mealType: meal.key, menuStatus: menu?.status || 'unavailable',
          ...(noCandidateProof ? { sourceDate: nutritionDate, sourceAgentRunId: agent.runId,
            inventoryStatus: noCandidateProof.status, candidateCount: noCandidateProof.candidateCount,
            excludedCandidateCount: noCandidateProof.excludedCandidateCount,
            catalogMainDishCount: noCandidateProof.catalogMainDishCount } : {}) } }));
    }
  }
  return result;
}

function localWindowConflict(candidate, slot, project) {
  const start = localMinutes(slot.localStart);
  if (project.activityTag === 'swimming_training' && start !== null && start < 13 * 60 + 30) {
    return '游泳时段早于午餐排班窗口 12:00–13:00 结束后 30 分钟；该时段不进入草案。';
  }
  return '';
}

function timeBand(start) {
  if (start < DAY_BLOCKS[0].end) return 'morning';
  if (start < DAY_BLOCKS[1].end) return 'afternoon';
  return 'evening';
}

function overlapsUsed(start, end, used) {
  return used.some(item => start < item.end && item.start < end);
}

async function activityItemsForDate({ guestId, date, candidates, agent, sourceDate, inventoryEvidence, parentRunId,
  healthRisk, policy }) {
  const blocks = new Map(DAY_BLOCKS.map(block => [block.key, null]));
  const reasons = new Map(DAY_BLOCKS.map(block => [block.key, []]));
  const used = [];
  const projectMap = new Map(candidates.map(item => [item.candidate.candidateId, item]));
  const inventory = date === sourceDate ? inventoryEvidence : null;
  const runSources = [
    { type: 'agent_run', id: agent.runId, label: '运动领域运行' },
    ...(parentRunId ? [{ type: 'agent_run', id: parentRunId, label: '协调者父运行' }] : [])
  ];
  if (!projectMap.size) {
    const verifiedInventory = inventory?.actualActivitySlotCount === 0
      && inventory?.potentiallyAvailableActualSlotCount === 0;
    const sourceIds = [...runSources, ...(verifiedInventory ? inventory.sources : [])];
    return DAY_BLOCKS.map(block => makeItem({ date, slotKey: block.key, type: 'gap',
      title: '运动项目未被协调者采纳', status: 'gap', reason: verifiedInventory
        ? '协调者没有采纳运动项目；运动工具已核对该日期的已登记活动时段为零。演示开放窗口不生成排期。'
        : `协调者没有采纳运动项目；${sourceDate} 的库存查询只证明该日期，不证明 ${date} 的库存为空。本日期保留缺口，不安排演示窗口。`,
      sourceIds, evidence: { inventoryStatus: verifiedInventory ? 'verified_empty' : 'not_queried_for_date',
        inventoryEvidenceDate: verifiedInventory ? date : sourceDate,
        inventoryProvesThisDate: Boolean(verifiedInventory), demoWindowsScheduled: false,
        parentRunId: parentRunId || null, childRunId: agent.runId,
        ...(verifiedInventory ? { availabilitySource: 'activity_slot_inventory', inventoryDate: date,
          projectCount: inventory.projectCount, actualActivitySlotCount: inventory.actualActivitySlotCount,
          potentiallyAvailableActualSlotCount: inventory.potentiallyAvailableActualSlotCount,
          demoOpenWindowCount: inventory.demoOpenWindowCount } : {}) } }));
  }
  const projectIds = [...new Set([...projectMap.values()].map(item => item.project.id))];
  const placeholders = projectIds.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT s.*,p.name AS project_name,p.location,p.is_demo AS project_is_demo,p.active AS project_active,
      (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
    FROM activity_slots s JOIN projects p ON p.id=s.project_id
    WHERE s.business_date=? AND s.project_id IN (${placeholders})
    ORDER BY s.starts_at,s.ends_at LIMIT ?`).all(date, ...projectIds, MAX_SLOTS_PER_DAY);
  let unknownOrUnsafeEvidence = null;
  for (const row of rows) {
    const match = [...projectMap.values()].find(item => item.project.id === row.project_id);
    if (!match) continue;
    const { candidate, project } = match;
    const assessment = await evaluateExistingDraftSlot({ project, row, guestId });
    const slot = assessment.slot;
    const band = timeBand(localMinutes(slot.localStart) ?? 24 * 60);
    const upstreamRuleIds = (candidate.details?.matchedRules || []).map(rule => rule.ruleId).filter(Boolean);
    const currentRuleIds = matchedRules(assessment);
    const refreshedR5 = candidate.status === 'rejected' && assessment.status === 'available'
      && upstreamRuleIds.length > 0 && upstreamRuleIds.every(ruleId => ruleId === 'R5')
      && !currentRuleIds.includes('R5');
    if (candidate.status === 'rejected' && assessment.status === 'available' && !refreshedR5) {
      reasons.get(band).push({ message: candidate.reason || 'Stage20 领域规则排除了该候选。', candidate, slot, project,
        assessment, ruleIds: upstreamRuleIds, excluded: true });
      continue;
    }
    const conflict = localWindowConflict(candidate, slot, project);
    if (conflict) {
      reasons.get(band).push({ message: conflict, candidate, slot, project,
        ruleIds: refreshedR5 ? [] : upstreamRuleIds, mealRestConflict: true });
      continue;
    }
    const effectiveUpstreamRuleIds = refreshedR5 ? [] : upstreamRuleIds;
    const ruleIds = [...new Set([...currentRuleIds, ...effectiveUpstreamRuleIds])];
    const evidence = { sourceRunId: agent.runId, sourceDate: candidate.details?.date || null,
      availabilityStatus: assessment.status, availabilitySource: 'activity_slots', remaining: assessment.remaining,
      isDemo: Boolean(project.isDemo || assessment.environment?.isDemo), rules: ruleEvidence(assessment),
      bookingAvailabilityStatus: assessment.status, domainCandidateStatus: candidate.status,
      domainCandidateReason: candidate.reason, coordinatorSelected: Boolean(candidate.coordinatorSelected),
      domainRuleIds: upstreamRuleIds, refreshedUpstreamRuleIds: refreshedR5 ? upstreamRuleIds : [] };
    const snapshotId = assessment.environment?.environmentSnapshotId || null;
    const sources = [...sourceRefs(candidate, agent.runId), { type: 'project_slot', id: slot.id, label: `${date} ${slot.localStart} 项目时段` },
      ...(snapshotId ? [{ type: 'environment_snapshot', id: snapshotId, label: `${date} 环境快照` }] : [])];
    if (assessment.status === 'available') {
      const start = localMinutes(slot.localStart);
      const end = localMinutes(slot.localEnd);
      if (start === null || end === null || overlapsUsed(start, end, used)) {
        reasons.get(band).push({ message: '该日期时段与草案中的其他条目冲突。', candidate, slot });
        continue;
      }
      if (!blocks.get(band)) {
        const reviewStatus = statusForAllowedCandidate({ guestId, date, candidate, healthRisk, policy, environment: assessment });
        blocks.set(band, makeItem({ date, slotKey: band, type: 'activity', candidateId: candidate.candidateId,
          title: candidate.title, localStart: slot.localStart, localEnd: slot.localEnd,
          status: reviewStatus,
          reason: `${project.isDemo ? '仅读取到该日期的演示排期；未预约、未占用容量，仍待人工确认。'
            : '读取到该日期既有开放时段；草案不会创建预约或占用容量。'}${!candidate.coordinatorSelected ? '该候选未被管家协调者采纳，仅供安全复核，不能作为已选建议。' : ''}${reviewStatus === 'mandatory_review' ? ` ${[...healthReviewReasons(healthRisk), domainCandidateReviewReason(candidate)].filter(Boolean).join('；')}。` : ''}`,
          location: project.location, ruleIds, sourceIds: sources, environmentSnapshotId: snapshotId,
          evidence: { ...evidence, ...reviewEvidence({ healthRisk, policy, status: reviewStatus }) } }));
        used.push({ start, end });
      }
    } else if (assessment.status === 'pending' || unknownMarine(assessment)) {
      if (!blocks.get(band)) {
        blocks.set(band, makeItem({ date, slotKey: band, type: 'activity', candidateId: candidate.candidateId,
          title: candidate.title, localStart: slot.localStart, localEnd: slot.localEnd,
          status: 'pending_confirmation', reason: unknownMarine(assessment)
            ? '潮汐或浪况资料未知；此项仅待现场确认，当前不可参加或预约。'
            : assessment.reason || '环境资料不完整，当前时段待确认。', location: project.location,
          ruleIds: [...new Set([...ruleIds, ...(unknownMarine(assessment) ? ['R5'] : [])])], sourceIds: sources,
          environmentSnapshotId: snapshotId, evidence }));
        unknownOrUnsafeEvidence = { candidate, slot, assessment };
      }
    } else if (assessment.status === 'restricted' || dangerousMarine(assessment)) {
      const details = ruleEvidence(assessment).map(item => `${item.ruleId}：${item.reason}`).join('；');
      reasons.get(band).push({ message: details || assessment.reason || '环境或健康规则排除此时段。', candidate, slot, ruleIds, assessment, project });
    }
  }

  return DAY_BLOCKS.map(block => blocks.get(block.key) || (() => {
    const conflicts = reasons.get(block.key) || [];
    const swimConflict = conflicts.find(item => item.project?.activityTag === 'swimming_training');
    const sourceIds = conflicts.flatMap(item => sourceRefs(item.candidate, agent.runId));
    const ruleIds = [...new Set(conflicts.flatMap(item => item.ruleIds || []))];
    if (swimConflict) {
      const mealRestConflict = conflicts.some(item => item.mealRestConflict);
      if (mealRestConflict) ruleIds.push('Q21-MEAL-REST-30M');
      return makeItem({ date, slotKey: block.key, type: 'gap', title: '没有合法游泳时段', status: 'excluded',
        reason: `${swimConflict.message}${mealRestConflict ? '午餐冲突规则 Q21-MEAL-REST-30M。' : ''}没有合法替代时段，保留明确缺口。`,
        ruleIds: [...new Set(ruleIds)], sourceIds,
        evidence: mealRestConflict ? { lunchPlanningWindow: ['12:00', '13:00'], minimumRestMinutes: 30 } : {} });
    }
    const pending = conflicts.find(item => item.assessment?.status === 'pending' || unknownMarine(item.assessment));
    if (pending) return makeItem({ date, slotKey: block.key, type: 'gap', title: '活动待确认', status: 'pending_confirmation',
      reason: pending.assessment.reason || '环境资料未能确认，不生成可参加时段。', ruleIds: [...new Set(ruleIds)], sourceIds,
      environmentSnapshotId: pending.assessment.environment?.environmentSnapshotId || null,
      evidence: { rules: ruleEvidence(pending.assessment) } });
    const reason = conflicts.length ? `没有可安排的时段：${[...new Set(conflicts.map(item => item.message))].join('；')}`
      : '没有该日期已登记且通过预约同源校验的实际项目时段；保留缺口，不把项目开放窗口当作排期。';
    const excluded = conflicts.some(item => item.excluded || (item.project && (item.assessment?.status === 'restricted' || dangerousMarine(item.assessment))));
    const noActualRows = !conflicts.length;
    const gapSources = [...new Map([...sourceIds, ...(inventory?.sources || [])]
      .map(item => [`${item.type}:${item.id}`, item])).values()];
    return makeItem({ date, slotKey: block.key, type: excluded || noActualRows ? 'gap' : 'rest',
      title: excluded ? '项目时段已排除' : noActualRows ? '没有已登记的活动时段' : '休息 / 自由活动',
      status: excluded ? 'excluded' : noActualRows ? 'gap' : 'proposed', reason,
      ruleIds: [...new Set(ruleIds)], sourceIds: gapSources,
      evidence: unknownOrUnsafeEvidence ? { checkedExistingActivitySlots: true }
        : inventory ? { availabilitySource: 'activity_slots', inventoryDate: date,
          actualActivitySlotCount: inventory.actualActivitySlotCount,
          potentiallyAvailableActualSlotCount: inventory.potentiallyAvailableActualSlotCount,
          demoOpenWindowCount: inventory.demoOpenWindowCount, demoWindowsScheduled: false } : {} });
  })());
}

async function buildDraftItems({ guestId, profile, startDate, dayCount, candidates, agents, dateByAgent, exerciseInventory,
  parentRunId, policy, adoption = false }) {
  const pendingIntakes = await db.prepare(`SELECT structured_json FROM health_intakes
    WHERE guest_id=? AND status='pending' ORDER BY revision DESC LIMIT 50`).all(guestId);
  const healthRisk = hardHealthState(profile, pendingIntakes);
  const nutritionAgent = agents.get('domain.nutrition');
  const exerciseAgent = agents.get('domain.exercise');
  const nutritionByMeal = candidateIdsByMeal(candidates);
  const activities = await activityCandidates(candidates, adoption);
  const items = [];
  for (let offset = 0; offset < dayCount; offset += 1) {
    const date = dateShift(startDate, offset);
    items.push(...await mealItemsForDate({ guestId, date,
      nutritionDate: dateByAgent['domain.nutrition'], nutritionCandidates: nutritionByMeal,
      agent: nutritionAgent, healthRisk, policy, adoption }));
    items.push(...await activityItemsForDate({ guestId, date, candidates: adoption && date !== dateByAgent['domain.exercise'] ? [] : activities,
      agent: exerciseAgent, sourceDate: dateByAgent['domain.exercise'], inventoryEvidence: exerciseInventory,
      parentRunId, healthRisk, policy }));
  }
  if (adoption) items.push(...await adoptedDomainItems({ guestId, date: dateByAgent['domain.exercise'], candidates, agents, items }));
  return items;
}

async function adoptedDomainItems({ guestId, date, candidates, agents, items }) {
  const result = [];
  const used = items.filter(item => item.date === date && item.type === 'activity')
    .map(item => ({ start: localMinutes(item.localStart), end: localMinutes(item.localEnd) }));
  for (const candidate of candidates.filter(item => ['physio', 'psychology'].includes(item.domain))) {
    const agent = agents.get(`domain.${candidate.domain}`);
    const sources = sourceRefs(candidate, agent.runId);
    const slotKey = `${candidate.domain}:${hash(candidate.candidateId).slice(0, 12)}`;
    const evidence = { domain: candidate.domain, childRunId: agent.runId, sourceCandidateId: candidate.candidateId,
      readOnlySuggestion: true, ...(candidate.domain === 'psychology' ? { resource: {
        id: candidate.details?.resourceId, title: candidate.title, audioUrl: candidate.details?.audioUrl,
        durationSeconds: candidate.details?.durationSeconds, type: 'guided'
      } } : {}) };
    if (candidate.domain === 'psychology') {
      result.push(makeItem({ date, slotKey, type: 'rest', candidateId: candidate.candidateId, title: candidate.title,
        status: 'proposed', reason: '已采纳的心理陪伴资源，可打开现有播放器；不是课程预约或医疗处方。',
        sourceIds: sources, evidence }));
      continue;
    }
    const project = await getProject(candidate.details?.projectId || candidate.candidateId);
    const rows = project ? await db.prepare(`SELECT s.*,p.name AS project_name,p.location,p.is_demo AS project_is_demo,
      p.active AS project_active,(SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
      FROM activity_slots s JOIN projects p ON p.id=s.project_id WHERE s.project_id=? AND s.business_date=? ORDER BY s.starts_at`)
      .all(project.id, date) : [];
    let selected;
    for (const row of rows) {
      const checked = await evaluateExistingDraftSlot({ project, row, guestId });
      const start = localMinutes(checked.slot.localStart), end = localMinutes(checked.slot.localEnd);
      if (!checked.available || start === null || end === null || overlapsUsed(start, end, used)) continue;
      selected = checked;used.push({start,end});break;
    }
    result.push(makeItem({ date, slotKey, type: selected ? 'activity' : 'gap', candidateId: candidate.candidateId,
      title: candidate.title, status: selected ? 'mandatory_review' : 'gap',
      reason: selected ? '已采纳理疗建议及真实可用时段，须负责医护审核后才预约。'
        : '保留本次理疗建议与来源；缺少该日期可用且不冲突的真实时段，不生成预约。',
      localStart: selected?.slot.localStart, localEnd: selected?.slot.localEnd, location: project?.location,
      sourceIds: [...sources, ...(selected ? [{type:'project_slot',id:selected.slot.id,label:`${date} ${selected.slot.localStart} 理疗时段`}] : [])],
      environmentSnapshotId: selected?.environment?.environmentSnapshotId || null,
      evidence: { ...evidence, ...(selected ? { selectedSlotId: selected.slot.id, availabilitySource: 'activity_slots',
        rules: ruleEvidence(selected), availabilityStatus: selected.status } : {}) } }));
  }
  return result;
}

function draftEvidence(run, collaboration, agents, dateByAgent, candidates, policy, planningCandidates = candidates,
  emptyCandidateDomains = {}) {
  return {
    parentRunId: run.runId,
    sessionId: run.sessionId,
    executionMode: run.executionMode,
    model: run.model || null,
    provider: run.provider || null,
    coordinator: {
      status: collaboration.coordinatorStatus,
      selectionSource: collaboration.selectionSource,
      validation: collaboration.selectionValidation,
      selectedCandidateIds: collaboration.finalAdoptedCandidateIds
    },
    selectedSuggestions: candidates.map(candidate => ({ candidateId: candidate.candidateId, domain: candidate.domain,
      title: candidate.title, status: candidate.status, reason: candidate.reason,
      childRunId: agents.get(`domain.${candidate.domain}`)?.runId || null,
      sourceIds: candidate.sourceIds || [], details: candidate.details || {} })),
    domainAgents: [...agents.values()].map(agent => ({
      runId: agent.runId, agentId: agent.agentId, model: agent.model, provider: agent.provider,
      executionMode: agent.executionMode, status: agent.status, candidateIds: agent.candidateIds,
      tools: agent.tools, sources: agent.sources.map(source => ({ type: source.type, id: String(source.id), label: source.label || source.type })),
      modelSteps: agent.modelSteps.map(step => ({ status: step.status, durationMs: step.durationMs,
        inputTokens: step.inputTokens, outputTokens: step.outputTokens, estimatedCostUsd: step.estimatedCostUsd }))
    })),
    candidateIds: candidates.map(item => item.candidateId),
    planningCandidates: planningCandidates.filter(item => item.domain === 'exercise').map(item => ({
      candidateId: item.candidateId, status: item.status, coordinatorSelected: Boolean(item.coordinatorSelected),
      reason: item.reason, sourceIds: item.sourceIds || [], ruleIds: (item.details?.matchedRules || []).map(rule => rule.ruleId).filter(Boolean)
    })),
    emptyCandidateDomains,
    domainDates: dateByAgent,
    graphBudget: collaboration.graphBudget,
    graphDurationMs: collaboration.graphDurationMs,
    reviewPolicy: policy
  };
}

export async function createWellnessDraft({ user, body, requestKey }) {
  if (!user || user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可生成本人疗程草案');
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(requestKey)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', '草案请求缺少有效的幂等标识');
  }
  const existing = await db.prepare('SELECT * FROM wellness_drafts WHERE guest_id=? AND request_key=?').get(user.id, requestKey);
  if (existing) return { ...(await getWellnessDraft(user.id, existing.id)), deduplicated: true };
  if (body && (typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['request', 'sessionId', 'regenerateFromDraftId'].includes(key)))) {
    throw new AppError(400, 'WELLNESS_DRAFT_INPUT_INVALID', '疗程草案请求包含不允许字段');
  }
  body = body || {};
  let regeneration = null;
  if (body.regenerateFromDraftId !== undefined) {
    if (typeof body.regenerateFromDraftId !== 'string' || body.regenerateFromDraftId.length > 64) {
      throw new AppError(400, 'WELLNESS_REGENERATION_INVALID', '退回版本编号无效');
    }
    const rejected = await db.prepare(`SELECT id,version,review_status,review_reason,review_thread_id FROM wellness_drafts
      WHERE id=? AND guest_id=?`).get(body.regenerateFromDraftId, user.id);
    if (!rejected || rejected.review_status !== 'returned') {
      throw new AppError(409, 'WELLNESS_REGENERATION_STATE', '只能依据本人已退回的疗程版本重新生成');
    }
    regeneration = { draftId: rejected.id, version: Number(rejected.version), reason: rejected.review_reason || '',
      threadId: rejected.review_thread_id || rejected.id };
    body = { ...body, request: `${typeof body.request === 'string' ? body.request.trim() : ''} 医护退回要求：${regeneration.reason}。请逐项遵守退回原因，排除被退回项目；不要复制原有受限安排。`.trim() };
  }
  const profile = await guestProfile(user.id);
  if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  const startDate = String(profile.check_in || '').slice(0, 10);
  const endDate = String(profile.check_out || '').slice(0, 10);
  if (!isDateOnly(startDate) || !isDateOnly(endDate) || endDate <= startDate) {
    throw new AppError(409, 'WELLNESS_STAY_INVALID', '请先由工作人员维护有效入住日期');
  }
  const stayDays = dateDistance(startDate, endDate);
  const dayCount = Math.min(stayDays, MAX_STAY_DAYS);
  if (dayCount < 1) throw new AppError(409, 'WELLNESS_STAY_INVALID', '入住区间没有可规划日期');

  const graph = await createDomainRun({ user, body: body || {}, requestKey });
  const policy = loadReviewPolicy();
  const items = await buildDraftItems({ guestId: user.id, profile, startDate, dayCount,
    candidates: graph.planningCandidates, agents: graph.agents, dateByAgent: graph.dateByAgent,
    exerciseInventory: graph.exerciseInventory, parentRunId: graph.run.runId, policy });
  const evidence = { ...draftEvidence(graph.run, graph.collaboration, graph.agents, graph.dateByAgent,
    graph.candidates, policy, graph.planningCandidates, graph.emptyCandidateDomains),
    ...(regeneration ? { regeneration } : {}) };
  const draftId = id('wellness_draft');
  let createdRow;
  await transaction(async () => {
    await db.prepare(`SELECT user_id FROM guest_profiles WHERE user_id=?${guestLock()}`).get(user.id);
    const previous = await db.prepare('SELECT * FROM wellness_drafts WHERE guest_id=? AND request_key=?').get(user.id, requestKey);
    if (previous) { createdRow = previous; return; }
    const latest = await db.prepare('SELECT COALESCE(MAX(version),0) AS version,MAX(created_at) AS latest_created_at FROM wellness_drafts WHERE guest_id=?').get(user.id);
    const version = Number(latest?.version || 0) + 1;
    const wallClockMs = Date.parse(now());
    const previousCreated = latest?.latest_created_at instanceof Date ? latest.latest_created_at.getTime()
      : Date.parse(String(latest?.latest_created_at || '').replace(' ', 'T') + (String(latest?.latest_created_at || '').endsWith('Z') ? '' : 'Z'));
    const timestamp = new Date(Math.max(wallClockMs, Number.isFinite(previousCreated) ? previousCreated + 1 : wallClockMs)).toISOString();
    await db.prepare(`INSERT INTO wellness_drafts
      (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
       evidence_json,created_at,review_status,review_thread_id,supersedes_draft_id)
      VALUES(?,?,?,?,?,?,?,'pending_review',?,?,?,?,'pending_review',?,?)`).run(
      draftId, user.id, version, requestKey, graph.run.runId, startDate, endDate, policy.mode, policy.samplePercent,
      JSON.stringify(evidence), timestamp, regeneration?.threadId || draftId, regeneration?.draftId || null
    );
    for (const item of items) {
      await db.prepare(`INSERT INTO wellness_draft_items
        (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
         rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        item.id, draftId, item.date, item.slotKey, item.type, item.candidateId, item.title,
        item.localStart, item.localEnd, item.status, item.reason, item.location,
        JSON.stringify(item.ruleIds), JSON.stringify(item.sourceIds), item.environmentSnapshotId, JSON.stringify(item.evidence)
      );
    }
    await log(user.id, 'wellness_draft.create', 'wellness_draft', draftId,
      `版本 ${version}；来源运行 ${graph.run.runId}；仅保存待审草案`);
    if (regeneration) {
      await db.prepare(`INSERT INTO wellness_review_events
        (id,draft_id,review_thread_id,guest_id,actor_id,actor_role,action,reason,from_version,to_version,request_key,payload_json,created_at)
        VALUES(?,?,?,?,?,'guest','revision',?,?,?,?,?,?)`).run(
        id('wellness_review'), draftId, regeneration.threadId, user.id, user.id,
        `依据退回版本 ${regeneration.version} 重新生成：${regeneration.reason}`,
        regeneration.version, version, requestKey,
        JSON.stringify({ regeneratedFromDraftId: regeneration.draftId, sourceRunId: graph.run.runId }), timestamp);
    }
    createdRow = await db.prepare('SELECT * FROM wellness_drafts WHERE id=? AND guest_id=?').get(draftId, user.id);
  });
  const result = await getWellnessDraft(user.id, createdRow.id);
  return { ...result, deduplicated: createdRow.id !== draftId,
    diagnostics: { sourceRunId: graph.run.runId, executionMode: graph.run.executionMode,
      model: graph.run.model, provider: graph.run.provider, inputTokens: graph.run.inputTokens,
      outputTokens: graph.run.outputTokens, estimatedCostUsd: graph.run.estimatedCostUsd,
      graphBudget: graph.collaboration.graphBudget } };
}

// Persist a guest's explicit selection from an already completed collaboration.
// This path deliberately never calls chatWithAssistant or creates another run.
export async function adoptWellnessDraft({ user, body, requestKey }) {
  if (!user || user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可采纳本人疗程方案');
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(requestKey)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', '草案请求缺少有效的幂等标识');
  }
  const input = validateAdoptionBody(body);
  const existing = await db.prepare('SELECT * FROM wellness_drafts WHERE guest_id=? AND request_key=?').get(user.id, requestKey);
  if (existing) {
    checkAdoptionReplay(existing, input);
    return { ...(await getWellnessDraft(user.id, existing.id)), deduplicated: true };
  }

  const run = await getAssistantRun({ user, role: 'guest', runId: input.sourceRunId });
  const sourceSession = await db.prepare('SELECT status,expires_at FROM assistant_sessions WHERE id=?').get(run.sessionId);
  const expiry = sourceSession?.expires_at instanceof Date ? sourceSession.expires_at.getTime()
    : Date.parse(String(sourceSession?.expires_at || '').replace(' ', 'T'));
  if (!sourceSession || sourceSession.status !== 'active' || !Number.isFinite(expiry) || expiry <= Date.parse(now())) {
    throw new AppError(409, 'WELLNESS_ADOPTION_SOURCE_EXPIRED', '来源会话已过期，请先重新评估');
  }
  const runSelection = validateWellnessAdoptionSelection({ sessionId: input.sessionId, runSessionId: run.sessionId,
    runStatus: run.status, selectedCandidateIds: input.selectedCandidateIds,
    candidateIds: run.collaboration?.candidates?.map(candidate => candidate.candidateId),
    adoptedCandidateIds: run.collaboration?.finalAdoptedCandidateIds || run.collaboration?.selectedCandidateIds });
  if (!runSelection.ok) {
    const messages = {
      WELLNESS_ADOPTION_SESSION_MISMATCH: '来源会话与运行记录不一致',
      WELLNESS_ADOPTION_RUN_INCOMPLETE: '只能采纳已完成的助手运行',
      WELLNESS_ADOPTION_CANDIDATES_INVALID: '采纳请求必须包含候选编号',
      WELLNESS_ADOPTION_CANDIDATE_FORBIDDEN: '候选不属于该运行的管家采纳结果'
    };
    throw new AppError(409, runSelection.errorCode, messages[runSelection.errorCode]);
  }
  const collaboration = run.collaboration;
  const sourceAgents = new Map((collaboration?.agents || []).map(agent => [agent.agentId, agent]));
  const dateByAgent = {};
  for (const name of ['domain.nutrition', 'domain.exercise']) {
    dateByAgent[name] = await collaborationDate(run.runId, sourceAgents.get(name));
  }
  if (!dateByAgent['domain.nutrition'] || !dateByAgent['domain.exercise']) {
    throw new AppError(409, 'WELLNESS_ADOPTION_DATE_MISSING', '来源运行缺少可核对的业务日期');
  }
  const validated = inspectWellnessCollaboration(run, { expectedExerciseDate: dateByAgent['domain.exercise'] });
  if (!validated.valid) {
    throw new AppError(409, 'WELLNESS_ADOPTION_SOURCE_INVALID', '来源运行缺少可核对的协作证据', { evidenceRejection: validated.rejection });
  }
  const selectedIds = new Set(runSelection.selectedCandidateIds);
  const candidates = validated.candidates.filter(candidate => selectedIds.has(candidate.candidateId))
    .map(candidate => ({ ...candidate, coordinatorSelected: true }));
  if (candidates.length !== selectedIds.size) throw new AppError(409, 'WELLNESS_ADOPTION_SOURCE_INVALID', '候选缺少对应专业智能体来源');
  if (!candidates.length) throw new AppError(409, 'WELLNESS_ADOPTION_CANDIDATE_REQUIRED', '没有可采纳的候选');

  const profile = await guestProfile(user.id);
  if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  const startDate = String(profile.check_in || '').slice(0, 10);
  const endDate = String(profile.check_out || '').slice(0, 10);
  if (!isDateOnly(startDate) || !isDateOnly(endDate) || endDate <= startDate) {
    throw new AppError(409, 'WELLNESS_STAY_INVALID', '请先由工作人员维护有效入住日期');
  }
  if (Object.values(dateByAgent).some(date => date < systemBusinessClock.dateKey() || date < startDate || date >= endDate)) {
    throw new AppError(409, 'WELLNESS_ADOPTION_DATE_STALE', '来源建议日期已过期或不在当前入住区间，请重新评估');
  }
  const dayCount = Math.min(dateDistance(startDate, endDate), MAX_STAY_DAYS);
  if (dayCount < 1) throw new AppError(409, 'WELLNESS_STAY_INVALID', '入住区间没有可规划日期');
  const policy = loadReviewPolicy();
  const selectedPlanning = validated.planningCandidates.filter(candidate => selectedIds.has(candidate.candidateId));
  const items = await buildDraftItems({ guestId: user.id, profile, startDate, dayCount,
    candidates, agents: validated.agents, dateByAgent, exerciseInventory: validated.exerciseInventory,
    parentRunId: run.runId, policy, adoption: true });
  const evidence = {
    ...draftEvidence(run, collaboration, validated.agents, dateByAgent, candidates, policy,
      selectedPlanning, validated.emptyCandidateDomains),
    adoption: { sourceRunId: run.runId, sessionId: run.sessionId, selectedCandidateIds: input.selectedCandidateIds,
      candidateId: input.candidateId || input.selectedCandidateIds[0], mode: 'existing_completed_parent_run' }
  };
  evidence.coordinator.selectedCandidateIds = runSelection.selectedCandidateIds;
  const draftId = id('wellness_draft');
  let createdRow;
  await transaction(async () => {
    await db.prepare(`SELECT user_id FROM guest_profiles WHERE user_id=?${guestLock()}`).get(user.id);
    const previous = await db.prepare('SELECT * FROM wellness_drafts WHERE guest_id=? AND request_key=?').get(user.id, requestKey);
    if (previous) { checkAdoptionReplay(previous, input); createdRow = previous; return; }
    const latest = await db.prepare('SELECT COALESCE(MAX(version),0) AS version,MAX(created_at) AS latest_created_at FROM wellness_drafts WHERE guest_id=?').get(user.id);
    const version = Number(latest?.version || 0) + 1;
    const wallClockMs = Date.parse(now());
    const previousCreated = latest?.latest_created_at instanceof Date ? latest.latest_created_at.getTime()
      : Date.parse(String(latest?.latest_created_at || '').replace(' ', 'T') + (String(latest?.latest_created_at || '').endsWith('Z') ? '' : 'Z'));
    const timestamp = new Date(Math.max(wallClockMs, Number.isFinite(previousCreated) ? previousCreated + 1 : wallClockMs)).toISOString();
    await db.prepare(`INSERT INTO wellness_drafts
      (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
       evidence_json,created_at,review_status,review_thread_id,supersedes_draft_id)
      VALUES(?,?,?,?,?,?,?,'pending_review',?,?,?,?,'pending_review',?,NULL)`).run(
      draftId, user.id, version, requestKey, run.runId, startDate, endDate, policy.mode, policy.samplePercent,
      JSON.stringify(evidence), timestamp, draftId
    );
    for (const item of items) {
      await db.prepare(`INSERT INTO wellness_draft_items
        (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
         rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        item.id, draftId, item.date, item.slotKey, item.type, item.candidateId, item.title,
        item.localStart, item.localEnd, item.status, item.reason, item.location,
        JSON.stringify(item.ruleIds), JSON.stringify(item.sourceIds), item.environmentSnapshotId, JSON.stringify(item.evidence)
      );
    }
    await log(user.id, 'wellness_draft.adopt', 'wellness_draft', draftId,
      `版本 ${version}；采纳来源运行 ${run.runId}；候选 ${input.selectedCandidateIds.join(',')}；仅保存待审草案`);
    createdRow = await db.prepare('SELECT * FROM wellness_drafts WHERE id=? AND guest_id=?').get(draftId, user.id);
  });
  const result = await getWellnessDraft(user.id, createdRow.id);
  return { ...result, deduplicated: createdRow.id !== draftId,
    diagnostics: { sourceRunId: run.runId, sessionId: run.sessionId, selectedCandidateIds: input.selectedCandidateIds,
      modelCalls: run.modelCallCount, toolCalls: run.toolCallCount } };
}

export async function createRestChangeDraft({ user, reservationId, sessionId, sourceRunId, actionCardId, reason, requestKey }) {
  if (!user || user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可提出本人疗程调整');
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(requestKey)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', '调整草案缺少有效请求标识');
  }
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!trimmedReason || trimmedReason.length > 500) throw new AppError(400, 'WELLNESS_REASON_REQUIRED', '请说明希望休息或调整的原因');
  const create = async () => {
    const existing = await db.prepare('SELECT id FROM wellness_drafts WHERE guest_id=? AND request_key=?').get(user.id, requestKey);
    if (existing) return { draftId: existing.id, replayed: true };
    const profile = await guestProfile(user.id);
    if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
    const stayStart = String(profile.check_in || '').slice(0, 10);
    const stayEnd = String(profile.check_out || '').slice(0, 10);
    const reservation = await db.prepare(`SELECT r.id,r.status,r.wellness_draft_id AS wellnessDraftId,
        s.business_date AS businessDate,s.project_id AS projectId,p.name AS projectName
      FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
      WHERE r.id=? AND r.guest_id=?`).get(reservationId, user.id);
    if (!reservation || reservation.status !== 'cancelled') {
      throw new AppError(409, 'WELLNESS_REVIEW_STATE', '调整草案必须关联已取消的本人预约');
    }
    const businessDate = String(reservation.businessDate).slice(0, 10);
    if (!isDateOnly(stayStart) || !isDateOnly(stayEnd) || businessDate < stayStart || businessDate >= stayEnd) {
      throw new AppError(409, 'WELLNESS_STAY_INVALID', '预约日期不在当前有效入住区间内');
    }
    let sourceDraft = reservation.wellnessDraftId
      ? await db.prepare('SELECT id,version,review_thread_id AS reviewThreadId,review_status AS reviewStatus FROM wellness_drafts WHERE id=? AND guest_id=?')
        .get(reservation.wellnessDraftId, user.id)
      : null;
    if (!sourceDraft) sourceDraft = await db.prepare(`SELECT id,version,review_thread_id AS reviewThreadId,review_status AS reviewStatus
      FROM wellness_drafts WHERE guest_id=? AND review_status='active' ORDER BY version DESC,id DESC LIMIT 1`).get(user.id);
    const latest = await db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM wellness_drafts WHERE guest_id=?').get(user.id);
    const version = Number(latest?.version || 0) + 1;
    const draftId = id('wellness_draft');
    const timestamp = now();
    const threadId = sourceDraft?.reviewThreadId || sourceDraft?.id || draftId;
    const evidence = {
      stage: 23,
      requestedChange: 'rest_or_reschedule',
      requestReason: trimmedReason,
      sourceReservationId: reservation.id,
      sourceProjectId: reservation.projectId,
      sourceProjectName: reservation.projectName,
      sourceAssistantSessionId: sessionId,
      sourceAssistantRunId: sourceRunId,
      sourceActionCardId: actionCardId,
      requiresClinicianReview: true,
      activatesReplacement: false
    };
    await db.prepare(`INSERT INTO wellness_drafts
      (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
       evidence_json,created_at,review_status,review_thread_id,supersedes_draft_id)
      VALUES(?,?,?,?,?,?,?,'pending_review','sampled_review',100,?,?,'pending_review',?,?)`).run(
      draftId, user.id, version, requestKey, sourceRunId, stayStart, stayEnd,
      JSON.stringify(evidence), timestamp, threadId, sourceDraft?.id || null
    );
    const itemId = id('wellness_item');
    await db.prepare(`INSERT INTO wellness_draft_items
      (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
       rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
      VALUES(?,?,?,'morning','rest',NULL,?,NULL,NULL,'pending_review',?,NULL,'[]',?,NULL,?)`).run(
      itemId, draftId, businessDate, '休息调整（待医护审核）',
      `客人确认停止预约 ${reservation.id}；${trimmedReason}。本条为待审调整草案，不会自动激活替代项目。`,
      JSON.stringify([{ type: 'reservation', id: reservation.id, label: reservation.projectName || '已取消预约' },
        { type: 'assistant_session', id: sessionId, label: '客人助手会话' },
        { type: 'assistant_action', id: actionCardId, label: '已确认的调整请求' }]),
      JSON.stringify({ requiresClinicianReview: true, noReplacementReservation: true, sourceRunId })
    );
    await db.prepare(`INSERT INTO wellness_review_events
      (id,draft_id,review_thread_id,guest_id,actor_id,actor_role,action,reason,from_version,to_version,request_key,payload_json,created_at)
      VALUES(?,?,?,?,?,'guest','revision',?,?,?,?,?,?)`).run(
      id('wellness_review'), draftId, threadId, user.id, user.id, trimmedReason,
      sourceDraft?.version ?? null, version, requestKey,
      JSON.stringify({ sourceReservationId: reservation.id, sourceSessionId: sessionId,
        sourceAssistantRunId: sourceRunId, sourceActionCardId: actionCardId, kind: 'guest_rest_change_request' }), timestamp
    );
    await log(user.id, 'wellness_draft.guest_change_request', 'wellness_draft', draftId,
      `客人提出休息调整；关联已取消预约 ${reservation.id}；待医护审核`);
    return { draftId, replayed: false };
  };
  const result = hasActiveTransaction() ? await create() : await transaction(create);
  return { ...(await getWellnessDraft(user.id, result.draftId)), deduplicated: result.replayed };
}

export async function getWellnessDraft(guestId, draftId) {
  const row = await db.prepare('SELECT * FROM wellness_drafts WHERE id=? AND guest_id=?').get(draftId, guestId);
  if (!row) throw new AppError(404, 'WELLNESS_DRAFT_NOT_FOUND', '疗程草案不存在');
  const items = await db.prepare(`SELECT * FROM wellness_draft_items WHERE draft_id=?
    ORDER BY business_date,CASE slot_key WHEN 'breakfast' THEN 1 WHEN 'morning' THEN 2 WHEN 'lunch' THEN 3
      WHEN 'afternoon' THEN 4 WHEN 'dinner' THEN 5 ELSE 6 END,local_start`).all(draftId);
  return decodeDraft(row, items.map(decodeItem));
}

export async function listWellnessDrafts(guestId, { stayStart = null, stayEnd = null } = {}) {
  const filters = ['guest_id=?'];
  const params = [guestId];
  if (stayStart && stayEnd) { filters.push('stay_start=? AND stay_end=?'); params.push(stayStart, stayEnd); }
  const rows = await db.prepare(`SELECT * FROM wellness_drafts WHERE ${filters.join(' AND ')} ORDER BY version DESC,id DESC LIMIT 50`)
    .all(...params);
  const result = [];
  for (const row of rows) result.push(await getWellnessDraft(guestId, row.id));
  return result;
}

export async function wellnessTimeline(guestId) {
  const nowValue = systemBusinessClock.utc();
  const reservations = await db.prepare(`SELECT r.id,r.status,r.cancelled_at AS cancelledAt,r.cancellation_reason AS cancellationReason,
      s.project_id AS projectId,s.business_date AS businessDate,s.starts_at AS startsAt,s.ends_at AS endsAt,
      s.local_start AS localStart,s.local_end AS localEnd,p.name AS projectName,p.location
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
    WHERE r.guest_id=? ORDER BY s.starts_at DESC,r.created_at DESC`).all(guestId);
  const upcoming = reservations.filter(item => item.status === 'confirmed' && Date.parse(item.startsAt) > Date.parse(nowValue));
  const cancelledHistory = reservations.filter(item => item.status === 'cancelled');
  const drafts = (await listWellnessDrafts(guestId)).filter(item => item.status === 'pending_review');
  return {
    upcomingBookings: upcoming.map(item => ({ ...item, type: 'confirmed_reservation' })),
    cancelledHistory: cancelledHistory.map(item => ({ ...item, type: 'cancelled_reservation' })),
    proposedDrafts: drafts.map(item => ({ draftId: item.draftId, version: item.version, stayStart: item.stayStart,
      stayEnd: item.stayEnd, status: item.status, sourceRunId: item.sourceRunId, createdAt: item.createdAt,
      active: false, itemCount: item.items.length })),
    boundary: '待审草案不属于预约，不占用名额；只有仍有效的已确认预约会进入待执行日程。'
  };
}
