import crypto from 'node:crypto';
import path from 'node:path';

export const STAGE27_R5_OFFLINE_BASELINE = Object.freeze({
  bytes: 402212,
  sha256: '232bc87a0cc38391a14cebc523583a174352fa0e785b1be1d261a1fb50db825b'
});

export const STAGE27_R5_SOURCE_PACKAGING_HANDOFF = Object.freeze({
  recordType: 'source-r5-original-worker-ordinary-packaging-repair-handoff',
  sourceTaskId: '01a0cbfe-a161-72d0-992d-12fad655d4ef',
  workerTaskId: '01a126ea-4705-7771-ad75-e0d6ef0f4eb7',
  hostId: 'local',
  path: 'output/resource-audit/stage27-r5-source-sol-original-task-packaging-repair-handoff-baseline-20261011.json',
  bytes: 13786,
  sha256: '502357c75dcee3fa2b7e72ffcec48ec8bb6315aa1a9605cae54f92c6acb8d36b',
  sourceProofs: Object.freeze({
    Q27_7: Object.freeze({
      path: 'output/resource-audit/stage27-r5-source-sol-first-independent-q277-business-proof-20261011.json',
      bytes: 3798,
      sha256: '683473158778a9c09589cfc0a952135a94d7aae063578a282d6bca468fcfb921',
      runId: '01a0cbfe-a161-72d0-992d-12fad655d4ef-Q27.7-2026-10-10T18-55-29-890Z-28766-9ef64665-b056-40f9-a07d-37fed8a25670',
      command: 'CODEX_TASK_ID=01a0cbfe-a161-72d0-992d-12fad655d4ef CODEX_STAGE27_SCOPE=R5 npm run quest -- Q27.7',
      exitCode: 0,
      evidencePath: 'output/resource-audit/stage27-r5/01a0cbfe-a161-72d0-992d-12fad655d4ef/01a0cbfe-a161-72d0-992d-12fad655d4ef-Q27.7-2026-10-10T18-55-29-890Z-28766-9ef64665-b056-40f9-a07d-37fed8a25670-Q277-evidence.jsonl',
      evidenceBytes: 6983,
      evidenceSha256: '2f85c47597db532a7c747fc20bae3bffd34a95f6c475501bdd2c98db81646d2b'
    }),
    Q27_8: Object.freeze({
      path: 'output/resource-audit/stage27-r5/01a0cbfe-a161-72d0-992d-12fad655d4ef/01a0cbfe-a161-72d0-992d-12fad655d4ef-Q27.8-2026-10-11T02-46-30-804Z-633-64323b8d-430e-4273-90e9-b117677c91c6-q278-clean-delivery.json',
      bytes: 54769,
      sha256: '2c496f06664407d4c62dfe46d78f9ac668cf29cd00192a8f8bba8c9ecc46c1c5',
      runId: '01a0cbfe-a161-72d0-992d-12fad655d4ef-Q27.8-2026-10-11T02-46-30-804Z-633-64323b8d-430e-4273-90e9-b117677c91c6',
      command: 'CODEX_TASK_ID=01a0cbfe-a161-72d0-992d-12fad655d4ef CODEX_STAGE27_SCOPE=R5 npm run quest -- Q27.8',
      exitCode: 0
    }),
    Q27_9: Object.freeze({
      path: 'output/resource-audit/stage27-r5/01a0cbfe-a161-72d0-992d-12fad655d4ef/01a0cbfe-a161-72d0-992d-12fad655d4ef-Q27.9-2026-10-11T02-49-05-620Z-33573-8a12d3d9-be3a-48de-ac33-3aecfaec4a0c-rtm109-evidence.json',
      bytes: 1412887,
      sha256: '9080fc32608757eadb9178c1042b586cc43c744c6ab161f8670bf92d77a6b364',
      runId: '01a0cbfe-a161-72d0-992d-12fad655d4ef-Q27.9-2026-10-11T02-49-05-620Z-33573-8a12d3d9-be3a-48de-ac33-3aecfaec4a0c',
      command: 'CODEX_TASK_ID=01a0cbfe-a161-72d0-992d-12fad655d4ef CODEX_STAGE27_SCOPE=R5 npm run quest -- Q27.9',
      exitCode: 0
    }),
    commandEvidence: Object.freeze({
      path: 'output/resource-audit/stage27-r5-source-sol-third-cold-and-aggregate-actual-command-evidence-20261011.json',
      bytes: 5524,
      sha256: '73f72bf928d98c4ce0dae331d2e42a6f81b25e35198f8e603aa81335937d7914'
    }),
    sourceExecutionLedgerPath: 'output/resource-audit/stage27-r5/01a0cbfe-a161-72d0-992d-12fad655d4ef/execution-ledger.jsonl'
  })
});

