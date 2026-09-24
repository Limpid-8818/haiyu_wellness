import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import './overrides.css';
import './agent.css';
import './assistant.css';

const API = '/api';
const PROFILE_FIELD_LIMITS = { phone: 32, emergencyContact: 128, mobility: 128 };

class ApiError extends Error {
  constructor(message, { status = 0, code = '', data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

async function request(path, options = {}) {
  const { onUnauthorized, ...fetchOptions } = options;
  const token = localStorage.getItem('community_token');
  let response;
  try {
    response = await fetch(API + path, {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(fetchOptions.headers || {})
      }
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new ApiError('网络连接失败，请检查服务是否启动', { data: error });
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new ApiError(data.error || data.message || `请求失败（${response.status}）`, {
      status: response.status,
      code: data.code,
      data
    });
    if (response.status === 401 && typeof onUnauthorized === 'function') onUnauthorized(error);
    if (response.status === 401 && token && !path.startsWith('/auth/login') && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('community:auth-expired'));
    }
    throw error;
  }
  return data;
}

const fmtDate = (value) => value ? new Date(value).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' }) : '—';
const initials = (name = '') => name.slice(0, 1);
const asText = (value) => typeof value === 'string' ? value : value == null ? '' : String(value);

function normalizeHealthRecord(row = {}) {
  return {
    ...row,
    type: row.type ?? row.record_type ?? '',
    recordedAt: row.recordedAt ?? row.recorded_at ?? '',
    recordedBy: row.recordedBy ?? row.recorded_by ?? ''
  };
}

function normalizeAdvice(row = {}) {
  return {
    ...row,
    createdAt: row.createdAt ?? row.created_at ?? '',
    updatedAt: row.updatedAt ?? row.updated_at ?? '',
    authorName: row.authorName ?? row.author_name ?? ''
  };
}

function normalizeGuestSummary(data) {
  if (!data || typeof data !== 'object') return data;
  const source = data.profile || {};
  const profile = data.profile ? {
    ...source,
    birthDate: source.birthDate ?? source.birth_date ?? '',
    roomNo: source.roomNo ?? source.room_no ?? '',
    checkIn: source.checkIn ?? source.check_in ?? '',
    checkOut: source.checkOut ?? source.check_out ?? '',
    emergencyContact: source.emergencyContact ?? source.emergency_contact ?? '',
    chronic: Array.isArray(source.chronic) ? source.chronic : [],
    allergies: Array.isArray(source.allergies) ? source.allergies : []
  } : data.profile;
  return {
    ...data,
    profile,
    health: Array.isArray(data.health) ? data.health.map(normalizeHealthRecord) : [],
    advice: Array.isArray(data.advice) ? data.advice.map(normalizeAdvice) : []
  };
}

function normalizeGuestList(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    ...row,
    roomNo: row.roomNo ?? row.room_no ?? '',
    chronic: Array.isArray(row.chronic) ? row.chronic : [],
    allergies: Array.isArray(row.allergies) ? row.allergies : []
  }));
}

