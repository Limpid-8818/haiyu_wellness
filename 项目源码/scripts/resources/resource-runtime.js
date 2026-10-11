import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RESOURCE_LIMITS = Object.freeze({
  logBytes: 8 * 1024 * 1024,
  directoryBytes: 512 * 1024 * 1024,
  leaseMs: 15 * 60 * 1000
});
export const RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES = 512 * 1024;

const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARDIAN_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'resource-guardian.js');
const MAX_REGISTRY_BYTES = 32 * 1024 * 1024;
const MAX_RPC_BYTES = 1024 * 1024;
const MAX_LOG_TAIL_BYTES = 32 * 1024;
const AUTO_SEGMENT_REMAINING_BYTES = 4 * 1024 * 1024;
const SEGMENT_MANIFEST_NAME = 'registry-segments.jsonl';

function safeTaskId(value) {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(result)) throw new Error('taskId must be a short, path-safe identifier');
  return result;
}

function checkLimit(value, max, label) {
  const amount = value === undefined ? max : Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > max) {
    throw new Error(`${label} must be between 1 and ${max}; limits can only be lowered`);
  }
  return amount;
}

function runPs(args) {
  const result = spawnSync('ps', args, { encoding: 'utf8', timeout: 2000, maxBuffer: 256 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) return '';
  return result.stdout || '';
}

export function processIdentity(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return null;
  let alive = true;
  try { process.kill(Number(pid), 0); }
  catch (error) { if (error.code === 'ESRCH') alive = false; else if (error.code !== 'EPERM') throw error; }
  if (!alive) return null;
  const row = runPs(['-p', String(pid), '-o', 'lstart=,stat=,pgid=,uid=,comm=']).trim();
  if (row.length < 25) return null;
  const startTime = row.slice(0, 24).trim();
  const fields = row.slice(24).trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(.+)$/);
  if (!fields) return null;
  const state = fields[1];
  const pgid = Number(fields[2]);
  const uid = Number(fields[3]);
  const command = fields[4].trim();
  if (!startTime || !command || !Number.isInteger(pgid) || !Number.isInteger(uid)) return null;
  // PID, start time, process group, and uid survive exec; comm does not.
  const fingerprint = crypto.createHash('sha256').update(`${Number(pid)}\0${startTime}\0${pgid}\0${uid}`).digest('hex');
  return { pid: Number(pid), startTime, executable: command, state, pgid, uid, fingerprint };
}

export function processMatches(pid, expected) {
  const current = processIdentity(pid);
  if (!current || !expected || current.pid !== Number(pid) || current.startTime !== expected.startTime) return false;
  if (expected.pgid !== undefined && current.pgid !== expected.pgid) return false;
  if (expected.uid !== undefined && current.uid !== expected.uid) return false;
  if (current.state?.startsWith('Z')) return true;
  return current.fingerprint === expected.fingerprint;
}

export function processGroupMembers(pgid) {
  const output = runPs(['-Ao', 'pid=,ppid=,pgid=']);
  const members = [];
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (match && Number(match[3]) === Number(pgid)) members.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
  }
  return members;
}

function redactArgs(command, args) {
  const safe = [];
  let redactNext = false;
  for (const item of [command, ...args]) {
    const value = String(item);
    if (redactNext) { safe.push('[redacted]'); redactNext = false; continue; }
    if (/^--?(?:password|passwd|token|secret|authorization|(?:[a-z_-]*api[-_]?key))$/i.test(value)) {
      safe.push(`${value}=[redacted]`);
      redactNext = true;
      continue;
    }
    if (/^--?(?:password|passwd|token|secret|authorization|(?:[a-z_-]*api[-_]?key))=/i.test(value)) {
      safe.push(value.replace(/=.*/, '=[redacted]'));
      continue;
    }
    if (/^-p.+/.test(value)) { safe.push('-p[redacted]'); continue; }
    safe.push(value.length > 768 ? `${value.slice(0, 768)}…[truncated]` : value);
  }
  if (redactNext) safe.push('[redacted]');
  return safe.join(' ').slice(0, 4096);
}