export const STAGE27_R5_ROW_PROVENANCE_HANDOFF = Object.freeze({
  path: 'output/resource-audit/stage27-r5-source-sol-per-row-provenance-and-document-repair-handoff-baseline-20261011.json',
  bytes: 13368,
  sha256: '7dc5debfc8a9dfbb32ab35ceefbe2a62f5f8a311c168c4b30bb01f609a80344b',
  originalProofBindingHandoff: Object.freeze({
    path: 'output/resource-audit/stage27-r5-source-sol-original-task-packaging-repair-handoff-baseline-20261011.json',
    bytes: 13786,
    sha256: '502357c75dcee3fa2b7e72ffcec48ec8bb6315aa1a9605cae54f92c6acb8d36b'
  }),
  compatibilityNote: Object.freeze({
    path: 'output/resource-audit/stage27-r5-source-sol-source-ledger-append-compatibility-handoff-note-20261011.json',
    bytes: 1588,
    sha256: '3cc34c595d6225d3850bff3480344d0e17b16a64d5dd342f09080c0e8655a022'
  }),
  currentSourceLedger: Object.freeze({
    path: '/Users/wangshanchong/.codex/worktrees/dfa3/haiyu_wellness/项目源码/output/resource-audit/stage27-r5/01a0cbfe-a161-72d0-992d-12fad655d4ef/execution-ledger.jsonl',
    bytes: 85428,
    sha256: '2a20f36b91742ebb6841e70f2816bf7d9524379906bbd4778307ee5e3a04b7fa'
  }),
  originalSourceProofLedgerPrefix: Object.freeze({
    path: '/Users/wangshanchong/.codex/worktrees/dfa3/haiyu_wellness/项目源码/output/resource-audit/stage27-r5/01a0cbfe-a161-72d0-992d-12fad655d4ef/execution-ledger.jsonl',
    bytes: 81154,
    sha256: 'abb8de82a8b7875011cc73ada60fe44d3126b9bbf2d8e6e0078ee07915f98336'
  })
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UNRESOLVED_WORKER_ID = 'TO_BE_RESOLVED_FROM_APP_FORK_RECEIPT';

function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}

function requireExactR5Reference(actual, expected, label) {
  requireThat(actual && path.resolve(actual.path) === path.resolve(expected.path)
    && actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
  `${label} path/bytes/SHA differ from the frozen source handoff`);
}

export function verifyStage27R5SourceLedgerWindow({
  executorIdentity,
  metadataHandoff,
  originalProofHandoff,
  compatibilityNote,
  sourceLedgerPath,
  sourceLedgerBytes
}) {
  const expected = STAGE27_R5_ROW_PROVENANCE_HANDOFF;
  const sourceTaskId = STAGE27_R5_SOURCE_PACKAGING_HANDOFF.sourceTaskId;
  const workerTaskId = STAGE27_R5_SOURCE_PACKAGING_HANDOFF.workerTaskId;
  requireExactR5Reference(metadataHandoff, expected, 'row-provenance/document-repair handoff');
  requireExactR5Reference(originalProofHandoff, expected.originalProofBindingHandoff, 'original proof-binding handoff');
  requireExactR5Reference(compatibilityNote, expected.compatibilityNote, 'source-ledger compatibility note');
  requireThat(metadataHandoff.value?.sourceTaskId === sourceTaskId
    && metadataHandoff.value?.workerTaskId === workerTaskId,
  'row-provenance handoff source/worker identities differ from the frozen task pair');
  requireThat(path.resolve(metadataHandoff.value?.originalProofBindingHandoff?.path || '')
    === path.resolve(expected.originalProofBindingHandoff.path)
    && metadataHandoff.value.originalProofBindingHandoff.bytes === expected.originalProofBindingHandoff.bytes
    && metadataHandoff.value.originalProofBindingHandoff.sha256 === expected.originalProofBindingHandoff.sha256,
  'row-provenance handoff does not retain the original proof-binding file');
  requireThat(path.resolve(metadataHandoff.value?.sourceLedgerAppendCompatibilityNote?.path || '')
    === path.resolve(expected.compatibilityNote.path)
    && metadataHandoff.value.sourceLedgerAppendCompatibilityNote.bytes === expected.compatibilityNote.bytes
    && metadataHandoff.value.sourceLedgerAppendCompatibilityNote.sha256 === expected.compatibilityNote.sha256,
  'row-provenance handoff does not retain the source-ledger compatibility note');

  const current = metadataHandoff.value?.sourceExecutionLedgerMustStayExactDuringThisWorker;
  const original = metadataHandoff.value?.originalSourceProofLedgerPrefixMustRemain;
  requireExactR5Reference(current, expected.currentSourceLedger, 'worker-time source-ledger snapshot');
  requireExactR5Reference(original, expected.originalSourceProofLedgerPrefix, 'original source-proof ledger prefix');
  requireThat(path.resolve(compatibilityNote.value?.oldFrozenProofLedger?.path || '')
    === path.resolve(expected.originalSourceProofLedgerPrefix.path)
    && compatibilityNote.value.oldFrozenProofLedger.bytes === expected.originalSourceProofLedgerPrefix.bytes
    && compatibilityNote.value.oldFrozenProofLedger.sha256 === expected.originalSourceProofLedgerPrefix.sha256,
  'compatibility note changed the original source-proof ledger prefix');
  requireThat(path.resolve(compatibilityNote.value?.currentSourceLedgerAfterActualSourceAcceptance?.path || '')
    === path.resolve(expected.currentSourceLedger.path)
    && compatibilityNote.value.currentSourceLedgerAfterActualSourceAcceptance.bytes === expected.currentSourceLedger.bytes
    && compatibilityNote.value.currentSourceLedgerAfterActualSourceAcceptance.sha256 === expected.currentSourceLedger.sha256,
  'compatibility note changed the accepted current source-ledger snapshot');

  requireThat(path.resolve(sourceLedgerPath) === path.resolve(expected.currentSourceLedger.path),
    'source execution ledger path differs from both frozen source bindings');
  requireThat(Buffer.isBuffer(sourceLedgerBytes), 'source execution ledger snapshot must be read as bounded bytes');
  requireThat(sourceLedgerBytes.length >= expected.currentSourceLedger.bytes,
    'source execution ledger is shorter than the latest accepted source snapshot');
  const currentPrefixSha256 = crypto.createHash('sha256')
    .update(sourceLedgerBytes.subarray(0, expected.currentSourceLedger.bytes)).digest('hex');
  requireThat(currentPrefixSha256 === expected.currentSourceLedger.sha256,
    'source execution ledger no longer retains the latest accepted source snapshot');
  const originalPrefixSha256 = crypto.createHash('sha256')
    .update(sourceLedgerBytes.subarray(0, expected.originalSourceProofLedgerPrefix.bytes)).digest('hex');
  requireThat(originalPrefixSha256 === expected.originalSourceProofLedgerPrefix.sha256,
    'source execution ledger no longer retains the original source-proof prefix');

  const fullSha256 = crypto.createHash('sha256').update(sourceLedgerBytes).digest('hex');
  let appendedSourceRows = [];
  if (executorIdentity?.role === 'worker' && executorIdentity.taskId === workerTaskId) {
    requireThat(sourceLedgerBytes.length === expected.currentSourceLedger.bytes
      && fullSha256 === expected.currentSourceLedger.sha256,
    'worker must leave the accepted current source ledger byte-for-byte unchanged');
  } else if (executorIdentity?.role === 'source' && executorIdentity.taskId === sourceTaskId) {
    const suffix = sourceLedgerBytes.subarray(expected.currentSourceLedger.bytes);
    if (suffix.length) {
      requireThat(suffix.at(-1) === 0x0a, 'source-owned appended ledger rows must end on a complete JSONL line');
      appendedSourceRows = suffix.toString('utf8').slice(0, -1).split('\n').map((line, index) => {
        requireThat(line.length > 0, `source-owned appended ledger row ${index + 1} is empty`);
        let row;
        try { row = JSON.parse(line); } catch { throw new Error(`source-owned appended ledger row ${index + 1} is invalid JSON`); }
        requireThat(row.taskId === sourceTaskId && typeof row.runId === 'string' && row.runId.length > 0
          && typeof row.quest === 'string' && /^Q27\.(?:[1-9]|aggregate)$/u.test(row.quest),
        `appended source ledger row ${index + 1} is not an actual source-owned Q27 run`);
        return row;
      });
    }
  } else {
    requireThat(false, 'source-ledger window has neither the frozen source nor worker executor identity');
  }
  return {
    sourceTaskId,
    workerTaskId,
    currentSnapshot: { path: expected.currentSourceLedger.path, bytes: expected.currentSourceLedger.bytes,
      sha256: expected.currentSourceLedger.sha256 },
    originalSourceProofPrefix: { path: expected.originalSourceProofLedgerPrefix.path,
      bytes: expected.originalSourceProofLedgerPrefix.bytes, sha256: expected.originalSourceProofLedgerPrefix.sha256 },
    observedBytes: sourceLedgerBytes.length,
    observedSha256: fullSha256,
    appendedSourceRunCount: appendedSourceRows.length,
    executorRole: executorIdentity.role
  };
}

export function buildStage27R5RowSourceEvidence({ rowId, latestRecords, enabled = true }) {
  if (!enabled) return { quests: [], sourceEvidence: [] };
  const quest = [30, 51].includes(rowId) ? 'Q27.7' : [1, 109].includes(rowId) ? 'Q27.8' : null;
  if (!quest) return { quests: [], sourceEvidence: [] };
  const record = latestRecords?.get(quest);
  if (record?.status !== 'PASS' || record.evidenceOrigin !== 'source_independent_acceptance') {
    return { quests: [], sourceEvidence: [] };
  }
  const expected = STAGE27_R5_SOURCE_PACKAGING_HANDOFF;
  const proof = expected.sourceProofs[quest.replace('.', '_')];
  const expectedEvidence = quest === 'Q27.7'
    ? { path: proof.evidencePath, bytes: proof.evidenceBytes, sha256: proof.evidenceSha256 }
    : { path: proof.path, bytes: proof.bytes, sha256: proof.sha256 };
  requireThat(record.sourceTaskId === expected.sourceTaskId
    && record.acceptanceExecutor?.taskId === expected.sourceTaskId
    && record.acceptanceExecutor?.role === 'source'
    && record.runId === proof.runId && record.actualSourceExitCode === 0
    && record.actualSourceCommand === proof.command
    && record.sourceProofPath === proof.path && record.sourceProofBytes === proof.bytes
    && record.sourceProofSha256 === proof.sha256,
  `${quest} row provenance actor/run/command/source-proof binding is invalid`);
  requireThat(record.actualEvidencePath === expectedEvidence.path
    && record.actualEvidenceBytes === expectedEvidence.bytes
    && record.actualEvidenceSha256 === expectedEvidence.sha256,
  `${quest} row provenance evidence path/bytes/SHA is invalid`);
  requireThat(record.commandEvidencePath === expected.sourceProofs.commandEvidence.path
    && record.commandEvidenceBytes === expected.sourceProofs.commandEvidence.bytes
    && record.commandEvidenceSha256 === expected.sourceProofs.commandEvidence.sha256,
  `${quest} row provenance command-evidence path/bytes/SHA is invalid`);
  const ledger = record.sourceLedgerBinding;
  requireThat(ledger?.sourceTaskId === expected.sourceTaskId && ledger.workerTaskId === expected.workerTaskId
    && path.resolve(ledger.currentSnapshot?.path || '') === path.resolve(STAGE27_R5_ROW_PROVENANCE_HANDOFF.currentSourceLedger.path)
    && ledger.currentSnapshot.bytes === STAGE27_R5_ROW_PROVENANCE_HANDOFF.currentSourceLedger.bytes
    && ledger.currentSnapshot.sha256 === STAGE27_R5_ROW_PROVENANCE_HANDOFF.currentSourceLedger.sha256
    && path.resolve(ledger.originalSourceProofPrefix?.path || '') === path.resolve(STAGE27_R5_ROW_PROVENANCE_HANDOFF.originalSourceProofLedgerPrefix.path)
    && ledger.originalSourceProofPrefix.bytes === STAGE27_R5_ROW_PROVENANCE_HANDOFF.originalSourceProofLedgerPrefix.bytes
    && ledger.originalSourceProofPrefix.sha256 === STAGE27_R5_ROW_PROVENANCE_HANDOFF.originalSourceProofLedgerPrefix.sha256,
  `${quest} row provenance source-ledger current snapshot or original prefix is invalid`);
  return {
    quests: [quest],
    sourceEvidence: [{
      quest, status: record.status, evidenceOrigin: record.evidenceOrigin,
      sourceTaskId: record.sourceTaskId, runId: record.runId,
      sourceProofPath: record.sourceProofPath, sourceProofBytes: record.sourceProofBytes,
      sourceProofSha256: record.sourceProofSha256,
      actualSourceCommand: record.actualSourceCommand, actualSourceExitCode: record.actualSourceExitCode,
      actualEvidencePath: record.actualEvidencePath, actualEvidenceBytes: record.actualEvidenceBytes,
      actualEvidenceSha256: record.actualEvidenceSha256,
      commandEvidencePath: record.commandEvidencePath, commandEvidenceBytes: record.commandEvidenceBytes,
      commandEvidenceSha256: record.commandEvidenceSha256,
      sourceLedgerBinding: ledger
    }]
  };
}

function protectedFile(manifest, filePath, label) {
  const expected = (manifest || []).find(item => path.resolve(item.path) === path.resolve(filePath));
  requireThat(expected, `${label} is not included in the frozen offline-repair manifest`);
  return expected;
}

export function assertProtectedProcessIdentity(actual, expected, label = 'protected process') {
  requireThat(expected && Number.isInteger(Number(expected.pid)) && expected.startTime && expected.fingerprint,
    `${label} has no complete frozen PID/start-time/fingerprint identity`);
  requireThat(actual, `${label} is absent; refusing to treat an unknown or reused PID as protected`);
  requireThat(Number(actual.pid) === Number(expected.pid), `${label} PID changed`);
  requireThat(actual.startTime === expected.startTime, `${label} process start time changed`);
  requireThat(actual.fingerprint === expected.fingerprint, `${label} process fingerprint changed`);
  return actual;
}

export function resolveStage27R5ExecutorIdentity({
  taskId,
  baseline,
  baselinePath,
  baselineBytes,
  baselineSha256,
  forkReceipt,
  forkReceiptPath,
  forkReceiptBytes,
  forkReceiptSha256,
  protectionBaseline,
  protectionBaselineBytes,
  protectionBaselineSha256
}) {
  requireThat(typeof taskId === 'string' && UUID.test(taskId), 'Stage27 R5 executor task ID is not a UUID');
  requireThat(protectionBaseline?.recordType === 'stage27-r5-source-sol-original-task-offline-repair-handoff-baseline',
    'R5 offline-repair protection baseline has an unexpected record type');
  requireThat(protectionBaselineBytes === STAGE27_R5_OFFLINE_BASELINE.bytes
    && protectionBaselineSha256 === STAGE27_R5_OFFLINE_BASELINE.sha256,
  'R5 offline-repair protection baseline bytes/SHA do not match the frozen source handoff');
  requireThat(protectionBaseline.sourceTaskId === '01a0cbfe-a161-72d0-992d-12fad655d4ef'
    && protectionBaseline.workerTaskId === '01a126ea-4705-7771-ad75-e0d6ef0f4eb7'
    && protectionBaseline.hostId === 'local', 'R5 offline-repair source/worker identities changed');
  requireThat(Array.isArray(protectionBaseline.allowedR5Executors)
    && protectionBaseline.allowedR5Executors.length === 2
    && protectionBaseline.allowedR5Executors.includes(protectionBaseline.sourceTaskId)
    && protectionBaseline.allowedR5Executors.includes(protectionBaseline.workerTaskId),
  'frozen R5 executor allowlist must contain exactly the source and its forked worker');

  const trusted = protectionBaseline.immutableProtectedEvidence;
  const baselineManifest = protectedFile(trusted, baselinePath, 'original R5 baseline');
  const forkManifest = protectedFile(trusted, forkReceiptPath, 'original App fork receipt');
  requireThat(baselineBytes === baselineManifest.bytes && baselineSha256 === baselineManifest.sha256,
    'original R5 baseline bytes/SHA differ from the frozen offline-repair manifest');
  requireThat(forkReceiptBytes === forkManifest.bytes && forkReceiptSha256 === forkManifest.sha256,
    'original App fork receipt bytes/SHA differ from the frozen offline-repair manifest');

  requireThat(baseline?.sourceTaskId === protectionBaseline.sourceTaskId,
    'original R5 baseline sourceTaskId differs from the frozen offline-repair baseline');
  requireThat(baseline?.newR5TaskId === UNRESOLVED_WORKER_ID
    || baseline?.newR5TaskId === protectionBaseline.workerTaskId,
  'original R5 baseline worker placeholder/resolution is not an accepted value');
  requireThat(forkReceipt?.recordType === 'stage27-r5-source-sol-app-fork-before-dispatch-receipt',
    'App fork receipt has an unexpected record type');
  requireThat(forkReceipt.sourceTaskId === protectionBaseline.sourceTaskId
    && forkReceipt.sourceHostId === protectionBaseline.hostId,
  'App fork receipt source identity is not bound to the frozen R5 source');
  requireThat(forkReceipt.workerTaskId === protectionBaseline.workerTaskId
    && forkReceipt.workerHostId === protectionBaseline.hostId,
  'App fork receipt worker identity is not the frozen R5 worker');
  requireThat(forkReceipt.appSynchronization === 'complete', 'App fork was not fully synchronized');
  requireThat(path.resolve(forkReceipt.baselinePath) === path.resolve(baselinePath),
    'App fork receipt names a different R5 baseline path');
  requireThat(forkReceipt.baselineSha256 === baselineSha256,
    'App fork receipt SHA does not match the actual original R5 baseline bytes');

  const role = taskId === protectionBaseline.sourceTaskId ? 'source'
    : taskId === forkReceipt.workerTaskId ? 'worker' : null;
  requireThat(role, 'Stage27 R5 executor task is neither the frozen source nor its verified App fork');
  return Object.freeze({ taskId, role,
    evidenceOrigin: role === 'source' ? 'source_independent_acceptance' : 'worker_self_validation',
    sourceTaskId: protectionBaseline.sourceTaskId, workerTaskId: forkReceipt.workerTaskId,
    hostId: protectionBaseline.hostId, baselinePath: path.resolve(baselinePath), baselineBytes,
    baselineSha256, forkReceiptPath: path.resolve(forkReceiptPath), forkReceiptBytes, forkReceiptSha256 });
}

export function deriveEnvironmentFunctionalAcceptance({
  mappingTitle,
  originalRtmName,
  requirement,
  currentEvidenceText,
  currentStage27Outcomes,
  sourceEnvironmentProof
}) {
  const q276 = (currentStage27Outcomes || []).find(item => item.questId === 'Q27.6');
  const citedCurrentProof = /\bQ27\.6\b/u.test(String(currentEvidenceText || ''));
  const verifiedDefaultProof = q276?.status === 'PASS'
    && q276.evidenceOrigin === 'source_independent_acceptance'
    && q276.sourceTaskId === sourceEnvironmentProof?.sourceTaskId
    && q276.sourceProofPath === sourceEnvironmentProof?.sourceProofPath
    && q276.sourceProofSha256 === sourceEnvironmentProof?.sourceProofSha256
    && sourceEnvironmentProof?.status === 'PASS'
    && sourceEnvironmentProof?.mode === 'Open-Meteo default modeled sea level including tides'
    && sourceEnvironmentProof?.dataChecksStatus === 'PASS'
    && sourceEnvironmentProof?.hourlyCounts?.weather === 24
    && sourceEnvironmentProof?.hourlyCounts?.marine === 24
    && sourceEnvironmentProof?.hourlyCounts?.modeledTide === 24
    && sourceEnvironmentProof?.snapshotReused === true
    && sourceEnvironmentProof?.stationCredentialsRequired === false;
  if (!citedCurrentProof || !verifiedDefaultProof) return null;

  const title = `${mappingTitle || ''} ${originalRtmName || ''}`;
  const fullText = `${title} ${requirement || ''}`;
  if (/安全校验|安全阈值|现场安全|下海/u.test(fullText)) {
    return { status: 'UNVERIFIED', scope: 'verified source data input only; no institution-approved safety threshold',
      reason: 'Source Q27.6 verifies the selected default Open-Meteo weather, marine and modeled sea-level inputs. The actual site safety threshold is not institution-approved or verified; current demo rules do not establish real-world or clinical permission. The complete unsafe-slot checks in both page and assistant flows remain unverified. QWeather credentials are not required for the selected default data mode.' };
  }
  if (/潮汐与海况状态条|天气与潮汐海况卡/u.test(title)) {
    return { status: 'SUBSCENARIO_PASS_PENDING_FULL_ACCEPTANCE', scope: 'selected default data and rendered snapshot sub-scenario',
      reason: 'Source Q27.6 verifies 24-hour Open-Meteo Forecast and Marine weather, wave and modeled sea-level-with-tides data, including source/grid/time and API/cache/database/page snapshot consistency for the selected default mode. This is a bounded data/display sub-scenario only; exact official-station readings, institutional site precision, exact high/low tide times and the full original interaction criteria remain unaccepted. Modeled global-MSL values are not official station observations.' };
  }
  return null;
}

function maskStringsAndComments(source) {
  const chars = [...source];
  let state = 'code';
  let escaped = false;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]; const next = chars[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'line-comment'; continue; }
      if (char === '/' && next === '*') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'block-comment'; continue; }
      if (char === "'" || char === '"' || char === '`') { state = char; chars[i] = ' '; escaped = false; }
      continue;
    }
    if (state === 'line-comment') {
      if (char === '\n') state = 'code'; else chars[i] = ' ';
      continue;
    }
    if (state === 'block-comment') {
      if (char === '*' && next === '/') { chars[i] = ' '; chars[i + 1] = ' '; i += 1; state = 'code'; }
      else if (char !== '\n') chars[i] = ' ';
      continue;
    }
    if (char === '\n') { state = 'code'; escaped = false; continue; }
    if (escaped) { chars[i] = ' '; escaped = false; continue; }
    if (char === '\\') { chars[i] = ' '; escaped = true; continue; }
    if (char === state) { chars[i] = ' '; state = 'code'; continue; }
    chars[i] = ' ';
  }
  return chars.join('');
}

