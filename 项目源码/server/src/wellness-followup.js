import { db, hasActiveTransaction, id, log, now, transaction } from './db.js';
import { AppError } from './errors.js';
import { systemBusinessClock } from './clock.js';
import {checkinAvailability} from '../../shared/release-presentation.js';

const FEELINGS = new Set(['comfortable', 'general', 'uncomfortable']);
const lockSuffix = () => db.driver === 'mysql' ? ' FOR UPDATE' : '';

function jsonValue(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function dateText(value) { return String(value ?? '').slice(0, 10); }

function parseInstant(value) {
  if (value instanceof Date) return value.getTime();
  let input = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(input)) input = `${input.replace(' ', 'T')}Z`;
  const parsed = Date.parse(input);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function feedbackInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'WELLNESS_FEEDBACK_BODY_INVALID', '反馈请求必须是对象');
  }
  const unknown = Object.keys(body).filter(key => !['feeling', 'note'].includes(key));
  if (unknown.length) throw new AppError(400, 'WELLNESS_FEEDBACK_FIELD_NOT_ALLOWED', '反馈请求包含不允许的字段', { fields: unknown });
  if (!FEELINGS.has(body.feeling)) throw new AppError(400, 'WELLNESS_FEELING_INVALID', '请选择舒服、一般或不舒服');
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.trim().length > 500)) {
    throw new AppError(400, 'WELLNESS_FEEDBACK_NOTE_INVALID', '补充说明不能超过 500 个字符');
  }
  return { feeling: body.feeling, note: (body.note || '').trim() };
}

function publicFeedback(row, revisions = []) {
  if (!row) return null;
  return {
    id: row.id, guestId: row.guestId ?? row.guest_id,
    reservationId: row.reservationId ?? row.reservation_id,
    checkinId: row.checkinId ?? row.checkin_id,
    feeling: row.feeling, note: row.note || '', revision: Number(row.revision),
    businessDate: dateText(row.businessDate ?? row.business_date),
    createdAt: row.createdAt ?? row.created_at, updatedAt: row.updatedAt ?? row.updated_at,
    revisions: revisions.map(item => ({ id: item.id, revision: Number(item.revision), feeling: item.feeling,
      note: item.note || '', businessDate: dateText(item.businessDate ?? item.business_date),
      createdAt: item.createdAt ?? item.created_at }))
  };
}

export async function recordReplanSourceEvent({ guestId, sourceType, sourceId, sourceVersion = 1,
  sourceLabel, sourceSnapshot, triggerReason = '', requiresAttention = false }) {
  if (!['feedback', 'health_metric', 'mood'].includes(sourceType)) throw new Error(`unsupported replan source type: ${sourceType}`);
  if (!Number.isSafeInteger(Number(sourceVersion)) || Number(sourceVersion) < 1) throw new Error('source version must be a positive integer');
  const persist = async () => {
    const existing = await db.prepare(`SELECT * FROM wellness_replan_events
      WHERE guest_id=? AND source_type=? AND source_id=? AND source_version=?`).get(
      guestId, sourceType, String(sourceId), Number(sourceVersion));
    if (existing) return existing;
    const stamp = now();
    const eventId = id('replan');
    try {
      await db.prepare(`INSERT INTO wellness_replan_events
        (id,guest_id,source_type,source_id,source_version,source_label,source_snapshot_json,trigger_reason,
         requires_attention,status,baseline_draft_id,candidate_draft_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,'recorded',NULL,NULL,?,?)`).run(
        eventId, guestId, sourceType, String(sourceId), Number(sourceVersion), String(sourceLabel || '').slice(0, 256),
        JSON.stringify(sourceSnapshot || {}), String(triggerReason || '').slice(0, 1000), requiresAttention ? 1 : 0, stamp, stamp
      );
    } catch (error) {
      if (!/unique|duplicate/i.test(`${error.code || ''} ${error.message || ''}`)) throw error;
      const raced = await db.prepare(`SELECT * FROM wellness_replan_events
        WHERE guest_id=? AND source_type=? AND source_id=? AND source_version=?`).get(
        guestId, sourceType, String(sourceId), Number(sourceVersion));
      if (raced) return raced;
      throw error;
    }
    return await db.prepare('SELECT * FROM wellness_replan_events WHERE id=?').get(eventId);
  };
  return hasActiveTransaction() ? persist() : transaction(persist);
}

