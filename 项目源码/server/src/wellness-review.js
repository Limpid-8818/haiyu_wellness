import crypto from 'node:crypto';
import { db, id, json, log, now, transaction } from './db.js';
import { AppError } from './errors.js';
import { createReservation, evaluateExistingDraftSlot } from './booking.js';
import { getProject } from './catalog.js';
import { authorizeGuestAccess, accessibleGuestIds } from './authorization.js';
import { canManageStaff, isDateOnly, jobTypeFor } from './staffing.js';
import { getWellnessDraft } from './wellness-planner.js';
import { createCareFollowUpTask, createNotificationOnce } from './wellness-notifications.js';

const lock = () => db.driver === 'mysql' ? ' FOR UPDATE' : '';
const MAX_REASON = 1000;

function text(value, limit = MAX_REASON) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function draftRow(draftId, forUpdate = false) {
  return db.prepare(`SELECT d.*,u.name AS guest_name FROM wellness_drafts d
    JOIN users u ON u.id=d.guest_id WHERE d.id=?${forUpdate ? lock() : ''}`).get(draftId);
}

function activitySlotSource(item) {
  // Planner items append their selected slot after the broader inventory
  // evidence inherited from the model candidate. Use the final project_slot
  // reference so two time windows from the same project cannot both book the
  // first inventory entry.
  return [...(item.sourceIds || [])].reverse().find(source => source?.type === 'project_slot' && source.id)?.id || null;
}

function itemRows(draftId) {
  return db.prepare(`SELECT * FROM wellness_draft_items WHERE draft_id=?
    ORDER BY business_date,CASE slot_key WHEN 'breakfast' THEN 1 WHEN 'morning' THEN 2 WHEN 'lunch' THEN 3
      WHEN 'afternoon' THEN 4 WHEN 'dinner' THEN 5 ELSE 6 END,local_start`).all(draftId);
}

function decodeReviewItem(row) {
  return { id: row.id, date: String(row.business_date).slice(0, 10), slotKey: row.slot_key,
    type: row.item_type, candidateId: row.candidate_id || null, title: row.title,
    localStart: row.local_start || null, localEnd: row.local_end || null, status: row.status,
    reason: row.reason, location: row.location || null, ruleIds: json(row.rule_ids_json, []),
    sourceIds: json(row.source_ids_json, []), environmentSnapshotId: row.environment_snapshot_id || null,
    evidence: json(row.evidence_json, {}) };
}

async function rootThreadId(row) {
  if (row.review_thread_id) return row.review_thread_id;
  return row.id;
}

async function assertClinicianGuest(actor, guestId) {
  if (actor.role !== 'staff' || jobTypeFor(actor) !== 'clinician') {
    throw new AppError(403, 'CLINICIAN_REQUIRED', '仅医护岗位可处理疗程审核');
  }
  return authorizeGuestAccess(actor, guestId);
}

async function assertCurrentVersion(row, expectedVersion) {
  if (!Number.isInteger(Number(expectedVersion)) || Number(expectedVersion) !== Number(row.version)) {
    throw new AppError(409, 'WELLNESS_VERSION_STALE', '疗程版本已变化，请刷新后重新核对', {
      currentVersion: Number(row.version), expectedVersion: Number(expectedVersion)
    });
  }
  const latest = await db.prepare('SELECT MAX(version) AS version FROM wellness_drafts WHERE guest_id=?').get(row.guest_id);
  if (Number(latest?.version || 0) !== Number(row.version)) {
    throw new AppError(409, 'WELLNESS_VERSION_STALE', '存在更新版本，请审核最新版本', { currentVersion: Number(latest.version) });
  }
}

function validateRequestKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(value)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', '审核请求缺少有效的幂等标识');
  }
  return value;
}

function validateRevisionEdits(edits) {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 10
    || edits.some(edit => !edit || typeof edit !== 'object' || Array.isArray(edit)
      || Object.keys(edit).some(key => !['itemId', 'slotId', 'title', 'reason'].includes(key)))) {
    throw new AppError(400, 'WELLNESS_REVISION_INVALID', '修订项目格式无效');
  }
}

