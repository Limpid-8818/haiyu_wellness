// G43：路由层共享中间件与助手，自 app.js 纯搬运；行为不变。
import crypto from 'node:crypto';
import { readToken } from '../auth.js';
import { authorizeGuestAccess } from '../authorization.js';
import { db, guestProfile, json, publicUser } from '../db.js';
import { AppError } from '../errors.js';
import { effectiveHealthConstraints, healthProfileCompleteness, normalizeHealthProfile } from '../health-profile.js';
import { capabilitiesFor, canManageStaff, jobTypeFor, jobTypeLabel } from '../staffing.js';

export const routeHandler = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);

export async function auth(req, _res, next) {
  const header = req.headers.authorization;
  const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
  const payload = readToken(token);
  if (!payload) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
  const user = await db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(payload.sub);
  if (!user) throw new AppError(401, 'ACCOUNT_INACTIVE', '账号不存在或已停用');
  // G11：令牌版本不匹配说明密码已更改或凭证已被吊销。
  if (Number(payload.ver ?? 0) !== Number(user.token_version ?? 0)) {
    throw new AppError(401, 'AUTH_TOKEN_REVOKED', '登录凭证已失效，请重新登录');
  }
  req.user = user;
  next();
}

export async function optionalAuth(req, _res, next) {
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
  if (Number(payload.ver ?? 0) !== Number(req.user.token_version ?? 0)) {
    throw new AppError(401, 'AUTH_TOKEN_REVOKED', '登录凭证已失效，请重新登录');
  }
  next();
}

export function staffOnly(req, _res, next) {
  return ['staff', 'dean'].includes(req.user.role)
    ? next()
    : next(new AppError(403, 'ROLE_FORBIDDEN', '仅工作人员可访问'));
}

export function deanOnly(req, _res, next) {
  return req.user.role === 'dean'
    ? next()
    : next(new AppError(403, 'ROLE_FORBIDDEN', '仅院长可访问'));
}

export function staffManagementOnly(req, _res, next) {
  return canManageStaff(req.user)
    ? next()
    : next(new AppError(403, 'CAPABILITY_FORBIDDEN', '当前岗位无权管理员工'));
}

export async function clinicianOnly(req, _res, next) {
  const capabilities = await capabilitiesFor(db, req.user);
  return capabilities.medicalAdvicePublish
    ? next()
    : next(new AppError(403, 'CLINICIAN_REQUIRED', '仅医护岗位可处理疗程审核'));
}

export function dietitianOnly(req, _res, next) {
  return req.user.role === 'staff' && jobTypeFor(req.user) === 'dietitian'
    ? next()
    : next(new AppError(403, 'DIETITIAN_REQUIRED', '仅配餐员可访问备餐工作台'));
}

export async function operationsSummaryOnly(req, _res, next) {
  const capabilities = await capabilitiesFor(db, req.user);
  return capabilities.operationsSummaryView
    ? next()
    : next(new AppError(403, 'CAPABILITY_FORBIDDEN', '当前岗位未获查看运营汇总的权限'));
}

export function publicStaffRow(row) {
  const jobType = row.jobType ?? row.job_type ?? 'clinician';
  return {
    ...row,
    jobType,
    jobTypeLabel: jobTypeLabel(jobType),
    role: 'staff'
  };
}

export async function requireGuestAccount(guestId) {
  const row = await db.prepare(`SELECT id,name,username,phone,status FROM users
    WHERE id=? AND role='guest'`).get(guestId);
  if (!row) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  if (row.status !== 'active') throw new AppError(409, 'GUEST_INACTIVE', '客人账号已停用');
  return row;
}

export function safeUser(user) { return publicUser(user); }

export function queryString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function requireGuestRole(user) {
  if (user.role !== 'guest') throw new AppError(403, 'GUEST_ONLY', '仅客人可提交个人健康自述');
}

export function normalizeIntake(row) {
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

export async function healthIntakeHistory(guestId, { pendingOnly = false } = {}) {
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

export async function healthProfileState(guestId) {
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

export function healthIntakeFingerprint(profile, baseProfileVersion) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ baseProfileVersion, profile }))
    .digest('hex');
}

export function jsonArray(value) {
  const parsed = json(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function requestedGuestId(req) {
  if (req.user.role === 'guest') return req.query.guestId ?? req.user.id;
  return req.query.guestId;
}

export async function authorizeQueryGuest(req) {
  const guestId = requestedGuestId(req);
  return await authorizeGuestAccess(req.user, guestId);
}
