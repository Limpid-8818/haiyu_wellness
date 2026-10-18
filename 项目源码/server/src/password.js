import crypto from 'node:crypto';

export function hashPassword(password) {
  if (typeof password !== 'string') throw new TypeError('password must be a string');
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [salt, expected, extra] = stored.split(':');
  if (!salt || !/^[0-9a-f]{128}$/i.test(expected || '') || extra !== undefined) return false;
  try {
    const actual = crypto.scryptSync(password, salt, 64).toString('hex');
    const actualBuffer = Buffer.from(actual, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    return actualBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  } catch {
    return false;
  }
}

// HTTP 入口使用线程池派生；同步入口保留给 CLI、种子和旧 fixture。
function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derived) => error ? reject(error) : resolve(derived));
  });
}

export async function hashPasswordAsync(password) {
  if (typeof password !== 'string') throw new TypeError('password must be a string');
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await derivePassword(password, salt)).toString('hex')}`;
}

export async function verifyPasswordAsync(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [salt, expected, extra] = stored.split(':');
  if (!salt || !/^[0-9a-f]{128}$/i.test(expected || '') || extra !== undefined) return false;
  try {
    const actual = await derivePassword(password, salt);
    return crypto.timingSafeEqual(actual, Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
