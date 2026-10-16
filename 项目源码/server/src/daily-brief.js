import { db, id, isUniqueViolation, json } from './db.js';
import { systemBusinessClock } from './clock.js';
import { readCurrentEnvironmentSnapshot, cleanupExpiredEnvironmentSnapshots } from './environment.js';
import { briefEnvironment } from './environment-resolution.js';
import { createNotificationOnce, syncCareSignals } from './wellness-notifications.js';

// 环境快照清理的每日执行备忘（模块级，进程重启后首个 tick 会再执行一次，幂等无害）。
let environmentCleanupLastDate = null;

const DAILY_BRIEF_HOUR = 7;
const REMINDER_LEAD_MS = 15 * 60 * 1000;

function dateDistance(start, end) {
  const first = Date.parse(`${String(start).slice(0, 10)}T00:00:00Z`);
  const second = Date.parse(`${String(end).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(first) && Number.isFinite(second) ? Math.floor((second - first) / 86_400_000) : null;
}

function decodeJson(value, fallback) {
  if (typeof value === 'string') return json(value, fallback);
  return value ?? fallback;
}

export async function buildDailyBriefSnapshot(guestId, businessDate) {
  const guest = await db.prepare(`SELECT u.id,u.name,g.check_in AS checkIn,g.check_out AS checkOut
    FROM users u LEFT JOIN guest_profiles g ON g.user_id=u.id
    WHERE u.id=? AND u.role='guest' AND u.status='active'`).get(guestId);
  if (!guest) return null;

  const stayStart = String(guest.checkIn || '').slice(0, 10);
  const stayEnd = String(guest.checkOut || '').slice(0, 10);
  const nights = stayStart && stayEnd && businessDate >= stayStart && businessDate < stayEnd
    ? dateDistance(stayStart, businessDate) : null;
  const activities = await db.prepare(`SELECT r.id AS reservationId,r.status AS reservationStatus,
      s.business_date AS businessDate,s.local_start AS localStart,s.local_end AS localEnd,
      p.id AS projectId,p.name AS projectName,p.location
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
    WHERE r.guest_id=? AND s.business_date=? AND r.status='confirmed'
    ORDER BY s.starts_at,r.id`).all(guestId, businessDate);

  const menus = await db.prepare(`SELECT m.id AS menuId,m.status AS menuStatus,mi.meal_type AS mealType,
      mi.dish_snapshot_json AS dishSnapshot,mi.selection_reason AS selectionReason
    FROM meal_menus m LEFT JOIN meal_menu_items mi ON mi.menu_id=m.id
    WHERE m.guest_id=? AND m.business_date=? ORDER BY mi.meal_type,mi.slot`).all(guestId, businessDate);
  const orderRows = await db.prepare(`SELECT id AS orderId,meal_type AS mealType,status AS orderStatus,
      dishes_snapshot_json AS dishesSnapshot FROM meal_orders WHERE guest_id=? AND business_date=?
    ORDER BY meal_type,id`).all(guestId, businessDate);
  const orderByType = new Map(orderRows.map(row => [row.mealType, row]));
  const menuId = menus.find(row => row.menuId)?.menuId || null;
  const mealLabels = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };
  const meals = Object.keys(mealLabels).map(mealType => {
    const entries = menus.filter(row => row.mealType === mealType);
    const order = orderByType.get(mealType);
    const dishNames = entries.map(row => decodeJson(row.dishSnapshot, {})?.name).filter(Boolean);
    const orderedNames = order ? decodeJson(order.dishesSnapshot, []).map(item => item?.name).filter(Boolean) : [];
    return {
      mealType, label: mealLabels[mealType], status: order?.orderStatus || (entries.length ? 'menu_saved' : 'not_generated'),
      items: [...new Set(orderedNames.length ? orderedNames : dishNames)], orderId: order?.orderId || null,
      menuId, targetType: order?.orderId ? 'meal_order' : 'meal_menu', targetId: order?.orderId || menuId || '',
      targetUrl: 'meals', missingNote: entries.length || order ? '' : `${mealLabels[mealType]}暂无已保存餐单`
    };
  });

  const advice = await db.prepare(`SELECT a.id,a.title,a.content,a.priority,a.created_at AS createdAt,
      a.updated_at AS updatedAt,u.name AS authorName
    FROM medical_advice a JOIN users u ON u.id=a.author_id
    WHERE a.guest_id=? AND a.status='active' ORDER BY a.updated_at DESC,a.id DESC LIMIT 20`).all(guestId);
  const environmentSnapshot = await readCurrentEnvironmentSnapshot(businessDate);
  const environment = briefEnvironment(environmentSnapshot);
  const moodFocus = await db.prepare(`SELECT id,streak_start AS streakStart,streak_end AS streakEnd
    FROM mood_focus_items WHERE guest_id=? AND status='open' ORDER BY streak_end DESC,id DESC LIMIT 20`).all(guestId);
  const revisions = await db.prepare(`SELECT id,draft_id AS draftId,reason,from_version AS fromVersion,to_version AS toVersion,
      created_at AS createdAt FROM wellness_review_events WHERE guest_id=? AND action='corrected'
    ORDER BY created_at DESC,id DESC LIMIT 20`).all(guestId);
  const careItems = [
    ...moodFocus.map(item => ({ sourceType: 'mood_focus_item', sourceId: String(item.id),
      title: '心情關懷', message: '近三日的心情记录需要工作人员留意；如愿意，可以联系负责人员聊聊。',
      sourceLabel: `${String(item.streakStart).slice(0, 10)} 至 ${String(item.streakEnd).slice(0, 10)} 的关注记录`, targetUrl: 'mood' })),
    ...revisions.map(item => ({ sourceType: 'wellness_review_event', sourceId: item.id,
      title: '医护修订', message: `医护已修订疗程安排（第 ${item.fromVersion || '—'} 版至第 ${item.toVersion || '—'} 版）。${item.reason || ''}`,
      sourceLabel: `审核事件 ${item.id}`, targetUrl: 'schedule' }))
  ];
  const sources = [
    ...activities.map(item => ({ type: 'reservation', id: item.reservationId, label: item.projectName })),
    ...meals.filter(item => item.targetId).map(item => ({ type: item.targetType, id: item.targetId, label: item.label })),
    ...advice.map(item => ({ type: 'medical_advice', id: String(item.id), label: item.title })),
    ...environment.filter(item => item.sourceId).map(item => ({ type: 'environment_snapshot', domain:item.domain, id: item.sourceId, label: item.sourceName,status:item.status })),
    ...careItems.map(item => ({ type: item.sourceType, id: item.sourceId, label: item.title }))
  ];
  const missing = [];
  if (nights === null) missing.push('入住日期未覆盖本日，入住天数无法计算');
  if (!activities.length) missing.push('当天没有已确认的活动预约');
  for (const meal of meals) if (meal.missingNote) missing.push(meal.missingNote);
  if (!advice.length) missing.push('当前没有已发布的医护建议');
  for (const item of environment) if (item.missingNote) missing.push(item.missingNote);

  return {
    businessDate,
    greeting: guest.name ? `${guest.name}，早上好` : '早上好',
    stay: { checkIn: stayStart || null, checkOut: stayEnd || null, dayNumber: nights === null ? null : nights + 1,
      label: nights === null ? '入住天数待核对' : `入住第 ${nights + 1} 天` },
    activities: activities.map(item => ({ ...item, targetType: 'reservation', targetId: item.reservationId, targetUrl: 'reservations' })),
    meals, advice, environment, careItems, sources, missing
  };
}

async function briefView(row, guestId, businessDate, { historical = false } = {}) {
  const generated = decodeJson(row.briefJson ?? row.brief_json, {});
  const current = historical ? generated : await buildDailyBriefSnapshot(guestId, businessDate);
  const currentDate = systemBusinessClock.dateKey();
  const currentEnvironmentSnapshot = await readCurrentEnvironmentSnapshot(historical ? currentDate : businessDate);
  return { status:'ready', id:row.id, guestId,businessDate,
    generatedAt:row.generatedAt ?? row.generated_at, updatedAt:row.updatedAt ?? row.updated_at,
    brief:current, generatedBrief:generated, historical,
    currentEnvironment:briefEnvironment(currentEnvironmentSnapshot),
    environmentContext:{generatedAt:row.generatedAt ?? row.generated_at, generatedEnvironment:generated.environment || [],
      currentSnapshotId:currentEnvironmentSnapshot.snapshotId,currentLocation:currentEnvironmentSnapshot.location,
      currentSourceMode:currentEnvironmentSnapshot.sourceMode,currentStatus:currentEnvironmentSnapshot.status,
      note:'生成时简报与来源保持原件；当前环境是另一次只读对照，不会更新原简报或批准活动。'} };
}

async function saveDailyBrief(guestId,businessDate,at) {
  let row=await db.prepare('SELECT * FROM daily_briefs WHERE guest_id=? AND business_date=?').get(guestId,businessDate);
  if(!row){
    const snapshot=await buildDailyBriefSnapshot(guestId,businessDate);if(!snapshot)return null;
    const briefId=id('daily_brief');
    try{await db.prepare('INSERT INTO daily_briefs(id,guest_id,business_date,brief_json,generated_at,updated_at) VALUES(?,?,?,?,?,?)')
      .run(briefId,guestId,businessDate,JSON.stringify(snapshot),at,at);}
    catch(error){if(!isUniqueViolation(error))throw error;}
    row=await db.prepare('SELECT * FROM daily_briefs WHERE guest_id=? AND business_date=?').get(guestId,businessDate);
    if(!row)throw new Error('daily brief creation has no persisted row');
    await createNotificationOnce({guestId,sourceType:'daily_brief',sourceId:businessDate,
      message:`${businessDate} 的每日简报已生成，可查看安排与来源。`,targetType:'daily_brief',targetId:row.id,
      targetUrl:'caretaker',notificationType:'brief',createdAt:row.generated_at});
  }
  return briefView(row,guestId,businessDate);
}

export async function getGuestDailyBrief(guestId,businessDate=systemBusinessClock.dateKey(),instant=systemBusinessClock.instant()) {
  const today=systemBusinessClock.dateKey(instant),hour=systemBusinessClock.parts(instant).hour;
  if(businessDate!==today||hour<DAILY_BRIEF_HOUR){
    const row=await db.prepare('SELECT * FROM daily_briefs WHERE guest_id=? AND business_date=?').get(guestId,businessDate);
    if(row)return briefView(row,guestId,businessDate,{historical:true});
    return businessDate===today?{status:'not_ready',guestId,businessDate,availableAt:'07:00',timeZone:'Asia/Shanghai'}
      :{status:'not_generated',guestId,businessDate};
  }
  return saveDailyBrief(guestId,businessDate,instant.toISOString());
}

export async function runStage25Tick(instant = systemBusinessClock.instant(), clock = systemBusinessClock) {
  const at = instant instanceof Date ? instant : new Date(instant);
  if (!Number.isFinite(at.getTime())) throw new TypeError('scheduler tick requires a valid instant');
  const businessDate = clock.dateKey(at);
  const parts = clock.parts(at);
  let briefsCreated = 0;
  let careSignals = 0;
  const guestFailures = [];
  if (parts.hour >= DAILY_BRIEF_HOUR) {
    const guests = await db.prepare(`SELECT id FROM users WHERE role='guest' AND status='active' ORDER BY id`).all();
    for (const guest of guests) {
      try {
        // 已有当日简报则跳过：saveDailyBrief→briefView 会为“当前对照”重建整份快照
        // （每客人 7+ 次查询），调度器每分钟全量重建是主要的周期性卡顿来源（G08）。
        const existing = await db.prepare(`SELECT id FROM daily_briefs WHERE guest_id=? AND business_date=?`)
          .get(guest.id, businessDate);
        if (!existing) {
          await saveDailyBrief(guest.id, businessDate, at.toISOString());
          briefsCreated += 1;
        }
        const signals = await syncCareSignals(guest.id, at.toISOString());
        careSignals += signals.moodFocusCount + signals.correctedReviewCount;
      } catch (error) {
        guestFailures.push({ guestId: guest.id, code: String(error?.code || 'BRIEF_SYNC_FAILED').slice(0, 64) });
      }
    }
  }
  const reminderEnd = new Date(at.getTime() + REMINDER_LEAD_MS).toISOString();
  const due = await db.prepare(`SELECT r.id AS reservationId,r.guest_id AS guestId,
      s.business_date AS businessDate,s.local_start AS localStart,p.name AS projectName
    FROM reservations r JOIN activity_slots s ON s.id=r.slot_id JOIN projects p ON p.id=s.project_id
      JOIN users u ON u.id=r.guest_id
    WHERE r.status='confirmed' AND u.status='active' AND s.starts_at>? AND s.starts_at<=?
    ORDER BY s.starts_at,r.id`).all(at.toISOString(), reminderEnd);
  let remindersCreated = 0;
  for (const item of due) {
    const notification = await createNotificationOnce({ guestId: item.guestId,
      sourceType: 'reservation_reminder', sourceId: item.reservationId,
      message: `预约提醒：${String(item.businessDate).slice(0, 10)} ${item.localStart} 将开始「${item.projectName}」。`,
      targetType: 'reservation', targetId: item.reservationId, targetUrl: 'reservations',
      notificationType: 'reminder', createdAt: at.toISOString() });
    if (notification.created) remindersCreated += 1;
  }
  // G09：每日首个 tick 清理一次过期超过 90 天的环境快照（追加式表此前永不清理）。
  let environmentCleaned = 0;
  if (environmentCleanupLastDate !== businessDate) {
    environmentCleanupLastDate = businessDate;
    try { environmentCleaned = await cleanupExpiredEnvironmentSnapshots(); }
    catch (error) { guestFailures.push({ guestId: 'environment-cleanup', code: String(error?.code || 'CLEANUP_FAILED').slice(0, 64) }); }
  }
  return { businessDate, localTime: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    briefsCreated, remindersCreated, careSignals, environmentCleaned, guestFailures };
}

export function startStage25Scheduler({ clock = systemBusinessClock, intervalMs = 60_000, onInitialTick = () => {}, onError = error => {
  console.error(`[stage25-scheduler] tick failed: ${String(error?.message || error).slice(0, 500)}`);
} } = {}) {
  let stopped = false;
  let inFlight = null;
  let initialTickStarted = false;
  const tick = () => {
    if (stopped) return Promise.resolve(null);
    if (inFlight) return inFlight;
    const isInitialTick = !initialTickStarted;
    initialTickStarted = true;
    inFlight = runStage25Tick(clock.instant(), clock).then(result => {
      if (isInitialTick) onInitialTick(result);
      return result;
    }).catch(error => {
      onError(error);
      return null;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  void tick();
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(timer);
      if (inFlight) await inFlight;
    }
  };
}
