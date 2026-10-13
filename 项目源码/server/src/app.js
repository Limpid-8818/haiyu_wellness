import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import {
  db, hashPassword, verifyPassword, now, log, publicUser, guestProfile, guestSummary, transaction, json, id
} from './db.js';
import { signToken, readToken } from './auth.js';
import { assistantStatus, chatWithAssistant, getAssistantHistory, startAssistantRun, scheduleAssistantRun, getAssistantRun, retryAssistantRun } from './assistant.js';
import { confirmAssistantAction } from './assistant-actions.js';
import { accessibleGuestIds, authorizeGuestAccess, countAccessibleGuests } from './authorization.js';
import { AppError, sendError } from './errors.js';
import {
  emptyHealthProfile, effectiveHealthConstraints, healthProfileCompleteness,
  mergeVerifiedHealthProfile, normalizeHealthProfile
} from './health-profile.js';
import {
  JOB_TYPES, SUMMARY_CAPABILITY, MEDICAL_CAPABILITY, capabilitiesFor, capabilityMatrix,
  canManageStaff, isDateOnly, jobTypeFor, jobTypeLabel, nightsBetween, stayStatus
} from './staffing.js';
import { getProject, listKnowledge, listProjects, listRules, updateProject } from './catalog.js';
import { evaluateProjectRules } from './rules-engine.js';
import { getEnvironmentSnapshot } from './environment.js';
import { getEnvironmentMode } from './environment-config.js';
import { environmentMockScenario } from './environment-mock.js';
import { assessProjectAvailability } from './environment-availability.js';
import { systemBusinessClock } from './clock.js';
import { getGuestDailyBrief } from './daily-brief.js';
import { createNotificationOnce, listGuestNotifications, markGuestNotificationRead, syncCareSignals } from './wellness-notifications.js';
import {
  createHealthRecord, getHealthSummary, getHealthTrend, listHealthRecords,
  retractHealthRecord, validateHealthMetricInput
} from './health-metrics.js';
import {
  cancelReservation, createReservation, listAdminProjectSlots, listGuestProjectSlots,
  listGuestReservations, listGuestSchedule, updateProjectSlot
} from './booking.js';
import {
  createGuestMealOrder, generateGuestMenu, getGuestMealOrders, getGuestMenu, listDishes,
  listDietitianMealOrders, replaceMenuItem, updateDietitianOrderStatus
} from './meals.js';
import {
  createMoodRecord, evaluateMoodFollowups, getMoodResource, getMoodResourceFile, getMoodSummary,
  getMoodTrend, getTodayMood, listMoodFocusItems, listMoodRecords, listMoodResources,
  recordMoodResourcePlay, updateMoodRecord, validateMoodInput
} from './mood.js';
import {
  confirmHealthExtraction, createHealthExtractionDraft, getHealthAssessmentProgress,
  listHealthExtractionDrafts, saveHealthAssessmentAnswer
} from './health-assessment.js';
import {
  adoptWellnessDraft, createWellnessDraft, getWellnessDraft, listWellnessDrafts, wellnessTimeline
} from './wellness-planner.js';
import { finishWellnessDraftPost } from './wellness-draft-post.js';
import {
  approveWellnessDraft, autoActivateWellnessDraft, correctActiveWellnessDraft,
  getWellnessReviewDetail, listWellnessAdminAttention, listWellnessReviewHistory,
  listWellnessReviewAlternatives, listWellnessReviewQueue, returnWellnessDraft, reviseWellnessDraft
} from './wellness-review.js';
import {
  activateReplanEvent, createGuestCheckin, createGuestFeedback, evaluateReplanEvent,
  getReplanEventDetail, listGuestCheckins, listReplanEvents, updateGuestFeedback
} from './wellness-followup.js';
import {
  assignStaffToSlot, cancelWeatherAffectedSlots, closeOperationsIncident, confirmWeatherReschedule,
  getOperationsSummary, listOperationsIncidents, listOrganizationGuests, listOrganizationReservations,
  listOrganizationSlots, listStaffDailySchedule, listWeatherCancellationCandidates,
  markReservationNoShow, organizationGuestHealthHistory, previewWeatherCancellation
} from './stage26-operations.js';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '256kb' }));

const routeHandler = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  app[method](route, ...handlers.map(routeHandler))
]));

async function auth(req, _res, next) {
  const header = req.headers.authorization;
  const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
  const payload = readToken(token);
  if (!payload) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
  const user = await db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(payload.sub);
  if (!user) throw new AppError(401, 'ACCOUNT_INACTIVE', '账号不存在或已停用');
  req.user = user;
  next();
}

async function optionalAuth(req, _res, next) {
  const header = req.headers.authorization;
  if (!header) {
    req.user = null;
    return next();
  }
  const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
  const payload = readToken(token);
  if (!payload) throw new AppError(401, 'AUTH_INVALID', '登录凭证无效，请重新登录');
  req.user = await db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(payload.sub) || null;
  if (!req.user) throw new AppError(401, 'ACCOUNT_INACTIVE', '账号不存在或已停用');
  next();
}

function staffOnly(req, _res, next) {
  return ['staff', 'dean'].includes(req.user.role)
    ? next()
    : next(new AppError(403, 'ROLE_FORBIDDEN', '仅工作人员可访问'));
}

function deanOnly(req, _res, next) {
  return req.user.role === 'dean'
    ? next()
    : next(new AppError(403, 'ROLE_FORBIDDEN', '仅院长可访问'));
}

function staffManagementOnly(req, _res, next) {
  return canManageStaff(req.user)
    ? next()
    : next(new AppError(403, 'CAPABILITY_FORBIDDEN', '当前岗位无权管理员工'));
}

async function clinicianOnly(req, _res, next) {
  const capabilities = await capabilitiesFor(db, req.user);
  return capabilities.medicalAdvicePublish
    ? next()
    : next(new AppError(403, 'CLINICIAN_REQUIRED', '仅医护岗位可处理疗程审核'));
}

function dietitianOnly(req, _res, next) {
  return req.user.role === 'staff' && jobTypeFor(req.user) === 'dietitian'
    ? next()
    : next(new AppError(403, 'DIETITIAN_REQUIRED', '仅配餐员可访问备餐工作台'));
}

async function operationsSummaryOnly(req, _res, next) {
  const capabilities = await capabilitiesFor(db, req.user);
  return capabilities.operationsSummaryView
    ? next()
    : next(new AppError(403, 'CAPABILITY_FORBIDDEN', '当前岗位未获查看运营汇总的权限'));
}

function duplicateConstraint(error) {
  return error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.errcode === 2067 || error?.errcode === 1555
    || error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

function publicStaffRow(row) {
  const jobType = row.jobType ?? row.job_type ?? 'clinician';
  return {
    ...row,
    jobType,
    jobTypeLabel: jobTypeLabel(jobType),
    role: 'staff'
  };
}

async function requireGuestAccount(guestId) {
  const row = await db.prepare(`SELECT id,name,username,phone,status FROM users
    WHERE id=? AND role='guest'`).get(guestId);
  if (!row) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  if (row.status !== 'active') throw new AppError(409, 'GUEST_INACTIVE', '客人账号已停用');
  return row;
}

function safeUser(user) { return publicUser(user); }

function queryString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function requireGuestRole(user) {
  if (user.role !== 'guest') throw new AppError(403, 'GUEST_ONLY', '仅客人可提交个人健康自述');
}

function normalizeIntake(row) {
  const rawCandidate = row.structuredJson ?? row.structured_json;
  let candidate = null;
  if (rawCandidate != null) {
    const parsed = json(rawCandidate, null);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      try { candidate = normalizeHealthProfile(parsed); }
      catch { candidate = null; }
    }
  }
  return {
    id: Number(row.id),
    guestId: row.guestId ?? row.guest_id,
    content: row.content || '',
    source: row.source || 'assistant',
    sessionId: row.sessionId ?? row.session_id ?? null,
    candidate,
    status: row.status || 'pending',
    revision: Number(row.revision || 0),
    baseProfileVersion: Number(row.baseProfileVersion ?? row.base_profile_version ?? 0),
    submittedBy: row.submittedBy ?? row.submitted_by ?? null,
    submitterName: row.submitterName ?? row.submitter_name ?? '',
    submittedAt: row.submittedAt ?? row.created_at ?? '',
    before: json(row.beforeJson ?? row.before_json, null),
    after: json(row.afterJson ?? row.after_json, null),
    verifiedBefore: json(row.verifiedBeforeJson ?? row.verified_before_json, null),
    verifiedAfter: json(row.verifiedAfterJson ?? row.verified_after_json, null),
    reviewedBy: row.reviewedBy ?? row.reviewed_by ?? null,
    reviewerName: row.reviewerName ?? row.reviewer_name ?? '',
    reviewedAt: row.reviewedAt ?? row.reviewed_at ?? null,
    reviewNote: row.reviewNote ?? row.review_note ?? null
  };
}

