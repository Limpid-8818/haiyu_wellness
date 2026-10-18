import { db, guestProfile, id, inTransaction, log, now } from './db.js';
import { AppError } from './errors.js';
import { isDateOnly } from './staffing.js';
import { getWellnessDraft } from './wellness-draft-queries.js';

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
  const result = await inTransaction(create);
  return { ...(await getWellnessDraft(user.id, result.draftId)), deduplicated: result.replayed };
}
