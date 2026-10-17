import crypto from 'node:crypto';
import { AppError } from './errors.js';
import { db, guestProfile, id, inTransaction, isUniqueViolation, json, log, mysqlLockSuffix, now, transaction, escapeLikeValue, likeEscapeClause } from './db.js';
import { listAdminProjectSlots, listGuestProjectSlots, createReservation } from './booking.js';
import { createNotificationOnce } from './wellness-notifications.js';
import { listProjects } from './catalog.js';
import { systemBusinessClock } from './clock.js';
import { effectiveHealthConstraints, normalizeHealthProfile } from './health-profile.js';
import { staffServiceDetails } from './service-execution.js';

const SERVICE_JOBS = new Set(['coach', 'therapist', 'dietitian']);

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDays(date, days) {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function ageAt(birthDate, date) {
  if (!birthDate || !isValidDate(String(birthDate).slice(0, 10))) return null;
  const birth = String(birthDate).slice(0, 10);
  let age = Number(date.slice(0, 4)) - Number(birth.slice(0, 4));
  if (date.slice(5) < birth.slice(5)) age -= 1;
  return age >= 0 && age <= 125 ? age : null;
}

function requireIdempotencyKey(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(value)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', `${label}缺少有效的幂等标识`);
  }
}

function reservationStatus(row) {
  return row.checkin_status === 'no_show' ? 'no_show' : row.status;
}

async function slotsForIds(slotIds) {
  const placeholders = slotIds.map(() => '?').join(',');
  return db.prepare(`SELECT s.id,s.project_id AS projectId,s.business_date AS businessDate,s.starts_at AS startsAt,
      s.local_start AS localStart,s.local_end AS localEnd,s.capacity,s.is_closed AS isClosed,
      p.name AS projectName,p.outdoor,p.category,p.active AS projectActive,
      (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
    FROM activity_slots s JOIN projects p ON p.id=s.project_id WHERE s.id IN (${placeholders}) ORDER BY s.starts_at`).all(...slotIds);
}

export async function listOrganizationGuests({ query = '', date = '' } = {}) {
  const needle = String(query || '').trim().slice(0, 100);
  const dateFilter = String(date || '').trim();
  if (dateFilter && !isValidDate(dateFilter)) throw new AppError(400, 'GUEST_SEARCH_DATE_INVALID', '入住日期格式无效');
  // G40：改用统一转义助手，并补上此前缺失、导致 SQLite 下转义无效的 ESCAPE 子句。
  const match = escapeLikeValue(needle);
  const matchEsc = likeEscapeClause();
  const rows = await db.prepare(`SELECT u.id,u.name,u.status AS accountStatus,u.created_at AS createdAt,
      p.gender,p.birth_date AS birthDate,p.room_no AS roomNo,p.check_in AS checkIn,p.check_out AS checkOut,
      p.chronic_json AS chronicJson,p.allergies_json AS allergiesJson,p.health_profile_json AS healthProfileJson
    FROM users u JOIN guest_profiles p ON p.user_id=u.id
    WHERE u.role='guest' AND (?='' OR u.name LIKE ?${matchEsc} OR p.room_no LIKE ?${matchEsc} OR p.check_in LIKE ?${matchEsc})
      AND (?='' OR p.check_in=?) ORDER BY p.check_in DESC,u.name,u.id LIMIT 200`).all(
    needle, match, match, match, dateFilter, dateFilter);
  const today = systemBusinessClock.dateKey();
  // G24：一次性取回本页客人的待核实自述（每客人取 revision 最高的一条），替代逐行 N+1 查询。
  const guestIds = rows.map(row => row.id);
  const pendingByGuest = new Map();
  if (guestIds.length) {
    const intakePlaceholders = guestIds.map(() => '?').join(',');
    const pendingRows = await db.prepare(`SELECT guest_id, risk_level AS riskLevel FROM health_intakes
      WHERE status='pending' AND guest_id IN (${intakePlaceholders})
      ORDER BY guest_id, revision DESC, id DESC`).all(...guestIds);
    for (const pending of pendingRows) {
      if (!pendingByGuest.has(pending.guest_id)) pendingByGuest.set(pending.guest_id, pending);
    }
  }
  return await Promise.all(rows.map(async row => {
    const chronic = json(row.chronicJson, []);
    const allergies = json(row.allergiesJson, []);
    const latestPending = pendingByGuest.get(row.id);
    const riskFlags = [];
    if (chronic.length) riskFlags.push('慢病记录');
    if (allergies.length) riskFlags.push('过敏或忌口');
    if (latestPending?.riskLevel && latestPending.riskLevel !== 'normal') riskFlags.push('待核实健康信息');
    const checkIn = String(row.checkIn || '').slice(0, 10);
    const checkOut = String(row.checkOut || '').slice(0, 10);
    const stayStatus = row.accountStatus !== 'active' ? 'disabled'
      : !checkIn || !checkOut ? 'pending'
        : checkIn <= today && checkOut > today ? 'in_house'
          : checkOut <= today ? 'checked_out' : 'pending';
    return { id: row.id, name: row.name, gender: row.gender || '未提供', age: ageAt(row.birthDate, today),
      roomNo: row.roomNo || '', checkIn, checkOut, status: stayStatus, riskFlags,
      updatedAt: row.createdAt };
  }));
}

export async function organizationGuestHealthHistory(guestId) {
  const profile = await guestProfile(guestId);
  if (!profile) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  const rows = await db.prepare(`SELECT id,record_type AS type,value,unit,recorded_at AS recordedAt,
      note,voided_at AS voidedAt,void_reason AS voidReason
    FROM health_records WHERE guest_id=? ORDER BY recorded_at DESC,id DESC LIMIT 20`).all(guestId);
  return { guestId, updatedAt: profile.updated_at || null, items: rows,
    note: '只读健康历史；记录不构成诊断。' };
}

