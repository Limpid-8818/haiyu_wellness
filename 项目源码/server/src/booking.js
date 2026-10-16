import crypto from 'node:crypto';
import { db, guestProfile, hasActiveTransaction, id, json, log, now, transaction } from './db.js';
import { decodeProject, getProject, listProjects, listRules } from './catalog.js';
import { effectiveHealthConstraints, normalizeHealthProfile } from './health-profile.js';
import { AppError } from './errors.js';
import { getEnvironmentSnapshot } from './environment.js';
import { assessEnvironmentWindow } from './environment-availability.js';
import { shiftDateKey, systemBusinessClock } from './clock.js';
import { isDateOnly } from './staffing.js';

const SLOT_MINUTES = 60;
const DAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const lockSuffix = () => db.driver === 'mysql' ? ' FOR UPDATE' : '';
const inTransaction = callback => hasActiveTransaction() ? callback() : transaction(callback);

function localDateTimeToUtc(date, time) {
  return systemBusinessClock.localToUtc(date, time);
}

function dateDay(date) {
  return DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

function minutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function timeText(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
}

function slotId(projectId, date, start, end) {
  const digest = crypto.createHash('sha256').update(`${projectId}\u0000${date}\u0000${start}\u0000${end}`).digest('hex').slice(0, 32);
  return `slot_${digest}`;
}

function isDuplicate(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062
    || String(error?.code || '').startsWith('SQLITE_CONSTRAINT')
    || /UNIQUE constraint failed/i.test(String(error?.message || ''));
}

export function slotWindowsForDate(project, date) {
  if (!isDateOnly(date)) throw new AppError(400, 'SLOT_DATE_INVALID', '日期必须是有效的 YYYY-MM-DD');
  const day = dateDay(date);
  const windows = Array.isArray(project.openWindows) ? project.openWindows : [];
  const slots = [];
  for (const window of windows) {
    if (!Array.isArray(window.days) || !(window.days.includes('每日') || window.days.includes(day))) continue;
    const start = minutes(window.start);
    const end = minutes(window.end);
    if (start === null || end === null || end <= start) continue;
    for (let cursor = start; cursor < end;) {
      const next = Math.min(cursor + SLOT_MINUTES, end);
      const localStart = timeText(cursor);
      const localEnd = timeText(next);
      slots.push({
        id: slotId(project.id, date, localStart, localEnd),
        projectId: project.id,
        businessDate: date,
        startsAt: localDateTimeToUtc(date, localStart),
        endsAt: localDateTimeToUtc(date, localEnd),
        localStart,
        localEnd,
        capacity: project.capacityPerWindow,
        location: project.location
      });
      cursor = next;
    }
  }
  const unique = new Map(slots.map(slot => [`${slot.localStart}|${slot.localEnd}`, slot]));
  return [...unique.values()].sort((left, right) => left.localStart.localeCompare(right.localStart) || left.localEnd.localeCompare(right.localEnd));
}

function slotMatchesCurrentWindow(project, slot) {
  const date = String(slot.business_date ?? slot.businessDate ?? '').slice(0, 10);
  if (!isDateOnly(date) || !slot?.id) return false;
  return slotWindowsForDate(project, date).some(candidate => candidate.id === slot.id);
}

export async function ensureProjectSlots(project, { startDate = systemBusinessClock.dateKey(), days = 7 } = {}) {
  if (!Number.isInteger(days) || days < 1 || days > 7) throw new AppError(400, 'SLOT_RANGE_INVALID', '一次最多生成未来七天的时段');
  if (!project?.active) return { generated: 0, slotCount: 0 };
  // 先在内存中算出应有时段、一次查询既有行，只补缺失部分：读路径不再产生
  // 成百上千次注定冲突的 INSERT，也不在无需写入时开启写事务（G07）。
  const expected = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = shiftDateKey(startDate, offset);
    for (const slot of slotWindowsForDate(project, date)) expected.push(slot);
  }
  const existingRows = await db.prepare(`SELECT id FROM activity_slots
    WHERE project_id=? AND business_date>=? AND business_date<?`).all(
    project.id, startDate, shiftDateKey(startDate, days)
  );
  const existing = new Set(existingRows.map(row => row.id));
  const missing = expected.filter(slot => !existing.has(slot.id));
  let generated = 0;
  if (missing.length) {
    await transaction(async () => {
      for (const slot of missing) {
        try {
          const result = await db.prepare(`INSERT INTO activity_slots
            (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?, ?,0,?,?)`).run(
            slot.id, slot.projectId, slot.businessDate, slot.startsAt, slot.endsAt,
            slot.localStart, slot.localEnd, slot.capacity, now(), now()
          );
          generated += Number(result.changes || 0);
        } catch (error) {
          if (!isDuplicate(error)) throw error;
        }
      }
    });
  }
  const count = Number((await db.prepare(`SELECT COUNT(*) AS count FROM activity_slots
    WHERE project_id=? AND business_date>=? AND business_date<?`).get(
    project.id, startDate, shiftDateKey(startDate, days)
  )).count || 0);
  return { generated, slotCount: count };
}

