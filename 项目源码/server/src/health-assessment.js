import crypto from 'node:crypto';
import { db, guestProfile, json, log, now, transaction } from './db.js';
import { AppError } from './errors.js';
import { HEALTH_PROFILE_FIELDS, emptyHealthProfile, normalizeHealthProfile } from './health-profile.js';
import { requestChatCompletion, ModelRequestError } from './model-adapter.js';

const guestLock = () => db.driver === 'mysql' ? ' FOR UPDATE' : '';
const listFields = new Set(['chronic', 'allergies', 'dietaryRestrictions', 'audienceTags']);
const textFields = new Set(['sleep', 'skin']);
const extractionFields = new Set(['chronic', 'allergies', 'dietaryRestrictions', 'sleep', 'skin', 'mobility']);
const vagueMobility = /腿不太方便|走路不太方便|行动不太方便|行动不便|走路不稳/u;
const concreteMobility = /拐杖|助行器|轮椅|搀扶|搀着|扶着|独立行走|独立走路|不用协助|不需要协助/u;

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function decodeExtraction(row) {
  if (!row) return null;
  return {
    id: row.id,
    guestId: row.guest_id,
    sessionId: row.session_id || null,
    source: { type: 'guest_utterance', utterance: row.source_text },
    candidates: json(row.candidates_json, []),
    clarificationQuestion: row.clarification_question || null,
    executionMode: row.execution_mode,
    model: row.model_name || null,
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    estimatedCostUsd: Number(row.estimated_cost_usd || 0),
    status: row.status,
    decisions: json(row.decisions_json, null),
    healthIntakeId: row.health_intake_id === null || row.health_intake_id === undefined
      ? null : Number(row.health_intake_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assessmentResult(answers, version, updatedAt = null, sourceSessionId = null) {
  const profile = normalizeHealthProfile(answers || {});
  const missing = HEALTH_PROFILE_FIELDS.filter(field => profile[field.key].status === 'unanswered');
  const completed = HEALTH_PROFILE_FIELDS.length - missing.length;
  return {
    profile,
    progress: { completed, total: HEALTH_PROFILE_FIELDS.length, percent: Math.round(100 * completed / HEALTH_PROFILE_FIELDS.length) },
    missing: missing.map(field => ({ key: field.key, label: field.label })),
    nextQuestion: missing[0] ? { key: missing[0].key, label: missing[0].label } : null,
    status: completed === 0 ? 'not_started' : missing.length ? 'in_progress' : 'completed',
    version: Number(version || 0), updatedAt, sourceSessionId
  };
}

function assessmentSeed(profile) {
  const answers = normalizeHealthProfile(profile?.health_profile || {});
  for (const field of ['chronic', 'allergies']) {
    if (answers[field].status !== 'unanswered') continue;
    const legacy = Array.isArray(profile?.[field]) ? profile[field].filter(value => typeof value === 'string' && value.trim()) : [];
    if (legacy.length) answers[field] = { status: 'reported', items: [...new Set(legacy.map(value => value.trim()))] };
  }
  if (answers.mobility.status === 'unanswered' && typeof profile?.mobility === 'string' && profile.mobility.trim()) {
    const value = profile.mobility.trim();
    if (/可独立|能够独立|能独立|无需协助|不需要协助/u.test(value)) answers.mobility = { status: 'independent', details: value };
    else if (/需|需要|协助|轮椅|拐杖|助行器|搀扶/u.test(value)) answers.mobility = { status: 'assistance', details: value };
    else answers.mobility = { status: 'unknown', details: '' };
  }
  return answers;
}

export async function getHealthAssessmentProgress(guestId) {
  const row = await db.prepare(`SELECT answers_json,version,updated_at,source_session_id
    FROM health_assessment_progress WHERE guest_id=?`).get(guestId);
  const profile = row ? json(row.answers_json, {}) : assessmentSeed(await guestProfile(guestId));
  return assessmentResult(profile, row?.version || 0,
    row?.updated_at || null, row?.source_session_id || null);
}

function validateAssessmentAnswer(body) {
  const allowedBody = new Set(['field', 'answer', 'baseVersion', 'sessionId']);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !allowedBody.has(key))) {
    throw new AppError(400, 'HEALTH_ASSESSMENT_INPUT_INVALID', '回答内容包含不允许字段');
  }
  const field = HEALTH_PROFILE_FIELDS.find(item => item.key === body.field);
  if (!field) throw new AppError(400, 'HEALTH_ASSESSMENT_FIELD_INVALID', '健康初评项目无效');
  if (body.baseVersion !== undefined && (!Number.isSafeInteger(body.baseVersion) || body.baseVersion < 0)) {
    throw new AppError(400, 'HEALTH_ASSESSMENT_VERSION_INVALID', '初评版本号无效');
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== 'string') {
    throw new AppError(400, 'HEALTH_ASSESSMENT_SESSION_INVALID', '会话编号无效');
  }
  let answer;
  try { answer = normalizeHealthProfile({ [field.key]: body.answer })[field.key]; }
  catch (error) { throw new AppError(400, error.code || 'HEALTH_ASSESSMENT_ANSWER_INVALID', error.message); }
  if (answer.status === 'unanswered') throw new AppError(400, 'HEALTH_ASSESSMENT_ANSWER_REQUIRED', '请选择回答、无、不确定或暂不回答');
  return { field, answer, sessionId: typeof body.sessionId === 'string' ? body.sessionId : null };
}

async function validateGuestSession(guestId, sessionId) {
  if (!sessionId) return null;
  const row = await db.prepare(`SELECT id,user_id,assistant_role,related_guest_id,status FROM assistant_sessions WHERE id=?`)
    .get(sessionId);
  if (!row || row.user_id !== guestId || row.related_guest_id !== guestId || row.assistant_role !== 'guest' || row.status !== 'active') {
    throw new AppError(404, 'ASSISTANT_SESSION_NOT_FOUND', '助手会话不存在');
  }
  return row.id;
}

export async function saveHealthAssessmentAnswer(guestId, body) {
  const { field, answer, sessionId } = validateAssessmentAnswer(body);
  const linkedSessionId = await validateGuestSession(guestId, sessionId);
  return await transaction(async () => {
    await db.prepare(`SELECT user_id FROM guest_profiles WHERE user_id=?${guestLock()}`).get(guestId);
    const existing = await db.prepare('SELECT answers_json,version,created_at,updated_at,source_session_id FROM health_assessment_progress WHERE guest_id=?')
      .get(guestId);
    const version = Number(existing?.version || 0);
    if (body.baseVersion !== undefined && body.baseVersion !== version) {
      throw new AppError(409, 'HEALTH_ASSESSMENT_STALE_VERSION', '初评已在其他页面更新，请刷新后继续', { currentVersion: version });
    }
    const profile = existing ? normalizeHealthProfile(json(existing.answers_json, {}))
      : assessmentSeed(await guestProfile(guestId));
    profile[field.key] = answer;
    const timestamp = now();
    const nextVersion = version + 1;
    if (existing) {
      await db.prepare(`UPDATE health_assessment_progress SET answers_json=?,source_session_id=COALESCE(?,source_session_id),version=?,updated_at=? WHERE guest_id=?`)
        .run(JSON.stringify(profile), linkedSessionId, nextVersion, timestamp, guestId);
    } else {
      await db.prepare(`INSERT INTO health_assessment_progress(guest_id,answers_json,source_session_id,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?)`).run(guestId, JSON.stringify(profile), linkedSessionId, nextVersion, timestamp, timestamp);
    }
    await log(guestId, 'health_assessment.answer', 'health_assessment', guestId, `初评回答字段 ${field.key}`);
    return assessmentResult(profile, nextVersion, timestamp, linkedSessionId || existing?.source_session_id || null);
  });
}

function parseExtractionResponse(content, utterance) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 16_384) return null;
  let value;
  try { value = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['candidates', 'clarificationQuestion'].includes(key))
    || !Array.isArray(value.candidates) || value.candidates.length > 8) return null;
  const clarificationQuestion = value.clarificationQuestion === null || value.clarificationQuestion === undefined
    ? null : (typeof value.clarificationQuestion === 'string' && value.clarificationQuestion.length <= 500
      ? value.clarificationQuestion.trim() : null);
  if (value.clarificationQuestion !== null && value.clarificationQuestion !== undefined && clarificationQuestion === null) return null;
  const seen = new Set();
  const candidates = [];
  for (const row of value.candidates) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).some(key => !['field', 'status', 'value', 'evidenceText'].includes(key))
      || !extractionFields.has(row.field) || typeof row.status !== 'string'
      || typeof row.value !== 'string' || typeof row.evidenceText !== 'string') return null;
    const field = row.field;
    const statusList = listFields.has(field) ? ['reported', 'none', 'unknown']
      : field === 'mobility' ? ['assistance', 'independent', 'unknown'] : ['reported', 'unknown'];
    const normalizedValue = row.value.trim();
    const evidenceText = row.evidenceText.trim();
    if (!statusList.includes(row.status) || evidenceText.length < 1 || evidenceText.length > 500
      || !utterance.includes(evidenceText) || (row.status === 'reported' && !normalizedValue)
      || (row.status !== 'reported' && field !== 'mobility' && normalizedValue)) return null;
    if (normalizedValue && !evidenceText.includes(normalizedValue)) return null;
    const key = `${field}\u0000${row.status}\u0000${normalizedValue.toLocaleLowerCase()}`;
    if (seen.has(key)) return null;
    seen.add(key);
    candidates.push({ field, status: row.status, value: normalizedValue, evidenceText });
  }
  if (!candidates.length && !clarificationQuestion) return null;
  return { candidates, clarificationQuestion };
}