async function reservationForGuest(guestId, reservationId, forUpdate = false) {
  return await db.prepare(`SELECT r.id AS reservationId,r.guest_id AS guestId,r.status AS reservationStatus,
      s.id AS slotId,s.business_date AS businessDate,s.starts_at AS startsAt,s.ends_at AS endsAt,
      s.local_start AS localStart,s.local_end AS localEnd,p.name AS projectName,p.location
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
    WHERE r.id=? AND r.guest_id=?${forUpdate ? lockSuffix() : ''}`).get(reservationId, guestId);
}

export async function listGuestCheckins(guestId) {
  const rows = await db.prepare(`SELECT r.id AS reservationId,r.status AS reservationStatus,
      s.business_date AS businessDate,s.starts_at AS startsAt,s.ends_at AS endsAt,
      s.local_start AS localStart,s.local_end AS localEnd,p.name AS projectName,p.location,
      c.id AS checkinId,c.checked_in_at AS checkedInAt,c.business_date AS checkedInBusinessDate,
      f.id AS feedbackId,f.feeling,f.note AS feedbackNote,f.revision AS feedbackRevision,
      f.business_date AS feedbackBusinessDate,f.created_at AS feedbackCreatedAt,f.updated_at AS feedbackUpdatedAt,
      a.status AS attendanceStatus
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
    LEFT JOIN wellness_checkins c ON c.reservation_id=r.id
    LEFT JOIN wellness_feedback f ON f.reservation_id=r.id
    LEFT JOIN stage26_reservation_checkins a ON a.reservation_id=r.id
    WHERE r.guest_id=? ORDER BY s.starts_at DESC,r.id DESC LIMIT 100`).all(guestId);
  const items = [];
  for (const row of rows) {
    let feedback = null;
    if (row.feedbackId) {
      const revisions = await db.prepare(`SELECT id,revision,feeling,note,business_date AS businessDate,created_at AS createdAt
        FROM wellness_feedback_revisions WHERE feedback_id=? ORDER BY revision`).all(row.feedbackId);
      feedback = publicFeedback({ id: row.feedbackId, guestId, reservationId: row.reservationId,
        checkinId: row.checkinId, feeling: row.feeling, note: row.feedbackNote, revision: row.feedbackRevision,
        businessDate: row.feedbackBusinessDate, createdAt: row.feedbackCreatedAt, updatedAt: row.feedbackUpdatedAt }, revisions);
    }
    const reservationStatus=row.attendanceStatus === 'no_show' ? 'no_show' : row.reservationStatus;
    const window=checkinAvailability({reservationStatus,startsAt:row.startsAt,checkin:row.checkinId},systemBusinessClock.utc());
    items.push({ ...window, serverNow:systemBusinessClock.utc(), reservationId: row.reservationId, reservationStatus,
      businessDate: dateText(row.businessDate),
      startsAt: Number.isFinite(parseInstant(row.startsAt)) ? new Date(parseInstant(row.startsAt)).toISOString() : row.startsAt,
      endsAt: Number.isFinite(parseInstant(row.endsAt)) ? new Date(parseInstant(row.endsAt)).toISOString() : row.endsAt,
      localStart: row.localStart, localEnd: row.localEnd, projectName: row.projectName, location: row.location,
      checkin: row.checkinId ? { id: row.checkinId, checkedInAt: row.checkedInAt,
        businessDate: dateText(row.checkedInBusinessDate) } : null,
      feedback, executions: await (await import('./service-execution.js')).reservationExecutions(row.reservationId) });
  }
  return { items, total: items.length };
}