async function insertEvent({ draft, actor, action, reason = '', requestKey, fromVersion = null,
  toVersion = null, payload = {} }) {
  const eventId = id('wellness_review');
  await db.prepare(`INSERT INTO wellness_review_events
    (id,draft_id,review_thread_id,guest_id,actor_id,actor_role,action,reason,from_version,to_version,request_key,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    eventId, draft.id, await rootThreadId(draft), draft.guest_id, actor.id,
    actor.system ? 'system' : actor.role === 'dean' ? 'administrator' : jobTypeFor(actor) || 'guest',
    action, reason, fromVersion, toVersion, requestKey, JSON.stringify(payload), now()
  );
  return { id: eventId, draftId: draft.id, guestId: draft.guest_id, action, reason, fromVersion, toVersion };
}

async function notifyReviewEvent(event) {
  if (!['approved', 'approved_after_revision', 'corrected', 'auto_activated'].includes(event.action)) return;
  const actionText = event.action === 'corrected' ? '纠正并激活'
    : event.action === 'auto_activated' ? '自动激活' : '审核通过';
  await createNotificationOnce({ guestId: event.guestId, sourceType: 'wellness_review_event', sourceId: event.id,
    draftId: event.draftId, message: `医护${actionText}疗程版本${event.toVersion ? `第 ${event.toVersion} 版` : ''}。${event.reason || ''}`.slice(0, 1200),
    targetType: 'wellness_revision', targetId: event.draftId, targetUrl: 'schedule',
    notificationType: event.action === 'corrected' ? 'care' : 'update' });
  if (event.action === 'corrected') {
    await createCareFollowUpTask({ guestId: event.guestId, sourceType: 'wellness_review_event', sourceId: event.id,
      title: '跟进已修订的疗程安排',
      detail: `疗程第 ${event.fromVersion || '—'} 版调整为第 ${event.toVersion || '—'} 版；来源事件 ${event.id}。${event.reason || ''}` });
  }
}

async function findEvent(draftId, actorId, action, requestKey) {
  return db.prepare(`SELECT * FROM wellness_review_events
    WHERE draft_id=? AND actor_id=? AND action=? AND request_key=?`).get(draftId, actorId, action, requestKey);
}

async function clinicianRevisionForDraft(draft) {
  if (!draft.supersedes_draft_id) return null;
  const event = await db.prepare(`SELECT * FROM wellness_review_events
    WHERE draft_id=? AND actor_role='clinician' AND action='revision' AND to_version=?
    ORDER BY created_at DESC,id DESC LIMIT 1`).get(draft.id, Number(draft.version));
  if (!event) return null;
  const payload = json(event.payload_json, {});
  if (payload.correction !== false || payload.supersedesDraftId !== draft.supersedes_draft_id) return null;
  const source = await db.prepare('SELECT version,review_thread_id,id FROM wellness_drafts WHERE id=?').get(draft.supersedes_draft_id);
  if (!source || Number(source.version) !== Number(event.from_version)
    || source.review_thread_id !== draft.review_thread_id) return null;
  return { event, payload };
}

function versionRequestFingerprint({ sourceDraftId, sourceVersion, reason, edits, correction }) {
  const normalizedEdits = edits.map(edit => ({ itemId: text(edit.itemId, 64), slotId: text(edit.slotId, 64),
    title: text(edit.title, 160), reason: text(edit.reason) }));
  const content = JSON.stringify({ sourceDraftId, sourceVersion: Number(sourceVersion), reason,
    edits: normalizedEdits, correction: Boolean(correction) });
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function findVersionRequestReplay({ source, actor, requestKey, requestFingerprint, correction }) {
  const rows = await db.prepare(`SELECT * FROM wellness_review_events
    WHERE actor_id=? AND action='revision' AND request_key=? ORDER BY created_at DESC LIMIT 100`)
    .all(actor.id, requestKey);
  const matching = rows.find(event => json(event.payload_json, {}).supersedesDraftId === source.id);
  if (!matching) {
    if (rows.length) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '该审核请求标识已用于其他疗程修订');
    return null;
  }
  const payload = json(matching.payload_json, {});
  if (!payload.requestFingerprint) {
    throw new AppError(409, 'IDEMPOTENCY_REPLAY_UNVERIFIABLE', '历史修订缺少请求内容校验，不能安全重放');
  }
  if (payload.correction !== Boolean(correction) || payload.requestFingerprint !== requestFingerprint) {
    throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '相同审核请求标识不能用于不同修订内容');
  }
  return { draftId: matching.draft_id, version: Number(matching.to_version), replayed: true, event: matching, payload };
}

async function insertAttentionOnce({ threadId, guestId, reason }) {
  const existing = await db.prepare(`SELECT id FROM wellness_admin_attention
    WHERE review_thread_id=? AND attention_type='repeated_returns'`).get(threadId);
  if (existing) return existing.id;
  const attentionId = id('wellness_attention');
  try {
    await db.prepare(`INSERT INTO wellness_admin_attention
      (id,review_thread_id,guest_id,attention_type,reason,status,created_at) VALUES(?,?,?,'repeated_returns',?,'open',?)`)
      .run(attentionId, threadId, guestId, reason, now());
    return attentionId;
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062 || /UNIQUE constraint failed/i.test(String(error?.message || ''))) {
      return (await db.prepare(`SELECT id FROM wellness_admin_attention WHERE review_thread_id=? AND attention_type='repeated_returns'`)
        .get(threadId))?.id || null;
    }
    throw error;
  }
}

function itemWriteValues(draftId, item) {
  return [item.id, draftId, item.date || item.businessDate, item.slotKey, item.type,
    item.candidateId || null, item.title, item.localStart || null, item.localEnd || null,
    item.status, item.reason, item.location || null, JSON.stringify(item.ruleIds || []),
    JSON.stringify(item.sourceIds || []), item.environmentSnapshotId || null, JSON.stringify(item.evidence || {})];
}

async function copyVersion({ actor, source, edits, reason, requestKey, requestFingerprint, correction = false }) {
  const rows = (await itemRows(source.id)).map(decodeReviewItem);
  const byId = new Map(rows.map(item => [item.id, item]));
  const edited = [];
  for (const edit of edits) {
    const old = byId.get(edit.itemId);
    if (!old || old.type !== 'activity') throw new AppError(400, 'WELLNESS_ITEM_INVALID', '只能修订草案中已有的活动项目');
    const slotId = text(edit.slotId, 64);
    if (!slotId) throw new AppError(400, 'WELLNESS_SLOT_REQUIRED', '修订活动需要选择真实项目时段');
    const slotRow = await db.prepare(`SELECT s.*,p.name AS project_name,p.location,p.is_demo AS project_is_demo,
        p.active AS project_active,p.slug,p.activity_tag,p.open_windows_json,p.capacity_per_window,p.category,p.intensity,
        p.sea_entry,p.outdoor,p.suitable_people,p.contraindications,p.description,p.source_reference,p.updated_at AS project_updated_at,
        (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
      FROM activity_slots s JOIN projects p ON p.id=s.project_id WHERE s.id=?${lock()}`).get(slotId);
    if (!slotRow) throw new AppError(409, 'WELLNESS_SLOT_UNAVAILABLE', '所选时段不存在或已下架');
    const project = await getProject(slotRow.project_id);
    if (!project?.active) throw new AppError(409, 'WELLNESS_SLOT_UNAVAILABLE', '所选项目已停用');
    const checked = await evaluateExistingDraftSlot({ project, row: slotRow, guestId: source.guest_id });
    if (!checked.available) throw new AppError(409, 'WELLNESS_SLOT_UNAVAILABLE', checked.reason || '所选时段当前不可用', {
      slotId, status: checked.status
    });
    const editReason = text(edit.reason || reason);
    if (!editReason) throw new AppError(400, 'WELLNESS_REASON_REQUIRED', '每项修订都需要记录具体原因');
    const sourceIds = [{ type: 'project_slot', id: checked.slot.id,
      label: `${checked.slot.businessDate} ${checked.slot.localStart} 项目时段` }];
    if (checked.environment?.environmentSnapshotId) sourceIds.push({ type: 'environment_snapshot',
      id: checked.environment.environmentSnapshotId, label: '当前环境快照' });
    edited.push({ ...old, date: checked.slot.businessDate,
      slotKey: `revision:${crypto.createHash('sha256').update(old.id).digest('hex').slice(0,20)}`,
      localStart: checked.slot.localStart,
      localEnd: checked.slot.localEnd, title: text(edit.title, 160) || checked.slot.projectName,
      candidateId: `clinician:${checked.slot.projectId}`, location: checked.slot.location,
      status: 'pending_review', reason: editReason, ruleIds: (checked.environment?.checks || [])
        .flatMap(check => check.ruleDecisions || []).filter(rule => rule.matched).map(rule => rule.ruleId).filter(Boolean),
      sourceIds, environmentSnapshotId: checked.environment?.environmentSnapshotId || null,
      evidence: { ...(old.evidence || {}), clinicianRevision: true, revisedFromItemId: old.id,
        selectedSlotId: checked.slot.id, availabilityStatus: checked.status,
        environmentCheckedAt: now(), clinicianReason: editReason } });
  }
  const replacements = new Map(edited.map(item => [item.id, item]));
  const nextItems = rows.map(item => replacements.get(item.id) || item);
  const latest = await db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM wellness_drafts WHERE guest_id=?').get(source.guest_id);
  const nextVersion = Number(latest?.version || 0) + 1;
  const nextId = id('wellness_draft');
  const timestamp = now();
  await db.prepare(`INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
     evidence_json,created_at,review_status,review_thread_id,supersedes_draft_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,?,?,?,?,?,'pending_review',?,?,?,?,'pending_review',?,?,?,NULL,NULL)`)
    .run(nextId, source.guest_id, nextVersion, `review:${nextId}`, source.source_run_id, source.stay_start,
      source.stay_end, source.review_policy, source.review_sample_percent,
      JSON.stringify({ ...json(source.evidence_json, {}), revision: { fromDraftId: source.id,
        fromVersion: Number(source.version), reason, actorId: actor.id, createdAt: timestamp } }), timestamp,
      await rootThreadId(source), source.id, reason);
  for (const item of nextItems) {
    await db.prepare(`INSERT INTO wellness_draft_items
      (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
       rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...itemWriteValues(nextId, { ...item, id: id('wellness_item') }));
  }
  await db.prepare(`UPDATE wellness_drafts SET status='cancelled',review_status='superseded',review_reason=?,reviewed_by=?,reviewed_at=?
    WHERE id=?`).run(reason, actor.id, timestamp, source.id);
  const next = await draftRow(nextId);
  await insertEvent({ draft: next, actor, action: 'revision', reason, requestKey,
    fromVersion: Number(source.version), toVersion: nextVersion,
    payload: { supersedesDraftId: source.id, editedItemIds: edits.map(edit => edit.itemId), correction, requestFingerprint } });
  await log(actor.id, correction ? 'wellness_draft.correct' : 'wellness_draft.revise', 'wellness_draft', nextId,
    `从版本 ${source.version} 修订为版本 ${nextVersion}；${reason}`);
  return next;
}