async function healthIntakeHistory(guestId, { pendingOnly = false } = {}) {
  const rows = await db.prepare(`SELECT h.id,h.guest_id AS guestId,h.content,h.source,h.session_id AS sessionId,
      h.structured_json AS structuredJson,h.status,h.revision,h.base_profile_version AS baseProfileVersion,
      h.submitted_by AS submittedBy,u.name AS submitterName,h.created_at AS submittedAt,
      h.before_json AS beforeJson,h.after_json AS afterJson,
      h.verified_before_json AS verifiedBeforeJson,h.verified_after_json AS verifiedAfterJson,
      h.reviewed_by AS reviewedBy,r.name AS reviewerName,h.reviewed_at AS reviewedAt,h.review_note AS reviewNote
    FROM health_intakes h
    LEFT JOIN users u ON u.id=h.submitted_by
    LEFT JOIN users r ON r.id=h.reviewed_by
    WHERE h.guest_id=? ${pendingOnly ? "AND h.status='pending'" : ''}
    ORDER BY h.revision DESC,h.id DESC LIMIT 200`).all(guestId);
  return rows.map(normalizeIntake);
}

async function healthProfileState(guestId) {
  const profile = await guestProfile(guestId);
  if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  const verifiedProfile = normalizeHealthProfile(profile.health_profile);
  const [history, pendingIntakes] = await Promise.all([
    healthIntakeHistory(guestId),
    healthIntakeHistory(guestId, { pendingOnly: true })
  ]);
  const currentPending = pendingIntakes.find(item => item.candidate)?.candidate || null;
  const draft = currentPending || verifiedProfile;
  const constraints = effectiveHealthConstraints({
    verified: verifiedProfile,
    pendingIntakes: pendingIntakes.map(item => ({ ...item, profile: item.candidate || {} })),
    legacyAllergies: profile.allergies
  });
  return {
    profile: draft,
    verifiedProfile,
    profileVersion: Number(profile.health_profile_version || 0),
    completeness: healthProfileCompleteness(draft),
    pendingIntakes,
    history,
    effectiveHealthConstraints: constraints
  };
}

function healthIntakeFingerprint(profile, baseProfileVersion) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ baseProfileVersion, profile }))
    .digest('hex');
}

