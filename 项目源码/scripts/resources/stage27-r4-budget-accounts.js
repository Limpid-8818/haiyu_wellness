import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STAGE27_R4_MODEL_LIMITS = Object.freeze({ requests: 24, tokens: 131_072,
  estimatedCostUsd: 0.5, activeIntervalMs: 300_000 });
export const STAGE27_R4_SOURCE_APPROVAL = Object.freeze({
  relativePath: 'output/resource-audit/stage27-r4-source-sol-source-only-extra12-approval-20261011.json',
  sha256: '478edda5598c179b1d1d14e91949d2fb75902f83911058d9b7a91d26b5529f9a',
  sourceTaskId: '01a0cbfe-a161-72d0-992d-12fad655d4ef',
  workerTaskId: '01a12558-3f36-72c0-857c-fdd666eccf86',
  budgetWindowId: 'd04bcd4d-2f93-416f-a30e-774366b7d655',
  sourceAccountRelativePath: 'output/resource-audit/stage27-r4/01a0cbfe-a161-72d0-992d-12fad655d4ef/q275-persistent-model-budget.jsonl',
  accountPrefixBytes: 9_551,
  accountPrefixLines: 11,
  accountPrefixSha256: '863d23b35d699c0b37da09aa081cfcba2150a0683bf18ba30be9471975618e66',
  previousRequestLimit: 24,
  additionalRequests: 12,
  newRequestLimit: 36,
  sourceUsageAtApproval: Object.freeze({ requests: 24, tokens: 34_550,
    estimatedCostUsd: 0.0130812, activeIntervalMs: 32_664 })
});
export const STAGE27_R4_ENV_LIMITS = Object.freeze({ requests: 6, requestTimeoutMs: 15_000 });

const EMPTY_HASH = crypto.createHash('sha256').digest('hex');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const validatedSourceApprovals = new WeakSet();

function fail(message, code = 'R4_BUDGET_UNKNOWN') {
  const error = new Error(message);
  error.code = code;
  error.stageBlocked = true;
  return error;
}

export function resolveStage27R4Executor(taskId, baseline) {
  if (taskId && taskId === baseline?.workerTaskId) return { executor: 'worker', taskId,
    budgetWindowId: baseline.workerBudget?.budgetWindowId || baseline.workerBudgetAccount?.budgetWindowId || null };
  if (taskId && taskId === baseline?.sourceTaskId) return { executor: 'source', taskId, budgetWindowId: null };
  throw fail('The current task ID is not the R4 source or worker identity in the immutable handoff baseline.', 'R4_EXECUTOR_UNKNOWN');
}

export function readHashedBudgetJsonl(filePath, { maxBytes = 8 * 1024 * 1024, maxLineBytes = 64 * 1024 } = {}) {
  if (!fs.existsSync(filePath)) return [];
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) throw fail(`${path.basename(filePath)} exceeds the bounded budget-account size.`);
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(16 * 1024);
  let pending = '';
  let totalBytes = 0;
  let prefixHash = crypto.createHash('sha256');
  const rows = [];
  const consume = line => {
    if (!line) return;
    if (Buffer.byteLength(line) > maxLineBytes) throw fail(`${path.basename(filePath)} has a budget event over 64 KiB.`);
    const row = JSON.parse(line);
    const { eventSha256, ...unsigned } = row;
    if (!eventSha256 || crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex') !== eventSha256) {
      throw fail(`${path.basename(filePath)} has an unverified budget event hash.`);
    }
    const journal = row.journal;
    if (!journal || journal.lineNumber !== rows.length + 1 || journal.byteOffset !== totalBytes
      || journal.prefixSha256Before !== prefixHash.copy().digest('hex')) {
      throw fail(`${path.basename(filePath)} has a broken append-only budget journal prefix.`);
    }
    const encoded = Buffer.from(`${line}\n`, 'utf8');
    totalBytes += encoded.byteLength;
    prefixHash.update(encoded);
    rows.push(row);
  };
  try {
    let count;
    while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      pending += chunk.subarray(0, count).toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, newline).replace(/\r$/u, ''));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending) > maxLineBytes) throw fail(`${path.basename(filePath)} has an incomplete line over 64 KiB.`);
    }
  } finally { fs.closeSync(descriptor); }
  if (pending) throw fail(`${path.basename(filePath)} ends with an incomplete budget event.`);
  return rows;
}