async function bookingHealthState(guestId) {
  const profile = await guestProfile(guestId);
  if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  const verifiedProfile = normalizeHealthProfile(profile.health_profile);
  const rows = await db.prepare(`SELECT id,source,structured_json AS structuredJson FROM health_intakes
    WHERE guest_id=? AND status='pending' ORDER BY revision DESC,id DESC`).all(guestId);
  const pendingIntakes = rows.map(row => {
    let candidate = {};
    try {
      const parsed = json(row.structuredJson, {});
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) candidate = normalizeHealthProfile(parsed);
    } catch { candidate = {}; }
    return { id: row.id, source: row.source || 'pending-intake', candidate, profile: candidate };
  });
  const effective = effectiveHealthConstraints({
    verified: verifiedProfile,
    pendingIntakes: pendingIntakes.map(item => ({ ...item, profile: item.candidate })),
    legacyAllergies: profile.allergies
  });
  return { profile, verifiedProfile, pendingIntakes, effectiveHealthConstraints: effective };
}

function hourChecksForSlot(slot) {
  const start = minutes(slot.local_start ?? slot.localStart);
  const end = minutes(slot.local_end ?? slot.localEnd);
  const times = [];
  for (let cursor = Math.floor(start / 60) * 60; cursor < end; cursor += 60) times.push(timeText(cursor));
  return times;
}

async function evaluateSlot({ project, slot, guestId, profileState, legacyProfile, rules, snapshot }) {
  if (!slotMatchesCurrentWindow(project, slot)) return {
    status: 'window_changed', available: false, isDemo: Boolean(project.isDemo),
    reason: '项目开放窗口已调整，此时段不再开放预约。', ruleDecisions: [],
    environmentSnapshotId: snapshot.snapshotId, checks: []
  };
  const checks = hourChecksForSlot(slot).map(time => assessEnvironmentWindow({
    project, snapshot, time, profileState, legacyProfile, rules
  }));
  if (!checks.length) return {
    status: 'pending', available: false, isDemo: Boolean(project.isDemo),
    reason: '时段不在项目开放窗口内，不能预约。', ruleDecisions: []
  };
  const blocking = checks.find(check => !check.available);
  const status = blocking ? (checks.some(check => check.status === 'pending') ? 'pending' : blocking.status) : 'available';
  const reasons = [...new Set(checks.filter(check => !check.available).map(check => check.reason).filter(Boolean))];
  return {
    status,
    available: checks.every(check => check.available),
    isDemo: Boolean(project.isDemo || checks.some(check => check.isDemo)),
    reason: reasons.join(' ') || checks[0].reason,
    ruleDecisions: checks.flatMap(check => check.ruleDecisions || []),
    environmentSnapshotId: snapshot.snapshotId,
    checks: checks.map(({ time, status: checkStatus, available, reason, ruleDecisions }) => ({ time, status: checkStatus, available, reason, ruleDecisions }))
  };
}

