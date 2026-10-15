import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../lib/request.js';
import { businessToday, mealLocalTime, slotDateLabel } from '../../lib/date.js';
import { checkinAvailability, businessText, businessTime, notificationCategory } from '../../../../shared/release-presentation.js';
import { PageTitle, SectionHead, Empty } from '../../shared/ui.jsx';
import { STAFF_JOB_LABELS } from '../../app/navigation.js';
import { SourceDetails, BusinessReason } from '../../SourceDetails.jsx';
import { reservationStatusLabel, cancellationReasonLabel } from './projects.jsx';

const WELLNESS_FEELING_LABELS = { comfortable: '舒服', general: '一般', uncomfortable: '不舒服' };

function CheckinFeedbackCard({ item, onCheckin, onFeedback, busy }) {
  const [feeling, setFeeling] = useState(item.feedback?.feeling || 'general');
  const [note, setNote] = useState(item.feedback?.note || '');
  useEffect(() => {
    setFeeling(item.feedback?.feeling || 'general');
    setNote(item.feedback?.note || '');
  }, [item.feedback?.id, item.feedback?.revision, item.feedback?.updatedAt]);
  const clockAnchor = useRef({server: item.serverNow, started: performance.now()});
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { clockAnchor.current={server:item.serverNow,started:performance.now()}; setElapsed(0); const timer=setInterval(()=>setElapsed(performance.now()-clockAnchor.current.started),1000); return ()=>clearInterval(timer); },[item.serverNow]);
  const serverInstant=Date.parse(clockAnchor.current.server);
  const checkinWindow=Number.isFinite(serverInstant)?checkinAvailability(item,new Date(serverInstant+elapsed).toISOString()):{canCheckin:false,checkinNote:'开始时间待核对，请刷新或联系工作人员'};
  const feedbackCanEdit = !item.feedback || item.feedback.businessDate === businessToday();
  return <article className="q24-execution-card" data-testid={`q24-appointment-${item.reservationId}`}>
    <div className="q24-execution-main"><div><span className="eyebrow">项目执行 · {item.businessDate}</span><h3>{item.projectName}</h3>
      <p>{item.localStart}–{item.localEnd} · {item.location || '地点待核对'}</p></div>
      <span className={`q24-state ${item.reservationStatus}`}>{item.reservationStatus === 'confirmed' ? '预约有效' : item.reservationStatus === 'no_show' ? '未参加' : '已取消'}</span>
    </div>
    {item.executions?.map(entry => <p className="health-review-note" role="status" key={entry.id}>{STAFF_JOB_LABELS[entry.jobType]}：{entry.status === 'completed' ? '服务已完成' : '已登记未参加'} · {entry.actorName} · {entry.note}</p>)}
    {item.checkin ? <div className="q24-checkin-saved" role="status"><strong>已签到</strong><span>{mealLocalTime(item.checkin.checkedInAt)}</span></div>
      : <div className="q24-checkin-action"><span>{checkinWindow.checkinNote}</span>
        <button type="button" className="primary-btn small-btn" data-testid={`q24-checkin-${item.reservationId}`}
          disabled={busy || !checkinWindow.canCheckin} onClick={() => onCheckin(item.reservationId)}>
          {busy ? '正在签到…' : '签到'}</button></div>}
    {item.checkin && <form className="q24-feedback-form" data-testid={`q24-feedback-${item.reservationId}`}
      onSubmit={event => { event.preventDefault(); onFeedback(item, { feeling, note }); }}>
      <div className="q24-feedback-head"><div><strong>项目后的感受</strong><span>{item.feedback ? `反馈第 ${item.feedback.revision} 版` : '你的记录只关联这次真实签到'}</span></div>
        {item.feedback && <small>{feedbackCanEdit ? '上海时间今天可修改' : `已过修改时段 · ${item.feedback.businessDate}`}</small>}</div>
      <label>感受<select aria-label={`${item.projectName}的项目感受`} value={feeling} onChange={event => setFeeling(event.target.value)} disabled={!feedbackCanEdit || busy}>
        <option value="comfortable">舒服</option><option value="general">一般</option><option value="uncomfortable">不舒服</option>
      </select></label>
      <label>补充说明<textarea aria-label="补充说明" rows="2" maxLength={500} value={note} onChange={event => setNote(event.target.value)}
        placeholder="可以简短记录身体感受" disabled={!feedbackCanEdit || busy}/></label>
      {feedbackCanEdit && <button type="submit" className="outline-btn small-btn" disabled={busy}>{busy ? '保存中…' : item.feedback ? '保存当天修改' : '保存感受'}</button>}
      {item.feedback?.revisions?.length > 1 && <details className="q24-feedback-history"><summary>修改记录（{item.feedback.revisions.length} 版）</summary>
        <ol>{item.feedback.revisions.map(revision => <li key={revision.id || revision.revision}>第 {revision.revision} 版 · {WELLNESS_FEELING_LABELS[revision.feeling]} · {revision.businessDate} · {revision.note || '无补充说明'}</li>)}</ol>
      </details>}
    </form>}
    <SourceDetails data={item}/>
  </article>;
}