function appendRegistry(filePath, event, { reserveBytes = 0 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch { /* preserve the platform default */ }
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
  if (Buffer.byteLength(line) > 16 * 1024) throw new Error('resource registry event exceeds 16 KiB');
  let fd;
  try {
    const current = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
    if (current + Buffer.byteLength(line) + reserveBytes > MAX_REGISTRY_BYTES) {
      throw new Error(`resource registry cannot append while preserving ${reserveBytes} cleanup bytes under its 32 MiB hard limit`);
    }
    fd = fs.openSync(filePath, 'a', 0o600);
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function assertRegistryCapacity(filePath, events, reserveBytes = 0) {
  const rows = Array.isArray(events) ? events : [events];
  let requiredBytes = 0;
  for (const event of rows) {
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > 16 * 1024) throw new Error('resource registry event exceeds 16 KiB');
    requiredBytes += bytes;
  }
  const current = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (current + requiredBytes + reserveBytes > MAX_REGISTRY_BYTES) {
    throw new Error(`resource registry has insufficient capacity for ${requiredBytes} event bytes plus ${reserveBytes} reserved cleanup bytes`);
  }
  return requiredBytes;
}

function isWithinPath(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function sha256File(filePath) {
  const before = fs.existsSync(filePath) ? fs.statSync(filePath, { bigint: true }) : null;
  const hash = crypto.createHash('sha256');
  if (before) {
    for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
    const after = fs.statSync(filePath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error(`legacy registry changed while capturing its segment snapshot: ${filePath}`);
    }
  }
  return { bytes: before ? Number(before.size) : 0, sha256: hash.digest('hex') };
}

async function recordSegmentSelection({ baseAuditRoot, auditRoot, registryPath, taskId, instanceId }) {
  if (!isWithinPath(path.join(baseAuditRoot, 'segments'), auditRoot)) return null;
  const legacyRegistryPath = path.join(baseAuditRoot, 'registry.jsonl');
  const legacySnapshot = await sha256File(legacyRegistryPath);
  const manifestPath = path.join(baseAuditRoot, SEGMENT_MANIFEST_NAME);
  const event = {
    event: 'resource_registry_segment_selected', taskId, instanceId,
    registryPath, segmentRoot: auditRoot, hardLimitBytes: MAX_REGISTRY_BYTES,
    cleanupReserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES,
    legacyRegistryPath, legacyRegistryBytes: legacySnapshot.bytes, legacyRegistrySha256: legacySnapshot.sha256
  };
  appendRegistry(manifestPath, event, { reserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES });
  return { manifestPath, legacySnapshot };
}

async function findCleanupRecord(filePath, instanceId) {
  if (!fs.existsSync(filePath)) return null;
  const input = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let latest = null;
  for await (const line of input) {
    if (!line.includes(instanceId)) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.instanceId !== instanceId || !['instance_cleaned', 'instance_cleanup_preserved', 'instance_cleanup_blocked'].includes(event.event)) continue;
    latest = event;
  }
  return latest;
}

function readTail(filePath, maxBytes = MAX_LOG_TAIL_BYTES) {
  if (!fs.existsSync(filePath)) return '';
  const size = fs.statSync(filePath).size;
  const count = Math.min(size, Math.max(0, Math.min(maxBytes, MAX_LOG_TAIL_BYTES)));
  if (!count) return '';
  const buffer = Buffer.alloc(count);
  const fd = fs.openSync(filePath, 'r');
  try { fs.readSync(fd, buffer, 0, count, size - count); }
  finally { fs.closeSync(fd); }
  const content = buffer.toString('utf8');
  return size > count ? `[tail ${count} bytes of ${size}]\n${content}` : content;
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function waitFor(predicate, timeoutMs, intervalMs = 100) {
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    const result = await predicate();
    if (result) return result;
    await sleep(intervalMs);
  }
  return await predicate();
}

export async function waitForExactProcessExit(identity, { timeoutMs = 20_000, pollMs = 100 } = {}) {
  if (!identity || !Number.isInteger(Number(identity.pid)) || !identity.startTime || !identity.fingerprint) {
    throw new Error('exact process-exit observation requires pid, start time, and fingerprint');
  }
  const deadline = Date.now() + Math.max(1, Number(timeoutMs));
  const identityExit = await waitFor(() => {
    const current = processIdentity(identity.pid);
    if (current && processMatches(identity.pid, identity)) return false;
    return { observedAt: new Date().toISOString(), currentPidIdentity: current };
  }, Math.max(1, deadline - Date.now()), pollMs);
  if (!identityExit) return null;
  const pgid = Number(identity.pgid) || Number(identity.pid);
  const groupExit = await waitFor(() => {
    const members = processGroupMembers(pgid);
    return members.length === 0 ? { observedAt: new Date().toISOString(), members } : false;
  }, Math.max(1, deadline - Date.now()), pollMs);
  if (!groupExit) return null;
  return {
    pid: Number(identity.pid), startTime: identity.startTime, fingerprint: identity.fingerprint, pgid,
    exactIdentityAbsentAt: identityExit.observedAt, currentPidIdentity: identityExit.currentPidIdentity,
    processGroupEmptyAt: groupExit.observedAt, processGroupMembers: groupExit.members
  };
}

function normalizeSpec(spec, defaultLeaseMs) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('resource spec must be an object');
  if (typeof spec.command !== 'string' || !spec.command.trim()) throw new Error('resource command is required');
  const args = spec.args ?? [];
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('resource args must be strings');
  const env = spec.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.values(env).some(value => value !== undefined && typeof value !== 'string')) {
    throw new Error('resource env must map names to string values');
  }
  const leaseMs = checkLimit(spec.leaseMs ?? defaultLeaseMs, RESOURCE_LIMITS.leaseMs, 'leaseMs');
  const shutdown = spec.shutdownCommand ?? null;
  if (shutdown && (!shutdown || typeof shutdown.command !== 'string' || !Array.isArray(shutdown.args ?? []))) {
    throw new Error('shutdownCommand needs a command and an optional string args array');
  }
  const kind = String(spec.kind || 'test');
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(kind)) throw new Error('resource kind must be a short lowercase label');
  const label = String(spec.label || kind).slice(0, 80);
  return {
    label, kind, role: String(spec.role || kind), command: spec.command, args, cwd: path.resolve(spec.cwd || process.cwd()),
    env, port: spec.port === undefined ? null : Number(spec.port), datadir: spec.datadir ? path.resolve(spec.datadir) : null,
    socket: spec.socket ? path.resolve(spec.socket) : null, shutdownCommand: shutdown,
    shutdownTimeoutMs: Math.min(30_000, Math.max(100, Number(spec.shutdownTimeoutMs || 10_000))),
    leaseMs
  };
}