function jsonArray(value) {
  const parsed = json(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function requestedGuestId(req) {
  if (req.user.role === 'guest') return req.query.guestId ?? req.user.id;
  return req.query.guestId;
}

async function authorizeQueryGuest(req) {
  const guestId = requestedGuestId(req);
  return await authorizeGuestAccess(req.user, guestId);
}

routes.get('/api/health', async (req, res) => res.json({ ok: true, service: 'seaside-wellness-community', time: now() }));
routes.get('/api/news', async (req, res) => {
  const rows = await db.prepare('SELECT id,category,title,summary,body,cover,published_at AS publishedAt,pinned FROM news ORDER BY pinned DESC,published_at DESC').all();
  res.json(rows);
});
routes.get('/api/news/:id', async (req, res) => {
  const row = await db.prepare('SELECT id,category,title,summary,body,cover,published_at AS publishedAt,pinned FROM news WHERE id=?').get(req.params.id);
  if (!row) throw new AppError(404, 'NEWS_NOT_FOUND', '新闻不存在');
  res.json(row);
});

routes.get('/api/projects', async (req, res) => {
  const items = await listProjects({ category: queryString(req.query.category), search: queryString(req.query.q) });
  res.json({ items, total: items.length });
});
routes.get('/api/projects/:id', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  res.json(project);
});
routes.get('/api/projects/:id/slots', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人可预约时段');
  const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  res.json(await listGuestProjectSlots(req.params.id, date, req.user.id));
});
routes.post('/api/reservations', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可创建本人预约');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => key !== 'slotId');
  if (unknown.length || typeof body.slotId !== 'string') throw new AppError(400, 'RESERVATION_INPUT_INVALID', '预约请求只接受时段编号');
  const idempotencyKey = typeof req.get('Idempotency-Key') === 'string' ? req.get('Idempotency-Key') : '';
  const result = await createReservation({ guestId: req.user.id, slotId: body.slotId, idempotencyKey });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.get('/api/reservations', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人预约');
  res.json(await listGuestReservations(req.user.id));
});
routes.delete('/api/reservations/:id', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可取消本人预约');
  res.json(await cancelReservation({ guestId: req.user.id, reservationId: req.params.id }));
});
routes.get('/api/schedule', auth, async (req, res) => {
  const guest = await authorizeQueryGuest(req);
  res.json(await listGuestSchedule(guest.id));
});
routes.get('/api/meals/dishes', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看个人餐单菜品');
  res.json({ items: await listDishes(), sourceNote: '菜品、过敏原、配方标签与供货状态均为明确标注的本地演示资料。' });
});
routes.get('/api/meals/menu', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人餐单');
  const businessDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  res.json(await getGuestMenu(req.user.id, businessDate));
});
routes.post('/api/meals/menus', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可生成本人餐单');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => key !== 'businessDate');
  if (unknown.length || typeof body.businessDate !== 'string') throw new AppError(400, 'MEAL_MENU_INPUT_INVALID', '请求只接受有效的业务日期');
  const result = await generateGuestMenu(req.user.id, body.businessDate);
  res.status(result.created ? 201 : 200).json(result);
});
routes.patch('/api/meals/menus/:menuId/items/:itemId', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可替换本人餐单菜品');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => !['version', 'dishId', 'reason'].includes(key));
  if (unknown.length) throw new AppError(400, 'MEAL_SWAP_INPUT_INVALID', '替换请求包含不允许的字段');
  res.json(await replaceMenuItem({
    guestId: req.user.id, menuId: req.params.menuId, itemId: req.params.itemId,
    version: body.version, dishId: body.dishId, reason: body.reason
  }));
});
routes.get('/api/meals/orders', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人餐食订单');
  const businessDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  res.json(await getGuestMealOrders(req.user.id, businessDate));
});
routes.post('/api/meals/orders', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可提交本人餐食订单');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => !['menuId', 'businessDate', 'mealType', 'version'].includes(key));
  if (unknown.length) throw new AppError(400, 'MEAL_ORDER_INPUT_INVALID', '订单请求包含不允许的字段');
  const result = await createGuestMealOrder({
    guestId: req.user.id, idempotencyKey: req.get('Idempotency-Key'),
    menuId: body.menuId, businessDate: body.businessDate, mealType: body.mealType, version: body.version
  });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.get('/api/staff/meals/orders', auth, dietitianOnly, async (req, res) => {
  const businessDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  const mealType = typeof req.query.mealType === 'string' ? req.query.mealType : '';
  res.json(await listDietitianMealOrders(req.user, { businessDate, mealType }));
});
routes.patch('/api/staff/meals/orders/:orderId/status', auth, dietitianOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => key !== 'status')) throw new AppError(400, 'MEAL_ORDER_STATUS_INPUT_INVALID', '状态更新只接受目标状态');
  res.json(await updateDietitianOrderStatus({ user: req.user, orderId: req.params.orderId, status: body.status }));
});
routes.get('/api/admin/projects', auth, staffManagementOnly, async (_req, res) => {
  const items = await listProjects({ includeInactive: true });
  res.json({ items, total: items.length });
});
routes.patch('/api/admin/projects/:id', auth, staffManagementOnly, async (req, res) => {
  const project = await updateProject(req.params.id, req.body, req.user.id);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
  res.json(project);
});
routes.get('/api/admin/projects/:id/slots', auth, staffManagementOnly, async (req, res) => {
  const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  res.json(await listAdminProjectSlots(req.params.id, date));
});
routes.patch('/api/admin/projects/:id/slots/:slotId', auth, staffManagementOnly, async (req, res) => {
  res.json(await updateProjectSlot({ actorId: req.user.id, projectId: req.params.id, slotId: req.params.slotId, patch: req.body }));
});
routes.get('/api/admin/operations/guests', auth, staffManagementOnly, async (req, res) => {
  res.json({ items: await listOrganizationGuests({ query: queryString(req.query.q), date: queryString(req.query.date) }) });
});
routes.get('/api/admin/operations/guests/:guestId/health-history', auth, staffManagementOnly, async (req, res) => {
  res.json(await organizationGuestHealthHistory(req.params.guestId));
});
routes.get('/api/staff/operations/guests/:guestId/health-history', auth, clinicianOnly, async (req, res) => {
  const guest = await authorizeGuestAccess(req.user, req.params.guestId);
  res.json(await organizationGuestHealthHistory(guest.id));
});
routes.get('/api/admin/operations/slots', auth, staffManagementOnly, async (req, res) => {
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  res.json(await listOrganizationSlots({ projectId: queryString(req.query.projectId),
    date: queryString(req.query.date) || systemBusinessClock.dateKey(), days }));
});
routes.get('/api/admin/operations/reservations', auth, staffManagementOnly, async (req, res) => {
  const date = queryString(req.query.date) || systemBusinessClock.dateKey();
  res.json(await listOrganizationReservations({ date, from: queryString(req.query.from), to: queryString(req.query.to),
    projectId: queryString(req.query.projectId), status: queryString(req.query.status) || 'active' }));
});
routes.post('/api/admin/operations/reservations/:id/no-show', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).length) throw new AppError(400, 'NO_SHOW_INPUT_INVALID', '爽约登记不接受额外字段');
  res.json(await markReservationNoShow({ reservationId: req.params.id, actorId: req.user.id }));
});
routes.post('/api/admin/operations/weather-cancellations/preview', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => !['slotIds', 'snapshotKey'].includes(key))) {
    throw new AppError(400, 'WEATHER_BATCH_INPUT_INVALID', '天气预览请求包含不允许的字段');
  }
  res.json(await previewWeatherCancellation({ slotIds: body.slotIds, snapshotKey: body.snapshotKey }));
});
routes.post('/api/admin/operations/weather-cancellations', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => !['slotIds', 'snapshotKey', 'requestKey', 'reason'].includes(key))) {
    throw new AppError(400, 'WEATHER_BATCH_INPUT_INVALID', '天气处理请求包含不允许的字段');
  }
  const result = await cancelWeatherAffectedSlots({ actorId: req.user.id, ...body,
    requestKey: req.get('Idempotency-Key') || body.requestKey || '' });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.get('/api/reservations/:id/reschedule-candidates', auth, async (req, res) => {
  const reservation = await db.prepare('SELECT guest_id AS guestId FROM reservations WHERE id=?').get(req.params.id);
  if (!reservation) throw new AppError(404, 'RESERVATION_NOT_FOUND', '预约不存在');
  const guest = await authorizeGuestAccess(req.user, reservation.guestId);
  res.json(await listWeatherCancellationCandidates({ reservationId: req.params.id, guestId: guest.id }));
});
routes.post('/api/reservations/:id/reschedule', auth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => key !== 'slotId') || typeof body.slotId !== 'string') {
    throw new AppError(400, 'RESCHEDULE_INPUT_INVALID', '改约只接受一个已选替代时段');
  }
  const reservation = await db.prepare('SELECT guest_id AS guestId FROM reservations WHERE id=?').get(req.params.id);
  if (!reservation) throw new AppError(404, 'RESERVATION_NOT_FOUND', '预约不存在');
  const guest = await authorizeGuestAccess(req.user, reservation.guestId);
  const result = await confirmWeatherReschedule({ reservationId: req.params.id, guestId: guest.id,
    actorId: req.user.id, slotId: body.slotId, requestKey: req.get('Idempotency-Key') || '' });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.post('/api/admin/operations/slots/:slotId/assignments', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => !['staffId', 'jobType'].includes(key))
    || typeof body.staffId !== 'string' || typeof body.jobType !== 'string') {
    throw new AppError(400, 'SLOT_ASSIGNMENT_INPUT_INVALID', '时段分配只接受员工编号与岗位');
  }
  res.status(201).json(await assignStaffToSlot({ slotId: req.params.slotId, staffId: body.staffId,
    jobType: body.jobType, actorId: req.user.id }));
});
routes.get('/api/staff/schedule', auth, staffOnly, async (req, res) => {
  res.json(await listStaffDailySchedule(req.user, queryString(req.query.date) || systemBusinessClock.dateKey()));
});
routes.get('/api/admin/operations/summary', auth, staffManagementOnly, async (req, res) => {
  res.json(await getOperationsSummary({ date: queryString(req.query.date) || systemBusinessClock.dateKey(),
    detail: queryString(req.query.detail) }));
});
routes.get('/api/admin/operations/incidents', auth, staffManagementOnly, async (_req, res) => {
  res.json({ items: await listOperationsIncidents() });
});
routes.post('/api/admin/operations/incidents/close', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => !['supplier', 'feature'].includes(key))
    || typeof body.supplier !== 'string' || typeof body.feature !== 'string') {
    throw new AppError(400, 'OPERATIONS_INCIDENT_INPUT_INVALID', '关闭运营事项需要供应商与功能标识');
  }
  res.json(await closeOperationsIncident({ supplier: body.supplier, feature: body.feature, actorId: req.user.id }));
});
routes.get('/api/knowledge', async (req, res) => {
  const items = await listKnowledge({ domain: queryString(req.query.domain), search: queryString(req.query.q) });
  res.json({ items, total: items.length });
});
routes.get('/api/rules', async (req, res) => {
  const items = await listRules({ search: queryString(req.query.q) });
  res.json({ items, total: items.length });
});
routes.get('/api/environment', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人环境与项目时段信息');
  const defaultDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(now()));
  const targetDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : defaultDate;
  if (!isDateOnly(targetDate)) throw new AppError(400, 'ENVIRONMENT_DATE_INVALID', '日期必须是有效的 YYYY-MM-DD');
  let mockScenario;
  if (req.query.mockScenario !== undefined) {
    if (getEnvironmentMode() !== 'demo') throw new AppError(400, 'ENVIRONMENT_MOCK_DISABLED', '仅合成/mock模式可选择测试场景');
    try { mockScenario = environmentMockScenario(req.query.mockScenario); }
    catch { throw new AppError(400, 'ENVIRONMENT_MOCK_SCENARIO_INVALID', '测试场景须为 normal、risk、missing 或 stale'); }
  }
  const snapshot = await getEnvironmentSnapshot(targetDate, { mockScenario });
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
  if (!projectId) return res.json({ ...snapshot, availability: null });
  const project = await getProject(projectId);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  const profileState = await healthProfileState(req.user.id);
  const legacyProfile = await guestProfile(req.user.id);
  const availability = assessProjectAvailability({
    project, snapshot, profileState, legacyProfile, rules: await listRules()
  });
  res.json({ ...snapshot, availability });
});
routes.post('/api/rules/evaluate', auth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => !['projectId', 'guestId', 'environment'].includes(key));
  if (unknown.length) throw new AppError(400, 'RULE_EVALUATION_FIELD_NOT_ALLOWED', '请求包含不允许的字段', { fields: unknown });
  if (typeof body.projectId !== 'string' || !body.projectId.trim()) {
    throw new AppError(400, 'PROJECT_ID_REQUIRED', '缺少项目编号');
  }
  if (!['guest', 'dean'].includes(req.user.role)
    && !(req.user.role === 'staff' && jobTypeFor(req.user) === 'clinician')) {
    throw new AppError(403, 'CLINICIAN_REQUIRED', '仅客人、负责医护或院长可执行健康规则核对');
  }
  const guestId = req.user.role === 'guest' ? req.user.id : body.guestId;
  if (typeof guestId !== 'string' || !guestId.trim()) throw new AppError(400, 'GUEST_ID_REQUIRED', '请提供待核对的客人');
  const guest = await authorizeGuestAccess(req.user, guestId.trim());
  const project = await getProject(body.projectId.trim());
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  const environment = body.environment === undefined ? {} : body.environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new AppError(400, 'ENVIRONMENT_INVALID', '环境输入格式不正确');
  }
  const environmentUnknown = Object.keys(environment).filter(key => !['uvLevel', 'seaStatus', 'source'].includes(key));
  if (environmentUnknown.length) throw new AppError(400, 'ENVIRONMENT_FIELD_NOT_ALLOWED', '环境输入包含不允许的字段', { fields: environmentUnknown });
  const uvLevels = new Set(['low', 'moderate', 'high', 'strong', 'unknown', 'missing']);
  const seaStatuses = new Set(['safe', 'unsafe', 'unknown', 'missing']);
  if (environment.uvLevel !== undefined && !uvLevels.has(environment.uvLevel)) {
    throw new AppError(400, 'ENVIRONMENT_UV_INVALID', '紫外线状态无效');
  }
  if (environment.seaStatus !== undefined && !seaStatuses.has(environment.seaStatus)) {
    throw new AppError(400, 'ENVIRONMENT_SEA_STATUS_INVALID', '海况状态无效');
  }
  if (environment.source !== undefined && (typeof environment.source !== 'string' || environment.source.length > 120)) {
    throw new AppError(400, 'ENVIRONMENT_SOURCE_INVALID', '环境来源说明最多 120 个字符');
  }
  const state = await healthProfileState(guest.id);
  const legacyProfile = await guestProfile(guest.id);
  const persistedRules = await listRules();
  res.json(evaluateProjectRules({
    project,
    verifiedProfile: state.verifiedProfile,
    legacyProfile,
    pendingIntakes: state.pendingIntakes,
    environment,
    effectiveHealthConstraints: state.effectiveHealthConstraints,
    rules: persistedRules
  }));
});

