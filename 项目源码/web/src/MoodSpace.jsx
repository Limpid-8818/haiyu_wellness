import {businessText} from '../../shared/release-presentation.js';
import {SourceDetails} from './SourceDetails.jsx';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const MOOD_OPTIONS = [
  { score: 1, label: '很难受', face: '☁', tone: 'low' },
  { score: 2, label: '有些烦闷', face: '🌧', tone: 'low' },
  { score: 3, label: '一般', face: '◐', tone: 'steady' },
  { score: 4, label: '比较平静', face: '🌤', tone: 'calm' },
  { score: 5, label: '心情不错', face: '☀', tone: 'good' }
];

function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

function businessToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function MoodSpace({ requestApi, activeResource, onSelectResource }) {
  const [catalog, setCatalog] = useState([]);
  const [records, setRecords] = useState([]);
  const [summary, setSummary] = useState(null);
  const [trend, setTrend] = useState(null);
  const [focusItems, setFocusItems] = useState([]);
  const [days, setDays] = useState(7);
  const [selectedDate, setSelectedDate] = useState('');
  const [score, setScore] = useState(3);
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const todayRecord = useMemo(() => records.find(item => item.businessDate === businessToday()) || null, [records]);
  const selectedPoint = useMemo(() => trend?.points?.find(point => point.date === selectedDate) || null, [trend, selectedDate]);
  const selectedReplanEvent = useMemo(() => trend?.replanEvents?.find(item => item.businessDate === selectedDate) || null,
    [trend, selectedDate]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextCatalog, nextRecords, nextSummary, nextFocus] = await Promise.all([
        requestApi('/mood/resources'),
        requestApi('/me/moods'),
        requestApi('/me/mood-summary'),
        requestApi('/me/mood-focus-items')
      ]);
      setCatalog(nextCatalog);
      setRecords(nextRecords);
      setSummary(nextSummary);
      setFocusItems(nextFocus);
      const today = nextRecords.find(item => item.businessDate === businessToday());
      setScore(today?.score || 3);
      setNote(today?.note || '');
    } catch (loadError) {
      setError(loadError.message || '心情记录暂时无法加载');
    } finally { setLoading(false); }
  }, [requestApi]);

  useEffect(() => { loadData(); }, [loadData, refreshKey]);
  useEffect(() => {
    let current = true;
    setTrend(null);
    requestApi(`/me/mood-trends?days=${days}`)
      .then(next => { if (current) setTrend(next); })
      .catch(loadError => { if (current) setError(loadError.message || '心情趋势暂时无法加载'); });
    return () => { current = false; };
  }, [requestApi, days, refreshKey]);
  useEffect(() => {
    if (!trend?.points?.length) return;
    const latest = [...trend.points].reverse().find(point => point.recordId);
    setSelectedDate(previous => trend.points.some(point => point.date === previous && point.recordId) ? previous : latest?.date || trend.endDate);
  }, [trend]);

  async function saveMood(event) {
    event?.preventDefault();
    if (saving) return;
    setSaving(true);
    setNotice('');
    try {
      let saved;
      if (todayRecord) {
        saved = await requestApi(`/me/moods/${todayRecord.id}`, {
          method: 'PUT', body: JSON.stringify({ score, note })
        });
        setNotice(`已更新今天的记录；仍是同一条记录。`);
      } else {
        saved = await requestApi('/me/moods', {
          method: 'POST', body: JSON.stringify({ score, note })
        });
        setNotice(`已保存今天的记录。`);
      }
      setEditing(false);
      setRefreshKey(value => value + 1);
    } catch (saveError) {
      if (saveError.code === 'MOOD_ALREADY_RECORDED') {
        setNotice('今天已经有一条心情记录。已载入原记录，请明确修改后再保存；系统不会再建一条。');
        setRefreshKey(value => value + 1);
      } else setNotice(saveError.message || '心情记录未能保存，请重试。');
    } finally { setSaving(false); }
  }

  function chooseQuickMood(option) {
    setScore(option.score);
    setNotice('');
    if (todayRecord) {
      setNote(todayRecord.note || '');
      setEditing(true);
      setNotice(`今天已记录为“${todayRecord.label}”。请检查备注并点击“保存修改”以明确更新。`);
      return;
    }
    if (saving) return;
    setEditing(false);
    setSaving(true);
    requestApi('/me/moods', { method: 'POST', body: JSON.stringify({ score: option.score, note: '' }) })
      .then(saved => {
        setNotice(`已保存今天的心情“${saved.label}”。`);
        setRefreshKey(value => value + 1);
      })
      .catch(saveError => {
        if (saveError.code === 'MOOD_ALREADY_RECORDED') {
          setNotice('今天已经有一条心情记录。已载入原记录，请明确修改后再保存；系统不会再建一条。');
          setRefreshKey(value => value + 1);
        } else setNotice(saveError.message || '心情记录未能保存，请重试。');
      })
      .finally(() => setSaving(false));
  }

  function startEdit() {
    if (!todayRecord) return;
    setScore(todayRecord.score);
    setNote(todayRecord.note || '');
    setEditing(true);
    setNotice(`正在编辑今日记录。保存会更新这条记录，不会新增。`);
  }

  return <div className="mood-page" aria-busy={loading || saving}>
    <div className="mood-page-title">
      <div><span className="eyebrow">MOOD &amp; COMPANION</span><h1>心情与陪伴</h1><p>为今天留下一条记录，也可以挑选一段自己愿意听的内容。</p></div>
      <div className="mood-date-chip"><span aria-hidden="true">◷</span> 上海时间 · {trend?.endDate || businessToday()}</div>
    </div>

    {error && <div className="mood-error" role="alert"><span>{error}</span><button type="button" className="outline-btn" onClick={() => setRefreshKey(value => value + 1)}>重试</button></div>}
    {loading ? <section className="surface mood-loading" role="status">正在读取心情记录和陪伴资源…</section> : <>
      <section className="surface mood-checkin">
        <div className="mood-section-heading"><div><span className="eyebrow">TODAY CHECK-IN</span><h2>此刻的心情怎么样？</h2><p>选择最接近的一档即可。它只是自我记录，不是测评。</p></div>
          {todayRecord && <span className="mood-record-badge">今天已记录</span>}
        </div>
        <div className="mood-quick-options" role="group" aria-label="选择心情档位">
          {MOOD_OPTIONS.map(option => <button type="button" key={option.score}
            className={`mood-option mood-${option.tone} ${score === option.score && editing ? 'selected' : ''}`}
            aria-pressed={score === option.score && editing}
            onClick={() => chooseQuickMood(option)}>
            <span className="mood-option-face" aria-hidden="true">{option.face}</span><strong>{option.label}</strong><small>{option.score}/5</small>
          </button>)}
        </div>
        {todayRecord && !editing && <div className="mood-today-saved"><div><strong>今天已记录：{todayRecord.label}</strong><span>{todayRecord.note || '没有填写备注'}</span></div><button type="button" className="outline-btn" onClick={startEdit}>编辑今日记录</button></div>}
        {editing && <form className="mood-edit-form" onSubmit={saveMood}>
          <label className="mood-note-label" htmlFor="mood-note">想留下一句备注吗？<textarea id="mood-note" aria-label="想留下一句备注吗？" rows="3" maxLength={500} value={note} onChange={event => setNote(event.target.value)} placeholder="可以写下此刻的感受，也可以留空。"/></label>
          <div className="mood-form-actions"><span>{todayRecord ? '将修改今天的同一条记录' : '快捷选择与详细备注会保存到同一条今日记录'}</span><div><button type="button" className="outline-btn" onClick={() => { setEditing(false); setNotice(''); }} disabled={saving}>取消</button><button type="submit" className="primary-btn" disabled={saving}>{saving ? '保存中…' : todayRecord ? '保存修改' : '保存今天的心情'}</button></div></div>
        </form>}
        {notice && <div className="mood-notice" role="status" aria-live="polite">{notice}</div>}
      </section>

      <section className="surface mood-trend-section">
        <div className="mood-section-heading"><div><span className="eyebrow">RECENT TREND</span><h2>最近的心情记录</h2><p>没有记录的日期保持空白，不会作为低分显示。选择有记录的日期查看原始内容。</p></div>
          <div className="mood-window-toggle" role="group" aria-label="心情趋势时间范围">{[7, 30].map(value => <button type="button" key={value} className={days === value ? 'active' : ''} aria-pressed={days === value} onClick={() => setDays(value)}>{value} 日</button>)}</div>
        </div>
        {trend ? <>
          <div className={`mood-calendar mood-calendar-${days}`} role="group" aria-label={`最近${days}日心情日期`}>
            {trend.points.map(point => <button type="button" key={point.date}
              className={`mood-day ${point.recordId ? 'has-record' : 'empty'} ${trend.replanEvents?.some(item => item.businessDate === point.date) ? 'has-replan-event' : ''} ${selectedDate === point.date ? 'selected' : ''}`}
              aria-label={`${point.date}${point.recordId ? `，${point.score}分，记录编号${point.recordId}` : '，无记录'}${trend.replanEvents?.some(item => item.businessDate === point.date) ? '，有疗程评估事件' : ''}`}
              aria-pressed={selectedDate === point.date} disabled={!point.recordId}
              onClick={() => setSelectedDate(point.date)}>
              <span>{point.date.slice(5)}</span><strong>{point.recordId ? `${point.score}/5` : '—'}</strong>
              {trend.replanEvents?.some(item => item.businessDate === point.date) && <i aria-hidden="true">调整事件</i>}
            </button>)}
          </div>
          <div className="mood-trend-foot">{trend.sampleCount} 个有记录日 · {trend.missingDayCount} 天留空</div>
          {selectedPoint?.recordId ? <article className="mood-selected-record" aria-live="polite">
            <div className="mood-selected-score"><strong>{selectedPoint.score}/5</strong><span>{MOOD_OPTIONS.find(item => item.score === selectedPoint.score)?.label}</span></div>
            <div><small>日期</small><strong>{selectedPoint.date}</strong></div>
            <div><small>备注</small><strong>{selectedPoint.note || '没有填写备注'}</strong></div>
            <SourceDetails data={selectedPoint}/>
          </article> : <div className="mood-insufficient" role="status">所选日期没有心情记录。</div>}
          {selectedReplanEvent && <article className="mood-replan-event" data-testid="mood-replan-event" aria-live="polite">
            <div><span className="eyebrow">RECORDED REPLANNING EVENT</span><strong>同日来源事件</strong></div>
            <p>心情变化记录 · 来源版本 {selectedReplanEvent.sourceVersion} · {selectedReplanEvent.businessDate}</p>
            <p>候选疗程版本：{selectedReplanEvent.candidateVersion ? `第 ${selectedReplanEvent.candidateVersion} 版` : '尚未生成'}</p><SourceDetails data={selectedReplanEvent}/>
            <p>审核状态：{selectedReplanEvent.candidateReviewStatus === 'pending_review' ? '待医护审核'
              : selectedReplanEvent.candidateReviewStatus === 'active' || selectedReplanEvent.candidateReviewStatus === 'auto_activated' ? '已激活'
                : businessText(selectedReplanEvent.candidateReviewStatus) || '已记录'}。</p>
            <small>这里只表示同一日期存在两条可追溯记录，不表示心情变化导致了疗程调整。</small>
          </article>}
        </> : <div className="mood-loading" role="status">正在生成趋势…</div>}
      </section>

      <section className="mood-focus-list" aria-label="持续负面关注事项">
        {focusItems.filter(item => item.status === 'open').map(item => <article className="mood-focus-item" key={item.id}>
          <span className="mood-focus-icon" aria-hidden="true">♡</span><div><strong>待人工关注</strong><p>{item.startDate} 至 {item.endDate} 有连续低分记录（演示规则）。</p><small>演示规则不构成诊断；如需要，请联系现场工作人员。</small><SourceDetails data={item}/></div>
        </article>)}
        {focusItems.some(item => item.status === 'improved') && <div className="mood-improved-note" role="status">已为先前关注事项记录后续心情变化。记录只描述自填分值。</div>}
      </section>

      <section className="mood-resource-section">
        <div className="mood-section-heading mood-resource-heading"><div><span className="eyebrow">COMPANION LIBRARY</span><h2>陪伴资源</h2><p>所有播放均需你主动点击。口播课程为本地演示内容，授权说明见每张卡片。</p></div><div className="mood-usage-summary">已记录 {summary?.resources?.reduce((sum, item) => sum + item.playCount, 0) || 0} 次播放</div></div>
        <div className="mood-resource-grid">
          {catalog.map(resource => <article className={`surface mood-resource-card ${activeResource?.id === resource.id ? 'active' : ''}`} key={resource.id}>
            <img className="mood-resource-cover" src={resource.coverUrl} alt={`${resource.title}封面`} loading="lazy"/>
            <div className="mood-resource-meta"><span>{resource.category === 'ambient' ? '环境音' : '引导课程'}</span><span>{formatDuration(resource.durationSeconds)}</span></div>
            <h3>{resource.title}</h3><p>{resource.subtitle}</p>
            <div className="mood-resource-credit"><strong>来源</strong><span>{resource.source}</span><strong>授权说明</strong><span>{resource.license}</span></div>
            <div className="mood-resource-actions"><span>已播放 {summary?.resources?.find(item => item.id === resource.id)?.playCount || 0} 次</span><button type="button" className="outline-btn" onClick={() => onSelectResource(resource)}>{activeResource?.id === resource.id ? '当前播放器' : '打开播放器'}</button></div>
          </article>)}
          {!catalog.length && <div className="surface mood-loading" role="status">当前没有可播放资源。</div>}
        </div>
        <div className="mood-usage-boundary">播放次数只用于显示资源使用情况，不代表心情改善或心理健康变化。</div>
      </section>
    </>}
  </div>;
}

