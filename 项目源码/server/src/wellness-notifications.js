import { db, id, now } from './db.js';

function duplicateConstraint(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062
    || String(error?.code || '').startsWith('SQLITE_CONSTRAINT')
    || /UNIQUE constraint failed/i.test(String(error?.message || ''));
}

export async function createNotificationOnce({ guestId, sourceType, sourceId, message, targetType,
  targetId = '', targetUrl, notificationType = 'update', draftId = null, createdAt = now() }) {
  const normalizedSourceId = String(sourceId ?? '').trim();
  const normalizedMessage = String(message ?? '').trim();
  if (!guestId || !sourceType || !normalizedSourceId || !normalizedMessage || !targetType || !targetUrl) {
    throw new TypeError('notification requires a guest, source, message, target, and URL');
  }
  const eventKey = `${sourceType}:${guestId}:${normalizedSourceId}`;
  if (eventKey.length > 160 || normalizedSourceId.length > 160 || normalizedMessage.length > 1200) {
    throw new RangeError('notification source or message exceeds its storage limit');
  }
  let created = false;
  try {
    await db.prepare(`INSERT INTO wellness_local_notifications
      (id,guest_id,draft_id,event_key,message,created_at,source_type,source_id,target_type,target_id,target_url,notification_type,read_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL)`).run(id('wellness_notice'), guestId, draftId, eventKey,
      normalizedMessage, createdAt, sourceType, normalizedSourceId, targetType, String(targetId || ''), targetUrl,
      notificationType);
    created = true;
  } catch (error) {
    if (!duplicateConstraint(error)) throw error;
  }
  const row = await db.prepare(`SELECT id,guest_id AS guestId,source_type AS sourceType,source_id AS sourceId,
    target_type AS targetType,target_id AS targetId,target_url AS targetUrl,notification_type AS notificationType,
    message,created_at AS createdAt,read_at AS readAt
    FROM wellness_local_notifications WHERE guest_id=? AND source_type=? AND source_id=?`).get(
    guestId, sourceType, normalizedSourceId);
  if (!row) throw new Error('notification idempotency conflict did not resolve to a persisted row');
  return { ...row, created };
}

export async function listGuestNotifications(guestId) {
  const items = await db.prepare(`SELECT id,draft_id AS draftId,source_type AS sourceType,source_id AS sourceId,
      target_type AS targetType,target_id AS targetId,target_url AS targetUrl,
      notification_type AS notificationType,message,created_at AS createdAt,read_at AS readAt
    FROM wellness_local_notifications WHERE guest_id=? ORDER BY created_at DESC,id DESC LIMIT 100`).all(guestId);
  return { items, unreadCount: items.filter(item => !item.readAt).length };
}

export async function markGuestNotificationRead(guestId, notificationId, readAt = now()) {
  const existing = await db.prepare(`SELECT id,guest_id AS guestId,read_at AS readAt
    FROM wellness_local_notifications WHERE id=? AND guest_id=?`).get(notificationId, guestId);
  if (!existing) return null;
  if (!existing.readAt) {
    await db.prepare(`UPDATE wellness_local_notifications SET read_at=? WHERE id=? AND guest_id=? AND read_at IS NULL`)
      .run(readAt, notificationId, guestId);
  }
  return await db.prepare(`SELECT id,read_at AS readAt FROM wellness_local_notifications WHERE id=? AND guest_id=?`)
    .get(notificationId, guestId);
}

export async function createCareFollowUpTask({ guestId, sourceType, sourceId, title, detail, at = now() }) {
  const assignment = await db.prepare(`SELECT a.staff_id AS assigneeId
    FROM staff_guest_assignments a JOIN users s ON s.id=a.staff_id
    WHERE a.guest_id=? AND a.status='active' AND s.role='staff' AND s.status='active'
      AND a.start_at<=? AND (a.end_at IS NULL OR a.end_at>?)
    ORDER BY a.start_at DESC,a.id DESC LIMIT 1`).get(guestId, at, at);
  if (!assignment?.assigneeId) return null;
  const source = String(sourceId);
  const existing = await db.prepare(`SELECT id,status,assignee_id AS assigneeId FROM care_follow_up_tasks
    WHERE guest_id=? AND source_type=? AND source_id=?`).get(guestId, sourceType, source);
  if (existing) return { ...existing, created: false };
  try {
    await db.prepare(`INSERT INTO care_follow_up_tasks
      (id,guest_id,assignee_id,source_type,source_id,title,detail,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,'open',?,?)`).run(id('care_task'), guestId, assignment.assigneeId,
      sourceType, source, String(title).slice(0, 180), String(detail).slice(0, 1200), at, at);
  } catch (error) {
    if (!duplicateConstraint(error)) throw error;
  }
  const task = await db.prepare(`SELECT id,status,assignee_id AS assigneeId FROM care_follow_up_tasks
    WHERE guest_id=? AND source_type=? AND source_id=?`).get(guestId, sourceType, source);
  return task ? { ...task, created: task.assigneeId === assignment.assigneeId } : null;
}

export async function syncCareSignals(guestId, at = now()) {
  const focusItems = await db.prepare(`SELECT id,streak_start AS streakStart,streak_end AS streakEnd
    FROM mood_focus_items WHERE guest_id=? AND status='open' ORDER BY streak_end DESC,id DESC LIMIT 20`).all(guestId);
  const reviewEvents = await db.prepare(`SELECT id,draft_id AS draftId,action,reason,from_version AS fromVersion,
      to_version AS toVersion
    FROM wellness_review_events WHERE guest_id=? AND action='corrected'
    ORDER BY created_at DESC,id DESC LIMIT 20`).all(guestId);
  for (const item of focusItems) {
    await createNotificationOnce({ guestId, sourceType: 'mood_focus_item', sourceId: item.id,
      message: '近三日的心情记录需要工作人员留意；如愿意，可以联系负责人员聊聊。',
      targetType: 'mood_focus', targetId: item.id, targetUrl: 'mood', notificationType: 'care', createdAt: at });
    await createCareFollowUpTask({ guestId, sourceType: 'mood_focus_item', sourceId: item.id,
      title: '跟进客人近三日心情记录',
      detail: `关注记录区间 ${String(item.streakStart).slice(0, 10)} 至 ${String(item.streakEnd).slice(0, 10)}；按现有负责关系联系客人，不作诊断。`, at });
  }
  for (const event of reviewEvents) {
    const versionLabel = event.fromVersion && event.toVersion
      ? `第 ${event.fromVersion} 版调整为第 ${event.toVersion} 版` : '疗程安排已修订';
    const reason = String(event.reason || '').trim();
    await createNotificationOnce({ guestId, sourceType: 'wellness_review_event', sourceId: event.id,
      draftId: event.draftId,
      message: `医护已修订疗程（${versionLabel}）。${reason}`.slice(0, 1200),
      targetType: 'wellness_revision', targetId: event.draftId, targetUrl: 'schedule', notificationType: 'care', createdAt: at });
    await createCareFollowUpTask({ guestId, sourceType: 'wellness_review_event', sourceId: event.id,
      title: '跟进已修订的疗程安排',
      detail: `疗程版本已调整（${versionLabel}）；来源事件 ${event.id}，请核对本人今日安排。${reason}`, at });
  }
  return { moodFocusCount: focusItems.length, correctedReviewCount: reviewEvents.length };
}
