import assert from 'node:assert/strict';
import { assertOk, databaseExec, databaseQuery, login, request, withBothDatabaseApis } from './q10-helpers.js';

export async function run() {
  await withBothDatabaseApis(async context => {
    const guest = (await login(context.baseUrl, 'guest')).data.token;
    const staff = (await login(context.baseUrl, 'staff')).data.token;
    const health = await request(context.baseUrl, '/me/health', { token: guest });
    assertOk(health, 200, 'health list');
    assert.ok(health.data.some(row => row.value === '138/86'));

    const created = await request(context.baseUrl, '/staff/guests/guest_001/advice', {
      method: 'POST', token: staff,
      body: { title: 'Synthetic Q10.6', content: 'Synthetic advice only.', priority: 'important' }
    });
    assertOk(created, 201, 'advice publish');
    const advice = await request(context.baseUrl, '/me/advice', { token: guest });
    assertOk(advice, 200, 'guest advice list');
    const row = advice.data.find(item => item.id === created.data.id);
    assert.ok(row);
    assert.equal(row.content, 'Synthetic advice only.');
    assert.equal(row.authorName, '王医生');
    assert.ok(row.createdAt);

    const before = Number((await databaseQuery(context,
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action='advice.create' AND target_id='guest_001'", [], 'get')).count);
    const trigger = context.driver === 'mysql'
      ? `CREATE TRIGGER q10_reject_advice BEFORE INSERT ON medical_advice FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic forced write failure'`
      : `CREATE TRIGGER q10_reject_advice BEFORE INSERT ON medical_advice BEGIN SELECT RAISE(ABORT,'synthetic forced write failure'); END`;
    await databaseExec(context, trigger);
    const failed = await request(context.baseUrl, '/staff/guests/guest_001/advice', {
      method: 'POST', token: staff,
      body: { title: 'Forced failure', content: 'This row must not be committed.' }
    });
    assert.equal(failed.status, 500);
    const after = Number((await databaseQuery(context,
      "SELECT COUNT(*) AS count FROM audit_logs WHERE action='advice.create' AND target_id='guest_001'", [], 'get')).count);
    assert.equal(after, before, 'failed advice write must not leave a success audit row');
  });
  return { output: ['health values and published advice matched on SQLite/MySQL', 'HTTP 201 and author/content/time verified', 'failed advice transaction left no success audit'] };
}
