import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// Each Node test worker has its own database, including when called alongside regressions.
process.env.DB_DRIVER = 'sqlite';
process.env.DB_PATH = ':memory:';
process.env.DEMO_SEED = '0';
process.env.LLM_API_KEY = '';
process.env.LLM_BASE_URL = '';
process.env.AUTH_SECRET = 'synthetic-meal-recovery-tests-only';
const { app } = await import('../src/app.js');
const { db, hashPassword, now, guestProfile } = await import('../src/db.js');
const { signToken } = await import('../src/auth.js');
const { systemBusinessClock } = await import('../src/clock.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
const date = systemBusinessClock.dateKey();
const tomorrow = new Date(`${date}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 3);
const out = tomorrow.toISOString().slice(0, 10);

async function fixture(name) {
  const ids = { guest: `synthetic_${name}`, clinician: `clinician_${name}`, dietitian: `dietitian_${name}`, outsider: `outsider_${name}` };
  for (const [role, id] of Object.entries(ids)) {
    await db.prepare(`INSERT INTO users(id,username,password_hash,role,name,phone,status,job_type,created_at)
      VALUES(?,?,?,?,?,'','active',?,?)`).run(id, id, hashPassword('Synthetic-only-123'), role === 'guest' ? 'guest' : 'staff', id,
      role === 'dietitian' ? 'dietitian' : role === 'guest' ? null : 'clinician', now());
  }
  await db.prepare(`INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,stay_plan,
    emergency_contact,chronic_json,allergies_json,mobility,updated_at) VALUES(?,'','',?, ?,?,'three_night','','[]','[]','',?)`)
    .run(ids.guest, 'SYNTHETIC', date, out, now());
  for (const staff of ['clinician', 'dietitian']) await db.prepare(`INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,status,created_by,created_at,updated_at) VALUES(?,?,'2020-01-01T00:00:00.000Z','active',?,?,?)`)
    .run(ids[staff], ids.guest, ids.clinician, now(), now());
  return ids;
}
async function call(id, route, method = 'GET', body, expected = 200, key) {
  const response = await fetch(base + route, { method, headers: { Authorization: `Bearer ${signToken({ id })}`,
    'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}
async function report(ids, profile, confirm = true) {
  const state = await call(ids.guest, '/me/health-profile');
  const saved = await call(ids.guest, '/me/health-intakes', 'POST', { profile, baseProfileVersion: state.profileVersion }, 201);
  const intake = saved.pendingIntakes[0];
  if (confirm) return call(ids.clinician, `/staff/health-intakes/${intake.id}/confirm`, 'POST', { baseProfileVersion: state.profileVersion });
  return saved;
}
const field = (...items) => ({ status: items.length ? 'reported' : 'none', items });

test('F03: formal summary source, confirmed history and fresh login preserve the same fields', async () => {
  const ids = await fixture('summary');
  const result = await report(ids, { chronic: field('高血压'), allergies: field('海鲜', '空气'), dietaryRestrictions: field('鸡蛋', '海鲜') });
  assert.equal(result.profileVersion, 1);
  const guest = await call(ids.guest, '/me');
  const staff = await call(ids.clinician, `/staff/guests/${ids.guest}`);
  assert.deepEqual(guest.profile.health_profile, staff.profile.health_profile);
  assert.deepEqual((await guestProfile(ids.guest)).health_profile.allergies.items, ['海鲜', '空气']);
  const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ids.guest, password: 'Synthetic-only-123', role: 'guest' }) });
  assert.equal(login.status, 200);
  const fresh = await call(ids.guest, '/me/health-profile');
  assert.equal(fresh.history[0].reviewedBy, ids.clinician);
  assert.deepEqual(fresh.verifiedProfile.chronic.items, ['高血压']);
});

test('F01: unresolved mixed restrictions block, clinician classification restores safe choices without deleting original text', async () => {
  const ids = await fixture('mixed');
  await report(ids, { allergies: field('海鲜', '空气'), dietaryRestrictions: field('鸡蛋', '海鲜') });
  let menu = await call(ids.guest, '/meals/menus', 'POST', { businessDate: date }, 201);
  assert.equal(menu.items.filter(item => item.dish).length, 0);
  assert.equal(menu.items.every(item => !item.eligibleReplacements.length), true);
  const request = await call(ids.guest, '/meals/restriction-review', 'POST', {});
  assert.equal(request.review.assignedTo, ids.clinician);
  const replay = await call(ids.guest, '/meals/restriction-review', 'POST', {});
  assert.equal(replay.created, false); assert.equal(replay.review.id, request.review.id);
  const resolution = { decisions: [{ classification: 'non_food' }], note: '合成客人与负责医护明确核对：空气为环境描述，原文保留；海鲜与鸡蛋仍为食物限制。' };
  await call(ids.dietitian, `/staff/meal-restriction-reviews/${request.review.id}/resolve`, 'POST', resolution, 403);
  await call(ids.outsider, `/staff/meal-restriction-reviews/${request.review.id}/resolve`, 'POST', resolution, 403);
  await call(ids.clinician, `/staff/meal-restriction-reviews/${request.review.id}/resolve`, 'POST', { decisions: [], note: '遗漏未知项' }, 400);
  await call(ids.clinician, `/staff/meal-restriction-reviews/${request.review.id}/resolve`, 'POST', resolution);
  assert.equal((await call(ids.clinician, `/staff/meal-restriction-reviews/${request.review.id}/resolve`, 'POST', resolution)).changed, false);
  menu = await call(ids.guest, `/meals/menu?date=${date}`);
  for (let index = 0; index < 9; index++) {
    const item = menu.items[index]; assert.ok(item.eligibleReplacements.length);
    menu = await call(ids.guest, `/meals/menus/${menu.menu.id}/items/${item.id}`, 'PATCH', { version: menu.menu.version, dishId: item.eligibleReplacements[0].id, reason: '医护核对后补齐合规菜品' });
  }
  assert.equal(menu.status, 'ready');
  assert.equal(menu.items.some(item => item.currentlyRestricted), false);
  assert.deepEqual((await call(ids.guest, '/me/health-profile')).verifiedProfile.allergies.items, ['海鲜', '空气']);
  assert.equal(menu.currentRuleBasis.nonFoodRestrictions[0].value, '空气');
  assert.ok(menu.menu.ruleBasis.generatedRuleBasis.effectiveHealthConstraints.allergies.some(item => item.value === '空气'));
  assert.equal((await call(ids.guest, '/meals/restriction-review')).history[0].reviewerName, ids.clinician);
  await call(ids.guest, '/meals/orders', 'POST', { menuId: menu.menu.id, businessDate: date, mealType: 'breakfast', version: menu.menu.version }, 201, 'mixed-order');
  await report(ids, { allergies: field('海鲜', '空气', '未知粉末') });
  const stale = await call(ids.clinician, `/staff/meal-restriction-reviews/${request.review.id}/resolve`, 'POST', resolution, 409);
  assert.equal(stale.code, 'MEAL_REVIEW_STALE');
  menu = await call(ids.guest, `/meals/menu?date=${date}`);
  assert.equal(menu.items.every(item => item.currentlyRestricted), true);
});

test('F02/F11: order pauses on new restrictions, rejects actual advancement, safe replacement plus explicit review restores and is idempotent', async () => {
  const ids = await fixture('order');
  await report(ids, { allergies: field(), dietaryRestrictions: field() });
  let menu = await call(ids.guest, '/meals/menus', 'POST', { businessDate: date }, 201);
  const payload = { menuId: menu.menu.id, businessDate: date, mealType: 'breakfast', version: menu.menu.version };
  const placed = await call(ids.guest, '/meals/orders', 'POST', payload, 201, 'synthetic-order');
  const orderId = placed.order.id;
  assert.equal((await call(ids.guest, '/meals/orders', 'POST', payload, 200, 'synthetic-order')).order.id, orderId);
  const pending = await report(ids, { allergies: field('海鲜'), dietaryRestrictions: field('鸡蛋') }, false);
  let orders = await call(ids.guest, `/meals/orders?date=${date}`);
  assert.equal(orders[0].reviewRequired, true);
  let diet = await call(ids.dietitian, `/staff/meals/orders?date=${date}&mealType=breakfast`);
  assert.deepEqual(orders[0].reviewReasons, diet[0].reviewReasons);
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'preparing' }, 409);
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/review`, 'POST', { note: '未核实不能放行' }, 409);
  await call(ids.clinician, `/staff/health-intakes/${pending.pendingIntakes[0].id}/confirm`, 'POST', { baseProfileVersion: 1 });
  menu = await call(ids.guest, `/meals/menu?date=${date}`);
  assert.equal(menu.currentReviewRequired, true);
  assert.equal(menu.menu.ruleBasis.effectiveHealthConstraints.allergies.length, 0);
  assert.ok(menu.currentRuleBasis.effectiveHealthConstraints.allergies.length);
  for (const old of menu.items.filter(item => item.mealType === 'breakfast' && item.currentlyRestricted)) {
    const item = menu.items.find(item => item.id === old.id);
    menu = await call(ids.guest, `/meals/menus/${menu.menu.id}/items/${item.id}`, 'PATCH', { version: menu.menu.version, dishId: item.eligibleReplacements[0].id, reason: '新增限制后合规替换' });
  }
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'preparing' }, 409);
  assert.equal((await call(ids.dietitian, `/staff/meals/orders/${orderId}/review`, 'POST', { note: '合成配餐员核对当前海鲜/鸡蛋限制与三餐位一致' })).changed, true);
  assert.equal((await call(ids.dietitian, `/staff/meals/orders/${orderId}/review`, 'POST', { note: '重复复核' })).changed, false);
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'preparing' });
  assert.equal((await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'preparing' })).changed, false);
  const prepared = (await call(ids.guest, `/meals/orders?date=${date}`))[0];
  assert.equal(prepared.status, 'preparing'); assert.equal(prepared.reviewRequired, false);
  assert.equal(prepared.review.checkedBy, ids.dietitian);
  assert.equal(menu.menu.ruleBasis.generatedRuleBasis.effectiveHealthConstraints.allergies.length, 0);
  assert.equal(prepared.dishes.some(dish => dish.allergens.includes('egg') || dish.allergens.includes('fish')), false);
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'delivered' });
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'preparing' }, 409);
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/review`, 'POST', { note: '完成不能回退' }, 409);
  const counts = await db.prepare("SELECT action,COUNT(*) AS n FROM audit_logs WHERE target_id=? GROUP BY action").all(orderId);
  assert.equal(counts.find(row => row.action === 'meal.order.review').n, 1);
  assert.equal(counts.find(row => row.action === 'meal.order.status').n, 2);
});

test('F01: an unknown food term requires a clinician mapping and preserves the original field and decision source', async () => {
  const ids = await fixture('foodmapping');
  await report(ids, { allergies: field('不明蛋制品'), dietaryRestrictions: field() });
  const requested = await call(ids.guest, '/meals/restriction-review', 'POST', {});
  await call(ids.clinician, `/staff/meal-restriction-reviews/${requested.review.id}/resolve`, 'POST', {
    decisions: [{ classification: 'food', foodValue: '未确认食物' }], note: '不能猜测' }, 400);
  await call(ids.clinician, `/staff/meal-restriction-reviews/${requested.review.id}/resolve`, 'POST', {
    decisions: [{ classification: 'food', foodValue: '鸡蛋' }], note: '合成客人与医护按原包装明确核对为鸡蛋' });
  const menu = await call(ids.guest, '/meals/menus', 'POST', { businessDate: date }, 201);
  assert.equal(menu.items.some(item => item.currentlyRestricted), false);
  assert.equal(menu.items.some(item => item.dish?.allergens.includes('egg')), false);
  assert.equal(menu.currentRuleBasis.effectiveHealthConstraints.allergies[0].value, '鸡蛋');
  assert.equal(menu.currentRuleBasis.effectiveHealthConstraints.allergies[0].originalValue, '不明蛋制品');
  assert.equal((await call(ids.guest, '/me/health-profile')).verifiedProfile.allergies.items[0], '不明蛋制品');
});

test('F01: air-only description recovers after explicit non-food decision; absent clinician cannot create a dangling request', async () => {
  const ids = await fixture('air');
  await report(ids, { allergies: field('空气'), dietaryRestrictions: field() });
  await db.prepare("UPDATE staff_guest_assignments SET status='closed',end_at=? WHERE staff_id=? AND guest_id=?")
    .run(now(), ids.clinician, ids.guest);
  const blocked = await call(ids.guest, '/meals/restriction-review', 'POST', {}, 409);
  assert.equal(blocked.code, 'MEAL_CLINICIAN_NOT_ASSIGNED');
  await db.prepare("UPDATE staff_guest_assignments SET status='active',end_at=NULL WHERE staff_id=? AND guest_id=?")
    .run(ids.clinician, ids.guest);
  const requested = await call(ids.guest, '/meals/restriction-review', 'POST', {});
  await call(ids.clinician, `/staff/meal-restriction-reviews/${requested.review.id}/resolve`, 'POST', {
    decisions: [{ classification: 'non_food' }], note: '合成客人明确说明为空气环境相关描述，保留记录' });
  const menu = await call(ids.guest, '/meals/menus', 'POST', { businessDate: date }, 201);
  assert.equal(menu.status, 'ready');
  assert.equal(menu.currentRuleBasis.nonFoodRestrictions[0].value, '空气');
});

test('F02: restrictions added during preparing pause delivery and allow explicit replacement without reverting order state', async () => {
  const ids = await fixture('preparing');
  await report(ids, { allergies: field(), dietaryRestrictions: field() });
  let menu = await call(ids.guest, '/meals/menus', 'POST', { businessDate: date }, 201);
  const placed = await call(ids.guest, '/meals/orders', 'POST', { menuId: menu.menu.id, businessDate: date, mealType: 'breakfast', version: menu.menu.version }, 201, 'preparing-order');
  const orderId = placed.order.id;
  const started = await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'preparing' });
  await report(ids, { dietaryRestrictions: field('鸡蛋') });
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'delivered' }, 409);
  menu = await call(ids.guest, `/meals/menu?date=${date}`);
  for (const old of menu.items.filter(item => item.mealType === 'breakfast' && item.currentlyRestricted)) {
    const item = menu.items.find(item => item.id === old.id);
    menu = await call(ids.guest, `/meals/menus/${menu.menu.id}/items/${item.id}`, 'PATCH', { version: menu.menu.version, dishId: item.eligibleReplacements[0].id, reason: '备餐中出现新限制，暂停后合规更换并等待配餐员重新核对' });
  }
  const paused = (await call(ids.guest, `/meals/orders?date=${date}`))[0];
  assert.equal(paused.status, 'preparing'); assert.equal(paused.reviewRequired, true);
  assert.equal(paused.preparingAt, started.order.preparingAt);
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/review`, 'POST', { note: '配餐员在暂停后核对更换菜品及实际备餐' });
  await call(ids.dietitian, `/staff/meals/orders/${orderId}/status`, 'PATCH', { status: 'delivered' });
  const delivered = (await call(ids.guest, `/meals/orders?date=${date}`))[0];
  assert.equal(delivered.status, 'delivered'); assert.equal(delivered.reviewRequired, false);
  await report(ids, { allergies: field('花生') });
  assert.equal((await call(ids.guest, `/meals/orders?date=${date}`))[0].status, 'delivered');
  await call(ids.guest, `/meals/menus/${menu.menu.id}/items/${menu.items[0].id}`, 'PATCH', { version: menu.menu.version, dishId: menu.items[0].dish.id, reason: '完成后不可替换' }, 409);
});
