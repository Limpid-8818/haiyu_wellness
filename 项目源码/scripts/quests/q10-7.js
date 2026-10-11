import assert from 'node:assert/strict';
import { hashPassword } from '../../server/src/password.js';
import { assertOk, databaseQuery, login, request, withBothDatabaseApis } from './q10-helpers.js';

export async function run() {
  const outputs = [];
  await withBothDatabaseApis(async context => {
    const dean = (await login(context.baseUrl, 'dean')).data.token;
    const staff = (await login(context.baseUrl, 'staff')).data.token;
    const news = assertOk(await request(context.baseUrl, '/news'), 200, 'news list');
    assert.ok(news.length >= 1);
    assert.equal(news[0].pinned, 1);
    assertOk(await request(context.baseUrl, `/news/${news[0].id}`), 200, 'news detail');
    const forbidden = await request(context.baseUrl, '/dean/staff', { token: staff });
    assert.equal(forbidden.status, 403);

    await databaseQuery(context,
      'INSERT INTO users(id,username,password_hash,role,name,phone,status) VALUES(?,?,?,?,?,?,?)',
      ['staff_002', 'staff_two', hashPassword('synthetic-staff-2'), 'staff', '合成工作人员二', '13900000002', 'active'], 'run');
    const first = await request(context.baseUrl, '/dean/staff/staff_001/reviews', {
      method: 'POST', token: dean, body: { content: 'Review for staff one.' }
    });
    const second = await request(context.baseUrl, '/dean/staff/staff_002/reviews', {
      method: 'POST', token: dean, body: { content: 'Review for staff two.' }
    });
    assertOk(first, 201, 'staff one review');
    assertOk(second, 201, 'staff two review');
    const firstHistory = assertOk(await request(context.baseUrl, '/dean/staff/staff_001/logs', { token: dean }), 200, 'staff one history');
    const secondHistory = assertOk(await request(context.baseUrl, '/dean/staff/staff_002/logs', { token: dean }), 200, 'staff two history');
    assert.ok(firstHistory.reviews.some(row => row.id === first.data.id && row.content === 'Review for staff one.'));
    assert.equal(firstHistory.reviews.some(row => row.id === second.data.id), false);
    assert.ok(secondHistory.reviews.some(row => row.id === second.data.id && row.content === 'Review for staff two.'));
    const staffIndex = assertOk(await request(context.baseUrl, '/dean/staff', { token: dean }), 200, 'staff index');
    assert.ok(staffIndex.some(row => row.id === 'staff_002'));
    outputs.push({ first: firstHistory.reviews.length, second: secondHistory.reviews.length, news: news.length });
  });
  assert.deepEqual(outputs[0], outputs[1]);
  return { output: ['public news order/detail and dean reviews verified on both drivers', 'staff-specific reviews stayed bound to the intended employee'] };
}