export async function createGuestCheckin({ guestId, reservationId, clock = systemBusinessClock }) {
  if (typeof reservationId !== 'string' || !reservationId.trim() || reservationId.length > 64) {
    throw new AppError(400, 'RESERVATION_ID_INVALID', '预约编号格式不正确');
  }
  return await transaction(async () => {
    const reservation = await reservationForGuest(guestId, reservationId, true);
    if (!reservation) throw new AppError(404, 'RESERVATION_NOT_FOUND', '没有找到本人预约');
    const attendance = await db.prepare('SELECT status FROM stage26_reservation_checkins WHERE reservation_id=?').get(reservationId);
    if (attendance?.status === 'no_show') throw new AppError(409, 'CHECKIN_NO_SHOW_RECORDED', '该预约已登记未参加，请联系负责人员核对，不能重新签到');
    const existing = await db.prepare(`SELECT id,guest_id AS guestId,reservation_id AS reservationId,
      business_date AS businessDate,checked_in_at AS checkedInAt,created_at AS createdAt
      FROM wellness_checkins WHERE reservation_id=?`).get(reservationId);
    if (existing) return { ...existing, businessDate: dateText(existing.businessDate), replayed: true };
    if (reservation.reservationStatus !== 'confirmed') {
      throw new AppError(409, 'CHECKIN_RESERVATION_INACTIVE', '已取消的预约不能签到');
    }
    const start = parseInstant(reservation.startsAt);
    if (!Number.isFinite(start)) throw new AppError(409, 'CHECKIN_START_TIME_INVALID', '预约开始时间无法核验，请联系工作人员');
    if (clock.instant().getTime() < start) {
      throw new AppError(409, 'CHECKIN_TOO_EARLY', '项目尚未开始，开始后再签到', {
        reservationId, startsAt: reservation.startsAt, businessDate: dateText(reservation.businessDate)
      });
    }
    const stamp = now();
    const checkinId = id('checkin');
    await db.prepare(`INSERT INTO wellness_checkins(id,guest_id,reservation_id,business_date,checked_in_at,created_at)
      VALUES(?,?,?,?,?,?)`).run(checkinId, guestId, reservationId, clock.dateKey(), stamp, stamp);
    await log(guestId, 'wellness.checkin.create', 'reservation', reservationId,
      `预约 ${reservationId} · ${reservation.projectName} · 实际签到 ${checkinId}`);
    return { id: checkinId, guestId, reservationId, businessDate: clock.dateKey(), checkedInAt: stamp, replayed: false };
  });
}

async function feedbackRevisionSnapshot({ guestId, feedbackId, revision, feeling, note, businessDate, stamp }) {
  await db.prepare(`INSERT INTO wellness_feedback_revisions
    (id,feedback_id,revision,feeling,note,business_date,created_at) VALUES(?,?,?,?,?,?,?)`)
    .run(id('feedback_rev'), feedbackId, revision, feeling, note, businessDate, stamp);
  await recordReplanSourceEvent({ guestId, sourceType: 'feedback', sourceId: feedbackId, sourceVersion: revision,
    sourceLabel: `项目反馈第 ${revision} 版`, sourceSnapshot: { feeling, note, businessDate, feedbackId },
    triggerReason: feeling === 'uncomfortable' ? '客人报告项目后不适，需要人工核对反馈和当前疗程。' : '',
    requiresAttention: feeling === 'uncomfortable' });
}

export async function createGuestFeedback({ guestId, reservationId, body, clock = systemBusinessClock }) {
  const input = feedbackInput(body);
  return await transaction(async () => {
    const reservation = await reservationForGuest(guestId, reservationId, true);
    if (!reservation) throw new AppError(404, 'RESERVATION_NOT_FOUND', '没有找到本人预约');
    const checkin = await db.prepare(`SELECT id FROM wellness_checkins WHERE reservation_id=? AND guest_id=?${lockSuffix()}`)
      .get(reservationId, guestId);
    if (!checkin) throw new AppError(409, 'FEEDBACK_CHECKIN_REQUIRED', '请先完成本人预约签到，再提交项目感受');
    const existing = await db.prepare('SELECT * FROM wellness_feedback WHERE reservation_id=?').get(reservationId);
    if (existing) {
      const revisions = await db.prepare(`SELECT id,revision,feeling,note,business_date AS businessDate,created_at AS createdAt
        FROM wellness_feedback_revisions WHERE feedback_id=? ORDER BY revision`).all(existing.id);
      return { ...publicFeedback(existing, revisions), replayed: true };
    }
    const stamp = now();
    const feedbackId = id('feedback');
    const businessDate = clock.dateKey();
    await db.prepare(`INSERT INTO wellness_feedback
      (id,guest_id,reservation_id,checkin_id,feeling,note,revision,business_date,created_at,updated_at)
      VALUES(?,?,?,?,?,?,1,?,?,?)`).run(feedbackId, guestId, reservationId, checkin.id,
      input.feeling, input.note, businessDate, stamp, stamp);
    await feedbackRevisionSnapshot({ guestId, feedbackId, revision: 1, ...input, businessDate, stamp });
    await log(guestId, 'wellness.feedback.create', 'reservation', reservationId,
      `预约 ${reservationId} 的项目反馈已保存为第 1 版`);
    return { id: feedbackId, guestId, reservationId, checkinId: checkin.id, ...input,
      revision: 1, businessDate, createdAt: stamp, updatedAt: stamp,
      revisions: [{ id: null, revision: 1, ...input, businessDate, createdAt: stamp }], replayed: false };
  });
}

