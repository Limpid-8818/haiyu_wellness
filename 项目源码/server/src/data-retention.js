// Manual maintenance only. Deliberately no database import or startup side effects.
export const retentionTables = Object.freeze([
  'tool_executions', 'agent_steps', 'assistant_messages', 'agent_runs',
  'assistant_sessions', 'mood_resource_events', 'audit_logs'
]);
export const retentionSchemaTables = Object.freeze([
  'activity_slots', 'agent_runs', 'agent_steps', 'assistant_action_cards', 'assistant_messages',
  'assistant_sessions', 'audit_logs', 'care_follow_up_tasks', 'daily_briefs', 'dishes',
  'domain_knowledge', 'environment_snapshots', 'guest_profiles', 'health_assessment_progress',
  'health_extraction_drafts', 'health_intakes', 'health_records', 'job_capability_settings',
  'meal_menu_items', 'meal_menus', 'meal_order_checks', 'meal_order_requests', 'meal_orders',
  'meal_restriction_reviews', 'medical_advice', 'mood_focus_items', 'mood_records',
  'mood_resource_events', 'news', 'projects', 'reservations', 'safety_rules', 'schema_migrations',
  'service_executions', 'staff_guest_assignments', 'staff_reviews', 'stage26_operations_incidents',
  'stage26_provider_events', 'stage26_provider_state', 'stage26_reschedule_links',
  'stage26_reservation_checkins', 'stage26_staff_slot_assignments', 'stage26_weather_batch_items',
  'stage26_weather_batches', 'tool_executions', 'users', 'wellness_admin_attention',
  'wellness_checkins', 'wellness_draft_items', 'wellness_drafts', 'wellness_feedback',
  'wellness_feedback_revisions', 'wellness_local_notifications', 'wellness_replan_events', 'wellness_review_events'
]);
const targets = new Set(retentionTables);
const graphTables = new Set(retentionTables.filter(t => !['mood_resource_events', 'audit_logs'].includes(t)));
const limits = { batchSize: [100, 1000], scanRows: [10000, 20000], scanBytes: [8388608, 16777216], groupRows: [1000, 1000] };
const configKeys = new Set(['enabled', 'auditEnabled', 'runDays', 'moodDays', 'auditDays', ...Object.keys(limits)]);
function invalid(message) { throw new Error(`RETENTION_INVALID: ${message}`); }
export function validateRetentionConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('configuration object required');
  for (const key of Object.keys(input)) if (!configKeys.has(key)) invalid(`unknown option ${key}`);
  const result = { enabled: false, auditEnabled: false, runDays: 90, moodDays: 90, auditDays: 180, ...input };
  for (const key of ['enabled', 'auditEnabled']) if (typeof result[key] !== 'boolean') invalid(`${key} must be boolean`);
  for (const key of ['runDays', 'moodDays', 'auditDays']) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > 36500) invalid(`${key} must be 1..36500 days`);
  }
  for (const [key, [fallback, max]] of Object.entries(limits)) {
    result[key] ??= fallback;
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > max) invalid(`${key} must be 1..${max}`);
  }
  return Object.freeze(result);
}
export function utcMillis(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return NaN;
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, part) => `.${(part || '').padEnd(3, '0')}Z`);
  return new Date(ms).toISOString() === normalized ? ms : NaN;
}
function blocked(reason) { throw new Error(`RETENTION_INCOMPLETE: ${reason}`); }