export function appendHashedBudgetEvent(filePath, entry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const rows = readHashedBudgetJsonl(filePath);
  const prefixHash = crypto.createHash('sha256');
  let byteOffset = 0;
  if (fs.existsSync(filePath)) {
    const descriptor = fs.openSync(filePath, 'r');
    const chunk = Buffer.allocUnsafe(16 * 1024);
    try {
      let count;
      while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
        prefixHash.update(chunk.subarray(0, count));
        byteOffset += count;
      }
    } finally { fs.closeSync(descriptor); }
  }
  const unsigned = { ...entry, journal: { file: path.basename(filePath), lineNumber: rows.length + 1,
    byteOffset, prefixSha256Before: byteOffset ? prefixHash.copy().digest('hex') : EMPTY_HASH } };
  const eventSha256 = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  const line = Buffer.from(`${JSON.stringify({ ...unsigned, eventSha256 })}\n`, 'utf8');
  if (line.byteLength > 64 * 1024 || byteOffset + line.byteLength > 8 * 1024 * 1024) throw fail('R4 budget event exceeds its size limit.');
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    let written = 0;
    while (written < line.byteLength) written += fs.writeSync(descriptor, line, written, line.byteLength - written);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  return { eventSha256, lineNumber: rows.length + 1, byteOffset, rowBytes: line.byteLength };
}

function numericUsage(value, keys) {
  if (!value || keys.some(key => !Number.isFinite(Number(value[key])) || Number(value[key]) < 0)) {
    throw fail('R4 budget usage is missing or non-numeric; the account is closed to further requests.');
  }
  return Object.fromEntries(keys.map(key => [key, Number(value[key])]));
}

function expectedSourceApprovalEventFields() {
  return { event: 'request-limit-adjusted', executor: 'source', workerTaskId: STAGE27_R4_SOURCE_APPROVAL.workerTaskId,
    taskId: STAGE27_R4_SOURCE_APPROVAL.sourceTaskId, budgetWindowId: STAGE27_R4_SOURCE_APPROVAL.budgetWindowId,
    approvalPath: STAGE27_R4_SOURCE_APPROVAL.relativePath, approvalSha256: STAGE27_R4_SOURCE_APPROVAL.sha256,
    accountPrefixBytes: STAGE27_R4_SOURCE_APPROVAL.accountPrefixBytes,
    accountPrefixSha256: STAGE27_R4_SOURCE_APPROVAL.accountPrefixSha256,
    previousRequestLimit: STAGE27_R4_SOURCE_APPROVAL.previousRequestLimit,
    additionalRequests: STAGE27_R4_SOURCE_APPROVAL.additionalRequests,
    newRequestLimit: STAGE27_R4_SOURCE_APPROVAL.newRequestLimit,
    sourceLiveInitialization: true,
    usageAtAdjustment: { ...STAGE27_R4_SOURCE_APPROVAL.sourceUsageAtApproval } };
}

function sourceApprovalEventFields(approvalToken) {
  if (!approvalToken || !validatedSourceApprovals.has(approvalToken)) {
    throw fail('Q27.5 request-limit adjustment has no verified source-only approval token.');
  }
  return expectedSourceApprovalEventFields();
}

function assertApprovalEventMatches(row, approvalToken) {
  const expected = approvalToken === null ? expectedSourceApprovalEventFields() : sourceApprovalEventFields(approvalToken);
  for (const [key, value] of Object.entries(expected)) {
    if (JSON.stringify(row[key]) !== JSON.stringify(value)) {
      throw fail(`Q27.5 source request-limit adjustment has an invalid ${key} field.`);
    }
  }
}

export function createSourceRequestLimitAdjustmentEvent(approvalToken) {
  return sourceApprovalEventFields(approvalToken);
}