export async function updateGuestFeedback({ guestId, feedbackId, body, clock = systemBusinessClock }) {
  if (typeof feedbackId !== 'string' || !feedbackId.trim() || feedbackId.length > 64) {
    throw new AppError(400, 'WELLNESS_FEEDBACK_ID_INVALID', '反馈编号格式不正确');
  }
  const input = feedbackInput(body);
  return await transaction(async () => {
    const current = await db.prepare(`SELECT * FROM wellness_feedback WHERE id=? AND guest_id=?${lockSuffix()}`)
      .get(feedbackId, guestId);
    if (!current) throw new AppError(404, 'WELLNESS_FEEDBACK_NOT_FOUND', '本人反馈不存在');
    const businessDate = dateText(current.business_date);
    if (businessDate !== clock.dateKey()) {
      throw new AppError(409, 'WELLNESS_FEEDBACK_EDIT_WINDOW_CLOSED', '反馈只可在上海时间提交当天修改');
    }
    const stamp = now();
    const revision = Number(current.revision) + 1;
    const update = await db.prepare(`UPDATE wellness_feedback SET feeling=?,note=?,revision=?,updated_at=?
      WHERE id=? AND guest_id=? AND revision=?`).run(input.feeling, input.note, revision, stamp,
      feedbackId, guestId, current.revision);
    if (!update.changes) throw new AppError(409, 'WELLNESS_FEEDBACK_CHANGED', '反馈已变化，请刷新后再修改');
    await feedbackRevisionSnapshot({ guestId, feedbackId, revision, ...input, businessDate, stamp });
    await log(guestId, 'wellness.feedback.update', 'reservation', current.reservation_id,
      `预约 ${current.reservation_id} 的项目反馈更正为第 ${revision} 版`);
    const revisions = await db.prepare(`SELECT id,revision,feeling,note,business_date AS businessDate,created_at AS createdAt
      FROM wellness_feedback_revisions WHERE feedback_id=? ORDER BY revision`).all(feedbackId);
    const fresh = await db.prepare('SELECT * FROM wellness_feedback WHERE id=?').get(feedbackId);
    return publicFeedback(fresh, revisions);
  });
}

function itemKey(item) {
  return [item.businessDate, item.slotKey, item.type].join('|');
}

function itemComparable(item) {
  return JSON.stringify({ candidateId: item.candidateId || null, title: item.title, localStart: item.localStart || null,
    localEnd: item.localEnd || null, status: item.status, location: item.location || null });
}

function planDiff(before, after) {
  const oldItems = before?.items || [];
  const newItems = after?.items || [];
  const oldByKey = new Map(oldItems.map(item => [itemKey(item), item]));
  const newByKey = new Map(newItems.map(item => [itemKey(item), item]));
  const changes = [];
  for (const [key, oldItem] of oldByKey) {
    const newItem = newByKey.get(key);
    if (!newItem) changes.push({ kind: 'removed', key, original: oldItem, candidate: null });
    else if (itemComparable(oldItem) !== itemComparable(newItem)) {
      changes.push({ kind: 'changed', key, original: oldItem, candidate: newItem });
    }
  }
  for (const [key, newItem] of newByKey) if (!oldByKey.has(key)) {
    changes.push({ kind: 'added', key, original: null, candidate: newItem });
  }
  return changes;
}

async function replanEventRow(guestId, eventId) {
  return await db.prepare(`SELECT id,guest_id AS guestId,source_type AS sourceType,source_id AS sourceId,
    source_version AS sourceVersion,source_label AS sourceLabel,source_snapshot_json AS sourceSnapshotJson,
    trigger_reason AS triggerReason,requires_attention AS requiresAttention,status,
    baseline_draft_id AS baselineDraftId,candidate_draft_id AS candidateDraftId,
    created_at AS createdAt,updated_at AS updatedAt
    FROM wellness_replan_events WHERE id=? AND guest_id=?`).get(eventId, guestId);
}

