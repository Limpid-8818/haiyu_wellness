import { AppError } from './errors.js';
import { signToken } from './auth.js';

export const SESSION_COOKIE = 'haiyu_session';
const MAX_AGE = 8 * 60 * 60 * 1000;
const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax', path: '/' });

// Presence matters: an empty, malformed or duplicated cookie is a failed credential.
export function requestCredential(req) {
  if (req.headers.authorization !== undefined) {
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization);
    return { transport: 'bearer', token: match?.[1] || '' };
  }
  const matches = String(req.headers.cookie || '').split(';').map(part => part.trim())
    .filter(part => part.split('=')[0] === SESSION_COOKIE);
  if (!matches.length) return { transport: null, token: '' };
  let token = '';
  try { if (matches.length === 1) token = decodeURIComponent(matches[0].slice(SESSION_COOKIE.length + 1)); }
  catch { /* invalid encoding fails authentication */ }
  return { transport: 'cookie', token };
}

export function allowedBrowserOrigins(value = process.env.CORS_ALLOWED_ORIGINS
  || 'http://127.0.0.1:5180,http://localhost:5180') {
  const origins = String(value).split(',').map(origin => origin.trim());
  for (const origin of origins) {
    let url;
    try { url = new URL(origin); } catch { /* diagnostic below */ }
    if (!url || !['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
      throw new Error(`CORS_ALLOWED_ORIGINS 必须是精确的 http/https 来源（无路径或通配符）：${origin}`);
    }
  }
  return new Set(origins);
}

export function requireBrowserWrite(req, origins) {
  if (!origins.has(req.get('Origin')) || req.get('X-Community-Request') !== '1') {
    throw new AppError(403, 'CSRF_REJECTED', '网页请求来源或保护头无效，请从可信网页重试');
  }
}

export function browserWriteGuard(origins) {
  return (req, _res, next) => {
    const mode = req.get('X-Session-Transport');
    if (mode !== undefined && !['cookie', 'bearer'].includes(mode)) {
      return next(new AppError(400, 'SESSION_TRANSPORT_INVALID', '会话传输方式无效'));
    }
    const cookieWrite = mode === 'cookie' || requestCredential(req).transport === 'cookie';
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && cookieWrite) requireBrowserWrite(req, origins);
    next();
  };
}

export function sessionResponse(req, res, user, data) {
  const cookie = req.authTransport ? req.authTransport === 'cookie' : req.get('X-Session-Transport') === 'cookie';
  const token = signToken(user);
  if (cookie) {
    res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), maxAge: MAX_AGE });
    return res.json(data);
  }
  return res.json({ ...data, token });
}

export function clearBrowserSession(res) {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}
