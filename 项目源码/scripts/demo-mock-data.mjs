// 演示模式 mock 数据种子脚本。
// 用法：先启动本地开发实例（默认 http://127.0.0.1:3020），再执行 npm run demo:mock。
// 幂等：已存在的账号/对象会跳过；所有写操作尽量走真实 API（校验/幂等键/审计齐全）。
// 仅两条用 SQL 直写（API 无法离线完成）：疗程草案（创建依赖模型服务）与历史心情（API 只支持当天）。
// 红线：不伪造环境安全放行（预约只用非海上项目），合成内容一律带“（演示）”标记。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const BASE = process.env.DEMO_API || 'http://127.0.0.1:3020/api';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DEMO_DB || path.join(HERE, '..', 'server', 'data', 'community-v2.sqlite');
const log = (tag, msg) => console.log(`[${tag}] ${msg}`);
const shDay = offset => new Date(Date.now() + 8 * 3600e3 + (offset || 0) * 86400e3).toISOString().slice(0, 10);

async function call(token, method, apiPath, body, expected, key) {
  const res = await fetch(BASE + apiPath, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const must = async (token, method, apiPath, body, expected, key) => {
  const r = await call(token, method, apiPath, body, expected, key);
  if (expected !== undefined && r.status !== expected) throw new Error(`${method} ${apiPath} -> ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  return r.data;
};
const login = async (username, password, role) => (await must(null, 'POST', '/auth/login', { username, password, role }, 200)).token;

// ── 0 前置检查 ──
const health = await call(null, 'GET', '/health');
if (health.status !== 200) { console.error(`本地 API 不可用（${BASE}），请先启动开发实例`); process.exit(1); }
log('env', `API=${BASE} DB=${DB_PATH}`);

const dean = await login('dean_demo', 'dean2026', 'dean');
const clinician = await login('staff_demo', 'staff2026', 'staff');

// ── 1 补齐五岗位员工（教练/理疗师/配餐员）──
const staffSeed = [
  { username: 'demo_coach', name: '刘教练（演示）', phone: '13900002001', jobType: 'coach' },
  { username: 'demo_therapist', name: '赵理疗师（演示）', phone: '13900002002', jobType: 'therapist' },
  { username: 'demo_dietitian', name: '钱配餐员（演示）', phone: '13900002003', jobType: 'dietitian' }
];
const staffIds = {};
for (const s of staffSeed) {
  const r = await call(dean, 'POST', '/dean/staff', { ...s, password: 'staff2026' });
  if (r.status === 201) log('staff', `创建 ${s.name}（${s.username}）`);
  else if (r.status === 409) log('staff', `已存在 ${s.username}，跳过`);
  else throw new Error(`创建员工失败 ${s.username}: ${JSON.stringify(r.data).slice(0, 160)}`);
  const list = await must(dean, 'GET', '/dean/staff');
  const row = (list.items || list.staff || list).find(x => x.username === s.username);
  if (row) staffIds[s.jobType] = row.id;
}
const dietitian = await login('demo_dietitian', 'staff2026', 'staff');
log('staff', `五岗位就绪：医护 staff_001 / 教练 ${staffIds.coach} / 理疗师 ${staffIds.therapist} / 配餐员 ${staffIds.dietitian}`);

// ── 2 客人B：丰富档案 ──
const B_PHONE = '13900001002';
let guestB = (await call(null, 'POST', '/auth/register', { phone: B_PHONE, password: 'Guest-2026!x', confirmPassword: 'Guest-2026!x', name: '顾斌（演示）' })).status;
if (guestB === 201) log('guestB', '注册 顾斌（演示）');
else if (guestB === 409) log('guestB', '已存在，复用');
else throw new Error('客人B注册失败');
const tokenB = await login(B_PHONE, 'Guest-2026!x', 'guest');
const meB = await must(tokenB, 'GET', '/me');
const idB = meB.user ? meB.user.id : meB.id;

// 入住（昨天起 7 晚，10 晚类别）+ 三岗分工
const stayR = await call(dean, 'PATCH', `/dean/guests/${idB}/stay`, { roomNo: 'B-102', checkIn: shDay(-1), checkOut: shDay(7), stayPlan: 'ten_night' });
log('guestB', `入住 ${stayR.status === 200 ? 'OK' : stayR.status + ' ' + JSON.stringify(stayR.data).slice(0, 80)} ${shDay(-1)} 至 ${shDay(7)}`);
for (const sid of [staffIds.coach, staffIds.dietitian]) {
  const a = await call(dean, 'POST', `/dean/guests/${idB}/assignments`, { staffId: sid });
  if (a.status === 201) log('guestB', `分工 ${sid}`);
}
const aClin = await call(dean, 'POST', `/dean/guests/${idB}/assignments`, { staffId: 'staff_001' });
if (aClin.status === 201) log('guestB', '分工 staff_001');

// 健康自述 → 医护确认（高血压 + 海鲜过敏 + 鸡蛋忌口）
let profileB = await must(tokenB, 'GET', '/me/health-profile');
const none = { status: 'none', items: [] };
if (profileB.profileVersion === 0) {
  const saved = await must(tokenB, 'POST', '/me/health-intakes', { profile: { chronic: { status: 'reported', items: ['高血压'] }, allergies: { status: 'reported', items: ['海鲜'] }, dietaryRestrictions: { status: 'reported', items: ['鸡蛋'] } }, baseProfileVersion: 0 }, 201);
  await must(clinician, 'POST', `/staff/health-intakes/${saved.pendingIntakes[0].id}/confirm`, { baseProfileVersion: 0 }, 200);
  log('guestB', '健康自述已提交并确认（高血压/海鲜/鸡蛋）');
} else log('guestB', `档案版本 ${profileB.profileVersion}，跳过自述`);

// 7 天血压 + 睡眠指标趋势（recordedAt 用上海早晨时刻，避免未来时间被拒；按日期去重）
const existingRecords = await call(tokenB, 'GET', '/me/health-records');
const existingDays = new Set((existingRecords.data.items || existingRecords.data || [])
  .map(r => String(r.recordedAt || r.recorded_at || '').slice(0, 10)));
const bp = [[132, 86], [130, 84], [136, 88], [128, 82], [126, 80], [124, 79], [122, 78]];
for (let i = 6; i >= 0; i -= 1) {
  const day = shDay(-i);
  if (existingDays.has(day)) continue;
  const [sys, dia] = bp[6 - i];
  const r1 = await call(tokenB, 'POST', '/me/health-records', { metric: 'blood_pressure', value: { systolic: sys, diastolic: dia }, unit: 'mmHg', recordedAt: `${day}T01:00:00.000Z`, note: '演示血压记录' });
  const r2 = await call(tokenB, 'POST', '/me/health-records', { metric: 'sleep', value: 6.5 + (6 - i) * 0.3, unit: 'h', recordedAt: `${day}T01:00:00.000Z`, note: '演示睡眠记录' });
  if (r1.status === 201) log('metric', `${day} 血压 ${sys}/${dia}、睡眠 ${(6.5 + (6 - i) * 0.3).toFixed(1)}h`);
}

// 今日/明日餐单 + 订单（早餐送达、午餐备餐中）
const today = shDay(0), tomorrow = shDay(1);
const menuR = await call(tokenB, 'POST', '/meals/menus', { businessDate: today });
const menuT = await call(tokenB, 'POST', '/meals/menus', { businessDate: tomorrow });
log('meal', `今日餐单 ${menuR.status}、明日餐单 ${menuT.status}`);
if (menuR.status === 201 || menuR.status === 200) {
  const menu = menuR.data.menu ?? menuR.data;
  const oB = await call(tokenB, 'POST', '/meals/orders', { menuId: menu.id, businessDate: today, mealType: 'breakfast', version: menu.version }, undefined, 'demo-mock-breakfast-2026');
  if (oB.status === 201 || oB.status === 200) {
    const oid = (oB.data.order ?? oB.data).id;
    await call(dietitian, 'POST', `/staff/meals/orders/${oid}/review`, { note: '演示复核：海鲜/鸡蛋限制与餐位一致' });
    await call(dietitian, 'PATCH', `/staff/meals/orders/${oid}/status`, { status: 'preparing' });
    await call(dietitian, 'PATCH', `/staff/meals/orders/${oid}/status`, { status: 'delivered' });
    log('meal', `早餐订单 ${oid} 已送达`);
  } else log('meal', `早餐订单跳过：${oB.status}`);
  const oL = await call(tokenB, 'POST', '/meals/orders', { menuId: menu.id, businessDate: today, mealType: 'lunch', version: menu.version }, undefined, 'demo-mock-lunch-2026');
  if (oL.status === 201 || oL.status === 200) {
    const oid = (oL.data.order ?? oL.data).id;
    await call(dietitian, 'POST', `/staff/meals/orders/${oid}/review`, { note: '演示复核：午餐限制一致' });
    await call(dietitian, 'PATCH', `/staff/meals/orders/${oid}/status`, { status: 'preparing' });
    log('meal', `午餐订单 ${oid} 备餐中`);
  }
}

// 预约：明天水疗 09:30 + 周一水疗 + 一条已取消
const slotsFri = await must(tokenB, 'GET', `/projects/project-spa/slots?date=${tomorrow}`);
const slotList = slotsFri.slots || [];
const slot1 = slotList.find(s => s.localStart === '09:30');
if (slot1) {
  const r1 = await call(tokenB, 'POST', '/reservations', { slotId: slot1.id }, undefined, 'demo-mock-resv-spa-1');
  log('resv', `明日水疗 09:30 预约 ${r1.status === 201 ? 'OK' : r1.status}`);
  const slot2 = slotList.find(s => s.localStart === '10:30');
  if (slot2) {
    const r2 = await call(tokenB, 'POST', '/reservations', { slotId: slot2.id }, undefined, 'demo-mock-resv-spa-2');
    if (r2.status === 201) {
      const rid = (r2.data.reservation ?? r2.data).id;
      await call(tokenB, 'DELETE', `/reservations/${rid}`, { reason: '演示：临时有事取消' });
      log('resv', `明日水疗 10:30 已预约并取消（${rid}）`);
    }
  }
} else log('resv', '明日 09:30 水疗时段不可约（窗口或容量），跳过');

// ── 3 客人C：新入住 + 待审核自述 ──
const C_PHONE = '13900001003';
const regC = await call(null, 'POST', '/auth/register', { phone: C_PHONE, password: 'Guest-2026!x', confirmPassword: 'Guest-2026!x', name: '岑心（演示）' });
if (regC.status === 201) log('guestC', '注册 岑心（演示）');
else if (regC.status === 409) log('guestC', '已存在，复用');
const tokenC = await login(C_PHONE, 'Guest-2026!x', 'guest');
const meC = await must(tokenC, 'GET', '/me');
const idC = meC.user ? meC.user.id : meC.id;
await call(dean, 'PATCH', `/dean/guests/${idC}/stay`, { roomNo: 'C-201', checkIn: today, checkOut: shDay(3), stayPlan: 'three_night' });
await call(dean, 'POST', `/dean/guests/${idC}/assignments`, { staffId: 'staff_001' });
const profileC = await must(tokenC, 'GET', '/me/health-profile');
if (profileC.profileVersion === 0) {
  const intakeC = await call(tokenC, 'POST', '/me/health-intakes', { profile: { chronic: none, allergies: { status: 'reported', items: ['花粉'] }, dietaryRestrictions: none }, baseProfileVersion: 0 });
  if (intakeC.status === 201 || intakeC.status === 200) log('guestC', '待审核健康自述已提交（花粉过敏，等待医护核实）');
  else log('guestC', `自述提交 ${intakeC.status}：${JSON.stringify(intakeC.data).slice(0, 100)}`);
}

// ── 4 SQL 直写：历史心情 + 疗程草案（v1 已激活 / v2 待审）──
const db = new DatabaseSync(DB_PATH);
try {
  const moodDates = [...Array(6)].map((_, i) => shDay(-(i + 1)));
  const moodScores = [3, 3, 4, 4, 4, 5];
  const moodNotes = ['演示：有些疲惫', '演示：睡眠一般', '演示：散步后舒服', '演示：状态平稳', '演示：心情不错', '演示：家人来访很开心'];
  let moodAdded = 0;
  moodDates.forEach((d, i) => {
    const r = db.prepare(`INSERT OR IGNORE INTO mood_records(guest_id,business_date,score,note,created_at,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(idB, d, moodScores[i], moodNotes[i], `${d}T12:30:00.000Z`, `${d}T12:30:00.000Z`);
    moodAdded += Number(r.changes);
  });
  const todayMood = await call(tokenB, 'POST', '/me/moods', { score: 4, note: '演示：今日心情平稳' });
  if (todayMood.status === 201) moodAdded += 1;
  log('mood', `写入 ${moodAdded} 条心情记录（含今日）`);

  // 疗程草案：v1 已激活 + v2 待审（进医护审核队列），逐条幂等
  const now = new Date().toISOString();
  const ev = {
    parentRunId: 'run_demo_mock_0001', sessionId: null, executionMode: 'recorded_fixture', model: null, provider: null,
    coordinator: { agentId: 'household.concierge', status: 'completed' },
    selectedSuggestions: [], domainAgents: [], candidateIds: [], planningCandidates: [],
    emptyCandidateDomains: [], domainDates: { nutrition: today, exercise: today },
    graphBudget: { modelCalls: 0 }, graphDurationMs: 0, reviewPolicy: 'sampled_review',
    environmentSnapshots: {}
  };
  const d1 = 'wellness_draft_demo_b1', d2 = 'wellness_draft_demo_b2';
  const draftInsert = `INSERT OR IGNORE INTO wellness_drafts(id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,evidence_json,created_at,review_status,review_thread_id,supersedes_draft_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const r1 = db.prepare(draftInsert).run(d1, idB, 1, 'demo-mock-draft-v1', null, shDay(-1), shDay(7), 'active', 'sampled_review', 100, JSON.stringify(ev), now, 'active', d1, null, '演示：医护已通过第 1 版', 'staff_001', now);
  const r2 = db.prepare(draftInsert).run(d2, idB, 2, 'demo-mock-draft-v2', null, shDay(-1), shDay(7), 'pending_review', 'sampled_review', 100, JSON.stringify(ev), now, 'pending_review', d2, d1, null, null, null);
  log('draft', `草案 v1(active)${Number(r1.changes) ? '写入' : '已存在'} / v2(pending_review)${Number(r2.changes) ? '写入' : '已存在'}`);

  const items1 = [
    ['demo-item-b11', d1, today, 'breakfast', 'meal', 'breakfast:dish-chicken-rice', '香菇鸡肉饭（演示）', null, null, 'proposed', '菜品来自演示目录；海鲜/鸡蛋限制已复核，不复制其他日期餐点。'],
    ['demo-item-b12', d1, tomorrow, 'morning', 'activity', 'project-spa', '水疗 SPA（低温短时）', '09:30', '10:30', 'mandatory_review', '高血压史：建议低温短时水疗，单次不超过 15 分钟；需医护逐项核对。'],
    ['demo-item-b13', d1, tomorrow, 'evening', 'rest', null, '晚间静养', '19:00', '20:00', 'proposed', '演示建议：晚间安排静养，避免高强度活动。'],
    ['demo-item-b14', d1, today, 'morning', 'gap', null, '慢病史未补充', null, null, 'gap', '演示缺口：长期用药说明尚未提供，相关领域建议仅供候选。']
  ];
  const items2 = items1.map((row, i) => [`demo-item-b2${i + 1}`, d2, ...row.slice(2)]);
  let itemAdded = 0;
  for (const row of [...items1, ...items2]) {
    const r = db.prepare(`INSERT OR IGNORE INTO wellness_draft_items(id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,'{}')`)
      .run(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[4] === 'activity' ? '康养中心水疗室（示例地点）' : null, '[]', JSON.stringify([{ type: 'demo_seed', id: 'mock', label: '演示数据' }]));
    itemAdded += Number(r.changes);
  }
  log('draft', `草案条目 ${itemAdded ? `新增 ${itemAdded} 条` : '均已存在'}`);
} finally { db.close(); }

log('done', '演示数据种子完成：五岗位 / 客人B（档案+指标+餐食+预约+草案+心情）/ 客人C（待审核自述）');