export function MoodPlayerDock({ resource, requestApi }) {
  const audioRef = useRef(null);
  const eventIdRef = useRef(null);
  const [error, setError] = useState('');
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [usageError, setUsageError] = useState('');

  useEffect(() => {
    const audio = audioRef.current;
    eventIdRef.current = null;
    setError(''); setUsageError(''); setPosition(0); setDuration(0); setIsPlaying(false);
    if (!audio) return;
    if (!resource) { audio.pause(); audio.removeAttribute('src'); audio.load(); return; }
    audio.src = resource.audioUrl;
    audio.load();
  }, [resource?.id, resource?.audioUrl]);

  async function togglePlayback() {
    const audio = audioRef.current;
    if (!audio || !resource) return;
    if (!audio.paused) { audio.pause(); return; }
    setError('');
    try { await audio.play(); }
    catch { setError('播放未能开始。请检查资源连接后点击“重新加载”再试。'); }
  }

  async function recordPlay() {
    if (!resource || eventIdRef.current) return;
    const eventId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2).padEnd(32, '0')}`;
    eventIdRef.current = eventId;
    try {
      await requestApi(`/me/mood-resources/${resource.id}/usage`, { method: 'POST', body: JSON.stringify({ eventId }) });
    } catch { setUsageError('播放已开始，但暂时未能记录使用次数。'); }
  }

  function reload() {
    const audio = audioRef.current;
    if (!audio || !resource) return;
    eventIdRef.current = null;
    setError(''); setUsageError(''); setPosition(0);
    audio.src = resource.audioUrl;
    audio.load();
  }

  return <aside className={`mood-player-dock ${resource ? 'has-resource' : 'empty-player'}`} aria-label="持续播放面板" data-testid="mood-player-dock">
    {resource ? <>
      <img src={resource.coverUrl} alt="" className="mood-player-cover"/>
      <div className="mood-player-copy"><strong>{resource.title}</strong><span>{formatDuration(position)} / {formatDuration(duration || resource.durationSeconds)}</span></div>
      <button type="button" className="mood-player-toggle" onClick={togglePlayback}>{isPlaying ? '暂停' : '播放'}</button>
      <audio ref={audioRef} controls preload="metadata" aria-label={`${resource.title}播放控制`}
        onPlay={() => { setIsPlaying(true); recordPlay(); setError(''); }}
        onPause={() => setIsPlaying(false)}
        onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
        onEnded={() => { eventIdRef.current = null; }}
        onError={() => setError('资源加载失败。可以重新加载，或选择其他内容。')}/>
      {error && <div className="mood-player-error" role="alert">{error}<button type="button" onClick={reload}>重新加载</button></div>}
      {usageError && <div className="mood-player-usage" role="status">{usageError}</div>}
    </> : <div className="mood-player-empty"><span aria-hidden="true">♫</span><span>选择一段陪伴资源后，可在站内切换页面时继续播放。</span></div>}
  </aside>;
}