export function validateSourceRequestLimitApproval({ approval, approvalFileSha256, executor, taskId,
  budgetWindowId, approvalPath, sourceAccountPath, accountPrefixBytes, accountTotalBytes,
  rows, allowAppend = false }) {
  const policy = STAGE27_R4_SOURCE_APPROVAL;
  const expectedApprovalPath = path.resolve(projectRoot, policy.relativePath);
  const expectedAccountPath = path.resolve(projectRoot, policy.sourceAccountRelativePath);
  if (executor !== 'source' || taskId !== policy.sourceTaskId) {
    throw fail('Only the approved source task may apply the Q27.5 cumulative request allowance adjustment.', 'R4_SOURCE_APPROVAL_IDENTITY');
  }
  if (approvalPath !== expectedApprovalPath || approvalFileSha256 !== policy.sha256
    || approvalPath !== path.resolve(projectRoot, policy.relativePath)) {
    throw fail('Q27.5 source allowance approval path or SHA-256 does not match the one-time approval.', 'R4_SOURCE_APPROVAL_MISMATCH');
  }
  if (sourceAccountPath !== expectedAccountPath || budgetWindowId !== policy.budgetWindowId) {
    throw fail('Q27.5 source allowance approval is bound to a different persistent account or budget window.', 'R4_SOURCE_APPROVAL_MISMATCH');
  }
  if (!approval || approval.recordType !== 'stage27-r4-source-sol-source-only-extra12-approval'
    || approval.executor !== 'source' || approval.sourceTaskId !== policy.sourceTaskId
    || approval.workerTaskId !== policy.workerTaskId || approval.budgetWindowId !== policy.budgetWindowId
    || approval.originalSourceRequestLimit !== policy.previousRequestLimit
    || approval.additionalRequestsOnce !== policy.additionalRequests
    || approval.newSourceCumulativeRequestLimit !== policy.newRequestLimit
    || approval.workerCumulativeRequestLimitUnchanged !== STAGE27_R4_MODEL_LIMITS.requests
    || approval.previousStageRequestLimit !== 48 || approval.newStageCumulativeRequestLimit !== 60
    || approval.unchangedSourceLimits?.tokens !== STAGE27_R4_MODEL_LIMITS.tokens
    || approval.unchangedSourceLimits?.estimatedCostUsd !== STAGE27_R4_MODEL_LIMITS.estimatedCostUsd
    || approval.unchangedSourceLimits?.activeIntervalMs !== STAGE27_R4_MODEL_LIMITS.activeIntervalMs
    || approval.unchangedGraphToolResourceLimits !== true
    || approval.noAccountReset !== true || approval.persistentWindowMustNotChange !== true
    || approval.approvalMayNotBeRepeatedOrStacked !== true
    || approval.sourceAloneAppendsActualAdjustmentDuringNextLiveInitialization !== true
    || approval.workerThisTurnAllActualExternalRequestsPermitted !== 0
    || approval.workerMustNotMutateRealBudgetAccounts !== true
    || approval.r5AuthorizedByThisRecord !== false || approval.gitWrites !== false) {
    throw fail('Q27.5 source allowance approval content does not match its fixed source-only policy.', 'R4_SOURCE_APPROVAL_MISMATCH');
  }
  const prefix = approval.accountPrefixAtApproval;
  if (!prefix || path.resolve(prefix.path) !== expectedAccountPath || prefix.bytes !== policy.accountPrefixBytes
    || prefix.sha256 !== policy.accountPrefixSha256 || !Buffer.isBuffer(accountPrefixBytes)
    || accountPrefixBytes.byteLength !== policy.accountPrefixBytes
    || crypto.createHash('sha256').update(accountPrefixBytes).digest('hex') !== policy.accountPrefixSha256) {
    throw fail('Q27.5 source allowance approval does not match the frozen persistent-account prefix.', 'R4_SOURCE_APPROVAL_PREFIX');
  }
  if (Number(accountTotalBytes) < policy.accountPrefixBytes || Number(accountTotalBytes) > 8 * 1024 * 1024) {
    throw fail('Q27.5 source account size is outside its bounded approved state.', 'R4_SOURCE_APPROVAL_PREFIX');
  }
  const accountPrefix = approval.sourceUsageAtApproval;
  if (!accountPrefix || ['requests', 'tokens', 'activeIntervalMs'].some(key => Number(accountPrefix[key])
    !== Number(policy.sourceUsageAtApproval[key]))
    || Math.abs(Number(accountPrefix.estimatedCostUsd) - policy.sourceUsageAtApproval.estimatedCostUsd) > 1e-8) {
    throw fail('Q27.5 source allowance approval usage does not match the approved cumulative account state.');
  }
  if (!Array.isArray(rows) || !rows.length || rows[0].event !== 'baseline-reconciled'
    || rows.some(row => row.taskId !== policy.sourceTaskId || row.budgetWindowId !== policy.budgetWindowId)) {
    throw fail('Q27.5 source allowance approval account contains an unexpected executor or persistent window.');
  }
  const adjustments = rows.map((row, index) => ({ row, index })).filter(item => item.row.event === 'request-limit-adjusted');
  if (adjustments.length > 1) throw fail('Q27.5 source allowance approval has already been repeated or stacked.');
  if (adjustments.length === 0) {
    if (!allowAppend || rows.length !== policy.accountPrefixLines || Number(accountTotalBytes) !== policy.accountPrefixBytes) {
      throw fail('Q27.5 source allowance may only be appended once to the exact untouched approved account prefix.');
    }
  } else {
    if (adjustments[0].index !== policy.accountPrefixLines || Number(accountTotalBytes) <= policy.accountPrefixBytes) {
      throw fail('Q27.5 source allowance adjustment is not the first append after the approved account prefix.');
    }
    const sourceUsage = adjustments[0].row.usageAtAdjustment;
    if (!sourceUsage || ['requests', 'tokens', 'activeIntervalMs'].some(key => Number(sourceUsage[key])
      !== Number(policy.sourceUsageAtApproval[key]))
      || Math.abs(Number(sourceUsage.estimatedCostUsd) - policy.sourceUsageAtApproval.estimatedCostUsd) > 1e-8) {
      throw fail('Q27.5 source allowance adjustment was not appended at the approved cumulative usage.');
    }
    assertApprovalEventMatches(adjustments[0].row, null);
  }
  const approvalStat = fs.statSync(approvalPath);
  if (approvalStat.size > 64 * 1024 || crypto.createHash('sha256').update(fs.readFileSync(approvalPath)).digest('hex') !== policy.sha256
    || approvalFileSha256 !== policy.sha256) {
    throw fail('Q27.5 source allowance approval file hash changed.', 'R4_SOURCE_APPROVAL_MISMATCH');
  }
  const token = Object.freeze({ __stage27R4SourceApproval: true, taskId: policy.sourceTaskId,
    budgetWindowId: policy.budgetWindowId, approvalPath: policy.relativePath, approvalSha256: policy.sha256,
    accountPrefixBytes: policy.accountPrefixBytes, accountPrefixSha256: policy.accountPrefixSha256,
    previousRequestLimit: policy.previousRequestLimit, additionalRequests: policy.additionalRequests,
    newRequestLimit: policy.newRequestLimit, sourceUsageAtApproval: policy.sourceUsageAtApproval });
  validatedSourceApprovals.add(token);
  return token;
}

