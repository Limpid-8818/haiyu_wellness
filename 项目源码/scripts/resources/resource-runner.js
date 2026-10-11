#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  ResourceSession, appendResourceRegistry, processIdentity, waitForExactProcessExit
} from './resource-runtime.js';

const MAX_RESOURCE_REGISTRY_BYTES = 32 * 1024 * 1024;
const MAX_RESOURCE_REGISTRY_LINE_BYTES = 64 * 1024;

let terminalResultEmitted = false;
let activeTaskId = process.env.CODEX_TASK_ID || null;

process.once('beforeExit', () => {
  if (terminalResultEmitted) return;
  terminalResultEmitted = true;
  console.error(JSON.stringify({ status: 'FAIL', taskId: activeTaskId,
    error: 'resource runner ended before reporting a terminal task and cleanup result', terminalResultMissing: true }));
  process.exitCode = 1;
});

function parseArgs(argv) {
  const options = { taskId: '', kind: 'test', name: '', timeoutMs: 15 * 60 * 1000, leaseMs: 15 * 60 * 1000,
    logBytes: undefined, directoryBytes: undefined, port: undefined, datadir: undefined, socket: undefined,
    auditRoot: undefined, tempParent: process.platform === 'win32' ? undefined : '/tmp', cwd: process.cwd(), showOutput: true };
  const separator = argv.indexOf('--');
  const flags = separator < 0 ? argv : argv.slice(0, separator);
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (flag === '--task-id') { options.taskId = value; index += 1; }
    else if (flag === '--kind') { options.kind = value; index += 1; }
    else if (flag === '--name') { options.name = value; index += 1; }
    else if (flag === '--timeout-ms') { options.timeoutMs = Number(value); index += 1; }
    else if (flag === '--lease-ms') { options.leaseMs = Number(value); index += 1; }
    else if (flag === '--log-bytes') { options.logBytes = Number(value); index += 1; }
    else if (flag === '--directory-bytes') { options.directoryBytes = Number(value); index += 1; }
    else if (flag === '--port') { options.port = Number(value); index += 1; }
    else if (flag === '--datadir') { options.datadir = value; index += 1; }
    else if (flag === '--socket') { options.socket = value; index += 1; }
    else if (flag === '--audit-root') { options.auditRoot = value; index += 1; }
    else if (flag === '--temp-parent') { options.tempParent = value; index += 1; }
    else if (flag === '--cwd') { options.cwd = value; index += 1; }
    else if (flag === '--no-output') options.showOutput = false;
    else throw new Error(`unknown resource runner option: ${flag}`);
  }
  if (!options.taskId) options.taskId = process.env.CODEX_TASK_ID || '';
  if (!options.taskId) throw new Error('pass --task-id or set CODEX_TASK_ID');
  activeTaskId = options.taskId;
  if (!command.length) throw new Error('append a command after --');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer');
  options.command = command[0];
  options.commandArgs = command.slice(1);
  return options;
}

function snapshotTaskRegistrySizes(projectRoot, taskId) {
  const root = path.join(projectRoot, 'output', 'resource-audit', 'segments', taskId);
  const registries = new Map();
  if (!fs.existsSync(root)) return registries;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile() && entry.name === 'registry.jsonl') {
        const size = fs.statSync(target).size;
        if (size > MAX_RESOURCE_REGISTRY_BYTES) throw new Error(`resource registry exceeds 32 MiB: ${target}`);
        registries.set(target, size);
      }
    }
  }
  return registries;
}

function forEachAppendedRegistryEvent(registryPath, offset, callback) {
  const stat = fs.statSync(registryPath);
  if (stat.size > MAX_RESOURCE_REGISTRY_BYTES) throw new Error(`resource registry exceeds 32 MiB: ${registryPath}`);
  if (stat.size < offset) throw new Error(`resource registry shrank during task: ${registryPath}`);
  if (stat.size === offset) return;
  const fd = fs.openSync(registryPath, 'r');
  const chunk = Buffer.alloc(64 * 1024);
  let position = offset;
  let pending = Buffer.alloc(0);
  try {
    while (position < stat.size) {
      const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (!count) break;
      position += count;
      pending = pending.length ? Buffer.concat([pending, chunk.subarray(0, count)]) : Buffer.from(chunk.subarray(0, count));
      let newline;
      while ((newline = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, newline);
        if (line.length > MAX_RESOURCE_REGISTRY_LINE_BYTES) throw new Error(`resource registry line exceeds 64 KiB: ${registryPath}`);
        if (line.length) callback(JSON.parse(line.toString('utf8')));
        pending = pending.subarray(newline + 1);
      }
      if (pending.length > MAX_RESOURCE_REGISTRY_LINE_BYTES) throw new Error(`resource registry line exceeds 64 KiB: ${registryPath}`);
    }
  } finally { fs.closeSync(fd); }
  if (pending.length) throw new Error(`resource registry has an incomplete appended line: ${registryPath}`);
}

