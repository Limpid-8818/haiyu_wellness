// G43：环境域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { authorizeGuestAccess } from '../authorization.js';
import { getProject, listRules } from '../catalog.js';
import { systemBusinessClock } from '../clock.js';
import { guestProfile, id, json } from '../db.js';
import { assessProjectAvailability } from '../environment-availability.js';
import { getEnvironmentMode } from '../environment-config.js';
import { environmentMockScenario } from '../environment-mock.js';
import { getEnvironmentSnapshot } from '../environment.js';
import { AppError } from '../errors.js';
import { effectiveHealthConstraints } from '../health-profile.js';
import { evaluateProjectRules } from '../rules-engine.js';
import { isDateOnly, jobTypeFor } from '../staffing.js';
import { auth, healthProfileState, routeHandler } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/environment', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人环境与项目时段信息');
  const targetDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  if (!isDateOnly(targetDate)) throw new AppError(400, 'ENVIRONMENT_DATE_INVALID', '日期必须是有效的 YYYY-MM-DD');
  let mockScenario;
  if (req.query.mockScenario !== undefined) {
    if (getEnvironmentMode() !== 'demo') throw new AppError(400, 'ENVIRONMENT_MOCK_DISABLED', '仅合成/mock模式可选择测试场景');
    try { mockScenario = environmentMockScenario(req.query.mockScenario); }
    catch { throw new AppError(400, 'ENVIRONMENT_MOCK_SCENARIO_INVALID', '测试场景须为 normal、risk、missing 或 stale'); }
  }
  const snapshot = await getEnvironmentSnapshot(targetDate, { mockScenario });
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
  if (!projectId) return res.json({ ...snapshot, availability: null });
  const project = await getProject(projectId);
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  const profileState = await healthProfileState(req.user.id);
  const legacyProfile = await guestProfile(req.user.id);
  const availability = assessProjectAvailability({
    project, snapshot, profileState, legacyProfile, rules: await listRules()
  });
  res.json({ ...snapshot, availability });
});
routes.post('/api/rules/evaluate', auth, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => !['projectId', 'guestId', 'environment'].includes(key));
  if (unknown.length) throw new AppError(400, 'RULE_EVALUATION_FIELD_NOT_ALLOWED', '请求包含不允许的字段', { fields: unknown });
  if (typeof body.projectId !== 'string' || !body.projectId.trim()) {
    throw new AppError(400, 'PROJECT_ID_REQUIRED', '缺少项目编号');
  }
  if (!['guest', 'dean'].includes(req.user.role)
    && !(req.user.role === 'staff' && jobTypeFor(req.user) === 'clinician')) {
    throw new AppError(403, 'CLINICIAN_REQUIRED', '仅客人、负责医护或院长可执行健康规则核对');
  }
  const guestId = req.user.role === 'guest' ? req.user.id : body.guestId;
  if (typeof guestId !== 'string' || !guestId.trim()) throw new AppError(400, 'GUEST_ID_REQUIRED', '请提供待核对的客人');
  const guest = await authorizeGuestAccess(req.user, guestId.trim());
  const project = await getProject(body.projectId.trim());
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在或已停用');
  const environment = body.environment === undefined ? {} : body.environment;
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new AppError(400, 'ENVIRONMENT_INVALID', '环境输入格式不正确');
  }
  const environmentUnknown = Object.keys(environment).filter(key => !['uvLevel', 'seaStatus', 'source'].includes(key));
  if (environmentUnknown.length) throw new AppError(400, 'ENVIRONMENT_FIELD_NOT_ALLOWED', '环境输入包含不允许的字段', { fields: environmentUnknown });
  const uvLevels = new Set(['low', 'moderate', 'high', 'strong', 'unknown', 'missing']);
  const seaStatuses = new Set(['safe', 'unsafe', 'unknown', 'missing']);
  if (environment.uvLevel !== undefined && !uvLevels.has(environment.uvLevel)) {
    throw new AppError(400, 'ENVIRONMENT_UV_INVALID', '紫外线状态无效');
  }
  if (environment.seaStatus !== undefined && !seaStatuses.has(environment.seaStatus)) {
    throw new AppError(400, 'ENVIRONMENT_SEA_STATUS_INVALID', '海况状态无效');
  }
  if (environment.source !== undefined && (typeof environment.source !== 'string' || environment.source.length > 120)) {
    throw new AppError(400, 'ENVIRONMENT_SOURCE_INVALID', '环境来源说明最多 120 个字符');
  }
  const state = await healthProfileState(guest.id);
  const legacyProfile = await guestProfile(guest.id);
  const persistedRules = await listRules();
  res.json(evaluateProjectRules({
    project,
    verifiedProfile: state.verifiedProfile,
    legacyProfile,
    pendingIntakes: state.pendingIntakes,
    environment,
    effectiveHealthConstraints: state.effectiveHealthConstraints,
    rules: persistedRules
  }));
});

export default router;