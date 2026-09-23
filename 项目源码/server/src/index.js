import express from 'express';
import cors from 'cors';
import { db, hashPassword, verifyPassword, id, now, log, publicUser, guestProfile, guestSummary } from './db.js';
import { signToken, readToken } from './auth.js';
import { assistantStatus, chatWithAssistant } from './assistant.js';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '256kb' }));

function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = readToken(token);
  if (!payload) return res.status(401).json({ error: '登录已失效，请重新登录' });
  const user = db.prepare('SELECT * FROM users WHERE id=? AND status=\'active\'').get(payload.sub);
  if (!user) return res.status(401).json({ error: '账号不存在或已停用' });
  req.user = user; next();
}
function staffOnly(req, res, next) { return ['staff','dean'].includes(req.user.role) ? next() : res.status(403).json({ error: '仅工作人员可访问' }); }
function deanOnly(req, res, next) { return req.user.role === 'dean' ? next() : res.status(403).json({ error: '仅院长可访问' }); }
function safeUser(user) { return publicUser(user); }

app.get('/api/health', (req, res) => res.json({ ok: true, service: 'seaside-wellness-community', time: now() }));
app.get('/api/news', (req, res) => {
  const rows = db.prepare('SELECT id,category,title,summary,body,cover,published_at AS publishedAt,pinned FROM news ORDER BY pinned DESC,published_at DESC').all();
  res.json(rows);
});
app.get('/api/news/:id', (req, res) => {
  const row = db.prepare('SELECT id,category,title,summary,body,cover,published_at AS publishedAt,pinned FROM news WHERE id=?').get(req.params.id);
  row ? res.json(row) : res.status(404).json({ error: '新闻不存在' });
});
function optionalAuth(req, _res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const payload = readToken(token);
  req.user = payload ? db.prepare("SELECT * FROM users WHERE id=? AND status='active'").get(payload.sub) : null;
  next();
}
app.get('/api/assistant/status', (req, res) => res.json(assistantStatus()));
app.post('/api/assistant/chat', optionalAuth, async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: '请输入你想咨询的内容' });
  const requestedRole = req.body?.role || req.user?.role || 'public';
  const role = req.user ? (req.user.role === 'dean' ? 'dean' : req.user.role) : 'public';
  if (req.user && requestedRole !== role) return res.status(403).json({ error: '助手身份与当前登录身份不匹配' });
  try { res.json(await chatWithAssistant({ user: req.user, role, sessionId: req.body?.sessionId, text, guestId: req.body?.guestId })); }
  catch (error) { console.error(error); res.status(502).json({ error: '助手服务暂时不可用，请稍后再试' }); }
});

app.post('/api/auth/login', (req, res) => {
  const { username, password, role } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=? AND role=? AND status=\'active\'').get(username, role);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: '账号、密码或身份不匹配' });
  log(user.id, 'login', 'user', user.id, '登录系统');
  res.json({ token: signToken(user), user: safeUser(user) });
});

