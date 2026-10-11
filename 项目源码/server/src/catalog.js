import { db, json, log, now } from './db.js';
import { AppError } from './errors.js';

export const PROJECT_CATEGORIES = Object.freeze([
  { value: 'water_therapy', label: '水疗' },
  { value: 'exercise', label: '运动' },
  { value: 'seaside', label: '亲海' }
]);

const categoryValues = new Set(PROJECT_CATEGORIES.map(item => item.value));
const weekDays = new Set(['每日', '周一', '周二', '周三', '周四', '周五', '周六', '周日']);
const intensityLabels = { low: '低', medium: '中', high: '高' };

function text(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength) {
    throw new AppError(400, 'PROJECT_FIELD_INVALID', `${field}不能为空且最多 ${maxLength} 个字符`);
  }
  return value.trim();
}

export function decodeProject(row) {
  if (!row) return null;
  const openWindows = json(row.open_windows_json, { demo: true, timezone: 'Asia/Shanghai', windows: [] });
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    category: row.category,
    categoryLabel: PROJECT_CATEGORIES.find(item => item.value === row.category)?.label || row.category,
    intensity: row.intensity || null,
    intensityLabel: intensityLabels[row.intensity] || '',
    location: row.location,
    description: row.description,
    suitablePeople: row.suitable_people,
    contraindications: row.contraindications,
    openWindows: Array.isArray(openWindows?.windows) ? openWindows.windows : [],
    openWindowsDemo: Boolean(openWindows?.demo),
    timezone: openWindows?.timezone || 'Asia/Shanghai',
    capacityPerWindow: Number(row.capacity_per_window),
    seaEntry: Boolean(Number(row.sea_entry)),
    outdoor: Boolean(Number(row.outdoor)),
    activityTag: row.activity_tag,
    active: Boolean(Number(row.active)),
    isDemo: Boolean(Number(row.is_demo)),
    sourceReference: row.source_reference,
    updatedAt: row.updated_at
  };
}

function validSearch(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.trim().length > 80) {
    throw new AppError(400, 'CATALOG_SEARCH_INVALID', '搜索内容最多 80 个字符');
  }
  return value.trim();
}

export async function listProjects({ category = '', search = '', includeInactive = false } = {}) {
  if (category && !categoryValues.has(category)) throw new AppError(400, 'PROJECT_CATEGORY_INVALID', '项目分类无效');
  const query = validSearch(search);
  const filters = [];
  const params = [];
  if (!includeInactive) filters.push('active=1');
  if (category) { filters.push('category=?'); params.push(category); }
  if (query) {
    filters.push('(name LIKE ? OR description LIKE ? OR suitable_people LIKE ?)');
    params.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = await db.prepare(`SELECT * FROM projects ${where} ORDER BY
    CASE category WHEN 'water_therapy' THEN 1 WHEN 'exercise' THEN 2 ELSE 3 END,name`).all(...params);
  return rows.map(decodeProject);
}

export async function getProject(projectId, { includeInactive = false } = {}) {
  if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 64) return null;
  const row = await db.prepare(`SELECT * FROM projects WHERE id=?${includeInactive ? '' : ' AND active=1'}`).get(projectId.trim());
  return decodeProject(row);
}

function validateOpenWindows(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'windows')) {
    throw new AppError(400, 'PROJECT_OPEN_WINDOW_INVALID', '开放窗口格式不正确');
  }
  if (!Array.isArray(value.windows) || value.windows.length < 1 || value.windows.length > 8) {
    throw new AppError(400, 'PROJECT_OPEN_WINDOW_INVALID', '请提供 1 至 8 个开放窗口');
  }
  const windows = value.windows.map(window => {
    if (!window || typeof window !== 'object' || Array.isArray(window) || Object.keys(window).some(key => !['days', 'start', 'end'].includes(key))) {
      throw new AppError(400, 'PROJECT_OPEN_WINDOW_INVALID', '开放窗口包含不允许的字段');
    }
    if (!Array.isArray(window.days) || !window.days.length || window.days.some(day => !weekDays.has(day))) {
      throw new AppError(400, 'PROJECT_OPEN_WINDOW_INVALID', '开放日期必须使用每日或周一至周日');
    }
    const start = typeof window.start === 'string' ? window.start : '';
    const end = typeof window.end === 'string' ? window.end : '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end) || start >= end) {
      throw new AppError(400, 'PROJECT_OPEN_WINDOW_INVALID', '开放窗口时间无效或结束时间不晚于开始时间');
    }
    return { days: [...new Set(window.days)], start, end };
  });
  return { demo: true, timezone: 'Asia/Shanghai', windows };
}

