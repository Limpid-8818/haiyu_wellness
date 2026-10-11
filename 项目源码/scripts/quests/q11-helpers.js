import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOk, databaseQuery, login, request, withBothDatabaseApis } from './q10-helpers.js';

const questDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectDirectory = path.resolve(questDirectory, '../..');
const webEntry = path.join(projectDirectory, 'web/src/main.jsx');

export async function withQ11Apis(callback, options = {}) {
  return withBothDatabaseApis(async context => callback(context), options);
}

export function uniquePart() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function createStaff(baseUrl, token, jobType, suffix = uniquePart()) {
  const input = {
    name: `测试${jobType}${suffix.slice(-4)}`,
    username: `q11_${suffix}`,
    phone: `139${String(Date.now()).slice(-8)}`,
    password: 'stage11-pass-2026',
    jobType
  };
  const result = await request(baseUrl, '/dean/staff', { method: 'POST', token, body: input });
  return { input, result };
}

export async function loginAccount(baseUrl, username, password, role = 'staff') {
  return request(baseUrl, '/auth/login', { method: 'POST', body: { username, password, role } });
}

export async function registerGuest(baseUrl, suffix = uniquePart()) {
  const phone = `139${String(Date.now()).slice(-8)}`;
  const body = { name: `测试客人${suffix.slice(-4)}`, phone, password: 'guest-stage11-pass', confirmPassword: 'guest-stage11-pass' };
  return { body, result: await request(baseUrl, '/auth/register', { method: 'POST', body }) };
}

export function localDate(offset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export function dateRange(startOffset, nights) {
  return { checkIn: localDate(startOffset), checkOut: localDate(startOffset + nights) };
}

export async function checkWebSource(expectations) {
  const source = await readFile(webEntry, 'utf8');
  for (const expectation of expectations) assert.ok(source.includes(expectation), `web UI contract is missing: ${expectation}`);
}

export { assert, assertOk, databaseQuery, login, request };
