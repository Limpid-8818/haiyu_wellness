// Bounded adapter for the application's single-statement DML. DDL stays in db.exec.
// MySQL's default quoting mode: backticks are identifiers; both quote characters
// delimit strings (backslash and doubled-quote escapes). No SQL values are interpolated.
const mappings = {
  guest_profiles: { check_in: 'check_in_date', check_out: 'check_out_date' },
  health_records: { value: 'value_text' }, users: { avatar: 'avatar_url' },
  news: { cover: 'cover_url' }, audit_logs: { detail: 'detail_json' },
  assistant_messages: { role: 'sender_role' },
  health_intakes: { content: 'raw_content', status: 'review_status' }
};
const logicalNames = new Set(Object.values(mappings).flatMap(fields => Object.keys(fields)));
const stops = new Set('WHERE JOIN LEFT RIGHT INNER OUTER CROSS ON SET VALUES ORDER GROUP HAVING LIMIT OFFSET FOR UNION RETURNING USING NATURAL'.split(' '));
function unsupported(message) { throw new Error(`Unsupported MySQL logical SQL: ${message}`); }

export function tokenizeSql(sql) {
  const tokens = [];
  let depth = 0;
  for (let i = 0; i < sql.length;) {
    const start = i, char = sql[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === '#' || (sql.startsWith('--', i) && /\s|^$/.test(sql[i + 2] || ''))) {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      if (sql[i + 2] === '!') unsupported('executable comments require a physical db.exec call');
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) unsupported('unterminated comment');
      i = end + 2; continue;
    }
    let kind = 'symbol', value = char;
    if (['\'', '"', '`'].includes(char)) {
      const quote = char; i++; value = ''; let closed = false;
      while (i < sql.length) {
        if (sql[i] === '\\' && quote !== '`') {
          value += sql.slice(i, i + 2); i += 2;
        } else if (sql[i] === quote) {
          if (sql[i + 1] === quote) { value += quote; i += 2; }
          else { i++; closed = true; break; }
        } else value += sql[i++];
      }
      if (!closed) unsupported('unterminated quoted token');
      kind = quote === '`' ? 'identifier' : 'string';
    } else if (/[A-Za-z_]/.test(char)) {
      i++; while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i])) i++;
      value = sql.slice(start, i); kind = 'identifier';
    } else { i++; }
    if (char === ')') depth--;
    if (depth < 0) unsupported('unbalanced parentheses');
    tokens.push({ kind, value, lower: value.toLowerCase(), upper: value.toUpperCase(), start, end: i, depth,
      quoted: char === '`' });
    if (char === '(') depth++;
  }
  if (depth) unsupported('unbalanced parentheses');
  return tokens;
}

function splitAtCommas(tokens, depth) {
  const groups = [[]];
  for (const token of tokens) {
    if (isSymbol(token, ',') && token.depth === depth) groups.push([]);
    else groups.at(-1).push(token);
  }
  return groups;
}
const isWord = (token, word) => token?.kind === 'identifier' && !token.quoted && token.upper === word;
const isSymbol = (token, symbol) => token?.kind === 'symbol' && token.value === symbol;
const isColumn = list => list.length === 1 && list[0].kind === 'identifier'
  || list.length === 3 && list[0].kind === 'identifier' && isSymbol(list[1], '.') && list[2].kind === 'identifier';

