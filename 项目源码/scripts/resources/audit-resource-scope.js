#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_REGISTRY_BYTES = 32 * 1024 * 1024;
const MAX_ROW_BYTES = 64 * 1024;
const MAX_FILES = 5000;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_SOL_THREAD_ID = '01a0cbfe-a161-72d0-992d-12fad655d4ef';
const INSTANCE_EVENTS = new Set([
  'runner_started', 'guardian_ready', 'guardian_started', 'guardian_start_failed',
  'guardian_exit_wait_timeout', 'guardian_control_plane_closed', 'guardian_pid_exited',
  'guardian_pid_exit_reconciled', 'process_starting', 'process_started', 'child_process_started',
  'process_exit', 'pid_exit_confirmed', 'resource_cleanup_summary', 'owner_exit_detected',
  'instance_cleaned', 'instance_cleanup_preserved', 'instance_cleanup_blocked',
  'posthoc_failure_diagnostic_preserved', 'posthoc_resource_directory_removed'
]);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const options = { taskId: null, includeTaskIds: [], executingAppThreadId: null,
    root: path.join(projectRoot, 'output/resource-audit'), out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--task-id') { options.taskId = value; index += 1; }
    else if (flag === '--include-task-id') { options.includeTaskIds.push(value); index += 1; }
    else if (flag === '--executing-app-thread-id') { options.executingAppThreadId = value; index += 1; }
    else if (flag === '--root') { options.root = path.resolve(value); index += 1; }
    else if (flag === '--out') { options.out = path.resolve(value); index += 1; }
    else throw new Error(`unknown audit-resource-scope option: ${flag}`);
  }
  if (!TASK_ID.test(options.taskId || '')) throw new Error('--task-id must be a complete canonical UUID before live inspection can start');
  options.taskId = options.taskId.toLowerCase();
  options.includeTaskIds = [...new Set(options.includeTaskIds.map(value => {
    if (!TASK_ID.test(value || '')) throw new Error('--include-task-id must be a complete UUID');
    return value.toLowerCase();
  }))];
  options.root = path.resolve(options.root);
  options.taskIds = [...new Set([options.taskId, ...options.includeTaskIds])];
  if (!TASK_ID.test(options.executingAppThreadId || '')) {
    throw new Error('--executing-app-thread-id must be a complete UUID; do not infer the executor from the audit scope');
  }
  options.executingAppThreadId = options.executingAppThreadId.toLowerCase();
  options.taskPrefixes = [...new Set(options.taskIds.map(id => `${id.split('-').slice(0, 2).join('-')}-`))];
  return options;
}

export function taskIdMatchesScope(taskId, options) {
  const candidate = String(taskId || '').toLowerCase();
  const prefixes = options.taskPrefixes || (options.taskPrefix ? [options.taskPrefix] : []);
  return options.taskIds.includes(candidate) || prefixes.some(prefix => candidate.startsWith(prefix));
}

export function registryMatchesScope({ taskIds = [], segmentTaskId = null } = {}, options) {
  return taskIdMatchesScope(segmentTaskId, options) || taskIds.some(taskId => taskIdMatchesScope(taskId, options));
}

function relativeSegmentTaskId(root, registryPath) {
  const relative = path.relative(root, registryPath).split(path.sep);
  return relative[0] === 'segments' && relative.length >= 4 ? relative[1] : null;
}

function collectRegistries(root) {
  const files = [];
  if (!fs.existsSync(root)) throw new Error(`resource audit root does not exist: ${root}`);
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(target);
      else if (entry.isFile() && entry.name === 'registry.jsonl') files.push(path.resolve(target));
      if (files.length > MAX_FILES) throw new Error(`registry count exceeds bounded limit ${MAX_FILES}`);
    }
  }
  return files.sort();
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

function normalized(value) { return String(value || '').trim().replace(/\s+/g, ' '); }

function processKey(identity) {
  return `${Number(identity.pid) || 0}|${normalized(identity.startTime)}|${identity.fingerprint || ''}`;
}