// Stage21 reads only slots that already exist. It deliberately avoids
// ensureProjectSlots(), which is allowed to materialize booking inventory for
// the interactive booking page but would make a draft write capacity data.
export async function evaluateExistingDraftSlot({ project, row, guestId }) {
  const slot = rowToSlot(row);
  const [health, legacyProfile, rules, snapshot] = await Promise.all([
    bookingHealthState(guestId), guestProfile(guestId), listRules(), getEnvironmentSnapshot(slot.businessDate)
  ]);
  const environment = await evaluateSlot({ project, slot, guestId, profileState: health, legacyProfile, rules, snapshot });
  const remaining = Math.max(0, slot.capacity - slot.booked);
  const stayReason = guestStayIssue(health.profile, slot.businessDate);
  const isPast = Date.parse(slot.startsAt) <= Date.parse(systemBusinessClock.utc());
  const overlap = await db.prepare(`SELECT r.id FROM reservations r
    JOIN activity_slots other_slot ON other_slot.id=r.slot_id
    WHERE r.guest_id=? AND r.status='confirmed' AND other_slot.starts_at<? AND other_slot.ends_at>? LIMIT 1`)
    .get(guestId, slot.endsAt, slot.startsAt);
  const status = !project.active ? 'inactive'
    : slot.isClosed ? 'closed'
      : isPast ? 'past'
        : environment.status === 'window_changed' ? 'window_changed'
          : !environment.available ? environment.status
            : overlap ? 'conflict'
              : remaining <= 0 ? 'full'
                : stayReason ? 'stay_required' : 'available';
  const reason = status === 'inactive' ? '项目已停用，不能安排。'
    : status === 'closed' ? '此时段已关闭。'
      : status === 'past' ? '时段已开始或结束。'
        : status === 'window_changed' ? environment.reason
          : status === 'conflict' ? '与已有有效预约时间重叠。'
            : status === 'full' ? '当前余量为零。'
              : status === 'stay_required' ? stayReason
                : !environment.available ? environment.reason : environment.reason;
  return { slot, status, available: status === 'available', remaining, reason, environment,
    bookedReservationConflict: overlap?.id || null };
}

function guestStayIssue(profile, date) {
  const checkIn = typeof profile.check_in === 'string' ? profile.check_in.slice(0, 10) : '';
  const checkOut = typeof profile.check_out === 'string' ? profile.check_out.slice(0, 10) : '';
  if (!isDateOnly(checkIn) || !isDateOnly(checkOut) || checkOut <= checkIn) return '入住日期尚未确认，请联系工作人员维护有效入住区间。';
  if (date < checkIn || date >= checkOut) return '时段不在您的有效入住区间内，不能预约。';
  return '';
}

function rowToSlot(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    businessDate: String(row.business_date).slice(0, 10),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    localStart: row.local_start,
    localEnd: row.local_end,
    location: row.location,
    capacity: Number(row.capacity),
    isClosed: Boolean(Number(row.is_closed)),
    projectActive: Boolean(Number(row.project_active)),
    isDemo: Boolean(Number(row.project_is_demo)),
    booked: Number(row.booked || 0)
  };
}

async function slotRows(projectId, date) {
  const rows = await db.prepare(`SELECT s.*,p.name AS project_name,p.location,p.is_demo AS project_is_demo,
      p.active AS project_active,
      (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
    FROM activity_slots s JOIN projects p ON p.id=s.project_id
    WHERE s.project_id=? AND s.business_date=? ORDER BY s.starts_at,s.ends_at`).all(projectId, date);
  return rows.map(rowToSlot);
}

function withinNextSevenDays(date) {
  const today = systemBusinessClock.dateKey();
  return isDateOnly(date) && date >= today && date <= shiftDateKey(today, 6);
}