export async function listOrganizationSlots({ projectId = '', date = systemBusinessClock.dateKey(), days = 7 } = {}) {
  const today = systemBusinessClock.dateKey();
  if (!isValidDate(date) || date < today || date > addDays(today, 6)) {
    throw new AppError(400, 'OPERATIONS_SLOT_DATE_INVALID', '排期日期须在今天起七天内');
  }
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new AppError(400, 'OPERATIONS_SLOT_RANGE_INVALID', '周视图最多查询七天');
  const dateOffset = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const availableDays = Math.min(days, 7 - dateOffset);
  const projects = await listProjects({ includeInactive: true });
  const selected = projects.filter(project => !projectId || project.id === projectId);
  if (projectId && !selected.length) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
  const items = [];
  for (const project of selected) {
    for (let offset = 0; offset < availableDays; offset += 1) {
      const businessDate = addDays(date, offset);
      const [daily, weatherSnapshot] = await Promise.all([
        listAdminProjectSlots(project.id, businessDate),
        db.prepare(`SELECT snapshot_key AS snapshotKey,source_name AS sourceName,observed_at AS observedAt,status
          FROM environment_snapshots WHERE target_date=? AND domain='weather' ORDER BY observed_at DESC,created_at DESC LIMIT 1`)
          .get(businessDate)
      ]);
      items.push(...daily.slots.map(slot => ({ ...slot, projectId: project.id, projectName: project.name,
        category: project.category, outdoor: Boolean(project.outdoor), weatherSnapshotKey: weatherSnapshot?.snapshotKey || null,
        weatherSourceName: weatherSnapshot?.sourceName || '', weatherObservedAt: weatherSnapshot?.observedAt || null,
        weatherSnapshotStatus: weatherSnapshot?.status || null })));
    }
  }
  return { date, days: availableDays, projectId: projectId || null, items, total: items.length };
}

