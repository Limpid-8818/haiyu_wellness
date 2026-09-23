import crypto from 'node:crypto';

export function hashPassword(password) {
  if (typeof password !== 'string') throw new TypeError('password must be a string');
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [salt, expected] = stored.split(':');
  if (!salt || !expected || !/^[0-9a-f]+$/i.test(expected)) return false;
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
