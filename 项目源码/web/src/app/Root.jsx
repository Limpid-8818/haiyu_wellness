import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from './AppShell.jsx';
import { Login } from '../components/public/Login.jsx';
import { Home } from '../components/public/Home.jsx';

export function Root() {
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
