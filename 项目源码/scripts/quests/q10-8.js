import assert from 'node:assert/strict';
import { hashPassword } from '../../server/src/password.js';
import { assertOk, databaseQuery, login, request, withBothDatabaseApis } from './q10-helpers.js';

export async function run() {
  const observations = [];
  await withBothDatabaseApis(async context => {
    const guest = (await login(context.baseUrl, 'guest')).data.token;
    const staff = (await login(context.baseUrl, 'staff')).data.token;
    await databaseQuery(context,
      'INSERT INTO users(id,username,password_hash,role,name,phone,status) VALUES(?,?,?,?,?,?,?)',
      ['guest_002', 'guest_two', hashPassword('synthetic-guest-2'), 'guest', '合成客人二', '', 'active'], 'run');
    const profileColumns = context.driver === 'mysql'
      ? 'user_id,gender,birth_date,room_no,check_in_date,check_out_date,emergency_contact,chronic_json,allergies_json,mobility'
      : 'user_id,gender,birth_date,room_no,check_in,check_out,emergency_contact,chronic_json,allergies_json,mobility';
    await databaseQuery(context,
      `INSERT INTO guest_profiles(${profileColumns}) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ['guest_002', '未知', '1955-02-02', 'Q10-2', '2026-09-11', '2026-10-11', '', '[]', '[]', ''], 'run');

    const first = await request(context.baseUrl, '/assistant/chat', {
      method: 'POST', token: guest,
      body: { role: 'guest', text: '最近睡眠不好，想把这条健康情况记下来。' }
    });
    assertOk(first, 200, 'guest chat');
    const firstHistory = assertOk(await request(context.baseUrl,
      `/assistant/history?role=guest&sessionId=${encodeURIComponent(first.data.sessionId)}`, { token: guest }), 200, 'guest history');
    assert.equal(firstHistory.messages.length, 2);
    assert.deepEqual(firstHistory.messages.map(message => message.role), ['user', 'assistant']);

    const crossRole = await request(context.baseUrl,
      `/assistant/history?role=staff&sessionId=${encodeURIComponent(first.data.sessionId)}`, { token: staff });
    assert.equal(crossRole.status, 403);
    const guestTwoLogin = await request(context.baseUrl, '/auth/login', {
      method: 'POST', body: { username: 'guest_two', password: 'synthetic-guest-2', role: 'guest' }
    });
    assertOk(guestTwoLogin, 200, 'second guest login');
    const second = await request(context.baseUrl, '/assistant/chat', {
      method: 'POST', token: guestTwoLogin.data.token,
      body: { role: 'guest', text: 'synthetic guest two session' }
    });
    assertOk(second, 200, 'second guest chat');
    const crossSession = await request(context.baseUrl,
      `/assistant/history?role=guest&sessionId=${encodeURIComponent(second.data.sessionId)}`, { token: guest });
    assert.equal(crossSession.status, 403);

    const restartedBaseUrl = await context.restartApi();
    const afterRestart = await request(restartedBaseUrl,
      `/assistant/history?role=guest&sessionId=${encodeURIComponent(first.data.sessionId)}`, { token: guest });
    assertOk(afterRestart, 200, 'history after restart');
    assert.equal(afterRestart.data.messages.length, 2);
    const intakeSql = context.driver === 'mysql'
      ? 'SELECT session_id,raw_content AS content,review_status AS status FROM health_intakes WHERE guest_id=?'
      : 'SELECT session_id,content,status FROM health_intakes WHERE guest_id=?';
    const intake = await databaseQuery(context, intakeSql, ['guest_001'], 'get');
    assert.equal(intake.session_id, first.data.sessionId);
    assert.match(intake.content, /睡眠不好/);
    assert.equal(intake.status, 'pending');
    observations.push({ roles: afterRestart.data.messages.map(message => message.role), intakeStatus: intake.status });
  });
  assert.deepEqual(observations[0], observations[1]);
  return { output: ['assistant messages and ownership survived restart on SQLite/MySQL', 'health intake remained pending and linked to its session', 'cross-role and cross-session history reads were denied'] };
}
