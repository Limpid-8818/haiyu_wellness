import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request, ApiError } from '../src/lib/request.js';

const originalFetch = globalThis.fetch;
const originalToken = localStorage.getItem('community_token');

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('lib/request', () => {
  beforeEach(() => {
    localStorage.setItem('community_token', 'token-abc');
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === null) localStorage.removeItem('community_token');
    else localStorage.setItem('community_token', originalToken);
    vi.restoreAllMocks();
  });

  it('携带 Authorization 头并返回解析后的 JSON', async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe('/api/me');
      expect(options.headers.Authorization).toBe('Bearer token-abc');
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
});
