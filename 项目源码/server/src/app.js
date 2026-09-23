import express from 'express';
import cors from 'cors';
import {
  db, hashPassword, verifyPassword, now, log, publicUser, guestProfile, guestSummary, transaction, json
} from './db.js';
import { signToken, readToken } from './auth.js';
import { assistantStatus, chatWithAssistant, getAssistantHistory } from './assistant.js';
import { accessibleGuestIds, authorizeGuestAccess, countAccessibleGuests } from './authorization.js';
import { AppError, sendError } from './errors.js';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '256kb' }));

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function auth(req, _res, next) {
  try {
    const header = req.headers.authorization;
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
    const payload = readToken(token);
    if (!payload) throw new AppError(401, 'AUTH_REQUIRED', '登录已失效，请重新登录');
    const user = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(payload.sub);
    if (!user) throw new AppError(401, 'ACCOUNT_INACTIVE', '账号不存在或已停用');
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function optionalAuth(req, _res, next) {
  try {
    const header = req.headers.authorization;
    if (!header) {
      req.user = null;
      return next();
    }
    const token = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '') : '';
    const payload = readToken(token);
    if (!payload) throw new AppError(401, 'AUTH_INVALID', '登录凭证无效，请重新登录');
    req.user = db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(payload.sub) || null;
    if (!req.user) throw new AppError(401, 'ACCOUNT_INACTIVE', '账号不存在或已停用');
    next();
  } catch (error) {
    next(error);
  }
}

function staffOnly(req, _res, next) {
  return ['staff', 'dean'].includes(req.user.role)
    ? next()
    : next(new AppError(403, 'ROLE_FORBIDDEN', '仅工作人员可访问'));
}

function deanOnly(req, _res, next) {
  return req.user.role === 'dean'
    ? next()
    : next(new AppError(403, 'ROLE_FORBIDDEN', '仅院长可访问'));
}

function safeUser(user) { return publicUser(user); }

function queryString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonArray(value) {
  const parsed = json(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function requestedGuestId(req) {
  if (req.user.role === 'guest') return req.query.guestId ?? req.user.id;
  return req.query.guestId;
}

function authorizeQueryGuest(req) {
  const guestId = requestedGuestId(req);
  return authorizeGuestAccess(req.user, guestId);
}

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'seaside-wellness-community', time: now() }));
app.get('/api/news', (req, res) => {
  const rows = db.prepare('SELECT id,category,title,summary,body,cover,published_at AS publishedAt,pinned FROM news ORDER BY pinned DESC,published_at DESC').all();
  res.json(rows);
});
app.get('/api/news/:id', (req, res) => {
  const row = db.prepare('SELECT id,category,title,summary,body,cover,published_at AS publishedAt,pinned FROM news WHERE id=?').get(req.params.id);
  if (!row) throw new AppError(404, 'NEWS_NOT_FOUND', '新闻不存在');
  res.json(row);
});

app.get('/api/assistant/status', (req, res) => res.json(assistantStatus()));
app.post('/api/assistant/chat', optionalAuth, asyncRoute(async (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const result = await chatWithAssistant({
    user: req.user,
    role: body.role,
    sessionId: body.sessionId,
    text: body.text,
    guestId: body.guestId
  });
  res.json(result);
}));
app.get('/api/assistant/history', optionalAuth, (req, res) => {
  if (typeof req.query.sessionId !== 'string' || !req.query.sessionId) {
    throw new AppError(400, 'ASSISTANT_SESSION_REQUIRED', '缺少助手会话编号');
  }
  res.json(getAssistantHistory({
    user: req.user,
    role: req.query.role,
    sessionId: req.query.sessionId,
    guestId: req.query.guestId
  }));
});

app.post('/api/auth/login', (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { username, password, role } = body;
  if (![username, password, role].every(value => typeof value === 'string')) {
    throw new AppError(401, 'AUTH_INVALID_CREDENTIALS', '账号、密码或身份不匹配');
  }
  const user = db.prepare("SELECT * FROM users WHERE username=? AND role=? AND status='active'").get(username, role);
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new AppError(401, 'AUTH_INVALID_CREDENTIALS', '账号、密码或身份不匹配');
  }
  log(user.id, 'login', 'user', user.id, '登录系统');
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  if (req.user.role === 'guest') {
    const summary = guestSummary(req.user.id);
    if (!summary) throw new AppError(403, 'GUEST_INACTIVE', '客人账号已停用');
    return res.json(summary);
  }
  res.json({ ...safeUser(req.user), assignedCount: countAccessibleGuests(req.user) });
});

