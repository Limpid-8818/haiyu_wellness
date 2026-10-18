import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { hashPassword, verifyPassword, hashPasswordAsync, verifyPasswordAsync } from '../src/password.js';

test('async scrypt preserves salt:hex interoperability with synchronous CLI/seed entry points', async () => {
  const old = hashPassword('合成-Password-123');
  const fresh = await hashPasswordAsync('合成-Password-123');
  assert.match(fresh, /^[0-9a-f]{32}:[0-9a-f]{128}$/);
  assert.notEqual(fresh, await hashPasswordAsync('合成-Password-123'));
  assert.equal(await verifyPasswordAsync('合成-Password-123', old), true);
  assert.equal(verifyPassword('合成-Password-123', fresh), true);
  assert.equal(await verifyPasswordAsync('wrong', fresh), false);
  assert.equal(verifyPassword('wrong', fresh), false);
});

test('async and sync verification reject malformed hashes and non-string input consistently', async () => {
  for (const hash of [null, undefined, {}, '', ':', 'salt:nohex', 'salt:abc', `salt:${'00'.repeat(64)}:extra`]) {
    assert.equal(verifyPassword('password', hash), false);
    assert.equal(await verifyPasswordAsync('password', hash), false);
  }
  for (const input of [null, {}, undefined]) {
    assert.equal(await verifyPasswordAsync(input, `salt:${'00'.repeat(64)}`), false);
    await assert.rejects(hashPasswordAsync(input), TypeError);
  }
});

test('async derive errors propagate for hashing and fail verification closed', async t => {
  t.mock.method(crypto, 'scrypt', (_password, _salt, _length, callback) => queueMicrotask(() => callback(new Error('synthetic derive failure'))));
  await assert.rejects(hashPasswordAsync('password'), /synthetic derive failure/);
  assert.equal(await verifyPasswordAsync('password', `salt:${'00'.repeat(64)}`), false);
});
