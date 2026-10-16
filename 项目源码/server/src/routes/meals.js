// G43：膳食域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { authorizeGuestAccess } from '../authorization.js';
import { systemBusinessClock } from '../clock.js';
import { id, json } from '../db.js';
import { AppError } from '../errors.js';
import { createGuestMealOrder, generateGuestMenu, getGuestMealOrders, getGuestMenu, getMealRestrictionReview, listDietitianMealOrders, listDishes, replaceMenuItem, requestMealRestrictionReview, resolveMealRestrictionReview, reviewDietitianOrder, reviewGuestMenu, updateDietitianOrderStatus } from '../meals.js';
import { jobTypeFor } from '../staffing.js';
import { auth, clinicianOnly, dietitianOnly, routeHandler, staffOnly } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.get('/api/meals/restriction-review', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人核对');
  res.json(await getMealRestrictionReview(req.user.id));
});
routes.post('/api/meals/restriction-review', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可转交本人限制');
  res.json(await requestMealRestrictionReview({ user: req.user, guestId: req.user.id }));
});
routes.get('/api/staff/guests/:id/meal-restriction-review', auth, staffOnly, async (req, res) => {
  await authorizeGuestAccess(req.user, req.params.id);
  res.json(await getMealRestrictionReview(req.params.id));
});
routes.post('/api/staff/guests/:id/meal-restriction-review', auth, staffOnly, async (req, res) => {
  if (!['clinician', 'dietitian'].includes(jobTypeFor(req.user))) throw new AppError(403, 'CAPABILITY_FORBIDDEN', '仅医护或配餐员可转交');
  res.json(await requestMealRestrictionReview({ user: req.user, guestId: req.params.id }));
});
routes.post('/api/staff/meal-restriction-reviews/:id/resolve', auth, clinicianOnly, async (req, res) => {
  if (Object.keys(req.body || {}).some(key => !['decisions', 'note'].includes(key))) throw new AppError(400, 'MEAL_REVIEW_INPUT_INVALID', '核对只接受逐项决定和依据');
  res.json(await resolveMealRestrictionReview({ user: req.user, reviewId: req.params.id, decisions: req.body?.decisions, note: req.body?.note }));
});
routes.post('/api/meals/menus/:id/review', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可核对本人餐位');
  if (Object.keys(req.body || {}).some(key => key !== 'version')) throw new AppError(400, 'MEAL_REVIEW_INPUT_INVALID', '请提交当前餐单版本');
  res.json(await reviewGuestMenu({ guestId: req.user.id, menuId: req.params.id, version: req.body?.version }));
});
routes.post('/api/staff/meals/orders/:id/review', auth, dietitianOnly, async (req, res) => {
  if (Object.keys(req.body || {}).some(key => key !== 'note')) throw new AppError(400, 'MEAL_REVIEW_INPUT_INVALID', '请提交复核说明');
  res.json(await reviewDietitianOrder({ user: req.user, orderId: req.params.id, note: req.body?.note }));
});
routes.get('/api/meals/dishes', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看个人餐单菜品');
  res.json({ items: await listDishes(), sourceNote: '菜品、过敏原、配方标签与供货状态均为明确标注的本地演示资料。' });
});
routes.get('/api/meals/menu', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人餐单');
  const businessDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  res.json(await getGuestMenu(req.user.id, businessDate));
});
routes.post('/api/meals/menus', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可生成本人餐单');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => key !== 'businessDate');
  if (unknown.length || typeof body.businessDate !== 'string') throw new AppError(400, 'MEAL_MENU_INPUT_INVALID', '请求只接受有效的业务日期');
  const result = await generateGuestMenu(req.user.id, body.businessDate);
  res.status(result.created ? 201 : 200).json(result);
});
routes.patch('/api/meals/menus/:menuId/items/:itemId', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可替换本人餐单菜品');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => !['version', 'dishId', 'reason'].includes(key));
  if (unknown.length) throw new AppError(400, 'MEAL_SWAP_INPUT_INVALID', '替换请求包含不允许的字段');
  res.json(await replaceMenuItem({
    guestId: req.user.id, menuId: req.params.menuId, itemId: req.params.itemId,
    version: body.version, dishId: body.dishId, reason: body.reason
  }));
});
routes.get('/api/meals/orders', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人餐食订单');
  const businessDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  res.json(await getGuestMealOrders(req.user.id, businessDate));
});
routes.post('/api/meals/orders', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可提交本人餐食订单');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const unknown = Object.keys(body).filter(key => !['menuId', 'businessDate', 'mealType', 'version'].includes(key));
  if (unknown.length) throw new AppError(400, 'MEAL_ORDER_INPUT_INVALID', '订单请求包含不允许的字段');
  const result = await createGuestMealOrder({
    guestId: req.user.id, idempotencyKey: req.get('Idempotency-Key'),
    menuId: body.menuId, businessDate: body.businessDate, mealType: body.mealType, version: body.version
  });
  res.status(result.replayed ? 200 : 201).json(result);
});
routes.get('/api/staff/meals/orders', auth, dietitianOnly, async (req, res) => {
  const businessDate = typeof req.query.date === 'string' && req.query.date ? req.query.date : systemBusinessClock.dateKey();
  const mealType = typeof req.query.mealType === 'string' ? req.query.mealType : '';
  res.json(await listDietitianMealOrders(req.user, { businessDate, mealType }));
});
routes.patch('/api/staff/meals/orders/:orderId/status', auth, dietitianOnly, async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some(key => key !== 'status')) throw new AppError(400, 'MEAL_ORDER_STATUS_INPUT_INVALID', '状态更新只接受目标状态');
  res.json(await updateDietitianOrderStatus({ user: req.user, orderId: req.params.orderId, status: body.status }));
});

export default router;