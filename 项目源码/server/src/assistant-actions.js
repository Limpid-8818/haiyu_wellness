import crypto from 'node:crypto';
import { db, guestProfile, hasActiveTransaction, id, json, log, now, transaction } from './db.js';
import { AppError } from './errors.js';
import { authorizeGuestAccess } from './authorization.js';
import { getProject } from './catalog.js';
import { createReservation, cancelReservation, inspectGuestProjectSlots, listGuestSchedule } from './booking.js';
import { createGuestMealOrder, getGuestMenu, previewGuestMenuReplacement, replaceMenuItem } from './meals.js';
import { createHealthRecord, validateHealthMetricInput } from './health-metrics.js';
import { systemBusinessClock } from './clock.js';
import { isDateOnly } from './staffing.js';
import { mealDeliveryTiming } from './meal-policy.js';

const ACTION_TTL_MS = 10 * 60 * 1000;
const ACTION_TYPES = new Set(['book_program','cancel_booking','book_meal','swap_dish','record_metric','rest_change']);
const OPEN_STATUSES = ['needs_input','pending_confirmation'];
const LOCK = db.driver === 'mysql' ? ' FOR UPDATE' : '';
const inTransaction = callback => hasActiveTransaction() ? callback() : transaction(callback);

function stableJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeText(value, max = 160) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function validCalendarDate(value) {
  if (!isDateOnly(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function dateWithinSevenDays(value) {
  if (!validCalendarDate(value)) return false;
  const today = systemBusinessClock.dateKey();
  const max = new Date(`${today}T12:00:00Z`);
  max.setUTCDate(max.getUTCDate() + 6);
  return isDateOnly(value) && value >= today && value <= max.toISOString().slice(0, 10);
}
function parsed(value, fallback) { return json(value, fallback); }

function publicAction(row) {
  return {
    id: row.id, actionType: row.action_type, version: Number(row.version), status: row.status,
    parameters: parsed(row.parameters_json, {}), impact: parsed(row.impact_json, {}),
    missingFields: parsed(row.missing_fields_json, []), expiresAt: row.expires_at || null,
    createdAt: row.created_at, updatedAt: row.updated_at, confirmedAt: row.confirmed_at || null,
    result: parsed(row.result_json, null), errorCode: row.error_code || null
  };
}

async function currentPublicAction(row) {
  let card = publicAction(row);
  if (OPEN_STATUSES.includes(card.status) && card.expiresAt && Date.parse(card.expiresAt) <= Date.parse(now())) {
    await db.prepare("UPDATE assistant_action_cards SET status='expired',updated_at=? WHERE id=? AND status IN ('needs_input','pending_confirmation')")
      .run(now(), row.id);
    card = { ...card, status: 'expired' };
  }
  if (card.status !== 'confirmed' || !card.result?.businessId) return card;
  const result = { ...card.result };
  if (result.businessType === 'reservation') {
    const current = await db.prepare(`SELECT r.status,s.business_date AS businessDate,s.local_start AS localStart,
      s.local_end AS localEnd,p.name AS projectName FROM reservations r JOIN activity_slots s ON s.id=r.slot_id
      JOIN projects p ON p.id=s.project_id WHERE r.id=? AND r.guest_id=?`).get(result.businessId, row.guest_id);
    if (current) {
      result.actualState = current.status;
      result.reservation = { ...result.reservation, ...current, businessDate: String(current.businessDate).slice(0, 10) };
    }
  } else if (result.businessType === 'meal_order') {
    const current = await db.prepare('SELECT status,menu_version AS menuVersion,expected_delivery_at AS expectedDeliveryAt FROM meal_orders WHERE id=? AND guest_id=?')
      .get(result.businessId, row.guest_id);
    if (current) result.actualState = current.status;
  } else if (result.businessType === 'meal_menu') {
    const current = await db.prepare('SELECT status,version FROM meal_menus WHERE id=? AND guest_id=?').get(result.businessId, row.guest_id);
    if (current) result.actualState = current.status;
  } else if (result.businessType === 'health_record') {
    const current = await db.prepare('SELECT id FROM health_records WHERE id=? AND guest_id=?').get(Number(result.businessId), row.guest_id);
    if (!current) result.actualState = 'not_found';
  } else if (result.businessType === 'wellness_draft') {
    const current = await db.prepare('SELECT review_status AS reviewStatus FROM wellness_drafts WHERE id=? AND guest_id=?').get(result.businessId, row.guest_id);
    if (current) result.actualState = current.reviewStatus;
  }
  return { ...card, result };
}

async function assertGuestSession({ user, guestId, sessionId, runId }) {
  if (!user || user.role !== 'guest' || !guestId || user.id !== guestId) {
    throw new AppError(403, 'GUEST_REQUIRED', '仅客人可为本人创建助手确认卡');
  }
  await authorizeGuestAccess(user, guestId);
  const session = await db.prepare('SELECT * FROM assistant_sessions WHERE id=?').get(sessionId);
  if (!session || session.user_id !== user.id || session.assistant_role !== 'guest'
    || session.related_guest_id !== guestId || session.status !== 'active'
    || Date.parse(session.expires_at) <= Date.parse(now())) {
    throw new AppError(409, 'ASSISTANT_SESSION_INACTIVE', '助手会话已失效，请重新开始后再提出操作');
  }
  const run = await db.prepare('SELECT session_id,actor_id,assistant_role FROM agent_runs WHERE id=?').get(runId);
  if (!run || run.session_id !== sessionId || run.actor_id !== user.id || run.assistant_role !== 'guest') {
    throw new AppError(403, 'ASSISTANT_RUN_FORBIDDEN', '确认卡来源会话不匹配');
  }
  return session;
}

function normalizeParameters(actionType, input = {}) {
  if (!ACTION_TYPES.has(actionType) || !input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'ASSISTANT_ACTION_INPUT_INVALID', '助手操作类型或参数无效');
  }
  const allow = {
    book_program: ['projectId','date','slotId'],
    cancel_booking: ['reservationId'],
    book_meal: ['businessDate','mealType'],
    swap_dish: ['businessDate','itemId','dishId','reason'],
    record_metric: ['metric','systolic','diastolic','value','unit','recordedAt','note'],
    rest_change: ['reservationId','reason']
  }[actionType];
  if (Object.keys(input).some(key => !allow.includes(key))) {
    throw new AppError(400, 'ASSISTANT_ACTION_INPUT_INVALID', '操作参数包含不允许的字段');
  }
  const output = {};
  for (const key of allow) {
    if (input[key] === undefined || input[key] === null || input[key] === '') continue;
    if (['systolic','diastolic','value'].includes(key)) {
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) {
        throw new AppError(400, 'ASSISTANT_ACTION_INPUT_INVALID', `指标字段 ${key} 必须是有限数字`);
      }
      output[key] = input[key];
    } else if (typeof input[key] !== 'string') {
      throw new AppError(400, 'ASSISTANT_ACTION_INPUT_INVALID', `操作参数 ${key} 必须是文本`);
    } else output[key] = safeText(input[key], key === 'reason' || key === 'note' ? 500 : 160);
  }
  return output;
}

function metricValue(parameters) {
  return parameters.metric === 'blood_pressure'
    ? { ...(parameters.systolic === undefined ? {} : { systolic: parameters.systolic }),
      ...(parameters.diastolic === undefined ? {} : { diastolic: parameters.diastolic }) }
    : parameters.value;
}

async function ownedReservations(guestId) {
  return await db.prepare(`SELECT r.id,r.status,s.id AS slot_id,s.business_date AS business_date,
      s.starts_at AS starts_at,s.ends_at AS ends_at,s.local_start AS local_start,s.local_end AS local_end,
      s.capacity,s.updated_at AS slot_updated_at,p.updated_at AS project_updated_at,p.name AS project_name,
      (SELECT COUNT(*) FROM reservations active WHERE active.slot_id=s.id AND active.status='confirmed') AS booked
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
    WHERE r.guest_id=? AND r.status='confirmed' ORDER BY s.starts_at,r.id`).all(guestId);
}

function reservationImpact(row) {
  return { reservationId: row.id, projectName: row.project_name,
    businessDate: String(row.business_date).slice(0, 10), localStart: row.local_start, localEnd: row.local_end,
    startsAt: row.starts_at, endsAt: row.ends_at, releasedCapacity: 1 };
}

function reservationBasis(row) {
  return { reservationId: row.id, status: row.status, slotId: row.slot_id,
    startsAt: row.starts_at, endsAt: row.ends_at, slotUpdatedAt: row.slot_updated_at,
    projectUpdatedAt: row.project_updated_at, capacity: Number(row.capacity), booked: Number(row.booked || 0) };
}

async function buildProposal(actionType, parameters, guestId, sessionId) {
  const missingFields = [];
  const basis = {};
  let impact = { page: 'assistant', summary: '操作尚未准备好。' };
  let rejected = null;

  if (actionType === 'book_program') {
    if (!parameters.projectId) missingFields.push('项目');
    if (!parameters.date) missingFields.push('日期');
    let project = null;
    let options = [];
    if (parameters.projectId) {
      project = await getProject(parameters.projectId);
      if (!project) rejected = { code: 'PROJECT_NOT_FOUND', message: '没有找到可预约的启用项目，请重新选择项目。' };
    }
    if (!rejected && project && parameters.date && !dateWithinSevenDays(parameters.date)) {
      rejected = { code: 'SLOT_DATE_OUT_OF_RANGE', message: '预约日期须在今天起七天内，请重新选择日期。' };
    }
    let inspected = null;
    if (!rejected && project && parameters.date && dateWithinSevenDays(parameters.date)) {
      inspected = await inspectGuestProjectSlots(project.id, parameters.date, guestId);
      options = inspected.slots.filter(slot => slot.bookable).map(slot => ({ id: slot.id, localStart: slot.localStart,
        localEnd: slot.localEnd, capacity: slot.capacity, reservedCount: slot.booked, remaining: slot.remaining,
        ruleStatus: slot.environment?.status || slot.status, ruleSummary: slot.reason, isDemo: slot.isDemo }));
      if (!parameters.slotId) missingFields.push('本人选择的时段');
      else {
        const selected = inspected.slots.find(slot => slot.id === parameters.slotId);
        if (!selected) rejected = { code: 'SLOT_NOT_FOUND', message: '所选时段不属于该项目或日期，请重新查看时段。' };
        else if (!selected.bookable) rejected = { code: 'SLOT_NOT_AVAILABLE', message: selected.reason || '该时段当前不可预约，请重新查看。' };
        else {
          const raw = await db.prepare(`SELECT s.updated_at AS slotUpdatedAt,p.updated_at AS projectUpdatedAt,
              s.capacity,s.is_closed AS isClosed,
              (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
            FROM activity_slots s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.project_id=?`).get(selected.id, project.id);
          const profile = await guestProfile(guestId);
          basis.slot = { slotId: selected.id, startsAt: selected.startsAt, endsAt: selected.endsAt,
            slotUpdatedAt: raw?.slotUpdatedAt || null, projectUpdatedAt: raw?.projectUpdatedAt || null,
            capacity: Number(raw?.capacity || 0), booked: Number(raw?.booked || 0), isClosed: Boolean(Number(raw?.isClosed || 0)),
            environmentSnapshotId: selected.environment?.environmentSnapshotId || null,
            healthProfileVersion: Number(profile?.health_profile_version || 0) };
          impact = { page: 'schedule', summary: '预约仅在你再次确认且服务端复核仍可预约后提交。',
            project: { id: project.id, name: project.name }, date: parameters.date,
            slot: { id: selected.id, start: selected.localStart, end: selected.localEnd,
              capacity: selected.capacity, reservedCount: selected.booked, remaining: selected.remaining },
            rules: { status: selected.environment?.status || selected.status,
              summary: selected.reason, isDemo: Boolean(selected.isDemo) },
            revalidation: '确认时会重新核对开放时间、入住、健康/环境规则与剩余容量。', pageEntry: '/guest/schedule' };
        }
      }
    } else if (!parameters.slotId && project && parameters.date && !rejected) {
      missingFields.push('可预约时段');
    }
    if (!impact.slot) impact = { page: 'projects', summary: '请补齐预约信息；不会自动选择时段。',
      project: project ? { id: project.id, name: project.name } : null, date: parameters.date || null,
      availableSlots: options, pageEntry: '/guest/projects' };
  }

  if (actionType === 'cancel_booking' || actionType === 'rest_change') {
    const reservations = await ownedReservations(guestId);
    const reservation = parameters.reservationId ? reservations.find(item => item.id === parameters.reservationId) : null;
    if (!parameters.reservationId) missingFields.push('本人要取消的预约');
    else if (!reservation) rejected = { code: 'RESERVATION_NOT_FOUND', message: '没有找到这条仍有效的本人预约，请先查看日程。' };
    else if (Date.parse(reservation.starts_at) <= Date.parse(systemBusinessClock.utc())) {
      rejected = { code: 'RESERVATION_ALREADY_STARTED', message: '预约已经开始或结束，不能取消。' };
    } else {
      basis.reservation = reservationBasis(reservation);
      impact = { page: actionType === 'rest_change' ? 'wellness' : 'schedule',
        summary: actionType === 'rest_change' ? '确认后会取消原预约并释放一个名额，新的休息调整只进入待医护审核。' : '确认后会取消原预约并释放一个名额。',
        reservation: reservationImpact(reservation), pageEntry: '/guest/schedule',
        replacement: actionType === 'rest_change' ? '待审核；不会创建或激活替代预约。' : null };
    }
    if (actionType === 'rest_change' && !parameters.reason) missingFields.push('调整原因');
    if (!parameters.reservationId && actionType === 'cancel_booking') {
      impact = { page: 'schedule', summary: '请选择要取消的本人预约；助手不会自动选择或取消活动。',
        reservations: reservations.filter(item => Date.parse(item.starts_at) > Date.parse(systemBusinessClock.utc()))
          .slice(0, 8).map(reservationImpact), pageEntry: '/guest/schedule' };
    }
    if (!parameters.reservationId && actionType === 'rest_change') {
      impact = { page: 'wellness', summary: '请选择要停止的本人预约；助手不会取消未明确指定的活动。',
        reservations: reservations.filter(item => Date.parse(item.starts_at) > Date.parse(systemBusinessClock.utc()))
          .slice(0, 8).map(reservationImpact), pageEntry: '/guest/schedule' };
    }
  }

  if (actionType === 'book_meal') {
    if (!parameters.businessDate) missingFields.push('餐食日期');
    if (!parameters.mealType || !['breakfast','lunch','dinner'].includes(parameters.mealType)) missingFields.push('餐次');
    if (parameters.businessDate && !validCalendarDate(parameters.businessDate)) {
      rejected = { code: 'MEAL_DATE_INVALID', message: '餐食日期格式无效，请重新提供日期。' };
    }
    if (!rejected && parameters.businessDate && parameters.mealType && validCalendarDate(parameters.businessDate)) {
      const view = await getGuestMenu(guestId, parameters.businessDate);
      if (!view.menu) {
        missingFields.push('已保存的完整餐单');
        impact = { page: 'meals', summary: '这一天还没有已保存的餐单；请先到膳食页面准备菜单，再回来确认点餐。',
          pageEntry: '/guest/meals' };
      } else {
        const mealItems = view.items.filter(item => item.mealType === parameters.mealType);
        const orders = view.orders.filter(order => order.mealType === parameters.mealType);
        if (mealItems.length !== 3 || mealItems.some(item => !item.dish)) {
          missingFields.push('完整且符合限制的餐次菜单');
          impact = { page: 'meals', summary: '该餐次菜单不完整，不能创建订单；请到膳食页面补齐符合限制的餐位。',
            businessDate: parameters.businessDate, mealType: parameters.mealType, pageEntry: '/guest/meals' };
        } else if (orders.length) {
          rejected = { code: 'MEAL_ORDER_ALREADY_EXISTS', message: `该日期的${mealLabel(parameters.mealType)}已有订单，请刷新订单状态。` };
        } else {
          const items = mealItems.map(item => ({ id: item.id, slot: item.slot, dishId: item.dish.id,
            dishName: item.dish.name, ingredients: item.dish.ingredients, allergens: item.dish.allergens }));
          const timing = mealDeliveryTiming(parameters.businessDate, parameters.mealType);
          basis.meal = { menuId: view.menu.id, menuVersion: Number(view.menu.version),
            profileVersion: Number(view.currentRuleBasis?.profileVersion || 0),
            itemsFingerprint: digest(stableJson(items)), orderStatus: null };
          impact = { page: 'meals', summary: '确认后会按当前菜单版本创建配餐订单；预计送达时间未确定，常规供餐时刻不是预计。',
            menu: { id: view.menu.id, version: Number(view.menu.version), status: view.menu.status },
            businessDate: parameters.businessDate, mealType: parameters.mealType, mealLabel: mealLabel(parameters.mealType),
            items, ...timing, expectedTimeIsDemo: true, pageEntry: '/guest/meals' };
          parameters = { ...parameters, menuId: view.menu.id, version: Number(view.menu.version) };
        }
      }
    }
  }

  if (actionType === 'swap_dish') {
    if (!parameters.businessDate) missingFields.push('餐食日期');
    if (!parameters.itemId) missingFields.push('要替换的餐位');
    if (!parameters.dishId) missingFields.push('符合限制的替换菜品');
    if (!parameters.reason) missingFields.push('替换原因');
    if (parameters.businessDate && !validCalendarDate(parameters.businessDate)) rejected = { code: 'MEAL_DATE_INVALID', message: '餐食日期格式无效。' };
    if (!rejected && parameters.businessDate && validCalendarDate(parameters.businessDate)) {
      const view = await getGuestMenu(guestId, parameters.businessDate);
      if (!view.menu) {
        missingFields.push('已保存的完整餐单');
        impact = { page: 'meals', summary: '没有找到该日期的已保存餐单，请先到膳食页面查看。', pageEntry: '/guest/meals' };
      } else {
        parameters = { ...parameters, menuId: view.menu.id, version: Number(view.menu.version) };
        if (!parameters.itemId) impact = { page: 'meals', summary: '请选择要替换的餐位。',
          businessDate: parameters.businessDate, menu: { id: view.menu.id, version: Number(view.menu.version) },
          items: view.items.map(item => ({ id: item.id, mealType: item.mealType, slot: item.slot, dishName: item.dish?.name || null })), pageEntry: '/guest/meals' };
        if (parameters.itemId && parameters.dishId) {
          try {
            const preview = await previewGuestMenuReplacement({ guestId, menuId: view.menu.id, itemId: parameters.itemId,
              version: Number(view.menu.version), dishId: parameters.dishId });
            basis.swap = { menuId: preview.menuId, version: preview.version, businessDate: preview.businessDate,
              itemId: preview.item.id, currentDishId: preview.item.currentDishId, dishId: parameters.dishId,
              profileVersion: preview.profileVersion, order: preview.order };
            impact = { page: 'meals', summary: `确认后会把${mealLabel(preview.item.mealType)}${preview.item.slot === 'main' ? '主菜' : preview.item.slot === 'side' ? '配菜' : '汤品'}替换为${preview.dish.name}；现有预留订单会同步更新。`,
              businessDate: preview.businessDate, menu: { id: preview.menuId, version: preview.version },
              item: { id: preview.item.id, mealType: preview.item.mealType, slot: preview.item.slot,
                currentDishId: preview.item.currentDishId }, dish: preview.dish,
              order: preview.order, reason: parameters.reason, pageEntry: '/guest/meals' };
          } catch (error) {
            if (['MEAL_DISH_RESTRICTED','MEAL_RESTRICTION_UNMAPPED','MEAL_ORDER_IN_PROGRESS','MEAL_DISH_UNAVAILABLE',
              'MEAL_DISH_SLOT_MISMATCH','MEAL_MENU_STALE_VERSION'].includes(error.code)) {
              rejected = { code: error.code, message: error.message };
              impact = { page: 'meals', summary: error.message, businessDate: parameters.businessDate,
                itemId: parameters.itemId, dishId: parameters.dishId, pageEntry: '/guest/meals' };
            } else throw error;
          }
        }
      }
    }
  }

  if (actionType === 'record_metric') {
    if (!parameters.metric || !['blood_pressure','sleep','steps','weight'].includes(parameters.metric)) missingFields.push('指标类型');
    const metric = parameters.metric;
    const value = metricValue(parameters);
    if (metric === 'blood_pressure' && (!value || value.systolic === undefined || value.diastolic === undefined)) missingFields.push('收缩压和舒张压数值');
    if (metric && metric !== 'blood_pressure' && value === undefined) missingFields.push('指标数值');
    const unit = parameters.unit || ({ blood_pressure: 'mmHg', sleep: 'h', steps: '步', weight: 'kg' })[metric];
    if (metric && !parameters.unit) parameters = { ...parameters, unit };
    if (metric && missingFields.length === 0) {
      const recordedAt = parameters.recordedAt || now();
      parameters = { ...parameters, recordedAt };
      try {
        const validated = validateHealthMetricInput({ metric, value, unit, recordedAt, note: parameters.note },
          { id: guestId, role: 'guest' }, systemBusinessClock);
        const profile = await guestProfile(guestId);
        basis.metric = { profileVersion: Number(profile?.health_profile_version || 0), sessionId };
        impact = { page: 'health', summary: '确认后只会新增这一条本人健康记录，不会更改正式健康档案。',
          record: { metric: validated.metric, values: validated.values, unit: validated.unit,
            recordedAt: validated.recordedAt, source: 'assistant', sourceSessionId: sessionId, note: validated.note },
          pageEntry: '/guest/health' };
      } catch (error) {
        rejected = { code: error.code || 'HEALTH_METRIC_INVALID', message: error.message || '指标数据无效。' };
        impact = { page: 'health', summary: rejected.message, pageEntry: '/guest/health' };
      }
    } else if (metric) {
      parameters = { ...parameters, unit: unit || null };
      impact = { page: 'health', summary: '请补齐数值与单位；信息不完整时不会写入健康记录。',
        metric, value: value ?? null, unit: unit || null, pageEntry: '/guest/health' };
    }
  }

  if (actionType === 'rest_change' && !impact.reservation) {
    impact = { ...impact, page: 'wellness', summary: rejected?.message || '请选择要停止的本人预约，并说明希望休息或调整的原因。',
      replacement: '确认后产生待医护审核的休息调整版本；不会创建替代预约。', pageEntry: '/guest/wellness' };
  }

  if (rejected) impact = { ...impact, summary: rejected.message, errorCode: rejected.code };

  const status = rejected ? 'rejected' : missingFields.length ? 'needs_input' : 'pending_confirmation';
  if (Buffer.byteLength(stableJson(parameters), 'utf8') > 24 * 1024 || Buffer.byteLength(stableJson(impact), 'utf8') > 48 * 1024) {
    throw new AppError(400, 'ASSISTANT_ACTION_INPUT_INVALID', '确认卡内容超出允许范围');
  }
  return { status, parameters, impact, missingFields: [...new Set(missingFields)], basis, errorCode: rejected?.code || null };
}

function mealLabel(value) { return ({ breakfast: '早餐', lunch: '午餐', dinner: '晚餐' })[value] || value; }

export async function proposeGuestAction({ actionType, parameters, user, role, guestId, sessionId, runId,
  expectedPreviousCard = null }) {
  const normalized = normalizeParameters(actionType, parameters);
  await assertGuestSession({ user, guestId, sessionId, runId });
  let createdId;
  let stalePreviousAction = false;
  await inTransaction(async () => {
    await db.prepare(`SELECT id FROM assistant_sessions WHERE id=? AND user_id=? AND assistant_role='guest'${LOCK}`)
      .get(sessionId, user.id);
    const previous = await db.prepare(`SELECT * FROM assistant_action_cards WHERE guest_id=? AND session_id=?
      AND action_type=? AND status IN ('needs_input','pending_confirmation') ORDER BY created_at DESC,id DESC LIMIT 1${LOCK}`)
      .get(guestId, sessionId, actionType);
    if (expectedPreviousCard) {
      const expired = previous?.expires_at && Date.parse(previous.expires_at) <= Date.parse(now());
      const matches = previous?.id === expectedPreviousCard.id
        && Number(previous.version) === Number(expectedPreviousCard.version)
        && (!expectedPreviousCard.status || previous.status === expectedPreviousCard.status);
      if (!matches || expired) {
        if (expired) await db.prepare("UPDATE assistant_action_cards SET status='expired',updated_at=? WHERE id=? AND status IN ('needs_input','pending_confirmation')")
          .run(now(), previous.id);
        stalePreviousAction = true;
        return;
      }
    }
    const priorParameters = previous ? parsed(previous.parameters_json, {}) : {};
    const allowed = {
      book_program: ['projectId','date','slotId'], cancel_booking: ['reservationId'], book_meal: ['businessDate','mealType'],
      swap_dish: ['businessDate','itemId','dishId','reason'], record_metric: ['metric','systolic','diastolic','value','unit','recordedAt','note'],
      rest_change: ['reservationId','reason']
    }[actionType];
    const previousInputs = Object.fromEntries(Object.entries(priorParameters).filter(([key]) => allowed.includes(key)));
    const merged = normalizeParameters(actionType, { ...previousInputs, ...normalized });
    const prepared = await buildProposal(actionType, merged, guestId, sessionId);
    const logicalActionId = previous?.logical_action_id || id('assistant_action');
    const version = previous ? Number(previous.version) + 1 : 1;
    const cardId = id('assistant_action_card');
    const timestamp = now();
    const expiresAt = new Date(Date.parse(timestamp) + ACTION_TTL_MS).toISOString();
    if (previous) await db.prepare(`UPDATE assistant_action_cards SET status='superseded',updated_at=?
      WHERE id=? AND status IN ('needs_input','pending_confirmation')`).run(timestamp, previous.id);
    await db.prepare(`INSERT INTO assistant_action_cards
      (id,logical_action_id,parent_card_id,guest_id,session_id,source_run_id,action_type,version,status,
       parameters_json,impact_json,missing_fields_json,basis_json,request_fingerprint,error_code,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      cardId, logicalActionId, previous?.id || null, guestId, sessionId, runId, actionType, version, prepared.status,
      stableJson(prepared.parameters), stableJson(prepared.impact), stableJson(prepared.missingFields), stableJson(prepared.basis),
      digest(stableJson(prepared.parameters)), prepared.errorCode, expiresAt, timestamp, timestamp
    );
    await log(user.id, `assistant_action.${prepared.status}`, 'assistant_action_card', cardId,
      `${actionType} v${version}；会话 ${sessionId}；来源运行 ${runId}`);
    createdId = cardId;
  });
  if (stalePreviousAction) throw new AppError(409, 'ASSISTANT_ACTION_STALE', '预约卡已过期或发生变化，请先查看最新卡片');
  return await getAssistantActionCard({ user, sessionId, actionId: createdId });
}

export async function getAssistantActionCard({ user, sessionId, actionId }) {
  if (!user || user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可查看本人助手确认卡');
  const row = await db.prepare(`SELECT * FROM assistant_action_cards WHERE id=? AND guest_id=? AND session_id=?`)
    .get(actionId, user.id, sessionId);
  if (!row) throw new AppError(404, 'ASSISTANT_ACTION_NOT_FOUND', '助手操作卡不存在');
  await authorizeGuestAccess(user, row.guest_id);
  const session = await db.prepare('SELECT user_id,assistant_role,related_guest_id FROM assistant_sessions WHERE id=?').get(sessionId);
  if (!session || session.user_id !== user.id || session.assistant_role !== 'guest' || session.related_guest_id !== user.id) {
    throw new AppError(403, 'ASSISTANT_ACTION_FORBIDDEN', '无权查看该助手操作卡');
  }
  return await currentPublicAction(row);
}

export async function listAssistantActionCardsForRun(runId, guestId) {
  if (!runId || !guestId) return [];
  const rows = await db.prepare(`SELECT * FROM assistant_action_cards WHERE source_run_id=? AND guest_id=? ORDER BY version,id`)
    .all(runId, guestId);
  return await Promise.all(rows.map(currentPublicAction));
}

export async function getGuestActionPromptContext({ guestId, sessionId }) {
  const rows = await db.prepare(`SELECT id,action_type,version,status,parameters_json,missing_fields_json,expires_at
    FROM assistant_action_cards WHERE guest_id=? AND session_id=? AND status IN ('needs_input','pending_confirmation')
    ORDER BY created_at DESC,id DESC LIMIT 5`).all(guestId, sessionId);
  if (!rows.length) return '';
  return `\n当前会话待处理的结构化助手操作卡（服务端数据，仅供延续补问，不代表已执行）：${stableJson(rows.map(row => ({
    id: row.id, actionType: row.action_type, version: Number(row.version), status: row.status,
    parameters: parsed(row.parameters_json, {}), missingFields: parsed(row.missing_fields_json, []), expiresAt: row.expires_at
  })))}。`;
}

async function currentBookingBasis(actionType, parameters, guestId) {
  if (actionType === 'book_program') {
    const view = await inspectGuestProjectSlots(parameters.projectId, parameters.date, guestId);
    const slot = view.slots.find(item => item.id === parameters.slotId);
    if (!slot) return { changed: true, reason: '预约时段已不存在，请重新选择时段。' };
    const raw = await db.prepare(`SELECT s.updated_at AS slotUpdatedAt,p.updated_at AS projectUpdatedAt,
        s.capacity,s.is_closed AS isClosed,
        (SELECT COUNT(*) FROM reservations r WHERE r.slot_id=s.id AND r.status='confirmed') AS booked
      FROM activity_slots s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.project_id=?`)
      .get(slot.id, parameters.projectId);
    const profile = await guestProfile(guestId);
    const current = { slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt,
      slotUpdatedAt: raw?.slotUpdatedAt || null, projectUpdatedAt: raw?.projectUpdatedAt || null,
      capacity: Number(raw?.capacity || 0), booked: Number(raw?.booked || 0), isClosed: Boolean(Number(raw?.isClosed || 0)),
      environmentSnapshotId: slot.environment?.environmentSnapshotId || null,
      healthProfileVersion: Number(profile?.health_profile_version || 0) };
    return { changed: stableJson(current) !== stableJson(parsed(parameters._basis, current)), current,
      bookable: slot.bookable, reason: slot.reason || '开放时间、容量或健康/环境核验结果已变化。' };
  }
  if (actionType === 'cancel_booking' || actionType === 'rest_change') {
    const row = (await ownedReservations(guestId)).find(item => item.id === parameters.reservationId);
    if (!row) return { changed: true, reason: '预约状态已变化或不再属于当前客人。' };
    const current = reservationBasis(row);
    return { changed: stableJson(current) !== stableJson(parsed(parameters._basis, current)), current,
      bookable: Date.parse(row.starts_at) > Date.parse(systemBusinessClock.utc()), reason: '预约状态或时段已变化。' };
  }
  if (actionType === 'book_meal') {
    const view = await getGuestMenu(guestId, parameters.businessDate);
    if (!view.menu) return { changed: true, reason: '已保存餐单已不存在。' };
    const items = view.items.filter(item => item.mealType === parameters.mealType).map(item => ({
      id: item.id, slot: item.slot, dishId: item.dish?.id || null, dishName: item.dish?.name || null,
      ingredients: item.dish?.ingredients || [], allergens: item.dish?.allergens || []
    }));
    const profileVersion = Number(view.currentRuleBasis?.profileVersion || 0);
    const order = view.orders.find(item => item.mealType === parameters.mealType) || null;
    const current = { menuId: view.menu.id, menuVersion: Number(view.menu.version), profileVersion,
      itemsFingerprint: digest(stableJson(items)), orderStatus: order?.status || null };
    return { changed: stableJson(current) !== stableJson(parsed(parameters._basis, current)), current,
      bookable: !order && items.length === 3 && items.every(item => item.dishId), reason: '餐单版本、限制或订单状态已变化。' };
  }
  if (actionType === 'swap_dish') {
    const preview = await previewGuestMenuReplacement({ guestId, menuId: parameters.menuId, itemId: parameters.itemId,
      version: Number(parameters.version), dishId: parameters.dishId });
    const current = { menuId: preview.menuId, version: preview.version, businessDate: preview.businessDate,
      itemId: preview.item.id, currentDishId: preview.item.currentDishId, dishId: parameters.dishId,
      profileVersion: preview.profileVersion, order: preview.order };
    return { changed: stableJson(current) !== stableJson(parsed(parameters._basis, current)), current,
      bookable: true, reason: '菜单、健康限制或配餐状态已变化。' };
  }
  if (actionType === 'record_metric') {
    validateHealthMetricInput({ metric: parameters.metric, value: metricValue(parameters), unit: parameters.unit,
      recordedAt: parameters.recordedAt, note: parameters.note }, { id: guestId, role: 'guest' }, systemBusinessClock);
    return { changed: false, bookable: true, current: parsed(parameters._basis, {}) };
  }
  return { changed: true, reason: '当前操作类型不能确认。' };
}

function confirmationKey(actionId, version) { return `assistant-action:${actionId}:v${version}`; }

async function executeConfirmedAction(row, user, parameters, key) {
  const guestId = row.guest_id;
  if (row.action_type === 'book_program') {
    const result = await createReservation({ guestId, slotId: parameters.slotId, idempotencyKey: key });
    return { businessId: result.reservation.id, businessType: 'reservation', actualState: result.reservation.status,
      page: 'schedule', reservation: result.reservation, replayed: Boolean(result.replayed) };
  }
  if (row.action_type === 'cancel_booking') {
    const reservation = await cancelReservation({ guestId, reservationId: parameters.reservationId });
    return { businessId: reservation.id, businessType: 'reservation', actualState: reservation.status,
      page: 'schedule', reservation, replayed: reservation.status === 'cancelled' };
  }
  if (row.action_type === 'book_meal') {
    const result = await createGuestMealOrder({ guestId, idempotencyKey: key, menuId: parameters.menuId,
      businessDate: parameters.businessDate, mealType: parameters.mealType, version: Number(parameters.version) });
    return { businessId: result.order.id, businessType: 'meal_order', actualState: result.order.status,
      page: 'meals', order: result.order, replayed: Boolean(result.replayed) };
  }
  if (row.action_type === 'swap_dish') {
    const menu = await replaceMenuItem({ guestId, menuId: parameters.menuId, itemId: parameters.itemId,
      version: Number(parameters.version), dishId: parameters.dishId, reason: parameters.reason });
    const order = menu.orders?.find(item => item.mealType === menu.items?.find(entry => entry.id === parameters.itemId)?.mealType) || null;
    return { businessId: menu.menu.id, businessType: 'meal_menu', actualState: menu.status,
      page: 'meals', menu, order, replayed: false };
  }
  if (row.action_type === 'record_metric') {
    const input = validateHealthMetricInput({ metric: parameters.metric, value: metricValue(parameters), unit: parameters.unit,
      recordedAt: parameters.recordedAt, note: parameters.note }, user, systemBusinessClock);
    const record = await createHealthRecord({ ...input, source: 'guest', sourceSessionId: row.session_id });
    return { businessId: String(record.id), businessType: 'health_record', actualState: 'recorded',
      page: 'health', record, sourceSessionId: row.session_id, replayed: false };
  }
  if (row.action_type === 'rest_change') {
    const reservation = await cancelReservation({ guestId, reservationId: parameters.reservationId });
    const { createRestChangeDraft } = await import('./wellness-planner.js');
    const draft = await createRestChangeDraft({ user, reservationId: parameters.reservationId, sessionId: row.session_id,
      sourceRunId: row.source_run_id, actionCardId: row.id, reason: parameters.reason,
      requestKey: `${row.id}:v${row.version}` });
    const schedule = await listGuestSchedule(guestId);
    return { businessId: draft.draftId, businessType: 'wellness_draft', actualState: draft.reviewStatus,
      page: 'wellness', reservation, draft, schedule, replayed: false,
      scheduleLabel: '已取消，调整待审' };
  }
  throw new AppError(400, 'ASSISTANT_ACTION_TYPE_INVALID', '不支持的助手操作类型');
}

export async function confirmAssistantAction({ user, actionId, sessionId, version, idempotencyKey }) {
  if (!user || user.role !== 'guest') throw new AppError(403, 'GUEST_REQUIRED', '仅客人可确认本人助手操作');
  const snapshot = await getAssistantActionCard({ user, sessionId, actionId });
  if (!Number.isInteger(Number(version)) || Number(version) !== snapshot.version) {
    throw new AppError(409, 'ASSISTANT_ACTION_VERSION_STALE', '确认卡版本已变化，请重新加载当前确认卡');
  }
  const expectedKey = confirmationKey(actionId, snapshot.version);
  if (idempotencyKey !== expectedKey) throw new AppError(400, 'ASSISTANT_ACTION_IDEMPOTENCY_INVALID', '确认请求标识与确认卡版本不匹配');
  let outcome;
  try {
    outcome = await inTransaction(async () => {
      const row = await db.prepare(`SELECT * FROM assistant_action_cards WHERE id=? AND guest_id=? AND session_id=?${LOCK}`)
        .get(actionId, user.id, sessionId);
      if (!row) throw new AppError(404, 'ASSISTANT_ACTION_NOT_FOUND', '助手操作卡不存在');
      if (row.status === 'confirmed') return { card: await currentPublicAction(row) };
      if (Number(row.version) !== Number(version)) throw new AppError(409, 'ASSISTANT_ACTION_VERSION_STALE', '确认卡版本已变化，请重新加载当前确认卡');
      if (row.status !== 'pending_confirmation') return { card: await currentPublicAction(row) };
      const session = await db.prepare(`SELECT * FROM assistant_sessions WHERE id=?${LOCK}`).get(sessionId);
      if (!session || session.user_id !== user.id || session.assistant_role !== 'guest'
        || session.related_guest_id !== user.id || session.status !== 'active'
        || Date.parse(session.expires_at) <= Date.parse(now())) {
        const message = '助手会话已失效，请重新开始后再核对。';
        await db.prepare(`UPDATE assistant_action_cards SET status='stale',error_code='ASSISTANT_SESSION_INACTIVE',
          impact_json=?,updated_at=? WHERE id=? AND status='pending_confirmation'`)
          .run(stableJson({ ...parsed(row.impact_json, {}), resultMessage: message }), now(), row.id);
        return { card: await currentPublicAction(await db.prepare('SELECT * FROM assistant_action_cards WHERE id=?').get(row.id)) };
      }
      if (Date.parse(row.expires_at) <= Date.parse(now())) {
        await db.prepare(`UPDATE assistant_action_cards SET status='expired',updated_at=? WHERE id=?`)
          .run(now(), row.id);
        const expired = await db.prepare('SELECT * FROM assistant_action_cards WHERE id=?').get(row.id);
        return { card: await currentPublicAction(expired) };
      }
      const parameters = parsed(row.parameters_json, {});
      const basis = parsed(row.basis_json, {});
      parameters._basis = basis.slot || basis.reservation || basis.meal || basis.swap || basis.metric || {};
      const current = await currentBookingBasis(row.action_type, parameters, row.guest_id);
      if (current.changed || !current.bookable) {
        const message = current.reason || '业务状态已变化，请重新核对并确认。';
        await db.prepare(`UPDATE assistant_action_cards SET status='stale',error_code='ASSISTANT_ACTION_STALE',
          impact_json=?,updated_at=? WHERE id=?`).run(stableJson({ ...parsed(row.impact_json, {}), resultMessage: message,
            currentState: current.current || null }), now(), row.id);
        const stale = await db.prepare('SELECT * FROM assistant_action_cards WHERE id=?').get(row.id);
        return { card: publicAction(stale) };
      }
      delete parameters._basis;
      const result = await executeConfirmedAction(row, user, parameters, expectedKey);
      const timestamp = now();
      await db.prepare(`UPDATE assistant_action_cards SET status='confirmed',result_json=?,confirmed_at=?,updated_at=?,error_code=NULL
        WHERE id=? AND status='pending_confirmation'`).run(stableJson(result), timestamp, timestamp, row.id);
      await log(user.id, 'assistant_action.confirm', 'assistant_action_card', row.id,
        `${row.action_type} v${row.version}；业务=${result.businessType}:${result.businessId}；状态=${result.actualState}`);
      return { card: publicAction(await db.prepare('SELECT * FROM assistant_action_cards WHERE id=?').get(row.id)) };
    });
  } catch (error) {
    const code = error.code || 'ASSISTANT_ACTION_EXECUTION_FAILED';
    const staleCodes = new Set(['SLOT_FULL','SLOT_NOT_AVAILABLE','SLOT_WINDOW_CHANGED','SLOT_CLOSED','SLOT_PAST',
      'RESERVATION_TIME_CONFLICT','MEAL_MENU_STALE_VERSION','MEAL_DISH_RESTRICTED','MEAL_RESTRICTION_UNMAPPED',
      'MEAL_ORDER_IN_PROGRESS','MEAL_ORDER_ALREADY_EXISTS','MEAL_MENU_INCOMPLETE','RESERVATION_ALREADY_STARTED']);
    await inTransaction(async () => {
      await db.prepare(`UPDATE assistant_action_cards SET status=?,error_code=?,impact_json=?,updated_at=?
        WHERE id=? AND status='pending_confirmation'`).run(staleCodes.has(code) ? 'stale' : 'failed', code,
        stableJson({ ...snapshot.impact, resultMessage: error.message || '操作暂时无法完成；没有保存成功结果。' }), now(), actionId);
    });
    const updated = await getAssistantActionCard({ user, sessionId, actionId });
    outcome = { card: updated };
  }
  return outcome.card || outcome;
}