function makeProcessIdentity(event, type) {
  if (type === 'resource') return {
    pid: Number(event.pid), startTime: event.processStartTime || null,
    fingerprint: event.processFingerprint || null, pgid: Number(event.pgid ?? event.processGroup) || null,
    executable: event.processExecutable || event.processExecutableAtStart || null,
    command: event.command || null, resourceId: event.resourceId || null,
    resourceLabel: event.resourceLabel || event.label || null, kind: event.resourceKind || event.kind || null,
    role: event.role || event.kind || null, tempDir: event.tempDir || null, logPath: event.logPath || null,
    socket: event.socket || null, datadir: event.datadir || null, port: event.port || null, cwd: event.cwd || null
  };
  if (type === 'owner') return {
    pid: Number(event.ownerPid), startTime: event.ownerStartTime || null,
    fingerprint: event.ownerFingerprint || null, pgid: Number(event.ownerPgid) || null,
    executable: null, role: 'resource-session-owner'
  };
  return {
    pid: Number(event.guardianPid), startTime: event.guardianStartTime || null,
    fingerprint: event.guardianFingerprint || null, pgid: Number(event.guardianPgid) || null,
    executable: null, role: 'resource-guardian'
  };
}

function addPath(instance, value, kind) {
  if (typeof value !== 'string' || !value.startsWith('/')) return;
  const absolute = path.resolve(value);
  const previous = instance.paths.get(absolute) || { path: absolute, kinds: new Set() };
  previous.kinds.add(kind);
  instance.paths.set(absolute, previous);
}

function getInstance(groups, registryPath, segmentTaskId, event) {
  if (!event.instanceId) return null;
  const key = `${registryPath}|${event.instanceId}`;
  let state = groups.get(key);
  if (!state) {
    state = { key, taskIds: new Set(), instanceId: event.instanceId, registryPath, segmentTaskId,
      resourceStarts: new Map(), exactExitKeys: new Set(), exactExitRecords: new Map(), owner: null, guardian: null,
      resourceCleanupById: new Map(), guardianExit: null, cleanupSummaries: 0, terminal: null, posthocDiagnostic: null,
      posthocRemoval: null, paths: new Map(), sockets: new Set(), ports: new Set(), eventCount: 0 };
    groups.set(key, state);
  }
  if (event.taskId) state.taskIds.add(String(event.taskId));
  state.eventCount += 1;
  for (const [field, kind] of [['tempDir', 'tempDir'], ['socket', 'socket'], ['datadir', 'datadir'], ['logPath', 'logPath']]) {
    if (event[field]) addPath(state, event[field], kind);
  }
  if (Number.isInteger(Number(event.port)) && Number(event.port) > 0 && Number(event.port) <= 65535) state.ports.add(Number(event.port));
  if (event.event === 'runner_started') state.owner = makeProcessIdentity(event, 'owner');
  if (event.event === 'guardian_started' || event.event === 'guardian_ready') state.guardian = makeProcessIdentity(event, 'guardian');
  if (event.event === 'process_started' || event.event === 'child_process_started') {
    const identity = makeProcessIdentity(event, 'resource');
    if (Number.isInteger(identity.pid) && identity.pid > 0) state.resourceStarts.set(processKey(identity), identity);
  }
  if (event.event === 'pid_exit_confirmed' && event.exactIdentityExited === true) {
    const key = processKey(makeProcessIdentity(event, 'resource'));
    state.exactExitKeys.add(key);
    state.exactExitRecords.set(key, { verifiedAt: event.verifiedAt || event.at || null,
      exactIdentityExited: event.exactIdentityExited, stillInProcessGroup: event.stillInProcessGroup ?? null });
  }
  if (event.event === 'resource_cleanup_summary') {
    state.cleanupSummaries += 1;
    if (event.resourceId) state.resourceCleanupById.set(event.resourceId, {
      status: event.status || null, exitCode: event.exitCode ?? null, signal: event.signal || null,
      stopReason: event.stopReason || null, shutdownOutcome: event.shutdownOutcome || null,
      trackedPidCount: event.trackedPidCount ?? null, allTrackedPidsExited: event.allTrackedPidsExited ?? null,
      logPath: event.logPath || null, logBytes: event.logBytes ?? null, maxLogBytes: event.maxLogBytes ?? null,
      directoryPeakBytes: event.directoryPeakBytes ?? null, maxDirectoryBytes: event.maxDirectoryBytes ?? null
    });
  }
  if (['instance_cleaned', 'instance_cleanup_preserved', 'instance_cleanup_blocked'].includes(event.event)) state.terminal = event;
  if (event.event === 'guardian_pid_exited' ||
      (event.event === 'guardian_pid_exit_reconciled' && event.exactIdentityExited === true)) state.guardianExit = event;
  if (event.event === 'posthoc_failure_diagnostic_preserved') state.posthocDiagnostic = event;
  if (event.event === 'posthoc_resource_directory_removed') state.posthocRemoval = event;
  return state;
}

