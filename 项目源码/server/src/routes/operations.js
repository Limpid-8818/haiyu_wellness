// G43：运营管理域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { listAdminProjectSlots, updateProjectSlot } from '../booking.js';
import { listProjects, updateProject } from '../catalog.js';
import { systemBusinessClock } from '../clock.js';
import { id, json } from '../db.js';
import { AppError } from '../errors.js';
import { assignStaffToSlot, cancelWeatherAffectedSlots, closeOperationsIncident, getOperationsSummary, listOperationsIncidents, listOrganizationGuests, listOrganizationReservations, listOrganizationSlots, markReservationNoShow, organizationGuestHealthHistory, previewWeatherCancellation } from '../operations.js';
import { auth, queryString, routeHandler, staffManagementOnly } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/admin/projects', auth, staffManagementOnly, async (_req, res) => {
  const items = await listProjects({ includeInactive: true });
  res.json({ items, total: items.length });
});
routes.patch('/api/admin/projects/:id', auth, staffManagementOnly, async (req, res) => {
  const project = await updateProject(req.params.id, req.body, req.user.id);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在');
  res.json(project);
});
routes.get('/api/admin/projects/:id/slots', auth, staffManagementOnly, async (req, res) => {
  const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  res.json(await listAdminProjectSlots(req.params.id, date));
});
routes.patch('/api/admin/projects/:id/slots/:slotId', auth, staffManagementOnly, async (req, res) => {
  res.json(await updateProjectSlot({ actorId: req.user.id, projectId: req.params.id, slotId: req.params.slotId, patch: req.body }));
});
routes.get('/api/admin/operations/guests', auth, staffManagementOnly, async (req, res) => {
  res.json({ items: await listOrganizationGuests({ query: queryString(req.query.q), date: queryString(req.query.date) }) });
});
routes.get('/api/admin/operations/guests/:guestId/health-history', auth, staffManagementOnly, async (req, res) => {
  res.json(await organizationGuestHealthHistory(req.params.guestId));
});
routes.get('/api/admin/operations/slots', auth, staffManagementOnly, async (req, res) => {
  const days = req.query.days === undefined ? 7 : Number(req.query.days);
  res.json(await listOrganizationSlots({ projectId: queryString(req.query.projectId),
    date: queryString(req.query.date) || systemBusinessClock.dateKey(), days }));
});
routes.get('/api/admin/operations/reservations', auth, staffManagementOnly, async (req, res) => {
  const date = queryString(req.query.date) || systemBusinessClock.dateKey();
  res.json(await listOrganizationReservations({ date, from: queryString(req.query.from), to: queryString(req.query.to),
    projectId: queryString(req.query.projectId), status: queryString(req.query.status) || 'active' }));
});
routes.post('/api/admin/operations/reservations/:id/no-show', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).length) throw new AppError(400, 'NO_SHOW_INPUT_INVALID', '爽约登记不接受额外字段');
  res.json(await markReservationNoShow({ reservationId: req.params.id, actorId: req.user.id }));
});
routes.post('/api/admin/operations/weather-cancellations/preview', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => !['slotIds', 'snapshotKey'].includes(key))) {
    throw new AppError(400, 'WEATHER_BATCH_INPUT_INVALID', '天气预览请求包含不允许的字段');
  }
  res.json(await previewWeatherCancellation({ slotIds: body.slotIds, snapshotKey: body.snapshotKey }));
});
routes.post('/api/admin/operations/weather-cancellations', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => !['slotIds', 'snapshotKey', 'requestKey', 'reason'].includes(key))) {
    throw new AppError(400, 'WEATHER_BATCH_INPUT_INVALID', '天气处理请求包含不允许的字段');
  }
  const result = await cancelWeatherAffectedSlots({ actorId: req.user.id, ...body,
    requestKey: req.get('Idempotency-Key') || body.requestKey || '' });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.post('/api/admin/operations/slots/:slotId/assignments', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => !['staffId', 'jobType'].includes(key))
    || typeof body.staffId !== 'string' || typeof body.jobType !== 'string') {
    throw new AppError(400, 'SLOT_ASSIGNMENT_INPUT_INVALID', '时段分配只接受员工编号与岗位');
  }
  res.status(201).json(await assignStaffToSlot({ slotId: req.params.slotId, staffId: body.staffId,
    jobType: body.jobType, actorId: req.user.id }));
});
routes.get('/api/admin/operations/summary', auth, staffManagementOnly, async (req, res) => {
  res.json(await getOperationsSummary({ date: queryString(req.query.date) || systemBusinessClock.dateKey(),
    detail: queryString(req.query.detail) }));
});
routes.get('/api/admin/operations/incidents', auth, staffManagementOnly, async (_req, res) => {
  res.json({ items: await listOperationsIncidents() });
});
routes.post('/api/admin/operations/incidents/close', auth, staffManagementOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => !['supplier', 'feature'].includes(key))
    || typeof body.supplier !== 'string' || typeof body.feature !== 'string') {
    throw new AppError(400, 'OPERATIONS_INCIDENT_INPUT_INVALID', '关闭运营事项需要供应商与功能标识');
  }
  res.json(await closeOperationsIncident({ supplier: body.supplier, feature: body.feature, actorId: req.user.id }));
});

export default router;