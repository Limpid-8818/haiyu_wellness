// All server/ping/shutdown results below are OFFLINE substitutes, except the
// explicitly registered small Node exit(1) contract. No MySQL binary is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ResourceSession } from '../resources/resource-runtime.js';
import { budget, main } from './mysql-fixture.js';
import { classifyProcessResult, waitForMysqlReady, coordinateMysqlClose, shutdownDecision } from './mysql-lifecycle.js';

const pending = () => ({ status: 'failed', exitCode: 1, signal: null, timedOut: false, tail: 'OFFLINE socket not ready' });
const alive = () => ({ status: 'exited', exitCode: 0, signal: null, timedOut: false, tail: 'mysqld is alive\n' });
function clock(start = 0) {
  let instant = start;
  return { now: () => instant, sleep: async ms => { instant += ms; }, advance: ms => { instant += ms; } };
}

test('actual managed small Node exit1 returns failed and is pending only for readiness', async () => {
  const out = process.env.G23_AUDIT_ROOT, attempt = process.env.G23_ATTEMPT;
  assert.ok(out && attempt && process.env.CODEX_TASK_ID);
  const session = await ResourceSession.create({ taskId: process.env.CODEX_TASK_ID,
    auditRoot: path.join(out, 'runtime', `${attempt}-offline-node`),
    limits: { leaseMs: 900000, logBytes: 8388608, directoryBytes: 536870912 } });
  let result;
  try {
    result = await session.runProcess({ label: 'offline-node-exit1', kind: 'test', role: 'test',
      command: process.execPath, args: ['-e', "console.log('OFFLINE_NODE_EXIT1'); process.exit(1)"], cwd: process.cwd()
    }, { timeoutMs: 2000 });
    assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 1); assert.equal(result.signal, null); assert.equal(result.timedOut, false);
    assert.equal(classifyProcessResult(result, { allowPending: true }), 'pending');
    assert.throws(() => classifyProcessResult(result), /unexpected process result/);
  } finally { assert.equal((await session.close('offline-node-contract-complete')).ok, true); }
  fs.writeFileSync(path.join(out, `${attempt}-actual-node.json`), JSON.stringify({ offline: true,
    command: 'node -e OFFLINE_NODE_EXIT1/exit(1)', instanceId: session.instanceId, result,
    tempRemoved: !fs.existsSync(session.tempDir), meaning: 'actual ResourceSession nonzero contract, not a MySQL result'
  }, null, 2) + '\n', { flag: 'wx' });
});

test('offline pending then alive succeeds and never probes again', async () => {
  const time = clock(); let calls = 0;
  const result = await waitForMysqlReady({ ...time, deadline: 4000, probe: async timeout => {
    assert.ok(timeout <= 1200); calls++; time.advance(20); return calls === 1 ? pending() : alive();
  } });
  assert.equal(result.ready, true); assert.equal(result.probes, 2); assert.equal(calls, 2); assert.equal(result.elapsedMs, 190);
});

test('offline all-pending reaches shared deadline without exceeding it or probing again', async () => {
  const time = clock(); let calls = 0;
  await assert.rejects(waitForMysqlReady({ ...time, deadline: 4000, probe: async timeout => {
    calls++; time.advance(timeout); return pending();
  } }), /remained pending/);
  assert.equal(time.now(), 4000); assert.equal(calls, 3);
});

test('offline pending attempt bound is six even when probes exit instantly', async () => {
  const time = clock(); let calls = 0;
  await assert.rejects(waitForMysqlReady({ ...time, deadline: 4000, probe: async () => { calls++; return pending(); } }), /remained pending/);
  assert.equal(calls, 6); assert.ok(time.now() < 4000);
});

test('offline timeout, signal, spawn and nonterminal states immediately reject, not pending', async () => {
  const bad = [{ ...pending(), timedOut: true }, { ...pending(), signal: 'SIGTERM' },
    ...['stopped', 'signaled', 'spawn_failed', 'blocked', 'running'].map(status => ({ ...pending(), status })),
    { ...pending(), exitCode: null }, { ...pending(), status: 'exited' }];
  for (const result of bad) {
    const time = clock(); let calls = 0;
    await assert.rejects(waitForMysqlReady({ ...time, deadline: 4000, probe: async () => { calls++; return result; } }));
    assert.equal(calls, 1);
  }
  await assert.rejects(waitForMysqlReady({ deadline: 4000, now: () => 0, probe: async () => { throw new Error('offline spawn RPC failed'); } }), /spawn RPC/);
  await assert.rejects(waitForMysqlReady({ deadline: 4000, now: () => 0, probe: async () => ({ ...alive(), tail: 'OFFLINE wrong output' }) }), /must report alive/);
});

test('offline ordinary steps keep strict success0, no shared pending exception', () => {
  assert.equal(classifyProcessResult(alive()), 'success');
  assert.throws(() => classifyProcessResult(pending()), /unexpected process result/);
});

