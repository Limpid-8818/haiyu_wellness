import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../../lib/request.js';
import { asText, normalizeGuestSummary } from '../../lib/normalize.js';
import { PageTitle, Field, ReadonlyField, Empty, QueryState } from '../../shared/ui.jsx';
import { admissionLabel } from '../../app/navigation.js';
import { PasswordPanel } from '../../shared/PasswordPanel.jsx';
import { SourceDetails } from '../../SourceDetails.jsx';

const PROFILE_FIELD_LIMITS = { phone: 32, emergencyContact: 128, mobility: 128 };

export const HEALTH_PROFILE_FIELDS = [
  { key: 'chronic', label: '慢病史', kind: 'list' },
  { key: 'medications', label: '长期用药说明', kind: 'medications' },
  { key: 'allergies', label: '过敏源', kind: 'list' },
  { key: 'dietaryRestrictions', label: '饮食忌口', kind: 'list' },
  { key: 'mobility', label: '行动能力', kind: 'mobility' },
  { key: 'sleep', label: '睡眠情况', kind: 'text' },
  { key: 'skin', label: '皮肤状况', kind: 'text' },
  { key: 'audienceTags', label: '客群标签', kind: 'list' }
];

const HEALTH_STATUS_LABELS = {
  unanswered: '暂不回答',
  none: '无',
  reported: '有，需要补充',
  unknown: '不确定',
  independent: '可独立行动',
  assistance: '需要协助'
};

function emptyHealthProfileUi() {
  return {
    chronic: { status: 'unanswered', items: [] },
    medications: { status: 'unanswered', items: [] },
    allergies: { status: 'unanswered', items: [] },
    dietaryRestrictions: { status: 'unanswered', items: [] },
    mobility: { status: 'unanswered', details: '' },
    sleep: { status: 'unanswered', details: '' },
    skin: { status: 'unanswered', details: '' },
    audienceTags: { status: 'unanswered', items: [] }
  };
}

function healthProfileCompletenessUi(profile) {
  const missing = HEALTH_PROFILE_FIELDS.filter(field => (profile?.[field.key]?.status || 'unanswered') === 'unanswered');
  const completed = HEALTH_PROFILE_FIELDS.length - missing.length;
  return {
    completed,
    total: HEALTH_PROFILE_FIELDS.length,
    percent: Math.round((completed / HEALTH_PROFILE_FIELDS.length) * 100),
    missing
  };
}

export function displayHealthField(key, value) {
  const entry = value || { status: 'unanswered' };
  const status = HEALTH_STATUS_LABELS[entry.status] || '暂不回答';
  if (entry.status === 'reported') {
    if (Array.isArray(entry.items)) {
      if (key === 'medications') return entry.items.map(item => `${item.originalText}（${item.timing}）`).join('；') || status;
      return entry.items.join('、') || status;
    }
    return entry.details || status;
  }
  if (['independent', 'assistance'].includes(entry.status)) return entry.details ? `${status}；${entry.details}` : status;
  return status;
}

export function formalHealthSummary(profile, key) {
  const entry = profile?.health_profile?.[key];
  if (entry?.status && entry.status !== 'unanswered') {
    return entry.status === 'none' ? '已核实：无' : entry.status === 'unknown' ? '正式档案：不确定，待核实' : displayHealthField(key, entry);
  }
  const legacy = profile?.[key];
  return `正式档案：尚未回答或核实${legacy?.length ? `；旧记录供核对：${legacy.join('、')}` : ''}`;
}

