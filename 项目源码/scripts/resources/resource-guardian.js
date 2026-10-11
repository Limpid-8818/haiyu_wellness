import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES, appendResourceRegistry, assertResourceRegistryCapacity, processGroupMembers, processIdentity, processMatches,
  readResourceLogTail, redactResourceCommand
} from './resource-runtime.js';

const configArg = process.argv.indexOf('--config');
if (configArg < 0 || !process.argv[configArg + 1]) process.exit(64);

const configPath = path.resolve(process.argv[configArg + 1]);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const { taskId, instanceId, root, socketPath, registryPath, owner, limits } = config;
const registryCleanupReserveBytes = Math.max(0, Number(config.registryCleanupReserveBytes || RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES));
const guardianIdentity = processIdentity(process.pid);
const resources = new Map();
const sockets = new Set();
let server;
let monitorTimer;
let cleanupPromise;
let cleanupReason = '';
let sessionStatus = 'starting';
let peakDirectoryBytes = 0;
let monitorBusy = false;
let finalSummary = null;
let registryFailure = null;

function registryPayload(event) {
  return {
    taskId, instanceId, guardianPid: process.pid, ownerPid: owner.pid,
    tempDir: root, socket: socketPath, ...event
  };
}

function noteRegistryFailure(eventName, error) {
  registryFailure ||= { eventName, message: String(error?.message || error).slice(0, 2048) };
  cleanupReason = `registry-error:${registryFailure.message}`;
  if (!cleanupPromise) setImmediate(() => { void cleanupSession(cleanupReason); });
}

function record(event, { terminal = false } = {}) {
  try {
    appendResourceRegistry(registryPath, registryPayload(event), {
      reserveBytes: terminal ? 0 : registryCleanupReserveBytes
    });
    return true;
  } catch (error) {
    noteRegistryFailure(event?.event || 'unknown', error);
    return false;
  }
}

function allocatedSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  let total = 0;
  let count = 0;
  while (stack.length) {
    const target = stack.pop();
    let stat;
    try { stat = fs.lstatSync(target); }
    catch (error) {
      // MySQL removes transient #sql files while the byte-limit walk is in
      // progress. A missing entry was already unlinked by its owner; the next
      // monitor pass will account for the settled directory size.
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    total += Number.isFinite(stat.blocks) ? stat.blocks * 512 : Math.ceil(stat.size / 4096) * 4096;
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names;
      try { names = fs.readdirSync(target); }
      catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      for (const name of names) {
        stack.push(path.join(target, name));
        count += 1;
        if (count > 100_000) return Math.max(total, limits.directoryBytes + 1);
      }
    }
    if (total > limits.directoryBytes) return total;
  }
  return total;
}

function commandSummary(command, args) { return redactResourceCommand(command, args); }

function tailSummary(resource) {
  return readResourceLogTail(resource.logPath, 4096);
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value)) throw new Error('path must be relative to the managed temp directory');
  const resolved = path.resolve(root, value);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('path escapes the managed temp directory');
  return resolved;
}

function processTable() {
  const result = spawnSync('ps', ['-Ao', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('could not enumerate process table');
  return (result.stdout || '').split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) } : null;
  }).filter(Boolean);
}

function resourceSnapshot(resource) {
  return {
    id: resource.id, label: resource.label, kind: resource.kind, role: resource.role,
    status: resource.status, pid: resource.pid, processGroup: resource.pgid,
    processStartTime: resource.identity?.startTime || null, processFingerprint: resource.identity?.fingerprint || null,
    processExecutable: resource.identity?.executable || null,
    command: resource.command, cwd: resource.cwd, tempDir: resource.workDir,
    datadir: resource.datadir, socket: resource.socket, port: resource.port,
    logPath: resource.logPath, logBytes: resource.logBytes, logPeakBytes: resource.logPeakBytes,
    maxLogBytes: limits.logBytes, directoryPeakBytes: peakDirectoryBytes, maxDirectoryBytes: limits.directoryBytes,
    leaseExpiresAt: new Date(resource.leaseExpiresAt).toISOString(), stopReason: resource.stopReason || null,
    exitCode: resource.exitCode, signal: resource.exitSignal,
    shutdownOutcome: resource.gracefulShutdownOk ? 'socket-shutdown-and-process-exit-confirmed' : resource.preserveOnCleanup || null,
    pids: [...resource.pids.values()].map(item => ({ ...item }))
  };
}

function openLog(resource) {
  fs.mkdirSync(path.dirname(resource.logPath), { recursive: true, mode: 0o700 });
  resource.logFd = fs.openSync(resource.logPath, 'a', 0o600);
  resource.logBytes = fs.fstatSync(resource.logFd).size;
  resource.logPeakBytes = resource.logBytes;
  if (resource.logBytes > limits.logBytes) throw new Error('existing resource log already exceeds its configured limit');
}

