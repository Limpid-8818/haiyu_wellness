import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseQuery, login, request, withBothDatabaseApis } from './q10-helpers.js';
import { projectDirectory } from './q10-helpers.js';

const TEST_NOW = '2026-10-01T10:00:00.000Z';
const TEST_DATE = '2026-10-01';
const NEXT_DATE = '2026-10-02';
const END_DATE = '2026-10-15';
let guestCounter = 0;
let activeResourceSession = null;

async function withMealApis(callback) {
  return withBothDatabaseApis(context => callback(context), {
    env: { BUSINESS_CLOCK_NOW: TEST_NOW }, resourceSession: activeResourceSession
  });
}

async function mealRequest(context, route, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${context.baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, data };
}

function assertOk(result, status = 200, label = 'meal request') {
  assert.equal(result.status, status, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function guestLogin(context) { return assertOk(await login(context.baseUrl, 'guest'), 200, 'guest login'); }
async function staffLogin(context) { return assertOk(await login(context.baseUrl, 'staff'), 200, 'staff login'); }

async function setHealthProfile(context, guestId, profile) {
  const serialized = JSON.stringify(profile);
  const sql = context.driver === 'mysql'
    ? 'UPDATE guest_profiles SET health_profile_json=CAST(? AS JSON) WHERE user_id=?'
    : 'UPDATE guest_profiles SET health_profile_json=? WHERE user_id=?';
  await databaseQuery(context, sql, [serialized, guestId], 'run');
}

function emptyHealthProfile() {
  return {
    chronic: { status: 'unanswered', items: [] },
    medications: { status: 'unanswered', items: [] },
    allergies: { status: 'unanswered', items: [] },
    dietaryRestrictions: { status: 'unanswered', items: [] },
    mobility: { status: 'unanswered', details: '' },
    sleep: { status: 'unanswered', details: '' },
    skin: { status: 'unanswered', details: '' },
    audienceTags: { status: 'unanswered', items: [] }
  };
}

async function submitHealthIntake(context, token, profile) {
  const state = await request(context.baseUrl, '/me/health-profile', { token });
  assert.equal(state.status, 200, JSON.stringify(state.data));
  const result = await request(context.baseUrl, '/me/health-intakes', {
    method: 'POST', token, body: { profile, baseProfileVersion: state.data.profileVersion }
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  return result.data.intake;
}

function containsSeafood(dish) {
  const seafood = new Set(['fish', 'shrimp', 'seafood', '鱼肉', '鱼', '虾仁', '虾', '海鲜']);
  return [...(dish?.allergens || []), ...(dish?.ingredients || [])]
    .some(value => seafood.has(String(value).trim().toLocaleLowerCase()));
}

async function createUnassignedGuest(context, name = 'Q16 合成客人') {
  guestCounter += 1;
  const phone = `139${String(70000000 + guestCounter).slice(-8)}`;
  const result = await request(context.baseUrl, '/auth/register', {
    method: 'POST', body: { name, phone, password: 'q16-guest-pass-2026', confirmPassword: 'q16-guest-pass-2026' }
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const checkIn = context.driver === 'mysql' ? 'check_in_date' : 'check_in';
  const checkOut = context.driver === 'mysql' ? 'check_out_date' : 'check_out';
  await databaseQuery(context, `UPDATE guest_profiles SET ${checkIn}=?,${checkOut}=? WHERE user_id=?`,
    [TEST_DATE, END_DATE, result.data.user.id], 'run');
  return { id: result.data.user.id, token: result.data.token };
}

async function generate(context, token, businessDate = TEST_DATE) {
  return assertOk(await request(context.baseUrl, '/meals/menus', {
    method: 'POST', token, body: { businessDate }
  }), 201, 'generate meal menu');
}

async function latestMenu(context, token, businessDate = TEST_DATE) {
  return assertOk(await request(context.baseUrl, `/meals/menu?date=${businessDate}`, { token }), 200, 'get meal menu');
}

async function createOrder(context, token, menu, mealType, key) {
  return mealRequest(context, '/meals/orders', {
    method: 'POST', token,
    headers: { 'Idempotency-Key': key },
    body: { menuId: menu.menu.id, businessDate: menu.businessDate, mealType, version: menu.menu.version }
  });
}

async function q161() {
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    const catalog = assertOk(await request(context.baseUrl, '/meals/dishes', { token: guest.token }));
    assert.ok(catalog.items.length >= 12);
    for (const dish of catalog.items) {
      assert.ok(dish.id && dish.ingredients.length && Array.isArray(dish.allergens));
      assert.ok(dish.mealTypes.length && dish.nutritionLabels.length && dish.sourceReference);
      assert.ok(dish.supplyStatus && dish.isDemo);
      assert.ok(dish.nutritionLabels.some(label => /演示|检测/.test(label)));
    }
    const shrimp = catalog.items.find(dish => dish.id === 'dish-shrimp-noodles');
    assert.ok(shrimp.nonSeafoodAlternative?.id === 'dish-chicken-rice');
    assert.ok(shrimp.allergens.includes('shrimp'));
  });
  return { output: ['dish catalog returns ingredients, explicit allergens, meal types, slot, demo nutrition labels, sources and demo supply status', 'shrimp noodles carry a stable non-seafood chicken alternative; no allergy is inferred from a dish name'] };
}

async function q162() {
  await withMealApis(async context => {
    const allergicGuest = await guestLogin(context);
    const first = await generate(context, allergicGuest.token, TEST_DATE);
    const firstMenu = await latestMenu(context, allergicGuest.token, TEST_DATE);
    const selected = firstMenu.items.filter(item => item.dish).map(item => JSON.stringify(item.dish));
    assert.ok(selected.every(item => !item.includes('虾') && !item.includes('shrimp')));
    assert.ok(firstMenu.currentRuleBasis.notices.some(item => item.code === 'ALLERGY_REVIEW_PENDING'));
    assert.ok(firstMenu.menu.avoidedItems.some(item => item.value === '虾' && item.source === 'legacy-profile'));

    const preferenceGuest = await createUnassignedGuest(context, 'Q16 偏好客人');
    let noPreference = await generate(context, preferenceGuest.token, TEST_DATE);
    noPreference = await latestMenu(context, preferenceGuest.token, TEST_DATE);
    const breakfastBefore = noPreference.items.find(item => item.mealType === 'breakfast' && item.slot === 'main').dish.id;
    assert.equal(breakfastBefore, 'dish-chicken-rice');
    await setHealthProfile(context, preferenceGuest.id, {
      audienceTags: { status: 'reported', items: ['清淡口味'] }
    });
    const withPreference = await generate(context, preferenceGuest.token, NEXT_DATE);
    const breakfastAfter = withPreference.items.find(item => item.mealType === 'breakfast' && item.slot === 'main').dish.id;
    assert.equal(breakfastAfter, 'dish-egg-custard');
    assert.ok(withPreference.menu.ruleBasis.audiencePreferences.some(item => item.value === '清淡口味'));

    const vegetarianGuest = await createUnassignedGuest(context, 'Q16 素食客人');
    const vegetarianProfile = emptyHealthProfile();
    vegetarianProfile.dietaryRestrictions = { status: 'reported', items: ['素食'] };
    await setHealthProfile(context, vegetarianGuest.id, vegetarianProfile);
    const vegetarianMenu = await generate(context, vegetarianGuest.token, NEXT_DATE);
    assert.equal(vegetarianMenu.status, 'ready');
    assert.equal(vegetarianMenu.items.length, 9);
    assert.ok(vegetarianMenu.items.every(item => item.dish), 'explicit vegetarian candidates should fill all nine slots');
    assert.ok(vegetarianMenu.items.every(item => item.dish.dietaryTags.some(tag => ['素食', '纯素'].includes(tag))));
    assert.ok(vegetarianMenu.items.every(item => !containsSeafood(item.dish)
      && !item.dish.ingredients.includes('鸡肉')));

    for (const [restriction, guestName] of [['纯素', 'Q16 纯素客人'], ['清真', 'Q16 清真客人']]) {
      const guest = await createUnassignedGuest(context, guestName);
      const profile = emptyHealthProfile();
      profile.dietaryRestrictions = { status: 'reported', items: [restriction] };
      await setHealthProfile(context, guest.id, profile);
      const menu = await generate(context, guest.token, NEXT_DATE);
      assert.equal(menu.status, 'incomplete', `${restriction} must fail closed without an explicit compatible tag`);
      assert.ok(menu.items.every(item => item.dish === null));
      assert.ok(menu.items.some(item => item.selectionReason.includes(`“${restriction}”`)));
    }

    await databaseQuery(context, "UPDATE dishes SET supply_status='unavailable' WHERE slot='main'", [], 'run');
    try {
      const underfilled = await generate(context, preferenceGuest.token, '2026-10-03');
      assert.equal(underfilled.status, 'incomplete');
      const missingMain = underfilled.items.find(item => item.mealType === 'breakfast' && item.slot === 'main');
      assert.equal(missingMain.dish, null);
      assert.match(missingMain.selectionReason, /没有标记为演示可供/);
      assert.match(missingMain.selectionReason, /未放入替代或禁忌菜品/);
    } finally {
      await databaseQuery(context, "UPDATE dishes SET supply_status='demo_available' WHERE slot='main'", [], 'run');
    }
    assert.equal(first.status, 'ready');
  });
  return { output: ['legacy shrimp allergy is preserved and shrimp candidates are filtered while an explicit pending review notice remains visible', 'audience preference follows hard filters; vegetarian tags satisfy an explicit vegetarian requirement; unsupported vegan/halal tags fail closed; unavailable candidates have a concrete shortage reason'] };
}

async function q163() {
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    const before = await request(context.baseUrl, `/meals/menu?date=${TEST_DATE}`, { token: guest.token });
    assert.equal(before.data.status, 'needs_generation');
    const generated = await generate(context, guest.token);
    assert.equal(generated.menu.version, 1);
    assert.equal(generated.items.length, 9);
    assert.deepEqual(new Set(generated.items.map(item => item.mealType)), new Set(['breakfast', 'lunch', 'dinner']));
    assert.deepEqual(new Set(generated.items.map(item => item.slot)), new Set(['main', 'side', 'soup']));
    assert.ok(generated.items.every(item => item.dish?.nutritionLabels?.length || item.selectionReason));
    assert.ok(generated.menu.ruleBasis.effectiveHealthConstraints.allergies.some(item => item.value === '虾'));
    const repeated = await request(context.baseUrl, '/meals/menus', { method: 'POST', token: guest.token, body: { businessDate: TEST_DATE } });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.data.menu.id, generated.menu.id);
    assert.equal(repeated.data.menu.version, 1);
  });
  return { output: ['date menu persists breakfast/lunch/dinner and main/side/soup with source basis, avoided restrictions and version 1', 'repeating generation reads the same saved menu without duplicating or reserving supply'] };
}

async function q164() {
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    const absent = await request(context.baseUrl, `/meals/menu?date=${NEXT_DATE}`, { token: guest.token });
    assert.equal(absent.status, 200);
    assert.equal(absent.data.status, 'needs_generation');
    assert.equal(absent.data.menu, null);
    const source = await readFile(path.join(projectDirectory, 'web/src/main.jsx'), 'utf8');
    for (const fragment of ['function GuestMeals', 'type="date"', '此日期暂无已保存餐单', 'needs_generation', 'MEAL_LABELS']) {
      assert.ok(source.includes(fragment), `guest menu UI contract missing ${fragment}`);
    }
  });
  return { output: ['menu API returns an explicit needs_generation state for a date with no stored menu', 'guest page renders a Shanghai date picker and separate no-data state instead of copying another day'] };
}