export function HealthIntakeHistory({ history = [] }) {
  if (!history.length) return <Empty text="还没有健康自述或核实记录"/>;
  return <div className="health-intake-history">{history.map(item => {
    const before = item.verifiedBefore || item.before || {};
    const after = item.verifiedAfter || item.after || item.candidate || {};
    const changes = HEALTH_PROFILE_FIELDS.map(field => ({
      label: field.label,
      before: displayHealthField(field.key, before[field.key]),
      after: displayHealthField(field.key, after[field.key])
    })).filter(change => change.before !== change.after);
    const submittedCandidate = item.status === 'rejected' && item.candidate
      ? HEALTH_PROFILE_FIELDS.map(field => ({
        label: field.label,
        value: displayHealthField(field.key, item.candidate[field.key]),
        status: HEALTH_STATUS_LABELS[item.candidate[field.key]?.status] || '暂不回答'
      }))
      : [];
    const statusLabel = item.status === 'confirmed' ? '已人工核实' : item.status === 'rejected' ? '已驳回' : '待核实';
    const actor = item.reviewerName || item.submitterName || (item.source === 'assistant' ? '健康助手' : '客人');
    return <details className="health-history-item" key={item.id}>
      <summary><span className={`health-intake-status ${item.status}`}>{statusLabel}</span><strong>第 {item.revision || '旧记录'} 版 · {item.source === 'form' ? '表单' : item.source === 'assistant' ? '对话' : item.source}</strong><time>{item.reviewedAt || item.submittedAt ? new Date(item.reviewedAt || item.submittedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '—'}</time></summary>
      <div className="health-history-meta"><span>提交人：{item.submitterName || (item.source === 'assistant' ? '客人通过助手' : '客人')}</span><span>处理人：{item.reviewerName || '尚未处理'}</span><span>来源会话：{item.sessionId || '表单提交'}</span><span>来源人：{actor}</span></div>
      {item.content && item.source !== 'form' && <p className="health-intake-raw">原始内容：{item.content}</p>}
      {changes.length ? <div className="health-history-diff"><div className="health-history-diff-head"><span>字段</span><span>修改前</span><span>修改后</span></div>{changes.map(change => <div className="health-history-diff-row" key={change.label}><strong>{change.label}</strong><span>{change.before}</span><span>{change.after}</span></div>)}</div> : <p className="health-intake-raw">{item.status === 'rejected' ? '驳回时正式档案保持不变。' : '记录保留；当前候选没有可对照的结构化字段。'}</p>}
      {submittedCandidate.length > 0 && <div className="health-history-diff"><div className="health-history-diff-head"><span>字段</span><span>客人提交内容</span><span>填写状态</span></div>{submittedCandidate.map(field => <div className="health-history-diff-row" key={`submitted-${field.label}`}><strong>{field.label}</strong><span>{field.value}</span><span>{field.status}</span></div>)}</div>}
      {item.reviewNote && <p className="health-review-note">审核说明：{item.reviewNote}</p>}
    </details>;
  })}</div>;
}

function HealthSelfReport({ me, notify, refreshKey = 0, onVerified }) {
  const [state, setState] = useState(null);
  const [form, setForm] = useState(emptyHealthProfileUi);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request('/me/health-profile');
      setState(data);
      onVerified?.({ health_profile: data.verifiedProfile, health_profile_version: data.profileVersion });
      setForm(data.profile || emptyHealthProfileUi());
      setFieldErrors({});
      setFormError('');
    } catch (error) {
      setFormError(error.message || '健康自述暂时无法加载');
    } finally {
      setLoading(false);
    }
  }, [onVerified]);

  useEffect(() => { load(); }, [load, refreshKey]);

  function updateField(key, patch) {
    setForm(current => ({ ...current, [key]: { ...current[key], ...patch } }));
    setFieldErrors(current => ({ ...current, [key]: '' }));
  }

  function chooseStatus(key, status) {
    const field = HEALTH_PROFILE_FIELDS.find(item => item.key === key);
    const patch = { status };
    if (status !== 'reported') patch[field.kind === 'list' || field.kind === 'medications' ? 'items' : 'details'] = field.kind === 'list' || field.kind === 'medications' ? [] : '';
    updateField(key, patch);
  }

  function handleValidationError(error) {
    const fields = error?.data?.details?.fields;
    const entries = Array.isArray(fields) ? fields.map(key => [key, '字段不被允许']) : Object.entries(fields || {});
    const next = {};
    for (const [path, message] of entries) {
      const key = String(path).replace(/^profile\./, '').split('.')[0];
      if (HEALTH_PROFILE_FIELDS.some(field => field.key === key)) next[key] = message;
    }
    setFieldErrors(next);
    setFormError(entries.length && !Object.keys(next).length ? error.message : '请按提示补充或修正对应项目。');
  }

  function jumpTo(key) {
    const field = document.getElementById(`health-field-${key}`);
    field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    field?.querySelector('select, input, textarea')?.focus({ preventScroll: true });
  }

  async function save(event) {
    event.preventDefault();
    if (saving || !state) return;
    setSaving(true);
    setFieldErrors({});
    setFormError('');
    try {
      const data = await request('/me/health-intakes', {
        method: 'POST',
        body: JSON.stringify({ profile: form, baseProfileVersion: state.profileVersion })
      });
      setState(data);
      setForm(data.profile || form);
      notify(data.deduplicated ? '这份自述已保存，仍在等待医护核实' : '健康自述已保存，尚待负责医护核实');
    } catch (error) {
      handleValidationError(error);
      notify(error.message || '健康自述保存失败');
    } finally {
      setSaving(false);
    }
  }

  const completeness = healthProfileCompletenessUi(form);
  const choicesFor = key => {
    if (key === 'mobility') return [['unanswered', '暂不回答'], ['independent', '可独立行动'], ['assistance', '需要协助'], ['unknown', '不确定']];
    const common = [['unanswered', '暂不回答'], ['none', '无'], ['reported', '有，需要补充'], ['unknown', '不确定']];
    if (['sleep', 'skin'].includes(key)) return [['unanswered', '暂不回答'], ['reported', '有，需要补充'], ['unknown', '不确定']];
    return common;
  };

  return <section className="surface health-self-report" aria-busy={loading || saving}>
    <div className="health-self-report-head"><div><div className="eyebrow">HEALTH SELF-REPORT</div><h2>健康自述</h2><p>请按自己的理解填写；药品按包装或原记录抄写，并写明使用时段。</p></div><button type="button" className="outline-btn small-btn" onClick={load} disabled={loading}>刷新档案　↻</button></div>
    <section className="health-completeness" aria-label="档案完整度"><div className="health-completeness-copy"><strong>档案完整度</strong><span>{completeness.completed}/{completeness.total} 项已回答</span></div><div className="health-progress"><span style={{ width: `${completeness.percent}%` }}/></div>{completeness.missing.length > 0 && <div className="health-missing-list"><span>待补充：</span>{completeness.missing.map(field => <button type="button" key={field.key} onClick={() => jumpTo(field.key)}>{field.label}</button>)}</div>}</section>
    {loading ? <QueryState text="正在读取健康自述…"/> : <>
      {state?.pendingIntakes?.length > 0 && <div className="health-pending-banner" role="status"><strong>客人自述 · 待核实</strong><span>你提交的健康信息已保存，负责医护确认前会按明确的过敏与忌口限制处理。</span></div>}
      {formError && <div className="health-form-error" role="alert">{formError}</div>}
      <form className="health-profile-form" onSubmit={save} noValidate>
        {HEALTH_PROFILE_FIELDS.map(field => {
          const value = form[field.key] || emptyHealthProfileUi()[field.key];
          const options = choicesFor(field.key);
          const error = fieldErrors[field.key];
          return <div className={`health-self-report-field ${error ? 'has-error' : ''}`} id={`health-field-${field.key}`} data-field={field.key} key={field.key}>
            <div className="health-field-heading"><label htmlFor={`health-status-${field.key}`}>{field.label}</label>{error && <span role="alert">{error}</span>}</div>
            <select id={`health-status-${field.key}`} value={value.status} onChange={event => chooseStatus(field.key, event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? `health-error-${field.key}` : undefined}>
              {options.map(([status, label]) => <option key={status} value={status}>{label}</option>)}
            </select>
            {value.status === 'reported' && field.kind === 'list' && <label className="health-field-input-label" htmlFor={`health-value-${field.key}`}>{field.key === 'audienceTags' ? '标签' : '具体内容'}（每行一项）<textarea id={`health-value-${field.key}`} rows="2" value={(value.items || []).join('\n')} onChange={event => updateField(field.key, { items: event.target.value.split(/[\n,，、]/).map(item => item.trim()).filter(Boolean) })} aria-invalid={Boolean(error)} placeholder={field.key === 'allergies' ? '例如：虾' : '请填写具体情况'}/></label>}
            {value.status === 'reported' && field.kind === 'medications' && <div className="health-medication-editor"><p>保留药品原文，不推断剂量或调整方案。</p>{(value.items || []).map((item, index) => <div className="health-medication-row" key={`${field.key}-${index}`}><label>药品原文<input value={item.originalText || ''} onChange={event => updateField(field.key, { items: value.items.map((entry, itemIndex) => itemIndex === index ? { ...entry, originalText: event.target.value } : entry) })} placeholder="照包装或原记录填写" aria-invalid={Boolean(error)}/></label><label>使用时段<input value={item.timing || ''} onChange={event => updateField(field.key, { items: value.items.map((entry, itemIndex) => itemIndex === index ? { ...entry, timing: event.target.value } : entry) })} placeholder="例如：早餐后" aria-invalid={Boolean(error)}/></label><button type="button" className="link-btn" onClick={() => updateField(field.key, { items: value.items.filter((_entry, itemIndex) => itemIndex !== index) })}>删除</button></div>)}<button type="button" className="outline-btn small-btn" onClick={() => updateField(field.key, { items: [...(value.items || []), { originalText: '', timing: '' }] })}>＋ 添加用药说明</button></div>}
            {(value.status === 'reported' || (field.kind === 'mobility' && ['independent', 'assistance'].includes(value.status))) && ['mobility', 'text'].includes(field.kind) && <label className="health-field-input-label" htmlFor={`health-value-${field.key}`}>具体情况<textarea id={`health-value-${field.key}`} rows="2" value={value.details || ''} onChange={event => updateField(field.key, { details: event.target.value })} aria-invalid={Boolean(error)} placeholder="请用自己的话描述"/></label>}
            {error && <small className="health-field-error" id={`health-error-${field.key}`}>{error}</small>}
          </div>;
        })}
        <div className="health-profile-actions"><span>正式档案版本 {state?.profileVersion ?? 0} · 提交后待医护核实</span><button type="submit" className="primary-btn" disabled={saving}>{saving ? '保存中…' : '保存健康自述　→'}</button></div>
      </form>
      <section className="health-verified-panel"><div className="form-section-title"><span>正式健康档案</span><small>只有负责医护确认后才会更新</small></div><div className="health-verified-grid">{HEALTH_PROFILE_FIELDS.map(field => <div key={field.key}><span>{field.label}</span><strong>{displayHealthField(field.key, state?.verifiedProfile?.[field.key])}</strong></div>)}</div></section>
      <section className="health-history-panel"><div className="form-section-title"><span>档案变更记录</span><small>只读 · 共 {state?.history?.length || 0} 条</small></div><HealthIntakeHistory history={state?.history || []}/></section>
    </>}
  </section>;
}

