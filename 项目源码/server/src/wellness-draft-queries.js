import { db, json } from './db.js';
import { AppError } from './errors.js';
import { systemBusinessClock } from './clock.js';
import { draftEnvironmentHistory } from './environment-history.js';

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

export async function getWellnessDraft(guestId, draftId) {
  const row = await db.prepare('SELECT * FROM wellness_drafts WHERE id=? AND guest_id=?').get(draftId, guestId);
  if (!row) throw new AppError(404, 'WELLNESS_DRAFT_NOT_FOUND', '疗程草案不存在');
  const items = await db.prepare(`SELECT * FROM wellness_draft_items WHERE draft_id=?
    ORDER BY business_date,CASE slot_key WHEN 'breakfast' THEN 1 WHEN 'morning' THEN 2 WHEN 'lunch' THEN 3
      WHEN 'afternoon' THEN 4 WHEN 'dinner' THEN 5 ELSE 6 END,local_start`).all(draftId);
  const draft = decodeDraft(row, items.map(decodeItem));
  return { ...draft, environmentHistory: await draftEnvironmentHistory(draft) };
}

export async function listWellnessDrafts(guestId, { stayStart = null, stayEnd = null } = {}) {
  const filters = ['guest_id=?'];
  const params = [guestId];
  if (stayStart && stayEnd) { filters.push('stay_start=? AND stay_end=?'); params.push(stayStart, stayEnd); }
  const rows = await db.prepare(`SELECT * FROM wellness_drafts WHERE ${filters.join(' AND ')} ORDER BY version DESC,id DESC LIMIT 50`)
    .all(...params);
  // G24：一次取回全部草案条目并按 draft_id 分组，替代逐草案 N+1 查询；环境历史仍按草案单独读取。
  const draftIds = rows.map(row => row.id);
  const itemsByDraft = new Map();
  if (draftIds.length) {
    const itemPlaceholders = draftIds.map(() => '?').join(',');
    const itemRows = await db.prepare(`SELECT * FROM wellness_draft_items WHERE draft_id IN (${itemPlaceholders})
      ORDER BY business_date,CASE slot_key WHEN 'breakfast' THEN 1 WHEN 'morning' THEN 2 WHEN 'lunch' THEN 3
        WHEN 'afternoon' THEN 4 WHEN 'dinner' THEN 5 ELSE 6 END,local_start`).all(...draftIds);
    for (const item of itemRows) {
      if (!itemsByDraft.has(item.draft_id)) itemsByDraft.set(item.draft_id, []);
      itemsByDraft.get(item.draft_id).push(item);
    }
  }
  const result = [];
  for (const row of rows) {
    const draft = decodeDraft(row, (itemsByDraft.get(row.id) || []).map(decodeItem));
    result.push({ ...draft, environmentHistory: await draftEnvironmentHistory(draft) });
  }
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
