import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { databaseQuery, formatProbe, login, request, runNodeManaged, withBothDatabaseApis } from './q10-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEST_NOW = '2026-10-01T10:00:00.000Z';
const TEST_DATE = '2026-10-01';
let activeResourceSession;

function withMoodApis(callback) {
  return withBothDatabaseApis(callback, { env: { BUSINESS_CLOCK_NOW: TEST_NOW }, resourceSession: activeResourceSession });
}

function assertOk(result, expected = 200, label = 'request') {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function guestFor(context) {
  return assertOk(await login(context.baseUrl, 'guest'), 200, 'guest login');
}

async function staffFor(context) {
  return assertOk(await login(context.baseUrl, 'staff'), 200, 'staff login');
}

function stamp(date, hour = '10:00:00', context = null) {
  return context?.driver === 'mysql' ? `${date} ${hour}` : `${date}T${hour}.000Z`;
}

async function insertMood(context, guestId, { date, score, note = '' }) {
  const at = stamp(date, '10:00:00', context);
  const inserted = await databaseQuery(context, `INSERT INTO mood_records
    (guest_id,business_date,score,note,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
  [guestId, date, score, note, at, at], 'run');
  const id = Number(inserted.lastInsertRowid || inserted.insertId);
  if (id) return id;
  const row = await databaseQuery(context, 'SELECT id FROM mood_records WHERE guest_id=? AND business_date=?', [guestId, date], 'get');
  return Number(row.id);
}

async function addGuestFixture(context, { id, name, birthDate, mobility = '独立行走' }) {
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status)
    VALUES(?,?,?,'guest',?,'','active')`, [id, `${id}_fixture`, 'not-used-in-fixture', name], 'run');
  await databaseQuery(context, `INSERT INTO guest_profiles
    (user_id,gender,birth_date,chronic_json,allergies_json,mobility)
    VALUES(?, '未提供', ?, '[]', '[]', ?)`, [id, birthDate, mobility], 'run');
}

async function assignGuestToStaff(context, guestId, staffId) {
  const started = stamp('2026-09-30', '00:00:00', context);
  await databaseQuery(context, `INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
    VALUES(?,?,?,NULL,'active',?,?,?)`, [staffId, guestId, started, staffId, started, started], 'run');
}

async function runMoodServiceProbe(context, guestId, label) {
  const code = `const { db } = await import('./src/db.js');
    try {
      const { evaluateMoodFollowups } = await import('./src/mood.js');
      const items = await evaluateMoodFollowups(${JSON.stringify(guestId)});
      console.log('Q18_FOCUS_PROBE ' + JSON.stringify(items));
    } finally { await db.close(); }`;
  const env = { DB_DRIVER: context.driver, DEMO_SEED: '0', BUSINESS_CLOCK_NOW: TEST_NOW };
  if (context.driver === 'sqlite') env.DB_PATH = context.databasePath;
  else {
    Object.assign(env, {
      MYSQL_HOST: process.env.MYSQL_HOST,
      MYSQL_PORT: process.env.MYSQL_PORT,
      MYSQL_USER: process.env.MYSQL_USER,
      MYSQL_PASSWORD: process.env.MYSQL_PASSWORD || '',
      MYSQL_DATABASE: context.database
    });
  }
  const result = await runNodeManaged(code, env, activeResourceSession, label);
  return formatProbe(result, 'Q18_FOCUS_PROBE ');
}

async function q181() {
  await withMoodApis(async context => {
    const guest = await guestFor(context);
    const results = await Promise.all([
      request(context.baseUrl, '/me/moods', { method: 'POST', token: guest.token, body: { score: 2, note: '快捷入口并发提交' } }),
      request(context.baseUrl, '/me/moods', { method: 'POST', token: guest.token, body: { score: 1, note: '详细表单并发提交' } })
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    const created = results.find(result => result.status === 201).data;
    const duplicate = results.find(result => result.status === 409);
    assert.equal(duplicate.data.code, 'MOOD_ALREADY_RECORDED');
    assert.equal(duplicate.data.details.recordId, created.id);
    assert.equal(created.businessDate, TEST_DATE);

    const repeat = await request(context.baseUrl, '/me/moods', {
      method: 'POST', token: guest.token, body: { score: 5, note: '再次提交' }
    });
    assert.equal(repeat.status, 409);
    assert.match(repeat.data.error, /今天已经记录/);
    assert.equal(repeat.data.details.recordId, created.id);

    const edited = assertOk(await request(context.baseUrl, `/me/moods/${created.id}`, {
      method: 'PUT', token: guest.token, body: { score: 4, note: '详细编辑后的备注' }
    }), 200, 'explicit same-day edit');
    assert.equal(edited.id, created.id);
    assert.equal(edited.score, 4);
    assert.equal(edited.note, '详细编辑后的备注');

    const yesterdayId = await insertMood(context, guest.user.id, { date: '2026-09-30', score: 2, note: '昨日锁定样本' });
    const yesterdayEdit = await request(context.baseUrl, `/me/moods/${yesterdayId}`, {
      method: 'PUT', token: guest.token, body: { score: 5, note: '不允许修改' }
    });
    assert.equal(yesterdayEdit.status, 409);
    assert.equal(yesterdayEdit.data.code, 'MOOD_EDIT_WINDOW_CLOSED');
    const rows = await request(context.baseUrl, '/me/moods', { token: guest.token });
    assert.equal(rows.data.length, 2);
    assert.equal(rows.data.find(row => row.id === yesterdayId).score, 2);
    assert.equal(rows.data.find(row => row.id === created.id).id, edited.id);
  });
}

async function q182() {
  await withMoodApis(async context => {
    const guest = await guestFor(context);
    const created = assertOk(await request(context.baseUrl, '/me/moods', {
      method: 'POST', token: guest.token, body: { score: 2, note: '' }
    }), 201, 'quick mood selection');
    const detailed = assertOk(await request(context.baseUrl, `/me/moods/${created.id}`, {
      method: 'PUT', token: guest.token, body: { score: 4, note: '我想补充的详细备注' }
    }), 200, 'detailed edit');
    assert.equal(detailed.id, created.id);
    assert.equal((await request(context.baseUrl, '/me/moods', { token: guest.token })).data.length, 1);

    const firstChat = assertOk(await request(context.baseUrl, '/assistant/chat', {
      method: 'POST', token: guest.token, body: { role: 'guest', text: '我今天有些烦闷，想和管家说一说。' }
    }), 200, 'existing guest assistant');
    const secondChat = assertOk(await request(context.baseUrl, '/assistant/chat', {
      method: 'POST', token: guest.token,
      body: { role: 'guest', sessionId: firstChat.sessionId, text: '谢谢你听我说。' }
    }), 200, 'same guest assistant session');
    assert.ok(firstChat.sessionId);
    assert.equal(secondChat.sessionId, firstChat.sessionId);
    const sessionCount = await databaseQuery(context, `SELECT COUNT(*) AS count FROM assistant_sessions
      WHERE user_id=? AND assistant_role='guest'`, [guest.user.id], 'get');
    assert.equal(Number(sessionCount.count), 1);
  });
}

async function q183() {
  await withMoodApis(async context => {
    const guest = await guestFor(context);
    const samples = [
      ['2026-09-26', 4, '周六还好'],
      ['2026-09-29', 3, '普通记录'],
      ['2026-10-01', 5, '今天还不错']
    ];
    const ids = new Map();
    for (const [date, score, note] of samples) ids.set(date, await insertMood(context, guest.user.id, { date, score, note }));
    for (const days of [7, 30]) {
      const trend = assertOk(await request(context.baseUrl, `/me/mood-trends?days=${days}`, { token: guest.token }), 200, `${days}-day mood trend`);
      assert.equal(trend.days, days);
      assert.equal(trend.sampleCount, 3);
      assert.equal(trend.missingDayCount, days - 3);
      assert.equal(trend.points.find(point => point.date === '2026-09-27').score, null);
      assert.equal(trend.points.find(point => point.date === '2026-09-27').recordId, null);
      const dated = trend.points.find(point => point.date === '2026-09-29');
      assert.equal(dated.score, 3);
      assert.equal(dated.note, '普通记录');
      assert.equal(dated.recordId, ids.get('2026-09-29'));
    }
    const invalidWindow = await request(context.baseUrl, '/me/mood-trends?days=14', { token: guest.token });
    assert.equal(invalidWindow.status, 400);
    assert.equal(invalidWindow.data.code, 'MOOD_TREND_WINDOW_INVALID');
  });
}

async function inspectMedia(resource) {
  const mediaPath = path.join(projectRoot, 'server/media/mood', `${resource.id}.wav`);
  const info = execFileSync('afinfo', [mediaPath], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  const duration = Number(info.match(/estimated duration:\s*([0-9.]+) sec/i)?.[1]);
  const bytes = fs.statSync(mediaPath).size;
  assert.ok(bytes > 1024, `${resource.id} asset is non-empty`);
  assert.ok(Number.isFinite(duration) && duration > 0, `${resource.id} has readable duration metadata`);
  assert.ok(Math.abs(duration - resource.durationSeconds) < 0.001, `${resource.id} duration matches afinfo`);
  return { bytes, durationSeconds: duration };
}

async function q184() {
  const outcomes = [];
  await withMoodApis(async context => {
    const catalog = assertOk(await request(context.baseUrl, '/mood/resources'), 200, 'mood resource catalog');
    assert.deepEqual(catalog.map(item => item.id).sort(), ['body-scan', 'breathing', 'ocean-waves', 'seaside-meditation']);
    for (const item of catalog) {
      assert.ok(item.title && item.subtitle && item.durationSeconds > 0, `${item.id} has title and duration`);
      assert.ok(item.source && item.license && item.audioUrl && item.coverUrl, `${item.id} has source and license text`);
      const media = await inspectMedia(item);
      const audio = await fetch(new URL(item.audioUrl, new URL(context.baseUrl).origin), { headers: { Range: 'bytes=0-63' } });
      assert.equal(audio.status, 206, `${item.id} range request: HTTP ${audio.status}`);
      assert.match(audio.headers.get('content-type') || '', /audio|wave/i);
      const rangeBytes = new Uint8Array(await audio.arrayBuffer());
      assert.equal(rangeBytes.length, 64);
      assert.equal(String.fromCharCode(...rangeBytes.slice(0, 4)), 'RIFF');
      assert.equal(String.fromCharCode(...rangeBytes.slice(8, 12)), 'WAVE');
      const cover = await fetch(new URL(item.coverUrl, new URL(context.baseUrl).origin));
      assert.equal(cover.status, 200);
      assert.match(cover.headers.get('content-type') || '', /svg/i);
      outcomes.push({ id: item.id, ...media });
    }
  });
  return outcomes;
}

async function q185() {
  await withMoodApis(async context => {
    const catalog = assertOk(await request(context.baseUrl, '/mood/resources'), 200, 'playable catalog');
    for (const item of catalog) {
      const response = await fetch(new URL(item.audioUrl, new URL(context.baseUrl).origin), { headers: { Range: 'bytes=0-255' } });
      assert.equal(response.status, 206, `${item.id} supports media seeking`);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(new Uint8Array(await response.arrayBuffer()).length, 256);
    }
  });
}

async function q186() {
  await withMoodApis(async context => {
    const guest = await guestFor(context);
    const eventId = '18a1fa2e-5a44-4b17-8a18-18a1fa2e0001';
    const first = assertOk(await request(context.baseUrl, '/me/mood-resources/ocean-waves/usage', {
      method: 'POST', token: guest.token, body: { eventId }
    }), 201, 'first play event');
    const retried = assertOk(await request(context.baseUrl, '/me/mood-resources/ocean-waves/usage', {
      method: 'POST', token: guest.token, body: { eventId }
    }), 201, 'idempotent play retry');
    assert.equal(first.id, retried.id);
    assert.equal(retried.duplicate, true);
    const summary = assertOk(await request(context.baseUrl, '/me/mood-summary', { token: guest.token }), 200, 'own mood summary');
    assert.equal(summary.resources.find(item => item.id === 'ocean-waves').playCount, 1);
    assert.match(summary.interpretationBoundary, /播放次数不表示心理改善/);
    const usage = await databaseQuery(context, `SELECT COUNT(*) AS count FROM mood_resource_events
      WHERE guest_id=? AND resource_id='ocean-waves'`, [guest.user.id], 'get');
    assert.equal(Number(usage.count), 1);
  });
}

async function q187() {
  await withMoodApis(async context => {
    const guest = await guestFor(context);
    const firstId = await insertMood(context, guest.user.id, { date: '2026-09-29', score: 1, note: '连续记录一' });
    const secondId = await insertMood(context, guest.user.id, { date: '2026-09-30', score: 2, note: '连续记录二' });
    const today = assertOk(await request(context.baseUrl, '/me/moods', {
      method: 'POST', token: guest.token, body: { score: 2, note: '连续记录三' }
    }), 201, 'third consecutive low mood day');
    assert.equal(today.businessDate, TEST_DATE);
    const detected = await request(context.baseUrl, '/me/mood-focus-items', { token: guest.token });
    assert.equal(detected.status, 200);
    assert.equal(detected.data.length, 1);
    assert.deepEqual(detected.data[0].sourceRecordIds, [firstId, secondId, today.id]);
    assert.equal(detected.data[0].startDate, '2026-09-29');
    assert.equal(detected.data[0].endDate, TEST_DATE);
    assert.equal(detected.data[0].status, 'open');

    await request(context.baseUrl, `/me/moods/${today.id}`, {
      method: 'PUT', token: guest.token, body: { score: 2, note: '重复检测不重复建项' }
    }).then(result => assertOk(result, 200, 'repeat same negative day detection'));
    const afterRepeat = await request(context.baseUrl, '/me/mood-focus-items', { token: guest.token });
    assert.equal(afterRepeat.data.length, 1);
    assert.equal(afterRepeat.data[0].id, detected.data[0].id);

    assertOk(await request(context.baseUrl, `/me/moods/${today.id}`, {
      method: 'PUT', token: guest.token, body: { score: 4, note: '今天感觉有所不同' }
    }), 200, 'improved follow-up update');
    const improved = await request(context.baseUrl, '/me/mood-focus-items', { token: guest.token });
    assert.equal(improved.data.length, 1);
    assert.equal(improved.data[0].status, 'improved');
    assert.ok(improved.data[0].resolvedAt);

    const normalGuestId = 'q18_normal_streak';
    await addGuestFixture(context, { id: normalGuestId, name: '普通心情夹具', birthDate: '1987-01-01' });
    await insertMood(context, normalGuestId, { date: '2026-09-29', score: 3, note: '正常样本一' });
    await insertMood(context, normalGuestId, { date: '2026-09-30', score: 4, note: '正常样本二' });
    await insertMood(context, normalGuestId, { date: TEST_DATE, score: 5, note: '正常样本三' });
    const normalItems = await runMoodServiceProbe(context, normalGuestId, `q18-normal-focus-${context.driver}`);
    assert.deepEqual(normalItems, []);
  });
}

async function q188() {
  await withMoodApis(async context => {
    const staff = await staffFor(context);
    const olderId = 'q18_older_fixture';
    const middleId = 'q18_middle_fixture';
    await addGuestFixture(context, { id: olderId, name: '长者演示夹具', birthDate: '1940-04-12', mobility: '需要陪同' });
    await addGuestFixture(context, { id: middleId, name: '中青年演示夹具', birthDate: '1985-04-12' });
    await assignGuestToStaff(context, olderId, staff.user.id);
    await assignGuestToStaff(context, middleId, staff.user.id);
    const olderMoodId = await insertMood(context, olderId, { date: '2026-09-30', score: 4, note: '少量记录示例' });
    const middleRows = [
      ['2026-09-25', 3, '样本一'], ['2026-09-26', 4, '样本二'], ['2026-09-28', 4, '样本三'],
      ['2026-09-29', 3, '样本四'], [TEST_DATE, 5, '样本五']
    ];
    const middleIds = [];
    for (const [date, score, note] of middleRows) middleIds.push(await insertMood(context, middleId, { date, score, note }));
    await databaseQuery(context, `INSERT INTO mood_resource_events(guest_id,resource_id,event_id,played_at)
      VALUES(?,?,?,?)`, [middleId, 'breathing', '18a1fa2e-5a44-4b17-8a18-18a1fa2e0002', stamp(TEST_DATE, '10:00:00', context)], 'run');

    const older = assertOk(await request(context.baseUrl, `/staff/guests/${olderId}/mood-summary`, { token: staff.token }), 200, 'older-adult mood summary');
    assert.equal(older.profile.ageBand, 'older_adult');
    assert.equal(older.profile.ageBandLabel, '长者演示范围');
    assert.equal(older.dataSufficiency.status, 'insufficient_data');
    assert.equal(older.recentMoods.length, 1);
    assert.equal(older.recentMoods[0].id, olderMoodId);
    assert.equal(older.resources.length, 4);
    assert.equal(older.resources.every(resource => Number(resource.playCount) === 0), true);

    const middle = assertOk(await request(context.baseUrl, `/staff/guests/${middleId}/mood-summary`, { token: staff.token }), 200, 'young/middle-aged mood summary');
    assert.equal(middle.profile.ageBand, 'young_middle_aged');
    assert.equal(middle.dataSufficiency.status, 'available');
    assert.equal(middle.recentMoods.length, 5);
    assert.deepEqual(middle.recentMoods.map(record => record.id).sort((a, b) => a - b), [...middleIds].sort((a, b) => a - b));
    assert.equal(middle.resources.find(resource => resource.id === 'breathing').playCount, 1);
    assert.match(middle.interpretationBoundary, /播放次数不表示心理改善/);

    const unauthorizedId = 'q18_unassigned_fixture';
    await addGuestFixture(context, { id: unauthorizedId, name: '未分配夹具', birthDate: '1980-01-01' });
    const denied = await request(context.baseUrl, `/staff/guests/${unauthorizedId}/mood-summary`, { token: staff.token });
    assert.equal(denied.status, 403);
  });
}

const runners = {
  'Q18.1': q181, 'Q18.2': q182, 'Q18.3': q183, 'Q18.4': q184,
  'Q18.5': q185, 'Q18.6': q186, 'Q18.7': q187, 'Q18.8': q188
};

export async function run({ questId, resourceSession }) {
  if (!resourceSession) throw new Error('Stage18 Quest requires a managed ResourceSession');
  activeResourceSession = resourceSession;
  const runner = runners[questId];
  if (!runner) throw new Error(`Unsupported Stage18 Quest: ${questId}`);
  const result = await runner();
  return { output: [
    `${questId} verified against isolated SQLite and MySQL 8.4.11; business date ${TEST_DATE} (Asia/Shanghai).`,
    ...(questId === 'Q18.4' && result ? [`Media metadata: ${JSON.stringify(result)}.`] : [])
  ] };
}
