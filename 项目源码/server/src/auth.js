import crypto from 'node:crypto';

const secret = process.env.AUTH_SECRET || 'change-this-secret-before-production';
function b64(value) { return Buffer.from(value).toString('base64url'); }
function unb64(value) { return Buffer.from(value, 'base64url').toString('utf8'); }
export function signToken(user) {
  const payload = { sub: user.id, role: user.role, exp: Date.now() + 8 * 60 * 60 * 1000 };
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
