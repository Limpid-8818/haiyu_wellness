import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { runDataRetention, retentionTables, retentionSchemaTables } from '../../src/data-retention.js';

export const retentionNow = '2026-10-18T00:00:00.000Z';
const old = '2020-01-01T00:00:00.000Z', recent = '2099-01-01T00:00:00.000Z';
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
export async function retentionContract(database, onCase = async (_name, action) => action()) {
  const { db, transaction } = database;
  const cases = [];
  async function check(name, action) { await onCase(name, action); cases.push(name); }
  const user = crypto.randomUUID();
  await db.prepare('INSERT INTO users(id,username,password_hash,role,name,created_at) VALUES(?,?,?,?,?,?)')
    .run(user, `g42${user}`, 'synthetic-not-a-password', 'guest', 'G42 synthetic', old);
  const connection = { db, transaction, close: async () => {} };
  const invoke = (extra = {}) => runDataRetention({ config: { enabled: true, batchSize: 1000, ...extra.config },
    mode: extra.mode || 'preview', maintenance: true, clock: () => retentionNow,
    openDatabase: async () => extra.connection || connection });
  async function session(overrides = {}) {
    const row = { id: id('as'), status: 'closed', started_at: old, last_message_at: old, expires_at: old, ...overrides };
    await db.prepare(`INSERT INTO assistant_sessions(id,user_id,assistant_role,status,started_at,last_message_at,expires_at)
      VALUES(?,?,'guest',?,?,?,?)`).run(row.id, user, row.status, row.started_at, row.last_message_at, row.expires_at);
    return row.id;
  }
  async function run(sessionId, overrides = {}) {
    const row = { id: id('run'), status: 'completed', created_at: old, updated_at: old, completed_at: old, parent_run_id: null, ...overrides };
    await db.prepare(`INSERT INTO agent_runs(id,session_id,assistant_role,client_request_id,status,input_text,
      created_at,updated_at,completed_at,parent_run_id) VALUES(?,?,'guest',?,?,'synthetic',?,?,?,?)`)
      .run(row.id, sessionId, row.id, row.status, row.created_at, row.updated_at, row.completed_at, row.parent_run_id);
    return row.id;
  }
  async function message(sessionId, runId, createdAt = old) {
    return (await db.prepare("INSERT INTO assistant_messages(session_id,role,content,created_at,run_id) VALUES(?,'assistant','synthetic',?,?)")
      .run(sessionId, createdAt, runId)).lastInsertRowid;
  }
  async function detail(runId, status = 'completed') {
    const step = (await db.prepare(`INSERT INTO agent_steps(run_id,step_index,step_type,status,source_json,started_at,completed_at)
      VALUES(?,1,'tool',?,'[]',?,?)`).run(runId, status, old, old)).lastInsertRowid;
    const tool = id('tool');
    await db.prepare(`INSERT INTO tool_executions(id,run_id,step_id,tool_name,tool_call_id,idempotency_key,
      arguments_json,result_json,source_json,status,started_at,completed_at)
      VALUES(?,?,?,'synthetic',?,?,'{}','{}','[]','completed',?,?)`)
      .run(tool, runId, step, tool, crypto.createHash('sha256').update(tool).digest('hex'), old, old);
    return { step, tool };
  }
  async function graph(overrides = {}) {
    const s = await session(overrides.session), r = await run(s, overrides.run), d = await detail(r, overrides.stepStatus);
    await message(s, r, overrides.messageTime || old);
    return { s, r, ...d };
  }
  const exists = async (table, value) => Boolean(await db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(value));
  const total = report => Object.values(report.tables).reduce((sum, row) => sum + row.deleted, 0);
  async function allRows() {
    const result = {};
    for (const table of retentionSchemaTables) result[table] = await db.prepare(`SELECT * FROM ${table}`).all();
    return JSON.stringify(result);
  }
  let deletable;
  await check('preview preserves every application row and reports a genuinely deletable complete graph', async () => {
    deletable = await graph();
    const before = await allRows(), report = await invoke();
    assert.equal(await allRows(), before); assert.equal(report.status, 'PREVIEW');
    for (const table of ['assistant_sessions', 'agent_runs', 'agent_steps', 'tool_executions', 'assistant_messages']) assert.ok(report.tables[table].selected >= 1);
    assert.equal(total(report), 0);
  });
  await check('apply removes old unreferenced graphs in dependency order and repeats safely', async () => {
    const report = await invoke({ mode: 'apply' }); assert.equal(total(report), 5);
    assert.equal(await exists('assistant_sessions', deletable.s), false); assert.equal(await exists('agent_runs', deletable.r), false);
    assert.equal(total(await invoke({ mode: 'apply' })), 0);
  });
  await check('active, queued, running, running step, new child, new message and new update preserve whole graphs', async () => {
    const fixtures = [
      await graph({ session: { status: 'active', expires_at: recent } }),
      await graph({ run: { status: 'queued' } }), await graph({ run: { status: 'running' } }),
      await graph({ stepStatus: 'running' }), await graph({ messageTime: recent }), await graph({ run: { updated_at: recent } })
    ];
    const parent = await graph(), childSession = await session();
    const child = await run(childSession, { parent_run_id: parent.r, updated_at: recent });
    fixtures.push(parent); await invoke({ mode: 'apply' });
    for (const item of fixtures) { assert.equal(await exists('agent_runs', item.r), true); assert.equal(await exists('tool_executions', item.tool), true); }
    assert.equal(await exists('agent_runs', child), true);
  });
  await check('cutoff equality, later expiry and illegal/missing times are retained; strictly earlier expired active sessions delete', async () => {
    const cutoff = (await invoke()).cutoffs.runs;
    const equal = await graph({ session: { last_message_at: cutoff } });
    const noEnd = await graph({ run: { completed_at: null } });
    const later = await graph({ session: { expires_at: recent } });
    const invalid = db.driver === 'sqlite' ? await graph({ session: { last_message_at: '2020-02-30T00:00:00Z' } }) : null;
    const expired = await graph({ session: { status: 'active' } });
    await invoke({ mode: 'apply' });
    for (const item of [equal, noEnd, later, invalid].filter(Boolean)) assert.equal(await exists('agent_runs', item.r), true);
    assert.equal(await exists('agent_runs', expired.r), false);
  });
  await check('cross-session parent graph and message.run_id protect both sessions', async () => {
    const parent = await graph(), childSession = await session({ last_message_at: recent });
    await run(childSession, { parent_run_id: parent.r });
    const other = await graph(), messageSession = await session({ last_message_at: recent });
    await message(messageSession, other.r);
    await invoke({ mode: 'apply' });
    assert.equal(await exists('agent_runs', parent.r), true); assert.equal(await exists('assistant_sessions', other.s), true);
  });
  await check('fully old unreferenced cross-session parent and child graphs really delete together', async () => {
    const parent = await graph(), child = await graph();
    await db.prepare('UPDATE agent_runs SET parent_run_id=? WHERE id=?').run(parent.r, child.r);
    await message(child.s, parent.r);
    const report = await invoke({ mode: 'apply' }); assert.equal(total(report), 11);
    for (const value of [parent, child]) {
      assert.equal(await exists('assistant_sessions', value.s), false); assert.equal(await exists('agent_runs', value.r), false);
      assert.equal(await exists('tool_executions', value.tool), false);
    }
  });
  await check('health intakes, assessment progress, extraction and health records protect SET NULL sources', async () => {
    const fixtures = [await graph(), await graph(), await graph(), await graph()];
    await db.prepare("INSERT INTO health_intakes(guest_id,session_id,content,source,created_at,revision) VALUES(?,?,'synthetic','assistant',?,1)")
      .run(user, fixtures[0].s, old);
    await db.prepare("INSERT INTO health_assessment_progress(guest_id,answers_json,source_session_id,created_at,updated_at) VALUES(?,'{}',?,?,?)")
      .run(user, fixtures[1].s, old, old);
    await db.prepare(`INSERT INTO health_extraction_drafts(id,guest_id,session_id,request_fingerprint,source_text,candidates_json,execution_mode,created_at,updated_at)
      VALUES(?,?,?,?,'synthetic','[]','safe_guidance',?,?)`).run(id('extract'), user, fixtures[2].s, 'a'.repeat(64), old, old);
    await db.prepare(`INSERT INTO health_records(guest_id,record_type,value,recorded_at,recorded_by,source_session_id)
      VALUES(?,'weight','60',?,?,?)`).run(user, old, user, fixtures[3].s);
    await invoke({ mode: 'apply' });
    for (const item of fixtures) assert.equal(await exists('assistant_sessions', item.s), true);
  });
  async function draft({ sourceRun = null, evidence = {}, suffix = 1 } = {}) {
    const draftId = id('draft');
    await db.prepare(`INSERT INTO wellness_drafts(id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,evidence_json,created_at)
      VALUES(?,?,?,?,?,'2026-10-18','2026-10-20','pending_review','sampled_review',?,?)`)
      .run(draftId, user, suffix, draftId, sourceRun, JSON.stringify(evidence), old);
    return draftId;
  }
  await check('wellness direct FK, adoption JSON and item source/evidence JSON preserve parent and children', async () => {
    const direct = await graph(), adopted = await graph(), item = await graph(), nested = await graph();
    await draft({ sourceRun: direct.r, suffix: 1 });
    await draft({ evidence: { adoption: { sourceRunId: adopted.r, sessionId: adopted.s, selectedCandidateIds: ['synthetic'] } }, suffix: 2 });
    const d = await draft({ suffix: 3 });
    await db.prepare(`INSERT INTO wellness_draft_items(id,draft_id,business_date,slot_key,item_type,title,status,reason,rule_ids_json,source_ids_json,evidence_json)
      VALUES(?,?,'2026-10-18','synthetic','rest','synthetic','proposed','synthetic','[]',?,?)`)
      .run(id('item'), d, JSON.stringify([{ type: 'agent_run', id: item.r }]), JSON.stringify({ nested: [{ sourceAgentRunId: nested.r }] }));
    await invoke({ mode: 'apply' });
    for (const value of [direct, adopted, item, nested]) assert.equal(await exists('agent_runs', value.r), true);
  });
  await check('action-card CASCADE sources and parent-card lineage survive even for expired/superseded cards', async () => {
    const first = await graph(), second = await graph(), card = id('card'), child = id('card');
    async function add(cardId, fixture, parent, status) {
      await db.prepare(`INSERT INTO assistant_action_cards(id,logical_action_id,parent_card_id,guest_id,session_id,source_run_id,
        action_type,version,status,parameters_json,impact_json,missing_fields_json,basis_json,request_fingerprint,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'record_metric',1,?,'{}','{}','[]','{}',?,?,?)`)
        .run(cardId, cardId, parent, user, fixture.s, fixture.r, status, crypto.createHash('sha256').update(cardId).digest('hex'), old, old);
    }
    await add(card, first, null, 'superseded'); await add(child, second, card, 'expired');
    await invoke({ mode: 'apply' });
    assert.equal(await exists('agent_runs', first.r), true); assert.equal(await exists('agent_runs', second.r), true);
    assert.equal((await db.prepare('SELECT parent_card_id FROM assistant_action_cards WHERE id=?').get(child)).parent_card_id, card);
  });
  await check('audit target and prose/JSON sources preserve graphs; audit strategy independently deletes only routine login', async () => {
    const target = await graph(), prose = await graph(), json = await graph();
    await db.prepare('INSERT INTO audit_logs(action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?)')
      .run('wellness_draft.adopt', 'agent_run', target.r, 'synthetic', old);
    await db.prepare('INSERT INTO audit_logs(action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?)')
      .run('wellness_draft.create', 'wellness_draft', 'synthetic', `来源运行 ${prose.r}`, old);
    await db.prepare('INSERT INTO audit_logs(action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?)')
      .run('unknown', '', '', JSON.stringify({ evidence: { sourceRunId: json.r } }), old);
    const login = (await db.prepare('INSERT INTO audit_logs(action,target_type,target_id,detail,created_at) VALUES(?,?,?,?,?)')
      .run('login', 'user', user, 'synthetic', old)).lastInsertRowid;
    const before = await invoke({ mode: 'apply' }); assert.equal(before.tables.audit_logs.deleted, 0);
    assert.equal(await exists('audit_logs', login), true);
    const after = await invoke({ mode: 'apply', config: { auditEnabled: true } }); assert.equal(after.tables.audit_logs.deleted, 1);
    assert.equal(await exists('audit_logs', login), false);
    for (const item of [target, prose, json]) assert.equal(await exists('agent_runs', item.r), true);
  });
  await check('preview is not authorization: a reference inserted afterwards is re-read by apply', async () => {
    const value = await graph(); const preview = await invoke(); assert.ok(preview.tables.agent_runs.selected >= 1);
    await draft({ evidence: { sourceRunId: value.r }, suffix: 4 });
    await invoke({ mode: 'apply' }); assert.equal(await exists('agent_runs', value.r), true);
  });
  await check('failure after tool deletion rolls every graph row back and the next apply succeeds', async () => {
    const value = await graph(); const before = await allRows(); let deletions = 0;
    const faulty = { ...connection, db: { driver: db.driver, prepare(sql) {
      const statement = db.prepare(sql);
      if (!sql.startsWith('DELETE')) return statement;
      return { ...statement, run: async (...args) => { if (++deletions === 2) throw new Error('G42 injected write failure'); return statement.run(...args); } };
    } } };
    await assert.rejects(invoke({ mode: 'apply', connection: faulty }), /injected write failure/);
    assert.ok(deletions >= 2); assert.equal(await allRows(), before);
    assert.equal(total(await invoke({ mode: 'apply' })), 5); assert.equal(await exists('agent_runs', value.r), false);
  });
  await check('bounded batches skip whole oversized groups and can delete smaller old groups', async () => {
    const large = await graph(), small = await session();
    const report = await invoke({ mode: 'apply', config: { batchSize: 1 } });
    assert.equal(total(report), 1); assert.equal(await exists('assistant_sessions', small), false);
    assert.equal(await exists('agent_runs', large.r), true);
    assert.ok(report.tables.agent_runs.reasons['batch-budget-exceeded'] >= 1);
    const groupBound = await invoke({ config: { groupRows: 4 } });
    assert.ok(groupBound.tables.agent_runs.reasons['group-budget-exceeded'] >= 1);
    await invoke({ mode: 'apply' });
  });
  await check('scan row/byte budgets fail before writes and leave every row intact', async () => {
    await graph(); const before = await allRows();
    for (const config of [{ scanRows: 1 }, { scanBytes: 1 }]) await assert.rejects(invoke({ mode: 'apply', config }), /RETENTION_INCOMPLETE/);
    assert.equal(await allRows(), before); await invoke({ mode: 'apply' });
  });
  await check('mood events delete only old unreferenced rows; typed JSON protects referenced event IDs', async () => {
    async function event(playedAt) {
      return (await db.prepare('INSERT INTO mood_resource_events(guest_id,resource_id,event_id,played_at) VALUES(?,?,?,?)')
        .run(user, 'synthetic-resource', crypto.randomUUID(), playedAt)).lastInsertRowid;
    }
    const remove = await event(old), keep = await event(recent), referenced = await event(old);
    await draft({ evidence: { type: 'mood_resource_event', id: Number(referenced) }, suffix: 5 });
    const report = await invoke({ mode: 'apply' }); assert.equal(report.tables.mood_resource_events.deleted, 1);
    assert.equal(await exists('mood_resource_events', remove), false); assert.equal(await exists('mood_resource_events', keep), true);
    assert.equal(await exists('mood_resource_events', referenced), true);
  });
  await check('typed numeric references protect step/message IDs without confusing other tables', async () => {
    const value = await graph(), other = await graph();
    const msg = await message(value.s, value.r);
    await draft({ evidence: { refs: [{ type: 'agent_step', id: Number(value.step) }, { type: 'assistant_message', id: Number(msg) }] }, suffix: 6 });
    await invoke({ mode: 'apply' }); assert.equal(await exists('agent_runs', value.r), true); assert.equal(await exists('agent_runs', other.r), false);
  });
  await check('invalid JSON and excessive nesting stop apply with no partial deletions', async () => {
    const value = await graph(), d = await draft({ suffix: 7 });
    if (db.driver === 'sqlite') {
      await db.prepare('UPDATE wellness_drafts SET evidence_json=? WHERE id=?').run('{broken', d);
      const before = await allRows(); await assert.rejects(invoke({ mode: 'apply' }), /invalid JSON/); assert.equal(await allRows(), before);
    }
    let payload = { sourceRunId: value.r }; for (let i = 0; i < 34; i++) payload = { next: payload };
    await db.prepare('UPDATE wellness_drafts SET evidence_json=? WHERE id=?').run(JSON.stringify(payload), d);
    const before = await allRows(); await assert.rejects(invoke({ mode: 'apply' }), /traversal budget/); assert.equal(await allRows(), before);
    await db.prepare('UPDATE wellness_drafts SET evidence_json=? WHERE id=?').run('{}', d); await invoke({ mode: 'apply' });
  });
  await check('dangling non-FK parent protects source instead of guessing complete graph', async () => {
    const value = await graph({ run: { parent_run_id: id('run') } });
    const report = await invoke({ mode: 'apply' });
    assert.equal(await exists('agent_runs', value.r), true); assert.ok(report.tables.agent_runs.reasons['unresolved-graph-reference'] >= 1);
  });
  await check('schema drift refuses maintenance instead of missing future business references', async () => {
    const before = await allRows();
    await db.exec('CREATE TABLE g42_unreviewed_source (id INTEGER PRIMARY KEY)');
    await assert.rejects(invoke({ mode: 'apply' }), /schema table set/);
    await db.exec('DROP TABLE g42_unreviewed_source'); assert.equal(await allRows(), before);
  });
  await check('remaining graph children and every real FK retain their parents', async () => {
    for (const [child, column, parent] of [['agent_runs', 'session_id', 'assistant_sessions'], ['agent_steps', 'run_id', 'agent_runs'],
      ['tool_executions', 'run_id', 'agent_runs'], ['assistant_messages', 'session_id', 'assistant_sessions']]) {
      const count = await db.prepare(`SELECT COUNT(*) AS n FROM ${child} AS c LEFT JOIN ${parent} AS p ON p.id=c.${column} WHERE p.id IS NULL`).get();
      assert.equal(Number(count.n), 0, `${child} dangling after maintenance`);
    }
    if (db.driver === 'sqlite') assert.deepEqual(await db.prepare('PRAGMA foreign_key_check').all(), []);
    else {
      const keys = await db.prepare(`SELECT TABLE_NAME AS child,COLUMN_NAME AS childColumn,
        REFERENCED_TABLE_NAME AS parent,REFERENCED_COLUMN_NAME AS parentColumn FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`).all();
      for (const key of keys) {
        assert.ok(retentionSchemaTables.includes(key.child) && retentionSchemaTables.includes(key.parent));
        assert.match(key.childColumn, /^[a-z_]+$/); assert.match(key.parentColumn, /^[a-z_]+$/);
        const count = await db.prepare(`SELECT COUNT(*) AS n FROM ${key.child} AS c LEFT JOIN ${key.parent} AS p
          ON p.${key.parentColumn}=c.${key.childColumn} WHERE c.${key.childColumn} IS NOT NULL AND p.${key.parentColumn} IS NULL`).get();
        assert.equal(Number(count.n), 0, `FK ${key.child}.${key.childColumn}`);
      }
    }
  });
  return { driver: db.driver, passed: cases.length, cases, final: await invoke(), targetTables: retentionTables };
}
