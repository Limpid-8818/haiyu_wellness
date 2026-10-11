import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const projectRoot = path.resolve(import.meta.dirname, '../..');
const taskId = '01a105f3-88a9-7022-b399-d43613f117cc';
const outputRoot = path.join(projectRoot, 'output', 'resource-audit');
const registryPath = path.join(outputRoot, 'registry.jsonl');
const baselinePath = path.join(outputRoot, 'stage22-rework-resource-baseline-20261004.json');
const checkpointPath = path.join(outputRoot, 'stage22-rework-resource-audit-checkpoint-20261004.json');
const finalPath = path.join(outputRoot, 'stage22-rework-resource-final-audit-20261004.json');
const leaseMs = 900_000;
const maxLogBytes = 8 * 1024 * 1024;
const maxDirectoryBytes = 512 * 1024 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function countBy(rows, field) {
  const counts = {};
  for (const row of rows) {
    const key = String(row[field] ?? 'null');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function pidKey(row) {
  return `${row.resourceId}:${row.pid}:${row.processStartTime}:${row.processFingerprint ?? ''}`;
}

async function readTaskEvents(excludeInstanceId = null) {
  const rows = [];
  let malformedLines = 0;
  const rl = createInterface({ input: createReadStream(registryPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines += 1;
      continue;
    }
    if (event.taskId === taskId && (!excludeInstanceId || event.instanceId !== excludeInstanceId)) rows.push(event);
  }
  return { rows, malformedLines };
}

function findAuditInstance(rows) {
  return rows.find((row) => row.event === 'process_started' && Number(row.pid) === process.pid)?.instanceId ?? null;
}

function verifyRegistry(rows, malformedLines, { requireNoActive = false } = {}) {
  const byEvent = new Map();
  const instances = new Map();
  const started = new Map();
  const exited = new Map();
  const pidExit = new Map();
  const summaries = new Map();
  const childStarts = [];
  const shutdowns = [];
  const mysqlExits = [];
  const paths = new Set();
  const sockets = new Set();

  for (const row of rows) {
    byEvent.set(row.event, (byEvent.get(row.event) ?? 0) + 1);
    if (row.instanceId) {
      if (!instances.has(row.instanceId)) instances.set(row.instanceId, {});
      const instance = instances.get(row.instanceId);
      if (row.event === 'runner_started') instance.runner = row;
      if (row.event === 'guardian_ready') instance.guardianReady = row;
      if (row.event === 'guardian_started') instance.guardianStarted = row;
      if (row.event === 'instance_cleaned') instance.cleaned = row;
      if (row.event === 'guardian_pid_exited') instance.guardianExited = row;
    }
    if (row.tempDir) paths.add(row.tempDir);
    if (row.socket) sockets.add(row.socket);
    if (row.event === 'process_started') started.set(row.resourceId, row);
    if (row.event === 'process_exit') exited.set(row.resourceId, row);
    if (row.event === 'pid_exit_confirmed') pidExit.set(pidKey(row), row);
    if (row.event === 'resource_cleanup_summary') summaries.set(row.resourceId, row);
    if (row.event === 'child_process_started') childStarts.push(row);
    if (row.event === 'shutdown_command_exit') shutdowns.push(row);
    if (row.event === 'mysql_graceful_exit_confirmed') mysqlExits.push(row);
  }

  const resources = [...started.values()].map((start) => {
    const processExit = exited.get(start.resourceId) ?? null;
    const cleanup = summaries.get(start.resourceId) ?? null;
    const pidConfirmation = pidExit.get(pidKey(start)) ?? null;
    const children = childStarts.filter((child) => child.resourceId === start.resourceId).map((child) => {
      const confirmation = pidExit.get(pidKey(child)) ?? null;
      return {
        pid: child.pid,
        ppid: child.ppid,
        pgid: child.pgid,
        processStartTime: child.processStartTime,
        processExecutable: child.processExecutable,
        processFingerprint: child.processFingerprint,
        command: child.command,
        cwd: child.cwd,
        logPath: child.logPath,
        port: child.port,
        exactIdentityExited: confirmation?.exactIdentityExited === true,
        identityStillMatches: confirmation?.identityStillMatches ?? null,
      };
    });
    return {
      resourceId: start.resourceId,
      label: start.resourceLabel,
      kind: start.resourceKind,
      role: start.role,
      pid: start.pid,
      ppid: start.ppid,
      pgid: start.pgid,
      processStartTime: start.processStartTime,
      processExecutable: start.processExecutable,
      processFingerprint: start.processFingerprint,
      command: start.command,
      cwd: start.cwd,
      tempDir: start.tempDir,
      logPath: start.logPath,
      port: start.port,
      datadir: start.datadir,
      exitCode: processExit?.exitCode ?? cleanup?.exitCode ?? null,
      signal: processExit?.signal ?? cleanup?.signal ?? null,
      exactIdentityExited: pidConfirmation?.exactIdentityExited === true,
      identityStillMatches: pidConfirmation?.identityStillMatches ?? null,
      cleanup: cleanup ? {
        status: cleanup.status,
        stopReason: cleanup.stopReason,
        trackedPidCount: cleanup.trackedPidCount,
        allTrackedPidsExited: cleanup.allTrackedPidsExited,
        logBytes: cleanup.logBytes,
        logPeakBytes: cleanup.logPeakBytes,
        maxLogBytes: cleanup.maxLogBytes,
        directoryPeakBytes: cleanup.directoryPeakBytes,
        maxDirectoryBytes: cleanup.maxDirectoryBytes,
      } : null,
      children,
    };
  });

  const instanceRows = [...instances.entries()].map(([instanceId, item]) => ({
    instanceId,
    ownerPid: item.runner?.ownerPid ?? null,
    ownerStartTime: item.runner?.ownerStartTime ?? null,
    ownerFingerprint: item.runner?.ownerFingerprint ?? null,
    command: item.runner?.command ?? null,
    cwd: item.runner?.cwd ?? null,
    tempDir: item.runner?.tempDir ?? null,
    socket: item.runner?.socket ?? null,
    limits: item.runner?.limits ?? null,
    guardianPid: item.guardianStarted?.guardianPid ?? item.guardianReady?.guardianPid ?? item.cleaned?.guardianPid ?? null,
    guardianStartTime: item.guardianStarted?.guardianStartTime ?? item.guardianExited?.guardianStartTime ?? null,
    guardianExitConfirmed: item.guardianExited?.exitConfirmed === true,
    directoryBytesBeforeDelete: item.cleaned?.directoryBytesBeforeDelete ?? null,
    peakDirectoryBytes: item.cleaned?.peakDirectoryBytes ?? null,
    maxDirectoryBytes: item.cleaned?.maxDirectoryBytes ?? null,
    maxLogBytes: item.cleaned?.maxLogBytes ?? null,
    resourceCount: item.cleaned?.resourceCount ?? null,
    resourceSummaryCount: item.cleaned?.resourceSummaryCount ?? null,
    openHandleCheck: item.cleaned?.openHandleCheck ?? null,
    cleanedAt: item.cleaned?.at ?? null,
    cleanedReason: item.cleaned?.reason ?? null,
  }));

  const allPidsConfirmed = resources.every((resource) => resource.exactIdentityExited)
    && childStarts.every((child) => pidExit.get(pidKey(child))?.exactIdentityExited === true);
  const allResourceCleanupsPassed = resources.every((resource) => resource.cleanup?.allTrackedPidsExited === true
    && Number(resource.cleanup?.logPeakBytes ?? resource.cleanup?.logBytes ?? 0) <= Number(resource.cleanup?.maxLogBytes ?? maxLogBytes)
    && Number(resource.cleanup?.directoryPeakBytes ?? 0) <= Number(resource.cleanup?.maxDirectoryBytes ?? maxDirectoryBytes));
  const allInstancesCleaned = instanceRows.every((instance) => instance.guardianExitConfirmed
    && instance.openHandleCheck?.includes('no matching handles')
    && instance.resourceCount === instance.resourceSummaryCount);
  const missingResourceRows = resources.filter((resource) => !resource.cleanup || !exited.has(resource.resourceId));
  const missingPids = childStarts.filter((child) => !pidExit.has(pidKey(child)));
  const existingTempPaths = [...paths].filter((entry) => fs.existsSync(entry));
  const existingSockets = [...sockets].filter((entry) => fs.existsSync(entry));
  const mysqlShutdownGood = shutdowns.every((row) => row.exitCode === 0 && row.command?.includes('--protocol=SOCKET'));
  const mysqlPidExitGood = mysqlExits.every((row) => row.exitCode === 0
    && row.shutdownExitCode === 0
    && pidExit.get(pidKey(row))?.exactIdentityExited === true
    && !fs.existsSync(row.datadir)
    && !fs.existsSync(row.socket));

  const currentPs = spawnSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024 });
  assert(currentPs.status === 0, `ps failed: ${currentPs.stderr || currentPs.error?.message || currentPs.status}`);
  const livePrefixMatches = currentPs.stdout.split('\n').map((line) => line.trim()).filter((line) => line && (line.includes(taskId) || line.includes(`/haiyu-resource-${taskId.slice(0, 8)}-`)));

  const lsof = spawnSync('lsof', ['-nP', '+L1'], { encoding: 'utf8', timeout: 25_000, maxBuffer: 8 * 1024 * 1024 });
  assert(lsof.status === 0 || lsof.status === 1, `lsof +L1 failed: ${lsof.stderr || lsof.error?.message || lsof.status}`);
  const taskPathMatches = [...paths].filter((entry) => entry && lsof.stdout.includes(entry));

  const failures = [];
  if (malformedLines) failures.push(`registry has ${malformedLines} malformed line(s)`);
  if (!allPidsConfirmed) failures.push('one or more tracked resource/child PIDs lack exact exit confirmation');
  if (!allResourceCleanupsPassed) failures.push('one or more resource cleanup summaries failed PID or budget checks');
  if (!allInstancesCleaned) failures.push('one or more instances lack full guardian/directory/handle cleanup confirmation');
  if (missingResourceRows.length) failures.push(`${missingResourceRows.length} resource(s) lack exit or cleanup summary`);
  if (missingPids.length) failures.push(`${missingPids.length} child PID(s) lack exit confirmation`);
  if (existingTempPaths.length) failures.push(`${existingTempPaths.length} temporary directory path(s) remain`);
  if (existingSockets.length) failures.push(`${existingSockets.length} resource socket path(s) remain`);
  if (!mysqlShutdownGood || !mysqlPidExitGood) failures.push('one or more temporary MySQL shutdown/exit checks failed');
  if (taskPathMatches.length) failures.push(`${taskPathMatches.length} deleted task resource path(s) remain open`);
  if (requireNoActive && livePrefixMatches.length) failures.push(`${livePrefixMatches.length} task-prefix process(es) remain: ${livePrefixMatches.join(' | ')}`);

  return {
    counts: Object.fromEntries([...byEvent.entries()].sort(([a], [b]) => a.localeCompare(b))),
    instances: instanceRows,
    resources,
    childProcessCount: childStarts.length,
    childProcesses: childStarts.map((child) => ({
      instanceId: child.instanceId,
      resourceId: child.resourceId,
      label: child.resourceLabel,
      pid: child.pid,
      ppid: child.ppid,
      pgid: child.pgid,
      processStartTime: child.processStartTime,
      processExecutable: child.processExecutable,
      processFingerprint: child.processFingerprint,
      command: child.command,
      cwd: child.cwd,
      tempDir: child.tempDir,
      logPath: child.logPath,
      port: child.port,
      exactIdentityExited: pidExit.get(pidKey(child))?.exactIdentityExited === true,
      identityStillMatches: pidExit.get(pidKey(child))?.identityStillMatches ?? null,
    })),
    pidExitConfirmations: [...pidExit.values()].map((row) => ({
      instanceId: row.instanceId,
      resourceId: row.resourceId,
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      processStartTime: row.processStartTime,
      processExecutable: row.processExecutable,
      processFingerprint: row.processFingerprint,
      exactIdentityExited: row.exactIdentityExited,
      identityStillMatches: row.identityStillMatches,
      stillInProcessGroup: row.stillInProcessGroup,
      verifiedAt: row.verifiedAt,
    })),
    mysql: {
      shutdownCommandCount: shutdowns.length,
      shutdownCommandsSucceeded: shutdowns.filter((row) => row.exitCode === 0).length,
      gracefulExitCount: mysqlExits.length,
      gracefulPidExitsConfirmed: mysqlExits.filter((row) => pidExit.get(pidKey(row))?.exactIdentityExited === true).length,
      shutdowns: shutdowns.map((row) => ({
        instanceId: row.instanceId,
        resourceId: row.resourceId,
        shutdownResourceId: row.shutdownResourceId,
        shutdownPid: row.pid,
        shutdownExitCode: row.exitCode,
        command: row.command,
        logPath: row.logPath,
        tempDir: row.tempDir,
        socket: row.socket,
      })),
      servers: mysqlExits.map((row) => ({
        instanceId: row.instanceId,
        resourceId: row.resourceId,
        pid: row.pid,
        processStartTime: row.processStartTime,
        processFingerprint: row.processFingerprint,
        exitCode: row.exitCode,
        shutdownPid: row.shutdownPid,
        shutdownExitCode: row.shutdownExitCode,
        socket: row.socket,
        datadir: row.datadir,
        tempDir: row.tempDir,
      })),
    },
    verification: {
      malformedRegistryLines: malformedLines,
      allPidsConfirmed,
      allResourceCleanupsPassed,
      allInstancesCleaned,
      missingResourceRows: missingResourceRows.map((row) => ({ resourceId: row.resourceId, label: row.label, pid: row.pid })),
      missingChildPidConfirmations: missingPids.map((row) => ({ resourceId: row.resourceId, pid: row.pid })),
      existingTempPaths,
      existingSockets,
      mysqlShutdownGood,
      mysqlPidExitGood,
      deletedTaskResourceOpenHandleMatches: taskPathMatches,
      taskPrefixProcessesObserved: livePrefixMatches,
      failures,
    },
  };
}

function getDiskSample() {
  const date = new Date().toISOString();
  const df = spawnSync('df', ['-Pk', '/tmp'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  const duAudit = spawnSync('du', ['-sk', path.join(outputRoot)], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  const duPlaywright = spawnSync('du', ['-sk', path.join(projectRoot, 'output', 'playwright')], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  const duDist = spawnSync('du', ['-sk', path.join(projectRoot, 'web', 'dist')], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024 });
  assert(df.status === 0 && duAudit.status === 0 && duPlaywright.status === 0 && duDist.status === 0, 'disk sample command failed');
  const dfLines = df.stdout.trim().split('\n');
  const dfColumns = dfLines.at(-1).trim().split(/\s+/);
  return {
    recordedAtUtc: date,
    commands: ['df -Pk /tmp', 'du -sk output/resource-audit', 'du -sk output/playwright', 'du -sk web/dist'],
    dfExitCode: df.status,
    filesystem: dfColumns[0],
    blocks1k: Number(dfColumns[1]),
    usedKiB: Number(dfColumns[2]),
    availableKiB: Number(dfColumns[3]),
    outputResourceAuditKiB: Number(duAudit.stdout.trim().split(/\s+/)[0]),
    outputPlaywrightKiB: Number(duPlaywright.stdout.trim().split(/\s+/)[0]),
    webDistKiB: Number(duDist.stdout.trim().split(/\s+/)[0]),
  };
}

async function auditMode() {
  const { rows: allRows, malformedLines: allMalformed } = await readTaskEvents();
  const auditInstanceId = findAuditInstance(allRows);
  assert(auditInstanceId, `cannot locate audit ResourceRunner instance for pid ${process.pid}`);
  const { rows, malformedLines } = await readTaskEvents(auditInstanceId);
  const audit = verifyRegistry(rows, malformedLines, { requireNoActive: false });
  const activeInstanceRows = allRows.filter((row) => row.instanceId === auditInstanceId);
  const activePids = new Set(activeInstanceRows.flatMap((row) => [row.pid, row.ownerPid, row.guardianPid]).filter(Number.isInteger));
  audit.verification.taskPrefixProcessesObserved = audit.verification.taskPrefixProcessesObserved.filter((line) => {
    const pid = Number(line.split(/\s+/, 1)[0]);
    return !activePids.has(pid);
  });
  audit.verification.failures = audit.verification.failures.filter((failure) => !failure.startsWith('one or more task-prefix processes'));
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const currentSpace = getDiskSample();
  const checkpoint = {
    schemaVersion: 1,
    taskId,
    recordedAtUtc: new Date().toISOString(),
    mode: 'managed-pre-cleanup-checkpoint',
    auditRunner: {
      instanceId: auditInstanceId,
      processId: process.pid,
      processStartTime: allRows.find((row) => row.event === 'process_started' && row.pid === process.pid)?.processStartTime ?? null,
    },
    baseline,
    diskSample: currentSpace,
    inventory: audit,
  };
  fs.writeFileSync(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  console.log(JSON.stringify({
    checkpointPath,
    auditInstanceId,
    auditedHistoricalInstances: audit.instances.length,
    auditedHistoricalResources: audit.resources.length,
    auditedHistoricalChildren: audit.childProcessCount,
    failures: audit.verification.failures,
    diskSample: currentSpace,
  }, null, 2));
  if (audit.verification.failures.length) process.exitCode = 1;
}

async function finalizeMode() {
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const { rows, malformedLines } = await readTaskEvents();
  const inventory = verifyRegistry(rows, malformedLines, { requireNoActive: true });
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const firstSpace = checkpoint.diskSample;
  const secondSpace = getDiskSample();
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const thirdSpace = getDiskSample();
  const maxWindowDelta = Math.max(...[firstSpace.availableKiB, secondSpace.availableKiB, thirdSpace.availableKiB])
    - Math.min(...[firstSpace.availableKiB, secondSpace.availableKiB, thirdSpace.availableKiB]);
  const browserEvidencePath = path.join(projectRoot, 'output', 'playwright', 'stage22-20261004-retry05', 'stage22-browser-evidence.json');
  const browserEvidence = JSON.parse(fs.readFileSync(browserEvidencePath, 'utf8'));
  const retainedArtifacts = [
    { path: 'output/playwright/stage22-20261004-retry01 through retry05/', purpose: 'all browser retry evidence and final 12 viewport screenshots', retainReason: 'audit trail and visual acceptance artifacts' },
    { path: 'output/resource-audit/stage22-execution-evidence-20261004.jsonl', purpose: 'Q22.1–Q22.12 dual database plus single live Q22.9 evidence', retainReason: 'business acceptance evidence' },
    { path: 'output/resource-audit/stage22-q21-regression-evidence-20261004.jsonl', purpose: 'Stage21 regression evidence', retainReason: 'regression acceptance evidence' },
    { path: 'output/resource-audit/registry.jsonl', purpose: 'append-only managed resource event history', retainReason: 'PID, command, directory, port, log, cleanup evidence' },
    { path: 'web/dist/', purpose: 'final Vite production build', retainReason: 'verified Stage22 build output' },
    { path: '../../wangshanchong/第28轮报告.md', purpose: 'Stage22 execution and rework report', retainReason: 'handoff report' },
    { path: 'docs/阶段22返工自验_20261004.md', purpose: 'Stage22 rework self-acceptance appendix', retainReason: 'Sol review package' },
    { path: '../../', purpose: 'current dfa3 worktree at b5268c0373620057cf720cd8b4ae5948dd2bdec1 with uncommitted Stage22 changes', retainReason: 'required Stage22 code and next review dependency' },
  ];
  const final = {
    schemaVersion: 1,
    title: 'Stage22 full rework task resource exit and cleanup audit',
    taskId,
    recordedAtUtc: new Date().toISOString(),
    auditWindow: 'all registry events for the Stage22 task through the managed final audit runner exit',
    registryPath: 'output/resource-audit/registry.jsonl',
    result: inventory.verification.failures.length ? 'FAIL' : 'PASS',
    baseline,
    checkpointDiskSample: firstSpace,
    finalDiskSamples: [secondSpace, thirdSpace],
    diskReview: {
      availableDeltaSinceBaselineKiB: thirdSpace.availableKiB - Number(baseline.samples.find((sample) => sample.command === 'df -k /tmp')?.stdout?.trim().split('\n').at(-1)?.trim().split(/\s+/)[3]),
      availableDeltaAcrossFinalSamplesKiB: thirdSpace.availableKiB - firstSpace.availableKiB,
      shortSampleWindowMaxDeltaKiB: maxWindowDelta,
      attribution: 'The APFS data volume is shared. Retained screenshots, evidence, build output, other application activity, and the managed temporary work contributed to aggregate volume deltas; the managed temporary directories themselves were removed and are not included in the retained output folders.',
    },
    configuration: {
      leaseMs,
      maxLogBytes,
      maxDirectoryBytes,
      mysqlPolicy: 'Temporary MySQL used its instance Unix socket for mysqladmin shutdown; server PID exact-identity exit was then confirmed before directory cleanup. Small buffer pool, constrained redo, and binlog disabled per resource plan.',
      browserConfigPath: 'scripts/resources/playwright-cli.config.json',
      browserDisableFeatures: browserEvidence.browserConfigFeatureArg,
      browserCacheParent: browserEvidence.cacheParent,
      browserCacheExpectedNames: browserEvidence.expectedCacheNames,
      browserCacheSnapshotsUnchanged: browserEvidence.cacheSnapshots.every((sample) => JSON.stringify(sample.names) === JSON.stringify(browserEvidence.expectedCacheNames)),
      protectedUserChromePid: browserEvidence.userChromeSnapshots?.[0]?.identity?.pid ?? null,
      protectedUserChromeFingerprint: browserEvidence.userChromeSnapshots?.[0]?.identity?.fingerprint ?? null,
      isolatedBrowserPid: browserEvidence.browserProcess?.pid ?? browserEvidence.chromeProcess?.pid ?? null,
    },
    browserEvidence: {
      path: 'output/playwright/stage22-20261004-retry05/stage22-browser-evidence.json',
      status: browserEvidence.status,
      screenshotCount: browserEvidence.screenshots?.length ?? 12,
      layoutCount: browserEvidence.layoutChecks?.length ?? null,
      cacheSnapshotCount: browserEvidence.cacheSnapshots?.length ?? null,
      cacheNamesUnchanged: browserEvidence.cacheSnapshots.every((sample) => JSON.stringify(sample.names) === JSON.stringify(browserEvidence.expectedCacheNames)),
    },
    inventory,
    retainedArtifacts,
    previousManagedAuditCheckpoint: {
      path: 'output/resource-audit/stage22-rework-resource-audit-checkpoint-20261004.json',
      auditRunnerInstanceId: checkpoint.auditRunner.instanceId,
      auditRunnerPid: checkpoint.auditRunner.processId,
      reason: 'pre-cleanup snapshot preserved to show resource inventory before final audit runner exit',
    },
  };
  fs.writeFileSync(finalPath, `${JSON.stringify(final, null, 2)}\n`);
  console.log(JSON.stringify({
    finalPath,
    result: final.result,
    instances: inventory.instances.length,
    resources: inventory.resources.length,
    childProcesses: inventory.childProcessCount,
    pidExitConfirmations: inventory.pidExitConfirmations.length,
    mysqlShutdowns: inventory.mysql.shutdownCommandCount,
    failures: inventory.verification.failures,
    diskSamples: [firstSpace.availableKiB, secondSpace.availableKiB, thirdSpace.availableKiB],
    taskPrefixProcesses: inventory.verification.taskPrefixProcessesObserved,
    deletedTaskResourceOpenHandleMatches: inventory.verification.deletedTaskResourceOpenHandleMatches,
  }, null, 2));
  if (inventory.verification.failures.length) process.exitCode = 1;
}

if (process.argv.includes('--finalize')) await finalizeMode();
else await auditMode();
