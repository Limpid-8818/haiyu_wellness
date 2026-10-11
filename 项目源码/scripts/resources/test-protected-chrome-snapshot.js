import assert from 'node:assert/strict';
import path from 'node:path';
import { validateProtectedChromeSnapshot } from './protected-chrome-snapshot.js';

const cacheParent = '/private/var/folders/test/X/com.google.Chrome.code_sign_clone';
const expectedCacheNames = [
  'code_sign_clone.7WCMBh', 'code_sign_clone.87prgQ', 'code_sign_clone.FGf0ku',
  'code_sign_clone.KlYqcP', 'code_sign_clone.Km1hwm', 'code_sign_clone.Ly34OH',
  'code_sign_clone.b9cnAV', 'code_sign_clone.fpg2xz', 'code_sign_clone.jcG5XI',
  'code_sign_clone.ooLA7h', 'code_sign_clone.xkTnpB'
];
const protectedChrome = { pid: 7081, startTime: 'Thu Oct 1 17:27:01 2026', fingerprint: 'user-chrome-fingerprint' };
const knownCacheNames = expectedCacheNames.slice().sort();
const snapshot = (name = 'code_sign_clone.jcG5XI', overrides = {}) => ({
  identity: { ...protectedChrome },
  cacheNames: knownCacheNames,
  clonePaths: [path.join(cacheParent, name, 'Google Chrome.app/Contents/MacOS/Google Chrome')],
  ...overrides
});

const initial = validateProtectedChromeSnapshot(snapshot(), { protectedChrome, cacheParent, expectedCacheNames });
assert.equal(initial.ok, true, 'first snapshot accepts the currently observed known .jcG5XI handle');
assert.deepEqual(initial.baseline.clonePaths, snapshot().clonePaths);

const changedHandle = validateProtectedChromeSnapshot(snapshot('code_sign_clone.Ly34OH'), {
  protectedChrome, cacheParent, expectedCacheNames, baseline: initial.baseline
});
assert.equal(changedHandle.ok, false);
assert.equal(changedHandle.code, 'USER_CHROME_CACHE_HANDLE_CHANGED');

const addedCache = validateProtectedChromeSnapshot(snapshot(undefined, {
  cacheNames: [...knownCacheNames, 'code_sign_clone.NEWITEM']
}), { protectedChrome, cacheParent, expectedCacheNames });
assert.equal(addedCache.ok, false);
assert.equal(addedCache.code, 'CHROME_CACHE_BASELINE_CHANGED');

const changedIdentity = validateProtectedChromeSnapshot(snapshot(undefined, {
  identity: { ...protectedChrome, fingerprint: 'different-process' }
}), { protectedChrome, cacheParent, expectedCacheNames });
assert.equal(changedIdentity.ok, false);
assert.equal(changedIdentity.code, 'USER_CHROME_BASELINE_CHANGED');

console.log('PROTECTED_CHROME_SNAPSHOT_TESTS_PASS: 4');
