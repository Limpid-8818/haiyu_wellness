// G47：助手会话与身份模块，自 assistant.js 纯搬运；行为不变。
import crypto from 'node:crypto';
import { isRealCalendarDate } from './assistant-tools.js';
import { authorizeGuestAccess } from './authorization.js';
import { sessionTtlMs } from './assistant-config.js';
import { db, guestSummary, json, log, now, transaction } from './db.js';
import { AppError } from './errors.js';
import { publicHealthRecord } from './health-metrics.js';
import { effectiveHealthConstraints, recommendationHealthContext } from './health-profile.js';

export const rolePrompts = {
  public: `你是海屿康养社区的接待助手。帮助访客了解康养服务和选择客人、工作人员或院长入口。每次只问一个简短问题，不收集身份证号、银行卡等敏感信息，不作医疗诊断。`,
  guest: `你是面向康养客人的健康支持助手。通过温和、易懂的方式逐步了解客人的近期身体感受、慢病、用药、过敏、睡眠、行动能力和康养目标。每次最多问两个问题。你可以提供一般性健康教育和就医提醒，但不能自称医生、不能诊断或调整处方。出现胸痛、呼吸困难、意识异常、严重出血等危险信号时，明确建议立即联系现场医护或急救。`,
  staff: `你是康养机构工作人员的工作助手。根据客人档案和工作人员输入的观察，帮助归纳重点、识别需要人工关注的风险、生成随访问题、交接摘要和医嘱草稿。不得自动发布医嘱，不得替代医护人员判断。输出应可执行、可追溯，并指出信息缺口。`,
  dean: `你是康养机构院长的管理助手。根据工作人员工作记录，帮助总结服务量、流程问题、风险和改进建议，辅助起草评价意见。不得虚构未提供的数据。`
};
export const validRoles = new Set(Object.keys(rolePrompts));

export function resolveRole(user, requestedRole) {
  const role = requestedRole === undefined || requestedRole === null || requestedRole === ''
    ? (user?.role || 'public')
    : requestedRole;
  if (typeof role !== 'string' || !validRoles.has(role)) {
    throw new AppError(400, 'ASSISTANT_ROLE_INVALID', '助手身份不正确');
  }
  if (user && role !== user.role) {
    throw new AppError(403, 'ASSISTANT_ROLE_FORBIDDEN', '助手身份与当前登录身份不匹配');
  }
  if (!user && role !== 'public') {
    throw new AppError(403, 'ASSISTANT_ROLE_FORBIDDEN', '未登录用户只能使用公开助手');
  }
  return role;
}

export function normalizeRequestedGuestId(guestId) {
  if (guestId === undefined || guestId === null) return undefined;
  if (typeof guestId !== 'string' || !guestId.trim() || guestId.length > 128) {
    throw new AppError(400, 'GUEST_ID_INVALID', '客人编号格式不正确');
  }
  return guestId;
}

export function sessionIdFromClient(sessionId) {
  if (sessionId === undefined || sessionId === null || sessionId === '') return null;
  if (typeof sessionId !== 'string' || !/^as_[0-9a-f-]{36}$/.test(sessionId)) {
    throw new AppError(404, 'ASSISTANT_SESSION_NOT_FOUND', '助手会话不存在');
  }
  return sessionId;
}

export function newSessionId() {
  return `as_${crypto.randomUUID()}`;
}

export async function roleContextForNewSession(user, role, requestedGuestId) {
  if (role === 'guest') {
    // A guest's context is always its own account, even if the client sends a
    // different guestId. authorizeGuestAccess turns that attempt into 403.
    if (requestedGuestId !== undefined) await authorizeGuestAccess(user, requestedGuestId);
    await authorizeGuestAccess(user, user.id);
    return user.id;
  }
  if (requestedGuestId === undefined) return null;
  return (await authorizeGuestAccess(user, requestedGuestId)).id;
}

export function assertSessionOwner(row, user, role) {
  const userId = user?.id || null;
  if (row.user_id !== userId || row.assistant_role !== role) {
    throw new AppError(403, 'ASSISTANT_SESSION_FORBIDDEN', '无权访问该助手会话');
  }
}

export async function assertSessionStatus(row) {
  if (row.status !== 'active') {
    throw new AppError(409, 'ASSISTANT_SESSION_INACTIVE', '助手会话已关闭或已过期，请新建会话');
  }
  if (row.expires_at && row.expires_at <= now()) {
    await db.prepare("UPDATE assistant_sessions SET status='expired' WHERE id=? AND status='active'").run(row.id);
    throw new AppError(409, 'ASSISTANT_SESSION_INACTIVE', '助手会话已关闭或已过期，请新建会话');
  }
}

export async function contextForExistingSession(row, user, role, requestedGuestId) {
  if (role === 'guest') {
    if (requestedGuestId !== undefined) await authorizeGuestAccess(user, requestedGuestId);
    await authorizeGuestAccess(user, user.id);
    if (row.related_guest_id !== user.id) {
      throw new AppError(409, 'ASSISTANT_GUEST_CONTEXT_MISMATCH', '会话关联客人不匹配，请新建会话');
    }
    return user.id;
  }

  if (requestedGuestId !== undefined) {
    const guest = await authorizeGuestAccess(user, requestedGuestId);
    if (row.related_guest_id !== guest.id) {
      throw new AppError(409, 'ASSISTANT_GUEST_CONTEXT_MISMATCH', '会话关联客人不匹配，请新建会话');
    }
    return guest.id;
  }
  if (row.related_guest_id) {
    await authorizeGuestAccess(user, row.related_guest_id);
    return row.related_guest_id;
  }
  return null;
}

