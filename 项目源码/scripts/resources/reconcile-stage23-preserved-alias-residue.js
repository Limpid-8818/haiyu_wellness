import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES,
  appendResourceRegistry,
  assertResourceRegistryCapacity,
  processGroupMembers,
  processIdentity,
  processMatches
} from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const executingTaskId = '01a107fa-cd18-7102-934a-48cba874c37f';
const sourceSolThreadId = '01a0cbfe-a161-72d0-992d-12fad655d4ef';
const instanceId = 'b69289f6-f0c0-43e2-80b3-478d947d8894';
const recordedTaskId = '01a107fa-cd18-934a-48cba874c37f';
const expectedRoot = `/tmp/haiyu-resource-01a107fa-${instanceId}`;
const segmentRegistry = path.join(projectRoot, 'output/resource-audit/segments', recordedTaskId, instanceId, 'registry.jsonl');
const sourceReviewPath = path.join(projectRoot, 'output/resource-audit/stage23-source-sol-return-review-20261006.json');
const prebusinessAuditPath = path.join(projectRoot, 'output/resource-audit/stage23-source-sol-prebusiness-current-resources-20261006.json');
const legacyRegistry = path.join(projectRoot, 'output/resource-audit/registry.jsonl');
const segmentManifest = path.join(projectRoot, 'output/resource-audit/registry-segments.jsonl');
const evidencePath = path.join(projectRoot, 'output/resource-audit/stage23-luna-alias-instance-b69289f6-cleanup-20261006.json');
const maxStructuredBytes = 16 * 1024 * 1024;
const maxRegistryRowBytes = 64 * 1024;
const maxLogTailBytes = 2048;
const expectedLegacyBytes = 31_229_667;
const expectedLegacySha256 = 'c75a5f637798d4921a42e88a303b14c92f5d0198051b44562b99be39606f4296';
const allowedTopLevel = new Set(['mysql-data', 'logs', 'work', 'tmp', 'quest-main']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readStructuredJson(filePath) {
  const stat = fs.statSync(filePath);
  assert(stat.size <= maxStructuredBytes, `structured evidence exceeds ${maxStructuredBytes} bytes: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function readBoundedTail(filePath, maxBytes = maxLogTailBytes) {
  const stat = fs.statSync(filePath);
  assert(stat.isFile(), `diagnostic log is not a regular file: ${filePath}`);
  assert(stat.size <= 8 * 1024 * 1024, `diagnostic log exceeds configured 8 MiB cap: ${filePath}`);
  const count = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(count);
  try { if (count) fs.readSync(fd, buffer, 0, count, stat.size - count); }
  finally { fs.closeSync(fd); }
  return { sizeBytes: stat.size, tailBytes: count,
    tailSha256: crypto.createHash('sha256').update(buffer).digest('hex'), tail: buffer.toString('utf8') };
}

function run(command, args, { timeout = 25_000, maxBuffer = 1024 * 1024 } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer });
  if (result.error) throw result.error;
  return { command: [command, ...args], exitCode: result.status, signal: result.signal || null,
    stdout: result.stdout || '', stderr: result.stderr || '' };
}

function dfSample(label) {
  const result = run('df', ['-Pk', '/tmp']);
  assert(result.exitCode === 0, `df -Pk /tmp failed: ${result.stderr.slice(0, 400)}`);
  const row = result.stdout.trim().split(/\r?\n/).at(-1).trim().split(/\s+/);
  assert(row.length >= 6, 'could not parse df -Pk /tmp');
  return { label, atUtc: new Date().toISOString(), filesystem: row[0], usedKiB: Number(row[2]),
    availableKiB: Number(row[3]), mountedOn: row.slice(5).join(' '), command: result.command, exitCode: result.exitCode };
}

function duSample(filePath) {
  const result = run('du', ['-sk', filePath]);
  const first = result.stdout.trim().split(/\s+/);
  return { path: filePath, command: result.command, exitCode: result.exitCode,
    allocatedKiB: result.exitCode === 0 && /^\d+$/.test(first[0] || '') ? Number(first[0]) : null,
    output: result.stdout.trim(), error: result.stderr.trim().slice(0, 400) };
}

async function readRegistry(filePath) {
  const stat = fs.statSync(filePath);
  assert(stat.size <= 32 * 1024 * 1024, 'alias registry exceeds its existing 32 MiB hard cap');
  const events = [];
  const lines = readline.createInterface({ input: fs.createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    index += 1;
    if (!line) continue;
    assert(Buffer.byteLength(line) <= maxRegistryRowBytes, `registry row ${index} exceeds 64 KiB`);
    const event = JSON.parse(line);
    assert(event.instanceId === instanceId, `foreign instance event in scoped alias registry at row ${index}`);
    events.push(event);
  }
  return { events, bytes: stat.size, sha256: sha256File(filePath) };
}

async function verifyManifestEntry() {
  const stat = fs.statSync(segmentManifest);
  assert(stat.size <= 32 * 1024 * 1024, 'segment manifest exceeds the existing 32 MiB hard cap');
  let matched = false;
  const lines = readline.createInterface({ input: fs.createReadStream(segmentManifest, { encoding: 'utf8' }), crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    index += 1;
    if (!line) continue;
    assert(Buffer.byteLength(line) <= maxRegistryRowBytes, `segment manifest row ${index} exceeds 64 KiB`);
    const event = JSON.parse(line);
    if (event.event === 'resource_registry_segment_selected' && event.taskId === recordedTaskId
      && event.instanceId === instanceId && path.resolve(event.registryPath || '') === path.resolve(segmentRegistry)) {
      matched = true;
    }
  }
  assert(matched, 'the exact alias registry is not present in the append-only segment manifest');
}

function inventoryRoot(root) {
  const rootStat = fs.lstatSync(root);
  assert(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'temporary root must be the exact real directory');
  assert(rootStat.uid === process.getuid() && (rootStat.mode & 0o777) === 0o700,
    'temporary root owner/mode does not match the ResourceRunner-owned directory');
  const rootDev = rootStat.dev;
  const top = fs.readdirSync(root).sort();
  for (const name of top) {
    assert(allowedTopLevel.has(name) || /^quest-api-[0-9a-f-]+$/i.test(name), `unexpected top-level entry: ${name}`);
  }
  let regularFiles = 0;
  let directories = 0;
  let allocatedLogicalBytes = 0;
  const specialEntries = [];
  const symlinks = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full);
      assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `entry escaped root: ${full}`);
      const item = fs.lstatSync(full);
      assert(item.dev === rootDev, `entry is on a different filesystem: ${full}`);
      if (item.isSymbolicLink()) symlinks.push(relative);
      else if (item.isDirectory()) { directories += 1; stack.push(full); }
      else if (item.isFile()) { regularFiles += 1; allocatedLogicalBytes += item.size; }
      else specialEntries.push({ path: relative, mode: item.mode });
    }
  }
  assert(symlinks.length === 0, `unexpected symlink(s) under ResourceSession: ${symlinks.join(', ')}`);
  assert(specialEntries.length === 0, `unexpected socket/device entries under ResourceSession: ${JSON.stringify(specialEntries)}`);
  return { path: String(root), device: rootDev, inode: rootStat.ino, uid: rootStat.uid,
    mode: (rootStat.mode & 0o777).toString(8), topLevelEntries: top,
    directoryCount: directories, regularFileCount: regularFiles, symlinks, specialEntries, regularFileBytes: allocatedLogicalBytes };
}

function currentIdentityState(pid, expected) {
  const current = processIdentity(pid);
  if (!current) return { pid, state: 'absent', exactIdentityPresent: false };
  const exact = processMatches(pid, expected);
  return { pid, state: exact ? 'exact_identity_alive' : 'pid_reused_or_identity_changed', exactIdentityPresent: exact,
    observed: { startTime: current.startTime, pgid: current.pgid, uid: current.uid, executable: current.executable } };
}

function openHandleAudit(rootPath, externalSocketAlias) {
  const rootScan = run('lsof', ['-nP', '+D', rootPath], { timeout: 25_000, maxBuffer: 256 * 1024 });
  assert([0, 1].includes(rootScan.exitCode), `lsof +D failed: ${rootScan.stderr.slice(0, 400)}`);
  assert(!rootScan.stdout.trim(), `open file handles remain under target root: ${rootScan.stdout.slice(0, 1000)}`);
  const deleted = run('lsof', ['-nP', '+L1'], { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
  assert(deleted.exitCode === 0, `lsof +L1 failed: ${deleted.stderr.slice(0, 400)}`);
  const needles = [rootPath, externalSocketAlias].filter(Boolean);
  const matches = deleted.stdout.split(/\r?\n/).filter(line => needles.some(needle => line.includes(needle)));
  assert(matches.length === 0, `deleted-open handles match target paths: ${matches.join('\n').slice(0, 1000)}`);
  return {
    rootScan: { command: rootScan.command, exitCode: rootScan.exitCode, matchCount: 0, outputBytes: Buffer.byteLength(rootScan.stdout) },
    deletedOpenScan: { command: deleted.command, exitCode: deleted.exitCode, matchingPaths: needles,
      matchCount: matches.length, outputBytes: Buffer.byteLength(deleted.stdout) }
  };
}

function captureIdentityChecks(review) {
  const item = review.wrongAliasEvidence;
  const checks = [
    currentIdentityState(item.owner.ownerPid, { startTime: item.owner.ownerStartTime, fingerprint: item.owner.ownerFingerprint }),
    currentIdentityState(item.guardian.guardianPid, { startTime: item.guardian.guardianStartTime, fingerprint: item.guardian.guardianFingerprint }),
    ...item.resources.map(resource => currentIdentityState(resource.pid, {
      startTime: resource.processStartTime, fingerprint: resource.processFingerprint,
      ...(Number.isInteger(resource.pgid) ? { pgid: resource.pgid } : {})
    }))
  ];
  assert(checks.length === 19, `expected 19 unique owner/guardian/resource identities, found ${checks.length}`);
  const exactAlive = checks.filter(item => item.exactIdentityPresent);
  assert(exactAlive.length === 0, `exact registered PID identity still alive: ${exactAlive.map(item => item.pid).join(',')}`);
  const groups = [...new Set(checks.map(item => item.pid))];
  const pgidAudit = [];
  for (const pgid of groups) {
    const members = processGroupMembers(pgid);
    if (members.length) pgidAudit.push({ pgid, members });
  }
  assert(pgidAudit.length === 0, `old resource process group(s) still have members: ${JSON.stringify(pgidAudit)}`);
  return { identityChecks: checks, exactAliveCount: exactAlive.length, pidReusedCount: checks.filter(item => item.state === 'pid_reused_or_identity_changed').length,
    allOriginalProcessGroupsEmpty: true, oldProcessGroupsChecked: groups };
}

function readShutdownDiagnostics(review) {
  const resources = review.wrongAliasEvidence.resources;
  const failedShutdown = resources.find(resource => resource.resourceLabel === 'q20-mysql-server-shutdown');
  const mysqlServer = resources.find(resource => resource.resourceLabel === 'q20-mysql-server');
  assert(failedShutdown?.logPath && mysqlServer?.logPath, 'required bounded MySQL shutdown diagnostic logs are missing from provenance');
  const shutdownTail = readBoundedTail(failedShutdown.logPath);
  const serverTail = readBoundedTail(mysqlServer.logPath);
  const finalShutdownLines = serverTail.tail.split(/\r?\n/).filter(line => /Received SHUTDOWN|Shutdown complete|MySQL Server - end/.test(line));
  assert(/Can't connect to local MySQL server through socket/.test(shutdownTail.tail), 'shutdown log no longer contains the recorded socket failure');
  assert(finalShutdownLines.some(line => line.includes('Shutdown complete')), 'MySQL server log does not confirm shutdown completion');
  const combined = [shutdownTail.tail, ...finalShutdownLines].join('\n');
  return {
    maxBytesReadPerLog: maxLogTailBytes,
    shutdownClient: { sourcePath: failedShutdown.logPath, sizeBytes: shutdownTail.sizeBytes, tailSha256: shutdownTail.tailSha256,
      tailBytes: Buffer.byteLength(shutdownTail.tail), tail: shutdownTail.tail },
    mysqlServer: { sourcePath: mysqlServer.logPath, sizeBytes: serverTail.sizeBytes, tailSha256: serverTail.tailSha256,
      tailBytes: serverTail.tailBytes, matchedShutdownLines: finalShutdownLines },
    savedText: combined
  };
}

function writeDiagnosticArtifact(payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  assert(Buffer.byteLength(text) < maxStructuredBytes, 'diagnostic artifact exceeds 16 MiB');
  const fd = fs.openSync(evidencePath, 'wx', 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return { path: evidencePath, bytes: fs.statSync(evidencePath).size, sha256: sha256File(evidencePath) };
}

async function main() {
  assert(process.env.CODEX_TASK_ID === executingTaskId, 'cleanup must run under the exact canonical Stage23 CODEX_TASK_ID');
  assert(os.tmpdir().startsWith('/tmp'), 'expected local temporary filesystem');
  assert(!fs.existsSync(evidencePath), `refusing to overwrite existing evidence artifact: ${evidencePath}`);
  const review = readStructuredJson(sourceReviewPath);
  const liveAudit = readStructuredJson(prebusinessAuditPath);
  const item = review.wrongAliasEvidence;
  assert(review.executingAppThreadId === sourceSolThreadId, 'source review provenance changed unexpectedly');
  assert(item.instanceId === instanceId && item.recordedTaskId === recordedTaskId && item.expectedTaskId === executingTaskId,
    'source Sol alias finding does not match this one-time cleanup target');
  assert(path.resolve(item.registryPath) === path.resolve(segmentRegistry), 'source Sol registry path does not match target alias');
  assert(item.registryBytes === 103878 && item.registrySha256 === '34ce87913b2861149a1fc643866b7b1fb440fe83c0b808b4c2e225fdbf1822c2',
    'source Sol alias registry fingerprint changed; preserve the instance and re-review');
  assert(liveAudit.executingAppThreadId === sourceSolThreadId
    && liveAudit.overallResourceGate === 'BLOCKED_UNREGISTERED_API_HISTORY',
    'source Sol full audit provenance changed unexpectedly');
  assert(liveAudit.remainingPaths.includes(expectedRoot) && liveAudit.legacyOrUnmanagedTempResidues.includes(expectedRoot),
    'source Sol audit no longer identifies the exact leftover root');
  const expectedRealRoot = path.join(fs.realpathSync('/tmp'), path.basename(expectedRoot));
  assert(fs.realpathSync(expectedRoot) === expectedRealRoot, 'target root must resolve under the canonical temp filesystem');

  const legacyStat = fs.statSync(legacyRegistry);
  assert(legacyStat.size === expectedLegacyBytes && sha256File(legacyRegistry) === expectedLegacySha256,
    'legacy append-only registry size/hash changed; no reconciliation will be applied');
  await verifyManifestEntry();
  const registryState = await readRegistry(segmentRegistry);
  assert(registryState.bytes === item.registryBytes && registryState.sha256 === item.registrySha256,
    'alias registry changed after source Sol captured it; no reconciliation will be applied');
  const events = registryState.events;
  const runnerStart = events.find(event => event.event === 'runner_started');
  const preserved = events.findLast(event => event.event === 'instance_cleanup_preserved');
  const shutdownFailed = events.findLast(event => event.event === 'mysql_shutdown_failed');
  const shutdownCommandExit = events.findLast(event => event.event === 'shutdown_command_exit');
  const mysqldExit = events.findLast(event => event.event === 'process_exit' && event.pid === 77240);
  const started = events.filter(event => ['process_started', 'child_process_started'].includes(event.event));
  const exits = events.filter(event => event.event === 'pid_exit_confirmed' && event.exactIdentityExited === true);
  assert(runnerStart?.taskId === recordedTaskId && events.every(event => event.taskId === recordedTaskId),
    'alias registry contents do not consistently belong to the recorded alias');
  assert(preserved?.reason === 'mysql-shutdown-command-failed:1', 'original preserved failure record does not match');
  assert(shutdownFailed?.reason === 'mysql-shutdown-command-failed:1' && shutdownCommandExit?.exitCode === 1,
    'original socket shutdown failure record does not match');
  assert(mysqldExit?.exitCode === 0, 'original mysqld actual process exit record does not show exit 0');
  assert(started.length === 17 && exits.length === 17 && events.filter(event => event.event === 'resource_cleanup_summary').length === 17,
    'alias registry does not contain 17 resource starts, exact exits, and summaries');
  assert(!events.some(event => event.event === 'guardian_pid_exited' && event.instanceId === instanceId),
    'a standard guardian exit event already exists; retain existing history without adding a duplicate');

  const root = fs.lstatSync(expectedRoot);
  assert(root.isDirectory() && !root.isSymbolicLink(), 'the exact temp root is not a real directory');
  const rootInventory = inventoryRoot(expectedRoot);
  const registeredPaths = new Set();
  for (const resource of item.resources) {
    for (const field of ['tempDir', 'datadir', 'logPath', 'socket']) {
      const value = resource[field];
      if (typeof value === 'string' && value.startsWith('/')) registeredPaths.add(value);
    }
    for (const field of ['tempDir', 'datadir', 'logPath']) {
      const value = resource[field];
      if (value) assert(value === expectedRoot || value.startsWith(`${expectedRoot}${path.sep}`), `registered ${field} escapes the exact temp root`);
    }
    if (resource.socket?.startsWith('/tmp/')) assert(resource.socket.startsWith(`${expectedRoot}${path.sep}`), 'registered MySQL socket escaped the temp root');
  }
  const terminalSocket = preserved.socket;
  assert(typeof terminalSocket === 'string' && terminalSocket.startsWith('/tmp/haiyu-rg-b69289f6-') && !fs.existsSync(terminalSocket),
    'external guardian socket alias must be the recorded task-owned alias and already absent');
  const diskBefore = { df: dfSample('before-exact-root-cleanup'), du: duSample(expectedRoot) };
  assert(diskBefore.du.exitCode === 0 && diskBefore.du.allocatedKiB === 144256,
    'target directory use changed from source Sol measurement; preserve and re-review');
  const identities = captureIdentityChecks(review);
  const ps = run('ps', ['-axo', 'pid=,ppid=,pgid=,uid=,lstart=,command='], { timeout: 5000, maxBuffer: 512 * 1024 });
  assert(ps.exitCode === 0, `full process table scan failed: ${ps.stderr.slice(0, 400)}`);
  const stalePrefix = `01a107fa-${instanceId.slice(0, 8)}`;
  const prefixMatches = ps.stdout.split(/\r?\n/).filter(line => line.includes(expectedRoot)
    || line.includes(stalePrefix) || line.includes(recordedTaskId));
  assert(prefixMatches.length === 0, `same-alias process/prefix remains: ${prefixMatches.slice(0, 4).join('\n')}`);
  const handlesBefore = openHandleAudit(expectedRoot, terminalSocket);
  const shutdown = readShutdownDiagnostics(review);

  const artifact = {
    schemaVersion: 1,
    status: 'verified_for_exact_temp_root_cleanup',
    clientDate: '2026-10-06',
    observedAtUtc: new Date().toISOString(),
    executingAppThreadId: executingTaskId,
    registryTaskId: recordedTaskId,
    sourceSolThreadId,
    worktree: projectRoot,
    head: 'b5268c0373620057cf720cd8b4ae5948dd2bdec1',
    instanceId, tempRoot: expectedRoot, terminalSocketAlias: terminalSocket,
    originalRegistry: { path: segmentRegistry, bytes: registryState.bytes, sha256: registryState.sha256,
      taskIdAlias: recordedTaskId, legacyRegistryUnchanged: { path: legacyRegistry, bytes: legacyStat.size, sha256: expectedLegacySha256 } },
    originalResourceHistory: { runnerTaskId: runnerStart.taskId, owner: item.owner, guardian: item.guardian,
      registeredResources: item.resources.map(resource => ({ resourceId: resource.resourceId, label: resource.resourceLabel,
        pid: resource.pid, ppid: resource.ppid, pgid: resource.pgid, processStartTime: resource.processStartTime,
        processFingerprint: resource.processFingerprint, command: resource.command, tempDir: resource.tempDir,
        datadir: resource.datadir, socket: resource.socket, logPath: resource.logPath, port: resource.port })),
      originalShutdownCommandExitCode: shutdownCommandExit.exitCode, originalMysqldExitCode: mysqldExit.exitCode,
      originalPreserveReason: preserved.reason, guardianStandardExitEventPresent: false },
    verificationBeforeCleanup: { rootInventory, registeredTemporaryPaths: [...registeredPaths].sort(), identities,
      oldProcessPrefixMatches: prefixMatches, handles: handlesBefore, disk: diskBefore },
    boundedDiagnostic: { maxBytesReadPerLog: maxLogTailBytes, shutdownClient: shutdown.shutdownClient,
      mysqlServer: shutdown.mysqlServer },
    cleanup: { command: 'rm -r -- /tmp/haiyu-resource-01a107fa-b69289f6-f0c0-43e2-80b3-478d947d8894',
      exitCode: null, directoryAbsent: false, postCleanupDisk: null },
    noUserProcessSignals: true, noUserDatabaseReadOrCopy: true,
    historicalGapPreserved: 'No guardian_pid_exited, pid_exit_confirmed, or historical exit time is synthesized.'
  };
  const diagnosticArtifact = { ...artifact, boundedDiagnostic: { ...artifact.boundedDiagnostic,
    excerpts: shutdown.savedText } };
  if (process.argv.slice(2).includes('--preflight-only')) {
    console.log(JSON.stringify({ status: 'PREFLIGHT_PASS_NO_DELETION', executingAppThreadId: executingTaskId,
      registryTaskId: recordedTaskId, sourceSolThreadId, instanceId, tempRoot: expectedRoot,
      originalPidCount: identities.identityChecks.length, exactIdentitiesPresent: identities.exactAliveCount,
      pidReusedCount: identities.pidReusedCount, processGroupsRemaining: 0, sameAliasProcessMatches: 0,
      lsofPlusDMatches: 0, lsofPlusL1Matches: 0, duAllocatedKiB: diskBefore.du.allocatedKiB,
      dfAvailableKiB: diskBefore.df.availableKiB,
      boundedLogBytesRead: diagnosticArtifact.boundedDiagnostic.shutdownClient.tailBytes
        + diagnosticArtifact.boundedDiagnostic.mysqlServer.tailBytes,
      diagnosticArtifactNotWritten: true, directoryLeftPresent: fs.existsSync(expectedRoot) }, null, 2));
    return;
  }
  const artifactInfo = writeDiagnosticArtifact(diagnosticArtifact);
  artifact.evidenceArtifact = artifactInfo;
  const diagnosticEvent = {
    taskId: recordedTaskId, instanceId, event: 'posthoc_failure_diagnostic_preserved',
    executingAppThreadId: executingTaskId, registryTaskId: recordedTaskId, sourceSolThreadId,
    diagnosticPath: path.relative(projectRoot, evidencePath), diagnosticSha256: artifactInfo.sha256,
    historicalShutdownCommandExitCode: 1, historicalMysqldExitCode: 0,
    originalPreserveReason: preserved.reason, historicalGuardianStandardExitEventPresent: false
  };
  const removalEventEstimate = {
    taskId: recordedTaskId, instanceId, event: 'posthoc_resource_directory_removed',
    executingAppThreadId: executingTaskId, registryTaskId: recordedTaskId, sourceSolThreadId,
    tempDir: expectedRoot, terminalSocketAlias: terminalSocket, command: artifact.cleanup.command,
    exitCode: 0, exactIdentityChecks: 19, exactIdentitiesPresent: 0, processGroupsRemaining: 0,
    sameAliasProcessMatches: 0, lsofPlusDMatches: 0, lsofPlusL1Matches: 0,
    directoryAbsentAfterRemoval: true, preCleanupAllocatedKiB: diskBefore.du.allocatedKiB,
    diagnosticPath: path.relative(projectRoot, evidencePath), diagnosticSha256: artifactInfo.sha256,
    historicalGuardianStandardExitEventPresent: false, historicalExitEventFabricated: false
  };
  assertResourceRegistryCapacity(segmentRegistry, [diagnosticEvent, removalEventEstimate], RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES);
  appendResourceRegistry(segmentRegistry, diagnosticEvent, { reserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES });

  const identitiesAgain = captureIdentityChecks(review);
  assert(identitiesAgain.identityChecks.every(check => check.state === 'absent'), 'an original PID became live before directory removal');
  const handlesAgain = openHandleAudit(expectedRoot, terminalSocket);
  const rm = run('rm', ['-r', '--', expectedRoot], { timeout: 45_000, maxBuffer: 16 * 1024 });
  const cleanup = { command: rm.command.join(' '), exitCode: rm.exitCode, signal: rm.signal,
    stdout: rm.stdout.trim().slice(0, 400), stderr: rm.stderr.trim().slice(0, 400) };
  assert(rm.exitCode === 0 && !fs.existsSync(expectedRoot), `exact temp root cleanup did not succeed (rm exit ${rm.exitCode})`);
  assert(!fs.existsSync(terminalSocket), 'guardian socket alias reappeared after temp root removal');
  const postDu = duSample(expectedRoot);
  assert(postDu.exitCode !== 0 && postDu.allocatedKiB === null, 'du unexpectedly found the removed target root');
  const postCleanupDf = dfSample('after-exact-root-cleanup-before-runner-exit');
  const finalHandles = run('lsof', ['-nP', '+L1'], { timeout: 25_000, maxBuffer: 2 * 1024 * 1024 });
  assert(finalHandles.exitCode === 0, `post-cleanup lsof +L1 failed: ${finalHandles.stderr.slice(0, 400)}`);
  const targetHandles = finalHandles.stdout.split(/\r?\n/).filter(line => line.includes(expectedRoot) || line.includes(terminalSocket));
  assert(targetHandles.length === 0, 'deleted-open resource files or socket alias remain after removal');
  const finalArtifactSha = artifactInfo.sha256;
  const finalEvent = { ...removalEventEstimate, command: cleanup.command, exitCode: rm.exitCode,
    signal: rm.signal, directoryAbsentAfterRemoval: !fs.existsSync(expectedRoot), terminalSocketAliasAbsent: !fs.existsSync(terminalSocket),
    preCleanupLsofPlusDExitCode: handlesAgain.rootScan.exitCode, preCleanupLsofPlusDMatches: handlesAgain.rootScan.matchCount,
    preCleanupLsofPlusL1ExitCode: handlesAgain.deletedOpenScan.exitCode, preCleanupLsofPlusL1Matches: handlesAgain.deletedOpenScan.matchCount,
    postCleanupDfUsedKiB: postCleanupDf.usedKiB, postCleanupDfAvailableKiB: postCleanupDf.availableKiB,
    postCleanupDuCommand: postDu.command.join(' '), postCleanupDuOutput: postDu.error,
    postCleanupDuExitCode: postDu.exitCode, postCleanupLsofPlusL1ExitCode: finalHandles.exitCode,
    postCleanupLsofPlusL1Matches: targetHandles.length, evidenceSha256: finalArtifactSha };
  appendResourceRegistry(segmentRegistry, finalEvent, { reserveBytes: RESOURCE_REGISTRY_CLEANUP_RESERVE_BYTES });
  const segmentAfter = fs.statSync(segmentRegistry);
  const legacyAfter = fs.statSync(legacyRegistry);
  assert(legacyAfter.size === expectedLegacyBytes && sha256File(legacyRegistry) === expectedLegacySha256,
    'legacy main registry changed during alias reconciliation');
  console.log(JSON.stringify({ status: 'TEMP_ROOT_REMOVED', executingAppThreadId: executingTaskId,
    registryTaskId: recordedTaskId, sourceSolThreadId, instanceId, tempRoot: expectedRoot,
    originalPidCount: identities.identityChecks.length, exactIdentitiesPresent: 0, processGroupsRemaining: 0,
    mySqlShutdownClientExitCode: 1, originalMysqldExitCode: 0, originalGuardianExitEventAdded: false,
    originalRegistryBytes: registryState.bytes, originalRegistrySha256: registryState.sha256,
    aliasRegistryBytesAfterAppend: segmentAfter.size, legacyRegistryBytesUnchanged: legacyAfter.size,
    diagnosticEvidencePath: path.relative(projectRoot, evidencePath), diagnosticEvidenceSha256: finalArtifactSha,
    duBeforeKiB: diskBefore.du.allocatedKiB, duAfterExitCode: postDu.exitCode,
    dfBeforeAvailableKiB: diskBefore.df.availableKiB,
    dfAfterUsedKiB: postCleanupDf.usedKiB, dfAfterAvailableKiB: postCleanupDf.availableKiB,
    lsofPlusDMatchesBeforeRemoval: 0, lsofPlusL1MatchesBeforeRemoval: 0,
    lsofPlusL1MatchesAfterRemoval: targetHandles.length,
    cleanupCommand: rm.command, cleanupExitCode: rm.exitCode }, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL_PRESERVED', executingAppThreadId: executingTaskId,
    registryTaskId: recordedTaskId, instanceId, error: String(error?.stack || error).slice(0, 5000),
    tempRootStillPresent: fs.existsSync(expectedRoot) }, null, 2));
  process.exitCode = 1;
});
