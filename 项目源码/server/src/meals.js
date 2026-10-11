import crypto from 'node:crypto';
import { db, guestProfile, id, json, now, log, transaction, hasActiveTransaction } from './db.js';
import { AppError } from './errors.js';
import { effectiveHealthConstraints, normalizeHealthProfile } from './health-profile.js';
import { isDateOnly, stayStatus } from './staffing.js';
import { authorizeGuestAccess } from './authorization.js';

const MEALS = ['breakfast', 'lunch', 'dinner'];
const SLOTS = ['main', 'side', 'soup'];
const LOCK = db.driver === 'mysql' ? ' FOR UPDATE' : '';
const inTransaction = callback => hasActiveTransaction() ? callback() : transaction(callback);

function decode(value, fallback = []) {
  const parsed = json(value, fallback);
  return parsed ?? fallback;
}

function isoUtc(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
}

function decodeDish(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    ingredients: decode(row.ingredients_json),
    allergens: decode(row.allergens_json),
    dietaryTags: decode(row.dietary_tags_json),
    audienceTags: decode(row.audience_tags_json),
    mealTypes: decode(row.meal_types_json),
    slot: row.slot,
    nutritionLabels: decode(row.nutrition_labels_json),
    sourceReference: row.source_reference,
    supplyStatus: row.supply_status,
    nonSeafoodAlternativeId: row.non_seafood_alternative_id || null,
    isDemo: Boolean(Number(row.is_demo))
  };
}

function normalizeValue(value) {
  return String(value ?? '').trim().toLocaleLowerCase().replace(/[\s·，,。]/g, '');
}

const ALIASES = new Map([
  ['虾', 'shrimp'], ['虾类', 'shrimp'], ['虾仁', 'shrimp'], ['虾过敏', 'shrimp'], ['shrimp', 'shrimp'],
  ['海鲜', 'seafood'], ['海产品', 'seafood'], ['seafood', 'seafood'],
  ['鱼', 'fish'], ['鱼类', 'fish'], ['鱼肉', 'fish'], ['鱼过敏', 'fish'], ['fish', 'fish'],
  ['鸡蛋', 'egg'], ['蛋类', 'egg'], ['鸡蛋过敏', 'egg'], ['egg', 'egg'],
  ['花生', 'peanut'], ['花生过敏', 'peanut'], ['peanut', 'peanut'],
  ['牛奶', 'milk'], ['乳制品', 'milk'], ['奶类', 'milk'], ['milk', 'milk'],
  ['小麦', 'gluten'], ['小麦面', 'gluten'], ['麸质', 'gluten'], ['wheat', 'gluten'], ['gluten', 'gluten'],
  ['燕麦', 'oats'], ['oats', 'oats'],
  ['大豆', 'soy'], ['豆制品', 'soy'], ['豆腐', 'soy'], ['soy', 'soy'],
  ['素食', '素食'], ['不吃肉', '素食'], ['纯素', '纯素'], ['vegan', '纯素'],
  ['清真', '清真'], ['halal', '清真']
]);
const KNOWN_INGREDIENTS = new Set([
  '鸡肉', '大米', '香菇', '姜', '豆腐', '小麦面', '青菜', '鱼肉', '鸡蛋', '南瓜', '小麦',
  '西兰花', '植物油', '胡萝卜', '西葫芦', '紫菜', '冬瓜', '燕麦', '牛奶', '花生'
].map(normalizeValue));
const SEAFOOD_COMPONENTS = new Set(['seafood', 'fish', 'shrimp']);
const POSITIVE_DIETARY_REQUIREMENTS = new Map([
  ['素食', { tags: new Set(['素食', '纯素']), excludes: new Set(['chicken', 'fish', 'shrimp', 'seafood']) }],
  ['纯素', { tags: new Set(['纯素']), excludes: new Set(['chicken', 'fish', 'shrimp', 'seafood', 'egg', 'milk']) }],
  ['清真', { tags: new Set(['清真']), excludes: new Set() }]
]);

function canonical(value) {
  const normalized = normalizeValue(value);
  return ALIASES.get(normalized) || normalized;
}

function safeJsonProfile(value) {
  try { return normalizeHealthProfile(decode(value, {})); }
  catch { return normalizeHealthProfile({}); }
}

