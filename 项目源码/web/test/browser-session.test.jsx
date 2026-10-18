import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { Root } from '../src/app/Root.jsx';
import { Login } from '../src/components/public/Login.jsx';
import { PasswordPanel } from '../src/shared/PasswordPanel.jsx';
import EnvironmentPanel from '../src/EnvironmentPanel.jsx';
import { request, setSessionActive } from '../src/lib/request.js';
vi.mock('../src/app/AppShell.jsx', () => ({ AppShell: ({ user, onLogout, onSessionExpired }) => <div data-testid="actual-user">{user.id}:{user.role}:{user.jobType}<button onClick={onLogout}>退出</button><button onClick={onSessionExpired}>模拟会话失效</button></div> }));
vi.mock('../src/components/public/Home.jsx', () => ({ Home: ({ onEnter }) => <div>公开首页与匿名助手<button onClick={() => onEnter('guest')}>客人入口</button></div> }));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fetchRoutes(handler) { vi.stubGlobal('fetch', vi.fn(async (url, options) => handler(url, options) || json({}))); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); setSessionActive(false); localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/'); });

describe('G12 browser session UI behavior', () => {
  it('刷新等待/me真实身份，不信任两种storage伪造身份，保留三身份五岗', async () => {
    for (const [role, jobType] of [['guest', null], ['dean', null], ...['administrator', 'clinician', 'coach', 'therapist', 'dietitian'].map(job => ['staff', job])]) {
      let resolve;
      vi.stubGlobal('fetch', vi.fn(() => new Promise(r => { resolve = r; })));
      for (const storage of [localStorage, sessionStorage]) { storage.setItem('community_user', '{"id":"forged","role":"dean"}'); storage.setItem('community_token', 'stolen'); }
      render(<Root/>);
      expect(screen.getByRole('status').textContent).toContain('恢复');
      expect(screen.queryByTestId('actual-user')).toBeNull();
      await act(async () => resolve(json({ id: 'server-user', role, jobType })));
      expect(screen.getByTestId('actual-user').textContent).toContain(`server-user:${role}:${jobType || ''}`);
      for (const storage of [localStorage, sessionStorage]) { expect(storage.getItem('community_user')).toBeNull(); expect(storage.getItem('community_token')).toBeNull(); }
      cleanup();
    }
  });

  it('401进入公开页面且只恢复一次，不阻塞匿名助手', async () => {
    fetchRoutes(() => json({ code: 'AUTH_REQUIRED' }, 401));
    render(<Root/>);
    await screen.findByText('公开首页与匿名助手');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('actual-user')).toBeNull();
  });

  it('恢复网络失败提示并能重试，不假装已登录', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(json({ id: 'real', role: 'dean' })));
    render(<Root/>);
    await screen.findByRole('alert');
    expect(screen.queryByTestId('actual-user')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试恢复' }));
    expect((await screen.findByTestId('actual-user')).textContent).toContain('real:dean');
  });

  it('退出失败保留真实身份与深链并提示，成功等服务端清cookie后回首页，刷新不恢复', async () => {
    let loggedOut = false; let fail = true;
    fetchRoutes((url, options) => {
      if (url === '/api/me') return loggedOut ? json({ code: 'AUTH_REQUIRED' }, 401) : json({ id: 'real', role: 'guest' });
      if (url === '/api/auth/logout') {
        expect(options.method).toBe('POST'); expect(options.credentials).toBe('same-origin');
        if (fail) throw new TypeError('offline');
        loggedOut = true; return json({ ok: true });
      }
    });
    history.replaceState(null, '', '/#profile'); render(<Root/>);
    await screen.findByTestId('actual-user'); fireEvent.click(screen.getByRole('button', { name: '退出', exact: true }));
    expect((await screen.findByRole('alert')).textContent).toContain('退出未完成');
    expect(screen.getByTestId('actual-user').textContent).toContain('real:guest'); expect(location.hash).toBe('#profile');
    fail = false; fireEvent.click(screen.getByRole('button', { name: '退出', exact: true }));
    await screen.findByText('公开首页与匿名助手'); expect(location.hash).toBe('');
    cleanup(); render(<Root/>); await screen.findByText('公开首页与匿名助手'); expect(screen.queryByTestId('actual-user')).toBeNull();
  });

  it('已登录401失效只清展示，不循环调用退出或恢复', async () => {
    fetchRoutes(() => json({ id: 'real', role: 'guest' })); render(<Root/>);
    await screen.findByTestId('actual-user');
    fireEvent.click(screen.getByRole('button', { name: '模拟会话失效' }));
    await screen.findByText('公开首页与匿名助手'); expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toContain('登录已失效');
  });

  it('登录和注册只采用user，不写任何token或身份缓存', async () => {
    for (const registering of [false, true]) {
      const onLogin = vi.fn();
      fetchRoutes((url, options) => {
        expect(url).toBe(registering ? '/api/auth/register' : '/api/auth/login');
        expect(options.headers['X-Session-Transport']).toBe('cookie');
        return json({ user: { id: 'real', role: 'guest' } });
      });
      render(<Login role="guest" onBack={() => {}} onLogin={onLogin}/>);
      if (registering) {
        fireEvent.click(screen.getByRole('button', { name: '没有账号？客人注册' }));
        fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '合成客人' } });
        fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '19900011234' } });
        fireEvent.change(screen.getByLabelText('密码', { exact: true }), { target: { value: 'Synthetic123' } });
        fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'Synthetic123' } });
      }
      fireEvent.submit(document.querySelector('form'));
      await waitFor(() => expect(onLogin).toHaveBeenCalled());
      expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0); cleanup();
    }
  });

  it('改密使用cookie保护请求，无token响应也能继续请求', async () => {
    const notify = vi.fn();
    fetchRoutes((url, options) => {
      expect(options.credentials).toBe('same-origin'); expect(options.headers.Authorization).toBeUndefined();
      if (url === '/api/me/password') { expect(options.headers['X-Community-Request']).toBe('1'); return json({ ok: true }); }
      return json({ id: 'real' });
    });
    render(<PasswordPanel notify={notify}/>);
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }));
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'Synthetic123' } });
    fireEvent.change(screen.getByLabelText('新密码（至少 8 位）'), { target: { value: 'Synthetic456' } });
    fireEvent.submit(document.querySelector('form'));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('密码已修改，请妥善保管'));
    await expect(request('/me')).resolves.toEqual({ id: 'real' }); expect(localStorage.length).toBe(0);
  });

  it('环境面板默认路径使用统一同源cookie和错误处理', async () => {
    fetchRoutes((url, options) => {
      expect(url).toMatch(/^\/api\/environment\?/); expect(options.credentials).toBe('same-origin'); expect(options.headers.Authorization).toBeUndefined();
      return json({ error: '合成环境错误' }, 503);
    });
    render(<EnvironmentPanel/>); await screen.findByText('合成环境错误');
  });
});
