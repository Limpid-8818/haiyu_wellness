import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as runtime from '../src/environment-budget.js';
import * as legacy from '../../scripts/resources/stage27-r4-budget-accounts.js';
import { fetchOpenMeteoWeather, fetchOpenMeteoMarine, fetchQWeatherTide } from '../src/environment-providers.js';

const taskId = 'g04-synthetic-caller';
function fixture(t, baselineUsed = 0) {
  const directory = fs.mkdtempSync(path.join(process.env.RESOURCE_TMPDIR || os.tmpdir(), 'g04-budget-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { filePath: path.join(directory, 'account.jsonl'), taskId, baselineUsed, provider: 'local-stub' };
}
function setProviderEnvironment(t, options) {
  for (const [key, value] of Object.entries({ ENVIRONMENT_PROVIDER_BUDGET_LEDGER_PATH: options?.filePath,
    CODEX_TASK_ID: options?.taskId, ENVIRONMENT_PROVIDER_BUDGET_BASELINE: options?.baselineUsed })) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key]; else process.env[key] = String(value);
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}
const query = { latitude: 0, longitude: 0, date: '2030-01-01' };
const response = { ok: true, json: async () => ({ current: { time: '2030-01-01T00:00:00Z' } }) };

test('unconfigured accounting and ordinary stub provider perform no budget filesystem I/O', async t => {
  setProviderEnvironment(t, null);
  for (const name of ['mkdirSync', 'existsSync', 'openSync', 'statSync', 'readFileSync', 'writeFileSync', 'unlinkSync']) {
    t.mock.method(fs, name, () => { throw new Error(`unexpected fs.${name}`); });
  }
  assert.equal(await runtime.reserveEnvironmentProviderRequest({}), null);
  let calls = 0;
  const weather = await fetchOpenMeteoWeather({ ...query, fetchImpl: async (_url, options) => {
    assert.ok(options.signal instanceof AbortSignal); calls += 1; return response;
  } });
  assert.equal(calls, 1);
  assert.equal(weather.status, 'available');
});

test('configured accounting rejects missing identity or invalid baseline/limit before writing or fetching', async t => {
  const options = fixture(t);
  for (const change of [{ taskId: '' }, { baselineUsed: NaN }, { baselineUsed: -1 }, { baselineUsed: 0.5 },
    { baselineUsed: 7 }, { limit: 7 }, { limit: 0 }, { limit: 1.5 }]) {
    await assert.rejects(runtime.reserveEnvironmentProviderRequest({ ...options, ...change }), { code: 'R4_ENV_BUDGET_BINDING' });
  }
  assert.deepEqual(fs.readdirSync(path.dirname(options.filePath)), []);
  setProviderEnvironment(t, { ...options, taskId: '' });
  await assert.rejects(fetchOpenMeteoWeather({ ...query, fetchImpl: () => assert.fail('must not fetch') }), { code: 'R4_ENV_BUDGET_BINDING' });
});

test('runtime and frozen tool share six-request/timeout, journal and cumulative success/failure contracts', async t => {
  assert.deepEqual(runtime.ENVIRONMENT_PROVIDER_LIMITS, legacy.STAGE27_R4_ENV_LIMITS);
  for (const implementation of [legacy, runtime]) {
    const options = fixture(t, 2);
    for (const outcome of ['success', 'failed']) {
      const reservation = await implementation.reserveEnvironmentProviderRequest(options);
      assert.equal(reservation.usedBefore, outcome === 'success' ? 2 : 3);
      reservation.finish(outcome);
    }
    const rows = runtime.readHashedBudgetJsonl(options.filePath);
    assert.deepEqual(rows, legacy.readHashedBudgetJsonl(options.filePath));
    assert.deepEqual(runtime.reconcileEnvironmentBudget({ ...options, rows }), { used: 4, remaining: 2 });
    assert.deepEqual(legacy.reconcileEnvironmentBudget({ ...options, rows }), { used: 4, remaining: 2 });
    for (const outcome of ['failed', 'success']) (await runtime.reserveEnvironmentProviderRequest(options)).finish(outcome);
    assert.deepEqual(legacy.reconcileEnvironmentBudget({ ...options, rows: legacy.readHashedBudgetJsonl(options.filePath) }), { used: 6, remaining: 0 });
    const frozen = fs.readFileSync(options.filePath);
    await assert.rejects(runtime.reserveEnvironmentProviderRequest(options), { code: 'R4_ENV_BUDGET_EXHAUSTED' });
    assert.deepEqual(fs.readFileSync(options.filePath), frozen);
    assert.equal(fs.existsSync(`${options.filePath}.lock`), false);
  }
});

test('existing legacy baseline and used attempts are continued without resetting allowance', async t => {
  const options = fixture(t, 3);
  legacy.initializeEnvironmentBudgetFile(options);
  (await legacy.reserveEnvironmentProviderRequest(options)).finish('failed');
  const prefix = fs.readFileSync(options.filePath);
  const reservation = await runtime.reserveEnvironmentProviderRequest(options);
  assert.equal(reservation.usedBefore, 4);
  reservation.finish('success');
  assert.deepEqual(fs.readFileSync(options.filePath).subarray(0, prefix.length), prefix);
  assert.deepEqual(legacy.reconcileEnvironmentBudget({ ...options, rows: legacy.readHashedBudgetJsonl(options.filePath) }), { used: 5, remaining: 1 });
});

test('all provider outcomes are charged before fetch and failed/invalid responses are recorded', async t => {
  const options = fixture(t);
  setProviderEnvironment(t, options);
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response; };
  await fetchOpenMeteoWeather({ ...query, fetchImpl });
  await fetchOpenMeteoMarine({ ...query, fetchImpl });
  await assert.rejects(fetchOpenMeteoWeather({ ...query, fetchImpl: async () => { calls += 1; throw new Error('offline failure'); } }));
  await assert.rejects(fetchOpenMeteoMarine({ ...query, fetchImpl: async () => { calls += 1; return { ok: false, status: 503 }; } }));
  await assert.rejects(fetchQWeatherTide({ stationId: 'TEST_ONLY', date: query.date, baseUrl: 'https://stub.invalid',
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ code: '401' }) }; } }));
  await assert.rejects(fetchOpenMeteoWeather({ ...query, fetchImpl: async () => { calls += 1; return { ok: true, json: async () => { throw new Error('invalid JSON'); } }; } }));
  await assert.rejects(fetchOpenMeteoWeather({ ...query, fetchImpl: () => assert.fail('exhausted account must not fetch') }), { code: 'R4_ENV_BUDGET_EXHAUSTED' });
  assert.equal(calls, 6);
  const rows = runtime.readHashedBudgetJsonl(options.filePath);
  assert.deepEqual(rows.filter(r => r.event.endsWith('-finished')).map(r => r.outcome), ['success', 'success', 'failed', 'failed', 'failed', 'failed']);
  assert.deepEqual(runtime.reconcileEnvironmentBudget({ ...options, rows }), { used: 6, remaining: 0 });
});

