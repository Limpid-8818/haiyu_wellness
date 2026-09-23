import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/db.js';
test('password hashes are salted and verifiable', () => {
  const stored = hashPassword('correct-password');
  assert.notEqual(stored, 'correct-password');
  assert.equal(verifyPassword('correct-password', stored), true);
  assert.equal(verifyPassword('wrong-password', stored), false);
});
