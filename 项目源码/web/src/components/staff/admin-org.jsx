import React, { useCallback, useState } from 'react';
import { useConfirmation } from '../../shared/Confirmation.jsx';
import { request } from '../../lib/request.js';
import { localDateValue, fmtDateTime } from '../../lib/date.js';
import { initials } from '../../lib/normalize.js';
import { useQuery } from '../../lib/useQuery.js';
import { PageTitle, SectionHead, Empty, QueryState } from '../../shared/ui.jsx';
import { admissionLabel, STAFF_JOB_LABELS } from '../../app/navigation.js';

export function StaffManagement({ me, notify }) {
  const { confirm, confirmation } = useConfirmation();
  const [saving, setSaving] = useState(false);
  const [updatingJobId, setUpdatingJobId] = useState('');
  const [form, setForm] = useState({ name: '', username: '', phone: '', password: '', jobType: 'clinician' });
  const { data: staffData, loading, error, load } = useQuery(async (signal) => {
    const data = await request('/dean/staff', { signal });
    return Array.isArray(data) ? data : [];
  }, [], { fallbackMessage: '员工列表暂时无法加载' });
  const staff = staffData || [];

  async function createStaff(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await request('/dean/staff', { method: 'POST', body: JSON.stringify(form) });
      setForm({ name: '', username: '', phone: '', password: '', jobType: 'clinician' });
      notify('员工账号已创建');
      await load();
    } catch (requestError) {
      notify(requestError.message || '创建员工账号失败');
    } finally { setSaving(false); }
  }

  async function setStaffStatus(member) {
    const nextStatus = member.status === 'active' ? 'disabled' : 'active';
    const update = async signal => {
      try {
        await request(`/dean/staff/${member.id}`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }), signal });
        if (signal?.aborted) return;
        notify(nextStatus === 'disabled' ? '员工账号已停用' : '员工账号已重新启用');
        await load();
      } catch (requestError) {
        if (signal?.aborted) return;
        const message = requestError.message || '更新员工状态失败';
        notify(message);
        if (signal) throw new Error(message);
      }
    };
    if (nextStatus === 'disabled') confirm({ title: '停用员工账号', description: `确认停用 ${member.name}（${member.username}）？其历史工作记录会保留。`, confirmLabel: '确认停用', action: update });
    else await update();
  }

  async function setStaffJobType(member, jobType) {
    if (jobType === member.jobType) return;
    if (member.id === me.id && jobType !== 'administrator') {
      notify('不能移除自己的管理员岗位');
      return;
    }
    setUpdatingJobId(member.id);
    try {
      await request(`/dean/staff/${member.id}`, { method: 'PATCH', body: JSON.stringify({ jobType }) });
      notify('员工岗位已更新');
      await load();
    } catch (requestError) { notify(requestError.message || '更新员工岗位失败'); }
    finally { setUpdatingJobId(''); }
  }

  return <>{confirmation}<PageTitle eyebrow="STAFF ACCOUNTS" title="员工账号管理" desc="创建工作人员账号、指定岗位或停用账号。停用只影响后续登录和访问，历史记录继续保留。" action={<button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新列表　↻</button>}/><section className="surface org-form-card"><SectionHead title="新增员工"/><form className="org-form-grid" onSubmit={createStaff}><label>姓名<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} maxLength={64} required/></label><label>登录账号<input value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} autoComplete="username" required/></label><label>联系电话<input type="tel" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} maxLength={32}/></label><label>初始密码<input type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} autoComplete="new-password" minLength={8} required/></label><label>岗位<select value={form.jobType} onChange={event => setForm({ ...form, jobType: event.target.value })}>{Object.entries(STAFF_JOB_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="org-form-submit"><button type="submit" className="primary-btn" disabled={saving} aria-busy={saving}>{saving ? '创建中…' : '创建员工账号　→'}</button></div></form></section><section className="surface table-surface"><SectionHead title="工作人员"/><div className="org-table-wrap" role="region" aria-label="工作人员列表" tabIndex="0"><table className="org-table"><thead><tr><th>姓名与账号</th><th>岗位</th><th>身份</th><th>状态</th><th>操作</th></tr></thead><tbody>{loading ? <tr><td colSpan="5">正在加载员工…</td></tr> : error ? <tr><td colSpan="5" role="alert">{error}</td></tr> : staff.map(member => <tr key={member.id}><td><strong>{member.name}</strong><small>{member.username} · {member.phone || '未留电话'}</small></td><td><select className="org-job-select" aria-label={`${member.name}岗位`} value={member.jobType} disabled={updatingJobId === member.id || member.id === me.id} onChange={event => setStaffJobType(member, event.target.value)}>{Object.entries(STAFF_JOB_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{member.id === me.id && <small>当前管理员岗位已锁定</small>}</td><td><span className="org-role-pill">{member.role}</span></td><td><span className={`org-state ${member.status}`}>{member.status === 'active' ? '正常' : '已停用'}</span></td><td><button type="button" className={member.status === 'active' ? 'danger-btn' : 'outline-btn'} disabled={member.id === me.id && member.status === 'active'} onClick={() => setStaffStatus(member)}>{member.status === 'active' ? '停用' : '重新启用'}</button></td></tr>)}</tbody></table>{!loading && !error && !staff.length && <Empty text="还没有工作人员账号"/>}</div></section></>;
}

export function CapabilitiesMatrix({ notify }) {
  const [saving, setSaving] = useState('');
  const { data, loading, error, load, setData } = useQuery(async (signal) => request('/dean/job-capabilities', { signal }),
    [], { fallbackMessage: '岗位权限暂时无法加载' });

  async function toggle(jobType, capability, enabled) {
    const key = `${jobType}:${capability}`;
    setSaving(key);
    setData(current => current ? {
      ...current,
      matrix: current.matrix.map(row => row.jobType === jobType ? {
        ...row,
        capabilities: { ...row.capabilities, [capability]: enabled }
      } : row)
    } : current);
    try {
      setData(await request('/dean/job-capabilities', { method: 'PATCH', body: JSON.stringify({ jobType, capability, enabled }) }));
      notify('岗位权限已更新');
    } catch (requestError) {
      notify(requestError.message || '更新岗位权限失败');
      await load();
    }
    finally { setSaving(''); }
  }

  const summaryKey = 'operations.summary.view';
  const medicalKey = 'medical_advice.publish';
  return <><PageTitle eyebrow="JOB CAPABILITIES" title="岗位权限矩阵" desc="医护建议权限由岗位固定配置；管理员只能调整预先开放的运营汇总查看开关。" action={<button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新　↻</button>}/><section className="surface table-surface"><SectionHead title="岗位能力"/><div className="org-table-wrap"><table className="org-table capability-table"><thead><tr><th>岗位</th><th>医护建议发布</th><th>查看运营汇总</th></tr></thead><tbody>{loading ? <tr><td colSpan="3">正在加载权限矩阵…</td></tr> : error ? <tr><td colSpan="3" role="alert">{error}</td></tr> : data?.matrix?.map(row => <tr key={row.jobType}><th scope="row">{row.jobTypeLabel}</th><td><span className={`capability-fixed ${row.capabilities[medicalKey] ? 'allowed' : 'denied'}`}>{row.capabilities[medicalKey] ? '仅此岗位' : '不可用'}</span></td><td><label className="capability-toggle"><input type="checkbox" checked={Boolean(row.capabilities[summaryKey])} disabled={saving === `${row.jobType}:${summaryKey}`} aria-label={`${row.jobTypeLabel} 查看运营汇总`} onChange={event => toggle(row.jobType, summaryKey, event.target.checked)}/><span>{row.capabilities[summaryKey] ? '已开启' : '已关闭'}</span></label></td></tr>)}</tbody></table></div><div className="capability-note"><strong>医护建议发布</strong><span>医护岗位固定开放；服务岗位、管理员和院长均不能通过此矩阵获得。</span></div></section></>;
}

export function StayManagement({ notify }) {
  const { confirm, confirmation } = useConfirmation();
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ roomNo: '', checkIn: localDateValue(), checkOut: localDateValue(3), stayPlan: 'three_night' });

  const { data: guestsData, loading, error, load } = useQuery(async (signal, status = filter, q = search) => {
    const rows = await request(`/dean/guests?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`, { signal });
    const list = Array.isArray(rows) ? rows : [];
    setSelectedId(current => current && !list.some(row => row.id === current) ? '' : current);
    return list;
  }, [filter, search, selectedId], { fallbackMessage: '客人入住列表暂时无法加载' });
  const guests = guestsData || [];

  const selected = guests.find(row => row.id === selectedId);
  function chooseGuest(row) {
    setSelectedId(row.id);
    setForm({
      roomNo: row.roomNo || '',
      checkIn: row.checkIn || localDateValue(),
      checkOut: row.checkOut || localDateValue(3),
      stayPlan: row.stayPlan || 'three_night'
    });
  }

  async function saveStay(event) {
    event.preventDefault();
    if (!selectedId || saving) return;
    setSaving(true);
    try {
      await request(`/dean/guests/${selectedId}/stay`, { method: 'PATCH', body: JSON.stringify(form) });
      notify('入住信息已保存');
      await load();
    } catch (requestError) { notify(requestError.message || '保存入住信息失败'); }
    finally { setSaving(false); }
  }

  function checkout(row) {
    confirm({ title: '办理离店', description: `确认办理 ${row.name} 离店？`, confirmLabel: '确认离店', action: async signal => {
      try {
        await request(`/dean/guests/${row.id}/stay`, { method: 'PATCH', body: JSON.stringify({ roomNo: row.roomNo, checkIn: row.checkIn, checkOut: localDateValue(), stayPlan: row.stayPlan || 'three_night' }), signal });
        if (signal.aborted) return;
        notify(`${row.name} 已办理离店`);
        await load();
      } catch (requestError) {
        if (signal.aborted) return;
        const message = requestError.message || '办理离店失败';
        notify(message); throw new Error(message);
      }
    } });
  }

  return <>{confirmation}<PageTitle eyebrow="GUEST ADMISSIONS" title="入住登记与筛选" desc="登记房间、入住日期和类别，按待入住、在住或已离店状态查找客人。" action={<button type="button" className="outline-btn" onClick={() => load()} disabled={loading}>刷新　↻</button>}/><section className="surface org-form-card"><SectionHead title="入住登记"/><form className="org-form-grid" onSubmit={saveStay}><label>选择客人<select value={selectedId} onChange={event => { const row = guests.find(item => item.id === event.target.value); if (row) chooseGuest(row); else setSelectedId(''); }} required><option value="">请选择客人</option>{guests.map(row => <option key={row.id} value={row.id}>{row.name} · {row.phone || '无电话'}</option>)}</select></label><label>房间号<input value={form.roomNo} onChange={event => setForm({ ...form, roomNo: event.target.value })} maxLength={32} required/></label><label>入住日期<input type="date" value={form.checkIn} onChange={event => setForm({ ...form, checkIn: event.target.value })} required/></label><label>离店日期<input type="date" value={form.checkOut} onChange={event => setForm({ ...form, checkOut: event.target.value })} required/></label><label>入住类别<select value={form.stayPlan} onChange={event => setForm({ ...form, stayPlan: event.target.value })}><option value="three_night">3晚类别（最多登记3晚）</option><option value="ten_night">10晚类别（最多登记10晚）</option></select></label><div className="org-form-submit"><button type="submit" className="primary-btn" disabled={saving || !selectedId} aria-busy={saving}>{saving ? '保存中…' : '保存入住登记　→'}</button></div></form></section><section className="surface table-surface"><div className="admission-list-tools"><SectionHead title="客人入住状态"/><div className="admission-filters"><label>状态<select value={filter} onChange={event => { setFilter(event.target.value); }}><option value="all">全部状态</option><option value="pending">待入住</option><option value="in_house">在住</option><option value="checked_out">已离店</option></select></label><form onSubmit={event => { event.preventDefault(); load(filter, search); }}><label htmlFor="admission-search">姓名、电话或房间</label><input id="admission-search" value={search} onChange={event => setSearch(event.target.value)}/><button type="submit" className="outline-btn">搜索</button></form></div></div>{loading ? <QueryState text="正在加载客人…"/> : error ? <QueryState error text={error} retryText="请稍后重试"/> : <div className="org-table-wrap" role="region" aria-label="客人入住列表" tabIndex="0"><table className="org-table"><thead><tr><th>客人</th><th>房间</th><th>入住区间</th><th>状态</th><th>操作</th></tr></thead><tbody>{guests.map(row => <tr key={row.id} className={selectedId === row.id ? 'selected-row' : ''}><td><button type="button" className="org-row-link" onClick={() => chooseGuest(row)}>{row.name}</button><small>{row.phone || row.username}</small></td><td>{row.roomNo || '未登记'}</td><td>{row.checkIn || '—'} 至 {row.checkOut || '—'}</td><td><span className={`org-state ${row.stayStatus}`}>{admissionLabel(row.stayStatus)}</span></td><td>{row.stayStatus === 'in_house' && <button type="button" className="danger-btn" onClick={() => checkout(row)}>办理离店</button>}</td></tr>)}</tbody></table>{!guests.length && <Empty text="当前筛选下没有客人"/>}</div>}</section>{selected && <section className="surface stay-selected-summary"><strong>当前选择：{selected.name}</strong><span>档案状态：{admissionLabel(selected.stayStatus)} · 保存后客人个人资料同步显示。</span></section>}</>;
}

export function AssignmentManagement({ notify }) {
  const [guestId, setGuestId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: baseData, loading, error: baseError, load: loadBase } = useQuery(async (signal) => {
    const [guestRows, staffRows] = await Promise.all([request('/dean/guests', { signal }), request('/dean/staff', { signal })]);
    setGuestId(current => current && guestRows.some(row => row.id === current) ? current : guestRows[0]?.id || '');
    return {
      guests: Array.isArray(guestRows) ? guestRows : [],
      staff: Array.isArray(staffRows) ? staffRows : []
    };
  }, [], { fallbackMessage: '分工管理信息暂时无法加载' });
  const guests = baseData?.guests || [];
  const staff = baseData?.staff || [];

  const { data: assignmentsData, error: assignmentsError, load: loadAssignments } = useQuery(async (signal) => {
    if (!guestId) return [];
    const rows = await request(`/dean/guests/${guestId}/assignments`, { signal });
    return Array.isArray(rows) ? rows : [];
  }, [guestId], { fallbackMessage: '负责关系暂时无法加载' });
  const assignments = assignmentsData || [];
  const error = baseError || assignmentsError;

  async function assign(event) {
    event.preventDefault();
    if (!staffId || !guestId || saving) return;
    setSaving(true);
    try {
      await request(`/dean/guests/${guestId}/assignments`, { method: 'POST', body: JSON.stringify({ staffId }) });
      setStaffId('');
      notify('负责关系已建立');
      await loadAssignments();
    } catch (requestError) { notify(requestError.message || '建立负责关系失败'); }
    finally { setSaving(false); }
  }

  async function closeAssignment(assignment) {
    try {
      await request(`/dean/guests/${guestId}/assignments/${assignment.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'closed' }) });
      notify('负责关系已结束，历史记录已保留');
      await loadAssignments();
    } catch (requestError) { notify(requestError.message || '结束负责关系失败'); }
  }

  const activeStaffIds = new Set(assignments.filter(row => row.status === 'active').map(row => row.staffId));
  const activeStaff = staff.filter(row => row.status === 'active');
  return <><PageTitle eyebrow="STAFF ASSIGNMENTS" title="客人负责关系" desc="为客人分配工作人员、结束当前关系并查看完整历史区间。" action={<button type="button" className="outline-btn" onClick={loadBase} disabled={loading}>刷新　↻</button>}/><section className="surface org-form-card"><SectionHead title="选择客人并新增负责关系"/><form className="org-form-grid" onSubmit={assign}><label>客人<select value={guestId} onChange={event => setGuestId(event.target.value)} required><option value="">请选择客人</option>{guests.map(row => <option key={row.id} value={row.id}>{row.name} · {row.roomNo || '未分配房间'}</option>)}</select></label><label>工作人员<select value={staffId} onChange={event => setStaffId(event.target.value)} required><option value="">选择医护或服务人员</option>{activeStaff.map(row => <option key={row.id} value={row.id} disabled={activeStaffIds.has(row.id)}>{row.name} · {row.jobTypeLabel || STAFF_JOB_LABELS[row.jobType]}{activeStaffIds.has(row.id) ? '（已负责）' : ''}</option>)}</select></label><div className="org-form-submit"><button type="submit" className="primary-btn" disabled={saving || !guestId || !staffId || activeStaffIds.has(staffId)} aria-busy={saving}>{saving ? '保存中…' : '建立负责关系　→'}</button></div></form></section><section className="surface table-surface"><SectionHead title="负责关系历史"/>{loading ? <QueryState text="正在加载客人与工作人员…"/> : error ? <QueryState error text={error} retryText="请刷新后重试"/> : <div className="assignment-history">{assignments.map(row => <article className="assignment-row" key={row.id}><div className="avatar orange-avatar">{initials(row.staffName)}</div><div className="assignment-person"><strong>{row.staffName}</strong><small>{row.staffUsername} · {row.jobTypeLabel || STAFF_JOB_LABELS[row.jobType] || '医护'}</small></div><div className="assignment-interval"><span>{row.startAt ? fmtDateTime(row.startAt) : '—'} → {row.endAt ? fmtDateTime(row.endAt) : row.status === 'active' ? '持续中' : '—'}</span><small>{row.status === 'active' ? '当前负责' : '已结束'}</small></div>{row.status === 'active' && <button type="button" className="danger-btn" onClick={() => closeAssignment(row)}>结束关系</button>}</article>)}{!assignments.length && <Empty text="该客人还没有负责关系"/>}</div>}</section></>;
}