async function healthState(guestId, { lock = false } = {}) {
  const profileRow = await db.prepare(`SELECT user_id,health_profile_json,health_profile_version,allergies_json,
      check_in,check_out,room_no FROM guest_profiles WHERE user_id=?${lock ? LOCK : ''}`).get(guestId);
  if (!profileRow) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立，暂不能生成餐单');
  const profile = safeJsonProfile(profileRow.health_profile_json);
  const legacyAllergies = decode(profileRow.allergies_json, []);
  const pendingRows = await db.prepare(`SELECT id,source,structured_json AS structuredJson FROM health_intakes
    WHERE guest_id=? AND status='pending' ORDER BY revision DESC,id DESC${lock ? LOCK : ''}`).all(guestId);
  const pendingIntakes = pendingRows.map(row => ({
    id: row.id,
    source: row.source || 'pending-intake',
    candidate: safeJsonProfile(row.structuredJson),
    profile: safeJsonProfile(row.structuredJson)
  }));
  const constraints = effectiveHealthConstraints({ verified: profile, pendingIntakes, legacyAllergies });
  const audiencePreferences = [
    ...profile.audienceTags.items.map(value => ({ value, source: 'verified-profile', sourceId: null })),
    ...pendingIntakes.flatMap(intake => intake.candidate.audienceTags.items.map(value => ({ value, source: intake.source, sourceId: intake.id })))
  ];
  const notices = [];
  if (profile.allergies.status === 'unanswered' || profile.allergies.status === 'unknown') {
    notices.push({ code: 'ALLERGY_REVIEW_PENDING', text: `正式过敏信息${profile.allergies.status === 'unknown' ? '标记为不确定' : '尚未填写'}；当前仅按已记录的明确来源限制避开，请联系配餐员补充核对。` });
  }
  if (profile.dietaryRestrictions.status === 'unanswered' || profile.dietaryRestrictions.status === 'unknown') {
    notices.push({ code: 'DIETARY_REVIEW_PENDING', text: `正式饮食忌口${profile.dietaryRestrictions.status === 'unknown' ? '标记为不确定' : '尚未填写'}；当前没有把它当作“无忌口”。` });
  }
  if (constraints.conflictState === 'pending-review' || constraints.conflictState === 'conflict') {
    notices.push({ code: 'HEALTH_REVIEW_PENDING', text: '健康限制中存在待核实信息；当前同时保留所有明确限制，建议配餐员复核。' });
  }
  const unrecognized = [...constraints.allergies, ...constraints.dietaryRestrictions]
    .filter(item => !knownConstraint(item.value));
  if (unrecognized.length) {
    notices.push({ code: 'RESTRICTION_UNMAPPED', text: `有未能与菜品字段精确对应的限制（${[...new Set(unrecognized.map(item => item.value))].join('、')}）；相关餐位暂不推荐菜品。` });
  }
  return {
    profile,
    pendingIntakes,
    constraints,
    audiencePreferences,
    notices,
    checkIn: profileRow.check_in,
    checkOut: profileRow.check_out,
    roomNo: profileRow.room_no || '',
    profileVersion: Number(profileRow.health_profile_version || 0)
  };
}

function knownConstraint(value) {
  const normalized = normalizeValue(value);
  return Boolean(normalized && (ALIASES.has(normalized) || KNOWN_INGREDIENTS.has(normalized)));
}

function domainMatches(value, dishValues) {
  const wanted = canonical(value);
  return dishValues.some(candidate => canonical(candidate) === wanted);
}

function hasSeafoodComponent(dish) {
  return [...dish.allergens, ...dish.ingredients]
    .some(value => SEAFOOD_COMPONENTS.has(canonical(value)));
}

function hasForbiddenDietComponent(dish, forbidden) {
  return [...dish.allergens, ...dish.ingredients]
    .some(value => forbidden.has(canonical(value)));
}

function dishConflictReason(dish, constraints) {
  for (const restriction of constraints.allergies) {
    const fields = [...dish.allergens, ...dish.ingredients];
    if (canonical(restriction.value) === 'seafood' ? hasSeafoodComponent(dish) : domainMatches(restriction.value, fields)) {
      return { kind: 'allergy', value: restriction.value, source: restriction.source, sourceId: restriction.sourceId };
    }
  }
  for (const restriction of constraints.dietaryRestrictions) {
    const requirement = POSITIVE_DIETARY_REQUIREMENTS.get(canonical(restriction.value));
    if (requirement) {
      const hasRequiredTag = dish.dietaryTags.some(value => requirement.tags.has(canonical(value)));
      if (!hasRequiredTag || hasForbiddenDietComponent(dish, requirement.excludes)) {
        return { kind: 'dietaryRequirement', value: restriction.value, source: restriction.source, sourceId: restriction.sourceId };
      }
      continue;
    }
    if (canonical(restriction.value) === 'seafood' ? hasSeafoodComponent(dish)
      : domainMatches(restriction.value, [...dish.allergens, ...dish.ingredients])) {
      return { kind: 'dietaryRestriction', value: restriction.value, source: restriction.source, sourceId: restriction.sourceId };
    }
  }
  return null;
}