export async function listOrganizationReservations({ date = '', projectId = '', from = '', to = '', status = 'active' } = {}) {
  const startDate = from || date;
  const endDate = to || date;
  if (!isValidDate(startDate) || !isValidDate(endDate) || endDate < startDate
    || Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`) > 6 * 86_400_000) {
    throw new AppError(400, 'OPERATIONS_RESERVATION_RANGE_INVALID', '预约查询须指定不超过七天的有效日期');
  }
  if (!['active', 'history', 'all'].includes(status)) throw new AppError(400, 'OPERATIONS_RESERVATION_STATUS_INVALID', '预约状态筛选无效');
  const params = [startDate, endDate];
  const projectFilter = projectId ? ' AND s.project_id=?' : '';
  if (projectId) params.push(projectId);
  const rows = await db.prepare(`SELECT r.id,r.guest_id AS guestId,u.name AS guestName,r.slot_id AS slotId,
      s.project_id AS projectId,p.name AS projectName,s.business_date AS businessDate,
      s.starts_at AS startsAt,s.ends_at AS endsAt,s.local_start AS localStart,s.local_end AS localEnd,
      r.status,r.created_at AS createdAt,r.cancelled_at AS cancelledAt,r.cancellation_reason AS cancellationReason,
      c.status AS checkin_status,c.checked_at AS checkedAt,l.new_reservation_id AS rescheduledTo
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
      JOIN users u ON u.id=r.guest_id LEFT JOIN stage26_reservation_checkins c ON c.reservation_id=r.id
      LEFT JOIN stage26_reschedule_links l ON l.previous_reservation_id=r.id
    WHERE s.business_date>=? AND s.business_date<=?${projectFilter}
    ORDER BY s.starts_at,r.created_at,r.id LIMIT 500`).all(...params);
  const items = rows.map(row => ({ ...row, businessDate: String(row.businessDate).slice(0, 10),
    status: reservationStatus(row), checkinStatus: row.checkin_status === 'no_show' ? 'not_attended' : null }));
  const filtered = status === 'active' ? items.filter(item => item.status === 'confirmed')
    : status === 'history' ? items.filter(item => ['cancelled', 'no_show'].includes(item.status)) : items;
  return { from: startDate, to: endDate, projectId: projectId || null, status, items: filtered, total: filtered.length };
}

export async function markReservationNoShow({ reservationId, actorId }) {
  return await transaction(async () => {
    const row = await db.prepare(`SELECT r.id,r.status,s.starts_at AS startsAt,s.project_id AS projectId,
        p.name AS projectName,u.name AS guestName
      FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
      JOIN users u ON u.id=r.guest_id WHERE r.id=?${mysqlLockSuffix()}`).get(reservationId);
    if (!row) throw new AppError(404, 'RESERVATION_NOT_FOUND', '预约不存在');
    if (row.status !== 'confirmed') throw new AppError(409, 'RESERVATION_NOT_ACTIVE', '只有有效预约可以登记未参加');
    if (await db.prepare('SELECT id FROM wellness_checkins WHERE reservation_id=?').get(reservationId)) {
      throw new AppError(409, 'CHECKIN_ALREADY_RECORDED', '客人已实际签到，不能登记未参加');
    }
    const existing = await db.prepare('SELECT id,status,checked_at AS checkedAt FROM stage26_reservation_checkins WHERE reservation_id=?').get(reservationId);
    if (existing) {
      if (existing.status === 'no_show') return { reservationId, status: 'no_show', checkinStatus: 'not_attended', checkedAt: existing.checkedAt, replayed: true };
      throw new AppError(409, 'CHECKIN_ALREADY_RECORDED', '该预约已经登记签到');
    }
    if (Date.parse(row.startsAt) > Date.parse(systemBusinessClock.utc())) throw new AppError(409, 'NO_SHOW_TOO_EARLY', '项目开始后才能登记爽约');
    const stamp = now();
    await db.prepare(`INSERT INTO stage26_reservation_checkins(id,reservation_id,status,checked_at,actor_id,note)
      VALUES(?,?,'no_show',?,?,?)`).run(id('checkin'), reservationId, stamp, actorId, '未参加签到；预约容量不提前释放。');
    await log(actorId, 'reservation.no_show', 'reservation', reservationId, `项目 ${row.projectName} · 未参加签到`);
    return { reservationId, status: 'no_show', checkinStatus: 'not_attended', checkedAt: stamp,
      capacityReleased: false, replayed: false };
  });
}

export async function previewWeatherCancellation({ slotIds = [], snapshotKey = '' } = {}) {
  const ids = [...new Set(slotIds)];
  if (!ids.length || ids.length > 50 || ids.some(value => typeof value !== 'string' || value.length > 64)) {
    throw new AppError(400, 'WEATHER_BATCH_SLOTS_INVALID', '请选择 1 至 50 个有效时段');
  }
  if (typeof snapshotKey !== 'string' || !snapshotKey.trim() || snapshotKey.length > 190) {
    throw new AppError(400, 'WEATHER_SNAPSHOT_REQUIRED', '请指定一个环境快照来源');
  }
  const slots = await slotsForIds(ids);
  if (slots.length !== ids.length) throw new AppError(404, 'WEATHER_SLOT_NOT_FOUND', '部分时段不存在，请刷新后重试');
  const dates = new Set(slots.map(slot => String(slot.businessDate).slice(0, 10)));
  if (dates.size !== 1) throw new AppError(400, 'WEATHER_BATCH_DATE_MISMATCH', '一次天气处理只能选择同一天的时段');
  const snapshot = await db.prepare(`SELECT snapshot_key AS snapshotKey,target_date AS targetDate,domain,status,
      source_name AS sourceName,observed_at AS observedAt
    FROM environment_snapshots WHERE snapshot_key=? AND domain='weather'`).get(snapshotKey);
  if (!snapshot || String(snapshot.targetDate).slice(0, 10) !== [...dates][0]) {
    throw new AppError(409, 'WEATHER_SNAPSHOT_MISMATCH', '所选天气快照与项目日期不匹配');
  }
  if (slots.some(slot => !Number(slot.outdoor))) throw new AppError(409, 'WEATHER_SLOT_NOT_OUTDOOR', '批量天气取消只适用于户外时段');
  const bookings = await db.prepare(`SELECT r.id,r.guest_id AS guestId,u.name AS guestName,r.slot_id AS slotId,
      s.local_start AS localStart,s.local_end AS localEnd,p.name AS projectName
    FROM reservations r JOIN users u ON u.id=r.guest_id JOIN activity_slots s ON s.id=r.slot_id
      JOIN projects p ON p.id=s.project_id
    WHERE r.slot_id IN (${ids.map(() => '?').join(',')}) AND r.status='confirmed' ORDER BY s.starts_at,r.id`).all(...ids);
  return { snapshot: { snapshotKey: snapshot.snapshotKey, targetDate: String(snapshot.targetDate).slice(0, 10),
      status: snapshot.status, sourceName: snapshot.sourceName, observedAt: snapshot.observedAt },
    slots: slots.map(slot => ({ id: slot.id, projectId: slot.projectId, projectName: slot.projectName,
      businessDate: String(slot.businessDate).slice(0, 10), localStart: slot.localStart, localEnd: slot.localEnd,
      booked: Number(slot.booked), outdoor: true })),
    affectedReservations: bookings, totalReservations: bookings.length,
    note: snapshot.status === 'demo' ? '明确标记的隔离环境快照；不是实时天气服务结果。' : '保存的环境快照；取消前仍需运营人员核对。' };
}

export async function cancelWeatherAffectedSlots({ actorId, slotIds, snapshotKey, requestKey, reason }) {
  requireIdempotencyKey(requestKey, '天气批量操作');
  const cleanReason = String(reason || '').trim().slice(0, 500);
  if (!cleanReason) throw new AppError(400, 'WEATHER_REASON_REQUIRED', '请说明天气调整原因');
  const ids = [...new Set(slotIds || [])];
  const preview = await previewWeatherCancellation({ slotIds: ids, snapshotKey });
  const action = async () => {
    const previous = await db.prepare('SELECT id FROM stage26_weather_batches WHERE request_key=?').get(requestKey);
    if (previous) return await weatherBatchResult(previous.id, true);
    const stamp = now();
    const batchId = id('weather_batch');
    await db.prepare(`INSERT INTO stage26_weather_batches
      (id,request_key,actor_id,snapshot_key,source_name,observed_at,reason,created_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(batchId, requestKey, actorId, preview.snapshot.snapshotKey, preview.snapshot.sourceName,
        preview.snapshot.observedAt, cleanReason, stamp);
    for (const reservation of preview.affectedReservations) {
      const changed = await db.prepare(`UPDATE reservations SET status='cancelled',cancelled_at=?,cancellation_reason=?
        WHERE id=? AND status='confirmed'`).run(stamp, `weather_batch:${batchId}`, reservation.id);
      if (Number(changed.changes) !== 1) throw new AppError(409, 'WEATHER_RESERVATION_CHANGED', '预约状态已变化，请重新预览后操作');
      await db.prepare(`INSERT INTO stage26_weather_batch_items(id,batch_id,reservation_id,slot_id,guest_id,created_at)
        VALUES(?,?,?,?,?,?)`).run(id('weather_item'), batchId, reservation.id, reservation.slotId, reservation.guestId, stamp);
      await createNotificationOnce({ guestId: reservation.guestId, sourceType: 'weather_cancellation',
        sourceId: `${batchId}:${reservation.id}`, message: `因天气调整，${reservation.projectName} ${reservation.localStart}-${reservation.localEnd} 已取消。${cleanReason}`,
        targetType: 'reservation', targetId: reservation.id, targetUrl: 'schedule', notificationType: 'update', createdAt: stamp });
    }
    await log(actorId, 'reservation.weather_batch_cancel', 'weather_batch', batchId,
      `${preview.affectedReservations.length} 条预约；来源 ${preview.snapshot.sourceName} · ${preview.snapshot.snapshotKey}`);
    return await weatherBatchResult(batchId, false);
  };
  return inTransaction(action);
}

async function weatherBatchResult(batchId, replayed) {
  const batch = await db.prepare(`SELECT id,request_key AS requestKey,snapshot_key AS snapshotKey,
      source_name AS sourceName,observed_at AS observedAt,reason,created_at AS createdAt
    FROM stage26_weather_batches WHERE id=?`).get(batchId);
  if (!batch) throw new Error('weather batch did not persist');
  const rows = await db.prepare(`SELECT reservation_id AS reservationId,slot_id AS slotId,guest_id AS guestId
    FROM stage26_weather_batch_items WHERE batch_id=? ORDER BY reservation_id`).all(batchId);
  const items = await Promise.all(rows.map(async item => {
    const notification = await db.prepare(`SELECT id FROM wellness_local_notifications
      WHERE guest_id=? AND source_type='weather_cancellation' AND source_id=?`).get(
      item.guestId, `${batchId}:${item.reservationId}`);
    return { ...item, notificationId: notification?.id || null };
  }));
  return { ...batch, items, cancelledCount: items.length, replayed };
}

export async function listWeatherCancellationCandidates({ reservationId, guestId }) {
  const original = await db.prepare(`SELECT r.id,r.guest_id AS guestId,r.slot_id AS slotId,r.status,r.cancellation_reason AS cancellationReason,
      s.project_id AS projectId,s.business_date AS businessDate,p.name AS projectName
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id WHERE r.id=?`).get(reservationId);
  if (!original || original.guestId !== guestId) throw new AppError(404, 'RESERVATION_NOT_FOUND', '天气取消预约不存在');
  if (original.status !== 'cancelled' || !String(original.cancellationReason || '').startsWith('weather_batch:')) {
    throw new AppError(409, 'RESCHEDULE_NOT_AVAILABLE', '只有天气批量取消的预约可以改约');
  }
  const today = systemBusinessClock.dateKey();
  const firstDate = String(original.businessDate).slice(0, 10) > today ? String(original.businessDate).slice(0, 10) : today;
  const candidates = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(firstDate, offset);
    if (date > addDays(today, 6)) break;
    try {
      const day = await listGuestProjectSlots(original.projectId, date, guestId);
      candidates.push(...day.slots.map(slot => ({ id: slot.id, projectId: original.projectId, projectName: original.projectName,
        businessDate: date, localStart: slot.localStart, localEnd: slot.localEnd,
        status: slot.status, remaining: slot.remaining, reason: slot.reason,
        environmentSnapshotId: slot.environment?.environmentSnapshotId || null,
        safety: slot.environment?.status || slot.status })));
    } catch (error) {
      if (error.code !== 'SLOT_DATE_OUT_OF_RANGE') throw error;
    }
  }
  return { reservationId, projectId: original.projectId,
    candidates: candidates.filter(item => item.status === 'available'),
    unavailable: candidates.filter(item => item.status !== 'available').slice(0, 20),
    note: '候选按现有环境快照、项目规则、健康限制、开放状态与余量过滤；最终改约仍需本人或授权员工明确确认。' };
}