function vagueMobilityClarification(utterance) {
  return vagueMobility.test(utterance) && !concreteMobility.test(utterance)
    ? '平时走路需要拐杖、助行器或他人搀扶吗？也可以说明是否能独立行走。'
    : null;
}

async function extractionSession(guestId, requestedSessionId, utterance) {
  if (requestedSessionId) {
    const validated = await validateGuestSession(guestId, requestedSessionId);
    await db.prepare('INSERT INTO assistant_messages(session_id,user_id,role,content,created_at) VALUES(?,?,?,?,?)')
      .run(validated, guestId, 'user', utterance, now());
    await db.prepare('UPDATE assistant_sessions SET last_message_at=? WHERE id=?').run(now(), validated);
    return validated;
  }
  const stamp = now();
  const sessionId = `as_${crypto.randomUUID()}`;
  const expiry = new Date(Date.parse(stamp) + 8 * 60 * 60 * 1000).toISOString();
  await transaction(async () => {
    await db.prepare(`INSERT INTO assistant_sessions(id,user_id,assistant_role,related_guest_id,status,started_at,last_message_at,expires_at)
      VALUES(?,?,'guest',?,'active',?,?,?)`).run(sessionId, guestId, guestId, stamp, stamp, expiry);
    await db.prepare('INSERT INTO assistant_messages(session_id,user_id,role,content,created_at) VALUES(?,?,?,?,?)')
      .run(sessionId, guestId, 'user', utterance, stamp);
  });
  return sessionId;
}

