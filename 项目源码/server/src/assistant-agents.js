import crypto from 'node:crypto';
import { shiftDateKey, systemBusinessClock } from './clock.js';

export const HOUSEHOLD_AGENT = Object.freeze({
  agentId: 'household.concierge',
  name: '海屿管家',
  instructionVersion: '1.1.0'
});

const stringIds = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 160 }, uniqueItems: true };
export const WELLNESS_DRAFT_COORDINATION_TASK = 'wellness_draft';
const mealTypes = new Set(['breakfast', 'lunch', 'dinner']);

const contracts = [
  {
    agentId: 'domain.physio', domain: 'physio', name: '理疗智能体', instructionVersion: '1.0.0',
    allowedTools: ['get_physio_context', 'get_therapy_knowledge'],
    knowledgeSourceIds: ['knowledge-therapy-01', 'knowledge-therapy-02'],
    inputSchema: { type: 'object', properties: { request: { type: 'string', maxLength: 4000 } }, required: ['request'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { candidateIds: stringIds }, required: ['candidateIds'], additionalProperties: false },
    instruction: '你是理疗信息整理智能体。只依据项目目录、有效约束、规则查询和理疗知识库，为海水浴、温泉或海泥项目提出候选项目 ID。你只能提交工具返回的项目 ID；不得给出医疗诊断、温度时长处方、预约确认或医护批准。最终只返回符合输出 schema 的 JSON。'
  },
  {
    agentId: 'domain.nutrition', domain: 'nutrition', name: '营养智能体', instructionVersion: '1.0.0',
    allowedTools: ['get_nutrition_context', 'get_nutrition_knowledge'],
    knowledgeSourceIds: ['knowledge-nutrition-01', 'knowledge-nutrition-02'],
    inputSchema: { type: 'object', properties: { request: { type: 'string', maxLength: 4000 }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, required: ['request', 'date'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { candidateIds: stringIds }, required: ['candidateIds'], additionalProperties: false },
    instruction: '你是营养信息整理智能体。只依据菜单食材、过敏/忌口约束、演示供货状态和营养知识库，为早餐、午餐、晚餐提出候选 ID。只能提交工具返回且适用于相应餐次的候选 ID；不要创建或修改餐单，不作治疗或营养素检测结论。最终只返回符合输出 schema 的 JSON。'
  },
  {
    agentId: 'domain.exercise', domain: 'exercise', name: '运动智能体', instructionVersion: '1.0.0',
    allowedTools: ['get_exercise_context', 'get_exercise_knowledge'],
    knowledgeSourceIds: ['knowledge-exercise-01', 'knowledge-exercise-02'],
    inputSchema: { type: 'object', properties: { request: { type: 'string', maxLength: 4000 }, date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }, required: ['request', 'date'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { candidateIds: stringIds }, required: ['candidateIds'], additionalProperties: false },
    instruction: '你是运动活动信息整理智能体。只依据项目、行动能力、既有日程、开放时段、有效规则和运动知识库提出候选项目 ID。只能提交工具返回的项目 ID；不得把演示窗口说成预约，不得改变预约或给出个体运动处方。最终只返回符合输出 schema 的 JSON。'
  },
  {
    agentId: 'domain.psychology', domain: 'psychology', name: '心理陪伴智能体', instructionVersion: '1.0.0',
    allowedTools: ['get_psychology_context', 'get_companionship_knowledge'],
    knowledgeSourceIds: ['knowledge-companionship-01', 'knowledge-companionship-02'],
    inputSchema: { type: 'object', properties: { request: { type: 'string', maxLength: 4000 } }, required: ['request'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { candidateIds: stringIds }, required: ['candidateIds'], additionalProperties: false },
    instruction: '你是心理陪伴资源整理智能体。只依据实际心情记录、待人工关注项、可播放课程和陪伴知识库提出课程资源 ID。不得作疾病诊断、推断心理状态或替代人工关注。最终只返回符合输出 schema 的 JSON。'
  }
];

export const DOMAIN_AGENT_CONTRACTS = Object.freeze(contracts.map(contract => Object.freeze(contract)));
const contractById = new Map(DOMAIN_AGENT_CONTRACTS.map(contract => [contract.agentId, contract]));

const matchers = [
  { agentId: 'domain.physio', pattern: /理疗|水疗|海水浴|温泉|海泥/u },
  { agentId: 'domain.nutrition', pattern: /餐|膳食|菜单|食谱|营养|虾|海鲜过敏|吃什么|三餐/u },
  { agentId: 'domain.exercise', pattern: /运动|游泳|活动|徒步|散步|海边|沙滩|行动受限|行动能力/u },
  { agentId: 'domain.psychology', pattern: /心情|情绪|陪伴|烦闷|冥想|孤独|焦虑|舒缓/u }
];

export function classifyDomainAgents(text, role, guestId, coordinationTask = null) {
  if (!['guest', 'staff', 'dean'].includes(role) || !guestId) return [];
  if (role === 'guest' && coordinationTask === WELLNESS_DRAFT_COORDINATION_TASK) {
    // Wellness drafts require both nutrition and exercise candidates. The
    // guest's free-text request (or a returned-plan reason) may mention
    // therapies and otherwise crowd exercise out of the generic two-agent cap.
    return [contractById.get('domain.nutrition'), contractById.get('domain.exercise')];
  }
  const value = String(text || '');
  const selected = matchers.filter(item => item.pattern.test(value)).map(item => contractById.get(item.agentId));
  // A request that explicitly spans all four domains is coordinated as one
  // complete graph. The graph budget reserves two model calls per child and
  // one for the coordinator; narrower requests keep the existing two-child cap.
  if (selected.length === contracts.length) return selected;
  return selected.slice(0, 2);
}

export function agentContract(agentId) {
  return contractById.get(agentId) || null;
}

export function publicAgentContracts() {
  return [
    { ...HOUSEHOLD_AGENT, role: 'coordinator', allowedTools: [], knowledgeSourceIds: [],
      inputSchema: { type: 'object', properties: {
        request: { type: 'string', maxLength: 4000 },
        adoptedCandidateIds: stringIds,
        adoptedCandidates: { type: 'array', maxItems: 80, items: { type: 'object', properties: {
          candidateId: { type: 'string', minLength: 1, maxLength: 160 },
          domain: { type: 'string', maxLength: 48 }, title: { type: 'string', maxLength: 240 },
          sourceIds: { type: 'array', maxItems: 40 },
          mealType: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'] },
          sourceDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          availabilitySource: { type: 'string', enum: ['activity_slots'] },
          availableSlotCount: { type: 'integer', minimum: 1 }
        }, required: ['candidateId', 'domain', 'title'], additionalProperties: false } },
        gaps: { type: 'array', maxItems: 8, items: { type: 'object', properties: {
          agentId: { type: 'string', maxLength: 96 }, domain: { type: 'string', maxLength: 48 },
          errorCode: { type: 'string', maxLength: 96 }
        }, required: ['agentId', 'domain', 'errorCode'], additionalProperties: false } },
        coordinationTask: { type: 'string', enum: [WELLNESS_DRAFT_COORDINATION_TASK] },
        sourceDates: { type: 'object', properties: {
          nutrition: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
          exercise: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
        }, additionalProperties: false }
      }, required: ['request', 'adoptedCandidateIds', 'adoptedCandidates', 'gaps'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { selectedCandidateIds: stringIds }, required: ['selectedCandidateIds'], additionalProperties: false } },
    ...DOMAIN_AGENT_CONTRACTS.map(({ instruction: _instruction, ...contract }) => contract)
  ];
}

function hasAvailableActualActivitySlot(candidate) {
  if (candidate?.details?.availabilitySource !== 'activity_slots'
    || !Array.isArray(candidate.details.windows)) return false;
  return candidate.details.windows.some(slot => slot && slot.closed !== true
    && Number.isSafeInteger(slot.availableCount) && slot.availableCount > 0);
}

function coordinatorCandidateProjection(candidate, sourceDates, task) {
  const base = { candidateId: candidate.candidateId, domain: candidate.domain,
    title: String(candidate.title || '').slice(0, 240) };
  if (task === WELLNESS_DRAFT_COORDINATION_TASK) {
    const sourceDate = sourceDates[candidate.domain] || null;
    if (candidate.domain === 'nutrition') {
      return { ...base, mealType: candidate.details?.mealType || null, sourceDate };
    }
    return { ...base, availabilitySource: 'activity_slots', sourceDate,
      availableSlotCount: candidate.details.windows.filter(slot => slot && slot.closed !== true
        && Number.isSafeInteger(slot.availableCount) && slot.availableCount > 0).length };
  }
  return { ...base, sourceIds: Array.isArray(candidate.sourceIds) ? candidate.sourceIds.slice(0, 40) : [] };
}

/**
 * Build the coordinator prompt and payload from the same allowlist so the IDs
 * named in the prompt can never drift from the IDs actually supplied.
 */
export function buildCoordinatorSelectionContract({ request, candidates = [], gaps = [], task = null, sourceDates = {} }) {
  const taskType = task === WELLNESS_DRAFT_COORDINATION_TASK ? task : null;
  const adopted = candidates.filter(candidate => candidate?.status === 'adopted'
    && typeof candidate.candidateId === 'string' && candidate.candidateId.length > 0);
  const eligible = taskType === WELLNESS_DRAFT_COORDINATION_TASK
    ? adopted.filter(candidate => {
      if (candidate.domain === 'nutrition') {
        return mealTypes.has(candidate.details?.mealType) && typeof sourceDates.nutrition === 'string';
      }
      return candidate.domain === 'exercise' && typeof sourceDates.exercise === 'string'
        && hasAvailableActualActivitySlot(candidate);
    })
    : adopted;
  const seen = new Set();
  const selectedCandidates = eligible.filter(candidate => {
    if (seen.has(candidate.candidateId)) return false;
    seen.add(candidate.candidateId);
    return true;
  });
  const adoptedCandidateIds = selectedCandidates.map(candidate => candidate.candidateId);
  const projectedCandidates = selectedCandidates.map(candidate => coordinatorCandidateProjection(candidate, sourceDates, taskType));
  const payload = {
    request: String(request || '').slice(0, 4000),
    adoptedCandidateIds,
    adoptedCandidates: projectedCandidates,
    gaps: (Array.isArray(gaps) ? gaps : []).slice(0, 8).map(gap => ({
      agentId: String(gap?.agentId || '').slice(0, 96),
      domain: String(gap?.domain || '').slice(0, 48),
      errorCode: String(gap?.errorCode || '').slice(0, 96)
    })),
    ...(taskType ? { coordinationTask: taskType,
      sourceDates: { nutrition: sourceDates.nutrition || null, exercise: sourceDates.exercise || null } } : {})
  };
  const taskInstructions = taskType === WELLNESS_DRAFT_COORDINATION_TASK
    ? `本次是 wellness_draft 草案任务。adoptedCandidates 只含营养与运动领域经确定性复核的合法源日期候选；adoptedCandidateIds 是唯一允许选择的 ID 列表。必须为列表中存在候选的每个 mealType 选择该餐次的一个营养候选，不能漏选。运动只可选择 availabilitySource 为 activity_slots 的候选；这些候选都至少有一个未关闭且有余量的真实时段。演示开放窗口和其他日期的候选不在允许列表中，不得补选。没有合法候选的餐次留空；没有合法运动候选时不选择运动。只有当两类都没有合法候选时才可返回空数组。`
    : '只能从给定 adoptedCandidateIds 中选择；被拒绝、待人工复核或缺失的领域不得作为已完成结果。普通对话即使没有要采用的候选，也可以返回空数组。';
  const systemPrompt = `你是${HOUSEHOLD_AGENT.name}协调者。agentId=${HOUSEHOLD_AGENT.agentId}\n负责对专业智能体的确定性复核后候选作最终选择。${taskInstructions}不要生成预约、餐单写入、医护批准、诊断或未提供的事实。只输出json对象，格式为 {"selectedCandidateIds":["候选ID"]}。`;
  return { task: taskType, systemPrompt, payload, allowedCandidateIds: adoptedCandidateIds,
    requiredMealTypes: taskType ? [...new Set(projectedCandidates.filter(item => item.domain === 'nutrition').map(item => item.mealType))] : [],
    requiresAvailableActivitySelection: Boolean(taskType && projectedCandidates.some(item => item.domain === 'exercise')) };
}

/** Add wellness-draft semantics without changing the generic empty-selection contract. */
export function validateCoordinatorSelectionForTask(validation, contract) {
  if (!validation?.ok || contract?.task !== WELLNESS_DRAFT_COORDINATION_TASK) return validation;
  const selected = new Set(validation.selectedCandidateIds);
  const selectedCandidates = contract.payload.adoptedCandidates.filter(item => selected.has(item.candidateId));
  const selectedMeals = selectedCandidates.filter(item => item.domain === 'nutrition').map(item => item.mealType);
  const missingMealTypes = contract.requiredMealTypes.filter(mealType => !selectedMeals.includes(mealType));
  if (missingMealTypes.length) return { ...validation, ok: false, semanticValid: false,
    errorCode: 'COORDINATOR_WELLNESS_MEAL_SELECTION_MISSING', missingMealTypes };
  if (contract.requiresAvailableActivitySelection
    && !selectedCandidates.some(item => item.domain === 'exercise')) {
    return { ...validation, ok: false, semanticValid: false,
      errorCode: 'COORDINATOR_WELLNESS_ACTIVITY_SELECTION_MISSING' };
  }
  return { ...validation, semanticValid: true };
}

function boundedDigest(value, maxBytes = 16_384) {
  const text = String(value ?? '');
  const bytes = Buffer.from(text, 'utf8');
  const sample = bytes.subarray(0, maxBytes);
  return { byteLength: Math.min(bytes.length, 65_536), truncated: bytes.length > maxBytes,
    sha256: crypto.createHash('sha256').update(sample).digest('hex') };
}

/** Store hashes and bounded structural metadata, never raw model input or output. */
export function summarizeCoordinatorSelectionEvidence({ contract, responseContent = null, validation = null, errorCode = null, finishReason = null }) {
  const payloadText = JSON.stringify(contract?.payload || {});
  const response = responseContent === null ? null : boundedDigest(responseContent);
  return {
    contractVersion: contract?.task === WELLNESS_DRAFT_COORDINATION_TASK ? 'wellness-draft-selection-v1' : 'coordinator-selection-v1',
    task: contract?.task || 'general',
    input: { ...boundedDigest(payloadText), fieldNames: Object.keys(contract?.payload || {}).slice(0, 12),
      candidateCount: Math.min(contract?.allowedCandidateIds?.length || 0, 80),
      allowedCandidateIds: (contract?.allowedCandidateIds || []).slice(0, 80),
      allowedCandidateIdsTruncated: (contract?.allowedCandidateIds || []).length > 80 },
    response,
    validation: validation ? { schemaValid: validation.schemaValid ?? null,
      allowlistValid: validation.allowlistValid ?? null, semanticValid: validation.semanticValid ?? null,
      errorCode: validation.errorCode || errorCode || null,
      missingMealTypes: (validation.missingMealTypes || []).slice(0, 3) } : null,
    finishReason: typeof finishReason === 'string' ? finishReason.slice(0, 48) : null,
    errorCode: typeof errorCode === 'string' ? errorCode.slice(0, 96) : null
  };
}

export function parseStructuredAgentOutput(content, { allowedIds, maxItems = 30 } = {}) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 16_384) return null;
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Array.isArray(value.candidateIds)
    || value.candidateIds.length > maxItems
    || value.candidateIds.some(id => typeof id !== 'string' || !id || id.length > 160)) return null;
  const unique = [...new Set(value.candidateIds)];
  if (unique.length !== value.candidateIds.length) return null;
  const allowed = new Set(allowedIds || []);
  if (unique.some(id => !allowed.has(id))) return null;
  return { candidateIds: unique };
}

export function parseCoordinatorSelection(content, allowedIds) {
  const result = validateCoordinatorSelection(content, allowedIds);
  return result.ok ? result.selectedCandidateIds : null;
}

export function validateCoordinatorSelection(content, allowedIds) {
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, errorCode: 'COORDINATOR_OUTPUT_EMPTY', schemaValid: false, allowlistValid: false };
  }
  if (Buffer.byteLength(content, 'utf8') > 16_384) {
    return { ok: false, errorCode: 'COORDINATOR_OUTPUT_TOO_LARGE', schemaValid: false, allowlistValid: false };
  }
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(trimmed); }
  catch { return { ok: false, errorCode: 'COORDINATOR_OUTPUT_INVALID_JSON', schemaValid: false, allowlistValid: false }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Array.isArray(value.selectedCandidateIds)
    || value.selectedCandidateIds.some(id => typeof id !== 'string' || !id || id.length > 160)
    || new Set(value.selectedCandidateIds).size !== value.selectedCandidateIds.length) {
    return { ok: false, errorCode: 'COORDINATOR_OUTPUT_SCHEMA_INVALID', schemaValid: false, allowlistValid: false };
  }
  const selected = value.selectedCandidateIds;
  const allowed = new Set(allowedIds);
  if (!selected.every(id => allowed.has(id))) {
    return { ok: false, errorCode: 'COORDINATOR_CANDIDATE_NOT_ALLOWED', schemaValid: true, allowlistValid: false };
  }
  return { ok: true, selectedCandidateIds: selected, schemaValid: true, allowlistValid: true };
}

export function nextBusinessDate(nowIso) {
  const source = nowIso ? new Date(nowIso) : new Date();
  return shiftDateKey(systemBusinessClock.dateKey(source), 1);
}
