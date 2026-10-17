// G43：疗程与关怀域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { getAgentStatus } from '../assistant.js';
import { accessibleGuestIds } from '../authorization.js';
import { systemBusinessClock } from '../clock.js';
import { getGuestDailyBrief } from '../daily-brief.js';
import { db, id, json } from '../db.js';
import { AppError } from '../errors.js';
import { isDateOnly } from '../staffing.js';
import { finishWellnessDraftPost } from '../wellness-draft-post.js';
import { activateReplanEvent, evaluateReplanEvent, getReplanEventDetail, listReplanEvents } from '../wellness-followup.js';
import { listGuestNotifications, markGuestNotificationRead } from '../wellness-notifications.js';
import { adoptWellnessDraft, createWellnessDraft, getWellnessDraft, listWellnessDrafts, wellnessTimeline } from '../wellness-planner.js';
import { approveWellnessDraft, autoActivateWellnessDraft, correctActiveWellnessDraft, getWellnessReviewDetail, listWellnessAdminAttention, listWellnessReviewAlternatives, listWellnessReviewHistory, listWellnessReviewQueue, returnWellnessDraft, reviseWellnessDraft } from '../wellness-review.js';
import { auth, clinicianOnly, queryString, requireGuestRole, routeHandler, staffOnly } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/me/therapy-drafts', auth, async (req, res) => {
  requireGuestRole(req.user);
  const stayStart = typeof req.query.stayStart === 'string' ? req.query.stayStart : null;
  const stayEnd = typeof req.query.stayEnd === 'string' ? req.query.stayEnd : null;
  if ((stayStart && !isDateOnly(stayStart)) || (stayEnd && !isDateOnly(stayEnd))) {
    throw new AppError(400, 'WELLNESS_STAY_INVALID', '入住日期必须是有效 YYYY-MM-DD');
  }
  res.json({ items: await listWellnessDrafts(req.user.id, { stayStart, stayEnd }) });
});
routes.post('/api/me/therapy-drafts', auth, async (req, res) => {
  requireGuestRole(req.user);
  const requestKey = req.get('Idempotency-Key');
  const isAdoption = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    && req.body.action === 'adopt_candidate';
  const draft = isAdoption
    ? await adoptWellnessDraft({ user: req.user, body: req.body, requestKey })
    : await createWellnessDraft({ user: req.user, body: req.body, requestKey });
  const result = await finishWellnessDraftPost({ draft, isAdoption, guestId: req.user.id,
    autoActivate: autoActivateWellnessDraft, getDraft: getWellnessDraft });
  res.status(draft.deduplicated ? 200 : 201).json(result);
});
routes.get('/api/me/therapy-drafts/:id', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await getWellnessDraft(req.user.id, req.params.id));
});
routes.get('/api/me/daily-brief', auth, async (req, res) => {
  requireGuestRole(req.user);
  const businessDate = queryString(req.query.date) || systemBusinessClock.dateKey();
  if (!isDateOnly(businessDate)) throw new AppError(400, 'DAILY_BRIEF_DATE_INVALID', '日期必须是有效 YYYY-MM-DD');
  res.json(await getGuestDailyBrief(req.user.id, businessDate));
});
routes.get('/api/me/wellness-notifications', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await listGuestNotifications(req.user.id));
});
routes.patch('/api/me/wellness-notifications/:id/read', auth, async (req, res) => {
  requireGuestRole(req.user);
  const item = await markGuestNotificationRead(req.user.id, req.params.id);
  if (!item) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', '提醒不存在或不属于当前客人');
  res.json({ item, unreadCount: (await listGuestNotifications(req.user.id)).unreadCount });
});
routes.get('/api/staff/care-follow-up-tasks', auth, staffOnly, async (req, res) => {
  const guestIds = await accessibleGuestIds(req.user);
  if (!guestIds.length) return res.json({ items: [] });
  const items = await db.prepare(`SELECT t.id,t.guest_id AS guestId,u.name AS guestName,
      t.source_type AS sourceType,t.source_id AS sourceId,t.title,t.detail,t.status,
      t.created_at AS createdAt,t.updated_at AS updatedAt
    FROM care_follow_up_tasks t JOIN users u ON u.id=t.guest_id
    WHERE t.assignee_id=? AND t.status='open' AND t.guest_id IN (${guestIds.map(() => '?').join(',')})
    ORDER BY t.created_at DESC,t.id DESC LIMIT 100`).all(req.user.id, ...guestIds);
  res.json({ items });
});
routes.get('/api/staff/therapy-drafts', auth, clinicianOnly, async (req, res) => {
  res.json(await listWellnessReviewQueue(req.user, { status: queryString(req.query.status),
    guestId: queryString(req.query.guestId), date: queryString(req.query.date), risk: queryString(req.query.risk) }));
});
routes.get('/api/staff/therapy-drafts/:id', auth, clinicianOnly, async (req, res) => {
  res.json(await getWellnessReviewDetail(req.user, req.params.id));
});
routes.get('/api/staff/therapy-drafts/:id/alternatives', auth, clinicianOnly, async (req, res) => {
  res.json(await listWellnessReviewAlternatives(req.user, req.params.id,
    queryString(req.query.itemId)));
});
routes.put('/api/staff/therapy-drafts/:id/revisions', auth, clinicianOnly, async (req, res) => {
  res.json(await reviseWellnessDraft({ actor: req.user, draftId: req.params.id,
    version: req.body?.version, edits: req.body?.edits, reason: req.body?.reason,
    requestKey: req.get('Idempotency-Key') }));
});
routes.post('/api/staff/therapy-drafts/:id/approve', auth, clinicianOnly, async (req, res) => {
  res.json(await approveWellnessDraft({ actor: req.user, draftId: req.params.id,
    version: req.body?.version, requestKey: req.get('Idempotency-Key') }));
});
routes.post('/api/staff/therapy-drafts/:id/return', auth, clinicianOnly, async (req, res) => {
  res.json(await returnWellnessDraft({ actor: req.user, draftId: req.params.id,
    version: req.body?.version, reason: req.body?.reason, requestKey: req.get('Idempotency-Key') }));
});
routes.post('/api/staff/therapy-drafts/:id/correction', auth, clinicianOnly, async (req, res) => {
  res.json(await correctActiveWellnessDraft({ actor: req.user, draftId: req.params.id,
    version: req.body?.version, edits: req.body?.edits, reason: req.body?.reason,
    requestKey: req.get('Idempotency-Key') }));
});
routes.get('/api/staff/therapy-review-history', auth, async (req, res) => {
  res.json(await listWellnessReviewHistory(req.user, { guestId: queryString(req.query.guestId),
    action: queryString(req.query.action), from: queryString(req.query.from), to: queryString(req.query.to) }));
});
routes.get('/api/staff/therapy-review-attention', auth, async (req, res) => {
  res.json(await listWellnessAdminAttention(req.user));
});
routes.get('/api/me/timeline', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await wellnessTimeline(req.user.id));
});
routes.get('/api/me/replanning-events', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await listReplanEvents(req.user.id));
});
routes.get('/api/me/replanning-events/:id', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await getReplanEventDetail(req.user.id, req.params.id));
});
routes.post('/api/me/replanning-events/:id/evaluate', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await evaluateReplanEvent({ user: req.user, eventId: req.params.id }));
});
routes.post('/api/me/replanning-events/:id/auto-activate', auth, async (req, res) => {
  requireGuestRole(req.user);
  res.json(await activateReplanEvent({ user: req.user, eventId: req.params.id }));
});
routes.get('/api/agent/status', auth, async (req, res) => {
  res.json(await getAgentStatus({ user: req.user, guestId: req.query.guestId }));
});

export default router;