routes.get('/api/assistant/status', async (req, res) => res.json(assistantStatus()));
routes.post('/api/assistant/chat', optionalAuth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const clientRequestId = req.get('Idempotency-Key') || body.clientRequestId;
  const forceDomainCollaboration = process.env.NODE_ENV === 'test'
    && process.env.Q20_ACCEPTANCE_HOOKS === '1' && body.forceDomainCollaboration === true;
  if (body.async === true) {
    const started = await startAssistantRun({
      user: req.user, role: body.role, sessionId: body.sessionId, text: body.text,
      guestId: body.guestId, clientRequestId, forceDomainCollaboration
    });
    if (!started.duplicate) scheduleAssistantRun(started.run.id);
    const run = await getAssistantRun({ user: req.user, role: body.role, runId: started.run.id });
    return res.status(202).json({ runId: run.runId, sessionId: run.sessionId, status: run.status, duplicate: started.duplicate });
  }
  const result = await chatWithAssistant({
    user: req.user,
    role: body.role,
    sessionId: body.sessionId,
    text: body.text,
    guestId: body.guestId,
    clientRequestId,
    forceDomainCollaboration
  });
  res.json(result);
});
routes.get('/api/assistant/runs/:runId', optionalAuth, async (req, res) => {
  res.json(await getAssistantRun({ user: req.user, role: req.query.role, runId: req.params.runId }));
});
routes.post('/api/assistant/runs/:runId/retry', optionalAuth, async (req, res) => {
  const result = await retryAssistantRun({ user: req.user, role: req.body?.role, runId: req.params.runId });
  res.status(result.status === 'queued' || result.status === 'running' ? 202 : 200).json(result);
});
routes.post('/api/assistant/actions/:actionId/confirm', auth, async (req, res) => {
  const body = req.body || {};
  if (Object.keys(body).some(key => !['sessionId', 'version'].includes(key))
    || typeof body.sessionId !== 'string' || !body.sessionId
    || !Number.isInteger(Number(body.version))) {
    throw new AppError(400, 'ASSISTANT_ACTION_CONFIRM_INPUT_INVALID', '确认卡请求参数无效');
  }
  const actionCard = await confirmAssistantAction({ user: req.user, actionId: req.params.actionId,
    sessionId: body.sessionId, version: Number(body.version), idempotencyKey: req.get('Idempotency-Key') });
  res.json({ actionCard });
});
routes.get('/api/assistant/history', optionalAuth, async (req, res) => {
  if (typeof req.query.sessionId !== 'string' || !req.query.sessionId) {
    throw new AppError(400, 'ASSISTANT_SESSION_REQUIRED', '缺少助手会话编号');
  }
  res.json(await getAssistantHistory({
    user: req.user,
    role: req.query.role,
    sessionId: req.query.sessionId,
    guestId: req.query.guestId,
    beforeId: req.query.beforeId,
    limit: req.query.limit
  }));
});

routes.get('/api/mood/resources', async (_req, res) => res.json(listMoodResources()));
routes.get('/api/mood/resources/:resourceId/audio', (req, res, next) => {
  if (!getMoodResource(req.params.resourceId)) throw new AppError(404, 'MOOD_RESOURCE_NOT_FOUND', '放松资源不存在');
  res.sendFile(getMoodResourceFile(req.params.resourceId, 'audio'), {
    headers: { 'Cache-Control': 'public, max-age=3600' }
  }, error => { if (error && !res.headersSent) next(error); });
});
routes.get('/api/mood/resources/:resourceId/cover', (req, res, next) => {
  if (!getMoodResource(req.params.resourceId)) throw new AppError(404, 'MOOD_RESOURCE_NOT_FOUND', '放松资源不存在');
  res.sendFile(getMoodResourceFile(req.params.resourceId, 'cover'), {
    headers: { 'Cache-Control': 'public, max-age=3600' }
  }, error => { if (error && !res.headersSent) next(error); });
});

routes.post('/api/auth/register', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
  const name = typeof body.name === 'string' ? body.name.trim() : `新客人${phone.slice(-4)}`;
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new AppError(400, 'REGISTER_PHONE_INVALID', '请输入有效的11位手机号');
  if (password.length < 8 || password.length > 128) throw new AppError(400, 'REGISTER_PASSWORD_INVALID', '密码长度应为 8 至 128 位');
  if (password !== confirmPassword) throw new AppError(400, 'REGISTER_PASSWORD_MISMATCH', '两次输入的密码不一致');
  if (!name || name.length > 64) throw new AppError(400, 'REGISTER_NAME_INVALID', '姓名不能为空且不能超过64个字符');
  if (await db.prepare('SELECT id FROM users WHERE phone=? OR username=? LIMIT 1').get(phone, phone)) {
    throw new AppError(409, 'REGISTER_PHONE_TAKEN', '该手机号已注册，请直接登录');
  }

  const guestId = id('guest');
  const createdAt = now();
  try {
    await transaction(async () => {
      await db.prepare(`INSERT INTO users(id,username,password_hash,role,name,phone,status,job_type,created_at)
        VALUES(?,?,?,?,?,?,'active',NULL,?)`).run(guestId, phone, hashPassword(password), 'guest', name, phone, createdAt);
      await db.prepare(`INSERT INTO guest_profiles
        (user_id,gender,birth_date,room_no,check_in,check_out,stay_plan,emergency_contact,chronic_json,allergies_json,mobility,updated_at)
        VALUES(?,NULL,NULL,NULL,NULL,NULL,NULL,'','[]','[]','',?)`).run(guestId, createdAt);
      await log(guestId, 'guest.register', 'guest', guestId, '手机号注册，入住状态待办理');
    });
  } catch (error) {
    if (duplicateConstraint(error)) throw new AppError(409, 'REGISTER_PHONE_TAKEN', '该手机号已注册，请直接登录');
    throw error;
  }
  const user = await db.prepare('SELECT * FROM users WHERE id=?').get(guestId);
  res.status(201).json({ token: signToken(user), user: safeUser(user), admissionStatus: 'pending' });
});

