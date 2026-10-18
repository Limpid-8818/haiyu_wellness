import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request, ApiError, setSessionActive } from '../src/lib/request.js';

const originalFetch = globalThis.fetch;
const originalToken = localStorage.getItem('community_token');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('lib/request', () => {
  beforeEach(() => {
    localStorage.setItem('community_token', 'token-abc');
    setSessionActive(true);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === null) localStorage.removeItem('community_token');
    else localStorage.setItem('community_token', originalToken);
    setSessionActive(false);
    vi.restoreAllMocks();
  });

  it('携带同源cookie及保护头，清理旧token且不拼Authorization', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe('/api/me');
      expect(options.credentials).toBe('same-origin');
      expect(options.headers.Authorization).toBeUndefined();
      expect(options.headers['X-Session-Transport']).toBe('cookie');
      expect(options.headers['X-Community-Request']).toBe('1');
      expect(localStorage.getItem('community_token')).toBeNull();
      return jsonResponse({ id: 'guest_1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(request('/me')).resolves.toEqual({ id: 'guest_1' });
  });

  it('非 2xx 抛出带状态与代码的 ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '预约不存在', code: 'NOT_FOUND' }, 404)));
    try {
      await request('/nope');
      expect.unreachable('should throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.status).toBe(404);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('预约不存在');
    }
  });

  it('401 触发全局登出事件（登录接口除外）', async () => {
    const listener = vi.fn();
    window.addEventListener('community:auth-expired', listener);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '登录过期' }, 401)));
    await expect(request('/me')).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('community:auth-expired', listener);
  });

  it('网络失败给出统一可读文案', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('boom'); }));
    await expect(request('/me')).rejects.toMatchObject({ message: '网络连接失败，请检查服务是否启动' });
  });
  it('匿名公共401不触发登出，登录401不误伤当前页面，活动会话只派发一次过期事件', async () => {
    const listener = vi.fn();
    window.addEventListener('community:auth-expired', listener);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: '登录过期' }, 401)));
    setSessionActive(false);
    await expect(request('/assistant/status')).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(0);
    setSessionActive(true);
    await expect(request('/auth/login', { method: 'POST' })).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(0);
    await expect(request('/me')).rejects.toMatchObject({ status: 401 });
    await expect(request('/me')).rejects.toMatchObject({ status: 401 });
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('community:auth-expired', listener);
  });

});
