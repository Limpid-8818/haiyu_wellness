import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { request } from '../../lib/request.js';
import { shanghaiDateOffset, slotDateLabel } from '../../lib/date.js';
import { useQuery } from '../../lib/useQuery.js';
import { PageTitle } from '../../shared/ui.jsx';
import { formatProjectWindows, parseProjectWindows } from '../guest/projects.jsx';

export function ProjectAdmin({ notify }) {
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ description: '', openWindowsText: '', active: true });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const { data: itemsData, loading, error, load, setData } = useQuery(async (signal) => {
    const result = await request('/admin/projects', { signal });
    setSelectedId(current => result.items?.some(item => item.id === current) ? current : result.items?.[0]?.id || '');
    return result.items || [];
  }, [], { fallbackMessage: '项目资料暂时无法加载' });
  const items = itemsData || [];
  const selected = useMemo(() => items.find(item => item.id === selectedId) || null, [items, selectedId]);
  useEffect(() => {
    if (selected) setForm({ description: selected.description, openWindowsText: formatProjectWindows(selected.openWindows), active: selected.active });
  }, [selected]);

  const visibleItems = items.filter(item => `${item.name} ${item.location}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
  async function save(event) {
    event.preventDefault();
    if (!selected || saving) return;
    setSaving(true);
    setFormError('');
    try {
      const updated = await request(`/admin/projects/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: form.description, openWindows: parseProjectWindows(form.openWindowsText), active: form.active })
      });
      setData(current => current.map(item => item.id === updated.id ? updated : item));
      notify('项目资料已保存');
    } catch (requestError) {
      setFormError(requestError.message || '保存失败，请检查填写内容');
    } finally { setSaving(false); }
  }

  return <>
    <PageTitle eyebrow="CATALOG MANAGEMENT" title="项目维护" desc="维护项目说明、开放窗口、预约时段容量和启用状态。" action={<button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新列表　↻</button>}/>
    <section className="project-admin-notice"><strong>演示资料维护</strong><span>当前地点与窗口是演示值。投入实际运营前应由机构核对项目和场地资料。</span></section>
    <div className="project-admin-layout">
      <section className="surface project-admin-list"><div className="project-admin-list-head"><h2>项目目录</h2><span>{items.length} 项</span></div>
        <label className="project-admin-filter" htmlFor="project-admin-filter">筛选项目<input id="project-admin-filter" value={filter} onChange={event => setFilter(event.target.value)} placeholder="项目名称或地点"/></label>
        {error ? <div className="project-state project-state-error" role="alert">{error}</div> : loading ? <div className="project-state">正在读取项目…</div> : <div className="project-admin-rows">{visibleItems.map(item => <button key={item.id} type="button" className={selectedId === item.id ? 'selected' : ''} onClick={() => setSelectedId(item.id)}><span><strong>{item.name}</strong><small>{item.categoryLabel} · {item.location}</small></span><em className={item.active ? 'is-active' : 'is-inactive'}>{item.active ? '启用' : '已停用'}</em></button>)}</div>}
      </section>
      <section className="surface project-admin-editor" aria-busy={saving}>
        {selected ? <form onSubmit={save} noValidate>
          <div className="project-admin-editor-head"><div><span>{selected.categoryLabel}</span><h2>{selected.name}</h2><small>{selected.id} · 时段容量演示值 {selected.capacityPerWindow}</small></div><span className={`project-admin-status ${form.active ? 'is-active' : 'is-inactive'}`}>{form.active ? '当前启用' : '已停用'}</span></div>
          <label htmlFor="project-admin-description">项目说明<textarea id="project-admin-description" rows="5" maxLength="1500" value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))}/></label>
          <label htmlFor="project-admin-windows">示例开放窗口<textarea id="project-admin-windows" rows="4" value={form.openWindowsText} onChange={event => setForm(current => ({ ...current, openWindowsText: event.target.value }))}/></label>
          <small className="project-admin-help">每行填写一个窗口，例如“每日 09:00-11:00”或“周一、周三 14:00-16:00”。时间按中国标准时间示例展示。</small>
          <label className="project-admin-toggle" htmlFor="project-admin-active"><input id="project-admin-active" type="checkbox" checked={form.active} onChange={event => setForm(current => ({ ...current, active: event.target.checked }))}/><span>在客人项目目录中启用</span></label>
          <p className="project-admin-deactivate-note">停用后不会出现在客人目录。项目记录保留供历史引用。</p>
          {formError && <div className="project-form-error" role="alert">{formError}</div>}
          <div className="project-admin-actions"><button type="button" className="outline-btn" onClick={() => setForm({ description: selected.description, openWindowsText: formatProjectWindows(selected.openWindows), active: selected.active })} disabled={saving}>恢复已保存内容</button><button type="submit" className="primary-btn" disabled={saving} aria-busy={saving}>{saving ? '保存中…' : '保存项目资料'}</button></div>
        </form> : <div className="project-state">{loading ? '正在加载项目…' : '请选择一个项目'}</div>}
      </section>
    </div>
    {selected && <ProjectSlotAdmin project={selected} notify={notify}/>}
  </>;
}