function ReplanEventCard({ item, onEvaluate, busy }) {
  const changes = item.changes || [];
  return <article className="q24-replan-card" data-testid={`q24-replan-${item.id}`}>
    <header><div><span className="eyebrow">可追溯的调整来源</span><h3>{businessText(item.sourceLabel)}</h3>
      <p>{businessText(item.sourceType)} · 来源版本 {item.sourceVersion} · 记录于 {mealLocalTime(item.createdAt)}</p></div>
      <span className={`q24-state ${item.status}`}>{item.candidateStatus === 'active' || item.candidateStatus === 'auto_activated' ? '候选已激活' : item.candidate ? '候选待审核' : item.requiresAttention ? '待评估' : '已记录'}</span>
    </header>
    {item.triggerReason && <BusinessReason value={item.triggerReason}/>}
    {item.requiresAttention && !item.candidate && <button type="button" className="primary-btn small-btn" data-testid={`q24-evaluate-${item.id}`}
      disabled={busy} onClick={() => onEvaluate(item.id)}>{busy ? '正在生成候选…' : '生成待审核候选'}</button>}
    {item.candidate && <div className="q24-diff-card" data-testid={`q24-diff-${item.id}`}>
      <div className="q24-diff-head"><strong>方案差异</strong><span>原版 {item.baseline ? `第 ${item.baseline.version} 版` : '暂无已激活版本'} → 候选第 {item.candidate.version} 版</span></div>
      <p>来源依据：{businessText(item.sourceType)} · 版本 {item.sourceVersion}。候选在审核完成前不会替换当前疗程或预约。</p>
      {changes.length ? <div className="q24-diff-list">{changes.map(change => <div className={`q24-diff-row ${change.kind}`} key={change.key}>
        <span>{change.kind === 'added' ? '新增' : change.kind === 'removed' ? '移除' : '调整'}</span>
        <div><small>原安排</small><strong>{change.original ? `${change.original.businessDate} ${change.original.localStart || ''} ${change.original.title}` : '无'}</strong></div>
        <div><small>候选安排</small><strong>{change.candidate ? `${change.candidate.businessDate} ${change.candidate.localStart || ''} ${change.candidate.title}` : '无'}</strong></div>
      </div>)}</div> : <div className="q24-no-diff">两个版本的已保存条目相同；保留原版与候选编号供审核比较。</div>}
      <div className="q24-diff-footer"><span>原版有效预约：{item.activeReservations?.length || 0} 条</span><span>候选状态：{businessText(item.candidate.reviewStatus)}</span></div>
    </div>}
    <SourceDetails data={item}/>
  </article>;
}

export function EnvironmentHistoryNote({ history }) {
  if (!history) return null;
  return <section className="stage21-draft-notice" data-testid="environment-history">
    <strong>生成时环境 · 历史快照</strong><p>{history.notice}</p>
    <p>生成时间：{mealLocalTime(history.generatedAt)}（上海时间）；旧版来源/规则理由保留。</p>
    {history.generated?.map((old,index)=><p key={old.snapshotId||index}>原地点：{old.location?.name || old.location?.id || '当时地点未记录'} · 原状态：{({available:'当时资料可用',unavailable:'当时来源不可用',stale:'当时资料已过期',demo:'当时为合成资料'})[old.status] || '见原规则理由，未记录的不推测'}</p>)}
    <strong>{history.changed ? '当前地点或来源已不同，请重新评估' : '当前来源对照（不更新旧版）'}</strong>
    {history.current?.map(now=><p key={now.targetDate}>{now.targetDate} · {now.location?.name || '当前地点未配置'} · {({available:'当前选中点可用',demo:'当前合成示例',stale:'当前资料过期',unavailable:'当前资料不可用'})[now.status] || '当前资料待核对'} · 当前来源另列，不是原草案结论。</p>)}
    <p>需要重新评估时，客人使用上方“生成新版本草案”，医护使用待审版本的“保存新待审版本”；读取此说明不会生成、批准或预约。</p><SourceDetails data={history}/>
  </section>;
}

