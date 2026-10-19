import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirmation } from '../../shared/Confirmation.jsx';
import { request } from '../../lib/request.js';
import { businessToday, mealLocalTime } from '../../lib/date.js';
import { useQuery } from '../../lib/useQuery.js';
import { PageTitle, QueryState, SectionHead } from '../../shared/ui.jsx';
import { SourceDetails } from '../../SourceDetails.jsx';

export const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };
export const SLOT_LABELS = { main: '主食', side: '配菜', soup: '汤品' };
export const ORDER_STATUS_LABELS = { reserved: '已提交', preparing: '备餐中', delivered: '已送达' };
const MEAL_SOURCE_LABELS = {
  'verified-profile': '正式档案',
  'legacy-profile': '历史档案',
  form: '待核实自述',
  assistant: '待核实对话自述',
  'pending-intake': '待核实自述'
};
const MEAL_RESTRICTION_STATUS_LABELS = { confirmed: '已确认', pending: '待核实', existing: '历史记录' };
const MEAL_FOOD_LABELS = {
  shrimp: '虾类', fish: '鱼类', seafood: '海鲜', egg: '鸡蛋', milk: '乳制品',
  soy: '大豆', wheat: '小麦', gluten: '麸质', oats: '燕麦', peanut: '花生'
};

export function mealSourceLabel(value) { return MEAL_SOURCE_LABELS[value] || '健康档案'; }
export function mealRestrictionStatusLabel(value) { return MEAL_RESTRICTION_STATUS_LABELS[value] || '已记录'; }
export function mealFoodLabels(values) {
  return (values || []).map(value => MEAL_FOOD_LABELS[String(value).trim().toLocaleLowerCase()] || value);
}

function MealConstraintList({ constraints, emptyText }) {
  const items = [...(constraints?.allergies || []), ...(constraints?.dietaryRestrictions || [])];
  return items.length ? <ul>{items.map((item, index) => <li key={index}>{mealFoodLabels([item.value])[0]} · {mealSourceLabel(item.source)} · {mealRestrictionStatusLabel(item.status)}</li>)}</ul> : <p>{emptyText}</p>;
}

export function MealOrderTiming({ order }) {
  return <div className="meal-timing" data-time-policy="unknown">
    <small>常规供餐时刻（上海时间，非预计）：{mealLocalTime(order.regularServingAt)}</small>
    <small>{order.expectedDeliveryNote || '预计送达时间未确定；请查看实际备餐与送达状态。'}</small>
    {order.preparingAt && <small>实际开始备餐（上海时间）：{mealLocalTime(order.preparingAt)}</small>}
    {order.deliveredAt && <small>实际送达（上海时间）：{mealLocalTime(order.deliveredAt)}</small>}
  </div>;
}

