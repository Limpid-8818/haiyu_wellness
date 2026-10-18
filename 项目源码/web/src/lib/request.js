const API = '/api';
let sessionActive = false;
export function setSessionActive(active) { sessionActive = Boolean(active); }
export function clearLegacySessionStorage() {
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      for (const key of ['community_token', 'community_user']) window[name].removeItem(key);
    } catch { /* storage can be disabled; it is never used for authentication */ }
  }
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', data = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function request(path, options = {}) {
  const { onUnauthorized, ...fetchOptions } = options;
  clearLegacySessionStorage();
  let response;
  try {
    response = await fetch(API + path, {
      ...fetchOptions,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Transport': 'cookie',
        'X-Community-Request': '1',
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
    if (response.status === 401 && sessionActive && !path.startsWith('/auth/') && typeof window !== 'undefined') {
      sessionActive = false;
      window.dispatchEvent(new CustomEvent('community:auth-expired'));
    }
    throw error;
  }
  return data;
}