test('in-flight request blocks a second reservation; completion and duplicate completion are serialized', async t => {
  const options = fixture(t);
  const first = await runtime.reserveEnvironmentProviderRequest(options);
  const prefix = fs.readFileSync(options.filePath);
  await assert.rejects(runtime.reserveEnvironmentProviderRequest(options), error => error.code === 'R4_BUDGET_UNKNOWN' && /in-flight/.test(error.message));
  assert.deepEqual(fs.readFileSync(options.filePath), prefix);
  first.finish('success');
  const completed = fs.readFileSync(options.filePath);
  assert.throws(() => first.finish('success'), /matching in-flight/);
  assert.deepEqual(fs.readFileSync(options.filePath), completed);
  (await runtime.reserveEnvironmentProviderRequest(options)).finish('unrecognized-outcome');
  assert.equal(runtime.readHashedBudgetJsonl(options.filePath).at(-1).outcome, 'failed');
});

test('lost old attempt remains in-flight and cannot be reused or reset', async t => {
  const options = fixture(t, 2);
  await legacy.reserveEnvironmentProviderRequest(options); // synthetic crash: no finish
  const prefix = fs.readFileSync(options.filePath);
  await assert.rejects(runtime.reserveEnvironmentProviderRequest(options), /in-flight/);
  assert.deepEqual(fs.readFileSync(options.filePath), prefix);
});

test('overlapping stub provider calls admit exactly one request and retain its actual outcome', async t => {
  const options = fixture(t);
  setProviderEnvironment(t, options);
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const first = fetchOpenMeteoWeather({ ...query, fetchImpl: async () => { calls += 1; await pending; return response; } });
  try {
    await assert.rejects(fetchOpenMeteoWeather({ ...query, fetchImpl: () => assert.fail('overlap must not fetch') }), error => error.code === 'R4_BUDGET_UNKNOWN' && /in-flight/.test(error.message));
  } finally { release(); }
  await first;
  assert.equal(calls, 1);
  assert.deepEqual(runtime.reconcileEnvironmentBudget({ ...options, rows: runtime.readHashedBudgetJsonl(options.filePath) }), { used: 1, remaining: 5 });
});