function incompleteReason(mealType, slot, state, rows) {
  const missing = [];
  if (!rows.length) missing.push('没有符合餐次与餐位的菜品资料');
  if (!rows.some(row => row.supply_status === 'demo_available')) missing.push('没有标记为演示可供的菜品');
  const restrictions = [...state.constraints.allergies, ...state.constraints.dietaryRestrictions];
  const filtered = rows.filter(row => row.supply_status === 'demo_available')
    .filter(row => !dishConflictReason(decodeDish(row), state.constraints));
  if (rows.length && !filtered.length) {
    const reasons = rows.filter(row => row.supply_status === 'demo_available')
      .map(row => dishConflictReason(decodeDish(row), state.constraints)).filter(Boolean);
    const unmet = [...new Set(reasons.filter(item => item.kind === 'dietaryRequirement').map(item => item.value))];
    const excluded = [...new Set(reasons.filter(item => item.kind !== 'dietaryRequirement').map(item => item.value))];
    if (unmet.length) missing.push(`没有带明确“${unmet.join('、')}”合规标签的菜品`);
    if (excluded.length) missing.push(`当前菜品命中明确限制（${excluded.join('、')}）`);
    if (!unmet.length && !excluded.length) missing.push('当前菜品资料不足以作安全筛选');
  }
  if (restrictions.some(item => !knownConstraint(item.value))) missing.push('至少一项限制无法精确映射到菜品字段');
  if (!missing.length) missing.push('符合当前明确限制的演示供货菜品数量不足');
  return `${mealType}/${slot}：${[...new Set(missing)].join('；')}。未放入替代或禁忌菜品。`;
}

function menuBasis(state) {
  return {
    profileVersion: state.profileVersion,
    effectiveHealthConstraints: state.constraints,
    audiencePreferences: state.audiencePreferences,
    notices: state.notices,
    evaluatedAt: now(),
    supplyNote: '演示供应状态仅用于本地验收，不表示真实库存、预留或出餐承诺。'
  };
}

function dishSnapshot(dish) {
  return {
    dishId: dish.id, name: dish.name, ingredients: dish.ingredients, allergens: dish.allergens,
    dietaryTags: dish.dietaryTags, mealTypes: dish.mealTypes, slot: dish.slot,
    nutritionLabels: dish.nutritionLabels, sourceReference: dish.sourceReference,
    supplyStatus: dish.supplyStatus, isDemo: dish.isDemo
  };
}

async function catalogRows() {
  return db.prepare('SELECT * FROM dishes ORDER BY id').all();
}