export function verifySourceRequestLimitApproval({ approvalPath, approvalSha256, executor, taskId,
  budgetWindowId, sourceAccountPath, rows, allowAppend = false }) {
  const expectedApprovalPath = path.resolve(projectRoot, STAGE27_R4_SOURCE_APPROVAL.relativePath);
  const expectedAccountPath = path.resolve(projectRoot, STAGE27_R4_SOURCE_APPROVAL.sourceAccountRelativePath);
  const resolvedApprovalPath = path.resolve(projectRoot, String(approvalPath || ''));
  const resolvedAccountPath = path.resolve(String(sourceAccountPath || ''));
  if (resolvedApprovalPath !== expectedApprovalPath || resolvedAccountPath !== expectedAccountPath) {
    throw fail('Q27.5 source approval or persistent-account path is not the approved source-only path.', 'R4_SOURCE_APPROVAL_MISMATCH');
  }
  const approvalStat = fs.statSync(resolvedApprovalPath);
  if (approvalStat.size > 64 * 1024) throw fail('Q27.5 source approval file exceeds its bounded read limit.');
  const approvalBytes = fs.readFileSync(resolvedApprovalPath);
  const approvalFileSha256 = crypto.createHash('sha256').update(approvalBytes).digest('hex');
  const accountStat = fs.statSync(resolvedAccountPath);
  if (accountStat.size > 8 * 1024 * 1024) throw fail('Q27.5 source account exceeds its bounded read limit.');
  const descriptor = fs.openSync(resolvedAccountPath, 'r');
  const prefix = Buffer.alloc(STAGE27_R4_SOURCE_APPROVAL.accountPrefixBytes);
  let prefixBytesRead = 0;
  try {
    while (prefixBytesRead < prefix.byteLength) {
      const count = fs.readSync(descriptor, prefix, prefixBytesRead, prefix.byteLength - prefixBytesRead, prefixBytesRead);
      if (count <= 0) break;
      prefixBytesRead += count;
    }
  } finally { fs.closeSync(descriptor); }
  return validateSourceRequestLimitApproval({ approval: JSON.parse(approvalBytes.toString('utf8')),
    approvalFileSha256, executor, taskId, budgetWindowId, approvalPath: resolvedApprovalPath,
    sourceAccountPath: resolvedAccountPath, accountPrefixBytes: prefix.subarray(0, prefixBytesRead),
    accountTotalBytes: accountStat.size, rows, allowAppend });
}