export function compileMysqlStatement(sql) {
  const tokens = tokenizeSql(sql);
  const operation = tokens[0]?.upper;
  const plan = { sql, projections: null, auditParams: [] };
  const mappedReferences = tokens.filter((t, i) => ['FROM', 'JOIN', 'INTO', 'UPDATE'].some(word => isWord(t, word))
    && mappings[tokens[i + 1]?.lower]);
  if (!['SELECT', 'INSERT', 'UPDATE', 'DELETE'].includes(operation)) {
    if (mappedReferences.length) unsupported('logical mappings require single-layer DML; use db.exec for physical DDL');
    return plan;
  }
  if (mappedReferences.some(t => t.depth)) unsupported('nested mapped table references');
  if (tokens.some((t, i) => isSymbol(t, ';') && i !== tokens.length - 1)) unsupported('multiple statements');
  const ignored = new Set(), relations = [], replacements = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.depth || token.kind !== 'identifier' || token.quoted || !['FROM', 'JOIN', 'INTO', 'UPDATE'].includes(token.upper)) continue;
    // FOR UPDATE and non-mapped native upserts are not table declarations.
    if (token.upper === 'UPDATE' && i !== 0) continue;
    let j = i + 1;
    if (tokens[j]?.kind !== 'identifier') unsupported('derived table or missing table');
    ignored.add(j);
    let table = tokens[j++].lower;
    if (isSymbol(tokens[j], '.')) { ignored.add(j++); ignored.add(j); table = tokens[j++]?.lower; }
    let alias = table;
    if (isWord(tokens[j], 'AS')) { ignored.add(j++); if (tokens[j]?.kind !== 'identifier') unsupported('missing table alias'); }
    if (tokens[j]?.kind === 'identifier' && (tokens[j].quoted || !stops.has(tokens[j].upper))) {
      alias = tokens[j].lower; ignored.add(j++);
    }
    if (relations.some(r => r.alias === alias)) unsupported(`duplicate table alias ${alias}`);
    relations.push({ table, alias, end: j });
  }
  if (!relations.some(r => mappings[r.table])) return plan;
  if (operation !== 'SELECT' && relations.length !== 1) unsupported('multi-table writes');
  if (tokens.some((t, i) => isWord(t, 'UPDATE') && i !== 0 && !isWord(tokens[i - 1], 'FOR'))) unsupported('multi-clause UPDATE');
  if (tokens.some((t, i) => isWord(t, 'SELECT') && i !== 0)
    || tokens.some(t => isWord(t, 'UNION') || isWord(t, 'USING') || isWord(t, 'NATURAL'))) {
    unsupported('subqueries, UNION and implicit JOIN columns require explicit physical SQL');
  }
  const from = tokens.findIndex(t => t.depth === 0 && isWord(t, 'FROM'));
  if (from >= 0) {
    const end = tokens.findIndex((t, i) => i > from && !t.depth && ['WHERE', 'GROUP', 'ORDER', 'LIMIT', 'FOR'].some(w => isWord(t, w)));
    if (tokens.slice(from + 1, end < 0 ? undefined : end).some(t => !t.depth && isSymbol(t, ','))) unsupported('comma joins');
  }
  const byAlias = new Map(relations.map(r => [r.alias, r.table]));
  function columnTable(list) {
    if (list.length === 3) return byAlias.get(list[0].lower);
    if (relations.length === 1) return relations[0].table;
    if (logicalNames.has(list[0].lower)) unsupported(`qualify column ${list[0].value} in a JOIN`);
    return undefined;
  }
  // Explicit projection aliases, including names equal to physical columns, are outputs.
  const outputAliases = new Set();
  if (operation === 'SELECT') {
    const start = isWord(tokens[1], 'DISTINCT') ? 2 : 1;
    const projections = splitAtCommas(tokens.slice(start, from < 0 ? tokens.length : from), 0);
    plan.projections = projections.map(list => {
      const as = list.findIndex(t => !t.depth && isWord(t, 'AS'));
      let expression = list, name;
      if (as >= 0) {
        if (as !== list.length - 2 || !['identifier', 'string'].includes(list.at(-1)?.kind)) unsupported('projection alias');
        expression = list.slice(0, as); name = list.at(-1).value;
        ignored.add(tokens.indexOf(list.at(-1))); outputAliases.add(name.toLowerCase());
      } else if (list.length > 1 && list.at(-1).kind === 'identifier' && !isSymbol(list.at(-2), '.')
        && list.at(-2).end < list.at(-1).start && (isColumn(list.slice(0, -1)) || isSymbol(list.at(-2), ')'))) {
        unsupported('use AS for output aliases');
      }
      const wildcard = expression.length === 1 && isSymbol(expression[0], '*')
        || expression.length === 3 && isSymbol(expression[1], '.') && isSymbol(expression[2], '*');
      if (wildcard) return { wildcard: true };
      const table = isColumn(expression) ? columnTable(expression) : undefined;
      const column = isColumn(expression) ? expression.at(-1).lower : undefined;
      return { name: name ?? (column ? expression.at(-1).value : undefined),
        audit: table === 'audit_logs' && ['detail', 'detail_json'].includes(column), expression };
    });
    if (plan.projections.filter(p => p.wildcard).length > 1) unsupported('only one wildcard projection is supported');
  }
  const orderStart = tokens.findIndex(t => !t.depth && ['ORDER', 'GROUP', 'HAVING'].some(w => isWord(t, w)));
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'identifier' || ignored.has(i) || !logicalNames.has(token.lower)) continue;
    if (isSymbol(tokens[i + 1], '.') || isSymbol(tokens[i + 1], '(') || isWord(tokens[i - 1], 'AS')) continue;
    const qualified = isSymbol(tokens[i - 1], '.');
    if (!qualified && orderStart >= 0 && i > orderStart && outputAliases.has(token.lower)) continue;
    const table = columnTable(qualified ? tokens.slice(i - 2, i + 1) : [token]);
    const physical = mappings[table]?.[token.lower];
    if (physical) replacements.set(token, token.quoted ? `\`${physical}\`` : physical);
  }
  for (const projection of plan.projections || []) {
    if (!projection.wildcard && projection.name === undefined && projection.expression.some(t => replacements.has(t))) {
      unsupported('use AS for computed projections of mapped columns');
    }
    delete projection.expression;
  }
  // Associate audit VALUES with actual column expressions and placeholder ordinals.
  // A literal comma, quoted '?', NULL or function in another field does not shift it.
  const parameterIndex = new Map(); let ordinal = 0;
  for (const token of tokens) if (token.value === '?' && token.kind === 'symbol') parameterIndex.set(token, ordinal++);
  function auditValue(expression) {
    if (expression.length === 1 && parameterIndex.has(expression[0])) plan.auditParams.push(parameterIndex.get(expression[0]));
    else if (!(expression.length === 1 && isWord(expression[0], 'NULL'))) unsupported('bind audit detail as a single parameter or NULL');
  }
  if (relations[0]?.table === 'audit_logs' && operation === 'INSERT') {
    const open = relations[0].end;
    if (!isSymbol(tokens[open], '(')) unsupported('audit INSERT requires a column list');
    const close = tokens.findIndex((t, i) => i > open && isSymbol(t, ')') && !t.depth);
    const columns = splitAtCommas(tokens.slice(open + 1, close), 1);
    const detail = columns.findIndex(c => c.length === 1 && ['detail', 'detail_json'].includes(c[0].lower));
    const values = tokens.findIndex(t => !t.depth && isWord(t, 'VALUES'));
    if (detail >= 0) {
      if (values < 0) unsupported('audit INSERT requires VALUES');
      for (let i = values + 1; i < tokens.length; i++) if (isSymbol(tokens[i], '(') && !tokens[i].depth) {
        const end = tokens.findIndex((t, j) => j > i && isSymbol(t, ')') && !t.depth);
        const row = splitAtCommas(tokens.slice(i + 1, end), 1);
        if (row.length !== columns.length) unsupported('audit column/value count');
        auditValue(row[detail]); i = end;
      }
    }
  }
  if (relations[0]?.table === 'audit_logs' && operation === 'UPDATE') {
    const set = tokens.findIndex(t => !t.depth && isWord(t, 'SET'));
    const end = tokens.findIndex((t, i) => i > set && !t.depth && ['WHERE', 'ORDER', 'LIMIT'].some(w => isWord(t, w)));
    for (const assignment of splitAtCommas(tokens.slice(set + 1, end < 0 ? undefined : end), 0)) {
      const equals = assignment.findIndex(t => isSymbol(t, '='));
      const left = assignment.slice(0, equals);
      if (isColumn(left) && ['detail', 'detail_json'].includes(left.at(-1).lower)) auditValue(assignment.slice(equals + 1));
    }
  }
  let cursor = 0; plan.sql = '';
  for (const [token, text] of replacements) {
    plan.sql += sql.slice(cursor, token.start) + text; cursor = token.end;
  }
  plan.sql += sql.slice(cursor);
  return plan;
}