async function activateInTransaction({ actor, draft, action, reason, requestKey, expectedVersion, eventPayload = {} }) {
  await assertCurrentVersion(draft, expectedVersion ?? draft.version);
  const previousEvent = await findEvent(draft.id, actor.id, action, requestKey);
  if (previousEvent) {
    await notifyReviewEvent({ id: previousEvent.id, draftId: draft.id, guestId: draft.guest_id,
      action: previousEvent.action, reason: previousEvent.reason, fromVersion: previousEvent.from_version,
      toVersion: previousEvent.to_version });
    return { draftId: draft.id, version: Number(draft.version), replayed: true, eventId: previousEvent.id,
      reservations: json(previousEvent.payload_json, {}).reservations || [] };
  }
  if (draft.review_status !== 'pending_review' || draft.status !== 'pending_review') {
    throw new AppError(409, 'WELLNESS_REVIEW_STATE', '当前版本不在待审核状态');
  }
  const items = (await itemRows(draft.id)).map(decodeReviewItem);
  const blocked = items.find(item => item.type === 'activity'
    && !['pending_review', 'mandatory_review', 'sampled_review'].includes(item.status));
  if (blocked) throw new AppError(409, 'WELLNESS_ITEM_NOT_READY', '草案包含未确认或受限活动，不能激活', { itemId: blocked.id, status: blocked.status });
  const reservations = [];
  for (const item of items.filter(candidate => candidate.type === 'activity')) {
    const slotId = activitySlotSource(item);
    if (!slotId) throw new AppError(409, 'WELLNESS_SLOT_EVIDENCE_MISSING', '活动缺少真实项目时段来源，不能激活', { itemId: item.id });
    const result = await createReservation({ guestId: draft.guest_id, slotId,
      idempotencyKey: `wellness:${draft.id}:${item.id}`, wellnessDraftId: draft.id, wellnessDraftItemId: item.id });
    reservations.push({ itemId: item.id, reservation: result.reservation, replayed: result.replayed });
  }
  const stamp = now();
  await db.prepare(`UPDATE wellness_drafts SET status='active',review_status=?,review_reason=?,reviewed_by=?,reviewed_at=?
    WHERE id=? AND status='pending_review'`).run(action === 'auto_activated' ? 'auto_activated' : 'active', reason, actor.id, stamp, draft.id);
  const reviewEvent = await insertEvent({ draft, actor, action, reason, requestKey, fromVersion: Number(draft.version),
    toVersion: Number(draft.version), payload: { reservations: reservations.map(item => ({ itemId: item.itemId,
      reservationId: item.reservation?.id, replayed: item.replayed })), ...eventPayload } });
  await notifyReviewEvent(reviewEvent);
  const auditAction = action === 'auto_activated' ? 'wellness_draft.auto_activate'
    : action === 'approved_after_revision' ? 'wellness_draft.approve_after_revision' : 'wellness_draft.activate';
  await log(actor.id, auditAction,
    'wellness_draft', draft.id, `版本 ${draft.version}；${reservations.length} 个真实预约；${reason}`);
  return { draftId: draft.id, version: Number(draft.version), replayed: false, eventId: reviewEvent.id, reservations };
}