function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'compact' : ''}`}><span className="brand-mark">屿</span><div><strong>海屿康养社区</strong>{!compact && <small>Seaside Wellness Community</small>}</div></div>;
}

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
    <section className="news-section" id="news"><div className="section-heading"><div><div className="eyebrow">COMMUNITY JOURNAL</div><h2>社区动态</h2></div><button type="button" className="link-btn" onClick={() => document.getElementById('news-grid')?.scrollIntoView({ behavior: 'smooth' })}>查看全部 <span>↗</span></button></div><div className="featured-news">{featured ? <><div className="featured-image"><span>{featured.category}</span><div className="feature-symbol">{featured.category === '健康管理' ? '◒' : featured.category === '滨海活动' ? '≈' : '✣'}</div></div><div className="featured-copy"><div className="news-meta"><span className="tag">置顶</span><span>{featured.category}</span><span>{fmtDate(featured.publishedAt)}</span></div><h3>{featured.title}</h3><p>{featured.summary}</p><button type="button" className="read-btn" onClick={() => setSelected(featured)}>阅读全文 <span>→</span></button></div></> : <div className="news-empty">{newsState}</div>}</div><div className="news-grid" id="news-grid">{news.slice(1).map(item => <article className="news-card" key={item.id} role="button" tabIndex="0" onClick={() => setSelected(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(item); } }}><div className="card-top"><span className="category-dot"/>{item.category}<time>{fmtDate(item.publishedAt)}</time></div><h3>{item.title}</h3><p>{item.summary}</p><span className="card-arrow">↗</span></article>)}</div></section>
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
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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

  return <div className="login-shell"><div className="login-aside"><Brand/><div className="login-quote"><span>“</span><h2 dangerouslySetInnerHTML={{ __html: copy.quote }}/><p>{copy.lead}</p></div><div className="login-aside-foot">海屿康养社区 · 安全工作区</div></div><div className="login-panel"><button type="button" className="back-btn" onClick={onBack}>← 返回首页</button><div className="login-form-wrap"><div className={`role-badge ${role}`}>{copy.badge}</div><h1>欢迎回来</h1><p className="form-lead">请输入你的账号信息，进入{copy.space}。</p><form onSubmit={submit}><label htmlFor="login-username">账号<input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username"/></label><label htmlFor="login-password">密码<input id="login-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password"/></label>{error && <div className="form-error" role="alert" aria-live="assertive">{error}</div>}<button type="submit" className="primary-btn full" disabled={loading} aria-busy={loading}>{loading ? '正在进入…' : '进入工作区　→'}</button></form><div className="demo-hint">演示账号已预填，可直接点击进入。生产环境请使用机构分配的账号。</div></div></div></div>;
}

function AppShell({ user, onLogout }) {
  const [section, setSection] = useState('overview');
  const [me, setMe] = useState(null);
  const [meError, setMeError] = useState('');
  const [meLoading, setMeLoading] = useState(true);
  const [toast, setToast] = useState('');
  const [assistantGuestId, setAssistantGuestId] = useState('');
  const toastTimer = useRef(null);
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
    } catch (error) {
      if (error.status === 401) {
        onLogout();
      } else {
        setMeError(error.message || '工作区暂时无法加载');
      }
    } finally {
      setMeLoading(false);
    }
  }, [onLogout]);

  useEffect(() => {
    loadMe();
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, [loadMe]);

  const handleGuestChange = useCallback((guestId) => setAssistantGuestId(guestId || ''), []);
  const handleAuthExpired = useCallback(() => onLogout(), [onLogout]);
  const guestNav = [{ id: 'overview', label: '我的首页', icon: '⌂' }, { id: 'profile', label: '我的资料', icon: '◯' }, { id: 'health', label: '我的健康', icon: '⌁' }, { id: 'advice', label: '我的医嘱', icon: '✚' }];
  const staffNav = [{ id: 'overview', label: '工作概览', icon: '⌂' }, { id: 'guests', label: '我负责的客人', icon: '♧' }, ...(user.role === 'dean' ? [{ id: 'team', label: '工作人员管理', icon: '♜' }] : []), { id: 'account', label: '我的账号', icon: '◯' }];
  const nav = user.role === 'guest' ? guestNav : staffNav;
  const assistantKey = `${assistantRole}:${user.id || user.username}:${['staff', 'dean'].includes(assistantRole) ? assistantGuestId || 'none' : 'none'}`;

  return <div className="app-shell"><aside className="app-sidebar"><Brand compact/><div className="workspace-label">{user.role === 'guest' ? '客人空间' : user.role === 'dean' ? '院长空间' : '工作人员空间'}</div><nav className="side-nav" aria-label="工作区导航">{nav.map(item => <button type="button" key={item.id} className={section === item.id ? 'active' : ''} onClick={() => setSection(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav><div className="side-bottom"><div className="privacy-note"><span>◈</span><div><strong>隐私保护中</strong><small>仅展示你有权限查看的信息</small></div></div><button type="button" className="logout-btn" onClick={onLogout}>退出登录</button></div></aside><div className="app-main"><header className="app-header"><div className="mobile-brand"><Brand compact/></div><div className="breadcrumb">海屿康养社区　/　<span>{nav.find((item) => item.id === section)?.label}</span></div><div className="user-menu"><div className="avatar">{initials(user.name)}</div><div><strong>{user.name}</strong><small>{user.role === 'guest' ? '康养客人' : user.role === 'dean' ? '院长' : '专业工作人员'}</small></div><button type="button" onClick={onLogout}>退出</button></div></header><main className="workspace">{meLoading ? <Loading/> : meError ? <ErrorState text={meError} onRetry={loadMe}/> : user.role === 'guest' ? <GuestView section={section} me={me} notify={notify} onSaved={(data) => setMe(normalizeGuestSummary(data))} go={setSection}/> : <StaffView section={section} me={me} notify={notify} onGuestChange={handleGuestChange}/>}</main></div>{toast && <div className="toast" role="status" aria-live="polite">✓ {toast}</div>}<AssistantWidget key={assistantKey} role={assistantRole} user={user} guestId={assistantGuestId} onAuthExpired={handleAuthExpired}/></div>;
}

function PageTitle({ eyebrow, title, desc, action }) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{desc && <p>{desc}</p>}</div>{action}</div>;
}

function GuestView({ section, me, notify, onSaved, go }) {
  if (!me) return <Loading/>;
  if (section === 'profile') return <GuestProfile me={me} notify={notify} onSaved={onSaved}/>;
  if (section === 'health') return <GuestHealth me={me}/>;
  if (section === 'advice') return <GuestAdvice me={me}/>;
  return <GuestOverview me={me} go={go}/>;
}

function GuestOverview({ me, go }) {
  const profile = me.profile || {};
  return <><PageTitle eyebrow="PERSONAL SPACE" title={`你好，${me.name}`} desc="这里是你的康养主页，重要的信息都会在这里清晰呈现。"/><div className="welcome-banner"><div><span className="banner-kicker">今日状态</span><h2>把今天过得松弛一点</h2><p>你的个人资料和健康信息已安全保存。需要帮助时，工作人员会在这里留下新的建议。</p></div><div className="banner-orb">海</div></div><div className="metric-grid"><Metric label="入住状态" value={profile.roomNo ? '在住' : '待确认'} hint={profile.roomNo ? `房间 ${profile.roomNo}` : '完善资料后显示'} tone="teal"/><button type="button" className="metric-card blue metric-button" onClick={() => go('health')}><span>健康记录</span><strong>{`${me.health?.length || 0} 条`}</strong><small>点击查看详情　→</small></button><button type="button" className="metric-card orange metric-button" onClick={() => go('advice')}><span>当前医嘱</span><strong>{`${me.advice?.length || 0} 条`}</strong><small>点击查看详情　→</small></button></div><AgentPanel role="guest"/><div className="two-col"><section className="surface"><SectionHead title="我的健康概览" link="查看全部" onClick={() => go('health')}/><div className="health-glance"><div className="health-icon">⌁</div><div><strong>{me.health?.[0]?.type || '还没有健康记录'}</strong><p>{me.health?.[0] ? `${me.health[0].value} ${me.health[0].unit} · ${fmtDate(me.health[0].recordedAt)}` : '可以在“我的健康”中查看工作人员记录。'}</p></div><span className="health-status">已记录</span></div></section><section className="surface"><SectionHead title="最近的医嘱" link="查看全部" onClick={() => go('advice')}/><div className="advice-preview">{me.advice?.[0] ? <><div className="advice-priority important">重要</div><strong>{me.advice[0].title}</strong><p>{me.advice[0].content}</p><small>{me.advice[0].authorName || '工作人员'} · {fmtDate(me.advice[0].createdAt)}</small></> : <Empty text="暂无新的医嘱"/>}</div></section></div></>;
}

function GuestProfile({ me, notify, onSaved }) {
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

  return <><PageTitle eyebrow="MY PROFILE" title="我的资料" desc="可编辑信息以白色输入框显示，机构登记信息和健康标签为只读。"/><form className="surface form-surface" onSubmit={save} aria-busy={saving}><div className="form-section-title"><span>可编辑信息</span><small>你可以随时更新联系方式</small></div><div className="form-grid"><Field label="联系电话" value={form.phone} maxLength={PROFILE_FIELD_LIMITS.phone} inputMode="tel" autoComplete="tel" onChange={(value) => setForm({ ...form, phone: value })}/><Field label="紧急联系人" value={form.emergencyContact} maxLength={PROFILE_FIELD_LIMITS.emergencyContact} onChange={(value) => setForm({ ...form, emergencyContact: value })}/><Field label="行动能力" value={form.mobility} maxLength={PROFILE_FIELD_LIMITS.mobility} onChange={(value) => setForm({ ...form, mobility: value })}/></div><div className="form-section-title with-top"><span>只读身份信息</span><small>由机构登记，不允许客人修改</small></div><div className="form-grid"><ReadonlyField label="姓名" value={me.name}/><ReadonlyField label="性别" value={profile.gender}/><ReadonlyField label="出生日期" value={profile.birthDate || profile.birth_date}/></div><div className="form-section-title with-top"><span>只读入住信息</span><small>如需更正，请联系工作人员</small></div><div className="form-grid"><ReadonlyField label="房间号" value={profile.roomNo || profile.room_no}/><ReadonlyField label="入住日期" value={profile.checkIn || profile.check_in}/><ReadonlyField label="离店日期" value={profile.checkOut || profile.check_out}/></div><div className="form-section-title with-top"><span>健康标签</span><small>由授权工作人员维护</small></div><div className="form-grid"><ReadonlyField label="慢病史" value={profile.chronic?.length ? profile.chronic.join('、') : '暂无记录'}/><ReadonlyField label="过敏源" value={profile.allergies?.length ? profile.allergies.join('、') : '暂无记录'}/></div><div className="form-actions"><button type="submit" className="primary-btn" disabled={saving} aria-busy={saving}>{saving ? '保存中…' : '保存修改　→'}</button></div></form><PasswordPanel notify={notify}/></>;
}

function GuestHealth({ me }) {
  return <><PageTitle eyebrow="MY HEALTH" title="我的健康状况" desc="查看近期由你或工作人员记录的健康信息。"/><div className="health-summary"><div><span>最近记录</span><strong>{me.health?.[0]?.value || '—'}</strong><small>{me.health?.[0] ? `${me.health[0].type} · ${me.health[0].unit}` : '等待记录'}</small></div><div><span>记录数量</span><strong>{me.health?.length || 0}</strong><small>近期记录</small></div><div><span>信息状态</span><strong className="green-text">已同步</strong><small>与工作人员共享</small></div></div><section className="surface table-surface"><SectionHead title="健康记录"/>{me.health?.length ? <div className="data-table"><div className="table-row table-head"><span>指标</span><span>数值</span><span>备注</span><span>记录时间</span></div>{me.health.map(row => <div className="table-row" key={row.id}><span><strong>{row.type}</strong><small>{row.unit}</small></span><span className="value-cell">{row.value}</span><span>{row.note || '—'}</span><span>{row.recordedAt ? new Date(row.recordedAt).toLocaleString('zh-CN') : '—'}</span></div>)}</div> : <div className="table-empty"><Empty text="暂无健康记录"/></div>}</section></>;
}

function GuestAdvice({ me }) {
  return <><PageTitle eyebrow="MY ADVICE" title="我的医嘱" desc="工作人员给你的专业建议会在这里持续保留，执行前请仔细阅读。"/><div className="advice-list">{me.advice?.map(advice => <article className="surface advice-card" key={advice.id}><div className="advice-card-head"><div className={`advice-priority ${advice.priority}`}>{advice.priority === 'urgent' ? '紧急' : advice.priority === 'important' ? '重要' : '建议'}</div><span>{fmtDate(advice.createdAt)}</span></div><h2>{advice.title}</h2><p>{advice.content}</p><footer><span className="avatar small">{initials(advice.authorName)}</span><span>{advice.authorName || '工作人员'} 发布</span><span className="advice-active">● 生效中</span></footer></article>)}</div>{!me.advice?.length && <div className="surface empty-large"><div>✚</div><h2>暂时没有医嘱</h2><p>工作人员新增建议后，会第一时间出现在这里。</p></div>}</>;
}

function StaffView({ section, me, notify, onGuestChange }) {
  useEffect(() => {
    if (section !== 'guests') onGuestChange(null);
  }, [section, onGuestChange]);
  if (!me) return <Loading/>;
  if (section === 'guests') return <StaffGuests notify={notify} onGuestChange={onGuestChange}/>;
  if (section === 'team') return <DeanTeam notify={notify}/>;
  if (section === 'account') return <StaffAccount me={me} notify={notify}/>;
  return <StaffOverview me={me}/>;
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
    'password.change': '修改登录密码',
    login: '登录系统'
  })[action] || action || '工作操作';
}

function fmtDateTime(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
}

function AgentPanel({ role }) {
  const [status, setStatus] = useState(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let active = true;
    request('/agent/status').then((data) => { if (active) setStatus(data); }).catch(() => {});
    return () => { active = false; };
  }, []);
  return <section className="surface agent-panel"><div className="agent-panel-head"><div><div className="eyebrow">AGENT ORCHESTRATION</div><h2><span className="agent-pulse"/>康养智能协作台</h2><p>{role === 'guest' ? '你的今日信息由康养管家协调多个专业 Agent 整理。' : '系统以康养管家为调度 Agent，辅助团队完成信息整理与建议生成。'}</p></div><div className="agent-mode">{status?.mode || '可解释规则协作模式'}<button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起' : '展开'}　⌃</button></div></div>{open && <><div className="agent-flow"><div className="flow-node orchestrator"><span>⌘</span><strong>康养管家</strong><small>调度与汇总</small></div><div className="flow-line"/><div className="flow-agents">{(status?.agents || []).slice(1).map((agent, index) => <div className="flow-node" key={agent.agent}><span>{['◒', '✣', '♧', '◌'][index]}</span><strong>{agent.agent}</strong><small>{agent.action}</small></div>)}</div></div><div className="agent-events">{(status?.agents || []).map((agent) => <div key={agent.agent}><span className={`event-state ${agent.state}`}>{agent.state === 'done' ? '✓' : '·'}</span><div><strong>{agent.agent} · {agent.action}</strong><p>{agent.detail}</p></div></div>)}</div><div className="agent-gate">⌁ 人工确认边界：{status?.humanGate || '健康风险建议由工作人员最终确认'}</div></>}</section>;
}

function StaffGuests({ notify, onGuestChange }) {
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

  return <><PageTitle eyebrow="MY GUESTS" title="我负责的客人" desc="在这里查看客人的基础资料与健康情况，并提供专业建议。" action={<button type="button" className="outline-btn" onClick={() => search()} disabled={loading} aria-busy={loading}>刷新列表　↻</button>}/><form className="search-bar" onSubmit={search}><label className="sr-only" htmlFor="guest-search">搜索客人姓名或房间号</label><span aria-hidden="true">⌕</span><input id="guest-search" placeholder="搜索客人姓名或房间号" value={query} onChange={(event) => setQuery(event.target.value)}/><button type="submit" disabled={loading} aria-busy={loading}>搜索</button></form><div className="guest-layout"><section className="surface guest-list"><div className="list-heading"><strong>客人列表</strong><span>{guests.length} 位在住客人</span></div>{loading ? <QueryState text="正在加载客人列表…"/> : listError ? <QueryState error text={listError} retryText="请稍后重试" onRetry={() => loadGuests(query.trim())} retryLabel="重试加载"/> : guests.length ? guests.map((guest) => <button type="button" className={`guest-row ${selectedId.current === guest.id ? 'selected' : ''}`} key={guest.id} onClick={() => choose(guest)}><span className="avatar">{initials(guest.name)}</span><span className="guest-main"><strong>{guest.name}</strong><small>{guest.roomNo || '未分配房间'} · {guest.phone}</small></span><span className="guest-flag">{guest.chronic?.length ? '需关注' : '状态良好'}</span><b aria-hidden="true">→</b></button>) : <div className="list-empty"><Empty text="暂无结果"/></div>}</section><section className="guest-detail">{selectionLoading ? <div className="surface detail-empty"><div className="empty-illustration">⌁</div><h2>正在打开客人档案</h2><p>正在读取当前授权范围内的信息。</p></div> : selected ? <StaffGuestDetail key={selected.id} guest={selected} notify={notify} onRefresh={refreshSelected}/> : <div className="surface detail-empty"><div className="empty-illustration">♧</div><h2>选择一位客人</h2><p>左侧选择客人后，这里会显示完整的工作所需信息。</p></div>}</section></div></>;
}

function StaffGuestDetail({ guest, notify, onRefresh }) {
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

  return <div className="detail-stack"><section className="surface profile-hero"><div className="avatar large">{initials(guest.name)}</div><div><div className="eyebrow">GUEST PROFILE</div><h2>{guest.name}</h2><p>{profile.gender || '—'}　{profile.birthDate || profile.birth_date || '—'}　房间 {profile.roomNo || profile.room_no || '—'}</p></div><span className="profile-status">在住</span></section><section className="surface"><SectionHead title="基础信息"/><div className="detail-grid"><Info label="联系电话" value={guest.phone}/><Info label="入住时间" value={`${profile.checkIn || profile.check_in || '—'} 至 ${profile.checkOut || profile.check_out || '—'}`}/><Info label="紧急联系人" value={profile.emergencyContact || profile.emergency_contact || '—'}/><Info label="行动能力" value={profile.mobility || '—'}/></div></section><section className="surface"><SectionHead title="健康情况"/><div className="health-alert"><span>⌁</span><div><strong>慢病史</strong><p>{profile.chronic?.length ? profile.chronic.join('、') : '暂无慢病记录'}</p></div></div><div className="health-alert"><span>◇</span><div><strong>过敏源</strong><p>{profile.allergies?.length ? profile.allergies.join('、') : '暂无过敏记录'}</p></div></div><div className="latest-records"><strong>近期记录</strong>{guest.health?.length ? guest.health.slice(0, 3).map((health) => <div key={health.id}><span>{health.type}</span><b>{health.value} {health.unit}</b><small>{fmtDate(health.recordedAt)}</small></div>) : <Empty text="暂无近期健康记录"/>}</div></section><section className="surface"><SectionHead title="医嘱与建议" action={<button type="button" className="primary-btn small-btn" onClick={() => setShowAdvice(!showAdvice)} aria-expanded={showAdvice}>＋ 新增建议</button>}/>{showAdvice && <form className="advice-form" onSubmit={submit} noValidate aria-busy={submitting}><Field label="标题" value={form.title} onChange={(value) => setForm({ ...form, title: value })} placeholder="例如：本周运动安排" required/><label htmlFor={`priority-${guest.id}`}>重要程度<select id={`priority-${guest.id}`} value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })}><option value="normal">一般建议</option><option value="important">重要提醒</option><option value="urgent">紧急提醒</option></select></label><label htmlFor={`advice-content-${guest.id}`}>建议内容<textarea id={`advice-content-${guest.id}`} rows="4" value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} placeholder="请输入清晰、可执行的建议" required/></label><div className="form-actions"><button type="button" className="outline-btn" onClick={() => setShowAdvice(false)} disabled={submitting}>取消</button><button type="submit" className="primary-btn" disabled={submitting} aria-busy={submitting}>{submitting ? '发布中…' : '发布建议　→'}</button></div></form>}{guest.advice?.map((advice) => <div className="staff-advice-row" key={advice.id}><div className={`advice-priority ${advice.priority}`}>{advice.priority === 'urgent' ? '紧急' : advice.priority === 'important' ? '重要' : '建议'}</div><div><strong>{advice.title}</strong><p>{advice.content}</p><small>{advice.authorName || '工作人员'} · {fmtDate(advice.createdAt)}</small></div></div>)}{!guest.advice?.length && <Empty text="还没有发布过医嘱"/>}</section></div>;
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
                    <div key={log.id}><span className="log-dot"/><div><strong>{log.action}</strong><p>{log.detail || '完成一项工作操作'}</p><small>{log.createdAt ? new Date(log.createdAt).toLocaleString('zh-CN') : '—'}</small></div></div>
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

function PasswordPanel({ notify }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [saving, setSaving] = useState(false);

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await request('/me/password', { method: 'POST', body: JSON.stringify(form) });
      notify('密码已修改，请妥善保管');
      setForm({ currentPassword: '', newPassword: '' });
      setOpen(false);
    } catch (error) {
      notify(error.message || '密码修改失败，请稍后再试');
    } finally {
      setSaving(false);
    }
  }

  return <section className="surface password-panel"><div><strong>登录密码</strong><p>定期修改密码，保护你的账号安全。</p></div><button type="button" className="outline-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起' : '修改密码'}</button>{open && <form className="password-form" onSubmit={save} aria-busy={saving}><Field label="当前密码" value={form.currentPassword} type="password" autoComplete="current-password" onChange={(value) => setForm({ ...form, currentPassword: value })} required/><Field label="新密码（至少 8 位）" value={form.newPassword} type="password" minLength={8} autoComplete="new-password" onChange={(value) => setForm({ ...form, newPassword: value })} required/><button type="submit" className="primary-btn" disabled={saving} aria-busy={saving}>{saving ? '修改中…' : '确认修改'}</button></form>}</section>;
}

function AssistantWidget({ role = 'public', user = null, guestId = '', onAuthExpired }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);
  const controllerRef = useRef(null);
  const generationRef = useRef(0);
  const identityKey = `${role}:${user?.id || 'public'}:${['staff', 'dean'].includes(role) ? guestId || 'none' : 'none'}`;
  const identityRef = useRef(identityKey);

  useEffect(() => {
    let active = true;
    request('/assistant/status').then((data) => { if (active) setStatus(data); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    identityRef.current = identityKey;
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setText('');
    setMessages([]);
    setSessionId('');
    setSending(false);
    setOpen(false);
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [identityKey]);

  useEffect(() => {
    if (open && !messages.length) setMessages([{ role: 'assistant', content: assistantWelcome(role) }]);
  }, [open, role, messages.length]);

  function clearConversation() {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setMessages([]);
    setSessionId('');
    setText('');
    setSending(false);
  }

  async function send(value = text) {
    const content = String(value || '').trim();
    if (!content || sending) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const body = { role, text: content };
    if (sessionId) body.sessionId = sessionId;
    if (['staff', 'dean'].includes(role) && guestId) body.guestId = guestId;
    setText('');
    setMessages((previous) => [...previous, { role: 'user', content }]);
    setSending(true);
    try {
      const data = await request('/assistant/chat', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (generation !== generationRef.current || identityRef.current !== identityKey) return;
      setSessionId(data.sessionId || '');
      setMessages((previous) => [...previous, { role: 'assistant', content: data.reply || '助手暂时没有返回内容。', mode: data.mode, quickReplies: data.quickReplies }]);
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
        error: true,
        restart: sessionError
      }]);
    } finally {
      if (generation === generationRef.current && identityRef.current === identityKey) {
        controllerRef.current = null;
        setSending(false);
      }
    }
  }

  return <><button type="button" className={`assistant-fab ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-label={open ? '关闭智能助手' : '打开智能助手'}><span>{open ? '×' : '✦'}</span><small>{open ? '关闭' : 'AI 助手'}</small></button>{open && <section className="assistant-window" aria-label="智能助手对话"><header><div className="assistant-title"><span className="assistant-avatar">✦</span><div><strong>{role === 'public' ? '海屿接待助手' : role === 'guest' ? '健康支持助手' : role === 'dean' ? '院长管理助手' : '工作人员助手'}</strong><small><i/> {status?.live ? `已连接 ${status.model || '模型服务'}` : '安全引导模式 · 可接入真实 API'}</small></div></div><button type="button" className="assistant-clear" onClick={clearConversation}>清空</button></header><div className="assistant-messages" aria-live="polite">{messages.map((message, index) => <div className={`assistant-message ${message.role} ${message.error ? 'assistant-error' : ''}`} key={`${index}-${String(message.content).slice(0, 8)}`}><div>{message.content}</div>{message.restart && <button type="button" className="assistant-error-action" onClick={clearConversation}>重新开始</button>}{message.mode && <small className="assistant-mode">{message.mode}</small>}{message.quickReplies?.length > 0 && <div className="quick-replies">{message.quickReplies.map((quickReply) => <button type="button" key={quickReply} onClick={() => send(quickReply)} disabled={sending}>{quickReply}</button>)}</div>}</div>)}{sending && <div className="assistant-message assistant"><div className="typing">正在整理你的信息<span>·</span><span>·</span><span>·</span></div></div>}</div><form className="assistant-input" onSubmit={(event) => { event.preventDefault(); send(); }}><label className="sr-only" htmlFor={`assistant-input-${identityKey.replace(/[^a-z0-9_-]/gi, '-')}`}>输入给智能助手的内容</label><input id={`assistant-input-${identityKey.replace(/[^a-z0-9_-]/gi, '-')}`} value={text} onChange={(event) => setText(event.target.value)} placeholder={role === 'guest' ? '描述你的身体情况或想了解的事…' : role === 'public' ? '输入你想了解的内容…' : '输入工作内容或客人情况…'} disabled={sending}/><button type="submit" disabled={sending || !text.trim()} aria-label="发送消息">↑</button></form><footer>AI 建议仅作辅助，健康风险请联系现场工作人员</footer></section>}</>;
}

