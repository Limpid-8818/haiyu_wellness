import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { request } from '../../lib/request.js';
import { shanghaiDateOffset, slotDateLabel } from '../../lib/date.js';
import { PageTitle } from '../../shared/ui.jsx';
import { SourceDetails } from '../../SourceDetails.jsx';
import EnvironmentPanel from '../../EnvironmentPanel.jsx';

const PROJECT_FILTERS = [
  { id: '', label: '全部项目' },
  { id: 'water_therapy', label: '水疗' },
  { id: 'exercise', label: '运动' },
  { id: 'seaside', label: '亲海' }
];

function ProjectArtwork({ project }) {
  const category = project.category || 'seaside';
  const palette = category === 'water_therapy'
    ? { sky: '#d7eeee', water: '#4e9eaa', shore: '#a8d4c9', sun: '#e9c980' }
    : category === 'exercise'
      ? { sky: '#e3eee3', water: '#80a99a', shore: '#93bb90', sun: '#e4bf76' }
      : { sky: '#e1edf1', water: '#518c9a', shore: '#b0caa8', sun: '#efcf87' };
  return <svg className="project-artwork" viewBox="0 0 520 210" role="img" aria-label={`${project.name}的示意图`}>
    <rect width="520" height="210" rx="18" fill={palette.sky}/>
    <circle cx="411" cy="54" r="27" fill={palette.sun}/>
    <path d="M0 124c62-23 117-13 174 4s113 14 170-1 118-18 176 1v82H0z" fill={palette.water}/>
    <path d="M0 169c84-27 150-9 218 8s145 10 302-9v42H0z" fill={palette.shore}/>
    <path d="M33 72c26-17 55-17 82 0M54 91c25-14 51-14 76 0M323 106c23-12 47-12 70 0" fill="none" stroke="#ffffff" strokeWidth="5" strokeLinecap="round" opacity=".72"/>
    <path d="M0 208h520" stroke="#739c81" strokeWidth="4" opacity=".5"/>
  </svg>;
}

function ProjectWindows({ windows = [] }) {
  if (!windows.length) return <span>暂未录入</span>;
  return <ul className="project-window-list">{windows.map((window, index) => <li key={`${window.start}-${index}`}>
    <strong>{Array.isArray(window.days) ? window.days.join('、') : '开放日'}</strong>
    <span>{window.start}–{window.end}</span>
  </li>)}</ul>;
}

function ProjectDetail({ project, onBack, go }) {
  return <>
    <PageTitle eyebrow="PROJECT DETAILS" title={project.name} desc={`${project.categoryLabel}${project.intensityLabel ? ` · ${project.intensityLabel}强度` : ''}`} action={<button className="outline-btn" type="button" onClick={onBack}>← 返回项目列表</button>}/>
    <section className="surface project-detail-card">
      <ProjectArtwork project={project}/>
      <div className="project-detail-meta"><span className="project-category-tag">{project.categoryLabel}</span>{project.intensityLabel && <span className={`project-intensity ${project.intensity}`}>{project.intensityLabel}强度</span>}<span className="project-demo-tag">示例资料</span></div>
      <div className="project-detail-grid">
        <section><h2>项目介绍</h2><p>{project.description}</p><small>{project.sourceReference}</small></section>
        <section><h2>地点</h2><p>{project.location}</p></section>
        <section><h2>适宜人群</h2><p>{project.suitablePeople}</p></section>
        <section className="project-caution"><h2>禁忌提示</h2><p>{project.contraindications}</p></section>
        <section><h2>开放时段</h2><ProjectWindows windows={project.openWindows}/><small>示例开放窗口 · 时区 {project.timezone}</small></section>
        <section><h2>时段容量</h2><p>{project.capacityPerWindow} 人 / 时段</p><small>演示容量，不代表实时余量</small></section>
      </div>
      <div className="project-detail-footnote"><strong>{project.isDemo ? '演示预约' : '预约说明'}</strong><span>{project.isDemo ? '时段与容量为演示数据。预约仅用于本地演示，不代表真实服务安排。' : '提交前由服务端重新核对入住区间、容量、环境和健康规则。'}</span></div>
    </section>
    <ProjectBooking project={project} go={go}/>
    <EnvironmentPanel projectId={project.id} requestApi={request}/>
  </>;
}

export function reservationStatusLabel(status) {
  return status === 'confirmed' ? '已确认' : status === 'cancelled' ? '已取消' : status;
}

export function cancellationReasonLabel(reason) {
  return reason === 'guest_cancelled' ? '客人主动取消' : reason || '已取消';
}