test('identity, baseline and stored limit mismatches reject without journal mutation', async t => {
  const options = fixture(t);
  (await runtime.reserveEnvironmentProviderRequest(options)).finish('success');
  const prefix = fs.readFileSync(options.filePath);
  for (const change of [{ taskId: 'another-caller' }, { baselineUsed: 1 }, { limit: 5 }]) {
    await assert.rejects(runtime.reserveEnvironmentProviderRequest({ ...options, ...change }), /baseline and limit/);
    assert.deepEqual(fs.readFileSync(options.filePath), prefix);
  }
});

test('oversized journals and events are rejected by bounded readers before any new reservation', async t => {
  const options = fixture(t);
  fs.writeFileSync(options.filePath, '');
  fs.truncateSync(options.filePath, 8 * 1024 * 1024 + 1);
  await assert.rejects(runtime.reserveEnvironmentProviderRequest(options), /bounded budget-account size/);
  fs.writeFileSync(options.filePath, 'x'.repeat(64 * 1024 + 1));
  await assert.rejects(runtime.reserveEnvironmentProviderRequest(options), /incomplete line over 64 KiB/);
  assert.equal(fs.statSync(options.filePath).size, 64 * 1024 + 1);
});

test('corrupt hash, broken prefix, truncated/empty journal and duplicate events all fail closed', async t => {
  const original = fixture(t);
  (await runtime.reserveEnvironmentProviderRequest(original)).finish('success');
  const good = fs.readFileSync(original.filePath, 'utf8');
  for (const bad of [good.replace('local-stub', 'altered-value'), good.slice(0, -2), '', '{bad json}\n']) {
    const options = fixture(t);
    fs.writeFileSync(options.filePath, bad);
    await assert.rejects(runtime.reserveEnvironmentProviderRequest(options));
    assert.equal(fs.readFileSync(options.filePath, 'utf8'), bad);
  }
  const options = fixture(t);
  const rows = runtime.readHashedBudgetJsonl(original.filePath);
  for (const row of rows) { const { eventSha256: _hash, journal: _journal, ...entry } = row; legacy.appendHashedBudgetEvent(options.filePath, entry); }
  const { eventSha256: _hash, journal: _journal, ...reused } = rows[1];
  legacy.appendHashedBudgetEvent(options.filePath, reused);
  const before = fs.readFileSync(options.filePath);
  await assert.rejects(runtime.reserveEnvironmentProviderRequest(options), /malformed/);
  assert.deepEqual(fs.readFileSync(options.filePath), before);
  const broken = fixture(t);
  fs.writeFileSync(broken.filePath, good.split('\n').slice(1).join('\n'));
  await assert.rejects(runtime.reserveEnvironmentProviderRequest(broken), /prefix/);
});

test('active, unknown and apparently dead/old lock owners are diagnosed without removing locks', async t => {
  const options = fixture(t);
  const lockPath = `${options.filePath}.lock`;
  for (const lock of [JSON.stringify({ pid: process.pid, taskId }), '{unknown owner', JSON.stringify({ pid: 2147483647, taskId })]) {
    fs.writeFileSync(lockPath, lock);
    fs.utimesSync(lockPath, 0, 0);
    await assert.rejects(runtime.reserveEnvironmentProviderRequest(options), error => error.code === 'R4_ENV_BUDGET_BUSY' && /unverified/.test(error.message));
    assert.equal(fs.readFileSync(lockPath, 'utf8'), lock);
    assert.equal(fs.existsSync(options.filePath), false);
  }
});

test('finish lock contention preserves the charged in-flight attempt until its owner can finish', async t => {
  const options = fixture(t);
  const reservation = await runtime.reserveEnvironmentProviderRequest(options);
  const prefix = fs.readFileSync(options.filePath);
  const lockPath = `${options.filePath}.lock`;
  fs.writeFileSync(lockPath, 'synthetic competing owner');
  assert.throws(() => reservation.finish('success'), { code: 'R4_ENV_BUDGET_BUSY' });
  assert.deepEqual(fs.readFileSync(options.filePath), prefix);
  fs.unlinkSync(lockPath); // only this test's own synthetic lock
  reservation.finish('success');
  assert.deepEqual(runtime.reconcileEnvironmentBudget({ ...options, rows: runtime.readHashedBudgetJsonl(options.filePath) }), { used: 1, remaining: 5 });
});
