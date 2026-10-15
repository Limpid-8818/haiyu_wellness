import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './overrides.css';
import './agent.css';
import './assistant.css';
import './web-layout.css';
import './age-friendly.css';
import './org-stage11.css';
import './stage13.css';
import './stage15.css';
import './stage16.css';
import './stage21.css';
import './stage22.css';
import './stage24.css';
import './stage25.css';
import './stage26.css';
import './health-metrics.css';
import './mood.css';
import './release.css';
import { checkinAvailability,businessText,businessTime,notificationCategory} from '../../shared/release-presentation.js';
import {SourceDetails,BusinessReason} from './SourceDetails.jsx';
import EnvironmentPanel from './EnvironmentPanel.jsx';
import { MoodPlayerDock, MoodSpace } from './MoodSpace.jsx';
import { request } from './lib/request.js';
import { fmtDate, businessToday, shanghaiDateOffset, slotDateLabel, mealLocalTime, localDateValue, healthBusinessDate, healthBusinessTime, healthInputNow, healthValueToUtc, fmtDateTime } from './lib/date.js';
import { asText, initials, normalizeGuestSummary, normalizeGuestList } from './lib/normalize.js';
import { PageTitle, Metric, SectionHead, Principle, Field, ReadonlyField, Info, Empty, QueryState, ErrorState, Loading } from './shared/ui.jsx';
import { Brand } from './shared/branding.jsx';
import { ErrorBoundary } from './shared/ErrorBoundary.jsx';
import { PasswordPanel } from './shared/PasswordPanel.jsx';
import { STAFF_JOB_LABELS, defaultStaffSection, staffSectionLabel, admissionLabel, wellnessTargetSection } from './app/navigation.js';

const PROFILE_FIELD_LIMITS = { phone: 32, emergencyContact: 128, mobility: 128 };

function PublicHeader({ onHome }) {
  return <header className="public-header"><Brand/><nav><button type="button" className="text-btn" onClick={onHome}>首页</button><a href="#news">社区动态</a><a href="#about">关于海屿</a></nav><div className="header-status"><span className="status-dot"/>服务正常</div></header>;
}

function Home({ onEnter }) {
  const [news, setNews] = useState([]);
  const [selected, setSelected] = useState(null);
  const [newsLoading, setNewsLoading] = useState(true);
  const [newsError, setNewsError] = useState('');
  const weatherOptions = useMemo(() => [
    { label: '东南风 2 级', hint: '适合滨海漫步', icon: '☀' },
    { label: '多云 24°C', hint: '适合室外活动', icon: '☁' },
    { label: '海风 3 级', hint: '建议带一件薄外套', icon: '≈' },
    { label: '晴间多云', hint: '紫外线较强，注意防晒', icon: '◒' }
  ], []);
  const [weatherIndex, setWeatherIndex] = useState(() => Math.floor(Math.random() * weatherOptions.length));
  const weather = weatherOptions[weatherIndex];

  useEffect(() => {
    const controller = new AbortController();
    setNewsLoading(true);
    request('/news', { signal: controller.signal })
      .then((data) => setNews(Array.isArray(data) ? data : []))
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          setNews([]);
          setNewsError(error.message || '社区动态暂时无法加载');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setNewsLoading(false);
      });
    return () => controller.abort();
  }, []);

  const featured = news[0];
  const newsState = newsLoading ? <QueryState text="正在加载社区动态…"/> : newsError ? <QueryState error text={newsError} retryText="社区动态暂时不可用"/> : !news.length ? <QueryState text="暂无社区动态"/> : null;

  return <div className="public-shell"><PublicHeader onHome={() => window.scrollTo({ top: 0, behavior: 'smooth' })}/><main>
    <section className="hero"><div className="hero-copy"><div className="eyebrow">面向每一个人的滨海康养服务</div><h1>把日子过得<br/><em>更从容一点</em></h1><p>海屿康养社区连接客人、医护与服务团队，让健康信息有边界地流动，让每一次照护都更贴近真实需要。</p><div className="hero-actions"><button type="button" className="primary-btn" onClick={() => onEnter('guest')}>我是客人 <span>→</span></button><button type="button" className="secondary-btn" onClick={() => onEnter('staff')}>我是工作人员 <span>→</span></button><button type="button" className="secondary-btn" onClick={() => onEnter('dean')}>院长管理入口 <span>→</span></button></div><div className="hero-note"><span>✦</span> 个人信息仅在授权工作区内展示</div></div><div className="hero-art"><div className="sun"/><div className="wave wave-a"/><div className="wave wave-b"/><button type="button" className="hero-card" onClick={() => setWeatherIndex(index => (index + 1) % weatherOptions.length)} aria-label="切换演示天气"><span className="mini-label">今日海风 · 演示数据　↻ 点击切换</span><strong>{weather.icon} {weather.label}</strong><span className="mini-muted">{weather.hint}</span></button></div></section>
    <section className="trust-strip"><div><strong>清晰的角色边界</strong><span>客人和工作人员各自拥有独立空间</span></div><div><strong>可追溯的健康记录</strong><span>每条医嘱都记录来源与时间</span></div><div><strong>温和而专业的服务</strong><span>让照护回到人与人的连接</span></div></section>
    <section className="news-section" id="news"><div className="section-heading"><div><div className="eyebrow">COMMUNITY JOURNAL</div><h2>社区动态</h2></div><button type="button" className="link-btn" onClick={() => document.getElementById('news-grid')?.scrollIntoView({ behavior: 'smooth' })}>查看全部 <span>↗</span></button></div><div className="featured-news">{featured ? <><div className="featured-image"><span>{featured.category}</span><div className="feature-symbol">{featured.category === '健康管理' ? '◒' : featured.category === '滨海活动' ? '≈' : '✣'}</div></div><div className="featured-copy"><div className="news-meta"><span className="tag">置顶</span><span>{featured.category}</span><span>{fmtDate(featured.publishedAt)}</span></div><h3>{featured.title}</h3><p>{featured.summary}</p><button type="button" className="read-btn" onClick={() => setSelected(featured)}>阅读全文 <span>→</span></button></div></> : <div className="news-empty">{newsState}</div>}</div><div className="news-grid" id="news-grid">{news.slice(1).map(item => <article className="news-card" key={item.id} role="button" tabIndex="0" onClick={() => setSelected(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(item); } }}><div className="card-top"><span className="category-dot"/>{item.category}<time>{fmtDate(item.publishedAt)}</time></div><h3>{item.title}</h3><p>{businessText(item.summary)}</p><span className="card-arrow">↗</span></article>)}</div></section>
    <section className="entry-section"><div className="entry-copy"><div className="eyebrow">YOUR SPACE</div><h2>从这里，进入<br/><em>属于你的空间</em></h2><p>不同的身份，不同的工作台。选择身份后，我们会把你需要的内容放在最顺手的位置。</p></div><div className="entry-cards"><button type="button" onClick={() => onEnter('guest')}><span className="entry-icon blue">⌂</span><span><strong>我是客人</strong><small>查看我的资料、健康与医嘱</small></span><b>→</b></button><button type="button" onClick={() => onEnter('staff')}><span className="entry-icon orange">✚</span><span><strong>我是工作人员</strong><small>管理负责客人并提供专业建议</small></span><b>→</b></button><button type="button" onClick={() => onEnter('dean')}><span className="entry-icon orange">♜</span><span><strong>院长管理入口</strong><small>查看团队记录并留下管理意见</small></span><b>→</b></button></div></section>
    <section className="about-section" id="about"><div className="about-number">01</div><div><div className="eyebrow">ABOUT HAIYU</div><h2>让信息更有边界，<br/>让照护更有温度。</h2></div><p>海屿不是把所有信息堆在一起的管理后台，而是一座有公共客厅、个人房间和专业工作台的社区。首页属于所有人，档案只属于被授权的人。</p></section>
  </main><footer><Brand compact/><span>© 2026 海屿康养社区 · 面向康养服务场景的数字化平台</span><span>隐私政策　服务说明</span></footer>{selected && <NewsModal item={selected} onClose={() => setSelected(null)}/>}<AssistantWidget role="public"/></div>;
}

function NewsModal({ item, onClose }) {
  return <div className="modal-backdrop" onClick={onClose}><div className="news-modal" onClick={(event) => event.stopPropagation()}><button type="button" className="close-btn" onClick={onClose} aria-label="关闭新闻详情">×</button><div className="news-meta"><span className="tag">{item.category}</span><span>{fmtDate(item.publishedAt)}</span></div><h2>{item.title}</h2><p className="modal-summary">{item.summary}</p><div className="modal-body">{item.body}</div></div></div>;
}

const ROLE_COPY = {
  guest: { username: 'guest_demo', password: 'guest2026', badge: '客人入口', quote: '你的健康，<br/>值得被认真对待。', lead: '在个人空间里查看自己的资料、健康记录与医嘱。', space: '个人空间' },
  staff: { username: 'staff_demo', password: 'staff2026', badge: '工作人员入口', quote: '专业的判断，<br/>从完整的信息开始。', lead: '在工作人员空间里，安全地管理你负责的每一位客人。', space: '工作台' },
  dean: { username: 'dean_demo', password: 'dean2026', badge: '院长管理入口', quote: '让团队的每一次照护，<br/>都被看见。', lead: '在院长空间里查看团队工作记录并留下管理意见。', space: '院长空间' }
};

function Login({ role, onBack, onLogin }) {
  const copy = ROLE_COPY[role] || ROLE_COPY.staff;
  const [username, setUsername] = useState(copy.username);
  const [password, setPassword] = useState(copy.password);
  const [registering, setRegistering] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const passwordMismatch = registering && confirmPassword.length > 0 && password !== confirmPassword;

  async function submit(event) {
    event.preventDefault();
    if (loading) return;
    setLoading(true);
    setError('');
    try {
      const data = await request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password, role }) });
      localStorage.setItem('community_token', data.token);
      localStorage.setItem('community_user', JSON.stringify(data.user));
      onLogin(data.user);
    } catch (requestError) {
      setError(requestError.message || '登录失败，请检查账号信息');
    } finally {
      setLoading(false);
    }
  }

  async function register(event) {
    event.preventDefault();
    if (loading) return;
    if (password !== confirmPassword) {
      setError('两次输入的密码不一致');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const data = await request('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ name, phone, password, confirmPassword })
      });
      localStorage.setItem('community_token', data.token);
      localStorage.setItem('community_user', JSON.stringify(data.user));
      onLogin(data.user, 'profile');
    } catch (requestError) {
      setError(requestError.message || '注册失败，请检查填写内容');
    } finally {
      setLoading(false);
    }
  }

  return <div className="login-shell"><div className="login-aside"><Brand/><div className="login-quote"><span>“</span><h2 dangerouslySetInnerHTML={{ __html: copy.quote }}/><p>{copy.lead}</p></div><div className="login-aside-foot">海屿康养社区 · 安全工作区</div></div><div className="login-panel"><button type="button" className="back-btn" onClick={onBack}>← 返回首页</button><div className="login-form-wrap"><div className={`role-badge ${role}`}>{registering ? '客人注册' : copy.badge}</div><h1>{registering ? '创建客人账号' : '欢迎回来'}</h1><p className="form-lead">{registering ? '使用手机号注册，注册后可进入个人档案。' : `请输入你的账号信息，进入${copy.space}。`}</p>{registering ? <form onSubmit={register} noValidate><label htmlFor="register-name">姓名<input id="register-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={64} required/></label><label htmlFor="register-phone">手机号<input id="register-phone" value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" inputMode="tel" autoComplete="tel" maxLength={11} required/></label><label htmlFor="register-password">密码<input id="register-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" minLength={8} maxLength={128} required/></label><label htmlFor="register-confirm-password">确认密码<input id="register-confirm-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" minLength={8} maxLength={128} required aria-invalid={passwordMismatch}/></label>{passwordMismatch && <div className="form-error inline-error" role="alert">两次输入的密码不一致</div>}{error && <div className="form-error" role="alert" aria-live="assertive">{error}</div>}<button type="submit" className="primary-btn full" disabled={loading || passwordMismatch} aria-busy={loading}>{loading ? '正在创建…' : '注册并进入档案　→'}</button><button type="button" className="login-switch" onClick={() => { setRegistering(false); setPassword(copy.password); setConfirmPassword(''); setError(''); }}>已有账号？返回登录</button></form> : <form onSubmit={submit}><label htmlFor="login-username">账号<input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username"/></label><label htmlFor="login-password">密码<input id="login-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password"/></label>{error && <div className="form-error" role="alert" aria-live="assertive">{error}</div>}<button type="submit" className="primary-btn full" disabled={loading} aria-busy={loading}>{loading ? '正在进入…' : '进入工作区　→'}</button>{role === 'guest' && <button type="button" className="login-switch" onClick={() => { setRegistering(true); setPassword(''); setConfirmPassword(''); setError(''); }}>没有账号？客人注册</button>}</form>}{!registering && <div className="demo-hint">演示账号已预填，可直接点击进入。生产环境请使用机构分配的账号。</div>}</div></div></div>;
}

