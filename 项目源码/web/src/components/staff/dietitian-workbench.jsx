import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../../lib/request.js';
import { businessToday, mealLocalTime } from '../../lib/date.js';
import { PageTitle, QueryState } from '../../shared/ui.jsx';
import { SourceDetails } from '../../SourceDetails.jsx';
import { MEAL_LABELS, SLOT_LABELS, ORDER_STATUS_LABELS, mealFoodLabels, mealSourceLabel, mealRestrictionStatusLabel, MealOrderTiming, MealRestrictionReview } from '../guest/meals.jsx';

export function DietitianMealWorkbench({ notify }) {
  const [date, setDate] = useState(businessToday);
  const [mealType, setMealType] = useState('breakfast');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [reviewNotes, setReviewNotes] = useState({});
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ date, mealType });
      setOrders(await request(`/staff/meals/orders?${query}`));
    } catch (loadError) { setError(loadError.message || '备餐订单暂时无法加载'); }
    finally { setLoading(false); }
  }, [date, mealType]);
  useEffect(() => { load(); }, [load]);

  async function advance(order, status) {
    setBusyId(order.id);
    try {
      await request(`/staff/meals/orders/${encodeURIComponent(order.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      notify(status === 'preparing' ? '订单已标记为备餐中' : '订单已标记为送达'); await load();
    } catch (requestError) { notify(requestError.message || '订单状态更新失败'); if (requestError.status === 409) await load(); }
    finally { setBusyId(''); }
  }

  return <><PageTitle eyebrow="DIETITIAN WORKBENCH" title="备餐订单" desc="仅显示当前有效分工客人的日期、餐次、房间、餐品和明确限制；状态按已提交 → 备餐中 → 已送达推进。" action={<button className="outline-btn" type="button" onClick={load} disabled={loading}>刷新　↻</button>}/>
    <section className="surface meal-toolbar"><label>服务日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label><label>餐次<select value={mealType} onChange={event => setMealType(event.target.value)}>{['breakfast', 'lunch', 'dinner'].map(item => <option key={item} value={item}>{MEAL_LABELS[item]}</option>)}</select></label><span>业务日期与订单时刻均按上海时间显示</span></section>
    {loading ? <section className="surface"><QueryState text="正在加载授权范围内的订单…"/></section> : error ? <section className="surface"><QueryState error text={error} retryText="备餐订单加载失败"/><button className="outline-btn" type="button" onClick={load}>重试</button></section> : !orders.length ? <section className="surface meal-empty"><div className="meal-empty-icon">◒</div><h2>当前没有可备餐订单</h2><p>此列表只显示你当前有效分工客人的已提交订单。</p></section> : <div className="dietitian-orders">{orders.map(order => <article className="surface dietitian-order" key={order.id} data-testid={`stage26-meal-order-${order.id}`} data-order-id={order.id} data-guest-id={order.guestId} data-order-status={order.status}><header><div><span className="eyebrow">{order.businessDate} · {MEAL_LABELS[order.mealType]}</span><h2>{order.guestName} <small>房间 {order.roomNo || '未登记'}</small></h2><p>订单号 {order.orderNo} · 提交时间（上海时间）{mealLocalTime(order.createdAt)}</p><SourceDetails data={order}/><MealOrderTiming order={order}/></div><strong className={`meal-state ${order.fulfillmentStatus}`}>{order.reviewRequired ? '须复核 · 暂停推进' : ORDER_STATUS_LABELS[order.status]}</strong></header><p className="meal-source-note">{order.dishes[0]?.sourceReference || '演示菜品资料'} 供货状态不代表实时库存或履约。</p><div className="dietitian-dishes">{order.dishes.map(dish => <div key={`${dish.slot}-${dish.dishId}`}><span>{SLOT_LABELS[dish.slot]}</span><strong>{dish.name}</strong><small>明确食材：{mealFoodLabels(dish.ingredients).join('、') || '未提供'} · 明确过敏原：{mealFoodLabels(dish.allergens).join('、') || '未列出'}</small></div>)}</div><div className="dietitian-restrictions"><strong>当前明确限制及来源状态</strong>{order.explicitRestrictions?.length ? <ul>{order.explicitRestrictions.map((item, index) => <li key={`${item.source}-${item.sourceId}-${item.value}-${index}`}>{mealFoodLabels([item.value])[0]} · {mealSourceLabel(item.source)} · {mealRestrictionStatusLabel(item.status)}</li>)}</ul> : <p>无已记录的明确限制</p>}{order.reviewNotices?.map((notice, index) => <p role="status" key={`${notice.code}-${index}`}>{notice.text}</p>)}</div>{order.reviewRequired && <div className="dietitian-restrictions" role="status">{order.reviewReasons.map(reason => <p key={reason}>{reason}</p>)}<MealRestrictionReview guestId={order.guestId} notify={notify} onChanged={load}/><label>订单复核说明<textarea aria-label="订单复核说明" value={reviewNotes[order.id] || ''} maxLength={1000} onChange={event => setReviewNotes(current => ({ ...current, [order.id]: event.target.value }))}/></label><button type="button" className="outline-btn" disabled={Boolean(busyId) || !order.canReview || !reviewNotes[order.id]?.trim()} onClick={async () => { setBusyId(order.id); try { await request(`/staff/meals/orders/${order.id}/review`, { method: 'POST', body: JSON.stringify({ note: reviewNotes[order.id] }) }); notify('订单复核完成，可以继续推进'); await load(); } catch (err) { notify(err.message); await load(); } finally { setBusyId(''); } }}>确认当前订单符合限制</button></div>}{order.review && <p>最近核对：{order.review.checkedName} · {order.review.note}</p>}<footer>{order.status === 'reserved' && <button className="primary-btn" type="button" disabled={Boolean(busyId) || order.reviewRequired} onClick={() => advance(order, 'preparing')}>{busyId === order.id ? '保存中…' : '开始备餐'}</button>}{order.status === 'preparing' && <button className="primary-btn" type="button" disabled={Boolean(busyId) || order.reviewRequired} onClick={() => advance(order, 'delivered')}>{busyId === order.id ? '保存中…' : '标记已送达'}</button>}</footer></article>)}</div>}
  </>;
}
