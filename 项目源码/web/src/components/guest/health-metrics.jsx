import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../../lib/request.js';
import { businessToday, healthBusinessDate, healthBusinessTime, healthInputNow, healthValueToUtc, fmtDate } from '../../lib/date.js';
import { initials } from '../../lib/normalize.js';
import { PageTitle } from '../../shared/ui.jsx';
import { BusinessReason, SourceDetails } from '../../SourceDetails.jsx';

const HEALTH_METRIC_OPTIONS = [
  { key: 'blood_pressure', label: '血压', unit: 'mmHg' },
  { key: 'sleep', label: '睡眠时长', unit: 'h' },
  { key: 'steps', label: '步数', unit: '步' },
  { key: 'weight', label: '体重', unit: 'kg' }
];

export function GuestHealth({ me }) {
  const [records, setRecords] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [metric, setMetric] = useState('blood_pressure');
  const [days, setDays] = useState(7);
  const [trend, setTrend] = useState(null);
  const [summary, setSummary] = useState(null);
  const [trendLoading, setTrendLoading] = useState(true);
  const [trendError, setTrendError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [form, setForm] = useState({ systolic: '', diastolic: '', value: '', recordedAt: healthInputNow(), note: '' });
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [retractId, setRetractId] = useState('');
  const [retractReason, setRetractReason] = useState('');
  const [retractError, setRetractError] = useState('');
  const [retracting, setRetracting] = useState(false);

  const activeRecords = useMemo(() => records.filter(record => !record.voidedAt), [records]);
  const latestRecord = activeRecords[0];
  const selectedMetric = HEALTH_METRIC_OPTIONS.find(item => item.key === metric) || HEALTH_METRIC_OPTIONS[0];

  const loadRecords = useCallback(async () => {
    setListLoading(true); setListError('');
    try { setRecords(await request('/me/health-records')); }
    catch (error) { setListError(error.message || '健康记录暂时无法加载'); }
    finally { setListLoading(false); }
  }, []);

  useEffect(() => { loadRecords(); }, [loadRecords, refreshKey]);

  useEffect(() => {
    let active = true;
    setTrendLoading(true); setTrendError('');
    const query = new URLSearchParams({ metric, days: String(days) });
    Promise.all([request(`/me/health-trends?${query}`), request(`/me/health-summary?${query}`)])
      .then(([nextTrend, nextSummary]) => {
        if (!active) return;
        setTrend(nextTrend); setSummary(nextSummary);
      })
      .catch(error => { if (active) setTrendError(error.message || '趋势数据暂时无法加载'); })
      .finally(() => { if (active) setTrendLoading(false); });
    return () => { active = false; };
  }, [metric, days, refreshKey]);

  function updateForm(field, value) {
    setForm(current => ({ ...current, [field]: value }));
    setFieldErrors(current => ({ ...current, [field]: '' }));
    setFormError('');
  }

  async function submitRecord(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setFieldErrors({}); setFormError('');
    try {
      const recordedAt = healthValueToUtc(form.recordedAt);
      const value = metric === 'blood_pressure'
        ? { systolic: form.systolic === '' ? NaN : Number(form.systolic), diastolic: form.diastolic === '' ? NaN : Number(form.diastolic) }
        : form.value === '' ? NaN : Number(form.value);
      await request('/me/health-records', {
        method: 'POST',
        body: JSON.stringify({ metric, value, unit: selectedMetric.unit, recordedAt, note: form.note })
      });
      setForm(current => ({ ...current, systolic: '', diastolic: '', value: '', note: '', recordedAt: healthInputNow() }));
      setRefreshKey(current => current + 1);
    } catch (error) {
      const field = error.data?.details?.field;
      if (field) {
        const inputField = field === 'systolic' || field === 'diastolic' ? field : field === 'recordedAt' ? 'recordedAt' : field === 'unit' ? 'unit' : 'value';
        setFieldErrors(current => ({ ...current, [inputField]: error.message || '请检查此项' }));
      } else setFormError(error.message || '记录保存失败，请稍后重试');
    } finally { setSaving(false); }
  }

  async function submitRetraction(event) {
    event.preventDefault();
    if (!retractId || retracting) return;
    setRetracting(true); setRetractError('');
    try {
      await request(`/me/health-records/${encodeURIComponent(retractId)}`, {
        method: 'DELETE', body: JSON.stringify({ reason: retractReason })
      });
      setRetractId(''); setRetractReason(''); setRefreshKey(current => current + 1);
    } catch (error) { setRetractError(error.message || '撤回失败，请稍后重试'); }
    finally { setRetracting(false); }
  }

  const today = businessToday();
  return <>
    <PageTitle eyebrow="MY HEALTH" title="我的健康状况" desc="记录和查看健康指标；日期和时间统一使用上海时间。"/>
    <div className="health-summary health-metric-summary">
      <div><span>最近记录</span><strong>{latestRecord?.displayValue || '—'}</strong><small>{latestRecord ? `${latestRecord.metricLabel} · ${latestRecord.unit}` : '等待记录'}</small></div>
      <div><span>有效记录</span><strong>{activeRecords.length}</strong><small>撤回记录保留在历史中</small></div>
      <div><span>指标时区</span><strong>上海时间</strong><small>展示与业务日期统一</small></div>
    </div>

    <section className="surface health-entry-surface">
      <div className="health-section-heading"><div><span className="eyebrow">METRIC INPUT</span><h2>新增健康记录</h2><p>录入范围用于演示数据校验，不代表临床诊断标准。</p></div></div>
      <form className="health-entry-form" onSubmit={submitRecord} aria-busy={saving}>
        <label className="health-form-field">指标<select value={metric} onChange={event => { setMetric(event.target.value); setFieldErrors({}); setFormError(''); }}>
          {HEALTH_METRIC_OPTIONS.map(option => <option value={option.key} key={option.key}>{option.label}</option>)}
        </select></label>
        {metric === 'blood_pressure' ? <>
          <label className="health-form-field">收缩压（mmHg）<input type="number" inputMode="decimal" step="any" value={form.systolic} onChange={event => updateForm('systolic', event.target.value)} aria-invalid={Boolean(fieldErrors.systolic)}/>{fieldErrors.systolic && <small className="health-field-error" role="alert">{fieldErrors.systolic}</small>}</label>
          <label className="health-form-field">舒张压（mmHg）<input type="number" inputMode="decimal" step="any" value={form.diastolic} onChange={event => updateForm('diastolic', event.target.value)} aria-invalid={Boolean(fieldErrors.diastolic)}/>{fieldErrors.diastolic && <small className="health-field-error" role="alert">{fieldErrors.diastolic}</small>}</label>
        </> : <label className="health-form-field">{selectedMetric.label}（{selectedMetric.unit}）<input type="number" inputMode="decimal" step={metric === 'steps' ? '1' : 'any'} value={form.value} onChange={event => updateForm('value', event.target.value)} aria-invalid={Boolean(fieldErrors.value)}/>{fieldErrors.value && <small className="health-field-error" role="alert">{fieldErrors.value}</small>}</label>}
        <label className="health-form-field">记录时间（上海时间）<input type="datetime-local" value={form.recordedAt} onChange={event => updateForm('recordedAt', event.target.value)} aria-invalid={Boolean(fieldErrors.recordedAt)}/>{fieldErrors.recordedAt && <small className="health-field-error" role="alert">{fieldErrors.recordedAt}</small>}</label>
        <label className="health-form-field">备注（选填）<input type="text" maxLength={500} value={form.note} onChange={event => updateForm('note', event.target.value)}/></label>
        {fieldErrors.unit && <p className="health-field-error health-wide-field" role="alert">{fieldErrors.unit}</p>}
        {formError && <p className="health-field-error health-wide-field" role="alert">{formError}</p>}
        <div className="health-form-actions health-wide-field"><span>数据会关联当前登录账号和录入来源。</span><button type="submit" className="primary-btn" disabled={saving}>{saving ? '保存中…' : '保存记录　→'}</button></div>
      </form>
    </section>

    <section className="surface health-trend-surface">
      <div className="health-section-heading health-trend-heading"><div><span className="eyebrow">TREND</span><h2>{selectedMetric.label}趋势</h2><p>每天显示最新有效记录；撤回的记录不参与趋势。</p></div>
        <div className="health-trend-controls"><label>指标<select aria-label="趋势指标" value={metric} onChange={event => setMetric(event.target.value)}>{HEALTH_METRIC_OPTIONS.map(option => <option value={option.key} key={option.key}>{option.label}</option>)}</select></label><div className="health-window-toggle" role="group" aria-label="趋势窗口">{[7, 30].map(windowDays => <button type="button" className={days === windowDays ? 'active' : ''} aria-pressed={days === windowDays} key={windowDays} onClick={() => setDays(windowDays)}>{windowDays}日</button>)}</div></div>
      </div>
      {trendLoading ? <div className="health-chart-state" role="status">正在加载趋势与摘要…</div> : trendError ? <div className="health-chart-state health-error-state" role="alert"><span>{trendError}</span><button type="button" className="outline-btn" onClick={() => setRefreshKey(current => current + 1)}>重试</button></div> : trend ? <>
        <HealthMetricChart trend={trend}/>
        <div className={`health-trend-summary ${summary?.status === 'insufficient_data' ? 'insufficient' : ''}`}>
          <strong>{summary?.status === 'insufficient_data' ? '样本不足' : '变化摘要'}</strong>
          {summary?.status === 'insufficient_data' ? <BusinessReason value={summary.reason}/> : <><p>{summary?.changeDescription || '暂无可比较变化'}</p><small>窗口 {summary?.window?.start} 至 {summary?.window?.end} · 有效样本 {summary?.sampleCount} 天 · 缺失 {summary?.missingDayCount} 天</small><SourceDetails data={{sourceRecordIds:summary?.sourceRecordIds}}/></>}
          <small className="health-demo-note">{summary?.demoRule?.note || trend.demoRule?.note}</small><SourceDetails data={summary?.demoRule || trend.demoRule}/>
        </div>
      </> : null}
    </section>

    <section className="surface health-records-surface">
      <div className="health-section-heading"><div><span className="eyebrow">RECORD HISTORY</span><h2>健康记录</h2><p>记录按时间倒序；撤回项保留审计信息，但不参与趋势和摘要。</p></div><button type="button" className="outline-btn" onClick={loadRecords} disabled={listLoading}>刷新　↻</button></div>
      {listLoading ? <div className="health-chart-state" role="status">正在加载健康记录…</div> : listError ? <div className="health-chart-state health-error-state" role="alert"><span>{listError}</span><button type="button" className="outline-btn" onClick={loadRecords}>重试</button></div> : records.length ? <div className="health-record-list">
        {records.map(record => {
          const isOwn = record.source === 'guest' && record.recordedBy === me.id;
          const isToday = healthBusinessDate(record.recordedAt) === today;
          return <article className={`health-record-row ${record.voidedAt ? 'retracted' : ''}`} key={record.id}>
            <div className="health-record-metric"><strong>{record.metricLabel}</strong><small>{record.unit || '单位未提供'}{record.parseStatus !== 'valid' ? ' · 旧值未解析' : ''}</small></div>
            <div className="health-record-value">{record.displayValue}{record.demoOutlier && <span className="health-outlier-tag" title={record.demoRule.note}>演示异常值</span>}</div>
            <div className="health-record-note">{record.note || '—'}</div>
            <div className="health-record-source"><strong>{record.source === 'guest' ? '客人录入' : record.source === 'device' ? '设备记录' : record.source === 'import' ? '导入记录' : '工作人员记录'}</strong><small>{record.recorderName || '录入人未提供'}</small></div>
            <div className="health-record-time"><strong>{healthBusinessTime(record.recordedAt)}</strong><SourceDetails data={record}/></div>
            <div className="health-record-action">{record.voidedAt ? <span className="health-retracted-label">已撤回</span> : isOwn && isToday ? <button type="button" className="health-retract-trigger" onClick={() => { setRetractId(String(record.id)); setRetractReason(''); setRetractError(''); }}>撤回</button> : isOwn ? <span className="health-expired-label" title="仅可撤回上海时间当天录入的记录">已过撤回时间</span> : null}</div>
            {record.voidedAt && <div className="health-retraction-audit">撤回于 {healthBusinessTime(record.voidedAt)} · 原因：{record.voidReason || '未提供'}</div>}
            {retractId === String(record.id) && <form className="health-retract-form" onSubmit={submitRetraction}><label>撤回原因<input autoFocus maxLength={500} value={retractReason} onChange={event => { setRetractReason(event.target.value); setRetractError(''); }} placeholder="请说明撤回原因"/></label>{retractError && <small role="alert" className="health-field-error">{retractError}</small>}<div><button className="outline-btn" type="button" onClick={() => setRetractId('')}>取消</button><button className="primary-btn" type="submit" disabled={retracting}>{retracting ? '提交中…' : '确认撤回'}</button></div></form>}
          </article>;
        })}
      </div> : <div className="health-chart-state"><strong>暂无健康记录</strong><span>保存第一条指标后，记录和趋势会显示在这里。</span></div>}
    </section>
  </>;
}

function HealthMetricChart({ trend }) {
  const width = 820;
  const height = 260;
  const padding = { left: 48, right: 18, top: 18, bottom: 35 };
  const series = trend.series || [];
  const values = series.flatMap(item => item.points.map(point => point.value).filter(value => value !== null && Number.isFinite(value)));
  const minValue = values.length ? Math.min(...values) : 0;
  const maxValue = values.length ? Math.max(...values) : 1;
  const spread = maxValue - minValue;
  const domainMin = values.length ? Math.max(0, minValue - (spread || Math.max(Math.abs(minValue) * .1, 1)) * .18) : 0;
  const domainMax = values.length ? maxValue + (spread || Math.max(Math.abs(maxValue) * .1, 1)) * .18 : 1;
  const xFor = index => padding.left + index * (width - padding.left - padding.right) / Math.max(1, trend.days - 1);
  const yFor = value => padding.top + (domainMax - value) * (height - padding.top - padding.bottom) / (domainMax - domainMin || 1);
  const palette = ['#14867e', '#df9a48'];
  const [hovered, setHovered] = useState(null);
  function pathRuns(points) {
    const paths = [];
    let current = [];
    points.forEach((point, index) => {
      if (point.value === null || !Number.isFinite(point.value)) {
        if (current.length) paths.push(current);
        current = [];
      } else current.push({ ...point, index });
    });
    if (current.length) paths.push(current);
    return paths;
  }
  const yTicks = values.length ? 4 : 2;
  return <div className="health-chart-wrap">
    {!values.length ? <div className="health-chart-empty"><span>◌</span><strong>当前窗口没有可绘制的指标样本</strong><small>缺失日期保持为空，不会补成 0。</small></div> : <>
      <div className="health-chart-legend">{series.map((item, index) => <span key={item.key}><i style={{ background: palette[index % palette.length] }}/>{item.label}（{item.unit}）</span>)}<small>演示范围；不用于诊断</small></div>
      <svg className="health-metric-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${trend.metricLabel}最近${trend.days}日趋势图`} preserveAspectRatio="none">
        {Array.from({ length: yTicks }, (_, index) => {
          const ratio = yTicks === 1 ? .5 : index / (yTicks - 1);
          const y = padding.top + ratio * (height - padding.top - padding.bottom);
          const label = values.length ? (domainMax - ratio * (domainMax - domainMin)).toFixed(0) : '';
          return <g key={`grid-${index}`}><line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="health-chart-gridline"/><text x={padding.left - 10} y={y + 4} textAnchor="end" className="health-chart-axis-label">{label}</text></g>;
        })}
        {series.map((item, seriesIndex) => pathRuns(item.points).map((run, runIndex) => <path key={`${item.key}-${runIndex}`} d={run.map((point, index) => `${index ? 'L' : 'M'} ${xFor(point.index)} ${yFor(point.value)}`).join(' ')} fill="none" stroke={palette[seriesIndex % palette.length]} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"/>))}
        {series.map((item, seriesIndex) => item.points.map((point, index) => point.value === null ? null : <g key={`${item.key}-${point.date}`} onMouseEnter={() => setHovered({ point, series: item, x: xFor(index), y: yFor(point.value) })} onMouseLeave={() => setHovered(null)} tabIndex="0" onFocus={() => setHovered({ point, series: item, x: xFor(index), y: yFor(point.value) })} onBlur={() => setHovered(null)}>
          <circle cx={xFor(index)} cy={yFor(point.value)} r="13" fill="transparent"/><circle cx={xFor(index)} cy={yFor(point.value)} r="4.5" fill={palette[seriesIndex % palette.length]} stroke="#fff" strokeWidth="2"/>
          <title>{`${item.label} ${point.value} ${point.unit} · ${point.date} · 记录 ${point.recordIds.join(', ')}`}</title>
        </g>))}
        {[0, Math.floor((trend.days - 1) / 2), trend.days - 1].filter((value, index, list) => list.indexOf(value) === index).map(index => <text key={`date-${index}`} x={xFor(index)} y={height - 10} textAnchor={index === 0 ? 'start' : index === trend.days - 1 ? 'end' : 'middle'} className="health-chart-axis-label">{trend.points[index]?.date.slice(5)}</text>)}
      </svg>
      {hovered && <div className="health-chart-tooltip" role="status"><strong>{hovered.series.label}：{hovered.point.value} {hovered.point.unit}</strong><span>{hovered.point.date} · 上海业务日</span><small>源记录：{hovered.point.recordIds.join('、') || '—'}</small>{hovered.point.demoOutlier && <small className="health-demo-note">演示阈值命中；仅用于界面说明，不代表诊断。</small>}</div>}
      <div className="health-chart-footnote">缺失日期不连线 · 有效采样 {trend.sampleCount} 天 · 缺失 {trend.missingDayCount} 天</div>
    </>}
  </div>;
}

export function GuestAdvice({ me }) {
  return <><PageTitle eyebrow="MY ADVICE" title="我的医嘱" desc="工作人员给你的专业建议会在这里持续保留，执行前请仔细阅读。"/><div className="advice-list">{me.advice?.map(advice => <article className="surface advice-card" key={advice.id}><div className="advice-card-head"><div className={`advice-priority ${advice.priority}`}>{advice.priority === 'urgent' ? '紧急' : advice.priority === 'important' ? '重要' : '建议'}</div><span>{fmtDate(advice.createdAt)}</span></div><h2>{advice.title}</h2><p>{advice.content}</p><footer><span className="avatar small">{initials(advice.authorName)}</span><span>{advice.authorName || '工作人员'} 发布</span><span className="advice-active">● 生效中</span></footer></article>)}</div>{!me.advice?.length && <div className="surface empty-large"><div>✚</div><h2>暂时没有医嘱</h2><p>工作人员新增建议后，会第一时间出现在这里。</p></div>}</>;
}
