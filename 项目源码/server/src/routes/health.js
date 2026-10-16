// G43：健康与心情域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { authorizeGuestAccess } from '../authorization.js';
import { systemBusinessClock } from '../clock.js';
import { db, guestProfile, id, isUniqueViolation, json, log, now, transaction } from '../db.js';
import { AppError } from '../errors.js';
import { confirmHealthExtraction, createHealthExtractionDraft, getHealthAssessmentProgress, listHealthExtractionDrafts, saveHealthAssessmentAnswer } from '../health-assessment.js';
import { createHealthRecord, getHealthSummary, getHealthTrend, listHealthRecords, retractHealthRecord, validateHealthMetricInput } from '../health-metrics.js';
import { effectiveHealthConstraints, mergeVerifiedHealthProfile, normalizeHealthProfile } from '../health-profile.js';
import { createMoodRecord, evaluateMoodFollowups, getMoodSummary, getMoodTrend, getTodayMood, listMoodFocusItems, listMoodRecords, recordMoodResourcePlay, updateMoodRecord, validateMoodInput } from '../mood.js';
import { capabilitiesFor } from '../staffing.js';
import { createNotificationOnce, syncCareSignals } from '../wellness-notifications.js';
import { auth, authorizeQueryGuest, clinicianOnly, healthIntakeFingerprint, healthProfileState, normalizeIntake, queryString, requireGuestRole, routeHandler, staffOnly } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/me/health', auth, async (req, res) => {
  const guest = await authorizeQueryGuest(req);
  res.json(await listHealthRecords(guest.id, { limit: 100 }));
});
routes.get('/api/me/health-records', auth, async (req, res) => {
  const guest = await authorizeQueryGuest(req);
  res.json(await listHealthRecords(guest.id, { includeRetracted: true, limit: 200 }));
});
routes.post('/api/me/health-records', auth, async (req, res) => {
  requireGuestRole(req.user);
  const input = validateHealthMetricInput(req.body, req.user, systemBusinessClock);
  const record = await transaction(() => createHealthRecord(input));
  res.status(201).json(record);
});
routes.delete('/api/me/health-records/:id', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await retractHealthRecord({
    guestId: req.user.id, actorId: req.user.id, recordId: req.params.id,
    reason: req.body?.reason, clock: systemBusinessClock
  }));
});
routes.get('/api/me/health-trends', auth, async (req, res) => {
  const guest = await authorizeQueryGuest(req);
  const metric = queryString(req.query.metric);
  const days = Number(req.query.days);
  res.json(await getHealthTrend(guest.id, metric, days, systemBusinessClock));
});
routes.get('/api/me/health-summary', auth, async (req, res) => {
  const guest = await authorizeQueryGuest(req);
  const metric = queryString(req.query.metric);
  const days = Number(req.query.days);
  res.json(await getHealthSummary(guest.id, metric, days, systemBusinessClock));
});
routes.get('/api/me/moods', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await listMoodRecords(req.user.id));
});
routes.post('/api/me/moods', auth, async (req, res) => {
  requireGuestRole(req.user);
  const input = validateMoodInput(req.body);
  let record;
  try {
    record = await transaction(() => createMoodRecord({ guestId: req.user.id, actorId: req.user.id, ...input }));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await getTodayMood(req.user.id);
    throw new AppError(409, 'MOOD_ALREADY_RECORDED', '今天已经记录过心情，请打开今天的记录并明确修改。', {
      recordId: existing?.id ?? null, businessDate: existing?.businessDate ?? null
    });
  }
  await evaluateMoodFollowups(req.user.id);
  await syncCareSignals(req.user.id);
  res.status(201).json(record);
});
routes.put('/api/me/moods/:id', auth, async (req, res) => {
  requireGuestRole(req.user);
  if (!/^\d+$/.test(req.params.id)) throw new AppError(400, 'MOOD_RECORD_ID_INVALID', '心情记录编号格式不正确');
  const input = validateMoodInput(req.body);
  const record = await transaction(() => updateMoodRecord({
    guestId: req.user.id, actorId: req.user.id, recordId: Number(req.params.id), ...input
  }));
  await evaluateMoodFollowups(req.user.id);
  await syncCareSignals(req.user.id);
  res.json(record);
});
routes.get('/api/me/mood-trends', auth, async (req, res) => {
  requireGuestRole(req.user);
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  res.json(await getMoodTrend(req.user.id, days, systemBusinessClock));
});
routes.get('/api/me/mood-focus-items', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await listMoodFocusItems(req.user.id));
});
routes.post('/api/me/mood-resources/:resourceId/usage', auth, async (req, res) => {
  requireGuestRole(req.user);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => key !== 'eventId');
  if (unknown.length) throw new AppError(400, 'MOOD_RESOURCE_EVENT_INVALID', '播放事件包含不允许的字段', { fields: unknown });
  res.status(201).json(await recordMoodResourcePlay({ guestId: req.user.id, resourceId: req.params.resourceId, eventId: body.eventId }));
});
routes.get('/api/me/mood-summary', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await getMoodSummary(req.user.id, systemBusinessClock));
});
routes.get('/api/staff/guests/:guestId/mood-summary', auth, staffOnly, async (req, res) => {
  const guest = await authorizeGuestAccess(req.user, req.params.guestId);
  res.json(await getMoodSummary(guest.id, systemBusinessClock));
});
routes.get('/api/me/health-profile', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await healthProfileState(req.user.id));
});
routes.post('/api/me/health-intakes', auth, async (req, res) => {
  requireGuestRole(req.user);
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'HEALTH_PROFILE_INVALID_BODY', '健康自述请求体必须是对象');
  }
  const unknown = Object.keys(body).filter(key => !['profile', 'baseProfileVersion'].includes(key));
  if (unknown.length) {
    throw new AppError(400, 'HEALTH_PROFILE_FIELD_NOT_ALLOWED', '健康自述包含未允许字段', { fields: unknown });
  }
  if (!Number.isSafeInteger(body.baseProfileVersion) || body.baseProfileVersion < 0) {
    throw new AppError(400, 'HEALTH_PROFILE_VERSION_REQUIRED', '请提交当前正式档案版本号');
  }
  const candidate = normalizeHealthProfile(body.profile);
  if (!Object.values(candidate).some(field => field.status !== 'unanswered')) {
    throw new AppError(400, 'HEALTH_PROFILE_EMPTY', '请至少回答一个健康自述项目');
  }
  const fingerprint = healthIntakeFingerprint(candidate, body.baseProfileVersion);
  const submittedAt = now();
  const result = await transaction(async () => {
    // This no-op update takes the guest profile row lock on MySQL and serializes
    // revision allocation with profile confirmations.
    await db.prepare('UPDATE guest_profiles SET health_profile_version=health_profile_version WHERE user_id=?').run(req.user.id);
    const profile = await guestProfile(req.user.id);
    if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');

    const duplicate = await db.prepare(`SELECT id FROM health_intakes
      WHERE guest_id=? AND submitted_by=? AND fingerprint=?`).get(req.user.id, req.user.id, fingerprint);
    if (duplicate) {
      const row = await db.prepare(`SELECT h.id,h.guest_id AS guestId,h.content,h.source,h.session_id AS sessionId,
          h.structured_json AS structuredJson,h.status,h.revision,h.base_profile_version AS baseProfileVersion,
          h.submitted_by AS submittedBy,u.name AS submitterName,h.created_at AS submittedAt,
          h.before_json AS beforeJson,h.after_json AS afterJson,
          h.verified_before_json AS verifiedBeforeJson,h.verified_after_json AS verifiedAfterJson,
          h.reviewed_by AS reviewedBy,r.name AS reviewerName,h.reviewed_at AS reviewedAt,h.review_note AS reviewNote
        FROM health_intakes h LEFT JOIN users u ON u.id=h.submitted_by LEFT JOIN users r ON r.id=h.reviewed_by
        WHERE h.id=?`).get(duplicate.id);
      return { intake: normalizeIntake(row), deduplicated: true };
    }
    const currentVersion = Number(profile.health_profile_version || 0);
    if (currentVersion !== body.baseProfileVersion) {
      throw new AppError(409, 'HEALTH_PROFILE_STALE_VERSION', '正式档案已更新，请刷新后重新提交', {
        currentProfileVersion: currentVersion
      });
    }
    const revisionRow = await db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM health_intakes WHERE guest_id=?').get(req.user.id);
    const revision = Number(revisionRow?.revision || 0) + 1;
    const content = `客人提交结构化健康自述（第 ${revision} 版）`;
    const inserted = await db.prepare(`INSERT INTO health_intakes
      (guest_id,session_id,content,source,created_at,structured_json,risk_level,submitted_by,
       base_profile_version,revision,fingerprint,before_json,after_json,status)
      VALUES(?,NULL,?,'form',?,?,'normal',?,?,?,?,?,?,'pending')`).run(
      req.user.id,
      content,
      submittedAt,
      JSON.stringify(candidate),
      req.user.id,
      body.baseProfileVersion,
      revision,
      fingerprint,
      JSON.stringify(normalizeHealthProfile(profile.health_profile)),
      JSON.stringify(candidate)
    );
    const row = await db.prepare(`SELECT h.id,h.guest_id AS guestId,h.content,h.source,h.session_id AS sessionId,
        h.structured_json AS structuredJson,h.status,h.revision,h.base_profile_version AS baseProfileVersion,
        h.submitted_by AS submittedBy,u.name AS submitterName,h.created_at AS submittedAt,
        h.before_json AS beforeJson,h.after_json AS afterJson,
        h.verified_before_json AS verifiedBeforeJson,h.verified_after_json AS verifiedAfterJson,
        h.reviewed_by AS reviewedBy,r.name AS reviewerName,h.reviewed_at AS reviewedAt,h.review_note AS reviewNote
      FROM health_intakes h LEFT JOIN users u ON u.id=h.submitted_by LEFT JOIN users r ON r.id=h.reviewed_by
      WHERE h.id=?`).get(inserted.lastInsertRowid);
    await log(req.user.id, 'health_intake.submit', 'health_intake', String(inserted.lastInsertRowid), `提交结构化自述第 ${revision} 版`);
    return { intake: normalizeIntake(row), deduplicated: false };
  });
  res.status(result.deduplicated ? 200 : 201).json({ ...result, ...(await healthProfileState(req.user.id)) });
});
routes.get('/api/me/health-assessment', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await getHealthAssessmentProgress(req.user.id));
});
routes.put('/api/me/health-assessment/answers', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await saveHealthAssessmentAnswer(req.user.id, req.body));
});
routes.get('/api/me/health-intake-extractions', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json({ items: await listHealthExtractionDrafts(req.user.id) });
});
routes.post('/api/me/health-intake-extractions', auth, async (req, res) => {
  requireGuestRole(req.user);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => !['utterance', 'sessionId'].includes(key));
  if (unknown.length) throw new AppError(400, 'HEALTH_EXTRACTION_INPUT_INVALID', '提取请求包含不允许字段', { fields: unknown });
  const extraction = await createHealthExtractionDraft({ guestId: req.user.id,
    utterance: body.utterance, sessionId: body.sessionId || null });
  res.status(extraction.deduplicated ? 200 : 201).json(extraction);
});
routes.post('/api/me/health-intake-extractions/:id/confirm', auth, async (req, res) => {
  requireGuestRole(req.user);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => key !== 'decisions');
  if (unknown.length) throw new AppError(400, 'HEALTH_EXTRACTION_DECISION_INVALID', '候选确认内容包含不允许字段');
  const result = await confirmHealthExtraction({ guestId: req.user.id, extractionId: req.params.id, decisions: body.decisions });
  res.status(result.deduplicated ? 200 : 201).json(result);
});
routes.get('/api/me/advice', auth, async (req, res) => {
  const guest = await authorizeQueryGuest(req);
  res.json(await db.prepare(`SELECT a.id,a.title,a.content,a.priority,a.status,a.created_at AS createdAt,a.updated_at AS updatedAt,u.name AS authorName
    FROM medical_advice a JOIN users u ON u.id=a.author_id WHERE a.guest_id=? AND a.status='active' ORDER BY a.created_at DESC`).all(guest.id));
});
routes.get('/api/staff/guests/:id/health-intakes', auth, clinicianOnly, async (req, res) => {
  const guest = await authorizeGuestAccess(req.user, req.params.id);
  const profile = await guestProfile(guest.id);
  const state = await healthProfileState(guest.id);
  await log(req.user.id, 'health_intake.view', 'guest', guest.id, '查看客人健康自述与变更历史');
  res.json({ guestId: guest.id, guestName: guest.name, verifiedProfile: state.verifiedProfile,
    profileVersion: state.profileVersion, pendingIntakes: state.pendingIntakes,
    history: state.history, effectiveHealthConstraints: state.effectiveHealthConstraints,
    legacyChronic: profile?.chronic || [], legacyAllergies: profile?.allergies || [] });
});
routes.post('/api/staff/health-intakes/:id/confirm', auth, clinicianOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => key !== 'baseProfileVersion');
  if (unknown.length) throw new AppError(400, 'HEALTH_REVIEW_FIELD_NOT_ALLOWED', '审核请求包含未允许字段', { fields: unknown });
  const outcome = await transaction(async () => {
    const intake = await db.prepare(`SELECT id,guest_id AS guestId,structured_json AS structuredJson,status,
      base_profile_version AS baseProfileVersion FROM health_intakes WHERE id=?`).get(req.params.id);
    if (!intake) throw new AppError(404, 'HEALTH_INTAKE_NOT_FOUND', '健康采集不存在');
    const guest = await authorizeGuestAccess(req.user, intake.guestId);
    const current = await guestProfile(guest.id);
    if (!current) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
    const currentVersion = Number(current.health_profile_version || 0);
    if (intake.status === 'confirmed') return { alreadyApplied: true, guestId: guest.id, profileVersion: currentVersion };
    if (intake.status !== 'pending') throw new AppError(409, 'HEALTH_INTAKE_NOT_PENDING', '该采集已被驳回，不能再次确认');
    if (!intake.structuredJson) throw new AppError(409, 'HEALTH_INTAKE_UNSTRUCTURED', '旧文本采集需先补充结构化字段，当前不能直接合并');
    const baseVersion = Number(intake.baseProfileVersion || 0);
    if (body.baseProfileVersion !== undefined && body.baseProfileVersion !== baseVersion) {
      throw new AppError(409, 'HEALTH_INTAKE_BASE_VERSION_MISMATCH', '审核版本与采集记录不匹配');
    }
    if (currentVersion !== baseVersion) {
      throw new AppError(409, 'HEALTH_PROFILE_STALE_VERSION', '正式档案已变化，请重新比对后再审核', {
        currentProfileVersion: currentVersion,
        intakeBaseProfileVersion: baseVersion
      });
    }
    const before = normalizeHealthProfile(current.health_profile);
    const after = mergeVerifiedHealthProfile(before, json(intake.structuredJson, {}));
    const nextVersion = currentVersion + 1;
    const profileUpdate = await db.prepare(`UPDATE guest_profiles SET health_profile_json=?,health_profile_version=?,updated_at=?
      WHERE user_id=? AND health_profile_version=?`).run(JSON.stringify(after), nextVersion, now(), guest.id, currentVersion);
    if (Number(profileUpdate.changes) !== 1) {
      throw new AppError(409, 'HEALTH_PROFILE_STALE_VERSION', '正式档案刚刚发生变化，请重新比对后再审核');
    }
    const reviewedAt = now();
    const intakeUpdate = await db.prepare(`UPDATE health_intakes SET status='confirmed',reviewed_by=?,reviewed_at=?,review_note=?,
      verified_before_json=?,verified_after_json=? WHERE id=? AND status='pending' AND base_profile_version=?`)
      .run(req.user.id, reviewedAt, '人工核实并合并到正式健康档案', JSON.stringify(before), JSON.stringify(after), req.params.id, currentVersion);
    if (Number(intakeUpdate.changes) !== 1) throw new AppError(409, 'HEALTH_INTAKE_ALREADY_REVIEWED', '该采集已由其他工作人员处理');
    await log(req.user.id, 'health_intake.confirm', 'health_intake', req.params.id, `确认采集并将正式档案升级至第 ${nextVersion} 版`);
    return { alreadyApplied: false, guestId: guest.id, profileVersion: nextVersion };
  });
  const state = await healthProfileState(outcome.guestId);
  res.json({ ...outcome, ...state, intake: state.history.find(item => item.id === Number(req.params.id)) || null });
});
routes.post('/api/staff/health-intakes/:id/reject', auth, clinicianOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => key !== 'reason');
  if (unknown.length) throw new AppError(400, 'HEALTH_REVIEW_FIELD_NOT_ALLOWED', '审核请求包含未允许字段', { fields: unknown });
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason || reason.length > 1000) throw new AppError(400, 'HEALTH_REVIEW_REASON_REQUIRED', '请填写驳回原因（最多 1000 字）');
  const outcome = await transaction(async () => {
    const intake = await db.prepare(`SELECT id,guest_id AS guestId,status FROM health_intakes WHERE id=?`).get(req.params.id);
    if (!intake) throw new AppError(404, 'HEALTH_INTAKE_NOT_FOUND', '健康采集不存在');
    const guest = await authorizeGuestAccess(req.user, intake.guestId);
    const current = await guestProfile(guest.id);
    if (intake.status === 'rejected') return { alreadyApplied: true, guestId: guest.id };
    if (intake.status !== 'pending') throw new AppError(409, 'HEALTH_INTAKE_NOT_PENDING', '已确认的采集不能驳回');
    const snapshot = JSON.stringify(normalizeHealthProfile(current?.health_profile));
    const reviewedAt = now();
    const update = await db.prepare(`UPDATE health_intakes SET status='rejected',reviewed_by=?,reviewed_at=?,review_note=?,
      verified_before_json=?,verified_after_json=? WHERE id=? AND status='pending'`)
      .run(req.user.id, reviewedAt, reason, snapshot, snapshot, req.params.id);
    if (Number(update.changes) !== 1) throw new AppError(409, 'HEALTH_INTAKE_ALREADY_REVIEWED', '该采集已由其他工作人员处理');
    await log(req.user.id, 'health_intake.reject', 'health_intake', req.params.id, reason);
    return { alreadyApplied: false, guestId: guest.id };
  });
  const state = await healthProfileState(outcome.guestId);
  res.json({ ...outcome, ...state, intake: state.history.find(item => item.id === Number(req.params.id)) || null });
});
routes.post('/api/staff/guests/:id/advice', auth, staffOnly, async (req, res) => {
  const capabilities = await capabilitiesFor(db, req.user);
  if (!capabilities.medicalAdvicePublish) {
    throw new AppError(403, 'CAPABILITY_FORBIDDEN', '仅医护岗位可发布医护建议');
  }
  const guest = await authorizeGuestAccess(req.user, req.params.id);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const priority = body.priority === undefined ? 'normal' : body.priority;
  if (!title || !content || title.length > 200 || content.length > 5000 || !['normal', 'important', 'urgent'].includes(priority)) {
    throw new AppError(400, 'ADVICE_INVALID', '标题、内容或重要程度不正确');
  }
  const t = now();
  const result = await transaction(async () => {
    const inserted = await db.prepare('INSERT INTO medical_advice(guest_id,author_id,title,content,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(guest.id, req.user.id, title, content, priority, 'active', t, t);
    const adviceId = String(inserted.lastInsertRowid);
    await createNotificationOnce({ guestId: guest.id, sourceType: 'medical_advice', sourceId: adviceId,
      message: `工作人员发布了新的医护建议：${title}`, targetType: 'medical_advice', targetId: adviceId,
      targetUrl: 'advice', notificationType: 'care', createdAt: t });
    await log(req.user.id, 'advice.create', 'guest', guest.id, title);
    return inserted;
  });
  res.status(201).json({ id: Number(result.lastInsertRowid), ok: true });
});

export default router;