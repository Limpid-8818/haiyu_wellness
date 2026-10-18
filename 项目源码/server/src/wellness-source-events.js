import { db, id, inTransaction, now } from './db.js';

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
  return inTransaction(persist);
}

export async function markReplanDraftActive(draftId) {
  await db.prepare(`UPDATE wellness_replan_events SET status='active',updated_at=? WHERE candidate_draft_id=?`)
    .run(now(), draftId);
}
