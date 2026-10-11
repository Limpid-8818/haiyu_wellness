import assert from 'node:assert/strict';
import { createBusinessClock } from '../../server/src/clock.js';

function midnightCycle() {
  let instant = new Date('2026-09-29T15:59:00.000Z');
  const shanghai = createBusinessClock({ timeZone: 'Asia/Shanghai', now: () => instant });
  const utc = createBusinessClock({ timeZone: 'UTC', now: () => instant });
  const before = {
    utc: shanghai.utc(),
    institutionDate: shanghai.dateKey(),
    institutionTime: shanghai.timeKey(),
    utcDate: utc.dateKey()
  };
  instant = new Date('2026-09-29T16:01:00.000Z');
  const after = {
    utc: shanghai.utc(),
    institutionDate: shanghai.dateKey(),
    institutionTime: shanghai.timeKey(),
    utcDate: utc.dateKey()
  };
  return { before, after };
}

export async function run() {
  const first = midnightCycle();
  const second = midnightCycle();
  assert.deepEqual(second, first, 'the injected midnight sequence must be repeatable');
  assert.deepEqual(first.before, {
    utc: '2026-09-29T15:59:00.000Z', institutionDate: '2026-09-29', institutionTime: '23:59', utcDate: '2026-09-29'
  });
  assert.deepEqual(first.after, {
    utc: '2026-09-29T16:01:00.000Z', institutionDate: '2026-09-30', institutionTime: '00:01', utcDate: '2026-09-29'
  });
  assert.notEqual(first.before.institutionDate, first.after.institutionDate);
  assert.equal(first.after.utcDate, first.before.utcDate, 'UTC and institutional business dates are independently represented');

  return { output: [
    `Before midnight: ${first.before.utc} UTC → Asia/Shanghai ${first.before.institutionDate} ${first.before.institutionTime}.`,
    `After midnight:  ${first.after.utc} UTC → Asia/Shanghai ${first.after.institutionDate} ${first.after.institutionTime}; UTC date remains ${first.after.utcDate}.`,
    'The two-minute advance used an injected clock only; the operating system clock was not changed.'
  ] };
}