export function AdoptedDomainSuggestions({ evidence, onSelectResource }) {
  if (!evidence?.selectedSuggestions?.length) return null;
  const names = { physio:'理疗', nutrition:'营养', exercise:'运动', psychology:'心理陪伴' };
  return <section className="surface" data-testid="adopted-domain-suggestions"><SectionHead title="生成时的领域建议（原始来源）"/>
    {evidence.executionMode === 'recorded_fixture' && <p className="release-boundary">录制合成模型工具演练 · 不是真实模型输出，也不代表正式业务验收通过。</p>}<SourceDetails data={{parentRunId:evidence.parentRunId,sessionId:evidence.sessionId||evidence.adoption?.sessionId}}/>
    <p>这些是生成时的只读建议，原文保留。当前是否已激活、预约或送达，请以本页当前审核状态和实际业务记录为准；原文不随执行状态改写。</p>
    {evidence.selectedSuggestions.map(suggestion => <article key={suggestion.candidateId} data-suggestion-domain={suggestion.domain}>
      <strong>{names[suggestion.domain] || suggestion.domain} · {suggestion.title}</strong><BusinessReason value={suggestion.reason}/>
      {suggestion.domain === 'psychology' && suggestion.details?.audioUrl && onSelectResource && <button type="button" className="outline-btn" onClick={() => onSelectResource({id:suggestion.details.resourceId,title:suggestion.title,audioUrl:suggestion.details.audioUrl,durationSeconds:suggestion.details.durationSeconds,type:'guided'})}>打开陪伴资源</button>}
      <details><summary>领域来源</summary><p>候选 {suggestion.candidateId} · 专业运行 {suggestion.childRunId}</p>{suggestion.sourceIds.map((source,index) => <p key={`${source.type}:${source.id}:${index}`}>{source.label || source.type} · {source.type}:{source.id}</p>)}</details>
    </article>)}
  </section>;
}