function ProjectBooking({ project, go }) {
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => shanghaiDateOffset(index)), []);
  const [date, setDate] = useState(() => shanghaiDateOffset());
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [reservation, setReservation] = useState(null);
  const submitLock = useRef(false);
  const idempotency = useRef({ slotId: '', key: '' });
  const slotsGeneration = useRef(0);

  const loadSlots = useCallback(async () => {
    const generation = ++slotsGeneration.current;
    setLoading(true);
    setError('');
    try {
      const result = await request(`/projects/${encodeURIComponent(project.id)}/slots?date=${encodeURIComponent(date)}`);
      if (generation !== slotsGeneration.current) return;
      setSlots(result.slots || []);
    } catch (requestError) {
      if (generation !== slotsGeneration.current) return;
      setError(requestError.message || '预约时段暂时无法加载');
      setSlots([]);
    } finally { if (generation === slotsGeneration.current) setLoading(false); }
  }, [project.id, date]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  function selectSlot(slot) {
    if (!slot.bookable || submitting) return;
    setSelectedSlot(slot);
    setError('');
    setReservation(null);
    if (idempotency.current.slotId !== slot.id) idempotency.current = { slotId: slot.id, key: '' };
  }

  async function submitReservation() {
    if (!selectedSlot || submitLock.current) return;
    submitLock.current = true;
    setSubmitting(true);
    setError('');
    if (!idempotency.current.key) {
      const generated = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      idempotency.current = { slotId: selectedSlot.id, key: `guest-${generated}` };
    }
    try {
      const result = await request('/reservations', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotency.current.key },
        body: JSON.stringify({ slotId: selectedSlot.id })
      });
      setReservation(result.reservation);
      setConfirming(false);
      setSelectedSlot(null);
      await loadSlots();
    } catch (requestError) {
      setError(requestError.message || '预约没有完成，请刷新时段后重试');
      setConfirming(false);
      await loadSlots();
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  return <section className="surface booking-panel" aria-busy={loading || submitting}>
    <div className="booking-panel-head"><div><div className="eyebrow">LIVE SCHEDULE</div><h2>选择预约时段</h2><p>服务端会在提交时再次核对余量、入住日期、环境和健康规则。</p></div><label htmlFor="project-slot-date">预约日期<select id="project-slot-date" value={date} onChange={event => { setDate(event.target.value); setSelectedSlot(null); setReservation(null); }}>{dates.map((value, index) => <option key={value} value={value}>{index === 0 ? '今天 · ' : ''}{slotDateLabel(value)}</option>)}</select></label></div>
    {project.isDemo && <div className="booking-demo-note" role="note"><strong>演示时段与容量</strong><span>当前项目资料为演示数据，不代表真实运营名额或安全确认。</span></div>}
    {error && <div className="project-form-error" role="alert">{error}</div>}
    {loading ? <div className="project-state" role="status">正在读取服务端余量…</div>
      : slots.length ? <div className="booking-slot-grid">{slots.map(slot => <article className={`booking-slot-card ${slot.status} ${selectedSlot?.id === slot.id ? 'selected' : ''}`} data-slot-id={slot.id} data-slot-status={slot.status} key={slot.id}>
        <div className="booking-slot-time"><strong>{slot.localStart}–{slot.localEnd}</strong><span className={`booking-slot-state ${slot.status}`}>{slot.status === 'available' ? '可预约' : slot.status === 'full' ? '已约满' : slot.status === 'pending' ? '待核实' : slot.status === 'restricted' ? '受限' : slot.status === 'stay_required' ? '入住日期不符' : slot.status === 'closed' ? '已关闭' : slot.status === 'past' ? '已结束' : slot.status === 'window_changed' ? '开放窗口已调整' : '不可预约'}</span></div>
        <p>{slot.location}</p><p className="booking-slot-capacity">余{slot.remaining}/{slot.capacity} · 已约{slot.booked}</p>
        {slot.bookable ? <button type="button" className={selectedSlot?.id === slot.id ? 'outline-btn' : 'primary-btn'} onClick={() => selectSlot(slot)} disabled={submitting}>{selectedSlot?.id === slot.id ? '已选择' : '选择时段'}</button>
          : <details className="booking-slot-reason"><summary>查看限制原因</summary><p>{slot.reason}</p>{slot.environment?.ruleDecisions?.filter(item => item.matched).map(item => <p key={`${item.ruleId}-${item.reason}`}>{item.ruleId}：{item.reason}</p>)}</details>}
      </article>)}</div>
      : <div className="project-state project-empty" role="status"><strong>当天没有生成开放时段</strong><p>请选择未来七天内的其他日期，或联系工作人员核对开放窗口。</p></div>}
    {selectedSlot && <div className="booking-selection" aria-live="polite"><span>已选：{slotDateLabel(selectedSlot.businessDate)} {selectedSlot.localStart}–{selectedSlot.localEnd} · {selectedSlot.location}</span><button type="button" className="primary-btn" onClick={() => setConfirming(true)} disabled={submitting}>立即预约</button></div>}
    {reservation && <div className="booking-success" role="status" data-reservation-id={reservation.id}><strong>预约已保存</strong><span>{reservation.projectName} · {slotDateLabel(reservation.businessDate)} {reservation.localStart}–{reservation.localEnd} · {reservationStatusLabel(reservation.status)}</span><SourceDetails><small>预约编号 {reservation.id}</small></SourceDetails><button type="button" className="outline-btn small-btn" onClick={() => go('reservations')}>查看我的预约</button></div>}
    {confirming && selectedSlot && <div className="booking-dialog-backdrop"><section className="booking-dialog" role="dialog" aria-modal="true" aria-labelledby="booking-confirm-title"><h2 id="booking-confirm-title">确认预约</h2><p>{project.name}，{slotDateLabel(selectedSlot.businessDate)} {selectedSlot.localStart}–{selectedSlot.localEnd}</p><p>{selectedSlot.location}</p><p>预约提交时，服务端会再次核对你的入住区间、名额、环境和健康限制。</p>{project.isDemo && <p className="booking-dialog-demo">这是演示预约，不代表真实服务安排。</p>}<div className="booking-dialog-actions"><button type="button" className="outline-btn" onClick={() => setConfirming(false)} disabled={submitting}>返回修改</button><button type="button" className="primary-btn" onClick={submitReservation} disabled={submitting}>{submitting ? '正在提交…' : '确认并预约'}</button></div></section></div>}
  </section>;
}