async function guestProjectSlots(project, date, guestId) {
  const projectId = project.id;
  const [slots, health, legacyProfile, rules, snapshot] = await Promise.all([
    slotRows(projectId, date), bookingHealthState(guestId), guestProfile(guestId), listRules(), getEnvironmentSnapshot(date)
  ]);
  const result = [];
  for (const slot of slots) {
    const environment = await evaluateSlot({ project, slot, guestId, profileState: health, legacyProfile, rules, snapshot });
    const remaining = Math.max(0, slot.capacity - slot.booked);
    const stayReason = guestStayIssue(health.profile, slot.businessDate);
    const isPast = Date.parse(slot.startsAt) <= Date.parse(systemBusinessClock.utc());
    const status = !project.active ? 'inactive'
      : slot.isClosed ? 'closed'
        : isPast ? 'past'
          : environment.status === 'window_changed' ? 'window_changed'
          : !environment.available ? environment.status
            : remaining <= 0 ? 'full' : stayReason ? 'stay_required' : 'available';
    const reason = status === 'inactive' ? '项目已停用，不能预约。'
      : status === 'closed' ? '此时段已关闭预约。'
        : status === 'past' ? '时段已开始或结束，不能预约。'
          : status === 'window_changed' ? environment.reason
          : status === 'full' ? '此时段已约满。'
            : status === 'stay_required' ? stayReason
              : !environment.available ? environment.reason : environment.reason;
    result.push({ ...slot, remaining, status, available: status === 'available', bookable: status === 'available',
      reason, environment: { ...environment, reason: environment.reason }, isDemo: Boolean(project.isDemo || environment.isDemo) });
  }
  return { projectId, projectName: project.name, date, timeZone: systemBusinessClock.timeZone, isDemo: project.isDemo, slots: result };
}

export async function inspectGuestProjectSlots(projectId, date, guestId) {
  if (!withinNextSevenDays(date)) throw new AppError(400, 'SLOT_DATE_OUT_OF_RANGE', '只能查看今天起七天内的预约时段');
  const project = await getProject(projectId);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  return await guestProjectSlots(project, date, guestId);
}

export async function listGuestProjectSlots(projectId, date, guestId) {
  if (!withinNextSevenDays(date)) throw new AppError(400, 'SLOT_DATE_OUT_OF_RANGE', '只能查看今天起七天内的预约时段');
  const project = await getProject(projectId);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  await ensureProjectSlots(project, { startDate: systemBusinessClock.dateKey(), days: 7 });
  return await guestProjectSlots(project, date, guestId);
}

export async function listAdminProjectSlots(projectId, date) {
  if (!withinNextSevenDays(date)) throw new AppError(400, 'SLOT_DATE_OUT_OF_RANGE', '只能查看今天起七天内的排期');
  const projects = await listProjects({ includeInactive: true });
  const project = projects.find(item => item.id === projectId);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
  await ensureProjectSlots(project, { startDate: systemBusinessClock.dateKey(), days: 7 });
  const slots = await slotRows(projectId, date);
  return {
    projectId, projectName: project.name, date, isDemo: project.isDemo,
    slots: slots.map(slot => {
      const windowCurrent = slotMatchesCurrentWindow(project, slot);
      return {
        ...slot,
        windowCurrent,
        remaining: Math.max(0, slot.capacity - slot.booked),
        status: slot.isClosed ? 'closed' : !windowCurrent ? 'window_changed' : slot.booked >= slot.capacity ? 'full' : 'open'
      };
    })
  };
}

async function reservationById(idValue, guestId) {
  return db.prepare(`SELECT r.*,s.project_id,s.business_date,s.starts_at,s.ends_at,s.local_start,s.local_end,
      s.capacity,p.name AS project_name,p.location,p.is_demo AS project_is_demo,
      c.status AS checkin_status,c.checked_at AS checked_at
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
      LEFT JOIN stage26_reservation_checkins c ON c.reservation_id=r.id
    WHERE r.id=? AND r.guest_id=?`).get(idValue, guestId);
}

function publicReservation(row) {
  if (!row) return null;
  return {
    id: row.id,
    guestId: row.guest_id,
    slotId: row.slot_id,
    projectId: row.project_id,
    projectName: row.project_name,
    location: row.location,
    businessDate: String(row.business_date).slice(0, 10),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    localStart: row.local_start,
    localEnd: row.local_end,
    status: row.checkin_status === 'no_show' ? 'no_show' : row.status,
    checkinStatus: row.checkin_status === 'no_show' ? 'not_attended' : null,
    checkedAt: row.checked_at || null,
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    reason: row.availability_reason,
    availabilityStatus: row.availability_status,
    environmentSnapshotId: row.environment_snapshot_id,
    isDemo: Boolean(Number(row.is_demo || row.project_is_demo))
  };
}

