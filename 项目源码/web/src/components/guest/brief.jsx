import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../../lib/request.js';
import { mealLocalTime } from '../../lib/date.js';
import { businessText, businessTime, notificationCategory } from '../../lib/release-presentation.js';
import { wellnessTargetSection } from '../../app/navigation.js';
import { SourceDetails } from '../../SourceDetails.jsx';

export const WELLNESS_NOTIFICATION_EVENT = 'wellness-notifications-updated';

export function publishWellnessNotificationUpdate() {
  window.dispatchEvent(new Event(WELLNESS_NOTIFICATION_EVENT));
}

export function GuestDailyBrief({ me, go }) {
  const [briefState, setBriefState] = useState(null);
  const [notificationState, setNotificationState] = useState({ items: [], unreadCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [readingId, setReadingId] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [brief, notifications] = await Promise.all([
        request('/me/daily-brief'), request('/me/wellness-notifications')
      ]);
      setBriefState(brief);
      setNotificationState(notifications);
    } catch (loadError) {
      setError(loadError.message || '简报和提醒暂时无法加载');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active) void load(); };
    refresh();
    window.addEventListener(WELLNESS_NOTIFICATION_EVENT, refresh);
    return () => { active = false; window.removeEventListener(WELLNESS_NOTIFICATION_EVENT, refresh); };
  }, [load]);

  async function markRead(item) {
    if (!item || item.readAt || readingId) return;
    setReadingId(item.id);
    try {
      await request(`/me/wellness-notifications/${encodeURIComponent(item.id)}/read`, { method: 'PATCH', body: '{}' });
      publishWellnessNotificationUpdate();
      await load();
    } catch (readError) { setError(readError.message || '标记已读失败'); }
    finally { setReadingId(''); }
  }

  function openTarget(targetUrl) {
    const section = wellnessTargetSection(targetUrl);
    if (section) go(section);
  }

  const brief = briefState?.brief;
  return <div className="stage25-daily-grid">
    <section className="surface stage25-brief" aria-label="每日简报" data-testid="stage25-daily-brief">
      <header className="stage25-card-head"><div><span className="eyebrow">DAILY BRIEF · ASIA/SHANGHAI</span><h2>每日简报</h2></div>
        <span className="stage25-date">{briefState?.businessDate || '—'}</span></header>
      {loading ? <p className="stage25-muted" role="status">正在读取今日来源…</p>
        : error ? <p className="stage25-error" role="alert">{error}</p>
          : briefState?.status !== 'ready' ? <p className="stage25-muted" data-testid="stage25-brief-state">
            {briefState?.status === 'not_ready' ? '每日简报将在上海时间 07:00 生成。' : '今日简报尚未生成；缺少的来源不会用推测内容补齐。'}
          </p> : <>
            <div className="stage25-greeting"><strong>{brief.greeting}</strong><span>{brief.stay?.label}</span></div>
            <div className="stage25-brief-section" data-testid="stage25-activity-schedule"><div className="stage25-section-title"><strong>今日活动</strong><button type="button" onClick={() => openTarget('reservations')}>查看预约 →</button></div>
              {brief.activities?.length ? brief.activities.map(item => <article className="stage25-plan-row" key={item.reservationId} data-source-id={item.reservationId}>
                <span>{item.localStart}–{item.localEnd}</span><div><strong>{item.projectName}</strong><SourceDetails><small>{item.businessDate} · 预约 {item.reservationId} · {item.location || '地点待核对'}</small></SourceDetails></div>
                <button type="button" aria-label={`查看预约 ${item.reservationId}`} onClick={() => openTarget(item.targetUrl)}>查看</button>
              </article>) : <p className="stage25-muted">当天没有已确认的活动预约。</p>}
            </div>
            <div className="stage25-meals" data-testid="stage25-meal-schedule">{brief.meals?.map(meal => <article className="stage25-meal-row" key={meal.mealType}>
              <div><strong>{meal.label}</strong><small>{meal.items?.length ? meal.items.join('、') : meal.missingNote || '尚无已保存安排'}</small></div>
              <button type="button" onClick={() => openTarget(meal.targetUrl)}>查看膳食</button>
            </article>)}</div>
            <div className="stage25-brief-columns">
              <section><div className="stage25-section-title"><strong>医护建议</strong><button type="button" onClick={() => openTarget('advice')}>查看来源 →</button></div>
                {brief.advice?.length ? brief.advice.slice(0, 3).map(item => <article className="stage25-advice-row" key={item.id} data-source-id={item.id}><strong>{item.title}</strong><p>{item.content}</p><small>{item.authorName || '工作人员'}</small><SourceDetails><small>来源 ID {item.id}</small></SourceDetails></article>) : <p className="stage25-muted">当前没有已发布的医护建议。</p>}
              </section>
              <section><div className="stage25-section-title"><strong>当前选用环境资料</strong></div>
                <ul className="stage25-source-list">{(briefState.currentEnvironment || brief.environment)?.map(item => <li key={item.domain} data-source-id={item.sourceId || ''}>
                  <span>{item.domain === 'weather' ? '天气' : item.domain === 'tide' ? '潮汐' : '海况'}</span>
                  <div><strong>{item.available ? item.summary : item.missingNote}</strong>{item.available && <small>{item.sourceName}</small>}</div>
                </li>)}</ul>
              </section>
            </div>
            {briefState.generatedBrief && <details className="stage25-missing" data-testid="brief-environment-history"><summary>生成时环境（历史快照，保持原件）</summary><p>生成时间 {mealLocalTime(briefState.generatedAt)} · 当前对照地点 {briefState.environmentContext?.currentLocation?.name || '未配置'}；旧来源与当前不同不会回写旧简报。</p><ul>{briefState.generatedBrief.environment?.map(item=><li key={item.domain}>{({weather:'天气',tide:'潮汐',marine:'海况'})[item.domain]}：原来源 {item.sourceId || '当时缺失'} · 原摘要 {String(item.summary || item.missingNote || '当时资料未记录').replaceAll('unknown','当时分级未设置').replaceAll('global mean sea level','全球平均海平面')}</li>)}</ul></details>}
            {brief.careItems?.length > 0 && <section className="stage25-care-list" data-testid="stage25-care-items"><div className="stage25-section-title"><strong>关怀与安排变动</strong><button type="button" onClick={() => openTarget('mood')}>查看心情记录 →</button></div>
              {brief.careItems.map(item => <article key={`${item.sourceType}:${item.sourceId}`} data-source-id={item.sourceId}>
                <div><strong>{item.title}</strong><p>{item.message}</p><SourceDetails><small>{item.sourceLabel} · 来源 ID {item.sourceId}</small></SourceDetails></div>
                <button type="button" onClick={() => openTarget(item.targetUrl)}>查看</button>
              </article>)}
            </section>}
            {brief.missing?.length > 0 && <details className="stage25-missing"><summary>资料缺项（{brief.missing.length}）</summary><ul>{brief.missing.map(item => <li key={item}>{item}</li>)}</ul></details>}
            <div className="stage25-brief-footer"><span>入住日期 {brief.stay?.checkIn || '待核对'} · 来源均可追溯</span><button type="button" onClick={() => void load()}>刷新简报</button></div>
          </>}
    </section>
    <section className="surface stage25-notification-center" aria-label="站内提醒" data-testid="stage25-notification-center">
      <header className="stage25-card-head"><div><span className="eyebrow">INBOX · IN-APP</span><h2>站内提醒</h2></div>
        <span className="stage25-unread-count" aria-label={`未读 ${notificationState.unreadCount || 0} 条`}>{notificationState.unreadCount || 0} 未读</span></header>
      {error && <p className="stage25-error" role="alert">{error}</p>}
      {notificationState.items?.length ? <ul className="stage25-notification-list">{notificationState.items.slice(0, 8).map(item => <li key={item.id}
        className={item.readAt ? 'read' : 'unread'} data-testid={`stage25-notice-${item.id}`} data-notification-id={item.id} data-source-id={item.sourceId} data-target-type={item.targetType} data-target-id={item.targetId} data-target-url={item.targetUrl}>
        <div><strong>{businessText(item.message)}</strong><small>{notificationCategory(item).label} · {businessTime(item.createdAt)}</small><SourceDetails data={item}/></div>
        <div className="stage25-notification-actions"><button type="button" onClick={() => openTarget(item.targetUrl)}>打开</button>
          {!item.readAt && <button type="button" disabled={readingId === item.id} onClick={() => void markRead(item)}>{readingId === item.id ? '保存中…' : '标为已读'}</button>}
        </div>
      </li>)}</ul> : <p className="stage25-muted">暂无站内提醒。</p>}
      <p className="stage25-notification-note">站内提醒会保留在这里。浏览器关闭时不会继续推送。</p>
    </section>
  </div>;
}