routes.post('/api/auth/login', async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { username, password, role } = body;
  if (![username, password, role].every(value => typeof value === 'string')) {
    throw new AppError(401, 'AUTH_INVALID_CREDENTIALS', '账号、密码或身份不匹配');
  }
  const user = await db.prepare("SELECT * FROM users WHERE username=? AND role=? AND status='active'").get(username, role);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new AppError(401, 'AUTH_INVALID_CREDENTIALS', '账号、密码或身份不匹配');
  }
  await log(user.id, 'login', 'user', user.id, '登录系统');
  res.json({ token: signToken(user), user: { ...safeUser(user), capabilities: await capabilitiesFor(db, user) } });
});

routes.get('/api/me', auth, async (req, res) => {
  if (req.user.role === 'guest') {
    const summary = await guestSummary(req.user.id);
    if (!summary) throw new AppError(403, 'GUEST_INACTIVE', '客人账号已停用');
    return res.json(summary);
  }
  res.json({ ...safeUser(req.user), capabilities: await capabilitiesFor(db, req.user), assignedCount: await countAccessibleGuests(req.user) });
});

routes.get('/api/me/capabilities', auth, async (req, res) => {
  res.json(await capabilitiesFor(db, req.user));
});

routes.patch('/api/me/profile', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(400, 'PROFILE_GUEST_ONLY', '工作人员请在账号设置中维护个人信息');
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'PROFILE_INVALID_BODY', '个人资料请求体必须是对象');
  }
  const allowed = {
    phone: 32,
    emergencyContact: 128,
    mobility: 128
  };
  const keys = Object.keys(body);
  const unknown = keys.filter(key => !Object.hasOwn(allowed, key));
  if (unknown.length) {
    throw new AppError(400, 'PROFILE_FIELD_NOT_ALLOWED', '只能修改联系电话、紧急联系人和行动能力', { fields: unknown });
  }
  if (!keys.length) throw new AppError(400, 'PROFILE_NO_FIELDS', '至少提供一个可修改字段');
  const values = {};
  for (const key of keys) {
    if (typeof body[key] !== 'string') throw new AppError(400, 'PROFILE_FIELD_INVALID', `${key} 必须是文本`);
    values[key] = body[key].trim();
    if (values[key].length > allowed[key]) throw new AppError(400, 'PROFILE_FIELD_INVALID', `${key} 长度超过 ${allowed[key]} 个字符`);
  }
  const current = await db.prepare('SELECT phone FROM users WHERE id=?').get(req.user.id);
  const profile = await guestProfile(req.user.id);
  if (!current || !profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  const nextPhone = values.phone ?? current.phone ?? '';
  const nextEmergency = values.emergencyContact ?? profile.emergency_contact ?? '';
  const nextMobility = values.mobility ?? profile.mobility ?? '';
  await transaction(async () => {
    await db.prepare('UPDATE users SET phone=? WHERE id=?').run(nextPhone, req.user.id);
    await db.prepare('UPDATE guest_profiles SET emergency_contact=?,mobility=?,updated_at=? WHERE user_id=?')
      .run(nextEmergency, nextMobility, now(), req.user.id);
    await log(req.user.id, 'profile.update', 'guest', req.user.id, '客人更新联系方式与行动能力');
  });
  res.json(await guestSummary(req.user.id));
});

