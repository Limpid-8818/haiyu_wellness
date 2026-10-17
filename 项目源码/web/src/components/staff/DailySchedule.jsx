import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../lib/request.js';
import { businessToday, mealLocalTime } from '../../lib/date.js';
import { STAFF_JOB_LABELS } from '../../app/navigation.js';
import { PageTitle, Empty } from '../../shared/ui.jsx';
import { SourceDetails } from '../../SourceDetails.jsx';

export function StaffDailySchedule({ jobType, notify }) {
  const [date, setDate] = useState(businessToday);
  const [data, setData] = useState(null); const [error, setError] = useState('');
  const [notes, setNotes] = useState({}); const [busy, setBusy] = useState('');
  const scheduleLoadGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++scheduleLoadGeneration.current;
    setError('');
    try {
      const next = await request(`/staff/schedule?date=${encodeURIComponent(date)}`);
      if (generation === scheduleLoadGeneration.current) setData(next);
    } catch (err) { if (generation === scheduleLoadGeneration.current) setError(err.message); }
  }, [date]);
  useEffect(() => { void load(); }, [load]);
  async function record(item, status) {
    setBusy(item.reservationId);
    try { await request(`/staff/schedule/${item.reservationId}/execution`, { method: 'POST', body: JSON.stringify({ status, note: notes[item.reservationId] || '' }) }); notify('服务工作记录已保存，客人可回读'); await load(); }
    catch (err) { setError(err.message); notify(err.message); } finally { setBusy(''); }
  }
  const label = jobType === 'coach' ? '教练每日安排' : '理疗师工作安排';
  return <div className="stage26-operations" data-testid="stage26-staff-schedule"><PageTitle eyebrow="SERVICE SCHEDULE" title={label} desc="查看本人时段分工及负责客人的签到/反馈；服务结束后记录完成，未参加须在开始后登记。" action={<button type="button" className="outline-btn" onClick={load}>刷新日程</button>}/><section className="surface stage26-filter-row"><label>业务日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label><span>{data?.total ?? 0} 个任务 · {STAFF_JOB_LABELS[jobType]}</span></section>{error && <div className="stage26-error" role="alert">{error}</div>}<section className="surface stage26-panel stage26-reservations">{data?.items?.length ? data.items.map(item => {
    const execution = item.executions?.find(entry => entry.jobType === jobType);
    return <article key={`${item.id}:${item.reservationId || 'empty'}`} data-reservation-id={item.reservationId || ''} data-guest-id={item.guestId || ''}><div><strong>{item.projectName} · {item.guestName || '暂无有效负责关系或预约'}</strong><SourceDetails><small>{item.businessDate} {item.localStart}–{item.localEnd} · {item.reservationId || '尚无可处理预约'}</small></SourceDetails>
      {item.reservationId && <><p>{item.checkin ? `客人已签到 · ${mealLocalTime(item.checkin.checkedInAt)}` : '客人尚未签到'}</p>{item.feedback && <p>客人反馈第 {item.feedback.revision} 版：{({comfortable:'舒服',general:'一般',uncomfortable:'不舒服'})[item.feedback.feeling] || item.feedback.feeling} · {item.feedback.note}</p>}
      {execution ? <p role="status">{execution.status === 'completed' ? '服务已完成' : '已登记未参加'} · {execution.actorName} · {execution.note}</p> : <div className="meal-swap-form"><label>服务工作说明<textarea aria-label="服务工作说明" maxLength={500} value={notes[item.reservationId] || ''} onChange={event => setNotes(current => ({ ...current, [item.reservationId]: event.target.value }))}/></label><button type="button" className="primary-btn" disabled={Boolean(busy) || !item.checkin || !notes[item.reservationId]?.trim()} onClick={() => record(item, 'completed')}>记录服务完成</button><button type="button" className="outline-btn" disabled={Boolean(busy) || Boolean(item.checkin) || !notes[item.reservationId]?.trim()} onClick={() => record(item, 'no_show')}>登记未参加</button></div>}</>}
    </div></article>;
  }) : <Empty text="当天没有已分配的服务时段。"/>}<small className="stage26-muted">{data?.privacyNote}</small></section></div>;
}
