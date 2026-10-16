import React, { useCallback, useEffect, useRef, useState } from 'react';
// G18 阶段 2：机构运营样式随 StaffView 分包就近加载（.stage26-advice-draft/.stage26-draft-trigger 助手专用规则已并入 assistant.css）。
import '../../styles/operations.css';
import { request } from '../../lib/request.js';
import { businessText } from '../../../../shared/release-presentation.js';
import { PageTitle } from '../../shared/ui.jsx';

export function OperationsWorkbench({ notify, me, initialSource = null }) {
  const [date, setDate] = useState(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date()));
  const [summary, setSummary] = useState(null);
  const [slots, setSlots] = useState([]);
  const [reservations, setReservations] = useState([]);
  const [incidents, setIncidents] = useState([]);
  const [guests, setGuests] = useState([]);
  const [staff, setStaff] = useState([]);
  const [query, setQuery] = useState('');
  const [guestDate, setGuestDate] = useState('');
  const [selectedSlots, setSelectedSlots] = useState([]);
  const [snapshotKey, setSnapshotKey] = useState('');
  const [weatherPreview, setWeatherPreview] = useState(null);
  const [reason, setReason] = useState('天气变化，暂停户外活动并联系客人改约。');
  const [detail, setDetail] = useState(null);
  const [rebooking, setRebooking] = useState(null);
  const [selectedCandidate, setSelectedCandidate] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [history, setHistory] = useState(null);
  const [assignments, setAssignments] = useState({});
  const [jobType, setJobType] = useState('coach');
  const [reservationView, setReservationView] = useState('day');
  const [reservationStatus, setReservationStatus] = useState('all');
  const [reservationProjectId, setReservationProjectId] = useState('');
  const [metricRecord, setMetricRecord] = useState(null);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setError('');
    try {
      const reservationQuery = new URLSearchParams({ status: reservationStatus });
      if (reservationView === 'day') reservationQuery.set('date', date);
      else {
        const weekEnd = new Date(`${date}T12:00:00+08:00`);
        weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
        reservationQuery.set('from', date);
        reservationQuery.set('to', weekEnd.toISOString().slice(0, 10));
      }
      if (reservationProjectId) reservationQuery.set('projectId', reservationProjectId);
      const [summaryData, slotData, reservationData, incidentData, staffData] = await Promise.all([
        request(`/admin/operations/summary?date=${encodeURIComponent(date)}`),
        request(`/admin/operations/slots?date=${encodeURIComponent(date)}&days=7`),
        request(`/admin/operations/reservations?${reservationQuery}`),
        request('/admin/operations/incidents'), request('/dean/staff')
      ]);
      if (generation !== loadGeneration.current) return;
      setSummary(summaryData); setSlots(slotData.items || []); setReservations(reservationData.items || []);
      setIncidents(incidentData.items || []); setStaff(staffData || []);
    } catch (loadError) { if (generation === loadGeneration.current) setError(loadError.message || '运营数据暂时无法加载'); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [date, reservationView, reservationStatus, reservationProjectId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!initialSource?.source?.id) return;
    const requestedDate = String(initialSource.content || '').match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
    if (requestedDate) setDate(current => current === requestedDate ? current : requestedDate);
  }, [initialSource?.source?.id, initialSource?.content]);
  useEffect(() => {
    if (!initialSource?.source?.id) return;
    const target = document.querySelector(`[data-slot-id="${initialSource.source.id}"]`);
    target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [initialSource, slots]);

  async function searchGuests(event) {
    event?.preventDefault();
    setError('');
    try {
      const params = new URLSearchParams(); if (query.trim()) params.set('q', query.trim()); if (guestDate) params.set('date', guestDate);
      const result = await request(`/admin/operations/guests?${params.toString()}`); setGuests(result.items || []);
    } catch (searchError) { setError(searchError.message || '客人查询失败'); }
  }
  async function showHistory(guestId) {
    try { setHistory(await request(`/admin/operations/guests/${encodeURIComponent(guestId)}/health-history`)); }
    catch (historyError) { setError(historyError.message || '健康历史查询失败'); }
  }
  async function openDetail(key) {
    setMetricRecord(null);
    try { setDetail(await request(`/admin/operations/summary?date=${encodeURIComponent(date)}&detail=${key}`)); }
    catch (detailError) { setError(detailError.message || '运营明细读取失败'); }
  }
  function toggleSlot(slotId) {
    const selected = slots.find(slot => slot.id === slotId);
    setSelectedSlots(current => current.includes(slotId) ? current.filter(id => id !== slotId) : [...current, slotId]);
    if (selected?.weatherSnapshotKey) setSnapshotKey(selected.weatherSnapshotKey);
    setWeatherPreview(null);
  }
  async function previewWeather() {
    const selected = slots.filter(slot => selectedSlots.includes(slot.id));
    const dateKeys = [...new Set(selected.map(slot => String(slot.businessDate).slice(0, 10)))];
    if (!selected.length || dateKeys.length !== 1) { notify('请选择同一天的户外时段'); return; }
    try {
      const result = await request('/admin/operations/weather-cancellations/preview', { method: 'POST', body: JSON.stringify({
        slotIds: selectedSlots, snapshotKey
      }) }); setWeatherPreview(result);
    } catch (previewError) { setError(previewError.message || '天气预览失败'); }
  }
  async function commitWeather() {
    if (!weatherPreview || !reason.trim()) return;
    try {
      await request('/admin/operations/weather-cancellations', { method: 'POST',
        headers: { 'Idempotency-Key': `weather:${crypto.randomUUID()}` },
        body: JSON.stringify({ slotIds: selectedSlots, snapshotKey, reason: reason.trim() }) });
      setWeatherPreview(null); setSelectedSlots([]); notify('批量取消已保存并通知客人'); await load();
    } catch (commitError) { setError(commitError.message || '批量天气处理失败'); }
  }
  async function markNoShow(item) {
    try { await request(`/admin/operations/reservations/${encodeURIComponent(item.id)}/no-show`, { method: 'POST', body: '{}' }); notify('已登记未参加'); await load(); }
    catch (noShowError) { setError(noShowError.message || '爽约登记失败'); }
  }
  async function inspectAlternatives(item) {
    try {
      const result = await request(`/reservations/${encodeURIComponent(item.id)}/reschedule-candidates`, { onUnauthorized: () => {}, method: 'GET' });
      setRebooking({ reservation: item, ...result }); setSelectedCandidate(result.candidates?.[0]?.id || '');
    } catch (candidateError) { setError(candidateError.message || '替代时段读取失败'); }
  }
  async function confirmAlternative() {
    if (!rebooking || !selectedCandidate) return;
    try {
      await request(`/reservations/${encodeURIComponent(rebooking.reservation.id)}/reschedule`, { method: 'POST',
        headers: { 'Idempotency-Key': `reschedule:${crypto.randomUUID()}` }, body: JSON.stringify({ slotId: selectedCandidate }) });
      setRebooking(null); notify('改约已确认并写入日程'); await load();
    } catch (moveError) { setError(moveError.message || '改约失败，请刷新候选后重试'); }
  }
  async function assign(slot, staffId) {
    if (!staffId) return;
    try { await request(`/admin/operations/slots/${encodeURIComponent(slot.id)}/assignments`, { method: 'POST', body: JSON.stringify({ staffId, jobType }) }); notify('岗位任务已分配'); }
    catch (assignError) { setError(assignError.message || '任务分配失败'); }
  }
  async function closeIncident(item) {
    try { await request('/admin/operations/incidents/close', { method: 'POST', body: JSON.stringify({ supplier: item.supplier, feature: item.feature }) }); notify('运营事项已关闭'); await load(); }
    catch (closeError) { setError(closeError.message || '恢复后才能关闭事项'); }
  }
  const staffForJob = staff.filter(item => item.jobType === jobType && item.status === 'active');
  return <div className="stage26-operations" data-testid="stage26-operations">
    <PageTitle eyebrow="INSTITUTION OPERATIONS" title="机构运营" desc="同一套预约、人员排班和服务记录支撑周容量、当日处置与异常跟进。" action={<button className="outline-btn" type="button" onClick={load} disabled={loading}>刷新数据 ↻</button>}/>
    <section className="surface stage26-filter-row" data-generated-at={summary?.generatedAt || ''}><label>业务日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label><span>{summary?.generatedAt ? `数据时间 ${new Date(summary.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : '读取实时运营数据'}</span></section>
    {error && <div className="stage26-error" role="alert">{error}</div>}
    <section className="stage26-metrics" aria-label="运营实时计数">{summary?.metrics?.map(metric => <article className="surface stage26-metric" key={metric.key}><span>{metric.label}</span><strong>{metric.value}</strong><button type="button" onClick={() => openDetail(metric.detailKey)}>查看明细</button></article>)}</section>
    {detail && <section className="surface stage26-panel" data-testid="stage26-detail"><header><div><span className="eyebrow">LIVE DETAIL</span><h2>{detail.detail} · {detail.items.length} 条</h2></div><button type="button" className="outline-btn" onClick={() => { setDetail(null); setMetricRecord(null); }}>收起</button></header><div className="stage26-detail-list">{detail.items.slice(0, 30).map(item => <button type="button" data-testid={`stage26-detail-row-${detail.detail}-${item.id || item.reservationId}`} data-record-id={item.id || item.reservationId} key={item.id || item.reservationId} onClick={() => setMetricRecord({ kind: detail.detail, item })}>{item.guestName || item.name || item.id}<small>{item.id} · {item.status || item.reviewStatus || item.businessDate || ''}</small></button>)}</div>{metricRecord && <article className="stage26-selected-detail" data-testid="stage26-metric-record"><strong>{metricRecord.item.guestName || metricRecord.item.name || metricRecord.item.id}</strong><small>{metricRecord.item.id} · {metricRecord.item.status || metricRecord.item.reviewStatus || metricRecord.item.businessDate || '记录已保存'}</small>{metricRecord.item.guestId && <small>客人编号 {metricRecord.item.guestId}</small>}{metricRecord.item.projectName && <small>{metricRecord.item.projectName} · {metricRecord.item.businessDate}</small>}</article>}</section>}
    <section className="stage26-grid">
      <section className="surface stage26-panel"><header><div><span className="eyebrow">GUEST DIRECTORY</span><h2>住客检索</h2></div></header>
        <form className="stage26-search" onSubmit={searchGuests}><label>姓名、房间或入住日<input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索住客或房间"/></label><label>入住日期<input type="date" value={guestDate} onChange={event => setGuestDate(event.target.value)}/></label><button className="primary-btn" type="submit">查询</button></form>
        <div className="stage26-guest-list">{guests.map(guest => <article key={guest.id}><div><strong>{guest.name}</strong><small>{guest.gender} · {guest.age ?? '年龄未提供'} 岁 · {guest.roomNo || '未分房'} · {guest.checkIn} 至 {guest.checkOut}</small><small>入住状态：{guest.status} · 风险提示：{guest.riskFlags?.join('、') || '无'}</small></div><button type="button" className="outline-btn" onClick={() => showHistory(guest.id)}>健康历史</button></article>)}</div>
        {history && <div className="stage26-history" data-testid="stage26-health-history"><strong>只读健康历史 · {history.guestId}</strong>{history.items?.map(item => <p key={item.id}>{item.recordType || item.type}：{item.value} {item.unit} · {item.recordedAt}</p>)}<small>{history.note}</small></div>}
      </section>
      <section className="surface stage26-panel"><header><div><span className="eyebrow">DATE RANGE CAPACITY</span><h2>所选日期起可排期容量</h2></div><small>已约数量直接来自有效预约</small></header>
        <div className="stage26-slot-list">{slots.slice(0, 45).map(slot => <article key={slot.id} data-slot-id={slot.id} data-business-date={String(slot.businessDate).slice(0, 10)} className={slot.isClosed ? 'closed' : ''}>
          <input type="checkbox" aria-label={`选择${slot.projectName} ${slot.businessDate} ${slot.localStart}`} checked={selectedSlots.includes(slot.id)} onChange={() => toggleSlot(slot.id)} disabled={!slot.outdoor}/>
          <div className="stage26-slot-main"><strong>{slot.projectName}</strong><small>{String(slot.businessDate).slice(0, 10)} · {slot.localStart}–{slot.localEnd} · {slot.outdoor ? '户外' : '室内'} · 时段 {slot.id}</small></div>
          <span>{slot.isClosed ? '已关闭' : `已约 ${slot.booked} / ${slot.capacity} · 余 ${slot.remaining}`}</span>
          <select aria-label={`${slot.projectName} ${slot.localStart}岗位分配`} value={assignments[slot.id] || ''} onChange={event => { setAssignments(current => ({ ...current, [slot.id]: event.target.value })); void assign(slot, event.target.value); }}>
            <option value="">分配岗位</option>{['coach', 'therapist', 'dietitian'].map(job => <option key={job} value={staff.find(person => person.jobType === job)?.id || ''}>{({ coach: '教练', therapist: '理疗师', dietitian: '配餐员' })[job]}</option>)}
          </select>
        </article>)}</div>
        <div className="stage26-weather-controls"><label>天气来源快照编号<input value={snapshotKey} onChange={event => setSnapshotKey(event.target.value)} placeholder="选择快照编号后预览"/></label><label>调整原因<input value={reason} maxLength={500} onChange={event => setReason(event.target.value)}/></label><button type="button" className="outline-btn" onClick={previewWeather} disabled={!selectedSlots.length || !snapshotKey}>预览批量取消</button></div>
        {weatherPreview && <div className="stage26-confirm" data-testid="stage26-weather-preview"><strong>{weatherPreview.snapshot.sourceName} · {weatherPreview.snapshot.observedAt}</strong><p>将取消 {weatherPreview.totalReservations} 条预约并向客人发送站内通知。</p><ul>{weatherPreview.affectedReservations.map(item => <li key={item.id}>{item.guestName} · {item.projectName} {item.localStart}</li>)}</ul><button type="button" className="primary-btn" onClick={commitWeather}>确认批量取消</button><button type="button" className="outline-btn" onClick={() => setWeatherPreview(null)}>返回修改</button></div>}
      </section>
    </section>
    <section className="surface stage26-panel"><header><div><span className="eyebrow">RESERVATION VIEWS</span><h2>{reservationView === 'day' ? '单日预约与异常处置' : '项目周预约与异常处置'}</h2></div><div className="stage26-job-filter"><label>分配岗位<select value={jobType} onChange={event => setJobType(event.target.value)}><option value="coach">教练</option><option value="therapist">理疗师</option><option value="dietitian">配餐员</option></select></label><button type="button" className="outline-btn" onClick={load}>刷新预约</button></div></header>
      <div className="stage26-reservation-filters" data-testid="stage26-reservation-view" data-view={reservationView} data-status={reservationStatus}>
        <div role="group" aria-label="预约时间范围"><button type="button" aria-pressed={reservationView === 'day'} onClick={() => setReservationView('day')}>单日</button><button type="button" aria-pressed={reservationView === 'project-week'} onClick={() => setReservationView('project-week')}>项目周</button></div>
        <label>项目<select aria-label="项目筛选" value={reservationProjectId} onChange={event => setReservationProjectId(event.target.value)}><option value="">全部项目</option>{[...new Map(slots.map(slot => [slot.projectId, slot.projectName])).entries()].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <label>预约状态<select aria-label="预约状态筛选" value={reservationStatus} onChange={event => setReservationStatus(event.target.value)}><option value="all">全部</option><option value="active">有效预约</option><option value="history">历史与取消</option></select></label>
      </div>
      <div className="stage26-reservations" data-testid="stage26-reservation-list">{reservations.map(item => <article key={item.id} data-reservation-id={item.id} data-guest-id={item.guestId} data-status={item.status}><div><strong>{item.projectName} · {item.guestName}</strong><small>{item.businessDate} {item.localStart}–{item.localEnd} · {item.id}</small><small>状态：{businessText(item.status)}{item.checkinStatus ? ` · ${item.checkinStatus}` : ''}{item.rescheduledTo ? ` · 已改至 ${item.rescheduledTo}` : ''}</small></div><div className="stage26-row-actions">{item.status === 'confirmed' && Date.parse(item.startsAt) <= Date.now() && <button type="button" className="outline-btn" onClick={() => markNoShow(item)}>登记未参加</button>}{item.status === 'cancelled' && String(item.cancellationReason || '').startsWith('weather_batch:') && <button type="button" className="outline-btn" onClick={() => inspectAlternatives(item)}>查看替代时段</button>}</div></article>)}</div>
      {rebooking && <div className="stage26-confirm" data-testid="stage26-rebooking"><strong>原预约 {rebooking.reservation.id} · 选择替代时段</strong><p>{rebooking.note}</p><label>可选时段<select value={selectedCandidate} onChange={event => setSelectedCandidate(event.target.value)}>{rebooking.candidates?.map(item => <option key={item.id} value={item.id}>{item.businessDate} {item.localStart}–{item.localEnd} · 余 {item.remaining} · {item.reason || item.safety}</option>)}</select></label><button type="button" className="primary-btn" disabled={!selectedCandidate} onClick={confirmAlternative}>明确确认改约</button><button type="button" className="outline-btn" onClick={() => setRebooking(null)}>取消</button></div>}
    </section>
    <section className="surface stage26-panel"><header><div><span className="eyebrow">SERVICE CONTINUITY</span><h2>服务事项</h2></div></header>
      {incidents.length ? incidents.map(item => <article className="stage26-incident" key={`${item.supplier}:${item.feature}`}><div><strong>{item.supplier} · {item.feature} · {businessText(item.status)}</strong><small>连续失败 {item.failureCount} 次 · {item.firstFailedAt} 至 {item.lastFailedAt}</small><p>{item.impactSummary}</p>{item.recoveredAt && <small>恢复时间 {item.recoveredAt}</small>}</div>{item.status === 'open' && item.recoveredAt && <button type="button" className="primary-btn" onClick={() => closeIncident(item)}>关闭已恢复事项</button>}</article>) : <p className="stage26-muted">目前没有需要跟进的运营事项。</p>}
    </section>
  </div>;
}