routes.post('/api/me/password', auth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { currentPassword, newPassword } = body;
  if (!verifyPassword(currentPassword, req.user.password_hash)) {
    throw new AppError(400, 'PASSWORD_CURRENT_INVALID', '当前密码不正确');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    throw new AppError(400, 'PASSWORD_NEW_INVALID', '新密码长度应为 8 至 128 位');
  }
  await transaction(async () => {
    await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), req.user.id);
    await log(req.user.id, 'password.change', 'user', req.user.id, '修改登录密码');
  });
  res.json({ ok: true });
});

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
    if (!duplicateConstraint(error)) throw error;
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
routes.get('/api/me/therapy-drafts', auth, async (req, res) => {
  requireGuestRole(req.user);
  const stayStart = typeof req.query.stayStart === 'string' ? req.query.stayStart : null;
  const stayEnd = typeof req.query.stayEnd === 'string' ? req.query.stayEnd : null;
  if ((stayStart && !isDateOnly(stayStart)) || (stayEnd && !isDateOnly(stayEnd))) {
    throw new AppError(400, 'WELLNESS_STAY_INVALID', '入住日期必须是有效 YYYY-MM-DD');
  }
  res.json({ items: await listWellnessDrafts(req.user.id, { stayStart, stayEnd }) });
});
routes.post('/api/me/therapy-drafts', auth, async (req, res) => {
  requireGuestRole(req.user);
  const requestKey = req.get('Idempotency-Key');
  const isAdoption = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    && req.body.action === 'adopt_candidate';
  const draft = isAdoption
    ? await adoptWellnessDraft({ user: req.user, body: req.body, requestKey })
    : await createWellnessDraft({ user: req.user, body: req.body, requestKey });
  const result = await finishWellnessDraftPost({ draft, isAdoption, guestId: req.user.id,
    autoActivate: autoActivateWellnessDraft, getDraft: getWellnessDraft });
  res.status(draft.deduplicated ? 200 : 201).json(result);
});
routes.get('/api/me/therapy-drafts/:id', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await getWellnessDraft(req.user.id, req.params.id));
});
routes.get('/api/me/daily-brief', auth, async (req, res) => {
  requireGuestRole(req.user);
  const businessDate = queryString(req.query.date) || systemBusinessClock.dateKey();
  if (!isDateOnly(businessDate)) throw new AppError(400, 'DAILY_BRIEF_DATE_INVALID', '日期必须是有效 YYYY-MM-DD');
  res.json(await getGuestDailyBrief(req.user.id, businessDate));
});
routes.get('/api/me/wellness-notifications', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await listGuestNotifications(req.user.id));
});
routes.patch('/api/me/wellness-notifications/:id/read', auth, async (req, res) => {
  requireGuestRole(req.user);
  const item = await markGuestNotificationRead(req.user.id, req.params.id);
  if (!item) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', '提醒不存在或不属于当前客人');
  res.json({ item, unreadCount: (await listGuestNotifications(req.user.id)).unreadCount });
});
routes.get('/api/staff/care-follow-up-tasks', auth, staffOnly, async (req, res) => {
  const guestIds = await accessibleGuestIds(req.user);
  if (!guestIds.length) return res.json({ items: [] });
  const items = await db.prepare(`SELECT t.id,t.guest_id AS guestId,u.name AS guestName,
      t.source_type AS sourceType,t.source_id AS sourceId,t.title,t.detail,t.status,
      t.created_at AS createdAt,t.updated_at AS updatedAt
    FROM care_follow_up_tasks t JOIN users u ON u.id=t.guest_id
    WHERE t.assignee_id=? AND t.status='open' AND t.guest_id IN (${guestIds.map(() => '?').join(',')})
    ORDER BY t.created_at DESC,t.id DESC LIMIT 100`).all(req.user.id, ...guestIds);
  res.json({ items });
});
routes.get('/api/staff/therapy-drafts', auth, clinicianOnly, async (req, res) => {
  res.json(await listWellnessReviewQueue(req.user, { status: queryString(req.query.status),
    guestId: queryString(req.query.guestId), date: queryString(req.query.date), risk: queryString(req.query.risk) }));
});
routes.get('/api/staff/therapy-drafts/:id', auth, clinicianOnly, async (req, res) => {
  res.json(await getWellnessReviewDetail(req.user, req.params.id));
});
routes.get('/api/staff/therapy-drafts/:id/alternatives', auth, clinicianOnly, async (req, res) => {
  res.json(await listWellnessReviewAlternatives(req.user, req.params.id,
    queryString(req.query.itemId)));
});
routes.put('/api/staff/therapy-drafts/:id/revisions', auth, clinicianOnly, async (req, res) => {
  res.json(await reviseWellnessDraft({ actor: req.user, draftId: req.params.id,
    version: req.body?.version, edits: req.body?.edits, reason: req.body?.reason,
    requestKey: req.get('Idempotency-Key') }));
});
routes.post('/api/staff/therapy-drafts/:id/approve', auth, clinicianOnly, async (req, res) => {
  res.json(await approveWellnessDraft({ actor: req.user, draftId: req.params.id,
    version: req.body?.version, requestKey: req.get('Idempotency-Key') }));
});
routes.post('/api/staff/therapy-drafts/:id/return', auth, clinicianOnly, async (req, res) => {
  res.json(await returnWellnessDraft({ actor: req.user, draftId: req.params.id,
    version: req.body?.version, reason: req.body?.reason, requestKey: req.get('Idempotency-Key') }));
});
routes.post('/api/staff/therapy-drafts/:id/correction', auth, clinicianOnly, async (req, res) => {
  res.json(await correctActiveWellnessDraft({ actor: req.user, draftId: req.params.id,
    version: req.body?.version, edits: req.body?.edits, reason: req.body?.reason,
    requestKey: req.get('Idempotency-Key') }));
});
routes.get('/api/staff/therapy-review-history', auth, async (req, res) => {
  res.json(await listWellnessReviewHistory(req.user, { guestId: queryString(req.query.guestId),
    action: queryString(req.query.action), from: queryString(req.query.from), to: queryString(req.query.to) }));
});
routes.get('/api/staff/therapy-review-attention', auth, async (req, res) => {
  res.json(await listWellnessAdminAttention(req.user));
});
routes.get('/api/me/timeline', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await wellnessTimeline(req.user.id));
});
routes.get('/api/me/checkins', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await listGuestCheckins(req.user.id));
});
routes.post('/api/me/reservations/:reservationId/checkin', auth, async (req, res) => {
  requireGuestRole(req.user);
  const checkin = await createGuestCheckin({ guestId: req.user.id, reservationId: req.params.reservationId, clock: systemBusinessClock });
  res.status(checkin.replayed ? 200 : 201).json(checkin);
});
routes.post('/api/me/reservations/:reservationId/feedback', auth, async (req, res) => {
  requireGuestRole(req.user);
  const feedback = await createGuestFeedback({ guestId: req.user.id, reservationId: req.params.reservationId,
    body: req.body, clock: systemBusinessClock });
  res.status(feedback.replayed ? 200 : 201).json(feedback);
});
routes.put('/api/me/feedback/:id', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await updateGuestFeedback({ guestId: req.user.id, feedbackId: req.params.id,
    body: req.body, clock: systemBusinessClock }));
});
routes.get('/api/me/replanning-events', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await listReplanEvents(req.user.id));
});
routes.get('/api/me/replanning-events/:id', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await getReplanEventDetail(req.user.id, req.params.id));
});
routes.post('/api/me/replanning-events/:id/evaluate', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await evaluateReplanEvent({ user: req.user, eventId: req.params.id }));
});
routes.post('/api/me/replanning-events/:id/auto-activate', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await activateReplanEvent({ user: req.user, eventId: req.params.id }));
});
routes.get('/api/me/advice', auth, async (req, res) => {
  const guest = await authorizeQueryGuest(req);
  res.json(await db.prepare(`SELECT a.id,a.title,a.content,a.priority,a.status,a.created_at AS createdAt,a.updated_at AS updatedAt,u.name AS authorName
    FROM medical_advice a JOIN users u ON u.id=a.author_id WHERE a.guest_id=? AND a.status='active' ORDER BY a.created_at DESC`).all(guest.id));
});
routes.get('/api/agent/status', auth, async (req, res) => {
  const guestId = req.user.role === 'guest'
    ? (req.query.guestId ?? req.user.id)
    : req.query.guestId;
  const guest = guestId === undefined ? null : await authorizeGuestAccess(req.user, guestId);
  const events = guest ? [
    { agent: '康养管家', action: '读取健康档案', detail: `已读取 ${guest.name} 的授权档案`, state: 'done' },
    { agent: '理疗顾问', action: '执行安全规则', detail: '核对慢病、过敏与项目禁忌', state: 'done' },
    { agent: '营养师', action: '生成膳食建议', detail: '结合过敏源与饮食偏好筛选餐食', state: 'done' },
    { agent: '运动教练', action: '评估活动强度', detail: '根据行动能力给出运动建议', state: 'done' },
    { agent: '心理陪伴', action: '准备陪伴策略', detail: '根据最近状态准备沟通建议', state: 'ready' }
  ] : [
    { agent: '康养管家', action: '等待任务', detail: '登录后可为客人编排服务任务', state: 'ready' },
    { agent: '理疗顾问', action: '规则库在线', detail: '禁忌规则服务正常', state: 'done' },
    { agent: '营养师', action: '规则库在线', detail: '膳食策略服务正常', state: 'done' },
    { agent: '运动教练', action: '规则库在线', detail: '运动强度服务正常', state: 'done' },
    { agent: '心理陪伴', action: '规则库在线', detail: '陪伴策略服务正常', state: 'done' }
  ];
  res.json({ mode: process.env.LLM_BASE_URL ? 'llm+rules' : '可解释规则协作模式', orchestrator: '康养管家', agents: events, humanGate: '涉及健康风险的建议由工作人员最终确认' });
});

routes.get('/api/staff/overview', auth, staffOnly, operationsSummaryOnly, async (req, res) => {
  const guestIds = await accessibleGuestIds(req.user);
  const placeholders = guestIds.map(() => '?').join(',');
  const activeAdvice = guestIds.length
    ? Number((await db.prepare(`SELECT COUNT(*) AS count FROM medical_advice WHERE status='active' AND guest_id IN (${placeholders})`).get(...guestIds)).count)
    : 0;
  let recent;
  if (req.user.role === 'dean') {
    recent = await db.prepare('SELECT id,action,detail,created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 8').all();
  } else {
    const targetFilter = guestIds.length ? ` OR target_id IN (${placeholders})` : '';
    recent = await db.prepare(`SELECT id,action,detail,created_at AS createdAt FROM audit_logs
      WHERE actor_id=? AND (COALESCE(target_type,'') <> 'guest'${targetFilter})
      ORDER BY id DESC LIMIT 8`).all(req.user.id, ...guestIds);
  }
  res.json({ guests: guestIds.length, activeAdvice, recent });
});