test('offline early failure waits for socket readiness in unused work time before one close', async () => {
  const time = clock(2095); let pings = 0; const calls = [];
  const result = await coordinateMysqlClose({ ...time, started: true, ready: false, workDeadline: 29000,
    getState: async timeoutMs => { assert.ok(timeoutMs <= 500); calls.push('state'); return 'running'; },
    probe: async () => { calls.push('ping'); pings++; time.advance(20); return pings === 1 ? pending() : alive(); },
    close: async () => { calls.push('close'); assert.equal(pings, 2); time.advance(12000); return { ok: true }; }
  });
  assert.deepEqual(calls, ['state', 'ping', 'ping', 'close']); assert.equal(result.preparation, 'ready-before-close');
  assert.equal(result.closeCalls, 1); assert.equal(result.workReserveExceeded, false); assert.ok(time.now() <= 29000 + 14000);
  assert.equal(result.cleanupBudgetExceeded, false);
});

test('offline exhausted work never borrows exit reserve and protected close still runs once', async () => {
  const time = clock(29000); let probes = 0, closes = 0;
  const result = await coordinateMysqlClose({ ...time, started: true, ready: false, workDeadline: 29000,
    getState: async () => 'running', probe: async () => { probes++; return pending(); },
    close: async () => { closes++; throw new Error('OFFLINE shutdown failed; diagnostics preserved'); }
  });
  assert.equal(probes, 0); assert.equal(closes, 1); assert.ok(result.preparationError);
  assert.match(result.cleanupError, /diagnostics preserved/); assert.equal(result.workReserveExceeded, false);
});

test('offline close preparation failure and already-exited states do not create graceful claims', async () => {
  const time = clock(); let closeCalls = 0;
  const result = await coordinateMysqlClose({ ...time, started: true, ready: false, workDeadline: 29000,
    getState: async () => 'failed', probe: () => assert.fail('must not probe exited service'),
    close: async () => { closeCalls++; return { ok: false, status: 'preserved' }; }
  });
  assert.equal(closeCalls, 1); assert.equal(result.preparation, 'already-exited-without-graceful-claim');
  const decision = shutdownDecision({ mysqlExit: { exitCode: 0, signal: null },
    shutdown: { exitCode: 1, signal: null }, graceful: false, cleanup: result.cleanup });
  assert.equal(decision.preserveDiagnostic, true); assert.equal(decision.socketShutdownSucceeded, false);
  const failure = await coordinateMysqlClose({ ...time, started: true, ready: false, workDeadline: 29000,
    getState: async () => { throw new Error('OFFLINE identity status failed'); },
    close: async () => { closeCalls++; return { ok: true }; } });
  assert.match(failure.preparationError, /identity/); assert.equal(closeCalls, 2);
});

test('offline early close with all-pending probes ends its two-second work allowance and preserves shutdown failure', async () => {
  const time = clock(25000); let closes = 0;
  const result = await coordinateMysqlClose({ ...time, started: true, ready: false, workDeadline: 29000,
    getState: async () => 'running', probe: async timeout => { time.advance(timeout); return pending(); },
    close: async () => { closes++; assert.equal(time.now(), 27000); throw new Error('OFFLINE shutdown failure preserved'); }
  });
  assert.equal(closes, 1); assert.equal(result.workReserveExceeded, false); assert.equal(result.cleanupBudgetExceeded, false);
  assert.match(result.preparationError, /remained pending/); assert.match(result.cleanupError, /preserved/);
});

test('offline successful socket shutdown requires all recorded results, process0 alone is insufficient', () => {
  const success = { mysqlExit: { exitCode: 0, signal: null }, shutdown: { exitCode: 0, signal: null }, graceful: true, cleanup: { ok: true } };
  assert.deepEqual(shutdownDecision(success), { socketShutdownSucceeded: true, preserveDiagnostic: false, historicalShutdownExit: 0, historicalMysqlExit: 0 });
  for (const patch of [{ shutdown: undefined }, { graceful: false }, { cleanup: { ok: false } },
    { mysqlExit: { exitCode: 0, signal: 'SIGTERM' } }]) assert.equal(shutdownDecision({ ...success, ...patch }).preserveDiagnostic, true);
});

test('offline fixture import is inert and budget leaves fourteen seconds of the original45 for exit', () => {
  assert.equal(typeof main, 'function');
  assert.equal(budget.work + budget.closeReserve + budget.outerReserve, 45000);
  assert.equal(budget.closeReserve, 14000); assert.equal(budget.work, 29000);
  assert.ok(budget.version * 3 + budget.initialize + budget.ready + budget.setup + budget.contract + 4000 <= budget.work);
  assert.ok(budget.ready <= 4000 && budget.ping <= 1200 && budget.pingAttempts <= 6);
});
