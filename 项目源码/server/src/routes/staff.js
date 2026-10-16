// G43：员工工作台域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { accessibleGuestIds, authorizeGuestAccess } from '../authorization.js';
import { systemBusinessClock } from '../clock.js';
import { db, escapeLikeValue, guestSummary, id, json, likeEscapeClause, log } from '../db.js';
import { AppError } from '../errors.js';
import { normalizeHealthProfile } from '../health-profile.js';
import { recordStaffExecution } from '../service-execution.js';
import { listStaffDailySchedule, organizationGuestHealthHistory } from '../stage26-operations.js';
import { auth, clinicianOnly, operationsSummaryOnly, queryString, routeHandler, staffOnly } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/staff/operations/guests/:guestId/health-history', auth, clinicianOnly, async (req, res) => {
  const guest = await authorizeGuestAccess(req.user, req.params.guestId);
  res.json(await organizationGuestHealthHistory(guest.id));
});
routes.get('/api/staff/schedule', auth, staffOnly, async (req, res) => {
  res.json(await listStaffDailySchedule(req.user, queryString(req.query.date) || systemBusinessClock.dateKey()));
});
routes.post('/api/staff/schedule/:reservationId/execution', auth, staffOnly, async (req, res) => {
  if (Object.keys(req.body || {}).some(key => !['status', 'note'].includes(key))) throw new AppError(400, 'SERVICE_EXECUTION_INPUT_INVALID', '只接受服务状态和工作说明');
  const result = await recordStaffExecution({ user: req.user, reservationId: req.params.reservationId, status: req.body?.status, note: req.body?.note });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.get('/api/staff/overview', auth, staffOnly, operationsSummaryOnly, async (req, res) => {
  const guestIds = await accessibleGuestIds(req.user);
  const placeholders = guestIds.map(() => '?').join(',');
  const activeAdvice = guestIds.length
    ? Number((await db.prepare(`SELECT COUNT(*) AS count FROM medical_advice WHERE status='active' AND guest_id IN (${placeholders})`).get(...guestIds)).count)
    : 0;
  let recent;
  if (req.user.role === 'dean') {
    recent = await db.prepare('SELECT id,action,detail,created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 8').all();
  } else {
    const targetFilter = guestIds.length ? ` OR target_id IN (${placeholders})` : '';
    recent = await db.prepare(`SELECT id,action,detail,created_at AS createdAt FROM audit_logs
      WHERE actor_id=? AND (COALESCE(target_type,'') <> 'guest'${targetFilter})
      ORDER BY id DESC LIMIT 8`).all(req.user.id, ...guestIds);
  }
  res.json({ guests: guestIds.length, activeAdvice, recent });
});
routes.get('/api/staff/guests', auth, staffOnly, async (req, res) => {
  const scope = await accessibleGuestIds(req.user);
  const q = escapeLikeValue(queryString(req.query.q));
  if (!scope.length) return res.json([]);
  const placeholders = scope.map(() => '?').join(',');
  const rows = await db.prepare(`SELECT u.id,u.name,u.phone,gp.room_no AS roomNo,gp.check_in AS checkIn,gp.check_out AS checkOut,
    gp.chronic_json AS chronicJson,gp.allergies_json AS allergiesJson,gp.health_profile_json AS formalJson
    FROM users u LEFT JOIN guest_profiles gp ON gp.user_id=u.id
    WHERE u.role='guest' AND u.status='active' AND u.id IN (${placeholders})
      AND (u.name LIKE ?${likeEscapeClause()} OR COALESCE(gp.room_no,'') LIKE ?${likeEscapeClause()}) ORDER BY u.name`).all(...scope, q, q);
  res.json(rows.map(row => {
    const formal = normalizeHealthProfile(json(row.formalJson, {}));
    return { ...row,
      chronic: formal.chronic.status === 'reported' ? formal.chronic.items : [],
      allergies: formal.allergies.status === 'reported' ? formal.allergies.items : [],
      chronicStatus: formal.chronic.status, allergiesStatus: formal.allergies.status,
      chronicJson: undefined, allergiesJson: undefined, formalJson: undefined
    };
  }));
});
routes.get('/api/staff/guests/:id', auth, staffOnly, async (req, res) => {
  await authorizeGuestAccess(req.user, req.params.id);
  const guest = await guestSummary(req.params.id);
  if (!guest) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  await log(req.user.id, 'guest.view', 'guest', req.params.id, '查看客人档案');
  res.json(guest);
});

export default router;