function assessmentOptions(field) {
  if (field.key === 'mobility') return [['independent', '可独立行走'], ['assistance', '需要协助'], ['unknown', '不确定']];
  if (['sleep', 'skin'].includes(field.key)) return [['reported', '有，需要补充'], ['unknown', '不确定']];
  return [['reported', '有，需要补充'], ['none', '无'], ['unknown', '不确定']];
}

function Stage21HealthWorkspace({ onIntakeSaved }) {
  const [progress, setProgress] = useState(null);
  const [assessmentAnswer, setAssessmentAnswer] = useState({ status: 'unanswered', items: [], details: '' });
  const [assessmentLoading, setAssessmentLoading] = useState(true);
  const [assessmentSaving, setAssessmentSaving] = useState(false);
  const [assessmentError, setAssessmentError] = useState('');
  const [utterance, setUtterance] = useState('');
  const [extractions, setExtractions] = useState([]);
  const [decisions, setDecisions] = useState({});
  const [extractionLoading, setExtractionLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  const [confirmingId, setConfirmingId] = useState('');
  const [extractionError, setExtractionError] = useState('');
  const [extractionNotice, setExtractionNotice] = useState('');
  const currentField = progress?.nextQuestion ? HEALTH_PROFILE_FIELDS.find(item => item.key === progress.nextQuestion.key) : null;

  const loadProgress = useCallback(async () => {
    setAssessmentLoading(true); setAssessmentError('');
    try { setProgress(await request('/me/health-assessment')); }
    catch (error) { setAssessmentError(error.message || '健康初评暂时无法读取'); }
    finally { setAssessmentLoading(false); }
  }, []);
  const loadExtractions = useCallback(async () => {
    setExtractionLoading(true); setExtractionError('');
    try { setExtractions((await request('/me/health-intake-extractions')).items || []); }
    catch (error) { setExtractionError(error.message || '健康自述提取记录暂时无法读取'); }
    finally { setExtractionLoading(false); }
  }, []);
  useEffect(() => { loadProgress(); loadExtractions(); }, [loadProgress, loadExtractions]);
  useEffect(() => {
    const value = currentField ? progress?.profile?.[currentField.key] : null;
    setAssessmentAnswer(value || { status: 'unanswered', items: [], details: '' });
  }, [currentField?.key, progress?.version]);

  async function saveAssessment(event) {
    event.preventDefault();
    if (!currentField || assessmentSaving || !assessmentAnswer.status || assessmentAnswer.status === 'unanswered') return;
    setAssessmentSaving(true); setAssessmentError('');
    const answer = currentField.kind === 'list'
      ? { status: assessmentAnswer.status, items: assessmentAnswer.status === 'reported' ? (assessmentAnswer.items || []) : [] }
      : currentField.kind === 'medications'
        ? { status: assessmentAnswer.status, items: assessmentAnswer.status === 'reported' ? (assessmentAnswer.items || []) : [] }
        : { status: assessmentAnswer.status, details: ['reported', 'independent', 'assistance'].includes(assessmentAnswer.status) ? assessmentAnswer.details || '' : '' };
    try {
      setProgress(await request('/me/health-assessment/answers', { method: 'PUT',
        body: JSON.stringify({ field: currentField.key, answer, baseVersion: progress.version }) }));
    } catch (error) {
      setAssessmentError(error.message || '初评回答没有保存');
      if (error.status === 409) await loadProgress();
    } finally { setAssessmentSaving(false); }
  }

  async function submitUtterance(event) {
    event.preventDefault();
    if (!utterance.trim() || extracting) return;
    setExtracting(true); setExtractionError(''); setExtractionNotice('');
    const clarification = extractions.find(item => item.clarificationQuestion && !item.candidates?.length);
    try {
      const result = await request('/me/health-intake-extractions', { method: 'POST', body: JSON.stringify({
        utterance: utterance.trim(), ...(clarification?.sessionId ? { sessionId: clarification.sessionId } : {})
      }) });
      setExtractions(current => [result, ...current.filter(item => item.id !== result.id)]);
      setDecisions({}); setUtterance('');
      setExtractionNotice(result.clarificationQuestion
        ? '需要补充具体事实后再提交候选；系统不会猜测或作出诊断。'
        : `已保存提取候选，模式 ${result.executionMode}，来源会话 ${result.sessionId || '已记录'}。请逐项确认或拒绝。`);
    } catch (error) { setExtractionError(error.message || '健康自述提取失败，原文仍保留在输入框中'); }
    finally { setExtracting(false); }
  }

  async function decideExtraction(extraction) {
    const choices = extraction.candidates.map(candidate => ({ candidateId: candidate.candidateId,
      decision: decisions[candidate.candidateId] || candidate.decision || '' }));
    if (choices.some(item => !['confirm', 'reject'].includes(item.decision)) || confirmingId) return;
    setConfirmingId(extraction.id); setExtractionError(''); setExtractionNotice('');
    try {
      const result = await request(`/me/health-intake-extractions/${encodeURIComponent(extraction.id)}/confirm`, {
        method: 'POST', body: JSON.stringify({ decisions: choices }) });
      setExtractions(current => current.map(item => item.id === extraction.id ? result.extraction : item));
      setExtractionNotice(result.intake
        ? `确认已写入待核实记录 #${result.intake.id}。正式健康档案没有被覆盖。`
        : '已保存你的拒绝选择；正式健康档案没有被修改。');
      if (result.intake) onIntakeSaved?.();
    } catch (error) { setExtractionError(error.message || '候选确认失败'); }
    finally { setConfirmingId(''); }
  }

  const statusText = status => ({ pending_confirmation: '待本人确认', confirmed: '已确认，待核实', partially_confirmed: '部分确认，待核实', rejected: '本人已拒绝' })[status] || status;
  return <section className="stage21-health-workspace">
    <section className="surface stage21-assessment" aria-busy={assessmentLoading || assessmentSaving}>
      <header className="stage21-workspace-heading"><div><span className="eyebrow">RESUMABLE HEALTH ASSESSMENT</span><h2>健康初评 · 可随时继续</h2><p>已回答内容会保存；重新打开后从缺失项继续。初评不会把未回答视为正常，也不会直接改正式档案。</p></div><button type="button" className="outline-btn small-btn" onClick={loadProgress} disabled={assessmentLoading}>恢复进度</button></header>
      {assessmentLoading ? <QueryState text="正在读取初评进度…"/> : assessmentError && !progress ? <QueryState error text={assessmentError} onRetry={loadProgress}/> : <>
        {assessmentError && <div className="project-form-error" role="alert">{assessmentError}</div>}
        <div className="stage21-progress-line"><strong>{progress?.progress?.completed || 0}/{progress?.progress?.total || HEALTH_PROFILE_FIELDS.length} 项已回答</strong><span>{progress?.status === 'completed' ? '初评已完成' : progress?.status === 'not_started' ? '尚未开始' : `待补 ${progress?.missing?.length || 0} 项`}</span></div>
        <div className="stage21-progress-track"><span style={{ width: `${progress?.progress?.percent || 0}%` }}/></div>
        {progress?.missing?.length > 0 && <p className="stage21-missing-list">待补充：{progress.missing.map(item => item.label).join('、')}</p>}
        {currentField ? <form className="stage21-assessment-form" onSubmit={saveAssessment}>
          <label htmlFor="stage21-assessment-status">下一项：{currentField.label}</label>
          <select id="stage21-assessment-status" value={assessmentAnswer.status === 'unanswered' ? '' : assessmentAnswer.status} onChange={event => setAssessmentAnswer(current => ({ ...current, status: event.target.value }))}>
            <option value="">请选择</option>{assessmentOptions(currentField).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          {assessmentAnswer.status === 'reported' && currentField.kind === 'list' && <label htmlFor="stage21-assessment-list">具体内容（每行一项）<textarea id="stage21-assessment-list" rows="2" value={(assessmentAnswer.items || []).join('\n')} onChange={event => setAssessmentAnswer(current => ({ ...current, items: event.target.value.split(/[\n,，、]/).map(item => item.trim()).filter(Boolean) }))} placeholder="按本人原话填写"/></label>}
          {assessmentAnswer.status === 'reported' && currentField.kind === 'medications' && <div className="stage21-medication-inputs"><label>药品原文<input value={assessmentAnswer.items?.[0]?.originalText || ''} onChange={event => setAssessmentAnswer(current => ({ ...current, items: [{ originalText: event.target.value, timing: current.items?.[0]?.timing || '' }] }))}/></label><label>使用时段<input value={assessmentAnswer.items?.[0]?.timing || ''} onChange={event => setAssessmentAnswer(current => ({ ...current, items: [{ originalText: current.items?.[0]?.originalText || '', timing: event.target.value }] }))} placeholder="请按原记录填写"/></label></div>}
          {['mobility', 'text'].includes(currentField.kind) && ['reported', 'independent', 'assistance'].includes(assessmentAnswer.status) && <label htmlFor="stage21-assessment-details">具体情况<textarea id="stage21-assessment-details" rows="2" value={assessmentAnswer.details || ''} onChange={event => setAssessmentAnswer(current => ({ ...current, details: event.target.value }))} placeholder="请用自己的话描述；不确定可选择不确定"/></label>}
          <div className="stage21-assessment-actions"><small>初评版本 {progress?.version || 0} · 下一次打开会从缺项继续</small><button className="primary-btn" type="submit" disabled={assessmentSaving || !assessmentAnswer.status || assessmentAnswer.status === 'unanswered'}>{assessmentSaving ? '保存中…' : '保存并继续　→'}</button></div>
        </form> : <div className="stage21-complete" role="status"><strong>已回答全部初评项目</strong><span>没有未回答字段。</span></div>}
      </>}
    </section>

    <section className="surface stage21-extraction" aria-busy={extractionLoading || extracting || Boolean(confirmingId)}>
      <header className="stage21-workspace-heading"><div><span className="eyebrow">SOURCE-BOUND EXTRACTION</span><h2>口语自述提取与本人确认</h2><p>只整理你明确说出的内容；先查看原文证据，再逐项确认或拒绝。确认后进入待核实流程。</p></div><button type="button" className="outline-btn small-btn" onClick={loadExtractions} disabled={extractionLoading}>刷新记录</button></header>
      <form className="stage21-utterance-form" onSubmit={submitUtterance}><label htmlFor="stage21-utterance">本人自述<textarea id="stage21-utterance" rows="3" maxLength="1200" value={utterance} onChange={event => setUtterance(event.target.value)} placeholder="例如：最近睡不好、对虾过敏"/></label><small>{utterance.length}/1200 字 · 不用于诊断</small><button className="primary-btn" type="submit" disabled={extracting || !utterance.trim()}>{extracting ? '正在整理原文…' : '提取候选'}</button></form>
      {extractionNotice && <div className="stage21-success" role="status">{extractionNotice}</div>}{extractionError && <div className="project-form-error" role="alert">{extractionError}</div>}
      {extractionLoading ? <QueryState text="正在读取提取记录…"/> : extractions.length ? <div className="stage21-extraction-list">{extractions.map(extraction => <article className="stage21-extraction-card" key={extraction.id}>
        <header><div><strong>提取编号 {extraction.id}</strong><SourceDetails><span>状态：{statusText(extraction.status)} · {extraction.executionMode} · 会话 {extraction.sessionId || '—'}</span></SourceDetails></div><time>{extraction.createdAt ? new Date(extraction.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '—'}</time></header>
        <blockquote>{extraction.source?.utterance || '原文暂不可用'}</blockquote>
        {extraction.clarificationQuestion && <div className="stage21-clarification"><strong>需要补充事实</strong><p>{extraction.clarificationQuestion}</p><small>请在上方输入框回答；系统不会根据模糊说法推断诊断或行动能力。</small></div>}
        {extraction.candidates?.length > 0 && <div className="stage21-candidates">{extraction.candidates.map(candidate => <div className="stage21-candidate" key={candidate.candidateId}>
          <div><strong>{({chronic:'慢病自述',allergies:'过敏自述',dietaryRestrictions:'饮食忌口',sleep:'睡眠自述',skin:'皮肤自述',mobility:'行动能力'})[candidate.field] || candidate.field}：{candidate.value || (candidate.status === 'unknown' ? '不确定' : '无')}</strong><span>候选 {candidate.candidateId} · {candidate.reviewStatus || (candidate.status === 'pending_confirmation' ? '待本人确认' : '待本人选择')}</span><blockquote>原文证据：「{candidate.evidenceText}」</blockquote><SourceDetails><small>来源会话 {candidate.source?.sessionId || extraction.sessionId || '—'} · 来源类型 {candidate.source?.type || extraction.source?.type}</small></SourceDetails></div>
          {extraction.status === 'pending_confirmation' && <label>本人选择<select value={decisions[candidate.candidateId] || candidate.decision || ''} onChange={event => setDecisions(current => ({ ...current, [candidate.candidateId]: event.target.value }))}><option value="">请选择</option><option value="confirm">确认这项</option><option value="reject">拒绝这项</option></select></label>}
        </div>)}{extraction.status === 'pending_confirmation' && <button className="primary-btn" type="button" onClick={() => decideExtraction(extraction)} disabled={confirmingId === extraction.id || extraction.candidates.some(item => !['confirm','reject'].includes(decisions[item.candidateId] || item.decision || ''))}>{confirmingId === extraction.id ? '保存选择中…' : '保存逐项选择'}</button>}</div>}
        {!extraction.candidates?.length && !extraction.clarificationQuestion && <p className="stage21-empty-candidate">没有可确认的候选。请重新用自己的话描述。</p>}
        <details className="stage21-extraction-evidence"><summary>模型与成本记录</summary><p>模型：{extraction.model || '确定性澄清'} · 输入/输出 token：{extraction.inputTokens}/{extraction.outputTokens} · 估算费用：${Number(extraction.estimatedCostUsd || 0).toFixed(6)}</p></details>
      </article>)}</div> : <div className="project-state project-empty">还没有自述提取记录。你可以用自己的话描述，系统会保留原文和来源。</div>}
    </section>
  </section>;
}

export function GuestProfile({ me, notify, onSaved }) {
  const [healthRefreshKey, setHealthRefreshKey] = useState(0);
  const [formalSummary, setFormalSummary] = useState(me.profile || {});
  const updateFormalSummary = useCallback(value => setFormalSummary(current => ({ ...current, ...value })), []);
  const profile = me.profile || {};
  const initialForm = useMemo(() => ({ phone: asText(me.phone), emergencyContact: asText(profile.emergencyContact ?? profile.emergency_contact), mobility: asText(profile.mobility) }), [me.id, me.phone, profile.emergencyContact, profile.emergency_contact, profile.mobility]);
  const [form, setForm] = useState(initialForm);
  const [saving, setSaving] = useState(false);

  useEffect(() => setForm(initialForm), [initialForm]);

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    const body = {
      phone: asText(form.phone).trim(),
      emergencyContact: asText(form.emergencyContact).trim(),
      mobility: asText(form.mobility).trim()
    };
    const invalid = Object.entries(PROFILE_FIELD_LIMITS).find(([field, limit]) => body[field].length > limit);
    if (invalid) {
      notify(`${invalid[0] === 'phone' ? '联系电话' : invalid[0] === 'emergencyContact' ? '紧急联系人' : '行动能力'}不能超过 ${invalid[1]} 个字符`);
      return;
    }
    setSaving(true);
    try {
      const response = normalizeGuestSummary(await request('/me/profile', { method: 'PATCH', body: JSON.stringify(body) }));
      const updated = response?.profile ? response : normalizeGuestSummary({ ...me, phone: body.phone, profile: { ...profile, emergencyContact: body.emergencyContact, mobility: body.mobility } });
      onSaved(updated);
      notify('个人资料已保存');
    } catch (error) {
      notify(error.message || '保存失败，请稍后再试');
    } finally {
      setSaving(false);
    }
  }

  return <><PageTitle eyebrow="MY PROFILE" title="我的资料" desc="可编辑信息以白色输入框显示，机构登记信息和健康标签为只读。"/><form className="surface form-surface" onSubmit={save} aria-busy={saving}><div className="form-section-title"><span>可编辑信息</span><small>你可以随时更新联系方式</small></div><div className="form-grid"><Field label="联系电话" value={form.phone} maxLength={PROFILE_FIELD_LIMITS.phone} inputMode="tel" autoComplete="tel" onChange={(value) => setForm({ ...form, phone: value })}/><Field label="紧急联系人" value={form.emergencyContact} maxLength={PROFILE_FIELD_LIMITS.emergencyContact} onChange={(value) => setForm({ ...form, emergencyContact: value })}/><Field label="行动能力" value={form.mobility} maxLength={PROFILE_FIELD_LIMITS.mobility} onChange={(value) => setForm({ ...form, mobility: value })}/></div><div className="form-section-title with-top"><span>只读身份信息</span><small>由机构登记，不允许客人修改</small></div><div className="form-grid"><ReadonlyField label="姓名" value={me.name}/><ReadonlyField label="性别" value={profile.gender}/><ReadonlyField label="出生日期" value={profile.birthDate || profile.birth_date}/></div><div className="form-section-title with-top"><span>只读入住信息</span><small>如需更正，请联系工作人员</small></div><div className="admission-status-line"><span>当前状态</span><strong>{admissionLabel(me.admissionStatus)}</strong></div><div className="form-grid"><ReadonlyField label="房间号" value={profile.roomNo || profile.room_no}/><ReadonlyField label="入住日期" value={profile.checkIn || profile.check_in}/><ReadonlyField label="离店日期" value={profile.checkOut || profile.check_out}/><ReadonlyField label="入住类别" value={({three_night: "3晚类别", ten_night: "10晚类别"})[profile.stayPlan] || "待登记"}/></div><div className="form-section-title with-top"><span>健康标签</span><small>由授权工作人员维护</small></div><div className="form-grid"><ReadonlyField label="慢病史" value={formalHealthSummary(formalSummary, 'chronic')}/><ReadonlyField label="过敏源" value={formalHealthSummary(formalSummary, 'allergies')}/></div><div className="form-actions"><button type="submit" className="primary-btn" disabled={saving} aria-busy={saving}>{saving ? '保存中…' : '保存修改　→'}</button></div></form><HealthSelfReport me={me} notify={notify} refreshKey={healthRefreshKey} onVerified={updateFormalSummary}/><Stage21HealthWorkspace onIntakeSaved={() => setHealthRefreshKey(value => value + 1)}/><PasswordPanel notify={notify}/></>;
}
