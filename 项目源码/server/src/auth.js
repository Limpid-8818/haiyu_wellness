import crypto from 'node:crypto';

// G01：默认密钥只允许本地开发使用。生产模式未配置 AUTH_SECRET 时拒绝启动，
// 避免用源码内公开默认值签发可离线伪造的 token；配置过短时给出告警。
const DEFAULT_AUTH_SECRET = 'change-this-secret-before-production';
const configuredAuthSecret = process.env.AUTH_SECRET || '';
if (process.env.NODE_ENV === 'production' && !configuredAuthSecret) {
  throw new Error('AUTH_SECRET 未配置：生产模式拒绝以默认密钥启动，请设置随机强密钥（建议 ≥32 字节）');
}
if (process.env.NODE_ENV !== 'test') {
  if (!configuredAuthSecret) console.warn('[community] AUTH_SECRET 未配置，正在使用源码默认值（仅限本地开发）；生产部署必须设置随机强密钥');
  else if (configuredAuthSecret.length < 32) console.warn(`[community] AUTH_SECRET 长度为 ${configuredAuthSecret.length}，少于建议的 32 字节`);
}
const secret = configuredAuthSecret || DEFAULT_AUTH_SECRET;
function b64(value) { return Buffer.from(value).toString('base64url'); }
function unb64(value) { return Buffer.from(value, 'base64url').toString('utf8'); }
export function signToken(user) {
  // G11：签发时写入令牌版本；改密递增版本后旧 token 在鉴权中间件被拒。
  const payload = { sub: user.id, role: user.role, ver: Number(user.token_version ?? 0), exp: Date.now() + 8 * 60 * 60 * 1000 };
  const body = b64(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}
export function readToken(token) {
  try {
    const [body, signature] = String(token || '').split('.');
    if (!body || !signature) return null;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
    const payload = JSON.parse(unb64(body));
    return payload && typeof payload.sub === 'string' && payload.exp > Date.now() ? payload : null;
  } catch { return null; }
}
