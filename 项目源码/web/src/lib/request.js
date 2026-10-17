const API = '/api';

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