async function replace(context, guestToken, menu, item, dishId, reason = 'Q16 测试口味调整') {
  return request(context.baseUrl, `/meals/menus/${menu.menu.id}/items/${item.id}`, {
    method: 'PATCH', token: guestToken,
    body: { version: menu.menu.version, dishId, reason }
  });
}

async function q165() {
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    await generate(context, guest.token);
    let menu = await latestMenu(context, guest.token);
    let item = menu.items.find(row => row.mealType === 'lunch' && row.slot === 'main');
    const created = await createOrder(context, guest.token, menu, 'lunch', 'q16-swap-order');
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const orderId = created.data.order.id;
    const preservedIds = menu.items.filter(row => row.id !== item.id).map(row => [row.id, row.dish?.id || null]);

    const fish = await replace(context, guest.token, menu, item, 'dish-fish-rice');
    assert.equal(fish.status, 200, JSON.stringify(fish.data));
    assert.equal(fish.data.menu.version, 2);
    const chickenItem = fish.data.items.find(row => row.id === item.id);
    const chicken = await replace(context, guest.token, fish.data, chickenItem, 'dish-chicken-rice', '客人更喜欢鸡肉');
    assert.equal(chicken.status, 200, JSON.stringify(chicken.data));
    assert.equal(chicken.data.menu.version, 3);
    assert.equal(chicken.data.items.find(row => row.id === item.id).dish.id, 'dish-chicken-rice');
    assert.deepEqual(chicken.data.items.filter(row => row.id !== item.id).map(row => [row.id, row.dish?.id || null]), preservedIds);
    const order = await request(context.baseUrl, `/meals/orders?date=${TEST_DATE}`, { token: guest.token });
    assert.equal(order.data.find(row => row.id === orderId).dishes.find(dish => dish.slot === 'main').dishId, 'dish-chicken-rice');

    const shrimpItem = chicken.data.items.find(row => row.id === item.id);
    const rejected = await replace(context, guest.token, chicken.data, shrimpItem, 'dish-shrimp-noodles');
    assert.equal(rejected.status, 409);
    assert.equal(rejected.data.code, 'MEAL_DISH_RESTRICTED');
    const stale = await request(context.baseUrl, `/meals/menus/${menu.menu.id}/items/${item.id}`, {
      method: 'PATCH', token: guest.token,
      body: { version: 1, dishId: 'dish-egg-custard', reason: '旧版本' }
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'MEAL_MENU_STALE_VERSION');
    const unchangedOrderCount = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM meal_orders WHERE id=?', [orderId], 'get')).count);
    assert.equal(unchangedOrderCount, 1);

    const seafoodGuest = await createUnassignedGuest(context, 'Q16 海鲜忌口客人');
    const seafoodProfile = emptyHealthProfile();
    seafoodProfile.dietaryRestrictions = { status: 'reported', items: ['海鲜'] };
    await setHealthProfile(context, seafoodGuest.id, seafoodProfile);
    let seafoodMenu = await generate(context, seafoodGuest.token, NEXT_DATE);
    assert.equal(seafoodMenu.status, 'ready');
    assert.ok(seafoodMenu.items.every(row => row.dish && !containsSeafood(row.dish)),
      'formal seafood restriction must filter explicit fish and shrimp ingredients/allergens');
    const seafoodOrderResult = await createOrder(context, seafoodGuest.token, seafoodMenu, 'dinner', 'q16-seafood-order');
    assert.equal(seafoodOrderResult.status, 201, JSON.stringify(seafoodOrderResult.data));
    const seafoodOrder = seafoodOrderResult.data.order;
    const dinnerMain = seafoodMenu.items.find(row => row.mealType === 'dinner' && row.slot === 'main');
    const shrimpBreakfast = seafoodMenu.items.find(row => row.mealType === 'breakfast' && row.slot === 'main');
    const originalVersion = seafoodMenu.menu.version;
    const originalDinnerDish = dinnerMain.dish.id;
    const originalOrderDishes = seafoodOrder.dishes;
    const deniedFish = await replace(context, seafoodGuest.token, seafoodMenu, dinnerMain, 'dish-fish-rice');
    assert.equal(deniedFish.status, 409);
    assert.equal(deniedFish.data.code, 'MEAL_DISH_RESTRICTED');
    const afterFish = await replace(context, seafoodGuest.token, seafoodMenu, shrimpBreakfast, 'dish-shrimp-noodles');
    assert.equal(afterFish.status, 409);
    assert.equal(afterFish.data.code, 'MEAL_DISH_RESTRICTED');
    seafoodMenu = await latestMenu(context, seafoodGuest.token, NEXT_DATE);
    assert.equal(seafoodMenu.menu.version, originalVersion);
    assert.equal(seafoodMenu.items.find(row => row.id === dinnerMain.id).dish.id, originalDinnerDish);
    const seafoodOrders = await request(context.baseUrl, `/meals/orders?date=${NEXT_DATE}`, { token: seafoodGuest.token });
    const unchangedSeafoodOrder = seafoodOrders.data.find(row => row.id === seafoodOrder.id);
    assert.deepEqual(unchangedSeafoodOrder.dishes, originalOrderDishes);
  });
  return { output: ['fish→chicken changes only the target slot and increments menu version; reserved lunch order snapshot updates in the same transaction', 'shrimp allergy, formal seafood restriction, direct fish/shrimp replacements, and stale menu version are rejected without changing saved menu or order snapshots'] };
}