export async function listWellnessReviewQueue(actor, { status = 'pending_review', guestId = '', date = '', risk = '' } = {}) {
  if (actor.role !== 'staff' || jobTypeFor(actor) !== 'clinician') throw new AppError(403, 'CLINICIAN_REQUIRED', '仅医护岗位可查看审核队列');
  if (date && !isDateOnly(date)) throw new AppError(400, 'WELLNESS_DATE_INVALID', '日期必须是有效 YYYY-MM-DD');
  const ids = await accessibleGuestIds(actor);
  if (!ids.length) return { items: [], counts: { pending: 0, complete: 0 }, filters: { status, guestId, date, risk } };
  const where = [`d.guest_id IN (${ids.map(() => '?').join(',')})`];
  const params = [...ids];
  const requestedStatus = status === 'complete' ? 'complete' : 'pending_review';
  where.push(requestedStatus === 'complete'
    ? "d.review_status IN ('active','auto_activated','returned','corrected','superseded')"
    : "d.review_status='pending_review'");
  if (guestId) { where.push('d.guest_id=?'); params.push(guestId); }
  if (date) { where.push('d.stay_start<=? AND d.stay_end>?'); params.push(date, date); }
  const rows = await db.prepare(`SELECT d.id,d.guest_id,d.version,d.stay_start,d.stay_end,d.status,d.review_status,
      d.review_policy,d.review_sample_percent,d.source_run_id,d.evidence_json,d.review_reason,d.created_at,
      u.name AS guest_name,gp.room_no
    FROM wellness_drafts d JOIN users u ON u.id=d.guest_id
    LEFT JOIN guest_profiles gp ON gp.user_id=d.guest_id
    WHERE ${where.join(' AND ')} ORDER BY d.created_at DESC,d.id DESC LIMIT 200`).all(...params);
  const items = [];
  for (const row of rows) {
    const draft = await getWellnessDraft(row.guest_id, row.id);
    const hard = draft.items.some(item => item.status === 'mandatory_review');
    const sampled = draft.items.some(item => item.status === 'sampled_review');
    const riskLevel = hard ? 'high' : sampled ? 'sampled' : 'standard';
    if (risk && risk !== riskLevel) continue;
    items.push({ draftId: row.id, guestId: row.guest_id, guestName: row.guest_name,
      roomNo: row.room_no || '', version: Number(row.version), stayStart: String(row.stay_start).slice(0, 10),
      stayEnd: String(row.stay_end).slice(0, 10), status: row.status, reviewStatus: row.review_status,
      generatedAt: row.created_at, sourceRunId: row.source_run_id, riskLevel,
      summary: draft.items.map(item => item.title).slice(0, 8).join('、'), itemCount: draft.items.length,
      reviewReason: row.review_reason || '' });
  }
  const countWhere = [`guest_id IN (${ids.map(() => '?').join(',')})`];
  const countParams = [...ids];
  if (guestId) { countWhere.push('guest_id=?'); countParams.push(guestId); }
  if (date) { countWhere.push('stay_start<=? AND stay_end>?'); countParams.push(date, date); }
  if (risk === 'high') countWhere.push(`EXISTS (SELECT 1 FROM wellness_draft_items ri WHERE ri.draft_id=wellness_drafts.id AND ri.status='mandatory_review')`);
  if (risk === 'sampled') countWhere.push(`EXISTS (SELECT 1 FROM wellness_draft_items ri WHERE ri.draft_id=wellness_drafts.id AND ri.status='sampled_review')`);
  if (risk === 'standard') countWhere.push(`NOT EXISTS (SELECT 1 FROM wellness_draft_items ri WHERE ri.draft_id=wellness_drafts.id AND ri.status IN ('mandatory_review','sampled_review'))`);
  const countRows = await db.prepare(`SELECT review_status,COUNT(*) AS total FROM wellness_drafts
    WHERE ${countWhere.join(' AND ')} GROUP BY review_status`).all(...countParams);
  const countMap = new Map(countRows.map(row => [row.review_status, Number(row.total)]));
  return { items, counts: { pending: countMap.get('pending_review') || 0,
    complete: [...countMap].filter(([key]) => ['active', 'auto_activated', 'returned', 'corrected', 'superseded'].includes(key))
      .reduce((sum, [, value]) => sum + value, 0) }, filters: { status: requestedStatus, guestId, date, risk } };
}