export function GuestSchedule({ me, onSelectResource }) {
  const [timeline, setTimeline] = useState(null);
  const [checkins, setCheckins] = useState([]);
  const [replanEvents, setReplanEvents] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [workingId, setWorkingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const profile = me?.profile || {};
  const stayStart = String(profile.checkIn || profile.check_in || '').slice(0, 10);
  const stayEnd = String(profile.checkOut || profile.check_out || '').slice(0, 10);
  const stayValid = /^\d{4}-\d{2}-\d{2}$/.test(stayStart) && /^\d{4}-\d{2}-\d{2}$/.test(stayEnd) && stayEnd > stayStart;
  const scheduleGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++scheduleGeneration.current;
    setLoading(true); setError('');
    try {
      const [nextTimeline, nextDrafts, nextNotifications, nextCheckins, nextReplanEvents] = await Promise.all([
        request('/me/timeline'),
        request(`/me/therapy-drafts${stayValid ? `?stayStart=${encodeURIComponent(stayStart)}&stayEnd=${encodeURIComponent(stayEnd)}` : ''}`),
        request('/me/wellness-notifications'), request('/me/checkins'), request('/me/replanning-events')
      ]);
      if (generation !== scheduleGeneration.current) return;
      setTimeline(nextTimeline); setDrafts(nextDrafts.items || []); setNotifications(nextNotifications.items || []);
      setCheckins(nextCheckins.items || []); setReplanEvents(nextReplanEvents.items || []);
    } catch (requestError) { if (generation === scheduleGeneration.current) setError(requestError.message || '日程暂时无法加载'); }
    finally { if (generation === scheduleGeneration.current) setLoading(false); }
  }, [stayStart, stayEnd, stayValid]);
  useEffect(() => { load(); }, [load]);

  async function createDraft() {
    if (generating || !stayValid) return;
    setGenerating(true); setError(''); setNotice('');
    try {
      const returnedDraft = drafts.find(item => item.reviewStatus === 'returned');
      const result = await request('/me/therapy-drafts', { method: 'POST',
        headers: { 'Idempotency-Key': `stage22:${crypto.randomUUID()}` },
        body: JSON.stringify(returnedDraft ? { regenerateFromDraftId: returnedDraft.draftId } : {}) });
      setNotice(result.reviewStatus === 'auto_activated' || result.reviewStatus === 'active'
        ? `第 ${result.version} 版低风险疗程已激活；有效活动预约已加入日程。`
        : returnedDraft ? `已根据第 ${returnedDraft.version} 版退回原因重新生成第 ${result.version} 版；请核对新的项目与证据。`
          : `已保存第 ${result.version} 版疗程草案，正在等待医护审核。待审草案不会创建预约或占用时段名额。`);
      await load();
    } catch (requestError) { setError(requestError.message || '疗程草案生成失败，请保留页面后重试'); }
    finally { setGenerating(false); }
  }

  async function checkIn(reservationId) {
    setWorkingId(`checkin:${reservationId}`); setError(''); setNotice('');
    try {
      const result = await request(`/me/reservations/${encodeURIComponent(reservationId)}/checkin`, { method: 'POST', body: '{}' });
      setNotice(`已签到；重复操作不会重复登记。`);
      await load();
    } catch (requestError) { setError(requestError.message || '签到未能保存，请核对预约开始时间'); }
    finally { setWorkingId(''); }
  }

  async function saveFeedback(item, body) {
    setWorkingId(`feedback:${item.reservationId}`); setError(''); setNotice('');
    try {
      const route = item.feedback
        ? `/me/feedback/${encodeURIComponent(item.feedback.id)}`
        : `/me/reservations/${encodeURIComponent(item.reservationId)}/feedback`;
      const result = await request(route, { method: item.feedback ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setNotice(`已保存这次项目的第 ${result.revision} 版反馈。`);
      await load();
    } catch (requestError) { setError(requestError.message || '反馈未能保存，请刷新后重试'); }
    finally { setWorkingId(''); }
  }

  async function evaluateEvent(eventId) {
    setWorkingId(`replan:${eventId}`); setError(''); setNotice('');
    try {
      const result = await request(`/me/replanning-events/${encodeURIComponent(eventId)}/evaluate`, { method: 'POST', body: '{}' });
      setNotice(`已生成第 ${result.candidate?.version || '新'} 版待审疗程；请联系负责医护，当前预约在审核前保持不变。`);
      await load();
    } catch (requestError) { setError(requestError.message || '候选疗程生成失败'); }
    finally { setWorkingId(''); }
  }

  const formatSources = sources => [...new Set((sources || []).map(source => `${source.type}:${source.id}`))];
  const historicalDraft = draft => ['active', 'auto_activated', 'corrected', 'superseded'].includes(draft.reviewStatus);
  const renderDraft = draft => {
    const eraLabel = historicalDraft(draft);
    const byDate = new Map();
    for (const item of draft.items || []) {
      if (!byDate.has(item.businessDate)) byDate.set(item.businessDate, []);
      byDate.get(item.businessDate).push(item);
    }
    return <article className="stage21-draft-card" key={draft.draftId} data-draft-id={draft.draftId}>
      <header><div><span className="eyebrow">WELLNESS DRAFT · VERSION {draft.version}</span><h2>{draft.stayStart} 至 {draft.stayEnd}（离店日不排入）</h2><p>第 {draft.version} 版 · 生成于 {businessTime(draft.createdAt)}</p></div><span className={`stage21-status ${draft.reviewStatus === 'active' || draft.reviewStatus === 'auto_activated' ? 'active' : draft.reviewStatus === 'returned' ? 'returned' : 'pending'}`}>{draft.reviewStatus === 'active' ? '医护已通过 · 已激活' : draft.reviewStatus === 'auto_activated' ? '低风险自动激活' : draft.reviewStatus === 'returned' ? '已退回 · 请重新生成' : draft.reviewStatus === 'corrected' ? '医护已纠正 · 查看新版本' : draft.reviewStatus === 'superseded' ? '已有更新版本' : '等待医护审核'}</span></header>
      <div className="stage21-draft-notice">{draft.reviewStatus === 'active' || draft.reviewStatus === 'auto_activated' ? '疗程已激活；真实项目预约会显示在下方日程。' : draft.reviewStatus === 'returned' ? `医护退回原因：${draft.reviewReason || '请联系医护核对'}。请生成新版本。` : ['superseded','corrected'].includes(draft.reviewStatus) ? '该版本已被医护更新，保留生成时来源供追溯；请查看当前激活版本。' : '只供本人和医护核对。待审核草案不会预约、点餐或占用时段名额。'}</div>
      <EnvironmentHistoryNote history={draft.environmentHistory}/><AdoptedDomainSuggestions evidence={draft.evidence} onSelectResource={onSelectResource}/>
      <SourceDetails data={draft}/><div className="stage21-days">{[...byDate.entries()].map(([date, dayItems]) => <section className="stage21-day" key={date}>
        <div className="stage21-day-head"><h3>{date}</h3><span>{dayItems.length} 项 · {dayItems.filter(item => item.type === 'gap').length} 项缺口</span></div>
        <div className="stage21-item-grid">{dayItems.map(item => <article className={`stage21-item ${item.status}`} key={item.id}>
          <div className="stage21-item-top"><span>{item.type === 'meal' ? ({breakfast:'早餐',lunch:'午餐',dinner:'晚餐'})[item.slotKey] || '餐食' : item.type === 'activity' ? ({morning:'上午活动',afternoon:'下午活动',evening:'晚间活动'})[item.slotKey] || '活动' : item.type === 'rest' ? ({morning:'上午安排',afternoon:'下午安排',evening:'晚间安排'})[item.slotKey] || '安排' : '资料缺口'}</span><strong>{item.localStart ? `${item.localStart}–${item.localEnd}` : item.status === 'gap' ? '未安排' : '时间待定'}</strong></div>
          <h4>{item.title}</h4>{item.location && <p className="stage21-item-location">{item.location}</p>}
          {item.evidence?.resource?.audioUrl && <button type="button" className="outline-btn" onClick={() => onSelectResource?.(item.evidence.resource)}>打开陪伴资源</button>}
          <span className={`stage21-status ${item.status}`}>{({pending_review:'待本人确认',mandatory_review:'必须人工核对',sampled_review:'抽样人工核对',pending_confirmation:'环境待确认',proposed:'建议休息',gap:'信息缺口',excluded:'已排除'})[item.status] || businessText(item.status)}</span>
          {eraLabel && <small className="stage21-reason-era">生成时记录：当前执行以实际预约与日程为准</small>}
          <BusinessReason value={item.reason}/>
          {item.ruleIds?.length > 0 && <SourceDetails><p>规则：{item.ruleIds.join('、')}</p></SourceDetails>}
          {item.environmentSnapshotId && <SourceDetails><p>环境快照：{item.environmentSnapshotId}</p></SourceDetails>}
          {item.evidence?.healthRisk && <p className="stage21-rule-list"><b>健康约束：</b>{Object.entries(item.evidence.healthRisk).filter(([,value]) => value === true).map(([key]) => businessText(key)).join('、') || '需人工复核'}</p>}
          <details className="stage21-sources"><summary>来源与证据</summary><p>候选编号：{item.candidateId || '无'}</p>{formatSources(item.sourceIds).length ? <ul>{formatSources(item.sourceIds).map(value => <li key={value}>{value}</li>)}</ul> : <p>没有可引用的来源编号。</p>}
            {item.evidence?.rules?.map((rule, index) => <p key={`${rule.ruleId}-${index}`}>{rule.ruleId} · {rule.action} · {rule.reason}</p>)}
          </details>
        </article>)}</div>
      </section>)}</div>
    </article>;
  };

  return <><PageTitle eyebrow="MY SCHEDULE" title="日程与疗程草案" desc="待审核建议、已确认预约和取消记录分开显示。草案不会占用真实时段。" action={<button type="button" className="outline-btn small-btn" onClick={load} disabled={loading}>刷新日程　↻</button>}/>
    <section className="surface stage21-plan-toolbar"><div><strong>当前入住区间</strong><span>{stayValid ? `${stayStart} 至 ${stayEnd} · 离店日不排入` : '入住日期尚未完整登记'}</span><small>三晚最多生成 3 天；十晚最多生成 7 天。只使用领域候选、当日餐单和已登记的实际时段。</small></div><button type="button" className="primary-btn" onClick={createDraft} disabled={!stayValid || generating || loading}>{generating ? '正在生成并核对…' : drafts.length ? '生成新版本草案' : '生成疗程草案'}</button></section>
    {notice && <div className="stage21-success" role="status">{notice}</div>}{error && <div className="project-form-error" role="alert">{error}</div>}
    {notifications.length > 0 && <section className="surface wellness-guest-notifications"><SectionHead title="日程通知"/>{[...new Set(notifications.map(item=>notificationCategory(item).key))].map(key=><section key={key} className="release-notice-group" data-notice-category={key}><h3>{notificationCategory(notifications.find(item=>notificationCategory(item).key===key)).label}</h3><ul>{notifications.filter(item=>notificationCategory(item).key===key).map(item=><li key={item.id}><span>{businessText(item.message)}</span><small>{businessTime(item.createdAt)}</small><SourceDetails data={item}/></li>)}</ul></section>)}</section>}
    {loading ? <section className="surface project-state">正在读取草案、预约和取消记录…</section> : <>
      <section className="stage21-timeline-section q24-execution-section" data-testid="q24-execution-feedback">
        <div className="stage21-section-heading"><div><span className="eyebrow">EXECUTION · CHECK-IN · FEEDBACK</span><h2>项目签到与感受</h2><p>只有本人真实预约可以签到；签到后可留下项目感受，并在提交当天修改。</p></div><span>{checkins.filter(item => item.checkin).length} 次已签到</span></div>
        {checkins.length ? <div className="q24-execution-list">{checkins.map(item => <CheckinFeedbackCard key={item.reservationId} item={item}
          onCheckin={checkIn} onFeedback={saveFeedback} busy={workingId === `checkin:${item.reservationId}` || workingId === `feedback:${item.reservationId}`}/>)}</div>
          : <div className="surface project-state project-empty">当前没有可签到的本人预约。</div>}
      </section>
      <section className="stage21-timeline-section q24-replan-section" data-testid="q24-replanning-events">
        <div className="stage21-section-heading"><div><span className="eyebrow">SOURCE · REVIEW · VERSION</span><h2>反馈后的疗程评估</h2><p>来源记录和版本可追溯；候选疗程须按现行规则审核后才会影响预约。</p></div><span>{replanEvents.length} 条来源</span></div>
        {replanEvents.length ? <div className="q24-replan-list">{replanEvents.map(item => <ReplanEventCard key={item.id} item={item}
          onEvaluate={evaluateEvent} busy={workingId === `replan:${item.id}`}/>)}</div>
          : <div className="surface project-state project-empty">反馈、指标或心情变化被记录后，来源会显示在这里。</div>}
      </section>
      <section className="stage21-timeline-section"><div className="stage21-section-heading"><div><span className="eyebrow">PROPOSED · INACTIVE</span><h2>疗程草案版本</h2><p>草案使用独立编号和来源运行；待审或人工复核条目都不是预约。</p></div><span>{drafts.length} 版</span></div>
        {drafts.length ? <div className="stage21-draft-list">{drafts.map(renderDraft)}</div> : <div className="surface project-state project-empty"><strong>还没有疗程草案</strong><p>{stayValid ? '生成后会在这里显示逐日餐食、时段、缺口和证据。' : '请先联系工作人员登记有效入住区间。'}</p></div>}
      </section>
      <section className="stage21-timeline-section"><div className="stage21-section-heading"><div><span className="eyebrow">CONFIRMED · UPCOMING</span><h2>待执行预约</h2><p>这里只列出仍有效且尚未开始的已确认预约，容量编号来自预约记录。</p></div><span>{timeline?.upcomingBookings?.length || 0} 条</span></div>
        {timeline?.upcomingBookings?.length ? <div className="surface reservation-list-panel">{timeline.upcomingBookings.map(item => <article className="reservation-row" key={item.id}><div><strong>{item.projectName}</strong><span>{slotDateLabel(item.businessDate)} · {item.localStart}–{item.localEnd}</span><small>{item.location}</small><SourceDetails data={item}/></div><span className="reservation-status confirmed">已确认</span></article>)}</div> : <div className="surface project-state project-empty">当前没有待执行预约。草案不会显示在本列表中。</div>}
      </section>
      <section className="stage21-timeline-section"><div className="stage21-section-heading"><div><span className="eyebrow">CANCELLED · HISTORY</span><h2>取消记录</h2><p>取消预约保留为历史记录，不会进入待执行日程。</p></div><span>{timeline?.cancelledHistory?.length || 0} 条</span></div>
        {timeline?.cancelledHistory?.length ? <div className="surface reservation-list-panel">{timeline.cancelledHistory.map(item => <article className="reservation-row" key={item.id}><div><strong>{item.projectName}</strong><span>{slotDateLabel(item.businessDate)} · {item.localStart}–{item.localEnd}</span><small>{item.location}</small><SourceDetails data={item}/></div><span className="reservation-status cancelled">已取消</span></article>)}</div> : <div className="surface project-state project-empty">当前没有取消记录。</div>}
      </section>
    </>}
  </>;
}

export function GuestReservations({ go }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [workingId, setWorkingId] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { const result = await request('/reservations'); setItems(result.items || []); }
    catch (requestError) { setError(requestError.message || '预约记录暂时无法加载'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function cancel(item) {
    const time = `${slotDateLabel(item.businessDate)} ${item.localStart}–${item.localEnd}`;
    if (!window.confirm(`将取消「${item.projectName}」${time} 的预约，并释放一个名额。确认取消吗？`)) return;
    setWorkingId(item.id);
    setError('');
    try { await request(`/reservations/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await load(); }
    catch (requestError) { setError(requestError.message || '取消没有完成，请刷新后重试'); }
    finally { setWorkingId(''); }
  }
  const visibleItems = dateFilter ? items.filter(item => item.businessDate === dateFilter) : items;
  const current = visibleItems.filter(item => item.status === 'confirmed' && Date.parse(item.startsAt) > Date.now());
  const history = visibleItems.filter(item => !current.includes(item));
  const renderRow = item => <article className="reservation-row" key={item.id}><div><strong>{item.projectName}</strong><span>{slotDateLabel(item.businessDate)} · {item.localStart}–{item.localEnd}</span><small>{item.location}</small><SourceDetails><small>预约编号 {item.id}</small></SourceDetails>{item.status === 'cancelled' && <small>取消原因：{cancellationReasonLabel(item.cancellationReason)}</small>}</div><div className="reservation-row-actions"><span className={`reservation-status ${item.status}`}>{reservationStatusLabel(item.status)}</span>{item.status === 'confirmed' && Date.parse(item.startsAt) > Date.now() && <button type="button" className="outline-btn small-btn danger-outline" onClick={() => cancel(item)} disabled={workingId === item.id}>{workingId === item.id ? '取消中…' : '取消预约'}</button>}</div></article>;
  return <><PageTitle eyebrow="MY RESERVATIONS" title="我的预约" desc="按服务日期查看当前预约和历史记录。取消确认后会释放时段名额。"/><div className="reservation-filter-bar"><label htmlFor="reservation-date-filter">服务日期<input id="reservation-date-filter" type="date" value={dateFilter} onChange={event => setDateFilter(event.target.value)}/></label><span>{dateFilter ? <>当前查看 <time>{dateFilter}</time></> : '全部日期'}</span><button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新预约　↻</button></div>{error && <div className="project-form-error" role="alert">{error}</div>}{loading ? <section className="surface reservation-list-panel">正在读取预约…</section> : <div className="reservation-history-layout"><section className="surface reservation-list-panel"><div className="reservation-section-head"><h2>待执行预约</h2><span>{current.length} 条</span></div>{current.length ? current.map(renderRow) : <div className="project-state project-empty"><strong>没有待执行预约</strong><p>{dateFilter ? '所选日期没有待执行预约。' : '项目详情中的时段网格会显示当前可预约名额。'}</p>{!dateFilter && <button type="button" className="outline-btn small-btn" onClick={() => go('projects')}>浏览项目</button>}</div>}</section><section className="surface reservation-list-panel"><div className="reservation-section-head"><h2>历史记录</h2><span>{history.length} 条</span></div>{history.length ? history.map(renderRow) : <div className="project-state project-empty">{dateFilter ? '所选日期暂无历史记录。' : '暂无历史记录。'}</div>}</section></div>}</>;
}
