import React, { useCallback, useEffect, useRef, useState } from 'react';
// G18 阶段 2：智能协作台样式随 StaffView 分包就近加载（.metric-button 例外，客人主页使用，已并入 base.css）。
import '../../styles/agent.css';
import { request } from '../../lib/request.js';
import { fmtDate, fmtDateTime, mealLocalTime } from '../../lib/date.js';
import { initials, normalizeGuestSummary, normalizeGuestList } from '../../lib/normalize.js';
import { useQuery } from '../../lib/useQuery.js';
import { PageTitle, Metric, SectionHead, Principle, Field, Info, Empty, QueryState } from '../../shared/ui.jsx';
import { admissionLabel, STAFF_JOB_LABELS } from '../../app/navigation.js';
import { PasswordPanel } from '../../shared/PasswordPanel.jsx';
import { HEALTH_PROFILE_FIELDS, HealthIntakeHistory, displayHealthField, formalHealthSummary } from '../guest/health-profile.jsx';
import { MealRestrictionReview } from '../guest/meals.jsx';
import { agentStateLabel } from '../assistant/assistant-parts.jsx';
import { SourceDetails } from '../../SourceDetails.jsx';

export function StaffOverview({ me }) {
  const { data: overview, loading, error } = useQuery(async (signal) => request('/staff/overview', { signal }),
    [], { fallbackMessage: '工作概览暂时无法加载' });
  const recent = Array.isArray(overview?.recent) ? overview.recent : [];
  return <><PageTitle eyebrow="STAFF WORKSPACE" title={`早上好，${me.name}`} desc="这是你的工作概览，今天也请从容地照顾好每一位客人。"/><div className="staff-banner"><div><span className="banner-kicker">今日工作台</span><h2>先看一眼需要关注的人</h2><p>进入“我负责的客人”，你可以查询档案、查看健康情况，并留下新的医嘱或建议。</p></div><div className="staff-symbol">✚</div></div>{error ? <QueryState error text={error} retryText="请刷新页面重试"/> : <><div className="metric-grid"><Metric label="负责客人" value={loading ? '…' : overview?.guests ?? 0} hint="当前授权范围内" tone="teal"/><Metric label="有效医嘱" value={loading ? '…' : overview?.activeAdvice ?? 0} hint="负责客人的有效医嘱" tone="blue"/><Metric label="近期工作记录" value={loading ? '…' : recent.length} hint="最近 8 条记录" tone="orange"/></div><section className="surface"><SectionHead title="近期工作记录"/>{loading ? <QueryState text="正在加载工作记录…"/> : recent.length ? <div className="staff-recent-list">{recent.map((entry) => <article className="staff-recent-row" key={entry.id}><span className="staff-recent-mark" aria-hidden="true">{entry.action === 'advice.create' ? '✚' : '◈'}</span><div><strong>{staffActionLabel(entry.action)}</strong><p>{entry.detail || '已记录一项工作操作'}</p></div><time dateTime={entry.createdAt}>{fmtDateTime(entry.createdAt)}</time></article>)}</div> : <Empty text="还没有近期工作记录"/>}</section></>}<AgentPanel role="staff"/><section className="surface"><SectionHead title="工作原则"/><div className="principle-grid"><Principle icon="◈" title="信息最小化" text="只查看完成工作所必需的客人信息。"/><Principle icon="⌁" title="建议可追溯" text="每条医嘱都保留作者、时间和状态。"/><Principle icon="♧" title="先沟通再行动" text="涉及健康风险时，及时联系客人与医护团队。"/></div></section></>;
}

function staffActionLabel(action) {
  return ({
    'guest.view': '查看客人档案',
    'advice.create': '发布医嘱与建议',
    'profile.update': '更新客人资料',
    'service.execution.record': '记录服务执行',
    'password.change': '修改登录密码',
    login: '登录系统'
  })[action] || action || '工作操作';
}