function assistantWelcome(role) {
  if (role === 'public') return '你好，我是海屿接待助手。你可以问我入住服务、客人空间或工作人员入口。先告诉我，你想了解什么？';
  if (role === 'guest') return '你好，我是你的健康支持助手。你可以说“录入我的身体情况”，我会一次问一两个问题，帮你整理给工作人员。';
  if (role === 'dean') return '你好，我是院长管理助手。我可以根据工作记录帮你整理问题和改进意见。';
  return '你好，我是工作助手。你可以输入客人观察、交接内容或服务需求，我会帮你整理成可核对的工作材料。';
}

function Metric({ label, value, hint, tone }) {
  return <div className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

function SectionHead({ title, link, onClick, action }) {
  return <div className="surface-head"><h2>{title}</h2>{action || (link && <button type="button" className="link-btn" onClick={onClick}>{link}　→</button>)}</div>;
}

function Principle({ icon, title, text }) {
  return <div className="principle"><span>{icon}</span><div><strong>{title}</strong><p>{text}</p></div></div>;
}

function Field({ label, value, onChange, type = 'text', placeholder = '', maxLength, minLength, inputMode, autoComplete, required = false }) {
  return <label>{label}<input type={type} value={value ?? ''} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} maxLength={maxLength} minLength={minLength} inputMode={inputMode} autoComplete={autoComplete} required={required}/></label>;
}

