// G43：公开信息域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { listGuestProjectSlots } from '../booking.js';
import { getProject, listKnowledge, listProjects, listRules } from '../catalog.js';
import { systemBusinessClock } from '../clock.js';
import { db, id, json, now } from '../db.js';
import { AppError } from '../errors.js';
import { getMoodResource, getMoodResourceFile, listMoodResources } from '../mood.js';
import { auth, queryString, routeHandler } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/health', async (req, res) => res.json({ ok: true, service: 'seaside-wellness-community', time: now() }));
routes.get('/api/news', async (req, res) => {
  // G13：公开列表加 LIMIT，防止表随运营增长后全量下发；首页只需置顶+少量条目。
  const rows = await db.prepare('SELECT id,category,title,summary,body,cover,published_at AS publishedAt,pinned FROM news ORDER BY pinned DESC,published_at DESC LIMIT 50').all();
  res.json(rows);
});
routes.get('/api/news/:id', async (req, res) => {
  const row = await db.prepare('SELECT id,category,title,summary,body,cover,published_at AS publishedAt,pinned FROM news WHERE id=?').get(req.params.id);
  if (!row) throw new AppError(404, 'NEWS_NOT_FOUND', '新闻不存在');
  res.json(row);
});
routes.get('/api/projects', async (req, res) => {
  const items = await listProjects({ category: queryString(req.query.category), search: queryString(req.query.q) });
  res.json({ items, total: items.length });
});
routes.get('/api/projects/:id', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  res.json(project);
});
routes.get('/api/projects/:id/slots', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人可预约时段');
  const date = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  res.json(await listGuestProjectSlots(req.params.id, date, req.user.id));
});
routes.get('/api/knowledge', async (req, res) => {
  const items = await listKnowledge({ domain: queryString(req.query.domain), search: queryString(req.query.q) });
  res.json({ items, total: items.length });
});
routes.get('/api/rules', async (req, res) => {
  const items = await listRules({ search: queryString(req.query.q) });
  res.json({ items, total: items.length });
});
routes.get('/api/mood/resources', async (_req, res) => res.json(listMoodResources()));
routes.get('/api/mood/resources/:resourceId/audio', (req, res, next) => {
  if (!getMoodResource(req.params.resourceId)) throw new AppError(404, 'MOOD_RESOURCE_NOT_FOUND', '放松资源不存在');
  res.sendFile(getMoodResourceFile(req.params.resourceId, 'audio'), {
    headers: { 'Cache-Control': 'public, max-age=3600' }
  }, error => { if (error && !res.headersSent) next(error); });
});
routes.get('/api/mood/resources/:resourceId/cover', (req, res, next) => {
  if (!getMoodResource(req.params.resourceId)) throw new AppError(404, 'MOOD_RESOURCE_NOT_FOUND', '放松资源不存在');
  res.sendFile(getMoodResourceFile(req.params.resourceId, 'cover'), {
    headers: { 'Cache-Control': 'public, max-age=3600' }
  }, error => { if (error && !res.headersSent) next(error); });
});

export default router;