async function q166() {
  const source = await readFile(path.join(projectDirectory, 'web/src/main.jsx'), 'utf8');
  for (const fragment of ['function GuestMeals', '替换原因', 'window.confirm', '确认替换', '请联系配餐员', 'Idempotency-Key']) {
    assert.ok(source.includes(fragment), `guest swap/order UI contract missing ${fragment}`);
  }
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    await generate(context, guest.token);
    const menu = await latestMenu(context, guest.token);
    const item = menu.items.find(row => row.mealType === 'dinner' && row.slot === 'main');
    const noReason = await request(context.baseUrl, `/meals/menus/${menu.menu.id}/items/${item.id}`, {
      method: 'PATCH', token: guest.token, body: { version: menu.menu.version, dishId: 'dish-chicken-rice', reason: '' }
    });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.data.code, 'MEAL_SWAP_REASON_REQUIRED');
  });
  return { output: ['guest swap form requires a reason and a separate confirmation before sending; current unsafe choices are absent from its server-provided replacement list', 'the guest UI displays contact-dietitian guidance when an order is in preparation'] };
}

async function q167() {
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    await generate(context, guest.token);
    const menu = await latestMenu(context, guest.token);
    const sameKey = await createOrder(context, guest.token, menu, 'breakfast', 'q16-idempotent-key');
    assert.equal(sameKey.status, 201, JSON.stringify(sameKey.data));
    const replay = await createOrder(context, guest.token, menu, 'breakfast', 'q16-idempotent-key');
    assert.equal(replay.status, 200);
    assert.equal(replay.data.order.id, sameKey.data.order.id);
    assert.equal(replay.data.replayed, true);
    const reused = await mealRequest(context, '/meals/orders', {
      method: 'POST', token: guest.token, headers: { 'Idempotency-Key': 'q16-idempotent-key' },
      body: { menuId: menu.menu.id, businessDate: TEST_DATE, mealType: 'lunch', version: menu.menu.version }
    });
    assert.equal(reused.status, 409);
    assert.equal(reused.data.code, 'MEAL_IDEMPOTENCY_CONFLICT');

    const race = await Promise.all([
      createOrder(context, guest.token, menu, 'dinner', 'q16-race-key-a'),
      createOrder(context, guest.token, menu, 'dinner', 'q16-race-key-b')
    ]);
    assert.deepEqual(race.map(result => result.status).sort(), [200, 201]);
    assert.equal(race[0].data.order.id, race[1].data.order.id);
    const dinnerRows = await databaseQuery(context,
      'SELECT id FROM meal_orders WHERE guest_id=? AND business_date=? AND meal_type=?', [guest.user.id, TEST_DATE, 'dinner']);
    assert.equal(dinnerRows.length, 1);
    const uniqueRows = await databaseQuery(context,
      'SELECT COUNT(*) AS count FROM meal_orders WHERE guest_id=? AND business_date=? AND meal_type=?', [guest.user.id, TEST_DATE, 'breakfast'], 'get');
    assert.equal(Number(uniqueRows.count), 1);

    const pendingGuest = await createUnassignedGuest(context, 'Q16 待核实海鲜客人');
    let pendingMenu = await generate(context, pendingGuest.token, NEXT_DATE);
    const lunchMain = pendingMenu.items.find(item => item.mealType === 'lunch' && item.slot === 'main');
    const fishSelection = await replace(context, pendingGuest.token, pendingMenu, lunchMain, 'dish-fish-rice');
    assert.equal(fishSelection.status, 200, JSON.stringify(fishSelection.data));
    pendingMenu = fishSelection.data;
    const pendingProfile = emptyHealthProfile();
    pendingProfile.dietaryRestrictions = { status: 'reported', items: ['海鲜'] };
    const intake = await submitHealthIntake(context, pendingGuest.token, pendingProfile);
    const refreshedMenu = await latestMenu(context, pendingGuest.token, NEXT_DATE);
    const pendingSeafood = refreshedMenu.currentRuleBasis.effectiveHealthConstraints.dietaryRestrictions
      .find(item => item.value === '海鲜' && item.status === 'pending');
    assert.equal(pendingSeafood.source, 'form');
    assert.equal(pendingSeafood.sourceId, intake.id);
    const deniedOrder = await createOrder(context, pendingGuest.token, refreshedMenu, 'lunch', 'q16-pending-seafood-denied');
    assert.equal(deniedOrder.status, 409);
    assert.equal(deniedOrder.data.code, 'MEAL_DISH_RESTRICTED');
    assert.equal(deniedOrder.data.details.sourceId, intake.id);
    const residualOrders = await databaseQuery(context,
      'SELECT id FROM meal_orders WHERE guest_id=? AND business_date=? AND meal_type=?',
      [pendingGuest.id, NEXT_DATE, 'lunch'], 'all');
    const residualKeys = await databaseQuery(context,
      'SELECT idempotency_key FROM meal_order_requests WHERE guest_id=? AND idempotency_key=?',
      [pendingGuest.id, 'q16-pending-seafood-denied'], 'all');
    assert.equal(residualOrders.length, 0, 'rejected pending-restriction order must not leave an order row');
    assert.equal(residualKeys.length, 0, 'rejected pending-restriction order must not leave an idempotency row');
  });
  return { output: ['same idempotency key and payload returns the same order; changed payload with that key returns 409', 'two concurrent different keys create one order; a newly submitted pending seafood restriction carries its intake source ID and blocks a pre-existing fish menu snapshot with no order/request rows'] };
}

