import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResourceSession } from './resource-runtime.js';
import { runStage27R4OfflineTests } from './stage27-r4-offline-tests.mjs';
import { readHashedBudgetJsonl, STAGE27_R4_SOURCE_APPROVAL } from './stage27-r4-budget-accounts.js';

const taskId = '01a12558-3f36-72c0-857c-fdd666eccf86';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resourceLimits = { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 };
const sourceAccountPath = path.join(projectRoot, STAGE27_R4_SOURCE_APPROVAL.sourceAccountRelativePath);
const workerAccountPath = path.join(projectRoot, 'output/resource-audit/stage27-r4', taskId, 'q275-persistent-model-budget.jsonl');
const approvalPath = path.join(projectRoot, STAGE27_R4_SOURCE_APPROVAL.relativePath);
const sourceReviewPath = path.join(projectRoot,
  'output/resource-audit/stage27-r4-source-sol-contract-callback-independent-entry-blocked-review-20261011.json');
const sourceBaselinePath = path.join(projectRoot,
  'output/resource-audit/stage27-r4-source-sol-cli-approval-forwarding-repair-handoff-baseline-20261011.json');
const reportRoot = path.join(projectRoot, 'output/resource-audit/stage27-r4', taskId,
  'cli-approval-forwarding-offline');

