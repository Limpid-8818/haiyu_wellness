import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_LIMITS, ResourceSession, appendResourceRegistry, processGroupMembers, processIdentity,
  processMatches, waitForExactProcessExit, waitForResourcePredicate, withResourceSession
} from './resource-runtime.js';
import { withApiAtDatabase, withTemporaryApi } from '../quests/helpers.js';
import { withDatabaseApi, withMysqlDatabase } from '../quests/q10-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureOwner = path.join(path.dirname(fileURLToPath(import.meta.url)), 'owner-fixture.js');
const runnerScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'resource-runner.js');
const taskId = process.env.CODEX_TASK_ID || '01a12035-a6e7-7423-822d-3948cc060ef1';
const runKey = `r1-${new Date().toISOString().replace(/[^0-9TZ]/g, '-')}-${crypto.randomUUID()}`;
const auditRoot = path.join(projectRoot, 'output', 'resource-audit', 'segments', taskId, `resource-tests-${runKey}`);
const evidencePath = path.join(projectRoot, 'output', 'resource-audit', `stage27-resource-selftest-${runKey}.json`);
const startedAt = new Date().toISOString();
const liveSessions = new Set();
const testResults = [];

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function createSession(options = {}) {
  const session = await ResourceSession.create({ taskId, projectRoot, auditRoot, tempParent: '/tmp', ...options });
  liveSessions.add(session);
  return session;
}

async function closeSession(session, reason) {
  try { return await session.close(reason); }
  finally { liveSessions.delete(session); }
}

function registryTailFrom(target, maxBytes = 1024 * 1024) {
  if (!fs.existsSync(target)) return [];
  const size = fs.statSync(target).size;
  const count = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(count);
  const fd = fs.openSync(target, 'r');
  try { fs.readSync(fd, buffer, 0, count, size - count); }
  finally { fs.closeSync(fd); }
  return buffer.toString('utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function registryTail(maxBytes = 1024 * 1024) {
  return registryTailFrom(path.join(auditRoot, 'registry.jsonl'), maxBytes);
}

async function waitForRegistry(predicate, timeoutMs = 10_000) {
  const found = await waitForResourcePredicate(() => {
    const events = registryTail();
    return predicate(events) || false;
  }, timeoutMs, 100);
  assert.ok(found, 'resource registry event did not arrive before timeout');
  return found;
}

function serviceSpec(label, script, options = {}) {
  return {
    label, kind: options.kind || 'test', role: options.role || 'test',
    command: process.execPath, args: ['-e', script], cwd: projectRoot,
    port: options.port, datadir: options.datadir, socket: options.socket,
    leaseMs: options.leaseMs, shutdownTimeoutMs: options.shutdownTimeoutMs,
    shutdownCommand: options.shutdownCommand, env: options.env || {}
  };
}

async function assertPidExited(pid, expected, message) {
  const gone = await waitForResourcePredicate(() => !processMatches(pid, expected), 8000, 50);
  assert.ok(gone, message || `PID ${pid} still matches its registered identity`);
  assert.deepEqual(processGroupMembers(pid), [], `process group ${pid} still has members`);
}

function assertCleanupEvent(instanceId, reason) {
  const events = registryTail();
  const cleaned = events.findLast(event => event.instanceId === instanceId && event.event === 'instance_cleaned');
  assert.ok(cleaned, `missing cleanup record for ${instanceId}`);
  if (reason) assert.equal(cleaned.reason, reason);
  assert.match(cleaned.openHandleCheck, /lsof \+D and lsof \+L1/);
  const instanceEvents = events.filter(event => event.instanceId === instanceId);
  const resources = instanceEvents.filter(event => event.event === 'resource_cleanup_summary');
  assert.equal(cleaned.resourceCount, resources.length, 'final cleanup index does not match per-resource summary records');
  assert.equal(cleaned.resourceSummaryCount, resources.length, 'final cleanup index is missing resource summary records');
  return { cleaned, resources, events: instanceEvents };
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }

async function boundedLsofMatches(args, matchPrefix, timeoutMs = 15_000) {
  return await new Promise(resolve => {
    const child = spawn('lsof', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let bytes = 0;
    let pending = '';
    const matches = [];
    let failure = null;
    const timer = setTimeout(() => {
      failure = 'lsof scan timeout';
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        failure = 'lsof scan output exceeded 64 MiB';
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        return;
      }
      pending += chunk.toString('utf8');
      if (pending.length > 64 * 1024 && !pending.includes('\n')) {
        failure = 'lsof output line exceeded 64 KiB';
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        return;
      }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.includes(matchPrefix) && matches.length < 32) matches.push(line.slice(0, 2048));
      }
    });
    child.once('error', error => { failure = `lsof unavailable: ${error.message}`; });
    child.once('close', code => {
      clearTimeout(timer);
      if (pending.includes(matchPrefix) && matches.length < 32) matches.push(pending.slice(0, 2048));
      resolve({ code, bytes, matches, failure });
    });
  });
}

async function assertNoOpenHandles(root) {
  const [rootScan, deletedScan] = await Promise.all([
    boundedLsofMatches(['-nP', '+D', root], root),
    boundedLsofMatches(['-nP', '+L1'], root)
  ]);
  assert.equal(rootScan.failure, null, rootScan.failure || 'lsof +D scan did not complete');
  assert.equal(deletedScan.failure, null, deletedScan.failure || 'lsof +L1 scan did not complete');
  assert.ok([0, 1].includes(rootScan.code), `lsof +D exited ${rootScan.code}`);
  assert.ok([0, 1].includes(deletedScan.code), `lsof +L1 exited ${deletedScan.code}`);
  assert.deepEqual(rootScan.matches, [], 'a process still has a handle under the retained test directory');
  assert.deepEqual(deletedScan.matches, [], 'a process still has a deleted open file from the test directory');
  return { rootScanBytes: rootScan.bytes, deletedScanBytes: deletedScan.bytes };
}

async function testNormalAndDelayedExit() {
  const session = await createSession();
  const root = session.tempDir;
  const guardianPid = session.guardian.pid;
  const guardianIdentity = session.guardianIdentity;
  const normal = await session.runProcess(serviceSpec('normal-command', "process.stdout.write('NORMAL_OK\\n')"), { timeoutMs: 5000 });
  assert.equal(normal.status, 'exited');
  assert.equal(normal.exitCode, 0);
  assert.match(normal.tail, /NORMAL_OK/);
  const delayedScript = [
    "process.on('SIGTERM',()=>setTimeout(()=>{require('node:fs').writeFileSync(process.env.RESOURCE_TMPDIR+'/delayed-exit','done');process.exit(0)},500));",
    'setInterval(()=>{},1000);'
  ].join('');
  const delayed = await session.startProcess(serviceSpec('delayed-term-exit', delayedScript, { role: 'api' }));
  const closing = session.close('normal-completion');
  await delay(100);
  assert.equal(fs.existsSync(root), true, 'temp directory was deleted while the delayed SIGTERM handler was still running');
  await closing;
  liveSessions.delete(session);
  assert.equal(fs.existsSync(root), false);
  await assertPidExited(delayed.pid, { startTime: delayed.processStartTime, fingerprint: delayed.processFingerprint });
  assert.equal(processMatches(guardianPid, guardianIdentity), false, `guardian PID ${guardianPid} survived cleanup`);
  const report = assertCleanupEvent(session.instanceId, 'normal-completion');
  assert.ok(report.events.some(event => event.event === 'pid_exit_confirmed' && event.pid === delayed.pid));
  return { name: 'normal completion + delayed graceful stop', guardianPid, servicePid: delayed.pid,
    tempDir: root, peakDirectoryBytes: report.cleaned.peakDirectoryBytes, logs: report.resources.map(item => item.logBytes) };
}

async function testExceptionCleanup() {
  let root = '';
  let instanceId = '';
  let servicePid = 0;
  let serviceIdentity;
  await assert.rejects(withResourceSession({ taskId, projectRoot, auditRoot, tempParent: '/tmp' }, async session => {
    root = session.tempDir;
    instanceId = session.instanceId;
    const resource = await session.startProcess(serviceSpec('exception-writer', 'setInterval(()=>{},1000)', { role: 'api' }));
    servicePid = resource.pid;
    serviceIdentity = { startTime: resource.processStartTime, fingerprint: resource.processFingerprint };
    throw new Error('synthetic exception path');
  }), /synthetic exception path/);
  assert.equal(fs.existsSync(root), false);
  await assertPidExited(servicePid, serviceIdentity);
  const report = assertCleanupEvent(instanceId, 'owner-exception');
  return { name: 'exception cleanup', servicePid, tempDir: root,
    peakDirectoryBytes: report.cleaned.peakDirectoryBytes };
}

async function testFailedStartIsRegistered() {
  const session = await createSession();
  const root = session.tempDir;
  const failed = await session.startProcess({
    label: 'missing-executable', kind: 'test', role: 'test',
    command: `/missing/resource-binary-${crypto.randomUUID()}`,
    args: [], cwd: projectRoot, leaseMs: session.limits.leaseMs
  }).then(value => ({ result: value, error: null }), error => ({ result: null, error }));
  assert.ok(failed.error);
  const events = registryTail().filter(event => event.instanceId === session.instanceId);
  assert.ok(events.some(event => event.event === 'process_starting' && event.resourceLabel === 'missing-executable'));
  assert.ok(events.some(event => event.event === 'process_start_failed' && event.resourceLabel === 'missing-executable'));
  await closeSession(session, 'failed-start-cleanup');
  assert.equal(fs.existsSync(root), false);
  const report = assertCleanupEvent(session.instanceId, 'failed-start-cleanup');
  return { name: 'failed startup append registration + cleanup', tempDir: root,
    peakDirectoryBytes: report.cleaned.peakDirectoryBytes, failureRecorded: true };
}