export function mysqlParams(plan, params) {
  const values = params.map(value => {
    if (typeof value !== 'string') return value;
    const timestamp = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/);
    if (!timestamp) return value;
    const fraction = timestamp[3] || '';
    if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3))) {
      throw new Error(`MySQL DATETIME(3) cannot preserve SQLite timestamp precision: ${value}`);
    }
    return `${timestamp[1]} ${timestamp[2]}${fraction ? `.${fraction.slice(0, 3)}` : ''}`;
  });
  for (const index of plan.auditParams) if (typeof values[index] === 'string') values[index] = JSON.stringify(values[index]);
  return values;
}

// Array rows preserve each column's origin even when a wildcard and an explicit
// physical-looking alias coexist. Object rows would lose one before restoration.
export function restoreMysqlRows(rows, fields, plan) {
  if (!Array.isArray(rows)) return rows;
  const descriptions = [];
  for (const projection of plan.projections || []) {
    const count = projection.wildcard ? fields.length - plan.projections.length + 1 : 1;
    for (let i = 0; i < count; i++) descriptions.push(projection);
  }
  return rows.map(values => Object.fromEntries(fields.map((field, index) => {
    const projection = descriptions[index];
    const table = field.orgTable;
    const logical = Object.entries(mappings[table] || {}).find(([, physical]) => physical === field.orgName)?.[0];
    const name = projection?.wildcard ? logical || field.name : projection?.name ?? field.name;
    let value = values[index];
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(value)) value = `${value.replace(' ', 'T')}Z`;
    if ((projection?.audit || projection?.wildcard && table === 'audit_logs' && logical === 'detail')
      && value !== null && typeof value === 'object') value = JSON.stringify(value);
    return [name, value];
  })));
}