export async function confirmWeatherReschedule({ reservationId, guestId, actorId, slotId, requestKey }) {
  requireIdempotencyKey(requestKey, '改约');
  // Candidate generation may materialize the current seven-day slot inventory,
  // which uses its own transaction. Do that read before opening the atomic
  // reservation/link/notification transaction below; createReservation still
  // rechecks rules, stay, slot state and capacity under the transaction lock.
  const candidateSnapshot = await listWeatherCancellationCandidates({ reservationId, guestId });
  const action = async () => {
    const original = await db.prepare(`SELECT r.id,r.guest_id AS guestId,r.status,r.cancellation_reason AS cancellationReason,
        s.project_id AS projectId
      FROM reservations r JOIN activity_slots s ON s.id=r.slot_id WHERE r.id=?${mysqlLockSuffix()}`).get(reservationId);
    if (!original || original.guestId !== guestId) throw new AppError(404, 'RESERVATION_NOT_FOUND', '预约不存在');
    if (original.status !== 'cancelled' || !String(original.cancellationReason || '').startsWith('weather_batch:')) {
      throw new AppError(409, 'RESCHEDULE_NOT_AVAILABLE', '只有天气批量取消的预约可以改约');
    }
    const prior = await db.prepare(`SELECT new_reservation_id AS newReservationId FROM stage26_reschedule_links
      WHERE previous_reservation_id=?`).get(reservationId);
    if (prior) return { previousReservationId: reservationId, newReservationId: prior.newReservationId, replayed: true };
    const selected = candidateSnapshot.candidates.find(item => item.id === slotId);
    if (!selected) throw new AppError(409, 'RESCHEDULE_SLOT_UNAVAILABLE', '所选替代时段当前不可预约；请重新查看候选');
    const created = await createReservation({ guestId, slotId, idempotencyKey: requestKey });
    const newReservationId = created.reservation.id;
    const linkId = id('reschedule');
    const stamp = now();
    await db.prepare(`INSERT INTO stage26_reschedule_links(id,previous_reservation_id,new_reservation_id,actor_id,reason,created_at)
      VALUES(?,?,?,?,?,?)`).run(linkId, reservationId, newReservationId, actorId, '天气调整后经人工确认改约。', stamp);
    await createNotificationOnce({ guestId, sourceType: 'weather_reschedule', sourceId: linkId,
      message: `天气取消的预约已改到 ${selected.businessDate} ${selected.localStart}-${selected.localEnd}。`,
      targetType: 'reservation', targetId: newReservationId, targetUrl: 'schedule', notificationType: 'update', createdAt: stamp });
    await log(actorId, 'reservation.weather_reschedule', 'reservation', newReservationId,
      `原预约 ${reservationId}；新时段 ${slotId}；需确认后提交`);
    return { previousReservationId: reservationId, newReservationId, reservation: created.reservation,
      linkId, notificationCreated: true, replayed: false };
  };
  return inTransaction(action);
}