app.patch('/api/me/profile', auth, (req, res) => {
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
  const current = db.prepare('SELECT phone FROM users WHERE id=?').get(req.user.id);
  const profile = guestProfile(req.user.id);
  if (!current || !profile) throw new AppError(409, 'PROFILE_NOT_READY', '客人档案尚未建立');
  const nextPhone = values.phone ?? current.phone ?? '';
  const nextEmergency = values.emergencyContact ?? profile.emergency_contact ?? '';
  const nextMobility = values.mobility ?? profile.mobility ?? '';
  transaction(() => {
    db.prepare('UPDATE users SET phone=? WHERE id=?').run(nextPhone, req.user.id);
    db.prepare('UPDATE guest_profiles SET emergency_contact=?,mobility=?,updated_at=? WHERE user_id=?')
      .run(nextEmergency, nextMobility, now(), req.user.id);
    log(req.user.id, 'profile.update', 'guest', req.user.id, '客人更新联系方式与行动能力');
  });
  res.json(guestSummary(req.user.id));
});

app.post('/api/me/password', auth, (req, res) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const { currentPassword, newPassword } = body;
  if (!verifyPassword(currentPassword, req.user.password_hash)) {
    throw new AppError(400, 'PASSWORD_CURRENT_INVALID', '当前密码不正确');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 128) {
    throw new AppError(400, 'PASSWORD_NEW_INVALID', '新密码长度应为 8 至 128 位');
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), req.user.id);
  log(req.user.id, 'password.change', 'user', req.user.id, '修改登录密码');
  res.json({ ok: true });
});

app.get('/api/me/health', auth, (req, res) => {
  const guest = authorizeQueryGuest(req);
  res.json(db.prepare('SELECT id,record_type AS type,value,unit,note,recorded_at AS recordedAt FROM health_records WHERE guest_id=? ORDER BY recorded_at DESC').all(guest.id));
});
app.get('/api/me/advice', auth, (req, res) => {
  const guest = authorizeQueryGuest(req);
  res.json(db.prepare(`SELECT a.id,a.title,a.content,a.priority,a.status,a.created_at AS createdAt,a.updated_at AS updatedAt,u.name AS authorName
    FROM medical_advice a JOIN users u ON u.id=a.author_id WHERE a.guest_id=? ORDER BY a.created_at DESC`).all(guest.id));
});
app.get('/api/agent/status', auth, (req, res) => {
  const guestId = req.user.role === 'guest'
    ? (req.query.guestId ?? req.user.id)
    : req.query.guestId;
  const guest = guestId === undefined ? null : authorizeGuestAccess(req.user, guestId);
  const events = guest ? [
    { agent: '康养管家', action: '读取健康档案', detail: `已读取 ${guest.name} 的授权档案`, state: 'done' },
    { agent: '理疗顾问', action: '执行安全规则', detail: '核对慢病、过敏与项目禁忌', state: 'done' },
    { agent: '营养师', action: '生成膳食建议', detail: '结合过敏源与饮食偏好筛选餐食', state: 'done' },
    { agent: '运动教练', action: '评估活动强度', detail: '根据行动能力给出运动建议', state: 'done' },
    { agent: '心理陪伴', action: '准备陪伴策略', detail: '根据最近状态准备沟通建议', state: 'ready' }
  ] : [
    { agent: '康养管家', action: '等待任务', detail: '登录后可为客人编排服务任务', state: 'ready' },
    { agent: '理疗顾问', action: '规则库在线', detail: '禁忌规则服务正常', state: 'done' },
    { agent: '营养师', action: '规则库在线', detail: '膳食策略服务正常', state: 'done' },
    { agent: '运动教练', action: '规则库在线', detail: '运动强度服务正常', state: 'done' },
    { agent: '心理陪伴', action: '规则库在线', detail: '陪伴策略服务正常', state: 'done' }
  ];
  res.json({ mode: process.env.LLM_BASE_URL ? 'llm+rules' : '可解释规则协作模式', orchestrator: '康养管家', agents: events, humanGate: '涉及健康风险的建议由工作人员最终确认' });
});

app.get('/api/staff/overview', auth, staffOnly, (req, res) => {
  const guestIds = accessibleGuestIds(req.user);
  const placeholders = guestIds.map(() => '?').join(',');
  const activeAdvice = guestIds.length
    ? db.prepare(`SELECT COUNT(*) AS count FROM medical_advice WHERE status='active' AND guest_id IN (${placeholders})`).get(...guestIds).count
    : 0;
  let recent;
  if (req.user.role === 'dean') {
    recent = db.prepare('SELECT id,action,detail,created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 8').all();
  } else {
    const targetFilter = guestIds.length ? ` OR target_id IN (${placeholders})` : '';
    recent = db.prepare(`SELECT id,action,detail,created_at AS createdAt FROM audit_logs
      WHERE actor_id=? AND (COALESCE(target_type,'') <> 'guest'${targetFilter})
      ORDER BY id DESC LIMIT 8`).all(req.user.id, ...guestIds);
  }
  res.json({ guests: guestIds.length, activeAdvice, recent });
});