async function q168() {
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    await generate(context, guest.token);
    const menu = await latestMenu(context, guest.token);
    const created = await createOrder(context, guest.token, menu, 'dinner', 'q16-dinner-display');
    assert.equal(created.status, 201);
    const order = created.data.order;
    assert.match(order.orderNo, /^meal_order_/);
    assert.equal(order.businessDate, TEST_DATE);
    assert.equal(order.status, 'reserved');
    assert.equal(order.expectedTimeIsDemo, true);
    assert.ok(Number.isFinite(Date.parse(order.expectedDeliveryAt)));
    assert.equal(order.expectedDeliveryAt, '2026-10-01T10:00:00.000Z');
    assert.deepEqual(new Set(order.dishes.map(dish => dish.slot)), new Set(['main', 'side', 'soup']));
    const afterRefresh = await request(context.baseUrl, `/meals/orders?date=${TEST_DATE}`, { token: guest.token });
    assert.equal(afterRefresh.data[0].id, order.id);
    assert.equal(JSON.stringify(afterRefresh.data[0].dishes), JSON.stringify(order.dishes));
    assert.match(afterRefresh.data[0].expectedDeliveryNote, /演示估算/);
  });
  return { output: ['guest order result persists the order number, business date, dishes, reserved status, UTC created time and UTC demo-estimate delivery time', 'refresh returns the same order ID and frozen dish snapshot; delivery estimate is explicitly marked as demo'] };
}