function buildExtractionPrompt(utterance) {
  const fixtureMarker = process.env.NODE_ENV === 'test' && process.env.Q21_ACCEPTANCE_HOOKS === '1'
    ? 'Q21:EXTRACT ' : '';
  return [
    '从客人原句中只提取本人明确表达的健康自述，不诊断、不补全未说内容。',
    '只输出 JSON 对象：{"candidates":[{"field":"allergies|chronic|dietaryRestrictions|sleep|skin|mobility","status":"reported|none|unknown|assistance|independent","value":"原句中可核对的短内容","evidenceText":"逐字摘录原句"}],"clarificationQuestion":null}',
    '每个候选都必须带原句中的逐字 evidenceText；value 必须出现在 evidenceText 中。对行动能力含糊表述（如“腿不太方便”）不要猜测，候选列表留空，询问是否需要拐杖、助行器或他人搀扶。',
    '仅在本人明确表示“没有/无”时使用 none；没有提及的字段不要输出。',
    `${fixtureMarker}客人原句：${utterance}`
  ].join('\n');
}

function estimateExtractionCost(inputTokens, outputTokens, modelName) {
  const model = String(modelName || '').toLowerCase();
  const rates = model.includes('deepseek-v4-pro') ? { input: 1.32, output: 3.96 }
    : model.includes('deepseek-flash') ? { input: 0.30, output: 1.20 } : { input: 0.30, output: 1.20 };
  return inputTokens * rates.input / 1_000_000 + outputTokens * rates.output / 1_000_000;
}

