import { db, id, json } from './db.js';
import { systemBusinessClock } from './clock.js';
import { createNotificationOnce, syncCareSignals } from './wellness-notifications.js';

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

function environmentSummary(domain, payload) {
  if (domain === 'weather' && payload?.current) {
    const current = payload.current;
    const parts = [];
    if (current.temperatureC != null && current.temperatureC !== '' && Number.isFinite(Number(current.temperatureC))) parts.push(`${current.temperatureC}°C`);
    if (current.uvLevel) parts.push(`紫外线标记 ${current.uvLevel}`);
    return parts.length ? `保存的天气快照：${parts.join(' · ')}` : '已保存天气快照';
  }
  if (domain === 'tide' && Array.isArray(payload?.events)) {
    const events = payload.events.slice(0, 4).map(event => `${String(event.localTime || event.time || '').slice(11, 16)} ${event.type === 'high' ? '高潮' : event.type === 'low' ? '低潮' : '潮汐记录'}${event.heightM != null && event.heightM !== '' && Number.isFinite(Number(event.heightM)) ? ` ${event.heightM}m` : ''}`);
    const datum = payload.verticalDatum ? `基准 ${payload.verticalDatum}` : '垂直基准未知';
    return `保存的潮汐快照：${events.filter(Boolean).join('、') || '有记录'}；${datum}`;
  }
  if (domain === 'marine' && Array.isArray(payload?.hourly)) {
    const first = payload.hourly[0];
    const height = first?.waveHeightM == null || first?.waveHeightM === '' ? NaN : Number(first.waveHeightM);
    return Number.isFinite(height) ? `保存的海况快照：首条波高记录 ${height}m` : '已保存海况快照';
  }
  return '已保存环境快照；详细内容以来源记录为准';
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
  const snapshots = await db.prepare(`SELECT snapshot_key AS sourceId,domain,status,source_name AS sourceName,
      observed_at AS observedAt,payload_json AS payloadJson
    FROM environment_snapshots WHERE target_date=? ORDER BY updated_at DESC,snapshot_key`).all(businessDate);
  const environmentByDomain = new Map();
  for (const row of snapshots) if (!environmentByDomain.has(row.domain)) environmentByDomain.set(row.domain, row);
  const environment = ['weather', 'tide', 'marine'].map(domain => {
    const row = environmentByDomain.get(domain);
    if (!row) return { domain, available: false, sourceId: null, sourceName: '', summary: '', missingNote: `${domain === 'weather' ? '天气' : domain === 'tide' ? '潮汐' : '海况'}快照缺失` };
    const payload = decodeJson(row.payloadJson, {});
    return { domain, available: true, status: row.status, sourceId: row.sourceId,
      sourceName: row.sourceName, observedAt: row.observedAt, summary: environmentSummary(domain, payload), missingNote: '' };
  });

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
    ...environment.filter(item => item.available).map(item => ({ type: 'environment_snapshot', id: item.sourceId, label: item.sourceName })),
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

async function saveDailyBrief(guestId, businessDate, at) {
  const snapshot = await buildDailyBriefSnapshot(guestId, businessDate);
  if (!snapshot) return null;
  const existing = await db.prepare(`SELECT id,generated_at AS generatedAt FROM daily_briefs
    WHERE guest_id=? AND business_date=?`).get(guestId, businessDate);
  let row = existing;
  if (existing) {
    await db.prepare('UPDATE daily_briefs SET brief_json=?,updated_at=? WHERE guest_id=? AND business_date=?')
      .run(JSON.stringify(snapshot), at, guestId, businessDate);
  } else {
    const briefId = id('daily_brief');
    try {
      await db.prepare(`INSERT INTO daily_briefs(id,guest_id,business_date,brief_json,generated_at,updated_at)
        VALUES(?,?,?,?,?,?)`).run(briefId, guestId, businessDate, JSON.stringify(snapshot), at, at);
      row = { id: briefId, generatedAt: at };
    } catch (error) {
      const duplicate = error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062
        || String(error?.code || '').startsWith('SQLITE_CONSTRAINT')
        || /UNIQUE constraint failed/i.test(String(error?.message || ''));
      if (!duplicate) throw error;
      row = await db.prepare(`SELECT id,generated_at AS generatedAt FROM daily_briefs
        WHERE guest_id=? AND business_date=?`).get(guestId, businessDate);
      await db.prepare('UPDATE daily_briefs SET brief_json=?,updated_at=? WHERE guest_id=? AND business_date=?')
        .run(JSON.stringify(snapshot), at, guestId, businessDate);
    }
  }
  if (!row) throw new Error('daily brief write did not produce a persisted row');
  await createNotificationOnce({ guestId, sourceType: 'daily_brief', sourceId: businessDate,
    message: `${businessDate} 的每日简报已更新，可查看活动、餐食和来源。`,
    targetType: 'daily_brief', targetId: row.id, targetUrl: 'caretaker', notificationType: 'brief', createdAt: row.generatedAt });
  return { status: 'ready', id: row.id, guestId, businessDate, generatedAt: row.generatedAt,
    updatedAt: at, brief: snapshot };
}

export async function getGuestDailyBrief(guestId, businessDate = systemBusinessClock.dateKey(), instant = systemBusinessClock.instant()) {
  const today = systemBusinessClock.dateKey(instant);
  const hour = systemBusinessClock.parts(instant).hour;
  if (businessDate === today && hour < DAILY_BRIEF_HOUR) {
    const existing = await db.prepare(`SELECT id,generated_at AS generatedAt,updated_at AS updatedAt,brief_json AS briefJson
      FROM daily_briefs WHERE guest_id=? AND business_date=?`).get(guestId, businessDate);
    return existing ? { status: 'ready', id: existing.id, guestId, businessDate,
      generatedAt: existing.generatedAt, updatedAt: existing.updatedAt, brief: decodeJson(existing.briefJson, {}) }
      : { status: 'not_ready', guestId, businessDate, availableAt: '07:00', timeZone: 'Asia/Shanghai' };
  }
  if (businessDate !== today) {
    const existing = await db.prepare(`SELECT id,generated_at AS generatedAt,updated_at AS updatedAt,brief_json AS briefJson
      FROM daily_briefs WHERE guest_id=? AND business_date=?`).get(guestId, businessDate);
    return existing ? { status: 'ready', id: existing.id, guestId, businessDate,
      generatedAt: existing.generatedAt, updatedAt: existing.updatedAt, brief: decodeJson(existing.briefJson, {}) }
      : { status: 'not_generated', guestId, businessDate };
  }
  return await saveDailyBrief(guestId, businessDate, instant.toISOString());
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
        const existing = await db.prepare(`SELECT id FROM daily_briefs WHERE guest_id=? AND business_date=?`)
          .get(guest.id, businessDate);
        await saveDailyBrief(guest.id, businessDate, at.toISOString());
        if (!existing) briefsCreated += 1;
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
  return { businessDate, localTime: `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`,
    briefsCreated, remindersCreated, careSignals, guestFailures };
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