export function reconcileModelBudget({ rows, taskId, budgetWindowId, baselineUsage,
  limits = STAGE27_R4_MODEL_LIMITS, sourceRequestLimitApproval = null }) {
  if (!Array.isArray(rows) || !rows.length || rows[0].event !== 'baseline-reconciled') {
    throw fail('Q27.5 account has no reconciled immutable baseline.');
  }
  if (rows.some(row => row.taskId !== taskId || row.budgetWindowId !== budgetWindowId)) {
    throw fail('Q27.5 account mixes executor IDs or persistent window IDs.');
  }
  const base = numericUsage(rows[0].cumulativeUsage, ['requests', 'tokens', 'estimatedCostUsd', 'activeIntervalMs']);
  if (baselineUsage && ['requests', 'tokens', 'estimatedCostUsd', 'activeIntervalMs']
    .some(key => Math.abs(base[key] - Number(baselineUsage[key])) > (key === 'estimatedCostUsd' ? 1e-8 : 0))) {
    throw fail('Q27.5 immutable baseline does not match the reconciled account start.');
  }
  const usage = { ...base };
  const openWindows = new Set();
  const windowRequests = new Map();
  const activeAttempts = new Set();
  const adjustmentRows = rows.filter(row => row.event === 'request-limit-adjusted');
  if (adjustmentRows.length > 1) throw fail('Q27.5 source request allowance may not be repeated or stacked.');
  if (adjustmentRows.length && !sourceRequestLimitApproval) {
    throw fail('Q27.5 source request allowance event has no verified approval context.');
  }
  if (!adjustmentRows.length && sourceRequestLimitApproval) {
    throw fail('Q27.5 verified source request allowance has no matching append-only account event.');
  }
  let requestLimit = limits.requests;
  for (const row of rows.slice(1)) {
    if (row.event === 'request-limit-adjusted') {
      assertApprovalEventMatches(row, sourceRequestLimitApproval);
      if (requestLimit !== STAGE27_R4_MODEL_LIMITS.requests || !Number.isFinite(Date.parse(row.at))) {
        throw fail('Q27.5 source request allowance does not start from the original cumulative limit.');
      }
      if (openWindows.size || activeAttempts.size) throw fail('Q27.5 source request allowance may only be appended between completed attempts.');
      const adjustmentUsage = numericUsage(row.usageAtAdjustment, ['requests', 'tokens', 'estimatedCostUsd', 'activeIntervalMs']);
      if (Object.keys(adjustmentUsage).some(key => Math.abs(adjustmentUsage[key] - usage[key]) > (key === 'estimatedCostUsd' ? 1e-8 : 0))) {
        throw fail('Q27.5 source request allowance was not appended at the exact current cumulative usage.');
      }
      const approvedUsage = STAGE27_R4_SOURCE_APPROVAL.sourceUsageAtApproval;
      if (Object.keys(adjustmentUsage).some(key => Math.abs(adjustmentUsage[key] - approvedUsage[key]) > (key === 'estimatedCostUsd' ? 1e-8 : 0))) {
        throw fail('Q27.5 source request allowance does not match its approved usage snapshot.');
      }
      requestLimit = STAGE27_R4_SOURCE_APPROVAL.newRequestLimit;
    } else if (row.event === 'repair-attempt-reserved') {
      if (!row.runId || activeAttempts.has(row.runId)) throw fail('Q27.5 attempt reservation is malformed or duplicated.');
      activeAttempts.add(row.runId);
    } else if (row.event === 'repair-window-started') {
      if (!row.runId || openWindows.has(row.runId)) throw fail('Q27.5 model window start is duplicated or unidentified.');
      openWindows.add(row.runId);
      windowRequests.set(row.runId, 0);
    } else if (row.event === 'repair-provider-usage-recorded') {
      const item = numericUsage(row.usage, ['requests', 'tokens', 'estimatedCostUsd']);
      if (!row.runId || !openWindows.size || !activeAttempts.size) throw fail('Q27.5 usage has no matching open reserved attempt.');
      const windowRunId = [...openWindows][0];
      if (openWindows.size !== 1) throw fail('Q27.5 usage cannot be assigned across multiple open windows.');
      usage.requests += item.requests;
      usage.tokens += item.tokens;
      usage.estimatedCostUsd += item.estimatedCostUsd;
      windowRequests.set(windowRunId, (windowRequests.get(windowRunId) || 0) + item.requests);
    } else if (row.event === 'repair-window-finished') {
      if (!row.runId || !openWindows.has(row.runId) || !Number.isFinite(Number(row.activeIntervalMs))) {
        throw fail('Q27.5 window finish has unknown timing or no matching start.');
      }
      if (row.usageReconciled === false) {
        throw fail('Q27.5 model window completed with unknown provider usage; the remaining account is not trusted.');
      }
      if ((windowRequests.get(row.runId) || 0) <= 0) throw fail('Q27.5 started a model window but has no reconciled provider usage.');
      usage.activeIntervalMs += Number(row.activeIntervalMs);
      openWindows.delete(row.runId);
      windowRequests.delete(row.runId);
      activeAttempts.delete(row.runId);
    } else if (row.event === 'repair-attempt-finished') {
      if (!row.runId || !activeAttempts.has(row.runId)) throw fail('Q27.5 attempt completion has no matching reservation.');
      if (row.providerCallsMayHaveStarted === true && row.windowFinished !== true) {
        throw fail('Q27.5 attempt may have called the model but has no completed usage/window reconciliation.');
      }
      activeAttempts.delete(row.runId);
    } else {
      throw fail(`Q27.5 contains an unknown event (${String(row.event || 'missing')}); usage is not trusted.`);
    }
  }
  if (openWindows.size || activeAttempts.size) throw fail('Q27.5 has an in-flight or unfinished attempt; no request is permitted.');
  if (requestLimit === STAGE27_R4_SOURCE_APPROVAL.newRequestLimit
    && limits.requests !== STAGE27_R4_MODEL_LIMITS.requests) {
    throw fail('Q27.5 source request allowance cannot change the original model limits object.');
  }
  if (requestLimit === STAGE27_R4_MODEL_LIMITS.requests && limits.requests !== STAGE27_R4_MODEL_LIMITS.requests) {
    throw fail('Q27.5 model request limit cannot be raised without the approved source event.');
  }
  const remaining = { requests: requestLimit - usage.requests, tokens: limits.tokens - usage.tokens,
    estimatedCostUsd: Number((limits.estimatedCostUsd - usage.estimatedCostUsd).toFixed(8)),
    activeIntervalMs: limits.activeIntervalMs - usage.activeIntervalMs };
  if (Object.values(remaining).some(value => !Number.isFinite(value) || value < 0)) throw fail('Q27.5 account is over its authorized cumulative limit.');
  return { cumulativeUsage: usage, remaining, limits: { ...limits, requests: requestLimit } };
}

