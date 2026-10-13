import { db, id, now, transaction } from './db.js';
import { AppError } from './errors.js';
import { authorizeGuestAccess, isAssignmentEffective } from './authorization.js';
import { jobTypeFor } from './staffing.js';
import { systemBusinessClock } from './clock.js';

const LOCK = db.driver === 'mysql' ? ' FOR UPDATE' : '';

export async function reservationExecutions(reservationId) {
  return db.prepare(`SELECT e.id,e.reservation_id AS reservationId,e.job_type AS jobType,e.status,e.note,
    e.actor_id AS actorId,u.name AS actorName,e.created_at AS createdAt FROM service_executions e
    JOIN users u ON u.id=e.actor_id WHERE e.reservation_id=? ORDER BY e.created_at,e.id`).all(reservationId);
}

export async function recordStaffExecution({ user, reservationId, status, note, clock = systemBusinessClock }) {
  const jobType = jobTypeFor(user);
  if (user?.role !== 'staff' || !['coach', 'therapist'].includes(jobType)) throw new AppError(403, 'SERVICE_JOB_REQUIRED', '仅教练或理疗师可记录本人负责服务');
  if (!['completed', 'no_show'].includes(status) || typeof note !== 'string' || !note.trim() || note.trim().length > 500) {
    throw new AppError(400, 'SERVICE_EXECUTION_INPUT_INVALID', '请选择完成/未参加并填写工作说明（最多500字）');
  }
  return transaction(async () => {
    const basic = await db.prepare('SELECT slot_id,guest_id FROM reservations WHERE id=?').get(reservationId);
    if (!basic) throw new AppError(404, 'RESERVATION_NOT_FOUND', '预约不存在');
    await authorizeGuestAccess(user, basic.guest_id);
    await db.prepare(`SELECT id FROM activity_slots WHERE id=?${LOCK}`).get(basic.slot_id);
    const assignment = await db.prepare(`SELECT id FROM stage26_staff_slot_assignments
      WHERE slot_id=? AND staff_id=? AND job_type=? AND status='active'${LOCK}`).get(basic.slot_id, user.id, jobType);
    if (!assignment) throw new AppError(403, 'SERVICE_NOT_ASSIGNED', '当前时段没有你的有效岗位分工');
    const reservation = await db.prepare(`SELECT r.status,s.starts_at,s.ends_at FROM reservations r JOIN activity_slots s ON s.id=r.slot_id
      WHERE r.id=?${LOCK}`).get(reservationId);
    const prior = (await reservationExecutions(reservationId)).find(row => row.jobType === jobType);
    if (prior) {
      if (prior.status !== status || prior.note !== note.trim()) throw new AppError(409, 'SERVICE_ALREADY_RECORDED', '服务结果已记录，不能重复改写');
      return { execution: prior, replayed: true };
    }
    if (reservation.status !== 'confirmed') throw new AppError(409, 'SERVICE_RESERVATION_INACTIVE', '只有有效预约可记录服务');
    const checkin = await db.prepare('SELECT id FROM wellness_checkins WHERE reservation_id=?').get(reservationId);
    const attendance = await db.prepare('SELECT status FROM stage26_reservation_checkins WHERE reservation_id=?').get(reservationId);
    const timestamp = clock.instant().getTime();
    const time = status === 'completed' ? reservation.ends_at : reservation.starts_at;
    const boundary = Date.parse(typeof time === 'string' && /^\d{4}-\d{2}-\d{2} /.test(time) ? time.replace(' ', 'T') + 'Z' : time);
    if (!Number.isFinite(boundary) || timestamp < boundary) {
      throw new AppError(409, 'SERVICE_TOO_EARLY', status === 'completed' ? '服务时段结束后才可记录完成' : '项目开始后才可登记未参加');
    }
    if (status === 'completed' && (!checkin || attendance?.status === 'no_show')) throw new AppError(409, 'SERVICE_CHECKIN_REQUIRED', '须有本人签到且未登记爽约才能完成服务');
    if (status === 'no_show' && (checkin || (await reservationExecutions(reservationId)).some(row => row.status === 'completed'))) {
      throw new AppError(409, 'SERVICE_ALREADY_ATTENDED', '客人已签到或服务已完成，不能登记未参加');
    }
    const stamp = now();
    if (status === 'no_show' && !attendance) await db.prepare(`INSERT INTO stage26_reservation_checkins
      (id,reservation_id,status,checked_at,actor_id,note) VALUES(?,?,'no_show',?,?,?)`).run(id('checkin'), reservationId, stamp, user.id, note.trim());
    const executionId = id('service');
    await db.prepare('INSERT INTO service_executions(id,reservation_id,job_type,status,actor_id,note,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(executionId, reservationId, jobType, status, user.id, note.trim(), stamp);
    await db.prepare('INSERT INTO audit_logs(actor_id,action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?,?)')
      .run(user.id, 'service.execution.record', 'reservation', reservationId, `${jobType} · ${status} · ${note.trim()}`, stamp);
    return { execution: (await reservationExecutions(reservationId)).find(row => row.id === executionId), replayed: false };
  });
}

export async function staffServiceDetails(user, item) {
  const guest = item.guestId ? await db.prepare("SELECT id FROM users WHERE id=? AND role='guest' AND status='active'").get(item.guestId) : null;
  if (!item.reservationId || !guest || !(await isAssignmentEffective(user.id, item.guestId))) return { ...item, reservationId: null, guestId: null, guestName: null, reservationStatus: null };
  const checkin = await db.prepare('SELECT id,checked_in_at AS checkedInAt FROM wellness_checkins WHERE reservation_id=?').get(item.reservationId);
  const feedback = await db.prepare('SELECT id,revision,feeling,note FROM wellness_feedback WHERE reservation_id=?').get(item.reservationId);
  return { ...item, checkin: checkin || null, feedback: feedback || null,
    executions: await reservationExecutions(item.reservationId) };
}