export class ResourceSession {
  static async create({
    taskId, projectRoot = DEFAULT_PROJECT_ROOT,
    tempParent = process.platform === 'win32' ? os.tmpdir() : '/tmp', auditRoot,
    limits = {}, guardianStartupMs = 10_000
  } = {}) {
    const session = new ResourceSession({ taskId, projectRoot, tempParent, auditRoot, limits, guardianStartupMs });
    return await session.start();
  }

  constructor({ taskId, projectRoot, tempParent, auditRoot, limits, guardianStartupMs }) {
    this.taskId = safeTaskId(taskId);
    this.projectRoot = path.resolve(projectRoot);
    this.tempParent = path.resolve(tempParent);
    this.instanceId = crypto.randomUUID();
    this.tempDir = path.join(this.tempParent, `haiyu-resource-${this.taskId.slice(0, 8)}-${this.instanceId}`);
    this.socketPath = path.join(this.tempParent, `haiyu-rg-${this.instanceId}.sock`);
    this.baseAuditRoot = path.resolve(path.join(this.projectRoot, 'output', 'resource-audit'));
    const requestedAuditRoot = path.resolve(auditRoot || this.baseAuditRoot);
    const requestedIsDefault = requestedAuditRoot === this.baseAuditRoot;
    const legacyRegistryPath = path.join(this.baseAuditRoot, 'registry.jsonl');
    const legacySize = fs.existsSync(legacyRegistryPath) ? fs.statSync(legacyRegistryPath).size : 0;
    const shouldSegment = requestedIsDefault && MAX_REGISTRY_BYTES - legacySize < AUTO_SEGMENT_REMAINING_BYTES;
    this.auditRoot = shouldSegment
      ? path.join(this.baseAuditRoot, 'segments', this.taskId, this.instanceId)
      : requestedAuditRoot;
    this.usesRegistrySegment = isWithinPath(path.join(this.baseAuditRoot, 'segments'), this.auditRoot);
    this.registryPath = path.join(this.auditRoot, 'registry.jsonl');
    this.configDir = path.join(this.auditRoot, 'state');
    this.configPath = path.join(this.configDir, `${this.instanceId}.json`);
    this.limits = {
      logBytes: checkLimit(limits.logBytes, RESOURCE_LIMITS.logBytes, 'logBytes'),
      directoryBytes: checkLimit(limits.directoryBytes, RESOURCE_LIMITS.directoryBytes, 'directoryBytes'),
      leaseMs: checkLimit(limits.leaseMs, RESOURCE_LIMITS.leaseMs, 'leaseMs')
    };
    this.guardianStartupMs = Math.min(30_000, Math.max(1000, Number(guardianStartupMs)));
    this.ownerIdentity = processIdentity(process.pid);
    if (!this.ownerIdentity) throw new Error('cannot identify the resource session owner process');
    this.guardian = null;
    this.guardianIdentity = null;
    this.guardianExitObservation = null;
    this.closed = false;
    this.cleanupComplete = false;
    this.closePromise = null;
    this.signalHandlers = [];
    this.lifecycleHandlers = [];
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    const runnerEvent = {
      taskId: this.taskId, instanceId: this.instanceId, event: 'runner_started', ownerPid: process.pid,
      ownerStartTime: this.ownerIdentity.startTime, ownerFingerprint: this.ownerIdentity.fingerprint,
      command: redactArgs(process.execPath, process.argv.slice(1)), cwd: process.cwd(), tempDir: this.tempDir,
      socket: this.socketPath, limits: this.limits, port: null, logPath: null, datadir: null,
      auditRoot: this.auditRoot, registryPath: this.registryPath
    };
    const startupReservation = [
      runnerEvent,
      { taskId: this.taskId, instanceId: this.instanceId, event: 'guardian_started', guardianPid: 999999, tempDir: this.tempDir },
      { taskId: this.taskId, instanceId: this.instanceId, event: 'guardian_ready', guardianPid: 999999, tempDir: this.tempDir }
    ];
    assertRegistryCapacity(this.registryPath, startupReservation, RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES);
    if (this.usesRegistrySegment) {
      this.segmentSelection = await recordSegmentSelection({
        baseAuditRoot: this.baseAuditRoot, auditRoot: this.auditRoot, registryPath: this.registryPath,
        taskId: this.taskId, instanceId: this.instanceId
      });
    }
    fs.mkdirSync(this.auditRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.auditRoot, 0o700); fs.chmodSync(this.configDir, 0o700); } catch { /* platform default */ }
    appendRegistry(this.registryPath, runnerEvent, { reserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES });
    const config = {
      taskId: this.taskId, instanceId: this.instanceId, root: this.tempDir, socketPath: this.socketPath,
      registryPath: this.registryPath, configPath: this.configPath, owner: this.ownerIdentity,
      limits: this.limits, registryCleanupReserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES, pollMs: 250
    };
    const fd = fs.openSync(this.configPath, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(config)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try { fs.chmodSync(this.configPath, 0o600); } catch { /* platform default */ }
    this.guardian = spawn(process.execPath, [GUARDIAN_SCRIPT, '--config', this.configPath], {
      cwd: this.projectRoot, detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env }
    });
    this.guardian.once('exit', (exitCode, signal) => {
      this.guardianExitObservation = {
        observedAt: new Date().toISOString(), exitCode, signal
      };
    });
    this.guardian.unref();
    let spawnError = null;
    this.guardian.once('error', error => { spawnError = error; });
    const ready = await waitFor(() => fs.existsSync(this.socketPath), this.guardianStartupMs, 100);
    if (!ready || spawnError) {
      const failureReason = spawnError?.message || 'guardian readiness timeout';
      appendRegistry(this.registryPath, {
        taskId: this.taskId, instanceId: this.instanceId, event: 'guardian_start_failed', guardianPid: this.guardian.pid || null,
        error: failureReason, tempDir: this.tempDir, socket: this.socketPath
      }, { reserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES });
      let guardianExitConfirmed = false;
      let cleanupReply = null;
      if (this.guardian.pid) {
        this.guardianIdentity = await waitFor(() => processIdentity(this.guardian.pid), 1000, 50);
        if (this.guardianIdentity && processMatches(this.guardian.pid, this.guardianIdentity)) {
          if (fs.existsSync(this.socketPath)) {
            try { cleanupReply = await this.rpc({ op: 'cleanup', reason: 'owner-startup-failure' }, 5000); }
            catch { /* fall through to an identity-checked signal */ }
          }
        }
        if (this.guardianIdentity && processMatches(this.guardian.pid, this.guardianIdentity)) {
          try { process.kill(this.guardian.pid, 'SIGTERM'); } catch { /* identity is checked before signaling */ }
          guardianExitConfirmed = Boolean(await waitFor(() =>
            !processMatches(this.guardian.pid, this.guardianIdentity) &&
            processGroupMembers(this.guardianIdentity.pgid).length === 0, 20_000, 100));
          if (guardianExitConfirmed) {
            appendRegistry(this.registryPath, {
              taskId: this.taskId, instanceId: this.instanceId, event: 'guardian_pid_exited',
              guardianPid: this.guardian.pid, guardianStartTime: this.guardianIdentity.startTime,
              guardianFingerprint: this.guardianIdentity.fingerprint, exitConfirmed: true,
              startupFailure: true, cleanupReply, tempDir: this.tempDir, socket: this.socketPath,
              registryPath: this.registryPath
            }, { reserveBytes: 0 });
          } else {
            appendRegistry(this.registryPath, {
              taskId: this.taskId, instanceId: this.instanceId, event: 'guardian_exit_wait_timeout',
              guardianPid: this.guardian.pid, guardianStartTime: this.guardianIdentity.startTime,
              guardianFingerprint: this.guardianIdentity.fingerprint,
              guardianCurrentIdentity: processIdentity(this.guardian.pid), cleanupReply,
              tempDir: this.tempDir, tempDirPresent: fs.existsSync(this.tempDir),
              socket: this.socketPath, socketPresent: fs.existsSync(this.socketPath),
              registryPath: this.registryPath
            });
          }
        }
      }
      throw new Error(`resource guardian did not become ready (${failureReason}); guardianExitConfirmed=${guardianExitConfirmed}; preserve ${this.tempDir} and ${this.configPath} for inspection`);
    }
    this.guardianIdentity = processIdentity(this.guardian.pid);
    if (!this.guardianIdentity) throw new Error('guardian socket appeared but its process identity is unavailable');
    appendRegistry(this.registryPath, {
      taskId: this.taskId, instanceId: this.instanceId, event: 'guardian_started', guardianPid: this.guardian.pid,
      guardianStartTime: this.guardianIdentity.startTime, guardianFingerprint: this.guardianIdentity.fingerprint,
      ownerPid: process.pid, tempDir: this.tempDir, socket: this.socketPath, limits: this.limits,
      logPath: null, port: null, datadir: null, registryPath: this.registryPath
    }, { reserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES });
    this.installSignalHandlers();
    return this;
  }

  installSignalHandlers() {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        const exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
        void this.close(`owner-${signal.toLowerCase()}`).then(
          () => process.exit(exitCode),
          error => {
            process.exitCode = 1;
            try {
              appendRegistry(this.registryPath, {
                taskId: this.taskId, instanceId: this.instanceId, event: 'owner_signal_cleanup_failed',
                signal, error: String(error?.message || error).slice(0, 2048),
                ownerPid: process.pid, ownerStartTime: this.ownerIdentity.startTime,
                ownerFingerprint: this.ownerIdentity.fingerprint, tempDir: this.tempDir
              }, { reserveBytes: 0 });
            } catch { /* the original cleanup failure remains visible on stderr */ }
            console.error(`RESOURCE_CLEANUP_FAIL owner ${signal}: ${String(error?.message || error).slice(0, 2048)}`);
            process.exit(1);
          }
        );
      };
      process.once(signal, handler);
      this.signalHandlers.push([signal, handler]);
    }
    this.beforeExitHandler = () => {
      if (this.cleanupComplete || this.closePromise) return;
      void this.close('owner-before-exit').catch(error => {
        process.exitCode = 1;
        try {
          appendRegistry(this.registryPath, {
            taskId: this.taskId, instanceId: this.instanceId, event: 'owner_exit_cleanup_failed',
            error: String(error?.message || error).slice(0, 2048),
            ownerPid: process.pid, ownerStartTime: this.ownerIdentity.startTime,
            ownerFingerprint: this.ownerIdentity.fingerprint, tempDir: this.tempDir
          }, { reserveBytes: 0 });
        } catch { /* close() already preserves its primary failure */ }
        console.error(`RESOURCE_CLEANUP_FAIL owner-before-exit: ${String(error?.message || error).slice(0, 2048)}`);
      });
    };
    this.ownerExitHandler = () => {
      if (this.cleanupComplete || this.closePromise) return;
      try {
        appendRegistry(this.registryPath, {
          taskId: this.taskId, instanceId: this.instanceId, event: 'owner_process_exit_without_close',
          ownerPid: process.pid, ownerStartTime: this.ownerIdentity.startTime,
          ownerFingerprint: this.ownerIdentity.fingerprint, guardianPid: this.guardian?.pid || null,
          guardianStartTime: this.guardianIdentity?.startTime || null,
          guardianFingerprint: this.guardianIdentity?.fingerprint || null, tempDir: this.tempDir
        }, { reserveBytes: 0 });
      } catch { /* exit handlers must not mask the process result */ }
    };
    process.once('beforeExit', this.beforeExitHandler);
    process.once('exit', this.ownerExitHandler);
    this.lifecycleHandlers.push(['beforeExit', this.beforeExitHandler], ['exit', this.ownerExitHandler]);
  }

  async rpc(payload, timeoutMs = 30_000) {
    return await new Promise((resolve, reject) => {
      const client = net.createConnection(this.socketPath);
      let data = '';
      let total = 0;
      let settled = false;
      const timer = setTimeout(() => finish(new Error('resource guardian RPC timed out')), timeoutMs);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.destroy();
        if (error) reject(error); else resolve(value);
      };
      client.once('connect', () => client.write(`${JSON.stringify(payload)}\n`));
      client.on('data', chunk => {
        total += chunk.length;
        if (total > MAX_RPC_BYTES) { finish(new Error('resource guardian RPC response exceeded 1 MiB')); return; }
        data += chunk.toString('utf8');
        const newline = data.indexOf('\n');
        if (newline >= 0) {
          if (newline !== data.length - 1) {
            finish(new Error('resource guardian RPC response contains trailing data'));
            return;
          }
          if (newline === 0) {
            finish(new Error('resource guardian RPC response was empty'));
            return;
          }
          try { finish(null, JSON.parse(data.slice(0, newline))); }
          catch (error) { finish(new Error(`invalid resource guardian RPC response: ${error.message}`)); }
        }
      });
      client.once('error', error => finish(error));
      client.once('end', () => {
        if (settled) return;
        finish(new Error(data
          ? `truncated resource guardian RPC response: ${data.slice(0, 256)}`
          : 'resource guardian RPC closed without a response'));
      });
      client.once('close', () => {
        if (!settled) finish(new Error(data
          ? `truncated resource guardian RPC response: ${data.slice(0, 256)}`
          : 'resource guardian RPC closed without a response'));
      });
    });
  }

  async allocateDir(relativePath) {
    const result = await this.rpc({ op: 'mkdir', path: relativePath });
    if (!result.ok) throw new Error(result.error || 'could not allocate resource directory');
    return result.path;
  }

  async startProcess(spec) {
    const normalized = normalizeSpec(spec, this.limits.leaseMs);
    const result = await this.rpc({ op: 'start', spec: normalized });
    if (!result.ok) throw new Error(result.error || 'resource process failed to start');
    return result.resource;
  }

  async status() { return await this.rpc({ op: 'status' }); }

  async renew(id, leaseMs = this.limits.leaseMs) {
    const amount = checkLimit(leaseMs, RESOURCE_LIMITS.leaseMs, 'leaseMs');
    const result = await this.rpc({ op: 'renew', id, leaseMs: amount });
    if (!result.ok) throw new Error(result.error || 'resource lease could not be renewed');
    return result.resource;
  }

  async waitProcess(id, timeoutMs = 30_000) {
    const endAt = Date.now() + Math.max(1, Number(timeoutMs));
    while (Date.now() < endAt) {
      let result;
      try { result = await this.rpc({ op: 'status', id }); }
      catch (error) { return { unavailable: true, error: error.message }; }
      const resource = result.resources?.find(item => item.id === id);
      if (!resource) return { unavailable: true, error: 'resource entry is no longer available' };
      if (['exited', 'stopped', 'failed', 'signaled', 'spawn_failed', 'blocked'].includes(resource.status)) {
        return { ...resource, timedOut: false };
      }
      await sleep(100);
    }
    return { ...(await this.status()).resources.find(item => item.id === id), timedOut: true };
  }

  async stop(id, reason = 'requested') { return await this.rpc({ op: 'stop', id, reason }); }

  async runProcess(spec, { timeoutMs = 60_000 } = {}) {
    const resource = await this.startProcess(spec);
    const result = await this.waitProcess(resource.id, timeoutMs);
    if (result.timedOut) await this.stop(resource.id, 'timeout');
    let tail = '';
    try {
      const response = await this.rpc({ op: 'log-tail', id: resource.id, maxBytes: MAX_LOG_TAIL_BYTES });
      tail = response.tail || '';
    } catch { /* A budget action can finish and remove the root before this read. */ }
    let final = result;
    try { final = (await this.status()).resources?.find(item => item.id === resource.id) || result; }
    catch { /* Budget cleanup may already have stopped the guardian. */ }
    return { ...final, timedOut: Boolean(result.timedOut), tail };
  }

  async close(reason = 'owner-finally') {
    if (this.closePromise) return await this.closePromise;
    this.closePromise = (async () => {
      this.closed = true;
      let response = null;
      try {
        try { response = await this.rpc({ op: 'cleanup', reason }, 5000); }
        catch (error) {
          if (fs.existsSync(this.tempDir)) {
            const alive = this.guardianIdentity && processMatches(this.guardian.pid, this.guardianIdentity);
            if (alive) throw new Error(`resource cleanup is still pending; preserved ${this.tempDir}: ${error.message}`);
          }
        }
        const [guardianExitObservation, guardianIdentityExit] = await Promise.all([
          waitFor(() => this.guardianExitObservation, 20_000, 50),
          this.guardianIdentity
            ? waitForExactProcessExit(this.guardianIdentity, { timeoutMs: 20_000, pollMs: 100 })
            : Promise.resolve(null)
        ]);
        const guardianGone = Boolean(guardianExitObservation && guardianIdentityExit);
        if (!guardianGone) {
          const currentIdentity = processIdentity(this.guardian.pid);
          const timeoutEvent = {
            taskId: this.taskId, instanceId: this.instanceId, event: 'guardian_exit_wait_timeout',
            ownerPid: process.pid, ownerStartTime: this.ownerIdentity.startTime,
            guardianPid: this.guardian.pid, guardianStartTime: this.guardianIdentity?.startTime || null,
            guardianFingerprint: this.guardianIdentity?.fingerprint || null,
            guardianCurrentIdentity: currentIdentity, guardianExitObservation, guardianIdentityExit,
            cleanupReply: response,
            tempDir: this.tempDir, tempDirPresent: fs.existsSync(this.tempDir),
            socket: this.socketPath, socketPresent: fs.existsSync(this.socketPath),
            registryPath: this.registryPath
          };
          appendRegistry(this.registryPath, timeoutEvent);
          throw new Error(`guardian PID ${this.guardian.pid} did not exit within 20000 ms; tempDirPresent=${timeoutEvent.tempDirPresent}; socketPresent=${timeoutEvent.socketPresent}; evidence=${this.registryPath}`);
        }
        appendRegistry(this.registryPath, {
          taskId: this.taskId, instanceId: this.instanceId, event: 'guardian_pid_exited', guardianPid: this.guardian.pid,
          guardianStartTime: this.guardianIdentity.startTime,
          guardianFingerprint: this.guardianIdentity.fingerprint, guardianPgid: this.guardianIdentity.pgid,
          exitConfirmed: true, exitCode: guardianExitObservation.exitCode, exitSignal: guardianExitObservation.signal,
          exitObservedAt: guardianExitObservation.observedAt,
          exactIdentityAbsentAt: guardianIdentityExit.exactIdentityAbsentAt,
          processGroupEmptyAt: guardianIdentityExit.processGroupEmptyAt,
          processGroupMembers: guardianIdentityExit.processGroupMembers,
          currentPidIdentity: guardianIdentityExit.currentPidIdentity,
          observerPid: process.pid, observerStartTime: this.ownerIdentity.startTime,
          observerFingerprint: this.ownerIdentity.fingerprint,
          observationMethod: 'child-process-exit-event-plus-exact-identity-and-empty-process-group',
          tempDir: this.tempDir, socket: this.socketPath, cleanupReply: response, registryPath: this.registryPath
        }, { reserveBytes: 0 });
        if (fs.existsSync(this.socketPath)) throw new Error(`guardian socket remains after exit: ${this.socketPath}`);
        if (fs.existsSync(this.configPath)) fs.unlinkSync(this.configPath);
        const cleanupRecord = await findCleanupRecord(this.registryPath, this.instanceId);
        if (!cleanupRecord) {
          throw new Error(`resource cleanup has no final registry record; FAIL; inspect ${this.registryPath} for instance ${this.instanceId}`);
        }
        if (cleanupRecord.event === 'instance_cleanup_blocked') {
          throw new Error(`resource cleanup is BLOCKED: ${cleanupRecord.reason || 'cleanup record reports blocked'}; preserve ${this.tempDir}`);
        }
        if (cleanupRecord.event === 'instance_cleanup_preserved') {
          throw new Error(`resource cleanup preserved diagnostics: ${cleanupRecord.reason}; inspect ${this.tempDir}`);
        }
        if (fs.existsSync(this.tempDir)) {
          throw new Error(`resource cleanup record exists but the managed directory remains; BLOCKED; preserve ${this.tempDir}`);
        }
        this.cleanupComplete = true;
        return { ok: true, status: 'cleaned', cleanupRecord };
      } finally {
        for (const [signal, handler] of this.signalHandlers) process.removeListener(signal, handler);
        this.signalHandlers = [];
        process.removeListener('beforeExit', this.beforeExitHandler);
        if (this.cleanupComplete) process.removeListener('exit', this.ownerExitHandler);
        this.lifecycleHandlers = this.lifecycleHandlers.filter(([eventName]) =>
          eventName === 'exit' && !this.cleanupComplete);
      }
    })();
    return await this.closePromise;
  }
}

