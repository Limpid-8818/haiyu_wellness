// G43：注册登录与个人账号域路由，自 app.js 纯搬运；路径与处理逻辑不变。
import express from 'express';
import { clearBrowserSession, requireBrowserWrite, sessionResponse } from '../browser-session.js';
import { countAccessibleGuests } from '../authorization.js';
import { db, guestProfile, guestSummary, id, isUniqueViolation, json, log, now, transaction } from '../db.js';
import { hashPasswordAsync, verifyPasswordAsync } from '../password.js';
import { requestLimit } from '../request-controls.js';
import { AppError } from '../errors.js';
import { capabilitiesFor } from '../staffing.js';
import { auth, currentCredentialUser, routeHandler, safeUser } from './shared.js';

const router = express.Router();
const routes = Object.fromEntries(['get', 'post', 'put', 'patch', 'delete'].map(method => [method, (route, ...handlers) =>
  router[method](route, ...handlers.map(routeHandler))]));

routes.post('/api/auth/register', requestLimit('register'), async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : '';
  const name = typeof body.name === 'string' ? body.name.trim() : `新客人${phone.slice(-4)}`;
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new AppError(400, 'REGISTER_PHONE_INVALID', '请输入有效的11位手机号');
  if (password.length < 8 || password.length > 128) throw new AppError(400, 'REGISTER_PASSWORD_INVALID', '密码长度应为 8 至 128 位');
  if (password !== confirmPassword) throw new AppError(400, 'REGISTER_PASSWORD_MISMATCH', '两次输入的密码不一致');
  if (!name || name.length > 64) throw new AppError(400, 'REGISTER_NAME_INVALID', '姓名不能为空且不能超过64个字符');
  if (await db.prepare('SELECT id FROM users WHERE phone=? OR username=? LIMIT 1').get(phone, phone)) {
    throw new AppError(409, 'REGISTER_PHONE_TAKEN', '该手机号已注册，请直接登录');
  }

  const guestId = id('guest');
  const createdAt = now();
  const passwordHash = await hashPasswordAsync(password);
  try {
    await transaction(async () => {
      await db.prepare(`INSERT INTO users(id,username,password_hash,role,name,phone,status,job_type,created_at)
        VALUES(?,?,?,?,?,?,'active',NULL,?)`).run(guestId, phone, passwordHash, 'guest', name, phone, createdAt);
      await db.prepare(`INSERT INTO guest_profiles
        (user_id,gender,birth_date,room_no,check_in,check_out,stay_plan,emergency_contact,chronic_json,allergies_json,mobility,updated_at)
        VALUES(?,NULL,NULL,NULL,NULL,NULL,NULL,'','[]','[]','',?)`).run(guestId, createdAt);
      await log(guestId, 'guest.register', 'guest', guestId, '手机号注册，入住状态待办理');
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError(409, 'REGISTER_PHONE_TAKEN', '该手机号已注册，请直接登录');
    throw error;
  }
  const user = await db.prepare('SELECT * FROM users WHERE id=?').get(guestId);
  sessionResponse(req, res.status(201), user, { user: safeUser(user), admissionStatus: 'pending' });
});

// G38：不存在/坏散列账号也派生一次；减少密码派生路径差异，不承诺完全恒时。
const LOGIN_TIMING_HASH = await hashPasswordAsync('login-timing-equalizer');
routes.post('/api/auth/login', requestLimit('login'), async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { username, password, role } = body;
  if (![username, password, role].every(value => typeof value === 'string')) {
    throw new AppError(401, 'AUTH_INVALID_CREDENTIALS', '账号、密码或身份不匹配');
  }
  const user = await db.prepare("SELECT * FROM users WHERE username=? AND role=? AND status='active'").get(username, role);
  const stored = user?.password_hash;
  const validHash = typeof stored === 'string' && /^[^:]+:[0-9a-f]{128}$/i.test(stored);
  const matches = await verifyPasswordAsync(password, validHash ? stored : LOGIN_TIMING_HASH);
  if (!user || !validHash || !matches) {
    throw new AppError(401, 'AUTH_INVALID_CREDENTIALS', '账号、密码或身份不匹配');
  }
  await currentCredentialUser(user);
  await log(user.id, 'login', 'user', user.id, '登录系统');
  sessionResponse(req, res, user, { user: { ...safeUser(user), capabilities: await capabilitiesFor(db, user) } });
});
// Clear this browser cookie, including an expired credential; this does not revoke copied tokens.
routes.post('/api/auth/logout', (req, res) => {
  // Guard the matched route too: Express accepts case variants and trailing slashes.
  requireBrowserWrite(req, req.app.locals.browserOrigins);
  clearBrowserSession(res);
  res.json({ ok: true });
});
routes.get('/api/me', auth, async (req, res) => {
  if (req.user.role === 'guest') {
    const summary = await guestSummary(req.user.id);
    if (!summary) throw new AppError(403, 'GUEST_INACTIVE', '客人账号已停用');
    return res.json(summary);
  }
  res.json({ ...safeUser(req.user), capabilities: await capabilitiesFor(db, req.user), assignedCount: await countAccessibleGuests(req.user) });
});
routes.get('/api/me/capabilities', auth, async (req, res) => {
  res.json(await capabilitiesFor(db, req.user));
});
routes.patch('/api/me/profile', auth, async (req, res) => {
  if (req.user.role !== 'guest') throw new AppError(400, 'PROFILE_GUEST_ONLY', '工作人员请在账号设置中维护个人信息');
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'PROFILE_INVALID_BODY', '个人资料请求体必须是对象');
  }
  const allowed = {
    phone: 32,
    emergencyContact: 128,
    mobility: 128
  };
  const keys = Object.keys(body);
  const unknown = keys.filter(key => !Object.hasOwn(allowed, key));
  if (unknown.length) {
    throw new AppError(400, 'PROFILE_FIELD_NOT_ALLOWED', '只能修改联系电话、紧急联系人和行动能力', { fields: unknown });
  }
  if (!keys.length) throw new AppError(400, 'PROFILE_NO_FIELDS', '至少提供一个可修改字段');
  const values = {};
  for (const key of keys) {
    if (typeof body[key] !== 'string') throw new AppError(400, 'PROFILE_FIELD_INVALID', `${key} 必须是文本`);
    values[key] = body[key].trim();
    if (values[key].length > allowed[key]) throw new AppError(400, 'PROFILE_FIELD_INVALID', `${key} 长度超过 ${allowed[key]} 个字符`);
  }
  const current = await db.prepare('SELECT phone FROM users WHERE id=?').get(req.user.id);
  const profile = await guestProfile(req.user.id);
  if (!current || !profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  const nextPhone = values.phone ?? current.phone ?? '';
  const nextEmergency = values.emergencyContact ?? profile.emergency_contact ?? '';
  const nextMobility = values.mobility ?? profile.mobility ?? '';
  await transaction(async () => {
    await db.prepare('UPDATE users SET phone=? WHERE id=?').run(nextPhone, req.user.id);
    await db.prepare('UPDATE guest_profiles SET emergency_contact=?,mobility=?,updated_at=? WHERE user_id=?')
      .run(nextEmergency, nextMobility, now(), req.user.id);
    await log(req.user.id, 'profile.update', 'guest', req.user.id, '客人更新联系方式与行动能力');
  });
  res.json(await guestSummary(req.user.id));
});
routes.post('/api/me/password', auth, requestLimit('password'), async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { currentPassword, newPassword } = body;
  if (!await verifyPasswordAsync(currentPassword, req.user.password_hash)) {
    throw new AppError(400, 'PASSWORD_CURRENT_INVALID', '当前密码不正确');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    throw new AppError(400, 'PASSWORD_NEW_INVALID', '新密码长度应为 8 至 128 位');
  }
  const passwordHash = await hashPasswordAsync(newPassword);
  let updated;
  await transaction(async () => {
    await currentCredentialUser(req.user);
    // G11：递增令牌版本吊销该用户全部已签发 token（含当前会话），随后向下发新 token 保持本会话。
    const result = await db.prepare(`UPDATE users SET password_hash=?,token_version=token_version+1
      WHERE id=? AND password_hash=? AND token_version=? AND status='active'`)
      .run(passwordHash, req.user.id, req.user.password_hash, Number(req.user.token_version ?? 0));
    if (Number(result.changes) !== 1) throw new AppError(401, 'AUTH_TOKEN_REVOKED', '登录凭证已失效，请重新登录');
    await log(req.user.id, 'password.change', 'user', req.user.id, '修改登录密码');
    updated = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  });
  sessionResponse(req, res, updated, { ok: true });
});

export default router;
