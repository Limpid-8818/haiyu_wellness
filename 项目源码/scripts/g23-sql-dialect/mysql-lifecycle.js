// Side-effect-free orchestration helpers. They never start a process or open a socket.
import assert from 'node:assert/strict';

export function classifyProcessResult(result, { allowPending = false } = {}) {
  assert.equal(result?.timedOut, false, 'process timeout is never pending');
  assert.equal(result.signal, null, 'signaled process is never pending');
  assert.ok(Number.isInteger(result.exitCode) && result.exitCode >= 0, 'missing/invalid exit code');
  if (result.status === 'exited' && result.exitCode === 0) return 'success';
  if (allowPending && result.status === 'failed' && result.exitCode > 0) return 'pending';
  throw new Error(`unexpected process result: status=${result.status} exit=${result.exitCode}`);
}

export async function waitForMysqlReady({ probe, deadline, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 6, perProbeMs = 1200, intervalMs = 150 }) {
  assert.ok(Number.isInteger(attempts) && attempts > 0 && attempts <= 6);
  assert.ok(perProbeMs > 0 && perProbeMs <= 1200 && intervalMs >= 0);
  const started = now(); assert.ok(deadline > started && deadline - started <= 4000, 'invalid shared ready deadline');
  const results = [];
  for (let index = 1; index <= attempts; index++) {
    const remaining = deadline - now(); if (remaining <= 0) break;
    const result = await probe(Math.min(perProbeMs, remaining), index);
    results.push(result);
    const outcome = classifyProcessResult(result, { allowPending: true });
    assert.ok(now() <= deadline, 'shared ready deadline exceeded');
    if (outcome === 'success') {
      assert.match(result.tail || '', /^mysqld is alive\s*$/m, 'successful ping must report alive');
      return { ready: true, elapsedMs: now() - started, probes: results.length, results };
    }
    const pause = Math.min(intervalMs, deadline - now());
    if (index < attempts && pause > 0) await sleep(pause);
  }
  throw new Error('ready ping remained pending within its shared deadline/attempt bound');
}

// Early work failure may occur before mysqld creates its socket. Use only unused
// work time to wait for readiness; never borrow the 14s reserved for session.close.
// session.close retains sole control of actual shutdown/signals/diagnostic preservation.
export async function coordinateMysqlClose({ started, ready, getState, probe, close, workDeadline,
  now = Date.now, sleep, reason = 'g23-mysql-failure', readyWaitMs = 2000 }) {
  assert.ok(readyWaitMs >= 0 && readyWaitMs <= 2000);
  const record = { preparation: started ? ready ? 'already-ready' : 'pending' : 'no-server', closeCalls: 0 };
  try {
    if (started && !ready) {
      const stateTimeoutMs = Math.min(500, workDeadline - now());
      assert.ok(stateTimeoutMs > 0, 'no work time remains for close preparation');
      record.serverState = await getState(stateTimeoutMs);
      assert.ok(now() <= workDeadline, 'server state check exceeded work deadline');
      if (record.serverState === 'running') {
        const deadline = Math.min(workDeadline, now() + readyWaitMs);
        record.ready = await waitForMysqlReady({ probe, deadline, now, sleep });
        record.preparation = 'ready-before-close';
      } else if (['exited', 'failed', 'stopped', 'signaled'].includes(record.serverState)) {
        record.preparation = 'already-exited-without-graceful-claim';
      } else throw new Error(`unexpected own server state before close: ${record.serverState}`);
    }
  } catch (error) { record.preparationError = error.message; }
  record.closeStartedAt = now();
  record.workReserveExceeded = now() > workDeadline;
  try { record.closeCalls++; record.cleanup = await close(reason); }
  catch (error) { record.cleanupError = error.message; }
  record.closeElapsedMs = now() - record.closeStartedAt;
  record.cleanupBudgetExceeded = record.closeElapsedMs > 14000;
  return record;
}

export function shutdownDecision({ mysqlExit, shutdown, graceful, cleanup }) {
  const socketShutdownSucceeded = mysqlExit?.exitCode === 0 && mysqlExit.signal === null
    && shutdown?.exitCode === 0 && shutdown.signal === null && graceful === true;
  return { socketShutdownSucceeded, preserveDiagnostic: !socketShutdownSucceeded || cleanup?.ok !== true,
    historicalShutdownExit: shutdown?.exitCode ?? null, historicalMysqlExit: mysqlExit?.exitCode ?? null };
}