export async function assignStaffToSlot({ slotId, staffId, jobType, actorId }) {
  if (!SERVICE_JOBS.has(jobType)) throw new AppError(400, 'SLOT_ASSIGNMENT_JOB_INVALID', '只可分配教练、理疗师或配餐岗位');
  return await transaction(async () => {
    const slot = await db.prepare(`SELECT s.id,s.project_id AS projectId,s.business_date AS businessDate,
        s.local_start AS localStart,s.local_end AS localEnd,p.name AS projectName
      FROM activity_slots s JOIN projects p ON p.id=s.project_id WHERE s.id=?${mysqlLockSuffix()}`).get(slotId);
    if (!slot) throw new AppError(404, 'SLOT_NOT_FOUND', '项目时段不存在');
    const staff = await db.prepare(`SELECT id,name,job_type AS jobType,status FROM users
      WHERE id=? AND role='staff'`).get(staffId);
    if (!staff || staff.status !== 'active') throw new AppError(404, 'STAFF_NOT_ACTIVE', '在職員工不存在或已停用');
    if (staff.jobType !== jobType) throw new AppError(409, 'STAFF_JOB_MISMATCH', '员工岗位与任务岗位不匹配');
    const existing = await db.prepare(`SELECT id,staff_id AS staffId,job_type AS jobType,status
      FROM stage26_staff_slot_assignments WHERE slot_id=? AND job_type=?`).get(slotId, jobType);
    if (existing) {
      if (existing.staffId === staffId && existing.status === 'active') return { ...slot, ...existing, staffName: staff.name, replayed: true };
      throw new AppError(409, 'SLOT_JOB_ALREADY_ASSIGNED', '该时段岗位已有负责人');
    }
    const stamp = now();
    const assignmentId = id('slot_task');
    await db.prepare(`INSERT INTO stage26_staff_slot_assignments(id,slot_id,staff_id,job_type,status,assigned_by,created_at,updated_at)
      VALUES(?,?,?,?,'active',?,?,?)`).run(assignmentId, slotId, staffId, jobType, actorId, stamp, stamp);
    await log(actorId, 'staff.slot.assign', 'staff_slot_assignment', assignmentId,
      `${staff.name} · ${slot.projectName} · ${slot.businessDate} ${slot.localStart}-${slot.localEnd} · ${jobType}`);
    return { ...slot, id: assignmentId, slotId, staffId, staffName: staff.name, jobType, status: 'active', createdAt: stamp, replayed: false };
  });
}

export async function listStaffDailySchedule(user, date = systemBusinessClock.dateKey()) {
  if (!isValidDate(date)) throw new AppError(400, 'SCHEDULE_DATE_INVALID', '日程日期无效');
  const jobType = user.role === 'staff' ? user.job_type || 'clinician' : 'clinician';
  const items = await db.prepare(`SELECT a.id,a.slot_id AS slotId,a.job_type AS jobType,a.status AS taskStatus,
      s.business_date AS businessDate,s.starts_at AS startsAt,s.ends_at AS endsAt,
      s.local_start AS localStart,s.local_end AS localEnd,p.id AS projectId,p.name AS projectName,
      r.id AS reservationId,u.id AS guestId,u.name AS guestName,r.status AS reservationStatus
    FROM stage26_staff_slot_assignments a JOIN activity_slots s ON s.id=a.slot_id
      JOIN projects p ON p.id=s.project_id LEFT JOIN reservations r ON r.slot_id=s.id AND r.status='confirmed'
      LEFT JOIN users u ON u.id=r.guest_id
    WHERE a.staff_id=? AND a.job_type=? AND a.status='active' AND s.business_date=?
    ORDER BY s.starts_at,p.name,r.id`).all(user.id, jobType, date);
  const scopedItems = await Promise.all(items.map(item => staffServiceDetails(user, item)));
  return { date, jobType, items: scopedItems, total: scopedItems.length,
    privacyNote: '只显示当前岗位任务所需的客人姓名与预约编号；不包含电话、健康档案或医护审核操作。' };
}

async function operationDetails(kind, date) {
  if (kind === 'guests') return await db.prepare(`SELECT u.id,u.name,u.status AS accountStatus,p.room_no AS roomNo,
      p.check_in AS checkIn,p.check_out AS checkOut FROM users u LEFT JOIN guest_profiles p ON p.user_id=u.id
    WHERE u.role='guest' ORDER BY u.created_at DESC,u.id DESC LIMIT 200`).all();
  if (kind === 'reservations') return (await listOrganizationReservations({ date, status: 'all' })).items;
  if (kind === 'pendingReviews') return await db.prepare(`SELECT d.id,d.guest_id AS guestId,u.name AS guestName,
      d.version,d.review_status AS reviewStatus,d.created_at AS createdAt,d.review_reason AS reviewReason
    FROM wellness_drafts d JOIN users u ON u.id=d.guest_id WHERE d.review_status='pending_review'
    ORDER BY d.created_at,d.id LIMIT 200`).all();
  if (kind === 'incidents') return await db.prepare(`SELECT supplier_key AS supplier,feature_key AS feature,status,
      failure_count AS failureCount,first_failed_at AS firstFailedAt,last_failed_at AS lastFailedAt,
      recovered_at AS recoveredAt,impact_summary AS impactSummary
    FROM stage26_operations_incidents WHERE status='open' ORDER BY last_failed_at DESC LIMIT 200`).all();
  throw new AppError(400, 'OPERATIONS_DETAIL_INVALID', '运营明细类型无效');
}

