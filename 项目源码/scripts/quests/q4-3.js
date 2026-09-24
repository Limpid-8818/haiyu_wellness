import assert from 'node:assert/strict';
import { withTemporaryApi } from './helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl }) => {
    const token = await guestToken(baseUrl);
    const before = await request(baseUrl, '/me', { token });
    assert.equal(before.status, 200);
    assert.equal(before.data.profile.room_no, 'A-203');

    const allowed = await request(baseUrl, '/me/profile', {
      method: 'PATCH',
      token,
      body: {
        phone: '13900000011',
        emergencyContact: '林先生 13900000012',
        mobility: '需陪同'
      }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.data.phone, '13900000011');
    assert.equal(allowed.data.profile.emergency_contact, '林先生 13900000012');
    assert.equal(allowed.data.profile.mobility, '需陪同');

    const forbidden = await request(baseUrl, '/me/profile', {
      method: 'PATCH',
      token,
      body: { phone: '13900000099', room: 'Z-999' }
    });
    assert.equal(forbidden.status, 400);
    assert.equal(forbidden.data.code, 'PROFILE_FIELD_NOT_ALLOWED');

    const after = await request(baseUrl, '/me', { token });
    assert.equal(after.status, 200);
    assert.equal(after.data.phone, '13900000011', 'rejected update must not partially change phone');
    assert.equal(after.data.profile.emergency_contact, '林先生 13900000012');
    assert.equal(after.data.profile.mobility, '需陪同');
    assert.equal(after.data.profile.room_no, 'A-203', 'room must remain unchanged');

    return {
      output: [
        'allowed HTTP 200 phone/emergencyContact/mobility verified',
        'room HTTP 400 PROFILE_FIELD_NOT_ALLOWED',
        'afterRejectedUpdate unchanged=true room=A-203'
      ]
    };
  }, 'haiyu-quest-q4-3-');
}

async function guestToken(baseUrl) {
  const result = await request(baseUrl, '/auth/login', {
    method: 'POST',
    body: { username: 'guest_demo', password: 'guest2026', role: 'guest' }
  });
  assert.equal(result.status, 200);
  assert.ok(result.data.token);
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