async function testNonzeroExitAndRunnerPropagation() {
  const session = await createSession();
  const root = session.tempDir;
  const result = await session.runProcess(serviceSpec('nonzero-exit', 'process.exit(7)'), { timeoutMs: 1200 });
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  await closeSession(session, 'nonzero-exit');
  assert.equal(fs.existsSync(root), false);
  const directReport = assertCleanupEvent(session.instanceId, 'nonzero-exit');
  const directSummary = directReport.resources.find(event => event.label === 'nonzero-exit');
  assert.ok(directSummary);
  assert.equal(directSummary.status, 'failed');
  assert.equal(directSummary.exitCode, 7);

  const cliTaskId = taskId;
  const cli = spawnSync(process.execPath, [runnerScript, '--task-id', cliTaskId, '--audit-root', auditRoot,
    '--temp-parent', '/tmp', '--kind', 'test',
    '--name', 'cli-nonzero-exit', '--timeout-ms', '5000', '--cwd', projectRoot,
    '--', process.execPath, '-e', 'process.exit(7)'], {
    cwd: projectRoot, env: { ...process.env }, encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024
  });
  assert.ifError(cli.error);
  assert.equal(cli.signal, null);
  assert.equal(cli.status, 7, `runner should propagate child exit code 7; stderr: ${cli.stderr.slice(-2048)}`);
  const cliReport = JSON.parse(cli.stdout);
  assert.equal(cliReport.status, 'FAIL');
  assert.equal(cliReport.resource.status, 'failed');
  assert.equal(cliReport.resource.exitCode, 7);
  assert.equal(cliReport.resource.timedOut, false);
  assert.equal(cliReport.cleanup.ok, true);
  assert.equal(cliReport.cleanup.status, 'cleaned');
  assert.equal(cliReport.tempDirRemoved, true);
  const cliCleanup = assertCleanupEvent(cliReport.instanceId, 'owner-finally');
  assert.equal(cliCleanup.resources.find(event => event.label === 'cli-nonzero-exit')?.exitCode, 7);
  return { name: 'nonzero exit is terminal and runner propagates code', childExitCode: 7,
    timedOut: result.timedOut, directTempDir: root, runnerInstanceId: cliReport.instanceId,
    runnerExitCode: cli.status, runnerTempDirRemoved: cliReport.tempDirRemoved };
}

async function testExecIdentityAndStop() {
  const session = await createSession();
  const root = session.tempDir;
  const resource = await session.startProcess({
    label: 'exec-identity', kind: 'test', role: 'test', command: '/bin/sh',
    args: ['-c', `sleep 0.25; exec ${shellQuote(process.execPath)} -e ${shellQuote('setInterval(()=>{},1000)')}`],
    cwd: projectRoot, leaseMs: session.limits.leaseMs
  });
  const currentIdentity = processIdentity(resource.pid);
  assert.ok(currentIdentity);
  const startIdentity = {
    pid: resource.pid, startTime: resource.processStartTime, pgid: resource.processGroup,
    uid: currentIdentity.uid, fingerprint: resource.processFingerprint, executable: resource.processExecutable
  };
  assert.match(startIdentity.executable, /sh/i, 'guardian must register the shell executable before exec');
  const execIdentity = await waitForResourcePredicate(() => {
    const current = processIdentity(resource.pid);
    return current && current.executable !== startIdentity.executable ? current : false;
  }, 5000, 50);
  assert.ok(execIdentity, 'exec did not change the process command within the expected interval');
  assert.equal(execIdentity.startTime, startIdentity.startTime);
  assert.equal(execIdentity.pgid, startIdentity.pgid);
  assert.equal(execIdentity.uid, startIdentity.uid);
  assert.equal(execIdentity.fingerprint, startIdentity.fingerprint);
  assert.notEqual(execIdentity.executable, startIdentity.executable);
  assert.equal(processMatches(resource.pid, startIdentity), true,
    'stable process identity must survive shell exec even when comm changes');

  const stopped = await session.stop(resource.id, 'exec-identity-regression');
  assert.equal(stopped.ok, true);
  assert.notEqual(stopped.resource.status, 'blocked');
  await assertPidExited(resource.pid, startIdentity);
  assert.deepEqual(processGroupMembers(resource.processGroup), [], 'exec process group survived stop');
  await closeSession(session, 'exec-identity-regression');
  assert.equal(fs.existsSync(root), false);
  const report = assertCleanupEvent(session.instanceId, 'exec-identity-regression');
  const summary = report.resources.find(event => event.resourceId === resource.id);
  assert.ok(summary);
  assert.equal(summary.allTrackedPidsExited, true);
  assert.ok(report.events.some(event => event.event === 'pid_exit_confirmed' && event.pid === resource.pid));
  return { name: 'exec-stable process identity and exact group stop', pid: resource.pid,
    startCommand: startIdentity.executable, execCommand: execIdentity.executable,
    processGroup: resource.processGroup, tempDir: root };
}

async function testWideCleanupEvidence() {
  const session = await createSession();
  const root = session.tempDir;
  const started = [];
  for (let index = 0; index < 6; index += 1) {
    const args = ['-e', 'process.exit(0)', ...Array.from({ length: 6 }, (_, argIndex) =>
      `${index + 1}-${argIndex + 1}-`.padEnd(800, 'x'))];
    assert.ok(args.slice(2).every(argument => argument.length === 800));
    const resource = await session.startProcess({
      label: `wide-summary-${index + 1}`, kind: 'test', role: 'test', command: process.execPath,
      args, cwd: projectRoot, leaseMs: session.limits.leaseMs
    });
    const result = await session.waitProcess(resource.id, 5000);
    assert.equal(result.status, 'exited');
    assert.equal(result.exitCode, 0);
    started.push(resource);
  }
  await closeSession(session, 'wide-summary-regression');
  assert.equal(fs.existsSync(root), false);
  const report = assertCleanupEvent(session.instanceId, 'wide-summary-regression');
  assert.equal(report.resources.length, 6);
  assert.equal(report.cleaned.resourceCount, 6);
  assert.equal(report.cleaned.resourceSummaryCount, 6);
  for (const resource of started) {
    const summary = report.resources.find(event => event.resourceId === resource.id);
    assert.ok(summary, `missing cleanup summary for ${resource.label}`);
    assert.equal(summary.exitCode, 0);
    assert.equal(summary.allTrackedPidsExited, true);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 16 * 1024);
  }
  return { name: 'six wide resources retain per-resource cleanup evidence', resourceCount: report.resources.length,
    argumentCountPerResource: 6, argumentLength: 800, tempDir: root,
    cleanupIndexCounts: [report.cleaned.resourceCount, report.cleaned.resourceSummaryCount] };
}

