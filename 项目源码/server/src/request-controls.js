import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AppError } from './errors.js';

const DEFAULTS = {
  login: { windowMs: 900000, ip: 60, identity: 15 },
  register: { windowMs: 3600000, ip: 20, identity: 5 },
  assistant: { windowMs: 60000, ip: 120, identity: 60 },
  password: { windowMs: 900000, ip: 60, identity: 20 }
};

function positiveInteger(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`${name} 必须是 1 至 ${maximum} 的整数`);
  }
  return Number(value);
}

export function readRequestControlConfig(env = process.env) {
  const config = { maxBuckets: positiveInteger(env.REQUEST_LIMIT_MAX_BUCKETS, 10000, 100000, 'REQUEST_LIMIT_MAX_BUCKETS') };
  for (const [scope, defaults] of Object.entries(DEFAULTS)) {
    const prefix = `REQUEST_LIMIT_${scope.toUpperCase()}`;
    config[scope] = {
      windowMs: positiveInteger(env[`${prefix}_WINDOW_MS`], defaults.windowMs, 86400000, `${prefix}_WINDOW_MS`),
      ip: positiveInteger(env[`${prefix}_IP`], defaults.ip, 100000, `${prefix}_IP`),
      identity: positiveInteger(env[`${prefix}_IDENTITY`], defaults.identity, 100000, `${prefix}_IDENTITY`)
    };
  }
  return config;
}

// 单进程固定窗口；不保存原始账号，不启动定时器，不逐出活跃桶。
export function createRequestControls({ config = readRequestControlConfig(), clock = () => performance.now() } = {}) {
  // 对程序化注入也执行相同校验，避免测试或嵌入场景意外禁用保护。
  const env = { REQUEST_LIMIT_MAX_BUCKETS: config.maxBuckets };
  for (const scope of Object.keys(DEFAULTS)) {
    for (const [field, suffix] of [['windowMs', 'WINDOW_MS'], ['ip', 'IP'], ['identity', 'IDENTITY']]) {
      env[`REQUEST_LIMIT_${scope.toUpperCase()}_${suffix}`] = config[scope]?.[field];
    }
  }
  const limits = readRequestControlConfig(env);
  const buckets = new Map();
  const digest = value => createHash('sha256').update(String(value)).digest('hex');
  return {
    get size() { return buckets.size; },
    consume(scope, { ip, identity }) {
      const rule = limits[scope];
      if (!rule) throw new Error(`未知请求限制类型: ${scope}`);
      const now = clock();
      if (!Number.isFinite(now)) throw new Error('请求限制时钟无效');
      const dimensions = [['ip', ip], ...(identity == null ? [] : [['identity', identity]])];
      const entries = dimensions.map(([dimension, value]) => {
        const key = `${scope}:${dimension}:${digest(value)}`;
        let bucket = buckets.get(key);
        if (bucket && bucket.expiresAt <= now) { buckets.delete(key); bucket = null; }
        return { key, bucket, limit: rule[dimension] };
      });
      const blocked = entries.filter(item => item.bucket?.count >= item.limit);
      if (blocked.length) return { allowed: false,
        retryAfter: Math.max(1, Math.ceil(Math.max(...blocked.map(item => item.bucket.expiresAt - now)) / 1000)) };
      const needed = entries.filter(item => !item.bucket).length;
      if (buckets.size + needed > limits.maxBuckets) {
        for (const [key, bucket] of buckets) if (bucket.expiresAt <= now) buckets.delete(key);
        if (buckets.size + needed > limits.maxBuckets) {
          let earliest = now + rule.windowMs;
          for (const bucket of buckets.values()) earliest = Math.min(earliest, bucket.expiresAt);
          return { allowed: false, retryAfter: Math.max(1, Math.ceil((earliest - now) / 1000)) };
        }
      }
      // 无 await：同一进程内检查全部维度并预占，异步执行不会并发超发。
      for (const entry of entries) {
        const bucket = entry.bucket || { count: 0, expiresAt: now + rule.windowMs };
        bucket.count += 1;
        buckets.set(entry.key, bucket);
      }
      return { allowed: true };
    }
  };
}

export function requestLimit(scope) {
  return (req, res, next) => {
    const body = req.body;
    const text = value => typeof value === 'string' ? value : '';
    const identity = scope === 'login' ? text(body?.username).trim().toLowerCase()
      : scope === 'register' ? text(body?.phone).trim() : req.user?.id;
    // 仅 socket 对端可信；不读取 X-Forwarded-For/Forwarded/自报 guestId/runId。
    const ip = (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
    const result = req.app.locals.requestControls.consume(scope, { ip, identity });
    if (result.allowed) return next();
    res.set('Retry-After', String(result.retryAfter));
    throw new AppError(429, 'REQUEST_LIMIT_EXCEEDED', '请求过于频繁，请稍后再试');
  };
}
