import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestControls, readRequestControlConfig } from '../src/request-controls.js';

test('request configuration rejects zero, negative, empty, fractional and excessive values even in tests', () => {
  for (const value of ['0', '-1', '', 'NaN', '1.5', 'Infinity', '100001', ' 1']) {
    assert.throws(() => readRequestControlConfig({ NODE_ENV: 'test', REQUEST_LIMIT_LOGIN_IP: value }), /REQUEST_LIMIT_LOGIN_IP/);
  }
  assert.throws(() => readRequestControlConfig({ REQUEST_LIMIT_ASSISTANT_WINDOW_MS: '86400001' }));
  assert.throws(() => createRequestControls({ config: { login: { ip: 0 } } }));
  assert.equal(readRequestControlConfig({ NODE_ENV: 'test' }).login.ip, 60);
});

test('independent IP/account windows reserve synchronously, do not partially charge a rejection, and recover exactly at expiry', async () => {
  let time = 0;
  const config = readRequestControlConfig({ REQUEST_LIMIT_LOGIN_IP: '2', REQUEST_LIMIT_LOGIN_IDENTITY: '1', REQUEST_LIMIT_LOGIN_WINDOW_MS: '1500' });
  const controls = createRequestControls({ config, clock: () => time });
  assert.equal(controls.consume('login', { ip: 'a', identity: 'one' }).allowed, true);
  assert.deepEqual(controls.consume('login', { ip: 'b', identity: 'one' }), { allowed: false, retryAfter: 2 });
  assert.equal(controls.consume('login', { ip: 'a', identity: 'two' }).allowed, true);
  assert.equal(controls.consume('login', { ip: 'a', identity: 'three' }).allowed, false);
  assert.equal(controls.consume('login', { ip: 'b', identity: 'three' }).allowed, true);
  time = 1499;
  assert.deepEqual(controls.consume('login', { ip: 'a', identity: 'one' }), { allowed: false, retryAfter: 1 });
  time = 1500;
  assert.equal(controls.consume('login', { ip: 'a', identity: 'one' }).allowed, true);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve().then(() =>
    controls.consume('login', { ip: 'concurrent', identity: `unique-${i}` }))));
  assert.equal(results.filter(result => result.allowed).length, 2);
});

test('bounded storage rejects capacity pressure without evicting active counters and reclaims expired buckets', () => {
  let time = 0;
  const config = readRequestControlConfig({ REQUEST_LIMIT_MAX_BUCKETS: '4', REQUEST_LIMIT_LOGIN_IDENTITY: '1', REQUEST_LIMIT_LOGIN_WINDOW_MS: '1000' });
  const controls = createRequestControls({ config, clock: () => time });
  controls.consume('login', { ip: 'a', identity: 'one' });
  controls.consume('login', { ip: 'b', identity: 'two' });
  for (let i = 0; i < 100; i++) assert.equal(controls.consume('login', { ip: `ip-${i}`, identity: `id-${i}` }).allowed, false);
  assert.equal(controls.size, 4);
  assert.equal(controls.consume('login', { ip: 'c', identity: 'one' }).allowed, false);
  time = 1000;
  assert.equal(controls.consume('login', { ip: 'new', identity: 'new' }).allowed, true);
  assert.equal(controls.size, 2);
});