function ProjectSlotAdmin({ project, notify }) {
  const dates = useMemo(() => Array.from({ length: 7 }, (_, index) => shanghaiDateOffset(index)), []);
  const [date, setDate] = useState(() => shanghaiDateOffset());
  const [savingId, setSavingId] = useState('');
  const [capacityDraft, setCapacityDraft] = useState({});
  const { data: slotsData, loading, error, setError, load } = useQuery(async (signal) => {
    const result = await request(`/admin/projects/${encodeURIComponent(project.id)}/slots?date=${encodeURIComponent(date)}`, { signal });
    setCapacityDraft(Object.fromEntries((result.slots || []).map(slot => [slot.id, String(slot.capacity)])));
    return result.slots || [];
  }, [project.id, date], { fallbackMessage: '时段排期暂时无法加载' });
  const slots = slotsData || [];
  async function update(slot, changes) {
    setSavingId(slot.id);
    setError('');
    try {
      await request(`/admin/projects/${encodeURIComponent(project.id)}/slots/${encodeURIComponent(slot.id)}`, {
        method: 'PATCH', body: JSON.stringify(changes)
      });
      notify('预约时段已更新');
      await load();
    } catch (requestError) { setError(requestError.message || '时段更新失败'); }
    finally { setSavingId(''); }
  }
  return <section className="surface project-slot-admin" aria-busy={loading || Boolean(savingId)}>
    <div className="project-slot-admin-head"><div><div className="eyebrow">SLOT MANAGEMENT</div><h2>预约时段维护 · {project.name}</h2><p>有效预约数来自服务端；容量不能降到有效预约数以下。关闭时段会保留已有预约。</p></div><label htmlFor="admin-slot-date">查看日期<select id="admin-slot-date" value={date} onChange={event => setDate(event.target.value)}>{dates.map((value, index) => <option key={value} value={value}>{index === 0 ? '今天 · ' : ''}{slotDateLabel(value)}</option>)}</select></label></div>
    {project.isDemo && <div className="booking-demo-note"><strong>演示排期</strong><span>容量和地点是演示资料。</span></div>}
    {error && <div className="project-form-error" role="alert">{error}</div>}
    {loading ? <div className="project-state">正在读取时段…</div> : slots.length ? <div className="project-slot-admin-list">{slots.map(slot => <article className="project-slot-admin-row" key={slot.id}>
      <div className="project-slot-admin-time"><strong>{slot.localStart}–{slot.localEnd}</strong><span>{slot.location}</span><small>已约 {slot.booked} · 剩余 {slot.remaining} · {slot.status === 'closed' ? '已关闭' : slot.status === 'window_changed' ? '不在当前开放窗口' : slot.status === 'full' ? '已约满' : '开放'}</small></div>
      <label>容量<input aria-label={`${slot.localStart} 时段容量`} type="number" min="1" max="100" value={capacityDraft[slot.id] ?? slot.capacity} onChange={event => setCapacityDraft(current => ({ ...current, [slot.id]: event.target.value }))}/></label>
      <div className="project-slot-admin-actions"><button type="button" className="outline-btn small-btn" onClick={() => update(slot, { capacity: Number(capacityDraft[slot.id]) })} disabled={savingId === slot.id || Number(capacityDraft[slot.id]) === slot.capacity}>保存容量</button><button type="button" className={slot.isClosed ? 'primary-btn small-btn' : 'outline-btn small-btn danger-outline'} onClick={() => update(slot, { closed: !slot.isClosed })} disabled={savingId === slot.id}>{slot.isClosed ? '重新开放' : '关闭时段'}</button></div>
    </article>)}</div> : <div className="project-state">所选日期没有已生成时段。停用项目不会生成新时段。</div>}
  </section>;
}

export function RulesWorkbench() {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const { data: rulesData, loading, error } = useQuery(async (signal) => {
    const params = search ? `?q=${encodeURIComponent(search)}` : '';
    const result = await request(`/rules${params}`, { signal });
    return result.items || [];
  }, [search], { fallbackMessage: '规则暂时无法加载' });
  const items = rulesData || [];
  const actionLabel = { allow: '允许', restrict: '限制并审核', reject: '拒绝并审核' };
  return <>
    <PageTitle eyebrow="CLINICIAN WORKSPACE" title="禁忌规则" desc="检索系统执行的只读规则。演示规则不构成临床或海况标准。"/>
    <section className="surface rules-workbench">
      <form className="rules-search" onSubmit={event => { event.preventDefault(); setSearch(draft.trim()); }}>
        <label htmlFor="rules-search">搜索规则</label><div><input id="rules-search" value={draft} onChange={event => setDraft(event.target.value)} placeholder="规则编号、条件或关键词"/><button className="primary-btn" type="submit">搜索</button></div>
      </form>
      <div className="rules-list-summary" aria-live="polite">{loading ? '正在读取规则…' : `找到 ${items.length} 条规则`}</div>
      {error ? <div className="project-state project-state-error" role="alert">{error}</div> : loading ? <div className="project-state">正在加载规则…</div> : items.length ? <div className="rules-list">{items.map(rule => <details className="rule-record" key={rule.ruleId} open>
        <summary><span className="rule-id">{rule.ruleId}</span><strong>{rule.title}</strong><span className="rule-version">规则版本 {rule.version}</span></summary>
        <div className="rule-record-body"><dl><div><dt>适用项目</dt><dd>{rule.scope}</dd></div><div><dt>触发条件</dt><dd>{rule.triggerCondition}</dd></div><div><dt>处置动作</dt><dd><span className={`rule-action ${rule.action}`}>{actionLabel[rule.action] || rule.action}</span></dd></div><div><dt>来源</dt><dd>{rule.sourceReference}{rule.sourceUrl && <> · <a href={rule.sourceUrl} target="_blank" rel="noreferrer">查看来源</a></>}</dd></div><div><dt>演示说明</dt><dd>{rule.demoNote}</dd></div></dl>
          <small>规则记录更新于 {rule.updatedAt ? new Date(rule.updatedAt).toLocaleDateString('zh-CN') : '—'}</small>
        </div>
      </details>)}</div> : <div className="project-state project-empty" role="status"><strong>没有匹配的规则</strong><p>调整关键词后再搜索。</p></div>}
    </section>
  </>;
}