function dateInStay(state, date) {
  if (!isDateOnly(date)) throw new AppError(400, 'MEAL_DATE_INVALID', '日期必须是有效的 YYYY-MM-DD');
  if (!isDateOnly(state.checkIn) || (isDateOnly(state.checkOut) && (date < state.checkIn || date >= state.checkOut))) {
    throw new AppError(409, 'MEAL_DATE_OUTSIDE_STAY', '所选日期不在已登记的入住区间内，请联系工作人员确认入住信息');
  }
  if (stayStatus(state.checkIn, state.checkOut, date) === 'pending') {
    throw new AppError(409, 'MEAL_DATE_OUTSIDE_STAY', '所选日期尚未入住，暂不能查看或提交餐单');
  }
  if (isDateOnly(state.checkOut) && date >= state.checkOut) {
    throw new AppError(409, 'MEAL_DATE_OUTSIDE_STAY', '所选日期已离店，暂不能查看或提交餐单');
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function menuForGuest(guestId, businessDate, { lock = false } = {}) {
  const row = await db.prepare(`SELECT * FROM meal_menus WHERE guest_id=? AND business_date=?${lock ? LOCK : ''}`)
    .get(guestId, businessDate);
  return row || null;
}

async function menuItems(menuId, { lock = false } = {}) {
  const rows = await db.prepare(`SELECT mi.*,d.name,d.ingredients_json,d.allergens_json,d.dietary_tags_json,
      d.audience_tags_json,d.meal_types_json,d.slot AS dish_slot,d.nutrition_labels_json,d.source_reference,
      d.supply_status,d.non_seafood_alternative_id,d.is_demo
    FROM meal_menu_items mi LEFT JOIN dishes d ON d.id=mi.dish_id
    WHERE mi.menu_id=? ORDER BY CASE mi.meal_type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END,
      CASE mi.slot WHEN 'main' THEN 1 WHEN 'side' THEN 2 ELSE 3 END${lock ? LOCK : ''}`).all(menuId);
  return rows.map(row => ({
    id: row.id, mealType: row.meal_type, slot: row.slot, dish: decodeDish(row.dish_id ? {
      ...row, id: row.dish_id, slot: row.dish_slot
    } : null), dishSnapshot: decode(row.dish_snapshot_json, {}), selectionReason: row.selection_reason || ''
  }));
}

export async function listDishes() {
  const rows = (await catalogRows()).map(decodeDish);
  const byId = new Map(rows.map(row => [row.id, row]));
  return rows.map(row => ({ ...row, nonSeafoodAlternative: row.nonSeafoodAlternativeId ? byId.get(row.nonSeafoodAlternativeId) || null : null }));
}

export async function getNutritionRecommendationContext(guestId) {
  const health = await healthState(guestId);
  const catalog = (await catalogRows()).map(decodeDish);
  const restrictions = [...health.constraints.allergies, ...health.constraints.dietaryRestrictions];
  const unmapped = restrictions.filter(item => !knownConstraint(item.value));
  const candidates = [];
  const excluded = [];
  for (const mealType of ['breakfast', 'lunch', 'dinner']) {
    for (const dish of catalog.filter(item => item.slot === 'main' && item.mealTypes.includes(mealType))) {
      const conflict = dishConflictReason(dish, health.constraints);
      let exclusionReason = '';
      let restriction = null;
      if (dish.supplyStatus !== 'demo_available') exclusionReason = '当前演示供货状态不可推荐';
      else if (unmapped.length) {
        exclusionReason = '存在无法精确映射到食材字段的限制，暂不推荐菜品';
        restriction = unmapped[0];
      } else if (conflict) {
        restriction = restrictions.find(item => item.value === conflict.value && item.source === conflict.source
          && item.sourceId === conflict.sourceId) || conflict;
        exclusionReason = conflict.kind === 'allergy' ? '命中过敏限制' : '命中饮食忌口限制';
      }
      if (exclusionReason) {
        excluded.push({ mealType, dishId: dish.id, dishName: dish.name, reason: exclusionReason,
          restrictionSourceId: restriction?.sourceId ?? guestId, restrictionSource: restriction?.source || 'guest-profile' });
        continue;
      }
      candidates.push({ candidateId: `${mealType}:${dish.id}`, mealType,
        dish: { id: dish.id, name: dish.name, ingredients: dish.ingredients, allergens: dish.allergens,
          mealTypes: dish.mealTypes, slot: dish.slot, supplyStatus: dish.supplyStatus, isDemo: dish.isDemo,
          sourceReference: dish.sourceReference } });
    }
  }
  return {
    candidates,
    excluded,
    restrictions: restrictions.map(item => ({ value: item.value, source: item.source, sourceId: item.sourceId ?? guestId, status: item.status })),
    notices: [...health.notices],
    profileVersion: health.profileVersion,
    supplyBoundary: '演示供货状态仅用于本地验收，不表示真实库存、预留或出餐承诺。'
  };
}

export async function getGuestMenu(guestId, businessDate) {
  if (!isDateOnly(businessDate)) throw new AppError(400, 'MEAL_DATE_INVALID', '日期必须是有效的 YYYY-MM-DD');
  const health = await healthState(guestId);
  dateInStay(health, businessDate);
  const menu = await menuForGuest(guestId, businessDate);
  if (!menu) return { status: 'needs_generation', businessDate, menu: null, items: [], orders: [] };
  const catalog = (await catalogRows()).map(decodeDish);
  const unmapped = [...health.constraints.allergies, ...health.constraints.dietaryRestrictions].some(item => !knownConstraint(item.value));
  const storedRuleBasis = decode(menu.rule_basis_json, {});
  const currentRuleBasis = menuBasis(health);
  const currentReviewRequired = Number(storedRuleBasis.profileVersion || 0) !== health.profileVersion
    || JSON.stringify(storedRuleBasis.effectiveHealthConstraints || {}) !== JSON.stringify(health.constraints);
  const items = (await menuItems(menu.id)).map(item => ({
    ...item,
    currentlyRestricted: Boolean(item.dish && (unmapped || item.dish.supplyStatus !== 'demo_available' || dishConflictReason(item.dish, health.constraints))),
    eligibleReplacements: unmapped ? [] : catalog.filter(dish => dish.id !== item.dish?.id
      && dish.slot === item.slot && dish.mealTypes.includes(item.mealType)
      && dish.supplyStatus === 'demo_available' && !dishConflictReason(dish, health.constraints))
  }));
  return {
    status: menu.status,
    businessDate,
    menu: {
      id: menu.id, guestId: menu.guest_id, businessDate, version: Number(menu.version),
      status: menu.status, ruleBasis: decode(menu.rule_basis_json, {}),
      avoidedItems: decode(menu.avoided_items_json, []), createdAt: menu.created_at, updatedAt: menu.updated_at
    },
    currentRuleBasis, currentReviewRequired,
    items,
    orders: await listGuestOrders(guestId, businessDate)
  };
}

export async function generateGuestMenu(guestId, businessDate) {
  return inTransaction(async () => {
    const health = await healthState(guestId, { lock: true });
    dateInStay(health, businessDate);
    const existing = await menuForGuest(guestId, businessDate, { lock: true });
    if (existing) return { created: false, ...(await getGuestMenu(guestId, businessDate)) };
    const catalog = await catalogRows();
    const basis = menuBasis(health);
    const avoided = [...health.constraints.allergies, ...health.constraints.dietaryRestrictions];
    const picks = [];
    const missing = [];
    for (const mealType of MEALS) for (const slot of SLOTS) {
      const candidates = catalog.filter(row => row.slot === slot && decode(row.meal_types_json).includes(mealType));
      const mappedUnknown = avoided.some(item => !knownConstraint(item.value));
      const eligible = candidates
        .filter(row => row.supply_status === 'demo_available')
        .map(decodeDish)
        .filter(dish => !mappedUnknown && !dishConflictReason(dish, health.constraints));
      eligible.sort((left, right) => {
        const leftScore = health.audiencePreferences.filter(item => left.audienceTags.some(tag => canonical(tag) === canonical(item.value))).length;
        const rightScore = health.audiencePreferences.filter(item => right.audienceTags.some(tag => canonical(tag) === canonical(item.value))).length;
        return rightScore - leftScore || left.id.localeCompare(right.id);
      });
      const dish = eligible[0] || null;
      const reason = dish ? '' : incompleteReason(mealType, slot, health, candidates);
      if (!dish) missing.push(reason);
      picks.push({ mealType, slot, dish, reason });
    }
    const menuId = id('meal_menu');
    const stamp = now();
    await db.prepare(`INSERT INTO meal_menus(id,guest_id,business_date,version,status,rule_basis_json,avoided_items_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      menuId, guestId, businessDate, 1, missing.length ? 'incomplete' : 'ready',
      JSON.stringify(basis), JSON.stringify(avoided), stamp, stamp
    );
    for (const pick of picks) {
      await db.prepare(`INSERT INTO meal_menu_items(id,menu_id,meal_type,slot,dish_id,dish_snapshot_json,selection_reason)
        VALUES(?,?,?,?,?,?,?)`).run(
        id('meal_item'), menuId, pick.mealType, pick.slot, pick.dish?.id || null,
        JSON.stringify(pick.dish ? dishSnapshot(pick.dish) : {}), pick.reason
      );
    }
    await log(guestId, 'meal.menu.generate', 'meal_menu', menuId, `${businessDate} ${missing.length ? '餐位不完整' : '已生成'}; explicit constraints preserved`);
    return { created: true, ...(await getGuestMenu(guestId, businessDate)) };
  });
}

async function menuById(menuId, { lock = false } = {}) {
  return db.prepare(`SELECT * FROM meal_menus WHERE id=?${lock ? LOCK : ''}`).get(menuId);
}

function validateDishForSlot(dish, item, mealType, health) {
  if (!dish || dish.supplyStatus !== 'demo_available') throw new AppError(409, 'MEAL_DISH_UNAVAILABLE', '所选菜品当前没有演示可供状态，请刷新餐单后重试');
  if (dish.slot !== item.slot || !dish.mealTypes.includes(mealType)) {
    throw new AppError(400, 'MEAL_DISH_SLOT_MISMATCH', '所选菜品不属于当前餐次和餐位');
  }
  const conflict = dishConflictReason(dish, health.constraints);
  if (conflict) {
    const description = conflict.kind === 'dietaryRequirement'
      ? `该菜品没有明确符合“${conflict.value}”的合规标签，不能提交`
      : `该菜品命中当前明确${conflict.kind === 'allergy' ? '过敏' : '饮食限制'}“${conflict.value}”，不能提交`;
    throw new AppError(409, 'MEAL_DISH_RESTRICTED', description, {
      source: conflict.source, sourceId: conflict.sourceId, field: conflict.kind
    });
  }
  if ([...health.constraints.allergies, ...health.constraints.dietaryRestrictions].some(entry => !knownConstraint(entry.value))) {
    throw new AppError(409, 'MEAL_RESTRICTION_UNMAPPED', '当前有无法精确匹配到菜品字段的健康限制，暂不能提交替换；请联系配餐员核对。');
  }
}

async function loadOrder(orderId, { lock = false } = {}) {
  const row = await db.prepare(`SELECT * FROM meal_orders WHERE id=?${lock ? LOCK : ''}`).get(orderId);
  return row ? decodeOrder(row) : null;
}

function decodeOrder(row) {
  return {
    id: row.id, orderNo: row.id, guestId: row.guest_id, menuId: row.menu_id,
    businessDate: String(row.business_date).slice(0, 10), mealType: row.meal_type,
    menuVersion: Number(row.menu_version), dishes: decode(row.dishes_snapshot_json, []),
    status: row.status, createdAt: isoUtc(row.created_at), expectedDeliveryAt: isoUtc(row.expected_delivery_at),
    expectedTimeIsDemo: Boolean(Number(row.expected_time_is_demo)),
    expectedDeliveryNote: '演示估算时刻，不代表实际送餐承诺。', preparingAt: isoUtc(row.preparing_at),
    deliveredAt: isoUtc(row.delivered_at)
  };
}

async function updateReservedOrderSnapshot(menu, mealType, version) {
  const orderRow = await db.prepare(`SELECT * FROM meal_orders WHERE guest_id=? AND business_date=? AND meal_type=?${LOCK}`)
    .get(menu.guest_id, menu.business_date, mealType);
  if (!orderRow) return;
  if (orderRow.status !== 'reserved') {
    throw new AppError(409, 'MEAL_ORDER_IN_PROGRESS', '订单已进入备餐或送达阶段，不能再修改；请联系配餐员处理。', { status: orderRow.status });
  }
  const items = await menuItems(menu.id, { lock: true });
  const dishes = items.filter(item => item.mealType === mealType && item.dish).map(item => ({ ...dishSnapshot(item.dish), slot: item.slot }));
  await db.prepare('UPDATE meal_orders SET menu_version=?,dishes_snapshot_json=? WHERE id=?')
    .run(version, JSON.stringify(dishes), orderRow.id);
}

export async function previewGuestMenuReplacement({ guestId, menuId: menuIdValue, itemId, version, dishId }) {
  const health = await healthState(guestId);
  const menu = await menuById(menuIdValue);
  if (!menu) throw new AppError(404, 'MEAL_MENU_NOT_FOUND', '餐单不存在');
  if (menu.guest_id !== guestId) throw new AppError(403, 'MEAL_MENU_FORBIDDEN', '只能查看本人的餐单');
  if (Number(menu.version) !== version) throw new AppError(409, 'MEAL_MENU_STALE_VERSION', '餐单已更新，请刷新后再替换');
  dateInStay(health, String(menu.business_date).slice(0, 10));
  const item = await db.prepare('SELECT * FROM meal_menu_items WHERE id=? AND menu_id=?').get(itemId, menu.id);
  if (!item) throw new AppError(404, 'MEAL_ITEM_NOT_FOUND', '餐位不存在');
  const dishRow = await db.prepare('SELECT * FROM dishes WHERE id=?').get(dishId);
  if (!dishRow) throw new AppError(404, 'MEAL_DISH_NOT_FOUND', '菜品不存在');
  const dish = decodeDish(dishRow);
  validateDishForSlot(dish, item, item.meal_type, health);
  const order = await db.prepare(`SELECT id,status,menu_version AS menuVersion FROM meal_orders
    WHERE guest_id=? AND business_date=? AND meal_type=?`).get(guestId, menu.business_date, item.meal_type);
  if (order && order.status !== 'reserved') {
    throw new AppError(409, 'MEAL_ORDER_IN_PROGRESS', '订单已进入备餐或送达阶段，不能在对话中静默换菜；请联系配餐员处理。', { status: order.status });
  }
  return { menuId: menu.id, businessDate: String(menu.business_date).slice(0, 10), version: Number(menu.version),
    item: { id: item.id, mealType: item.meal_type, slot: item.slot, currentDishId: item.dish_id || null },
    dish: dishSnapshot(dish), order: order ? { id: order.id, status: order.status, menuVersion: Number(order.menuVersion) } : null,
    profileVersion: Number(health.profileVersion || 0) };
}

export async function replaceMenuItem({ guestId, menuId: menuIdValue, itemId, version, dishId, reason }) {
  const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
  if (!Number.isInteger(version) || version < 1) throw new AppError(400, 'MEAL_MENU_VERSION_INVALID', '缺少有效餐单版本号');
  if (!trimmedReason || trimmedReason.length > 300) throw new AppError(400, 'MEAL_SWAP_REASON_REQUIRED', '请填写替换原因（不超过 300 字）');
  if (typeof dishId !== 'string' || !dishId) throw new AppError(400, 'MEAL_DISH_REQUIRED', '请选择替换菜品');
  return inTransaction(async () => {
    const health = await healthState(guestId, { lock: true });
    const menu = await menuById(menuIdValue, { lock: true });
    if (!menu) throw new AppError(404, 'MEAL_MENU_NOT_FOUND', '餐单不存在');
    if (menu.guest_id !== guestId) throw new AppError(403, 'MEAL_MENU_FORBIDDEN', '只能修改本人的餐单');
    if (Number(menu.version) !== version) throw new AppError(409, 'MEAL_MENU_STALE_VERSION', '餐单已更新，请刷新后再替换', { currentVersion: Number(menu.version) });
    dateInStay(health, String(menu.business_date).slice(0, 10));
    const itemRow = await db.prepare(`SELECT * FROM meal_menu_items WHERE id=? AND menu_id=?${LOCK}`).get(itemId, menu.id);
    if (!itemRow) throw new AppError(404, 'MEAL_ITEM_NOT_FOUND', '餐位不存在');
    const dishRow = await db.prepare('SELECT * FROM dishes WHERE id=?').get(dishId);
    if (!dishRow) throw new AppError(404, 'MEAL_DISH_NOT_FOUND', '菜品不存在');
    const dish = decodeDish(dishRow);
    validateDishForSlot(dish, itemRow, itemRow.meal_type, health);
    const nextVersion = version + 1;
    const stamp = now();
    await db.prepare(`UPDATE meal_menu_items SET dish_id=?,dish_snapshot_json=?,selection_reason=? WHERE id=?`)
      .run(dish.id, JSON.stringify(dishSnapshot(dish)), trimmedReason, itemId);
    const itemsAfter = await db.prepare('SELECT meal_type,slot,dish_id FROM meal_menu_items WHERE menu_id=?').all(menu.id);
    const complete = itemsAfter.length === 9 && itemsAfter.every(row => row.dish_id);
    await db.prepare(`UPDATE meal_menus SET version=?,status=?,rule_basis_json=?,avoided_items_json=?,updated_at=? WHERE id=?`)
      .run(nextVersion, complete ? 'ready' : 'incomplete', JSON.stringify(menuBasis(health)),
        JSON.stringify([...health.constraints.allergies, ...health.constraints.dietaryRestrictions]), stamp, menu.id);
    await updateReservedOrderSnapshot(menu, itemRow.meal_type, nextVersion);
    await log(guestId, 'meal.menu.swap', 'meal_menu', menu.id, `替换原因已保存；餐次=${itemRow.meal_type}；餐位=${itemRow.slot}`);
    return { ...(await getGuestMenu(guestId, String(menu.business_date).slice(0, 10))), replaced: true };
  });
}

export async function listGuestOrders(guestId, businessDate) {
  const rows = await db.prepare(`SELECT * FROM meal_orders WHERE guest_id=? AND business_date=?
    ORDER BY CASE meal_type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END`).all(guestId, businessDate);
  return rows.map(decodeOrder);
}

export async function getGuestMealOrders(guestId, businessDate) {
  if (!isDateOnly(businessDate)) throw new AppError(400, 'MEAL_DATE_INVALID', '日期必须是有效的 YYYY-MM-DD');
  dateInStay(await healthState(guestId), businessDate);
  return listGuestOrders(guestId, businessDate);
}

export async function createGuestMealOrder({ guestId, idempotencyKey, menuId: menuIdValue, businessDate, mealType, version }) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 120) {
    throw new AppError(400, 'MEAL_IDEMPOTENCY_KEY_REQUIRED', '请提供有效的订单幂等键');
  }
  if (!isDateOnly(businessDate) || !MEALS.includes(mealType) || typeof menuIdValue !== 'string' || !Number.isInteger(version) || version < 1) {
    throw new AppError(400, 'MEAL_ORDER_INPUT_INVALID', '订单日期、餐次、餐单和版本信息不完整');
  }
  const payload = { guestId, menuId: menuIdValue, businessDate, mealType, version };
  const fingerprint = hash(payload);
  return inTransaction(async () => {
    const health = await healthState(guestId, { lock: true });
    dateInStay(health, businessDate);
    const menu = await menuById(menuIdValue, { lock: true });
    if (!menu || menu.guest_id !== guestId || String(menu.business_date).slice(0, 10) !== businessDate) {
      throw new AppError(404, 'MEAL_MENU_NOT_FOUND', '没有找到本人所选日期的已保存餐单');
    }
    const priorRequest = await db.prepare(`SELECT request_fingerprint AS requestFingerprint,order_id AS orderId
      FROM meal_order_requests WHERE guest_id=? AND idempotency_key=?${LOCK}`).get(guestId, idempotencyKey);
    if (priorRequest) {
      if (priorRequest.requestFingerprint !== fingerprint) throw new AppError(409, 'MEAL_IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同订单请求');
      const order = await loadOrder(priorRequest.orderId, { lock: true });
      return { order, replayed: true };
    }
    if (Number(menu.version) !== version) throw new AppError(409, 'MEAL_MENU_STALE_VERSION', '餐单已更新，请刷新后再提交订单', { currentVersion: Number(menu.version) });
    const items = await menuItems(menu.id, { lock: true });
    const mealItems = items.filter(item => item.mealType === mealType);
    if (mealItems.length !== 3 || mealItems.some(item => !item.dish)) {
      throw new AppError(409, 'MEAL_MENU_INCOMPLETE', '该餐次餐位未全部生成，不能提交订单；请联系配餐员补足符合限制的菜品');
    }
    for (const item of mealItems) validateDishForSlot(item.dish, { slot: item.slot }, mealType, health);
    const orderDishes = mealItems.map(item => ({ ...dishSnapshot(item.dish), slot: item.slot }));
    const existing = await db.prepare(`SELECT * FROM meal_orders WHERE guest_id=? AND business_date=? AND meal_type=?${LOCK}`)
      .get(guestId, businessDate, mealType);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new AppError(409, 'MEAL_ORDER_ALREADY_EXISTS', '该日期和餐次已有订单，刷新页面查看当前状态');
      await db.prepare(`INSERT INTO meal_order_requests(guest_id,idempotency_key,request_fingerprint,order_id,created_at)
        VALUES(?,?,?,?,?)`).run(guestId, idempotencyKey, fingerprint, existing.id, now());
      return { order: decodeOrder(existing), replayed: true };
    }
    const stamp = now();
    const orderId = id('meal_order');
    const expectedHour = ({ breakfast: 8, lunch: 12, dinner: 18 })[mealType];
    const [year, month, day] = businessDate.split('-').map(Number);
    const expectedDeliveryAt = new Date(Date.UTC(year, month - 1, day, expectedHour - 8)).toISOString();
    await db.prepare(`INSERT INTO meal_orders(id,guest_id,menu_id,business_date,meal_type,menu_version,request_fingerprint,
      dishes_snapshot_json,status,created_at,expected_delivery_at,expected_time_is_demo,preparing_at,delivered_at)
      VALUES(?,?,?,?,?,?,?,?, 'reserved',?,?,1,NULL,NULL)`).run(
      orderId, guestId, menu.id, businessDate, mealType, version, fingerprint, JSON.stringify(orderDishes), stamp, expectedDeliveryAt
    );
    await db.prepare(`INSERT INTO meal_order_requests(guest_id,idempotency_key,request_fingerprint,order_id,created_at)
      VALUES(?,?,?,?,?)`).run(guestId, idempotencyKey, fingerprint, orderId, stamp);
    await log(guestId, 'meal.order.create', 'meal_order', orderId, `${businessDate} ${mealType}; UTC=${stamp}; supply not reserved`);
    return { order: await loadOrder(orderId), replayed: false };
  });
}

export async function listDietitianMealOrders(user, { businessDate, mealType }) {
  if (!isDateOnly(businessDate)) throw new AppError(400, 'MEAL_DATE_INVALID', '日期必须是有效的 YYYY-MM-DD');
  if (mealType && !MEALS.includes(mealType)) throw new AppError(400, 'MEAL_TYPE_INVALID', '餐次不正确');
  const assignedRows = await db.prepare(`SELECT DISTINCT u.id FROM users u JOIN staff_guest_assignments a ON a.guest_id=u.id
    WHERE u.role='guest' AND u.status='active' AND a.staff_id=? AND a.status='active'
      AND a.start_at<=? AND (a.end_at IS NULL OR a.end_at>?)`).all(user.id, now(), now());
  const ids = assignedRows.map(row => row.id);
  if (!ids.length) return [];
  const rows = await db.prepare(`SELECT o.*,u.name AS guest_name,g.room_no AS room_no FROM meal_orders o
    JOIN users u ON u.id=o.guest_id LEFT JOIN guest_profiles g ON g.user_id=o.guest_id
    WHERE o.business_date=? ${mealType ? 'AND o.meal_type=? ' : ''}
      AND o.guest_id IN (${ids.map(() => '?').join(',')})
    ORDER BY CASE o.meal_type WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 ELSE 3 END,u.name,o.id`).all(
    ...(mealType ? [businessDate, mealType, ...ids] : [businessDate, ...ids])
  );
  const result = [];
  for (const row of rows) {
    const health = await healthState(row.guest_id);
    result.push({
      ...decodeOrder(row), guestName: row.guest_name, roomNo: row.room_no || '',
      explicitRestrictions: [...health.constraints.allergies, ...health.constraints.dietaryRestrictions],
      reviewNotices: health.notices
    });
  }
  return result;
}

export async function updateDietitianOrderStatus({ user, orderId, status }) {
  if (!['preparing', 'delivered'].includes(status)) throw new AppError(400, 'MEAL_ORDER_STATUS_INVALID', '只能将订单推进到备餐中或已送达');
  return transaction(async () => {
    const row = await db.prepare(`SELECT * FROM meal_orders WHERE id=?${LOCK}`).get(orderId);
    if (!row) throw new AppError(404, 'MEAL_ORDER_NOT_FOUND', '餐食订单不存在');
    await authorizeGuestAccess(user, row.guest_id);
    const current = row.status;
    if (current === status) return { order: decodeOrder(row), changed: false };
    const allowed = (current === 'reserved' && status === 'preparing') || (current === 'preparing' && status === 'delivered');
    if (!allowed) throw new AppError(409, 'MEAL_ORDER_TRANSITION_INVALID', '订单只能按“已预订 → 备餐中 → 已送达”的顺序推进，不能跳步或回退', { currentStatus: current, requestedStatus: status });
    const stamp = now();
    if (status === 'preparing') await db.prepare("UPDATE meal_orders SET status='preparing',preparing_at=? WHERE id=?").run(stamp, row.id);
    else await db.prepare("UPDATE meal_orders SET status='delivered',delivered_at=? WHERE id=?").run(stamp, row.id);
    await log(user.id, 'meal.order.status', 'meal_order', row.id, `${current} -> ${status}`);
    return { order: await loadOrder(row.id), changed: true };
  });
}

export async function assertGuestCanUseMeals(user, guestId) {
  return authorizeGuestAccess(user, guestId);
}