function AgentPanel({ role }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let active = true;
    request('/agent/status').then((data) => { if (active) setStatus(data); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return <section className="surface agent-panel"><div className="agent-panel-head"><div><div className="eyebrow">AGENT ORCHESTRATION</div><h2><span className="agent-pulse"/>康养智能协作台</h2><p>{role === 'guest' ? '你的今日信息由康养管家协调多个专业 Agent 整理。' : '系统以康养管家为调度 Agent，辅助团队完成信息整理与建议生成。'}</p></div><div className="agent-mode">{status?.mode || '可解释规则协作模式'}<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起' : '展开'}　⌃</button></div></div>{open && <><p>实际运行：{agentStateLabel(status?.state || 'not_run')} · 服务健康：{({unknown:'尚未验证',unconfigured:'未配置',last_request_succeeded:'最近请求成功',last_request_failed:'最近请求失败'})[status?.serviceHealth?.state] || '尚未验证'}</p><div className="agent-flow"><div className="flow-node orchestrator"><span>⌘</span><strong>康养管家</strong><small>调度与汇总</small></div><div className="flow-line"/><div className="flow-agents">{(status?.agents || []).slice(1).map((agent, index) => <div className="flow-node" key={agent.agent}><span>{['◒', '✣', '♧', '◌'][index]}</span><strong>{agent.agent}</strong><small>{agent.action}</small></div>)}</div></div><div className="agent-events">{(status?.agents || []).map((agent) => <div key={agent.agent}><span className={`event-state ${agent.state}`}>{agent.state === 'done' ? '✓' : '·'}</span><div><strong>{agent.agent} · {agent.action}</strong><p>{agent.detail}</p></div></div>)}</div><div className="agent-gate">⌁ 人工确认边界：{status?.humanGate || '健康风险建议由工作人员最终确认'}</div></>}</section>;
}

function StaffCareFollowUpTasks({ guests, onChooseGuest }) {
  const { data: tasksData, error, loading, load } = useQuery(async (signal) => {
    const result = await request('/staff/care-follow-up-tasks', { signal });
    return result.items || [];
  }, [], { fallbackMessage: '关怀待办暂时无法加载' });
  const items = tasksData || [];
  const guestIds = new Set(guests.map(guest => guest.id));
  return <section className="surface stage25-staff-care" aria-label="关怀跟进待办" data-testid="stage25-staff-care-tasks">
    <header><div><span className="eyebrow">CARE FOLLOW-UP</span><h2>关怀跟进待办</h2></div><button type="button" className="outline-btn" onClick={() => void load()} disabled={loading}>刷新</button></header>
    {loading ? <p role="status">正在读取当前负责范围内的待办…</p> : error ? <p role="alert">{error}</p> : items.length ? <ul>{items.map(item => <li key={item.id} data-source-id={item.sourceId} data-guest-id={item.guestId}>
      <div><strong>{item.title}</strong><p>{item.guestName} · {item.detail}</p><SourceDetails><small>{item.sourceType} · 来源 {item.sourceId} · {item.createdAt ? mealLocalTime(item.createdAt) : ''}</small></SourceDetails></div>
      <button type="button" disabled={!guestIds.has(item.guestId)} onClick={() => onChooseGuest(guests.find(guest => guest.id === item.guestId))}>{guestIds.has(item.guestId) ? '打开客人档案' : '超出当前搜索结果'}</button>
    </li>)}</ul> : <p>当前负责范围内没有待跟进事项。</p>}
  </section>;
}

export function StaffGuests({ notify, onGuestChange, canReview }) {
  const [guests, setGuests] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selectionLoading, setSelectionLoading] = useState(false);
  const loadController = useRef(null);
  const selectionController = useRef(null);
  const selectionSequence = useRef(0);
  const selectedId = useRef('');

  const loadGuests = useCallback(async (search = '') => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setListError('');
    try {
      const data = await request(`/staff/guests?q=${encodeURIComponent(search)}`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        const nextGuests = normalizeGuestList(data);
        setGuests(nextGuests);
        if (selectedId.current && !nextGuests.some(guest => guest.id === selectedId.current)) {
          selectionController.current?.abort();
          selectionSequence.current += 1;
          selectedId.current = '';
          setSelected(null);
          setSelectionLoading(false);
          onGuestChange(null);
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setGuests([]);
      setListError(error.message || '客人列表暂时无法加载');
      notify(error.message || '客人列表暂时无法加载');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [notify, onGuestChange]);

  useEffect(() => {
    onGuestChange(null);
    loadGuests();
    return () => {
      loadController.current?.abort();
      selectionController.current?.abort();
      selectionSequence.current += 1;
      selectedId.current = '';
      onGuestChange(null);
    };
  }, [loadGuests, onGuestChange]);

  async function search(event) {
    event?.preventDefault();
    await loadGuests(query.trim());
  }

  async function choose(guest) {
    selectionController.current?.abort();
    const controller = new AbortController();
    selectionController.current = controller;
    const sequence = ++selectionSequence.current;
    selectedId.current = guest.id;
    setSelected(null);
    setSelectionLoading(true);
    onGuestChange(guest.id);
    try {
      const data = await request(`/staff/guests/${guest.id}`, { signal: controller.signal });
      if (!controller.signal.aborted && sequence === selectionSequence.current) setSelected(normalizeGuestSummary(data));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (sequence === selectionSequence.current) {
        selectedId.current = '';
        onGuestChange(null);
        notify(error.message || '客人详情暂时无法加载');
      }
    } finally {
      if (!controller.signal.aborted && sequence === selectionSequence.current) setSelectionLoading(false);
    }
  }

  async function refreshSelected(guestId) {
    if (!guestId || guestId !== selectedId.current) return;
    try {
      const data = await request(`/staff/guests/${guestId}`);
      if (guestId === selectedId.current) setSelected(normalizeGuestSummary(data));
    } catch (error) {
      if (guestId === selectedId.current) notify(error.message || '客人详情暂时无法刷新');
    }
  }

  return <><PageTitle eyebrow="MY GUESTS" title="我负责的客人" desc="在这里查看客人的基础资料与健康情况，并提供专业建议。" action={<button type="button" className="outline-btn" onClick={() => search()} disabled={loading} aria-busy={loading}>刷新列表　↻</button>}/><StaffCareFollowUpTasks guests={guests} onChooseGuest={choose}/><form className="search-bar" onSubmit={search}><label className="sr-only" htmlFor="guest-search">搜索客人姓名或房间号</label><span aria-hidden="true">⌕</span><input id="guest-search" placeholder="搜索客人姓名或房间号" value={query} onChange={(event) => setQuery(event.target.value)}/><button type="submit" disabled={loading} aria-busy={loading}>搜索</button></form><div className="guest-layout"><section className="surface guest-list"><div className="list-heading"><strong>客人列表</strong><span>{guests.length} 位授权客人</span></div>{loading ? <QueryState text="正在加载客人列表…"/> : listError ? <QueryState error text={listError} retryText="请稍后重试" onRetry={() => loadGuests(query.trim())} retryLabel="重试加载"/> : guests.length ? guests.map((guest) => <button type="button" className={`guest-row ${selectedId.current === guest.id ? 'selected' : ''}`} key={guest.id} onClick={() => choose(guest)}><span className="avatar">{initials(guest.name)}</span><span className="guest-main"><strong>{guest.name}</strong><small>{guest.roomNo || '未分配房间'} · {guest.phone}</small></span><span className="guest-flag">{guest.chronicStatus === 'reported' ? '需关注' : guest.chronicStatus === 'none' ? '已核实无慢病' : '待补充或核实'}</span><b aria-hidden="true">→</b></button>) : <div className="list-empty"><Empty text="暂无结果"/></div>}</section><section className="guest-detail">{selectionLoading ? <div className="surface detail-empty"><div className="empty-illustration">⌁</div><h2>正在打开客人档案</h2><p>正在读取当前授权范围内的信息。</p></div> : selected ? <StaffGuestDetail key={selected.id} guest={selected} notify={notify} onRefresh={refreshSelected} canReview={canReview}/> : <div className="surface detail-empty"><div className="empty-illustration">♧</div><h2>选择一位客人</h2><p>左侧选择客人后，这里会显示完整的工作所需信息。</p></div>}</section></div></>;
}

function ClinicianHealthReview({ guestId, notify, onGuestRefresh }) {
  const [actionId, setActionId] = useState(null);
  const [reasons, setReasons] = useState({});

  const { data, loading, load, setData } = useQuery(async (signal) => request(`/staff/guests/${guestId}/health-intakes`, { signal }),
    [guestId], { fallbackMessage: '', onError: (loadError) => notify(loadError?.message || '健康自述审核记录暂时无法加载') });

  async function review(item, action) {
    if (actionId) return;
    setActionId(item.id);
    try {
      const body = action === 'confirm'
        ? { baseProfileVersion: item.baseProfileVersion }
        : { reason: reasons[item.id] || '' };
      const result = await request(`/staff/health-intakes/${item.id}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      setData(current => current ? { ...current, verifiedProfile: result.verifiedProfile, profileVersion: result.profileVersion,
        history: result.history, pendingIntakes: result.pendingIntakes, effectiveHealthConstraints: result.effectiveHealthConstraints } : current);
      notify(action === 'confirm' ? '健康自述已核实并写入正式档案' : '已驳回该自述，正式档案保持不变');
      await onGuestRefresh(guestId);
    } catch (error) {
      notify(error.message || (action === 'confirm' ? '核实失败，请重新比对' : '驳回失败'));
      await load();
    } finally {
      setActionId(null);
    }
  }

  const pending = data?.pendingIntakes || [];
  return <section className="surface clinician-health-review" aria-busy={loading || Boolean(actionId)}>
    <div className="clinician-review-head"><div><SectionHead title="健康自述核实"/><p>仅负责医护可处理采集。确认后会更新正式档案版本；驳回会保留原文与原因。</p></div><button type="button" className="outline-btn small-btn" onClick={load} disabled={loading}>刷新队列　↻</button></div>
    {loading ? <QueryState text="正在读取待核实采集…"/> : <>
      <div className="clinician-review-current"><strong>正式档案版本 {data?.profileVersion ?? 0}</strong>{HEALTH_PROFILE_FIELDS.filter(field => data?.verifiedProfile?.[field.key]?.status !== 'unanswered').map(field => <span key={field.key}>{field.label}：{displayHealthField(field.key, data.verifiedProfile[field.key])}</span>)}</div>
      {pending.length ? <div className="clinician-review-queue">{pending.map(item => <article className="clinician-review-item" key={item.id}>
        <div className="clinician-review-item-head"><div><span className="health-intake-status pending">待核实</span><strong>第 {item.revision || '旧记录'} 版 · {item.source === 'form' ? '客人表单' : item.source === 'assistant' ? '助手对话' : item.source}</strong></div><time>{item.submittedAt ? new Date(item.submittedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '—'}</time></div>
        <div className="clinician-review-submitter">提交人：{item.submitterName || '客人'} · 基于正式版本 {item.baseProfileVersion}</div>
        {item.candidate ? <>
          <div className="clinician-candidate-grid">{HEALTH_PROFILE_FIELDS.filter(field => item.candidate[field.key]?.status !== 'unanswered').map(field => <div key={field.key}><span>{field.label}</span><strong>{displayHealthField(field.key, item.candidate[field.key])}</strong></div>)}</div>
          <details className="clinician-compare"><summary>查看修改前后对照与来源</summary><HealthIntakeHistory history={[item]}/></details>
          <div className="clinician-review-actions"><button type="button" className="primary-btn small-btn" disabled={actionId === item.id} onClick={() => review(item, 'confirm')}>{actionId === item.id ? '处理中…' : '确认并更新正式档案'}</button><label>驳回原因<textarea rows="2" value={reasons[item.id] || ''} onChange={event => setReasons(current => ({ ...current, [item.id]: event.target.value }))} placeholder="填写核实后发现的问题或请客人补充的内容"/></label><button type="button" className="outline-btn small-btn" disabled={actionId === item.id || !reasons[item.id]?.trim()} onClick={() => review(item, 'reject')}>驳回并保留原文</button></div>
        </> : <div className="clinician-legacy-intake"><strong>历史文本采集</strong><p>{item.content || '无原始文本'}</p><small>该记录保持待核实；需要先以结构化字段补充后才能合并正式档案。</small></div>}
      </article>)}</div> : <div className="clinician-empty-queue"><Empty text="当前没有待核实采集"/></div>}
      <div className="form-section-title with-top"><span>档案变更历史</span><small>只读</small></div><HealthIntakeHistory history={data?.history || []}/>
    </>}
  </section>;
}

function StaffGuestDetail({ guest, notify, onRefresh, canReview }) {
  const profile = guest.profile || {};
  const [showAdvice, setShowAdvice] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', priority: 'normal' });
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      notify('请填写建议标题和内容');
      return;
    }
    setSubmitting(true);
    try {
      await request(`/staff/guests/${guest.id}/advice`, { method: 'POST', body: JSON.stringify({ ...form, title, content }) });
      setForm({ title: '', content: '', priority: 'normal' });
      setShowAdvice(false);
      notify('医嘱已发布，客人可以查看');
      await onRefresh(guest.id);
    } catch (error) {
      notify(error.message || '发布建议失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="detail-stack"><section className="surface profile-hero"><div className="avatar large">{initials(guest.name)}</div><div><div className="eyebrow">GUEST PROFILE</div><h2>{guest.name}</h2><p>{profile.gender || '—'}　{profile.birthDate || profile.birth_date || '—'}　房间 {profile.roomNo || profile.room_no || '—'}</p></div><span className="profile-status">{admissionLabel(guest.admissionStatus)}</span></section><section className="surface"><SectionHead title="基础信息"/><div className="detail-grid"><Info label="联系电话" value={guest.phone}/><Info label="入住时间" value={`${profile.checkIn || profile.check_in || '—'} 至 ${profile.checkOut || profile.check_out || '—'}`}/><Info label="紧急联系人" value={profile.emergencyContact || profile.emergency_contact || '—'}/><Info label="行动能力" value={profile.mobility || '—'}/></div></section><section className="surface"><SectionHead title="健康情况"/><div className="health-alert"><span>⌁</span><div><strong>慢病史</strong><p>{formalHealthSummary(profile, 'chronic')}</p></div></div><div className="health-alert"><span>◇</span><div><strong>过敏源</strong><p>{formalHealthSummary(profile, 'allergies')}</p></div></div>{profile.health_profile && <div className="health-verified-grid staff-verified-grid">{HEALTH_PROFILE_FIELDS.map(field => <div key={field.key}><span>{field.label} · 正式档案</span><strong>{displayHealthField(field.key, profile.health_profile[field.key])}</strong></div>)}</div>}<div className="latest-records"><strong>近期记录</strong>{guest.health?.length ? guest.health.slice(0, 3).map((health) => <div key={health.id}><span>{health.type}</span><b>{health.value} {health.unit}</b><small>{fmtDate(health.recordedAt)}</small></div>) : <Empty text="暂无近期健康记录"/>}</div></section><MealRestrictionReview guestId={guest.id} canResolve={canReview} notify={notify} onChanged={() => onRefresh(guest.id)}/>{canReview ? <ClinicianHealthReview guestId={guest.id} notify={notify} onGuestRefresh={onRefresh}/> : <section className="surface"><SectionHead title="健康自述核实"/><p className="read-only-review-note">当前岗位可查看正式健康档案。采集核实仅开放给负责医护。</p></section>}<section className="surface"><SectionHead title="医嘱与建议" action={canReview ? <button type="button" className="primary-btn small-btn" onClick={() => setShowAdvice(!showAdvice)} aria-expanded={showAdvice}>＋ 新增建议</button> : null}/>{canReview && showAdvice && <form className="advice-form" onSubmit={submit} noValidate aria-busy={submitting}><Field label="标题" value={form.title} onChange={(value) => setForm({ ...form, title: value })} placeholder="例如：本周运动安排" required/><label htmlFor={`priority-${guest.id}`}>重要程度<select id={`priority-${guest.id}`} value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option value="normal">一般建议</option><option value="important">重要提醒</option><option value="urgent">紧急提醒</option></select></label><label htmlFor={`advice-content-${guest.id}`}>建议内容<textarea id={`advice-content-${guest.id}`} rows="4" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="请输入清晰、可执行的建议" required/></label><div className="form-actions"><button type="button" className="outline-btn" onClick={() => setShowAdvice(false)} disabled={submitting}>取消</button><button type="submit" className="primary-btn" disabled={submitting} aria-busy={submitting}>{submitting ? '发布中…' : '发布建议　→'}</button></div></form>}{guest.advice?.map((advice) => <div className="staff-advice-row" key={advice.id}><div className={`advice-priority ${advice.priority}`}>{advice.priority === 'urgent' ? '紧急' : advice.priority === 'important' ? '重要' : '建议'}</div><div><strong>{advice.title}</strong><p>{advice.content}</p><small>{advice.authorName || '工作人员'} · {fmtDate(advice.createdAt)}</small></div></div>)}{!guest.advice?.length && <Empty text="还没有发布过医嘱"/>}</section></div>;
}

export function StaffAccount({ me, notify }) {
  return <><PageTitle eyebrow="MY ACCOUNT" title="我的账号" desc="维护你的工作人员账号信息与登录安全。"/><section className="surface account-card"><div className="account-avatar"><div className="avatar large">{initials(me.name)}</div><div><h2>{me.name}</h2><p>工作人员　·　账号 {me.username}</p></div></div><div className="account-line"><span>联系电话</span><strong>{me.phone || '未填写'}</strong></div><div className="account-line"><span>账号状态</span><strong className="green-text">正常</strong></div></section><PasswordPanel notify={notify}/></>;
}
