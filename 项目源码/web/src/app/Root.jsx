import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from './AppShell.jsx';
import { Login } from '../components/public/Login.jsx';
import { Home } from '../components/public/Home.jsx';
import { clearLegacySessionStorage, request, setSessionActive } from '../lib/request.js';

export function Root() {
  const [mode, setMode] = useState('home');
  const [user, setUser] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [restoreError, setRestoreError] = useState('');
  const [sessionMessage, setSessionMessage] = useState('');
  const [loggingOut, setLoggingOut] = useState(false);
  const logoutPending = useRef(false);
  const restoreAttempt = useRef(0);

  const clearIdentity = useCallback(() => {
    setSessionActive(false);
    clearLegacySessionStorage();
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    setUser(null);
    setMode('home');
  }, []);

  const restore = useCallback(async () => {
    const attempt = ++restoreAttempt.current;
    clearLegacySessionStorage();
    setRestoring(true);
    setRestoreError('');
    try {
      const actualUser = await request('/me');
      if (attempt !== restoreAttempt.current) return;
      setSessionActive(true);
      setUser(actualUser);
    } catch (error) {
      if (attempt !== restoreAttempt.current) return;
      if (error.status === 401) {
        clearIdentity();
        if (error.code !== 'AUTH_REQUIRED') setSessionMessage('登录已失效，请重新登录或清除失效会话');
      } else setRestoreError(error.message || '会话恢复失败，请重试');
    } finally {
      if (attempt === restoreAttempt.current) setRestoring(false);
    }
  }, [clearIdentity]);

  useEffect(() => { restore(); return () => { restoreAttempt.current += 1; }; }, [restore]);

  const expired = useCallback(() => {
    clearIdentity();
    setSessionMessage('登录已失效，请重新登录或清除失效会话');
  }, [clearIdentity]);
  useEffect(() => {
    window.addEventListener('community:auth-expired', expired);
    return () => window.removeEventListener('community:auth-expired', expired);
  }, [expired]);

  const logout = useCallback(async () => {
    if (logoutPending.current) return;
    logoutPending.current = true;
    setLoggingOut(true);
    setSessionMessage('');
    try {
      await request('/auth/logout', { method: 'POST' });
      clearIdentity();
    } catch (error) {
      setSessionMessage(`退出未完成，当前会话尚未清除：${error.message}`);
    } finally {
      logoutPending.current = false;
      setLoggingOut(false);
    }
  }, [clearIdentity]);

  const login = useCallback((nextUser, initialSection) => {
    setSessionActive(true);
    clearLegacySessionStorage();
    setUser(initialSection ? { ...nextUser, initialSection } : nextUser);
    setSessionMessage('');
    setMode('home');
  }, []);
  if (restoring) return <p role="status">正在恢复登录状态…</p>;
  if (restoreError) return <div role="alert"><p>会话恢复失败：{restoreError}</p><button type="button" onClick={restore}>重试恢复</button><button type="button" onClick={() => { clearIdentity(); setRestoreError(''); }}>暂时返回首页</button></div>;
  return <>{sessionMessage && <div role="alert">{sessionMessage}{!user && <button type="button" disabled={loggingOut} onClick={logout}>清除失效会话</button>}</div>}{loggingOut && <p role="status">正在退出…</p>}{user
    ? <AppShell user={user} onLogout={logout} onSessionExpired={expired}/>
    : ['login-guest', 'login-staff', 'login-dean'].includes(mode)
      ? <Login role={mode.replace('login-', '')} onBack={() => setMode('home')} onLogin={login}/>
      : <Home onEnter={role => setMode(`login-${role}`)}/>}</>;
}
