import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';
import { login, request, withDatabase } from './q5-helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    const staffToken = await login(baseUrl);
    const detail = await request(baseUrl, '/staff/guests/guest_001', { token: staffToken });
    assert.equal(detail.status, 200);
    const created = await request(baseUrl, '/staff/guests/guest_001/advice', {
      method: 'POST', token: staffToken,
      body: { title: 'Q5.12 审计标题', content: 'Q5.12 内容应留在建议记录，不应写入审计明细。' }
    });
    assert.equal(created.status, 201);

    const logs = readRelevantLogs(databasePath);
    const viewed = logs.find(row => row.action === 'guest.view');
    const adviceCreated = logs.find(row => row.action === 'advice.create' && row.detail === 'Q5.12 审计标题');
    assert.ok(viewed, 'guest.view audit record should be present');
    assert.ok(adviceCreated, 'advice.create audit record should be present');
    for (const entry of [viewed, adviceCreated]) {
      assert.equal(entry.actor_id, 'staff_001');
      assert.equal(entry.target_id, 'guest_001');
      assert.ok(Number.isFinite(Date.parse(entry.created_at)), 'audit record must include a valid timestamp');
    }
    assert.equal(adviceCreated.detail.includes('Q5.12 内容应留在建议记录'), false, 'audit should not contain the full advice content');

    return { output: [
      'GET /staff/guests/guest_001 HTTP 200 produced guest.view',
      `guest.view actor=${viewed.actor_id} target=${viewed.target_id} timestamp=${viewed.created_at}`,
      `advice.create actor=${adviceCreated.actor_id} target=${adviceCreated.target_id} timestamp=${adviceCreated.created_at}`,
      'audit detail stores advice title; full advice content absent'
    ] };
  }, 'haiyu-quest-q5-12-');
}

function readRelevantLogs(databasePath) {
  return withDatabase(databasePath, database => database.prepare(`SELECT actor_id,action,target_id,detail,created_at
    FROM audit_logs WHERE actor_id='staff_001' AND target_id='guest_001'
      AND action IN ('guest.view','advice.create') ORDER BY id`).all());
}