async function testRegistryWriteFailureCannotPass() {
  const harness = await createSession();
  const harnessRoot = harness.tempDir;
  const harnessGuardianPid = harness.guardian.pid;
  const harnessGuardianIdentity = harness.guardianIdentity;
  const isolatedAuditRoot = await harness.allocateDir('isolated-registry-write-failure');
  const session = await createSession({ auditRoot: isolatedAuditRoot });
  const root = session.tempDir;
  const guardianPid = session.guardian.pid;
  const guardianIdentity = session.guardianIdentity;
  const resource = await session.startProcess(serviceSpec('registry-write-failure', 'process.exit(0)'));
  const resourceIdentity = { startTime: resource.processStartTime, fingerprint: resource.processFingerprint };
  const exited = await session.waitProcess(resource.id, 5000);
  assert.equal(exited.status, 'exited');
  assert.equal(exited.exitCode, 0);

  const originalMode = fs.statSync(session.registryPath).mode & 0o777;
  let modeRestricted = false;
  let blockedEvidenceRecorded = false;
  let removedEvidenceRecorded = false;
  let openHandleCheck = null;
  let closeError = null;
  try {
    fs.chmodSync(session.registryPath, originalMode & ~0o222);
    modeRestricted = true;
    try { await closeSession(session, 'registry-write-failure'); }
    catch (error) { closeError = error; }
    fs.chmodSync(session.registryPath, originalMode);
    modeRestricted = false;
    assert.ok(closeError, 'a required registry write failure must reject close(), never PASS');
    assert.match(closeError.message, /EACCES|permission denied/i);
    assert.equal(processMatches(guardianPid, guardianIdentity), false,
      'guardian must exit even when required cleanup evidence cannot be registered');
    await assertPidExited(resource.pid, resourceIdentity);
    assert.deepEqual(processGroupMembers(resource.processGroup), []);
    assert.equal(fs.existsSync(root), true,
      'the instance directory must remain when cleanup evidence registration fails');

    const failedEvents = registryTailFrom(session.registryPath).filter(event => event.instanceId === session.instanceId);
    assert.equal(failedEvents.some(event => ['instance_cleaned', 'instance_cleanup_preserved', 'instance_cleanup_blocked'].includes(event.event)), false,
      'permission failure fixture should prevent the final cleanup record from being written');
    openHandleCheck = await assertNoOpenHandles(root);
    if (fs.existsSync(session.configPath)) fs.unlinkSync(session.configPath);
    appendResourceRegistry(session.registryPath, {
      taskId, instanceId: session.instanceId, event: 'resource_registry_write_failure_blocked',
      guardianPid, guardianStartTime: guardianIdentity.startTime, guardianFingerprint: guardianIdentity.fingerprint,
      guardianExited: true, resourcePid: resource.pid, resourceStartTime: resource.processStartTime,
      resourceFingerprint: resource.processFingerprint, resourceExited: true, processGroup: resource.processGroup,
      closeRejected: true, finalCleanupRecordMissing: true, directoryPreservedAtFailure: true,
      openHandleCheck: 'lsof +D and lsof +L1 completed with no matching handles', ...openHandleCheck
    });
    blockedEvidenceRecorded = true;
    fs.rmSync(root, { recursive: true, force: false });
    assert.equal(fs.existsSync(root), false);
    appendResourceRegistry(session.registryPath, {
      taskId, instanceId: session.instanceId, event: 'resource_registry_failure_fixture_directory_removed',
      tempDir: root, guardianPid, resourcePid: resource.pid, allPidsExited: true,
      configPathRemoved: !fs.existsSync(session.configPath), directoryAbsentAfterRemoval: true
    });
    removedEvidenceRecorded = true;
    appendResourceRegistry(path.join(auditRoot, 'registry.jsonl'), {
      taskId, instanceId: session.instanceId, event: 'isolated_registry_failure_fixture_reconciled',
      isolatedRegistryPath: session.registryPath, isolatedAuditRoot, tempDir: root,
      guardianPid, guardianStartTime: guardianIdentity.startTime, guardianFingerprint: guardianIdentity.fingerprint,
      resourcePid: resource.pid, resourceStartTime: resource.processStartTime,
      resourceFingerprint: resource.processFingerprint, processGroup: resource.processGroup,
      ownerPid: session.ownerIdentity.pid, ownerStartTime: session.ownerIdentity.startTime,
      ownerFingerprint: session.ownerIdentity.fingerprint, closeRejected: true, registryRestored: true,
      lsofAndDirectoryRemovalEvidence: true
    });
  } finally {
    if (modeRestricted) fs.chmodSync(session.registryPath, originalMode);
    if (!session.closed) {
      try { await closeSession(session, 'registry-write-failure-fixture-recovery'); }
      catch { /* exact-PID recovery below preserves the original failure evidence */ }
    }
    if (fs.existsSync(root)) {
      if (processMatches(guardianPid, guardianIdentity)) {
        try { process.kill(guardianPid, 'SIGTERM'); } catch { /* identity is checked before signaling */ }
        await waitForResourcePredicate(() => !processMatches(guardianPid, guardianIdentity), 8000, 50);
      }
      if (!processMatches(resource.pid, resourceIdentity) && !processMatches(guardianPid, guardianIdentity)) {
        openHandleCheck ||= await assertNoOpenHandles(root);
        if (fs.existsSync(session.configPath)) fs.unlinkSync(session.configPath);
        appendResourceRegistry(session.registryPath, {
          taskId, instanceId: session.instanceId, event: 'resource_registry_failure_fixture_recovered',
          guardianPid, guardianStartTime: guardianIdentity.startTime, guardianExited: true,
          resourcePid: resource.pid, resourceStartTime: resource.processStartTime, resourceExited: true,
          directoryPreservedAtFailure: true,
          openHandleCheck: 'lsof +D and lsof +L1 completed with no matching handles', ...openHandleCheck
        });
        fs.rmSync(root, { recursive: true, force: false });
        appendResourceRegistry(session.registryPath, {
          taskId, instanceId: session.instanceId, event: 'resource_registry_failure_fixture_directory_removed',
          tempDir: root, guardianPid, resourcePid: resource.pid, allPidsExited: true,
          configPathRemoved: !fs.existsSync(session.configPath), directoryAbsentAfterRemoval: true
        });
        appendResourceRegistry(path.join(auditRoot, 'registry.jsonl'), {
          taskId, instanceId: session.instanceId, event: 'isolated_registry_failure_fixture_reconciled',
          isolatedRegistryPath: session.registryPath, isolatedAuditRoot, tempDir: root,
          guardianPid, guardianStartTime: guardianIdentity.startTime, guardianFingerprint: guardianIdentity.fingerprint,
          resourcePid: resource.pid, resourceStartTime: resource.processStartTime,
          resourceFingerprint: resource.processFingerprint, processGroup: resource.processGroup,
          ownerPid: session.ownerIdentity.pid, ownerStartTime: session.ownerIdentity.startTime,
          ownerFingerprint: session.ownerIdentity.fingerprint, closeRejected: Boolean(closeError),
          registryRestored: true, lsofAndDirectoryRemovalEvidence: true
        });
      }
    }
    if (!harness.closed) await closeSession(harness, 'registry-write-failure-fixture-parent');
  }
  assert.ok(blockedEvidenceRecorded);
  assert.ok(removedEvidenceRecorded);
  assert.equal(fs.existsSync(harnessRoot), false);
  assert.equal(processMatches(harnessGuardianPid, harnessGuardianIdentity), false);
  assertCleanupEvent(harness.instanceId, 'registry-write-failure-fixture-parent');
  return { name: 'isolated cleanup registry write failure blocks close', resourcePid: resource.pid,
    guardianPid, closeRejected: true, tempDirPreservedUntilEvidence: true, tempDirRemovedAfterEvidence: true,
    openHandleCheck, closeError: closeError.message };
}

async function testRpcPrematureEndAndTimeout() {
  const session = await createSession({ tempParent: '/tmp' });
  const root = session.tempDir;
  const owner = session.ownerIdentity;
  const modes = ['empty-eof', 'truncated-response', 'abrupt-close', 'timeout'];
  const results = [];
  try {
    const fixtureDir = await session.allocateDir('rpc-fixtures');
    for (let index = 0; index < modes.length; index += 1) {
      const mode = modes[index];
      const socketPath = path.join(fixtureDir, 'r' + index + '.sock');
      assert.ok(socketPath.length < 100, 'RPC test socket path exceeds the portable local socket limit');
      const connected = new Set();
      const server = net.createServer(socket => {
        connected.add(socket);
        socket.once('close', () => connected.delete(socket));
        socket.once('data', () => {
          if (mode === 'empty-eof') socket.end();
          else if (mode === 'truncated-response') socket.end('{"ok":');
          else if (mode === 'abrupt-close') socket.destroy();
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
      });
      appendResourceRegistry(session.registryPath, {
        taskId, instanceId: session.instanceId, fixtureId: 'rpc-' + index,
        event: 'rpc_fixture_started', mode, pid: process.pid, processStartTime: owner.startTime,
        processFingerprint: owner.fingerprint, processGroup: owner.pgid, command: 'in-process net.Server',
        tempDir: root, socket: socketPath, port: null, logPath: null
      });
      try {
        const requestTimeout = mode === 'timeout' ? 250 : 1000;
        const pending = ResourceSession.prototype.rpc.call({ socketPath }, { op: 'probe' }, requestTimeout);
        let timer;
        const outcome = await Promise.race([
          pending.then(value => ({ ok: true, value }), error => ({ ok: false, error })),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })
        ]);
        clearTimeout(timer);
        assert.ok(outcome, mode + ' RPC did not settle within its bounded test window');
        assert.equal(outcome.ok, false, mode + ' RPC unexpectedly succeeded');
        if (mode === 'timeout') assert.match(outcome.error.message, /timed out/i);
        else assert.match(outcome.error.message, /closed|truncated|empty/i);
        results.push({ mode, rejected: true, message: outcome.error.message.slice(0, 256), requestTimeout });
      } finally {
        for (const socket of connected) socket.destroy();
        await new Promise(resolve => server.close(() => resolve()));
        if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
        appendResourceRegistry(session.registryPath, {
          taskId, instanceId: session.instanceId, fixtureId: 'rpc-' + index,
          event: 'rpc_fixture_closed', mode, pid: process.pid, processStartTime: owner.startTime,
          processFingerprint: owner.fingerprint, socket: socketPath, listenerClosed: !server.listening,
          socketRemoved: !fs.existsSync(socketPath)
        });
      }
    }
  } finally {
    await closeSession(session, 'rpc-protocol-regression');
  }
  assert.equal(fs.existsSync(root), false);
  assertCleanupEvent(session.instanceId, 'rpc-protocol-regression');
  return { name: 'RPC rejects empty EOF, truncated response, close and timeout', cases: results, tempDir: root };
}