export async function createReservation({ guestId, slotId: requestedSlotId, idempotencyKey,
  wellnessDraftId = null, wellnessDraftItemId = null }) {
  if (typeof requestedSlotId !== 'string' || !requestedSlotId.trim() || requestedSlotId.length > 64) {
    throw new AppError(400, 'SLOT_ID_INVALID', '请选择一个预约时段');
  }
  if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9:_-]{8,120}$/.test(idempotencyKey)) {
    throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', '预约请求缺少有效的幂等标识');
  }
  const fingerprint = crypto.createHash('sha256').update(requestedSlotId).digest('hex');
  // 环境快照在 live 冷缓存时可能触发外部 HTTP（三域串行最坏数十秒）。
  // 必须在开事务前取好，避免期间占用 SQLite 全局事务串行链 / MySQL 行锁（G03）。
  const slotDateRow = await db.prepare('SELECT business_date FROM activity_slots WHERE id=?').get(requestedSlotId);
  const prefetchedSnapshot = slotDateRow
    ? await getEnvironmentSnapshot(String(slotDateRow.business_date).slice(0, 10))
    : null;
  const create = async () => {
    const guest = await db.prepare(`SELECT id FROM users WHERE id=? AND role='guest' AND status='active'${lockSuffix()}`).get(guestId);
    if (!guest) throw new AppError(409, 'GUEST_INACTIVE', '客人账号不存在或已停用');
    await db.prepare(`SELECT user_id FROM guest_profiles WHERE user_id=?${lockSuffix()}`).get(guestId);

    const previous = await db.prepare('SELECT * FROM reservations WHERE guest_id=? AND idempotency_key=?').get(guestId, idempotencyKey);
    if (previous) {
      if (previous.request_fingerprint !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '该预约标识已用于不同的预约时段');
      return { reservation: publicReservation(await reservationById(previous.id, guestId)), replayed: true };
    }

    const slot = await db.prepare(`SELECT s.*,p.active AS project_active,p.name AS project_name,
        p.location,p.is_demo AS project_is_demo,p.category,p.intensity,p.activity_tag,p.sea_entry,p.outdoor,
        p.open_windows_json,p.capacity_per_window,p.suitable_people,p.contraindications,p.slug,p.description,
        p.source_reference,p.updated_at AS project_updated_at
      FROM activity_slots s JOIN projects p ON p.id=s.project_id WHERE s.id=?${lockSuffix()}`).get(requestedSlotId);
    if (!slot) throw new AppError(404, 'SLOT_NOT_FOUND', '预约时段不存在，请刷新项目时段');
    if (!Number(slot.project_active)) throw new AppError(409, 'PROJECT_INACTIVE', '项目已停用，不能创建新预约');
    // The joined FOR UPDATE read is a current read in MySQL REPEATABLE READ.
    // Keep all project validation on this locked row; a normal getProject() read
    // here could reuse the transaction's older consistent-read snapshot.
    const project = decodeProject({
      ...slot,
      id: slot.project_id,
      name: slot.project_name,
      active: slot.project_active,
      is_demo: slot.project_is_demo,
      updated_at: slot.project_updated_at
    });
    if (!project) throw new AppError(409, 'PROJECT_INACTIVE', '项目已停用，不能创建新预约');
    if (!slotMatchesCurrentWindow(project, slot)) {
      throw new AppError(409, 'SLOT_WINDOW_CHANGED', '项目开放窗口已调整，此时段不再开放预约。', { slotId: requestedSlotId });
    }
    const health = await bookingHealthState(guestId);
    const snapshot = prefetchedSnapshot;
    const rules = await listRules();
    const availability = await evaluateSlot({
      project, slot, guestId, profileState: health, legacyProfile: health.profile, rules, snapshot
    });
    if (!availability.available) {
      throw new AppError(409, 'SLOT_NOT_AVAILABLE', availability.reason || '此时段当前不可预约', {
        slotId: requestedSlotId, status: availability.status, environment: availability
      });
    }
    if (guestStayIssue(health.profile, String(slot.business_date).slice(0, 10))) {
      throw new AppError(409, 'STAY_NOT_ACTIVE', guestStayIssue(health.profile, String(slot.business_date).slice(0, 10)));
    }
    if (Number(slot.is_closed)) throw new AppError(409, 'SLOT_CLOSED', '此时段已关闭预约');
    const startsAt = slot.starts_at;
    const endsAt = slot.ends_at;
    if (Date.parse(startsAt) <= Date.parse(systemBusinessClock.utc())) throw new AppError(409, 'SLOT_PAST', '时段已开始或结束，不能预约');

    const overlap = await db.prepare(`SELECT r.id FROM reservations r JOIN activity_slots other_slot ON other_slot.id=r.slot_id
      WHERE r.guest_id=? AND r.status='confirmed' AND other_slot.starts_at<? AND other_slot.ends_at>?${lockSuffix()}`)
      .get(guestId, endsAt, startsAt);
    if (overlap) throw new AppError(409, 'RESERVATION_TIME_CONFLICT', '您已有一条时间重叠的有效预约');

    const activeForSlot = await db.prepare(`SELECT id FROM reservations WHERE slot_id=? AND status='confirmed'${lockSuffix()}`).all(requestedSlotId);
    const booked = activeForSlot.length;
    if (Number(slot.is_closed)) throw new AppError(409, 'SLOT_CLOSED', '此时段已关闭预约');
    if (booked >= Number(slot.capacity)) throw new AppError(409, 'SLOT_FULL', '此时段已约满', { capacity: Number(slot.capacity), booked });

    const reservationId = id('res');
    const stamp = now();
    const isDemo = Boolean(project.isDemo || availability.isDemo);
    await db.prepare(`INSERT INTO reservations
      (id,guest_id,slot_id,idempotency_key,request_fingerprint,status,created_at,cancelled_at,cancellation_reason,
       environment_snapshot_id,availability_status,availability_reason,is_demo,wellness_draft_id,wellness_draft_item_id)
      VALUES(?,?,?,?,?,'confirmed',?,NULL,NULL,?,?,?,?,?,?)`).run(
      reservationId, guestId, requestedSlotId, idempotencyKey, fingerprint, stamp,
      availability.environmentSnapshotId || snapshot.snapshotId, availability.status,
      availability.reason || '环境与健康规则允许预约。', isDemo ? 1 : 0, wellnessDraftId, wellnessDraftItemId
    );
    await log(guestId, 'reservation.create', 'reservation', reservationId, `项目 ${project.name} · ${slot.business_date} ${slot.local_start}-${slot.local_end}`);
    return { reservation: publicReservation(await reservationById(reservationId, guestId)), replayed: false };
  };
  return hasActiveTransaction() ? create() : transaction(create);
}