app.get('/api/dean/staff', auth, deanOnly, (req, res) => {
  const rows = db.prepare("SELECT id,name,username,phone,status,created_at AS createdAt FROM users WHERE role='staff' ORDER BY name").all();
  res.json(rows.map(row => ({
    ...row,
    guestViews: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id=? AND action='guest.view'").get(row.id).count,
    adviceCount: db.prepare("SELECT COUNT(*) AS count FROM medical_advice WHERE author_id=?").get(row.id).count
  })));
});
app.get('/api/dean/staff/:id/logs', auth, deanOnly, (req, res) => {
  const staff = db.prepare("SELECT id,name,username,phone,status FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  const logs = db.prepare('SELECT id,action,target_type AS targetType,target_id AS targetId,detail,created_at AS createdAt FROM audit_logs WHERE actor_id=? ORDER BY id DESC LIMIT 50').all(req.params.id);
  const reviews = db.prepare('SELECT id,content,created_at AS createdAt FROM staff_reviews WHERE staff_id=? AND dean_id=? ORDER BY id DESC').all(req.params.id, req.user.id);
  res.json({ staff, logs, reviews });
});
app.post('/api/dean/staff/:id/reviews', auth, deanOnly, (req, res) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  const staff = db.prepare("SELECT id FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) throw new AppError(404, 'STAFF_NOT_FOUND', '工作人员不存在');
  if (!content || content.length > 5000) throw new AppError(400, 'REVIEW_INVALID', '意见内容不能为空且不能超过 5000 个字符');
  const result = db.prepare('INSERT INTO staff_reviews(staff_id,dean_id,content,created_at) VALUES(?,?,?,?)').run(req.params.id, req.user.id, content, now());
  log(req.user.id, 'staff.review', 'staff', req.params.id, content);
  res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
});

app.get('/api/staff/guests', auth, staffOnly, (req, res) => {
  const scope = accessibleGuestIds(req.user);
  const q = `%${queryString(req.query.q)}%`;
  if (!scope.length) return res.json([]);
  const placeholders = scope.map(() => '?').join(',');
  const rows = db.prepare(`SELECT u.id,u.name,u.phone,gp.room_no AS roomNo,gp.check_in AS checkIn,gp.check_out AS checkOut,
    gp.chronic_json AS chronicJson,gp.allergies_json AS allergiesJson
    FROM users u LEFT JOIN guest_profiles gp ON gp.user_id=u.id
    WHERE u.role='guest' AND u.status='active' AND u.id IN (${placeholders})
      AND (u.name LIKE ? OR COALESCE(gp.room_no,'') LIKE ?) ORDER BY u.name`).all(...scope, q, q);
  res.json(rows.map(row => ({
    ...row,
    chronic: jsonArray(row.chronicJson || '[]'),
    allergies: jsonArray(row.allergiesJson || '[]'),
    chronicJson: undefined,
    allergiesJson: undefined
  })));
});
app.get('/api/staff/guests/:id', auth, staffOnly, (req, res) => {
  authorizeGuestAccess(req.user, req.params.id);
  const guest = guestSummary(req.params.id);
  if (!guest) throw new AppError(404, 'GUEST_NOT_FOUND', '客人不存在');
  log(req.user.id, 'guest.view', 'guest', req.params.id, '查看客人档案');
  res.json(guest);
});
app.post('/api/staff/guests/:id/advice', auth, staffOnly, (req, res) => {
  authorizeGuestAccess(req.user, req.params.id);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  const priority = body.priority === undefined ? 'normal' : body.priority;
  if (!title || !content || title.length > 200 || content.length > 5000 || !['normal', 'important', 'urgent'].includes(priority)) {
    throw new AppError(400, 'ADVICE_INVALID', '标题、内容或重要程度不正确');
  }
  const guest = authorizeGuestAccess(req.user, req.params.id);
  const t = now();
  const result = db.prepare('INSERT INTO medical_advice(guest_id,author_id,title,content,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(guest.id, req.user.id, title, content, priority, 'active', t, t);
  log(req.user.id, 'advice.create', 'guest', guest.id, title);
  res.status(201).json({ id: Number(result.lastInsertRowid), ok: true });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.parse.failed') return sendError(res, new AppError(400, 'INVALID_JSON', '请求体不是有效 JSON'));
  if (!(error instanceof AppError)) console.error(error);
  return sendError(res, error);
});

export { app };
export default app;