async function q169() {
  const pageSource = await readFile(path.join(projectDirectory, 'web/src/main.jsx'), 'utf8');
  for (const fragment of ['function mealSourceLabel', 'function mealLocalTime', "timeZone: 'Asia/Shanghai'", 'mealFoodLabels', '来源状态']) {
    assert.ok(pageSource.includes(fragment), `dietitian display contract missing ${fragment}`);
  }
  assert.ok(!pageSource.includes('UTC {order.createdAt}'), 'raw UTC timestamps must not appear in the workbench');
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    const staff = await staffLogin(context);
    const deniedBeforeRoleChange = await request(context.baseUrl, `/staff/meals/orders?date=${TEST_DATE}&mealType=dinner`, { token: staff.token });
    assert.equal(deniedBeforeRoleChange.status, 403);
    await databaseQuery(context, "UPDATE users SET job_type='dietitian' WHERE id='staff_001'", [], 'run');
    await generate(context, guest.token);
    const menu = await latestMenu(context, guest.token);
    const guestOrder = await createOrder(context, guest.token, menu, 'dinner', 'q16-assigned-order');
    assert.equal(guestOrder.status, 201);

    const outsider = await createUnassignedGuest(context, 'Q16 未分配客人');
    await generate(context, outsider.token);
    const outsideMenu = await latestMenu(context, outsider.token);
    const outsideOrder = await createOrder(context, outsider.token, outsideMenu, 'dinner', 'q16-unassigned-order');
    assert.equal(outsideOrder.status, 201);

    const board = await request(context.baseUrl, `/staff/meals/orders?date=${TEST_DATE}&mealType=dinner`, { token: staff.token });
    assert.equal(board.status, 200, JSON.stringify(board.data));
    assert.equal(board.data.length, 1);
    assert.equal(board.data[0].id, guestOrder.data.order.id);
    assert.equal(board.data[0].orderNo, guestOrder.data.order.orderNo);
    assert.ok(board.data[0].guestName && board.data[0].roomNo);
    assert.equal(board.data[0].dishes.length, 3);
    assert.ok(board.data[0].explicitRestrictions.some(item => item.value === '虾'));
    for (const forbidden of ['profile', 'medications', 'chronic', 'healthProfile']) assert.equal(Object.hasOwn(board.data[0], forbidden), false);
    await databaseQuery(context, "UPDATE staff_guest_assignments SET status='closed' WHERE staff_id='staff_001' AND guest_id='guest_001'", [], 'run');
    const revokedBoard = await request(context.baseUrl, `/staff/meals/orders?date=${TEST_DATE}&mealType=dinner`, { token: staff.token });
    assert.equal(revokedBoard.data.length, 0);
  });
  return { output: ['non-dietitian role is denied; dietitian board exposes date/meal/guest/room/dishes and explicit restrictions only', 'orders for an unassigned guest are omitted, and ending the active assignment immediately removes the guest from the board'] };
}

