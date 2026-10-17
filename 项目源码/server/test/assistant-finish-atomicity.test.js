import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '0',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0'
});
const { db, transaction } = await import('../src/db.js');
const { finishRun } = await import('../src/assistant-run.js');
test.after(async () => { await db.close(); });

const originalStamp = '2026-01-01T00:00:00.000Z';
const completion = {
  status: 'completed', output: '离线合成最终回复', executionMode: 'recorded_fixture',
  model: 'synthetic-model', provider: 'synthetic-provider',
  inputTokens: 23, outputTokens: 7, estimatedCost: 0.000123
};

async function fixture() {
  const sessionId = `as_${crypto.randomUUID()}`;
  const runId = `run_${crypto.randomUUID()}`;
  await db.prepare(`INSERT INTO assistant_sessions
    (id,assistant_role,started_at,last_message_at,expires_at,mode,model_name)
    VALUES(?,'public',?,?,?,'safe_guidance','previous-model')`)
    .run(sessionId, originalStamp, originalStamp, '2099-01-01T00:00:00.000Z');
  await db.prepare(`INSERT INTO agent_runs
    (id,session_id,assistant_role,client_request_id,status,input_text,created_at,updated_at)
    VALUES(?,?,'public',?,'running','离线合成请求',?,?)`)
    .run(runId, sessionId, crypto.randomUUID(), originalStamp, originalStamp);
  await db.prepare(`INSERT INTO assistant_messages(session_id,role,content,created_at,run_id)
    VALUES(?,'user','离线合成请求',?,?)`).run(sessionId, originalStamp, runId);
  return { sessionId, runId };
}

async function snapshot({ sessionId, runId }) {
  return {
    run: await db.prepare('SELECT * FROM agent_runs WHERE id=?').get(runId),
    session: await db.prepare('SELECT * FROM assistant_sessions WHERE id=?').get(sessionId),
    messages: await db.prepare('SELECT * FROM assistant_messages WHERE session_id=? ORDER BY id').all(sessionId)
  };
}

function assertReplyProjection(state, result, expected) {
  assert.deepEqual(result, state.run, 'return the persisted terminal run');
  assert.equal(state.run.status, expected.status);
  assert.equal(state.run.output_text, expected.output);
  assert.equal(state.run.error_code, expected.errorCode ?? null);
  assert.equal(state.run.stop_reason, expected.stopReason);
  assert.equal(state.run.execution_mode, expected.executionMode);
  assert.equal(state.run.is_live, 0, 'offline fixture must not be marked live');
  assert.equal(state.run.model_name, expected.model ?? null);
  assert.equal(state.run.provider, expected.provider ?? null);
  assert.equal(state.run.input_tokens, expected.inputTokens ?? 0);
  assert.equal(state.run.output_tokens, expected.outputTokens ?? 0);
  assert.equal(state.run.estimated_cost_usd, expected.estimatedCost ?? 0);
  assert.notEqual(state.run.completed_at, originalStamp);
  assert.equal(state.run.updated_at, state.run.completed_at);
  assert.equal(state.messages.length, 2, 'preserve user message and add exactly one final reply');
  const reply = state.messages[1];
  assert.equal(reply.role, 'assistant');
  assert.equal(reply.run_id, state.run.id);
  assert.equal(reply.session_id, state.session.id);
  assert.equal(reply.user_id, state.run.actor_id);
  assert.equal(reply.content, expected.output);
  assert.equal(reply.created_at, state.run.completed_at);
  assert.equal(state.session.last_message_at, state.run.completed_at);
  assert.equal(state.session.mode, state.run.execution_mode);
  assert.equal(state.session.model_name, state.run.model_name);
}

test('G41: successful completion persists usage, final reply and session projection together', async () => {
  const ids = await fixture();
  const result = await finishRun(ids.runId, completion);
  assertReplyProjection(await snapshot(ids), result, { ...completion, stopReason: 'RESPONSE_COMPLETED' });
});

test('G41: empty failed output updates only the run and preserves the session and messages', async () => {
  const ids = await fixture();
  const before = await snapshot(ids);
  const result = await finishRun(ids.runId, {
    status: 'failed', output: '', errorCode: 'MODEL_NOT_CONFIGURED', inputTokens: 5
  });
  const after = await snapshot(ids);
  assert.deepEqual(result, after.run);
  assert.equal(after.run.status, 'failed');
  assert.equal(after.run.output_text, '');
  assert.equal(after.run.error_code, 'MODEL_NOT_CONFIGURED');
  assert.equal(after.run.stop_reason, 'MODEL_NOT_CONFIGURED');
  assert.equal(after.run.execution_mode, 'fallback');
  assert.equal(after.run.is_live, 0);
  assert.equal(after.run.input_tokens, 5);
  assert.equal(after.run.output_tokens, 0);
  assert.equal(after.run.estimated_cost_usd, 0);
  assert.equal(after.run.model_name, null);
  assert.equal(after.run.provider, null);
  assert.ok(after.run.completed_at);
  assert.equal(after.run.updated_at, after.run.completed_at);
  assert.deepEqual(after.session, before.session);
  assert.deepEqual(after.messages, before.messages);
});

test('G41: failed run with a reply preserves explicit stop reason and safe guidance mode', async () => {
  const ids = await fixture();
  const failed = { status: 'failed', output: '合成失败提示', errorCode: 'SYNTHETIC_FAILURE',
    stopReason: 'SYNTHETIC_STOP' };
  const result = await finishRun(ids.runId, failed);
  assertReplyProjection(await snapshot(ids), result, { ...failed, executionMode: 'safe_guidance' });
});

for (const [name, trigger] of [
  ['message insert', `BEFORE INSERT ON assistant_messages WHEN NEW.role='assistant'`],
  ['session update', 'BEFORE UPDATE ON assistant_sessions']
]) {
  test(`G41: ${name} failure rolls back the entire terminal write and propagates the error`, async () => {
    const ids = await fixture();
    const before = await snapshot(ids);
    // TEMP triggers exist only on this in-memory test connection. RAISE(ABORT)
    // fails the statement, so a full rollback must come from finishRun itself.
    await db.exec(`CREATE TEMP TRIGGER g41_write_failure ${trigger}
      BEGIN SELECT RAISE(ABORT, 'g41 synthetic write failure'); END`);
    try {
      await assert.rejects(finishRun(ids.runId, completion), /g41 synthetic write failure/);
      assert.deepEqual(await snapshot(ids), before, 'run, session and all messages must be unchanged');
    } finally {
      await db.exec('DROP TRIGGER g41_write_failure');
    }
  });
}

test('G41: finishRun joins an existing transaction without opening a nested transaction', async () => {
  const ids = await fixture();
  const result = await transaction(async () => await finishRun(ids.runId, completion));
  assertReplyProjection(await snapshot(ids), result, { ...completion, stopReason: 'RESPONSE_COMPLETED' });
});

test('G41: outer transaction rollback also reverts a successful finishRun', async () => {
  const ids = await fixture();
  const before = await snapshot(ids);
  await assert.rejects(transaction(async () => {
    const result = await finishRun(ids.runId, completion);
    assertReplyProjection(await snapshot(ids), result, { ...completion, stopReason: 'RESPONSE_COMPLETED' });
    throw new Error('g41 synthetic outer rollback');
  }), /g41 synthetic outer rollback/);
  assert.deepEqual(await snapshot(ids), before);
});