function redactOutput(text) {
  return String(text).replace(/((?:api[_-]?key|apikey|authorization|bearer|password|passwd|secret|token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}

function writeLog(resource, text) {
  if (!text || resource.logFd === undefined) return;
  const output = Buffer.from(redactOutput(text));
  const remaining = Math.max(0, limits.logBytes - resource.logBytes);
  if (output.length <= remaining) {
    fs.writeSync(resource.logFd, output);
    resource.logBytes += output.length;
    resource.logPeakBytes = Math.max(resource.logPeakBytes, resource.logBytes);
    return;
  }
  if (remaining > 0) {
    fs.writeSync(resource.logFd, output.subarray(0, remaining));
    resource.logBytes += remaining;
    resource.logPeakBytes = Math.max(resource.logPeakBytes, resource.logBytes);
  }
  resource.limitReason = 'log-limit';
  record({ event: 'log_limit_exceeded', resourceId: resource.id, pid: resource.pid, logPath: resource.logPath,
    logBytes: resource.logBytes, maxLogBytes: limits.logBytes, command: resource.command, port: resource.port, datadir: resource.datadir });
  void cleanupSession('log-limit');
}

function closeLog(resource) {
  if (resource.logFd !== undefined) {
    try { fs.fsyncSync(resource.logFd); } catch { /* process may have closed the volume */ }
    try { fs.closeSync(resource.logFd); } catch { /* already closed */ }
    delete resource.logFd;
  }
}

function attachOutput(resource, child) {
  child.stdout?.on('data', chunk => writeLog(resource, chunk.toString('utf8')));
  child.stderr?.on('data', chunk => writeLog(resource, chunk.toString('utf8')));
}

function addPid(resource, pid, ppid, pgid, identity, { main = false } = {}) {
  if (!identity) return;
  if (!main && identity.state?.startsWith('Z')) return;
  if (main && [...resource.pids.values()].some(item => item.pid === pid && item.main)) return;
  const key = `${pid}:${identity.fingerprint}`;
  if (resource.pids.has(key)) return;
  const item = { pid, ppid, pgid, startTime: identity.startTime, executable: identity.executable,
    fingerprint: identity.fingerprint, main };
  resource.pids.set(key, item);
  record({ event: main ? 'process_started' : 'child_process_started', resourceId: resource.id,
    resourceLabel: resource.label, resourceKind: resource.kind, role: resource.role,
    pid, ppid, pgid, processStartTime: identity.startTime, processExecutable: identity.executable,
    processFingerprint: identity.fingerprint,
    command: resource.command, cwd: resource.cwd, tempDir: resource.workDir, logPath: resource.logPath,
    port: resource.port, datadir: resource.datadir, socket: resource.socket,
    guardianStartTime: guardianIdentity?.startTime, ownerStartTime: owner.startTime });
}

function trackDescendants(resource) {
  if (!resource.pid) return;
  let table;
  try { table = processTable(); }
  catch (error) { record({ event: 'process_scan_error', resourceId: resource.id, error: error.message }); return; }
  const knownPids = new Set([...resource.pids.values()].map(item => item.pid));
  const queue = [resource.pid, ...knownPids];
  const seen = new Set();
  while (queue.length) {
    const parent = queue.shift();
    if (seen.has(parent)) continue;
    seen.add(parent);
    for (const row of table) {
      if (row.ppid !== parent || seen.has(row.pid)) continue;
      const identity = processIdentity(row.pid);
      addPid(resource, row.pid, row.ppid, row.pgid, identity);
      queue.push(row.pid);
    }
  }
  for (const row of table) {
    if (row.pgid !== resource.pgid) continue;
    const identity = processIdentity(row.pid);
    addPid(resource, row.pid, row.ppid, row.pgid, identity, { main: row.pid === resource.pid });
  }
}

function currentKnownPids(resource) {
  const alive = [];
  for (const item of resource.pids.values()) {
    if (processMatches(item.pid, { startTime: item.startTime, fingerprint: item.fingerprint })) alive.push(item);
  }
  return alive;
}

async function waitForResourceGone(resource, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    trackDescendants(resource);
    const inGroup = processGroupMembers(resource.pgid);
    const knownAlive = currentKnownPids(resource);
    if (!inGroup.length && !knownAlive.length) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  trackDescendants(resource);
  return processGroupMembers(resource.pgid).length === 0 && currentKnownPids(resource).length === 0;
}

function signalResource(resource, signal) {
  trackDescendants(resource);
  const members = processGroupMembers(resource.pgid);
  const knownAlive = currentKnownPids(resource);
  const groupOwned = members.some(row => knownAlive.some(item => item.pid === row.pid)) ||
    (resource.identity && processMatches(resource.pid, resource.identity));
  if (members.length && groupOwned && resource.pgid === resource.pid) {
    try { process.kill(-resource.pgid, signal); }
    catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
  }
  for (const item of knownAlive) {
    const currentMembers = processGroupMembers(resource.pgid);
    if (currentMembers.some(row => row.pid === item.pid)) continue;
    if (!processMatches(item.pid, { startTime: item.startTime, fingerprint: item.fingerprint })) continue;
    try { process.kill(item.pid, signal); }
    catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
  }
  return { groupMembers: members.length, knownAlive: knownAlive.length, groupOwned };
}

function roleOrder(resource) {
  const role = String(resource.role || '').toLowerCase();
  if (['browser', 'client'].includes(role)) return 0;
  if (['test', 'runner', 'probe', 'shutdown'].includes(role)) return 1;
  if (['vite', 'web'].includes(role)) return 2;
  if (role === 'api') return 3;
  if (['mysql', 'database', 'db'].includes(role)) return 4;
  return 5;
}

function makeResource(spec, { parentId = null } = {}) {
  const id = crypto.randomUUID();
  const workDir = path.join(root, 'work', id);
  return {
    id, parentId, label: spec.label, kind: spec.kind, role: spec.role,
    command: commandSummary(spec.command, spec.args), rawCommand: spec.command, args: spec.args,
    cwd: path.resolve(spec.cwd), env: spec.env || {}, port: spec.port, datadir: spec.datadir, socket: spec.socket,
    shutdownCommand: spec.shutdownCommand, shutdownTimeoutMs: spec.shutdownTimeoutMs,
    workDir, logPath: path.join(root, 'logs', `${id}.log`), pid: null, pgid: null,
    identity: null, child: null, status: 'starting', startAt: Date.now(),
    leaseExpiresAt: Date.now() + spec.leaseMs, pids: new Map(), logBytes: 0, logPeakBytes: 0,
    exitCode: null, exitSignal: null, stopReason: null, exitPromise: null, resolveExit: null,
    stopPromise: null, limitReason: null, failureRecorded: false
  };
}

function recordStartFailure(resource, error) {
  if (resource.failureRecorded) return;
  resource.failureRecorded = true;
  record({ event: 'process_start_failed', resourceId: resource.id, resourceLabel: resource.label,
    resourceKind: resource.kind, role: resource.role, pid: resource.pid, processStartTime: resource.identity?.startTime || null,
    processFingerprint: resource.identity?.fingerprint || null, command: resource.command, error: String(error || 'process failed to start'),
    cwd: resource.cwd, tempDir: resource.workDir, logPath: resource.logPath, port: resource.port,
    datadir: resource.datadir, socket: resource.socket, exitCode: resource.exitCode, signal: resource.exitSignal });
}

async function startResource(spec, { parentId = null, allowDuringCleanup = false } = {}) {
  if (sessionStatus !== 'ready' && !(allowDuringCleanup && sessionStatus === 'cleaning')) throw new Error(`resource session is ${sessionStatus}`);
  if (typeof spec.command !== 'string' || !spec.command.trim() || !Array.isArray(spec.args ?? [])) throw new Error('invalid process command');
  if (Object.values(spec.env || {}).some(value => typeof value !== 'string')) throw new Error('resource env values must be strings');
  const resource = makeResource(spec, { parentId });
  resources.set(resource.id, resource);
  fs.mkdirSync(resource.workDir, { recursive: true, mode: 0o700 });
  try {
    openLog(resource);
    record({ event: 'process_starting', resourceId: resource.id, resourceLabel: resource.label,
      resourceKind: resource.kind, role: resource.role, command: resource.command, cwd: resource.cwd,
      tempDir: resource.workDir, logPath: resource.logPath, port: resource.port, datadir: resource.datadir,
      socket: resource.socket, envKeys: Object.keys(spec.env || {}).sort(), leaseMs: spec.leaseMs,
      maxLogBytes: limits.logBytes, maxDirectoryBytes: limits.directoryBytes });
    const tempWork = path.join(root, 'tmp');
    const env = {
      ...process.env,
      ...spec.env,
      TMPDIR: tempWork, TMP: tempWork, TEMP: tempWork, RESOURCE_TMPDIR: resource.workDir,
      RESOURCE_INSTANCE_ID: instanceId, RESOURCE_TASK_ID: taskId
    };
    resource.child = spawn(spec.command, spec.args, {
      cwd: path.resolve(spec.cwd), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    resource.exitPromise = new Promise(resolve => { resource.resolveExit = resolve; });
    resource.child.stdout?.on('data', chunk => writeLog(resource, chunk.toString('utf8')));
    resource.child.stderr?.on('data', chunk => writeLog(resource, chunk.toString('utf8')));
    resource.child.once('spawn', () => {
      resource.pid = resource.child.pid || null;
      resource.pgid = resource.pid;
      try {
        resource.identity = processIdentity(resource.pid);
        if (resource.identity) {
          addPid(resource, resource.pid, process.pid, resource.pgid, resource.identity, { main: true });
          resource.status = 'running';
        }
      } catch (error) { resource.spawnError = `could not capture process identity: ${error.message}`; }
    });
    resource.child.once('close', (code, signal) => {
      resource.exitCode = code;
      resource.exitSignal = signal;
      resource.childClosedAt = new Date().toISOString();
      closeLog(resource);
      if (!resource.identity) {
        resource.status = 'spawn_failed';
        recordStartFailure(resource, resource.spawnError || 'process exited before its identity was captured');
        resource.resolveExit?.(resourceSnapshot(resource));
        return;
      }
      record({ event: 'process_exit', resourceId: resource.id, pid: resource.pid, pgid: resource.pgid,
        processStartTime: resource.identity.startTime, processFingerprint: resource.identity.fingerprint,
        exitCode: code, signal, logBytes: resource.logBytes, logPeakBytes: resource.logPeakBytes,
        maxLogBytes: limits.logBytes, port: resource.port, datadir: resource.datadir, logPath: resource.logPath });
      void (async () => {
        trackDescendants(resource);
        const leftovers = await waitForResourceGone(resource, 250);
        if (!leftovers) await terminateResource(resource, 'leader-exit-with-child');
        else markPidsExited(resource);
        if (resource.status !== 'blocked') resource.status = code === 0 ? 'exited' : (code === null ? 'signaled' : 'failed');
        resource.resolveExit?.(resourceSnapshot(resource));
      })();
    });
    const spawnResult = await new Promise(resolve => {
      resource.child.once('spawn', () => resolve({ ok: true }));
      resource.child.once('error', error => resolve({ ok: false, error }));
    });
    if (!spawnResult.ok) throw spawnResult.error;
    if (!resource.pid) throw new Error('spawn did not return a process PID');
    if (!resource.identity) throw new Error(resource.spawnError || 'could not capture service PID start time and identity');
    return resourceSnapshot(resource);
  } catch (error) {
    closeLog(resource);
    resource.status = 'spawn_failed';
    resource.spawnError = error.message;
    recordStartFailure(resource, error.message);
    if (resource.pid) await terminateResource(resource, 'start-failed');
    else resource.resolveExit?.(resourceSnapshot(resource));
    return resourceSnapshot(resource);
  }
}

function markPidsExited(resource) {
  const group = processGroupMembers(resource.pgid);
  for (const item of resource.pids.values()) {
    const identity = { startTime: item.startTime, fingerprint: item.fingerprint };
    const alive = processMatches(item.pid, identity);
    const stillInGroup = group.some(row => row.pid === item.pid);
    if (!alive && !item.exitConfirmed) {
      record({ event: 'pid_exit_confirmed', resourceId: resource.id, pid: item.pid, ppid: item.ppid,
        pgid: item.pgid, processStartTime: item.startTime, processFingerprint: item.fingerprint,
        processExecutable: item.executable, identityStillMatches: false, stillInProcessGroup: stillInGroup,
        exactIdentityExited: true, verifiedAt: new Date().toISOString() });
      item.exitConfirmed = true;
    } else if (!alive) {
      continue;
    } else if (!stillInGroup && !item.outsideGroupReported) {
      record({ event: 'pid_identity_alive_outside_group', resourceId: resource.id, pid: item.pid, ppid: item.ppid,
        pgid: item.pgid, processStartTime: item.startTime, processFingerprint: item.fingerprint,
        processExecutable: item.executable, identityStillMatches: true, stillInProcessGroup: false,
        verifiedAt: new Date().toISOString() });
      item.outsideGroupReported = true;
    }
  }
}

async function runShutdownCommand(resource) {
  if (!resource.shutdownCommand || resource.shutdownStarted || resource.exitPromise === null) return;
  if (!['running', 'starting'].includes(resource.status)) return;
  resource.shutdownStarted = true;
  const command = resource.shutdownCommand;
  const spec = {
    label: `${resource.label}-shutdown`, kind: 'shutdown', role: 'shutdown',
    command: command.command, args: command.args || [], cwd: command.cwd || resource.cwd,
    env: command.env || {}, port: resource.port, datadir: resource.datadir, socket: resource.socket,
    leaseMs: Math.min(limits.leaseMs, resource.shutdownTimeoutMs), shutdownCommand: null
  };
  const shutdown = await startResource(spec, { parentId: resource.id, allowDuringCleanup: true });
  if (shutdown.status === 'spawn_failed') {
    resource.preserveOnCleanup = 'mysql-shutdown-command-failed-to-start';
    record({ event: 'mysql_shutdown_failed', resourceId: resource.id, pid: resource.pid,
      reason: resource.preserveOnCleanup, shutdownCommand: shutdown.command, logPath: shutdown.logPath,
      port: resource.port, datadir: resource.datadir, socket: resource.socket });
    return;
  }
  const target = resources.get(shutdown.id);
  const finished = await Promise.race([
    target.exitPromise,
    new Promise(resolve => setTimeout(() => resolve(null), resource.shutdownTimeoutMs))
  ]);
  if (!finished && ['running', 'starting'].includes(target.status)) {
    record({ event: 'shutdown_command_timeout', resourceId: resource.id, shutdownResourceId: target.id,
      pid: target.pid, processStartTime: target.identity?.startTime, timeoutMs: resource.shutdownTimeoutMs,
      command: target.command, logPath: target.logPath, port: resource.port, datadir: resource.datadir });
    await terminateResource(target, 'shutdown-timeout');
  }
  record({ event: 'shutdown_command_exit', resourceId: resource.id, shutdownResourceId: target.id,
    pid: target.pid, exitCode: target.exitCode, signal: target.exitSignal, logPath: target.logPath,
    logBytes: target.logBytes, maxLogBytes: limits.logBytes, command: target.command });
  if (finished?.exitCode !== 0 || finished?.signal || target.status !== 'exited') {
    resource.preserveOnCleanup = `mysql-shutdown-command-failed:${target.exitCode ?? target.exitSignal ?? target.status}`;
    record({ event: 'mysql_shutdown_failed', resourceId: resource.id, pid: resource.pid,
      reason: resource.preserveOnCleanup, shutdownPid: target.pid, shutdownExitCode: target.exitCode,
      shutdownSignal: target.exitSignal, command: target.command, logPath: target.logPath,
      port: resource.port, datadir: resource.datadir, socket: resource.socket });
    return;
  }
  const serverExit = await Promise.race([
    resource.exitPromise,
    new Promise(resolve => setTimeout(() => resolve(null), resource.shutdownTimeoutMs))
  ]);
  if (!serverExit || serverExit.exitCode !== 0 || serverExit.signal) {
    resource.preserveOnCleanup = !serverExit ? 'mysqld-did-not-exit-after-socket-shutdown' :
      `mysqld-exited-abnormally-after-socket-shutdown:${serverExit.exitCode ?? serverExit.signal}`;
    record({ event: 'mysql_shutdown_failed', resourceId: resource.id, pid: resource.pid,
      processStartTime: resource.identity?.startTime, processFingerprint: resource.identity?.fingerprint,
      reason: resource.preserveOnCleanup, shutdownPid: target.pid, shutdownExitCode: target.exitCode,
      mysqldExitCode: serverExit?.exitCode ?? null, mysqldSignal: serverExit?.signal ?? null,
      timeoutMs: resource.shutdownTimeoutMs, command: resource.command, logPath: resource.logPath,
      port: resource.port, datadir: resource.datadir, socket: resource.socket });
    return;
  }
  resource.gracefulShutdownOk = true;
  record({ event: 'mysql_graceful_exit_confirmed', resourceId: resource.id, pid: resource.pid,
    processStartTime: resource.identity?.startTime, processFingerprint: resource.identity?.fingerprint,
    exitCode: serverExit.exitCode, signal: serverExit.signal, shutdownPid: target.pid,
    shutdownExitCode: target.exitCode, socket: resource.socket, datadir: resource.datadir });
}

async function terminateResource(resource, reason) {
  if (resource.stopPromise) return await resource.stopPromise;
  resource.stopPromise = (async () => {
    if (resource.status === 'stopped' || resource.status === 'exited' || resource.status === 'failed' || resource.status === 'signaled' || resource.status === 'spawn_failed') {
      trackDescendants(resource);
      if (processGroupMembers(resource.pgid).length || currentKnownPids(resource).length) await terminateGroup(resource, reason);
      markPidsExited(resource);
      return resourceSnapshot(resource);
    }
    resource.stopReason = reason;
    record({ event: 'process_stop_requested', resourceId: resource.id, pid: resource.pid, pgid: resource.pgid,
      processStartTime: resource.identity?.startTime, reason, command: resource.command, logPath: resource.logPath,
      port: resource.port, datadir: resource.datadir });
    if (resource.role === 'mysql') await runShutdownCommand(resource);
    await terminateGroup(resource, reason);
    if (resource.status !== 'blocked') resource.status = 'stopped';
    resource.stopReason = reason;
    return resourceSnapshot(resource);
  })();
  return await resource.stopPromise;
}

async function terminateGroup(resource, reason) {
  trackDescendants(resource);
  const members = processGroupMembers(resource.pgid);
  const knownAlive = currentKnownPids(resource);
  if (!members.length && !knownAlive.length) { markPidsExited(resource); return true; }
  const ownership = knownAlive.length > 0 || processMatches(resource.pid, resource.identity);
  if (!ownership) {
    resource.status = 'blocked';
    record({ event: 'process_identity_mismatch', resourceId: resource.id, pid: resource.pid, pgid: resource.pgid,
      expectedStartTime: resource.identity?.startTime, currentPidIdentity: processIdentity(resource.pid),
      reason: 'refusing to signal an unverified PID/process group', tempDir: root });
    return false;
  }
  try { process.kill(-resource.pgid, 'SIGTERM'); }
  catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
  for (const item of currentKnownPids(resource)) {
    if (processGroupMembers(resource.pgid).some(row => row.pid === item.pid)) continue;
    if (!processMatches(item.pid, { startTime: item.startTime, fingerprint: item.fingerprint })) continue;
    try { process.kill(item.pid, 'SIGTERM'); } catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
  }
  let gone = await waitForResourceGone(resource, 1500);
  if (!gone) {
    trackDescendants(resource);
    const current = processGroupMembers(resource.pgid);
    const alive = currentKnownPids(resource);
    const verified = current.some(row => alive.some(item => item.pid === row.pid)) ||
      alive.length > 0 || processMatches(resource.pid, resource.identity);
    if (!verified) {
      resource.status = 'blocked';
      record({ event: 'process_identity_mismatch', resourceId: resource.id, pid: resource.pid, pgid: resource.pgid,
        reason: 'identity changed during forced shutdown; no further signal sent', tempDir: root });
      return false;
    }
    try { process.kill(-resource.pgid, 'SIGKILL'); }
    catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
    for (const item of currentKnownPids(resource)) {
      if (processGroupMembers(resource.pgid).some(row => row.pid === item.pid)) continue;
      if (!processMatches(item.pid, { startTime: item.startTime, fingerprint: item.fingerprint })) continue;
      try { process.kill(item.pid, 'SIGKILL'); } catch (error) { if (!['ESRCH', 'EPERM'].includes(error.code)) throw error; }
    }
    gone = await waitForResourceGone(resource, 3000);
  }
  if (!gone) {
    resource.status = 'blocked';
    record({ event: 'process_exit_unconfirmed', resourceId: resource.id, pid: resource.pid, pgid: resource.pgid,
      reason, pids: currentKnownPids(resource), tempDir: root });
    return false;
  }
  if (resource.exitPromise && ['running', 'starting'].includes(resource.status)) {
    await Promise.race([resource.exitPromise, new Promise(resolve => setTimeout(resolve, 1500))]);
  }
  markPidsExited(resource);
  return true;
}

async function stopAll(reason) {
  const active = [...resources.values()].filter(resource => ['starting', 'running'].includes(resource.status));
  active.sort((a, b) => roleOrder(a) - roleOrder(b) || a.startAt - b.startAt);
  for (const resource of active) {
    try { await terminateResource(resource, reason); }
    catch (error) {
      resource.status = 'blocked';
      record({ event: 'resource_stop_error', resourceId: resource.id, pid: resource.pid,
        error: error.message, tempDir: root, logPath: resource.logPath });
    }
  }
  for (const resource of resources.values()) {
    trackDescendants(resource);
    if (processGroupMembers(resource.pgid).length || currentKnownPids(resource).length) {
      await terminateResource(resource, reason);
    }
  }
}

function parseLsofPid(line) {
  const fields = line.trim().split(/\s+/);
  if (fields.length < 2 || fields[0] === 'COMMAND') return null;
  const pid = Number(fields[1]);
  return Number.isInteger(pid) ? pid : null;
}

async function lsofScan(args, matchPrefix, { timeoutMs = 12_000, maxInputBytes = 64 * 1024 * 1024 } = {}) {
  const startedAt = Date.now();
  return await new Promise(resolve => {
    const child = spawn('lsof', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let bytes = 0;
    let pending = '';
    const matches = [];
    let incompleteReason = null;
    const timer = setTimeout(() => {
      incompleteReason = 'lsof scan timeout';
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }, timeoutMs);
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxInputBytes) {
        incompleteReason = 'lsof scan output exceeded 64 MiB';
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        return;
      }
      pending += chunk.toString('utf8');
      if (pending.length > 64 * 1024 && !pending.includes('\n')) {
        incompleteReason = 'lsof output line exceeded 64 KiB';
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
        return;
      }
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.includes(matchPrefix) && matches.length < 100) matches.push(line.slice(0, 2048));
      }
    });
    child.once('error', error => { incompleteReason = `lsof unavailable: ${error.message}`; });
    child.once('close', code => {
      clearTimeout(timer);
      if (pending.includes(matchPrefix) && matches.length < 100) matches.push(pending.slice(0, 2048));
      resolve({ complete: !incompleteReason, incompleteReason, code, bytesScanned: bytes, matches,
        elapsedMs: Date.now() - startedAt });
    });
  });
}

async function verifyNoOpenHandles() {
  const startedAt = Date.now();
  const [rootScan, deletedScan] = await Promise.all([
    lsofScan(['-nP', '+D', root], root, { timeoutMs: 15_000 }),
    lsofScan(['-nP', '+L1'], root, { timeoutMs: 15_000 })
  ]);
  const elapsedMs = Date.now() - startedAt;
  const external = rootScan.matches.filter(line => {
    const pid = parseLsofPid(line);
    return pid !== process.pid && pid !== owner.pid;
  });
  const timings = { elapsedMs, rootScanMs: rootScan.elapsedMs, deletedScanMs: deletedScan.elapsedMs };
  if (!rootScan.complete) return { ok: false, reason: rootScan.incompleteReason, holders: external, rootScan, deletedScan, timings };
  if (external.length) return { ok: false, reason: 'open file handles remain under temp directory', holders: external, rootScan, deletedScan, timings };
  if (!deletedScan.complete) return { ok: false, reason: deletedScan.incompleteReason, holders: deletedScan.matches, rootScan, deletedScan, timings };
  if (deletedScan.matches.length) return { ok: false, reason: 'deleted-but-open files still reference temp directory', holders: deletedScan.matches, rootScan, deletedScan, timings };
  return { ok: true, rootScan, deletedScan, timings };
}

let serverClosePromise;
async function closeRpcServer() {
  if (!server) return { ok: true, elapsedMs: 0, socketsBefore: 0, socketsAfter: 0, callbackCompleted: true };
  if (serverClosePromise) return await serverClosePromise;
  const startedAt = Date.now();
  const socketsBefore = sockets.size;
  serverClosePromise = (async () => {
    let timer;
    const closeCallback = new Promise(resolve => {
      if (!server.listening) { resolve({ callbackCompleted: true }); return; }
      try {
        server.close(error => resolve({ callbackCompleted: true, error: error ? String(error.message || error) : null }));
      } catch (error) { resolve({ callbackCompleted: false, error: String(error.message || error) }); }
    });
    for (const socket of [...sockets]) socket.destroy();
    const result = await Promise.race([
      closeCallback,
      new Promise(resolve => { timer = setTimeout(() => resolve({ callbackCompleted: false, timedOut: true }), 2000); })
    ]);
    if (timer) clearTimeout(timer);
    return { ok: result.callbackCompleted && !result.error, ...result, elapsedMs: Date.now() - startedAt,
      socketsBefore, socketsAfter: sockets.size };
  })();
  return await serverClosePromise;
}

function resourceCleanupEvent(resource) {
  const tracked = [...resource.pids.values()];
  const diagnosticTail = resource.role === 'mysql' || resource.status !== 'exited' || resource.exitCode !== 0 || resource.exitSignal
    ? tailSummary(resource) : '';
  return {
    event: 'resource_cleanup_summary', resourceId: resource.id, label: resource.label,
    kind: resource.kind, role: resource.role, status: resource.status, pid: resource.pid,
    processGroup: resource.pgid, processStartTime: resource.identity?.startTime || null,
    processFingerprint: resource.identity?.fingerprint || null,
    processExecutableAtStart: resource.identity?.executable || null,
    port: resource.port, datadir: resource.datadir, socket: resource.socket, logPath: resource.logPath,
    logBytes: resource.logBytes, logPeakBytes: resource.logPeakBytes, maxLogBytes: limits.logBytes,
    exitCode: resource.exitCode, signal: resource.exitSignal, stopReason: resource.stopReason || null,
    shutdownOutcome: resource.gracefulShutdownOk ? 'socket-shutdown-and-process-exit-confirmed' : resource.preserveOnCleanup || null,
    trackedPidCount: tracked.length, allTrackedPidsExited: tracked.every(item => item.exitConfirmed === true),
    directoryPeakBytes: peakDirectoryBytes, maxDirectoryBytes: limits.directoryBytes,
    ...(diagnosticTail ? { logTail: diagnosticTail.slice(-4096) } : {})
  };
}

function blockCleanup(reason, details = {}) {
  sessionStatus = 'blocked';
  finalSummary = { ok: false, blocked: true, reason, tempDir: root, ...details };
  record({ event: 'instance_cleanup_blocked', reason: String(reason).slice(0, 1024), tempDir: root,
    ...details, peakDirectoryBytes, maxDirectoryBytes: limits.directoryBytes }, { terminal: true });
  return finalSummary;
}

async function finishSession(reason) {
  await stopAll(reason);
  const active = [...resources.values()].filter(resource => ['starting', 'running', 'blocked'].includes(resource.status));
  const activePids = active.flatMap(resource => currentKnownPids(resource).map(item => ({ resourceId: resource.id, ...item })));
  const remainingGroups = active.filter(resource => processGroupMembers(resource.pgid).length);
  if (activePids.length || remainingGroups.length) {
    blockCleanup('one or more exact PIDs/process groups remain', {
      activePidCount: activePids.length, activePids: activePids.slice(0, 16),
      remainingResourceIds: remainingGroups.slice(0, 32).map(item => item.id),
      remainingResourceCount: remainingGroups.length
    });
  } else {
    for (const resource of resources.values()) {
      trackDescendants(resource);
      markPidsExited(resource);
      closeLog(resource);
    }
    const unconfirmed = [...resources.values()].flatMap(resource => [...resource.pids.values()]
      .filter(item => item.exitConfirmed !== true)
      .map(item => ({ resourceId: resource.id, pid: item.pid, startTime: item.startTime, pgid: item.pgid })));
    if (unconfirmed.length) {
      blockCleanup('exact PID exit evidence is incomplete', {
        unconfirmedPidCount: unconfirmed.length, unconfirmedPids: unconfirmed.slice(0, 16)
      });
    } else if (registryFailure) {
      blockCleanup(`required registry write failed: ${registryFailure.message}`, { registryFailure });
    } else {
      sessionStatus = 'verifying';
      const handleResult = await verifyNoOpenHandles();
      if (!handleResult.ok) {
        blockCleanup(handleResult.reason, {
          holders: handleResult.holders.slice(0, 8).map(line => line.slice(0, 512)),
          holderCount: handleResult.holders.length,
          rootScanBytes: handleResult.rootScan?.bytesScanned, deletedScanBytes: handleResult.deletedScan?.bytesScanned,
          handleCheckTimings: handleResult.timings
        });
      } else {
        const controlPlane = await closeRpcServer();
        if (!controlPlane.ok) {
          blockCleanup('guardian RPC server did not close after destroying its client sockets', { controlPlane });
        } else {
          record({ event: 'guardian_control_plane_closed', ...controlPlane,
            handleCheckTimings: handleResult.timings });
          if (registryFailure) {
            blockCleanup(`required control-plane cleanup evidence cannot be registered: ${registryFailure.message}`, { registryFailure });
          } else {
            const sizeBeforeDelete = allocatedSize(root);
            const preservation = [...resources.values()].find(resource => resource.preserveOnCleanup);
            const summaryRows = [...resources.values()].map(resourceCleanupEvent);
            const openHandleCheck = preservation
              ? 'lsof +D and lsof +L1 completed with no matching handles; diagnostic data preserved'
              : 'lsof +D and lsof +L1 completed with no matching handles';
            const finalEvent = preservation
              ? { event: 'instance_cleanup_preserved', reason: preservation.preserveOnCleanup, tempDir: root,
                  directoryBytesBeforeDelete: sizeBeforeDelete, peakDirectoryBytes, maxDirectoryBytes: limits.directoryBytes,
                  maxLogBytes: limits.logBytes, resourceCount: summaryRows.length, resourceSummaryCount: summaryRows.length,
                  openHandleCheck, handleCheckTimings: handleResult.timings, controlPlane }
              : { event: 'instance_cleaned', reason, tempDir: root, directoryBytesBeforeDelete: sizeBeforeDelete,
                  peakDirectoryBytes, maxDirectoryBytes: limits.directoryBytes, maxLogBytes: limits.logBytes,
                  resourceCount: summaryRows.length, resourceSummaryCount: summaryRows.length,
                  openHandleCheck, handleCheckTimings: handleResult.timings, controlPlane };
            const batch = [...summaryRows, finalEvent].map(event => registryPayload(event));
            try { assertResourceRegistryCapacity(registryPath, batch, registryCleanupReserveBytes); }
            catch (error) { noteRegistryFailure('cleanup-evidence-preflight', error); }
            if (registryFailure) {
              blockCleanup(`required cleanup evidence cannot be registered: ${registryFailure.message}`, { registryFailure });
            } else {
              let summariesWritten = true;
              for (const summary of summaryRows) {
                if (!record(summary, { terminal: true })) { summariesWritten = false; break; }
              }
              if (!summariesWritten || registryFailure) {
                blockCleanup(`required per-resource cleanup evidence was not written: ${registryFailure?.message || 'unknown registry error'}`, {
                  registryFailure, resourceCount: summaryRows.length
                });
              } else if (preservation) {
                finalSummary = { ok: false, preserved: true, reason: preservation.preserveOnCleanup,
                  tempDir: root, directoryBytesBeforeDelete: sizeBeforeDelete, peakDirectoryBytes,
                  maxDirectoryBytes: limits.directoryBytes, resourceCount: summaryRows.length,
                  openHandleCheck, resourceSummaries: summaryRows, handleCheckTimings: handleResult.timings, controlPlane };
                if (record(finalEvent, { terminal: true })) sessionStatus = 'preserved';
                else blockCleanup(`preservation evidence could not be registered: ${registryFailure?.message || 'unknown registry error'}`, { registryFailure });
              } else {
                try {
                  fs.rmSync(root, { recursive: true, force: false });
                  finalSummary = { ok: true, reason, tempDir: root, directoryBytesBeforeDelete: sizeBeforeDelete,
                    peakDirectoryBytes, maxDirectoryBytes: limits.directoryBytes, resourceCount: summaryRows.length,
                    openHandleCheck, resourceSummaries: summaryRows, handleCheckTimings: handleResult.timings, controlPlane };
                  if (record(finalEvent, { terminal: true })) sessionStatus = 'cleaned';
                  else {
                    sessionStatus = 'blocked';
                    finalSummary = { ok: false, blocked: true, directoryRemoved: true,
                      reason: `cleanup event write failed after directory removal: ${registryFailure?.message || 'unknown registry error'}`,
                      tempDir: root, resourceCount: summaryRows.length };
                  }
                } catch (error) {
                  blockCleanup(`temp directory removal failed: ${String(error.message).slice(0, 512)}`, {
                    directoryBytesBeforeDelete: sizeBeforeDelete
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch (error) {
    record({ event: 'guardian_socket_unlink_failed', error: error.message, socket: socketPath }, { terminal: true });
  }
  try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch { /* runner can remove after PID exit */ }
  return finalSummary;
}

async function cleanupSession(reason = 'requested') {
  if (cleanupPromise) return await cleanupPromise;
  cleanupReason = reason;
  sessionStatus = 'cleaning';
  if (monitorTimer) clearInterval(monitorTimer);
  cleanupPromise = finishSession(reason);
  try { return await cleanupPromise; }
  catch (error) {
    sessionStatus = 'blocked';
    finalSummary = { ok: false, blocked: true, reason: error.message, tempDir: root };
    record({ event: 'instance_cleanup_blocked', reason: error.message, tempDir: root }, { terminal: true });
    await closeRpcServer();
    try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch { /* keep temp directory evidence */ }
    try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch { /* keep temp directory evidence */ }
    return finalSummary;
  }
}

async function handleRequest(message) {
  if (message.op === 'status') {
    const list = [...resources.values()];
    return { ok: true, status: sessionStatus, peakDirectoryBytes, currentDirectoryBytes: allocatedSize(root),
      resources: (message.id ? list.filter(item => item.id === message.id) : list).map(resourceSnapshot), finalSummary };
  }
  if (message.op === 'mkdir') {
    const dir = safeRelativePath(message.path);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return { ok: true, path: dir };
  }
  if (message.op === 'start') {
    const normalized = message.spec;
    const resource = await startResource(normalized);
    if (resource.status === 'spawn_failed') return { ok: false, error: resources.get(resource.id).spawnError || 'resource failed to start', resource };
    return { ok: true, resource };
  }
  if (message.op === 'renew') {
    const resource = resources.get(message.id);
    if (!resource || !['starting', 'running'].includes(resource.status)) return { ok: false, error: 'resource is not active' };
    const leaseMs = Number(message.leaseMs);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 15 * 60 * 1000) return { ok: false, error: 'renewal exceeds the 15-minute maximum lease' };
    resource.leaseExpiresAt = Date.now() + leaseMs;
    record({ event: 'lease_renewed', resourceId: resource.id, pid: resource.pid, leaseMs,
      leaseExpiresAt: new Date(resource.leaseExpiresAt).toISOString(), maxLeaseMs: limits.leaseMs });
    return { ok: true, resource: resourceSnapshot(resource) };
  }
  if (message.op === 'log-tail') {
    const resource = resources.get(message.id);
    if (!resource) return { ok: false, error: 'resource not found' };
    const maxBytes = Math.min(32 * 1024, Math.max(0, Number(message.maxBytes || 0)));
    return { ok: true, tail: readResourceLogTail(resource.logPath, maxBytes), logBytes: resource.logBytes, maxLogBytes: limits.logBytes };
  }
  if (message.op === 'stop') {
    const resource = resources.get(message.id);
    if (!resource) return { ok: false, error: 'resource not found' };
    return { ok: true, resource: await terminateResource(resource, String(message.reason || 'requested')) };
  }
  if (message.op === 'cleanup') {
    const reason = String(message.reason || 'requested');
    return { cleanup: true, reason };
  }
  return { ok: false, error: `unknown resource operation: ${String(message.op)}` };
}

async function monitor() {
  if (monitorBusy || cleanupPromise) return;
  monitorBusy = true;
  try {
    if (!processMatches(owner.pid, owner)) {
      record({ event: 'owner_exit_detected', ownerPid: owner.pid, ownerStartTime: owner.startTime,
        ownerFingerprint: owner.fingerprint, tempDir: root });
      await cleanupSession('owner-exit');
      return;
    }
    const currentSize = allocatedSize(root);
    peakDirectoryBytes = Math.max(peakDirectoryBytes, currentSize);
    if (currentSize > limits.directoryBytes) {
      record({ event: 'directory_limit_exceeded', currentDirectoryBytes: currentSize,
        peakDirectoryBytes, maxDirectoryBytes: limits.directoryBytes, tempDir: root });
      await cleanupSession('directory-limit');
      return;
    }
    for (const resource of resources.values()) {
      if (!['starting', 'running'].includes(resource.status)) continue;
      trackDescendants(resource);
      if (resource.limitReason) {
        await cleanupSession(resource.limitReason);
        return;
      }
      if (Date.now() >= resource.leaseExpiresAt) {
        record({ event: 'lease_expired', resourceId: resource.id, pid: resource.pid,
          processStartTime: resource.identity?.startTime, leaseExpiresAt: new Date(resource.leaseExpiresAt).toISOString(),
          maxLeaseMs: limits.leaseMs, tempDir: root });
        await cleanupSession('lease-expired');
        return;
      }
    }
  } catch (error) {
    record({ event: 'guardian_monitor_error', error: error.message, tempDir: root });
    await cleanupSession(`guardian-error:${error.message}`);
  } finally { monitorBusy = false; }
}

function respond(socket, payload) {
  try { socket.end(`${JSON.stringify(payload)}\n`); }
  catch { try { socket.destroy(); } catch { /* closed */ } }
}

async function main() {
  if (!processMatches(owner.pid, owner)) {
    record({ event: 'owner_missing_before_start', ownerPid: owner.pid, ownerStartTime: owner.startTime,
      guardianStartTime: guardianIdentity?.startTime });
    try { if (fs.existsSync(configPath)) fs.unlinkSync(configPath); } catch { /* no managed resources exist */ }
    process.exit(0);
  }
  fs.mkdirSync(root, { recursive: false, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'work'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(root, 0o700); } catch { /* platform default */ }
  server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', async chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1024 * 1024) { respond(socket, { ok: false, error: 'resource request exceeds 1 MiB' }); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      let message;
      try { message = JSON.parse(line); }
      catch { respond(socket, { ok: false, error: 'invalid resource request JSON' }); return; }
      try {
        const result = await handleRequest(message);
        if (result.cleanup) {
          respond(socket, { ok: true, cleanupStarted: true, reason: result.reason });
          socket.once('close', () => { void cleanupSession(result.reason); });
          setTimeout(() => { if (!cleanupPromise) void cleanupSession(result.reason); }, 1000).unref();
        } else respond(socket, result);
      } catch (error) { respond(socket, { ok: false, error: error.message }); }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try { fs.chmodSync(socketPath, 0o600); } catch { /* platform default */ }
  sessionStatus = 'ready';
  record({ event: 'guardian_ready', guardianPid: process.pid, guardianStartTime: guardianIdentity?.startTime,
    guardianFingerprint: guardianIdentity?.fingerprint, ownerPid: owner.pid, ownerStartTime: owner.startTime,
    ownerFingerprint: owner.fingerprint, tempDir: root, socket: socketPath, limits,
    allocatedDirectoryBytes: allocatedSize(root) });
  monitorTimer = setInterval(() => { void monitor(); }, Math.max(100, Number(config.pollMs || 250)));
  monitorTimer.unref();
}

process.once('SIGTERM', () => { void cleanupSession('guardian-sigterm'); });
process.once('SIGINT', () => { void cleanupSession('guardian-sigint'); });
process.on('uncaughtException', error => {
  record({ event: 'guardian_uncaught_exception', error: error.message, tempDir: root });
  void cleanupSession(`guardian-error:${error.message}`);
});
process.on('unhandledRejection', error => {
  record({ event: 'guardian_unhandled_rejection', error: String(error?.message || error), tempDir: root });
  void cleanupSession(`guardian-error:${String(error?.message || error)}`);
});

void main().catch(error => {
  record({ event: 'guardian_start_failed', error: error.message, guardianPid: process.pid,
    guardianStartTime: guardianIdentity?.startTime, tempDir: root, socket: socketPath });
  void cleanupSession(`guardian-start-failed:${error.message}`).finally(() => process.exit(1));
});

export { processIdentity, processGroupMembers, processMatches };