export async function getWellnessReviewDetail(actor, draftId) {
  const row = await draftRow(draftId);
  if (!row) throw new AppError(404, 'WELLNESS_DRAFT_NOT_FOUND', '疗程草案不存在');
  await assertClinicianGuest(actor, row.guest_id);
  const draft = await getWellnessDraft(row.guest_id, draftId);
  const clinicianRevision = await clinicianRevisionForDraft(row);
  const [events, reservations] = await Promise.all([
    db.prepare(`SELECT e.*,u.name AS actor_name FROM wellness_review_events e
      JOIN users u ON u.id=e.actor_id WHERE e.review_thread_id=? ORDER BY e.created_at,e.id LIMIT 200`)
      .all(await rootThreadId(row)),
    db.prepare(`SELECT r.id,r.slot_id,r.status,r.wellness_draft_item_id,s.business_date,s.local_start,s.local_end,
        p.name AS project_name FROM reservations r JOIN activity_slots s ON s.id=r.slot_id
      JOIN projects p ON p.id=s.project_id WHERE r.wellness_draft_id=? ORDER BY s.starts_at`).all(draftId)
  ]);
  return { ...draft, guestName: row.guest_name, reviewStatus: row.review_status,
    reviewReason: row.review_reason || '', reviewedAt: row.reviewed_at || null,
    reviewedBy: row.reviewed_by || null,
    approvalAction: clinicianRevision ? 'approved_after_revision' : 'approved',
    approvalContext: clinicianRevision ? { revisionEventId: clinicianRevision.event.id,
      supersedesDraftId: row.supersedes_draft_id, fromVersion: Number(clinicianRevision.event.from_version),
      toVersion: Number(clinicianRevision.event.to_version), revisionReason: clinicianRevision.event.reason } : null,
    history: events.map(event => ({ id: event.id, action: event.action,
      actorId: event.actor_id, actorName: event.actor_name, actorRole: event.actor_role,
      reason: event.reason, fromVersion: event.from_version, toVersion: event.to_version,
    createdAt: event.created_at, payload: json(event.payload_json, {}) })), reservations };
}