routes.get('/api/dean/staff', auth, staffManagementOnly, async (req, res) => {
  const rows = await db.prepare(`SELECT id,name,username,phone,status,job_type AS jobType,created_at AS createdAt
    FROM users WHERE role='staff' ORDER BY name`).all();
  const result = await Promise.all(rows.map(async row => ({
    ...publicStaffRow(row),
    guestViews: Number((await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id=? AND action='guest.view'").get(row.id)).count),
    adviceCount: Number((await db.prepare("SELECT COUNT(*) AS count FROM medical_advice WHERE author_id=?").get(row.id)).count)
  })));
  res.json(result);
});
routes.post('/api/dean/staff', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const jobType = body.jobType;
  if (!name || name.length > 64 || !/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) {
    throw new AppError(400, 'STAFF_INPUT_INVALID', '请填写姓名和3至64位账号');
  }
  if (password.length < 8 || password.length > 128) throw new AppError(400, 'STAFF_PASSWORD_INVALID', '初始密码长度应为 8 至 128 位');
  if (phone.length > 32 || !JOB_TYPES.some(type => type.value === jobType)) {
    throw new AppError(400, 'STAFF_JOB_TYPE_INVALID', '联系电话或岗位类型不正确');
  }
  if (await db.prepare('SELECT id FROM users WHERE username=?').get(username)) {
    throw new AppError(409, 'STAFF_USERNAME_TAKEN', '该账号已存在');
  }
  const staffId = id('staff');
  try {
    await transaction(async () => {
      await db.prepare(`INSERT INTO users(id,username,password_hash,role,name,phone,status,job_type,created_at)
        VALUES(?,?,?,'staff',?,?,'active',?,?)`).run(staffId, username, hashPassword(password), name, phone, jobType, now());
      await log(req.user.id, 'staff.create', 'staff', staffId, `创建${jobTypeLabel(jobType)}账号 ${username}`);
    });
  } catch (error) {
    if (duplicateConstraint(error)) throw new AppError(409, 'STAFF_USERNAME_TAKEN', '该账号已存在');
    throw error;
  }
  const created = await db.prepare(`SELECT id,name,username,phone,status,job_type AS jobType,created_at AS createdAt
    FROM users WHERE id=?`).get(staffId);
  res.status(201).json(publicStaffRow(created));
});
routes.patch('/api/dean/staff/:id', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const keys = Object.keys(body);
  const unknown = keys.filter(key => !['status', 'jobType'].includes(key));
  if (!keys.length || unknown.length) throw new AppError(400, 'STAFF_UPDATE_INVALID', '请提供状态或岗位字段');
  if (body.status !== undefined && !['active', 'disabled'].includes(body.status)) {
    throw new AppError(400, 'STAFF_STATUS_INVALID', '状态只能设为正常或停用');
  }
  if (body.jobType !== undefined && !JOB_TYPES.some(type => type.value === body.jobType)) {
    throw new AppError(400, 'STAFF_JOB_TYPE_INVALID', '岗位类型不正确');
  }
  const staff = await db.prepare("SELECT id,name,username,status,job_type AS jobType FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  if (staff.id === req.user.id && (body.status === 'disabled' || body.jobType !== undefined && body.jobType !== 'administrator')) {
    throw new AppError(409, 'STAFF_SELF_LOCKOUT', '不能停用或移除自己的管理员岗位');
  }
  const nextStatus = body.status ?? staff.status;
  const nextJobType = body.jobType ?? staff.jobType ?? 'clinician';
  await transaction(async () => {
    await db.prepare('UPDATE users SET status=?,job_type=? WHERE id=?').run(nextStatus, nextJobType, staff.id);
    const changes = [];
    if (body.status !== undefined && body.status !== staff.status) changes.push(nextStatus === 'disabled' ? '停用账号' : '重新启用账号');
    if (body.jobType !== undefined && body.jobType !== staff.jobType) changes.push(`岗位改为${jobTypeLabel(nextJobType)}`);
    if (changes.length) await log(req.user.id, 'staff.update', 'staff', staff.id, changes.join('；'));
  });
  res.json(publicStaffRow(await db.prepare(`SELECT id,name,username,phone,status,job_type AS jobType,created_at AS createdAt
    FROM users WHERE id=?`).get(staff.id)));
});

routes.get('/api/dean/job-capabilities', auth, staffManagementOnly, async (_req, res) => {
  res.json(await capabilityMatrix(db));
});
routes.patch('/api/dean/job-capabilities', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { jobType, capability, enabled } = body;
  if (!JOB_TYPES.some(type => type.value === jobType)) throw new AppError(400, 'CAPABILITY_JOB_TYPE_INVALID', '岗位类型不正确');
  if (capability === MEDICAL_CAPABILITY) throw new AppError(400, 'CAPABILITY_FIXED', '医护建议权限固定，不能通过岗位开关授予');
  if (capability !== SUMMARY_CAPABILITY || typeof enabled !== 'boolean') {
    throw new AppError(400, 'CAPABILITY_UPDATE_INVALID', '只可调整运营汇总查看开关');
  }
  await transaction(async () => {
    const current = await db.prepare(`SELECT enabled FROM job_capability_settings WHERE job_type=? AND capability_key=?`).get(jobType, capability);
    if (current) {
      await db.prepare(`UPDATE job_capability_settings SET enabled=?,updated_by=?,updated_at=?
        WHERE job_type=? AND capability_key=?`).run(enabled ? 1 : 0, req.user.id, now(), jobType, capability);
    } else {
      await db.prepare(`INSERT INTO job_capability_settings(job_type,capability_key,enabled,updated_by,updated_at)
        VALUES(?,?,?,?,?)`).run(jobType, capability, enabled ? 1 : 0, req.user.id, now());
    }
    await log(req.user.id, 'job.capability.update', 'job_type', jobType, `${capability}=${enabled}`);
  });
  res.json(await capabilityMatrix(db));
});

routes.get('/api/dean/guests', auth, staffManagementOnly, async (req, res) => {
  const filter = queryString(req.query.status) || 'all';
  if (!['all', 'pending', 'in_house', 'checked_out'].includes(filter)) throw new AppError(400, 'STAY_FILTER_INVALID', '入住状态筛选条件不正确');
  const query = `%${queryString(req.query.q)}%`;
  const rows = await db.prepare(`SELECT u.id,u.name,u.username,u.phone,u.status,gp.room_no AS roomNo,
    gp.check_in AS checkIn,gp.check_out AS checkOut,gp.stay_plan AS stayPlan
    FROM users u LEFT JOIN guest_profiles gp ON gp.user_id=u.id
    WHERE u.role='guest' AND u.status='active'
      AND (u.name LIKE ? OR u.phone LIKE ? OR COALESCE(gp.room_no,'') LIKE ?)
    ORDER BY u.name,u.id`).all(query, query, query);
  const guests = rows.map(row => ({ ...row, stayStatus: stayStatus(row.checkIn, row.checkOut) }));
  res.json(filter === 'all' ? guests : guests.filter(guest => guest.stayStatus === filter));
});
routes.patch('/api/dean/guests/:id/stay', auth, staffManagementOnly, async (req, res) => {
  const guest = await requireGuestAccount(req.params.id);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const roomNo = typeof body.roomNo === 'string' ? body.roomNo.trim() : '';
  const checkIn = body.checkIn;
  const checkOut = body.checkOut;
  const stayPlan = body.stayPlan;
  if (!roomNo || roomNo.length > 32 || !isDateOnly(checkIn) || !isDateOnly(checkOut)) {
    throw new AppError(400, 'STAY_INPUT_INVALID', '请填写房间号和有效的入住、离店日期');
  }
  if (!['three_night', 'ten_night'].includes(stayPlan)) throw new AppError(400, 'STAY_PLAN_INVALID', '入住类别不正确');
  const nights = nightsBetween(checkIn, checkOut);
  const maximum = stayPlan === 'three_night' ? 3 : 10;
  if (!Number.isInteger(nights) || nights < 1) throw new AppError(400, 'STAY_DATE_RANGE_INVALID', '离店日期必须晚于入住日期，且至少住一晚');
  if (nights > maximum) throw new AppError(400, 'STAY_LIMIT_EXCEEDED', `${stayPlan === 'three_night' ? '3晚类别' : '10晚类别'}最多登记${maximum}晚`);
  const profile = await guestProfile(guest.id);
  if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  await transaction(async () => {
    await db.prepare(`UPDATE guest_profiles SET room_no=?,check_in=?,check_out=?,stay_plan=?,updated_at=? WHERE user_id=?`)
      .run(roomNo, checkIn, checkOut, stayPlan, now(), guest.id);
    await log(req.user.id, 'guest.stay.update', 'guest', guest.id, `更新入住登记：${roomNo} ${checkIn}—${checkOut}`);
  });
  res.json({ ...await guestSummary(guest.id), admissionStatus: stayStatus(checkIn, checkOut) });
});

