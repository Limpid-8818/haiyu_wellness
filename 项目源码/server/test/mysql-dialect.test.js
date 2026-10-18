import test from 'node:test';
import assert from 'node:assert/strict';
import { compileMysqlStatement as compile, mysqlParams, restoreMysqlRows, tokenizeSql } from '../src/mysql-dialect.js';

test('quoted values, escapes, comments and fake table clauses remain byte-identical', () => {
  const text = `SELECT avatar, 'FROM health_intakes status content role ? , ''avatar''' AS value_text,
    "JOIN assistant_messages role \\\" cover" AS cover_url FROM users
    /* JOIN health_records value, ? */ WHERE name='FROM' -- JOIN news cover
    AND avatar=? # FROM audit_logs detail
  `;
  assert.equal(compile(text).sql, text.replace('SELECT avatar,', 'SELECT avatar_url,').replace('AND avatar=?', 'AND avatar_url=?'));
  assert.equal(tokenizeSql(text).filter(t => t.kind === 'symbol' && t.value === '?').length, 1);
  assert.equal(compile("SELECT 'FROM users avatar' AS avatar_url").sql, "SELECT 'FROM users avatar' AS avatar_url");
});
for (const [table, fields] of Object.entries({
  guest_profiles: ['check_in', 'check_out'], health_records: ['value'], users: ['avatar'], news: ['cover'],
  audit_logs: ['detail'], assistant_messages: ['role'], health_intakes: ['content', 'status']
})) test(`identifiers for ${table} support quoted aliases and do not match prefixes`, () => {
  const physical = { check_in: 'check_in_date', check_out: 'check_out_date', value: 'value_text', avatar: 'avatar_url',
    cover: 'cover_url', detail: 'detail_json', role: 'sender_role', content: 'raw_content', status: 'review_status' };
  for (const field of fields) {
    assert.equal(compile(`SELECT t.\`${field}\` AS \`${field}\`,t.${field}_extra FROM \`${table}\` AS t WHERE t.\`${field}\`=?`).sql,
      `SELECT t.\`${physical[field]}\` AS \`${field}\`,t.${field}_extra FROM \`${table}\` AS t WHERE t.\`${physical[field]}\`=?`);
    assert.equal(compile(`UPDATE ${table} SET ${field}=? WHERE id=?`).sql, `UPDATE ${table} SET ${physical[field]}=? WHERE id=?`);
    assert.equal(compile(`DELETE FROM ${table} WHERE ${field}=?`).sql, `DELETE FROM ${table} WHERE ${physical[field]}=?`);
  }
});
test('JOIN ownership and output aliases are independent, including ORDER BY output', () => {
  assert.equal(compile(`SELECT u.role,m.role AS role,i.content,i.status,u.avatar AS status FROM users u
    JOIN assistant_messages m ON m.user_id=u.id JOIN health_intakes i ON i.guest_id=u.id ORDER BY status`).sql,
  `SELECT u.role,m.sender_role AS role,i.raw_content,i.review_status,u.avatar_url AS status FROM users u
    JOIN assistant_messages m ON m.user_id=u.id JOIN health_intakes i ON i.guest_id=u.id ORDER BY status`);
  assert.throws(() => compile('SELECT role FROM users u JOIN assistant_messages m ON m.user_id=u.id'), /qualify column role/);
});
test('bounded syntax rejects ambiguity and never interprets executable comments as inert text', () => {
  for (const sql of ['SELECT avatar FROM users,news', 'SELECT avatar FROM users UNION SELECT avatar FROM users',
    'SELECT avatar FROM users WHERE id IN (SELECT id FROM users)', 'SELECT avatar a FROM users',
    'SELECT u.*,n.* FROM users u JOIN news n ON 1=1', 'SELECT * FROM users NATURAL JOIN news',
    'SELECT * FROM users; DELETE FROM users', 'SELECT /*! avatar */ 1', "SELECT 'unterminated"]) {
    assert.throws(() => compile(sql), /Unsupported MySQL logical SQL/, sql);
  }
});
test('audit parameter ordinals follow VALUES expressions rather than column indexes or text matches', () => {
  const plan = compile(`INSERT IGNORE INTO audit_logs(action,detail,created_at,target_id)
    VALUES('question?, comma, FROM health_intakes status',?,? ,NULL),(?, ?,?,?)`);
  assert.deepEqual(plan.auditParams, [0, 3]);
  const params = ['"原文"', '2030-01-02T03:04:05.123Z', 'action', '{"a":1}', '2030-01-02T03:04:05Z', '?'];
  assert.deepEqual(mysqlParams(plan, params), [JSON.stringify(params[0]), '2030-01-02 03:04:05.123', 'action',
    JSON.stringify(params[3]), '2030-01-02 03:04:05', '?']);
  assert.deepEqual(mysqlParams(compile('UPDATE audit_logs SET action=?,detail=? WHERE id=?'), ['x', 'hello', 2]), ['x', '"hello"', 2]);
  assert.deepEqual(compile("INSERT INTO news(title,body) VALUES('INSERT INTO audit_logs(detail) VALUES(?)',?)").auditParams, []);
  assert.throws(() => compile("INSERT INTO audit_logs(detail) VALUES('literal')"), /bind audit detail/);
});
test('timestamp precision is preserved or rejected before binding and never mutates input parameters', () => {
  const plan = compile('SELECT ? AS t');
  const params = ['2030-01-02T03:04:05.123000Z'];
  assert.deepEqual(mysqlParams(plan, params), ['2030-01-02 03:04:05.123']);
  assert.equal(params[0], '2030-01-02T03:04:05.123000Z');
  assert.throws(() => mysqlParams(plan, ['2030-01-02T03:04:05.123001Z']), /cannot preserve/);
});
test('wildcard fields and physical-looking explicit aliases coexist by position without deleting either key', () => {
  const fields = [{ name: 'id', orgName: 'id', orgTable: 'users' },
    { name: 'avatar_url', orgName: 'avatar_url', orgTable: 'users' },
    { name: 'avatar_url', orgName: 'avatar_url', orgTable: 'users' }];
  assert.deepEqual(restoreMysqlRows([['u', 'original', 'explicit']], fields,
    compile('SELECT u.*,u.avatar AS avatar_url FROM users u')), [{ id: 'u', avatar: 'original', avatar_url: 'explicit' }]);
  assert.deepEqual(restoreMysqlRows([['explicit', 'logical']], fields.slice(1),
    compile('SELECT avatar AS avatar_url,avatar FROM users')), [{ avatar_url: 'explicit', avatar: 'logical' }]);
  assert.deepEqual(restoreMysqlRows([['{"x":1}', { x: 1 }]], [
    { name: 'detail_json', orgName: '', orgTable: '' }, { name: 'detail_json', orgName: 'detail_json', orgTable: 'audit_logs' }
  ], compile("SELECT '{\"x\":1}' AS detail_json,detail FROM audit_logs")), [{ detail_json: '{"x":1}', detail: '{"x":1}' }]);
});
test('physical migration metadata SQL is untouched by string table names', () => {
  const sql = `SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='health_intakes' AND COLUMN_NAME='status'`;
  assert.equal(compile(sql).sql, sql);
});
test('computed projections require an explicit AS when their identifiers change', () => {
  for (const sql of ["SELECT COALESCE(avatar,'') FROM users", 'SELECT MAX(value) FROM health_records',
    "SELECT CONCAT('avatar',avatar) label FROM users"]) assert.throws(() => compile(sql), /use AS/);
  assert.equal(compile("SELECT COALESCE(avatar,'') AS avatar_url FROM users").sql,
    "SELECT COALESCE(avatar_url,'') AS avatar_url FROM users");
  assert.throws(() => compile('SELECT (SELECT avatar FROM users) AS x FROM schema_migrations'), /nested mapped/);
  assert.throws(() => compile('WITH u AS (SELECT avatar FROM users) SELECT * FROM u'), /single-layer DML/);
});
test('literal punctuation does not become SQL punctuation or projection boundaries', () => {
  const sql = `SELECT ',',')',';','*','?' AS x,avatar FROM users WHERE name='FROM'`;
  assert.equal(compile(sql).sql, sql.replace(',avatar FROM', ',avatar_url FROM'));
  assert.equal(compile(sql).projections.length, 6);
});
test('actual FOR UPDATE and the native environment upsert keep their original clause semantics', () => {
  assert.equal(compile('SELECT user_id,check_in FROM guest_profiles WHERE user_id=? FOR UPDATE').sql,
    'SELECT user_id,check_in_date FROM guest_profiles WHERE user_id=? FOR UPDATE');
  const sql = `INSERT INTO environment_snapshots(snapshot_key,payload_json) VALUES(?,?)
    ON DUPLICATE KEY UPDATE snapshot_key=VALUES(snapshot_key)`;
  assert.equal(compile(sql).sql, sql);
});
