import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './resource-runtime.js';
import { assertProtectedProcessIdentity, assertQ278InitializationOrder,
  deriveEnvironmentFunctionalAcceptance, resolveStage27R5ExecutorIdentity,
  verifyStage27R5SourceAcceptance, retainStage27R5ExecutorObservation,
  verifyStage27R5SourceLedgerWindow, buildStage27R5RowSourceEvidence, STAGE27_R5_SOURCE_PACKAGING_HANDOFF,
  STAGE27_R5_ROW_PROVENANCE_HANDOFF, STAGE27_R5_OFFLINE_BASELINE } from './stage27-r5-offline-guards.js';
import { sampleProtectedProcessIdentity } from './stage27-r5-clean-browser-acceptance.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resourceRoot = path.join(projectRoot, 'output/resource-audit');
const offlineBaselinePath = path.join(resourceRoot, 'stage27-r5-source-sol-original-task-offline-repair-handoff-baseline-20261011.json');
const originalBaselinePath = path.join(resourceRoot, 'stage27-r5-source-sol-complete-handoff-baseline-20261011.json');
const forkReceiptPath = path.join(resourceRoot, 'stage27-r5-source-sol-app-fork-receipt-20261011.json');
const sourceProofPath = path.join(resourceRoot, 'stage27-r4-source-sol-final-independent-acceptance-and-handoff-20261011.json');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const offlineBaselineBytes = fs.readFileSync(offlineBaselinePath);
const originalBaselineBytes = fs.readFileSync(originalBaselinePath);
const forkReceiptBytes = fs.readFileSync(forkReceiptPath);
const protectionBaseline = JSON.parse(offlineBaselineBytes.toString('utf8'));
const originalBaseline = JSON.parse(originalBaselineBytes.toString('utf8'));
const forkReceipt = JSON.parse(forkReceiptBytes.toString('utf8'));
const offlineBaselineSha256 = hash(offlineBaselineBytes);
const originalBaselineSha256 = hash(originalBaselineBytes);
const forkReceiptSha256 = hash(forkReceiptBytes);

assert.equal(offlineBaselineBytes.length, STAGE27_R5_OFFLINE_BASELINE.bytes);
assert.equal(offlineBaselineSha256, STAGE27_R5_OFFLINE_BASELINE.sha256);

function resolve(taskId, overrides = {}) {
  return resolveStage27R5ExecutorIdentity({
    taskId, baseline: originalBaseline, baselinePath: originalBaselinePath,
    baselineBytes: originalBaselineBytes.length, baselineSha256: originalBaselineSha256,
    forkReceipt, forkReceiptPath, forkReceiptBytes: forkReceiptBytes.length, forkReceiptSha256,
    protectionBaseline, protectionBaselineBytes: offlineBaselineBytes.length,
    protectionBaselineSha256: offlineBaselineSha256, ...overrides
  });
}