export async function listWellnessReviewAlternatives(actor, draftId, itemId) {
  const draft = await draftRow(draftId);
  if (!draft) throw new AppError(404, 'WELLNESS_DRAFT_NOT_FOUND', '疗程草案不存在');
  await assertClinicianGuest(actor, draft.guest_id);
  const itemRow = await db.prepare('SELECT * FROM wellness_draft_items WHERE id=? AND draft_id=?').get(itemId, draftId);
  if (!itemRow || itemRow.item_type !== 'activity') throw new AppError(404, 'WELLNESS_ITEM_NOT_FOUND', '活动项目不存在');
  const rows = await db.prepare(`SELECT s.*,p.name AS project_name,p.location,p.is_demo AS project_is_demo,
      p.active AS project_active,p.slug,p.activity_tag,p.open_windows_json,p.capacity_per_window,p.category,p.intensity,
      p.sea_entry,p.outdoor,p.suitable_people,p.contraindications,p.description,p.source_reference,p.updated_at AS project_updated_at,
      (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
    FROM activity_slots s JOIN projects p ON p.id=s.project_id
    WHERE p.active=1 AND s.business_date>=? AND s.business_date<? AND s.is_closed=0
    ORDER BY s.business_date,s.starts_at LIMIT 120`).all(draft.stay_start, draft.stay_end);
  const alternatives = [];
  for (const row of rows) {
    const project = await getProject(row.project_id);
    if (!project?.active) continue;
    const checked = await evaluateExistingDraftSlot({ project, row, guestId: draft.guest_id });
    if (!checked.available) continue;
    alternatives.push({ slotId: checked.slot.id, projectName: checked.slot.projectName,
      date: checked.slot.businessDate, localStart: checked.slot.localStart, localEnd: checked.slot.localEnd,
      location: checked.slot.location, remaining: checked.remaining, isDemo: checked.slot.isDemo });
  }
  return { itemId, alternatives };
}

export async function reviseWellnessDraft({ actor, draftId, version, edits, reason, requestKey }) {
  const normalizedReason = text(reason);
  if (!normalizedReason) throw new AppError(400, 'WELLNESS_REASON_REQUIRED', '请填写本次修订原因');
  validateRevisionEdits(edits);
  const key = validateRequestKey(requestKey);
  const existing = await draftRow(draftId);
  if (!existing) throw new AppError(404, 'WELLNESS_DRAFT_NOT_FOUND', '疗程草案不存在');
  await assertClinicianGuest(actor, existing.guest_id);
  const requestFingerprint = versionRequestFingerprint({ sourceDraftId: draftId, sourceVersion: version,
    reason: normalizedReason, edits, correction: false });
  const result = await transaction(async () => {
    const source = await draftRow(draftId, true);
    await assertClinicianGuest(actor, source.guest_id);
    const replay = await findVersionRequestReplay({ source, actor, requestKey: key, requestFingerprint, correction: false });
    if (replay) return replay;
    await assertCurrentVersion(source, version);
    if (source.review_status !== 'pending_review' || source.status !== 'pending_review') {
      throw new AppError(409, 'WELLNESS_REVIEW_STATE', '只有待审核版本可以修订');
    }
    const revised = await copyVersion({ actor, source, edits, reason: normalizedReason, requestKey: key, requestFingerprint });
    return { draftId: revised.id, version: Number(revised.version), replayed: false };
  });
  return { ...(await getWellnessReviewDetail(actor, result.draftId)), revised: true, replayed: result.replayed };
}

export async function approveWellnessDraft({ actor, draftId, version, requestKey }) {
  const key = validateRequestKey(requestKey);
  const result = await transaction(async () => {
    const draft = await draftRow(draftId, true);
    if (!draft) throw new AppError(404, 'WELLNESS_DRAFT_NOT_FOUND', '疗程草案不存在');
    await assertClinicianGuest(actor, draft.guest_id);
    const clinicianRevision = await clinicianRevisionForDraft(draft);
    if (!clinicianRevision) return activateInTransaction({ actor, draft, action: 'approved', requestKey: key,
      expectedVersion: version, reason: '医护审核通过' });
    const { event } = clinicianRevision;
    const reason = `医护修改后通过：第${draft.version}版；对应修订事件 ${event.id}（第${event.from_version}版→第${event.to_version}版）；修订原因：${text(event.reason, 500)}`;
    return activateInTransaction({ actor, draft, action: 'approved_after_revision', requestKey: key,
      expectedVersion: version, reason, eventPayload: { revisionEventId: event.id,
        supersedesDraftId: draft.supersedes_draft_id, fromVersion: Number(event.from_version),
        toVersion: Number(event.to_version), revisionReason: event.reason } });
  });
  return { ...result, ...(await getWellnessReviewDetail(actor, result.draftId)) };
}