export function GuestProjects({ go }) {
  const [filter, setFilter] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const listRef = useRef(null);
  const savedScrollTop = useRef(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (filter) params.set('category', filter);
    if (search) params.set('q', search);
    request(`/projects${params.size ? `?${params.toString()}` : ''}`).then(result => {
      if (current) setItems(result.items || []);
    }).catch(requestError => {
      if (current) setError(requestError.message || '项目目录暂时无法加载');
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [filter, search]);

  useLayoutEffect(() => {
    if (!selected && listRef.current) listRef.current.scrollTop = savedScrollTop.current;
  }, [selected, loading]);

  async function openProject(item) {
    savedScrollTop.current = listRef.current?.scrollTop || 0;
    setDetailLoading(true);
    setDetailError('');
    try {
      const detail = await request(`/projects/${encodeURIComponent(item.id)}`);
      setSelected(detail);
    } catch (requestError) {
      setDetailError(requestError.message || '项目详情暂时无法加载');
    } finally {
      setDetailLoading(false);
    }
  }

  if (selected) return <ProjectDetail project={selected} onBack={() => setSelected(null)} go={go}/>;
  return <>
    <PageTitle eyebrow="GUEST SPACE" title="海滨项目库" desc="查看开放时段、服务端余量与预约状态。"/>
    <section className="project-catalog surface" aria-busy={loading}>
      <div className="project-catalog-tools">
        <div className="project-filters" role="group" aria-label="项目分类筛选">{PROJECT_FILTERS.map(item => <button key={item.id || 'all'} type="button" className={filter === item.id ? 'active' : ''} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
        <form className="project-search" onSubmit={event => { event.preventDefault(); setSearch(searchDraft.trim()); }}>
          <label htmlFor="project-search-input">搜索项目</label>
          <div><input id="project-search-input" value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="输入项目名称或关键词"/><button type="submit" className="primary-btn">搜索</button></div>
        </form>
      </div>
      <div className="project-catalog-summary" aria-live="polite"><strong>{loading ? '正在加载项目…' : `${items.length} 个项目`}</strong><span>分类、搜索均使用项目目录数据</span></div>
      {error ? <div className="project-state project-state-error" role="alert">{error}<button type="button" className="outline-btn small-btn" onClick={() => setSearch(value => `${value} `)}>重试</button></div> : detailError ? <div className="project-state project-state-error" role="alert">{detailError}</div> : loading ? <div className="project-state" role="status">正在读取项目目录…</div> : items.length ? <div className="project-grid" ref={listRef}>
        {items.map(item => <article className="project-card" key={item.id}>
          <ProjectArtwork project={item}/>
          <div className="project-card-body"><div className="project-card-tags"><span className="project-category-tag">{item.categoryLabel}</span>{item.intensityLabel && <span className={`project-intensity ${item.intensity}`}>{item.intensityLabel}强度</span>}</div>
            <h2>{item.name}</h2><p>{item.description}</p><div className="project-card-location">⌖ {item.location}</div>
            <button type="button" className="project-card-link" onClick={() => openProject(item)} disabled={detailLoading}>{detailLoading ? '正在打开…' : '查看详情　→'}</button>
          </div>
        </article>)}
      </div> : <div className="project-state project-empty" role="status"><strong>未找到相关项目</strong><p>换一个分类或搜索词再试试。</p></div>}
      <p className="project-list-note">可预约时段和余量由服务端读取；提交前会再次核对容量、入住日期、环境和健康规则。</p>
    </section>
  </>;
}

export function formatProjectWindows(windows = []) {
  return windows.map(window => `${(window.days || ['每日']).join('、')} ${window.start}-${window.end}`).join('\n');
}

export function parseProjectWindows(value) {
  const lines = value.split(/[\n;；]+/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('请填写至少一个开放窗口');
  return { windows: lines.map(line => {
    const match = line.match(/^(.+?)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
    if (!match) throw new Error('时间格式请写成“每日 09:00-11:00”，每行一个窗口');
    return { days: match[1].split(/[、,，]/).map(day => day.trim()).filter(Boolean), start: match[2], end: match[3] };
  }) };
}