export function MealRestrictionReview({ guestId, canResolve = false, notify, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState([]);
  const [note, setNote] = useState('');
  const endpoint = guestId ? `/staff/guests/${guestId}/meal-restriction-review` : '/meals/restriction-review';
  const { data, error, setError, load } = useQuery(async (signal) => {
    const result = await request(endpoint, { signal });
    setChoices((result.review?.restrictions || []).map(() => ({ classification: '', foodValue: '' })));
    return result;
  }, [endpoint], { fallbackMessage: '' });
  async function submit(resolve) {
    setBusy(true);
    try {
      await request(resolve ? `/staff/meal-restriction-reviews/${data.review.id}/resolve` : endpoint, {
        method: 'POST', body: JSON.stringify(resolve ? { decisions: choices, note } : {})
      });
      notify(resolve ? '医护核对已保存，原健康记录保留' : '限制已转交负责医护'); await load(); await onChanged?.();
    } catch (err) { notify(err.message); setError(err.message); } finally { setBusy(false); }
  }
  if (!data && !error) return null;
  if (data && !data.unrecognized.length && !data.history.length && !error) return null;
  return <section className="surface meal-restriction-review" aria-label="膳食限制人工核对"><SectionHead title="膳食限制人工核对"/><button type="button" className="text-btn" onClick={load}>刷新核对进度</button>
    {error && <p role="alert">{error}</p>}
    {data?.unrecognized.length > 0 && <p>原始限制保留：{data.unrecognized.map(item => item.value).join('、')}。核实前暂停相关选择；仅医护可决定食物与非食物分类。</p>}
    <p>负责医护：{data?.responsibleClinicians.map(item => item.name).join('、') || '尚未分工，请联系机构管理员安排医护'}</p>
    {data?.review ? <><p role="status">处理状态：{data.review.status === 'resolved' ? '已人工核对' : '待医护核对'} · 转交负责人：{data.review.assignedName}</p>
      {data.review.status === 'resolved' ? <p>核对人：{data.review.reviewerName} · {data.review.note} · {mealLocalTime(data.review.reviewedAt)}。健康自述原文与历史保持。</p> : canResolve && <div className="meal-swap-form">{data.review.restrictions.map((item, index) => <div key={index}><label>“{item.value}”的分类<select value={choices[index]?.classification || ''} onChange={event => setChoices(current => current.map((choice, n) => n === index ? { ...choice, classification: event.target.value } : choice))}><option value="">请选择人工核对结果</option><option value="food">食物限制</option><option value="non_food">非食物描述（原文保留）</option></select></label>{choices[index]?.classification === 'food' && <label>对应食材或饮食标签<input value={choices[index]?.foodValue || ''} onChange={event => setChoices(current => current.map((choice, n) => n === index ? { ...choice, foodValue: event.target.value } : choice))} placeholder="例如：鸡蛋、海鲜、花生、清真"/></label>}</div>)}<label>人工核对依据<textarea aria-label="人工核对依据" value={note} maxLength={1000} onChange={event => setNote(event.target.value)} placeholder="记录与客人核对的结果和来源，不推测未知项"/></label><button type="button" className="primary-btn" disabled={busy || !note.trim() || choices.some(choice => !choice.classification || (choice.classification === 'food' && !choice.foodValue.trim()))} onClick={() => submit(true)}>保存医护分类核对</button></div>}</> : data?.unrecognized.length > 0 && <button type="button" className="outline-btn" disabled={busy || !data.responsibleClinicians.length} onClick={() => submit(false)}>转交负责医护核对</button>}
    {data?.history.length > 0 && <details><summary>查看核对历史与原始限制</summary>{data.history.map(item => <div key={item.id}><p>{item.restrictions.map(entry => entry.value).join('、')} · {item.status === 'resolved' ? '已核对' : '待核对'} · {item.reviewerName || item.assignedName} · {item.note}</p>{item.decisions.map((decision, index) => <p key={index}>“{decision.value}” → {decision.classification === 'non_food' ? '非食物描述' : `食物限制：${decision.foodValue}`}</p>)}</div>)}</details>}
  </section>;
}

export function GuestMeals({ me, notify }) {
  const { confirm, confirmation } = useConfirmation();
  const [date, setDate] = useState(businessToday);
  const [data, setData] = useState(null);
  const [dishes, setDishes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editingId, setEditingId] = useState('');
  const [swap, setSwap] = useState({ dishId: '', reason: '' });

  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    // 快速切换日期时，晚到的旧响应不再覆盖新数据（G20）
    const generation = ++loadGeneration.current;
    setLoading(true); setError('');
    try {
      const [menu, catalog] = await Promise.all([
        request(`/meals/menu?date=${encodeURIComponent(date)}`), request('/meals/dishes')
      ]);
      if (generation !== loadGeneration.current) return;
      setData(menu); setDishes(catalog.items || []);
    } catch (loadError) { if (generation === loadGeneration.current) setError(loadError.message || '餐单暂时无法加载'); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [date]);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    setBusy('generate');
    try {
      const result = await request('/meals/menus', { method: 'POST', body: JSON.stringify({ businessDate: date }) });
      setData(result); notify(result.status === 'ready' ? '餐单已生成' : '餐单已生成，部分餐位需要配餐员补充');
      await load();
    } catch (requestError) { notify(requestError.message || '餐单生成失败'); }
    finally { setBusy(''); }
  }

  async function replace(item) {
    if (!swap.dishId || !swap.reason.trim()) { notify('请选择菜品并填写替换原因'); return; }
    confirm({ title: '替换菜品', description: `确认将「${item.dish?.name || SLOT_LABELS[item.slot]}」替换为所选菜品？${data.orders?.some(order => order.mealType === item.mealType) ? '\n已提交订单会同步更新。' : ''}`, confirmLabel: '确认替换', action: async signal => {
      setBusy(item.id);
      try {
        await request(`/meals/menus/${encodeURIComponent(data.menu.id)}/items/${encodeURIComponent(item.id)}`, {
          method: 'PATCH', body: JSON.stringify({ version: data.menu.version, dishId: swap.dishId, reason: swap.reason }), signal
        });
        if (signal.aborted) return;
        setEditingId(''); setSwap({ dishId: '', reason: '' }); notify('餐位已替换'); await load();
      } catch (requestError) {
        if (signal.aborted) return;
        const message = requestError.message || '替换失败';
        notify(message); if (requestError.status === 409) await load();
        throw new Error(message);
      } finally { if (!signal.aborted) setBusy(''); }
    } });
  }

  async function order(mealType) {
    if (busy) return;
    setBusy(`order-${mealType}`);
    try {
      const key = `meal-${me.id}-${date}-${mealType}-${window.crypto.randomUUID()}`;
      await request('/meals/orders', {
        method: 'POST', headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ menuId: data.menu.id, businessDate: date, mealType, version: data.menu.version })
      });
      notify(`${MEAL_LABELS[mealType]}订单已提交`); await load();
    } catch (requestError) { notify(requestError.message || '订单提交失败'); if (requestError.status === 409) await load(); }
    finally { setBusy(''); }
  }

  const items = data?.items || [];
  const orders = data?.orders || [];
  const basis = data?.currentRuleBasis || data?.menu?.ruleBasis || {};
  const savedBasis = data?.menu?.ruleBasis?.generatedRuleBasis || data?.menu?.ruleBasis || {};
  const canOrder = (mealType) => data?.status === 'ready' && !data.currentReviewRequired
    && basis.effectiveHealthConstraints?.conflictState === 'clear'
    && items.filter(item => item.mealType === mealType && item.dish && !item.currentlyRestricted).length === 3;
  return <>{confirmation}<PageTitle eyebrow="MY MEALS" title="每日膳食" desc="按上海业务日期查看已保存餐单；菜品、配方与供货标记均为演示资料，不代表真实库存或营养检测。" action={<button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新　↻</button>}/>
    <section className="surface meal-toolbar"><label>服务日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label><span>时区：Asia/Shanghai</span></section>
    <MealRestrictionReview notify={notify} onChanged={load}/>
    {loading ? <section className="surface"><QueryState text="正在读取服务端餐单…"/></section> : error ? <section className="surface"><QueryState error text={error} retryText="餐单加载失败"/><button className="outline-btn" type="button" onClick={load}>重试</button></section> : data?.status === 'needs_generation' ? <section className="surface meal-empty"><div className="meal-empty-icon">◒</div><h2>此日期暂无已保存餐单</h2><p>系统不会复制其他日期的餐单。生成前会按当前已记录的过敏与饮食限制筛选；限制信息未确认时会明确提示。</p><button type="button" className="primary-btn" disabled={busy === 'generate'} onClick={generate}>{busy === 'generate' ? '生成中…' : '生成此日期餐单'}</button></section> : <>
      {basis.notices?.length > 0 && <section className="meal-notices" aria-label="健康信息提示">{basis.notices.map((notice, index) => <p key={`${notice.code}-${index}`} role="status"><strong>待核对</strong>{notice.text}</p>)}</section>}
      {data.currentReviewRequired && <section className="meal-notices"><p role="status"><strong>餐单待复核</strong>当前有效健康限制与上次核对时不同。请先完成医护核对，再替换冲突餐位；已有订单还需要负责配餐员复核。</p><button type="button" className="outline-btn" disabled={Boolean(busy) || items.some(item => !item.dish || item.currentlyRestricted)} onClick={async () => { setBusy('review'); try { await request(`/meals/menus/${data.menu.id}/review`, { method: 'POST', body: JSON.stringify({ version: data.menu.version }) }); notify('当前餐位已核对'); await load(); } catch (err) { notify(err.message); } finally { setBusy(''); } }}>确认全部餐位符合当前限制</button></section>}
      {basis.supplyNote && <p className="meal-source-note">{basis.supplyNote}</p>}
      <section className="surface meal-source-note" aria-label="餐单推荐方式" data-menu-id={data.menu.id}><strong>{savedBasis.recommendationPolicy?.label || '目录规则餐单（历史版本）'}</strong><p>{savedBasis.recommendationPolicy?.description || '历史餐单保留原选择；未记录轮换规则版本。'} AI协作建议为另行保存的候选，未采纳或未提交不代表已点餐。此餐单只有点击提交订单后才创建配餐订单。</p><small>第 {data.menu.version} 版 · {savedBasis.recommendationPolicy?.version || '历史版本未记录'}</small><SourceDetails><small>餐单编号 {data.menu.id}</small></SourceDetails></section>
      <div className="meal-day-grid">{['breakfast', 'lunch', 'dinner'].map(mealType => {
        const mealItems = items.filter(item => item.mealType === mealType);
        const currentOrder = orders.find(item => item.mealType === mealType);
        return <section className="surface meal-card" key={mealType} data-meal-type={mealType}>
          <header><div><span className="eyebrow">{date}</span><h2>{MEAL_LABELS[mealType]}</h2></div><span className={`meal-state ${data.status}`}>{data.status === 'ready' ? '已生成' : '部分待补充'}</span></header>
          <div className="meal-items">{mealItems.map(item => <article className="meal-item" key={item.id} data-meal-item-id={item.id}>
            <div className="meal-item-heading"><strong>{SLOT_LABELS[item.slot]}</strong><span>{item.dish ? '演示可供' : '待配餐员补充'}</span></div>
            {item.dish ? <><h3>{item.dish.name}</h3><p><b>明确食材：</b>{item.dish.ingredients?.join('、') || '未提供'}</p><p><b>明确过敏原：</b>{mealFoodLabels(item.dish.allergens).join('、') || '未列出'}</p><p><b>演示标签：</b>{item.dish.nutritionLabels?.join('；') || '无'}</p><p className="meal-selection-reason"><b>选择/替换原因：</b>{item.selectionReason || '历史餐位未记录选择理由；不重新生成或覆盖人工选择。'}</p>{item.currentlyRestricted && <p className="meal-missing" role="status">此菜品与当前限制或供应状态不符，已暂停点餐，请联系配餐员。</p>}</> : <p className="meal-missing" role="status">{item.selectionReason || '没有符合当前限制的菜品，未填入替代菜。'}</p>}
            {editingId === item.id ? <div className="meal-swap-form"><label>替换菜品<select value={swap.dishId} onChange={event => setSwap({ ...swap, dishId: event.target.value })}><option value="">请选择符合当前限制的菜品</option>{(item.eligibleReplacements || []).map(dish => <option value={dish.id} key={dish.id}>{dish.name} · 演示供货</option>)}</select></label><small>替代项已按当前供应、餐次、餐位与有效限制筛选；人工选择不会在刷新时被轮换覆盖。</small><label>替换原因<textarea aria-label="替换原因" value={swap.reason} maxLength={300} onChange={event => setSwap({ ...swap, reason: event.target.value })} placeholder="请说明替换原因"/></label><div><button className="primary-btn" type="button" disabled={busy === item.id || !swap.dishId || !swap.reason.trim()} onClick={() => replace(item)}>{busy === item.id ? '保存中…' : '确认替换'}</button><button className="text-btn" type="button" onClick={() => { setEditingId(''); setSwap({ dishId: '', reason: '' }); }}>取消</button></div>{!item.eligibleReplacements?.length && <small role="status">当前没有可确认的安全替换项，请联系配餐员。</small>}</div> : <button className="outline-btn meal-swap-trigger" type="button" disabled={!item.eligibleReplacements?.length || Boolean(currentOrder && (currentOrder.status === 'delivered' || (currentOrder.status === 'preparing' && !currentOrder.reviewRequired)))} onClick={() => { setEditingId(item.id); setSwap({ dishId: '', reason: '' }); }}>{currentOrder?.status === 'preparing' && !currentOrder.reviewRequired ? '订单备餐中，联系配餐员' : currentOrder?.status === 'delivered' ? '订单已送达，不可替换' : '替换此餐位'}</button>}
          </article>)}</div>
          {currentOrder ? <div className={`meal-order-status ${currentOrder.fulfillmentStatus}`} role="status" data-order-id={currentOrder.id}><span>订单号 {currentOrder.orderNo}</span><strong>{currentOrder.reviewRequired ? '须复核 · 暂停推进' : ORDER_STATUS_LABELS[currentOrder.status]}</strong>{currentOrder.reviewReasons?.map(reason => <small key={reason}>{reason}</small>)}{currentOrder.review && <small>最近核对：{currentOrder.review.checkedName} · {currentOrder.review.note}</small>}<small>提交时间（上海时间）：{mealLocalTime(currentOrder.createdAt)}</small><MealOrderTiming order={currentOrder}/></div> : <button type="button" className="primary-btn meal-order-btn" disabled={!canOrder(mealType) || Boolean(busy)} onClick={() => order(mealType)}>{busy === `order-${mealType}` ? '提交中…' : `提交${MEAL_LABELS[mealType]}订单`}</button>}
        </section>;
      })}</div>
      <section className="surface meal-avoidance"><h2>生成餐单时的限制</h2><MealConstraintList constraints={(data.menu.ruleBasis.generatedRuleBasis || data.menu.ruleBasis).rawHealthConstraints || (data.menu.ruleBasis.generatedRuleBasis || data.menu.ruleBasis).effectiveHealthConstraints} emptyText="生成时未列出明确限制；这是历史快照。"/><h2>当前有效食物限制</h2><MealConstraintList constraints={basis.effectiveHealthConstraints} emptyText="当前未列出明确食物限制；未回答与不确定状态见上方提示。"/>{basis.nonFoodRestrictions?.map((item, index) => <p key={index}>保留原文“{item.value}”：医护人工核对为非食物描述 · {basis.restrictionReview?.reviewerName} · {basis.restrictionReview?.note}</p>)}</section>
    </>}
  </>;
}