async function waitForMealLockWait(context, blockerConnectionId, tableName, expectedCount = 1, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let waiting = 0;
  while (Date.now() < deadline) {
    const row = await databaseQuery(context, `SELECT COUNT(*) AS waiting
      FROM performance_schema.data_lock_waits AS waits
      JOIN performance_schema.threads AS blocker ON blocker.THREAD_ID=waits.BLOCKING_THREAD_ID
      JOIN performance_schema.data_locks AS requested ON requested.ENGINE_LOCK_ID=waits.REQUESTING_ENGINE_LOCK_ID
      WHERE blocker.PROCESSLIST_ID=? AND requested.OBJECT_NAME=?`, [blockerConnectionId, tableName], 'get');
    waiting = Number(row?.waiting || 0);
    if (waiting >= expectedCount) return waiting;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`meal requests did not reach the held ${tableName} row lock; expected ${expectedCount} wait(s), observed ${waiting}`);
}

async function createMealRaceFixture(context, guestToken, date, key) {
  await generate(context, guestToken, date);
  const menu = await latestMenu(context, guestToken, date);
  const item = menu.items.find(row => row.mealType === 'breakfast' && row.slot === 'main');
  assert.ok(item?.dish && item.eligibleReplacements.length, 'race fixture needs a replaceable breakfast main');
  const orderResult = await createOrder(context, guestToken, menu, 'breakfast', key);
  assert.equal(orderResult.status, 201, JSON.stringify(orderResult.data));
  return { menu, item, replacement: item.eligibleReplacements[0], order: orderResult.data.order };
}

async function advanceToPreparing(context, token, orderId) {
  return request(context.baseUrl, `/staff/meals/orders/${orderId}/status`, {
    method: 'PATCH', token, body: { status: 'preparing' }
  });
}

async function verifyRaceState(context, guestToken, fixture, swapResult, preparingResult) {
  assert.equal(preparingResult.status, 200, JSON.stringify(preparingResult.data));
  assert.equal(preparingResult.data.order.status, 'preparing');
  const menu = await latestMenu(context, guestToken, fixture.menu.businessDate);
  const orderRows = await request(context.baseUrl, `/meals/orders?date=${fixture.menu.businessDate}`, { token: guestToken });
  assert.equal(orderRows.status, 200);
  const order = orderRows.data.find(row => row.id === fixture.order.id);
  assert.ok(order);
  assert.equal(order.status, 'preparing');
  if (swapResult.status === 200) {
    const changedItem = menu.items.find(row => row.id === fixture.item.id);
    assert.equal(changedItem.dish.id, fixture.replacement.id);
    assert.equal(menu.menu.version, fixture.menu.menu.version + 1);
    assert.equal(order.menuVersion, menu.menu.version);
    assert.equal(order.dishes.find(dish => dish.slot === fixture.item.slot).dishId, fixture.replacement.id);
  } else {
    assert.equal(swapResult.status, 409, JSON.stringify(swapResult.data));
    assert.equal(swapResult.data.code, 'MEAL_ORDER_IN_PROGRESS');
    const unchangedItem = menu.items.find(row => row.id === fixture.item.id);
    assert.equal(unchangedItem.dish.id, fixture.item.dish.id);
    assert.equal(menu.menu.version, fixture.menu.menu.version);
    assert.equal(order.menuVersion, fixture.order.menuVersion);
    assert.deepEqual(order.dishes, fixture.order.dishes);
  }
  const counts = await databaseQuery(context, `SELECT
      (SELECT COUNT(*) FROM meal_orders WHERE id=?) AS orders,
      (SELECT COUNT(*) FROM meal_menu_items WHERE id=?) AS menu_items`,
  [fixture.order.id, fixture.item.id], 'get');
  assert.equal(Number(counts.orders), 1);
  assert.equal(Number(counts.menu_items), 1);
  return { menu, order };
}

