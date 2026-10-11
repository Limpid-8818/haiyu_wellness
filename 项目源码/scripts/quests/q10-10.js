import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSnapshot, fixtureAccounts } from './q10-fixtures.js';
import { formatProbe, runSqliteImporter, sqliteSnapshotHash, withMysqlDatabase } from './q10-helpers.js';
import { withApiAtDatabase, withTemporaryApi } from './helpers.js';

function canonical(value, key = '') {
  if (/(^time$|_at$|At$|token$|^sessionId$)/i.test(key)) return '<volatile>';
  if (Array.isArray(value)) return value.map(item => canonical(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, canonical(childValue, childKey)]));
  }
  return value;
}

function assertResponse(result, status, route) {
  assert.equal(result.status, status, route + ': ' + JSON.stringify(result.data));
  return result.data;
}

async function runContract(context, accounts) {
  const observations = [];
  const remember = (route, result) => {
    observations.push({ route, status: result.status, data: canonical(result.data) });
    return result.data;
  };
  const send = async (route, options) => {
    const result = await fetch(context.baseUrl + route, {
      method: options && options.method || 'GET',
      headers: {
        ...(options && options.token ? { authorization: 'Bearer ' + options.token } : {}),
        ...(options && options.body !== undefined ? { 'content-type': 'application/json' } : {})
      },
      body: options && options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
    let data;
    try { data = await result.json(); }
    catch { throw new Error(route + ' returned non-JSON HTTP ' + result.status); }
    return { status: result.status, data };
  };

  const health = assertResponse(await send('/health'), 200, 'GET /api/health');
  assert.equal(health.ok, true);
  assert.equal(health.service, 'seaside-wellness-community');
  assert.ok(Number.isFinite(Date.parse(health.time)));
  remember('GET /api/health', { status: 200, data: health });

  const news = assertResponse(await send('/news'), 200, 'GET /api/news');
  assert.equal(news.length, 1);
  assert.equal(news[0].id, 91);
  remember('GET /api/news', { status: 200, data: news });

  const newsDetail = assertResponse(await send('/news/91'), 200, 'GET /api/news/:id');
  assert.equal(newsDetail.title, 'synthetic news');
  remember('GET /api/news/:id', { status: 200, data: newsDetail });

  const assistantStatus = assertResponse(await send('/assistant/status'), 200, 'GET /api/assistant/status');
  assert.equal(assistantStatus.live, false);
  remember('GET /api/assistant/status', { status: 200, data: assistantStatus });

  const tokens = {};
  const roleUsers = {};
  for (const role of ['guest', 'staff', 'dean']) {
    const account = accounts[role];
    const result = await send('/auth/login', {
      method: 'POST',
      body: { username: account.username, password: account.password, role }
    });
    const data = assertResponse(result, 200, 'POST /api/auth/login (' + role + ')');
    assert.equal(data.user.id, account.id);
    assert.equal(data.user.role, role);
    tokens[role] = data.token;
    roleUsers[role] = data.user;
  }
  remember('POST /api/auth/login', { status: 200, data: roleUsers });

  const guest = tokens.guest;
  const staff = tokens.staff;
  const dean = tokens.dean;
  const me = assertResponse(await send('/me', { token: guest }), 200, 'GET /api/me');
  assert.equal(me.id, accounts.guest.id);
  assert.equal(me.profile.room_no, 'S-001');
  assert.equal(me.health[0].value, '138/86');
  remember('GET /api/me', { status: 200, data: me });

  const guestChat = await send('/assistant/chat', {
    method: 'POST',
    token: guest,
    body: { role: 'guest', text: '请记录我的健康情况，我最近睡眠不好。' }
  });
  const chatData = assertResponse(guestChat, 200, 'POST /api/assistant/chat');
  assert.match(chatData.sessionId, /^as_[0-9a-f-]{36}$/);
  assert.equal(chatData.mode, '安全引导模式');
  assert.ok(chatData.reply);
  remember('POST /api/assistant/chat', guestChat);

  const history = await send('/assistant/history?role=guest&sessionId=' + encodeURIComponent(chatData.sessionId), { token: guest });
  const historyData = assertResponse(history, 200, 'GET /api/assistant/history');
  assert.deepEqual(historyData.messages.map(message => message.role), ['user', 'assistant']);
  remember('GET /api/assistant/history', history);

  const crossRoleHistory = await send('/assistant/history?role=staff&sessionId=' + encodeURIComponent(chatData.sessionId), { token: staff });
  assertResponse(crossRoleHistory, 403, 'GET /api/assistant/history cross-role denial');
  remember('GET /api/assistant/history cross-role denial', crossRoleHistory);
  const secondGuestLogin = await send('/auth/login', {
    method: 'POST',
    body: {
      username: accounts.unassignedGuest.username,
      password: accounts.unassignedGuest.password,
      role: 'guest'
    }
  });
  const secondGuest = assertResponse(secondGuestLogin, 200, 'POST /api/auth/login unassigned guest');
  const secondGuestChat = await send('/assistant/chat', {
    method: 'POST',
    token: secondGuest.token,
    body: { role: 'guest', text: 'synthetic second guest session' }
  });
  const secondSession = assertResponse(secondGuestChat, 200, 'POST /api/assistant/chat second guest');
  const crossSessionHistory = await send(
    '/assistant/history?role=guest&sessionId=' + encodeURIComponent(secondSession.sessionId),
    { token: guest }
  );
  assertResponse(crossSessionHistory, 403, 'GET /api/assistant/history cross-session denial');
  remember('GET /api/assistant/history cross-session denial', crossSessionHistory);

  const profile = await send('/me/profile', {
    method: 'PATCH',
    token: guest,
    body: { phone: '13987650011', emergencyContact: '合成联系人', mobility: '需要陪同' }
  });
  const profileData = assertResponse(profile, 200, 'PATCH /api/me/profile');
  assert.equal(profileData.phone, '13987650011');
  assert.equal(profileData.profile.emergency_contact, '合成联系人');
  remember('PATCH /api/me/profile', profile);

  const password = await send('/me/password', {
    method: 'POST',
    token: guest,
    body: { currentPassword: accounts.guest.password, newPassword: 'synthetic-new-pass-2026' }
  });
  assert.deepEqual(assertResponse(password, 200, 'POST /api/me/password'), { ok: true });
  remember('POST /api/me/password', password);

  const newPasswordLogin = await send('/auth/login', {
    method: 'POST',
    body: { username: accounts.guest.username, password: 'synthetic-new-pass-2026', role: 'guest' }
  });
  assertResponse(newPasswordLogin, 200, 'POST /api/auth/login after password update');

  const healthRecords = await send('/me/health', { token: guest });
  const healthData = assertResponse(healthRecords, 200, 'GET /api/me/health');
  assert.ok(healthData.some(row => row.value === '138/86'));
  remember('GET /api/me/health', healthRecords);

  const advice = await send('/me/advice', { token: guest });
  const adviceData = assertResponse(advice, 200, 'GET /api/me/advice');
  assert.ok(adviceData.some(row => row.id === 81 && row.content === 'Synthetic advisory text.'));
  remember('GET /api/me/advice', advice);

  const agent = await send('/agent/status', { token: guest });
  const agentData = assertResponse(agent, 200, 'GET /api/agent/status');
  assert.equal(agentData.agents.length, 5);
  remember('GET /api/agent/status', agent);

  const guestCannotSeeOverview = await send('/staff/overview', { token: guest });
  assertResponse(guestCannotSeeOverview, 403, 'GET /api/staff/overview guest denial');
  const overview = await send('/staff/overview', { token: staff });
  const overviewData = assertResponse(overview, 200, 'GET /api/staff/overview');
  assert.equal(overviewData.guests, 1);
  remember('GET /api/staff/overview', overview);
  remember('GET /api/staff/overview guest denial', guestCannotSeeOverview);

  const staffCannotSeeDean = await send('/dean/staff', { token: staff });
  assertResponse(staffCannotSeeDean, 403, 'GET /api/dean/staff staff denial');
  const staffIndex = await send('/dean/staff', { token: dean });
  const staffIndexData = assertResponse(staffIndex, 200, 'GET /api/dean/staff');
  assert.ok(staffIndexData.some(row => row.id === accounts.staff.id));
  remember('GET /api/dean/staff', staffIndex);
  remember('GET /api/dean/staff staff denial', staffCannotSeeDean);

  const staffLogs = await send('/dean/staff/' + accounts.staff.id + '/logs', { token: dean });
  const staffLogsData = assertResponse(staffLogs, 200, 'GET /api/dean/staff/:id/logs');
  assert.equal(staffLogsData.staff.id, accounts.staff.id);
  assert.ok(staffLogsData.reviews.some(row => row.id === 111));
  remember('GET /api/dean/staff/:id/logs', staffLogs);

  const review = await send('/dean/staff/' + accounts.staff.id + '/reviews', {
    method: 'POST', token: dean, body: { content: 'Synthetic Q10.10 review.' }
  });
  const reviewData = assertResponse(review, 201, 'POST /api/dean/staff/:id/reviews');
  assert.equal(reviewData.ok, true);
  remember('POST /api/dean/staff/:id/reviews', review);

  const guests = await send('/staff/guests', { token: staff });
  const guestsData = assertResponse(guests, 200, 'GET /api/staff/guests');
  assert.deepEqual(guestsData.map(row => row.id), [accounts.guest.id]);
  remember('GET /api/staff/guests', guests);

  const forbiddenGuest = await send('/staff/guests/' + accounts.unassignedGuest.id, { token: staff });
  assertResponse(forbiddenGuest, 403, 'GET /api/staff/guests/:id unassigned denial');
  const guestDetail = await send('/staff/guests/' + accounts.guest.id, { token: staff });
  const guestDetailData = assertResponse(guestDetail, 200, 'GET /api/staff/guests/:id');
  assert.equal(guestDetailData.id, accounts.guest.id);
  assert.equal(guestDetailData.phone, '13987650011');
  remember('GET /api/staff/guests/:id', guestDetail);
  remember('GET /api/staff/guests/:id unassigned denial', forbiddenGuest);

  const newAdvice = await send('/staff/guests/' + accounts.guest.id + '/advice', {
    method: 'POST', token: staff,
    body: { title: 'Synthetic Q10.10 advice', content: 'Persisted on both drivers.', priority: 'important' }
  });
  const newAdviceData = assertResponse(newAdvice, 201, 'POST /api/staff/guests/:id/advice');
  assert.equal(newAdviceData.ok, true);
  remember('POST /api/staff/guests/:id/advice', newAdvice);

  assert.equal(observations.length, 25, '20 route patterns plus five role/ownership denial checks');
  return observations;
}

export async function run() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'haiyu-q10-parity-'));
  const sourcePath = path.join(directory, 'synthetic-source.sqlite');
  const sqliteRuntimePath = path.join(directory, 'sqlite-runtime.sqlite');
  const rollbackPath = path.join(directory, 'sqlite-rollback-copy.sqlite');
  const accounts = fixtureAccounts('synthetic');
  try {
    createSqliteSnapshot(sourcePath, 'synthetic');
    const sourceHash = sqliteSnapshotHash(sourcePath);
    await copyFile(sourcePath, sqliteRuntimePath);
    await copyFile(sourcePath, rollbackPath);
    assert.equal(sqliteSnapshotHash(rollbackPath), sourceHash, 'the rollback copy must start as an exact clone of the immutable source snapshot');
    const sqliteRuntime = new DatabaseSync(sqliteRuntimePath);
    try {
      sqliteRuntime.prepare("UPDATE staff_guest_assignments SET status='active' WHERE id=61").run();
    } finally { sqliteRuntime.close(); }

    const sqliteObservations = await withApiAtDatabase(
      sqliteRuntimePath,
      context => runContract(context, accounts),
      { DB_DRIVER: 'sqlite', DEMO_SEED: '0' }
    );

    const mysqlObservations = await withMysqlDatabase(async ({ env, pool }) => {
      const imported = formatProbe(runSqliteImporter(sourcePath, env), 'SQLITE_IMPORT=');
      assert.deepEqual(imported.sourceCounts, imported.targetCounts);
      assert.equal(imported.relationshipViolations, 0);
      assert.deepEqual(Object.values(imported.duplicates), Array(17).fill(0));
      await pool.execute("UPDATE staff_guest_assignments SET status='active' WHERE id=61");
      return withTemporaryApi(
        context => runContract(context, accounts),
        'haiyu-q10-parity-mysql-',
        { ...env, DEMO_SEED: '0' }
      );
    });

    assert.deepEqual(mysqlObservations, sqliteObservations, 'the same synthetic API requests must have matching SQLite/MySQL responses');

    const rollbackLogins = await withApiAtDatabase(
      rollbackPath,
      async context => {
        assert.equal(path.resolve(context.databasePath), path.resolve(rollbackPath), 'the rollback API must use its independent SQLite runtime copy');
        const rollbackBaseUrl = await context.restartApi();
        const health = await fetch(rollbackBaseUrl + '/health');
        assert.equal(health.status, 200, 'the restarted SQLite API must be healthy');
        const healthData = await health.json();
        assert.equal(healthData.ok, true);
        const loggedIn = [];
        for (const role of ['guest', 'staff', 'dean']) {
          const account = accounts[role];
          const response = await fetch(rollbackBaseUrl + '/auth/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: account.username, password: account.password, role })
          });
          let data;
          try { data = await response.json(); }
          catch { throw new Error('SQLite rollback login returned non-JSON HTTP ' + response.status + ' (' + role + ')'); }
          assert.equal(response.status, 200, 'SQLite rollback login (' + role + '): ' + JSON.stringify(data));
          assert.equal(data.user.id, account.id);
          assert.equal(data.user.role, role);
          assert.ok(typeof data.token === 'string' && data.token.length > 0);
          loggedIn.push(role);
        }
        return loggedIn;
      },
      { DB_DRIVER: 'sqlite', DEMO_SEED: '0' }
    );
    assert.deepEqual(rollbackLogins, ['guest', 'staff', 'dean']);
    assert.equal(sqliteSnapshotHash(sourcePath), sourceHash, 'the synthetic source snapshot must remain unchanged');
    return {
      output: [
        'all 20 API route patterns matched against the same imported synthetic sample on SQLite and MySQL',
        'after MySQL shut down, the SQLite API restarted on an independent clone of the original sample and guest, staff and dean all logged in',
        'session history, profile/password updates and advice/review writes passed on both drivers',
        'role, cross-session and unassigned-guest access denials passed on both drivers',
        'the immutable synthetic SQLite source snapshot SHA-256 remained unchanged'
      ]
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