export function reserveModelBudgetAttempt({ filePath, taskId, budgetWindowId, runId,
  limits = STAGE27_R4_MODEL_LIMITS, sourceRequestLimitApproval = null }) {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') throw fail('Q27.5 persistent model budget is locked by another attempt.', 'R4_MODEL_BUDGET_BUSY'); throw error; }
  try {
    fs.writeSync(lock, `${JSON.stringify({ taskId, runId, at: new Date().toISOString(), pid: process.pid })}\n`);
    fs.fsyncSync(lock);
    const rows = readHashedBudgetJsonl(filePath);
    const reconciled = reconcileModelBudget({ rows, taskId, budgetWindowId, limits, sourceRequestLimitApproval });
    if (Object.values(reconciled.remaining).some(value => value <= 0)) {
      throw fail('Q27.5 cumulative model budget is exhausted; no provider request is permitted.', 'R4_MODEL_BUDGET_EXHAUSTED');
    }
    if (sourceRequestLimitApproval) {
      const adjustmentIndex = rows.findIndex(row => row.event === 'request-limit-adjusted');
      if (adjustmentIndex < 0 || rows.slice(adjustmentIndex + 1).some(row => row.event === 'repair-attempt-reserved')) {
        throw fail('The source-only +12 approval permits one Q27.5 rerun reservation; that reservation already exists.',
          'R4_SOURCE_APPROVED_ATTEMPT_USED');
      }
    }
    appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-q275-budget-event', taskId, budgetWindowId,
      runId, event: 'repair-attempt-reserved', at: new Date().toISOString(),
      remainingBeforeAttempt: reconciled.remaining, providerCallsMayHaveStarted: false });
    return reconciled;
  } finally {
    try { fs.closeSync(lock); } catch { /* closed by a previous failure path */ }
    try { fs.unlinkSync(lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export function reconcileEnvironmentBudget({ rows, taskId, baselineUsed, limit = STAGE27_R4_ENV_LIMITS.requests }) {
  if (!Array.isArray(rows) || !rows.length || rows[0].event !== 'environment-budget-baseline-reconciled'
    || rows[0].taskId !== taskId || Number(rows[0].baselineUsed) !== Number(baselineUsed)) {
    throw fail('Q27.6 environment account does not match this executor baseline.');
  }
  let used = Number(baselineUsed);
  const open = new Set();
  for (const row of rows.slice(1)) {
    if (row.taskId !== taskId) throw fail('Q27.6 environment account contains another executor ID.');
    if (row.event === 'environment-provider-request-reserved') {
      if (!row.attemptId || open.has(row.attemptId)) throw fail('Q27.6 provider reservation is malformed.');
      used += 1;
      open.add(row.attemptId);
    } else if (row.event === 'environment-provider-request-finished') {
      if (!open.delete(row.attemptId) || !['success', 'failed'].includes(row.outcome)) {
        throw fail('Q27.6 provider completion does not match a reserved request.');
      }
    } else throw fail(`Q27.6 contains an unknown provider accounting event (${String(row.event || 'missing')}).`);
  }
  if (open.size) throw fail('Q27.6 has an in-flight provider request; further requests are blocked.');
  if (used > limit) throw fail('Q27.6 per-executor environment provider request limit is exhausted.');
  return { used, remaining: limit - used };
}

export async function reserveEnvironmentProviderRequest({ filePath, taskId, baselineUsed, provider,
  limit = STAGE27_R4_ENV_LIMITS.requests }) {
  if (!filePath || !taskId) return null;
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let lock;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) { if (error?.code === 'EEXIST') throw fail('Q27.6 provider budget is locked by another request.', 'R4_ENV_BUDGET_BUSY'); throw error; }
  try {
    fs.writeSync(lock, `${JSON.stringify({ taskId, at: new Date().toISOString(), pid: process.pid })}\n`);
    fs.fsyncSync(lock);
    let rows = readHashedBudgetJsonl(filePath);
    if (!rows.length) {
      appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-environment-budget-event', taskId,
        event: 'environment-budget-baseline-reconciled', baselineUsed, limit, at: new Date().toISOString() });
      rows = readHashedBudgetJsonl(filePath);
    }
    const account = reconcileEnvironmentBudget({ rows, taskId, baselineUsed, limit });
    if (account.remaining <= 0) {
      throw fail('Q27.6 cumulative environment provider request limit is exhausted.', 'R4_ENV_BUDGET_EXHAUSTED');
    }
    const attemptId = crypto.randomUUID();
    appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-environment-budget-event', taskId,
      event: 'environment-provider-request-reserved', attemptId, provider: String(provider || 'environment').slice(0, 80),
      usedBefore: account.used, at: new Date().toISOString() });
    return { attemptId, usedBefore: account.used, remainingAfterReserve: account.remaining - 1,
      finish(outcome) {
        const result = ['success', 'failed'].includes(outcome) ? outcome : 'failed';
        appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-environment-budget-event', taskId,
          event: 'environment-provider-request-finished', attemptId, outcome: result, at: new Date().toISOString() });
      } };
  } finally {
    try { fs.closeSync(lock); } catch { /* closed by a previous failure path */ }
    try { fs.unlinkSync(lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
}

export function initializeEnvironmentBudgetFile({ filePath, taskId, baselineUsed, limit = STAGE27_R4_ENV_LIMITS.requests }) {
  const rows = readHashedBudgetJsonl(filePath);
  if (rows.length) return reconcileEnvironmentBudget({ rows, taskId, baselineUsed, limit });
  appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-environment-budget-event', taskId,
    event: 'environment-budget-baseline-reconciled', baselineUsed, limit, at: new Date().toISOString() });
  return reconcileEnvironmentBudget({ rows: readHashedBudgetJsonl(filePath), taskId, baselineUsed, limit });
}