export async function withResourceSession(options, callback) {
  const session = await ResourceSession.create(options);
  let result;
  let failure;
  try { result = await callback(session); }
  catch (error) { failure = error; }
  try { await session.close(failure ? 'owner-exception' : 'owner-finally'); }
  catch (cleanupError) {
    if (failure) throw new AggregateError([failure, cleanupError], 'resource task failed and cleanup is blocked');
    throw cleanupError;
  }
  if (failure) throw failure;
  return result;
}

export function assertActiveResourceSession(session, caller = 'service startup') {
  if (!(session instanceof ResourceSession)) {
    throw new Error(`${caller} requires an active managed ResourceSession; refusing to spawn an unmanaged service`);
  }
  if (!session.started || session.closed || !session.guardian?.pid || !session.guardianIdentity ||
      !processMatches(session.guardian.pid, session.guardianIdentity) || !fs.existsSync(session.socketPath)) {
    throw new Error(`${caller} received a missing, malformed, or inactive ResourceSession; refusing to spawn a service`);
  }
  return session;
}

export {
  appendRegistry as appendResourceRegistry,
  assertRegistryCapacity as assertResourceRegistryCapacity,
  readTail as readResourceLogTail,
  waitFor as waitForResourcePredicate,
  redactArgs as redactResourceCommand
};