function ReadonlyField({ label, value }) {
  return <div className="readonly-field"><label>{label} <span className="lock-mark" aria-hidden="true">🔒</span></label><input className="readonly-input" value={value || '—'} disabled readOnly aria-label={`${label}（只读）`}/></div>;
}

function Info({ label, value }) {
  return <div className="info-item"><span>{label}</span><strong>{value || '—'}</strong></div>;
}

function Empty({ text }) {
  return <div className="empty"><span>○</span><p>{text}</p></div>;
}

function QueryState({ text, error = false, retryText = '', onRetry, retryLabel = '重试' }) {
  return <div className={`query-state ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error ? '!' : '⌁'}</span><p>{text}</p>{retryText && <small>{retryText}</small>}{onRetry && <button type="button" className="outline-btn small-btn" onClick={onRetry}>{retryLabel}</button>}</div>;
}

function ErrorState({ text, onRetry }) {
  return <div className="error-state" role="alert"><h2>暂时无法打开工作区</h2><p>{text}</p><button type="button" className="outline-btn" onClick={onRetry}>重新加载</button></div>;
}

function Loading() {
  return <div className="loading" role="status"><span className="loader"/>正在载入你的空间…</div>;
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

  const login = useCallback((nextUser) => { setUser(nextUser); setMode('home'); }, []);
  if (user) return <AppShell user={user} onLogout={logout}/>;
  if (mode === 'login-guest' || mode === 'login-staff' || mode === 'login-dean') return <Login role={mode.replace('login-', '')} onBack={() => setMode('home')} onLogin={login}/>;
  return <Home onEnter={(role) => setMode(`login-${role}`)}/>;
}

createRoot(document.getElementById('root')).render(<Root/>);