const workerIdentity = resolve('01a126ea-4705-7771-ad75-e0d6ef0f4eb7');
const sourceIdentity = resolve('01a0cbfe-a161-72d0-992d-12fad655d4ef');
assert.equal(workerIdentity.role, 'worker');
assert.equal(workerIdentity.evidenceOrigin, 'worker_self_validation');
assert.equal(sourceIdentity.role, 'source');
assert.equal(sourceIdentity.evidenceOrigin, 'source_independent_acceptance');
assert.throws(() => resolve('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), /neither the frozen source/u,
  'unlisted task IDs are rejected');
assert.throws(() => resolve('01a126ea-4705-7771-ad75-e0d6ef0f4eb7', {
  forkReceipt: { ...forkReceipt, workerTaskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
}), /worker identity is not the frozen/u, 'a fork for another worker is rejected');
assert.throws(() => resolve('01a126ea-4705-7771-ad75-e0d6ef0f4eb7', {
  forkReceipt: { ...forkReceipt, baselineSha256: '0'.repeat(64) }
}), /SHA does not match/u, 'a fork receipt bound to another baseline SHA is rejected');
assert.throws(() => resolve('01a126ea-4705-7771-ad75-e0d6ef0f4eb7', {
  baselineSha256: '0'.repeat(64)
}), /baseline bytes\/SHA differ/u, 'changed original baseline bytes/SHA are rejected');
assert.throws(() => resolve('01a126ea-4705-7771-ad75-e0d6ef0f4eb7', {
  forkReceiptPath: path.join(resourceRoot, 'untrusted-fork-receipt.json')
}), /not included in the frozen/u, 'an unlisted fork receipt path is rejected');
assert.throws(() => resolve('01a126ea-4705-7771-ad75-e0d6ef0f4eb7', {
  protectionBaselineSha256: '0'.repeat(64)
}), /protection baseline bytes\/SHA/u, 'a changed offline-repair baseline is rejected');

const sourceBinding = STAGE27_R5_SOURCE_PACKAGING_HANDOFF;
const sourceProofBindings = sourceBinding.sourceProofs;
const sourceRun = (quest, status = 'PASS', extra = {}) => ({
  taskId: sourceBinding.sourceTaskId, quest, status,
  runId: sourceProofBindings[quest.replace('.', '_')].runId, ...extra
});
const packagingHandoff = {
  path: sourceBinding.path, bytes: sourceBinding.bytes, sha256: sourceBinding.sha256,
  value: {
    recordType: sourceBinding.recordType, sourceTaskId: sourceBinding.sourceTaskId,
    workerTaskId: sourceBinding.workerTaskId, sourceHostId: sourceBinding.hostId,
    workerHostId: sourceBinding.hostId,
    sourceQ277Proof: { path: path.resolve(projectRoot, sourceProofBindings.Q27_7.path) },
    sourceQ278Proof: { path: path.resolve(projectRoot, sourceProofBindings.Q27_8.path) },
    sourceRawRtm: { path: path.resolve(projectRoot, sourceProofBindings.Q27_9.path) },
    sourceActualThirdCommandEvidence: { path: path.resolve(projectRoot, sourceProofBindings.commandEvidence.path) }
  }
};
const sourceCommandBundle = {
  path: sourceProofBindings.commandEvidence.path,
  bytes: sourceProofBindings.commandEvidence.bytes,
  sha256: sourceProofBindings.commandEvidence.sha256,
  value: {
    cold: { command: sourceProofBindings.Q27_8.command, polls: [{ exit_code: 0 }] },
    mapping: { command: sourceProofBindings.Q27_9.command,
      result: { exit_code: 0, output: sourceProofBindings.Q27_9.runId } },
    aggregate: { command: `CODEX_TASK_ID=${sourceBinding.sourceTaskId} CODEX_STAGE27_SCOPE=R5 npm run quest -- --stage 27`,
      result: { exit_code: 2, output: 'NOT_FINAL_ACCEPTED' } }
  }
};
const sourceAcceptanceBundle = {
  executorIdentity: workerIdentity,
  handoff: packagingHandoff,
  q277Proof: { path: sourceProofBindings.Q27_7.path, bytes: sourceProofBindings.Q27_7.bytes,
    sha256: sourceProofBindings.Q27_7.sha256, value: {
      recordType: 'stage27-r5-source-first-actual-independent-q277-business-verification',
      sourceTaskId: sourceBinding.sourceTaskId, status: 'PASS_Q277',
      actualCommand: sourceProofBindings.Q27_7.command, exitCode: 0,
      evidence: { path: path.resolve(projectRoot, sourceProofBindings.Q27_7.evidencePath),
        bytes: sourceProofBindings.Q27_7.evidenceBytes, sha256: sourceProofBindings.Q27_7.evidenceSha256 }
    } },
  q277Evidence: { path: sourceProofBindings.Q27_7.evidencePath,
    bytes: sourceProofBindings.Q27_7.evidenceBytes, sha256: sourceProofBindings.Q27_7.evidenceSha256,
    value: [sourceRun('Q27.7')] },
  q278Proof: { path: sourceProofBindings.Q27_8.path, bytes: sourceProofBindings.Q27_8.bytes,
    sha256: sourceProofBindings.Q27_8.sha256, value: { taskId: sourceBinding.sourceTaskId,
      status: 'PASS', runId: sourceProofBindings.Q27_8.runId, error: null } },
  commandEvidence: sourceCommandBundle,
  q279Rtm: { path: sourceProofBindings.Q27_9.path, bytes: sourceProofBindings.Q27_9.bytes,
    sha256: sourceProofBindings.Q27_9.sha256, value: { taskId: sourceBinding.sourceTaskId,
      parsedCount: 109, idsComplete: true,
      mappingStatusCounts: { PASS: 33, BLOCKED: 76, FAIL: 0 },
      functionalAcceptanceCounts: { UNVERIFIED: 103, SUBSCENARIO_PASS_PENDING_FULL_ACCEPTANCE: 6 } } },
  sourceExecutionRows: [sourceRun('Q27.7'),
    sourceRun('Q27.8', 'PASS', { evidencePath: sourceProofBindings.Q27_8.path }),
    sourceRun('Q27.9', 'PASS', { summaryPath: sourceProofBindings.Q27_9.path })]
};
const acceptedR5SourceProofs = verifyStage27R5SourceAcceptance(sourceAcceptanceBundle);
assert.deepEqual(acceptedR5SourceProofs.map(item => [item.quest, item.status, item.evidenceOrigin,
  item.sourceTaskId, item.actualSourceExitCode]), [
  ['Q27.7', 'PASS', 'source_independent_acceptance', sourceBinding.sourceTaskId, 0],
  ['Q27.8', 'PASS', 'source_independent_acceptance', sourceBinding.sourceTaskId, 0],
  ['Q27.9', 'PASS', 'source_independent_acceptance', sourceBinding.sourceTaskId, 0]
]);
const readReference = reference => {
  const bytes = fs.readFileSync(path.resolve(projectRoot, reference.path));
  return { path: reference.path, bytes: bytes.length, sha256: hash(bytes), value: JSON.parse(bytes.toString('utf8')) };
};
const metadataHandoff = readReference(STAGE27_R5_ROW_PROVENANCE_HANDOFF);
const compatibilityNote = readReference(STAGE27_R5_ROW_PROVENANCE_HANDOFF.compatibilityNote);
const originalProofHandoff = readReference(STAGE27_R5_ROW_PROVENANCE_HANDOFF.originalProofBindingHandoff);
const sourceLedgerPath = STAGE27_R5_ROW_PROVENANCE_HANDOFF.currentSourceLedger.path;
const sourceLedgerBytes = fs.readFileSync(sourceLedgerPath);
const workerSourceLedgerWindow = verifyStage27R5SourceLedgerWindow({
  executorIdentity: workerIdentity, metadataHandoff, originalProofHandoff, compatibilityNote,
  sourceLedgerPath, sourceLedgerBytes
});
assert.deepEqual({ bytes: workerSourceLedgerWindow.observedBytes, sha256: workerSourceLedgerWindow.observedSha256,
  appendedSourceRunCount: workerSourceLedgerWindow.appendedSourceRunCount, executorRole: workerSourceLedgerWindow.executorRole }, {
  bytes: STAGE27_R5_ROW_PROVENANCE_HANDOFF.currentSourceLedger.bytes,
  sha256: STAGE27_R5_ROW_PROVENANCE_HANDOFF.currentSourceLedger.sha256,
  appendedSourceRunCount: 0, executorRole: 'worker'
}, 'worker sees the exact current source ledger while retaining its older source-proof prefix');
assert.throws(() => verifyStage27R5SourceLedgerWindow({
  executorIdentity: workerIdentity, metadataHandoff: { ...metadataHandoff, sha256: '0'.repeat(64) },
  originalProofHandoff, compatibilityNote, sourceLedgerPath, sourceLedgerBytes
}), /row-provenance\/document-repair handoff path\/bytes\/SHA/u,
'a changed source metadata handoff SHA is rejected');
const sourceOwnedAppend = Buffer.from(`${JSON.stringify({ taskId: sourceBinding.sourceTaskId,
  runId: `${sourceBinding.sourceTaskId}-Q27.9-fixture`, quest: 'Q27.9', status: 'PASS' })}\n`);
const sourceAppendWindow = verifyStage27R5SourceLedgerWindow({
  executorIdentity: sourceIdentity, metadataHandoff, originalProofHandoff, compatibilityNote,
  sourceLedgerPath, sourceLedgerBytes: Buffer.concat([sourceLedgerBytes, sourceOwnedAppend])
});
assert.equal(sourceAppendWindow.appendedSourceRunCount, 1,
  'the source may append its own complete Q27 run while preserving both frozen prefixes');
assert.throws(() => verifyStage27R5SourceLedgerWindow({
  executorIdentity: sourceIdentity, metadataHandoff, originalProofHandoff, compatibilityNote,
  sourceLedgerPath, sourceLedgerBytes: Buffer.concat([sourceLedgerBytes, Buffer.from(`${JSON.stringify({
    taskId: sourceBinding.workerTaskId, runId: 'worker-forged-run', quest: 'Q27.9', status: 'PASS' })}\n`)])
}), /appended source ledger row 1 is not an actual source-owned Q27 run/u,
'a worker-authored row cannot be appended under the source identity');
assert.throws(() => verifyStage27R5SourceLedgerWindow({
  executorIdentity: workerIdentity, metadataHandoff, originalProofHandoff, compatibilityNote,
  sourceLedgerPath, sourceLedgerBytes: Buffer.concat([sourceLedgerBytes, sourceOwnedAppend])
}), /worker must leave the accepted current source ledger byte-for-byte unchanged/u,
'worker cannot append to the current source ledger');
const sourceRecordFor = quest => ({
  ...acceptedR5SourceProofs.find(record => record.quest === quest),
  sourceLedgerBinding: workerSourceLedgerWindow
});
const sourceRowRecords = new Map([['Q27.7', sourceRecordFor('Q27.7')], ['Q27.8', sourceRecordFor('Q27.8')]]);
for (const [rowId, quest] of [[1, 'Q27.8'], [109, 'Q27.8'], [30, 'Q27.7'], [51, 'Q27.7']]) {
  const rowEvidence = buildStage27R5RowSourceEvidence({ rowId, latestRecords: sourceRowRecords });
  assert.deepEqual(rowEvidence.quests, [quest], `RTM ${rowId} only receives its directly mapped source scenario`);
  assert.equal(rowEvidence.sourceEvidence[0].sourceTaskId, sourceBinding.sourceTaskId);
  assert.equal(rowEvidence.sourceEvidence[0].evidenceOrigin, 'source_independent_acceptance');
  assert.equal(rowEvidence.sourceEvidence[0].actualSourceExitCode, 0);
}
assert.deepEqual(buildStage27R5RowSourceEvidence({ rowId: 1, latestRecords: sourceRowRecords, enabled: false }),
  { quests: [], sourceEvidence: [] }, 'non-R5 invocations cannot add R5 source sub-scenarios');
assert.deepEqual(buildStage27R5RowSourceEvidence({ rowId: 9, latestRecords: sourceRowRecords }),
  { quests: [], sourceEvidence: [] }, 'unmapped RTM rows do not inherit an R5 source sub-scenario');
assert.deepEqual(buildStage27R5RowSourceEvidence({ rowId: 30,
  latestRecords: new Map([['Q27.7', { ...sourceRecordFor('Q27.7'), evidenceOrigin: 'worker_self_validation' }]]) }),
{ quests: [], sourceEvidence: [] }, 'worker self-validation cannot become row-level source evidence');
for (const [label, mutation, pattern] of [
  ['actor', record => ({ ...record, sourceTaskId: sourceBinding.workerTaskId }), /Q27\.8 row provenance actor\/run\/command\/source-proof binding/u],
  ['run', record => ({ ...record, runId: 'wrong-source-run' }), /Q27\.8 row provenance actor\/run\/command\/source-proof binding/u],
  ['proof path', record => ({ ...record, sourceProofPath: 'output/other-proof.json' }), /Q27\.8 row provenance actor\/run\/command\/source-proof binding/u],
  ['evidence SHA', record => ({ ...record, actualEvidenceSha256: '0'.repeat(64) }), /Q27\.8 row provenance evidence path\/bytes\/SHA/u],
  ['command SHA', record => ({ ...record, commandEvidenceSha256: '0'.repeat(64) }), /Q27\.8 row provenance command-evidence path\/bytes\/SHA/u],
  ['ledger snapshot SHA', record => ({ ...record, sourceLedgerBinding: { ...record.sourceLedgerBinding,
    currentSnapshot: { ...record.sourceLedgerBinding.currentSnapshot, sha256: '0'.repeat(64) } } }),
  /Q27\.8 row provenance source-ledger current snapshot or original prefix/u]
]) {
  const record = mutation(sourceRecordFor('Q27.8'));
  assert.throws(() => buildStage27R5RowSourceEvidence({ rowId: 1,
    latestRecords: new Map([['Q27.8', record]]) }), pattern, `wrong source ${label} is rejected`);
}
assert.throws(() => verifyStage27R5SourceAcceptance({ ...sourceAcceptanceBundle,
  q277Proof: { ...sourceAcceptanceBundle.q277Proof,
    value: { ...sourceAcceptanceBundle.q277Proof.value, sourceTaskId: sourceBinding.workerTaskId } }
}), /source Q27\.7 actor/u, 'worker identity cannot be relabeled as the accepted source Q27.7 run');
assert.throws(() => verifyStage27R5SourceAcceptance({ ...sourceAcceptanceBundle,
  q278Proof: { ...sourceAcceptanceBundle.q278Proof,
    value: { ...sourceAcceptanceBundle.q278Proof.value, error: 'stale first-attempt error' } }
}), /source Q27\.8 actor, run, status, or error/u, 'Q27.8 PASS cannot inherit an earlier attempt error');
assert.throws(() => verifyStage27R5SourceAcceptance({ ...sourceAcceptanceBundle,
  commandEvidence: { ...sourceCommandBundle, sha256: '0'.repeat(64) }
}), /source actual command evidence path\/bytes\/SHA/u, 'changed command-evidence SHA is rejected');
assert.throws(() => verifyStage27R5SourceAcceptance({ ...sourceAcceptanceBundle,
  q279Rtm: { ...sourceAcceptanceBundle.q279Rtm,
    value: { ...sourceAcceptanceBundle.q279Rtm.value, taskId: sourceBinding.workerTaskId } }
}), /source Q27\.9 RTM actor/u, 'worker Q27.9 evidence cannot impersonate source Q27.9 evidence');
const retainedWorkerFailure = retainStage27R5ExecutorObservation(acceptedR5SourceProofs[1], {
  taskId: sourceBinding.workerTaskId, quest: 'Q27.8', status: 'FAIL', runId: 'worker-old-q278-fail',
  error: 'Cannot access businessClock before initialization'
}, workerIdentity);
assert.equal(retainedWorkerFailure.status, 'PASS');
assert.equal(retainedWorkerFailure.error, null);
assert.equal(retainedWorkerFailure.workerObservation.status, 'FAIL');
assert.equal(retainedWorkerFailure.workerObservation.evidenceOrigin, 'worker_self_validation');
assert.equal(retainedWorkerFailure.sourceTaskId, sourceBinding.sourceTaskId);
const retainedWorkerQ279 = retainStage27R5ExecutorObservation(acceptedR5SourceProofs[2], {
  taskId: sourceBinding.workerTaskId, quest: 'Q27.9', status: 'PASS', runId: 'worker-q279-run', parsedCount: 109
}, workerIdentity);
assert.equal(retainedWorkerQ279.evidenceOrigin, 'source_independent_acceptance');
assert.equal(retainedWorkerQ279.sourceTaskId, sourceBinding.sourceTaskId);
assert.equal(retainedWorkerQ279.workerObservation.runId, 'worker-q279-run');

const knownChrome = { pid: 7081, startTime: 'Thu Oct  1 17:27:01 2026',
  fingerprint: 'a30da864807c765187c20eb24b90dfaedb6d8273c8675d112e09016b42ec949d' };
const knownVsCode = { pid: 67464, startTime: 'Thu Oct  8 10:04:43 2026',
  fingerprint: '5e8fbacc04ae022967ad83f46440dc1e63db1170cd175bb7bce9f24813dbbf37' };
assert.equal(assertProtectedProcessIdentity(knownChrome, knownChrome, 'Chrome').pid, 7081);
assert.equal(assertProtectedProcessIdentity(knownVsCode, knownVsCode, 'VS Code').pid, 67464);
assert.throws(() => assertProtectedProcessIdentity({ ...knownVsCode,
  fingerprint: '5e8fbacc188b821703db5d01c36edb643c0c884a18acc9707915a581b7cda712' }, knownVsCode, 'VS Code'),
/fingerprint changed/u, 'the source-reviewed stale fingerprint is rejected');
assert.throws(() => assertProtectedProcessIdentity({ ...knownVsCode, pid: 77777 }, knownVsCode, 'VS Code'),
  /PID changed/u, 'a reused/unknown PID is rejected');
assert.throws(() => assertProtectedProcessIdentity({ ...knownVsCode, startTime: 'Thu Oct  9 10:04:43 2026' }, knownVsCode, 'VS Code'),
  /start time changed/u, 'a process with a different birth time is rejected');
assert.throws(() => assertProtectedProcessIdentity(null, knownVsCode, 'VS Code'),
  /absent/u, 'an absent identity is not trusted');

const originalTimezonePresent = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
const originalTimezone = process.env.TZ;
const callerTimezones = [
  { name: 'UTC', value: 'UTC' },
  { name: 'Asia/Shanghai', value: 'Asia/Shanghai' },
  { name: 'unset', value: null }
];
let productionTimezoneIdentityPassCases = 0;
let productionTimezoneIdentityRejectCases = 0;
let timezoneRestorationCases = 0;
let timezoneExceptionRestorationCases = 0;
function setCallerTimezone(value) {
  if (value === null) delete process.env.TZ;
  else process.env.TZ = value;
}
function assertCallerTimezone(value, label) {
  if (value === null) assert.equal(Object.prototype.hasOwnProperty.call(process.env, 'TZ'), false, label);
  else assert.equal(process.env.TZ, value, label);
}
try {
  for (const caller of callerTimezones) {
    setCallerTimezone(caller.value);
    for (const [identity, label] of [[knownChrome, 'Chrome'], [knownVsCode, 'VS Code']]) {
      const sampled = sampleProtectedProcessIdentity(identity, `${label} actual production timezone sample`, pid => {
        assert.equal(process.env.TZ, 'Asia/Shanghai', 'production sampler sets Shanghai TZ around processIdentity');
        return processIdentity(pid);
      });
      assert.deepEqual({ pid: sampled.pid, startTime: sampled.startTime, fingerprint: sampled.fingerprint }, identity,
        `${label} frozen PID/start/fingerprint match in caller TZ ${caller.name}`);
      assertCallerTimezone(caller.value, `${label} caller TZ ${caller.name} is restored after sampling`);
      productionTimezoneIdentityPassCases += 1;
      timezoneRestorationCases += 1;
    }
  }

  const injectedIdentityFailures = [
    { name: 'PID', actual: { ...knownVsCode, pid: knownVsCode.pid + 1 }, pattern: /PID changed/u },
    { name: 'start time', actual: { ...knownVsCode, startTime: 'Thu Oct  9 10:04:43 2026' }, pattern: /start time changed/u },
    { name: 'fingerprint', actual: { ...knownVsCode, fingerprint: '0'.repeat(64) }, pattern: /fingerprint changed/u },
    { name: 'missing identity', actual: null, pattern: /absent/u }
  ];
  for (const [index, failure] of injectedIdentityFailures.entries()) {
    const caller = callerTimezones[index % callerTimezones.length];
    setCallerTimezone(caller.value);
    assert.throws(() => sampleProtectedProcessIdentity(knownVsCode,
      `injected ${failure.name} production sampler rejection`, pid => {
        assert.equal(process.env.TZ, 'Asia/Shanghai', 'production sampler keeps the normalized TZ during injected samples');
        assert.equal(pid, knownVsCode.pid, 'production sampler requests the frozen PID');
        return failure.actual;
      }), failure.pattern, `${failure.name} mismatch is rejected by production sampler`);
    assertCallerTimezone(caller.value, `${failure.name} rejection restores caller TZ ${caller.name}`);
    productionTimezoneIdentityRejectCases += 1;
    timezoneRestorationCases += 1;
  }

  for (const caller of callerTimezones) {
    setCallerTimezone(caller.value);
    assert.throws(() => sampleProtectedProcessIdentity(knownChrome, 'injected sampler exception', () => {
      assert.equal(process.env.TZ, 'Asia/Shanghai', 'production sampler sets normalized TZ before a throwing read');
      throw new Error('injected processIdentity read failure');
    }), /injected processIdentity read failure/u);
    assertCallerTimezone(caller.value, `exception path restores caller TZ ${caller.name}`);
    timezoneExceptionRestorationCases += 1;
  }
} finally {
  if (originalTimezonePresent) process.env.TZ = originalTimezone;
  else delete process.env.TZ;
}

const q27SourcePath = path.join(projectRoot, 'scripts/quests/q27.js');
const q27Source = fs.readFileSync(q27SourcePath, 'utf8');
const order = assertQ278InitializationOrder(q27Source);
for (const variable of ['date', 'businessClock']) {
  const signature = 'async function runQ278({ resourceSession }) {';
  assert.ok(q27Source.includes(signature), 'the expected Q27.8 runner signature remains present');
  const withEarlyUse = q27Source.replace(signature, `${signature}\n  const offlinePreUse = ${variable};`);
  assert.throws(() => assertQ278InitializationOrder(withEarlyUse), new RegExp(`uses ${variable} before its initialization`, 'u'),
    `${variable} use-before-initialization is rejected by the offline check`);
}

const sourceProofBytes = fs.readFileSync(sourceProofPath);
const sourceProof = JSON.parse(sourceProofBytes.toString('utf8'));
const q276 = sourceProof.q276;
const sourceEnvironmentOutcome = { questId: 'Q27.6', status: q276.status,
  evidenceOrigin: 'source_independent_acceptance', sourceTaskId: sourceProof.sourceTaskId,
  sourceProofPath: path.relative(projectRoot, sourceProofPath), sourceProofSha256: hash(sourceProofBytes) };
const sourceEnvironmentEvidence = { sourceTaskId: sourceProof.sourceTaskId, status: q276.status, mode: q276.mode,
  dataChecksStatus: q276.dataChecks.status, hourlyCounts: q276.dataChecks.hourlyCounts,
  snapshotReused: q276.snapshotReuse.sameSnapshotId,
  stationCredentialsRequired: q276.stationCredentialsRequired,
  sourceProofPath: path.relative(projectRoot, sourceProofPath), sourceProofSha256: hash(sourceProofBytes) };
const outcomeFor = (title, originalRtmName, requirement, evidenceText = 'Q27.6') => deriveEnvironmentFunctionalAcceptance({
  mappingTitle: title, originalRtmName, requirement, currentEvidenceText: evidenceText,
  currentStage27Outcomes: [sourceEnvironmentOutcome], sourceEnvironmentProof: sourceEnvironmentEvidence
});
const stateBar = outcomeFor('潮汐与海况状态条', '潮汐与海况状态条', '展示状态摘要并可展开曲线。');
const weatherCard = outcomeFor('天气与潮汐海况卡', '天气与潮汐海况卡', '展示天气与模式海面高度。');
const safetyGate = outcomeFor('潮汐安全校验', '潮汐安全校验', '校验下海预约的安全阈值。');
assert.equal(stateBar?.status, 'SUBSCENARIO_PASS_PENDING_FULL_ACCEPTANCE');
assert.equal(weatherCard?.status, 'SUBSCENARIO_PASS_PENDING_FULL_ACCEPTANCE');
assert.equal(safetyGate?.status, 'UNVERIFIED');
assert.equal(deriveEnvironmentFunctionalAcceptance({ mappingTitle: '天气与潮汐海况卡', originalRtmName: '天气与潮汐海况卡',
  requirement: '显示数据。', currentEvidenceText: 'A43; E1–E3; T3', futureQuestPlan: 'Q27.6',
  currentStage27Outcomes: [sourceEnvironmentOutcome], sourceEnvironmentProof: sourceEnvironmentEvidence }), null,
  'a future-Quest column without a current Q27.6 evidence citation is not accepted');
assert.equal(deriveEnvironmentFunctionalAcceptance({ mappingTitle: '天气与潮汐海况卡', originalRtmName: '天气与潮汐海况卡',
  requirement: '显示数据。', currentEvidenceText: 'Q27.6',
  currentStage27Outcomes: [{ ...sourceEnvironmentOutcome, evidenceOrigin: 'worker_self_validation' }],
  sourceEnvironmentProof: sourceEnvironmentEvidence }), null, 'worker self-validation cannot create a source sub-scenario');
const changedHourlyEvidence = { ...sourceEnvironmentEvidence, hourlyCounts: { ...sourceEnvironmentEvidence.hourlyCounts, marine: 23 } };
assert.equal(deriveEnvironmentFunctionalAcceptance({ mappingTitle: '天气与潮汐海况卡', originalRtmName: '天气与潮汐海况卡',
  requirement: '显示数据。', currentEvidenceText: 'Q27.6', currentStage27Outcomes: [sourceEnvironmentOutcome],
  sourceEnvironmentProof: changedHourlyEvidence }), null, 'incomplete hourly data cannot create the bounded data sub-scenario');
const mismatchedSourceProof = { ...sourceEnvironmentEvidence, sourceTaskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
assert.equal(deriveEnvironmentFunctionalAcceptance({ mappingTitle: '天气与潮汐海况卡', originalRtmName: '天气与潮汐海况卡',
  requirement: '显示数据。', currentEvidenceText: 'Q27.6', currentStage27Outcomes: [sourceEnvironmentOutcome],
  sourceEnvironmentProof: mismatchedSourceProof }), null, 'environment proof from another source task is rejected');

console.log(JSON.stringify({ status: 'PASS', fixtureType: 'offline-only',
  baselineSha256: offlineBaselineSha256, executorAccepts: ['source', 'worker'], executorRejectCases: 6,
  protectedIdentityPassCases: 2, protectedIdentityRejectCases: 4,
  productionTimezoneIdentityPassCases, productionTimezoneIdentityRejectCases,
  timezoneCallerEnvironments: callerTimezones.map(item => item.name), timezoneRestorationCases, timezoneExceptionRestorationCases,
  q278InitializerCheck: order, q278EarlyUseRejectCases: 2,
  sourceR5AcceptedProofs: acceptedR5SourceProofs.map(item => ({ quest: item.quest,
    evidenceOrigin: item.evidenceOrigin, sourceTaskId: item.sourceTaskId, exitCode: item.actualSourceExitCode })),
  sourceR5RejectedCases: 4, sourceLedgerWindow: {
    workerCurrentSnapshotExact: workerSourceLedgerWindow.observedSha256 === STAGE27_R5_ROW_PROVENANCE_HANDOFF.currentSourceLedger.sha256,
    originalSourceProofPrefixRetained: workerSourceLedgerWindow.originalSourceProofPrefix.sha256 === 'abb8de82a8b7875011cc73ada60fe44d3126b9bbf2d8e6e0078ee07915f98336',
    sourceOwnedAppendAccepted: sourceAppendWindow.appendedSourceRunCount === 1,
    workerAppendRejected: true, wrongSourceActorRejected: true, wrongMetadataHandoffRejected: true
  }, rowLevelSourceProvenance: {
    directlyMappedRows: [1, 30, 51, 109], workerSelfValidationIgnored: true,
    wrongActorRunProofPathEvidenceShaCommandShaLedgerShaRejected: true,
    nonR5AndUnmappedRowsRemainEmpty: true
  }, workerObservationIsolation: {
    oldQ278FailDoesNotContaminateSourcePass: retainedWorkerFailure.status === 'PASS'
      && retainedWorkerFailure.workerObservation.status === 'FAIL',
    workerQ279RemainsSeparate: retainedWorkerQ279.evidenceOrigin === 'source_independent_acceptance'
      && retainedWorkerQ279.workerObservation.runId === 'worker-q279-run'
  },
  environmentClassification: { statusBar: stateBar.status, weatherCard: weatherCard.status, safetyGate: safetyGate.status,
    futureQuestOnlyAccepted: false, workerEvidenceAcceptedAsSource: false, incompleteHourlyEvidenceAccepted: false,
    mismatchedSourceProofAccepted: false },
  providerCalls: 0, installAttempts: 0, servicesStarted: 0 }, null, 2));