export async function getOrCreateSession({ user, role, sessionId, guestId }) {
  const requestedSessionId = sessionIdFromClient(sessionId);
  const requestedGuestId = normalizeRequestedGuestId(guestId);
  if (requestedSessionId) {
    const row = await db.prepare('SELECT * FROM assistant_sessions WHERE id=?').get(requestedSessionId);
    if (!row) throw new AppError(404, 'ASSISTANT_SESSION_NOT_FOUND', '助手会话不存在');
    assertSessionOwner(row, user, role);
    await assertSessionStatus(row);
    const relatedGuestId = await contextForExistingSession(row, user, role, requestedGuestId);
    return { row, relatedGuestId };
  }

  const relatedGuestId = await roleContextForNewSession(user, role, requestedGuestId);
  const id = newSessionId();
  const timestamp = now();
  const expiresAt = new Date(Date.parse(now()) + sessionTtlMs).toISOString();
  await db.prepare(`INSERT INTO assistant_sessions
    (id,user_id,assistant_role,related_guest_id,status,started_at,last_message_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, user?.id || null, role, relatedGuestId, 'active', timestamp, timestamp, expiresAt);
  const row = await db.prepare('SELECT * FROM assistant_sessions WHERE id=?').get(id);
  return { row, relatedGuestId };
}

export async function modelGuestContext(guestId) {
  if (!guestId) return '';
  const summary = await guestSummary(guestId);
  if (!summary) return '';
  const profile = summary.profile || {};
  const pendingRows = await db.prepare(`SELECT id,source,structured_json FROM health_intakes
    WHERE guest_id=? AND status='pending' ORDER BY revision DESC`).all(guestId);
  const constraints = effectiveHealthConstraints({
    verified: profile.health_profile,
    pendingIntakes: pendingRows.map(row => ({
      id: row.id,
      source: row.source,
      profile: json(row.structured_json, {})
    })),
    legacyAllergies: profile.allergies
  });
  // Deliberately omit name, phone, room number, birth date and emergency contact.
  // These fields are not needed for drafting general guidance and must not be sent
  // to an external model endpoint.
  const recentHealth = (summary.health || []).map(publicHealthRecord)
    .filter(item => item.parseStatus === 'valid' && item.values).slice(0, 5)
    .map(item => ({ type: item.type, value: item.values, unit: item.unit, note: item.note, recordedAt: item.recordedAt }));
  const context = {
    chronic: Array.isArray(profile.chronic) ? profile.chronic : [],
    allergies: Array.isArray(profile.allergies) ? profile.allergies : [],
    ...recommendationHealthContext(constraints),
    mobility: profile.mobility || '',
    recentHealth,
    activeAdvice: (summary.advice || []).slice(0, 5).map(item => ({
      title: item.title,
      content: item.content,
      priority: item.priority
    }))
  };
  return `\n授权业务上下文（不含直接身份标识）：${JSON.stringify(context)}`;
}

export function validateText(text) {
  if (typeof text !== 'string') throw new AppError(400, 'ASSISTANT_TEXT_INVALID', '咨询内容必须是文本');
  const value = text.trim();
  if (!value) throw new AppError(400, 'ASSISTANT_TEXT_REQUIRED', '请输入你想咨询的内容');
  if (value.length > 4000) throw new AppError(400, 'ASSISTANT_TEXT_TOO_LONG', '咨询内容不能超过 4000 个字符');
  return value;
}

export function normalizedClientRequestId(value) {
  if (value === undefined || value === null || value === '') return crypto.randomUUID();
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new AppError(400, 'ASSISTANT_REQUEST_ID_INVALID', '请求编号格式不正确');
  }
  return value;
}

export async function recordGuestHealthIntake({ user, sessionId, text }) {
  if (user?.role !== 'guest' || !/慢病|用药|过敏|睡眠|血压|疼|不适|康复/.test(text)) return;
  await transaction(async () => {
    await db.prepare('UPDATE guest_profiles SET health_profile_version=health_profile_version WHERE user_id=?').run(user.id);
    const profile = await db.prepare('SELECT health_profile_version AS profileVersion FROM guest_profiles WHERE user_id=?').get(user.id);
    const revisionRow = await db.prepare('SELECT COALESCE(MAX(revision),0) AS revision FROM health_intakes WHERE guest_id=?').get(user.id);
    const revision = Number(revisionRow?.revision || 0) + 1;
    const timestamp = now();
    await db.prepare(`INSERT INTO health_intakes
      (guest_id,session_id,content,source,created_at,submitted_by,base_profile_version,revision)
      VALUES(?,?,?,'assistant',?,?,?,?)`)
      .run(user.id, sessionId, text, timestamp, user.id, Number(profile?.profileVersion || 0), revision);
    await log(user.id, 'assistant.health_intake', 'guest', user.id, '客人通过健康助手补充情况');
  });
}

export function appointmentClarificationState(history) {
  const userText = history.filter(item => item.role === 'user').map(item => item.content).join('\n');
  if (!/(?:我想|我要|幫我|帮我|希望|想要).{0,8}(?:预约|預約|预订|預訂|报名|報名|参加|參加)/u.test(userText)) return null;
  const projectFound = /SPA|水疗|水療|温泉|溫泉|海水浴|康复|復康|疗愈|療癒|瑜伽/i.test(userText);
  const dates = userText.match(/\b\d{4}-\d{2}-\d{2}\b/g) || [];
  const date = dates.at(-1) || null;
  const dateFound = isRealCalendarDate(date);
  const missingFields = [];
  if (!projectFound) missingFields.push('项目');
  if (!dateFound) missingFields.push('有效日期');
  return { flow: 'appointment', projectFound, date: dateFound ? date : null, missingFields };
}