app.get('/api/me', auth, (req, res) => {
  if (req.user.role === 'guest') return res.json(guestSummary(req.user.id));
  res.json({ ...safeUser(req.user), assignedCount: db.prepare("SELECT COUNT(*) AS count FROM guest_profiles gp JOIN users u ON u.id=gp.user_id WHERE u.status='active'").get().count });
});
app.patch('/api/me/profile', auth, (req, res) => {
  if (req.user.role !== 'guest') return res.status(400).json({ error: '工作人员请在账号设置中维护个人信息' });
  const b = req.body || {};
  const allowed = ['name','phone'];
  const userName = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : req.user.name;
  db.prepare('UPDATE users SET name=?,phone=? WHERE id=?').run(userName, typeof b.phone === 'string' ? b.phone.trim() : req.user.phone, req.user.id);
  const profile = guestProfile(req.user.id) || {};
  const next = {
    gender: b.gender ?? profile.gender ?? '', birth_date: b.birthDate ?? profile.birth_date ?? '', room_no: b.roomNo ?? profile.room_no ?? '',
    check_in: b.checkIn ?? profile.check_in ?? '', check_out: b.checkOut ?? profile.check_out ?? '', emergency_contact: b.emergencyContact ?? profile.emergency_contact ?? '',
    chronic_json: JSON.stringify(Array.isArray(b.chronic) ? b.chronic : (profile.chronic || [])), allergies_json: JSON.stringify(Array.isArray(b.allergies) ? b.allergies : (profile.allergies || [])), mobility: b.mobility ?? profile.mobility ?? ''
  };
  db.prepare(`UPDATE guest_profiles SET gender=?,birth_date=?,room_no=?,check_in=?,check_out=?,emergency_contact=?,chronic_json=?,allergies_json=?,mobility=?,updated_at=? WHERE user_id=?`).run(next.gender,next.birth_date,next.room_no,next.check_in,next.check_out,next.emergency_contact,next.chronic_json,next.allergies_json,next.mobility,now(),req.user.id);
  log(req.user.id, 'profile.update', 'guest', req.user.id, '客人更新个人与健康档案');
  res.json(guestSummary(req.user.id));
});
app.post('/api/me/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!verifyPassword(currentPassword, req.user.password_hash)) return res.status(400).json({ error: '当前密码不正确' });
  if (typeof newPassword !== 'string' || newPassword.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPassword(newPassword), req.user.id);
  log(req.user.id, 'password.change', 'user', req.user.id, '修改登录密码');
  res.json({ ok: true });
});
app.get('/api/me/health', auth, (req, res) => {
  const guestId = req.user.role === 'guest' ? req.user.id : req.query.guestId;
  if (req.user.role !== 'guest' && !guestId) return res.status(400).json({ error: '缺少客人编号' });
  res.json(db.prepare('SELECT id,record_type AS type,value,unit,note,recorded_at AS recordedAt FROM health_records WHERE guest_id=? ORDER BY recorded_at DESC').all(guestId));
});
app.get('/api/me/advice', auth, (req, res) => {
  const guestId = req.user.role === 'guest' ? req.user.id : req.query.guestId;
  if (req.user.role !== 'guest' && !guestId) return res.status(400).json({ error: '缺少客人编号' });
  res.json(db.prepare(`SELECT a.id,a.title,a.content,a.priority,a.status,a.created_at AS createdAt,a.updated_at AS updatedAt,u.name AS authorName FROM medical_advice a JOIN users u ON u.id=a.author_id WHERE a.guest_id=? ORDER BY a.created_at DESC`).all(guestId));
});
app.get('/api/agent/status', auth, (req, res) => {
  const guestId = req.user.role === 'guest' ? req.user.id : req.query.guestId;
  const guest = guestId ? db.prepare('SELECT name FROM users WHERE id=? AND role=\'guest\'').get(guestId) : null;
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
  const guests = db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='guest' AND status='active'").get().count;
  const activeAdvice = db.prepare("SELECT COUNT(*) AS count FROM medical_advice WHERE status='active'").get().count;
  const recent = db.prepare('SELECT id,action,detail,created_at AS createdAt FROM audit_logs ORDER BY id DESC LIMIT 8').all();
  res.json({ guests, activeAdvice, recent });
});
app.get('/api/dean/staff', auth, deanOnly, (req, res) => {
  const rows = db.prepare("SELECT id,name,username,phone,status,created_at AS createdAt FROM users WHERE role='staff' ORDER BY name").all();
  res.json(rows.map(row => ({ ...row, guestViews: db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id=? AND action='guest.view'").get(row.id).count, adviceCount: db.prepare("SELECT COUNT(*) AS count FROM medical_advice WHERE author_id=?").get(row.id).count })));
});
app.get('/api/dean/staff/:id/logs', auth, deanOnly, (req, res) => {
  const staff = db.prepare("SELECT id,name,username,phone,status FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) return res.status(404).json({ error: '工作人员不存在' });
  const logs = db.prepare('SELECT id,action,target_type AS targetType,target_id AS targetId,detail,created_at AS createdAt FROM audit_logs WHERE actor_id=? ORDER BY id DESC LIMIT 50').all(req.params.id);
  const reviews = db.prepare('SELECT id,content,created_at AS createdAt FROM staff_reviews WHERE staff_id=? AND dean_id=? ORDER BY id DESC').all(req.params.id, req.user.id);
  res.json({ staff, logs, reviews });
});
app.post('/api/dean/staff/:id/reviews', auth, deanOnly, (req, res) => {
  const content = String(req.body?.content || '').trim();
  const staff = db.prepare("SELECT id FROM users WHERE id=? AND role='staff'").get(req.params.id);
  if (!staff) return res.status(404).json({ error: '工作人员不存在' });
  if (!content) return res.status(400).json({ error: '意见内容不能为空' });
  const result = db.prepare('INSERT INTO staff_reviews(staff_id,dean_id,content,created_at) VALUES(?,?,?,?)').run(req.params.id, req.user.id, content, now());
  log(req.user.id, 'staff.review', 'staff', req.params.id, content);
  res.status(201).json({ ok: true, id: Number(result.lastInsertRowid) });
});
app.get('/api/staff/guests', auth, staffOnly, (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const rows = db.prepare(`SELECT u.id,u.name,u.phone,gp.room_no AS roomNo,gp.check_in AS checkIn,gp.check_out AS checkOut,gp.chronic_json AS chronicJson,gp.allergies_json AS allergiesJson FROM users u JOIN guest_profiles gp ON gp.user_id=u.id WHERE u.role='guest' AND u.status='active' AND (u.name LIKE ? OR gp.room_no LIKE ?) ORDER BY u.name`).all(q,q);
  res.json(rows.map(r => ({ ...r, chronic: JSON.parse(r.chronicJson), allergies: JSON.parse(r.allergiesJson), chronicJson: undefined, allergiesJson: undefined })));
});
app.get('/api/staff/guests/:id', auth, staffOnly, (req, res) => {
  const guest = guestSummary(req.params.id);
  if (!guest || guest.role !== 'guest') return res.status(404).json({ error: '客人不存在' });
  log(req.user.id, 'guest.view', 'guest', req.params.id, '查看客人档案');
  res.json(guest);
});
app.post('/api/staff/guests/:id/advice', auth, staffOnly, (req, res) => {
  const { title, content, priority = 'normal' } = req.body || {};
  if (!title?.trim() || !content?.trim()) return res.status(400).json({ error: '标题和建议内容不能为空' });
  const guest = db.prepare("SELECT id FROM users WHERE id=? AND role='guest'").get(req.params.id);
  if (!guest) return res.status(404).json({ error: '客人不存在' });
  const t = now();
  const result = db.prepare('INSERT INTO medical_advice(guest_id,author_id,title,content,priority,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(req.params.id, req.user.id, title.trim(), content.trim(), ['normal','important','urgent'].includes(priority) ? priority : 'normal', 'active', t, t);
  log(req.user.id, 'advice.create', 'guest', req.params.id, title.trim());
  res.status(201).json({ id: Number(result.lastInsertRowid), ok: true });
});
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: '服务器内部错误' }); });
const port = Number(process.env.PORT || 3020);
app.listen(port, () => console.log(`[community] API running at http://localhost:${port}/api`));