export async function getOperationsSummary({ date = systemBusinessClock.dateKey(), detail = '' } = {}) {
  if (!isValidDate(date)) throw new AppError(400, 'OPERATIONS_DATE_INVALID', '运营日期无效');
  if (detail) return { date, detail, items: await operationDetails(detail, date), generatedAt: now() };
  const guests = await db.prepare(`SELECT COUNT(*) AS count FROM users WHERE role='guest'`).get();
  const reservations = await db.prepare(`SELECT COUNT(*) AS count FROM reservations r JOIN activity_slots s ON s.id=r.slot_id
    WHERE s.business_date=? AND r.status='confirmed'`).get(date);
  const pendingReviews = await db.prepare(`SELECT COUNT(*) AS count FROM wellness_drafts WHERE review_status='pending_review'`).get();
  const incidents = await db.prepare(`SELECT COUNT(*) AS count FROM stage26_operations_incidents WHERE status='open'`).get();
  return { date, generatedAt: now(), source: '当前隔离数据库实时汇总', metrics: [
    { key: 'guests', label: '客人账号', value: Number(guests.count || 0), detailKey: 'guests' },
    { key: 'reservations', label: '当日有效预约', value: Number(reservations.count || 0), detailKey: 'reservations' },
    { key: 'pendingReviews', label: '待审疗程', value: Number(pendingReviews.count || 0), detailKey: 'pendingReviews' },
    { key: 'incidents', label: '未关闭运营事项', value: Number(incidents.count || 0), detailKey: 'incidents' }
  ] };
}

function boundedKey(value, maxLength) {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean || clean.length > maxLength || !/^[a-z0-9._:-]+$/.test(clean)) throw new TypeError('provider key is invalid');
  return clean;
}

function failureThreshold() {
  const configured = Number(process.env.OPERATIONS_FAILURE_THRESHOLD || 3);
  return Number.isInteger(configured) ? Math.min(10, Math.max(1, configured)) : 3;
}

export async function recordProviderFailure({ supplier, feature, errorCode = 'PROVIDER_UNAVAILABLE', impact = '' }) {
  const supplierKey = boundedKey(supplier, 96);
  const featureKey = boundedKey(feature, 64);
  const safeCode = String(errorCode).replace(/[^A-Z0-9_.:-]/gi, '_').slice(0, 96) || 'PROVIDER_UNAVAILABLE';
  return await transaction(async () => {
    const stamp = now();
    await db.prepare(`INSERT INTO stage26_provider_events(id,supplier_key,feature_key,outcome,error_code,occurred_at)
      VALUES(?,?,?,'failed',?,?)`).run(id('provider_event'), supplierKey, featureKey, safeCode, stamp);
    const state = await db.prepare(`SELECT consecutive_failures AS consecutiveFailures,first_failed_at AS firstFailedAt
      FROM stage26_provider_state WHERE supplier_key=? AND feature_key=?${mysqlLockSuffix()}`).get(supplierKey, featureKey);
    const count = Number(state?.consecutiveFailures || 0) + 1;
    if (state) {
      await db.prepare(`UPDATE stage26_provider_state SET consecutive_failures=?,last_outcome='failed',
        first_failed_at=COALESCE(first_failed_at,?),last_failed_at=?,updated_at=? WHERE supplier_key=? AND feature_key=?`)
        .run(count, stamp, stamp, stamp, supplierKey, featureKey);
    } else {
      try {
        await db.prepare(`INSERT INTO stage26_provider_state(supplier_key,feature_key,consecutive_failures,last_outcome,
          first_failed_at,last_failed_at,last_success_at,updated_at) VALUES(?,?,?,'failed',?,?,NULL,?)`)
          .run(supplierKey, featureKey, count, stamp, stamp, stamp);
      } catch (error) { if (!isUniqueViolation(error)) throw error; }
    }
    if (count >= failureThreshold()) {
      const current = await db.prepare(`SELECT status FROM stage26_operations_incidents
        WHERE supplier_key=? AND feature_key=?${mysqlLockSuffix()}`).get(supplierKey, featureKey);
      const impactSummary = String(impact || '连续调用失败；相关资料查询暂时降级，其他运营功能可继续使用。').slice(0, 500);
      if (current) {
        await db.prepare(`UPDATE stage26_operations_incidents SET status='open',failure_count=?,first_failed_at=COALESCE(first_failed_at,?),
          last_failed_at=?,recovered_at=NULL,closed_at=NULL,closed_by=NULL,impact_summary=?,updated_at=?
          WHERE supplier_key=? AND feature_key=?`).run(count, stamp, stamp, impactSummary, stamp, supplierKey, featureKey);
      } else {
        await db.prepare(`INSERT INTO stage26_operations_incidents(supplier_key,feature_key,status,failure_count,
          first_failed_at,last_failed_at,recovered_at,closed_at,closed_by,impact_summary,created_at,updated_at)
          VALUES(?,?,'open',?,?,?,NULL,NULL,NULL,?,?,?)`).run(supplierKey, featureKey, count, stamp, stamp,
          impactSummary, stamp, stamp);
      }
    }
    return { supplier: supplierKey, feature: featureKey, consecutiveFailures: count,
      threshold: failureThreshold(), incidentCreated: count >= failureThreshold() };
  });
}

