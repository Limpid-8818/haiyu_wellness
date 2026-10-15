import React, { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../lib/request.js';
import { initials, normalizeGuestSummary } from '../lib/normalize.js';
import { Brand } from '../shared/branding.jsx';
import { Loading, ErrorState } from '../shared/ui.jsx';
import { STAFF_JOB_LABELS, defaultStaffSection, staffSectionLabel } from './navigation.js';
import { GuestView } from '../components/guest/GuestView.jsx';
import { StaffView } from '../components/staff/StaffView.jsx';
import { AssistantWidget } from '../components/assistant/AssistantWidget.jsx';
import { MoodPlayerDock } from '../MoodSpace.jsx';

export function AppShell({ user, onLogout }) {
  const [section, setSection] = useState(user.initialSection || (user.role === 'guest' ? 'caretaker' : defaultStaffSection(user)));
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState('');
  const [meLoading, setMeLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [assistantGuestId, setAssistantGuestId] = useState('');
  const [activeMoodResource, setActiveMoodResource] = useState(null);
  const [reviewDraftRequest, setReviewDraftRequest] = useState('');
  const [operationsSourceRequest, setOperationsSourceRequest] = useState(null);
  const toastTimer = useRef(null);
  const landingResolved = useRef(Boolean(user.initialSection || user.role === 'guest'));
  const assistantRole = user.role === 'dean' ? 'dean' : user.role;

  const notify = useCallback((message) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2800);
  }, []);

  const loadMe = useCallback(async () => {
    setMeLoading(true);
    setMeError('');
    try {
      const data = await request('/me');
      setMe(normalizeGuestSummary(data));
      if (!landingResolved.current) {
        setSection(defaultStaffSection({ ...user, jobType: data.jobType || user.jobType }));
        landingResolved.current = true;
      }
    } catch (error) {
      if (error.status === 401) {
        onLogout();
      } else {
        setMeError(error.message || '工作区暂时无法加载');
      }
    } finally {
      setMeLoading(false);
    }
  }, [onLogout, user]);

  useEffect(() => {
    loadMe();
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [loadMe]);

  const handleGuestChange = useCallback((guestId) => setAssistantGuestId(guestId || ''), []);
  const handleAuthExpired = useCallback(() => onLogout(), [onLogout]);
  const clearReviewDraftRequest = useCallback(() => setReviewDraftRequest(''), []);
  const openReviewSource = useCallback(draftId => {
    if (user.role !== 'staff' || me?.jobType !== 'clinician' || !me?.capabilities?.medicalAdvicePublish || !draftId) {
      notify('只有负责医护可以打开疗程审核来源'); return;
    }
    setReviewDraftRequest(draftId); setSection('wellness-review');
  }, [me, notify, user.role]);
  const openOperationsSource = useCallback((source, content = '') => {
    if (user.role !== 'staff' || me?.jobType !== 'administrator' || !me?.capabilities?.operationsSummaryView || !source?.id) {
      notify('当前岗位无权打开运营时段'); return;
    }
    setOperationsSourceRequest({ source, content }); setSection('operations');
  }, [me, notify, user.role]);
  const guestNav = [{ id: 'caretaker', label: '管家', icon: '⌂' }, { id: 'schedule', label: '日程', icon: '▦' }, { id: 'projects', label: '项目', icon: '◇' }, { id: 'meals', label: '膳食', icon: '◒' }, { id: 'my', label: '我的', icon: '◯' }];
  const capabilities = me?.capabilities || user.capabilities || {};
  const managementAllowed = capabilities.staffManagement ?? user.role === 'dean';
  const staffNav = [
    ...(capabilities.operationsSummaryView ? [{ id: 'overview', label: '工作概览', icon: '⌂' }] : []),
    { id: 'guests', label: '我负责的客人', icon: '♧' },
    ...(managementAllowed ? [
      { id: 'operations', label: '机构运营', icon: '▤' },
      { id: 'staff-admin', label: '员工账号', icon: '♜' },
      { id: 'projects-admin', label: '项目维护', icon: '◇' },
      { id: 'capabilities', label: '岗位权限', icon: '◇' },
      { id: 'admissions', label: '入住管理', icon: '⌂' },
      { id: 'assignments', label: '客人分工', icon: '♧' }
    ] : []),
    ...(user.role === 'staff' && user.jobType === 'coach' ? [{ id: 'daily', label: '每日安排', icon: '▦' }] : []),
    ...(user.role === 'staff' && user.jobType === 'therapist' ? [{ id: 'therapy', label: '理疗工作台', icon: '◇' }] : []),
    ...(user.role === 'staff' && user.jobType === 'dietitian' ? [{ id: 'meal-prep', label: '备餐工作台', icon: '◒' }] : []),
    ...(capabilities.medicalAdvicePublish ? [{ id: 'rules', label: '禁忌规则', icon: '⊘' }] : []),
    ...(capabilities.medicalAdvicePublish ? [{ id: 'wellness-review', label: '疗程审核', icon: '✓' }] : []),
    ...(capabilities.medicalAdvicePublish || managementAllowed ? [{ id: 'wellness-history', label: '疗程审核历史', icon: '↺' }] : []),
    ...(user.role === 'dean' ? [{ id: 'team', label: '院长意见', icon: '♜' }] : []),
    { id: 'account', label: '我的账号', icon: '◯' }
  ];
  const nav = user.role === 'guest' ? guestNav : staffNav;
  const guestNavId = ['profile', 'health', 'advice', 'mood', 'accessibility', 'reservations'].includes(section) ? 'my' : section;
  const selectedNavId = user.role === 'guest' ? guestNavId : section;
  const assistantKey = `${assistantRole}:${user.id || user.username}:${['staff', 'dean'].includes(assistantRole) ? assistantGuestId || 'none' : 'none'}`;

  return <div className="app-shell"><aside className="app-sidebar"><Brand compact/><div className="workspace-label">{user.role === 'guest' ? '客人空间' : user.role === 'dean' ? '院长空间' : `${STAFF_JOB_LABELS[user.jobType] || '工作人员'}工作区`}</div><nav className="side-nav" aria-label="工作区导航">{nav.map(item => <button type="button" key={item.id} className={selectedNavId === item.id ? 'active' : ''} onClick={() => setSection(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav><div className="side-bottom"><div className="privacy-note"><span>◈</span><div><strong>隐私保护中</strong><small>仅展示你有权限查看的信息</small></div></div><button type="button" className="logout-btn" onClick={onLogout}>退出登录</button></div></aside><div className="app-main"><header className="app-header"><div className="breadcrumb">海屿康养社区　/　<span>{nav.find((item) => item.id === selectedNavId)?.label || staffSectionLabel(section, user)}</span></div><div className="user-menu"><div className="avatar">{initials(user.name)}</div><div><strong>{user.name}</strong><small>{user.role === 'guest' ? '康养客人' : user.role === 'dean' ? '院长' : `${STAFF_JOB_LABELS[user.jobType] || '工作人员'}`}</small></div><button type="button" onClick={onLogout}>退出</button></div></header><main className="workspace"><p className="release-boundary" data-testid="release-boundary">本地网页演示 · 菜品、供货、排期和容量为合成示例。已接入的公开环境预报使用地区代表点，机构精确地点未核实；资料不代表安全批准。</p>{meLoading ? <Loading/> : meError ? <ErrorState text={meError} onRetry={loadMe}/> : user.role === 'guest' ? <GuestView section={section} me={me} notify={notify} onSaved={(data) => setMe(normalizeGuestSummary(data))} go={setSection} activeResource={activeMoodResource} onSelectResource={setActiveMoodResource}/> : <StaffView section={section} me={me} notify={notify} onGuestChange={handleGuestChange} go={setSection} reviewDraftId={reviewDraftRequest} onReviewDraftOpened={clearReviewDraftRequest} operationsSource={operationsSourceRequest}/>}</main>{user.role === 'guest' && <MoodPlayerDock resource={activeMoodResource} requestApi={request}/>}</div>{toast && <div className="toast" role="status" aria-live="polite">✓ {toast}</div>}<AssistantWidget key={assistantKey} role={assistantRole} user={user} guestId={assistantGuestId} onAuthExpired={handleAuthExpired} onSelectResource={setActiveMoodResource} onNavigate={setSection} onOpenReviewSource={openReviewSource} onOpenOperationsSource={openOperationsSource}/></div>;
}
