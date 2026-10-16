const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Shanghai';

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('business clock returned an invalid date');
  return date;
}

// 纯业务日期键运算，与时区无关；各业务模块不再各自复制这份实现。
export function shiftDateKey(dateKey, days) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

export function createBusinessClock({ timeZone = DEFAULT_BUSINESS_TIME_ZONE, now = () => new Date() } = {}) {
  if (typeof now !== 'function') throw new TypeError('business clock source must be a function');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const localParts = value => Object.fromEntries(
    formatter.formatToParts(asDate(value)).filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])
  );

  return Object.freeze({
    timeZone,
    instant: () => asDate(now()),
    utc: () => asDate(now()).toISOString(),
    parts: (value = now()) => localParts(value),
    dateKey: (value = now()) => {
      const parts = localParts(value);
      return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    },
    timeKey: (value = now()) => {
      const parts = localParts(value);
      return `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
    },
    // 业务墙钟时间（本时区的某日某刻）转 UTC ISO；两轮校正兼容夏令时时区，替代各处硬编码的固定偏移。
    localToUtc: (dateKey, timeKey = '00:00') => {
      const [year, month, day] = String(dateKey).split('-').map(Number);
      const [hour = 0, minute = 0] = String(timeKey).split(':').map(Number);
      const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
      let stamp = wallAsUtc;
      for (let pass = 0; pass < 2; pass += 1) {
        const parts = localParts(stamp);
        const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
        stamp = wallAsUtc - (observed - stamp);
      }
      return new Date(stamp).toISOString();
    }
  });
}

const injectedBusinessInstant = process.env.BUSINESS_CLOCK_NOW || '';

export const systemBusinessClock = createBusinessClock({
  now: () => injectedBusinessInstant ? new Date(injectedBusinessInstant) : new Date()
});
