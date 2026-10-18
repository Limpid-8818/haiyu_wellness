// G43：院长管理域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { db, escapeLikeValue, guestProfile, guestSummary, id, isUniqueViolation, json, likeEscapeClause, log, now, transaction } from '../db.js';
import { hashPasswordAsync } from '../password.js';
import { requestLimit } from '../request-controls.js';
import { AppError } from '../errors.js';
import { JOB_TYPES, MEDICAL_CAPABILITY, SUMMARY_CAPABILITY, canManageStaff, capabilityMatrix, isDateOnly, jobTypeLabel, nightsBetween, stayStatus } from '../staffing.js';
import { auth, currentCredentialUser, deanOnly, publicStaffRow, queryString, requireGuestAccount, routeHandler, staffManagementOnly } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/dean/staff', auth, staffManagementOnly, async (req, res) => {
  const rows = await db.prepare(`SELECT id,name,username,phone,status,job_type AS jobType,created_at AS createdAt
    FROM users WHERE role='staff' ORDER BY name`).all();
  // G24：两条 GROUP BY 聚合替代每员工 2 次计数的 2N+1 查询；IN 走 actor/author 索引前导列。
  const staffIds = rows.map(row => row.id);
  const placeholders = staffIds.map(() => '?').join(',');
  const viewRows = staffIds.length ? await db.prepare(`SELECT actor_id AS actorId, COUNT(*) AS count
    FROM audit_logs WHERE action='guest.view' AND actor_id IN (${placeholders}) GROUP BY actor_id`).all(...staffIds) : [];
  const adviceRows = staffIds.length ? await db.prepare(`SELECT author_id AS authorId, COUNT(*) AS count
    FROM medical_advice WHERE author_id IN (${placeholders}) GROUP BY author_id`).all(...staffIds) : [];
  const viewCounts = new Map(viewRows.map(row => [row.actorId, Number(row.count)]));
  const adviceCounts = new Map(adviceRows.map(row => [row.authorId, Number(row.count)]));
  res.json(rows.map(row => ({
    ...publicStaffRow(row),
    guestViews: viewCounts.get(row.id) || 0,
    adviceCount: adviceCounts.get(row.id) || 0
  })));
});
routes.post('/api/dean/staff', auth, staffManagementOnly, requestLimit('password'), async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const jobType = body.jobType;
  if (!name || name.length > 64 || !/^[A-Za-z0-9_.@-]{3,64}$/.test(username)) {
    throw new AppError(400, 'STAFF_INPUT_INVALID', '请填写姓名和3至64位账号');
  }
  if (password.length < 8 || password.length > 128) throw new AppError(400, 'STAFF_PASSWORD_INVALID', '初始密码长度应为 8 至 128 位');
  if (phone.length > 32 || !JOB_TYPES.some(type => type.value === jobType)) {
    throw new AppError(400, 'STAFF_JOB_TYPE_INVALID', '联系电话或岗位类型不正确');
  }
  if (await db.prepare('SELECT id FROM users WHERE username=?').get(username)) {
    throw new AppError(409, 'STAFF_USERNAME_TAKEN', '该账号已存在');
  }
  const staffId = id('staff');
  const passwordHash = await hashPasswordAsync(password);
  try {
    await transaction(async () => {
      if (!canManageStaff(await currentCredentialUser(req.user))) {
        throw new AppError(403, 'CAPABILITY_FORBIDDEN', '当前岗位无权管理员工');
      }
      await db.prepare(`INSERT INTO users(id,username,password_hash,role,name,phone,status,job_type,created_at)
        VALUES(?,?,?,'staff',?,?,'active',?,?)`).run(staffId, username, passwordHash, name, phone, jobType, now());
      await log(req.user.id, 'staff.create', 'staff', staffId, `创建${jobTypeLabel(jobType)}账号 ${username}`);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, 'STAFF_USERNAME_TAKEN', '该账号已存在');
    throw error;
  }
  const created = await db.prepare(`SELECT id,name,username,phone,status,job_type AS jobType,created_at AS createdAt
    FROM users WHERE id=?`).get(staffId);
  res.status(201).json(publicStaffRow(created));
});
routes.patch('/api/dean/staff/:id', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const keys = Object.keys(body);
  const unknown = keys.filter(key => !['status', 'jobType'].includes(key));
  if (!keys.length || unknown.length) throw new AppError(400, 'STAFF_UPDATE_INVALID', '请提供状态或岗位字段');
  if (body.status !== undefined && !['active', 'disabled'].includes(body.status)) {
    throw new AppError(400, 'STAFF_STATUS_INVALID', '状态只能设为正常或停用');
  }
  if (body.jobType !== undefined && !JOB_TYPES.some(type => type.value === body.jobType)) {
    throw new AppError(400, 'STAFF_JOB_TYPE_INVALID', '岗位类型不正确');
  }
  const staff = await db.prepare("SELECT id,name,username,status,job_type AS jobType FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  if (staff.id === req.user.id && (body.status === 'disabled' || body.jobType !== undefined && body.jobType !== 'administrator')) {
    throw new AppError(409, 'STAFF_SELF_LOCKOUT', '不能停用或移除自己的管理员岗位');
  }
  const nextStatus = body.status ?? staff.status;
  const nextJobType = body.jobType ?? staff.jobType ?? 'clinician';
  await transaction(async () => {
    await db.prepare('UPDATE users SET status=?,job_type=? WHERE id=?').run(nextStatus, nextJobType, staff.id);
    const changes = [];
    if (body.status !== undefined && body.status !== staff.status) changes.push(nextStatus === 'disabled' ? '停用账号' : '重新启用账号');
    if (body.jobType !== undefined && body.jobType !== staff.jobType) changes.push(`岗位改为${jobTypeLabel(nextJobType)}`);
    if (changes.length) await log(req.user.id, 'staff.update', 'staff', staff.id, changes.join('；'));
  });
  res.json(publicStaffRow(await db.prepare(`SELECT id,name,username,phone,status,job_type AS jobType,created_at AS createdAt
    FROM users WHERE id=?`).get(staff.id)));
});
routes.get('/api/dean/job-capabilities', auth, staffManagementOnly, async (_req, res) => {
  res.json(await capabilityMatrix(db));
});
routes.patch('/api/dean/job-capabilities', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { jobType, capability, enabled } = body;
  if (!JOB_TYPES.some(type => type.value === jobType)) throw new AppError(400, 'CAPABILITY_JOB_TYPE_INVALID', '岗位类型不正确');
  if (capability === MEDICAL_CAPABILITY) throw new AppError(400, 'CAPABILITY_FIXED', '医护建议权限固定，不能通过岗位开关授予');
  if (capability !== SUMMARY_CAPABILITY || typeof enabled !== 'boolean') {
    throw new AppError(400, 'CAPABILITY_UPDATE_INVALID', '只可调整运营汇总查看开关');
  }
  await transaction(async () => {
    const current = await db.prepare(`SELECT enabled FROM job_capability_settings WHERE job_type=? AND capability_key=?`).get(jobType, capability);
    if (current) {
      await db.prepare(`UPDATE job_capability_settings SET enabled=?,updated_by=?,updated_at=?
        WHERE job_type=? AND capability_key=?`).run(enabled ? 1 : 0, req.user.id, now(), jobType, capability);
    } else {
      await db.prepare(`INSERT INTO job_capability_settings(job_type,capability_key,enabled,updated_by,updated_at)
        VALUES(?,?,?,?,?)`).run(jobType, capability, enabled ? 1 : 0, req.user.id, now());
    }
    await log(req.user.id, 'job.capability.update', 'job_type', jobType, `${capability}=${enabled}`);
  });
  res.json(await capabilityMatrix(db));
});
routes.get('/api/dean/guests', auth, staffManagementOnly, async (req, res) => {
  const filter = queryString(req.query.status) || 'all';
  if (!['all', 'pending', 'in_house', 'checked_out'].includes(filter)) throw new AppError(400, 'STAY_FILTER_INVALID', '入住状态筛选条件不正确');
  const query = escapeLikeValue(queryString(req.query.q));
  const rows = await db.prepare(`SELECT u.id,u.name,u.username,u.phone,u.status,gp.room_no AS roomNo,
    gp.check_in AS checkIn,gp.check_out AS checkOut,gp.stay_plan AS stayPlan
    FROM users u LEFT JOIN guest_profiles gp ON gp.user_id=u.id
    WHERE u.role='guest' AND u.status='active'
      AND (u.name LIKE ?${likeEscapeClause()} OR u.phone LIKE ?${likeEscapeClause()} OR COALESCE(gp.room_no,'') LIKE ?${likeEscapeClause()})
    ORDER BY u.name,u.id`).all(query, query, query);
  const guests = rows.map(row => ({ ...row, stayStatus: stayStatus(row.checkIn, row.checkOut) }));
  res.json(filter === 'all' ? guests : guests.filter(guest => guest.stayStatus === filter));
});
routes.patch('/api/dean/guests/:id/stay', auth, staffManagementOnly, async (req, res) => {
  const guest = await requireGuestAccount(req.params.id);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const roomNo = typeof body.roomNo === 'string' ? body.roomNo.trim() : '';
  const checkIn = body.checkIn;
  const checkOut = body.checkOut;
  const stayPlan = body.stayPlan;
  if (!roomNo || roomNo.length > 32 || !isDateOnly(checkIn) || !isDateOnly(checkOut)) {
    throw new AppError(400, 'STAY_INPUT_INVALID', '请填写房间号和有效的入住、离店日期');
  }
  if (!['three_night', 'ten_night'].includes(stayPlan)) throw new AppError(400, 'STAY_PLAN_INVALID', '入住类别不正确');
  const nights = nightsBetween(checkIn, checkOut);
  const maximum = stayPlan === 'three_night' ? 3 : 10;
  if (!Number.isInteger(nights) || nights < 1) throw new AppError(400, 'STAY_DATE_RANGE_INVALID', '离店日期必须晚于入住日期，且至少住一晚');
  if (nights > maximum) throw new AppError(400, 'STAY_LIMIT_EXCEEDED', `${stayPlan === 'three_night' ? '3晚类别' : '10晚类别'}最多登记${maximum}晚`);
  const profile = await guestProfile(guest.id);
  if (!profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  await transaction(async () => {
    await db.prepare(`UPDATE guest_profiles SET room_no=?,check_in=?,check_out=?,stay_plan=?,updated_at=? WHERE user_id=?`)
      .run(roomNo, checkIn, checkOut, stayPlan, now(), guest.id);
    await log(req.user.id, 'guest.stay.update', 'guest', guest.id, `更新入住登记：${roomNo} ${checkIn}—${checkOut}`);
  });
  res.json({ ...await guestSummary(guest.id), admissionStatus: stayStatus(checkIn, checkOut) });
});
routes.get('/api/dean/guests/:id/assignments', auth, staffManagementOnly, async (req, res) => {
  await requireGuestAccount(req.params.id);
  const rows = await db.prepare(`SELECT a.id,a.staff_id AS staffId,a.guest_id AS guestId,a.start_at AS startAt,
    a.end_at AS endAt,a.status,a.created_by AS createdBy,a.created_at AS createdAt,u.name AS staffName,
    u.username AS staffUsername,u.phone AS staffPhone,u.job_type AS jobType,u.status AS staffStatus
    FROM staff_guest_assignments a JOIN users u ON u.id=a.staff_id
    WHERE a.guest_id=? ORDER BY CASE WHEN a.status='active' THEN 0 ELSE 1 END,a.start_at DESC,a.id DESC`).all(req.params.id);
  res.json(rows.map(row => ({ ...row, jobType: row.jobType || 'clinician', jobTypeLabel: jobTypeLabel(row.jobType || 'clinician') })));
});
routes.post('/api/dean/guests/:id/assignments', auth, staffManagementOnly, async (req, res) => {
  const guest = await requireGuestAccount(req.params.id);
  const staffId = typeof req.body?.staffId === 'string' ? req.body.staffId : '';
  if (!staffId) throw new AppError(400, 'ASSIGNMENT_STAFF_REQUIRED', '请选择工作人员');
  const staff = await db.prepare(`SELECT id,name,job_type AS jobType,status FROM users WHERE id=? AND role='staff'`).get(staffId);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  if (staff.status !== 'active') throw new AppError(409, 'STAFF_INACTIVE', '已停用的工作人员不能建立新分工');
  const currentTime = now();
  const current = await db.prepare(`SELECT id FROM staff_guest_assignments
    WHERE staff_id=? AND guest_id=? AND status='active'
      AND (end_at IS NULL OR end_at>?) ORDER BY start_at DESC,id DESC LIMIT 1`).get(staff.id, guest.id, currentTime);
  if (current) throw new AppError(409, 'ASSIGNMENT_EXISTS', '该工作人员已负责此客人');
  const last = await db.prepare(`SELECT start_at FROM staff_guest_assignments WHERE staff_id=? AND guest_id=?
    ORDER BY start_at DESC,id DESC LIMIT 1`).get(staff.id, guest.id);
  const previousStart = last ? Date.parse(last.start_at) : 0;
  const baseStart = Date.parse(currentTime);
  const startAt = previousStart >= baseStart ? new Date(previousStart + 1).toISOString() : currentTime;
  let assignment;
  try {
    assignment = await transaction(async () => {
      const inserted = await db.prepare(`INSERT INTO staff_guest_assignments
        (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
        VALUES(?,?,?,NULL,'active',?,?,?)`).run(staff.id, guest.id, startAt, req.user.id, currentTime, currentTime);
      await log(req.user.id, 'assignment.create', 'guest', guest.id, `分配${jobTypeLabel(staff.jobType || 'clinician')} ${staff.name}`);
      return inserted;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, 'ASSIGNMENT_EXISTS', '该工作人员与客人已有此开始时间的分工');
    throw error;
  }
  res.status(201).json({ id: Number(assignment.lastInsertRowid), staffId: staff.id, guestId: guest.id, startAt, status: 'active' });
});
routes.patch('/api/dean/guests/:guestId/assignments/:assignmentId', auth, staffManagementOnly, async (req, res) => {
  const guest = await requireGuestAccount(req.params.guestId);
  const assignmentId = Number(req.params.assignmentId);
  if (!Number.isSafeInteger(assignmentId) || assignmentId < 1) throw new AppError(400, 'ASSIGNMENT_ID_INVALID', '负责关系编号不正确');
  const assignment = await db.prepare(`SELECT id,staff_id AS staffId,status,start_at AS startAt FROM staff_guest_assignments
    WHERE id=? AND guest_id=?`).get(assignmentId, guest.id);
  if (!assignment) throw new AppError(404, 'ASSIGNMENT_NOT_FOUND', '负责关系不存在');
  if (assignment.status !== 'active') throw new AppError(409, 'ASSIGNMENT_ALREADY_CLOSED', '该负责关系已经结束');
  const endedAt = new Date(Math.max(Date.parse(now()), Date.parse(assignment.startAt))).toISOString();
  await transaction(async () => {
    await db.prepare(`UPDATE staff_guest_assignments SET status='closed',end_at=?,updated_at=? WHERE id=?`)
      .run(endedAt, endedAt, assignmentId);
    await log(req.user.id, 'assignment.close', 'guest', guest.id, `结束工作人员 ${assignment.staffId} 的负责关系`);
  });
  res.json({ id: assignmentId, staffId: assignment.staffId, guestId: guest.id, status: 'closed', endAt: endedAt });
});
routes.get('/api/dean/staff/:id/logs', auth, deanOnly, async (req, res) => {
  const staff = await db.prepare("SELECT id,name,username,phone,status FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  const logs = await db.prepare('SELECT id,action,target_type AS targetType,target_id AS targetId,detail,created_at AS createdAt FROM audit_logs WHERE actor_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(req.params.id);
  const reviews = await db.prepare('SELECT id,content,created_at AS createdAt FROM staff_reviews WHERE staff_id=? AND dean_id=? ORDER BY created_at DESC,id DESC').all(req.params.id, req.user.id);
  res.json({ staff, logs, reviews });
});
routes.post('/api/dean/staff/:id/reviews', auth, deanOnly, async (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const staff = await db.prepare("SELECT id FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  if (!content || content.length > 5000) throw new AppError(400, 'REVIEW_INVALID', '意见内容不能为空且不能超过 5000 个字符');
  const result = await transaction(async () => {
    const inserted = await db.prepare('INSERT INTO staff_reviews(staff_id,dean_id,content,created_at) VALUES(?,?,?,?)').run(req.params.id, req.user.id, content, now());
    await log(req.user.id, 'staff.review', 'staff', req.params.id, content);
    return inserted;
  });
  res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
});

export default router;
