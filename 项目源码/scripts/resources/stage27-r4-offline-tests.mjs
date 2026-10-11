import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessEnvironmentWindow } from '../../server/src/environment-availability.js';
import { fetchOpenMeteoMarine, fetchOpenMeteoWeather } from '../../server/src/environment-providers.js';
import { liveEnvironmentConfig } from '../../server/src/environment-config.js';
import { q275SourceApprovalParameters, sanitizeManagedQuestEnvironment } from './stage27-r4-cli-approval-context.js';
import {
  appendHashedBudgetEvent, initializeEnvironmentBudgetFile, readHashedBudgetJsonl,
  reconcileEnvironmentBudget, reconcileModelBudget, reserveEnvironmentProviderRequest,
  reserveModelBudgetAttempt, resolveStage27R4Executor, STAGE27_R4_MODEL_LIMITS,
  STAGE27_R4_SOURCE_APPROVAL, createSourceRequestLimitAdjustmentEvent,
  validateSourceRequestLimitApproval
} from './stage27-r4-budget-accounts.js';
import { validateQ275ConfirmationContract } from './stage27-r4-confirmation-contract.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function okJson(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function modelBaseline(filePath, taskId, windowId, cumulativeUsage = { requests: 0, tokens: 0,
  estimatedCostUsd: 0, activeIntervalMs: 0 }) {
  appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-q275-budget-event', taskId,
    budgetWindowId: windowId, runId: `baseline-${taskId}`, event: 'baseline-reconciled', at: new Date().toISOString(), cumulativeUsage });
}

function frozenSourceBudgetPrefixFixture(tempRoot, label) {
  const sourceAccountPath = path.resolve(projectRoot, STAGE27_R4_SOURCE_APPROVAL.sourceAccountRelativePath);
  const stat = fs.statSync(sourceAccountPath);
  assert.ok(stat.size >= STAGE27_R4_SOURCE_APPROVAL.accountPrefixBytes,
    'source budget file contains the frozen approved prefix');
  assert.ok(stat.size <= 8 * 1024 * 1024, 'source budget file is size-checked before the bounded prefix read');
  const prefix = Buffer.alloc(STAGE27_R4_SOURCE_APPROVAL.accountPrefixBytes);
  const descriptor = fs.openSync(sourceAccountPath, 'r');
  try {
    let offset = 0;
    while (offset < prefix.byteLength) {
      const count = fs.readSync(descriptor, prefix, offset, prefix.byteLength - offset, offset);
      assert.ok(count > 0, 'source budget frozen prefix read completes');
      offset += count;
    }
  } finally { fs.closeSync(descriptor); }
  assert.equal(crypto.createHash('sha256').update(prefix).digest('hex'), STAGE27_R4_SOURCE_APPROVAL.accountPrefixSha256,
    'source budget begins with the approval-frozen 9,551-byte prefix');
  assert.equal(prefix.toString('utf8').split(/\r?\n/u).filter(Boolean).length,
    STAGE27_R4_SOURCE_APPROVAL.accountPrefixLines, 'frozen source budget prefix contains the original 11 rows');
  const fixturePath = path.join(tempRoot, `source-budget-prefix-${label}.jsonl`);
  fs.writeFileSync(fixturePath, prefix, { mode: 0o600, flag: 'wx' });
  const rows = readHashedBudgetJsonl(fixturePath);
  assert.equal(rows.length, STAGE27_R4_SOURCE_APPROVAL.accountPrefixLines, 'temporary source budget fixture retains all 11 frozen events');
  return { sourceAccountPath, fixturePath, prefix, totalBytes: prefix.byteLength, rows };
}

function readBoundedSourceApproval() {
  const approvalPath = path.resolve(projectRoot, STAGE27_R4_SOURCE_APPROVAL.relativePath);
  const stat = fs.statSync(approvalPath);
  assert.ok(stat.size <= 64 * 1024, 'source approval JSON is size-checked before reading');
  const bytes = fs.readFileSync(approvalPath);
  assert.equal(bytes.byteLength, stat.size, 'source approval byte count remains stable during the bounded read');
  return { approvalPath, approval: JSON.parse(bytes.toString('utf8')) };
}