export async function updateProject(projectId, body, actorId) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, 'PROJECT_UPDATE_INVALID', '请求内容格式不正确');
  const allowed = ['description', 'suitablePeople', 'contraindications', 'openWindows', 'capacityPerWindow', 'active'];
  const unknown = Object.keys(body).filter(key => !allowed.includes(key));
  if (unknown.length) throw new AppError(400, 'PROJECT_FIELD_NOT_ALLOWED', `不允许修改字段：${unknown.join('、')}`);
  const updates = [];
  const values = [];
  if (Object.hasOwn(body, 'description')) { updates.push('description=?'); values.push(text(body.description, '项目介绍', 1500)); }
  if (Object.hasOwn(body, 'suitablePeople')) { updates.push('suitable_people=?'); values.push(text(body.suitablePeople, '适宜人群', 800)); }
  if (Object.hasOwn(body, 'contraindications')) { updates.push('contraindications=?'); values.push(text(body.contraindications, '禁忌说明', 1200)); }
  if (Object.hasOwn(body, 'openWindows')) { updates.push('open_windows_json=?'); values.push(JSON.stringify(validateOpenWindows(body.openWindows))); }
  if (Object.hasOwn(body, 'capacityPerWindow')) {
    if (!Number.isInteger(body.capacityPerWindow) || body.capacityPerWindow < 1 || body.capacityPerWindow > 100) {
      throw new AppError(400, 'PROJECT_CAPACITY_INVALID', '演示时段容量须为 1 至 100 的整数');
    }
    updates.push('capacity_per_window=?'); values.push(body.capacityPerWindow);
  }
  if (Object.hasOwn(body, 'active')) {
    if (typeof body.active !== 'boolean') throw new AppError(400, 'PROJECT_ACTIVE_INVALID', '启用状态必须是布尔值');
    updates.push('active=?'); values.push(body.active ? 1 : 0);
  }
  if (!updates.length) throw new AppError(400, 'PROJECT_UPDATE_EMPTY', '请至少修改一个项目字段');
  const existing = await db.prepare('SELECT id FROM projects WHERE id=?').get(projectId);
  if (!existing) return null;
  updates.push('updated_at=?'); values.push(now()); values.push(projectId);
  await db.prepare(`UPDATE projects SET ${updates.join(',')} WHERE id=?`).run(...values);
  await log(actorId, 'project.update', 'project', projectId, JSON.stringify(Object.keys(body)));
  return getProject(projectId, { includeInactive: true });
}

export async function listKnowledge({ domain = '', search = '' } = {}) {
  const domains = new Set(['therapy', 'nutrition', 'exercise', 'companionship']);
  if (domain && !domains.has(domain)) throw new AppError(400, 'KNOWLEDGE_DOMAIN_INVALID', '知识领域无效');
  const query = validSearch(search);
  const filters = ['active=1'];
  const params = [];
  if (domain) { filters.push('domain=?'); params.push(domain); }
  if (query) {
    filters.push('(title LIKE ? OR summary LIKE ? OR body LIKE ? OR source_name LIKE ? OR keywords_json LIKE ?)');
    for (let i = 0; i < 5; i++) params.push(`%${query}%`);
  }
  const rows = await db.prepare(`SELECT * FROM domain_knowledge WHERE ${filters.join(' AND ')} ORDER BY domain,title`).all(...params);
  return rows.map(row => ({
    knowledgeId: row.knowledge_id,
    domain: row.domain,
    title: row.title,
    summary: row.summary,
    body: row.body,
    keywords: json(row.keywords_json, []),
    sourceName: row.source_name,
    sourceUrl: row.source_url,
    sourceCheckedAt: row.source_checked_at,
    updatedAt: row.updated_at
  }));
}

export async function listRules({ search = '' } = {}) {
  const query = validSearch(search);
  const params = [];
  let where = 'WHERE active=1';
  if (query) {
    where += ' AND (rule_id LIKE ? OR title LIKE ? OR scope LIKE ? OR trigger_condition LIKE ? OR source_reference LIKE ? OR demo_note LIKE ?)';
    for (let i = 0; i < 6; i++) params.push(`%${query}%`);
  }
  const rows = await db.prepare(`SELECT * FROM safety_rules ${where} ORDER BY rule_id`).all(...params);
  return rows.map(row => ({
    ruleId: row.rule_id,
    title: row.title,
    scope: row.scope,
    triggerCondition: row.trigger_condition,
    conditions: json(row.conditions_json, {}),
    action: row.action,
    version: row.version,
    sourceReference: row.source_reference,
    sourceUrl: row.source_url || '',
    demoNote: row.demo_note,
    updatedAt: row.updated_at
  }));
}