async function testRunnerFailsOnIsolatedRegistryWriteFailure() {
  const session = await createSession();
  const root = session.tempDir;
  const guardianPid = session.guardian.pid;
  const guardianIdentity = session.guardianIdentity;
  const auditRoot = await session.allocateDir('cli-isolated-audit');
  const isolatedRegistry = path.join(auditRoot, 'registry.jsonl');
  const cliTaskId = taskId + '-cli-rpc-failure';
  const commandScript = "setTimeout(()=>{const fs=require('node:fs');const target=process.argv[1];const mode=fs.statSync(target).mode&0o777;fs.chmodSync(target,mode&~0o222);},150);";
  let result = null;
  let isolatedEvents = [];
  let innerRoot = null;
  let innerSocket = null;
  let innerConfig = null;
  let registryWasRestricted = false;
  let lsofEvidence = null;
  let reconciled = false;
  const startedAt = Date.now();
  try {
    const resource = await session.runProcess({
      label: 'resource-runner-isolated-registry-failure', kind: 'test', role: 'test',
      command: process.execPath,
      args: [runnerScript, '--task-id', cliTaskId, '--audit-root', auditRoot, '--temp-parent', '/tmp', '--kind', 'test',
        '--name', 'isolated-registry-write-failure', '--timeout-ms', '5000', '--cwd', projectRoot,
        '--', process.execPath, '-e', commandScript, isolatedRegistry],
      cwd: projectRoot
    }, { timeoutMs: 20_000 });
    result = resource;
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 20_000, 'nested resource runner did not complete within its bound');
    assert.equal(resource.timedOut, false, 'nested resource runner exceeded its bounded process timeout');
    assert.equal(resource.status, 'failed', 'nested resource runner must fail closed');
    assert.notEqual(resource.exitCode, 0, 'nested resource runner returned exit code 0 after cleanup failure');
    assert.match(resource.tail, /"status"\s*:\s*"FAIL"/);
    assert.doesNotMatch(resource.tail, /"status"\s*:\s*"PASS"/);

    const registryMode = fs.statSync(isolatedRegistry).mode & 0o777;
    registryWasRestricted = (registryMode & 0o222) === 0;
    assert.equal(registryWasRestricted, true, 'CLI child did not restrict only its isolated registry');
    fs.chmodSync(isolatedRegistry, 0o600);
    isolatedEvents = registryTailFrom(isolatedRegistry, 256 * 1024);
    const runnerStarted = isolatedEvents.find(event => event.event === 'runner_started');
    const guardianStarted = isolatedEvents.find(event => event.event === 'guardian_started');
    const processes = isolatedEvents.filter(event => event.event === 'process_started' || event.event === 'child_process_started');
    assert.ok(runnerStarted, 'isolated registry is missing runner identity evidence');
    assert.ok(guardianStarted, 'isolated registry is missing guardian identity evidence');
    assert.ok(processes.length, 'isolated registry is missing child process identity evidence');
    innerRoot = runnerStarted.tempDir;
    innerSocket = runnerStarted.socket;
    innerConfig = path.join(auditRoot, 'state', runnerStarted.instanceId + '.json');
    assert.ok(innerRoot && fs.existsSync(innerRoot), 'failed CLI cleanup should preserve its diagnostic directory');

    const runnerIdentity = { startTime: runnerStarted.ownerStartTime, fingerprint: runnerStarted.ownerFingerprint };
    await assertPidExited(resource.pid, { startTime: resource.processStartTime, fingerprint: resource.processFingerprint });
    assert.deepEqual(processGroupMembers(resource.processGroup), [], 'outer CLI process group survived');
    await assertPidExited(runnerStarted.ownerPid, runnerIdentity, 'nested CLI owner PID survived');
    const innerGuardianIdentity = { startTime: guardianStarted.guardianStartTime, fingerprint: guardianStarted.guardianFingerprint };
    await assertPidExited(guardianStarted.guardianPid, innerGuardianIdentity, 'nested guardian PID survived');
    assert.deepEqual(processGroupMembers(guardianStarted.guardianPid), [], 'nested guardian process group survived');
    for (const event of processes) {
      const identity = { startTime: event.processStartTime, fingerprint: event.processFingerprint };
      await assertPidExited(event.pid, identity, 'nested resource PID ' + event.pid + ' survived');
      assert.deepEqual(processGroupMembers(event.pgid), [], 'nested resource process group ' + event.pgid + ' survived');
    }
    lsofEvidence = await assertNoOpenHandles(innerRoot);
    if (innerConfig && fs.existsSync(innerConfig)) fs.unlinkSync(innerConfig);
    if (innerSocket && fs.existsSync(innerSocket)) fs.unlinkSync(innerSocket);
    fs.rmSync(innerRoot, { recursive: true, force: false });
    assert.equal(fs.existsSync(innerRoot), false);
    appendResourceRegistry(session.registryPath, {
      taskId, instanceId: session.instanceId, event: 'nested_resource_runner_failure_reconciled',
      innerTaskId: cliTaskId, isolatedAuditRoot: auditRoot, isolatedRegistryPath: isolatedRegistry,
      innerTempDir: innerRoot, innerSocket, innerConfig, outerRunnerPid: resource.pid,
      outerRunnerStartTime: resource.processStartTime, outerRunnerFingerprint: resource.processFingerprint,
      outerRunnerGroup: resource.processGroup, innerOwnerPid: runnerStarted.ownerPid,
      innerOwnerStartTime: runnerStarted.ownerStartTime, innerOwnerFingerprint: runnerStarted.ownerFingerprint,
      innerGuardianPid: guardianStarted.guardianPid, innerGuardianStartTime: guardianStarted.guardianStartTime,
      innerGuardianFingerprint: guardianStarted.guardianFingerprint,
      resourcePids: processes.map(event => ({ pid: event.pid, startTime: event.processStartTime,
        fingerprint: event.processFingerprint, pgid: event.pgid, command: event.command })),
      allExactPidsExited: true, allGroupsEmpty: true, tempDirRemoved: true,
      lsofPlusDAndPlusL1Clean: true, lsofEvidence,
      resultStatus: resource.status, resultExitCode: resource.exitCode, resultTimedOut: resource.timedOut,
      elapsedMs, diagnosticTail: resource.tail.slice(-4096)
    });
    reconciled = true;
  } finally {
    if (fs.existsSync(isolatedRegistry)) {
      const mode = fs.statSync(isolatedRegistry).mode & 0o777;
      if ((mode & 0o222) === 0) fs.chmodSync(isolatedRegistry, 0o600);
      isolatedEvents = registryTailFrom(isolatedRegistry, 256 * 1024);
    }
    if (result && processMatches(result.pid, { startTime: result.processStartTime, fingerprint: result.processFingerprint })) {
      try { await session.stop(result.id, 'nested-runner-fixture-recovery'); } catch { /* parent guardian owns this exact resource */ }
    }
    const runnerStarted = isolatedEvents.find(event => event.event === 'runner_started');
    const guardianStarted = isolatedEvents.find(event => event.event === 'guardian_started');
    const processes = isolatedEvents.filter(event => event.event === 'process_started' || event.event === 'child_process_started');
    if (runnerStarted) {
      innerRoot ||= runnerStarted.tempDir;
      innerSocket ||= runnerStarted.socket;
      innerConfig ||= path.join(auditRoot, 'state', runnerStarted.instanceId + '.json');
    }
    if (runnerStarted && guardianStarted) {
      const innerGuardianIdentity = { startTime: guardianStarted.guardianStartTime, fingerprint: guardianStarted.guardianFingerprint };
      if (processMatches(guardianStarted.guardianPid, innerGuardianIdentity)) {
        try { process.kill(guardianStarted.guardianPid, 'SIGTERM'); } catch { /* verify exact identity before any signal */ }
        await waitForResourcePredicate(() => !processMatches(guardianStarted.guardianPid, innerGuardianIdentity), 8000, 50);
      }
      for (const event of processes) {
        const identity = { startTime: event.processStartTime, fingerprint: event.processFingerprint };
        if (processMatches(event.pid, identity)) {
          try { process.kill(event.pid, 'SIGTERM'); } catch { /* verify exact identity before any signal */ }
          await waitForResourcePredicate(() => !processMatches(event.pid, identity), 5000, 50);
        }
      }
    }
    if (innerRoot && fs.existsSync(innerRoot)) {
      const stillAlive = processes.some(event => processMatches(event.pid,
        { startTime: event.processStartTime, fingerprint: event.processFingerprint })) ||
        (guardianStarted && processMatches(guardianStarted.guardianPid,
          { startTime: guardianStarted.guardianStartTime, fingerprint: guardianStarted.guardianFingerprint }));
      if (!stillAlive) {
        lsofEvidence ||= await assertNoOpenHandles(innerRoot);
        if (innerConfig && fs.existsSync(innerConfig)) fs.unlinkSync(innerConfig);
        if (innerSocket && fs.existsSync(innerSocket)) fs.unlinkSync(innerSocket);
        fs.rmSync(innerRoot, { recursive: true, force: false });
      }
    }
    if (!reconciled) {
      appendResourceRegistry(session.registryPath, {
        taskId, instanceId: session.instanceId, event: 'nested_resource_runner_failure_fixture_recovered',
        innerTaskId: cliTaskId, isolatedAuditRoot: auditRoot, isolatedRegistryPath: isolatedRegistry,
        innerTempDir: innerRoot, resultStatus: result?.status || null, resultExitCode: result?.exitCode ?? null,
        resultTimedOut: result?.timedOut ?? null, registryWasRestricted, tempDirRemoved: !innerRoot || !fs.existsSync(innerRoot),
        exactInnerEvents: isolatedEvents.filter(event => ['runner_started', 'guardian_started', 'process_started',
          'child_process_started', 'process_exit', 'pid_exit_confirmed', 'instance_cleanup_blocked'].includes(event.event)).slice(0, 12),
        diagnosticTail: result?.tail?.slice(-4096) || null, lsofEvidence
      });
    }
    await closeSession(session, 'nested-runner-failure-regression');
  }
  assert.equal(fs.existsSync(root), false);
  assert.equal(processMatches(guardianPid, guardianIdentity), false);
  assertCleanupEvent(session.instanceId, 'nested-runner-failure-regression');
  return { name: 'CLI reports FAIL and nonzero on isolated registry write failure', pid: result.pid,
    exitCode: result.exitCode, status: result.status, boundedMs: Date.now() - startedAt,
    tempDirPreservedForDiagnostics: true, tempDirRemovedAfterEvidence: !innerRoot || !fs.existsSync(innerRoot),
    registryWasRestricted, lsofEvidence };
}