async function readRegistry(filePath, options, groups, selectedRegistries, structuralErrors) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_REGISTRY_BYTES) {
    structuralErrors.push(`${filePath}: exceeds ${MAX_REGISTRY_BYTES}-byte registry limit`);
    return;
  }
  const segmentTaskId = relativeSegmentTaskId(options.root, filePath);
  const pathSelectsFile = segmentTaskId && taskIdMatchesScope(segmentTaskId, options);
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let row = 0;
  let selectedRows = 0;
  for await (const line of lines) {
    row += 1;
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_ROW_BYTES) {
      structuralErrors.push(`${filePath}: row ${row} exceeds ${MAX_ROW_BYTES} bytes`);
      continue;
    }
    let event;
    try { event = JSON.parse(line); }
    catch { structuralErrors.push(`${filePath}: row ${row} is invalid JSON`); continue; }
    if (!pathSelectsFile && !taskIdMatchesScope(event.taskId, options)) continue;
    selectedRows += 1;
    if (event.instanceId && INSTANCE_EVENTS.has(event.event)) getInstance(groups, filePath, segmentTaskId, event);
  }
  if (selectedRows) selectedRegistries.push({ path: filePath, bytes: stat.size, selectedRows,
    segmentTaskId, sha256: await sha256File(filePath) });
}

export async function scanScopedRegistries(root, options) {
  const scopedOptions = { ...options, root: path.resolve(root) };
  const registryPaths = collectRegistries(scopedOptions.root);
  const groups = new Map();
  const selectedRegistries = [];
  const structuralErrors = [];
  for (const registryPath of registryPaths) {
    await readRegistry(registryPath, scopedOptions, groups, selectedRegistries, structuralErrors);
  }
  return { groups, selectedRegistries, structuralErrors };
}

function runBounded(command, args, timeoutMs = 7000, maxBuffer = 8 * 1024 * 1024) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} interrupted by ${result.signal}`);
  return result;
}

function parseProcessTable() {
  const result = runBounded('ps', ['-Ao', 'pid=,ppid=,pgid=,uid=,lstart=,stat=,command='], 7000, 8 * 1024 * 1024);
  if (result.status !== 0) throw new Error(`ps process inventory exited ${result.status}`);
  const processes = new Map();
  for (const line of result.stdout.split(/\r?\n/)) {
    const prefix = line.trimStart().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+/);
    if (!prefix) continue;
    const afterNumbers = line.trimStart().slice(prefix[0].length);
    const startTime = afterNumbers.slice(0, 24).trim();
    const afterTime = afterNumbers.slice(24).trimStart();
    const stateEnd = afterTime.search(/\s/);
    if (stateEnd < 0) continue;
    const state = afterTime.slice(0, stateEnd);
    const command = afterTime.slice(stateEnd).trim();
    const pid = Number(prefix[1]);
    const ppid = Number(prefix[2]);
    const pgid = Number(prefix[3]);
    const uid = Number(prefix[4]);
    const fingerprint = crypto.createHash('sha256').update(`${pid}\0${startTime}\0${pgid}\0${uid}`).digest('hex');
    processes.set(pid, { pid, ppid, pgid, uid, startTime, state, command, fingerprint });
  }
  return processes;
}

function selfResourceSession(processes) {
  let parentPid = process.ppid;
  let guardian = null;
  for (let depth = 0; depth < 12 && parentPid > 1; depth += 1) {
    const parent = processes.get(parentPid);
    if (!parent) break;
    const match = parent.command.match(/(?:^|\s)--config\s+(\S+)/);
    if (parent.command.includes('resource-guardian.js') && match) { guardian = { pid: parent.pid, configPath: match[1] }; break; }
    parentPid = parent.ppid;
  }
  if (!guardian) return null;
  const configPath = path.resolve(guardian.configPath);
  const stat = fs.statSync(configPath);
  if (stat.size > 64 * 1024) throw new Error(`current resource session config exceeds 64 KiB: ${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.instanceId || !config.taskId || !config.root || !config.socketPath) return null;
  const root = path.resolve(config.root);
  if (!root.startsWith('/tmp/haiyu-resource-')) throw new Error(`current resource session root is outside the managed temp prefix: ${root}`);
  return { instanceId: config.instanceId, taskId: String(config.taskId).toLowerCase(), root, socket: path.resolve(config.socketPath),
    ownerPid: Number(config.owner?.pid) || null, guardianPid: guardian.pid, processPid: process.pid };
}