export async function returnWellnessDraft({ actor, draftId, version, reason, requestKey }) {
  const normalizedReason = text(reason);
  if (!normalizedReason) throw new AppError(400, 'WELLNESS_REASON_REQUIRED', '退回时必须填写具体原因');
  const key = validateRequestKey(requestKey);
  const result = await transaction(async () => {
    const draft = await draftRow(draftId, true);
    if (!draft) throw new AppError(404, 'WELLNESS_DRAFT_NOT_FOUND', '疗程草案不存在');
    await assertClinicianGuest(actor, draft.guest_id);
    await assertCurrentVersion(draft, version);
    const replay = await findEvent(draft.id, actor.id, 'returned', key);
    if (replay) return { draftId: draft.id, version: Number(draft.version), replayed: true, attentionId: null };
    if (draft.review_status !== 'pending_review' || draft.status !== 'pending_review') {
      throw new AppError(409, 'WELLNESS_REVIEW_STATE', '只有待审核版本可以退回');
    }
    const stamp = now();
    await db.prepare(`UPDATE wellness_drafts SET status='cancelled',review_status='returned',review_reason=?,reviewed_by=?,reviewed_at=?
      WHERE id=?`).run(normalizedReason, actor.id, stamp, draft.id);
    await insertEvent({ draft, actor, action: 'returned', reason: normalizedReason, requestKey: key,
      fromVersion: Number(draft.version), toVersion: Number(draft.version) });
    const threadId = await rootThreadId(draft);
    const prior = await db.prepare(`SELECT COUNT(*) AS total FROM wellness_review_events
      WHERE review_thread_id=? AND action='returned'`).get(threadId);
    const attentionId = Number(prior?.total || 0) >= 2
      ? await insertAttentionOnce({ threadId, guestId: draft.guest_id, reason: '同一疗程版本链已连续两次被医护退回，需要管理员关注。' })
      : null;
    await log(actor.id, 'wellness_draft.return', 'wellness_draft', draft.id, normalizedReason);
    return { draftId: draft.id, version: Number(draft.version), replayed: false, attentionId };
  });
  return { ...result, ...(await getWellnessReviewDetail(actor, result.draftId)) };
}

export async function correctActiveWellnessDraft({ actor, draftId, version, edits, reason, requestKey }) {
  const normalizedReason = text(reason);
  if (!normalizedReason) throw new AppError(400, 'WELLNESS_REASON_REQUIRED', '纠正时必须填写具体原因');
  validateRevisionEdits(edits);
  const key = validateRequestKey(requestKey);
  const existing = await draftRow(draftId);
  if (!existing) throw new AppError(404, 'WELLNESS_DRAFT_NOT_FOUND', '疗程草案不存在');
  await assertClinicianGuest(actor, existing.guest_id);
  const requestFingerprint = versionRequestFingerprint({ sourceDraftId: draftId, sourceVersion: version,
    reason: normalizedReason, edits, correction: true });
  const result = await transaction(async () => {
    const source = await draftRow(draftId, true);
    await assertClinicianGuest(actor, source.guest_id);
    const replay = await findVersionRequestReplay({ source, actor, requestKey: key, requestFingerprint, correction: true });
    if (replay) {
      const correctedEvent = await findEvent(replay.draftId, actor.id, 'corrected', key);
      if (!correctedEvent) throw new AppError(500, 'WELLNESS_CORRECTION_RESULT_MISSING', '纠正版本缺少完成记录');
      const payload = json(correctedEvent.payload_json, {});
      return { draftId: replay.draftId, version: Number(correctedEvent.to_version || replay.version), replayed: true,
        reservations: payload.reservations || [], correctedFromDraftId: payload.correctedFromDraftId || source.id,
        correctedFromVersion: Number(payload.correctedFromVersion || source.version),
        compensatedReservationCount: Number(payload.compensatedReservationCount || 0) };
    }
    await assertCurrentVersion(source, version);
    if (source.review_status !== 'active' || source.status !== 'active') {
      throw new AppError(409, 'WELLNESS_REVIEW_STATE', '只有已激活版本可以纠正');
    }
    const oldReservations = await db.prepare(`SELECT r.id FROM reservations r JOIN activity_slots s ON s.id=r.slot_id
      WHERE r.wellness_draft_id=? AND r.status='confirmed' AND s.starts_at>?${lock()}`).all(source.id, now());
    for (const reservation of oldReservations) {
      await db.prepare(`UPDATE reservations SET status='cancelled',cancelled_at=?,cancellation_reason='wellness_corrected'
        WHERE id=? AND status='confirmed'`).run(now(), reservation.id);
      await log(actor.id, 'reservation.correct', 'reservation', reservation.id,
        `疗程 ${source.id} 版本 ${source.version} 被医护纠正；已补偿关联预约名额`);
    }
    const revised = await copyVersion({ actor, source, edits, reason: normalizedReason, requestKey: key,
      requestFingerprint, correction: true });
    const activation = await activateInTransaction({ actor, draft: revised, action: 'corrected',
      requestKey: key, expectedVersion: revised.version, reason: normalizedReason,
      eventPayload: { correctedFromDraftId: source.id, correctedFromVersion: Number(source.version),
        compensatedReservationCount: oldReservations.length } });
    await db.prepare(`UPDATE wellness_drafts SET review_status='corrected',review_reason=?,reviewed_by=?,reviewed_at=? WHERE id=?`)
      .run(normalizedReason, actor.id, now(), source.id);
    return { ...activation, correctedFromDraftId: source.id, correctedFromVersion: Number(source.version),
      compensatedReservationCount: oldReservations.length };
  });
  return { ...result, ...(await getWellnessReviewDetail(actor, result.draftId)) };
}