export async function listGuestReservations(guestId) {
  const rows = await db.prepare(`SELECT r.*,s.project_id,s.business_date,s.starts_at,s.ends_at,s.local_start,s.local_end,
      s.capacity,p.name AS project_name,p.location,p.is_demo AS project_is_demo,
      c.status AS checkin_status,c.checked_at AS checked_at
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
      LEFT JOIN stage26_reservation_checkins c ON c.reservation_id=r.id
    WHERE r.guest_id=? ORDER BY s.starts_at DESC,r.created_at DESC`).all(guestId);
  return { items: rows.map(publicReservation), total: rows.length };
}

export async function listGuestSchedule(guestId) {
  const rows = await db.prepare(`SELECT r.id,r.guest_id AS guestId,r.slot_id AS slotId,
      CASE WHEN c.status='no_show' THEN 'no_show' ELSE r.status END AS status,
      CASE WHEN c.status='no_show' THEN 'not_attended' ELSE NULL END AS checkinStatus,
      c.checked_at AS checkedAt,r.created_at AS createdAt,
      s.project_id AS projectId,s.business_date AS businessDate,s.starts_at AS startsAt,s.ends_at AS endsAt,
      s.local_start AS localStart,s.local_end AS localEnd,p.name AS projectName,p.location
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
      LEFT JOIN stage26_reservation_checkins c ON c.reservation_id=r.id
    WHERE r.guest_id=? AND r.status='confirmed' ORDER BY s.starts_at`).all(guestId);
  return { guestId, items: rows, total: rows.length };
}

