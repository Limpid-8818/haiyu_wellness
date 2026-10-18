// G43：预约与日程域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { authorizeGuestAccess } from '../authorization.js';
import { cancelReservation, createReservation, listGuestReservations, listGuestSchedule } from '../booking.js';
import { systemBusinessClock } from '../clock.js';
import { db, id, json } from '../db.js';
import { AppError } from '../errors.js';
import { confirmWeatherReschedule, listWeatherCancellationCandidates } from '../operations.js';
import { createGuestCheckin, createGuestFeedback, listGuestCheckins, updateGuestFeedback } from '../wellness-followup.js';
import { auth, authorizeQueryGuest, requireGuestRole, routeHandler } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.post('/api/reservations', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可创建本人预约');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => key !== 'slotId');
  if (unknown.length || typeof body.slotId !== 'string') throw new AppError(400, 'RESERVATION_INPUT_INVALID', '预约请求只接受时段编号');
  const idempotencyKey = typeof req.get('Idempotency-Key') === 'string' ? req.get('Idempotency-Key') : '';
  const result = await createReservation({ guestId: req.user.id, slotId: body.slotId, idempotencyKey });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.get('/api/reservations', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人预约');
  res.json(await listGuestReservations(req.user.id));
});
routes.delete('/api/reservations/:id', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可取消本人预约');
  res.json(await cancelReservation({ guestId: req.user.id, reservationId: req.params.id }));
});
routes.get('/api/schedule', auth, async (req, res) => {
  const guest = await authorizeQueryGuest(req);
  res.json(await listGuestSchedule(guest.id));
});
routes.get('/api/reservations/:id/reschedule-candidates', auth, async (req, res) => {
  const reservation = await db.prepare('SELECT guest_id AS guestId FROM reservations WHERE id=?').get(req.params.id);
  if (!reservation) throw new AppError(404, 'RESERVATION_NOT_FOUND', '预约不存在');
  const guest = await authorizeGuestAccess(req.user, reservation.guestId);
  res.json(await listWeatherCancellationCandidates({ reservationId: req.params.id, guestId: guest.id }));
});
routes.post('/api/reservations/:id/reschedule', auth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => key !== 'slotId') || typeof body.slotId !== 'string') {
    throw new AppError(400, 'RESCHEDULE_INPUT_INVALID', '改约只接受一个已选替代时段');
  }
  const reservation = await db.prepare('SELECT guest_id AS guestId FROM reservations WHERE id=?').get(req.params.id);
  if (!reservation) throw new AppError(404, 'RESERVATION_NOT_FOUND', '预约不存在');
  const guest = await authorizeGuestAccess(req.user, reservation.guestId);
  const result = await confirmWeatherReschedule({ reservationId: req.params.id, guestId: guest.id,
    actorId: req.user.id, slotId: body.slotId, requestKey: req.get('Idempotency-Key') || '' });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.get('/api/me/checkins', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await listGuestCheckins(req.user.id));
});
routes.post('/api/me/reservations/:reservationId/checkin', auth, async (req, res) => {
  requireGuestRole(req.user);
  const checkin = await createGuestCheckin({ guestId: req.user.id, reservationId: req.params.reservationId, clock: systemBusinessClock });
  res.status(checkin.replayed ? 200 : 201).json(checkin);
});
routes.post('/api/me/reservations/:reservationId/feedback', auth, async (req, res) => {
  requireGuestRole(req.user);
  const feedback = await createGuestFeedback({ guestId: req.user.id, reservationId: req.params.reservationId,
    body: req.body, clock: systemBusinessClock });
  res.status(feedback.replayed ? 200 : 201).json(feedback);
});
routes.put('/api/me/feedback/:id', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await updateGuestFeedback({ guestId: req.user.id, feedbackId: req.params.id,
    body: req.body, clock: systemBusinessClock }));
});

export default router;