export async function createHealthExtractionDraft({ guestId, utterance, sessionId: requestedSessionId = null }) {
  if (typeof utterance !== 'string' || !utterance.trim() || utterance.trim().length > 1200) {
    throw new AppError(400, 'HEALTH_EXTRACTION_TEXT_INVALID', '请填写不超过 1200 字的本人自述');
  }
  const sourceText = utterance.trim();
  const requestFingerprint = fingerprint(sourceText);
  const duplicate = await db.prepare('SELECT * FROM health_extraction_drafts WHERE guest_id=? AND request_fingerprint=?')
    .get(guestId, requestFingerprint);
  if (duplicate) return { ...decodeExtraction(duplicate), deduplicated: true };

  let sessionId = requestedSessionId;
  if (sessionId) await validateGuestSession(guestId, sessionId);
  const deterministicQuestion = vagueMobilityClarification(sourceText);
  let extraction = { candidates: [], clarificationQuestion: deterministicQuestion };
  let executionMode = deterministicQuestion ? 'deterministic_clarification' : 'live';
  let modelName = process.env.LLM_MODEL || null;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedCostUsd = 0;

  if (!deterministicQuestion) {
    const prompt = buildExtractionPrompt(sourceText);
    try {
      const response = await requestChatCompletion({
        messages: [{ role: 'system', content: '你是健康自述结构化提取器。遵守用户原话边界，不输出诊断或内部推理。' },
          { role: 'user', content: prompt }],
        timeoutMs: 15_000,
        maxTokens: 512,
        responseFormat: { type: 'json_object' },
        thinkingMode: 'disabled'
      });
      if (response.finishReason === 'length') throw new AppError(502, 'HEALTH_EXTRACTION_TRUNCATED', '结构化提取结果不完整，请稍后重新描述');
      extraction = parseExtractionResponse(response.message.content, sourceText);
      if (!extraction) throw new AppError(502, 'HEALTH_EXTRACTION_SCHEMA_INVALID', '结构化提取结果未通过字段与原文校验');
      modelName = response.model || modelName;
      inputTokens = Number(response.usage.inputTokens || Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4));
      outputTokens = Number(response.usage.outputTokens || Math.ceil(Buffer.byteLength(response.message.content || '', 'utf8') / 4));
      estimatedCostUsd = estimateExtractionCost(inputTokens, outputTokens, modelName);
      if (inputTokens + outputTokens > 8_192 || estimatedCostUsd > 0.10) {
        throw new AppError(502, 'HEALTH_EXTRACTION_BUDGET_EXCEEDED', '本次结构化提取超过单次预算，未保存候选');
      }
      executionMode = process.env.ASSISTANT_MODEL_SOURCE === 'recorded_fixture' ? 'recorded_fixture' : 'live';
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = error instanceof ModelRequestError ? error.code : 'HEALTH_EXTRACTION_FAILED';
      const status = code === 'MODEL_NOT_CONFIGURED' ? 503 : 502;
      throw new AppError(status, code, code === 'MODEL_NOT_CONFIGURED' ? '当前没有可用的结构化提取服务' : '结构化提取暂时失败，请保留原文后重试');
    }
  }

  if (!sessionId) sessionId = await extractionSession(guestId, null, sourceText);
  const extractionId = `hex_${crypto.randomUUID()}`;
  const candidates = extraction.candidates.map((candidate, index) => ({
    ...candidate,
    candidateId: `hc_${fingerprint(`${extractionId}\u0000${index}\u0000${candidate.field}\u0000${candidate.value}`).slice(0, 20)}`,
    source: { type: 'guest_utterance', id: extractionId, sessionId, excerpt: candidate.evidenceText }
  }));
  const stamp = now();
  try {
    await db.prepare(`INSERT INTO health_extraction_drafts
      (id,guest_id,session_id,request_fingerprint,source_text,candidates_json,clarification_question,execution_mode,model_name,
       input_tokens,output_tokens,estimated_cost_usd,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'pending_confirmation',?,?)`).run(
      extractionId, guestId, sessionId, requestFingerprint, sourceText, JSON.stringify(candidates),
      extraction.clarificationQuestion, executionMode, modelName, inputTokens, outputTokens, estimatedCostUsd, stamp, stamp
    );
  } catch (error) {
    const existing = await db.prepare('SELECT * FROM health_extraction_drafts WHERE guest_id=? AND request_fingerprint=?')
      .get(guestId, requestFingerprint);
    if (!existing) throw error;
    return { ...decodeExtraction(existing), deduplicated: true };
  }
  const saved = await db.prepare('SELECT * FROM health_extraction_drafts WHERE id=? AND guest_id=?').get(extractionId, guestId);
  return { ...decodeExtraction(saved), deduplicated: false };
}