export function assertQ278InitializationOrder(source) {
  const masked = maskStringsAndComments(source);
  const marker = 'async function runQ278(';
  const start = masked.indexOf(marker);
  if (start < 0) throw new Error('Q27.8 runQ278 function is missing');
  const signatureEnd = masked.indexOf(') {', start + marker.length);
  const openBrace = signatureEnd < 0 ? -1 : signatureEnd + 2;
  if (openBrace < 0) throw new Error('Q27.8 runQ278 body is missing');
  let depth = 0; let closeBrace = -1;
  for (let i = openBrace; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') { depth -= 1; if (depth === 0) { closeBrace = i; break; } }
  }
  if (closeBrace < 0) throw new Error('Q27.8 runQ278 body is not balanced');
  const body = masked.slice(openBrace + 1, closeBrace);
  const findSingleDeclaration = name => {
    const declarations = [...body.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`, 'gu'))];
    if (declarations.length !== 1) throw new Error(`Q27.8 must declare ${name} exactly once in runQ278`);
    const declaration = declarations[0];
    const tokenOffset = declaration.index + declaration[0].lastIndexOf(name);
    const tokens = [...body.matchAll(new RegExp(`\\b${name}\\b`, 'gu'))];
    if (!tokens.length || tokens[0].index !== tokenOffset) throw new Error(`Q27.8 uses ${name} before its initialization`);
    return tokenOffset;
  };
  const dateOffset = findSingleDeclaration('date');
  const businessClockOffset = findSingleDeclaration('businessClock');
  const firstTry = body.search(/\btry\s*\{/u);
  if (firstTry < 0 || dateOffset > firstTry || businessClockOffset > firstTry) {
    throw new Error('Q27.8 date/businessClock initialization must precede the delivery try block');
  }
  return { dateOffset, businessClockOffset, firstTryOffset: firstTry };
}

function assertBoundR5Reference(actual, expected, label) {
  requireThat(actual && path.normalize(actual.path) === path.normalize(expected.path)
    && actual.bytes === expected.bytes && actual.sha256 === expected.sha256,
  `${label} path/bytes/SHA differ from the original source handoff`);
  requireThat(actual.value && typeof actual.value === 'object', `${label} has no parsed proof value`);
  return actual.value;
}

function requireR5SourceLedgerRow(rows, quest, runId, status, evidenceField, evidencePath) {
  const row = (rows || []).find(item => item.taskId === STAGE27_R5_SOURCE_PACKAGING_HANDOFF.sourceTaskId
    && item.quest === quest && item.runId === runId && item.status === status
    && (!evidenceField || item[evidenceField] === evidencePath));
  requireThat(row, `${quest} lacks the exact source-task ${status} execution-ledger event`);
  return row;
}

export function verifyStage27R5SourceAcceptance({
  executorIdentity,
  handoff,
  q277Proof,
  q277Evidence,
  q278Proof,
  commandEvidence,
  q279Rtm,
  sourceExecutionRows
}) {
  const expected = STAGE27_R5_SOURCE_PACKAGING_HANDOFF;
  requireThat(executorIdentity?.taskId === expected.workerTaskId && executorIdentity.role === 'worker'
    || executorIdentity?.taskId === expected.sourceTaskId && executorIdentity.role === 'source',
  'source proof verification is running under neither the original worker nor the original source identity');
  const baseline = assertBoundR5Reference(handoff, expected, 'R5 packaging handoff baseline');
  requireThat(baseline.recordType === expected.recordType && baseline.sourceTaskId === expected.sourceTaskId
    && baseline.workerTaskId === expected.workerTaskId && baseline.sourceHostId === expected.hostId
    && baseline.workerHostId === expected.hostId,
  'R5 packaging handoff source/worker identities differ from the frozen source and worker');
  for (const key of ['Q27_7', 'Q27_8', 'Q27_9', 'commandEvidence']) {
    requireThat(baseline[key === 'commandEvidence' ? 'sourceActualThirdCommandEvidence'
      : key === 'Q27_7' ? 'sourceQ277Proof' : key === 'Q27_8' ? 'sourceQ278Proof' : 'sourceRawRtm']
      && baseline[key === 'commandEvidence' ? 'sourceActualThirdCommandEvidence'
        : key === 'Q27_7' ? 'sourceQ277Proof' : key === 'Q27_8' ? 'sourceQ278Proof' : 'sourceRawRtm'].path
        === path.resolve(expected.sourceProofs[key].path),
    `${key} proof path differs from the frozen source handoff`);
  }

  const q277 = assertBoundR5Reference(q277Proof, expected.sourceProofs.Q27_7, 'source Q27.7 proof');
  const q277EvidenceRows = assertBoundR5Reference(q277Evidence, {
    path: expected.sourceProofs.Q27_7.evidencePath,
    bytes: expected.sourceProofs.Q27_7.evidenceBytes,
    sha256: expected.sourceProofs.Q27_7.evidenceSha256
  }, 'source Q27.7 JSONL evidence');
  requireThat(q277.recordType === 'stage27-r5-source-first-actual-independent-q277-business-verification'
    && q277.sourceTaskId === expected.sourceTaskId && q277.status === 'PASS_Q277'
    && q277.actualCommand === expected.sourceProofs.Q27_7.command && q277.exitCode === 0
    && q277.evidence?.path === path.resolve(expected.sourceProofs.Q27_7.evidencePath)
    && q277.evidence?.bytes === expected.sourceProofs.Q27_7.evidenceBytes
    && q277.evidence?.sha256 === expected.sourceProofs.Q27_7.evidenceSha256,
  'source Q27.7 actor, command, exit, or evidence binding is invalid');
  const q277Run = q277EvidenceRows.find(row => row.taskId === expected.sourceTaskId
    && row.quest === 'Q27.7' && row.status === 'PASS' && row.runId === expected.sourceProofs.Q27_7.runId);
  requireThat(q277Run, 'source Q27.7 JSONL row does not match its frozen source run');
  requireR5SourceLedgerRow(sourceExecutionRows, 'Q27.7', expected.sourceProofs.Q27_7.runId, 'PASS');

  const q278Value = assertBoundR5Reference(q278Proof, expected.sourceProofs.Q27_8, 'source Q27.8 clean-delivery proof');
  requireThat(q278Value.taskId === expected.sourceTaskId && q278Value.status === 'PASS'
    && q278Value.runId === expected.sourceProofs.Q27_8.runId && q278Value.error === null,
  'source Q27.8 actor, run, status, or error field is invalid');
  const commands = assertBoundR5Reference(commandEvidence, expected.sourceProofs.commandEvidence,
    'source actual command evidence');
  const cold = commands.cold;
  requireThat(cold?.command === expected.sourceProofs.Q27_8.command
    && cold.polls?.at(-1)?.exit_code === expected.sourceProofs.Q27_8.exitCode,
  'source Q27.8 actual command/exit does not match its accepted clean-delivery run');
  requireR5SourceLedgerRow(sourceExecutionRows, 'Q27.8', expected.sourceProofs.Q27_8.runId, 'PASS',
    'evidencePath', expected.sourceProofs.Q27_8.path);

  const q279Value = assertBoundR5Reference(q279Rtm, expected.sourceProofs.Q27_9, 'source Q27.9 RTM proof');
  requireThat(q279Value.taskId === expected.sourceTaskId && q279Value.parsedCount === 109
    && q279Value.idsComplete === true && q279Value.mappingStatusCounts?.PASS === 33
    && q279Value.mappingStatusCounts?.BLOCKED === 76 && q279Value.mappingStatusCounts?.FAIL === 0
    && q279Value.functionalAcceptanceCounts?.UNVERIFIED === 103
    && q279Value.functionalAcceptanceCounts?.SUBSCENARIO_PASS_PENDING_FULL_ACCEPTANCE === 6,
  'source Q27.9 RTM actor or 109-row counts differ from the accepted source proof');
  const mapping = commands.mapping;
  requireThat(mapping?.command === expected.sourceProofs.Q27_9.command
    && mapping.result?.exit_code === expected.sourceProofs.Q27_9.exitCode
    && mapping.result?.output?.includes(expected.sourceProofs.Q27_9.runId),
  'source Q27.9 command, run output, or exit does not match the accepted source RTM');
  requireR5SourceLedgerRow(sourceExecutionRows, 'Q27.9', expected.sourceProofs.Q27_9.runId, 'PASS',
    'summaryPath', expected.sourceProofs.Q27_9.path);
  requireThat(commands.aggregate?.command
    === 'CODEX_TASK_ID=01a0cbfe-a161-72d0-992d-12fad655d4ef CODEX_STAGE27_SCOPE=R5 npm run quest -- --stage 27'
    && commands.aggregate.result?.exit_code === 2
    && commands.aggregate.result?.output?.includes('NOT_FINAL_ACCEPTED'),
  'the prior source aggregate must retain its actual NOT_FINAL_ACCEPTED exit-2 result');

  const sourceAcceptanceExecutor = Object.freeze({ ...executorIdentity,
    taskId: expected.sourceTaskId, role: 'source', evidenceOrigin: 'source_independent_acceptance',
    sourceTaskId: expected.sourceTaskId, workerTaskId: expected.workerTaskId, hostId: expected.hostId });
  return [
    { quest: 'Q27.7', runId: expected.sourceProofs.Q27_7.runId,
      actualSourceCommand: expected.sourceProofs.Q27_7.command, actualSourceExitCode: 0,
      sourceProofPath: expected.sourceProofs.Q27_7.path, sourceProofBytes: q277Proof.bytes,
      sourceProofSha256: q277Proof.sha256, actualEvidencePath: expected.sourceProofs.Q27_7.evidencePath,
      actualEvidenceBytes: q277Evidence.bytes, actualEvidenceSha256: q277Evidence.sha256,
      commandEvidencePath: expected.sourceProofs.commandEvidence.path,
      commandEvidenceBytes: commandEvidence.bytes, commandEvidenceSha256: commandEvidence.sha256 },
    { quest: 'Q27.8', runId: expected.sourceProofs.Q27_8.runId,
      actualSourceCommand: expected.sourceProofs.Q27_8.command, actualSourceExitCode: 0,
      sourceProofPath: expected.sourceProofs.Q27_8.path, sourceProofBytes: q278Proof.bytes,
      sourceProofSha256: q278Proof.sha256, actualEvidencePath: expected.sourceProofs.Q27_8.path,
      actualEvidenceBytes: q278Proof.bytes, actualEvidenceSha256: q278Proof.sha256,
      commandEvidencePath: expected.sourceProofs.commandEvidence.path,
      commandEvidenceBytes: commandEvidence.bytes, commandEvidenceSha256: commandEvidence.sha256 },
    { quest: 'Q27.9', runId: expected.sourceProofs.Q27_9.runId,
      actualSourceCommand: expected.sourceProofs.Q27_9.command, actualSourceExitCode: 0,
      sourceProofPath: expected.sourceProofs.Q27_9.path, sourceProofBytes: q279Rtm.bytes,
      sourceProofSha256: q279Rtm.sha256, actualEvidencePath: expected.sourceProofs.Q27_9.path,
      actualEvidenceBytes: q279Rtm.bytes, actualEvidenceSha256: q279Rtm.sha256,
      commandEvidencePath: expected.sourceProofs.commandEvidence.path,
      commandEvidenceBytes: commandEvidence.bytes, commandEvidenceSha256: commandEvidence.sha256 }
  ].map(record => ({ ...record, status: 'PASS', evidenceOrigin: 'source_independent_acceptance',
    sourceTaskId: expected.sourceTaskId, error: null, acceptanceExecutor: sourceAcceptanceExecutor }));
}

export function retainStage27R5ExecutorObservation(acceptedRecord, observedRecord, executorIdentity) {
  requireThat(executorIdentity?.role === 'source' || executorIdentity?.role === 'worker',
    'Stage27 R5 observation has no verified source/worker identity');
  requireThat(observedRecord?.taskId === executorIdentity.taskId,
    'Stage27 R5 observation task ID differs from the verified executor identity');
  const observation = {
    taskId: observedRecord.taskId,
    role: executorIdentity.role,
    evidenceOrigin: executorIdentity.evidenceOrigin,
    quest: observedRecord.quest,
    status: observedRecord.status,
    runId: observedRecord.runId || null,
    at: observedRecord.at || null,
    error: observedRecord.error || null,
    evidencePath: observedRecord.evidencePath || observedRecord.summaryPath || null,
    parsedCount: observedRecord.parsedCount ?? null
  };
  if (acceptedRecord?.evidenceOrigin !== 'source_independent_acceptance') {
    return { ...(acceptedRecord || {}), ...observedRecord };
  }
  const key = executorIdentity.role === 'worker' ? 'workerObservation' : 'sourceObservation';
  return { ...acceptedRecord, [key]: observation, error: acceptedRecord.status === 'PASS' ? null : acceptedRecord.error || null };
}
