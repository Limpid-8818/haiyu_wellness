import React, { useState } from 'react';
import { request } from '../../lib/request.js';
import { Brand } from '../../shared/branding.jsx';

// G02：演示账号只预填进开发构建；生产构建中不再内置演示密码。
const DEMO_PREFILL = import.meta.env.DEV;

const ROLE_COPY = {
  guest: { username: 'guest_demo', password: DEMO_PREFILL ? 'guest2026' : '', badge: '客人入口', quoteLines: ['你的健康，', '值得被认真对待。'], lead: '在个人空间里查看自己的资料、健康记录与医嘱。', space: '个人空间' },
  staff: { username: 'staff_demo', password: DEMO_PREFILL ? 'staff2026' : '', badge: '工作人员入口', quoteLines: ['专业的判断，', '从完整的信息开始。'], lead: '在工作人员空间里，安全地管理你负责的每一位客人。', space: '工作台' },
  dean: { username: 'dean_demo', password: DEMO_PREFILL ? 'dean2026' : '', badge: '院长管理入口', quoteLines: ['让团队的每一次照护，', '都被看见。'], lead: '在院长空间里查看团队工作记录并留下管理意见。', space: '院长空间' }
};

export function Login({ role, onBack, onLogin }) {
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

  return <div className="login-shell"><div className="login-aside"><Brand/><div className="login-quote"><span>“</span><h2>{copy.quoteLines.map((line, index) => <React.Fragment key={index}>{index > 0 && <br/>}{line}</React.Fragment>)}</h2><p>{copy.lead}</p></div><div className="login-aside-foot">海屿康养社区 · 安全工作区</div></div><div className="login-panel"><button type="button" className="back-btn" onClick={onBack}>← 返回首页</button><div className="login-form-wrap"><div className={`role-badge ${role}`}>{registering ? '客人注册' : copy.badge}</div><h1>{registering ? '创建客人账号' : '欢迎回来'}</h1><p className="form-lead">{registering ? '使用手机号注册，注册后可进入个人档案。' : `请输入你的账号信息，进入${copy.space}。`}</p>{registering ? <form onSubmit={register} noValidate><label htmlFor="register-name">姓名<input id="register-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={64} required/></label><label htmlFor="register-phone">手机号<input id="register-phone" value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" inputMode="tel" autoComplete="tel" maxLength={11} required/></label><label htmlFor="register-password">密码<input id="register-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="new-password" minLength={8} maxLength={128} required/></label><label htmlFor="register-confirm-password">确认密码<input id="register-confirm-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" autoComplete="new-password" minLength={8} maxLength={128} required aria-invalid={passwordMismatch}/></label>{passwordMismatch && <div className="form-error inline-error" role="alert">两次输入的密码不一致</div>}{error && <div className="form-error" role="alert" aria-live="assertive">{error}</div>}<button type="submit" className="primary-btn full" disabled={loading || passwordMismatch} aria-busy={loading}>{loading ? '正在创建…' : '注册并进入档案　→'}</button><button type="button" className="login-switch" onClick={() => { setRegistering(false); setPassword(copy.password); setConfirmPassword(''); setError(''); }}>已有账号？返回登录</button></form> : <form onSubmit={submit}><label htmlFor="login-username">账号<input id="login-username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username"/></label><label htmlFor="login-password">密码<input id="login-password" value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password"/></label>{error && <div className="form-error" role="alert" aria-live="assertive">{error}</div>}<button type="submit" className="primary-btn full" disabled={loading} aria-busy={loading}>{loading ? '正在进入…' : '进入工作区　→'}</button>{role === 'guest' && <button type="button" className="login-switch" onClick={() => { setRegistering(true); setPassword(''); setConfirmPassword(''); setError(''); }}>没有账号？客人注册</button>}</form>}{!registering && <div className="demo-hint">{DEMO_PREFILL ? '演示账号已预填，可直接点击进入。生产环境请使用机构分配的账号。' : '请使用机构分配的账号登录。'}</div>}</div></div></div>;
}