export async function listHealthExtractionDrafts(guestId, limit = 20) {
  const rows = await db.prepare(`SELECT * FROM health_extraction_drafts WHERE guest_id=? ORDER BY created_at DESC,id DESC LIMIT ?`)
    .all(guestId, Math.max(1, Math.min(50, Number(limit) || 20)));
  return rows.map(decodeExtraction);
}

function profileForConfirmedCandidates(candidates, decisions) {
  const profile = emptyHealthProfile();
  for (const candidate of candidates) {
    if (decisions[candidate.candidateId] !== 'confirm') continue;
    if (listFields.has(candidate.field)) {
      if (candidate.status === 'reported') {
        const existing = profile[candidate.field].status === 'reported' ? profile[candidate.field].items : [];
        profile[candidate.field] = { status: 'reported', items: [...new Set([...existing, candidate.value])] };
      } else if (profile[candidate.field].status !== 'reported') {
        profile[candidate.field] = { status: candidate.status, items: [] };
      }
    } else if (candidate.field === 'mobility') {
      profile.mobility = { status: candidate.status,
        details: candidate.status === 'unknown' ? '' : candidate.value || candidate.evidenceText };
    } else if (textFields.has(candidate.field)) {
      profile[candidate.field] = candidate.status === 'reported'
        ? { status: 'reported', details: candidate.value }
        : { status: candidate.status, details: '' };
    }
  }
  return normalizeHealthProfile(profile);
}

function normalizedDecisions(candidates, input) {
  if (!Array.isArray(input) || input.length !== candidates.length) {
    throw new AppError(400, 'HEALTH_EXTRACTION_DECISIONS_REQUIRED', '请逐项确认或拒绝全部提取候选');
  }
  const byId = new Map(candidates.map(candidate => [candidate.candidateId, candidate]));
  const result = {};
  for (const decision of input) {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)
      || Object.keys(decision).some(key => !['candidateId', 'decision'].includes(key))
      || !byId.has(decision.candidateId) || !['confirm', 'reject'].includes(decision.decision)
      || result[decision.candidateId]) {
      throw new AppError(400, 'HEALTH_EXTRACTION_DECISION_INVALID', '候选确认内容无效');
    }
    result[decision.candidateId] = decision.decision;
  }
  if (Object.keys(result).length !== candidates.length) {
    throw new AppError(400, 'HEALTH_EXTRACTION_DECISIONS_REQUIRED', '请逐项确认或拒绝全部提取候选');
  }
  return result;
}

function publicIntake(row) {
  return row ? { id: Number(row.id), guestId: row.guestId ?? row.guest_id,
    sessionId: row.sessionId ?? row.session_id ?? null, content: row.content || '', source: row.source || 'assistant',
    status: row.status || 'pending', revision: Number(row.revision || 0), candidate: json(row.structuredJson ?? row.structured_json, {}) } : null;
}

