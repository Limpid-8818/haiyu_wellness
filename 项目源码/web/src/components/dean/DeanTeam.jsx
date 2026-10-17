import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../../lib/request.js';
import { fmtDate } from '../../lib/date.js';
import { initials } from '../../lib/normalize.js';
import { PageTitle, QueryState, SectionHead, Empty } from '../../shared/ui.jsx';

export function DeanTeam({ notify }) {
  const [staff, setStaff] = useState([]);
  const [selected, setSelected] = useState(null);
  const [reviewDrafts, setReviewDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selectingId, setSelectingId] = useState('');
  const [saving, setSaving] = useState(false);
  const selectionSequence = useRef(0);
  const selectedStaffId = useRef('');
  const reviewDraftsRef = useRef({});
  const reviewDraftVersions = useRef({});

  function updateReviewDraft(staffId, content) {
    const nextDrafts = { ...reviewDraftsRef.current, [staffId]: content };
    reviewDraftsRef.current = nextDrafts;
    reviewDraftVersions.current[staffId] = (reviewDraftVersions.current[staffId] || 0) + 1;
    setReviewDrafts(nextDrafts);
  }

  const load = useCallback(async () => {
    setLoading(true);
    setListError('');
    try {
      const data = await request('/dean/staff');
      const rows = Array.isArray(data) ? data : [];
      setStaff(rows);
      if (selectedStaffId.current && !rows.some((row) => row.id === selectedStaffId.current)) {
        selectedStaffId.current = '';
        setSelected(null);
      }
    } catch (error) {
      setStaff([]);
      setListError(error.message || '工作人员列表暂时无法加载');
      notify(error.message || '工作人员列表暂时无法加载');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    load();
    return () => { selectionSequence.current += 1; };
  }, [load]);

  async function choose(staffMember) {
    const sequence = ++selectionSequence.current;
    selectedStaffId.current = staffMember.id;
    setSelectingId(staffMember.id);
    setSelected(null);
    try {
      const data = await request(`/dean/staff/${staffMember.id}/logs`);
      if (sequence === selectionSequence.current) setSelected(data);
    } catch (error) {
      if (sequence === selectionSequence.current) {
        selectedStaffId.current = '';
        notify(error.message || '工作人员记录暂时无法加载');
      }
    } finally {
      if (sequence === selectionSequence.current) setSelectingId('');
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || !selected?.staff?.id) return;
    const staffId = selected.staff.id;
    const content = reviewDrafts[staffId] ?? '';
    if (!content.trim()) return;
    const submittedDraftVersion = reviewDraftVersions.current[staffId] || 0;
    setSaving(true);
    try {
      await request(`/dean/staff/${staffId}/reviews`, { method: 'POST', body: JSON.stringify({ content }) });
      if ((reviewDraftVersions.current[staffId] || 0) === submittedDraftVersion) updateReviewDraft(staffId, '');
      notify('院长意见已记录');
      if (selectedStaffId.current === staffId) await choose({ id: staffId });
    } catch (error) {
      notify(error.message || '记录院长意见失败，请稍后再试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageTitle
        eyebrow="DEAN CONSOLE"
        title="工作人员管理"
        desc="查看团队工作记录，了解服务执行情况，并留下院长意见。"
        action={<button type="button" className="outline-btn" onClick={load} disabled={loading} aria-busy={loading}>刷新　↻</button>}
      />
      <div className="guest-layout dean-layout">
        <section className="surface guest-list">
          <div className="list-heading"><strong>工作人员</strong><span>{staff.length} 人</span></div>
          {loading ? <QueryState text="正在加载工作人员列表…"/> : listError ? <QueryState error text={listError} retryText="请稍后重试"/> : staff.length ? staff.map((staffMember) => (
            <button
              type="button"
              className={`guest-row ${selectedStaffId.current === staffMember.id ? 'selected' : ''}`}
              key={staffMember.id}
              onClick={() => choose(staffMember)}
              disabled={Boolean(selectingId && selectingId !== staffMember.id)}
            >
              <span className="avatar orange-avatar">{initials(staffMember.name)}</span>
              <span className="guest-main"><strong>{staffMember.name}</strong><small>{staffMember.username} · {staffMember.phone}</small></span>
              <span className="guest-flag">查看 {staffMember.guestViews} 次</span>
              <span className="guest-flag">建议 {staffMember.adviceCount} 条</span>
              <b aria-hidden="true">→</b>
            </button>
          )) : <div className="list-empty"><Empty text="暂无工作人员记录"/></div>}
        </section>
        <section className="guest-detail">
          {selectingId ? (
            <div className="surface detail-empty"><div className="empty-illustration">⌁</div><h2>正在打开工作记录</h2><p>正在读取该工作人员的服务记录。</p></div>
          ) : selected ? (
            <div className="detail-stack">
              <section className="surface profile-hero">
                <div className="avatar large orange-avatar">{initials(selected.staff.name)}</div>
                <div><div className="eyebrow">STAFF PROFILE</div><h2>{selected.staff.name}</h2><p>工作人员　·　账号 {selected.staff.username}</p></div>
                <span className="profile-status">账号正常</span>
              </section>
              <section className="surface">
                <SectionHead title="近期工作记录"/>
                <div className="staff-log-list">
                  {selected.logs.length ? selected.logs.map((log) => (
                    <div key={log.id}><span className="log-dot"/><div><strong>{log.action === 'service.execution.record' ? '记录服务执行' : log.action}</strong><p>{log.detail || '完成一项工作操作'}</p><small>{log.createdAt ? new Date(log.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '—'}</small></div></div>
                  )) : <Empty text="暂无工作记录"/>}
                </div>
              </section>
              <section className="surface">
                <SectionHead title="院长意见"/>
                <div className="review-history">
                  {selected.reviews?.length ? selected.reviews.map((item) => (
                    <div key={item.id}><p>{item.content}</p><small>{fmtDate(item.createdAt)}</small></div>
                  )) : <Empty text="暂无历史意见"/>}
                </div>
                <form className="review-form" onSubmit={submit} aria-busy={saving}>
                  <label className="sr-only" htmlFor={`review-${selected.staff.id}`}>院长意见</label>
                  <textarea
                    id={`review-${selected.staff.id}`}
                    rows="3"
                    placeholder="请输入对工作人员的指导意见"
                    value={reviewDrafts[selected.staff.id] ?? ''}
                    onChange={(event) => updateReviewDraft(selected.staff.id, event.target.value)}
                    required
                  />
                  <button type="submit" className="primary-btn small-btn" disabled={saving} aria-busy={saving}>{saving ? '记录中…' : '记录意见　→'}</button>
                </form>
              </section>
            </div>
          ) : (
            <div className="surface detail-empty"><div className="empty-illustration">♜</div><h2>选择一位工作人员</h2><p>查看工作记录并留下院长意见。</p></div>
          )}
        </section>
      </div>
    </>
  );
}
