function dateValue(value) {
  const result = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError('environment cache clock returned an invalid date');
  return result;
}

export function createCachedLoader({ read, write, clock = () => new Date(), ttlMs = 30 * 60 * 1000 }) {
  if (typeof read !== 'function' || typeof write !== 'function') throw new TypeError('environment cache needs read and write functions');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('environment cache ttlMs must be positive');

  return async function loadCached(key, loader, { forceRefresh = false } = {}) {
    const now = dateValue(clock());
    const cached = await read(key);
    if (!forceRefresh && cached && ['available', 'demo'].includes(cached.status)
      && dateValue(cached.expiresAt).getTime() > now.getTime()) {
      return { ...cached, freshness: 'fresh', cache: 'hit' };
    }

    try {
      const payload = await loader();
      if (!payload || !['available', 'demo'].includes(payload.status)) {
        throw new Error('environment provider did not return an available snapshot');
      }
      const loadedAt = dateValue(clock());
      const snapshot = {
        ...payload,
        snapshotKey: key,
        retrievedAt: payload.retrievedAt || loadedAt.toISOString(),
        expiresAt: new Date(loadedAt.getTime() + ttlMs).toISOString()
      };
      await write(key, snapshot);
      return { ...snapshot, freshness: 'fresh', cache: cached ? 'refreshed' : 'miss' };
    } catch (error) {
      if (cached) return {
        ...cached,
        status: 'stale',
        freshness: 'stale',
        cache: 'stale',
        errorCode: error?.code || 'ENVIRONMENT_PROVIDER_UNAVAILABLE'
      };
      return {
        snapshotKey: key,
        status: 'unavailable',
        freshness: 'unavailable',
        cache: 'miss',
        payload: null,
        errorCode: error?.code || 'ENVIRONMENT_PROVIDER_UNAVAILABLE'
      };
    }
  };
}
