import path from 'node:path';

function sortedUnique(values) {
  return [...new Set((values || []).map(value => String(value)))].sort();
}

function normalizeStartTime(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

export function validateProtectedChromeSnapshot(snapshot, {
  protectedChrome, cacheParent, expectedCacheNames, baseline = null
}) {
  const expectedNames = sortedUnique(expectedCacheNames);
  const names = sortedUnique(snapshot?.cacheNames);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) {
    return { ok: false, code: 'CHROME_CACHE_BASELINE_CHANGED', message: 'Chrome clone-cache directory list differs from the approved 11-item set' };
  }

  const identity = snapshot?.identity;
  if (!identity || Number(identity.pid) !== Number(protectedChrome?.pid)
    || normalizeStartTime(identity.startTime) !== normalizeStartTime(protectedChrome?.startTime)
    || identity.fingerprint !== protectedChrome?.fingerprint) {
    return { ok: false, code: 'USER_CHROME_BASELINE_CHANGED', message: 'protected Chrome process identity differs from the recorded PID, start time, or fingerprint' };
  }

  const allowedNames = new Set(expectedNames);
  const parent = path.resolve(cacheParent);
  const handles = sortedUnique(snapshot?.clonePaths);
  if (!handles.length) {
    return { ok: false, code: 'USER_CHROME_CACHE_HANDLE_MISSING', message: 'protected Chrome has no open handle in the approved code-sign clone cache' };
  }
  for (const handle of handles) {
    const absolute = path.resolve(handle);
    const relative = path.relative(parent, absolute);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { ok: false, code: 'USER_CHROME_CACHE_HANDLE_UNEXPECTED', message: 'protected Chrome has an open clone-cache handle outside the approved cache parent' };
    }
    const cacheName = relative.split(path.sep)[0];
    if (!allowedNames.has(cacheName)) {
      return { ok: false, code: 'USER_CHROME_CACHE_HANDLE_UNEXPECTED', message: 'protected Chrome has an open handle in an unapproved clone-cache directory' };
    }
  }

  if (baseline) {
    const baselineHandles = sortedUnique(baseline.clonePaths);
    if (JSON.stringify(handles) !== JSON.stringify(baselineHandles)) {
      return { ok: false, code: 'USER_CHROME_CACHE_HANDLE_CHANGED', message: 'protected Chrome clone-cache handle set changed since this run began' };
    }
    if (Number(baseline.identity?.pid) !== Number(identity.pid)
      || normalizeStartTime(baseline.identity?.startTime) !== normalizeStartTime(identity.startTime)
      || baseline.identity?.fingerprint !== identity.fingerprint) {
      return { ok: false, code: 'USER_CHROME_BASELINE_CHANGED', message: 'protected Chrome identity changed since this run began' };
    }
  }

  return { ok: true, baseline: {
    identity: { pid: Number(identity.pid), startTime: normalizeStartTime(identity.startTime), fingerprint: identity.fingerprint },
    cacheNames: names,
    clonePaths: handles
  } };
}