export async function runStage27R4OfflineTests(tempRoot) {
  fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const results = [];
  const check = async (name, fn) => { await fn(); results.push({ name, status: 'PASS' }); };

  const confirmationFixture = () => ({ browserFlow: { runId: 'graph-run', actionRunId: 'proposal-run',
    needsInputCardId: 'needs-input-card', selectionRunId: 'selection-run', selectedSlotId: 'slot-1',
    pendingActionCardId: 'confirmed-card', confirmedActionCardId: 'confirmed-card', selectionSubmitted: true,
    confirmationSubmitted: true, confirmationBodyError: null, confirmedCardVisible: true, externalRequests: [], pageErrors: [],
    confirmation: { httpStatus: 200, actionCardId: 'confirmed-card', actionCardStatus: 'confirmed',
      businessType: 'reservation', reservationId: 'reservation-1' } },
    preConfirmationDatabaseReadback: { guestId: 'guest-1', slotId: 'slot-1', reservationCount: 0,
      actionCardId: 'confirmed-card', selectionRunId: 'selection-run' },
    selectionActionCard: { id: 'confirmed-card', actionType: 'book_program', status: 'confirmed' },
    reservation: { id: 'reservation-1', status: 'confirmed', slot_id: 'slot-1' }, confirmedReservationCount: 1,
    expected: { graphRunId: 'graph-run', proposalRunId: 'proposal-run', needsInputCardId: 'needs-input-card',
      selectionRunId: 'selection-run', slotId: 'slot-1' } });

  await check('executor identity is pinned to the immutable worker/source IDs', () => {
    const baseline = { workerTaskId: 'worker-task', sourceTaskId: 'source-task',
      workerBudget: { budgetWindowId: 'persistent-window' } };
    assert.deepEqual(resolveStage27R4Executor('worker-task', baseline), {
      executor: 'worker', taskId: 'worker-task', budgetWindowId: 'persistent-window'
    });
    assert.equal(resolveStage27R4Executor('source-task', baseline).executor, 'source');
    assert.throws(() => resolveStage27R4Executor('other-task', baseline), error => error.code === 'R4_EXECUTOR_UNKNOWN');
  });

  await check('Q27.5 confirmation contract accepts only the exact webpage-to-SQL booking chain', () => {
    const fixture = confirmationFixture();
    const accepted = validateQ275ConfirmationContract(fixture);
    assert.equal(accepted.status, 'PASS');
    assert.equal(accepted.responseReservationId, 'reservation-1');
    assert.equal(accepted.databaseReservationId, 'reservation-1');
  });

  await check('Q27.5 rejects an HTTP reservation ID that differs from the independent SQL row', () => {
    const fixture = confirmationFixture();
    fixture.reservation.id = 'reservation-from-a-different-row';
    assert.throws(() => validateQ275ConfirmationContract(fixture), error =>
      error?.code === 'ERR_ASSERTION'
        && error.message.includes('actual webpage response and independent database row identify the same reservation'));
  });

  await check('Q27.5 confirmation contract rejects a missing HTTP reservation identifier', () => {
    const fixture = confirmationFixture(); fixture.browserFlow.confirmation.reservationId = null;
    assert.throws(() => validateQ275ConfirmationContract(fixture), /webpage response reservation ID/u);
  });

  await check('Q27.5 confirmation contract rejects wrong HTTP, action-card, type, status, and slot values', () => {
    for (const mutate of [
      fixture => { fixture.browserFlow.confirmation.httpStatus = 201; },
      fixture => { fixture.browserFlow.confirmation.actionCardId = 'other-card'; },
      fixture => { fixture.browserFlow.confirmation.businessType = 'meal'; },
      fixture => { fixture.selectionActionCard.status = 'pending_confirmation'; },
      fixture => { fixture.reservation.slot_id = 'other-slot'; }
    ]) {
      const fixture = confirmationFixture(); mutate(fixture);
      assert.throws(() => validateQ275ConfirmationContract(fixture));
    }
  });

  await check('Q27.5 confirmation contract requires zero pre-write and exactly one post-write reservation', () => {
    for (const count of [1, 2]) {
      const fixture = confirmationFixture();
      if (count === 1) fixture.preConfirmationDatabaseReadback.reservationCount = count;
      else fixture.confirmedReservationCount = count;
      assert.throws(() => validateQ275ConfirmationContract(fixture));
    }
  });

  await check('Q27.5 source approval parameters cross the CLI environment reset only for the exact source live quest', () => {
    const approval = readBoundedSourceApproval();
    const sourceTaskId = STAGE27_R4_SOURCE_APPROVAL.sourceTaskId;
    const workerTaskId = STAGE27_R4_SOURCE_APPROVAL.workerTaskId;
    const makeEnvironment = ({ taskId = sourceTaskId, scope = 'R4', questId = 'Q27.5', live = true,
      includePath = true, includeHash = true, approvalPath = approval.approvalPath,
      approvalSha256 = STAGE27_R4_SOURCE_APPROVAL.sha256 } = {}) => {
      const environment = { PATH: '/usr/bin:/bin', CODEX_TASK_ID: taskId, CODEX_STAGE27_SCOPE: scope,
        LLM_BASE_URL: 'http://offline.invalid', LLM_API_KEY: 'offline-test-sentinel', LLM_MODEL: 'offline-model',
        UNLISTED_SECRET: 'offline-test-sentinel' };
      if (includePath) environment.STAGE27_R4_SOURCE_EXTRA12_APPROVAL_PATH = approvalPath;
      if (includeHash) environment.STAGE27_R4_SOURCE_EXTRA12_APPROVAL_SHA256 = approvalSha256;
      return environment;
    };
    const boundary = ({ environment, taskId = sourceTaskId, scope = 'R4', questId = 'Q27.5', live = true }) =>
      sanitizeManagedQuestEnvironment(environment, { taskId, stage27: true, stage27Scope: scope, questId, live });

    const allowedEnvironment = makeEnvironment();
    const allowedResult = boundary({ environment: allowedEnvironment });
    assert.equal(allowedResult.sourceApprovalEligible, true);
    assert.deepEqual(allowedResult.forwardedApprovalFields, [
      'STAGE27_R4_SOURCE_EXTRA12_APPROVAL_PATH', 'STAGE27_R4_SOURCE_EXTRA12_APPROVAL_SHA256'
    ]);
    assert.deepEqual(q275SourceApprovalParameters(allowedEnvironment), {
      approvalPath: approval.approvalPath, approvalSha256: STAGE27_R4_SOURCE_APPROVAL.sha256
    }, 'the exact environment reader used by Q27.5 budget initialization receives both approved values after CLI cleanup');
    for (const key of ['LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL', 'UNLISTED_SECRET']) {
      assert.equal(Object.hasOwn(allowedEnvironment, key), false, `${key} remains removed by the CLI environment boundary`);
    }

    const noApprovalEnvironment = makeEnvironment({ includePath: false, includeHash: false });
    boundary({ environment: noApprovalEnvironment });
    assert.deepEqual(q275SourceApprovalParameters(noApprovalEnvironment), { approvalPath: '', approvalSha256: '' },
      'no approval leaves the original 24-request limit path in force');

    for (const context of [
      { taskId: workerTaskId, scope: 'R4', questId: 'Q27.5', live: true },
      { taskId: sourceTaskId, scope: 'R4', questId: 'Q27.6', live: true },
      { taskId: sourceTaskId, scope: 'R4', questId: 'Q27.5', live: false },
      { taskId: sourceTaskId, scope: 'R3', questId: 'Q27.5', live: true }
    ]) {
      const environment = makeEnvironment({ taskId: context.taskId, scope: context.scope });
      const result = boundary({ environment, ...context });
      assert.equal(result.sourceApprovalEligible, false);
      assert.deepEqual(q275SourceApprovalParameters(environment), { approvalPath: '', approvalSha256: '' },
        'worker, other quest, non-live, and non-R4 invocations cannot receive the source allowance parameters');
      assert.equal(Object.hasOwn(environment, 'LLM_API_KEY'), false, 'non-allowlisted model credentials remain stripped');
    }

    const prefixFixture = frozenSourceBudgetPrefixFixture(tempRoot, 'cli-entry');
    const validationBase = { approval: approval.approval, approvalFileSha256: STAGE27_R4_SOURCE_APPROVAL.sha256,
      executor: 'source', taskId: sourceTaskId, budgetWindowId: STAGE27_R4_SOURCE_APPROVAL.budgetWindowId,
      approvalPath: approval.approvalPath, sourceAccountPath: prefixFixture.sourceAccountPath,
      accountPrefixBytes: prefixFixture.prefix, accountTotalBytes: prefixFixture.totalBytes,
      rows: prefixFixture.rows, allowAppend: true };
    for (const partial of [
      makeEnvironment({ includeHash: false }),
      makeEnvironment({ includePath: false })
    ]) {
      boundary({ environment: partial });
      const received = q275SourceApprovalParameters(partial);
      assert.throws(() => validateSourceRequestLimitApproval({ ...validationBase,
        approvalPath: received.approvalPath, approvalFileSha256: received.approvalSha256 }), /path or SHA-256/u,
      'one-sided CLI parameters reach the initializer input but cannot validate an allowance');
    }
    const wrongHashEnvironment = makeEnvironment({ approvalSha256: '0'.repeat(64) });
    boundary({ environment: wrongHashEnvironment });
    const wrongHash = q275SourceApprovalParameters(wrongHashEnvironment);
    assert.equal(wrongHash.approvalSha256, '0'.repeat(64), 'the CLI does not normalize or replace an incorrect hash');
    assert.throws(() => validateSourceRequestLimitApproval({ ...validationBase,
      approvalPath: wrongHash.approvalPath, approvalFileSha256: wrongHash.approvalSha256 }), /path or SHA-256/u);
    const wrongPathEnvironment = makeEnvironment({ approvalPath: path.join(tempRoot, 'not-the-approved-file.json') });
    boundary({ environment: wrongPathEnvironment });
    const wrongPath = q275SourceApprovalParameters(wrongPathEnvironment);
    assert.equal(wrongPath.approvalPath, path.join(tempRoot, 'not-the-approved-file.json'),
      'the CLI preserves the incorrect path so fixed-path validation rejects it');
    assert.throws(() => validateSourceRequestLimitApproval({ ...validationBase,
      approvalPath: wrongPath.approvalPath }), /path or SHA-256/u);
  });

  await check('source +12 approval is bound to its source identity, exact hash, window, and frozen prefix', () => {
    const { approvalPath, approval } = readBoundedSourceApproval();
    const sourceFixture = frozenSourceBudgetPrefixFixture(tempRoot, 'approval-validation');
    const base = { approval, approvalFileSha256: STAGE27_R4_SOURCE_APPROVAL.sha256,
      executor: 'source', taskId: STAGE27_R4_SOURCE_APPROVAL.sourceTaskId,
      budgetWindowId: STAGE27_R4_SOURCE_APPROVAL.budgetWindowId,
      approvalPath, sourceAccountPath: sourceFixture.sourceAccountPath,
      accountPrefixBytes: sourceFixture.prefix,
      accountTotalBytes: sourceFixture.totalBytes, rows: sourceFixture.rows, allowAppend: true };
    const approvalToken = validateSourceRequestLimitApproval(base);
    assert.throws(() => validateSourceRequestLimitApproval({ ...base, executor: 'worker' }), /Only the approved source task/u);
    assert.throws(() => validateSourceRequestLimitApproval({ ...base, taskId: STAGE27_R4_SOURCE_APPROVAL.workerTaskId }), /Only the approved source task/u);
    assert.throws(() => validateSourceRequestLimitApproval({ ...base, budgetWindowId: 'new-window' }), /different persistent account/u);
    assert.throws(() => validateSourceRequestLimitApproval({ ...base, approvalFileSha256: '0'.repeat(64) }), /path or SHA-256/u);
    const changedPrefix = Buffer.from(base.accountPrefixBytes); changedPrefix[0] ^= 1;
    assert.throws(() => validateSourceRequestLimitApproval({ ...base, accountPrefixBytes: changedPrefix }), /frozen persistent-account prefix/u);
    assert.equal(createSourceRequestLimitAdjustmentEvent(approvalToken).newRequestLimit, 36);
  });

  await check('model usage accumulates into one append-only window', () => {
    const filePath = path.join(tempRoot, 'model-pass.jsonl');
    const taskId = 'offline-worker'; const windowId = crypto.randomUUID(); const runId = 'attempt-one';
    modelBaseline(filePath, taskId, windowId);
    const first = reserveModelBudgetAttempt({ filePath, taskId, budgetWindowId: windowId, runId });
    assert.equal(first.remaining.requests, 24);
    appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-q275-budget-event', taskId,
      budgetWindowId: windowId, runId, event: 'repair-window-started', at: new Date().toISOString() });
    appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-q275-budget-event', taskId,
      budgetWindowId: windowId, runId: 'provider-child-run', event: 'repair-provider-usage-recorded',
      usage: { requests: 2, tokens: 125, estimatedCostUsd: 0.001 }, at: new Date().toISOString() });
    appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-q275-budget-event', taskId,
      budgetWindowId: windowId, runId, event: 'repair-window-finished', activeIntervalMs: 250,
      usageReconciled: true, at: new Date().toISOString() });
    const reconciled = reconcileModelBudget({ rows: readHashedBudgetJsonl(filePath), taskId, budgetWindowId: windowId });
    assert.deepEqual(reconciled.cumulativeUsage, { requests: 2, tokens: 125, estimatedCostUsd: 0.001, activeIntervalMs: 250 });
    assert.equal(reconciled.remaining.requests, 22);
  });

  await check('source +12 is append-only, preserves the zero baseline and prior 24 requests, and changes no other cap', () => {
    const { approvalPath, approval } = readBoundedSourceApproval();
    const sourceFixture = frozenSourceBudgetPrefixFixture(tempRoot, 'source-budget-cumulative');
    const sourceRows = sourceFixture.rows;
    const approvalToken = validateSourceRequestLimitApproval({ approval,
      approvalFileSha256: STAGE27_R4_SOURCE_APPROVAL.sha256, executor: 'source',
      taskId: STAGE27_R4_SOURCE_APPROVAL.sourceTaskId, budgetWindowId: STAGE27_R4_SOURCE_APPROVAL.budgetWindowId,
      approvalPath, sourceAccountPath: sourceFixture.sourceAccountPath, accountPrefixBytes: sourceFixture.prefix,
      accountTotalBytes: sourceFixture.totalBytes, rows: sourceRows, allowAppend: true });
    const sourceBefore = reconcileModelBudget({ rows: sourceRows, taskId: STAGE27_R4_SOURCE_APPROVAL.sourceTaskId,
      budgetWindowId: STAGE27_R4_SOURCE_APPROVAL.budgetWindowId,
      baselineUsage: { requests: 0, tokens: 0, estimatedCostUsd: 0, activeIntervalMs: 0 } });
    assert.equal(sourceRows[0].cumulativeUsage.requests, 0, 'real source baseline remains zero');
    assert.equal(sourceBefore.cumulativeUsage.requests, 24, 'all previously consumed source requests remain counted');
    assert.equal(sourceBefore.remaining.requests, 0, 'the original 24-request cumulative cap is exhausted');
    assert.throws(() => reconcileModelBudget({ rows: sourceRows, taskId: STAGE27_R4_SOURCE_APPROVAL.sourceTaskId,
      budgetWindowId: STAGE27_R4_SOURCE_APPROVAL.budgetWindowId,
      baselineUsage: { requests: 0, tokens: 0, estimatedCostUsd: 0, activeIntervalMs: 0 },
      limits: { ...STAGE27_R4_MODEL_LIMITS, requests: 36 } }), /cannot change the original model limits/u);
    assert.equal(sourceBefore.remaining.tokens, 131_072 - 34_550);
    assert.equal(sourceBefore.remaining.activeIntervalMs, 300_000 - 32_664);

    const filePath = path.join(tempRoot, 'source-approved-budget.jsonl');
    const taskId = STAGE27_R4_SOURCE_APPROVAL.sourceTaskId;
    const windowId = STAGE27_R4_SOURCE_APPROVAL.budgetWindowId;
    const baseline = { requests: 0, tokens: 0, estimatedCostUsd: 0, activeIntervalMs: 0 };
    const seedApprovedAccount = target => {
      modelBaseline(target, taskId, windowId, baseline);
      const priorRun = 'source-prior-usage';
      appendHashedBudgetEvent(target, { taskId, budgetWindowId: windowId, runId: priorRun,
        event: 'repair-attempt-reserved', at: new Date().toISOString() });
      appendHashedBudgetEvent(target, { taskId, budgetWindowId: windowId, runId: priorRun,
        event: 'repair-window-started', at: new Date().toISOString() });
      appendHashedBudgetEvent(target, { taskId, budgetWindowId: windowId, runId: 'source-prior-provider',
        event: 'repair-provider-usage-recorded', usage: STAGE27_R4_SOURCE_APPROVAL.sourceUsageAtApproval,
        at: new Date().toISOString() });
      appendHashedBudgetEvent(target, { taskId, budgetWindowId: windowId, runId: priorRun,
        event: 'repair-window-finished', activeIntervalMs: STAGE27_R4_SOURCE_APPROVAL.sourceUsageAtApproval.activeIntervalMs,
        usageReconciled: true, at: new Date().toISOString() });
      appendHashedBudgetEvent(target, { taskId, budgetWindowId: windowId,
        ...createSourceRequestLimitAdjustmentEvent(approvalToken), at: new Date().toISOString() });
      return readHashedBudgetJsonl(target);
    };
    const adjustedRows = seedApprovedAccount(filePath);
    assert.equal(adjustedRows[0].cumulativeUsage.requests, 0, 'synthetic approved account also retains its original zero baseline');
    const adjusted = reconcileModelBudget({ rows: adjustedRows, taskId, budgetWindowId: windowId,
      baselineUsage: baseline, sourceRequestLimitApproval: approvalToken });
    assert.equal(adjusted.limits.requests, 36);
    assert.equal(adjusted.cumulativeUsage.requests, 24);
    assert.equal(adjusted.remaining.requests, 12);
    assert.equal(adjusted.limits.tokens, STAGE27_R4_MODEL_LIMITS.tokens);
    assert.equal(adjusted.limits.estimatedCostUsd, STAGE27_R4_MODEL_LIMITS.estimatedCostUsd);
    assert.equal(adjusted.limits.activeIntervalMs, STAGE27_R4_MODEL_LIMITS.activeIntervalMs);
    const reserved = reserveModelBudgetAttempt({ filePath, taskId, budgetWindowId: windowId,
      runId: 'source-approved-next-attempt', sourceRequestLimitApproval: approvalToken });
    assert.equal(reserved.remaining.requests, 12);
    appendHashedBudgetEvent(filePath, { taskId, budgetWindowId: windowId, runId: 'source-approved-next-attempt',
      event: 'repair-window-started', at: new Date().toISOString() });
    appendHashedBudgetEvent(filePath, { taskId, budgetWindowId: windowId, runId: 'source-approved-provider',
      event: 'repair-provider-usage-recorded', usage: { requests: 12, tokens: 100,
        estimatedCostUsd: 0.001 }, at: new Date().toISOString() });
    appendHashedBudgetEvent(filePath, { taskId, budgetWindowId: windowId, runId: 'source-approved-next-attempt',
      event: 'repair-window-finished', activeIntervalMs: 100, usageReconciled: true, at: new Date().toISOString() });
    const exhaustedRows = readHashedBudgetJsonl(filePath);
    const exhausted = reconcileModelBudget({ rows: exhaustedRows, taskId, budgetWindowId: windowId,
      baselineUsage: baseline, sourceRequestLimitApproval: approvalToken });
    assert.equal(exhausted.cumulativeUsage.requests, 36);
    assert.equal(exhausted.remaining.requests, 0);
    assert.throws(() => reserveModelBudgetAttempt({ filePath, taskId, budgetWindowId: windowId,
      runId: 'source-approved-over-cap', sourceRequestLimitApproval: approvalToken }),
    error => error.code === 'R4_MODEL_BUDGET_EXHAUSTED');
    assert.throws(() => reconcileModelBudget({ rows: adjustedRows, taskId, budgetWindowId: windowId,
      baselineUsage: baseline }), /no verified approval context/u);
    appendHashedBudgetEvent(filePath, { taskId, budgetWindowId: windowId,
      ...createSourceRequestLimitAdjustmentEvent(approvalToken), at: new Date().toISOString() });
    assert.throws(() => reconcileModelBudget({ rows: readHashedBudgetJsonl(filePath), taskId,
      budgetWindowId: windowId, baselineUsage: baseline, sourceRequestLimitApproval: approvalToken }), /repeated or stacked/u);

    const oneRerunPath = path.join(tempRoot, 'source-approved-one-rerun.jsonl');
    seedApprovedAccount(oneRerunPath);
    reserveModelBudgetAttempt({ filePath: oneRerunPath, taskId, budgetWindowId: windowId,
      runId: 'source-single-rerun', sourceRequestLimitApproval: approvalToken });
    appendHashedBudgetEvent(oneRerunPath, { taskId, budgetWindowId: windowId, runId: 'source-single-rerun',
      event: 'repair-window-started', at: new Date().toISOString() });
    appendHashedBudgetEvent(oneRerunPath, { taskId, budgetWindowId: windowId, runId: 'source-single-provider',
      event: 'repair-provider-usage-recorded', usage: { requests: 6, tokens: 100,
        estimatedCostUsd: 0.001 }, at: new Date().toISOString() });
    appendHashedBudgetEvent(oneRerunPath, { taskId, budgetWindowId: windowId, runId: 'source-single-rerun',
      event: 'repair-window-finished', activeIntervalMs: 100, usageReconciled: true, at: new Date().toISOString() });
    const oneRerunRows = readHashedBudgetJsonl(oneRerunPath);
    assert.equal(reconcileModelBudget({ rows: oneRerunRows, taskId, budgetWindowId: windowId,
      baselineUsage: baseline, sourceRequestLimitApproval: approvalToken }).remaining.requests, 6);
    assert.throws(() => reserveModelBudgetAttempt({ filePath: oneRerunPath, taskId, budgetWindowId: windowId,
      runId: 'source-single-rerun-twice', sourceRequestLimitApproval: approvalToken }),
    error => error.code === 'R4_SOURCE_APPROVED_ATTEMPT_USED');
  });

  await check('unknown model usage closes the account', () => {
    const filePath = path.join(tempRoot, 'model-unknown.jsonl');
    const taskId = 'offline-worker-unknown'; const windowId = crypto.randomUUID(); const runId = 'attempt-unknown';
    modelBaseline(filePath, taskId, windowId);
    reserveModelBudgetAttempt({ filePath, taskId, budgetWindowId: windowId, runId });
    appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-q275-budget-event', taskId,
      budgetWindowId: windowId, runId, event: 'repair-window-started', at: new Date().toISOString() });
    appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-q275-budget-event', taskId,
      budgetWindowId: windowId, runId: 'provider-child-run', event: 'repair-provider-usage-recorded',
      usage: { requests: 1, tokens: 7, estimatedCostUsd: 0.0001 }, at: new Date().toISOString() });
    appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-q275-budget-event', taskId,
      budgetWindowId: windowId, runId, event: 'repair-window-finished', activeIntervalMs: 20,
      usageReconciled: false, at: new Date().toISOString() });
    assert.throws(() => reconcileModelBudget({ rows: readHashedBudgetJsonl(filePath), taskId, budgetWindowId: windowId }),
      /unknown provider usage/u);
  });

  await check('exhausted model allowance refuses a new attempt', () => {
    const filePath = path.join(tempRoot, 'model-exhausted.jsonl');
    const taskId = 'offline-worker-exhausted'; const windowId = crypto.randomUUID();
    modelBaseline(filePath, taskId, windowId, { requests: 24, tokens: 10, estimatedCostUsd: 0.1, activeIntervalMs: 10 });
    assert.throws(() => reserveModelBudgetAttempt({ filePath, taskId, budgetWindowId: windowId, runId: 'blocked-attempt' }),
      error => error.code === 'R4_MODEL_BUDGET_EXHAUSTED');
  });

  await check('failed environment attempts count and the six-request cap holds', async () => {
    const filePath = path.join(tempRoot, 'environment-budget.jsonl'); const taskId = 'offline-env-worker';
    assert.equal(initializeEnvironmentBudgetFile({ filePath, taskId, baselineUsed: 0, limit: 6 }).used, 0);
    const first = await reserveEnvironmentProviderRequest({ filePath, taskId, baselineUsed: 0, provider: 'fixture-failure', limit: 6 });
    first.finish('failed');
    assert.deepEqual(reconcileEnvironmentBudget({ rows: readHashedBudgetJsonl(filePath), taskId, baselineUsed: 0, limit: 6 }),
      { used: 1, remaining: 5 });
    for (let index = 0; index < 5; index += 1) {
      const request = await reserveEnvironmentProviderRequest({ filePath, taskId, baselineUsed: 0, provider: 'local-fixture', limit: 6 });
      request.finish('success');
    }
    assert.deepEqual(reconcileEnvironmentBudget({ rows: readHashedBudgetJsonl(filePath), taskId, baselineUsed: 0, limit: 6 }),
      { used: 6, remaining: 0 });
    await assert.rejects(() => reserveEnvironmentProviderRequest({ filePath, taskId, baselineUsed: 0, provider: 'blocked', limit: 6 }),
      error => error.code === 'R4_ENV_BUDGET_EXHAUSTED' && /limit/u.test(error.message));
  });

  await check('unfinished environment request blocks further use', async () => {
    const filePath = path.join(tempRoot, 'environment-inflight.jsonl'); const taskId = 'offline-env-inflight';
    initializeEnvironmentBudgetFile({ filePath, taskId, baselineUsed: 0, limit: 6 });
    await reserveEnvironmentProviderRequest({ filePath, taskId, baselineUsed: 0, provider: 'in-flight', limit: 6 });
    assert.throws(() => reconcileEnvironmentBudget({ rows: readHashedBudgetJsonl(filePath), taskId, baselineUsed: 0, limit: 6 }),
      /in-flight/u);
  });

  await check('Open-Meteo is the default; QWeather credentials are optional unless selected', () => {
    const config = liveEnvironmentConfig({ ENVIRONMENT_LOCATION_ID: 'region', ENVIRONMENT_LOCATION_NAME: 'region point',
      ENVIRONMENT_LATITUDE: '39.05', ENVIRONMENT_LONGITUDE: '121.78', ENVIRONMENT_TIME_ZONE: 'Asia/Shanghai' });
    assert.equal(config.tideProvider, 'open-meteo');
    assert.deepEqual(config.missing, []);
    assert.deepEqual(config.missingByDomain.tide, []);
    const qweather = liveEnvironmentConfig({ ENVIRONMENT_TIDE_PROVIDER: 'qweather',
      ENVIRONMENT_LOCATION_ID: 'region', ENVIRONMENT_LOCATION_NAME: 'region point',
      ENVIRONMENT_LATITUDE: '39.05', ENVIRONMENT_LONGITUDE: '121.78', ENVIRONMENT_TIME_ZONE: 'Asia/Shanghai' });
    assert.deepEqual(qweather.missingByDomain.tide, ['QWEATHER_TIDE_STATION_ID', 'QWEATHER_API_HOST', 'QWEATHER_API_KEY']);
  });

  await check('Open-Meteo local observation times normalize from response timezone without shifting explicit offsets', async () => {
    const date = '2026-10-10';
    const callWeather = async ({ currentTime, timezone = 'Asia/Shanghai', offset = 28800, requestedTimezone = timezone }) => {
      const response = { latitude: 39.05, longitude: 121.78, timezone,
        ...(offset === undefined ? {} : { utc_offset_seconds: offset }),
        current: { time: currentTime, temperature_2m: 20, wind_speed_10m: 8 },
        hourly_units: { temperature_2m: '°C', wind_speed_10m: 'km/h', uv_index: 'index' },
        hourly: { time: [`${date}T22:00`, `${date}T23:00`], temperature_2m: [19, 18],
          wind_speed_10m: [7, 6], uv_index: [1, 0] } };
      return await fetchOpenMeteoWeather({ latitude: 39.05, longitude: 121.78, date,
        timeZone: requestedTimezone, baseUrl: 'http://127.0.0.1/weather', fetchImpl: async () => okJson(response) });
    };
    const local = await callWeather({ currentTime: `${date}T22:45` });
    assert.equal(local.observedAt, `${date}T14:45:00.000Z`, '22:45 in Asia/Shanghai corresponds to 14:45Z');
    assert.equal(local.observedLocalTime, `${date}T22:45`, 'the source-local observation remains available');
    assert.equal(local.current.time, `${date}T22:00`, 'current values map to the matching provider-local forecast hour');
    const explicitOffset = await callWeather({ currentTime: `${date}T22:45:00+08:00` });
    assert.equal(explicitOffset.observedAt, `${date}T14:45:00.000Z`, 'an explicit +08:00 timestamp is parsed once');
    const explicitUtc = await callWeather({ currentTime: `${date}T14:45:00Z` });
    assert.equal(explicitUtc.observedAt, `${date}T14:45:00.000Z`, 'an explicit Z timestamp is not shifted again');
    const timezoneFallback = await callWeather({ currentTime: `${date}T22:45`, offset: undefined });
    assert.equal(timezoneFallback.observedAt, `${date}T14:45:00.000Z`, 'the response timezone resolves a local timestamp if offset seconds are absent');
    await assert.rejects(callWeather({ currentTime: `${date}T22:45`, timezone: '', requestedTimezone: '', offset: null }),
      error => error.code === 'ENVIRONMENT_TIMESTAMP_OFFSET_MISSING');
  });

  await check('missing modeled sea level is unavailable even when wave height is present', async () => {
    const date = '2026-10-10'; const time = Array.from({ length: 24 }, (_, hour) => `${date}T${String(hour).padStart(2, '0')}:00`);
    const response = { latitude: 39.05, longitude: 121.78, timezone: 'Asia/Shanghai',
      hourly_units: { wave_height: 'm', sea_level_height_msl: 'm' },
      hourly: { time, wave_height: time.map(() => 0.4), sea_level_height_msl: time.map(() => 0.1) } };
    const complete = await fetchOpenMeteoMarine({ latitude: 39.052585, longitude: 121.787513, date,
      baseUrl: 'http://127.0.0.1/marine', fetchImpl: async () => okJson(response) });
    assert.equal(complete.variableStatus.modeledSeaLevelIncludingTides, 'available');
    assert.match(complete.providerResponseHash, /^[a-f0-9]{64}$/u);
    assert.equal(complete.hourly.length, 24);
    const incompleteResponse = structuredClone(response);
    incompleteResponse.hourly.sea_level_height_msl[7] = null;
    const incomplete = await fetchOpenMeteoMarine({ latitude: 39.052585, longitude: 121.787513, date,
      baseUrl: 'http://127.0.0.1/marine', fetchImpl: async () => okJson(incompleteResponse) });
    assert.equal(incomplete.variableStatus.waveHeight, 'available');
    assert.equal(incomplete.variableStatus.modeledSeaLevelIncludingTides, 'unavailable');
    assert.equal(incomplete.hourly[7].modelSeaLevelHeightMsl, null);
    const nonNumericResponse = structuredClone(response);
    nonNumericResponse.hourly.sea_level_height_msl[9] = 'not-a-number';
    const nonNumeric = await fetchOpenMeteoMarine({ latitude: 39.052585, longitude: 121.787513, date,
      baseUrl: 'http://127.0.0.1/marine', fetchImpl: async () => okJson(nonNumericResponse) });
    assert.equal(nonNumeric.variableStatus.waveHeight, 'available');
    assert.equal(nonNumeric.variableStatus.modeledSeaLevelIncludingTides, 'unavailable');
    assert.equal(nonNumeric.hourly[9].modelSeaLevelHeightMsl, null);
  });

  await check('modeled sea level cannot satisfy station-tide availability', () => {
    const date = '2026-10-10'; const time = `${date}T15:00`;
    const snapshot = { targetDate: date, snapshotId: 'offline-modeled-tide',
      weather: { status: 'available', hourly: [{ time, uvIndex: 1 }] },
      tide: { status: 'available', mode: 'modeled-sea-level-including-tides', hourly: [{ time, heightM: 0.1 }] },
      marine: { status: 'available', hourly: [{ time, waveHeightM: 0.4 }] }, safetyThresholds: null };
    const result = assessEnvironmentWindow({ project: { id: 'project-sea-bath', name: '海水浴', activityTag: 'sea_bath', outdoor: true, seaEntry: true },
      snapshot, profileState: {}, legacyProfile: {} });
    assert.equal(result.status, 'pending');
    assert.equal(result.tideHeightM, null);
  });

  return { status: 'PASS', testCount: results.length, results };
}