export async function recordProviderSuccess({ supplier, feature }) {
  const supplierKey = boundedKey(supplier, 96);
  const featureKey = boundedKey(feature, 64);
  return await transaction(async () => {
    const stamp = now();
    await db.prepare(`INSERT INTO stage26_provider_events(id,supplier_key,feature_key,outcome,error_code,occurred_at)
      VALUES(?,?,?,'succeeded','',?)`).run(id('provider_event'), supplierKey, featureKey, stamp);
    await db.prepare(`UPDATE stage26_provider_state SET consecutive_failures=0,last_outcome='succeeded',
      last_success_at=?,updated_at=? WHERE supplier_key=? AND feature_key=?`).run(stamp, stamp, supplierKey, featureKey);
    const result = await db.prepare(`UPDATE stage26_operations_incidents SET recovered_at=?,updated_at=?
      WHERE supplier_key=? AND feature_key=? AND status='open'`).run(stamp, stamp, supplierKey, featureKey);
    return { supplier: supplierKey, feature: featureKey, recovered: Number(result.changes || 0) > 0 };
  });
}

export async function closeOperationsIncident({ supplier, feature, actorId }) {
  const supplierKey = boundedKey(supplier, 96);
  const featureKey = boundedKey(feature, 64);
  return await transaction(async () => {
    const row = await db.prepare(`SELECT status,recovered_at AS recoveredAt,failure_count AS failureCount,
      impact_summary AS impactSummary FROM stage26_operations_incidents WHERE supplier_key=? AND feature_key=?${mysqlLockSuffix()}`)
      .get(supplierKey, featureKey);
    if (!row) throw new AppError(404, 'OPERATIONS_INCIDENT_NOT_FOUND', '运营事项不存在');
    if (row.status === 'closed') return { supplier: supplierKey, feature: featureKey, status: 'closed', replayed: true };
    if (!row.recoveredAt) throw new AppError(409, 'OPERATIONS_INCIDENT_NOT_RECOVERED', '服务恢复后才能关闭运营事项');
    const stamp = now();
    await db.prepare(`UPDATE stage26_operations_incidents SET status='closed',closed_at=?,closed_by=?,updated_at=?
      WHERE supplier_key=? AND feature_key=? AND status='open'`).run(stamp, actorId, stamp, supplierKey, featureKey);
    await log(actorId, 'operations.incident.close', 'operations_incident', `${supplierKey}:${featureKey}`, '服务恢复后关闭连续失败事项');
    return { supplier: supplierKey, feature: featureKey, status: 'closed', failureCount: Number(row.failureCount),
      recoveredAt: row.recoveredAt, closedAt: stamp, replayed: false };
  });
}

export async function listOperationsIncidents() {
  return await db.prepare(`SELECT supplier_key AS supplier,feature_key AS feature,status,
      failure_count AS failureCount,first_failed_at AS firstFailedAt,last_failed_at AS lastFailedAt,
      recovered_at AS recoveredAt,closed_at AS closedAt,impact_summary AS impactSummary
    FROM stage26_operations_incidents ORDER BY updated_at DESC LIMIT 200`).all();
}