async function testTimeoutAndLease() {
  const timed = await createSession();
  const timedRoot = timed.tempDir;
  const timedGuardian = timed.guardian.pid;
  const timedIdentity = timed.guardianIdentity;
  const timeoutScript = "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));setInterval(()=>{},1000);";
  const timedResult = await timed.runProcess(serviceSpec('short-timeout', timeoutScript, { role: 'test' }), { timeoutMs: 300 });
  assert.equal(timedResult.timedOut, true);
  assert.equal(timedResult.stopReason, 'timeout');
  const timedPid = timedResult.pid;
  const timedProcessIdentity = { startTime: timedResult.processStartTime, fingerprint: timedResult.processFingerprint };
  await closeSession(timed, 'timeout');
  assert.equal(fs.existsSync(timedRoot), false);
  await assertPidExited(timedPid, timedProcessIdentity);
  assert.equal(processMatches(timedGuardian, timedIdentity), false);
  assertCleanupEvent(timed.instanceId, 'timeout');

  const leased = await createSession({ limits: { leaseMs: 600 } });
  const leaseRoot = leased.tempDir;
  const leaseGuardian = leased.guardian.pid;
  const leaseGuardianIdentity = leased.guardianIdentity;
  const leaseResource = await leased.startProcess(serviceSpec('lease-expiry', 'setInterval(()=>{},1000)', { role: 'api', leaseMs: 600 }));
  const leaseIdentity = { startTime: leaseResource.processStartTime, fingerprint: leaseResource.processFingerprint };
  await waitForResourcePredicate(() => !fs.existsSync(leaseRoot), 8000, 100);
  assert.equal(fs.existsSync(leaseRoot), false, 'lease expiry did not remove the closed task directory');
  await assertPidExited(leaseResource.pid, leaseIdentity);
  const leaseGuardianGone = await waitForResourcePredicate(() => !processMatches(leaseGuardian, leaseGuardianIdentity), 8000, 50);
  assert.ok(leaseGuardianGone, `guardian PID ${leaseGuardian} did not fully exit after lease cleanup`);
  await closeSession(leased, 'confirm-autonomous-lease-cleanup');
  assertCleanupEvent(leased.instanceId, 'lease-expired');
  return { name: 'explicit timeout + autonomous lease expiry', timeoutPid: timedPid,
    leasePid: leaseResource.pid, leaseMs: 600, timeoutLimitMs: 300, tempDirs: [timedRoot, leaseRoot] };
}

async function runOwnerLifecycleScenario({ scenario, mode, signal, expectedCode, expectedSignal = null }) {
  const observerIdentity = processIdentity(process.pid);
  assert.ok(observerIdentity, 'resource test observer has no exact process identity');
  const owner = spawn(process.execPath, [fixtureOwner, taskId, projectRoot, auditRoot, mode], {
    cwd: projectRoot, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  let closed = false;
  let ownerCloseResult = null;
  const ownerClosed = new Promise(resolve => owner.once('close', (...args) => {
    closed = true; ownerCloseResult = args; resolve(args);
  }));
  let output = '';
  let errors = '';
  owner.stdout.on('data', chunk => { output += chunk.toString('utf8').slice(0, 8192 - output.length); });
  owner.stderr.on('data', chunk => { errors += chunk.toString('utf8').slice(0, 8192 - errors.length); });
  let ownerInfo = null;
  let guardianExitRecorded = false;
  let writer = null;
  try {
    const readyLine = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`owner fixture did not become ready: ${errors}`)), 8000);
      const poll = setInterval(() => {
        const line = output.split('\n').find(value => value.startsWith('RESOURCE_OWNER_READY '));
        if (line) { clearTimeout(timeout); clearInterval(poll); resolve(line.slice('RESOURCE_OWNER_READY '.length)); }
      }, 50);
      owner.once('error', error => { clearTimeout(timeout); clearInterval(poll); reject(error); });
    });
    ownerInfo = JSON.parse(readyLine);
    assert.equal(ownerInfo.ownerIdentity.pid, owner.pid, 'fixture owner identity does not match its exact child PID');
    const registryEvent = await waitForRegistry(events => events.find(event => event.instanceId === ownerInfo.instanceId &&
      event.event === 'child_process_started' && event.ppid === ownerInfo.servicePid));
    writer = registryEvent;
    assert.notEqual(writer.pid, ownerInfo.servicePid);
    if (mode === 'natural-exit') owner.stdin.end('complete-natural-exit\n');
    if (signal) assert.equal(owner.kill(signal), true);
    const closeResult = await Promise.race([
      ownerClosed,
      delay(15_000).then(() => { throw new Error(`owner fixture ${ownerInfo.ownerPid} did not exit within 15000 ms`); })
    ]);
    assert.deepEqual(closeResult, [expectedCode, expectedSignal]);
    assert.equal(processMatches(ownerInfo.ownerPid, ownerInfo.ownerIdentity), false);
    await waitForResourcePredicate(() => !fs.existsSync(ownerInfo.tempDir), 10_000, 100);
    assert.equal(fs.existsSync(ownerInfo.tempDir), false, `guardian did not remove the ${mode} resource directory`);
    assert.equal(fs.existsSync(ownerInfo.socketPath), false, 'guardian socket remains after owner termination');
    assert.equal(fs.existsSync(ownerInfo.configPath), false, 'guardian config remains after owner termination');
    await assertPidExited(ownerInfo.servicePid, ownerInfo.serviceIdentity);
    await assertPidExited(writer.pid, { startTime: writer.processStartTime, fingerprint: writer.processFingerprint });

    appendResourceRegistry(ownerInfo.registryPath, {
      taskId, instanceId: ownerInfo.instanceId, event: 'owner_process_exited',
      ownerPid: ownerInfo.ownerIdentity.pid, ownerStartTime: ownerInfo.ownerIdentity.startTime,
      ownerFingerprint: ownerInfo.ownerIdentity.fingerprint, exitCode: closeResult[0], signal: closeResult[1],
      observerPid: observerIdentity.pid, observerStartTime: observerIdentity.startTime,
      observerFingerprint: observerIdentity.fingerprint, observerTaskId: taskId,
      observationMethod: 'live-parent-child-process-close-event'
    });

    const cleanupReason = signal === 'SIGKILL' ? 'owner-exit' :
      signal === 'SIGTERM' ? 'owner-sigterm' : 'owner-before-exit';
    const report = assertCleanupEvent(ownerInfo.instanceId, cleanupReason);
    const guardianExit = report.events.findLast(event => event.event === 'guardian_pid_exited' &&
      Number(event.guardianPid) === Number(ownerInfo.guardianPid));
    assert.ok(guardianExit, 'owner-termination cleanup has no standard guardian_pid_exited event');
    assert.equal(guardianExit.exitConfirmed, true);
    assert.equal(guardianExit.observationMethod,
      'child-process-exit-event-plus-exact-identity-and-empty-process-group');
    assert.equal(guardianExit.observerPid, ownerInfo.ownerPid);
    const ownerExitRecord = report.events.findLast(event => event.event === 'owner_process_exited' &&
      Number(event.ownerPid) === Number(ownerInfo.ownerPid));
    assert.ok(ownerExitRecord, 'owner exact process exit was not recorded by the live observer');
    if (signal === 'SIGKILL') assert.ok(report.events.some(event => event.event === 'owner_exit_detected'));
    return { name: `owner ${scenario || mode} cleanup and exact guardian exit observation`, ownerPid: owner.pid,
      servicePid: ownerInfo.servicePid, childPid: writer.pid, guardianPid: ownerInfo.guardianPid,
      tempDir: ownerInfo.tempDir, socketRemoved: !fs.existsSync(ownerInfo.socketPath),
      guardianExitRecorded, guardianExit, peakDirectoryBytes: report.cleaned.peakDirectoryBytes };
  } finally {
    if (!closed) {
      try { owner.kill('SIGKILL'); } catch { /* already gone */ }
      await Promise.race([ownerClosed, delay(5000)]);
    }
    if (!closed) throw new Error(`owner fixture PID ${owner.pid} did not exit after SIGKILL`);
    const started = registryTail().findLast(event => event.taskId === taskId && event.ownerPid === owner.pid && event.event === 'runner_started');
    if (started) {
      const cleaned = await waitForResourcePredicate(() => registryTail().some(event =>
        event.instanceId === started.instanceId && event.event === 'instance_cleaned'), 10_000, 100);
      if (!cleaned) throw new Error(`fixture guardian did not finish cleanup for ${started.instanceId}`);
      const events = registryTail().filter(event => event.instanceId === started.instanceId);
      const guardianStart = events.findLast(event => event.event === 'guardian_started' || event.event === 'guardian_ready');
      const hasStandardExit = events.some(event => event.event === 'guardian_pid_exited' && guardianStart &&
        Number(event.guardianPid) === Number(guardianStart.guardianPid) &&
        event.guardianStartTime === guardianStart.guardianStartTime &&
        event.guardianFingerprint === guardianStart.guardianFingerprint && event.exitConfirmed === true);
      if (!hasStandardExit && guardianStart && ownerInfo) {
        const identity = ownerInfo.guardianIdentity;
        const exitObservation = await waitForExactProcessExit(identity, { timeoutMs: 8000, pollMs: 50 });
        if (!exitObservation) throw new Error(`cannot observe guardian identity exit for ${started.instanceId}`);
        appendResourceRegistry(ownerInfo.registryPath, {
          taskId, instanceId: ownerInfo.instanceId, event: 'guardian_pid_exited',
          guardianPid: identity.pid, guardianStartTime: identity.startTime,
          guardianFingerprint: identity.fingerprint, guardianPgid: identity.pgid,
          exitConfirmed: true, exitObservedAt: exitObservation.exactIdentityAbsentAt,
          processGroupEmptyAt: exitObservation.processGroupEmptyAt,
          currentPidIdentity: exitObservation.currentPidIdentity, processGroupMembers: exitObservation.processGroupMembers,
          observerPid: observerIdentity.pid, observerStartTime: observerIdentity.startTime,
          observerFingerprint: observerIdentity.fingerprint, observerTaskId: taskId,
          observationMethod: 'live-parent-exact-identity-and-process-group-observer'
        });
        guardianExitRecorded = true;
      }
      if (ownerInfo && ownerCloseResult) {
        const ownerExitAlreadyRecorded = registryTail().some(event => event.instanceId === ownerInfo.instanceId &&
          event.event === 'owner_process_exited' && Number(event.ownerPid) === Number(ownerInfo.ownerPid));
        if (!ownerExitAlreadyRecorded) appendResourceRegistry(ownerInfo.registryPath, {
          taskId, instanceId: ownerInfo.instanceId, event: 'owner_process_exited',
          ownerPid: ownerInfo.ownerIdentity.pid, ownerStartTime: ownerInfo.ownerIdentity.startTime,
          ownerFingerprint: ownerInfo.ownerIdentity.fingerprint, exitCode: ownerCloseResult[0], signal: ownerCloseResult[1],
          observerPid: observerIdentity.pid, observerStartTime: observerIdentity.startTime,
          observerFingerprint: observerIdentity.fingerprint, observerTaskId: taskId,
          observationMethod: 'live-parent-child-process-close-event'
        });
      }
    }
  }
}