async function racePreparingWinsWithMysqlBarrier(context, guestToken, staffToken) {
  const fixture = await createMealRaceFixture(context, guestToken, NEXT_DATE, 'q16-race-preparing-wins');
  const locker = await context.pool.getConnection();
  let inTransaction = false;
  let swapPromise;
  try {
    const [[isolation]] = await locker.query('SELECT @@transaction_isolation AS value');
    assert.equal(String(isolation.value).toLowerCase(), 'repeatable-read');
    await locker.beginTransaction();
    inTransaction = true;
    const [[connection]] = await locker.query('SELECT CONNECTION_ID() AS connectionId');
    await locker.execute('SELECT user_id FROM guest_profiles WHERE user_id=? FOR UPDATE', [fixture.order.guestId]);

    let swapSettled = false;
    swapPromise = replace(context, guestToken, fixture.menu, fixture.item, fixture.replacement.id, '并发备餐前提交测试')
      .then(result => { swapSettled = true; return result; });
    await waitForMealLockWait(context, connection.connectionId, 'guest_profiles');
    const preparing = await advanceToPreparing(context, staffToken, fixture.order.id);
    assert.equal(preparing.status, 200, JSON.stringify(preparing.data));
    assert.equal(swapSettled, false, 'replacement must remain blocked on the held health-profile row');
    await locker.commit();
    inTransaction = false;

    const deniedSwap = await swapPromise;
    const final = await verifyRaceState(context, guestToken, fixture, deniedSwap, preparing);
    assert.equal(deniedSwap.status, 409);
    assert.equal(deniedSwap.data.code, 'MEAL_ORDER_IN_PROGRESS');
    assert.deepEqual(final.order.dishes, fixture.order.dishes);
  } finally {
    if (inTransaction) await locker.rollback();
    locker.release();
    if (swapPromise) await swapPromise.catch(() => {});
  }
}

async function raceSwapWinsWithMysqlBarrier(context, guestToken, staffToken) {
  const fixture = await createMealRaceFixture(context, guestToken, '2026-10-03', 'q16-race-swap-wins');
  const locker = await context.pool.getConnection();
  let inTransaction = false;
  let swapPromise;
  let preparingPromise;
  try {
    const [[isolation]] = await locker.query('SELECT @@transaction_isolation AS value');
    assert.equal(String(isolation.value).toLowerCase(), 'repeatable-read');
    await locker.beginTransaction();
    inTransaction = true;
    const [[connection]] = await locker.query('SELECT CONNECTION_ID() AS connectionId');
    await locker.execute('SELECT id FROM meal_orders WHERE id=? FOR UPDATE', [fixture.order.id]);

    let swapSettled = false;
    let preparingSettled = false;
    swapPromise = replace(context, guestToken, fixture.menu, fixture.item, fixture.replacement.id, '并发换菜先提交测试')
      .then(result => { swapSettled = true; return result; });
    await waitForMealLockWait(context, connection.connectionId, 'meal_orders');
    preparingPromise = advanceToPreparing(context, staffToken, fixture.order.id)
      .then(result => { preparingSettled = true; return result; });
    await waitForMealLockWait(context, connection.connectionId, 'meal_orders', 2);
    assert.equal(swapSettled, false);
    assert.equal(preparingSettled, false);
    await locker.commit();
    inTransaction = false;

    const [swapped, preparing] = await Promise.all([swapPromise, preparingPromise]);
    assert.equal(swapped.status, 200, JSON.stringify(swapped.data));
    assert.equal(preparing.status, 200, JSON.stringify(preparing.data));
    const final = await verifyRaceState(context, guestToken, fixture, swapped, preparing);
    assert.equal(final.menu.menu.version, fixture.menu.menu.version + 1);
    assert.equal(final.order.dishes.find(dish => dish.slot === fixture.item.slot).dishId, fixture.replacement.id);
  } finally {
    if (inTransaction) await locker.rollback();
    locker.release();
    if (swapPromise) await swapPromise.catch(() => {});
    if (preparingPromise) await preparingPromise.catch(() => {});
  }
}