export function resolveAuditProvenance({ executingAppThreadId, resourceSessionTaskId, environmentTaskId = null } = {}) {
  const errors = [];
  const appThreadId = String(executingAppThreadId || '').toLowerCase();
  const registryTaskId = String(resourceSessionTaskId || '').toLowerCase();
  const envTaskId = String(environmentTaskId || '').toLowerCase();
  if (!TASK_ID.test(appThreadId)) errors.push('executing App thread ID is missing or is not a complete UUID');
  if (!TASK_ID.test(registryTaskId)) errors.push('current ResourceRunner registry task ID is unavailable or invalid');
  if (TASK_ID.test(appThreadId) && TASK_ID.test(registryTaskId) && appThreadId !== registryTaskId) {
    errors.push('executing App thread ID does not match the current ResourceRunner registry task ID');
  }
  if (envTaskId && !TASK_ID.test(envTaskId)) errors.push('CODEX_TASK_ID is not a complete UUID');
  if (envTaskId && TASK_ID.test(registryTaskId) && envTaskId !== registryTaskId) {
    errors.push('CODEX_TASK_ID does not match the current ResourceRunner registry task ID');
  }
  return {
    executingAppThreadId: TASK_ID.test(appThreadId) ? appThreadId : null,
    registryTaskId: TASK_ID.test(registryTaskId) ? registryTaskId : null,
    sourceSolThreadId: SOURCE_SOL_THREAD_ID,
    errors
  };
}

function identityCurrent(identity, processes) {
  if (!identity?.pid || !identity.startTime || !identity.fingerprint) return { state: 'identity-incomplete', current: null };
  const current = processes.get(Number(identity.pid));
  if (!current) return { state: 'absent', current: null };
  if (current.fingerprint === identity.fingerprint && normalized(current.startTime) === normalized(identity.startTime)) {
    return { state: 'exact-live', current };
  }
  return { state: 'pid-reused', current: { pid: current.pid, startTime: current.startTime,
    pgid: current.pgid, executable: path.basename(current.command.split(/\s/)[0] || '') } };
}

function eventIdentityExitKey(identity) { return processKey(identity); }

function lsofPathRows(result) {
  const rows = [];
  let pid = null;
  let command = null;
  for (const field of String(result.stdout || '').split(/\r?\n/)) {
    if (field.startsWith('p')) { pid = Number(field.slice(1)) || null; command = null; }
    else if (field.startsWith('c')) command = field.slice(1);
    else if (field.startsWith('n')) rows.push({ pid, command, path: field.slice(1) });
  }
  return rows;
}

