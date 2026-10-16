import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
Object.assign(process.env, {
  DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '1',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '',
  ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0'
});
const { app } = await import('../src/app.js');
const { db, now } = await import('../src/db.js');
const { shiftDateKey, systemBusinessClock } = await import('../src/clock.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api`;
test.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });

async function call(token, route, method = 'GET', body, expected = 200) {
  const response = await fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(data)}`);
  return data;
}

const guest = (await call(null, '/auth/login', 'POST', { username: 'guest_demo', password: 'guest2026', role: 'guest' })).token;
const staff = (await call(null, '/auth/login', 'POST', { username: 'staff_demo', password: 'staff2026', role: 'staff' })).token;
const today = systemBusinessClock.dateKey();

test('放松资源目录只暴露 URL 与说明字段，不暴露服务端文件名', async () => {
  const items = await call(null, '/mood/resources');
  assert.equal(items.length, 4);
  for (const item of items) {
    assert.ok(item.id && item.title && item.category);
    assert.equal(typeof item.durationSeconds, 'number');
    assert.equal(item.audioUrl, `/api/mood/resources/${item.id}/audio`);
    assert.equal(item.coverUrl, `/api/mood/resources/${item.id}/cover`);
    assert.ok(item.license, '许可边界必须随目录下发');
    assert.equal(item.audioFile, undefined);
    assert.equal(item.coverFile, undefined);
  }
});

test('心情录入校验：档位、未知字段、备注长度逐项拒绝', async () => {
  assert.equal((await call(guest, '/me/moods', 'POST', { score: 0 }, 400)).code, 'MOOD_SCORE_INVALID');
  assert.equal((await call(guest, '/me/moods', 'POST', { score: 6 }, 400)).code, 'MOOD_SCORE_INVALID');
  assert.equal((await call(guest, '/me/moods', 'POST', { score: 3.5 }, 400)).code, 'MOOD_SCORE_INVALID');
  const unknownField = await call(guest, '/me/moods', 'POST', { score: 3, mood: '好' }, 400);
  assert.equal(unknownField.code, 'MOOD_FIELD_NOT_ALLOWED');
  assert.deepEqual(unknownField.details, { fields: ['mood'] });
  assert.equal((await call(guest, '/me/moods', 'POST', { score: 3, note: '长'.repeat(501) }, 400)).code, 'MOOD_NOTE_INVALID');
});

test('连续低分达到阈值生成待人工关注项，改善后自动转为有改善记录', async () => {
  const stamp = now();
  for (const offset of [-2, -1]) {
    await db.prepare('INSERT INTO mood_records(guest_id,business_date,score,note,revision,created_at,updated_at) VALUES(?,?,?,?,1,?,?)')
      .run('guest_001', shiftDateKey(today, offset), 2, '', stamp, stamp);
  }
  const created = await call(guest, '/me/moods', 'POST', { score: 2, note: '有点低落' }, 201);
  assert.equal(created.businessDate, today);
  assert.equal(created.score, 2);
  assert.equal(created.label, '有些烦闷');
  assert.equal(created.revision, 1);

  const items = await call(guest, '/me/mood-focus-items');
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'open');
  assert.equal(items[0].statusLabel, '待人工关注');
  assert.equal(items[0].startDate, shiftDateKey(today, -2));
  assert.equal(items[0].endDate, today);
  assert.equal(items[0].sourceRecordIds.length, 3);
  assert.equal(items[0].rule.id, 'demo-negative-streak-v1');

  const updated = await call(guest, `/me/moods/${created.id}`, 'PUT', { score: 4, note: '好些了' });
  assert.equal(updated.revision, 2);
  assert.equal(updated.label, '比较平静');

  const improved = await call(guest, '/me/mood-focus-items');
  assert.equal(improved[0].status, 'improved');
  assert.equal(improved[0].statusLabel, '有改善记录');
  assert.ok(improved[0].resolvedAt, '改善项必须带结论时间');
});

test('同一业务日重复记录被拒，并回指已有记录', async () => {
  const conflict = await call(guest, '/me/moods', 'POST', { score: 3 }, 409);
  assert.equal(conflict.code, 'MOOD_ALREADY_RECORDED');
  assert.ok(conflict.details.recordId, '冲突响应必须回指当天已有记录');
  assert.equal(conflict.details.businessDate, today);
});

test('趋势只覆盖指定业务日窗口，非法窗口被拒', async () => {
  const trend = await call(guest, '/me/mood-trends?days=7');
  assert.equal(trend.days, 7);
  assert.equal(trend.points.length, 7);
  assert.equal(trend.endDate, today);
  assert.equal(trend.startDate, shiftDateKey(today, -6));
  assert.equal(trend.points[6].date, today);
  assert.equal(trend.points[6].score, 4);
  assert.equal(trend.points[4].score, 2);
  assert.equal(trend.points[5].score, 2);
  assert.equal(trend.sampleCount, 3);
  assert.equal(trend.missingDayCount, 4);
  assert.ok(trend.points.every(point => point.score === null ? point.recordId === null : true));
  assert.equal((await call(guest, '/me/mood-trends?days=5', 'GET', undefined, 400)).code, 'MOOD_TREND_WINDOW_INVALID');
});

test('摘要在记录充分时可用，并保留演示边界声明', async () => {
  const summary = await call(guest, '/me/mood-summary');
  assert.equal(summary.dataSufficiency.status, 'available');
  assert.equal(summary.dataSufficiency.recordCount, 3);
  assert.equal(summary.profile.ageBand, 'older_adult');
  assert.equal(summary.recentMoods.length, 3);
  assert.equal(summary.focusItems.length, 1);
  assert.ok(summary.interpretationBoundary.includes('不作诊断'));
});

test('播放事件按事件编号幂等，无效资源与事件被拒', async () => {
  const eventId = crypto.randomUUID();
  const first = await call(guest, '/me/mood-resources/breathing/usage', 'POST', { eventId }, 201);
  assert.equal(first.duplicate, false);
  const replay = await call(guest, '/me/mood-resources/breathing/usage', 'POST', { eventId }, 201);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.id, first.id);
  assert.equal((await call(guest, '/me/mood-resources/breathing/usage', 'POST', { eventId: 'not-a-uuid' }, 400)).code, 'MOOD_RESOURCE_EVENT_INVALID');
  assert.equal((await call(guest, '/me/mood-resources/breathing/usage', 'POST', { eventId, extra: 1 }, 400)).code, 'MOOD_RESOURCE_EVENT_INVALID');
  assert.equal((await call(guest, '/me/mood-resources/nope/usage', 'POST', { eventId: crypto.randomUUID() }, 404)).code, 'MOOD_RESOURCE_NOT_FOUND');

  const summary = await call(guest, '/me/mood-summary');
  const breathing = summary.resources.find(item => item.id === 'breathing');
  assert.equal(breathing.playCount, 1, '同一事件编号重复上报不得重复计数');
  assert.ok(breathing.lastPlayedAt);
});

test('负责医护可读取同一份客人摘要', async () => {
  const summary = await call(staff, '/staff/guests/guest_001/mood-summary');
  assert.equal(summary.profile.guestId, 'guest_001');
  assert.equal(summary.dataSufficiency.status, 'available');
});