export async function searchStaffReviewContext({ user, guestId }) {
  if (!guestId) throw new AppError(400, 'GUEST_CONTEXT_REQUIRED', '请选择当前负责的客人');
  if (user?.role !== 'staff' || user?.job_type !== 'clinician') throw new AppError(403, 'CLINICIAN_REQUIRED', '该只读资料工具仅供医护岗位使用');
  const assignment = await db.prepare(`SELECT id FROM staff_guest_assignments
    WHERE staff_id=? AND guest_id=? AND status='active' AND start_at<=?
      AND (end_at IS NULL OR end_at>?) LIMIT 1`).get(user.id, guestId, now(), now());
  if (!assignment) throw new AppError(403, 'GUEST_ACCESS_DENIED', '客人不在当前医护负责范围内');
  const guest = await db.prepare(`SELECT u.id,u.name,g.room_no AS roomNo,g.chronic_json AS chronicJson,
      g.allergies_json AS allergiesJson,g.health_profile_json AS healthProfileJson
    FROM users u JOIN guest_profiles g ON g.user_id=u.id WHERE u.id=? AND u.role='guest' AND u.status='active'`).get(guestId);
  if (!guest) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  const pendingRows = await db.prepare(`SELECT id,source,structured_json AS structuredJson
    FROM health_intakes WHERE guest_id=? AND status='pending' ORDER BY revision DESC,id DESC LIMIT 20`).all(guestId);
  const pendingIntakes = pendingRows.map(row => ({ id: row.id, source: row.source || 'pending-intake',
    profile: normalizeHealthProfile(json(row.structuredJson, {})) }));
  const verifiedProfile = normalizeHealthProfile(json(guest.healthProfileJson, {}));
  const assessmentRow = await db.prepare(`SELECT answers_json AS answersJson,version,updated_at AS updatedAt
    FROM health_assessment_progress WHERE guest_id=?`).get(guestId);
  const assessmentProfile = normalizeHealthProfile(json(assessmentRow?.answersJson, {}));
  const constraints = effectiveHealthConstraints({ verified: verifiedProfile, pendingIntakes,
    legacyAllergies: json(guest.allergiesJson, []) });
  const draft = await db.prepare(`SELECT d.id,d.version,d.review_status AS reviewStatus,d.review_reason AS reviewReason,
      d.created_at AS createdAt,d.evidence_json AS evidenceJson
    FROM wellness_drafts d WHERE d.guest_id=? AND d.review_status='pending_review'
    ORDER BY d.created_at DESC,d.version DESC LIMIT 1`).get(guestId);
  if (!draft) return { data: { guest: { id: guest.id, name: guest.name, roomNo: guest.roomNo }, pendingPlan: null,
      riskFlags: [], rules: [], answerBoundary: '没有查到当前待审方案；助手不得推断审批结论。' }, sources: [] };
  const riskFlags = [
    ...json(guest.chronicJson, []).map(value => `档案慢病记录：${value}`),
    ...(verifiedProfile.chronic.status === 'reported' ? verifiedProfile.chronic.items.map(value => `正式档案慢病：${value}`) : []),
    ...constraints.allergies.map(entry => `${entry.status === 'pending' ? '待核实的过敏自述' : '档案过敏记录'}：${entry.value}${entry.conflictsWithVerified ? '（与正式档案冲突）' : ''}`),
    ...constraints.dietaryRestrictions.map(entry => `${entry.status === 'pending' ? '待核实的饮食忌口自述' : '档案饮食忌口'}：${entry.value}${entry.conflictsWithVerified ? '（与正式档案冲突）' : ''}`),
    ...(verifiedProfile.skin.status === 'reported' ? [`正式档案皮肤情况：${verifiedProfile.skin.details}`] : []),
    ...pendingIntakes.flatMap(intake => {
      const profile = intake.profile;
      return [
        ...(profile.chronic.status === 'reported' ? profile.chronic.items.map(value => `待核实的慢病自述：${value}`) : []),
        ...(profile.medications.status === 'reported' ? profile.medications.items.map(item => `待核实的用药自述：${item.originalText}（${item.timing}）`) : []),
        ...(profile.skin.status === 'reported' ? [`待核实的皮肤自述：${profile.skin.details}`] : [])
      ];
    }),
    ...(assessmentProfile.chronic.status === 'reported' ? assessmentProfile.chronic.items.map(value => `未核实的初评慢病自述：${value}`) : []),
    ...(assessmentProfile.medications.status === 'reported' ? assessmentProfile.medications.items.map(item => `未核实的初评用药自述：${item.originalText}（${item.timing}）`) : []),
    ...(assessmentProfile.allergies.status === 'reported' ? assessmentProfile.allergies.items.map(value => `未核实的初评过敏自述：${value}`) : []),
    ...(assessmentProfile.dietaryRestrictions.status === 'reported' ? assessmentProfile.dietaryRestrictions.items.map(value => `未核实的初评饮食忌口自述：${value}`) : []),
    ...(assessmentProfile.skin.status === 'reported' ? [`未核实的初评皮肤自述：${assessmentProfile.skin.details}`] : [])
  ];
  const evidence = json(draft.evidenceJson, {});
  const draftItems = await db.prepare(`SELECT rule_ids_json AS ruleIds,evidence_json AS evidenceJson
    FROM wellness_draft_items WHERE draft_id=? ORDER BY business_date,slot_key,id`).all(draft.id);
  const ruleIds = new Set();
  const collectRules = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(collectRules); return; }
    for (const [key, child] of Object.entries(value)) {
      if ((key === 'ruleId' || key === 'rule_id') && typeof child === 'string') ruleIds.add(child);
      else if (/ruleIds/i.test(key) && Array.isArray(child)) child.forEach(item => typeof item === 'string' && ruleIds.add(item));
      else collectRules(child);
    }
  };
  collectRules(evidence);
  for (const item of draftItems) {
    collectRules(json(item.ruleIds, []));
    collectRules(json(item.evidenceJson, {}));
  }
  const rules = ruleIds.size ? await db.prepare(`SELECT rule_id AS id,title,trigger_condition AS summary FROM safety_rules
    WHERE rule_id IN (${[...ruleIds].map(() => '?').join(',')})`).all(...ruleIds) : [];
  const result = { data: { guest: { id: guest.id, name: guest.name, roomNo: guest.roomNo },
      pendingPlan: { id: draft.id, version: Number(draft.version), status: draft.reviewStatus,
        reason: draft.reviewReason || '', createdAt: draft.createdAt },
      riskFlags, rules, answerBoundary: '只读引用真实档案与规则；助手只能形成建议草稿，不能批准或更改方案。' },
    sources: [{ type: 'wellness_draft', id: draft.id, label: `待审方案 ${draft.id}` },
      ...rules.map(rule => ({ type: 'safety_rule', id: rule.id, label: rule.title })),
      ...pendingIntakes.map(intake => ({ type: 'health_intake', id: intake.id, label: `待核实健康自述 ${intake.id}` })),
      ...(assessmentRow ? [{ type: 'health_assessment', id: guest.id,
        label: `健康初评进度第 ${Number(assessmentRow.version)} 版（未核实，非正式档案）` }] : [])] };
  return result;
}

export async function searchOperationsCapacity({ projectId, date }) {
  if (!isValidDate(date)) throw new AppError(400, 'OPERATIONS_DATE_INVALID', '请传入有效日期');
  const projects = await listProjects({ includeInactive: false });
  let project = projectId ? projects.find(item => item.id === projectId) : null;
  if (!project && !projectId) throw new AppError(400, 'OPERATIONS_PROJECT_REQUIRED', '请先从项目目录确认项目编号');
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  const result = await listOrganizationSlots({ projectId: project.id, date, days: 1 });
  const items = result.items.map(slot => ({ slotId: slot.id, projectId: project.id, projectName: project.name,
    date: String(slot.businessDate).slice(0, 10), localStart: slot.localStart, localEnd: slot.localEnd,
    capacity: Number(slot.capacity), booked: Number(slot.booked), remaining: Number(slot.remaining),
    status: slot.status, isClosed: Boolean(slot.isClosed), dataTime: now() }));
  return { data: { project: { id: project.id, name: project.name }, date, dataTime: now(), slots: items,
      note: '只读本地预约数据；需要变更时须打开运营页并由有权员工再次确认。' },
    sources: items.map(item => ({ type: 'project_slot', id: item.slotId, label: `${project.name} ${item.localStart}` })) };
}

export const stage26Jobs = [...SERVICE_JOBS];
