// G43：智能助手域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { confirmAssistantAction } from '../assistant-actions.js';
import { assistantStatus, chatWithAssistant, getAssistantHistory, getAssistantRun, retryAssistantRun, scheduleAssistantRun, startAssistantRun } from '../assistant.js';
import { id, json } from '../db.js';
import { AppError } from '../errors.js';
import { auth, optionalAuth, routeHandler } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/assistant/status', optionalAuth, async (req, res) => {
  const status = assistantStatus();
  if (!req.user) {
    // G39：匿名访客只返回连接概况（公开首页助手角标所需），不暴露完整工具清单与预算契约。
    return res.json({ live: status.live, executionMode: status.executionMode, mode: status.mode,
      model: status.model, provider: status.provider, fallback: status.fallback });
  }
  res.json(status);
});
routes.post('/api/assistant/chat', optionalAuth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const clientRequestId = req.get('Idempotency-Key') || body.clientRequestId;
  const forceDomainCollaboration = process.env.NODE_ENV === 'test'
    && process.env.Q20_ACCEPTANCE_HOOKS === '1' && body.forceDomainCollaboration === true;
  if (body.async === true) {
    const started = await startAssistantRun({
      user: req.user, role: body.role, sessionId: body.sessionId, text: body.text,
      guestId: body.guestId, clientRequestId, forceDomainCollaboration
    });
    if (!started.duplicate) scheduleAssistantRun(started.run.id);
    const run = await getAssistantRun({ user: req.user, role: body.role, runId: started.run.id });
    return res.status(202).json({ runId: run.runId, sessionId: run.sessionId, status: run.status, duplicate: started.duplicate });
  }
  const result = await chatWithAssistant({
    user: req.user,
    role: body.role,
    sessionId: body.sessionId,
    text: body.text,
    guestId: body.guestId,
    clientRequestId,
    forceDomainCollaboration
  });
  res.json(result);
});
routes.get('/api/assistant/runs/:runId', optionalAuth, async (req, res) => {
  res.json(await getAssistantRun({ user: req.user, role: req.query.role, runId: req.params.runId }));
});
routes.post('/api/assistant/runs/:runId/retry', optionalAuth, async (req, res) => {
  const result = await retryAssistantRun({ user: req.user, role: req.body?.role, runId: req.params.runId });
  res.status(result.status === 'queued' || result.status === 'running' ? 202 : 200).json(result);
});
routes.post('/api/assistant/actions/:actionId/confirm', auth, async (req, res) => {
  const body = req.body || {};
  if (Object.keys(body).some(key => !['sessionId', 'version'].includes(key))
    || typeof body.sessionId !== 'string' || !body.sessionId
    || !Number.isInteger(Number(body.version))) {
    throw new AppError(400, 'ASSISTANT_ACTION_CONFIRM_INPUT_INVALID', '确认卡请求参数无效');
  }
  const actionCard = await confirmAssistantAction({ user: req.user, actionId: req.params.actionId,
    sessionId: body.sessionId, version: Number(body.version), idempotencyKey: req.get('Idempotency-Key') });
  res.json({ actionCard });
});
routes.get('/api/assistant/history', optionalAuth, async (req, res) => {
  if (typeof req.query.sessionId !== 'string' || !req.query.sessionId) {
    throw new AppError(400, 'ASSISTANT_SESSION_REQUIRED', '缺少助手会话编号');
  }
  res.json(await getAssistantHistory({
    user: req.user,
    role: req.query.role,
    sessionId: req.query.sessionId,
    guestId: req.query.guestId,
    beforeId: req.query.beforeId,
    limit: req.query.limit
  }));
});

export default router;