async function testOwnerNaturalExitBeforeExitCleanup() {
  return await runOwnerLifecycleScenario({ scenario: 'natural exit', mode: 'natural-exit', expectedCode: 0 });
}

async function testOwnerSigtermCancellationCleanup() {
  return await runOwnerLifecycleScenario({ scenario: 'SIGTERM cancellation', mode: 'wait', signal: 'SIGTERM', expectedCode: 143 });
}

async function testOwnerKilledWithWriterChild() {
  const observerSession = await createSession();
  const observerInstanceId = observerSession.instanceId;
  const nestedRunnerAuditRoot = path.join(auditRoot, `nested-runner-observer-${crypto.randomUUID()}`);
  const ownerAuditRoot = path.join(auditRoot, `nested-killed-owner-${crypto.randomUUID()}`);
  const nestedRunner = await observerSession.startProcess({
    label: 'resource-runner-killed-owner-observer', kind: 'test', role: 'test',
    command: process.execPath,
    args: [runnerScript, '--task-id', taskId, '--kind', 'test', '--name', 'nested-owner-kill-observer',
      '--timeout-ms', '20000', '--audit-root', nestedRunnerAuditRoot, '--cwd', projectRoot, '--',
      process.execPath, fixtureOwner, taskId, projectRoot, ownerAuditRoot, 'self-kill'],
    cwd: projectRoot, leaseMs: RESOURCE_LIMITS.leaseMs
  });
  try {
    const nestedResult = await observerSession.waitProcess(nestedRunner.id, 30_000);
    assert.equal(nestedResult.timedOut, false, 'nested resource-runner did not finish the owner-kill observation');
    assert.equal(nestedResult.exitCode, 1, 'nested runner must surface the synthetic SIGKILL owner failure');
    assert.equal(nestedResult.signal, null);
    await assertPidExited(nestedRunner.pid, {
      startTime: nestedRunner.processStartTime, fingerprint: nestedRunner.processFingerprint
    }, 'nested resource-runner survived its bounded owner-kill observation');

    const ownerRegistryPath = path.join(ownerAuditRoot, 'registry.jsonl');
    const ownerEvents = registryTailFrom(ownerRegistryPath, 256 * 1024);
    const ownerStart = ownerEvents.find(event => event.event === 'runner_started');
    const guardianStart = ownerEvents.find(event => event.event === 'guardian_started' || event.event === 'guardian_ready');
    const cleanup = ownerEvents.findLast(event => event.event === 'instance_cleaned');
    const guardianExit = ownerEvents.findLast(event => event.event === 'guardian_pid_exited');
    assert.ok(ownerStart && guardianStart, 'killed owner instance has no registered owner and guardian identities');
    assert.ok(cleanup, 'killed owner guardian did not record instance cleanup');
    assert.match(cleanup.openHandleCheck, /lsof \+D and lsof \+L1 completed with no matching handles/);
    assert.equal(cleanup.reason, 'owner-exit');
    assert.ok(guardianExit, 'resource-runner did not append the missing guardian exit observation');
    assert.equal(guardianExit.exitConfirmed, true);
    assert.equal(guardianExit.guardianStartTime, guardianStart.guardianStartTime);
    assert.equal(guardianExit.guardianFingerprint, guardianStart.guardianFingerprint);
    assert.equal(guardianExit.observerPid, nestedRunner.pid);
    assert.equal(guardianExit.observerTaskId, taskId);
    assert.equal(guardianExit.observationMethod,
      'resource-runner-live-descendant-exact-identity-and-process-group-observer');
    assert.deepEqual(guardianExit.processGroupMembers, []);
    await assertPidExited(ownerStart.ownerPid, {
      startTime: ownerStart.ownerStartTime, fingerprint: ownerStart.ownerFingerprint
    }, 'SIGKILL owner identity remained alive');
    const started = ownerEvents.filter(event => ['process_started', 'child_process_started'].includes(event.event) && Number.isInteger(event.pid));
    const exited = ownerEvents.filter(event => event.event === 'pid_exit_confirmed' && event.exactIdentityExited === true);
    const identityKey = event => `${event.pid}:${event.processStartTime}:${event.processFingerprint}`;
    assert.deepEqual(started.filter(event => !exited.some(exit => identityKey(exit) === identityKey(event))), [],
      'resource-runner observation run left a child without exact PID exit evidence');
    assert.equal(fs.existsSync(ownerStart.tempDir), false, 'killed owner resource root remains');
    assert.equal(fs.existsSync(ownerStart.socket), false, 'killed owner guardian socket remains');

    const nestedRunnerEvents = registryTailFrom(path.join(nestedRunnerAuditRoot, 'registry.jsonl'), 256 * 1024);
    const nestedRunnerCleaned = nestedRunnerEvents.findLast(event =>
      event.event === 'instance_cleaned' && event.reason === 'owner-finally');
    const nestedRunnerGuardianExit = nestedRunnerEvents.findLast(event => event.event === 'guardian_pid_exited');
    assert.ok(nestedRunnerCleaned, 'observer resource-runner did not clean its own task root');
    assert.match(nestedRunnerCleaned.openHandleCheck, /lsof \+D and lsof \+L1 completed with no matching handles/);
    assert.ok(nestedRunnerGuardianExit?.exitConfirmed);
    assert.equal(fs.existsSync(nestedRunnerCleaned.tempDir), false);
    assert.equal(fs.existsSync(nestedRunnerCleaned.socket), false);
    return { name: 'owner SIGKILL with writer child observed by resource-runner',
      observerInstanceId, observerRunnerPid: nestedRunner.pid, observerRunnerExitCode: nestedResult.exitCode,
      ownerInstanceId: ownerStart.instanceId, ownerPid: ownerStart.ownerPid, ownerStartTime: ownerStart.ownerStartTime,
      guardianPid: guardianStart.guardianPid, guardianStartTime: guardianStart.guardianStartTime,
      servicePids: started.map(event => event.pid), exactExitedPids: exited.map(event => event.pid),
      guardianExitMethod: guardianExit.observationMethod, guardianObserverPid: guardianExit.observerPid,
      tempDir: ownerStart.tempDir, socketRemoved: true, ownerRootRemoved: true };
  } finally {
    await closeSession(observerSession, 'owner-kill-observer-test');
    assertCleanupEvent(observerInstanceId, 'owner-kill-observer-test');
  }
}