function AppShell({ user, onLogout }) {
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

function GuestView({ section, me, notify, onSaved, go, activeResource, onSelectResource }) {
  if (!me) return <Loading/>;
  if (section === 'profile') return <GuestProfile me={me} notify={notify} onSaved={onSaved}/>;
  if (section === 'health') return <GuestHealth me={me}/>;
  if (section === 'advice') return <GuestAdvice me={me}/>;
  if (section === 'schedule') return <GuestSchedule me={me} onSelectResource={onSelectResource}/>;
  if (section === 'projects') return <GuestProjects go={go}/>;
  if (section === 'meals') return <GuestMeals me={me} notify={notify}/>;
  if (section === 'my') return <GuestMy me={me} go={go}/>;
  if (section === 'reservations') return <GuestReservations go={go}/>;
  if (section === 'mood') return <MoodSpace requestApi={request} activeResource={activeResource} onSelectResource={onSelectResource}/>;

  return <GuestOverview me={me} go={go}/>;
}

function GuestMy({ me, go }) {
  const entries = [
    { id: 'profile', title: '我的档案', description: '查看与更新你可以编辑的联系资料。', detail: '联系资料可修改，正式健康档案由负责医护核实。' },
    { id: 'reservations', title: '我的预约', description: '查看服务时间、已确认预约和取消记录。', detail: '预约记录来自服务端。' },
    { id: 'mood', title: '心情与陪伴', description: '记录今天的心情、查看近 7/30 日变化并播放本地演示资源。', detail: '每天一条记录，保留修改历史。' },
    { id: 'health', title: '健康记录', description: `现有健康记录 ${me.health?.length || 0} 条。`, detail: '新增或撤回自己的指标记录。' },
    { id: 'advice', title: '我的医嘱', description: `现有医嘱 ${me.advice?.length || 0} 条。`, detail: '按负责医护的建议执行；如有疑问请联系医护。' }
  ];
  return <><PageTitle eyebrow="PERSONAL SPACE" title="我的" desc="个人档案入口与当前可查看的数据。"/><div className="guest-my-grid">{entries.map(entry => <button className="surface guest-my-entry" type="button" key={entry.id} onClick={() => go(entry.id)}><span className="guest-my-entry-icon" aria-hidden="true">{entry.id === 'health' ? '⌁' : entry.id === 'mood' ? '♡' : entry.id === 'accessibility' ? 'Aa' : entry.id === 'advice' ? '✚' : entry.id === 'reservations' ? '▦' : '◯'}</span><span className="guest-my-entry-copy"><strong>{entry.title}</strong><span>{entry.description}</span></span><span className="guest-my-entry-detail">{entry.detail}</span><span className="guest-my-entry-arrow" aria-hidden="true">→</span></button>)}</div></>;
}

const placeholderCopy = {
  schedule: { title: '日程', lead: '日程页面待开发。当前没有可预约的日程内容。', sub: '此处不会生成预约或活动安排。' },
  meals: { title: '膳食', lead: '膳食页面待开发。当前没有个人餐单或饮食数据。', sub: '此处不会展示模拟餐单或个性化建议。' },
  mood: { title: '心情记录', lead: '心情记录页面待开发。当前没有心情数据。', sub: '此处不会展示模拟的心情记录。' }
};

function GuestPlaceholder({ kind }) {
  const copy = placeholderCopy[kind];
  return <><PageTitle eyebrow="GUEST SPACE" title={copy.title} desc={copy.lead}/><section className="surface guest-placeholder-panel"><div className="guest-placeholder-state" role="status"><strong>页面尚未接入</strong><p>{copy.sub}</p></div></section></>;
}

const MEAL_LABELS = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐' };
const SLOT_LABELS = { main: '主食', side: '配菜', soup: '汤品' };
const ORDER_STATUS_LABELS = { reserved: '已提交', preparing: '备餐中', delivered: '已送达' };
const MEAL_SOURCE_LABELS = {
  'verified-profile': '正式档案',
  'legacy-profile': '历史档案',
  form: '待核实自述',
  assistant: '待核实对话自述',
  'pending-intake': '待核实自述'
};
const MEAL_RESTRICTION_STATUS_LABELS = { confirmed: '已确认', pending: '待核实', existing: '历史记录' };
const MEAL_FOOD_LABELS = {
  shrimp: '虾类', fish: '鱼类', seafood: '海鲜', egg: '鸡蛋', milk: '乳制品',
  soy: '大豆', wheat: '小麦', gluten: '麸质', oats: '燕麦', peanut: '花生'
};

function mealSourceLabel(value) { return MEAL_SOURCE_LABELS[value] || '健康档案'; }
function mealRestrictionStatusLabel(value) { return MEAL_RESTRICTION_STATUS_LABELS[value] || '已记录'; }
function mealFoodLabels(values) {
  return (values || []).map(value => MEAL_FOOD_LABELS[String(value).trim().toLocaleLowerCase()] || value);
}

function MealConstraintList({ constraints, emptyText }) {
  const items = [...(constraints?.allergies || []), ...(constraints?.dietaryRestrictions || [])];
  return items.length ? <ul>{items.map((item, index) => <li key={index}>{mealFoodLabels([item.value])[0]} · {mealSourceLabel(item.source)} · {mealRestrictionStatusLabel(item.status)}</li>)}</ul> : <p>{emptyText}</p>;
}

function MealOrderTiming({ order }) {
  return <div className="meal-timing" data-time-policy="unknown">
    <small>常规供餐时刻（上海时间，非预计）：{mealLocalTime(order.regularServingAt)}</small>
    <small>{order.expectedDeliveryNote || '预计送达时间未确定；请查看实际备餐与送达状态。'}</small>
    {order.preparingAt && <small>实际开始备餐（上海时间）：{mealLocalTime(order.preparingAt)}</small>}
    {order.deliveredAt && <small>实际送达（上海时间）：{mealLocalTime(order.deliveredAt)}</small>}
  </div>;
}

function MealRestrictionReview({ guestId, canResolve = false, notify, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState([]);
  const [note, setNote] = useState('');
  const endpoint = guestId ? `/staff/guests/${guestId}/meal-restriction-review` : '/meals/restriction-review';
  const load = useCallback(async () => {
    try { const result = await request(endpoint); setData(result); setError(''); setChoices((result.review?.restrictions || []).map(() => ({ classification: '', foodValue: '' }))); }
    catch (err) { setError(err.message); }
  }, [endpoint]);
  useEffect(() => { load(); }, [load]);
  async function submit(resolve) {
    setBusy(true);
    try {
      await request(resolve ? `/staff/meal-restriction-reviews/${data.review.id}/resolve` : endpoint, {
        method: 'POST', body: JSON.stringify(resolve ? { decisions: choices, note } : {})
      });
      notify(resolve ? '医护核对已保存，原健康记录保留' : '限制已转交负责医护'); await load(); await onChanged?.();
    } catch (err) { notify(err.message); setError(err.message); } finally { setBusy(false); }
  }
  if (!data && !error) return null;
  if (data && !data.unrecognized.length && !data.history.length && !error) return null;
  return <section className="surface meal-restriction-review" aria-label="膳食限制人工核对"><SectionHead title="膳食限制人工核对"/><button type="button" className="text-btn" onClick={load}>刷新核对进度</button>
    {error && <p role="alert">{error}</p>}
    {data?.unrecognized.length > 0 && <p>原始限制保留：{data.unrecognized.map(item => item.value).join('、')}。核实前暂停相关选择；仅医护可决定食物与非食物分类。</p>}
    <p>负责医护：{data?.responsibleClinicians.map(item => item.name).join('、') || '尚未分工，请联系机构管理员安排医护'}</p>
    {data?.review ? <><p role="status">处理状态：{data.review.status === 'resolved' ? '已人工核对' : '待医护核对'} · 转交负责人：{data.review.assignedName}</p>
      {data.review.status === 'resolved' ? <p>核对人：{data.review.reviewerName} · {data.review.note} · {mealLocalTime(data.review.reviewedAt)}。健康自述原文与历史保持。</p> : canResolve && <div className="meal-swap-form">{data.review.restrictions.map((item, index) => <div key={index}><label>“{item.value}”的分类<select value={choices[index]?.classification || ''} onChange={event => setChoices(current => current.map((choice, n) => n === index ? { ...choice, classification: event.target.value } : choice))}><option value="">请选择人工核对结果</option><option value="food">食物限制</option><option value="non_food">非食物描述（原文保留）</option></select></label>{choices[index]?.classification === 'food' && <label>对应食材或饮食标签<input value={choices[index]?.foodValue || ''} onChange={event => setChoices(current => current.map((choice, n) => n === index ? { ...choice, foodValue: event.target.value } : choice))} placeholder="例如：鸡蛋、海鲜、花生、清真"/></label>}</div>)}<label>人工核对依据<textarea aria-label="人工核对依据" value={note} maxLength={1000} onChange={event => setNote(event.target.value)} placeholder="记录与客人核对的结果和来源，不推测未知项"/></label><button type="button" className="primary-btn" disabled={busy || !note.trim() || choices.some(choice => !choice.classification || (choice.classification === 'food' && !choice.foodValue.trim()))} onClick={() => submit(true)}>保存医护分类核对</button></div>}</> : data?.unrecognized.length > 0 && <button type="button" className="outline-btn" disabled={busy || !data.responsibleClinicians.length} onClick={() => submit(false)}>转交负责医护核对</button>}
    {data?.history.length > 0 && <details><summary>查看核对历史与原始限制</summary>{data.history.map(item => <div key={item.id}><p>{item.restrictions.map(entry => entry.value).join('、')} · {item.status === 'resolved' ? '已核对' : '待核对'} · {item.reviewerName || item.assignedName} · {item.note}</p>{item.decisions.map((decision, index) => <p key={index}>“{decision.value}” → {decision.classification === 'non_food' ? '非食物描述' : `食物限制：${decision.foodValue}`}</p>)}</div>)}</details>}
  </section>;
}

function GuestMeals({ me, notify }) {
  const [date, setDate] = useState(businessToday);
  const [data, setData] = useState(null);
  const [dishes, setDishes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [editingId, setEditingId] = useState('');
  const [swap, setSwap] = useState({ dishId: '', reason: '' });

  const loadGeneration = useRef(0);
  const load = useCallback(async () => {
    // 快速切换日期时，晚到的旧响应不再覆盖新数据（G20）
    const generation = ++loadGeneration.current;
    setLoading(true); setError('');
    try {
      const [menu, catalog] = await Promise.all([
        request(`/meals/menu?date=${encodeURIComponent(date)}`), request('/meals/dishes')
      ]);
      if (generation !== loadGeneration.current) return;
      setData(menu); setDishes(catalog.items || []);
    } catch (loadError) { if (generation === loadGeneration.current) setError(loadError.message || '餐单暂时无法加载'); }
    finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [date]);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    setBusy('generate');
    try {
      const result = await request('/meals/menus', { method: 'POST', body: JSON.stringify({ businessDate: date }) });
      setData(result); notify(result.status === 'ready' ? '餐单已生成' : '餐单已生成，部分餐位需要配餐员补充');
      await load();
    } catch (requestError) { notify(requestError.message || '餐单生成失败'); }
    finally { setBusy(''); }
  }

  async function replace(item) {
    if (!swap.dishId || !swap.reason.trim()) { notify('请选择菜品并填写替换原因'); return; }
    if (!window.confirm(`确认将「${item.dish?.name || SLOT_LABELS[item.slot]}」替换为所选菜品？${data.orders?.some(order => order.mealType === item.mealType) ? '\n已提交订单会同步更新。' : ''}`)) return;
    setBusy(item.id);
    try {
      await request(`/meals/menus/${encodeURIComponent(data.menu.id)}/items/${encodeURIComponent(item.id)}`, {
        method: 'PATCH', body: JSON.stringify({ version: data.menu.version, dishId: swap.dishId, reason: swap.reason })
      });
      setEditingId(''); setSwap({ dishId: '', reason: '' }); notify('餐位已替换'); await load();
    } catch (requestError) { notify(requestError.message || '替换失败'); if (requestError.status === 409) await load(); }
    finally { setBusy(''); }
  }

  async function order(mealType) {
    if (busy) return;
    setBusy(`order-${mealType}`);
    try {
      const key = `meal-${me.id}-${date}-${mealType}-${window.crypto.randomUUID()}`;
      await request('/meals/orders', {
        method: 'POST', headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ menuId: data.menu.id, businessDate: date, mealType, version: data.menu.version })
      });
      notify(`${MEAL_LABELS[mealType]}订单已提交`); await load();
    } catch (requestError) { notify(requestError.message || '订单提交失败'); if (requestError.status === 409) await load(); }
    finally { setBusy(''); }
  }

  const items = data?.items || [];
  const orders = data?.orders || [];
  const basis = data?.currentRuleBasis || data?.menu?.ruleBasis || {};
  const savedBasis = data?.menu?.ruleBasis?.generatedRuleBasis || data?.menu?.ruleBasis || {};
  const canOrder = (mealType) => data?.status === 'ready' && !data.currentReviewRequired
    && basis.effectiveHealthConstraints?.conflictState === 'clear'
    && items.filter(item => item.mealType === mealType && item.dish && !item.currentlyRestricted).length === 3;
  return <><PageTitle eyebrow="MY MEALS" title="每日膳食" desc="按上海业务日期查看已保存餐单；菜品、配方与供货标记均为演示资料，不代表真实库存或营养检测。" action={<button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新　↻</button>}/>
    <section className="surface meal-toolbar"><label>服务日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label><span>时区：Asia/Shanghai</span></section>
    <MealRestrictionReview notify={notify} onChanged={load}/>
    {loading ? <section className="surface"><QueryState text="正在读取服务端餐单…"/></section> : error ? <section className="surface"><QueryState error text={error} retryText="餐单加载失败"/><button className="outline-btn" type="button" onClick={load}>重试</button></section> : data?.status === 'needs_generation' ? <section className="surface meal-empty"><div className="meal-empty-icon">◒</div><h2>此日期暂无已保存餐单</h2><p>系统不会复制其他日期的餐单。生成前会按当前已记录的过敏与饮食限制筛选；限制信息未确认时会明确提示。</p><button type="button" className="primary-btn" disabled={busy === 'generate'} onClick={generate}>{busy === 'generate' ? '生成中…' : '生成此日期餐单'}</button></section> : <>
      {basis.notices?.length > 0 && <section className="meal-notices" aria-label="健康信息提示">{basis.notices.map((notice, index) => <p key={`${notice.code}-${index}`} role="status"><strong>待核对</strong>{notice.text}</p>)}</section>}
      {data.currentReviewRequired && <section className="meal-notices"><p role="status"><strong>餐单待复核</strong>当前有效健康限制与上次核对时不同。请先完成医护核对，再替换冲突餐位；已有订单还需要负责配餐员复核。</p><button type="button" className="outline-btn" disabled={Boolean(busy) || items.some(item => !item.dish || item.currentlyRestricted)} onClick={async () => { setBusy('review'); try { await request(`/meals/menus/${data.menu.id}/review`, { method: 'POST', body: JSON.stringify({ version: data.menu.version }) }); notify('当前餐位已核对'); await load(); } catch (err) { notify(err.message); } finally { setBusy(''); } }}>确认全部餐位符合当前限制</button></section>}
      {basis.supplyNote && <p className="meal-source-note">{basis.supplyNote}</p>}
      <section className="surface meal-source-note" aria-label="餐单推荐方式" data-menu-id={data.menu.id}><strong>{savedBasis.recommendationPolicy?.label || '目录规则餐单（历史版本）'}</strong><p>{savedBasis.recommendationPolicy?.description || '历史餐单保留原选择；未记录轮换规则版本。'} AI协作建议为另行保存的候选，未采纳或未提交不代表已点餐。此餐单只有点击提交订单后才创建配餐订单。</p><small>第 {data.menu.version} 版 · {savedBasis.recommendationPolicy?.version || '历史版本未记录'}</small><SourceDetails><small>餐单编号 {data.menu.id}</small></SourceDetails></section>
      <div className="meal-day-grid">{['breakfast', 'lunch', 'dinner'].map(mealType => {
        const mealItems = items.filter(item => item.mealType === mealType);
        const currentOrder = orders.find(item => item.mealType === mealType);
        return <section className="surface meal-card" key={mealType} data-meal-type={mealType}>
          <header><div><span className="eyebrow">{date}</span><h2>{MEAL_LABELS[mealType]}</h2></div><span className={`meal-state ${data.status}`}>{data.status === 'ready' ? '已生成' : '部分待补充'}</span></header>
          <div className="meal-items">{mealItems.map(item => <article className="meal-item" key={item.id} data-meal-item-id={item.id}>
            <div className="meal-item-heading"><strong>{SLOT_LABELS[item.slot]}</strong><span>{item.dish ? '演示可供' : '待配餐员补充'}</span></div>
            {item.dish ? <><h3>{item.dish.name}</h3><p><b>明确食材：</b>{item.dish.ingredients?.join('、') || '未提供'}</p><p><b>明确过敏原：</b>{mealFoodLabels(item.dish.allergens).join('、') || '未列出'}</p><p><b>演示标签：</b>{item.dish.nutritionLabels?.join('；') || '无'}</p><p className="meal-selection-reason"><b>选择/替换原因：</b>{item.selectionReason || '历史餐位未记录选择理由；不重新生成或覆盖人工选择。'}</p>{item.currentlyRestricted && <p className="meal-missing" role="status">此菜品与当前限制或供应状态不符，已暂停点餐，请联系配餐员。</p>}</> : <p className="meal-missing" role="status">{item.selectionReason || '没有符合当前限制的菜品，未填入替代菜。'}</p>}
            {editingId === item.id ? <div className="meal-swap-form"><label>替换菜品<select value={swap.dishId} onChange={event => setSwap({ ...swap, dishId: event.target.value })}><option value="">请选择符合当前限制的菜品</option>{(item.eligibleReplacements || []).map(dish => <option value={dish.id} key={dish.id}>{dish.name} · 演示供货</option>)}</select></label><small>替代项已按当前供应、餐次、餐位与有效限制筛选；人工选择不会在刷新时被轮换覆盖。</small><label>替换原因<textarea aria-label="替换原因" value={swap.reason} maxLength={300} onChange={event => setSwap({ ...swap, reason: event.target.value })} placeholder="请说明替换原因"/></label><div><button className="primary-btn" type="button" disabled={busy === item.id || !swap.dishId || !swap.reason.trim()} onClick={() => replace(item)}>{busy === item.id ? '保存中…' : '确认替换'}</button><button className="text-btn" type="button" onClick={() => { setEditingId(''); setSwap({ dishId: '', reason: '' }); }}>取消</button></div>{!item.eligibleReplacements?.length && <small role="status">当前没有可确认的安全替换项，请联系配餐员。</small>}</div> : <button className="outline-btn meal-swap-trigger" type="button" disabled={!item.eligibleReplacements?.length || Boolean(currentOrder && (currentOrder.status === 'delivered' || (currentOrder.status === 'preparing' && !currentOrder.reviewRequired)))} onClick={() => { setEditingId(item.id); setSwap({ dishId: '', reason: '' }); }}>{currentOrder?.status === 'preparing' && !currentOrder.reviewRequired ? '订单备餐中，联系配餐员' : currentOrder?.status === 'delivered' ? '订单已送达，不可替换' : '替换此餐位'}</button>}
          </article>)}</div>
          {currentOrder ? <div className={`meal-order-status ${currentOrder.fulfillmentStatus}`} role="status" data-order-id={currentOrder.id}><span>订单号 {currentOrder.orderNo}</span><strong>{currentOrder.reviewRequired ? '须复核 · 暂停推进' : ORDER_STATUS_LABELS[currentOrder.status]}</strong>{currentOrder.reviewReasons?.map(reason => <small key={reason}>{reason}</small>)}{currentOrder.review && <small>最近核对：{currentOrder.review.checkedName} · {currentOrder.review.note}</small>}<small>提交时间（上海时间）：{mealLocalTime(currentOrder.createdAt)}</small><MealOrderTiming order={currentOrder}/></div> : <button type="button" className="primary-btn meal-order-btn" disabled={!canOrder(mealType) || Boolean(busy)} onClick={() => order(mealType)}>{busy === `order-${mealType}` ? '提交中…' : `提交${MEAL_LABELS[mealType]}订单`}</button>}
        </section>;
      })}</div>
      <section className="surface meal-avoidance"><h2>生成餐单时的限制</h2><MealConstraintList constraints={(data.menu.ruleBasis.generatedRuleBasis || data.menu.ruleBasis).rawHealthConstraints || (data.menu.ruleBasis.generatedRuleBasis || data.menu.ruleBasis).effectiveHealthConstraints} emptyText="生成时未列出明确限制；这是历史快照。"/><h2>当前有效食物限制</h2><MealConstraintList constraints={basis.effectiveHealthConstraints} emptyText="当前未列出明确食物限制；未回答与不确定状态见上方提示。"/>{basis.nonFoodRestrictions?.map((item, index) => <p key={index}>保留原文“{item.value}”：医护人工核对为非食物描述 · {basis.restrictionReview?.reviewerName} · {basis.restrictionReview?.note}</p>)}</section>
    </>}
  </>;
}

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

function reservationStatusLabel(status) {
  return status === 'confirmed' ? '已确认' : status === 'cancelled' ? '已取消' : status;
}

function cancellationReasonLabel(reason) {
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

const WELLNESS_FEELING_LABELS = { comfortable: '舒服', general: '一般', uncomfortable: '不舒服' };

function CheckinFeedbackCard({ item, onCheckin, onFeedback, busy }) {
  const [feeling, setFeeling] = useState(item.feedback?.feeling || 'general');
  const [note, setNote] = useState(item.feedback?.note || '');
  useEffect(() => {
    setFeeling(item.feedback?.feeling || 'general');
    setNote(item.feedback?.note || '');
  }, [item.feedback?.id, item.feedback?.revision, item.feedback?.updatedAt]);
  const clockAnchor = useRef({server: item.serverNow, started: performance.now()});
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { clockAnchor.current={server:item.serverNow,started:performance.now()}; setElapsed(0); const timer=setInterval(()=>setElapsed(performance.now()-clockAnchor.current.started),1000); return ()=>clearInterval(timer); },[item.serverNow]);
  const serverInstant=Date.parse(clockAnchor.current.server);
  const checkinWindow=Number.isFinite(serverInstant)?checkinAvailability(item,new Date(serverInstant+elapsed).toISOString()):{canCheckin:false,checkinNote:'开始时间待核对，请刷新或联系工作人员'};
  const feedbackCanEdit = !item.feedback || item.feedback.businessDate === businessToday();
  return <article className="q24-execution-card" data-testid={`q24-appointment-${item.reservationId}`}>
    <div className="q24-execution-main"><div><span className="eyebrow">项目执行 · {item.businessDate}</span><h3>{item.projectName}</h3>
      <p>{item.localStart}–{item.localEnd} · {item.location || '地点待核对'}</p></div>
      <span className={`q24-state ${item.reservationStatus}`}>{item.reservationStatus === 'confirmed' ? '预约有效' : item.reservationStatus === 'no_show' ? '未参加' : '已取消'}</span>
    </div>
    {item.executions?.map(entry => <p className="health-review-note" role="status" key={entry.id}>{STAFF_JOB_LABELS[entry.jobType]}：{entry.status === 'completed' ? '服务已完成' : '已登记未参加'} · {entry.actorName} · {entry.note}</p>)}
    {item.checkin ? <div className="q24-checkin-saved" role="status"><strong>已签到</strong><span>{mealLocalTime(item.checkin.checkedInAt)}</span></div>
      : <div className="q24-checkin-action"><span>{checkinWindow.checkinNote}</span>
        <button type="button" className="primary-btn small-btn" data-testid={`q24-checkin-${item.reservationId}`}
          disabled={busy || !checkinWindow.canCheckin} onClick={() => onCheckin(item.reservationId)}>
          {busy ? '正在签到…' : '签到'}</button></div>}
    {item.checkin && <form className="q24-feedback-form" data-testid={`q24-feedback-${item.reservationId}`}
      onSubmit={event => { event.preventDefault(); onFeedback(item, { feeling, note }); }}>
      <div className="q24-feedback-head"><div><strong>项目后的感受</strong><span>{item.feedback ? `反馈第 ${item.feedback.revision} 版` : '你的记录只关联这次真实签到'}</span></div>
        {item.feedback && <small>{feedbackCanEdit ? '上海时间今天可修改' : `已过修改时段 · ${item.feedback.businessDate}`}</small>}</div>
      <label>感受<select aria-label={`${item.projectName}的项目感受`} value={feeling} onChange={event => setFeeling(event.target.value)} disabled={!feedbackCanEdit || busy}>
        <option value="comfortable">舒服</option><option value="general">一般</option><option value="uncomfortable">不舒服</option>
      </select></label>
      <label>补充说明<textarea aria-label="补充说明" rows="2" maxLength={500} value={note} onChange={event => setNote(event.target.value)}
        placeholder="可以简短记录身体感受" disabled={!feedbackCanEdit || busy}/></label>
      {feedbackCanEdit && <button type="submit" className="outline-btn small-btn" disabled={busy}>{busy ? '保存中…' : item.feedback ? '保存当天修改' : '保存感受'}</button>}
      {item.feedback?.revisions?.length > 1 && <details className="q24-feedback-history"><summary>修改记录（{item.feedback.revisions.length} 版）</summary>
        <ol>{item.feedback.revisions.map(revision => <li key={revision.id || revision.revision}>第 {revision.revision} 版 · {WELLNESS_FEELING_LABELS[revision.feeling]} · {revision.businessDate} · {revision.note || '无补充说明'}</li>)}</ol>
      </details>}
    </form>}
    <SourceDetails data={item}/>
  </article>;
}

function ReplanEventCard({ item, onEvaluate, busy }) {
  const changes = item.changes || [];
  return <article className="q24-replan-card" data-testid={`q24-replan-${item.id}`}>
    <header><div><span className="eyebrow">可追溯的调整来源</span><h3>{businessText(item.sourceLabel)}</h3>
      <p>{businessText(item.sourceType)} · 来源版本 {item.sourceVersion} · 记录于 {mealLocalTime(item.createdAt)}</p></div>
      <span className={`q24-state ${item.status}`}>{item.candidateStatus === 'active' || item.candidateStatus === 'auto_activated' ? '候选已激活' : item.candidate ? '候选待审核' : item.requiresAttention ? '待评估' : '已记录'}</span>
    </header>
    {item.triggerReason && <BusinessReason value={item.triggerReason}/>}
    {item.requiresAttention && !item.candidate && <button type="button" className="primary-btn small-btn" data-testid={`q24-evaluate-${item.id}`}
      disabled={busy} onClick={() => onEvaluate(item.id)}>{busy ? '正在生成候选…' : '生成待审核候选'}</button>}
    {item.candidate && <div className="q24-diff-card" data-testid={`q24-diff-${item.id}`}>
      <div className="q24-diff-head"><strong>方案差异</strong><span>原版 {item.baseline ? `第 ${item.baseline.version} 版` : '暂无已激活版本'} → 候选第 {item.candidate.version} 版</span></div>
      <p>来源依据：{businessText(item.sourceType)} · 版本 {item.sourceVersion}。候选在审核完成前不会替换当前疗程或预约。</p>
      {changes.length ? <div className="q24-diff-list">{changes.map(change => <div className={`q24-diff-row ${change.kind}`} key={change.key}>
        <span>{change.kind === 'added' ? '新增' : change.kind === 'removed' ? '移除' : '调整'}</span>
        <div><small>原安排</small><strong>{change.original ? `${change.original.businessDate} ${change.original.localStart || ''} ${change.original.title}` : '无'}</strong></div>
        <div><small>候选安排</small><strong>{change.candidate ? `${change.candidate.businessDate} ${change.candidate.localStart || ''} ${change.candidate.title}` : '无'}</strong></div>
      </div>)}</div> : <div className="q24-no-diff">两个版本的已保存条目相同；保留原版与候选编号供审核比较。</div>}
      <div className="q24-diff-footer"><span>原版有效预约：{item.activeReservations?.length || 0} 条</span><span>候选状态：{businessText(item.candidate.reviewStatus)}</span></div>
    </div>}
    <SourceDetails data={item}/>
  </article>;
}

function EnvironmentHistoryNote({ history }) {
  if (!history) return null;
  return <section className="stage21-draft-notice" data-testid="environment-history">
    <strong>生成时环境 · 历史快照</strong><p>{history.notice}</p>
    <p>生成时间：{mealLocalTime(history.generatedAt)}（上海时间）；旧版来源/规则理由保留。</p>
    {history.generated?.map((old,index)=><p key={old.snapshotId||index}>原地点：{old.location?.name || old.location?.id || '当时地点未记录'} · 原状态：{({available:'当时资料可用',unavailable:'当时来源不可用',stale:'当时资料已过期',demo:'当时为合成资料'})[old.status] || '见原规则理由，未记录的不推测'}</p>)}
    <strong>{history.changed ? '当前地点或来源已不同，请重新评估' : '当前来源对照（不更新旧版）'}</strong>
    {history.current?.map(now=><p key={now.targetDate}>{now.targetDate} · {now.location?.name || '当前地点未配置'} · {({available:'当前选中点可用',demo:'当前合成示例',stale:'当前资料过期',unavailable:'当前资料不可用'})[now.status] || '当前资料待核对'} · 当前来源另列，不是原草案结论。</p>)}
    <p>需要重新评估时，客人使用上方“生成新版本草案”，医护使用待审版本的“保存新待审版本”；读取此说明不会生成、批准或预约。</p><SourceDetails data={history}/>
  </section>;
}

function GuestSchedule({ me, onSelectResource }) {
  const [timeline, setTimeline] = useState(null);
  const [checkins, setCheckins] = useState([]);
  const [replanEvents, setReplanEvents] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [workingId, setWorkingId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const profile = me?.profile || {};
  const stayStart = String(profile.checkIn || profile.check_in || '').slice(0, 10);
  const stayEnd = String(profile.checkOut || profile.check_out || '').slice(0, 10);
  const stayValid = /^\d{4}-\d{2}-\d{2}$/.test(stayStart) && /^\d{4}-\d{2}-\d{2}$/.test(stayEnd) && stayEnd > stayStart;
  const scheduleGeneration = useRef(0);
  const load = useCallback(async () => {
    const generation = ++scheduleGeneration.current;
    setLoading(true); setError('');
    try {
      const [nextTimeline, nextDrafts, nextNotifications, nextCheckins, nextReplanEvents] = await Promise.all([
        request('/me/timeline'),
        request(`/me/therapy-drafts${stayValid ? `?stayStart=${encodeURIComponent(stayStart)}&stayEnd=${encodeURIComponent(stayEnd)}` : ''}`),
        request('/me/wellness-notifications'), request('/me/checkins'), request('/me/replanning-events')
      ]);
      if (generation !== scheduleGeneration.current) return;
      setTimeline(nextTimeline); setDrafts(nextDrafts.items || []); setNotifications(nextNotifications.items || []);
      setCheckins(nextCheckins.items || []); setReplanEvents(nextReplanEvents.items || []);
    } catch (requestError) { if (generation === scheduleGeneration.current) setError(requestError.message || '日程暂时无法加载'); }
    finally { if (generation === scheduleGeneration.current) setLoading(false); }
  }, [stayStart, stayEnd, stayValid]);
  useEffect(() => { load(); }, [load]);

  async function createDraft() {
    if (generating || !stayValid) return;
    setGenerating(true); setError(''); setNotice('');
    try {
      const returnedDraft = drafts.find(item => item.reviewStatus === 'returned');
      const result = await request('/me/therapy-drafts', { method: 'POST',
        headers: { 'Idempotency-Key': `stage22:${crypto.randomUUID()}` },
        body: JSON.stringify(returnedDraft ? { regenerateFromDraftId: returnedDraft.draftId } : {}) });
      setNotice(result.reviewStatus === 'auto_activated' || result.reviewStatus === 'active'
        ? `第 ${result.version} 版低风险疗程已激活；有效活动预约已加入日程。`
        : returnedDraft ? `已根据第 ${returnedDraft.version} 版退回原因重新生成第 ${result.version} 版；请核对新的项目与证据。`
          : `已保存第 ${result.version} 版疗程草案，正在等待医护审核。待审草案不会创建预约或占用时段名额。`);
      await load();
    } catch (requestError) { setError(requestError.message || '疗程草案生成失败，请保留页面后重试'); }
    finally { setGenerating(false); }
  }

  async function checkIn(reservationId) {
    setWorkingId(`checkin:${reservationId}`); setError(''); setNotice('');
    try {
      const result = await request(`/me/reservations/${encodeURIComponent(reservationId)}/checkin`, { method: 'POST', body: '{}' });
      setNotice(`已签到；重复操作不会重复登记。`);
      await load();
    } catch (requestError) { setError(requestError.message || '签到未能保存，请核对预约开始时间'); }
    finally { setWorkingId(''); }
  }

  async function saveFeedback(item, body) {
    setWorkingId(`feedback:${item.reservationId}`); setError(''); setNotice('');
    try {
      const route = item.feedback
        ? `/me/feedback/${encodeURIComponent(item.feedback.id)}`
        : `/me/reservations/${encodeURIComponent(item.reservationId)}/feedback`;
      const result = await request(route, { method: item.feedback ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setNotice(`已保存这次项目的第 ${result.revision} 版反馈。`);
      await load();
    } catch (requestError) { setError(requestError.message || '反馈未能保存，请刷新后重试'); }
    finally { setWorkingId(''); }
  }

  async function evaluateEvent(eventId) {
    setWorkingId(`replan:${eventId}`); setError(''); setNotice('');
    try {
      const result = await request(`/me/replanning-events/${encodeURIComponent(eventId)}/evaluate`, { method: 'POST', body: '{}' });
      setNotice(`已生成第 ${result.candidate?.version || '新'} 版待审疗程；请联系负责医护，当前预约在审核前保持不变。`);
      await load();
    } catch (requestError) { setError(requestError.message || '候选疗程生成失败'); }
    finally { setWorkingId(''); }
  }

  const formatSources = sources => [...new Set((sources || []).map(source => `${source.type}:${source.id}`))];
  const historicalDraft = draft => ['active', 'auto_activated', 'corrected', 'superseded'].includes(draft.reviewStatus);
  const renderDraft = draft => {
    const eraLabel = historicalDraft(draft);
    const byDate = new Map();
    for (const item of draft.items || []) {
      if (!byDate.has(item.businessDate)) byDate.set(item.businessDate, []);
      byDate.get(item.businessDate).push(item);
    }
    return <article className="stage21-draft-card" key={draft.draftId} data-draft-id={draft.draftId}>
      <header><div><span className="eyebrow">WELLNESS DRAFT · VERSION {draft.version}</span><h2>{draft.stayStart} 至 {draft.stayEnd}（离店日不排入）</h2><p>第 {draft.version} 版 · 生成于 {businessTime(draft.createdAt)}</p></div><span className={`stage21-status ${draft.reviewStatus === 'active' || draft.reviewStatus === 'auto_activated' ? 'active' : draft.reviewStatus === 'returned' ? 'returned' : 'pending'}`}>{draft.reviewStatus === 'active' ? '医护已通过 · 已激活' : draft.reviewStatus === 'auto_activated' ? '低风险自动激活' : draft.reviewStatus === 'returned' ? '已退回 · 请重新生成' : draft.reviewStatus === 'corrected' ? '医护已纠正 · 查看新版本' : draft.reviewStatus === 'superseded' ? '已有更新版本' : '等待医护审核'}</span></header>
      <div className="stage21-draft-notice">{draft.reviewStatus === 'active' || draft.reviewStatus === 'auto_activated' ? '疗程已激活；真实项目预约会显示在下方日程。' : draft.reviewStatus === 'returned' ? `医护退回原因：${draft.reviewReason || '请联系医护核对'}。请生成新版本。` : ['superseded','corrected'].includes(draft.reviewStatus) ? '该版本已被医护更新，保留生成时来源供追溯；请查看当前激活版本。' : '只供本人和医护核对。待审核草案不会预约、点餐或占用时段名额。'}</div>
      <EnvironmentHistoryNote history={draft.environmentHistory}/><AdoptedDomainSuggestions evidence={draft.evidence} onSelectResource={onSelectResource}/>
      <SourceDetails data={draft}/><div className="stage21-days">{[...byDate.entries()].map(([date, dayItems]) => <section className="stage21-day" key={date}>
        <div className="stage21-day-head"><h3>{date}</h3><span>{dayItems.length} 项 · {dayItems.filter(item => item.type === 'gap').length} 项缺口</span></div>
        <div className="stage21-item-grid">{dayItems.map(item => <article className={`stage21-item ${item.status}`} key={item.id}>
          <div className="stage21-item-top"><span>{item.type === 'meal' ? ({breakfast:'早餐',lunch:'午餐',dinner:'晚餐'})[item.slotKey] || '餐食' : item.type === 'activity' ? ({morning:'上午活动',afternoon:'下午活动',evening:'晚间活动'})[item.slotKey] || '活动' : item.type === 'rest' ? ({morning:'上午安排',afternoon:'下午安排',evening:'晚间安排'})[item.slotKey] || '安排' : '资料缺口'}</span><strong>{item.localStart ? `${item.localStart}–${item.localEnd}` : item.status === 'gap' ? '未安排' : '时间待定'}</strong></div>
          <h4>{item.title}</h4>{item.location && <p className="stage21-item-location">{item.location}</p>}
          {item.evidence?.resource?.audioUrl && <button type="button" className="outline-btn" onClick={() => onSelectResource?.(item.evidence.resource)}>打开陪伴资源</button>}
          <span className={`stage21-status ${item.status}`}>{({pending_review:'待本人确认',mandatory_review:'必须人工核对',sampled_review:'抽样人工核对',pending_confirmation:'环境待确认',proposed:'建议休息',gap:'信息缺口',excluded:'已排除'})[item.status] || businessText(item.status)}</span>
          {eraLabel && <small className="stage21-reason-era">生成时记录：当前执行以实际预约与日程为准</small>}
          <BusinessReason value={item.reason}/>
          {item.ruleIds?.length > 0 && <SourceDetails><p>规则：{item.ruleIds.join('、')}</p></SourceDetails>}
          {item.environmentSnapshotId && <SourceDetails><p>环境快照：{item.environmentSnapshotId}</p></SourceDetails>}
          {item.evidence?.healthRisk && <p className="stage21-rule-list"><b>健康约束：</b>{Object.entries(item.evidence.healthRisk).filter(([,value]) => value === true).map(([key]) => businessText(key)).join('、') || '需人工复核'}</p>}
          <details className="stage21-sources"><summary>来源与证据</summary><p>候选编号：{item.candidateId || '无'}</p>{formatSources(item.sourceIds).length ? <ul>{formatSources(item.sourceIds).map(value => <li key={value}>{value}</li>)}</ul> : <p>没有可引用的来源编号。</p>}
            {item.evidence?.rules?.map((rule, index) => <p key={`${rule.ruleId}-${index}`}>{rule.ruleId} · {rule.action} · {rule.reason}</p>)}
          </details>
        </article>)}</div>
      </section>)}</div>
    </article>;
  };

  return <><PageTitle eyebrow="MY SCHEDULE" title="日程与疗程草案" desc="待审核建议、已确认预约和取消记录分开显示。草案不会占用真实时段。" action={<button type="button" className="outline-btn small-btn" onClick={load} disabled={loading}>刷新日程　↻</button>}/>
    <section className="surface stage21-plan-toolbar"><div><strong>当前入住区间</strong><span>{stayValid ? `${stayStart} 至 ${stayEnd} · 离店日不排入` : '入住日期尚未完整登记'}</span><small>三晚最多生成 3 天；十晚最多生成 7 天。只使用领域候选、当日餐单和已登记的实际时段。</small></div><button type="button" className="primary-btn" onClick={createDraft} disabled={!stayValid || generating || loading}>{generating ? '正在生成并核对…' : drafts.length ? '生成新版本草案' : '生成疗程草案'}</button></section>
    {notice && <div className="stage21-success" role="status">{notice}</div>}{error && <div className="project-form-error" role="alert">{error}</div>}
    {notifications.length > 0 && <section className="surface wellness-guest-notifications"><SectionHead title="日程通知"/>{[...new Set(notifications.map(item=>notificationCategory(item).key))].map(key=><section key={key} className="release-notice-group" data-notice-category={key}><h3>{notificationCategory(notifications.find(item=>notificationCategory(item).key===key)).label}</h3><ul>{notifications.filter(item=>notificationCategory(item).key===key).map(item=><li key={item.id}><span>{businessText(item.message)}</span><small>{businessTime(item.createdAt)}</small><SourceDetails data={item}/></li>)}</ul></section>)}</section>}
    {loading ? <section className="surface project-state">正在读取草案、预约和取消记录…</section> : <>
      <section className="stage21-timeline-section q24-execution-section" data-testid="q24-execution-feedback">
        <div className="stage21-section-heading"><div><span className="eyebrow">EXECUTION · CHECK-IN · FEEDBACK</span><h2>项目签到与感受</h2><p>只有本人真实预约可以签到；签到后可留下项目感受，并在提交当天修改。</p></div><span>{checkins.filter(item => item.checkin).length} 次已签到</span></div>
        {checkins.length ? <div className="q24-execution-list">{checkins.map(item => <CheckinFeedbackCard key={item.reservationId} item={item}
          onCheckin={checkIn} onFeedback={saveFeedback} busy={workingId === `checkin:${item.reservationId}` || workingId === `feedback:${item.reservationId}`}/>)}</div>
          : <div className="surface project-state project-empty">当前没有可签到的本人预约。</div>}
      </section>
      <section className="stage21-timeline-section q24-replan-section" data-testid="q24-replanning-events">
        <div className="stage21-section-heading"><div><span className="eyebrow">SOURCE · REVIEW · VERSION</span><h2>反馈后的疗程评估</h2><p>来源记录和版本可追溯；候选疗程须按现行规则审核后才会影响预约。</p></div><span>{replanEvents.length} 条来源</span></div>
        {replanEvents.length ? <div className="q24-replan-list">{replanEvents.map(item => <ReplanEventCard key={item.id} item={item}
          onEvaluate={evaluateEvent} busy={workingId === `replan:${item.id}`}/>)}</div>
          : <div className="surface project-state project-empty">反馈、指标或心情变化被记录后，来源会显示在这里。</div>}
      </section>
      <section className="stage21-timeline-section"><div className="stage21-section-heading"><div><span className="eyebrow">PROPOSED · INACTIVE</span><h2>疗程草案版本</h2><p>草案使用独立编号和来源运行；待审或人工复核条目都不是预约。</p></div><span>{drafts.length} 版</span></div>
        {drafts.length ? <div className="stage21-draft-list">{drafts.map(renderDraft)}</div> : <div className="surface project-state project-empty"><strong>还没有疗程草案</strong><p>{stayValid ? '生成后会在这里显示逐日餐食、时段、缺口和证据。' : '请先联系工作人员登记有效入住区间。'}</p></div>}
      </section>
      <section className="stage21-timeline-section"><div className="stage21-section-heading"><div><span className="eyebrow">CONFIRMED · UPCOMING</span><h2>待执行预约</h2><p>这里只列出仍有效且尚未开始的已确认预约，容量编号来自预约记录。</p></div><span>{timeline?.upcomingBookings?.length || 0} 条</span></div>
        {timeline?.upcomingBookings?.length ? <div className="surface reservation-list-panel">{timeline.upcomingBookings.map(item => <article className="reservation-row" key={item.id}><div><strong>{item.projectName}</strong><span>{slotDateLabel(item.businessDate)} · {item.localStart}–{item.localEnd}</span><small>{item.location}</small><SourceDetails data={item}/></div><span className="reservation-status confirmed">已确认</span></article>)}</div> : <div className="surface project-state project-empty">当前没有待执行预约。草案不会显示在本列表中。</div>}
      </section>
      <section className="stage21-timeline-section"><div className="stage21-section-heading"><div><span className="eyebrow">CANCELLED · HISTORY</span><h2>取消记录</h2><p>取消预约保留为历史记录，不会进入待执行日程。</p></div><span>{timeline?.cancelledHistory?.length || 0} 条</span></div>
        {timeline?.cancelledHistory?.length ? <div className="surface reservation-list-panel">{timeline.cancelledHistory.map(item => <article className="reservation-row" key={item.id}><div><strong>{item.projectName}</strong><span>{slotDateLabel(item.businessDate)} · {item.localStart}–{item.localEnd}</span><small>{item.location}</small><SourceDetails data={item}/></div><span className="reservation-status cancelled">已取消</span></article>)}</div> : <div className="surface project-state project-empty">当前没有取消记录。</div>}
      </section>
    </>}
  </>;
}

function GuestReservations({ go }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [workingId, setWorkingId] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { const result = await request('/reservations'); setItems(result.items || []); }
    catch (requestError) { setError(requestError.message || '预约记录暂时无法加载'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  async function cancel(item) {
    const time = `${slotDateLabel(item.businessDate)} ${item.localStart}–${item.localEnd}`;
    if (!window.confirm(`将取消「${item.projectName}」${time} 的预约，并释放一个名额。确认取消吗？`)) return;
    setWorkingId(item.id);
    setError('');
    try { await request(`/reservations/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); await load(); }
    catch (requestError) { setError(requestError.message || '取消没有完成，请刷新后重试'); }
    finally { setWorkingId(''); }
  }
  const visibleItems = dateFilter ? items.filter(item => item.businessDate === dateFilter) : items;
  const current = visibleItems.filter(item => item.status === 'confirmed' && Date.parse(item.startsAt) > Date.now());
  const history = visibleItems.filter(item => !current.includes(item));
  const renderRow = item => <article className="reservation-row" key={item.id}><div><strong>{item.projectName}</strong><span>{slotDateLabel(item.businessDate)} · {item.localStart}–{item.localEnd}</span><small>{item.location}</small><SourceDetails><small>预约编号 {item.id}</small></SourceDetails>{item.status === 'cancelled' && <small>取消原因：{cancellationReasonLabel(item.cancellationReason)}</small>}</div><div className="reservation-row-actions"><span className={`reservation-status ${item.status}`}>{reservationStatusLabel(item.status)}</span>{item.status === 'confirmed' && Date.parse(item.startsAt) > Date.now() && <button type="button" className="outline-btn small-btn danger-outline" onClick={() => cancel(item)} disabled={workingId === item.id}>{workingId === item.id ? '取消中…' : '取消预约'}</button>}</div></article>;
  return <><PageTitle eyebrow="MY RESERVATIONS" title="我的预约" desc="按服务日期查看当前预约和历史记录。取消确认后会释放时段名额。"/><div className="reservation-filter-bar"><label htmlFor="reservation-date-filter">服务日期<input id="reservation-date-filter" type="date" value={dateFilter} onChange={event => setDateFilter(event.target.value)}/></label><span>{dateFilter ? <>当前查看 <time>{dateFilter}</time></> : '全部日期'}</span><button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新预约　↻</button></div>{error && <div className="project-form-error" role="alert">{error}</div>}{loading ? <section className="surface reservation-list-panel">正在读取预约…</section> : <div className="reservation-history-layout"><section className="surface reservation-list-panel"><div className="reservation-section-head"><h2>待执行预约</h2><span>{current.length} 条</span></div>{current.length ? current.map(renderRow) : <div className="project-state project-empty"><strong>没有待执行预约</strong><p>{dateFilter ? '所选日期没有待执行预约。' : '项目详情中的时段网格会显示当前可预约名额。'}</p>{!dateFilter && <button type="button" className="outline-btn small-btn" onClick={() => go('projects')}>浏览项目</button>}</div>}</section><section className="surface reservation-list-panel"><div className="reservation-section-head"><h2>历史记录</h2><span>{history.length} 条</span></div>{history.length ? history.map(renderRow) : <div className="project-state project-empty">{dateFilter ? '所选日期暂无历史记录。' : '暂无历史记录。'}</div>}</section></div>}</>;
}

function GuestProjects({ go }) {
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

function formatProjectWindows(windows = []) {
  return windows.map(window => `${(window.days || ['每日']).join('、')} ${window.start}-${window.end}`).join('\n');
}

function parseProjectWindows(value) {
  const lines = value.split(/[\n;；]+/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) throw new Error('请填写至少一个开放窗口');
  return { windows: lines.map(line => {
    const match = line.match(/^(.+?)\s+(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})$/);
    if (!match) throw new Error('时间格式请写成“每日 09:00-11:00”，每行一个窗口');
    return { days: match[1].split(/[、,，]/).map(day => day.trim()).filter(Boolean), start: match[2], end: match[3] };
  }) };
}

function ProjectAdmin({ notify }) {
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('');
  const [form, setForm] = useState({ description: '', openWindowsText: '', active: true });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await request('/admin/projects');
      setItems(result.items || []);
      setSelectedId(current => result.items?.some(item => item.id === current) ? current : result.items?.[0]?.id || '');
    } catch (requestError) {
      setError(requestError.message || '项目资料暂时无法加载');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);
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
      setItems(current => current.map(item => item.id === updated.id ? updated : item));
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
  const [slots, setSlots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingId, setSavingId] = useState('');
  const [capacityDraft, setCapacityDraft] = useState({});
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await request(`/admin/projects/${encodeURIComponent(project.id)}/slots?date=${encodeURIComponent(date)}`);
      setSlots(result.slots || []);
      setCapacityDraft(Object.fromEntries((result.slots || []).map(slot => [slot.id, String(slot.capacity)])));
    } catch (requestError) { setError(requestError.message || '时段排期暂时无法加载'); }
    finally { setLoading(false); }
  }, [project.id, date]);
  useEffect(() => { load(); }, [load]);
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

function RulesWorkbench() {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    const params = search ? `?q=${encodeURIComponent(search)}` : '';
    request(`/rules${params}`).then(result => { if (current) setItems(result.items || []); })
      .catch(requestError => { if (current) setError(requestError.message || '规则暂时无法加载'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [search]);
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

function contrastRatio(foreground, background) {
  const luminance = color => {
    const channels = color.match(/[0-9a-f]{2}/gi).map(channel => parseInt(channel, 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((values[0] + 0.05) / (values[1] + 0.05)).toFixed(2);
}

function GuestAccessibility({ go }) {
  const [sampleText, setSampleText] = useState('这段内容只用于控件交互示例。');
  const [state, setState] = useState({ kind: 'idle', text: '等待操作' });
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const notifySample = message => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const runSuccess = () => {
    setState({ kind: 'success', text: '保存成功：本页示例状态已更新。' });
    setErrorDetailsOpen(false);
    notifySample('示例操作已完成');
  };
  const runFailure = () => {
    setState({ kind: 'error', text: '操作失败：示例服务暂时无法响应。' });
    setErrorDetailsOpen(true);
    notifySample('示例操作失败，可查看详细原因');
  };
  const confirmClear = () => {
    setSampleText('');
    setConfirmOpen(false);
    setState({ kind: 'success', text: '已清除本页临时示例文字。' });
    notifySample('本页示例文字已清除');
  };

  return <div className="accessibility-page"><PageTitle eyebrow="ACCESSIBLE CONTROLS" title="适老化控件样本" desc="仅演示可读文字、操作状态和确认反馈，不提交或修改任何业务资料。" action={<button className="secondary-btn" type="button" onClick={() => go('my')}>← 返回我的</button>}/><section className="surface accessibility-card"><h2>对比度与文字</h2><div className="accessibility-swatches"><div className="accessibility-swatch body-swatch"><strong>正文文字示例</strong><span>海屿康养社区 · 清晰阅读</span><span>正文对比度 {contrastRatio('#153B47', '#F4FAF8')}:1</span></div><div className="accessibility-swatch button-swatch"><strong>海洋蓝按钮文字</strong><span>按钮文字对比度 {contrastRatio('#FFFFFF', '#0B6670')}:1</span></div></div><p>文字颜色 #153B47 / 浅海背景 #F4FAF8；海洋蓝 #0B6670 / 白字。</p></section><section className="surface accessibility-card"><h2>操作状态</h2><label className="accessibility-field" htmlFor="accessibility-sample-text">示例文字<input id="accessibility-sample-text" value={sampleText} onChange={event => setSampleText(event.target.value)} placeholder="输入本页临时示例文字"/></label><div className={`accessibility-state ${state.kind}`} role="status" aria-live="polite"><strong>状态：</strong>{state.text}</div><div className="accessibility-actions"><button className="accessibility-primary" type="button" onClick={runSuccess}>模拟成功</button><button className="accessibility-secondary" type="button" onClick={runFailure}>模拟失败</button><button className="accessibility-danger" type="button" onClick={() => setConfirmOpen(true)}>清除示例文字</button></div>{state.kind === 'error' && <><button className="accessibility-link" type="button" onClick={() => setErrorDetailsOpen(value => !value)}>{errorDetailsOpen ? '收起错误详情' : '查看错误详情'}</button>{errorDetailsOpen && <div className="accessibility-error-detail" role="alert"><strong>错误详情</strong><p>本地演示请求返回模拟网络错误。你可以稍后重试；此消息不会访问外部服务。</p></div>}</>}</section>{toast && <div className="age-toast" role="status" aria-live="polite">{toast}</div>}{confirmOpen && <div className="accessibility-modal-backdrop"><section className="accessibility-confirm" role="dialog" aria-modal="true" aria-labelledby="accessibility-confirm-title"><h2 id="accessibility-confirm-title">确认清除示例文字？</h2><p>这只会清空本页的临时输入示例，不影响个人资料、健康信息或医嘱。</p><div className="accessibility-actions"><button className="accessibility-secondary" type="button" onClick={() => setConfirmOpen(false)}>取消</button><button className="accessibility-danger" type="button" onClick={confirmClear}>确认清除</button></div></section></div>}</div>;
}

const WELLNESS_NOTIFICATION_EVENT = 'wellness-notifications-updated';

function publishWellnessNotificationUpdate() {
  window.dispatchEvent(new Event(WELLNESS_NOTIFICATION_EVENT));
}

function GuestDailyBrief({ me, go }) {
  const [briefState, setBriefState] = useState(null);
  const [notificationState, setNotificationState] = useState({ items: [], unreadCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [readingId, setReadingId] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const [brief, notifications] = await Promise.all([
        request('/me/daily-brief'), request('/me/wellness-notifications')
      ]);
      setBriefState(brief);
      setNotificationState(notifications);
    } catch (loadError) {
      setError(loadError.message || '简报和提醒暂时无法加载');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => { if (active) void load(); };
    refresh();
    window.addEventListener(WELLNESS_NOTIFICATION_EVENT, refresh);
    return () => { active = false; window.removeEventListener(WELLNESS_NOTIFICATION_EVENT, refresh); };
  }, [load]);

  async function markRead(item) {
    if (!item || item.readAt || readingId) return;
    setReadingId(item.id);
    try {
      await request(`/me/wellness-notifications/${encodeURIComponent(item.id)}/read`, { method: 'PATCH', body: '{}' });
      publishWellnessNotificationUpdate();
      await load();
    } catch (readError) { setError(readError.message || '标记已读失败'); }
    finally { setReadingId(''); }
  }

  function openTarget(targetUrl) {
    const section = wellnessTargetSection(targetUrl);
    if (section) go(section);
  }

  const brief = briefState?.brief;
  return <div className="stage25-daily-grid">
    <section className="surface stage25-brief" aria-label="每日简报" data-testid="stage25-daily-brief">
      <header className="stage25-card-head"><div><span className="eyebrow">DAILY BRIEF · ASIA/SHANGHAI</span><h2>每日简报</h2></div>
        <span className="stage25-date">{briefState?.businessDate || '—'}</span></header>
      {loading ? <p className="stage25-muted" role="status">正在读取今日来源…</p>
        : error ? <p className="stage25-error" role="alert">{error}</p>
          : briefState?.status !== 'ready' ? <p className="stage25-muted" data-testid="stage25-brief-state">
            {briefState?.status === 'not_ready' ? '每日简报将在上海时间 07:00 生成。' : '今日简报尚未生成；缺少的来源不会用推测内容补齐。'}
          </p> : <>
            <div className="stage25-greeting"><strong>{brief.greeting}</strong><span>{brief.stay?.label}</span></div>
            <div className="stage25-brief-section" data-testid="stage25-activity-schedule"><div className="stage25-section-title"><strong>今日活动</strong><button type="button" onClick={() => openTarget('reservations')}>查看预约 →</button></div>
              {brief.activities?.length ? brief.activities.map(item => <article className="stage25-plan-row" key={item.reservationId} data-source-id={item.reservationId}>
                <span>{item.localStart}–{item.localEnd}</span><div><strong>{item.projectName}</strong><SourceDetails><small>{item.businessDate} · 预约 {item.reservationId} · {item.location || '地点待核对'}</small></SourceDetails></div>
                <button type="button" aria-label={`查看预约 ${item.reservationId}`} onClick={() => openTarget(item.targetUrl)}>查看</button>
              </article>) : <p className="stage25-muted">当天没有已确认的活动预约。</p>}
            </div>
            <div className="stage25-meals" data-testid="stage25-meal-schedule">{brief.meals?.map(meal => <article className="stage25-meal-row" key={meal.mealType}>
              <div><strong>{meal.label}</strong><small>{meal.items?.length ? meal.items.join('、') : meal.missingNote || '尚无已保存安排'}</small></div>
              <button type="button" onClick={() => openTarget(meal.targetUrl)}>查看膳食</button>
            </article>)}</div>
            <div className="stage25-brief-columns">
              <section><div className="stage25-section-title"><strong>医护建议</strong><button type="button" onClick={() => openTarget('advice')}>查看来源 →</button></div>
                {brief.advice?.length ? brief.advice.slice(0, 3).map(item => <article className="stage25-advice-row" key={item.id} data-source-id={item.id}><strong>{item.title}</strong><p>{item.content}</p><small>{item.authorName || '工作人员'}</small><SourceDetails><small>来源 ID {item.id}</small></SourceDetails></article>) : <p className="stage25-muted">当前没有已发布的医护建议。</p>}
              </section>
              <section><div className="stage25-section-title"><strong>当前选用环境资料</strong></div>
                <ul className="stage25-source-list">{(briefState.currentEnvironment || brief.environment)?.map(item => <li key={item.domain} data-source-id={item.sourceId || ''}>
                  <span>{item.domain === 'weather' ? '天气' : item.domain === 'tide' ? '潮汐' : '海况'}</span>
                  <div><strong>{item.available ? item.summary : item.missingNote}</strong>{item.available && <small>{item.sourceName}</small>}</div>
                </li>)}</ul>
              </section>
            </div>
            {briefState.generatedBrief && <details className="stage25-missing" data-testid="brief-environment-history"><summary>生成时环境（历史快照，保持原件）</summary><p>生成时间 {mealLocalTime(briefState.generatedAt)} · 当前对照地点 {briefState.environmentContext?.currentLocation?.name || '未配置'}；旧来源与当前不同不会回写旧简报。</p><ul>{briefState.generatedBrief.environment?.map(item=><li key={item.domain}>{({weather:'天气',tide:'潮汐',marine:'海况'})[item.domain]}：原来源 {item.sourceId || '当时缺失'} · 原摘要 {String(item.summary || item.missingNote || '当时资料未记录').replaceAll('unknown','当时分级未设置').replaceAll('global mean sea level','全球平均海平面')}</li>)}</ul></details>}
            {brief.careItems?.length > 0 && <section className="stage25-care-list" data-testid="stage25-care-items"><div className="stage25-section-title"><strong>关怀与安排变动</strong><button type="button" onClick={() => openTarget('mood')}>查看心情记录 →</button></div>
              {brief.careItems.map(item => <article key={`${item.sourceType}:${item.sourceId}`} data-source-id={item.sourceId}>
                <div><strong>{item.title}</strong><p>{item.message}</p><SourceDetails><small>{item.sourceLabel} · 来源 ID {item.sourceId}</small></SourceDetails></div>
                <button type="button" onClick={() => openTarget(item.targetUrl)}>查看</button>
              </article>)}
            </section>}
            {brief.missing?.length > 0 && <details className="stage25-missing"><summary>资料缺项（{brief.missing.length}）</summary><ul>{brief.missing.map(item => <li key={item}>{item}</li>)}</ul></details>}
            <div className="stage25-brief-footer"><span>入住日期 {brief.stay?.checkIn || '待核对'} · 来源均可追溯</span><button type="button" onClick={() => void load()}>刷新简报</button></div>
          </>}
    </section>
    <section className="surface stage25-notification-center" aria-label="站内提醒" data-testid="stage25-notification-center">
      <header className="stage25-card-head"><div><span className="eyebrow">INBOX · IN-APP</span><h2>站内提醒</h2></div>
        <span className="stage25-unread-count" aria-label={`未读 ${notificationState.unreadCount || 0} 条`}>{notificationState.unreadCount || 0} 未读</span></header>
      {error && <p className="stage25-error" role="alert">{error}</p>}
      {notificationState.items?.length ? <ul className="stage25-notification-list">{notificationState.items.slice(0, 8).map(item => <li key={item.id}
        className={item.readAt ? 'read' : 'unread'} data-testid={`stage25-notice-${item.id}`} data-notification-id={item.id} data-source-id={item.sourceId} data-target-type={item.targetType} data-target-id={item.targetId} data-target-url={item.targetUrl}>
        <div><strong>{businessText(item.message)}</strong><small>{notificationCategory(item).label} · {businessTime(item.createdAt)}</small><SourceDetails data={item}/></div>
        <div className="stage25-notification-actions"><button type="button" onClick={() => openTarget(item.targetUrl)}>打开</button>
          {!item.readAt && <button type="button" disabled={readingId === item.id} onClick={() => void markRead(item)}>{readingId === item.id ? '保存中…' : '标为已读'}</button>}
        </div>
      </li>)}</ul> : <p className="stage25-muted">暂无站内提醒。</p>}
      <p className="stage25-notification-note">站内提醒会保留在这里。浏览器关闭时不会继续推送。</p>
    </section>
  </div>;
}

function GuestOverview({ me, go }) {
  const profile = me.profile || {};
  return <><PageTitle eyebrow="PERSONAL SPACE" title={`你好，${me.name}`} desc="这里是你的康养主页，重要的信息都会在这里清晰呈现。"/><GuestDailyBrief me={me} go={go}/><div className="welcome-banner"><div><span className="banner-kicker">今日状态</span><h2>把今天过得松弛一点</h2><p>你的个人资料和健康信息已安全保存。需要帮助时，工作人员会在这里留下新的建议。</p></div><div className="banner-orb">海</div></div><div className="metric-grid"><Metric label="入住状态" value={admissionLabel(me.admissionStatus)} hint={profile.roomNo ? `房间 ${profile.roomNo}` : '等待机构办理入住'} tone="teal"/><button type="button" className="metric-card blue metric-button" onClick={() => go('health')}><span>健康记录</span><strong>{`${me.health?.length || 0} 条`}</strong><small>点击查看详情　→</small></button><button type="button" className="metric-card orange metric-button" onClick={() => go('advice')}><span>当前医嘱</span><strong>{`${me.advice?.length || 0} 条`}</strong><small>点击查看详情　→</small></button></div><EnvironmentPanel requestApi={request}/><GuestAgentResults/><div className="two-col"><section className="surface"><SectionHead title="我的健康概览" link="查看全部" onClick={() => go('health')}/><div className="health-glance"><div className="health-icon">⌁</div><div><strong>{me.health?.[0]?.type || '还没有健康记录'}</strong><p>{me.health?.[0] ? `${me.health[0].value} ${me.health[0].unit} · ${fmtDate(me.health[0].recordedAt)}` : '可以在“我的健康”中查看工作人员记录。'}</p></div><span className="health-status">已记录</span></div></section><section className="surface"><SectionHead title="最近的医嘱" link="查看全部" onClick={() => go('advice')}/><div className="advice-preview">{me.advice?.[0] ? <><div className="advice-priority important">重要</div><strong>{me.advice[0].title}</strong><p>{me.advice[0].content}</p><small>{me.advice[0].authorName || '工作人员'} · {fmtDate(me.advice[0].createdAt)}</small></> : <Empty text="暂无新的医嘱"/>}</div></section></div></>;
}

const HEALTH_PROFILE_FIELDS = [
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

function displayHealthField(key, value) {
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

function formalHealthSummary(profile, key) {
  const entry = profile?.health_profile?.[key];
  if (entry?.status && entry.status !== 'unanswered') {
    return entry.status === 'none' ? '已核实：无' : entry.status === 'unknown' ? '正式档案：不确定，待核实' : displayHealthField(key, entry);
  }
  const legacy = profile?.[key];
  return `正式档案：尚未回答或核实${legacy?.length ? `；旧记录供核对：${legacy.join('、')}` : ''}`;
}

function HealthIntakeHistory({ history = [] }) {
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

function GuestProfile({ me, notify, onSaved }) {
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

const HEALTH_METRIC_OPTIONS = [
  { key: 'blood_pressure', label: '血压', unit: 'mmHg' },
  { key: 'sleep', label: '睡眠时长', unit: 'h' },
  { key: 'steps', label: '步数', unit: '步' },
  { key: 'weight', label: '体重', unit: 'kg' }
];

function GuestHealth({ me }) {
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

function GuestAdvice({ me }) {
  return <><PageTitle eyebrow="MY ADVICE" title="我的医嘱" desc="工作人员给你的专业建议会在这里持续保留，执行前请仔细阅读。"/><div className="advice-list">{me.advice?.map(advice => <article className="surface advice-card" key={advice.id}><div className="advice-card-head"><div className={`advice-priority ${advice.priority}`}>{advice.priority === 'urgent' ? '紧急' : advice.priority === 'important' ? '重要' : '建议'}</div><span>{fmtDate(advice.createdAt)}</span></div><h2>{advice.title}</h2><p>{advice.content}</p><footer><span className="avatar small">{initials(advice.authorName)}</span><span>{advice.authorName || '工作人员'} 发布</span><span className="advice-active">● 生效中</span></footer></article>)}</div>{!me.advice?.length && <div className="surface empty-large"><div>✚</div><h2>暂时没有医嘱</h2><p>工作人员新增建议后，会第一时间出现在这里。</p></div>}</>;
}

function StaffView({ section, me, notify, onGuestChange, go, reviewDraftId = '', onReviewDraftOpened, operationsSource = null }) {
  useEffect(() => {
    if (section !== 'guests') onGuestChange(null);
  }, [section, onGuestChange]);
  if (!me) return <Loading/>;
  if (section === 'meal-prep' && me.jobType === 'dietitian') return <DietitianMealWorkbench notify={notify}/>;
  const canManage = Boolean(me.capabilities?.staffManagement);
  const canReview = Boolean(me.capabilities?.medicalAdvicePublish);
  const backSection = me.capabilities?.operationsSummaryView ? 'overview' : 'account';
  if (section === 'guests') return <StaffGuests notify={notify} onGuestChange={onGuestChange} canReview={canReview}/>;
  if (section === 'operations' && canManage) return <OperationsWorkbench notify={notify} me={me} initialSource={operationsSource}/>;
  if ((section === 'daily' && me.jobType === 'coach') || (section === 'therapy' && me.jobType === 'therapist')) {
    return <StaffDailySchedule jobType={me.jobType} notify={notify}/>;
  }
  if (section === 'wellness-review' && canReview) return <WellnessReviewWorkbench notify={notify} initialDraftId={reviewDraftId} onInitialDraftOpened={onReviewDraftOpened}/>;
  if (section === 'wellness-history' && (canReview || canManage)) return <WellnessHistoryWorkbench canOpenDetails={canReview} notify={notify}/>;
  if (section === 'team') return <DeanTeam notify={notify}/>;
  if (section === 'staff-admin' && canManage) return <StaffManagement me={me} notify={notify}/>;
  if (section === 'projects-admin' && canManage) return <ProjectAdmin notify={notify}/>;
  if (section === 'capabilities' && canManage) return <CapabilitiesMatrix notify={notify}/>;
  if (section === 'admissions' && canManage) return <StayManagement notify={notify}/>;
  if (section === 'assignments' && canManage) return <AssignmentManagement notify={notify}/>;
  if (section === 'rules' && canReview) return <RulesWorkbench/>;
  if (section === 'account') return <StaffAccount me={me} notify={notify}/>;
  if (section === 'overview' && !me.capabilities?.operationsSummaryView) return <UnavailableStaffPage title="运营汇总暂不可用" backSection={backSection} go={go}/>;
  if (['review', 'daily', 'therapy', 'meal-prep'].includes(section)) {
    const page = {
      review: ['医护审核台', '医护工作入口已就绪。医护建议权限只授予医护岗位。'],
      daily: ['每日安排', '教练工作入口已就绪，具体服务排程将在后续阶段接入。'],
      therapy: ['理疗工作台', '理疗师工作入口已就绪，服务排程将在后续阶段接入。'],
      'meal-prep': ['备餐单', '配餐工作入口已就绪，餐单与备餐流程将在后续阶段接入。']
    }[section];
    return <UnavailableStaffPage title={page[0]} description={page[1]} backSection="guests" go={go}/>;
  }
  if (canManage && ['staff-admin', 'projects-admin', 'capabilities', 'admissions', 'assignments'].includes(section)) return <UnavailableStaffPage title="当前账号无权打开此页面" backSection={backSection} go={go}/>;
  return <StaffOverview me={me}/>;
}

function OperationsWorkbench({ notify, me, initialSource = null }) {
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

function StaffDailySchedule({ jobType, notify }) {
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

function AdoptedDomainSuggestions({ evidence, onSelectResource }) {
  if (!evidence?.selectedSuggestions?.length) return null;
  const names = { physio:'理疗', nutrition:'营养', exercise:'运动', psychology:'心理陪伴' };
  return <section className="surface" data-testid="adopted-domain-suggestions"><SectionHead title="生成时的领域建议（原始来源）"/>
    {evidence.executionMode === 'recorded_fixture' && <p className="release-boundary">录制合成模型工具演练 · 不是真实模型输出，也不代表正式业务验收通过。</p>}<SourceDetails data={{parentRunId:evidence.parentRunId,sessionId:evidence.sessionId||evidence.adoption?.sessionId}}/>
    <p>这些是生成时的只读建议，原文保留。当前是否已激活、预约或送达，请以本页当前审核状态和实际业务记录为准；原文不随执行状态改写。</p>
    {evidence.selectedSuggestions.map(suggestion => <article key={suggestion.candidateId} data-suggestion-domain={suggestion.domain}>
      <strong>{names[suggestion.domain] || suggestion.domain} · {suggestion.title}</strong><BusinessReason value={suggestion.reason}/>
      {suggestion.domain === 'psychology' && suggestion.details?.audioUrl && onSelectResource && <button type="button" className="outline-btn" onClick={() => onSelectResource({id:suggestion.details.resourceId,title:suggestion.title,audioUrl:suggestion.details.audioUrl,durationSeconds:suggestion.details.durationSeconds,type:'guided'})}>打开陪伴资源</button>}
      <details><summary>领域来源</summary><p>候选 {suggestion.candidateId} · 专业运行 {suggestion.childRunId}</p>{suggestion.sourceIds.map((source,index) => <p key={`${source.type}:${source.id}:${index}`}>{source.label || source.type} · {source.type}:{source.id}</p>)}</details>
    </article>)}
  </section>;
}

function WellnessReviewWorkbench({ notify, initialDraftId = '', onInitialDraftOpened }) {
  const [mode, setMode] = useState('pending_review');
  const [guestId, setGuestId] = useState('');
  const [date, setDate] = useState('');
  const [risk, setRisk] = useState('');
  const [queue, setQueue] = useState({ items: [], counts: { pending: 0, complete: 0 } });
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState(null);
  const [alternatives, setAlternatives] = useState({});
  const [selectedSlots, setSelectedSlots] = useState({});
  const [revisionReason, setRevisionReason] = useState('');
  const [returnReason, setReturnReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const loadQueue = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ status: mode });
      if (guestId.trim()) params.set('guestId', guestId.trim());
      if (date) params.set('date', date);
      if (risk) params.set('risk', risk);
      const result = await request(`/staff/therapy-drafts?${params}`);
      setQueue(result);
      if (selectedId && !result.items.some(item => item.draftId === selectedId)) {
        setSelectedId(''); setDetail(null);
      }
    } catch (requestError) {
      setError(requestError.message || '疗程审核队列暂时无法加载');
      setQueue({ items: [], counts: { pending: 0, complete: 0 } });
    } finally { setLoading(false); }
  }, [mode, guestId, date, risk, selectedId]);

  useEffect(() => { loadQueue(); }, [loadQueue]);

  const openDetail = useCallback(async draftId => {
    setSelectedId(draftId); setDetail(null); setAlternatives({}); setSelectedSlots({});
    setDetailLoading(true);
    try {
      const result = await request(`/staff/therapy-drafts/${encodeURIComponent(draftId)}`);
      setDetail(result);
      const activityItems = (result.items || []).filter(item => item.type === 'activity');
      const available = await Promise.all(activityItems.map(async item => {
        try {
          const data = await request(`/staff/therapy-drafts/${encodeURIComponent(draftId)}/alternatives?itemId=${encodeURIComponent(item.id)}`);
          return [item.id, data.alternatives || []];
        } catch { return [item.id, []]; }
      }));
      setAlternatives(Object.fromEntries(available));
    } catch (requestError) {
      notify(requestError.message || '疗程证据详情暂时无法加载');
      setSelectedId('');
    } finally { setDetailLoading(false); }
  }, [notify]);

  useEffect(() => {
    if (!initialDraftId || loading || !queue.items.some(item => item.draftId === initialDraftId)) return;
    if (selectedId === initialDraftId) return;
    void openDetail(initialDraftId);
    onInitialDraftOpened?.();
  }, [initialDraftId, loading, queue.items, selectedId, openDetail, onInitialDraftOpened]);

  async function act(action) {
    if (!detail || busy) return;
    const edits = Object.entries(selectedSlots).filter(([, slotId]) => slotId)
      .map(([itemId, slotId]) => ({ itemId, slotId, reason: revisionReason.trim() }));
    if (['revise', 'correct'].includes(action) && (!edits.length || !revisionReason.trim())) {
      notify('请选择至少一个真实时段，并填写具体修订原因'); return;
    }
    if (action === 'return' && !returnReason.trim()) { notify('请填写具体退回原因'); return; }
    setBusy(action);
    try {
      const version = detail.version;
      const key = `stage22:${action}:${detail.draftId}:${version}:${crypto.randomUUID()}`;
      const options = { headers: { 'Idempotency-Key': key }, body: JSON.stringify({ version }) };
      let result;
      if (action === 'revise') result = await request(`/staff/therapy-drafts/${detail.draftId}/revisions`, {
        method: 'PUT', ...options, body: JSON.stringify({ version, edits, reason: revisionReason.trim() }) });
      if (action === 'approve') result = await request(`/staff/therapy-drafts/${detail.draftId}/approve`, { method: 'POST', ...options });
      if (action === 'return') result = await request(`/staff/therapy-drafts/${detail.draftId}/return`, {
        method: 'POST', ...options, body: JSON.stringify({ version, reason: returnReason.trim() }) });
      if (action === 'correct') result = await request(`/staff/therapy-drafts/${detail.draftId}/correction`, {
        method: 'POST', ...options, body: JSON.stringify({ version, edits, reason: revisionReason.trim() }) });
      notify(action === 'approve' ? (result?.history?.some(event => event.action === 'approved_after_revision')
        ? '修改后的疗程已通过并在同一事务中激活预约' : '疗程已通过并在同一事务中激活预约')
        : action === 'return' ? '已退回并记录原因' : action === 'correct' ? '已保存纠正版、补偿原版本预约并激活新版本' : '修订已保存为新的待审版本');
      setRevisionReason(''); setReturnReason(''); setSelectedSlots({});
      await loadQueue();
      if (result?.draftId) await openDetail(result.draftId);
      else await openDetail(detail.draftId);
    } catch (requestError) {
      notify(requestError.message || '审核操作未完成');
      await openDetail(detail.draftId);
    } finally { setBusy(''); }
  }

  const items = queue.items || [];
  const canReviewCurrent = detail?.reviewStatus === 'pending_review';
  const canCorrectCurrent = detail?.reviewStatus === 'active';

  return <div className="wellness-review-workbench">
    <PageTitle eyebrow="CLINICIAN REVIEW" title="疗程审核" desc="按真实入住日期、风险和版本核对疗程证据；通过后才会在事务内创建实际项目预约。" action={<button type="button" className="outline-btn" onClick={loadQueue} disabled={loading}>刷新队列　↻</button>}/>
    <section className="surface wellness-review-filters">
      <div className="wellness-review-tabs" role="tablist" aria-label="疗程审核状态">
        <button type="button" role="tab" aria-selected={mode === 'pending_review'} className={mode === 'pending_review' ? 'active' : ''} onClick={() => setMode('pending_review')}>待审核 <b>{queue.counts?.pending || 0}</b></button>
        <button type="button" role="tab" aria-selected={mode === 'complete'} className={mode === 'complete' ? 'active' : ''} onClick={() => setMode('complete')}>已完成 <b>{queue.counts?.complete || 0}</b></button>
      </div>
      <form className="wellness-review-filter-grid" onSubmit={event => { event.preventDefault(); loadQueue(); }}>
        <label>客人编号<input value={guestId} onChange={event => setGuestId(event.target.value)} placeholder="按客人编号筛选"/></label>
        <label>入住日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label>
        <label>风险<select value={risk} onChange={event => setRisk(event.target.value)}><option value="">全部风险</option><option value="high">强制医护审核</option><option value="sampled">抽样审核</option><option value="standard">常规</option></select></label>
        <button type="submit" className="primary-btn small-btn" disabled={loading}>筛选</button>
      </form>
    </section>
    {error && <div className="project-form-error" role="alert">{error}</div>}
    <div className="wellness-review-layout">
      <section className="surface wellness-review-queue" aria-busy={loading}>
        <div className="wellness-review-list-head"><strong>{mode === 'pending_review' ? '待审核疗程' : '已处理疗程'}</strong><span>{items.length} 条</span></div>
        {loading ? <QueryState text="正在读取授权范围内的审核记录…"/> : items.length ? items.map(item => <button type="button" key={item.draftId} data-draft-id={item.draftId} className={`wellness-review-row ${selectedId === item.draftId ? 'selected' : ''}`} onClick={() => openDetail(item.draftId)}>
          <span className="wellness-review-avatar">{initials(item.guestName)}</span><span className="wellness-review-row-copy"><strong>{item.guestName} <small>{item.roomNo || '未分配房间'}</small></strong><span>版本 {item.version} · {item.stayStart} 至 {item.stayEnd}</span><span>{businessText(item.summary) || '暂无条目摘要'}</span><small>{item.generatedAt ? new Date(item.generatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '生成时间未记录'} · {item.itemCount} 项</small></span><span className={`wellness-risk ${item.riskLevel}`}>{item.riskLevel === 'high' ? '强制复核' : item.riskLevel === 'sampled' ? '抽样' : '常规'}</span>
        </button>) : <div className="wellness-review-empty"><Empty text={mode === 'pending_review' ? '当前没有待审核疗程' : '没有符合筛选条件的已完成记录'}/></div>}
      </section>
      <section className="wellness-review-detail" data-testid="wellness-review-detail" data-draft-id={detail?.draftId || ''} aria-busy={detailLoading || Boolean(busy)}>
        {detailLoading ? <div className="surface"><QueryState text="正在读取疗程版本、证据与审核历史…"/></div> : detail ? <>
          <section className="surface wellness-review-detail-head"><div><span className="eyebrow">第 {detail.version} 版</span><h2>{detail.guestName} · {detail.stayStart} 至 {detail.stayEnd}</h2><p>第 {detail.version} 版 · 生成于 {businessTime(detail.createdAt)}</p></div><span className={`wellness-review-status ${detail.reviewStatus}`}>{detail.reviewStatus === 'pending_review' ? '待审核' : detail.reviewStatus === 'active' ? '已激活' : detail.reviewStatus === 'auto_activated' ? '自动激活' : detail.reviewStatus === 'returned' ? '已退回' : detail.reviewStatus === 'corrected' ? '已纠正' : '已替代'}</span></section>
          {detail.reviewReason && <div className="wellness-review-reason"><b>最近审核原因：</b>{detail.reviewReason}</div>}
          <SourceDetails data={detail}/><EnvironmentHistoryNote history={detail.environmentHistory}/><AdoptedDomainSuggestions evidence={detail.evidence}/>
          <section className="surface"><div className="wellness-review-section-head"><SectionHead title="逐项证据"/><span>{detail.items?.length || 0} 项</span></div>
            {(detail.items || []).map(item => <article className="wellness-evidence-item" data-item-id={item.id} key={item.id}>
              <div className="wellness-evidence-title"><div><span>{item.type === 'activity' ? '活动' : item.type === 'meal' ? '餐食建议' : item.type === 'gap' ? '资料缺口' : '休息'}</span><h3>{item.title}</h3></div><b>{item.businessDate || item.date} {item.localStart ? `${item.localStart}–${item.localEnd}` : ''}</b></div>
              {['active','auto_activated','corrected','superseded'].includes(detail.reviewStatus) && <small className="stage21-reason-era">生成时记录：当前执行以关联预约与客人日程为准</small>}
              <BusinessReason value={item.reason}/><div className="wellness-evidence-tags"><span>状态：{businessText(item.status)}</span>{item.ruleIds?.map(rule => <span key={rule}>规则 {rule}</span>)}{item.environmentSnapshotId && <SourceDetails><p>环境 {item.environmentSnapshotId}</p></SourceDetails>}</div>
              {item.evidence?.healthRisk && <p className="wellness-evidence-risk">档案健康复核：{Object.entries(item.evidence.healthRisk).filter(([, value]) => value === true).map(([key]) => businessText(key)).join('、') || '当前未标记硬风险'}；证据来自服务端保存的档案与规则评估。</p>}
              <details className="wellness-evidence-sources"><summary>来源编号、规则理由与版本依据</summary>
                {item.sourceIds?.length ? <ul>{item.sourceIds.map((source, index) => <li key={`${source.type}:${source.id}:${index}`}><b>{source.type}:{source.id}</b> · {source.label || '来源标签未记录'}</li>)}</ul> : <p>无可验证来源编号，不能补造引用。</p>}
                {item.evidence?.rules?.length ? item.evidence.rules.map((rule, index) => <p key={`${rule.ruleId}-${index}`}>{rule.ruleId} · {rule.action} · {rule.reason}</p>) : <p>此条没有保存规则命中证据。</p>}
              </details>
              {item.type === 'activity' && canReviewCurrent && <label className="wellness-slot-choice">选择可用的真实替代时段<select value={selectedSlots[item.id] || ''} onChange={event => setSelectedSlots(current => ({ ...current, [item.id]: event.target.value }))}><option value="">保留当前建议</option>{(alternatives[item.id] || []).map(option => <option value={option.slotId} key={option.slotId}>{option.date} · {option.projectName} · {option.localStart}–{option.localEnd} · {option.location} · 余 {option.remaining}</option>)}</select><small>列表仅含数据库已有且经当前规则核对可预约的时段；保存修订不会占用名额。</small></label>}
              {item.type === 'activity' && canCorrectCurrent && <label className="wellness-slot-choice">纠正为另一时段<select value={selectedSlots[item.id] || ''} onChange={event => setSelectedSlots(current => ({ ...current, [item.id]: event.target.value }))}><option value="">保持当前时段</option>{(alternatives[item.id] || []).map(option => <option value={option.slotId} key={option.slotId}>{option.date} · {option.projectName} · {option.localStart}–{option.localEnd} · {option.location} · 余 {option.remaining}</option>)}</select></label>}
            </article>)}
          </section>
          {detail.reservations?.length > 0 && <section className="surface"><SectionHead title="关联预约"/><div className="wellness-reservation-list">{detail.reservations.map(item => <div key={item.id}><strong>{item.project_name}</strong><span>{item.business_date} {item.local_start}–{item.local_end} · {businessText(item.status)}</span><SourceDetails data={item}/></div>)}</div></section>}
          {(canReviewCurrent || canCorrectCurrent) && <section className="surface wellness-review-actions"><SectionHead title={canReviewCurrent ? '审核操作' : '版本纠正'}/><label>{canReviewCurrent ? '修订或退回原因' : '纠正原因'}<textarea aria-label={canReviewCurrent ? '修订或退回原因' : '纠正原因'} rows="3" value={revisionReason} onChange={event => setRevisionReason(event.target.value)} placeholder="记录依据、变更内容和需要注意的事实"/></label>
            <div className="wellness-action-buttons">{canReviewCurrent && <><button type="button" className="outline-btn" onClick={() => act('revise')} disabled={Boolean(busy) || !Object.values(selectedSlots).some(Boolean)}>{busy === 'revise' ? '保存中…' : '保存新待审版本'}</button><button type="button" className="primary-btn" onClick={() => act('approve')} disabled={Boolean(busy)}>{busy === 'approve' ? '激活中…' : detail.approvalAction === 'approved_after_revision' ? '修改后通过并激活' : '审核通过并激活'}</button></>}{canCorrectCurrent && <button type="button" className="primary-btn" onClick={() => act('correct')} disabled={Boolean(busy) || !Object.values(selectedSlots).some(Boolean)}>{busy === 'correct' ? '纠正中…' : '保存纠正版并重新激活'}</button>}</div>
            {canReviewCurrent && detail.approvalContext && <SourceDetails><small className="wellness-approval-context">此版本由医护修订事件 {detail.approvalContext.revisionEventId} 创建；第 {detail.approvalContext.fromVersion} 版 → 第 {detail.approvalContext.toVersion} 版。修订原因：{detail.approvalContext.revisionReason}</small></SourceDetails>}
            {canReviewCurrent && <label className="wellness-return-field">退回原因<textarea aria-label="退回原因" rows="2" value={returnReason} onChange={event => setReturnReason(event.target.value)} placeholder="说明退回项目和再次生成需要排除的原因"/></label>}
            {canReviewCurrent && <button type="button" className="wellness-return-button" onClick={() => act('return')} disabled={Boolean(busy) || !returnReason.trim()}>{busy === 'return' ? '退回中…' : '退回并要求重新生成'}</button>}
          </section>}
          <section className="surface"><div className="wellness-review-section-head"><SectionHead title="不可变审核历史"/><span>{detail.history?.length || 0} 条</span></div>{detail.history?.length ? <div className="wellness-history-list">{detail.history.map(event => <article key={event.id}><span className={`wellness-history-action ${event.action}`}>{({revision:'修订',approved:'通过',approved_after_revision:'修改后通过',returned:'退回',auto_activated:'自动激活',corrected:'纠正'})[event.action] || event.action}</span><div><strong>{event.actorName} · {businessText(event.actorRole)} · {event.createdAt ? new Date(event.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '时间未记录'}</strong><p>{event.reason || '未记录原因'} · 版本 {event.fromVersion ?? '—'} → {event.toVersion ?? '—'}</p></div></article>)}</div> : <Empty text="尚无审核事件"/>}</section>
        </> : <div className="surface wellness-review-no-selection"><div>✓</div><h2>选择一条疗程审核记录</h2><p>列表显示当前授权范围内的客人、入住日期、生成时间、风险和条目摘要。</p></div>}
      </section>
    </div>
  </div>;
}

function WellnessHistoryWorkbench({ canOpenDetails, notify }) {
  const [guestId, setGuestId] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [result, setResult] = useState({ items: [], total: 0 });
  const [attention, setAttention] = useState([]);
  const [selectedDetail, setSelectedDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (guestId.trim()) params.set('guestId', guestId.trim());
      if (action) params.set('action', action);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const history = await request(`/staff/therapy-review-history?${params}`);
      setResult(history);
      try {
        const flags = await request('/staff/therapy-review-attention');
        setAttention(flags.items || []);
      } catch { setAttention([]); }
    } catch (error) {
      notify(error.message || '审核历史暂时无法加载');
      setResult({ items: [], total: 0 });
    } finally { setLoading(false); }
  }, [guestId, action, from, to, notify]);

  async function openVersion(draftId) {
    try { setSelectedDetail(await request(`/staff/therapy-drafts/${encodeURIComponent(draftId)}`)); }
    catch (error) { notify(error.message || '该版本当前不在你的授权范围内'); }
  }

  useEffect(() => { load(); }, [load]);

  return <div className="wellness-history-workbench">
    <PageTitle eyebrow="REVIEW AUDIT" title="疗程审核历史" desc="只读查询医护修订、通过、退回、自动激活和纠正记录；历史事件不会被页面编辑。" action={<button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新　↻</button>}/>
    <section className="surface wellness-history-filters"><form className="wellness-review-filter-grid" onSubmit={event => { event.preventDefault(); load(); }}>
      <label>客人编号<input value={guestId} onChange={event => setGuestId(event.target.value)} placeholder="可留空查看授权范围"/></label>
      <label>审核动作<select value={action} onChange={event => setAction(event.target.value)}><option value="">全部动作</option><option value="revision">修订</option><option value="approved">通过</option><option value="approved_after_revision">修改后通过</option><option value="returned">退回</option><option value="auto_activated">自动激活</option><option value="corrected">纠正</option></select></label>
      <label>开始日期<input type="date" value={from} onChange={event => setFrom(event.target.value)}/></label>
      <label>结束日期<input type="date" value={to} onChange={event => setTo(event.target.value)}/></label>
      <button type="submit" className="primary-btn small-btn" disabled={loading}>查询</button>
    </form></section>
    {attention.length > 0 && <section className="surface wellness-history-attention"><SectionHead title="管理员待关注事项"/><div>{attention.map(item => <article key={item.id}><b>{item.guest_name}</b><span>{item.reason}</span><small>{item.created_at ? new Date(item.created_at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : ''}</small></article>)}</div></section>}
    <section className="surface wellness-history-results"><div className="wellness-review-list-head"><strong>审核事件</strong><span>{result.total || 0} 条</span></div>{loading ? <QueryState text="正在读取不可变历史…"/> : result.items?.length ? result.items.map(item => <article className="wellness-history-row" key={item.id}>
      <span className={`wellness-history-action ${item.action}`}>{({revision:'修订',approved:'通过',approved_after_revision:'修改后通过',returned:'退回',auto_activated:'自动激活',corrected:'纠正'})[item.action] || item.action}</span>
      <div><strong>{item.guestName} · {item.actorName} · {businessText(item.actorRole)}</strong><p>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '时间未记录'} · 版本 {item.fromVersion ?? '—'} → {item.toVersion ?? '—'}</p><BusinessReason value={item.reason || '未记录原因'}/><SourceDetails><small>草案 {item.draftId} · 事件 {item.id}</small></SourceDetails></div>
      {canOpenDetails && <button type="button" className="outline-btn small-btn" onClick={() => openVersion(item.draftId)}>查看版本</button>}
    </article>) : <Empty text="没有符合条件的审核历史"/>}</section>
    {selectedDetail && <section className="surface wellness-history-version"><div className="wellness-review-section-head"><SectionHead title={`${selectedDetail.guestName} · 第 ${selectedDetail.version} 版`}/><button type="button" className="outline-btn small-btn" onClick={() => setSelectedDetail(null)}>关闭</button></div><p>父运行：{selectedDetail.evidence?.parentRunId || '无可验证来源运行'}</p>{selectedDetail.items?.map(item => <article key={item.id}><strong>{item.date} · {item.title}</strong><small className="stage21-reason-era">生成时记录</small><BusinessReason value={item.reason}/><SourceDetails><small>来源：{item.sourceIds?.map(source => `${source.type}:${source.id}`).join('、') || '未记录'}</small></SourceDetails></article>)}</section>}
  </div>;
}

function DietitianMealWorkbench({ notify }) {
  const [date, setDate] = useState(businessToday);
  const [mealType, setMealType] = useState('breakfast');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [reviewNotes, setReviewNotes] = useState({});
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const query = new URLSearchParams({ date, mealType });
      setOrders(await request(`/staff/meals/orders?${query}`));
    } catch (loadError) { setError(loadError.message || '备餐订单暂时无法加载'); }
    finally { setLoading(false); }
  }, [date, mealType]);
  useEffect(() => { load(); }, [load]);

  async function advance(order, status) {
    setBusyId(order.id);
    try {
      await request(`/staff/meals/orders/${encodeURIComponent(order.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
      notify(status === 'preparing' ? '订单已标记为备餐中' : '订单已标记为送达'); await load();
    } catch (requestError) { notify(requestError.message || '订单状态更新失败'); if (requestError.status === 409) await load(); }
    finally { setBusyId(''); }
  }

  return <><PageTitle eyebrow="DIETITIAN WORKBENCH" title="备餐订单" desc="仅显示当前有效分工客人的日期、餐次、房间、餐品和明确限制；状态按已提交 → 备餐中 → 已送达推进。" action={<button className="outline-btn" type="button" onClick={load} disabled={loading}>刷新　↻</button>}/>
    <section className="surface meal-toolbar"><label>服务日期<input type="date" value={date} onChange={event => setDate(event.target.value)}/></label><label>餐次<select value={mealType} onChange={event => setMealType(event.target.value)}>{['breakfast', 'lunch', 'dinner'].map(item => <option key={item} value={item}>{MEAL_LABELS[item]}</option>)}</select></label><span>业务日期与订单时刻均按上海时间显示</span></section>
    {loading ? <section className="surface"><QueryState text="正在加载授权范围内的订单…"/></section> : error ? <section className="surface"><QueryState error text={error} retryText="备餐订单加载失败"/><button className="outline-btn" type="button" onClick={load}>重试</button></section> : !orders.length ? <section className="surface meal-empty"><div className="meal-empty-icon">◒</div><h2>当前没有可备餐订单</h2><p>此列表只显示你当前有效分工客人的已提交订单。</p></section> : <div className="dietitian-orders">{orders.map(order => <article className="surface dietitian-order" key={order.id} data-testid={`stage26-meal-order-${order.id}`} data-order-id={order.id} data-guest-id={order.guestId} data-order-status={order.status}><header><div><span className="eyebrow">{order.businessDate} · {MEAL_LABELS[order.mealType]}</span><h2>{order.guestName} <small>房间 {order.roomNo || '未登记'}</small></h2><p>订单号 {order.orderNo} · 提交时间（上海时间）{mealLocalTime(order.createdAt)}</p><SourceDetails data={order}/><MealOrderTiming order={order}/></div><strong className={`meal-state ${order.fulfillmentStatus}`}>{order.reviewRequired ? '须复核 · 暂停推进' : ORDER_STATUS_LABELS[order.status]}</strong></header><p className="meal-source-note">{order.dishes[0]?.sourceReference || '演示菜品资料'} 供货状态不代表实时库存或履约。</p><div className="dietitian-dishes">{order.dishes.map(dish => <div key={`${dish.slot}-${dish.dishId}`}><span>{SLOT_LABELS[dish.slot]}</span><strong>{dish.name}</strong><small>明确食材：{mealFoodLabels(dish.ingredients).join('、') || '未提供'} · 明确过敏原：{mealFoodLabels(dish.allergens).join('、') || '未列出'}</small></div>)}</div><div className="dietitian-restrictions"><strong>当前明确限制及来源状态</strong>{order.explicitRestrictions?.length ? <ul>{order.explicitRestrictions.map((item, index) => <li key={`${item.source}-${item.sourceId}-${item.value}-${index}`}>{mealFoodLabels([item.value])[0]} · {mealSourceLabel(item.source)} · {mealRestrictionStatusLabel(item.status)}</li>)}</ul> : <p>无已记录的明确限制</p>}{order.reviewNotices?.map((notice, index) => <p role="status" key={`${notice.code}-${index}`}>{notice.text}</p>)}</div>{order.reviewRequired && <div className="dietitian-restrictions" role="status">{order.reviewReasons.map(reason => <p key={reason}>{reason}</p>)}<MealRestrictionReview guestId={order.guestId} notify={notify} onChanged={load}/><label>订单复核说明<textarea aria-label="订单复核说明" value={reviewNotes[order.id] || ''} maxLength={1000} onChange={event => setReviewNotes(current => ({ ...current, [order.id]: event.target.value }))}/></label><button type="button" className="outline-btn" disabled={Boolean(busyId) || !order.canReview || !reviewNotes[order.id]?.trim()} onClick={async () => { setBusyId(order.id); try { await request(`/staff/meals/orders/${order.id}/review`, { method: 'POST', body: JSON.stringify({ note: reviewNotes[order.id] }) }); notify('订单复核完成，可以继续推进'); await load(); } catch (err) { notify(err.message); await load(); } finally { setBusyId(''); } }}>确认当前订单符合限制</button></div>}{order.review && <p>最近核对：{order.review.checkedName} · {order.review.note}</p>}<footer>{order.status === 'reserved' && <button className="primary-btn" type="button" disabled={Boolean(busyId) || order.reviewRequired} onClick={() => advance(order, 'preparing')}>{busyId === order.id ? '保存中…' : '开始备餐'}</button>}{order.status === 'preparing' && <button className="primary-btn" type="button" disabled={Boolean(busyId) || order.reviewRequired} onClick={() => advance(order, 'delivered')}>{busyId === order.id ? '保存中…' : '标记已送达'}</button>}</footer></article>)}</div>}
  </>;
}

function UnavailableStaffPage({ title, description = '当前岗位没有查看此页面的权限。', backSection, go }) {
  const backLabel = backSection === 'overview' ? '返回工作概览' : backSection === 'guests' ? '返回客人列表' : '返回我的账号';
  return <><PageTitle eyebrow="WORKSPACE" title={title} desc={description}/><section className="surface stage11-placeholder"><span aria-hidden="true">⌁</span><div><h2>工作入口已准备</h2><p>{description}</p><button type="button" className="outline-btn" onClick={() => go(backSection)}>← {backLabel}</button></div></section></>;
}

function StaffManagement({ me, notify }) {
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updatingJobId, setUpdatingJobId] = useState('');
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', username: '', phone: '', password: '', jobType: 'clinician' });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await request('/dean/staff');
      setStaff(Array.isArray(data) ? data : []);
    } catch (requestError) {
      setError(requestError.message || '员工列表暂时无法加载');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

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
    if (nextStatus === 'disabled' && !window.confirm(`确认停用 ${member.name}（${member.username}）？其历史工作记录会保留。`)) return;
    try {
      await request(`/dean/staff/${member.id}`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) });
      notify(nextStatus === 'disabled' ? '员工账号已停用' : '员工账号已重新启用');
      await load();
    } catch (requestError) { notify(requestError.message || '更新员工状态失败'); }
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

  return <><PageTitle eyebrow="STAFF ACCOUNTS" title="员工账号管理" desc="创建工作人员账号、指定岗位或停用账号。停用只影响后续登录和访问，历史记录继续保留。" action={<button type="button" className="outline-btn" onClick={load} disabled={loading}>刷新列表　↻</button>}/><section className="surface org-form-card"><SectionHead title="新增员工"/><form className="org-form-grid" onSubmit={createStaff}><label>姓名<input value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} maxLength={64} required/></label><label>登录账号<input value={form.username} onChange={event => setForm({ ...form, username: event.target.value })} autoComplete="username" required/></label><label>联系电话<input type="tel" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} maxLength={32}/></label><label>初始密码<input type="password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} autoComplete="new-password" minLength={8} required/></label><label>岗位<select value={form.jobType} onChange={event => setForm({ ...form, jobType: event.target.value })}>{Object.entries(STAFF_JOB_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className="org-form-submit"><button type="submit" className="primary-btn" disabled={saving} aria-busy={saving}>{saving ? '创建中…' : '创建员工账号　→'}</button></div></form></section><section className="surface table-surface"><SectionHead title="工作人员"/><div className="org-table-wrap"><table className="org-table"><thead><tr><th>姓名与账号</th><th>岗位</th><th>身份</th><th>状态</th><th>操作</th></tr></thead><tbody>{loading ? <tr><td colSpan="5">正在加载员工…</td></tr> : error ? <tr><td colSpan="5" role="alert">{error}</td></tr> : staff.map(member => <tr key={member.id}><td><strong>{member.name}</strong><small>{member.username} · {member.phone || '未留电话'}</small></td><td><select className="org-job-select" aria-label={`${member.name}岗位`} value={member.jobType} disabled={updatingJobId === member.id || member.id === me.id} onChange={event => setStaffJobType(member, event.target.value)}>{Object.entries(STAFF_JOB_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{member.id === me.id && <small>当前管理员岗位已锁定</small>}</td><td><span className="org-role-pill">{member.role}</span></td><td><span className={`org-state ${member.status}`}>{member.status === 'active' ? '正常' : '已停用'}</span></td><td><button type="button" className={member.status === 'active' ? 'danger-btn' : 'outline-btn'} disabled={member.id === me.id && member.status === 'active'} onClick={() => setStaffStatus(member)}>{member.status === 'active' ? '停用' : '重新启用'}</button></td></tr>)}</tbody></table>{!loading && !error && !staff.length && <Empty text="还没有工作人员账号"/>}</div></section></>;
}

function CapabilitiesMatrix({ notify }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setData(await request('/dean/job-capabilities')); }
    catch (requestError) { setError(requestError.message || '岗位权限暂时无法加载'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

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

function StayManagement({ notify }) {
  const [guests, setGuests] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ roomNo: '', checkIn: localDateValue(), checkOut: localDateValue(3), stayPlan: 'three_night' });

  const load = useCallback(async (status = filter, q = search) => {
    setLoading(true);
    setError('');
    try {
      const rows = await request(`/dean/guests?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}`);
      setGuests(Array.isArray(rows) ? rows : []);
      if (selectedId && !rows.some(row => row.id === selectedId)) setSelectedId('');
    } catch (requestError) { setError(requestError.message || '客人入住列表暂时无法加载'); }
    finally { setLoading(false); }
  }, [filter, search, selectedId]);
  useEffect(() => { load(); }, [load]);

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

  async function checkout(row) {
    if (!window.confirm(`确认办理 ${row.name} 离店？`)) return;
    try {
      await request(`/dean/guests/${row.id}/stay`, { method: 'PATCH', body: JSON.stringify({ roomNo: row.roomNo, checkIn: row.checkIn, checkOut: localDateValue(), stayPlan: row.stayPlan || 'three_night' }) });
      notify(`${row.name} 已办理离店`);
      await load();
    } catch (requestError) { notify(requestError.message || '办理离店失败'); }
  }

  return <><PageTitle eyebrow="GUEST ADMISSIONS" title="入住登记与筛选" desc="登记房间、入住日期和类别，按待入住、在住或已离店状态查找客人。" action={<button type="button" className="outline-btn" onClick={() => load()} disabled={loading}>刷新　↻</button>}/><section className="surface org-form-card"><SectionHead title="入住登记"/><form className="org-form-grid" onSubmit={saveStay}><label>选择客人<select value={selectedId} onChange={event => { const row = guests.find(item => item.id === event.target.value); if (row) chooseGuest(row); else setSelectedId(''); }} required><option value="">请选择客人</option>{guests.map(row => <option key={row.id} value={row.id}>{row.name} · {row.phone || '无电话'}</option>)}</select></label><label>房间号<input value={form.roomNo} onChange={event => setForm({ ...form, roomNo: event.target.value })} maxLength={32} required/></label><label>入住日期<input type="date" value={form.checkIn} onChange={event => setForm({ ...form, checkIn: event.target.value })} required/></label><label>离店日期<input type="date" value={form.checkOut} onChange={event => setForm({ ...form, checkOut: event.target.value })} required/></label><label>入住类别<select value={form.stayPlan} onChange={event => setForm({ ...form, stayPlan: event.target.value })}><option value="three_night">3晚类别（最多登记3晚）</option><option value="ten_night">10晚类别（最多登记10晚）</option></select></label><div className="org-form-submit"><button type="submit" className="primary-btn" disabled={saving || !selectedId} aria-busy={saving}>{saving ? '保存中…' : '保存入住登记　→'}</button></div></form></section><section className="surface table-surface"><div className="admission-list-tools"><SectionHead title="客人入住状态"/><div className="admission-filters"><label>状态<select value={filter} onChange={event => { setFilter(event.target.value); }}><option value="all">全部状态</option><option value="pending">待入住</option><option value="in_house">在住</option><option value="checked_out">已离店</option></select></label><form onSubmit={event => { event.preventDefault(); load(filter, search); }}><label htmlFor="admission-search">姓名、电话或房间</label><input id="admission-search" value={search} onChange={event => setSearch(event.target.value)}/><button type="submit" className="outline-btn">搜索</button></form></div></div>{loading ? <QueryState text="正在加载客人…"/> : error ? <QueryState error text={error} retryText="请稍后重试"/> : <div className="org-table-wrap"><table className="org-table"><thead><tr><th>客人</th><th>房间</th><th>入住区间</th><th>状态</th><th>操作</th></tr></thead><tbody>{guests.map(row => <tr key={row.id} className={selectedId === row.id ? 'selected-row' : ''}><td><button type="button" className="org-row-link" onClick={() => chooseGuest(row)}>{row.name}</button><small>{row.phone || row.username}</small></td><td>{row.roomNo || '未登记'}</td><td>{row.checkIn || '—'} 至 {row.checkOut || '—'}</td><td><span className={`org-state ${row.stayStatus}`}>{admissionLabel(row.stayStatus)}</span></td><td>{row.stayStatus === 'in_house' && <button type="button" className="danger-btn" onClick={() => checkout(row)}>办理离店</button>}</td></tr>)}</tbody></table>{!guests.length && <Empty text="当前筛选下没有客人"/>}</div>}</section>{selected && <section className="surface stay-selected-summary"><strong>当前选择：{selected.name}</strong><span>档案状态：{admissionLabel(selected.stayStatus)} · 保存后客人个人资料同步显示。</span></section>}</>;
}

function AssignmentManagement({ notify }) {
  const [guests, setGuests] = useState([]);
  const [staff, setStaff] = useState([]);
  const [guestId, setGuestId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadBase = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [guestRows, staffRows] = await Promise.all([request('/dean/guests'), request('/dean/staff')]);
      setGuests(Array.isArray(guestRows) ? guestRows : []);
      setStaff(Array.isArray(staffRows) ? staffRows : []);
      setGuestId(current => current && guestRows.some(row => row.id === current) ? current : guestRows[0]?.id || '');
    } catch (requestError) { setError(requestError.message || '分工管理信息暂时无法加载'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { loadBase(); }, [loadBase]);

  const loadAssignments = useCallback(async () => {
    if (!guestId) { setAssignments([]); return; }
    try {
      const rows = await request(`/dean/guests/${guestId}/assignments`);
      setAssignments(Array.isArray(rows) ? rows : []);
    } catch (requestError) { setError(requestError.message || '负责关系暂时无法加载'); }
  }, [guestId]);
  useEffect(() => { loadAssignments(); }, [loadAssignments]);

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

function StaffOverview({ me }) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    request('/staff/overview').then((data) => {
      if (active) setOverview(data);
    }).catch((requestError) => {
      if (active) setError(requestError.message || '工作概览暂时无法加载');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const recent = Array.isArray(overview?.recent) ? overview.recent : [];
  return <><PageTitle eyebrow="STAFF WORKSPACE" title={`早上好，${me.name}`} desc="这是你的工作概览，今天也请从容地照顾好每一位客人。"/><div className="staff-banner"><div><span className="banner-kicker">今日工作台</span><h2>先看一眼需要关注的人</h2><p>进入“我负责的客人”，你可以查询档案、查看健康情况，并留下新的医嘱或建议。</p></div><div className="staff-symbol">✚</div></div>{error ? <QueryState error text={error} retryText="请刷新页面重试"/> : <><div className="metric-grid"><Metric label="负责客人" value={loading ? '…' : overview?.guests ?? 0} hint="当前授权范围内" tone="teal"/><Metric label="有效医嘱" value={loading ? '…' : overview?.activeAdvice ?? 0} hint="负责客人的有效医嘱" tone="blue"/><Metric label="近期工作记录" value={loading ? '…' : recent.length} hint="最近 8 条记录" tone="orange"/></div><section className="surface"><SectionHead title="近期工作记录"/>{loading ? <QueryState text="正在加载工作记录…"/> : recent.length ? <div className="staff-recent-list">{recent.map((entry) => <article className="staff-recent-row" key={entry.id}><span className="staff-recent-mark" aria-hidden="true">{entry.action === 'advice.create' ? '✚' : '◈'}</span><div><strong>{staffActionLabel(entry.action)}</strong><p>{entry.detail || '已记录一项工作操作'}</p></div><time dateTime={entry.createdAt}>{fmtDateTime(entry.createdAt)}</time></article>)}</div> : <Empty text="还没有近期工作记录"/>}</section></>}<AgentPanel role="staff"/><section className="surface"><SectionHead title="工作原则"/><div className="principle-grid"><Principle icon="◈" title="信息最小化" text="只查看完成工作所必需的客人信息。"/><Principle icon="⌁" title="建议可追溯" text="每条医嘱都保留作者、时间和状态。"/><Principle icon="♧" title="先沟通再行动" text="涉及健康风险时，及时联系客人与医护团队。"/></div></section></>;
}

function staffActionLabel(action) {
  return ({
    'guest.view': '查看客人档案',
    'advice.create': '发布医嘱与建议',
    'profile.update': '更新客人资料',
    'service.execution.record': '记录服务执行',
    'password.change': '修改登录密码',
    login: '登录系统'
  })[action] || action || '工作操作';
}

function agentStateLabel(state) {
  return ({ not_run: '尚未运行', queued: '等待执行', running: '正在执行', completed: '已完成', partial_failure: '部分任务未完成', failed: '执行失败', interrupted: '执行已中断' })[state] || state;
}

function GuestAgentResults() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const load = useCallback(async () => {
    try { setStatus(await request('/agent/status')); setError(''); }
    catch (error) { setError(error.message || '暂时无法读取协作记录'); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const run = status?.run;
  return <section className="surface" data-testid="guest-agent-results"><SectionHead title="管家协作" link="刷新协作" onClick={load}/>
    {error ? <p role="alert">{error}</p> : !status ? <p>正在读取协作记录…</p> : <>
      <p>{agentStateLabel(status.state)}</p>
      {run ? <><small>{fmtDateTime(run.createdAt)}</small><BusinessReason value={businessText(run.reply || '任务尚未返回答复。')}/>
        <button type="button" className="outline-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起原运行详情' : '打开原运行详情'}</button>
        {open && <div data-run-id={run.runId}><SourceDetails><p>会话 {run.sessionId}</p></SourceDetails><div className="assistant-sources"><strong>查询来源</strong>{run.sources.map(source => <article key={`${source.type}:${source.id}`}><span>{source.label}</span><SourceDetails><small>{source.id}</small></SourceDetails></article>)}</div>
          {run.collaboration && <AssistantCollaborationTrace collaboration={run.collaboration}/>}
          {run.steps.map(step => <p key={step.stepIndex}>{step.summary} · {step.status}</p>)}</div>}</> : <p>当前授权范围内没有协作记录。可使用右下角助手整理建议。</p>}
    </>}
  </section>;
}

function AgentPanel({ role }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let active = true;
    request('/agent/status').then((data) => { if (active) setStatus(data); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return <section className="surface agent-panel"><div className="agent-panel-head"><div><div className="eyebrow">AGENT ORCHESTRATION</div><h2><span className="agent-pulse"/>康养智能协作台</h2><p>{role === 'guest' ? '你的今日信息由康养管家协调多个专业 Agent 整理。' : '系统以康养管家为调度 Agent，辅助团队完成信息整理与建议生成。'}</p></div><div className="agent-mode">{status?.mode || '可解释规则协作模式'}<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起' : '展开'}　⌃</button></div></div>{open && <><p>实际运行：{agentStateLabel(status?.state || 'not_run')} · 服务健康：{({unknown:'尚未验证',unconfigured:'未配置',last_request_succeeded:'最近请求成功',last_request_failed:'最近请求失败'})[status?.serviceHealth?.state] || '尚未验证'}</p><div className="agent-flow"><div className="flow-node orchestrator"><span>⌘</span><strong>康养管家</strong><small>调度与汇总</small></div><div className="flow-line"/><div className="flow-agents">{(status?.agents || []).slice(1).map((agent, index) => <div className="flow-node" key={agent.agent}><span>{['◒', '✣', '♧', '◌'][index]}</span><strong>{agent.agent}</strong><small>{agent.action}</small></div>)}</div></div><div className="agent-events">{(status?.agents || []).map((agent) => <div key={agent.agent}><span className={`event-state ${agent.state}`}>{agent.state === 'done' ? '✓' : '·'}</span><div><strong>{agent.agent} · {agent.action}</strong><p>{agent.detail}</p></div></div>)}</div><div className="agent-gate">⌁ 人工确认边界：{status?.humanGate || '健康风险建议由工作人员最终确认'}</div></>}</section>;
}

function StaffCareFollowUpTasks({ guests, onChooseGuest }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setError('');
    try { const result = await request('/staff/care-follow-up-tasks'); setItems(result.items || []); }
    catch (loadError) { setError(loadError.message || '关怀待办暂时无法加载'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const guestIds = new Set(guests.map(guest => guest.id));
  return <section className="surface stage25-staff-care" aria-label="关怀跟进待办" data-testid="stage25-staff-care-tasks">
    <header><div><span className="eyebrow">CARE FOLLOW-UP</span><h2>关怀跟进待办</h2></div><button type="button" className="outline-btn" onClick={() => void load()} disabled={loading}>刷新</button></header>
    {loading ? <p role="status">正在读取当前负责范围内的待办…</p> : error ? <p role="alert">{error}</p> : items.length ? <ul>{items.map(item => <li key={item.id} data-source-id={item.sourceId} data-guest-id={item.guestId}>
      <div><strong>{item.title}</strong><p>{item.guestName} · {item.detail}</p><SourceDetails><small>{item.sourceType} · 来源 {item.sourceId} · {item.createdAt ? mealLocalTime(item.createdAt) : ''}</small></SourceDetails></div>
      <button type="button" disabled={!guestIds.has(item.guestId)} onClick={() => onChooseGuest(guests.find(guest => guest.id === item.guestId))}>{guestIds.has(item.guestId) ? '打开客人档案' : '超出当前搜索结果'}</button>
    </li>)}</ul> : <p>当前负责范围内没有待跟进事项。</p>}
  </section>;
}

function StaffGuests({ notify, onGuestChange, canReview }) {
  const [guests, setGuests] = useState([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [selectionLoading, setSelectionLoading] = useState(false);
  const loadController = useRef(null);
  const selectionController = useRef(null);
  const selectionSequence = useRef(0);
  const selectedId = useRef('');

  const loadGuests = useCallback(async (search = '') => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setListError('');
    try {
      const data = await request(`/staff/guests?q=${encodeURIComponent(search)}`, { signal: controller.signal });
      if (!controller.signal.aborted) {
        const nextGuests = normalizeGuestList(data);
        setGuests(nextGuests);
        if (selectedId.current && !nextGuests.some(guest => guest.id === selectedId.current)) {
          selectionController.current?.abort();
          selectionSequence.current += 1;
          selectedId.current = '';
          setSelected(null);
          setSelectionLoading(false);
          onGuestChange(null);
        }
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
      setGuests([]);
      setListError(error.message || '客人列表暂时无法加载');
      notify(error.message || '客人列表暂时无法加载');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [notify, onGuestChange]);

  useEffect(() => {
    onGuestChange(null);
    loadGuests();
    return () => {
      loadController.current?.abort();
      selectionController.current?.abort();
      selectionSequence.current += 1;
      selectedId.current = '';
      onGuestChange(null);
    };
  }, [loadGuests, onGuestChange]);

  async function search(event) {
    event?.preventDefault();
    await loadGuests(query.trim());
  }

  async function choose(guest) {
    selectionController.current?.abort();
    const controller = new AbortController();
    selectionController.current = controller;
    const sequence = ++selectionSequence.current;
    selectedId.current = guest.id;
    setSelected(null);
    setSelectionLoading(true);
    onGuestChange(guest.id);
    try {
      const data = await request(`/staff/guests/${guest.id}`, { signal: controller.signal });
      if (!controller.signal.aborted && sequence === selectionSequence.current) setSelected(normalizeGuestSummary(data));
    } catch (error) {
      if (error?.name === 'AbortError') return;
      if (sequence === selectionSequence.current) {
        selectedId.current = '';
        onGuestChange(null);
        notify(error.message || '客人详情暂时无法加载');
      }
    } finally {
      if (!controller.signal.aborted && sequence === selectionSequence.current) setSelectionLoading(false);
    }
  }

  async function refreshSelected(guestId) {
    if (!guestId || guestId !== selectedId.current) return;
    try {
      const data = await request(`/staff/guests/${guestId}`);
      if (guestId === selectedId.current) setSelected(normalizeGuestSummary(data));
    } catch (error) {
      if (guestId === selectedId.current) notify(error.message || '客人详情暂时无法刷新');
    }
  }

  return <><PageTitle eyebrow="MY GUESTS" title="我负责的客人" desc="在这里查看客人的基础资料与健康情况，并提供专业建议。" action={<button type="button" className="outline-btn" onClick={() => search()} disabled={loading} aria-busy={loading}>刷新列表　↻</button>}/><StaffCareFollowUpTasks guests={guests} onChooseGuest={choose}/><form className="search-bar" onSubmit={search}><label className="sr-only" htmlFor="guest-search">搜索客人姓名或房间号</label><span aria-hidden="true">⌕</span><input id="guest-search" placeholder="搜索客人姓名或房间号" value={query} onChange={(event) => setQuery(event.target.value)}/><button type="submit" disabled={loading} aria-busy={loading}>搜索</button></form><div className="guest-layout"><section className="surface guest-list"><div className="list-heading"><strong>客人列表</strong><span>{guests.length} 位授权客人</span></div>{loading ? <QueryState text="正在加载客人列表…"/> : listError ? <QueryState error text={listError} retryText="请稍后重试" onRetry={() => loadGuests(query.trim())} retryLabel="重试加载"/> : guests.length ? guests.map((guest) => <button type="button" className={`guest-row ${selectedId.current === guest.id ? 'selected' : ''}`} key={guest.id} onClick={() => choose(guest)}><span className="avatar">{initials(guest.name)}</span><span className="guest-main"><strong>{guest.name}</strong><small>{guest.roomNo || '未分配房间'} · {guest.phone}</small></span><span className="guest-flag">{guest.chronicStatus === 'reported' ? '需关注' : guest.chronicStatus === 'none' ? '已核实无慢病' : '待补充或核实'}</span><b aria-hidden="true">→</b></button>) : <div className="list-empty"><Empty text="暂无结果"/></div>}</section><section className="guest-detail">{selectionLoading ? <div className="surface detail-empty"><div className="empty-illustration">⌁</div><h2>正在打开客人档案</h2><p>正在读取当前授权范围内的信息。</p></div> : selected ? <StaffGuestDetail key={selected.id} guest={selected} notify={notify} onRefresh={refreshSelected} canReview={canReview}/> : <div className="surface detail-empty"><div className="empty-illustration">♧</div><h2>选择一位客人</h2><p>左侧选择客人后，这里会显示完整的工作所需信息。</p></div>}</section></div></>;
}

function ClinicianHealthReview({ guestId, notify, onGuestRefresh }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState(null);
  const [reasons, setReasons] = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await request(`/staff/guests/${guestId}/health-intakes`));
    } catch (error) {
      notify(error.message || '健康自述审核记录暂时无法加载');
    } finally {
      setLoading(false);
    }
  }, [guestId, notify]);

  useEffect(() => { load(); }, [load]);

  async function review(item, action) {
    if (actionId) return;
    setActionId(item.id);
    try {
      const body = action === 'confirm'
        ? { baseProfileVersion: item.baseProfileVersion }
        : { reason: reasons[item.id] || '' };
      const result = await request(`/staff/health-intakes/${item.id}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      setData(current => current ? { ...current, verifiedProfile: result.verifiedProfile, profileVersion: result.profileVersion,
        history: result.history, pendingIntakes: result.pendingIntakes, effectiveHealthConstraints: result.effectiveHealthConstraints } : current);
      notify(action === 'confirm' ? '健康自述已核实并写入正式档案' : '已驳回该自述，正式档案保持不变');
      await onGuestRefresh(guestId);
    } catch (error) {
      notify(error.message || (action === 'confirm' ? '核实失败，请重新比对' : '驳回失败'));
      await load();
    } finally {
      setActionId(null);
    }
  }

  const pending = data?.pendingIntakes || [];
  return <section className="surface clinician-health-review" aria-busy={loading || Boolean(actionId)}>
    <div className="clinician-review-head"><div><SectionHead title="健康自述核实"/><p>仅负责医护可处理采集。确认后会更新正式档案版本；驳回会保留原文与原因。</p></div><button type="button" className="outline-btn small-btn" onClick={load} disabled={loading}>刷新队列　↻</button></div>
    {loading ? <QueryState text="正在读取待核实采集…"/> : <>
      <div className="clinician-review-current"><strong>正式档案版本 {data?.profileVersion ?? 0}</strong>{HEALTH_PROFILE_FIELDS.filter(field => data?.verifiedProfile?.[field.key]?.status !== 'unanswered').map(field => <span key={field.key}>{field.label}：{displayHealthField(field.key, data.verifiedProfile[field.key])}</span>)}</div>
      {pending.length ? <div className="clinician-review-queue">{pending.map(item => <article className="clinician-review-item" key={item.id}>
        <div className="clinician-review-item-head"><div><span className="health-intake-status pending">待核实</span><strong>第 {item.revision || '旧记录'} 版 · {item.source === 'form' ? '客人表单' : item.source === 'assistant' ? '助手对话' : item.source}</strong></div><time>{item.submittedAt ? new Date(item.submittedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}) : '—'}</time></div>
        <div className="clinician-review-submitter">提交人：{item.submitterName || '客人'} · 基于正式版本 {item.baseProfileVersion}</div>
        {item.candidate ? <>
          <div className="clinician-candidate-grid">{HEALTH_PROFILE_FIELDS.filter(field => item.candidate[field.key]?.status !== 'unanswered').map(field => <div key={field.key}><span>{field.label}</span><strong>{displayHealthField(field.key, item.candidate[field.key])}</strong></div>)}</div>
          <details className="clinician-compare"><summary>查看修改前后对照与来源</summary><HealthIntakeHistory history={[item]}/></details>
          <div className="clinician-review-actions"><button type="button" className="primary-btn small-btn" disabled={actionId === item.id} onClick={() => review(item, 'confirm')}>{actionId === item.id ? '处理中…' : '确认并更新正式档案'}</button><label>驳回原因<textarea rows="2" value={reasons[item.id] || ''} onChange={event => setReasons(current => ({ ...current, [item.id]: event.target.value }))} placeholder="填写核实后发现的问题或请客人补充的内容"/></label><button type="button" className="outline-btn small-btn" disabled={actionId === item.id || !reasons[item.id]?.trim()} onClick={() => review(item, 'reject')}>驳回并保留原文</button></div>
        </> : <div className="clinician-legacy-intake"><strong>历史文本采集</strong><p>{item.content || '无原始文本'}</p><small>该记录保持待核实；需要先以结构化字段补充后才能合并正式档案。</small></div>}
      </article>)}</div> : <div className="clinician-empty-queue"><Empty text="当前没有待核实采集"/></div>}
      <div className="form-section-title with-top"><span>档案变更历史</span><small>只读</small></div><HealthIntakeHistory history={data?.history || []}/>
    </>}
  </section>;
}

function StaffGuestDetail({ guest, notify, onRefresh, canReview }) {
  const profile = guest.profile || {};
  const [showAdvice, setShowAdvice] = useState(false);
  const [form, setForm] = useState({ title: '', content: '', priority: 'normal' });
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    const title = form.title.trim();
    const content = form.content.trim();
    if (!title || !content) {
      notify('请填写建议标题和内容');
      return;
    }
    setSubmitting(true);
    try {
      await request(`/staff/guests/${guest.id}/advice`, { method: 'POST', body: JSON.stringify({ ...form, title, content }) });
      setForm({ title: '', content: '', priority: 'normal' });
      setShowAdvice(false);
      notify('医嘱已发布，客人可以查看');
      await onRefresh(guest.id);
    } catch (error) {
      notify(error.message || '发布建议失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="detail-stack"><section className="surface profile-hero"><div className="avatar large">{initials(guest.name)}</div><div><div className="eyebrow">GUEST PROFILE</div><h2>{guest.name}</h2><p>{profile.gender || '—'}　{profile.birthDate || profile.birth_date || '—'}　房间 {profile.roomNo || profile.room_no || '—'}</p></div><span className="profile-status">{admissionLabel(guest.admissionStatus)}</span></section><section className="surface"><SectionHead title="基础信息"/><div className="detail-grid"><Info label="联系电话" value={guest.phone}/><Info label="入住时间" value={`${profile.checkIn || profile.check_in || '—'} 至 ${profile.checkOut || profile.check_out || '—'}`}/><Info label="紧急联系人" value={profile.emergencyContact || profile.emergency_contact || '—'}/><Info label="行动能力" value={profile.mobility || '—'}/></div></section><section className="surface"><SectionHead title="健康情况"/><div className="health-alert"><span>⌁</span><div><strong>慢病史</strong><p>{formalHealthSummary(profile, 'chronic')}</p></div></div><div className="health-alert"><span>◇</span><div><strong>过敏源</strong><p>{formalHealthSummary(profile, 'allergies')}</p></div></div>{profile.health_profile && <div className="health-verified-grid staff-verified-grid">{HEALTH_PROFILE_FIELDS.map(field => <div key={field.key}><span>{field.label} · 正式档案</span><strong>{displayHealthField(field.key, profile.health_profile[field.key])}</strong></div>)}</div>}<div className="latest-records"><strong>近期记录</strong>{guest.health?.length ? guest.health.slice(0, 3).map((health) => <div key={health.id}><span>{health.type}</span><b>{health.value} {health.unit}</b><small>{fmtDate(health.recordedAt)}</small></div>) : <Empty text="暂无近期健康记录"/>}</div></section><MealRestrictionReview guestId={guest.id} canResolve={canReview} notify={notify} onChanged={() => onRefresh(guest.id)}/>{canReview ? <ClinicianHealthReview guestId={guest.id} notify={notify} onGuestRefresh={onRefresh}/> : <section className="surface"><SectionHead title="健康自述核实"/><p className="read-only-review-note">当前岗位可查看正式健康档案。采集核实仅开放给负责医护。</p></section>}<section className="surface"><SectionHead title="医嘱与建议" action={canReview ? <button type="button" className="primary-btn small-btn" onClick={() => setShowAdvice(!showAdvice)} aria-expanded={showAdvice}>＋ 新增建议</button> : null}/>{canReview && showAdvice && <form className="advice-form" onSubmit={submit} noValidate aria-busy={submitting}><Field label="标题" value={form.title} onChange={(value) => setForm({ ...form, title: value })} placeholder="例如：本周运动安排" required/><label htmlFor={`priority-${guest.id}`}>重要程度<select id={`priority-${guest.id}`} value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option value="normal">一般建议</option><option value="important">重要提醒</option><option value="urgent">紧急提醒</option></select></label><label htmlFor={`advice-content-${guest.id}`}>建议内容<textarea id={`advice-content-${guest.id}`} rows="4" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="请输入清晰、可执行的建议" required/></label><div className="form-actions"><button type="button" className="outline-btn" onClick={() => setShowAdvice(false)} disabled={submitting}>取消</button><button type="submit" className="primary-btn" disabled={submitting} aria-busy={submitting}>{submitting ? '发布中…' : '发布建议　→'}</button></div></form>}{guest.advice?.map((advice) => <div className="staff-advice-row" key={advice.id}><div className={`advice-priority ${advice.priority}`}>{advice.priority === 'urgent' ? '紧急' : advice.priority === 'important' ? '重要' : '建议'}</div><div><strong>{advice.title}</strong><p>{advice.content}</p><small>{advice.authorName || '工作人员'} · {fmtDate(advice.createdAt)}</small></div></div>)}{!guest.advice?.length && <Empty text="还没有发布过医嘱"/>}</section></div>;
}

function StaffAccount({ me, notify }) {
  return <><PageTitle eyebrow="MY ACCOUNT" title="我的账号" desc="维护你的工作人员账号信息与登录安全。"/><section className="surface account-card"><div className="account-avatar"><div className="avatar large">{initials(me.name)}</div><div><h2>{me.name}</h2><p>工作人员　·　账号 {me.username}</p></div></div><div className="account-line"><span>联系电话</span><strong>{me.phone || '未填写'}</strong></div><div className="account-line"><span>账号状态</span><strong className="green-text">正常</strong></div></section><PasswordPanel notify={notify}/></>;
}

function DeanTeam({ notify }) {
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

function AssistantWidget({ role = 'public', user = null, guestId = '', onAuthExpired, onSelectResource, onNavigate,
  onOpenReviewSource, onOpenOperationsSource }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState('');
  const [historyCursor, setHistoryCursor] = useState(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [confirmingActionId, setConfirmingActionId] = useState('');
  const [assistantNotices, setAssistantNotices] = useState([]);
  const [browserReminderStatus, setBrowserReminderStatus] = useState('');
  const [adviceDraft, setAdviceDraft] = useState(null);
  const [adviceSaving, setAdviceSaving] = useState(false);
  const [advicePublishNotice, setAdvicePublishNotice] = useState('');
  const controllerRef = useRef(null);
  const generationRef = useRef(0);
  const identityKey = `${role}:${user?.id || 'public'}:${['staff', 'dean'].includes(role) ? guestId || 'none' : 'none'}`;
  const identityRef = useRef(identityKey);
  const storageKey = `assistant-session:${identityKey}`;

  useEffect(() => {
    let active = true;
    request('/assistant/status').then((data) => { if (active) setStatus(data); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (role !== 'guest') { setAssistantNotices([]); return undefined; }
    let active = true;
    const refreshNotices = () => request('/me/wellness-notifications').then(data => {
      if (active) setAssistantNotices(Array.isArray(data.items) ? data.items : []);
    }).catch(() => {});
    void refreshNotices();
    window.addEventListener(WELLNESS_NOTIFICATION_EVENT, refreshNotices);
    return () => { active = false; window.removeEventListener(WELLNESS_NOTIFICATION_EVENT, refreshNotices); };
  }, [role, identityKey]);

  useEffect(() => {
    identityRef.current = identityKey;
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setText('');
    setMessages([]);
    setSessionId('');
    setAdviceDraft(null);
    setSending(false);
    setProgress('');
    setHistoryCursor(null);
    setHistoryHasMore(false);
    setOpen(false);
    setAdvicePublishNotice('');
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
    if (saved?.sessionId) {
      setSessionId(saved.sessionId);
      const generation = generationRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      const params = new URLSearchParams({ sessionId: saved.sessionId, role, limit: '30' });
      const historyRequest = request(`/assistant/history?${params.toString()}`, { signal: controller.signal })
        .then((data) => {
          if (generation !== generationRef.current || identityRef.current !== identityKey) return;
          setMessages(data.messages || []);
          setHistoryCursor(data.nextBeforeId || null);
          setHistoryHasMore(Boolean(data.hasMore));
          return data.messages || [];
        })
        .catch(() => [])
        .finally(() => { if (controllerRef.current === controller) controllerRef.current = null; });
      if (saved.runId) {
        setSending(true);
        setProgress('正在恢复上次查询…');
        void historyRequest.then(messages => pollRun(saved.runId, controller, generation, messages, saved.reply))
          .catch(() => {}).finally(() => {
          if (generation === generationRef.current && identityRef.current === identityKey) {
            setSending(false);
            setProgress('');
          }
        });
      }
    }
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [identityKey, role, storageKey]);

  useEffect(() => {
    if (open && !messages.length) setMessages([{ role: 'assistant', content: assistantWelcome(role),
      clientMessageId: `welcome:${identityKey}` }]);
  }, [open, role, identityKey, messages.length]);

  function clearConversation() {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setMessages([]);
    setSessionId('');
    setText('');
    setSending(false);
    setProgress('');
    setHistoryCursor(null);
    setHistoryHasMore(false);
    setAdviceDraft(null);
    setAdvicePublishNotice('');
    sessionStorage.removeItem(storageKey);
  }

  function upsertRunMessage(run, mergeLatestHistory = false) {
    const message = {
      role: 'assistant', content: run.reply || '助手暂时没有返回内容。', runId: run.runId,
      mode: assistantExecutionModeLabel(run.executionMode || (run.live ? 'live' : 'safe_guidance')), sources: run.sources || [],
      clarificationState: run.clarificationState || null,
      collaboration: run.collaboration || null,
      actionCards: run.actionCards || [],
      retryable: Boolean(run.retryable), error: run.status === 'failed'
    };
    setMessages((previous) => {
      const runMatches = previous.map((item, index) => item.runId === run.runId ? index : -1).filter(index => index >= 0);
      const exactReplyMatches = runMatches.filter(index => previous[index].role === 'assistant'
        && previous[index].content === message.content);
      let match = exactReplyMatches.at(-1) ?? runMatches.at(-1) ?? -1;
      if (match < 0 && mergeLatestHistory) {
        const exactHistoryMatches = previous.map((item, index) => item.role === 'assistant'
          && !item.runId && item.content === message.content ? index : -1).filter(index => index >= 0);
        if (exactHistoryMatches.length === 1) match = exactHistoryMatches[0];
      }
      if (match < 0) return [...previous, message];
      const next = [...previous];
      next[match] = { ...next[match], ...message };
      return next;
    });
  }

  function updateActionCard(actionCard) {
    setMessages(previous => previous.map(message => ({
      ...message,
      actionCards: (message.actionCards || []).map(card => card.id === actionCard.id ? actionCard : card)
    })));
  }

  async function confirmActionCard(card) {
    if (!sessionId || confirmingActionId) return;
    setConfirmingActionId(card.id);
    try {
      const response = await request(`/assistant/actions/${encodeURIComponent(card.id)}/confirm`, {
        method: 'POST', body: JSON.stringify({ sessionId, version: card.version }),
        headers: { 'Idempotency-Key': `assistant-action:${card.id}:v${card.version}` },
        onUnauthorized: onAuthExpired
      });
      if (response.actionCard) updateActionCard(response.actionCard);
    } catch (error) {
      setProgress(error.message || '确认请求暂时无法完成');
    } finally { setConfirmingActionId(''); }
  }

  async function adoptCollaboration(collaboration) {
    const parentRunId = collaboration?.parent?.runId;
    const selectedCandidateIds = Array.isArray(collaboration?.finalAdoptedCandidateIds)
      ? collaboration.finalAdoptedCandidateIds : collaboration?.selectedCandidateIds;
    if (!sessionId || !parentRunId || !Array.isArray(selectedCandidateIds) || !selectedCandidateIds.length) return;
    const encoded = new TextEncoder().encode([...selectedCandidateIds].sort().join('\n'));
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    const suffix = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('').slice(0,48);
    const key = `adopt:${parentRunId}:${suffix}`;
    setAdviceSaving(true);
    setAdvicePublishNotice('正在保存已选方案…');
    try {
      const result = await request('/me/therapy-drafts', {
        method: 'POST', body: JSON.stringify({ action: 'adopt_candidate', sourceRunId: parentRunId,
          sessionId, selectedCandidateIds, candidateId: selectedCandidateIds[0] }),
        headers: { 'Idempotency-Key': key }, onUnauthorized: onAuthExpired
      });
      setAdviceDraft(result);
      setAdvicePublishNotice(`已保存疗程草案 ${result.draftId} · 版本 ${result.version}，来源运行 ${result.sourceRunId || parentRunId}；仍需医护审核。`);
      window.dispatchEvent(new CustomEvent(WELLNESS_NOTIFICATION_EVENT));
    } catch (error) {
      setAdvicePublishNotice(error.message || '方案保存失败，请稍后重试');
    } finally { setAdviceSaving(false); }
  }

  function navigateForAction(card) {
    const page = card.impact?.page || card.result?.page;
    const section = ({ schedule: 'schedule', reservations: 'reservations', projects: 'projects',
      meals: 'meals', health: 'health', wellness: 'schedule' })[page];
    if (section) onNavigate?.(section);
  }

  async function pollRun(runId, controller, generation, historyMessages = [], savedReply = null) {
    const startedAt = Date.now();
    for (;;) {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      // G21：服务端状态卡在 running 时不再无限轮询，120 秒后转入可读的失败提示。
      if (Date.now() - startedAt > 120_000) throw new Error('处理时间过长，已停止自动刷新；结果可稍后在历史记录中查看。');
      const data = await request(`/assistant/runs/${encodeURIComponent(runId)}?role=${encodeURIComponent(role)}`, { signal: controller.signal });
      if (generation !== generationRef.current || identityRef.current !== identityKey) return data;
      const steps = data.steps || [];
      const lastStep = [...steps].reverse().find(step => step.status === 'running') || [...steps].reverse()[0];
      if (data.status === 'queued' || data.status === 'running') {
        setProgress(Date.now() - startedAt >= 20_000
          ? '仍在处理，刷新页面后也可继续查看进度…'
          : (lastStep?.summary || '正在整理你的信息…'));
      } else {
        const lastHistoryMessage = historyMessages.at(-1);
        const replyAlreadyPersisted = Boolean(savedReply && savedReply === data.reply && lastHistoryMessage?.role === 'assistant' &&
          lastHistoryMessage.content === data.reply);
        upsertRunMessage(data, replyAlreadyPersisted);
        setProgress('');
        try { sessionStorage.setItem(storageKey, JSON.stringify({ sessionId: data.sessionId, runId: data.runId, reply: data.reply })); } catch { /* storage can be unavailable */ }
        return data;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
  }

  async function loadEarlierHistory() {
    if (!sessionId || !historyCursor || !historyHasMore || sending) return;
    try {
      const params = new URLSearchParams({ sessionId, role, beforeId: String(historyCursor), limit: '30' });
      if (['staff', 'dean'].includes(role) && guestId) params.set('guestId', guestId);
      const data = await request(`/assistant/history?${params.toString()}`);
      setMessages(previous => [...(data.messages || []), ...previous]);
      setHistoryCursor(data.nextBeforeId || null);
      setHistoryHasMore(Boolean(data.hasMore));
    } catch { /* keep the current page visible when history is unavailable */ }
  }

  async function retryRun(runId) {
    if (sending) return;
    const controller = new AbortController();
    const generation = generationRef.current;
    controllerRef.current = controller;
    setSending(true);
    setProgress('正在重试上次查询…');
    try {
      await request(`/assistant/runs/${encodeURIComponent(runId)}/retry`, {
        method: 'POST', body: JSON.stringify({ role }), signal: controller.signal
      });
      await pollRun(runId, controller, generation);
    } catch (error) {
      if (error?.name !== 'AbortError') setProgress(error.message || '重试暂时不可用');
    } finally {
      if (generation === generationRef.current) {
        controllerRef.current = null;
        setSending(false);
      }
    }
  }

  async function send(value = text) {
    const content = String(value || '').trim();
    if (!content || sending) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const body = { role, text: content, async: true, clientRequestId: crypto.randomUUID() };
    if (sessionId) body.sessionId = sessionId;
    if (['staff', 'dean'].includes(role) && guestId) body.guestId = guestId;
    setText('');
    setAdviceDraft(null);
    setMessages((previous) => [...previous, { role: 'user', content, clientMessageId: crypto.randomUUID() }]);
    setSending(true);
    setProgress('已提交，正在排队…');
    try {
      const data = await request('/assistant/chat', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (generation !== generationRef.current || identityRef.current !== identityKey) return;
      setSessionId(data.sessionId || '');
      try { sessionStorage.setItem(storageKey, JSON.stringify({ sessionId: data.sessionId, runId: data.runId })); } catch { /* ignore unavailable storage */ }
      await pollRun(data.runId, controller, generation);
    } catch (error) {
      if (error?.name === 'AbortError' || generation !== generationRef.current || identityRef.current !== identityKey) return;
      if (error.status === 401 && role !== 'public') {
        onAuthExpired?.();
        return;
      }
      const sessionError = [403, 404, 409].includes(error.status);
      setMessages((previous) => [...previous, {
        role: 'assistant',
        content: sessionError ? `当前助手会话无法继续：${error.message || '会话状态已变化'}。为保护隐私，刚才的内容没有自动重发，请点击“重新开始”后再输入。` : (error.message || '助手暂时无法回复，请稍后再试。'),
        clientMessageId: crypto.randomUUID(),
        error: true,
        restart: sessionError
      }]);
    } finally {
      if (generation === generationRef.current && identityRef.current === identityKey) {
        controllerRef.current = null;
        setSending(false);
        setProgress('');
      }
    }
  }

  async function publishAssistantAdvice(event) {
    event.preventDefault();
    if (!adviceDraft || !guestId || adviceSaving) return;
    setAdviceSaving(true);
    try {
      const result = await request(`/staff/guests/${encodeURIComponent(guestId)}/advice`, { method: 'POST',
        body: JSON.stringify({ title: adviceDraft.title, content: adviceDraft.content, priority: adviceDraft.priority }) });
      setAdviceDraft(null);
      setAdvicePublishNotice(`已由医护人员确认发布，医嘱编号 ${result.id}`);
      setProgress('');
    } catch (error) { setAdvicePublishNotice(error.message || '发布失败，请检查医嘱草稿'); }
    finally { setAdviceSaving(false); }
  }

  const currentAssistantNotice = role === 'guest' ? assistantNotices[0] : null;

  async function markAssistantNoticeRead(item) {
    if (!item || item.readAt) return;
    try {
      await request(`/me/wellness-notifications/${encodeURIComponent(item.id)}/read`, { method: 'PATCH', body: '{}' });
      publishWellnessNotificationUpdate();
    } catch { /* the notification center remains the source of truth */ }
  }

  function openAssistantNotice(item) {
    const section = wellnessTargetSection(item?.targetUrl);
    if (section) onNavigate?.(section);
    void markAssistantNoticeRead(item);
  }

  async function enableBrowserReminder() {
    if (typeof window.Notification === 'undefined') {
      setBrowserReminderStatus('此浏览器不支持通知；站内提醒仍保留在个人主页。');
      return;
    }
    try {
      const permission = window.Notification.permission === 'default'
        ? await window.Notification.requestPermission() : window.Notification.permission;
      if (permission === 'granted') {
        new window.Notification('海屿康养社区', { body: currentAssistantNotice?.message || '你有新的站内提醒。' });
        setBrowserReminderStatus('浏览器提醒已显示；站内提醒仍会保留在个人主页。');
      } else if (permission === 'denied') {
        setBrowserReminderStatus('浏览器通知未获允许；你仍可在个人主页查看站内提醒。');
      } else {
        setBrowserReminderStatus('浏览器尚未允许通知；你仍可在个人主页查看站内提醒。');
      }
    } catch { setBrowserReminderStatus('浏览器提醒暂不可用；站内提醒仍保留在个人主页。'); }
  }

  const latestActionCardMessageIndex = new Map();
  messages.forEach((message, index) => (message.actionCards || []).forEach(card => latestActionCardMessageIndex.set(card.id, index)));
  const visibleActionCards = messages.map((message, index) => {
    const seen = new Set();
    return (message.actionCards || []).filter(card => {
      if (latestActionCardMessageIndex.get(card.id) !== index || seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
  });

  return <>
    <button type="button" className={`assistant-fab ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-label={open ? '关闭智能助手' : '打开智能助手'}><span>{open ? '×' : '✦'}</span><small>{open ? '关闭' : 'AI 助手'}</small></button>
    {open && <section className="assistant-window" aria-label="智能助手对话">
      <header><div className="assistant-title"><span className="assistant-avatar">✦</span><div><strong>{role === 'public' ? '海屿接待助手' : role === 'guest' ? '健康支持助手' : role === 'dean' ? '院长管理助手' : '工作人员助手'}</strong><small><i/> {status?.executionMode === 'live' ? `已连接 ${status.model || '模型服务'}` : status?.executionMode === 'recorded_fixture' ? '录制模型夹具 · 验收环境' : '安全引导模式 · 可接入真实 API'}</small></div></div><button type="button" className="assistant-clear" onClick={clearConversation}>清空</button></header>
      <div className="assistant-messages" aria-live="polite">
        {historyHasMore && <button type="button" className="assistant-history-more" onClick={loadEarlierHistory} disabled={sending}>加载更早消息</button>}
        {currentAssistantNotice && <article className="stage25-assistant-notice" data-testid="stage25-assistant-notice" data-notification-id={currentAssistantNotice.id} data-source-id={currentAssistantNotice.sourceId} data-target-type={currentAssistantNotice.targetType} data-target-id={currentAssistantNotice.targetId} data-target-url={currentAssistantNotice.targetUrl}>
          <span className="eyebrow">站内提醒 · {currentAssistantNotice.sourceType}</span>
          <strong>{currentAssistantNotice.message}</strong>
          <SourceDetails><small>来源 {currentAssistantNotice.sourceId} · 目标 {currentAssistantNotice.targetType}:{currentAssistantNotice.targetId}</small></SourceDetails>
          <div><button type="button" onClick={() => openAssistantNotice(currentAssistantNotice)}>打开提醒</button>
            {!currentAssistantNotice.readAt && <button type="button" onClick={() => void markAssistantNoticeRead(currentAssistantNotice)}>标为已读</button>}
            <button type="button" onClick={() => void enableBrowserReminder()}>开启浏览器提醒</button></div>
          <small>仅当此浏览器开着时显示；站内通知保留在这里。{browserReminderStatus && ` ${browserReminderStatus}`}</small>
        </article>}
        {messages.map((message, index) => <div className={`assistant-message ${message.role} ${message.error ? 'assistant-error' : ''}`}
          data-run-id={message.runId || ''} data-message-id={message.id ?? ''}
          key={message.id !== undefined && message.id !== null ? `history-${message.id}`
            : message.clientMessageId || (message.runId ? `${message.role}-${message.runId}` : `${message.role}-local-${index}`)}>
          <div>{message.content}</div>
          {role === 'guest' && message.clarificationState?.entryPage === 'projects' && <button type="button"
            className="assistant-error-action appointment-entry" data-testid="assistant-booking-entry"
            onClick={() => onNavigate?.('projects')}>前往预约页面</button>}
          {role === 'guest' && visibleActionCards[index].map(card => <AssistantActionCard key={card.id} card={card}
            busy={confirmingActionId === card.id} onConfirm={() => confirmActionCard(card)}
            onRefresh={() => send('请重新核对当前业务状态并生成新的操作确认卡。')} onChoose={value => send(value)}
            onNavigate={() => navigateForAction(card)}/>) }
          {message.restart && <button type="button" className="assistant-error-action" onClick={clearConversation}>重新开始</button>}
          {message.retryable && message.runId && <button type="button" className="assistant-error-action" onClick={() => retryRun(message.runId)} disabled={sending}>重试查询</button>}
          {role === 'staff' && user?.jobType === 'clinician' && guestId && message.role === 'assistant' && message.runId && !message.error && !message.actionCards?.length && message.content
            && <button type="button" className="stage26-draft-trigger" data-testid="stage26-create-advice-draft" onClick={() => setAdviceDraft({
              runId: message.runId, title: '医护建议草稿', content: message.content, priority: 'normal'
            })}>转成医嘱草稿</button>}
          {adviceDraft && adviceDraft.runId === message.runId && <form className="stage26-advice-draft" data-testid="stage26-advice-draft" onSubmit={publishAssistantAdvice}>
            <strong>医嘱草稿 · 发布前请医护人员核对</strong>
            <label>标题<input required maxLength={200} value={adviceDraft.title} onChange={event => setAdviceDraft(current => ({ ...current, title: event.target.value }))}/></label>
            <label>内容<textarea required maxLength={5000} rows={5} value={adviceDraft.content} onChange={event => setAdviceDraft(current => ({ ...current, content: event.target.value }))}/></label>
            <label>重要程度<select value={adviceDraft.priority} onChange={event => setAdviceDraft(current => ({ ...current, priority: event.target.value }))}><option value="normal">建议</option><option value="important">重要</option><option value="urgent">紧急</option></select></label>
            <div><button type="submit" className="primary-btn" disabled={adviceSaving}>{adviceSaving ? '发布中…' : '医护确认并发布'}</button><button type="button" className="outline-btn" onClick={() => setAdviceDraft(null)} disabled={adviceSaving}>取消草稿</button></div>
            <small>取消只清除此编辑草稿；不会写入客人医嘱。</small>
          </form>}
          {message.sources?.length > 0 && <div className="assistant-sources"><strong>查询来源</strong>{message.sources.map(source => {
            const canOpenReview = role === 'staff' && user?.jobType === 'clinician' && source.type === 'wellness_draft';
            const canOpenOperations = role === 'staff' && user?.jobType === 'administrator' && source.type === 'project_slot';
            return <article key={`${source.type}:${source.id}`} data-source-type={source.type} data-source-id={source.id}>
              <span>{source.label}</span><SourceDetails><small>{source.id}</small></SourceDetails>
              {canOpenReview && <button type="button" data-testid="assistant-review-source" data-source-id={source.id}
                data-guest-id={guestId} data-run-id={message.runId || ''} data-tool-name="search_staff_review_context"
                onClick={() => onOpenReviewSource?.(source.id)}>打开待审方案</button>}
              {canOpenOperations && <button type="button" data-testid="assistant-operations-source" data-source-id={source.id}
                data-run-id={message.runId || ''} data-tool-name="search_operations_capacity"
                onClick={() => onOpenOperationsSource?.(source, message.content)}>打开运营时段</button>}
            </article>;
          })}</div>}
          {message.collaboration && <AssistantCollaborationTrace collaboration={message.collaboration} onSelectResource={onSelectResource}
            onAdopt={role === 'guest' ? adoptCollaboration : null}/>}
          {message.mode && <small className="assistant-mode">{message.mode}</small>}
          {message.quickReplies?.length > 0 && <div className="quick-replies">{message.quickReplies.map((quickReply) => <button type="button" key={quickReply} onClick={() => send(quickReply)} disabled={sending}>{quickReply}</button>)}</div>}
        </div>)}
        {advicePublishNotice && <div className="assistant-message assistant-mode" role="status">{advicePublishNotice}</div>}
        {sending && <div className="assistant-message assistant"><div className="typing">{progress || '正在整理你的信息…'}<span>·</span><span>·</span><span>·</span></div></div>}
      </div>
      <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); send(); }}><label className="sr-only" htmlFor={`assistant-input-${identityKey.replace(/[^a-z0-9_-]/gi, '-')}`}>输入给智能助手的内容</label><input id={`assistant-input-${identityKey.replace(/[^a-z0-9_-]/gi, '-')}`} value={text} onChange={(event) => setText(event.target.value)} placeholder={role === 'guest' ? '描述你的身体情况或想了解的事…' : role === 'public' ? '输入你想了解的内容…' : '输入工作内容或客人情况…'} disabled={sending}/><button type="submit" disabled={sending || !text.trim()} aria-label="发送消息">↑</button></form>
      <footer>AI 建议仅作辅助，健康风险请联系现场工作人员</footer>
    </section>}
  </>;
}

function AssistantActionCard({ card, busy, onConfirm, onRefresh, onChoose, onNavigate }) {
  const result = card.result || {};
  const labels = { needs_input: '需要补充信息', pending_confirmation: '等待本人确认', confirmed: result.actualState === 'cancelled' ? '已取消' : '已完成',
    rejected: '当前条件不允许', stale: '信息已变化', expired: '已过期', failed: '未能完成', superseded: '已更新' };
  const resultLabel = result.businessType === 'reservation' ? '预约' : result.businessType === 'meal_order' ? '配餐订单'
    : result.businessType === 'meal_menu' ? '餐单' : result.businessType === 'health_record' ? '健康记录'
      : result.businessType === 'wellness_draft' ? '疗程调整草稿' : '业务记录';
  const detail = result.businessId ? `${resultLabel}编号 ${result.businessId} · 状态 ${result.actualState || '已保存'}` : '';
  return <section className={`assistant-action-card status-${card.status}`} aria-label="助手操作确认卡" data-action-card-id={card.id}>
    <header><strong>{labels[card.status] || '操作信息'}</strong><small>版本 {card.version}</small></header>
    <p>{card.impact?.summary || '请核对以下操作信息。'}</p>
    {card.missingFields?.length > 0 && <p>还需要：{card.missingFields.join('、')}</p>}
    {card.impact?.project && <p>{card.impact.project.name} · {card.impact.date || ''}</p>}
    {card.impact?.slot && <p>时段 {card.impact.slot.start}–{card.impact.slot.end} · 剩余 {card.impact.slot.remaining}</p>}
    {card.impact?.reservation && <p>原预约：{card.impact.reservation.projectName} · {card.impact.reservation.businessDate} {card.impact.reservation.localStart}</p>}
    {card.impact?.items?.length > 0 && <ul>{card.impact.items.map(item => <li key={item.id}>{item.slot || item.dishName}: {item.dishName || item.dishId}</li>)}</ul>}
    {card.status === 'needs_input' && card.impact?.availableSlots?.length > 0 && <div className="assistant-action-choices">{card.impact.availableSlots.map(slot => <button type="button" key={slot.id} onClick={() => onChoose(`我选择 ${slot.localStart} 至 ${slot.localEnd}，时段编号 ${slot.id}`)}>{slot.localStart}–{slot.localEnd} · 余 {slot.remaining}</button>)}</div>}
    {card.status === 'needs_input' && card.impact?.reservations?.length > 0 && <div className="assistant-action-choices">{card.impact.reservations.map(item => <button type="button" key={item.reservationId} onClick={() => onChoose(`我选择取消预约 ${item.reservationId}`)}>{item.projectName} · {item.businessDate} {item.localStart}</button>)}</div>}
    {card.impact?.dish && <p>替换为：{card.impact.dish.name}</p>}
    {card.impact?.record && <p>记录：{card.impact.record.metric} · {JSON.stringify(card.impact.record.values)} {card.impact.record.unit}</p>}
    {card.impact?.resultMessage && <p role="status">{card.impact.resultMessage}</p>}
    {detail && <p role="status">{detail}</p>}
    <footer>
      {card.status === 'pending_confirmation' && <button type="button" className="primary-btn" onClick={onConfirm} disabled={busy}>{busy ? '正在复核…' : '确认并提交'}</button>}
      {card.status === 'confirmed' && <button type="button" className="outline-btn" onClick={onNavigate}>查看相关页面</button>}
      {['stale', 'expired', 'failed', 'rejected'].includes(card.status) && <button type="button" className="outline-btn" onClick={onRefresh}>重新核对</button>}
    </footer>
  </section>;
}

function assistantExecutionModeLabel(mode) {
  if (mode === 'live') return '真实模型服务';
  if (mode === 'recorded_fixture') return '录制模型夹具';
  if (mode === 'offline_fixture') return '离线网页夹具 · 未调用模型';
  return '安全引导模式';
}

function AssistantCollaborationTrace({ collaboration, onSelectResource, onAdopt }) {
  const [expanded, setExpanded] = useState(false);
  const parent = collaboration.parent || {};
  const selectionVerified = collaboration.coordinatorStatus === 'completed'
    && collaboration.selectionSource === 'model'
    && collaboration.selectionValidation?.schemaValid === true
    && collaboration.selectionValidation?.allowlistValid === true
    && collaboration.selectionValidation?.responseComplete === true;
  return <section className="assistant-collaboration">
    <button type="button" className="assistant-trace-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span>本次如何生成</span><small>{collaboration.agents?.length || 0} 个专业任务 · {assistantExecutionModeLabel(collaboration.executionMode)}</small><b aria-hidden="true">{expanded ? '−' : '+'}</b>
    </button>
    {expanded && <div className="assistant-trace-body">
      <div className="assistant-trace-run"><strong>{parent.name || '海屿管家'} · 协调任务</strong><SourceDetails><small>runId {parent.runId || '—'}</small></SourceDetails><small>{parent.agentId || 'household.concierge'} · v{parent.instructionVersion || '—'} · {assistantExecutionModeLabel(parent.executionMode)}</small>
        {parent.model && <small>模型 {parent.model}</small>}
        {collaboration.coordinatorError
          ? <small className="assistant-trace-coordinator-status failed">管家选择未完成（{collaboration.coordinatorError}）；回退来源：已完成领域智能体候选，未标为管家采用。</small>
          : selectionVerified
            ? <small className="assistant-trace-coordinator-status">选择来源：实际管家模型响应；schema 与候选白名单均通过；最终采纳 {collaboration.finalAdoptedCandidateIds?.length ?? collaboration.selectedCandidateIds?.length ?? 0} 项</small>
            : <small className="assistant-trace-coordinator-status unverified">管家选择状态未验证：该记录缺少完整的结构化选择与来源证据。</small>}
        {(parent.modelSteps || []).map(step => <small className="assistant-trace-step" key={`parent-step-${step.stepIndex}`}>{step.summary} · {step.status === 'completed' ? '完成' : step.status === 'failed' ? `失败（${step.errorCode || '未知原因'}）` : step.status} · {step.finishReason ? `finish_reason ${step.finishReason} · ` : ''}{formatTraceDuration(step.durationMs)} · {Number(step.inputTokens || 0) + Number(step.outputTokens || 0)} tokens</small>)}
        {(parent.validationSteps || []).map(step => <small className={`assistant-trace-validation ${step.status === 'failed' ? 'failed' : ''}`} key={`parent-validation-${step.stepIndex}`}>验证 step {step.status === 'completed' ? '通过' : `失败（${step.errorCode || '未知原因'}）`} · schema {step.diagnostic?.schemaValid === true ? '通过' : step.diagnostic?.schemaValid === false ? '失败' : '未执行'} · 白名单 {step.diagnostic?.allowlistValid === true ? '通过' : step.diagnostic?.allowlistValid === false ? '失败' : '未执行'}{step.diagnostic?.finishReason ? ` · finish_reason ${step.diagnostic.finishReason}` : ''}</small>)}
      </div>
      {(collaboration.agents || []).map(agent => <article className={`assistant-trace-agent ${agent.status === 'failed' ? 'failed' : ''}`} key={agent.runId}>
        <strong>{agent.name || agent.agentId} <span>{agent.status === 'completed' ? '已完成' : agent.status === 'failed' ? '未完成' : agent.status}</span></strong>
        <SourceDetails><small>runId {agent.runId}</small></SourceDetails><small>{agent.agentId} · v{agent.instructionVersion || '—'} · {assistantExecutionModeLabel(agent.executionMode)}</small>
        <small>{agent.model || '未取得模型'} · {formatTraceDuration(agent.durationMs)} · {Number(agent.inputTokens || 0) + Number(agent.outputTokens || 0)} tokens · 估算 ${Number(agent.estimatedCostUsd || 0).toFixed(6)}</small>
        {(agent.tools || []).map((tool, index) => <SourceDetails><small className="assistant-trace-tool" key={`${agent.runId}-${tool.toolName}-${index}`}>工具 {tool.toolName} · {tool.status === 'completed' ? '完成' : '失败'} · {formatTraceDuration(tool.durationMs)}</small></SourceDetails>)}
        {(agent.sources || []).length > 0 && <div className="assistant-trace-sources"><b>引用</b>{agent.sources.map(source => <SourceDetails><small key={`${agent.runId}-${source.type}:${source.id}`}>{source.label || source.type} · {source.id}</small></SourceDetails>)}</div>}
      </article>)}
      {(collaboration.gaps || []).map(gap => <div className="assistant-trace-gap" key={`${gap.agentId}:${gap.runId || 'missing'}`}>领域缺口：{gap.domain} 未完成（{gap.errorCode || '未知原因'}）</div>)}
      {(collaboration.candidates || []).length > 0 && <div className="assistant-trace-candidates"><b>候选复核</b>{collaboration.candidates.map(candidate => <div className={`assistant-trace-candidate ${candidate.status}`} key={`${candidate.domain}:${candidate.candidateId}`}>
        <strong>{candidate.title}</strong><span>{collaboration.coordinatorError && candidate.status === 'adopted'
          ? '领域候选（未经管家选择）'
          : `${candidateStatusLabel(candidate.status)}${selectionVerified && collaboration.selectedCandidateIds?.includes(candidate.candidateId)
            ? ' · 管家采用' : selectionVerified && candidate.status === 'adopted' ? ' · 管家未选择'
              : !selectionVerified && candidate.status === 'adopted' ? ' · 管家选择未验证' : ''}`}</span><small>{candidate.reason}</small>
        {(candidate.sourceIds || []).length > 0 && <SourceDetails><small>来源 ID：{candidate.sourceIds.map(source => source.id).join('、')}</small></SourceDetails>}
        {candidate.domain === 'psychology' && candidate.status === 'adopted' && candidate.details?.audioUrl && onSelectResource && <button type="button" className="assistant-resource-button" onClick={() => onSelectResource({
          id: candidate.details.resourceId || candidate.candidateId, title: candidate.title, audioUrl: candidate.details.audioUrl,
          durationSeconds: candidate.details.durationSeconds, source: candidate.details.resourceSource, license: candidate.details.license
        })}>打开陪伴课程</button>}
        {onAdopt && selectionVerified && candidate.status === 'adopted'
          && collaboration.finalAdoptedCandidateIds?.includes(candidate.candidateId)
          && <button type="button" className="assistant-resource-button" disabled={false}
            onClick={() => onAdopt(collaboration)}>采纳此方案</button>}
      </div>)}</div>}
      {collaboration.graphBudget && <small className="assistant-trace-budget">协作预算：模型 {collaboration.graphBudget.modelCalls}/{collaboration.graphBudget.maxModelCalls} 次 · 工具 {collaboration.graphBudget.toolCalls}/{collaboration.graphBudget.maxToolCalls} 次 · {Number(collaboration.graphBudget.inputTokens || 0) + Number(collaboration.graphBudget.outputTokens || 0)} tokens · ${Number(collaboration.graphBudget.estimatedCostUsd || 0).toFixed(6)} · {formatTraceDuration(collaboration.graphDurationMs)}</small>}
    </div>}
  </section>;
}

function candidateStatusLabel(status) {
  if (status === 'adopted') return '可参考';
  if (status === 'rejected') return '已排除';
  if (status === 'requires_review') return '待人工复核';
  return '未采用';
}

function formatTraceDuration(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '耗时记录不可用';
  return `${Math.max(0, Math.round(Number(value)))} ms`;
}

function assistantWelcome(role) {
  if (role === 'public') return '你好，我是海屿接待助手。你可以问我入住服务、客人空间或工作人员入口。先告诉我，你想了解什么？';
  if (role === 'guest') return '你好，我是你的健康支持助手。你可以说“录入我的身体情况”，我会一次问一两个问题，帮你整理给工作人员。';
  if (role === 'dean') return '你好，我是院长管理助手。我可以根据工作记录帮你整理问题和改进意见。';
  return '你好，我是工作助手。你可以输入客人观察、交接内容或服务需求，我会帮你整理成可核对的工作材料。';
}

function Root() {
  const [mode, setMode] = useState('home');
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('community_user') || 'null'); } catch { return null; }
  });
  const userRef = useRef(user);

  useEffect(() => { userRef.current = user; }, [user]);

  const logout = useCallback(() => {
    localStorage.removeItem('community_token');
    localStorage.removeItem('community_user');
    setUser(null);
    setMode('home');
  }, []);

  useEffect(() => {
    const handleAuthExpired = () => { if (userRef.current) logout(); };
    window.addEventListener('community:auth-expired', handleAuthExpired);
    return () => window.removeEventListener('community:auth-expired', handleAuthExpired);
  }, [logout]);

  const login = useCallback((nextUser, initialSection) => {
    const authenticatedUser = initialSection ? { ...nextUser, initialSection } : nextUser;
    localStorage.setItem('community_user', JSON.stringify(authenticatedUser));
    setUser(authenticatedUser);
    setMode('home');
  }, []);
  if (user) return <AppShell user={user} onLogout={logout}/>;
  if (mode === 'login-guest' || mode === 'login-staff' || mode === 'login-dean') return <Login role={mode.replace('login-', '')} onBack={() => setMode('home')} onLogin={login}/>;
  return <Home onEnter={(role) => setMode(`login-${role}`)}/>;
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><Root/></ErrorBoundary>);