function boundedSnapshot(filePath, maxBytes) {
  if (!fs.existsSync(filePath)) return { exists: false, bytes: 0, sha256: null };
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) throw new Error(path.basename(filePath) + ' exceeds the bounded read limit of ' + maxBytes + ' bytes.');
  const bytes = fs.readFileSync(filePath);
  if (bytes.byteLength !== stat.size) throw new Error(path.basename(filePath) + ' changed while being read.');
  return { exists: true, bytes: bytes.byteLength, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function readBoundedJson(filePath, maxBytes) {
  const snapshot = boundedSnapshot(filePath, maxBytes);
  if (!snapshot.exists) throw new Error(path.basename(filePath) + ' is required but missing.');
  return { snapshot, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
}

function diskSample() {
  const stat = fs.statfsSync('/tmp');
  const blockBytes = Number(stat.bsize);
  return { at: new Date().toISOString(), availableBytes: Number(stat.bavail) * blockBytes,
    usedBytes: (Number(stat.blocks) - Number(stat.bfree)) * blockBytes,
    totalBytes: Number(stat.blocks) * blockBytes };
}

function budgetSnapshot(filePath) {
  const snapshot = boundedSnapshot(filePath, 8 * 1024 * 1024);
  if (snapshot.exists) readHashedBudgetJsonl(filePath);
  return snapshot;
}

async function managedCommand(session, { label, command, args, timeoutMs = 600_000, cwd = projectRoot }) {
  const result = await session.runProcess({ label, kind: label.startsWith('npm-') ? 'test' : 'test',
    role: 'r4-cli-approval-offline-verification', command, args, cwd,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', CODEX_TASK_ID: taskId,
      npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1' }, leaseMs: resourceLimits.leaseMs }, { timeoutMs });
  const receipt = { label, status: result.status, pid: result.pid, exitCode: result.exitCode ?? null,
    signal: result.signal || null, timedOut: Boolean(result.timedOut), resourceId: result.id,
    trackedPids: (result.pids || []).map(item => ({ pid: item.pid, processStartTime: item.processStartTime,
      fingerprint: item.fingerprint, exitConfirmed: item.exitConfirmed, exitCode: item.exitCode ?? null })),
    outputTail: String(result.tail || '').slice(-12_000) };
  assert.equal(receipt.status, 'exited', label + ' did not exit: ' + receipt.outputTail.slice(-2500));
  assert.equal(receipt.exitCode, 0, label + ' failed: ' + receipt.outputTail.slice(-2500));
  assert.equal(receipt.signal, null, label + ' was signaled');
  assert.equal(receipt.timedOut, false, label + ' timed out');
  assert.ok(receipt.trackedPids.every(item => item.exitConfirmed === true), label + ' has exact PID exit confirmation');
  return receipt;
}

async function main() {
  assert.equal(process.env.CODEX_TASK_ID, taskId, 'run only under the original assigned Stage 27 R4 worker identity');
  const sourceReview = readBoundedJson(sourceReviewPath, 16 * 1024 * 1024);
  const sourceBaseline = readBoundedJson(sourceBaselinePath, 16 * 1024 * 1024);
  assert.equal(sourceBaseline.snapshot.sha256,
    'ad61bedcbb3440231f6ca1203b013f734fb7cf473c1681c76238a644e258ae60',
    'the source CLI-repair handoff baseline has its frozen SHA-256');
  assert.equal(sourceBaseline.value.currentCodeBaseline.length, 219, 'source baseline contains all 219 code fingerprints');
  assert.equal(sourceReview.value.all902SegmentManifest.length, 902, 'source review retains all 902 registry-segment fingerprints');

  const reportId = 'cli-approval-forwarding-offline-' + new Date().toISOString().replace(/[^0-9TZ]/gu, '-')
    + '-' + crypto.randomUUID();
  const reportDirectory = path.join(reportRoot, reportId);
  fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(reportDirectory, 'cli-approval-forwarding-offline.json');
  const sourceBudgetBefore = budgetSnapshot(sourceAccountPath);
  const workerBudgetBefore = budgetSnapshot(workerAccountPath);
  const approvalBefore = boundedSnapshot(approvalPath, 64 * 1024);
  const reportBaseline = sourceBaseline.value.reportAppendOnlyPrefix;
  const roundReportBefore = boundedSnapshot(reportBaseline.path, 16 * 1024 * 1024);
  assert.deepEqual(roundReportBefore, { exists: true, bytes: reportBaseline.bytes, sha256: reportBaseline.sha256 },
    'the existing round report matches the frozen append-only source snapshot before work');
  const diskBefore = diskSample();
  const session = await ResourceSession.create({ taskId, projectRoot, limits: resourceLimits, tempParent: '/tmp' });
  const report = {
    schemaVersion: 1,
    recordType: 'stage27-r4-cli-approval-forwarding-offline-verification',
    reportId,
    taskId,
    sourceTaskId: sourceReview.value.sourceTaskId,
    worktree: projectRoot,
    head: sourceReview.value.head,
    startedAt: new Date().toISOString(),
    status: 'RUNNING',
    scope: '受管离线CLI环境边界/预算输入反例；不执行source live，不写真实预算',
    limits: resourceLimits,
    sourceReview: { path: path.relative(projectRoot, sourceReviewPath), bytes: sourceReview.snapshot.bytes,
      sha256: sourceReview.snapshot.sha256, status: sourceReview.value.overallStatus },
    sourceBaseline: { path: path.relative(projectRoot, sourceBaselinePath), bytes: sourceBaseline.snapshot.bytes,
      sha256: sourceBaseline.snapshot.sha256, codeFingerprintCount: sourceBaseline.value.currentCodeBaseline.length,
      segmentFingerprintCount: sourceReview.value.all902SegmentManifest.length },
    resourceSession: { instanceId: session.instanceId, tempDir: session.tempDir, socketPath: session.socketPath,
      registryPath: session.registryPath, ownerPid: session.ownerPid ?? process.pid,
      guardianPid: session.guardian?.pid || null, guardianIdentity: session.guardianIdentity || null },
    diskSamples: { before: diskBefore },
    modelProviderCalls: 0,
    environmentProviderCalls: 0,
    realSourceBudgetBefore: sourceBudgetBefore,
    realWorkerBudgetBefore: workerBudgetBefore,
    realApprovalBefore: approvalBefore,
    commands: [],
    focusedChecks: null,
    codeChangesSince219SourceBaseline: null,
    inheritedBrowserEvidence: null,
    gitEvidence: null,
    resourceCleanup: null,
    cleanupFailure: null,
    errors: []
  };
  let cleanupFailure = null;
  try {
    report.focusedChecks = await runStage27R4OfflineTests(path.join(session.tempDir, 'focused-offline-tests'));
    assert.equal(report.focusedChecks.status, 'PASS');
    assert.equal(report.focusedChecks.testCount, 18, 'focused tests include the CLI forwarding and mismatched SQL ID regressions');

    const changedJs = [
      'scripts/quest.js',
      'scripts/quests/q27.js',
      'scripts/resources/stage27-r4-cli-approval-context.js',
      'scripts/resources/stage27-r4-offline-tests.mjs',
      'scripts/resources/run-stage27-r4-offline-acceptance.mjs',
      'scripts/resources/run-stage27-r4-cli-approval-offline.mjs'
    ];
    for (const relativePath of changedJs) report.commands.push(await managedCommand(session, {
      label: 'node-check-' + path.basename(relativePath), command: process.execPath,
      args: ['--check', path.join(projectRoot, relativePath)], timeoutMs: 30_000
    }));
    report.commands.push(await managedCommand(session, { label: 'git-diff-check', command: 'git',
      args: ['diff', '--check'], timeoutMs: 30_000 }));
    report.commands.push(await managedCommand(session, { label: 'npm-test', command: 'npm', args: ['test'] }));
    report.commands.push(await managedCommand(session, { label: 'npm-build', command: 'npm', args: ['run', 'build'] }));
    const npmTest = report.commands.find(item => item.label === 'npm-test');
    assert.match(npmTest.outputTail, /# pass 58\b/u, 'existing test suite still reports 58 passing tests');
    assert.match(npmTest.outputTail, /# fail 0\b/u, 'existing test suite has no failures');
    const npmBuild = report.commands.find(item => item.label === 'npm-build');
    assert.match(npmBuild.outputTail, /built in/u, 'web build completed and emitted its bundle summary');

    report.commands.push(await managedCommand(session, { label: 'git-head', command: 'git', args: ['rev-parse', 'HEAD'], timeoutMs: 30_000 }));
    report.commands.push(await managedCommand(session, { label: 'git-status-short', command: 'git',
      args: ['status', '--short', '--untracked-files=all'], timeoutMs: 30_000 }));
    report.commands.push(await managedCommand(session, { label: 'git-diff-stat', command: 'git', args: ['diff', '--stat'], timeoutMs: 30_000 }));
    report.commands.push(await managedCommand(session, { label: 'git-staged-diff-stat', command: 'git',
      args: ['diff', '--cached', '--stat'], timeoutMs: 30_000 }));

    const changedBaselineFiles = [];
    for (const entry of sourceBaseline.value.currentCodeBaseline) {
      const filePath = path.isAbsolute(entry.path) ? entry.path : path.resolve(projectRoot, entry.path);
      const current = boundedSnapshot(filePath, 64 * 1024 * 1024);
      if (!current.exists || current.bytes !== entry.bytes || current.sha256 !== entry.sha256) {
        changedBaselineFiles.push({ path: path.relative(projectRoot, filePath).split(path.sep).join('/'),
          baselineBytes: entry.bytes, baselineSha256: entry.sha256, currentBytes: current.bytes,
          currentSha256: current.sha256, exists: current.exists });
      }
    }
    report.codeChangesSince219SourceBaseline = { baselineCount: sourceBaseline.value.currentCodeBaseline.length,
      changedCount: changedBaselineFiles.length, files: changedBaselineFiles };
    const expectedChangedFiles = new Set(['scripts/quest.js', 'scripts/quests/q27.js',
      'scripts/resources/stage27-r4-offline-tests.mjs', 'scripts/resources/run-stage27-r4-offline-acceptance.mjs']);
    assert.deepEqual(new Set(changedBaselineFiles.map(item => item.path)), expectedChangedFiles,
      'only the four scoped existing code files changed from the frozen 219-file source baseline');

    const previousBrowserReportPath = path.join(projectRoot,
      'output/resource-audit/stage27-r4', taskId,
      'offline-verification-20261011-confirmation-contract-2026-10-10T16-42-15-533Z-6d572afe-e04d-4882-bd40-4a0ff8714203',
      'offline-verification.json');
    const previousBrowserReport = readBoundedJson(previousBrowserReportPath, 4 * 1024 * 1024);
    assert.equal(previousBrowserReport.value.status, 'PASS_OFFLINE_VERIFICATION_ONLY');
    assert.equal(previousBrowserReport.value.bookingBrowser.confirmationContract.status, 'PASS');
    const inheritedScreenshots = Object.entries(previousBrowserReport.value.bookingBrowser.screenshots).map(([name, item]) => {
      const current = boundedSnapshot(item.path, 8 * 1024 * 1024);
      assert.deepEqual(current, { exists: true, bytes: item.bytes, sha256: item.sha256 }, name + ' inherited PNG still matches its source report');
      return { name, path: path.relative(projectRoot, item.path), bytes: item.bytes, sha256: item.sha256 };
    });
    report.inheritedBrowserEvidence = { sourceReport: path.relative(projectRoot, previousBrowserReportPath),
      sourceReportSha256: previousBrowserReport.snapshot.sha256, confirmationContract: 'PASS',
      liveBrowserRerun: false, inheritedScreenshots };

    const sourceBudgetAfter = budgetSnapshot(sourceAccountPath);
    const workerBudgetAfter = budgetSnapshot(workerAccountPath);
    const approvalAfter = boundedSnapshot(approvalPath, 64 * 1024);
    assert.deepEqual(sourceBudgetAfter, sourceBudgetBefore, 'offline CLI checks leave the real source budget unchanged');
    assert.deepEqual(workerBudgetAfter, workerBudgetBefore, 'offline CLI checks leave the real worker budget unchanged');
    assert.deepEqual(approvalAfter, approvalBefore, 'offline CLI checks leave the one-time approval file unchanged');
    report.realSourceBudgetAfter = sourceBudgetAfter;
    report.realWorkerBudgetAfter = workerBudgetAfter;
    report.realApprovalAfter = approvalAfter;

    const head = report.commands.find(item => item.label === 'git-head').outputTail.trim();
    assert.equal(head, sourceReview.value.head, 'Git HEAD remains at the inherited task baseline');
    const staged = report.commands.find(item => item.label === 'git-staged-diff-stat').outputTail.trim();
    assert.equal(staged, '', 'no staged Git changes were made');
    report.gitEvidence = { head, stagedDiffStat: staged, writesRequested: false,
      statusTail: report.commands.find(item => item.label === 'git-status-short').outputTail,
      diffStat: report.commands.find(item => item.label === 'git-diff-stat').outputTail,
      diffCheckExitCode: report.commands.find(item => item.label === 'git-diff-check').exitCode };
    report.status = 'PASS_OFFLINE_VERIFICATION_ONLY';
  } catch (error) {
    report.status = 'FAIL_OFFLINE_VERIFICATION';
    report.errors.push(String(error?.stack || error?.message || error).slice(0, 16_000));
  } finally {
    try {
      const status = await session.status();
      const resources = status.resources || [];
      const live = resources.filter(item => ['starting', 'running'].includes(item.status));
      report.resourceCleanup = { resourcesBeforeClose: resources, liveResourcesBeforeClose: live,
        allResourcesExitedBeforeGuardianClose: live.length === 0 };
      assert.equal(live.length, 0, 'all managed commands exit before guardian close');
    } catch (error) { cleanupFailure ||= 'pre-close inventory: ' + error.message; }
    try {
      const closed = await session.close(report.status === 'PASS_OFFLINE_VERIFICATION_ONLY'
        ? 'cli-approval-offline-verification-complete' : 'cli-approval-offline-verification-failed');
      report.resourceCleanup ||= {};
      report.resourceCleanup.close = closed;
      report.resourceCleanup.guardianExitObservation = session.guardianExitObservation;
      report.resourceCleanup.guardianIdentity = session.guardianIdentity;
      report.resourceCleanup.tempDirPresentAfterClose = fs.existsSync(session.tempDir);
      report.resourceCleanup.socketPresentAfterClose = fs.existsSync(session.socketPath);
      report.resourceCleanup.registryPath = session.registryPath;
      const registryStat = fs.statSync(session.registryPath);
      assert.ok(registryStat.size <= 8 * 1024 * 1024, 'new session registry is within its bounded read limit');
      const registryRows = fs.readFileSync(session.registryPath, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line));
      report.resourceCleanup.registryInstanceEvents = registryRows.filter(row => row.instanceId === session.instanceId);
      report.resourceCleanup.instanceCleanupRecord = [...report.resourceCleanup.registryInstanceEvents].reverse().find(row =>
        ['instance_cleaned', 'instance_cleanup_blocked', 'instance_cleanup_preserved'].includes(row.event)) || null;
      report.resourceCleanup.trackedPidCount = report.resourceCleanup.resourcesBeforeClose
        .flatMap(item => item.pids || []).length;
      report.resourceCleanup.allTrackedPidsExited = report.resourceCleanup.resourcesBeforeClose
        .flatMap(item => item.pids || []).every(item => item.exitConfirmed === true);
      report.resourceCleanup.maxObservedLogBytes = Math.max(0, ...report.resourceCleanup.resourcesBeforeClose
        .map(item => item.logPeakBytes || 0));
      report.resourceCleanup.maxObservedDirectoryBytes = Math.max(0, ...report.resourceCleanup.resourcesBeforeClose
        .map(item => item.directoryPeakBytes || 0));
      assert.equal(report.resourceCleanup.tempDirPresentAfterClose, false);
      assert.equal(report.resourceCleanup.socketPresentAfterClose, false);
      assert.equal(report.resourceCleanup.instanceCleanupRecord?.event, 'instance_cleaned');
      assert.equal(report.resourceCleanup.instanceCleanupRecord?.openHandleCheck,
        'lsof +D and lsof +L1 completed with no matching handles');
      assert.equal(report.resourceCleanup.guardianExitObservation?.exitCode, 0);
      assert.equal(report.resourceCleanup.allTrackedPidsExited, true);
      assert.equal(closed.ok, true);
    } catch (error) { cleanupFailure ||= 'ResourceSession close: ' + error.message; }
    report.completedAt = new Date().toISOString();
    report.cleanupFailure = cleanupFailure;
    report.diskSamples.after = diskSample();
    if (cleanupFailure) report.status = 'BLOCKED_RESOURCE_CLEANUP';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ status: report.status, reportPath,
    resourceInstanceId: session.instanceId, resourceCount: report.resourceCleanup?.resourcesBeforeClose?.length || 0,
    trackedPids: report.resourceCleanup?.trackedPidCount || 0, cleanup: report.resourceCleanup?.instanceCleanupRecord?.event || null }));
  if (report.status !== 'PASS_OFFLINE_VERIFICATION_ONLY') process.exitCode = 1;
}

await main();