export async function autoActivateWellnessDraft(draftId) {
  try {
    return await transaction(async () => {
      const draft = await draftRow(draftId, true);
      if (!draft || draft.review_policy !== 'auto' || draft.review_status !== 'pending_review') return null;
      const items = (await itemRows(draft.id)).map(decodeReviewItem);
      if (items.some(item => ['mandatory_review', 'sampled_review', 'pending_confirmation', 'excluded'].includes(item.status))) return null;
      const source = { id: draft.guest_id, role: 'guest', system: true };
      return await activateInTransaction({ actor: source, draft, action: 'auto_activated',
        requestKey: `auto:${draft.id}`, expectedVersion: draft.version,
        reason: '低风险且未抽中人工审核；仍经预约规则、健康、环境与容量二次校验' });
    });
  } catch (error) {
    // Returning null from inside the transaction callback would commit any
    // earlier reservations created for this plan. Convert only after the
    // transaction wrapper has rolled the entire activation back.
    if (error instanceof AppError && [409, 400].includes(error.status)) return null;
    throw error;
  }
}

export async function listWellnessReviewHistory(actor, { guestId = '', action = '', from = '', to = '' } = {}) {
  const manager = canManageStaff(actor);
  if (!manager && !(actor.role === 'staff' && jobTypeFor(actor) === 'clinician')) {
    throw new AppError(403, 'WELLNESS_HISTORY_FORBIDDEN', '仅医护或管理员可查看审核历史');
  }
  if ((from && !isDateOnly(from)) || (to && !isDateOnly(to)) || (from && to && from > to)) {
    throw new AppError(400, 'WELLNESS_HISTORY_DATE_INVALID', '历史日期范围无效');
  }
  if (guestId && !manager) await authorizeGuestAccess(actor, guestId);
  const guestIds = manager ? null : await accessibleGuestIds(actor);
  const where = [];
  const params = [];
  if (guestIds) {
    if (!guestIds.length) return { items: [], total: 0 };
    where.push(`e.guest_id IN (${guestIds.map(() => '?').join(',')})`);
    params.push(...guestIds);
  }
  if (guestId) { where.push('e.guest_id=?'); params.push(guestId); }
  if (action) {
    if (!['revision', 'approved', 'approved_after_revision', 'returned', 'auto_activated', 'corrected'].includes(action)) {
      throw new AppError(400, 'WELLNESS_HISTORY_ACTION_INVALID', '审核动作筛选无效');
    }
    where.push('e.action=?'); params.push(action);
  }
  if (from) { where.push('e.created_at>=?'); params.push(`${from} 00:00:00`); }
  if (to) { where.push('e.created_at<?'); params.push(`${to} 23:59:59.999`); }
  const rows = await db.prepare(`SELECT e.*,u.name AS guest_name,a.name AS actor_name,d.version
    FROM wellness_review_events e JOIN users u ON u.id=e.guest_id JOIN users a ON a.id=e.actor_id
    JOIN wellness_drafts d ON d.id=e.draft_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.created_at DESC,e.id DESC LIMIT 500`).all(...params);
  return { total: rows.length, items: rows.map(row => ({ id: row.id, draftId: row.draft_id,
    guestId: row.guest_id, guestName: row.guest_name, version: Number(row.version), action: row.action,
    actorId: row.actor_id, actorName: row.actor_name, actorRole: row.actor_role,
    reason: row.reason, fromVersion: row.from_version, toVersion: row.to_version,
    createdAt: row.created_at, payload: json(row.payload_json, {}) })) };
}

export async function listWellnessAdminAttention(actor) {
  if (!canManageStaff(actor)) throw new AppError(403, 'STAFF_MANAGEMENT_REQUIRED', '仅管理员可查看待关注事项');
  return { items: await db.prepare(`SELECT a.*,u.name AS guest_name FROM wellness_admin_attention a
    JOIN users u ON u.id=a.guest_id WHERE a.status='open' ORDER BY a.created_at DESC LIMIT 200`).all() };
}
