import { db, now } from './db.js';
import { AppError } from './errors.js';

const ACTIVE_GUEST_SQL = "role='guest' AND status='active'";
const ACTIVE_GUEST_USER_SQL = "u.role='guest' AND u.status='active'";

function requireGuestId(guestId) {
  if (guestId === undefined || guestId === null || guestId === '') {
    throw new AppError(400, 'GUEST_ID_REQUIRED', '缺少客人编号');
  }
  if (typeof guestId !== 'string' || guestId.length > 128) {
    throw new AppError(400, 'GUEST_ID_INVALID', '客人编号格式不正确');
  }
  return guestId;
}

export async function isAssignmentEffective(staffId, guestId, at = now()) {
  const stamp = at instanceof Date ? at.toISOString() : String(at);
  const row = await db.prepare(`
    SELECT id FROM staff_guest_assignments
    WHERE staff_id=? AND guest_id=? AND status='active'
      AND start_at <= ?
      AND (end_at IS NULL OR end_at > ?)
    ORDER BY start_at DESC, id DESC LIMIT 1
  `).get(staffId, guestId, stamp, stamp);
  return Boolean(row);
}

export async function accessibleGuestIds(user, at = now()) {
  if (!user) return [];
  if (user.role === 'dean') {
    return (await db.prepare(`SELECT id FROM users WHERE ${ACTIVE_GUEST_SQL} ORDER BY id`).all()).map(row => row.id);
  }
  if (user.role === 'guest') {
    const row = await db.prepare(`SELECT id FROM users WHERE id=? AND ${ACTIVE_GUEST_SQL}`).get(user.id);
    return row ? [row.id] : [];
  }
  if (user.role !== 'staff') return [];
  const stamp = at instanceof Date ? at.toISOString() : String(at);
  return (await db.prepare(`
    SELECT DISTINCT u.id
    FROM users u JOIN staff_guest_assignments a ON a.guest_id=u.id
    WHERE ${ACTIVE_GUEST_USER_SQL} AND a.staff_id=? AND a.status='active'
      AND a.start_at <= ?
      AND (a.end_at IS NULL OR a.end_at > ?)
    ORDER BY u.id
  `).all(user.id, stamp, stamp)).map(row => row.id);
}

export async function countAccessibleGuests(user) {
  return (await accessibleGuestIds(user)).length;
}

export async function findGuest(guestId) {
  const id = requireGuestId(guestId);
  return (await db.prepare("SELECT id,username,password_hash,role,name,phone,avatar,status,created_at FROM users WHERE id=? AND role='guest'").get(id)) || null;
}

export async function authorizeGuestAccess(user, guestId) {
  const id = requireGuestId(guestId);
  const guest = await findGuest(id);
  if (!guest) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  if (guest.status !== 'active') throw new AppError(403, 'GUEST_INACTIVE', '客人账号已停用');

  if (!user) throw new AppError(401, 'AUTH_REQUIRED', '请先登录');
  if (user.role === 'dean') return guest;
  if (user.role === 'guest') {
    if (user.id !== guest.id) throw new AppError(403, 'GUEST_FORBIDDEN', '只能访问本人的客人档案');
    return guest;
  }
  if (user.role === 'staff') {
    if (!(await isAssignmentEffective(user.id, guest.id))) {
      throw new AppError(403, 'GUEST_NOT_ASSIGNED', '该客人当前不在你的负责范围内');
    }
    return guest;
  }
  throw new AppError(403, 'GUEST_FORBIDDEN', '当前身份无权访问客人档案');
}

export async function guestScope(user) {
  const ids = await accessibleGuestIds(user);
  if (!ids.length) return { clause: '1=0', params: [] };
  return {
    clause: `u.id IN (${ids.map(() => '?').join(',')})`,
    params: ids
  };
}