async function testLogAndDirectoryLimits() {
  const logSession = await createSession({ limits: { logBytes: 1024 } });
  const logRoot = logSession.tempDir;
  const logGuardianPid = logSession.guardian.pid;
  const logGuardianIdentity = logSession.guardianIdentity;
  const logResource = await logSession.startProcess(serviceSpec('log-flood',
    "setTimeout(()=>{process.stdout.write('L'.repeat(512*1024));setInterval(()=>{},1000)},100)", { role: 'test' }));
  const logIdentity = { startTime: logResource.processStartTime, fingerprint: logResource.processFingerprint };
  await waitForResourcePredicate(() => !fs.existsSync(logRoot), 10_000, 100);
  assert.equal(fs.existsSync(logRoot), false);
  await assertPidExited(logResource.pid, logIdentity);
  const logGuardianGone = await waitForResourcePredicate(() => !processMatches(logGuardianPid, logGuardianIdentity), 8000, 50);
  assert.ok(logGuardianGone, `guardian PID ${logGuardianPid} did not fully exit after log limit`);
  const logReport = assertCleanupEvent(logSession.instanceId, 'log-limit');
  const logLimit = logReport.events.find(event => event.event === 'log_limit_exceeded');
  assert.ok(logLimit);
  assert.equal(logLimit.logBytes, 1024);
  assert.equal(logLimit.maxLogBytes, 1024);
  await closeSession(logSession, 'confirm-log-limit-cleanup');

  const dirSession = await createSession({ limits: { directoryBytes: 128 * 1024 } });
  const dirRoot = dirSession.tempDir;
  const dirGuardianPid = dirSession.guardian.pid;
  const dirGuardianIdentity = dirSession.guardianIdentity;
  const dirScript = [
    "const fs=require('node:fs');const file=process.env.RESOURCE_TMPDIR+'/growth.bin';let n=0;",
    "const timer=setInterval(()=>{fs.appendFileSync(file,Buffer.alloc(4096));n+=4096;if(n>=1024*1024)clearInterval(timer)},20);",
    'setInterval(()=>{},1000);'
  ].join('');
  const dirResource = await dirSession.startProcess(serviceSpec('directory-growth', dirScript, { role: 'test' }));
  const dirIdentity = { startTime: dirResource.processStartTime, fingerprint: dirResource.processFingerprint };
  await waitForResourcePredicate(() => !fs.existsSync(dirRoot), 10_000, 100);
  assert.equal(fs.existsSync(dirRoot), false);
  await assertPidExited(dirResource.pid, dirIdentity);
  const dirGuardianGone = await waitForResourcePredicate(() => !processMatches(dirGuardianPid, dirGuardianIdentity), 8000, 50);
  assert.ok(dirGuardianGone, `guardian PID ${dirGuardianPid} did not fully exit after directory limit`);
  const dirReport = assertCleanupEvent(dirSession.instanceId, 'directory-limit');
  const limit = dirReport.events.find(event => event.event === 'directory_limit_exceeded');
  assert.ok(limit);
  assert.ok(limit.currentDirectoryBytes > limit.maxDirectoryBytes);
  assert.ok(limit.peakDirectoryBytes >= limit.currentDirectoryBytes);
  assert.ok(limit.currentDirectoryBytes < limit.maxDirectoryBytes + 1024 * 1024,
    `quota response overshot by more than 1 MiB: ${limit.currentDirectoryBytes}`);
  await closeSession(dirSession, 'confirm-directory-limit-cleanup');
  return { name: 'log + allocated-directory limits', logBytes: logLimit.logBytes,
    logMaxBytes: logLimit.maxLogBytes, directoryLimitBytes: limit.maxDirectoryBytes,
    directoryPeakBytes: limit.peakDirectoryBytes, directoryTriggeredBytes: limit.currentDirectoryBytes,
    tempDirs: [logRoot, dirRoot] };
}

async function testReplacementRetainsBothPids() {
  const session = await createSession();
  const root = session.tempDir;
  const serverScript = "process.on('SIGTERM',()=>{process.exit(0)});setInterval(()=>{},1000);";
  const old = await session.startProcess(serviceSpec('api-replaced', serverScript, { role: 'api', port: 39991 }));
  const oldIdentity = { startTime: old.processStartTime, fingerprint: old.processFingerprint };
  await session.stop(old.id, 'replaced-by-new-api');
  await assertPidExited(old.pid, oldIdentity);
  const current = await session.startProcess(serviceSpec('api-replaced', serverScript, { role: 'api', port: 39991 }));
  const currentIdentity = { startTime: current.processStartTime, fingerprint: current.processFingerprint };
  assert.notEqual(old.id, current.id);
  assert.notEqual(old.pid, current.pid);
  const status = await session.status();
  assert.equal(status.resources.filter(item => item.label === 'api-replaced').length, 2,
    'replacing a service must append a new instance without overwriting the old PID');
  await closeSession(session, 'replacement-completion');
  assert.equal(fs.existsSync(root), false);
  await assertPidExited(current.pid, currentIdentity);
  const report = assertCleanupEvent(session.instanceId, 'replacement-completion');
  const exitedPids = report.events.filter(event => event.event === 'pid_exit_confirmed').map(event => event.pid);
  assert.ok(exitedPids.includes(old.pid));
  assert.ok(exitedPids.includes(current.pid));
  return { name: 'replaced service PID retained and cleaned', oldPid: old.pid, newPid: current.pid,
    tempDir: root, peakDirectoryBytes: report.cleaned.peakDirectoryBytes };
}

async function testFailedMysqlShutdownPreservesEvidence() {
  const session = await createSession();
  const root = session.tempDir;
  const guardianPid = session.guardian.pid;
  const guardianIdentity = session.guardianIdentity;
  const mysql = await session.startProcess({
    label: 'synthetic-mysql-shutdown-failure', kind: 'mysql', role: 'mysql', command: process.execPath,
    args: ['-e', "process.stdout.write('FAKE_MYSQL_DIAGNOSTIC\\n');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)"],
    cwd: projectRoot, leaseMs: session.limits.leaseMs, shutdownTimeoutMs: 1500,
    shutdownCommand: { command: process.execPath, args: ['-e', 'process.exit(7)'] }
  });
  const mysqlIdentity = { startTime: mysql.processStartTime, fingerprint: mysql.processFingerprint };
  await delay(100);
  let closeError = null;
  try { await closeSession(session, 'synthetic-mysql-shutdown-failure'); }
  catch (error) { closeError = error; }
  assert.ok(closeError, 'failed MySQL shutdown must preserve its diagnostic directory');
  assert.match(closeError.message, /resource cleanup preserved diagnostics/);
  assert.equal(fs.existsSync(root), true, 'diagnostics were removed after a failed socket shutdown');
  await assertPidExited(mysql.pid, mysqlIdentity);
  assert.equal(processMatches(guardianPid, guardianIdentity), false, 'guardian survived failure preservation');
  const events = registryTail().filter(event => event.instanceId === session.instanceId);
  const preserved = events.findLast(event => event.event === 'instance_cleanup_preserved');
  assert.ok(preserved, 'missing preserved-instance registry evidence');
  assert.match(preserved.openHandleCheck, /lsof \+D and lsof \+L1 completed with no matching handles/);
  assert.equal(preserved.reason, 'mysql-shutdown-command-failed:7');
  const serverSummary = events.findLast(event => event.event === 'resource_cleanup_summary' &&
    event.label === 'synthetic-mysql-shutdown-failure');
  assert.ok(serverSummary);
  assert.match(serverSummary.logTail, /FAKE_MYSQL_DIAGNOSTIC/);
  const shutdownFailure = events.findLast(event => event.event === 'mysql_shutdown_failed');
  assert.equal(shutdownFailure.shutdownExitCode, 7);
  assert.ok(events.some(event => event.event === 'pid_exit_confirmed' && event.pid === mysql.pid && event.exactIdentityExited));
  assert.ok(events.some(event => event.event === 'guardian_pid_exited' && event.guardianPid === guardianPid));
  const shutdownProcess = events.findLast(event => event.event === 'process_started' &&
    event.resourceLabel === 'synthetic-mysql-shutdown-failure-shutdown');
  assert.ok(shutdownProcess, 'shutdown command process was not registered');
  await assertPidExited(shutdownProcess.pid, {
    startTime: shutdownProcess.processStartTime, fingerprint: shutdownProcess.processFingerprint
  });
  const allStarted = events.filter(event => ['process_started', 'child_process_started'].includes(event.event) && Number.isInteger(event.pid));
  const exitEvidence = events.filter(event => event.event === 'pid_exit_confirmed' && event.exactIdentityExited === true);
  assert.deepEqual(allStarted.filter(start => !exitEvidence.some(exit => exit.pid === start.pid &&
    exit.processFingerprint === start.processFingerprint && exit.processStartTime === start.processStartTime)), [],
  'a preserved synthetic instance must still have exact exit evidence for each PID');

  appendResourceRegistry(session.registryPath, {
    taskId, instanceId: session.instanceId, event: 'synthetic_preserved_diagnostic_evidence_recorded',
    tempDir: root, reason: 'failure log tail and PID-exit evidence retained in append-only registry'
  });
  fs.rmSync(root, { recursive: true, force: false });
  assert.equal(fs.existsSync(root), false, 'synthetic self-test left a preserved directory behind');
  appendResourceRegistry(session.registryPath, {
    taskId, instanceId: session.instanceId, event: 'synthetic_preserved_diagnostic_directory_removed',
    tempDir: root, registeredPids: [...new Set(allStarted.map(event => event.pid))],
    allPidsExited: true, openHandleCheck: preserved.openHandleCheck,
    diagnosticTailPreservedInRegistry: true, directoryAbsentAfterRemoval: true
  });
  return { name: 'MySQL socket shutdown failure preserves bounded diagnostics',
    mysqlPid: mysql.pid, shutdownExitCode: 7, guardianPid, tempDir: root,
    diagnosticTailBytes: Buffer.byteLength(serverSummary.logTail), diagnosticRecorded: true,
    tempDirRemovedAfterEvidenceCapture: true };
}