function processIdentityKey(pid, startTime, fingerprint) {
  return `${Number(pid)}\0${startTime || ''}\0${fingerprint || ''}`;
}

async function reconcileNestedGuardianExits({ projectRoot, taskId, registrySizes, resourceResult }) {
  const trackedProcesses = new Map((resourceResult?.pids || []).map(item => [
    processIdentityKey(item.pid, item.startTime, item.fingerprint), item
  ]));
  const sessions = new Map();
  const currentRegistries = snapshotTaskRegistrySizes(projectRoot, taskId);
  for (const registryPath of registrySizes.keys()) {
    if (!currentRegistries.has(registryPath)) throw new Error(`pre-existing task registry disappeared: ${registryPath}`);
  }
  for (const [registryPath, currentSize] of currentRegistries) {
    const previousSize = registrySizes.get(registryPath) || 0;
    if (currentSize < previousSize) throw new Error(`resource registry shrank during task: ${registryPath}`);
    forEachAppendedRegistryEvent(registryPath, previousSize, event => {
      if (event.taskId !== taskId || typeof event.instanceId !== 'string') return;
      const key = `${registryPath}\0${event.instanceId}`;
      if (event.event === 'runner_started') {
        const identityKey = processIdentityKey(event.ownerPid, event.ownerStartTime, event.ownerFingerprint);
        if (trackedProcesses.has(identityKey)) sessions.set(key, { registryPath, runner: event, guardian: null, guardianExit: null });
        return;
      }
      const session = sessions.get(key);
      if (!session) return;
      if (event.event === 'guardian_started' || event.event === 'guardian_ready') session.guardian = event;
      if (event.event === 'guardian_pid_exited') session.guardianExit = event;
    });
  }

  const observerIdentity = processIdentity(process.pid);
  if (!observerIdentity) throw new Error('resource runner has no exact observer process identity');
  const observations = [];
  for (const session of sessions.values()) {
    const guardian = session.guardian;
    if (!guardian || !Number.isInteger(Number(guardian.guardianPid)) || !guardian.guardianStartTime || !guardian.guardianFingerprint) continue;
    const completeExit = session.guardianExit?.exitConfirmed === true &&
      session.guardianExit.guardianStartTime === guardian.guardianStartTime &&
      session.guardianExit.guardianFingerprint === guardian.guardianFingerprint &&
      typeof session.guardianExit.exactIdentityAbsentAt === 'string' &&
      typeof session.guardianExit.processGroupEmptyAt === 'string' &&
      Array.isArray(session.guardianExit.processGroupMembers) && session.guardianExit.processGroupMembers.length === 0;
    if (completeExit) continue;
    const identity = {
      pid: Number(guardian.guardianPid), startTime: guardian.guardianStartTime,
      fingerprint: guardian.guardianFingerprint, pgid: Number(guardian.guardianPgid) || Number(guardian.guardianPid)
    };
    const observation = await waitForExactProcessExit(identity, { timeoutMs: 20_000, pollMs: 100 });
    if (!observation) {
      throw new Error(`nested guardian PID ${identity.pid} has no complete exact-exit observation; registry=${session.registryPath}; instance=${session.runner.instanceId}`);
    }
    const exitEvent = {
      taskId, instanceId: session.runner.instanceId, event: 'guardian_pid_exited',
      guardianPid: identity.pid, guardianStartTime: identity.startTime, guardianFingerprint: identity.fingerprint,
      guardianPgid: identity.pgid, exitConfirmed: true, exitCode: null, exitSignal: null,
      exitStatusUnavailable: true, exitObservedAt: observation.exactIdentityAbsentAt,
      exactIdentityAbsentAt: observation.exactIdentityAbsentAt,
      processGroupEmptyAt: observation.processGroupEmptyAt,
      processGroupMembers: observation.processGroupMembers,
      currentPidIdentity: observation.currentPidIdentity,
      observerPid: observerIdentity.pid, observerStartTime: observerIdentity.startTime,
      observerFingerprint: observerIdentity.fingerprint, observerTaskId: taskId,
      observationMethod: 'resource-runner-live-descendant-exact-identity-and-process-group-observer',
      ownerPid: session.runner.ownerPid, ownerStartTime: session.runner.ownerStartTime,
      ownerFingerprint: session.runner.ownerFingerprint, registryPath: session.registryPath
    };
    appendResourceRegistry(session.registryPath, exitEvent, { reserveBytes: 0 });
    observations.push({ instanceId: session.runner.instanceId, guardianPid: identity.pid,
      registryPath: session.registryPath, exitObservedAt: observation.exactIdentityAbsentAt });
  }
  return observations;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const projectRoot = path.resolve(process.cwd());
  const registrySizes = snapshotTaskRegistrySizes(projectRoot, options.taskId);
  const session = await ResourceSession.create({
    taskId: options.taskId, projectRoot, auditRoot: options.auditRoot, tempParent: options.tempParent,
    limits: {
      leaseMs: options.leaseMs,
      ...(options.logBytes === undefined ? {} : { logBytes: options.logBytes }),
      ...(options.directoryBytes === undefined ? {} : { directoryBytes: options.directoryBytes })
    }
  });
  let result;
  let taskError = null;
  let nestedGuardianExitObservations = [];
  try {
    result = await session.runProcess({
      label: options.name || options.kind, kind: options.kind, role: options.kind,
      command: options.command, args: options.commandArgs, cwd: options.cwd,
      port: options.port, datadir: options.datadir, socket: options.socket,
      leaseMs: options.leaseMs
    }, { timeoutMs: options.timeoutMs });
  } catch (error) { taskError = error; }
  try {
    nestedGuardianExitObservations = await reconcileNestedGuardianExits({
      projectRoot, taskId: options.taskId, registrySizes, resourceResult: result
    });
  } catch (error) {
    taskError = taskError ? new AggregateError([taskError, error], 'task and nested guardian exit observation failed') : error;
  }
  let cleanup;
  try { cleanup = await session.close(taskError ? 'owner-exception' : result?.timedOut ? 'timeout' : 'owner-finally'); }
  catch (error) { taskError = taskError ? new AggregateError([taskError, error], 'task failed and cleanup is blocked') : error; }
  const report = {
    taskId: options.taskId, instanceId: session.instanceId, resource: result || null,
    cleanup: cleanup || null, nestedGuardianExitObservations, registryPath: session.registryPath,
    tempDirRemoved: !session.tempDir || !fs.existsSync(session.tempDir)
  };
  if (options.showOutput && result?.tail) report.outputTail = result.tail.slice(-32 * 1024);
  if (taskError) {
    terminalResultEmitted = true;
    console.error(JSON.stringify({ status: 'FAIL', error: taskError.message, ...report }, null, 2));
    process.exitCode = result?.timedOut ? 124 : (Number.isInteger(result?.exitCode) && result.exitCode !== 0 ? result.exitCode : 1);
    return;
  }
  const failed = !result || result.timedOut || result.status !== 'exited' || result.exitCode !== 0 || result.signal != null ||
    cleanup?.ok !== true || cleanup.status !== 'cleaned' || cleanup.cleanupRecord?.event !== 'instance_cleaned' ||
    report.tempDirRemoved !== true;
  terminalResultEmitted = true;
  console.log(JSON.stringify({ status: failed ? 'FAIL' : 'PASS', ...report }, null, 2));
  if (failed) process.exitCode = result?.timedOut ? 124 : (Number.isInteger(result?.exitCode) && result.exitCode !== 0 ? result.exitCode : 1);
}

main().catch(error => {
  terminalResultEmitted = true;
  console.error(JSON.stringify({ status: 'FAIL', taskId: activeTaskId, error: error.stack || error.message,
    terminalResultMissing: true }, null, 2));
  process.exitCode = 1;
});