async function raceSwapAndPreparingOnSqlite(context, guestToken, staffToken) {
  const fixture = await createMealRaceFixture(context, guestToken, '2026-10-03', 'q16-sqlite-race');
  const [swap, preparing] = await Promise.all([
    replace(context, guestToken, fixture.menu, fixture.item, fixture.replacement.id, 'SQLite并发锁序测试'),
    advanceToPreparing(context, staffToken, fixture.order.id)
  ]);
  assert.ok([200, 409].includes(swap.status), JSON.stringify(swap.data));
  if (swap.status === 409) assert.equal(swap.data.code, 'MEAL_ORDER_IN_PROGRESS');
  const final = await verifyRaceState(context, guestToken, fixture, swap, preparing);
  assert.ok(final.menu.menu.version === fixture.menu.menu.version
    || final.menu.menu.version === fixture.menu.menu.version + 1);
}

async function q1610() {
  await withMealApis(async context => {
    const guest = await guestLogin(context);
    const staff = await staffLogin(context);
    await databaseQuery(context, "UPDATE users SET job_type='dietitian' WHERE id='staff_001'", [], 'run');
    await generate(context, guest.token);
    let menu = await latestMenu(context, guest.token);
    const created = await createOrder(context, guest.token, menu, 'breakfast', 'q16-state-order');
    assert.equal(created.status, 201);
    const order = created.data.order;
    const badSkip = await request(context.baseUrl, `/staff/meals/orders/${order.id}/status`, {
      method: 'PATCH', token: staff.token, body: { status: 'delivered' }
    });
    assert.equal(badSkip.status, 409);
    assert.equal(badSkip.data.code, 'MEAL_ORDER_TRANSITION_INVALID');

    const preparing = await request(context.baseUrl, `/staff/meals/orders/${order.id}/status`, {
      method: 'PATCH', token: staff.token, body: { status: 'preparing' }
    });
    assert.equal(preparing.status, 200);
    const repeatedPreparing = await request(context.baseUrl, `/staff/meals/orders/${order.id}/status`, {
      method: 'PATCH', token: staff.token, body: { status: 'preparing' }
    });
    assert.equal(repeatedPreparing.data.order.status, 'preparing');
    assert.equal(repeatedPreparing.data.changed, false);
    menu = await latestMenu(context, guest.token);
    const breakfastMain = menu.items.find(item => item.mealType === 'breakfast' && item.slot === 'main');
    const replacement = breakfastMain.eligibleReplacements[0];
    const deniedSwap = await replace(context, guest.token, menu, breakfastMain, replacement.id, '准备中不应生效');
    assert.equal(deniedSwap.status, 409);
    assert.equal(deniedSwap.data.code, 'MEAL_ORDER_IN_PROGRESS');

    const guestAfterPreparing = await request(context.baseUrl, `/meals/orders?date=${TEST_DATE}`, { token: guest.token });
    assert.equal(guestAfterPreparing.data[0].status, 'preparing');
    const delivered = await request(context.baseUrl, `/staff/meals/orders/${order.id}/status`, {
      method: 'PATCH', token: staff.token, body: { status: 'delivered' }
    });
    assert.equal(delivered.data.order.status, 'delivered');
    const repeatedDelivered = await request(context.baseUrl, `/staff/meals/orders/${order.id}/status`, {
      method: 'PATCH', token: staff.token, body: { status: 'delivered' }
    });
    assert.equal(repeatedDelivered.data.changed, false);
    const backwards = await request(context.baseUrl, `/staff/meals/orders/${order.id}/status`, {
      method: 'PATCH', token: staff.token, body: { status: 'preparing' }
    });
    assert.equal(backwards.status, 409);
    assert.equal(backwards.data.code, 'MEAL_ORDER_TRANSITION_INVALID');
    const guestAfterDelivery = await request(context.baseUrl, `/meals/orders?date=${TEST_DATE}`, { token: guest.token });
    assert.equal(guestAfterDelivery.data[0].status, 'delivered');

    if (context.driver === 'mysql') {
      await racePreparingWinsWithMysqlBarrier(context, guest.token, staff.token);
      await raceSwapWinsWithMysqlBarrier(context, guest.token, staff.token);
    } else {
      await raceSwapAndPreparingOnSqlite(context, guest.token, staff.token);
    }
  });
  return { output: ['dietitian status is reserved→preparing→delivered; same-state actions are idempotent and skip/back transitions return 409', 'SQLite concurrent swap/status requests serialize without partial writes; MySQL 8 REPEATABLE-READ lock barriers prove preparing-first rejects and rolls back a waiting swap, while swap-first atomically updates the reserved order snapshot before preparing reads it'] };
}

const quests = {
  'Q16.1': q161, 'Q16.2': q162, 'Q16.3': q163, 'Q16.4': q164, 'Q16.5': q165,
  'Q16.6': q166, 'Q16.7': q167, 'Q16.8': q168, 'Q16.9': q169, 'Q16.10': q1610
};

export async function run({ questId, resourceSession }) {
  assert.ok(resourceSession, 'Stage16 acceptance requires a managed ResourceSession');
  activeResourceSession = resourceSession;
  const execute = quests[questId];
  assert.ok(execute, `unsupported Stage16 quest ${questId}`);
  return execute();
}

export { quests as stage16Quests };
