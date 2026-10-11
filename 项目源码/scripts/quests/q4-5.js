import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../../server/src/password.js';
import { withTemporaryApi } from './helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    addOtherGuestRecord(databasePath);

    const anonymous = await request(baseUrl, '/me/health');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.code, 'AUTH_REQUIRED');

    const token = await guestToken(baseUrl);
    const own = await request(baseUrl, '/me/health', { token });
    assert.equal(own.status, 200);
    assert.equal(own.data.length, 1);
    assert.equal(own.data[0].type, '血压');
    assert.equal(own.data[0].value, '138/86');
    assert.equal(own.data[0].unit, 'mmHg');
    assert.equal(own.data[0].recordedAt, '2026-09-14T07:30:00.000Z');
    assert.equal(own.data.some(row => row.value === 'other-guest-secret'), false);

    const crossGuest = await request(baseUrl, '/me/health?guestId=guest_002', { token });
    assert.equal(crossGuest.status, 403);
    assert.equal(crossGuest.data.code, 'GUEST_FORBIDDEN');

    return {
      output: [
        'anonymous HTTP 401 AUTH_REQUIRED',
        `own HTTP 200 records=${own.data.length} type=${own.data[0].type} value=${own.data[0].value} ${own.data[0].unit} date=${own.data[0].recordedAt}`,
        'guestId=guest_002 HTTP 403 GUEST_FORBIDDEN otherRecordVisible=false'
      ]
    };
  }, 'haiyu-quest-q4-5-');
}

function addOtherGuestRecord(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys=ON');
    database.prepare('INSERT INTO users(id,username,password_hash,role,name) VALUES(?,?,?,?,?)')
      .run('guest_002', 'other_guest', hashPassword('other-guest-password'), 'guest', '测试客人');
    database.prepare(`INSERT INTO health_records(guest_id,record_type,value,unit,note,recorded_at,recorded_by)
      VALUES(?,?,?,?,?,?,?)`).run('guest_002', '私有指标', 'other-guest-secret', 'unit', 'must not be returned', '2026-09-15T08:00:00Z', 'staff_001');
  } finally {
    database.close();
  }
}

async function guestToken(baseUrl) {
  const result = await request(baseUrl, '/auth/login', {
    method: 'POST',
    body: { username: 'guest_demo', password: 'guest2026', role: 'guest' }
  });
  assert.equal(result.status, 200);
  return result.data.token;
}

async function request(baseUrl, route, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, data: await response.json() };
}