export async function confirmHealthExtraction({ guestId, extractionId, decisions: input }) {
  if (typeof extractionId !== 'string' || !/^hex_[0-9a-f-]{36}$/.test(extractionId)) {
    throw new AppError(404, 'HEALTH_EXTRACTION_NOT_FOUND', '健康自述提取记录不存在');
  }
  const initial = await db.prepare('SELECT * FROM health_extraction_drafts WHERE id=? AND guest_id=?').get(extractionId, guestId);
  if (!initial) throw new AppError(404, 'HEALTH_EXTRACTION_NOT_FOUND', '健康自述提取记录不存在');
  const candidates = json(initial.candidates_json, []);
  if (!candidates.length) throw new AppError(409, 'HEALTH_EXTRACTION_NEEDS_CLARIFICATION', '请先回答行动能力追问，再提交可确认的自述');
  const decisions = normalizedDecisions(candidates, input);
  const decisionsJson = JSON.stringify(decisions);
  if (initial.status !== 'pending_confirmation') {
    if (JSON.stringify(json(initial.decisions_json, {})) !== JSON.stringify(decisions)) {
      throw new AppError(409, 'HEALTH_EXTRACTION_ALREADY_DECIDED', '这组候选已完成确认，不能更改原处理结果');
    }
    const intake = initial.health_intake_id ? await db.prepare(`SELECT id,guest_id AS guestId,session_id AS sessionId,content,source,status,revision,structured_json AS structuredJson
      FROM health_intakes WHERE id=? AND guest_id=?`).get(initial.health_intake_id, guestId) : null;
    return { extraction: decodeExtraction(initial), intake: publicIntake(intake), deduplicated: true };
  }

  const candidateProfile = profileForConfirmedCandidates(candidates, decisions);
  const confirmedCount = Object.values(decisions).filter(item => item === 'confirm').length;
  const outcomeStatus = confirmedCount === 0 ? 'rejected'
    : confirmedCount === candidates.length ? 'confirmed' : 'partially_confirmed';
  let result;
  await transaction(async () => {
    await db.prepare(`SELECT user_id FROM guest_profiles WHERE user_id=?${guestLock()}`).get(guestId);
    const row = await db.prepare('SELECT * FROM health_extraction_drafts WHERE id=? AND guest_id=?').get(extractionId, guestId);
    if (!row) throw new AppError(404, 'HEALTH_EXTRACTION_NOT_FOUND', '健康自述提取记录不存在');
    if (row.status !== 'pending_confirmation') {
      if (JSON.stringify(json(row.decisions_json, {})) !== decisionsJson) {
        throw new AppError(409, 'HEALTH_EXTRACTION_ALREADY_DECIDED', '这组候选已完成确认，不能更改原处理结果');
      }
      result = { intakeId: row.health_intake_id, deduplicated: true };
      return;
    }
    const profile = await guestProfile(guestId);
    if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
    let intakeId = null;
    if (confirmedCount) {
      const baseProfileVersion = Number(profile.health_profile_version || 0);
      const revisions = await db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM health_intakes WHERE guest_id=?').get(guestId);
      const revision = Number(revisions?.revision || 0) + 1;
      const savedProfile = normalizeHealthProfile(profile.health_profile);
      const intakeFingerprint = fingerprint(`stage21:${extractionId}:${decisionsJson}`);
      const inserted = await db.prepare(`INSERT INTO health_intakes
        (guest_id,session_id,content,source,created_at,structured_json,risk_level,submitted_by,base_profile_version,revision,
         fingerprint,before_json,after_json,status)
        VALUES(?,?,?,'assistant',?,?,?,?,?,?,?,?,?,'pending')`).run(
        guestId, row.session_id, row.source_text, now(), JSON.stringify(candidateProfile), 'attention', guestId,
        baseProfileVersion, revision, intakeFingerprint, JSON.stringify(savedProfile), JSON.stringify(candidateProfile)
      );
      intakeId = Number(inserted.lastInsertRowid);
      await log(guestId, 'health_intake.extraction_confirm', 'health_intake', String(intakeId), '客人确认结构化对话自述；等待负责医护核实');
    }
    const updatedCandidates = candidates.map(candidate => ({ ...candidate,
      decision: decisions[candidate.candidateId],
      reviewStatus: decisions[candidate.candidateId] === 'confirm' ? 'pending_verification' : 'rejected_by_guest'
    }));
    await db.prepare(`UPDATE health_extraction_drafts SET candidates_json=?,status=?,decisions_json=?,health_intake_id=?,updated_at=? WHERE id=? AND guest_id=?`)
      .run(JSON.stringify(updatedCandidates), outcomeStatus, decisionsJson, intakeId, now(), extractionId, guestId);
    result = { intakeId, deduplicated: false };
  });
  const savedExtraction = await db.prepare('SELECT * FROM health_extraction_drafts WHERE id=? AND guest_id=?').get(extractionId, guestId);
  const intakeRow = result.intakeId ? await db.prepare(`SELECT id,guest_id AS guestId,session_id AS sessionId,content,source,status,revision,structured_json AS structuredJson
    FROM health_intakes WHERE id=? AND guest_id=?`).get(result.intakeId, guestId) : null;
  return { extraction: decodeExtraction(savedExtraction), intake: publicIntake(intakeRow), deduplicated: result.deduplicated };
}