async function testApiHelpersFailClosed() {
  let callbackCalled = false;
  const invalidSession = {};
  const missingSessionError = /active managed ResourceSession|missing, malformed, or inactive ResourceSession/;
  await assert.rejects(withTemporaryApi(() => { callbackCalled = true; }), missingSessionError);
  await assert.rejects(withTemporaryApi(() => { callbackCalled = true; }, 'unused-', {}, { resourceSession: invalidSession }), missingSessionError);
  await assert.rejects(withDatabaseApi('sqlite', () => { callbackCalled = true; }), missingSessionError);
  await assert.rejects(withDatabaseApi('sqlite', () => { callbackCalled = true; }, { resourceSession: invalidSession }), missingSessionError);
  await assert.rejects(withDatabaseApi('mysql', () => { callbackCalled = true; }), missingSessionError);
  await assert.rejects(withMysqlDatabase(() => { callbackCalled = true; }), missingSessionError);
  await assert.rejects(withApiAtDatabase(path.join(projectRoot, 'output', 'unmanaged-api-must-not-create.sqlite'),
    () => { callbackCalled = true; }), missingSessionError);
  assert.equal(callbackCalled, false, 'unmanaged API helper invoked its callback before rejecting');
  assert.equal(fs.existsSync(path.join(projectRoot, 'output', 'unmanaged-api-must-not-create.sqlite')), false,
    'unmanaged API helper created a database path before rejecting');
  return { name: 'API helpers reject absent and malformed sessions before spawn', spawnAttempted: false,
    helpers: ['withTemporaryApi', 'withDatabaseApi-sqlite', 'withDatabaseApi-mysql', 'withMysqlDatabase', 'withApiAtDatabase'] };
}

async function testIdleRpcSocketIsDestroyedDuringClose() {
  const session = await createSession();
  const guardianPid = session.guardian.pid;
  const guardianIdentity = session.guardianIdentity;
  const idleSocket = net.createConnection(session.socketPath);
  const connected = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('idle guardian socket connect timed out')), 3000);
    idleSocket.once('connect', () => { clearTimeout(timer); resolve(true); });
    idleSocket.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(connected, true);
  let closeError = null;
  let cleanup;
  try { cleanup = await closeSession(session, 'idle-rpc-socket-close'); }
  catch (error) { closeError = error; }
  finally { idleSocket.destroy(); }
  assert.equal(closeError, null, closeError?.message);
  assert.equal(cleanup.ok, true);
  await assertPidExited(guardianPid, guardianIdentity, 'guardian remained alive after closing an idle RPC client');
  return { name: 'guardian close destroys idle RPC sockets before reporting cleanup',
    guardianPid, cleanupEvent: cleanup.cleanupRecord.event, idleClientClosedByCleanup: true };
}

async function testDefaultRegistrySegmentsWhenLegacyLedgerIsNearLimit() {
  const legacyRegistry = path.join(projectRoot, 'output', 'resource-audit', 'registry.jsonl');
  const legacyBytes = fs.existsSync(legacyRegistry) ? fs.statSync(legacyRegistry).size : 0;
  const shouldSegment = 32 * 1024 * 1024 - legacyBytes < 4 * 1024 * 1024;
  if (!shouldSegment) {
    return { name: 'default registry segmentation threshold', skipped: true,
      reason: 'legacy registry has more than 4 MiB available; no artificial file growth was used', legacyBytes };
  }
  const session = await createSession({ auditRoot: undefined });
  assert.ok(session.auditRoot.startsWith(path.join(projectRoot, 'output', 'resource-audit', 'segments', taskId)),
    'near-full legacy ledger did not select a task-specific segment');
  assert.notEqual(session.registryPath, legacyRegistry);
  const closed = await closeSession(session, 'default-segment-empty-session');
  assert.equal(closed.ok, true);
  await assertPidExited(session.guardian.pid, session.guardianIdentity, 'segmented-session guardian identity did not exit');
  const manifestPath = path.join(projectRoot, 'output', 'resource-audit', 'registry-segments.jsonl');
  const manifest = registryTailFrom(manifestPath, 64 * 1024);
  const selected = manifest.findLast(event => event.event === 'resource_registry_segment_selected' && event.instanceId === session.instanceId);
  assert.ok(selected, 'segment manifest is missing this isolated registry path');
  assert.equal(selected.registryPath, session.registryPath);
  assert.equal(selected.legacyRegistryBytes, legacyBytes);
  assert.match(selected.legacyRegistrySha256, /^[a-f0-9]{64}$/);
  return { name: 'default registry segments when legacy ledger is near limit',
    legacyBytes, legacyRegistrySha256: selected.legacyRegistrySha256,
    segmentRegistryPath: session.registryPath, guardianPid: session.guardian.pid,
    cleanup: closed.cleanupRecord.event };
}

async function main() {
  try {
    const cases = [
      ['general', testApiHelpersFailClosed],
      ['general', testIdleRpcSocketIsDestroyedDuringClose],
      ['general', testDefaultRegistrySegmentsWhenLegacyLedgerIsNearLimit],
      ['general', testNormalAndDelayedExit],
      ['general', testExceptionCleanup],
      ['general', testFailedStartIsRegistered],
      ['general', testNonzeroExitAndRunnerPropagation],
      ['general', testExecIdentityAndStop],
      ['general', testWideCleanupEvidence],
      ['general', testRegistryWriteFailureCannotPass],
      ['general', testRpcPrematureEndAndTimeout],
      ['general', testRunnerFailsOnIsolatedRegistryWriteFailure],
      ['general', testTimeoutAndLease],
      ['owner-lifecycle', testOwnerNaturalExitBeforeExitCleanup],
      ['owner-lifecycle', testOwnerSigtermCancellationCleanup],
      ['owner-lifecycle', testOwnerKilledWithWriterChild],
      ['general', testLogAndDirectoryLimits],
      ['general', testReplacementRetainsBothPids],
      ['general', testFailedMysqlShutdownPreservesEvidence]
    ];
    const requestedFilter = process.env.RESOURCE_TEST_FILTER?.trim() || null;
    if (requestedFilter && !['general', 'owner-lifecycle'].includes(requestedFilter)) {
      throw new Error(`unsupported RESOURCE_TEST_FILTER: ${requestedFilter}`);
    }
    const selectedCases = requestedFilter ? cases.filter(([group]) => group === requestedFilter) : cases;
    for (const [, run] of selectedCases) testResults.push(await run());
    const residualState = fs.existsSync(path.join(auditRoot, 'state')) ? fs.readdirSync(path.join(auditRoot, 'state')) : [];
    assert.deepEqual(residualState, [], 'finished tests left guardian configuration files behind');
    const instances = new Set(testResults.map(item => item.name));
    assert.equal(instances.size, testResults.length);
    return { status: 'PASS', taskId, runKey, startedAt, finishedAt: new Date().toISOString(),
      testFilter: process.env.RESOURCE_TEST_FILTER?.trim() || null,
      tests: testResults.length, defaultLimits: RESOURCE_LIMITS, results: testResults,
      registryPath: path.join(auditRoot, 'registry.jsonl'), residualGuardianConfigs: residualState };
  } finally {
    const cleanupErrors = [];
    for (const session of [...liveSessions]) {
      try { await closeSession(session, 'test-harness-finally'); }
      catch (error) { cleanupErrors.push(`${session.instanceId}: ${error.message}`); }
    }
    if (cleanupErrors.length) throw new Error(`test harness cleanup blocked: ${cleanupErrors.join('; ')}`);
  }
}

main().then(report => {
  fs.writeFileSync(evidencePath, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, taskId, runKey, tests: report.tests,
    registryPath: report.registryPath, evidencePath, residualGuardianConfigs: report.residualGuardianConfigs }));
}).catch(error => {
  const failure = { status: 'FAIL', taskId, runKey, startedAt, finishedAt: new Date().toISOString(),
    testFilter: process.env.RESOURCE_TEST_FILTER?.trim() || null,
    results: testResults, error: String(error?.stack || error?.message || error).slice(0, 16 * 1024),
    registryPath: path.join(auditRoot, 'registry.jsonl') };
  let evidenceError = null;
  try { fs.writeFileSync(evidencePath, JSON.stringify(failure, null, 2), { flag: 'wx', mode: 0o600 }); }
  catch (writeError) { evidenceError = String(writeError.message || writeError); }
  console.error(JSON.stringify({ status: 'FAIL', taskId, runKey, testsCompleted: testResults.length,
    registryPath: failure.registryPath, evidencePath, evidenceError,
    error: failure.error.slice(-4096) }));
  process.exitCode = 1;
});