export async function getReplanEventDetail(guestId, eventId) {
  const { getWellnessDraft } = await import('./wellness-planner.js');
  const row = await replanEventRow(guestId, eventId);
  if (!row) throw new AppError(404, 'WELLNESS_REPLAN_EVENT_NOT_FOUND', '重规划来源记录不存在');
  const baseline = row.baselineDraftId ? await getWellnessDraft(guestId, row.baselineDraftId).catch(() => null) : null;
  const candidate = row.candidateDraftId ? await getWellnessDraft(guestId, row.candidateDraftId).catch(() => null) : null;
  const activeReservations = row.baselineDraftId ? await db.prepare(`SELECT id,slot_id AS slotId,status
    FROM reservations WHERE wellness_draft_id=? AND status='confirmed' ORDER BY id`).all(row.baselineDraftId) : [];
  const event = { ...row, sourceVersion: Number(row.sourceVersion), requiresAttention: Boolean(row.requiresAttention),
    sourceSnapshot: jsonValue(row.sourceSnapshotJson), baseline, candidate,
    candidateStatus: candidate?.reviewStatus || null, activeReservations,
    changes: planDiff(baseline, candidate) };
  if (candidate?.reviewStatus === 'active' || candidate?.reviewStatus === 'auto_activated') event.status = 'active';
  else if (candidate?.reviewStatus === 'pending_review') event.status = 'pending_review';
  delete event.sourceSnapshotJson;
  return event;
}

export async function listReplanEvents(guestId) {
  // G24：一次性取回事件全行（不再逐条回查 id），同一草案在多条来源事件间复用
  // getWellnessDraft 的原有逻辑按 draftId 记忆化，避免重复加载同一草案。
  const { getWellnessDraft } = await import('./wellness-planner.js');
  const rows = await db.prepare(`SELECT id,guest_id AS guestId,source_type AS sourceType,source_id AS sourceId,
    source_version AS sourceVersion,source_label AS sourceLabel,source_snapshot_json AS sourceSnapshotJson,
    trigger_reason AS triggerReason,requires_attention AS requiresAttention,status,
    baseline_draft_id AS baselineDraftId,candidate_draft_id AS candidateDraftId,
    created_at AS createdAt,updated_at AS updatedAt
    FROM wellness_replan_events WHERE guest_id=? ORDER BY created_at DESC,id DESC LIMIT 100`).all(guestId);
  const draftCache = new Map();
  const loadDraft = draftId => {
    if (!draftCache.has(draftId)) draftCache.set(draftId, getWellnessDraft(guestId, draftId).catch(() => null));
    return draftCache.get(draftId);
  };
  const items = [];
  for (const row of rows) {
    const baseline = row.baselineDraftId ? await loadDraft(row.baselineDraftId) : null;
    const candidate = row.candidateDraftId ? await loadDraft(row.candidateDraftId) : null;
    const activeReservations = row.baselineDraftId ? await db.prepare(`SELECT id,slot_id AS slotId,status
      FROM reservations WHERE wellness_draft_id=? AND status='confirmed' ORDER BY id`).all(row.baselineDraftId) : [];
    const event = { ...row, sourceVersion: Number(row.sourceVersion), requiresAttention: Boolean(row.requiresAttention),
      sourceSnapshot: jsonValue(row.sourceSnapshotJson), baseline, candidate,
      candidateStatus: candidate?.reviewStatus || null, activeReservations,
      changes: planDiff(baseline, candidate) };
    if (candidate?.reviewStatus === 'active' || candidate?.reviewStatus === 'auto_activated') event.status = 'active';
    else if (candidate?.reviewStatus === 'pending_review') event.status = 'pending_review';
    delete event.sourceSnapshotJson;
    items.push(event);
  }
  return { items, total: items.length };
}