// Complete bounded snapshot, including incoming FKs and non-FK / JSON / text sources.
async function snapshot(db, config) {
  const mysql = db.driver === 'mysql';
  if (!mysql && db.driver !== 'sqlite') invalid('unsupported driver');
  const catalog = await db.prepare(mysql
    ? 'SELECT TABLE_NAME AS name,TABLE_TYPE AS kind,ENGINE AS engine FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=DATABASE()'
    : "SELECT name,type AS kind FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").all();
  const names = catalog.map(row => row.name).sort();
  if (JSON.stringify(names) !== JSON.stringify([...retentionSchemaTables].sort())) blocked('schema table set differs from v29');
  if (mysql && catalog.some(row => row.kind !== 'BASE TABLE' || row.engine !== 'InnoDB')) blocked('transactional InnoDB tables required');
  if (!mysql && catalog.some(row => row.kind !== 'table')) blocked('views are not supported');
  const triggers = await db.prepare(mysql
    ? 'SELECT TRIGGER_NAME AS name FROM INFORMATION_SCHEMA.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() LIMIT 1'
    : "SELECT name FROM sqlite_master WHERE type='trigger' LIMIT 1").all();
  if (triggers.length) blocked('triggers require a separate retention review');
  const versionRows = await db.prepare('SELECT version FROM schema_migrations ORDER BY version LIMIT 30').all();
  if (versionRows.length !== 29 || versionRows.some((row, index) => Number(row.version) !== index + 1)) blocked('all 29 migrations required');
  const rows = {}, fks = [];
  let count = 0, bytes = 0;
  for (const table of retentionSchemaTables) {
    const columns = mysql
      ? await db.prepare('SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?').all(table)
      : await db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.length || columns.length > 128 || columns.some(column => !/^[a-z][a-z0-9_]*$/.test(column.name))) blocked('unreviewed column shape');
    // Check bounded scalar lengths before materializing potentially large TEXT/JSON.
    // SQLite LENGTH(text) counts characters, hence CAST AS BLOB for a byte bound.
    const lengths = columns.map((column, index) => `${mysql ? `OCTET_LENGTH(\`${column.name}\`)` : `LENGTH(CAST(\`${column.name}\` AS BLOB))`} AS size_${index}`);
    const sizes = await db.prepare(`SELECT ${lengths.join(',')} FROM ${table} LIMIT ?`).all(config.scanRows - count + 1);
    if (count + sizes.length > config.scanRows) blocked('scanRows exceeded; no partial reference decisions');
    const rawBytes = sizes.reduce((sum, row) => sum + Object.values(row).reduce((subtotal, size) => subtotal + Number(size || 0), 0), 0);
    if (!Number.isSafeInteger(rawBytes) || bytes + rawBytes > config.scanBytes) blocked('scanBytes exceeded before loading text');
    const found = await db.prepare(`SELECT * FROM ${table} LIMIT ?`).all(config.scanRows - count + 1);
    count += found.length;
    if (count > config.scanRows) blocked('scanRows exceeded; no partial reference decisions');
    bytes += Buffer.byteLength(JSON.stringify(found));
    if (bytes > config.scanBytes) blocked('scanBytes exceeded');
    rows[table] = found;
    if (!mysql) for (const key of await db.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
      fks.push({ table, column: key.from, referencedTable: key.table, referencedColumn: key.to });
    }
  }
  if (mysql) fks.push(...await db.prepare(`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS columnName,
    REFERENCED_TABLE_NAME AS referencedTable,REFERENCED_COLUMN_NAME AS referencedColumn
    FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`).all()
    .then(keys => keys.map(key => ({ ...key, table: key.tableName, column: key.columnName }))));
  return { rows, fks, count, bytes };
}
const typeTable = Object.freeze({
  agent_run: 'agent_runs', agent_runs: 'agent_runs', assistant_run: 'agent_runs',
  assistant_session: 'assistant_sessions', assistant_sessions: 'assistant_sessions',
  agent_step: 'agent_steps', agent_steps: 'agent_steps', tool_execution: 'tool_executions',
  assistant_message: 'assistant_messages', assistant_messages: 'assistant_messages',
  audit_log: 'audit_logs', audit_logs: 'audit_logs', mood_resource_event: 'mood_resource_events', mood_resource_events: 'mood_resource_events'
});
const columnTable = Object.freeze({
  sessionid: 'assistant_sessions', sourcesessionid: 'assistant_sessions',
  runid: 'agent_runs', parentrunid: 'agent_runs', sourcerunid: 'agent_runs',
  sourceagentrunid: 'agent_runs', sourceassistantrunid: 'agent_runs', childrunid: 'agent_runs',
  stepid: 'agent_steps', agentstepid: 'agent_steps', messageid: 'assistant_messages',
  assistantmessageid: 'assistant_messages', toolexecutionid: 'tool_executions',
  auditlogid: 'audit_logs', moodresourceeventid: 'mood_resource_events'
});
const normalizedKey = key => key.replaceAll('_', '').toLowerCase();
const nodeKey = (table, id) => `${table}:${String(id).toLowerCase()}`;

function planSnapshot(state, config, currentMs) {
  const { rows, fks } = state;
  const nodes = new Map(), lexical = new Map();
  for (const table of retentionTables) for (const row of rows[table]) {
    if (row.id === undefined || row.id === null) blocked('target primary key missing');
    const key = nodeKey(table, row.id);
    if (nodes.has(key)) blocked('ambiguous target identity');
    nodes.set(key, { key, table, row, parent: key, reasons: new Set() });
    for (const id of [row.id, ...(table === 'mood_resource_events' ? [row.event_id] : [])]) {
      if (typeof id === 'string' && !/^\d+$/.test(id)) {
        const token = id.toLowerCase();
        if (!lexical.has(token)) lexical.set(token, []);
        lexical.get(token).push(key);
      }
    }
  }
  function root(key) {
    let node = nodes.get(key);
    while (node.parent !== node.key) { node.parent = nodes.get(node.parent).parent; node = nodes.get(node.parent); }
    return node;
  }
  function union(left, right) { const a = root(left), b = root(right); if (a.key !== b.key) b.parent = a.key; }
  function protect(key, reason) { nodes.get(key).reasons.add(reason); }
  function reference(owner, destination, reason) {
    if (!nodes.has(destination)) return;
    if (owner === destination) return;
    if (owner && graphTables.has(nodes.get(owner).table) && graphTables.has(nodes.get(destination).table)) union(owner, destination);
    else {
      protect(destination, reason);
      if (owner) protect(owner, 'outgoing-persistent-reference');
    }
  }
  function namedReference(owner, table, id, reason, required = false) {
    if (id === null || id === undefined || id === '') return;
    const key = nodeKey(table, id);
    if (nodes.has(key)) reference(owner, key, reason);
    else if (required && owner) protect(owner, 'unresolved-graph-reference');
  }
  let jsonNodes = 0;
  function walk(value, owner, reason, depth = 0, field = '') {
    if (++jsonNodes > 100000 || depth > 32) blocked('JSON traversal budget exceeded');
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) blocked('binary source cannot be interpreted');
    const named = columnTable[normalizedKey(field)];
    if (named && (typeof value === 'string' || typeof value === 'number')) namedReference(owner, named, value, reason);
    if (typeof value === 'string') {
      // Includes references embedded in audit prose, URLs, and serialized nested payloads.
      for (const token of value.toLowerCase().match(/[a-z0-9_-]+/g) || []) {
        for (const target of lexical.get(token) || []) reference(owner, target, reason);
      }
      if (/^\s*[\[{]/.test(value)) {
        let nested;
        try { nested = JSON.parse(value); } catch { /* Plain prose is scanned as text; declared JSON is parsed strictly below. */ }
        if (nested !== undefined) walk(nested, owner, reason, depth + 1);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, owner, reason, depth + 1);
    } else if (value && typeof value === 'object') {
      const paired = typeTable[value.type || value.source_type || value.sourceType || value.target_type || value.targetType];
      if (paired) namedReference(owner, paired, value.id ?? value.source_id ?? value.sourceId ?? value.target_id ?? value.targetId, reason);
      for (const [key, item] of Object.entries(value)) walk(item, owner, reason, depth + 1, key);
    }
  }
  for (const [table, records] of Object.entries(rows)) for (const row of records) {
    const owner = targets.has(table) ? nodeKey(table, row.id) : null;
    const reason = `reference:${table}`;
    for (const fk of fks.filter(key => key.table === table && targets.has(key.referencedTable))) {
      if (fk.referencedColumn !== 'id') blocked('unreviewed target foreign key');
      namedReference(owner, fk.referencedTable, row[fk.column], reason, true);
    }
    if (graphTables.has(table)) {
      const required = table === 'assistant_sessions' ? [] : table === 'agent_runs'
        ? [['session_id', 'assistant_sessions'], ['parent_run_id', 'agent_runs']]
        : table === 'assistant_messages' ? [['session_id', 'assistant_sessions'], ['run_id', 'agent_runs']]
          : [['run_id', 'agent_runs'], ...(table === 'tool_executions' ? [['step_id', 'agent_steps']] : [])];
      for (const [column, destination] of required) {
        if ((column === 'session_id' || column === 'run_id' && table !== 'assistant_messages') && !row[column]) protect(owner, 'missing-graph-owner');
        namedReference(owner, destination, row[column], reason, true);
      }
    }
    for (const [column, original] of Object.entries(row)) {
      if (column === 'id' || table === 'mood_resource_events' && column === 'event_id') continue;
      let value = original;
      if (column.endsWith('_json') && typeof value === 'string') {
        try { value = JSON.parse(value); } catch { blocked(`invalid JSON in ${table}.${column}`); }
      }
      walk(value, owner, reason, 0, column);
    }
    const paired = typeTable[row.target_type || row.source_type];
    if (paired) namedReference(owner, paired, row.target_id ?? row.source_id, reason);
  }
  const cutoffs = { runs: currentMs - config.runDays * 86400000, mood: currentMs - config.moodDays * 86400000, audit: currentMs - config.auditDays * 86400000 };
  function time(node, columns, cutoff) {
    for (const column of columns) {
      const ms = utcMillis(node.row[column]);
      if (!Number.isFinite(ms)) node.reasons.add('invalid-or-missing-time');
      else if (ms >= cutoff) node.reasons.add('recent-or-cutoff-boundary');
    }
  }
  for (const node of nodes.values()) {
    const { table, row } = node;
    if (table === 'assistant_sessions') {
      time(node, ['started_at', 'last_message_at', 'expires_at'], cutoffs.runs);
      if (!['closed', 'expired', 'active'].includes(row.status)) node.reasons.add('unknown-status');
      if (row.status === 'active' && !(utcMillis(row.expires_at) < currentMs)) node.reasons.add('active-session');
    } else if (table === 'agent_runs') {
      time(node, ['created_at', 'updated_at', 'completed_at'], cutoffs.runs);
      if (!['completed', 'failed', 'interrupted'].includes(row.status)) node.reasons.add('active-or-unknown-status');
    } else if (['agent_steps', 'tool_executions'].includes(table)) {
      time(node, ['started_at', 'completed_at'], cutoffs.runs);
      if (!['completed', 'failed', 'reused'].includes(row.status)) node.reasons.add('active-or-unknown-status');
    } else if (table === 'assistant_messages') time(node, ['created_at'], cutoffs.runs);
    else if (table === 'mood_resource_events') time(node, ['played_at'], cutoffs.mood);
    else {
      time(node, ['created_at'], cutoffs.audit);
      if (!config.auditEnabled) node.reasons.add('audit-policy-disabled');
      if (row.action !== 'login' || row.target_type !== 'user') node.reasons.add('audit-business-or-unknown-category');
    }
  }
  const groups = new Map();
  for (const node of nodes.values()) {
    const key = root(node.key).key;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  const tables = Object.fromEntries(retentionTables.map(table => [table, { scanned: rows[table].length, candidates: 0, selected: 0, protected: 0, deleted: 0, reasons: {} }]));
  const selected = [];
  let candidateGroups = 0, selectedGroups = 0;
  for (const group of [...groups.values()].sort((a, b) => a[0].key.localeCompare(b[0].key))) {
    const reasons = new Set(group.flatMap(node => [...node.reasons]));
    if (group.length > config.groupRows) reasons.add('group-budget-exceeded');
    if (!reasons.size) {
      candidateGroups++;
      for (const node of group) tables[node.table].candidates++;
      if (selected.length + group.length > config.batchSize) reasons.add('batch-budget-exceeded');
      else { selectedGroups++; selected.push(...group); for (const node of group) tables[node.table].selected++; }
    }
    if (reasons.size) for (const node of group) {
      const result = tables[node.table]; result.protected++;
      for (const reason of reasons) result.reasons[reason] = (result.reasons[reason] || 0) + 1;
    }
  }
  return { tables, selected, cutoffs: Object.fromEntries(Object.entries(cutoffs).map(([key, ms]) => [key, new Date(ms).toISOString()])),
    groups: { total: groups.size, candidates: candidateGroups, selected: selectedGroups }, scannedRows: state.count, scannedBytes: state.bytes };
}

export async function runDataRetention({ config: input, mode = 'preview', maintenance = false,
  clock = () => new Date(), openDatabase } = {}) {
  const config = validateRetentionConfig(input);
  if (!['preview', 'apply'].includes(mode)) invalid('mode must be preview or apply');
  if (mode === 'apply' && (!config.enabled || maintenance !== true)) invalid('apply requires enabled and explicit maintenance=true');
  if (!config.enabled) return { status: 'DISABLED', mode, databaseOpened: false };
  const current = clock(), currentMs = current instanceof Date ? current.getTime() : utcMillis(current);
  if (!Number.isFinite(currentMs) || currentMs < 0) invalid('clock must be a valid UTC date');
  if (typeof openDatabase !== 'function') invalid('openDatabase injection required');
  const connection = await openDatabase({ readOnly: mode === 'preview' });
  try {
    return await connection.transaction(async () => {
      const plan = planSnapshot(await snapshot(connection.db, config), config, currentMs);
      if (mode === 'apply') {
        for (const table of retentionTables) for (const node of plan.selected.filter(item => item.table === table)) {
          const result = await connection.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(node.row.id);
          if (Number(result.changes) !== 1) blocked('target changed during maintenance');
          plan.tables[table].deleted++;
        }
      }
      const { selected: _selected, ...report } = plan;
      return { status: mode === 'apply' ? 'APPLIED' : 'PREVIEW', mode, databaseOpened: true,
        now: new Date(currentMs).toISOString(), config, ...report };
    }, { readOnly: mode === 'preview' });
  } finally { await connection.close(); }
}
