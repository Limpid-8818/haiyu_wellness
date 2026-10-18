import assert from 'node:assert/strict';

// The very same assertions run against an in-memory SQLite and the managed MySQL fixture.
export async function sqlDialectContract({ db, transaction, isUniqueViolation, driver }) {
  const checks = [];
  async function check(name, action) { await action(); checks.push(name); }
  const stamp = '2030-01-02T03:04:05.123Z';
  const text = `中文 FROM health_intakes content status JOIN assistant_messages role, ? ' " \\ avatar cover detail value`;
  await check('seven logical tables: INSERT/get/all/UPDATE and explicit output aliases', async () => {
    const user = await db.prepare('INSERT INTO users(id,username,password_hash,role,name,avatar,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('g23-user', 'g23-user', 'synthetic-only', 'guest', 'G23 synthetic', text, stamp);
    assert.equal(user.changes, 1);
    await db.prepare(`INSERT INTO guest_profiles(user_id,check_in,check_out,chronic_json,allergies_json)
      VALUES(?,?,?,?,?)`).run('g23-user', '2030-01-01', '2030-01-03', '[]', '[]');
    await db.prepare(`INSERT INTO health_records(guest_id,record_type,value,recorded_at,recorded_by)
      VALUES(?,?,?,?,?)`).run('g23-user', '合成', text, stamp, 'g23-user');
    const news = await db.prepare('INSERT INTO news(category,title,summary,body,cover,published_at) VALUES(?,?,?,?,?,?)')
      .run('合成', 'G23', text, text, text, stamp);
    assert.ok(news.lastInsertRowid > 0); assert.equal(news.changes, 1);
    await db.prepare('INSERT INTO audit_logs(actor_id,action,detail,created_at) VALUES(?,?,?,?)').run('g23-user', 'g23', text, stamp);
    await db.prepare(`INSERT INTO assistant_sessions(id,user_id,assistant_role,started_at,last_message_at,expires_at)
      VALUES(?,?,?,?,?,?)`).run('g23-session', 'g23-user', 'guest', stamp, stamp, stamp);
    await db.prepare('INSERT INTO assistant_messages(session_id,user_id,role,content,created_at) VALUES(?,?,?,?,?)')
      .run('g23-session', 'g23-user', 'user', text, stamp);
    await db.prepare('INSERT INTO health_intakes(guest_id,content,status,created_at) VALUES(?,?,?,?)')
      .run('g23-user', text, 'pending', stamp);
    for (const [table, column, value, next] of [
      ['users', 'avatar', text, text + '2'], ['guest_profiles', 'check_in', '2030-01-01', '2030-01-02'],
      ['guest_profiles', 'check_out', '2030-01-03', '2030-01-04'], ['health_records', 'value', text, text + '2'],
      ['news', 'cover', text, text + '2'], ['audit_logs', 'detail', text, text + '2'],
      ['assistant_messages', 'role', 'user', 'assistant'], ['health_intakes', 'content', text, text + '2'],
      ['health_intakes', 'status', 'pending', 'confirmed']
    ]) {
      assert.deepEqual({ ...await db.prepare(`SELECT ${column} FROM ${table}`).get() }, { [column]: value });
      assert.deepEqual((await db.prepare(`SELECT ${column} AS output_name FROM ${table}`).all()).map(row => ({ ...row })), [{ output_name: value }]);
      assert.equal((await db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${column}=?`).run(next, value)).changes, 1);
      assert.equal((await db.prepare(`SELECT ${column} FROM ${table}`).get())[column], next);
    }
  });
  await check('qualified multi-mapping JOIN preserves users.role and message role independently', async () => {
    const row = await db.prepare(`SELECT u.role AS userRole,m.role,i.status,i.content,g.check_in,g.check_out,u.avatar
      FROM users u JOIN assistant_messages m ON m.user_id=u.id JOIN health_intakes i ON i.guest_id=u.id
      JOIN guest_profiles g ON g.user_id=u.id WHERE u.id=?`).get('g23-user');
    assert.deepEqual({ ...row }, { userRole: 'guest', role: 'assistant', status: 'confirmed', content: text + '2',
      check_in: '2030-01-02', check_out: '2030-01-04', avatar: text + '2' });
  });
  await check('wildcards restore logical names and preserve physical-looking explicit aliases', async () => {
    const row = await db.prepare('SELECT u.*,u.avatar AS avatar_url FROM users u WHERE u.id=?').get('g23-user');
    assert.equal(row.avatar, text + '2'); assert.equal(row.avatar_url, text + '2');
    for (const [table, logical, physical] of [['guest_profiles', 'check_in', 'check_in_date'], ['health_records', 'value', 'value_text'],
      ['news', 'cover', 'cover_url'], ['audit_logs', 'detail', 'detail_json'], ['assistant_messages', 'role', 'sender_role'],
      ['health_intakes', 'content', 'raw_content']]) {
      const result = await db.prepare(`SELECT * FROM ${table}`).get();
      assert.ok(Object.hasOwn(result, logical), `${table}.${logical}`); assert.equal(Object.hasOwn(result, physical), false);
    }
    const aliases = await db.prepare('SELECT avatar AS avatar_url,avatar FROM users').get();
    assert.deepEqual({ ...aliases }, { avatar_url: text + '2', avatar: text + '2' });
    assert.deepEqual({ ...await db.prepare("SELECT COALESCE(avatar,'FROM assistant_messages role') AS avatar_url FROM users").get() },
      { avatar_url: text + '2' });
  });
  await check('literal fake table clauses and comments do not affect result keys or byte values', async () => {
    const row = await db.prepare(`SELECT 'FROM health_intakes status content JOIN assistant_messages role ?, ''avatar''' AS avatar_url,
      avatar /* FROM news cover ? */ FROM users WHERE id=? -- JOIN audit_logs detail
    `).get('g23-user');
    assert.deepEqual({ ...row }, { avatar_url: "FROM health_intakes status content JOIN assistant_messages role ?, 'avatar'", avatar: text + '2' });
    const only = await db.prepare("SELECT 'FROM audit_logs detail JOIN health_intakes status' AS detail_json").get();
    assert.deepEqual({ ...only }, { detail_json: 'FROM audit_logs detail JOIN health_intakes status' });
    const punctuation = await db.prepare("SELECT ',' AS a,')' AS b,';' AS c,avatar FROM users").get();
    assert.deepEqual({ ...punctuation }, { a: ',', b: ')', c: ';', avatar: text + '2' });
  });
  await check('audit JSON strings and commas/quoted placeholders bind to the actual detail parameter', async () => {
    for (const detail of [text, '{"nested":[1,"x"]}', '"quoted"', 'null', '']) {
      const inserted = await db.prepare(`INSERT INTO audit_logs(action,target_id,detail,created_at)
        VALUES('literal?, comma, FROM users avatar',NULL,?,?)`).run(detail, stamp);
      const row = await db.prepare('SELECT detail AS detail_json,detail,created_at FROM audit_logs WHERE id=?').get(inserted.lastInsertRowid);
      assert.deepEqual({ ...row }, { detail_json: detail, detail, created_at: stamp });
    }
  });
  await check('real UTC values and bound pseudo-SQL retain parameter/result contracts', async () => {
    assert.equal((await db.prepare('SELECT recorded_at FROM health_records').get()).recorded_at, stamp);
    assert.equal((await db.prepare('SELECT created_at FROM users').get()).created_at, stamp);
    assert.equal((await db.prepare('SELECT avatar FROM users WHERE avatar=?').get(text + '2')).avatar, text + '2');
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM users').get()).count, 1);
  });
  await check('unique/FK errors remain distinct and failed transactions roll back', async () => {
    const duplicate = await db.prepare('INSERT INTO users(id,username,password_hash,role,name) VALUES(?,?,?,?,?)')
      .run('g23-other', 'g23-user', 'x', 'guest', 'x').then(() => null, e => e);
    assert.ok(duplicate); assert.equal(isUniqueViolation(duplicate), true);
    const foreignKey = await db.prepare('INSERT INTO guest_profiles(user_id,chronic_json,allergies_json) VALUES(?,?,?)')
      .run('g23-missing', '[]', '[]').then(() => null, e => e);
    assert.ok(foreignKey); assert.equal(isUniqueViolation(foreignKey), false);
    assert.ok(foreignKey.errcode === 787 || foreignKey.errno === 1452, foreignKey.message);
    await assert.rejects(transaction(async () => {
      await db.prepare('UPDATE users SET avatar=? WHERE id=?').run('must roll back', 'g23-user');
      throw new Error('g23 injected rollback');
    }), /g23 injected rollback/);
    assert.equal((await db.prepare('SELECT avatar FROM users').get()).avatar, text + '2');
    await transaction(async () => {
      const lock = driver === 'mysql' ? ' FOR UPDATE' : '';
      assert.equal((await db.prepare(`SELECT check_in FROM guest_profiles WHERE user_id=?${lock}`).get('g23-user')).check_in, '2030-01-02');
      await db.prepare('UPDATE users SET avatar=? WHERE id=?').run(text, 'g23-user');
    });
    assert.equal((await db.prepare('SELECT avatar FROM users').get()).avatar, text);
  });
  await check('DELETE uses logical mapped predicates without touching pseudo-SQL parameters', async () => {
    assert.equal((await db.prepare('DELETE FROM health_intakes WHERE content=? AND status=?').run(text + '2', 'confirmed')).changes, 1);
    assert.deepEqual(await db.prepare('SELECT content,status FROM health_intakes').all(), []);
  });
  // Precision rejection is a MySQL boundary; SQLite intentionally retains the text exactly.
  const highPrecision = '2030-01-02T03:04:05.123001Z';
  if (driver === 'mysql') await check('MySQL rejects unrepresentable timestamp precision before query', async () => {
    await assert.rejects(db.prepare('UPDATE users SET created_at=? WHERE id=?').run(highPrecision, 'g23-user'), /cannot preserve/);
    assert.equal((await db.prepare('SELECT created_at FROM users').get()).created_at, stamp);
  });
  else await check('SQLite retains timestamp text precision', async () => {
    assert.equal((await db.prepare('SELECT ? AS stamp').get(highPrecision)).stamp, highPrecision);
  });
  return { driver, checks, passed: checks.length, failed: 0, skipped: 0 };
}