export async function evaluateReplanEvent({ user, eventId }) {
  if (!user || user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可核对本人重规划来源');
  if (typeof eventId !== 'string' || !eventId.trim() || eventId.length > 64) {
    throw new AppError(400, 'WELLNESS_REPLAN_EVENT_ID_INVALID', '重规划来源编号格式不正确');
  }
  let row = await replanEventRow(user.id, eventId);
  if (!row) throw new AppError(404, 'WELLNESS_REPLAN_EVENT_NOT_FOUND', '重规划来源记录不存在');
  if (!Number(row.requiresAttention)) return await getReplanEventDetail(user.id, eventId);
  if (row.candidateDraftId) return await getReplanEventDetail(user.id, eventId);

  const baseline = await db.prepare(`SELECT id FROM wellness_drafts WHERE guest_id=? AND review_status IN ('active','auto_activated')
    ORDER BY version DESC,created_at DESC,id DESC LIMIT 1`).get(user.id);
  await db.prepare(`UPDATE wellness_replan_events SET status='evaluating',baseline_draft_id=?,updated_at=?
    WHERE id=? AND guest_id=? AND candidate_draft_id IS NULL`).run(baseline?.id || null, now(), eventId, user.id);
  row = await replanEventRow(user.id, eventId);
  const snapshot = jsonValue(row.sourceSnapshotJson);
  const request = `根据已登记的执行/健康来源重新评估当前疗程，并生成一个待审核候选版本。来源类型：${row.sourceType}；来源编号：${row.sourceId}；来源版本：${row.sourceVersion}；来源摘要：${row.sourceLabel}；记录快照：${JSON.stringify(snapshot)}。触发说明：${row.triggerReason || '将此记录作为本次评估依据。'}。请复用当前多智能体协调器、现行安全约束、规则与实际可用时段；不要宣称诊断或因果关系。`;
  try {
    const { createWellnessDraft } = await import('./wellness-planner.js');
    const draft = await createWellnessDraft({ user, body: { request }, requestKey: `q24-replan:${eventId}` });
    const evidence = { ...(draft.evidence || {}), replanning: { eventId, sourceType: row.sourceType,
      sourceId: row.sourceId, sourceVersion: Number(row.sourceVersion), sourceLabel: row.sourceLabel,
      sourceSnapshot: snapshot, triggerReason: row.triggerReason || '' } };
    await transaction(async () => {
      await db.prepare('UPDATE wellness_drafts SET evidence_json=? WHERE id=? AND guest_id=?')
        .run(JSON.stringify(evidence), draft.draftId, user.id);
      await db.prepare(`UPDATE wellness_replan_events SET status='pending_review',candidate_draft_id=?,updated_at=?
        WHERE id=? AND guest_id=?`).run(draft.draftId, now(), eventId, user.id);
      await log(user.id, 'wellness.replan.evaluate', 'wellness_replan_event', eventId,
        `来源 ${row.sourceType}:${row.sourceId}@${row.sourceVersion} 生成待审核候选 ${draft.draftId}`);
    });
  } catch (error) {
    await db.prepare(`UPDATE wellness_replan_events SET status='failed',updated_at=?
      WHERE id=? AND guest_id=? AND candidate_draft_id IS NULL`).run(now(), eventId, user.id);
    throw error;
  }
  return await getReplanEventDetail(user.id, eventId);
}

export async function activateReplanEvent({ user, eventId }) {
  if (!user || user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅本人可请求现行低风险自动激活规则');
  const row = await replanEventRow(user.id, eventId);
  if (!row) throw new AppError(404, 'WELLNESS_REPLAN_EVENT_NOT_FOUND', '重规划来源记录不存在');
  if (!row.candidateDraftId) throw new AppError(409, 'WELLNESS_REPLAN_CANDIDATE_MISSING', '请先生成候选版本');
  const { autoActivateWellnessDraft } = await import('./wellness-review.js');
  const activated = await autoActivateWellnessDraft(row.candidateDraftId);
  if (activated) {
    await db.prepare(`UPDATE wellness_replan_events SET status='active',updated_at=? WHERE id=? AND guest_id=?`)
      .run(now(), eventId, user.id);
  }
  return { activated: Boolean(activated), detail: await getReplanEventDetail(user.id, eventId),
    message: activated ? '现行低风险自动激活规则已完成复核。' : '候选版本仍待医护按现行审核规则核对。' };
}

export async function markReplanDraftActive(draftId) {
  await db.prepare(`UPDATE wellness_replan_events SET status='active',updated_at=? WHERE candidate_draft_id=?`)
    .run(now(), draftId);
}
