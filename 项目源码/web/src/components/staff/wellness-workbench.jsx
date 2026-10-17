import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../lib/request.js';
import { businessText, businessTime } from '../../../../shared/release-presentation.js';
import { initials } from '../../lib/normalize.js';
import { useQuery } from '../../lib/useQuery.js';
import { PageTitle, SectionHead, Empty, QueryState } from '../../shared/ui.jsx';
import { EnvironmentHistoryNote, AdoptedDomainSuggestions } from '../guest/schedule.jsx';
import { SourceDetails, BusinessReason } from '../../SourceDetails.jsx';

export function WellnessReviewWorkbench({ notify, initialDraftId = '', onInitialDraftOpened }) {
  const [mode, setMode] = useState('pending_review');
  const [guestId, setGuestId] = useState('');
  const [date, setDate] = useState('');
  const [risk, setRisk] = useState('');
  const [queue, setQueue] = useState({ items: [], counts: { pending: 0, complete: 0 } });
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [alternatives, setAlternatives] = useState({});
  const [selectedSlots, setSelectedSlots] = useState({});
  const [revisionReason, setRevisionReason] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ status: mode });
      if (guestId.trim()) params.set('guestId', guestId.trim());
      if (date) params.set('date', date);
      if (risk) params.set('risk', risk);
      const result = await request(`/staff/therapy-drafts?${params}`);
      setQueue(result);
      if (selectedId && !result.items.some(item => item.draftId === selectedId)) {
        setSelectedId(''); setDetail(null);
      }
    } catch (requestError) {
      setError(requestError.message || '疗程审核队列暂时无法加载');
      setQueue({ items: [], counts: { pending: 0, complete: 0 } });
    } finally { setLoading(false); }
  }, [mode, guestId, date, risk, selectedId]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const openDetail = useCallback(async draftId => {
    setSelectedId(draftId); setDetail(null); setAlternatives({}); setSelectedSlots({});
    setDetailLoading(true);
    try {
      const result = await request(`/staff/therapy-drafts/${encodeURIComponent(draftId)}`);
      setDetail(result);
      const activityItems = (result.items || []).filter(item => item.type === 'activity');
      const available = await Promise.all(activityItems.map(async item => {
        try {
          const data = await request(`/staff/therapy-drafts/${encodeURIComponent(draftId)}/alternatives?itemId=${encodeURIComponent(item.id)}`);
          return [item.id, data.alternatives || []];
        } catch { return [item.id, []]; }
      }));
      setAlternatives(Object.fromEntries(available));
    } catch (requestError) {
      notify(requestError.message || '疗程证据详情暂时无法加载');
      setSelectedId('');
    } finally { setDetailLoading(false); }
  }, [notify]);

  useEffect(() => {
    if (!initialDraftId || loading || !queue.items.some(item => item.draftId === initialDraftId)) return;
    if (selectedId === initialDraftId) return;
    void openDetail(initialDraftId);
    onInitialDraftOpened?.();
  }, [initialDraftId, loading, queue.items, selectedId, openDetail, onInitialDraftOpened]);

  async function act(action) {
    if (!detail || busy) return;
    const edits = Object.entries(selectedSlots).filter(([, slotId]) => slotId)
      .map(([itemId, slotId]) => ({ itemId, slotId, reason: revisionReason.trim() }));
    if (['revise', 'correct'].includes(action) && (!edits.length || !revisionReason.trim())) {
      notify('请选择至少一个真实时段，并填写具体修订原因'); return;
    }
    if (action === 'return' && !returnReason.trim()) { notify('请填写具体退回原因'); return; }
    setBusy(action);
    try {
      const version = detail.version;
      const key = `stage22:${action}:${detail.draftId}:${version}:${crypto.randomUUID()}`;
      const options = { headers: { 'Idempotency-Key': key }, body: JSON.stringify({ version }) };
      let result;
      if (action === 'revise') result = await request(`/staff/therapy-drafts/${detail.draftId}/revisions`, {
        method: 'PUT', ...options, body: JSON.stringify({ version, edits, reason: revisionReason.trim() }) });
      if (action === 'approve') result = await request(`/staff/therapy-drafts/${detail.draftId}/approve`, { method: 'POST', ...options });
      if (action === 'return') result = await request(`/staff/therapy-drafts/${detail.draftId}/return`, {
        method: 'POST', ...options, body: JSON.stringify({ version, reason: returnReason.trim() }) });
      if (action === 'correct') result = await request(`/staff/therapy-drafts/${detail.draftId}/correction`, {
        method: 'POST', ...options, body: JSON.stringify({ version, edits, reason: revisionReason.trim() }) });
      notify(action === 'approve' ? (result?.history?.some(event => event.action === 'approved_after_revision')
        ? '修改后的疗程已通过并在同一事务中激活预约' : '疗程已通过并在同一事务中激活预约')
        : action === 'return' ? '已退回并记录原因' : action === 'correct' ? '已保存纠正版、补偿原版本预约并激活新版本' : '修订已保存为新的待审版本');
      setRevisionReason(''); setReturnReason(''); setSelectedSlots({});
      await loadQueue();
      if (result?.draftId) await openDetail(result.draftId);
      else await openDetail(detail.draftId);
    } catch (requestError) {
      notify(requestError.message || '审核操作未完成');
      await openDetail(detail.draftId);
    } finally { setBusy(''); }
  }

  const items = queue.items || [];
  const canReviewCurrent = detail?.reviewStatus === 'pending_review';
  const canCorrectCurrent = detail?.reviewStatus === 'active';

  return <div className="wellness-review-workbench">
    <PageTitle eyebrow="CLINICIAN REVIEW" title="疗程审核" desc="按真实入住日期、风险和版本核对疗程证据；通过后才会在事务内创建实际项目预约。" action={<button type="button" className="outline-btn" onClick={loadQueue} disabled={loading}>刷新队列　↻</button>}/>
    <section className="surface wellness-review-filters">
      <div className="wellness-review-tabs" role="tablist" aria-label="疗程审核状态">
        <button type="button" role="tab" aria-selected={mode === 'pending_review'} className={mode === 'pending_review' ? 'active' : ''} onClick={() => setMode('pending_review')}>待审核 <b>{queue.counts?.pending || 0}</b></button>
        <button type="button" role="tab" aria-selected={mode === 'complete'} className={mode === 'complete' ? 'active' : ''} onClick={() => setMode('complete')}>已完成 <b>{queue.counts?.complete || 0}</b></button>
      </div>
      <form className="wellness-review-filter-grid" onSubmit={event => { event.preventDefault(); loadQueue(); }}>
        <label>客人编号<input value={guestId} onChange={event => setGuestId(event.target.value)} placeholder="按客人编号筛选"/></label>
        <label>入住日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label>
        <label>风险<select value={risk} onChange={event => setRisk(event.target.value)}><option value="">全部风险</option><option value="high">强制医护审核</option><option value="sampled">抽样审核</option><option value="standard">常规</option></select></label>
        <button type="submit" className="primary-btn small-btn" disabled={loading}>筛选</button>
      </form>
    </section>
    {error && <div className="project-form-error" role="alert">{error}</div>}
    <div className="wellness-review-layout">
      <section className="surface wellness-review-queue" aria-busy={loading}>
        <div className="wellness-review-list-head"><strong>{mode === 'pending_review' ? '待审核疗程' : '已处理疗程'}</strong><span>{items.length} 条</span></div>
        {loading ? <QueryState text="正在读取授权范围内的审核记录…"/> : items.length ? items.map(item => <button type="button" key={item.draftId} data-draft-id={item.draftId} className={`wellness-review-row ${selectedId === item.draftId ? 'selected' : ''}`} onClick={() => openDetail(item.draftId)}>
          <span className="wellness-review-avatar">{initials(item.guestName)}</span><span className="wellness-review-row-copy"><strong>{item.guestName} <small>{item.roomNo || '未分配房间'}</small></strong><span>版本 {item.version} · {item.stayStart} 至 {item.stayEnd}</span><span>{businessText(item.summary) || '暂无条目摘要'}</span><small>{item.generatedAt ? new Date(item.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '生成时间未记录'} · {item.itemCount} 项</small></span><span className={`wellness-risk ${item.riskLevel}`}>{item.riskLevel === 'high' ? '强制复核' : item.riskLevel === 'sampled' ? '抽样' : '常规'}</span>
        </button>) : <div className="wellness-review-empty"><Empty text={mode === 'pending_review' ? '当前没有待审核疗程' : '没有符合筛选条件的已完成记录'}/></div>}
      </section>
      <section className="wellness-review-detail" data-testid="wellness-review-detail" data-draft-id={detail?.draftId || ''} aria-busy={detailLoading || Boolean(busy)}>
        {detailLoading ? <div className="surface"><QueryState text="正在读取疗程版本、证据与审核历史…"/></div> : detail ? <>
          <section className="surface wellness-review-detail-head"><div><span className="eyebrow">第 {detail.version} 版</span><h2>{detail.guestName} · {detail.stayStart} 至 {detail.stayEnd}</h2><p>第 {detail.version} 版 · 生成于 {businessTime(detail.createdAt)}</p></div><span className={`wellness-review-status ${detail.reviewStatus}`}>{detail.reviewStatus === 'pending_review' ? '待审核' : detail.reviewStatus === 'active' ? '已激活' : detail.reviewStatus === 'auto_activated' ? '自动激活' : detail.reviewStatus === 'returned' ? '已退回' : detail.reviewStatus === 'corrected' ? '已纠正' : '已替代'}</span></section>
          {detail.reviewReason && <div className="wellness-review-reason"><b>最近审核原因：</b>{detail.reviewReason}</div>}
          <SourceDetails data={detail}/><EnvironmentHistoryNote history={detail.environmentHistory}/><AdoptedDomainSuggestions evidence={detail.evidence}/>
          <section className="surface"><div className="wellness-review-section-head"><SectionHead title="逐项证据"/><span>{detail.items?.length || 0} 项</span></div>
            {(detail.items || []).map(item => <article className="wellness-evidence-item" data-item-id={item.id} key={item.id}>
              <div className="wellness-evidence-title"><div><span>{item.type === 'activity' ? '活动' : item.type === 'meal' ? '餐食建议' : item.type === 'gap' ? '资料缺口' : '休息'}</span><h3>{item.title}</h3></div><b>{item.businessDate || item.date} {item.localStart ? `${item.localStart}–${item.localEnd}` : ''}</b></div>
              {['active','auto_activated','corrected','superseded'].includes(detail.reviewStatus) && <small className="stage21-reason-era">生成时记录：当前执行以关联预约与客人日程为准</small>}
              <BusinessReason value={item.reason}/><div className="wellness-evidence-tags"><span>状态：{businessText(item.status)}</span>{item.ruleIds?.map(rule => <span key={rule}>规则 {rule}</span>)}{item.environmentSnapshotId && <SourceDetails><p>环境 {item.environmentSnapshotId}</p></SourceDetails>}</div>
              {item.evidence?.healthRisk && <p className="wellness-evidence-risk">档案健康复核：{Object.entries(item.evidence.healthRisk).filter(([, value]) => value === true).map(([key]) => businessText(key)).join('、') || '当前未标记硬风险'}；证据来自服务端保存的档案与规则评估。</p>}
              <details className="wellness-evidence-sources"><summary>来源编号、规则理由与版本依据</summary>
                {item.sourceIds?.length ? <ul>{item.sourceIds.map((source, index) => <li key={`${source.type}:${source.id}:${index}`}><b>{source.type}:{source.id}</b> · {source.label || '来源标签未记录'}</li>)}</ul> : <p>无可验证来源编号，不能补造引用。</p>}
                {item.evidence?.rules?.length ? item.evidence.rules.map((rule, index) => <p key={`${rule.ruleId}-${index}`}>{rule.ruleId} · {rule.action} · {rule.reason}</p>) : <p>此条没有保存规则命中证据。</p>}
              </details>
              {item.type === 'activity' && canReviewCurrent && <label className="wellness-slot-choice">选择可用的真实替代时段<select value={selectedSlots[item.id] || ''} onChange={event => setSelectedSlots(current => ({ ...current, [item.id]: event.target.value }))}><option value="">保留当前建议</option>{(alternatives[item.id] || []).map(option => <option value={option.slotId} key={option.slotId}>{option.date} · {option.projectName} · {option.localStart}–{option.localEnd} · {option.location} · 余 {option.remaining}</option>)}</select><small>列表仅含数据库已有且经当前规则核对可预约的时段；保存修订不会占用名额。</small></label>}
              {item.type === 'activity' && canCorrectCurrent && <label className="wellness-slot-choice">纠正为另一时段<select value={selectedSlots[item.id] || ''} onChange={event => setSelectedSlots(current => ({ ...current, [item.id]: event.target.value }))}><option value="">保持当前时段</option>{(alternatives[item.id] || []).map(option => <option value={option.slotId} key={option.slotId}>{option.date} · {option.projectName} · {option.localStart}–{option.localEnd} · {option.location} · 余 {option.remaining}</option>)}</select></label>}
            </article>)}
          </section>
          {detail.reservations?.length > 0 && <section className="surface"><SectionHead title="关联预约"/><div className="wellness-reservation-list">{detail.reservations.map(item => <div key={item.id}><strong>{item.project_name}</strong><span>{item.business_date} {item.local_start}–{item.local_end} · {businessText(item.status)}</span><SourceDetails data={item}/></div>)}</div></section>}
          {(canReviewCurrent || canCorrectCurrent) && <section className="surface wellness-review-actions"><SectionHead title={canReviewCurrent ? '审核操作' : '版本纠正'}/><label>{canReviewCurrent ? '修订或退回原因' : '纠正原因'}<textarea aria-label={canReviewCurrent ? '修订或退回原因' : '纠正原因'} rows="3" value={revisionReason} onChange={event => setRevisionReason(event.target.value)} placeholder="记录依据、变更内容和需要注意的事实"/></label>
            <div className="wellness-action-buttons">{canReviewCurrent && <><button type="button" className="outline-btn" onClick={() => act('revise')} disabled={Boolean(busy) || !Object.values(selectedSlots).some(Boolean)}>{busy === 'revise' ? '保存中…' : '保存新待审版本'}</button><button type="button" className="primary-btn" onClick={() => act('approve')} disabled={Boolean(busy)}>{busy === 'approve' ? '激活中…' : detail.approvalAction === 'approved_after_revision' ? '修改后通过并激活' : '审核通过并激活'}</button></>}{canCorrectCurrent && <button type="button" className="primary-btn" onClick={() => act('correct')} disabled={Boolean(busy) || !Object.values(selectedSlots).some(Boolean)}>{busy === 'correct' ? '纠正中…' : '保存纠正版并重新激活'}</button>}</div>
            {canReviewCurrent && detail.approvalContext && <SourceDetails><small className="wellness-approval-context">此版本由医护修订事件 {detail.approvalContext.revisionEventId} 创建；第 {detail.approvalContext.fromVersion} 版 → 第 {detail.approvalContext.toVersion} 版。修订原因：{detail.approvalContext.revisionReason}</small></SourceDetails>}
            {canReviewCurrent && <label className="wellness-return-field">退回原因<textarea aria-label="退回原因" rows="2" value={returnReason} onChange={event => setReturnReason(event.target.value)} placeholder="说明退回项目和再次生成需要排除的原因"/></label>}
            {canReviewCurrent && <button type="button" className="wellness-return-button" onClick={() => act('return')} disabled={Boolean(busy) || !returnReason.trim()}>{busy === 'return' ? '退回中…' : '退回并要求重新生成'}</button>}
          </section>}
          <section className="surface"><div className="wellness-review-section-head"><SectionHead title="不可变审核历史"/><span>{detail.history?.length || 0} 条</span></div>{detail.history?.length ? <div className="wellness-history-list">{detail.history.map(event => <article key={event.id}><span className={`wellness-history-action ${event.action}`}>{({revision:'修订',approved:'通过',approved_after_revision:'修改后通过',returned:'退回',auto_activated:'自动激活',corrected:'纠正'})[event.action] || event.action}</span><div><strong>{event.actorName} · {businessText(event.actorRole)} · {event.createdAt ? new Date(event.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '时间未记录'}</strong><p>{event.reason || '未记录原因'} · 版本 {event.fromVersion ?? '—'} → {event.toVersion ?? '—'}</p></div></article>)}</div> : <Empty text="尚无审核事件"/>}</section>
        </> : <div className="surface wellness-review-no-selection"><div>✓</div><h2>选择一条疗程审核记录</h2><p>列表显示当前授权范围内的客人、入住日期、生成时间、风险和条目摘要。</p></div>}
      </section>
    </div>
  </div>;
}

export function WellnessHistoryWorkbench({ canOpenDetails, notify }) {
  const [guestId, setGuestId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [attention, setAttention] = useState([]);
  const [selectedDetail, setSelectedDetail] = useState(null);

  const { data: historyData, loading, error, load } = useQuery(async (signal) => {
    const params = new URLSearchParams();
    if (guestId.trim()) params.set('guestId', guestId.trim());
    if (action) params.set('action', action);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const history = await request(`/staff/therapy-review-history?${params}`, { signal });
    try {
      const flags = await request('/staff/therapy-review-attention', { signal });
      setAttention(flags.items || []);
    } catch { setAttention([]); }
    return history;
  }, [guestId, action, from, to], {
    fallbackMessage: '',
    onError: (loadError) => notify(loadError?.message || '审核历史暂时无法加载')
  });
  // 与原实现一致：初始未加载与加载失败都呈现空结果（G20 迁移曾丢失首帧空对象，
  // 使 result 为 null 并在读取 result.total 时崩溃）。
  const result = (error || !historyData) ? { items: [], total: 0 } : historyData;

  async function openVersion(draftId) {
    try { setSelectedDetail(await request(`/staff/therapy-drafts/${encodeURIComponent(draftId)}`)); }
    catch (loadError) { notify(loadError.message || '该版本当前不在你的授权范围内'); }
  }

  return <div className="wellness-history-workbench">
    <PageTitle eyebrow="REVIEW AUDIT" title="疗程审核历史" desc="只读查询医护修订、通过、退回、自动激活和纠正记录；历史事件不会被页面编辑。" action={<button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新　↻</button>}/>
    <section className="surface wellness-history-filters"><form className="wellness-review-filter-grid" onSubmit={event => { event.preventDefault(); load(); }}>
      <label>客人编号<input value={guestId} onChange={event => setGuestId(event.target.value)} placeholder="可留空查看授权范围"/></label>
      <label>审核动作<select value={action} onChange={event => setAction(event.target.value)}><option value="">全部动作</option><option value="revision">修订</option><option value="approved">通过</option><option value="approved_after_revision">修改后通过</option><option value="returned">退回</option><option value="auto_activated">自动激活</option><option value="corrected">纠正</option></select></label>
      <label>开始日期<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
      <label>结束日期<input type="date" value={to} onChange={event => setTo(event.target.value)}/></label>
      <button type="submit" className="primary-btn small-btn" disabled={loading}>查询</button>
    </form></section>
    {attention.length > 0 && <section className="surface wellness-history-attention"><SectionHead title="管理员待关注事项"/><div>{attention.map(item => <article key={item.id}><b>{item.guest_name}</b><span>{item.reason}</span><small>{item.created_at ? new Date(item.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : ''}</small></article>)}</div></section>}
    <section className="surface wellness-history-results"><div className="wellness-review-list-head"><strong>审核事件</strong><span>{result.total || 0} 条</span></div>{loading ? <QueryState text="正在读取不可变历史…"/> : result.items?.length ? result.items.map(item => <article className="wellness-history-row" key={item.id}>
      <span className={`wellness-history-action ${item.action}`}>{({revision:'修订',approved:'通过',approved_after_revision:'修改后通过',returned:'退回',auto_activated:'自动激活',corrected:'纠正'})[item.action] || item.action}</span>
      <div><strong>{item.guestName} · {item.actorName} · {businessText(item.actorRole)}</strong><p>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '时间未记录'} · 版本 {item.fromVersion ?? '—'} → {item.toVersion ?? '—'}</p><BusinessReason value={item.reason || '未记录原因'}/><SourceDetails><small>草案 {item.draftId} · 事件 {item.id}</small></SourceDetails></div>
      {canOpenDetails && <button type="button" className="outline-btn small-btn" onClick={() => openVersion(item.draftId)}>查看版本</button>}
    </article>) : <Empty text="没有符合条件的审核历史"/>}</section>
    {selectedDetail && <section className="surface wellness-history-version"><div className="wellness-review-section-head"><SectionHead title={`${selectedDetail.guestName} · 第 ${selectedDetail.version} 版`}/><button type="button" className="outline-btn small-btn" onClick={() => setSelectedDetail(null)}>关闭</button></div><p>父运行：{selectedDetail.evidence?.parentRunId || '无可验证来源运行'}</p>{selectedDetail.items?.map(item => <article key={item.id}><strong>{item.date} · {item.title}</strong><small className="stage21-reason-era">生成时记录</small><BusinessReason value={item.reason}/><SourceDetails><small>来源：{item.sourceIds?.map(source => `${source.type}:${source.id}`).join('、') || '未记录'}</small></SourceDetails></article>)}</section>}
  </div>;
}