routes.get('/api/dean/guests/:id/assignments', auth, staffManagementOnly, async (req, res) => {
  await requireGuestAccount(req.params.id);
  const rows = await db.prepare(`SELECT a.id,a.staff_id AS staffId,a.guest_id AS guestId,a.start_at AS startAt,
    a.end_at AS endAt,a.status,a.created_by AS createdBy,a.created_at AS createdAt,u.name AS staffName,
    u.username AS staffUsername,u.phone AS staffPhone,u.job_type AS jobType,u.status AS staffStatus
    FROM staff_guest_assignments a JOIN users u ON u.id=a.staff_id
    WHERE a.guest_id=? ORDER BY CASE WHEN a.status='active' THEN 0 ELSE 1 END,a.start_at DESC,a.id DESC`).all(req.params.id);
  res.json(rows.map(row => ({ ...row, jobType: row.jobType || 'clinician', jobTypeLabel: jobTypeLabel(row.jobType || 'clinician') })));
});
routes.post('/api/dean/guests/:id/assignments', auth, staffManagementOnly, async (req, res) => {
  const guest = await requireGuestAccount(req.params.id);
  const staffId = typeof req.body?.staffId === 'string' ? req.body.staffId : '';
  if (!staffId) throw new AppError(400, 'ASSIGNMENT_STAFF_REQUIRED', '请选择工作人员');
  const staff = await db.prepare(`SELECT id,name,job_type AS jobType,status FROM users WHERE id=? AND role='staff'`).get(staffId);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  if (staff.status !== 'active') throw new AppError(409, 'STAFF_INACTIVE', '已停用的工作人员不能建立新分工');
  const currentTime = now();
  const current = await db.prepare(`SELECT id FROM staff_guest_assignments
    WHERE staff_id=? AND guest_id=? AND status='active'
      AND (end_at IS NULL OR end_at>?) ORDER BY start_at DESC,id DESC LIMIT 1`).get(staff.id, guest.id, currentTime);
  if (current) throw new AppError(409, 'ASSIGNMENT_EXISTS', '该工作人员已负责此客人');
  const last = await db.prepare(`SELECT start_at FROM staff_guest_assignments WHERE staff_id=? AND guest_id=?
    ORDER BY start_at DESC,id DESC LIMIT 1`).get(staff.id, guest.id);
  const previousStart = last ? Date.parse(last.start_at) : 0;
  const baseStart = Date.parse(currentTime);
  const startAt = previousStart >= baseStart ? new Date(previousStart + 1).toISOString() : currentTime;
  let assignment;
  try {
    assignment = await transaction(async () => {
      const inserted = await db.prepare(`INSERT INTO staff_guest_assignments
        (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
        VALUES(?,?,?,NULL,'active',?,?,?)`).run(staff.id, guest.id, startAt, req.user.id, currentTime, currentTime);
      await log(req.user.id, 'assignment.create', 'guest', guest.id, `分配${jobTypeLabel(staff.jobType || 'clinician')} ${staff.name}`);
      return inserted;
    });
  } catch (error) {
    if (duplicateConstraint(error)) throw new AppError(409, 'ASSIGNMENT_EXISTS', '该工作人员与客人已有此开始时间的分工');
    throw error;
  }
  res.status(201).json({ id: Number(assignment.lastInsertRowid), staffId: staff.id, guestId: guest.id, startAt, status: 'active' });
});
routes.patch('/api/dean/guests/:guestId/assignments/:assignmentId', auth, staffManagementOnly, async (req, res) => {
  const guest = await requireGuestAccount(req.params.guestId);
  const assignmentId = Number(req.params.assignmentId);
  if (!Number.isSafeInteger(assignmentId) || assignmentId < 1) throw new AppError(400, 'ASSIGNMENT_ID_INVALID', '负责关系编号不正确');
  const assignment = await db.prepare(`SELECT id,staff_id AS staffId,status,start_at AS startAt FROM staff_guest_assignments
    WHERE id=? AND guest_id=?`).get(assignmentId, guest.id);
  if (!assignment) throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', '负责关系不存在');
  if (assignment.status !== 'active') throw new AppError(409, 'ASSIGNMENT_ALREADY_CLOSED', '该负责关系已经结束');
  const endedAt = new Date(Math.max(Date.parse(now()), Date.parse(assignment.startAt))).toISOString();
  await transaction(async () => {
    await db.prepare(`UPDATE staff_guest_assignments SET status='closed',end_at=?,updated_at=? WHERE id=?`)
      .run(endedAt, endedAt, assignmentId);
    await log(req.user.id, 'assignment.close', 'guest', guest.id, `结束工作人员 ${assignment.staffId} 的负责关系`);
  });
  res.json({ id: assignmentId, staffId: assignment.staffId, guestId: guest.id, status: 'closed', endAt: endedAt });
});
routes.get('/api/dean/staff/:id/logs', auth, deanOnly, async (req, res) => {
  const staff = await db.prepare("SELECT id,name,username,phone,status FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  const logs = await db.prepare('SELECT id,action,target_type AS targetType,target_id AS targetId,detail,created_at AS createdAt FROM audit_logs WHERE actor_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(req.params.id);
  const reviews = await db.prepare('SELECT id,content,created_at AS createdAt FROM staff_reviews WHERE staff_id=? AND dean_id=? ORDER BY created_at DESC,id DESC').all(req.params.id, req.user.id);
  res.json({ staff, logs, reviews });
});
routes.post('/api/dean/staff/:id/reviews', auth, deanOnly, async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const staff = await db.prepare("SELECT id FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  if (!content || content.length > 5000) throw new AppError(400, 'REVIEW_INVALID', '意见内容不能为空且不能超过 5000 个字符');
  const result = await transaction(async () => {
    const inserted = await db.prepare('INSERT INTO staff_reviews(staff_id,dean_id,content,created_at) VALUES(?,?,?,?)').run(req.params.id, req.user.id, content, now());
    await log(req.user.id, 'staff.review', 'staff', req.params.id, content);
    return inserted;
  });
  res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
});

routes.get('/api/staff/guests', auth, staffOnly, async (req, res) => {
  const scope = await accessibleGuestIds(req.user);
  const q = `%${queryString(req.query.q)}%`;
  if (!scope.length) return res.json([]);
  const placeholders = scope.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT u.id,u.name,u.phone,gp.room_no AS roomNo,gp.check_in AS checkIn,gp.check_out AS checkOut,
    gp.chronic_json AS chronicJson,gp.allergies_json AS allergiesJson
    FROM users u LEFT JOIN guest_profiles gp ON gp.user_id=u.id
    WHERE u.role='guest' AND u.status='active' AND u.id IN (${placeholders})
      AND (u.name LIKE ? OR COALESCE(gp.room_no,'') LIKE ?) ORDER BY u.name`).all(...scope, q, q);
  res.json(rows.map(row => ({
    ...row,
    chronic: jsonArray(row.chronicJson || '[]'),
    allergies: jsonArray(row.allergiesJson || '[]'),
    chronicJson: undefined,
    allergiesJson: undefined
  })));
});
routes.get('/api/staff/guests/:id', auth, staffOnly, async (req, res) => {
  await authorizeGuestAccess(req.user, req.params.id);
  const guest = await guestSummary(req.params.id);
  if (!guest) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  await log(req.user.id, 'guest.view', 'guest', req.params.id, '查看客人档案');
  res.json(guest);
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

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.parse.failed') return sendError(res, new AppError(400, 'INVALID_JSON', '请求体不是有效 JSON'));
  if (!(error instanceof AppError)) console.error(error);
  return sendError(res, error);
});

export { app };
export default app;