function inspectListeners(ports, exactPids) {
  if (!ports.size) return { exitCode: null, listeners: [], error: null };
  const result = runBounded('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], 7000, 4 * 1024 * 1024);
  if (![0, 1].includes(result.status)) return { exitCode: result.status, listeners: [], error: `lsof listener inventory exited ${result.status}` };
  const listeners = [];
  let pid = null;
  let command = null;
  let name = null;
  const flush = () => {
    if (!pid || !name) return;
    const port = Number(name.match(/:(\d+)(?:\s|$)/)?.[1]);
    if (ports.has(port)) listeners.push({ pid, command, port, exactRegisteredIdentity: exactPids.has(pid) });
  };
  for (const field of String(result.stdout || '').split(/\r?\n/)) {
    if (field.startsWith('p')) { flush(); pid = Number(field.slice(1)) || null; command = null; name = null; }
    else if (field.startsWith('c')) command = field.slice(1);
    else if (field.startsWith('n')) name = field.slice(1);
  }
  flush();
  return { exitCode: result.status, listeners, error: null };
}

async function readManifest(root) {
  const filePath = path.join(root, 'registry-segments.jsonl');
  const listed = new Set();
  const errors = [];
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false, listed, errors };
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_REGISTRY_BYTES) return { path: filePath, exists: true, listed,
    errors: [`manifest exceeds ${MAX_REGISTRY_BYTES} bytes`] };
  const input = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let row = 0;
  for await (const line of lines) {
    row += 1;
    if (!line) continue;
    if (Buffer.byteLength(line) > MAX_ROW_BYTES) { errors.push(`row ${row} exceeds ${MAX_ROW_BYTES} bytes`); continue; }
    try {
      const event = JSON.parse(line);
      if (event.event === 'resource_registry_segment_selected' && event.registryPath) listed.add(path.resolve(event.registryPath));
    } catch { errors.push(`row ${row} is invalid JSON`); }
  }
  return { path: filePath, exists: true, listed, errors };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv); // Validate the full task UUID before the first OS/process snapshot.
  const { groups, selectedRegistries, structuralErrors } = await scanScopedRegistries(options.root, options);
  const manifest = await readManifest(options.root);
  const missingManifestEntries = selectedRegistries.filter(file => file.segmentTaskId && !manifest.listed.has(file.path)).map(file => file.path);
  const processes = parseProcessTable();
  const self = selfResourceSession(processes);
  const provenance = resolveAuditProvenance({ executingAppThreadId: options.executingAppThreadId,
    resourceSessionTaskId: self?.taskId, environmentTaskId: process.env.CODEX_TASK_ID || null });
  const selfPids = new Set([process.pid, process.ppid, self?.ownerPid, self?.guardianPid].filter(Boolean));
  const selfPgids = new Set([...selfPids].map(pid => processes.get(pid)?.pgid).filter(Boolean));
  const selfInstanceKey = self ? [...groups.values()].find(instance => instance.instanceId === self.instanceId)?.key : null;
  const taskPrefixes = [...new Set(options.taskIds.map(id => id.slice(0, 8)))];
  const rootPrefixStrings = taskPrefixes.map(prefix => `/tmp/haiyu-resource-${prefix}-`);
  const socketPathSet = new Set([...groups.values()].flatMap(instance => [...instance.paths.values()]
    .filter(item => item.kinds.has('socket')).map(item => item.path)));
  const allResourcePorts = new Set([...groups.values()].flatMap(instance => [...instance.ports]));
  const allExactIdentities = new Map();
  const exactLivePids = new Set();
  const identityStatesByPid = new Map();
  const instanceResults = [];
  let missingResourceExitEvents = 0;
  let missingGuardianExitEvents = 0;
  let missingTerminalEvents = 0;
  const historicalGapSample = [];

  for (const instance of groups.values()) {
    const isSelf = instance.key === selfInstanceKey;
    const identities = [...instance.resourceStarts.values()];
    const missingExits = identities.filter(identity => !instance.exactExitKeys.has(eventIdentityExitKey(identity)));
    const liveIdentities = [];
    const pidReuse = [];
    for (const identity of identities) {
      const current = identityCurrent(identity, processes);
      identityStatesByPid.set(identity.pid, current.state);
      if (current.state === 'exact-live') exactLivePids.add(identity.pid);
      if (current.state === 'exact-live' && !isSelf && !selfPids.has(identity.pid)) {
        liveIdentities.push({ pid: identity.pid, startTime: identity.startTime, fingerprint: identity.fingerprint,
          pgid: identity.pgid, role: identity.role, resourceId: identity.resourceId, label: identity.resourceLabel });
      } else if (current.state === 'pid-reused') pidReuse.push({ pid: identity.pid, current: current.current });
      allExactIdentities.set(processKey(identity), identity);
    }
    const ownerState = instance.owner ? identityCurrent(instance.owner, processes) : { state: 'identity-incomplete' };
    const guardianState = instance.guardian ? identityCurrent(instance.guardian, processes) : { state: 'identity-incomplete' };
    if (instance.owner) identityStatesByPid.set(instance.owner.pid, ownerState.state);
    if (instance.guardian) identityStatesByPid.set(instance.guardian.pid, guardianState.state);
    if (ownerState.state === 'exact-live') exactLivePids.add(instance.owner.pid);
    if (guardianState.state === 'exact-live') exactLivePids.add(instance.guardian.pid);
    if (!isSelf && ownerState.state === 'exact-live' && !selfPids.has(instance.owner.pid)) {
      liveIdentities.push({ pid: instance.owner.pid, startTime: instance.owner.startTime, fingerprint: instance.owner.fingerprint,
        pgid: instance.owner.pgid, role: 'resource-session-owner', resourceId: null, label: null });
    }
    if (!isSelf && guardianState.state === 'exact-live' && !selfPids.has(instance.guardian.pid)) {
      liveIdentities.push({ pid: instance.guardian.pid, startTime: instance.guardian.startTime, fingerprint: instance.guardian.fingerprint,
        pgid: instance.guardian.pgid, role: 'resource-guardian', resourceId: null, label: null });
    }
    if (instance.owner) allExactIdentities.set(processKey(instance.owner), instance.owner);
    if (instance.guardian) allExactIdentities.set(processKey(instance.guardian), instance.guardian);
    const guardianExitMatches = Boolean(instance.guardian && instance.guardianExit &&
      Number(instance.guardian.pid) === Number(instance.guardianExit.guardianPid) &&
      normalized(instance.guardian.startTime) === normalized(instance.guardianExit.guardianStartTime) &&
      (!instance.guardian.fingerprint || !instance.guardianExit.guardianFingerprint ||
        instance.guardian.fingerprint === instance.guardianExit.guardianFingerprint));
    if (!isSelf && missingExits.length) missingResourceExitEvents += missingExits.length;
    if (!isSelf && instance.guardian && !guardianExitMatches) missingGuardianExitEvents += 1;
    if (!isSelf && !instance.terminal) missingTerminalEvents += 1;
    if (!isSelf && missingExits.length && historicalGapSample.length < 20) historicalGapSample.push({ instanceId: instance.instanceId,
      registryPath: instance.registryPath, gap: 'resource PID exit event missing', count: missingExits.length,
      pids: missingExits.slice(0, 5).map(item => item.pid) });
    if (!isSelf && instance.guardian && !guardianExitMatches && historicalGapSample.length < 20) historicalGapSample.push({
      instanceId: instance.instanceId, registryPath: instance.registryPath, gap: 'matching guardian exit event missing',
      pid: instance.guardian.pid, latestEvent: instance.guardianExit?.event || null });
    if (!isSelf && !instance.terminal && historicalGapSample.length < 20) historicalGapSample.push({ instanceId: instance.instanceId,
      registryPath: instance.registryPath, gap: 'terminal cleanup event missing' });
    instanceResults.push({ taskIds: [...instance.taskIds].sort(), segmentTaskId: instance.segmentTaskId,
      instanceId: instance.instanceId, registryPath: instance.registryPath, eventCount: instance.eventCount,
      currentAuditSession: isSelf,
      processStartCount: identities.length, exactPidExitEventCount: instance.exactExitKeys.size,
      missingResourcePidExitEventCount: missingExits.length, owner: instance.owner ? { pid: instance.owner.pid,
        startTime: instance.owner.startTime, fingerprint: instance.owner.fingerprint,
        exactIdentityState: ownerState.state } : null,
      guardian: instance.guardian ? { pid: instance.guardian.pid, startTime: instance.guardian.startTime,
        fingerprint: instance.guardian.fingerprint, exactIdentityState: guardianState.state, matchingExitEvent: guardianExitMatches,
        exitEvent: instance.guardianExit?.event || null } : null,
      cleanupSummaryCount: instance.cleanupSummaries, terminalEvent: instance.terminal?.event || null,
      posthocDiagnosticPreserved: Boolean(instance.posthocDiagnostic), posthocDirectoryRemoved: instance.posthocRemoval ? {
        path: instance.posthocRemoval.tempDir, exitCode: instance.posthocRemoval.exitCode,
        exactIdentityChecks: instance.posthocRemoval.exactIdentityChecks,
        exactIdentitiesPresent: instance.posthocRemoval.exactIdentitiesPresent,
        processGroupsRemaining: instance.posthocRemoval.processGroupsRemaining,
        lsofPlusDMatches: instance.posthocRemoval.lsofPlusDMatches,
        lsofPlusL1MatchesAfterRemoval: instance.posthocRemoval.lsofPlusL1MatchesAfterRemoval,
        directoryAbsentAfterRemoval: instance.posthocRemoval.directoryAbsentAfterRemoval
      } : null,
      tempRoots: [...instance.paths.values()].filter(item => item.kinds.has('tempDir') && path.basename(item.path).startsWith('haiyu-resource-'))
        .map(item => item.path), sockets: [...instance.paths.values()].filter(item => item.kinds.has('socket')).map(item => item.path),
      ports: [...instance.ports].sort((a, b) => a - b), liveIdentities, reusedPids: pidReuse,
      resources: identities.map(identity => {
        const key = processKey(identity);
        return { resourceId: identity.resourceId, label: identity.resourceLabel, kind: identity.kind, role: identity.role,
          pid: identity.pid, startTime: identity.startTime, fingerprint: identity.fingerprint, pgid: identity.pgid,
          executable: identity.executable, command: identity.command ? identity.command.slice(0, 1024) : null,
          commandTruncated: Boolean(identity.command && identity.command.length > 1024), cwd: identity.cwd,
          tempDir: identity.tempDir, logPath: identity.logPath, socket: identity.socket, datadir: identity.datadir,
          port: identity.port, exactPidExitEvent: instance.exactExitKeys.has(key),
          exactPidExitVerifiedAt: instance.exactExitRecords.get(key)?.verifiedAt || null,
          currentIdentityState: identityCurrent(identity, processes).state,
          cleanupSummary: identity.resourceId ? instance.resourceCleanupById.get(identity.resourceId) || null : null };
      }) });
  }

  const registeredTempRoots = new Set(instanceResults.flatMap(item => item.tempRoots));
  const trackedSockets = new Set(instanceResults.flatMap(item => item.sockets));
  const tempEntries = fs.readdirSync('/tmp', { withFileTypes: true });
  const candidateTaskPrefixPaths = tempEntries.filter(entry => rootPrefixStrings.some(prefix => path.join('/tmp', entry.name).startsWith(prefix)))
    .map(entry => path.join('/tmp', entry.name)).sort();
  const remainingTempRoots = candidateTaskPrefixPaths.filter(item => fs.existsSync(item) && item !== self?.root);
  const unregisteredTaskPrefixPaths = remainingTempRoots.filter(item => !registeredTempRoots.has(item));
  const remainingSockets = [...trackedSockets].filter(socket => socket !== self?.socket && fs.existsSync(socket));
  const groupsWithLiveMembers = new Map();
  const unverifiedCurrentProcessGroups = new Map();
  const reusedProcessGroups = new Map();
  for (const identity of allExactIdentities.values()) {
    if (!identity.pgid) continue;
    const members = [...processes.values()].filter(item => item.pgid === identity.pgid && !selfPids.has(item.pid));
    if (!members.length || selfPgids.has(identity.pgid)) continue;
    const confirmed = members.some(item => exactLivePids.has(item.pid) || rootPrefixStrings.some(prefix => item.command.includes(prefix)));
    const leader = processes.get(identity.pgid);
    const leaderWasReused = Boolean(leader && leader.pgid === identity.pgid && identityStatesByPid.get(identity.pgid) === 'pid-reused');
    const summary = members.map(item => ({ pid: item.pid, ppid: item.ppid, startTime: item.startTime,
      executable: path.basename(item.command.split(/\s/)[0] || '') }));
    if (confirmed) groupsWithLiveMembers.set(identity.pgid, summary);
    else if (leaderWasReused) reusedProcessGroups.set(identity.pgid, summary);
    else unverifiedCurrentProcessGroups.set(identity.pgid, summary);
  }
  const sameTaskPrefixProcesses = [...processes.values()].filter(item =>
    rootPrefixStrings.some(prefix => item.command.includes(prefix)) && !selfPids.has(item.pid));
  const deletedOpen = runBounded('lsof', ['-nP', '+L1', '-Fpcn'], 10000, 8 * 1024 * 1024);
  if (![0, 1].includes(deletedOpen.status)) structuralErrors.push(`lsof +L1 exited ${deletedOpen.status}`);
  const taskPathTokens = [...rootPrefixStrings, ...remainingTempRoots, ...remainingSockets, ...trackedSockets];
  const deletedOpenMatches = lsofPathRows(deletedOpen).filter(item => taskPathTokens.some(token => item.path.includes(token)));
  const exactPids = new Set([...allExactIdentities.values()].map(item => item.pid).filter(Boolean));
  const listenerAudit = inspectListeners(allResourcePorts, exactPids);
  if (listenerAudit.error) structuralErrors.push(listenerAudit.error);

  const processResidues = instanceResults.flatMap(instance => instance.liveIdentities.map(identity => ({
    instanceId: instance.instanceId, registryPath: instance.registryPath, ...identity
  })));
  const historicalGaps = { instancesWithoutTerminalEvent: missingTerminalEvents,
    guardiansWithoutMatchingExitEvent: missingGuardianExitEvents,
    resourceProcessIdentitiesWithoutExactExitEvent: missingResourceExitEvents,
    sample: historicalGapSample };
  const manifestMissingSegmentPaths = missingManifestEntries;
  const observedSegmentTaskIds = [...new Set(selectedRegistries.map(item => item.segmentTaskId).filter(Boolean))].sort();
  const status = structuralErrors.length || processResidues.length || remainingTempRoots.length || remainingSockets.length ||
    deletedOpenMatches.length || sameTaskPrefixProcesses.length || historicalGaps.instancesWithoutTerminalEvent ||
    historicalGaps.guardiansWithoutMatchingExitEvent || historicalGaps.resourceProcessIdentitiesWithoutExactExitEvent ||
    manifestMissingSegmentPaths.length || unverifiedCurrentProcessGroups.size || provenance.errors.length ? 'BLOCKED' : 'PASS';
  const result = {
    schemaVersion: 1, audit: 'stage23-alias-inclusive-live-resource-scope', status,
    executingAppThreadId: provenance.executingAppThreadId, registryTaskId: provenance.registryTaskId,
    sourceSolThreadId: provenance.sourceSolThreadId,
    executorProvenanceErrors: provenance.errors,
    root: options.root, scopeTaskIds: options.taskIds, includedTaskIdPrefixes: options.taskPrefixes, observedSegmentTaskIds,
    selectedRegistryCount: selectedRegistries.length,
    selectedEventCount: selectedRegistries.reduce((sum, item) => sum + item.selectedRows, 0),
    selectedResourceInstanceEventCount: instanceResults.reduce((sum, item) => sum + item.eventCount, 0),
    selectedRegistries, segmentManifest: { path: manifest.path, exists: manifest.exists,
      missingSegmentRegistryEntries: manifestMissingSegmentPaths, errors: manifest.errors },
    instanceCount: instanceResults.length, instances: instanceResults,
    currentResourceProcessIdentities: processResidues,
    currentRegisteredProcessGroups: [...groupsWithLiveMembers].map(([pgid, members]) => ({ pgid, members })),
    unverifiedCurrentProcessGroups: [...unverifiedCurrentProcessGroups].map(([pgid, members]) => ({ pgid, members })),
    reusedProcessGroups: [...reusedProcessGroups].map(([pgid, members]) => ({ pgid,
      reason: 'recorded group leader PID is now a different exact process identity', members })),
    sameTaskPrefixProcesses: sameTaskPrefixProcesses.map(item => ({ pid: item.pid, ppid: item.ppid, pgid: item.pgid,
      startTime: item.startTime, executable: path.basename(item.command.split(/\s/)[0] || '') })),
    currentTempRoots: candidateTaskPrefixPaths.map(item => ({ path: item, exists: fs.existsSync(item),
      registered: registeredTempRoots.has(item), auditorSession: item === self?.root })),
    unregisteredTaskPrefixPaths, remainingRegisteredTempRoots: remainingTempRoots.filter(item => registeredTempRoots.has(item)),
    remainingRegisteredSocketPaths: remainingSockets,
    deletedOpenTaskPaths: deletedOpenMatches,
    registeredPorts: [...allResourcePorts].sort((a, b) => a - b),
    registeredPortListeners: listenerAudit.listeners,
    possibleUnattributedPortListeners: listenerAudit.listeners.filter(item => !item.exactRegisteredIdentity),
    selfAuditSession: self ? { instanceId: self.instanceId, root: self.root, socket: self.socket,
      ownerPid: self.ownerPid, guardianPid: self.guardianPid, processPid: self.processPid,
      excludedFromTargetResidueCounts: true } : null,
    historicalGaps, structuralErrors
  };
  if (options.out) {
    const outPath = path.resolve(options.out);
    const relative = path.relative(options.root, outPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('--out must stay within the selected resource audit root');
    fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
    result.outputPath = outPath;
    fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (status !== 'PASS') process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`RESOURCE_SCOPE_AUDIT_FAIL ${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}

export { parseArgs, relativeSegmentTaskId, parseProcessTable, selfResourceSession, SOURCE_SOL_THREAD_ID };
