import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessClock, shiftDateKey, systemBusinessClock } from '../src/clock.js';

test('dateKey/timeKey 按业务时区取墙钟值', () => {
  const clock = createBusinessClock({ now: () => new Date('2026-10-16T00:30:00Z') });
  assert.equal(clock.dateKey(), '2026-10-16');
  assert.equal(clock.timeKey(), '08:30');
  assert.equal(clock.dateKey('2026-01-01T16:30:00Z'), '2026-01-02', ' UTC 时刻需折算到上海业务日');
});

test('localToUtc 把业务墙钟时间转换为正确的 UTC 时刻', () => {
  assert.equal(systemBusinessClock.localToUtc('2026-10-16', '08:00'), '2026-10-16T00:00:00.000Z');
  assert.equal(systemBusinessClock.localToUtc('2026-10-16', '23:05'), '2026-10-16T15:05:00.000Z');
  assert.equal(systemBusinessClock.localToUtc('2026-10-16'), '2026-10-15T16:00:00.000Z', '缺省为当日零点');
});

test('localToUtc 对夏令时时区两轮校正', () => {
  const newYork = createBusinessClock({ timeZone: 'America/New_York' });
  assert.equal(newYork.localToUtc('2026-07-15', '09:00'), '2026-07-15T13:00:00.000Z', '夏令时 EDT 为 UTC-4');
  assert.equal(newYork.localToUtc('2026-01-15', '09:00'), '2026-01-15T14:00:00.000Z', '冬令时 EST 为 UTC-5');
});

test('shiftDateKey 处理跨月、跨年与闰年边界', () => {
  assert.equal(shiftDateKey('2026-12-31', 1), '2027-01-01');
  assert.equal(shiftDateKey('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDateKey('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDateKey('2026-10-16', 0), '2026-10-16');
});
