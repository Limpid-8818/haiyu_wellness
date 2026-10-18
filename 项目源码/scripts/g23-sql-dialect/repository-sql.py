#!/usr/bin/env python3
"""Extract current prepared SQL literals without executing application modules.

Dynamic fragments use explicit representative expansions. This checks adapter
compatibility of the corpus, not execution of every business query or SQL typing.
Unknown template fragments fail rather than disappearing from the review.
"""
import argparse, json, re, signal
from pathlib import Path
signal.alarm(30)
p = argparse.ArgumentParser(); p.add_argument('--out', required=True); a = p.parse_args()
root = Path(__file__).resolve().parents[2]
records = []

def quoted(s, start):
    quote = s[start]; i = start + 1; parts = []
    while i < len(s):
        if s[i] == '\\':
            char = s[i + 1]
            parts.append({'n':'\n', 'r':'\r', 't':'\t'}.get(char, char)); i += 2
        elif quote == '`' and s.startswith('${', i):
            begin = i + 2; i = begin; depth = 1
            while depth:
                if s[i] in "'\"`": _, i = quoted(s, i); continue
                if s[i] == '{': depth += 1
                if s[i] == '}': depth -= 1
                i += 1
            parts.append(('expression', s[begin:i - 1]))
        elif s[i] == quote: return parts, i + 1
        else: parts.append(s[i]); i += 1
    raise ValueError('unterminated JavaScript literal')

constants = {}
for file, name in [('health-metrics.js', 'RECORD_SELECT'), ('authorization.js', 'ACTIVE_GUEST_SQL'),
                   ('authorization.js', 'ACTIVE_GUEST_USER_SQL')]:
    source = (root/'server/src'/file).read_text()
    match = re.search(r'const '+name+r'\s*=\s*([\x27"`])', source)
    constants[name] = ''.join(quoted(source, match.end() - 1)[0])

def expand(expression):
    if expression in constants: return constants[expression]
    if 'mysqlLockSuffix()' in expression: return ' FOR UPDATE'
    if expression in ['likeEscapeClause()', 'matchEsc']: return " ESCAPE '\\\\'"
    if expression in ['placeholders', 'intakePlaceholders', 'itemPlaceholders'] or ".map(() => '?').join(',')" in expression: return '?,?,?'
    if expression == 'ignoreClause': return 'IGNORE'
    if expression == 'quoteIdentifier(table)': return '`users`'
    if expression == 'ordering': return ' ORDER BY id'
    if expression == 'where' or expression in ["where.join(' AND ')", "countWhere.join(' AND ')", "filters.join(' AND ')"]: return '1=1'
    if expression == "updates.join(',')": return 'name=?,updated_at=?'
    if expression == 'targetFilter': return ' AND target_id IN (?,?,?)'
    if expression == 'projectFilter': return ' AND s.project_id=?'
    if expression == "where.length ? `WHERE ${where.join(' AND ')}` : ''": return 'WHERE 1=1'
    conditionals = {
        "includeRetracted ? '' : 'AND r.voided_at IS NULL'": 'AND r.voided_at IS NULL',
        "guestId === undefined ? '' : 'AND s.related_guest_id=?'": 'AND s.related_guest_id=?',
        "includeInactive ? '' : ' AND active=1'": ' AND active=1',
        "mealType ? 'AND o.meal_type=? ' : ''": 'AND o.meal_type=? ',
        '''pendingOnly ? "AND h.status='pending'" : '' ''': "AND h.status='pending'"
    }
    if expression.strip() in {k.strip(): v for k, v in conditionals.items()}: return {k.strip(): v for k, v in conditionals.items()}[expression.strip()]
    raise ValueError('unreviewed interpolation: '+expression)

for file in sorted((root/'server/src').rglob('*.js')):
    source = file.read_text()
    for match in re.finditer(r'\b(?:db|database)\.prepare\(\s*([\x27"`])', source):
        parts, end = quoted(source, match.end() - 1)
        sql = ''.join(expand(part[1]) if isinstance(part, tuple) else part for part in parts)
        records.append(dict(file=str(file.relative_to(root)), line=source[:match.start()].count('\n') + 1,
                            sql=sql, fragments=[part[1] for part in parts if isinstance(part, tuple)]))
    # These are the actual variable-based MySQL queries used by prepare.
    for name in (['projectInsert', 'knowledgeInsert', 'ruleInsert'] if file == root/'server/src/catalog-seed.js' else
                 ['mysqlSql'] if file == root/'server/src/environment.js' else []):
        match = re.search(r'const '+name+r'\s*=\s*`', source)
        parts, end = quoted(source, match.end() - 1)
        records.append(dict(file=str(file.relative_to(root)), line=source[:match.start()].count('\n') + 1,
                            sql=''.join(expand(part[1]) if isinstance(part, tuple) else part for part in parts),
                            variable=name))
with Path(a.out).open('x') as f: json.dump(records, f, ensure_ascii=False, indent=2); f.write('\n')
print(json.dumps(dict(statements=len(records), out=a.out), ensure_ascii=False))