export async function cancelReservation({ guestId, reservationId }) {
  return inTransaction(async () => {
    const guest = await db.prepare(`SELECT id FROM users WHERE id=? AND role='guest' AND status='active'${lockSuffix()}`).get(guestId);
    if (!guest) throw new AppError(409, 'GUEST_INACTIVE', '客人账号不存在或已停用');
    const basic = await db.prepare('SELECT id,slot_id,status FROM reservations WHERE id=? AND guest_id=?').get(reservationId, guestId);
    if (!basic) throw new AppError(404, 'RESERVATION_NOT_FOUND', '预约不存在');
    await db.prepare(`SELECT id FROM activity_slots WHERE id=?${lockSuffix()}`).get(basic.slot_id);
    const current = await db.prepare(`SELECT * FROM reservations WHERE id=? AND guest_id=?${lockSuffix()}`).get(reservationId, guestId);
    if (current.status === 'cancelled') return publicReservation(await reservationById(current.id, guestId));
    const slot = await db.prepare('SELECT starts_at FROM activity_slots WHERE id=?').get(current.slot_id);
    if (Date.parse(slot.starts_at) <= Date.parse(systemBusinessClock.utc())) {
      throw new AppError(409, 'RESERVATION_ALREADY_STARTED', '时段已开始或结束，不能取消');
    }
    const cancelledAt = now();
    await db.prepare(`UPDATE reservations SET status='cancelled',cancelled_at=?,cancellation_reason='guest_cancelled'
      WHERE id=? AND guest_id=? AND status='confirmed'`).run(cancelledAt, reservationId, guestId);
    await log(guestId, 'reservation.cancel', 'reservation', reservationId, '客人主动取消；已释放预约名额');
    return publicReservation(await reservationById(reservationId, guestId));
  });
}

export async function updateProjectSlot({ actorId, projectId, slotId: requestedSlotId, patch }) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new AppError(400, 'SLOT_UPDATE_INVALID', '时段更新内容无效');
  const keys = Object.keys(patch);
  if (!keys.length || keys.some(key => !['capacity', 'closed'].includes(key))) throw new AppError(400, 'SLOT_UPDATE_INVALID', '只能调整容量或关闭状态');
  if (patch.capacity !== undefined && (!Number.isInteger(patch.capacity) || patch.capacity < 1 || patch.capacity > 100)) {
    throw new AppError(400, 'SLOT_CAPACITY_INVALID', '容量必须是 1 到 100 的整数');
  }
  if (patch.closed !== undefined && typeof patch.closed !== 'boolean') throw new AppError(400, 'SLOT_CLOSED_INVALID', '关闭状态必须是布尔值');
  return transaction(async () => {
    const slot = await db.prepare(`SELECT s.*,p.location,p.active AS project_active,p.is_demo AS project_is_demo,p.name AS project_name
      FROM activity_slots s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.project_id=?${lockSuffix()}`).get(requestedSlotId, projectId);
    if (!slot) throw new AppError(404, 'SLOT_NOT_FOUND', '排期时段不存在');
    const activeReservations = await db.prepare(`SELECT id FROM reservations WHERE slot_id=? AND status='confirmed'${lockSuffix()}`).all(requestedSlotId);
    if (patch.capacity !== undefined && patch.capacity < activeReservations.length) {
      throw new AppError(409, 'CAPACITY_BELOW_BOOKED', '容量不能低于当前有效预约数', { booked: activeReservations.length, requestedCapacity: patch.capacity });
    }
    const capacity = patch.capacity ?? Number(slot.capacity);
    const closed = patch.closed === undefined ? Number(slot.is_closed) : (patch.closed ? 1 : 0);
    await db.prepare('UPDATE activity_slots SET capacity=?,is_closed=?,updated_at=? WHERE id=?')
      .run(capacity, closed, now(), requestedSlotId);
    await log(actorId, 'project.slot.update', 'activity_slot', requestedSlotId, `capacity=${capacity}; closed=${Boolean(closed)}`);
    return { ...rowToSlot({ ...slot, capacity, is_closed: closed, booked: activeReservations.length }), remaining: Math.max(0, capacity - activeReservations.length), status: closed ? 'closed' : activeReservations.length >= capacity ? 'full' : 'open' };
  });
}
