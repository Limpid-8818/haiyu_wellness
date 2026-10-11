import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { withDatabaseApi, withBothDatabaseApis, databaseQuery, databaseExec, login, request, assertOk } from './q10-helpers.js';
import { runRegisteredQuest, terminalQuestsForRange } from '../quest-registry.js';
import { runStage27BackendRegression, runStage27BrowserAcceptance } from './q26.js';
import { runStage27EnvironmentBrowser, runStage27LiveTraceBrowser } from '../resources/stage26-browser-acceptance.js';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { runStage27R2QuestMap, runStage27R2Rtm } from './stage27-r2-reconciliation.js';
import { validateQ275ConfirmationContract } from '../resources/stage27-r4-confirmation-contract.js';
import { q275SourceApprovalParameters } from '../resources/stage27-r4-cli-approval-context.js';
import { runStage27R5CleanBrowserAcceptance } from '../resources/stage27-r5-clean-browser-acceptance.js';
import { deriveEnvironmentFunctionalAcceptance, resolveStage27R5ExecutorIdentity,
  verifyStage27R5SourceAcceptance, retainStage27R5ExecutorObservation,
  verifyStage27R5SourceLedgerWindow, buildStage27R5RowSourceEvidence, STAGE27_R5_SOURCE_PACKAGING_HANDOFF,
  STAGE27_R5_ROW_PROVENANCE_HANDOFF, STAGE27_R5_OFFLINE_BASELINE } from '../resources/stage27-r5-offline-guards.js';
import { appendHashedBudgetEvent, initializeEnvironmentBudgetFile, readHashedBudgetJsonl,
  reconcileEnvironmentBudget, reconcileModelBudget, reserveModelBudgetAttempt,
  resolveStage27R4Executor, STAGE27_R4_ENV_LIMITS, STAGE27_R4_MODEL_LIMITS,
  STAGE27_R4_SOURCE_APPROVAL, createSourceRequestLimitAdjustmentEvent,
  verifySourceRequestLimitApproval } from '../resources/stage27-r4-budget-accounts.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const invocationQuestId = process.argv.find(value => /^Q27\.(?:[2-4]|[7-9])$/u.test(value)) || '';
const stage27R3Invocation = Boolean(process.env.CODEX_TASK_ID && ['Q27.2', 'Q27.3', 'Q27.4'].includes(invocationQuestId));
const stage27R4QuestId = process.argv.find(value => ['Q27.5', 'Q27.6'].includes(value)) || '';
const stage27R4Invocation = Boolean(process.env.CODEX_TASK_ID && process.env.CODEX_STAGE27_SCOPE === 'R4' && stage27R4QuestId);
const stage27R5QuestId = process.argv.find(value => ['Q27.7', 'Q27.8', 'Q27.9'].includes(value)) || '';
const stage27R5Invocation = Boolean(process.env.CODEX_TASK_ID && process.env.CODEX_STAGE27_SCOPE === 'R5'
  && (stage27R5QuestId || (process.argv.includes('--stage') && process.argv[process.argv.indexOf('--stage') + 1] === '27')));
const taskSlug = String(process.env.CODEX_TASK_ID || 'unmanaged').replace(/[^A-Za-z0-9_-]/gu, '-');
const invocationStamp = new Date().toISOString().replace(/[^0-9TZ]/gu, '-');
const invocationRunId = stage27R3Invocation
  ? `${taskSlug}-${invocationQuestId}-${invocationStamp}-${process.pid}-${crypto.randomUUID()}`
  : stage27R4Invocation ? `${taskSlug}-${stage27R4QuestId}-${invocationStamp}-${process.pid}-${crypto.randomUUID()}`
    : stage27R5Invocation ? `${taskSlug}-${stage27R5QuestId || 'Q27-stage'}-${invocationStamp}-${process.pid}-${crypto.randomUUID()}` : null;
const stage27R3Root = path.join(projectRoot, 'output/resource-audit/stage27-r3', taskSlug);
const stage27R3LedgerPath = path.join(stage27R3Root, 'execution-ledger.jsonl');
const stage27R4Root = path.join(projectRoot, 'output/resource-audit/stage27-r4', taskSlug);
const stage27R4LedgerPath = path.join(stage27R4Root, 'execution-ledger.jsonl');
const stage27R5Root = path.join(projectRoot, 'output/resource-audit/stage27-r5', taskSlug);
const stage27R5LedgerPath = path.join(stage27R5Root, 'execution-ledger.jsonl');
const stage27R5BaselinePath = path.join(projectRoot, 'output/resource-audit/stage27-r5-source-sol-complete-handoff-baseline-20261011.json');
const stage27R5OfflineBaselinePath = path.join(projectRoot, 'output/resource-audit/stage27-r5-source-sol-original-task-offline-repair-handoff-baseline-20261011.json');
const stage27R5PackagingHandoffPath = path.join(projectRoot, STAGE27_R5_SOURCE_PACKAGING_HANDOFF.path);
const stage27R4OriginalBaselinePath = path.join(projectRoot, 'output/resource-audit/stage27-r4-source-sol-original-task-repair-handoff-baseline-20261010.json');
const stage27R4BaselinePath = path.join(projectRoot, 'output/resource-audit/stage27-r4-source-sol-offline-repair-handoff-baseline-20261010.json');
let stage27R4BudgetWindowId = stage27R4Invocation && stage27R4QuestId === 'Q27.5'
  ? 'f4f42408-26aa-4113-a88b-c3f4bdba4e52' : null;
const stage27R4BudgetAccountPath = path.join(stage27R4Root, 'q275-persistent-model-budget.jsonl');
const stage27R4EnvironmentBudgetAccountPath = path.join(stage27R4Root, 'q276-persistent-environment-budget.jsonl');
const stage27R4EvidencePath = stage27R4Invocation
  ? path.join(stage27R4Root, `${invocationRunId}-${stage27R4QuestId.replace('.', '')}-evidence.jsonl`) : null;
const stage27R4ReceiptPath = stage27R4Invocation
  ? path.join(stage27R4Root, `${invocationRunId}-receipt.json`) : null;
const stage27R4StartMarkerPath = stage27R4Invocation
  ? path.join(stage27R4Root, `${stage27R4QuestId.replace('.', '')}-repair-${invocationRunId}-started.json`) : null;
const stage27R4StartReservePath = stage27R4Invocation
  ? path.join(stage27R4Root, `${stage27R4QuestId.replace('.', '')}-repair-${invocationRunId}-attempt-reserved.json`) : null;
const stage27R5EvidencePath = stage27R5Invocation
  ? path.join(stage27R5Root, `${invocationRunId}-${(stage27R5QuestId || 'Q27-stage').replace('.', '')}-evidence.jsonl`) : null;
const stage27R5RtmCsvPath = stage27R5Invocation ? path.join(stage27R5Root, `${invocationRunId}-rtm109-evidence.csv`) : null;
const stage27R5RtmSummaryPath = stage27R5Invocation ? path.join(stage27R5Root, `${invocationRunId}-rtm109-evidence.json`) : null;
const stage27R5AggregatePath = stage27R5Invocation ? path.join(stage27R5Root, `${invocationRunId}-full-stage-aggregate.json`) : null;
let stage27R4EventSequence = 0;
let stage27R4LastAppendReceipts = [];
let stage27R5EventSequence = 0;
let stage27R5LastAppendReceipts = [];
let stage27R5ExecutorIdentityCache = null;
const priorEvidencePath = path.join(projectRoot, 'output/resource-audit/stage27-execution-evidence-20261009.jsonl');
const legacyEvidencePath = path.join(projectRoot, 'output/resource-audit/stage27-repair-execution-evidence-20261009.jsonl');
const legacyQ272EvidencePath = path.join(projectRoot, 'output/resource-audit/stage27-repair-q272-backend-evidence-20261009.jsonl');
const evidencePath = stage27R3Invocation ? path.join(stage27R3Root, `${invocationRunId}-execution.jsonl`)
  : stage27R4Invocation ? stage27R4EvidencePath : stage27R5Invocation ? stage27R5EvidencePath : legacyEvidencePath;
const q272EvidencePath = stage27R3Invocation && invocationQuestId === 'Q27.2'
  ? path.join(stage27R3Root, `${invocationRunId}-backend.jsonl`) : legacyQ272EvidencePath;
const q275EvidencePath = stage27R4Invocation && stage27R4QuestId === 'Q27.5' ? stage27R4EvidencePath
  : path.join(projectRoot, 'output/resource-audit/stage27-repair-q275-live-attempt-20261009.jsonl');
const q276EvidencePath = stage27R4Invocation && stage27R4QuestId === 'Q27.6' ? stage27R4EvidencePath
  : path.join(projectRoot, 'output/resource-audit/stage27-repair-q276-provider-evidence-20261009.jsonl');
const rtmPath = path.resolve(projectRoot, '../docs/RTM当前实现映射.md');
const rtmCsvPath = stage27R5Invocation ? stage27R5RtmCsvPath
  : path.join(projectRoot, 'output/resource-audit/stage27-final-rtm-acceptance-20261010.csv');
const rtmSummaryPath = stage27R5Invocation ? stage27R5RtmSummaryPath
  : path.join(projectRoot, 'output/resource-audit/stage27-final-rtm-acceptance-20261010.json');
const aggregatePath = stage27R5Invocation ? stage27R5AggregatePath
  : path.join(projectRoot, 'output/resource-audit/stage27-final-full-stage-aggregate-20261010.json');
const sourceFinalPath = path.join(projectRoot, 'output/resource-audit/stage26-source-sol-final-independent-acceptance-and-handoff-20261009.json');
const limits = Object.freeze({ logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 });
let baseTerminalCoverage = null;
const requiredEnvironmentKeys = Object.freeze([
  'ENVIRONMENT_LOCATION_ID', 'ENVIRONMENT_LOCATION_NAME', 'ENVIRONMENT_LATITUDE', 'ENVIRONMENT_LONGITUDE',
  'ENVIRONMENT_TIME_ZONE'
]);

function appendEvidence(entry) {
  if (stage27R4Invocation) {
    appendBoundedJsonl(stage27R4EvidencePath, entry);
    return;
  }
  if (stage27R5Invocation) {
    appendStage27R5Event(stage27R5EvidencePath, entry);
    return;
  }
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ at: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...(stage27R3Invocation ? { runId: invocationRunId } : {}), ...entry })}\n`;
  const bytes = Buffer.byteLength(line);
  const destinations = stage27R3Invocation ? [evidencePath, stage27R3LedgerPath] : [evidencePath];
  for (const destination of destinations) {
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    const current = fs.existsSync(destination) ? fs.statSync(destination).size : 0;
    if (bytes > 48 * 1024 || current + bytes > 8 * 1024 * 1024) {
      throw new Error(`Stage27 execution evidence append exceeds 8 MiB: ${path.basename(destination)}`);
    }
  }
  for (const destination of destinations) fs.appendFileSync(destination, line, { encoding: 'utf8', mode: 0o600 });
}

function appendBoundedJsonl(filePath, entry, { maxBytes = 8 * 1024 * 1024, maxLineBytes = 64 * 1024 } = {}) {
  if (stage27R4Invocation) {
    return appendStage27R4Event(filePath, entry);
  }
  if (stage27R5Invocation) return appendStage27R5Event(filePath, entry);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ at: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...entry })}\n`;
  const bytes = Buffer.byteLength(line);
  const current = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (bytes > maxLineBytes || current + bytes > maxBytes) throw new Error(`bounded JSONL append exceeds its limit: ${path.basename(filePath)}`);
  fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
}

function recordQuest(quest, status, details = {}) {
  appendEvidence({ quest, status, ...details });
}

function inspectJsonlPrefix(filePath, { maxBytes = 8 * 1024 * 1024, maxLineBytes = 64 * 1024 } = {}) {
  if (!fs.existsSync(filePath)) return { bytes: 0, lines: 0, prefixSha256: crypto.createHash('sha256').digest('hex'), hash: crypto.createHash('sha256') };
  const stat = fs.statSync(filePath);
  assert.ok(stat.size <= maxBytes, `${path.basename(filePath)} is below ${maxBytes} bytes before append`);
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(16 * 1024);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let lines = 0;
  let lineBytes = 0;
  let lastByte = null;
  try {
    let count;
    while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      const part = chunk.subarray(0, count);
      hash.update(part);
      bytes += count;
      for (const byte of part) {
        lastByte = byte;
        if (byte === 0x0a) { lines += 1; lineBytes = 0; }
        else lineBytes += 1;
        assert.ok(lineBytes <= maxLineBytes, `${path.basename(filePath)} has a line over ${maxLineBytes} bytes`);
      }
    }
  } finally { fs.closeSync(descriptor); }
  assert.ok(bytes === 0 || lastByte === 0x0a, `${path.basename(filePath)} ends with a complete JSONL row`);
  return { bytes, lines, prefixSha256: hash.copy().digest('hex'), hash };
}

function appendHashedJsonl(filePath, baseEntry) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const prefix = inspectJsonlPrefix(filePath);
  const journal = { file: path.relative(projectRoot, filePath), lineNumber: prefix.lines + 1,
    byteOffset: prefix.bytes, prefixSha256Before: prefix.prefixSha256 };
  const unsigned = { ...baseEntry, journal };
  const eventSha256 = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  const line = Buffer.from(`${JSON.stringify({ ...unsigned, eventSha256 })}\n`, 'utf8');
  assert.ok(line.byteLength <= 64 * 1024, `${path.basename(filePath)} row is within 64 KiB`);
  assert.ok(prefix.bytes + line.byteLength <= 8 * 1024 * 1024, `${path.basename(filePath)} remains within 8 MiB`);
  const prefixSha256After = prefix.hash.copy().update(line).digest('hex');
  const descriptor = fs.openSync(filePath, 'a', 0o600);
  try {
    let written = 0;
    while (written < line.byteLength) written += fs.writeSync(descriptor, line, written, line.byteLength - written);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  return { file: journal.file, lineNumber: journal.lineNumber, byteOffset: journal.byteOffset,
    rowBytes: line.byteLength, eventSha256, prefixSha256Before: journal.prefixSha256Before, prefixSha256After };
}

function appendStage27R4Event(filePath, entry) {
  stage27R4EventSequence += 1;
  const eventName = String(entry.event || `${entry.quest || 'quest'}:${entry.status || 'event'}`).slice(0, 120);
  const eventId = crypto.createHash('sha256').update([
    process.env.CODEX_TASK_ID || '', invocationRunId || '', String(stage27R4EventSequence), eventName
  ].join('\0')).digest('hex');
  const baseEntry = { at: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, runId: invocationRunId, questId: stage27R4QuestId,
    budgetWindowId: stage27R4BudgetWindowId, eventSequence: stage27R4EventSequence,
    eventId, ...entry };
  const destinations = [...new Set([filePath, stage27R4LedgerPath])];
  stage27R4LastAppendReceipts = destinations.map(destination => appendHashedJsonl(destination, baseEntry));
  return stage27R4LastAppendReceipts;
}

function appendStage27R5Event(filePath, entry) {
  stage27R5EventSequence += 1;
  const eventName = String(entry.event || `${entry.quest || 'quest'}:${entry.status || 'event'}`).slice(0, 120);
  const eventId = crypto.createHash('sha256').update([
    process.env.CODEX_TASK_ID || '', invocationRunId || '', String(stage27R5EventSequence), eventName
  ].join('\0')).digest('hex');
  const baseEntry = { at: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, runId: invocationRunId, questId: stage27R5QuestId || 'Q27.aggregate',
    eventSequence: stage27R5EventSequence, eventId, ...entry };
  const destinations = [...new Set([filePath, stage27R5LedgerPath])];
  stage27R5LastAppendReceipts = destinations.map(destination => appendHashedJsonl(destination, baseEntry));
  return stage27R5LastAppendReceipts;
}

function beginStage27R4Quest(details = {}) {
  if (!stage27R4Invocation) return { started: true };
  fs.mkdirSync(stage27R4Root, { recursive: true, mode: 0o700 });
  const marker = { recordType: 'stage27-r4-one-shot-start', taskId: process.env.CODEX_TASK_ID,
    questId: stage27R4QuestId, runId: invocationRunId, budgetWindowId: stage27R4BudgetWindowId,
    startedAt: new Date().toISOString(), ...details };
  let reserveDescriptor;
  try { reserveDescriptor = fs.openSync(stage27R4StartReservePath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') return { started: false, markerPath: stage27R4StartReservePath };
    throw error;
  }
  try { fs.writeSync(reserveDescriptor, `${JSON.stringify({ ...marker, recordType: 'stage27-r4-repair-attempt-reservation' })}\n`); fs.fsyncSync(reserveDescriptor); }
  finally { fs.closeSync(reserveDescriptor); }
  const descriptor = fs.openSync(stage27R4StartMarkerPath, 'wx', 0o600);
  try { fs.writeSync(descriptor, `${JSON.stringify(marker)}\n`); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  appendBoundedJsonl(stage27R4EvidencePath, { event: 'quest-attempt-start', ...marker });
  return { started: true, markerPath: stage27R4StartMarkerPath };
}

function finalizeStage27R4Run(status, details = {}) {
  if (!stage27R4Invocation) return null;
  const receipt = { recordType: 'stage27-r4-run-receipt', taskId: process.env.CODEX_TASK_ID,
    questId: stage27R4QuestId, runId: invocationRunId, budgetWindowId: stage27R4BudgetWindowId,
    status, completedAt: new Date().toISOString(), startMarkerPath: path.relative(projectRoot, stage27R4StartMarkerPath),
    evidence: inspectJsonlPrefix(stage27R4EvidencePath), ledger: inspectJsonlPrefix(stage27R4LedgerPath),
    lastAppendReceipts: stage27R4LastAppendReceipts, ...details };
  const markerStat = fs.statSync(stage27R4StartMarkerPath);
  assert.ok(markerStat.size <= 64 * 1024, 'R4 one-shot start marker is below 64 KiB');
  receipt.startMarkerBytes = markerStat.size;
  receipt.startMarkerSha256 = crypto.createHash('sha256').update(fs.readFileSync(stage27R4StartMarkerPath)).digest('hex');
  delete receipt.evidence.hash;
  delete receipt.ledger.hash;
  fs.writeFileSync(stage27R4ReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return { path: path.relative(projectRoot, stage27R4ReceiptPath), ...receipt };
}

function blocked(message) {
  const error = new Error(message);
  error.stageBlocked = true;
  return error;
}

function readJsonUnderLimit(filePath, maxBytes = 16 * 1024 * 1024) {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) throw new Error(`JSON evidence exceeds ${maxBytes} bytes: ${path.basename(filePath)}`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stage27BrowserCodeFingerprint() {
  const roots = ['server/src', 'web/src'];
  const files = [
    'scripts/quests/q27.js', 'scripts/quests/q26.js', 'scripts/quests/helpers.js',
    'scripts/quests/q10-helpers.js', 'scripts/resources/stage26-browser-acceptance.js',
    'web/vite.config.js', 'package.json', 'server/package.json', 'web/package.json'
  ];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'output'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.(?:js|jsx|mjs|css|json)$/u.test(entry.name)) files.push(path.relative(projectRoot, absolute));
    }
  };
  for (const root of roots) visit(path.join(projectRoot, root));
  const digest = crypto.createHash('sha256');
  for (const relative of [...new Set(files)].sort()) {
    const content = fs.readFileSync(path.join(projectRoot, relative));
    digest.update(relative); digest.update('\0'); digest.update(content); digest.update('\0');
  }
  return digest.digest('hex');
}

function readJsonlUnderLimit(filePath, { maxBytes = 8 * 1024 * 1024, maxLineBytes = 64 * 1024 } = {}) {
  const stat = fs.statSync(filePath);
  assert.ok(stat.size <= maxBytes, `${path.basename(filePath)} is below ${maxBytes} bytes before streaming`);
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(16 * 1024);
  const rows = [];
  let pending = '';
  let lineNumber = 0;
  function consume(line) {
    if (!line) return;
    lineNumber += 1;
    assert.ok(Buffer.byteLength(line) <= maxLineBytes, `${path.basename(filePath)} line ${lineNumber} is within ${maxLineBytes} bytes`);
    rows.push(JSON.parse(line));
  }
  try {
    let count;
    while ((count = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) {
      pending += chunk.subarray(0, count).toString('utf8');
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        consume(pending.slice(0, newline).replace(/\r$/u, ''));
        pending = pending.slice(newline + 1);
      }
      assert.ok(Buffer.byteLength(pending) <= maxLineBytes, `${path.basename(filePath)} pending line is within ${maxLineBytes} bytes`);
    }
    consume(pending.replace(/\r$/u, ''));
  } finally { fs.closeSync(descriptor); }
  return rows;
}

function q275BudgetAccountRows() {
  return fs.existsSync(stage27R4BudgetAccountPath)
    ? readHashedBudgetJsonl(stage27R4BudgetAccountPath) : [];
}

function appendQ275BudgetEvent(entry) {
  return appendHashedJsonl(stage27R4BudgetAccountPath, { recordType: 'stage27-r4-q275-budget-event',
    taskId: process.env.CODEX_TASK_ID, budgetWindowId: stage27R4BudgetWindowId, runId: invocationRunId,
    ...entry });
}

function initializeQ275BudgetAccount() {
  const baseline = readJsonUnderLimit(stage27R4BaselinePath);
  const identity = resolveStage27R4Executor(process.env.CODEX_TASK_ID, baseline);
  let account = q275BudgetAccountRows();
  let initialUsage;
  let originalEvidence = null;
  let sourceRequestLimitApproval = null;
  const { approvalPath, approvalSha256 } = q275SourceApprovalParameters();
  if (identity.executor === 'worker') {
    assert.equal(Boolean(approvalPath || approvalSha256), false,
      'worker identity cannot supply or consume the source-only +12 request allowance approval');
    const originalBaseline = readJsonUnderLimit(stage27R4OriginalBaselinePath);
    assert.equal(originalBaseline.workerTaskId, identity.taskId, 'worker identity matches its frozen original baseline');
    const original = (originalBaseline.newR4ImmutableEvidence || []).find(item =>
      item.path.includes(`/${taskSlug}/`) && item.path.endsWith('-Q275-evidence.jsonl'));
    assert.ok(original, 'the frozen original Q27.5 evidence is present in the worker handoff baseline');
    const evidenceStat = fs.statSync(original.path);
    assert.ok(evidenceStat.size <= 16 * 1024 * 1024, 'original Q27.5 evidence is below its bounded read limit before hashing');
    const originalBytes = fs.readFileSync(original.path);
    assert.equal(originalBytes.byteLength, original.bytes, 'original Q27.5 evidence byte length matches the frozen baseline');
    assert.equal(crypto.createHash('sha256').update(originalBytes).digest('hex'), original.sha256,
      'original Q27.5 evidence hash matches the frozen baseline');
    const rows = readJsonlUnderLimit(original.path);
    const attempt = rows.find(row => row.event === 'attempt-final');
    assert.ok(attempt && attempt.finalStatus === 'FAIL', 'the retained original worker Q27.5 attempt remains a failed attempt');
    const requests = (attempt.runs || []).flatMap(run => run.providerAttempts?.providerRequests || []);
    initialUsage = { requests: requests.length,
      tokens: requests.reduce((sum, item) => sum + Number(item.inputTokens || 0) + Number(item.outputTokens || 0), 0),
      estimatedCostUsd: Number(requests.reduce((sum, item) => sum + Number(item.estimatedCostUsd || 0), 0).toFixed(8)),
      activeIntervalMs: Number(attempt.providerWindowElapsedMs) };
    const recorded = originalBaseline.workerBudgetAccount;
    for (const key of ['requests', 'tokens', 'activeIntervalMs']) assert.equal(initialUsage[key],
      key === 'requests' ? recorded.usedRequests : key === 'tokens' ? recorded.usedTokens : recorded.usedActiveIntervalMs,
    `original worker ${key} matches its frozen budget baseline`);
    assert.ok(Math.abs(initialUsage.estimatedCostUsd - recorded.usedEstimatedCostUsd) < 1e-8,
      'original worker cost matches its frozen budget baseline');
    assert.ok(account.length, 'worker must reuse the existing persistent account; a new full allowance is never created');
    assert.equal(identity.budgetWindowId, originalBaseline.workerBudgetAccount.budgetWindowId,
      'worker account keeps its original persistent window ID');
    originalEvidence = { path: path.relative(projectRoot, original.path), bytes: original.bytes, sha256: original.sha256 };
  } else {
    const source = baseline.sourceBudget;
    assert.equal(source.workerMayNotConsumeOrImpersonateSource, true, 'source allowance remains isolated from the worker');
    assert.equal(baseline.sourceTaskId, identity.taskId, 'source task matches its immutable R4 baseline');
    initialUsage = { requests: 0, tokens: 0, estimatedCostUsd: 0, activeIntervalMs: 0 };
    assert.ok(account.length, 'source must reuse its existing persistent Q27.5 account; a new allowance window is never created');
    stage27R4BudgetWindowId = account[0].budgetWindowId;
    assert.equal(stage27R4BudgetWindowId, STAGE27_R4_SOURCE_APPROVAL.budgetWindowId,
      'source keeps the original persistent Q27.5 request window');
    const existingAdjustments = account.filter(row => row.event === 'request-limit-adjusted');
    if (approvalPath || approvalSha256 || existingAdjustments.length) {
      const lockPath = `${stage27R4BudgetAccountPath}.lock`;
      let lock;
      try { lock = fs.openSync(lockPath, 'wx', 0o600); }
      catch (error) {
        if (error?.code === 'EEXIST') throw blocked('Q27.5 persistent model budget is locked by another source allowance or provider attempt.');
        throw error;
      }
      try {
        fs.writeSync(lock, `${JSON.stringify({ taskId: identity.taskId, runId: invocationRunId,
          reason: 'source-only-extra12-approval', at: new Date().toISOString(), pid: process.pid })}\n`);
        fs.fsyncSync(lock);
        account = q275BudgetAccountRows();
        const lockedAdjustments = account.filter(row => row.event === 'request-limit-adjusted');
        sourceRequestLimitApproval = verifySourceRequestLimitApproval({ approvalPath, approvalSha256,
          executor: identity.executor, taskId: identity.taskId, budgetWindowId: stage27R4BudgetWindowId,
          sourceAccountPath: stage27R4BudgetAccountPath, rows: account, allowAppend: lockedAdjustments.length === 0 });
        if (!lockedAdjustments.length) {
          const beforeAdjustment = reconcileModelBudget({ rows: account, taskId: identity.taskId,
            budgetWindowId: stage27R4BudgetWindowId, baselineUsage: initialUsage });
          for (const key of ['requests', 'tokens', 'activeIntervalMs']) assert.equal(
            beforeAdjustment.cumulativeUsage[key], STAGE27_R4_SOURCE_APPROVAL.sourceUsageAtApproval[key],
            `source ${key} usage matches the one-time approval snapshot`);
          assert.ok(Math.abs(beforeAdjustment.cumulativeUsage.estimatedCostUsd
            - STAGE27_R4_SOURCE_APPROVAL.sourceUsageAtApproval.estimatedCostUsd) < 1e-8,
          'source estimated cost matches the one-time approval snapshot');
          appendQ275BudgetEvent({ event: 'request-limit-adjusted',
            ...createSourceRequestLimitAdjustmentEvent(sourceRequestLimitApproval),
            at: new Date().toISOString() });
          account = q275BudgetAccountRows();
          sourceRequestLimitApproval = verifySourceRequestLimitApproval({ approvalPath, approvalSha256,
            executor: identity.executor, taskId: identity.taskId, budgetWindowId: stage27R4BudgetWindowId,
            sourceAccountPath: stage27R4BudgetAccountPath, rows: account, allowAppend: false });
        }
      } finally {
        try { fs.closeSync(lock); } catch { /* closed by a prior failure path */ }
        try { fs.unlinkSync(lockPath); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      }
    }
  }
  const originalWindowId = identity.executor === 'worker' ? identity.budgetWindowId : stage27R4BudgetWindowId;
  stage27R4BudgetWindowId = originalWindowId;
  const reconciled = reconcileModelBudget({ rows: account, taskId: identity.taskId,
    budgetWindowId: stage27R4BudgetWindowId, baselineUsage: initialUsage,
    sourceRequestLimitApproval });
  if (identity.executor === 'worker') {
    const handoffUsage = baseline.workerBudget?.actualCumulativeUsage;
    assert.ok(handoffUsage, 'latest handoff carries the worker cumulative usage total');
    for (const key of ['requests', 'tokens', 'activeIntervalMs']) assert.equal(reconciled.cumulativeUsage[key], handoffUsage[key],
      `worker ledger ${key} matches the immutable latest handoff total`);
    assert.ok(Math.abs(reconciled.cumulativeUsage.estimatedCostUsd - handoffUsage.estimatedCostUsd) < 1e-8,
      'worker ledger cost matches the immutable latest handoff total');
  }
  return { baseline, executor: identity.executor, originalEvidence, initialUsage,
    consumedBefore: reconciled.cumulativeUsage, remaining: reconciled.remaining,
    modelLimits: reconciled.limits, sourceRequestLimitApproval,
    requestLimitAdjustment: sourceRequestLimitApproval ? { approvalPath: STAGE27_R4_SOURCE_APPROVAL.relativePath,
      approvalSha256: STAGE27_R4_SOURCE_APPROVAL.sha256, previousRequestLimit: STAGE27_R4_SOURCE_APPROVAL.previousRequestLimit,
      additionalRequests: STAGE27_R4_SOURCE_APPROVAL.additionalRequests,
      newRequestLimit: STAGE27_R4_SOURCE_APPROVAL.newRequestLimit, budgetWindowId: stage27R4BudgetWindowId,
      sourceUsageAtAdjustment: STAGE27_R4_SOURCE_APPROVAL.sourceUsageAtApproval } : null,
    budgetWindowId: stage27R4BudgetWindowId };
}

function processReceipt(resource, startedAt, status) {
  return { status, exitCode: resource.exitCode ?? null, signal: resource.signal || null,
    elapsedMs: Date.now() - startedAt, pid: resource.pid, processStartTime: resource.processStartTime,
    processFingerprint: resource.processFingerprint, resourceId: resource.id, logPath: resource.logPath,
    logBytes: resource.logBytes ?? null, directoryPeakBytes: resource.directoryPeakBytes ?? null,
    maxLogBytes: resource.maxLogBytes, maxDirectoryBytes: resource.maxDirectoryBytes,
    trackedPidCount: resource.pids?.length ?? null, allTrackedPidsExited: resource.pids?.every(item => item.exitConfirmed === true) === true,
    outputTail: String(resource.tail || '').slice(-12 * 1024) };
}

async function runManaged(resourceSession, { label, command, args = [], cwd = projectRoot, timeoutMs = 900_000, env = {} }) {
  const startedAt = Date.now();
  const resource = await resourceSession.runProcess({ label, kind: 'test', role: 'acceptance-command', command, args, cwd,
    env: { PATH: process.env.PATH || '/usr/bin:/bin', TZ: 'UTC', CODEX_TASK_ID: process.env.CODEX_TASK_ID, ...env },
    leaseMs: limits.leaseMs }, { timeoutMs });
  const receipt = processReceipt(resource, startedAt, resource.status);
  if (resource.status !== 'exited' || resource.exitCode !== 0 || resource.signal || resource.timedOut || !receipt.allTrackedPidsExited) {
    const error = new Error(`${label} did not complete cleanly: ${JSON.stringify({ status: resource.status,
      exitCode: resource.exitCode, signal: resource.signal, timedOut: resource.timedOut, outputTail: receipt.outputTail })}`);
    error.receipt = receipt;
    throw error;
  }
  return receipt;
}

function sourceAcceptanceEvidence() {
  const acceptance = readJsonUnderLimit(sourceFinalPath);
  assert.equal(acceptance.overall, 'PASS_WITH_ACCEPTED_HISTORY_EXCEPTION');
  assert.equal(acceptance.all11SourcePngViewed, true);
  const paths = ['web/src/main.jsx', 'server/src/app.js', 'server/src/auth.js'];
  const unchanged = paths.map(relativePath => {
    const pathOnDisk = path.join(projectRoot, relativePath);
    const currentHash = crypto.createHash('sha256').update(fs.readFileSync(pathOnDisk)).digest('hex');
    const accepted = (acceptance.protectedCodeFiles || []).find(item =>
      item.path === pathOnDisk || item.path === `项目源码/${relativePath}` || item.path === relativePath);
    return { path: relativePath, currentHash, matchesStage26Accepted: Boolean(accepted && accepted.sha256 === currentHash) };
  });
  assert.ok(unchanged.every(item => item.matchesStage26Accepted), 'the browser/auth sources remain at the independently accepted Stage26 hashes');
  return { sourceAcceptance: sourceFinalPath, overall: acceptance.overall, all11ScreenshotsViewed: acceptance.all11SourcePngViewed,
    screenshots: acceptance.sourceScreenshots, unchangedBrowserSources: unchanged };
}

function stage27LegacyBrowserCoverage() {
  const record = latestStage27QuestRecords().get('Q27.3');
  assert.ok(record && record.status === 'PASS', 'fresh Stage27 browser evidence passed before Q27.1 reconciliation');
  assert.equal(record.taskId, process.env.CODEX_TASK_ID, 'browser result belongs to this Stage27 task');
  assert.equal(typeof record.evidencePath, 'string');
  const evidencePathOnDisk = path.resolve(record.evidencePath);
  const playwrightRoot = path.join(projectRoot, 'output/playwright');
  const evidenceRelative = path.relative(playwrightRoot, evidencePathOnDisk);
  assert.ok(evidenceRelative && !evidenceRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(evidenceRelative),
    'browser JSON is contained under the retained Stage27 Playwright evidence directory');
  const browserEvidence = readJsonUnderLimit(evidencePathOnDisk);
  assert.equal(browserEvidence.taskId, process.env.CODEX_TASK_ID);
  assert.equal(browserEvidence.status, 'PASS');
  const pages = browserEvidence.browserFlow?.legacyBasePages;
  assert.ok(pages && pages.newsTitle && pages.guestName && pages.assistantReplyVisible === true,
    'fresh browser flow opened the legacy news, guest, and assistant pages');
  const expectedScreenshots = {
    publicNewsHome: 'publicNewsHome', publicNewsDetail: 'publicNewsDetail',
    guestProfile: 'guestProfile', healthRecords: 'healthRecords', assistant: 'assistant'
  };
  const screenshotEvidence = {};
  for (const [key, sourceKey] of Object.entries(expectedScreenshots)) {
    const screenshotPath = pages.screenshots?.[sourceKey];
    assert.equal(typeof screenshotPath, 'string', `legacy ${sourceKey} screenshot path is present`);
    const resolved = path.resolve(screenshotPath);
    assert.equal(path.dirname(resolved), path.dirname(evidencePathOnDisk),
      `${sourceKey} screenshot is from the same fresh browser attempt`);
    const stat = fs.statSync(resolved);
    assert.ok(stat.isFile() && stat.size > 1024, `${sourceKey} screenshot is a non-empty PNG`);
    screenshotEvidence[key] = { path: path.relative(projectRoot, resolved), bytes: stat.size,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex') };
  }
  return { status: 'PASS', sourceQuest: 'Q27.3', sourceTaskId: browserEvidence.taskId,
    observedAt: browserEvidence.observedAt, evidencePath: path.relative(projectRoot, evidencePathOnDisk),
    legacyPages: { newsTitle: pages.newsTitle, guestName: pages.guestName,
      healthRecordCount: pages.healthRecordCount, assistantReplyVisible: pages.assistantReplyVisible },
    screenshots: screenshotEvidence };
}

async function runQ271({ resourceSession }) {
  const results = [];
  const test = await runManaged(resourceSession, { label: 'stage27-q271-npm-test', command: 'npm', args: ['test'] });
  const match = test.outputTail.match(/# tests (\d+)\s+# suites (\d+)\s+# pass (\d+)\s+# fail (\d+)/);
  assert.ok(match, 'npm test summary is present in the bounded tail');
  assert.equal(Number(match[3]), 58, 'all current server tests pass');
  assert.equal(Number(match[4]), 0);
  results.push({ command: 'npm test', ...test, tests: Number(match[1]), suites: Number(match[2]), passed: Number(match[3]), failed: Number(match[4]) });

  const build = await runManaged(resourceSession, { label: 'stage27-q271-npm-build', command: 'npm', args: ['run', 'build'] });
  assert.match(build.outputTail, /✓ built in/u, 'Vite production build completed');
  results.push({ command: 'npm run build', ...build });

  const questMapPath = path.join(projectRoot, '../QuestMap.md');
  const questMapStat = fs.statSync(questMapPath);
  assert.ok(questMapStat.size <= 2 * 1024 * 1024, 'base QuestMap is read under a 2 MiB bound');
  const questMap = fs.readFileSync(questMapPath, 'utf8');
  const legacyQuestIds = [...questMap.matchAll(/^\s*#{2,4}\s*.*?Quest\s+(\d+\.\d+)\s*[：:]?\s*(.*)$/gmu)]
    .filter(match => Number(match[1].split('.')[0]) <= 8)
    .map(match => ({ id: `Q${match[1]}`, title: match[2].replace(/\*\*/gu, '').trim() }));
  assert.equal(legacyQuestIds.length, 68, `the original Stage1–8 scope contains 68 mapped quests; actual=${legacyQuestIds.length}`);
  const terminalIds = terminalQuestsForRange(1, 8);
  const terminalResults = [];
  for (const questId of terminalIds) {
    const startedAt = Date.now();
    try {
      const result = await runRegisteredQuest(questId, { resourceSession });
      assert.ok(result && Array.isArray(result.output), `${questId} returned a structured terminal result`);
      terminalResults.push({ questId, status: 'PASS', elapsedMs: Date.now() - startedAt,
        outputLineCount: result.output.length, outputCaptured: false });
    } catch (error) {
      terminalResults.push({ questId, status: error?.stageBlocked ? 'BLOCKED' : 'FAIL', elapsedMs: Date.now() - startedAt,
        error: String(error.message || error).slice(0, 1000) });
    }
  }
  const repeatedQ16 = await runRegisteredQuest('Q1.6', { resourceSession });
  assert.ok(Array.isArray(repeatedQ16.output), 'Q1.6 passed a second isolated execution');
  const failedTerminalIds = terminalResults.filter(item => item.status !== 'PASS').map(item => item.questId);
  baseTerminalCoverage = { questMapPath: path.relative(projectRoot, questMapPath), mappedQuestCount: legacyQuestIds.length,
    terminalQuestCount: terminalResults.length, terminalQuestIds: terminalIds, outcomes: terminalResults,
    q16Repeated: true, uncoveredNonTerminalQuests: legacyQuestIds.filter(item => !terminalIds.includes(item.id)) };
  if (failedTerminalIds.length) {
    recordQuest('Q27.1', 'FAIL', { commands: results, baseTerminalCoverage,
      reason: 'One or more base registered terminal quests failed under the current resource manager.' });
    throw new Error(`base terminal regression failures: ${JSON.stringify(terminalResults.filter(item => item.status !== 'PASS'))}`);
  }
  const browser = sourceAcceptanceEvidence();
  const legacyBrowserCoverage = stage27LegacyBrowserCoverage();
  const manuallyUncovered = baseTerminalCoverage.uncoveredNonTerminalQuests;
  const status = manuallyUncovered.length ? 'BLOCKED' : 'PASS';
  const result = { commands: results, baseTerminalCoverage, inheritedSourceHashes: browser,
    browserCoverage: legacyBrowserCoverage, browserCoveragePending: manuallyUncovered.length > 0,
    unresolvedManualQuestIds: manuallyUncovered.map(item => item.id),
    compatibility: '58 server tests, production build, registered terminal quests and fresh legacy browser pages were checked. Nonterminal QuestMap entries are not counted as passed unless individually evidenced.' };
  recordQuest('Q27.1', status, result);
  const output = [`58/58 server tests and production build passed; ${terminalResults.length} registered base terminal quests passed, including a second Q1.6 run.`,
    `Fresh legacy browser evidence covers public news home/detail, guest profile, health-records page and assistant reply.`,
    `${manuallyUncovered.length} of the original 68 QuestMap entries remain nonterminal/manual and lack item-level evidence.`];
  if (status === 'BLOCKED') throw blocked(`Q27.1 remains BLOCKED: ${manuallyUncovered.length} base manual QuestMap entries lack item-level evidence.`);
  return { output };
}

async function runQ272({ resourceSession }) {
  try {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_PORT || !process.env.MYSQL_USER) {
    throw blocked('Q27.2 needs the isolated ResourceRunner MySQL instance; no connection variables are available.');
  }
  const result = await runStage27BackendRegression({ resourceSession, evidenceDestination: q272EvidencePath });
  const evidenceBytes = fs.statSync(q272EvidencePath).size;
  assert.ok(evidenceBytes < 8 * 1024 * 1024, 'backend evidence remains below 8 MiB');
  const rows = readJsonlUnderLimit(q272EvidencePath);
  const drivers = ['sqlite', 'mysql'];
  const starts = drivers.map(driver => ({ driver,
    index: rows.findLastIndex(row => row.driver === driver && row.quest === 'Q26.1' && row.result === 'PASS') }))
    .filter(item => item.index >= 0).sort((left, right) => left.index - right.index);
  const latestRowsByDriver = Object.fromEntries(drivers.map(driver => {
    const start = starts.find(item => item.driver === driver);
    const nextStart = start ? starts.find(item => item.index > start.index) : null;
    return [driver, start ? rows.slice(start.index, nextStart?.index ?? rows.length)
      .filter(row => row.driver === driver && row.result === 'PASS') : []];
  }));
  const expectedBackendQuests = Array.from({ length: 13 }, (_, index) => `Q26.${index + 1}`);
  const passedByDriver = Object.fromEntries(drivers.map(driver => [driver,
    [...new Set(latestRowsByDriver[driver].map(row => row.quest).filter(quest => expectedBackendQuests.includes(quest)))]
      .sort((left, right) => Number(left.slice(4)) - Number(right.slice(4)))]));
  for (const driver of drivers) assert.deepEqual(passedByDriver[driver], expectedBackendQuests,
    `${driver} latest attempt has exactly one PASS for each backend scenario: ${JSON.stringify(passedByDriver[driver])}`);
  const lifecycleByDriver = Object.fromEntries(drivers.map(driver => [driver,
    latestRowsByDriver[driver].filter(row => row.quest === 'Q27.lifecycle')]));
  assert.equal(lifecycleByDriver.sqlite.length, 1, 'SQLite completed the same-database Stage27 plan/order/check-in/feedback/replan lifecycle');
  assert.equal(lifecycleByDriver.mysql.length, 1, 'MySQL completed the same-database Stage27 plan/order/check-in/feedback/replan lifecycle');
  const summary = { evidencePath: q272EvidencePath, evidenceBytes, driverQuestCounts: {
    sqlite: passedByDriver.sqlite.length, mysql: passedByDriver.mysql.length },
    matchingQuestIds: passedByDriver.sqlite.filter(id => passedByDriver.mysql.includes(id)).length,
    latestAttemptRows: Object.fromEntries(drivers.map(driver => [driver, latestRowsByDriver[driver].length])),
    lifecycle: Object.fromEntries(Object.entries(lifecycleByDriver).map(([driver, values]) => [driver, values[0].businessEvidence])) };
  recordQuest('Q27.2', 'PASS', { ...summary,
    reusedEntrypoint: 'Stage26 backend scenarios plus a new same-database lifecycle per driver: clinician approval, order status progression, notifications, booking, check-in, feedback, and pending replan candidate.' });
  return { output: result };
  } catch (error) {
    recordQuest('Q27.2', error?.stageBlocked ? 'BLOCKED' : 'FAIL', { backendEvidencePath: q272EvidencePath,
      error: String(error.message || error).slice(0, 2400), runId: invocationRunId });
    throw error;
  }
}

function reusableQ274Evidence(codeFingerprint) {
  const latest = [...stage27EvidenceRows()].reverse().find(row => row.quest === 'Q27.4' && row.status === 'PASS');
  if (!latest || latest.codeFingerprint !== codeFingerprint || typeof latest.evidencePath !== 'string'
    || !fs.existsSync(latest.evidencePath)) return null;
  const browserEvidence = readJsonUnderLimit(latest.evidencePath);
  if (browserEvidence.taskId !== process.env.CODEX_TASK_ID || browserEvidence.runId !== latest.runId
    || browserEvidence.status !== 'PASS' || browserEvidence.codeFingerprint !== codeFingerprint
    || browserEvidence.nonMedicalReviewDenied !== true || browserEvidence.disabledEmployeeDenied !== true) return null;
  const roles = new Set((browserEvidence.browserFlow?.roleOperations || []).map(item => item.role));
  if (!['clinician', 'coach', 'therapist', 'dietitian', 'administrator'].every(role => roles.has(role))) return null;
  const requiredScreenshots = ['persona1Profile', 'persona1Plan', 'persona1Booking', 'persona1Checkin',
    'persona2Profile', 'persona2Plan', 'persona2Booking', 'persona2Checkin', 'persona3Profile',
    'persona3Plan', 'persona3Booking', 'persona3Checkin', 'clinicianApprovals', 'therapistSchedule', 'dietitianOrders'];
  const screenshots = browserEvidence.screenshots || {};
  for (const key of requiredScreenshots) {
    const filePath = screenshots[key];
    if (typeof filePath !== 'string' || !fs.existsSync(filePath) || fs.statSync(filePath).size < 1000) return null;
  }
  return { latest, browserEvidence };
}

async function runQ273AndQ274({ resourceSession }) {
  const codeFingerprint = stage27BrowserCodeFingerprint();
  if (stage27R3Invocation && invocationQuestId === 'Q27.4') {
    const reusable = reusableQ274Evidence(codeFingerprint);
    if (reusable) {
      const prior = reusable.latest;
      recordQuest('Q27.4', 'PASS', { evidencePath: prior.evidencePath, screenshotDirectory: prior.screenshotDirectory,
        screenshots: prior.screenshots, roleOperations: prior.roleOperations, nonMedicalReviewDenied: true,
        disabledEmployeeDenied: true, actualBrowserSession: true, codeFingerprint,
        reusedFromRunId: prior.runId, reusedVerifiedBrowserEvidence: true,
        reason: 'Q27.3 already ran the same browser input fingerprint and all five authenticated role actions were source-verified; the saved browser JSON and PNGs were reopened and checked.' });
      return { output: ['Q27.4 PASS: five role workflows reused from the verified Q27.3 browser run with the same code fingerprint.'] };
    }
  }
  let browser;
  try { browser = await runStage27BrowserAcceptance({ resourceSession, evidenceDestination: evidencePath,
    runId: invocationRunId, codeFingerprint }); }
  catch (error) {
    recordQuest('Q27.3', 'FAIL', { failure: String(error.message || error).slice(0, 3000),
      browserRunFailedBeforeStructuredPersonaAndRoleResults: true,
      reason: 'The browser acceptance stopped before it could produce the structured Stage27 guest and role result; retain the run-specific browser evidence and cleanup receipt.' });
    recordQuest('Q27.4', 'BLOCKED', { reason: 'The shared browser flow failed before role-operation results were returned; no role PASS is inferred.' });
    throw error;
  }
  const personas = browser.browserFlow?.personaJourneys || [];
  const requiredPersonaTypes = ['chronic_elder', 'mobility_limited', 'youth'];
  const personaCoverage = requiredPersonaTypes.map(personaType => {
    const journey = personas.find(item => item.personaType === personaType);
    const checkin = journey?.checkinFeedback;
    const identityComplete = Boolean(journey?.registration?.id && journey?.registration?.username && journey?.profile?.guestId === journey.registration.id);
    const profileComplete = identityComplete && journey.profile.roomNo && journey.profile.checkIn === '2026-10-09'
      && journey.profile.checkOut === '2026-10-16'
      && (personaType === 'chronic_elder' ? journey.profile.birthDate === '1949-05-01' && journey.profile.mobility === '需要协助'
        : personaType === 'mobility_limited' ? String(journey.profile.mobility || '').includes('轮椅')
          : journey.profile.birthDate === '2004-08-21');
    const assessmentComplete = journey?.assessment?.completedCount === 8;
    const planComplete = Boolean(journey?.plan?.draftId && ['active', 'auto_activated'].includes(journey.plan.reviewStatus || journey.plan.status)
      && journey?.refreshReadback?.sameDraftId === journey.plan.draftId
      && journey?.refreshReadback?.planStatus === (journey.plan.reviewStatus || journey.plan.status));
    const bookingComplete = Boolean(journey?.reservation?.id && journey.reservation.status === 'confirmed'
      && journey?.refreshReadback?.sameReservationId === journey.reservation.id);
    const checkinFeedbackComplete = Boolean(checkin?.webpageActionVerified && checkin?.checkinId && checkin?.feedbackId
      && checkin?.pageRefreshed && journey?.refreshReadback?.sameCheckinId === checkin.checkinId
      && journey?.refreshReadback?.sameFeedbackId === checkin.feedbackId);
    return { personaType, guestId: journey?.registration?.id || null, registration: identityComplete,
      profile: profileComplete, assessment: assessmentComplete, humanReviewOrAutoActivation: planComplete,
      reservation: bookingComplete, webpageCheckinAndFeedback: checkinFeedbackComplete,
      reservationId: journey?.reservation?.id || null, draftId: journey?.plan?.draftId || null,
      checkinId: checkin?.checkinId || null, feedbackId: checkin?.feedbackId || null,
      complete: identityComplete && profileComplete && assessmentComplete && planComplete && bookingComplete && checkinFeedbackComplete };
  });
  const personaCoverageComplete = personaCoverage.length === 3 && personaCoverage.every(item => item.complete)
    && browser.browserFlow?.checkinFeedback?.allThreeCheckedIn === true
    && browser.browserFlow?.checkinFeedback?.allThreeFeedbackSaved === true;
  const mealSwap = personas.find(item => item.mealSwap)?.mealSwap || null;
  const mealSwapComplete = Boolean(mealSwap?.menuId && mealSwap?.itemId && mealSwap?.beforeDishId && mealSwap?.afterDishId
    && mealSwap.beforeDishId !== mealSwap.afterDishId && mealSwap.versionAfter > mealSwap.versionBefore && mealSwap.refreshReadback === true);
  const clockAdvance = browser.browserFlow?.checkinFeedback?.clockAdjustment || null;
  const clockAdvanceComplete = clockAdvance?.method === 'managed-api-restart-same-port' && clockAdvance.slotRowsMutated === false
    && clockAdvance.timeZone === 'Asia/Shanghai' && clockAdvance.checkinApiInstant === '2026-10-10T06:05:00.000Z'
    && clockAdvance.before?.length === 3 && clockAdvance.after?.length === 3;
  const q273Complete = personaCoverageComplete && mealSwapComplete && clockAdvanceComplete;
  recordQuest('Q27.3', q273Complete ? 'PASS' : 'FAIL', {
    runId: invocationRunId, codeFingerprint, evidencePath: browser.evidencePath, screenshotDirectory: browser.screenshotDirectory,
    screenshots: browser.screenshots, personaCoverage, requiredPersonaTypes,
    verifiedPersonaCount: personaCoverage.filter(item => item.complete).length, requiredPersonaCount: 3,
    fullJourneyIdRefreshVerified: personaCoverageComplete, mealSwap,
    guestMealSwapThroughWebpage: mealSwapComplete,
    browserDatabaseCheckinReadbacks: browser.browserFlow?.checkinFeedback?.databaseReadbacks || [],
    controlledClockAdvancement: clockAdvance,
    missingCoverage: personaCoverage.filter(item => !item.complete).map(item => item.personaType),
    reason: q273Complete ? 'Three registered synthetic profiles completed browser registration, profile/admission, all eight health-intake fields, a reviewed or auto-activated plan, booking, check-in, feedback, and same-ID refresh/database readback; one guest also replaced a menu item through the guest webpage.'
      : 'At least one guest journey, the webpage meal swap, or the no-slot-mutation controlled clock advancement lacks browser/database evidence.'
  });
  const roleOperations = browser.roleOperations;
  const roleIds = new Set((roleOperations || []).map(item => item.role));
  const requiredRoles = ['clinician', 'coach', 'therapist', 'dietitian', 'administrator'];
  const operationByRole = Object.fromEntries((roleOperations || []).map(item => [item.role, item]));
  const hasRefreshedStatus = operation => Boolean(operation?.refreshReadback && operation.beforeStatus && operation.afterStatus
    && operation.loginStatus === 'authenticated' && operation.actionType && operation.action);
  const clinician = operationByRole.clinician;
  const coach = operationByRole.coach;
  const therapist = operationByRole.therapist;
  const dietitian = operationByRole.dietitian;
  const administrator = operationByRole.administrator;
  const roleEvidenceComplete = hasRefreshedStatus(clinician) && clinician.draftId && clinician.guestId
    && clinician.beforeStatus === 'pending_review' && clinician.afterStatus === 'active'
    && clinician.refreshReadback.draftId === clinician.draftId && clinician.refreshReadback.status === 'active'
    && hasRefreshedStatus(coach) && coach.reservationId && coach.guestId && coach.afterStatus === 'confirmed'
    && coach.refreshReadback.items?.some(item => item.reservationId === coach.reservationId && item.guestId === coach.guestId && item.status === 'confirmed')
    && hasRefreshedStatus(therapist) && therapist.reservationId && therapist.guestId && therapist.afterStatus === 'confirmed'
    && therapist.refreshReadback.rows?.some(item => item.reservationId === therapist.reservationId && item.guestId === therapist.guestId && item.status === 'confirmed')
    && hasRefreshedStatus(dietitian) && dietitian.orderId && dietitian.guestId && dietitian.beforeStatus === 'reserved'
    && dietitian.afterStatus === 'delivered' && dietitian.transitions?.includes('preparing') && dietitian.transitions?.includes('delivered')
    && dietitian.refreshReadback.preparing?.status === 'preparing' && dietitian.refreshReadback.delivered?.status === 'delivered'
    && dietitian.refreshReadback.preparing?.id === dietitian.orderId && dietitian.refreshReadback.delivered?.id === dietitian.orderId
    && hasRefreshedStatus(administrator) && administrator.employeeId && administrator.beforeStatus === 'active'
    && administrator.afterStatus === 'disabled' && administrator.refreshReadback.staffId === administrator.employeeId
    && administrator.refreshReadback.status === 'disabled';
  const roleCoverageComplete = requiredRoles.every(role => roleIds.has(role)) && roleEvidenceComplete
    && browser.nonMedicalReviewDenied === true && browser.disabledEmployeeDenied === true;
  recordQuest('Q27.4', roleCoverageComplete ? 'PASS' : 'FAIL', { runId: invocationRunId, codeFingerprint,
    evidencePath: browser.evidencePath, screenshotDirectory: browser.screenshotDirectory,
    screenshots: browser.screenshots, roleOperations, nonMedicalReviewDenied: browser.nonMedicalReviewDenied,
    disabledEmployeeDenied: browser.disabledEmployeeDenied, actualBrowserSession: true,
    reason: roleCoverageComplete ? 'Each role performed a real browser workflow with an ID, before/after status, and refreshed source readback; medical review remained role-protected.'
      : 'One or more roles lack authenticated action details, a persisted business ID, a status transition/readback, or the expected role boundary.' });
  return { output: [`Q27.3 ${q273Complete ? 'PASS' : 'FAIL'}: ${personaCoverage.filter(item => item.complete).length}/3 complete persona journeys; guest meal-swap=${mealSwapComplete}.`,
    `Q27.4 ${roleCoverageComplete ? 'PASS' : 'FAIL'}: ${roleCoverageComplete ? 'five roles' : 'role action evidence incomplete'}; fresh browser evidence saved at ${browser.evidencePath}.`] };
}

function sqlTime(driver, value) { return driver === 'mysql' ? value.replace('T', ' ').replace(/Z$/, '') : value; }

async function seedLiveGuest(context, bookingDate = '2026-10-11', businessClockNow = new Date().toISOString()) {
  const username = 'q27_live_synthetic_guest';
  const guestId = 'guest_q27_live_synthetic';
  const password = 'guest2026';
  const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
  assert.ok(source?.password_hash, 'isolated demo seed has a password hash to clone for a synthetic account');
  const stamp = sqlTime(context.driver, businessClockNow);
  const checkIn = new Date(`${bookingDate}T00:00:00+08:00`);
  checkIn.setUTCDate(checkIn.getUTCDate() - 1);
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + 7);
  const checkInDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(checkIn);
  const checkOutDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(checkOut);
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,?,?,'guest',?,'','active',?)`, [guestId, username, source.password_hash, '阶段27合成验收客人', stamp], 'run');
  await databaseQuery(context, `INSERT INTO guest_profiles
    (user_id,gender,birth_date,room_no,check_in,check_out,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at)
    VALUES(?,'女','1980-01-01','Q27-01',?,?,'[]','[]','可独立行走',?,0,?)`,
  [guestId, checkInDate, checkOutDate,
    JSON.stringify({ allergies: { status: 'none', items: [] }, mobility: { status: 'independent' } }), stamp], 'run');
  return { guestId, username, password };
}

async function seedLiveEnvironment(context, date, businessClockNow = new Date().toISOString()) {
  const observedAt = businessClockNow;
  const demo = makeDemoEnvironment(date, observedAt, DEMO_ENVIRONMENT_LOCATION);
  for (const [domain, stationId, data] of [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]]) {
    const key = `env:${crypto.createHash('sha256').update(JSON.stringify([DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain])).digest('hex').slice(0, 48)}`;
    const encoded = JSON.stringify(data);
    const hash = crypto.createHash('sha256').update(encoded).digest('hex');
    const upsert = context.driver === 'mysql'
      ? ` ON DUPLICATE KEY UPDATE payload_hash=VALUES(payload_hash),payload_json=VALUES(payload_json),updated_at=VALUES(updated_at)`
      : ` ON CONFLICT(snapshot_key) DO UPDATE SET payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`;
    await databaseQuery(context, `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,
       payload_hash,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)${upsert}`,
    [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, data.sourceName || 'Stage27 isolated demo snapshot',
      data.sourceUrl || '', sqlTime(context.driver, observedAt), sqlTime(context.driver, new Date(Date.parse(observedAt) + 6 * 86_400_000).toISOString()),
      hash, encoded, sqlTime(context.driver, observedAt), sqlTime(context.driver, observedAt)], 'run');
  }
}

async function seedLiveSlot(context, date, businessClockNow = new Date().toISOString()) {
  const projectId = 'project-sea-bath';
  const localStart = '15:00'; const localEnd = '16:00';
  const slotId = `slot_${crypto.createHash('sha256').update(`${projectId}\0${date}\0${localStart}\0${localEnd}`).digest('hex').slice(0, 32)}`;
  const start = new Date(`${date}T${localStart}:00+08:00`).toISOString();
  const end = new Date(`${date}T${localEnd}:00+08:00`).toISOString();
  const stamp = sqlTime(context.driver, businessClockNow);
  const upsert = context.driver === 'mysql'
    ? ` ON DUPLICATE KEY UPDATE capacity=VALUES(capacity),is_closed=0,updated_at=VALUES(updated_at)`
    : ` ON CONFLICT(id) DO UPDATE SET capacity=excluded.capacity,is_closed=0,updated_at=excluded.updated_at`;
  await databaseQuery(context, `INSERT INTO activity_slots
    (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,2,0,?,?)${upsert}`,
  [slotId, projectId, date, sqlTime(context.driver, start), sqlTime(context.driver, end), localStart, localEnd, stamp, stamp], 'run');
  return { slotId, projectId, date, localStart, localEnd };
}

const STAGE27_LIVE_LIMITS = Object.freeze({
  totalModelCalls: 24, totalTokens: 131_072, totalCostUsd: 0.50, totalRuntimeMs: 300_000,
  runModelCalls: 16, runTokens: 65_536, runCostUsd: 0.25, runRuntimeMs: 180_000,
  modelTimeoutMs: 60_000, toolTimeoutMs: 15_000, toolCalls: 24
});

function stage27ModelEnv(liveConfig, { maxModelCalls, maxTokens, maxCostUsd, maxRuntimeMs }) {
  return {
    LLM_BASE_URL: liveConfig.LLM_BASE_URL, LLM_API_KEY: liveConfig.LLM_API_KEY, LLM_MODEL: liveConfig.LLM_MODEL,
    LLM_TIMEOUT_MS: String(STAGE27_LIVE_LIMITS.modelTimeoutMs),
    ASSISTANT_TOOL_TIMEOUT_MS: String(STAGE27_LIVE_LIMITS.toolTimeoutMs),
    ASSISTANT_MAX_RUNTIME_MS: String(maxRuntimeMs),
    ASSISTANT_MAX_MODEL_CALLS: String(maxModelCalls),
    ASSISTANT_MAX_ACTION_MODEL_CALLS: String(maxModelCalls),
    ASSISTANT_MAX_TOOL_ROUNDS: '4', ASSISTANT_MAX_TOOL_CALLS: String(STAGE27_LIVE_LIMITS.toolCalls),
    ASSISTANT_MAX_TOKENS: String(maxTokens), ASSISTANT_MAX_ESTIMATED_COST_USD: String(maxCostUsd)
  };
}

export function providerAttempts(trace) {
  const collaboration = trace.collaboration || {};
  const topLevelModels = (trace.steps || []).filter(step => step.type === 'model');
  const childModels = (collaboration.agents || []).flatMap(agent =>
    (agent.modelSteps || []).map(step => ({ ...step, auditAgentId: agent.agentId || null })));
  const parentModels = (collaboration.parent?.modelSteps || []).map(step => ({
    ...step, auditAgentId: collaboration.parent.agentId || 'household.concierge'
  }));
  const detailed = Array.isArray(trace.modelUsage) ? trace.modelUsage
    : collaboration.agents?.length ? [...(parentModels.length ? parentModels : topLevelModels), ...childModels]
      : topLevelModels;
  const attempts = detailed.map((step, index) => {
    const attempted = typeof step.requestAttempted === 'boolean' ? step.requestAttempted
      : typeof step.diagnostic?.providerRequestAttempted === 'boolean' ? step.diagnostic.providerRequestAttempted : null;
    const usageReported = typeof step.usageReported === 'boolean' ? step.usageReported
      : typeof step.diagnostic?.usageReported === 'boolean' ? step.diagnostic.usageReported : null;
    const actualUsage = attempted === true && usageReported === true;
    const requestRunId = step.runId || trace.runId || null;
    const requestAgentId = step.auditAgentId || step.agentId || null;
    const requestStepIndex = Number.isInteger(step.stepIndex) ? step.stepIndex : null;
    const rawProviderResponseId = step.providerResponseId || step.diagnostic?.providerResponseId || null;
    const providerResponseId = typeof rawProviderResponseId === 'string'
      && /^[A-Za-z0-9_.:-]{1,128}$/u.test(rawProviderResponseId) ? rawProviderResponseId : null;
    return {
      sourceIndex: index, runId: requestRunId, agentId: requestAgentId,
      stepIndex: requestStepIndex,
      requestIdentity: attempted === true
        ? `${requestRunId || 'unknown-run'}:${requestAgentId || 'unknown-agent'}:${requestStepIndex ?? index}` : null,
      providerResponseId,
      startedAt: step.providerRequestStartedAt || step.diagnostic?.providerRequestStartedAt || step.startedAt || null,
      completedAt: step.providerResponseReceivedAt || step.diagnostic?.providerResponseReceivedAt || step.completedAt || null,
      businessClockStartedAt: step.startedAt || null,
      businessClockCompletedAt: step.completedAt || null,
      providerRequestAttempted: attempted, status: step.status || 'unknown', usageReported,
      inputTokens: actualUsage && step.inputTokens !== null && step.inputTokens !== undefined
        && Number.isFinite(Number(step.inputTokens)) ? Number(step.inputTokens) : null,
      outputTokens: actualUsage && step.outputTokens !== null && step.outputTokens !== undefined
        && Number.isFinite(Number(step.outputTokens)) ? Number(step.outputTokens) : null,
      estimatedCostUsd: actualUsage && (step.estimatedCostUsd ?? step.diagnostic?.estimatedCostUsd) !== null
        && (step.estimatedCostUsd ?? step.diagnostic?.estimatedCostUsd) !== undefined
        && Number.isFinite(Number(step.estimatedCostUsd ?? step.diagnostic?.estimatedCostUsd))
        ? Number(step.estimatedCostUsd ?? step.diagnostic?.estimatedCostUsd) : null,
      durationMs: step.durationMs !== null && step.durationMs !== undefined && Number.isFinite(Number(step.durationMs))
        ? Number(step.durationMs) : null,
      usageUnavailableReason: step.usageUnavailableReason || step.diagnostic?.usageUnavailableReason || null,
      errorCode: step.errorCode || null
    };
  });
  const providerRequests = attempts.filter(item => item.providerRequestAttempted === true);
  const unknownAttemptSteps = attempts.filter(item => item.providerRequestAttempted === null).length;
  const unknownUsageRequests = providerRequests.filter(item => item.usageReported !== true
    || item.inputTokens === null || item.outputTokens === null || item.estimatedCostUsd === null).length;
  const declaredCount = Number.isSafeInteger(trace.modelCallCount) ? trace.modelCallCount : null;
  const topLevelAttemptCount = topLevelModels.filter(step => step.diagnostic?.providerRequestAttempted === true).length;
  const parentAttemptCount = parentModels.filter(step => step.diagnostic?.providerRequestAttempted === true).length;
  const childAttemptCount = childModels.filter(step => step.diagnostic?.providerRequestAttempted === true).length;
  const collaborationAttemptCount = parentAttemptCount + childAttemptCount;
  const exactCount = declaredCount !== null && unknownAttemptSteps === 0 && providerRequests.length === declaredCount;
  const completeUsage = providerRequests.length > 0 && unknownUsageRequests === 0;
  const sum = key => completeUsage ? providerRequests.reduce((total, item) => total + item[key], 0) : null;
  return {
    providerRequests, providerRequestCount: providerRequests.length, declaredModelCallCount: declaredCount,
    unknownAttemptSteps, unknownUsageRequests, exactCount,
    collaborationAttemptCount, topLevelAttemptCount,
    collaborationCountMatchesDeclared: collaboration.agents?.length
      ? declaredCount !== null && collaborationAttemptCount === declaredCount : null,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    totalTokens: completeUsage ? sum('inputTokens') + sum('outputTokens') : null,
    estimatedCostUsd: sum('estimatedCostUsd'), usageComplete: completeUsage,
    traceDurationMs: trace.durationMs !== null && trace.durationMs !== undefined && Number.isFinite(Number(trace.durationMs))
      ? Number(trace.durationMs) : null,
    model: trace.model || null, provider: trace.provider || null
  };
}

async function boundedJsonRequest(baseUrl, route, { method = 'GET', token, body, headers = {}, timeoutMs = 10_000 } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method, signal: AbortSignal.timeout(timeoutMs),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

async function readLiveTrace(baseUrl, runId, token, timeoutMs = 10_000) {
  const result = await boundedJsonRequest(baseUrl,
    `/assistant/runs/${encodeURIComponent(runId)}?role=guest`, { token, timeoutMs });
  return assertOk(result, 200, 'live assistant run trace');
}

function assertTraceBudget(summary, limits, label) {
  assert.ok(summary.exactCount, `${label} provider-attempt count reconciles with the run trace: ${JSON.stringify({
    observed: summary.providerRequestCount, declared: summary.declaredModelCallCount,
    unknownAttemptSteps: summary.unknownAttemptSteps })}`);
  assert.ok(summary.usageComplete, `${label} provider usage is fully reported; missing=${summary.unknownUsageRequests}`);
  assert.ok(summary.providerRequestCount <= limits.maxModelCalls,
    `${label} provider requests ${summary.providerRequestCount} ≤ ${limits.maxModelCalls}`);
  assert.ok(summary.totalTokens <= limits.maxTokens, `${label} tokens ${summary.totalTokens} ≤ ${limits.maxTokens}`);
  assert.ok(summary.estimatedCostUsd <= limits.maxCostUsd,
    `${label} estimated cost ${summary.estimatedCostUsd} ≤ ${limits.maxCostUsd}`);
  assert.ok(summary.traceDurationMs !== null && summary.traceDurationMs <= limits.maxRuntimeMs,
    `${label} run duration ${summary.traceDurationMs}ms ≤ ${limits.maxRuntimeMs}ms`);
}

function safeAttemptError(error) {
  return { errorType: String(error?.name || 'Error').slice(0, 80),
    errorCode: String(error?.code || 'UNCLASSIFIED').slice(0, 100),
    phase: String(error?.stage27Phase || 'unknown').slice(0, 80) };
}

function q276DataChecks(snapshot, location, targetDate, nowMs = Date.now(), tideProvider = 'open-meteo') {
  const weather = snapshot.weather || {};
  const marine = snapshot.marine || {};
  const tide = snapshot.tide || {};
  const onDate = record => Array.isArray(record.hourly)
    ? record.hourly.filter(item => String(item.time || item.localTime || '').startsWith(`${targetDate}T`)) : [];
  const weatherHours = onDate(weather);
  const marineHours = onDate(marine);
  const tideHours = onDate(tide);
  const observedLocalTime = String(weather.observedLocalTime || '');
  const hasExplicitOffset = /(?:[zZ]|[+-]\d{2}(?::?\d{2})?)$/u.test(observedLocalTime);
  const localAsUtcMs = Date.parse(hasExplicitOffset ? observedLocalTime : `${observedLocalTime}Z`);
  const hasReportedUtcOffset = weather.utcOffsetSeconds !== null && weather.utcOffsetSeconds !== undefined
    && weather.utcOffsetSeconds !== '';
  const reportedUtcOffsetSeconds = hasReportedUtcOffset ? Number(weather.utcOffsetSeconds) : Number.NaN;
  const expectedObservedAtMs = hasExplicitOffset ? localAsUtcMs
    : Number.isInteger(reportedUtcOffsetSeconds) && Math.abs(reportedUtcOffsetSeconds) <= 14 * 60 * 60
      ? localAsUtcMs - reportedUtcOffsetSeconds * 1000 : Number.NaN;
  const observedAtMs = Date.parse(weather.observedAt || '');
  const completeCoordinates = record => {
    const latitude = record?.providerCoordinates?.latitude;
    const longitude = record?.providerCoordinates?.longitude;
    const numeric = value => (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)));
    return numeric(latitude) && numeric(longitude);
  };
  const fresh = record => ['available'].includes(record?.status) && Number.isFinite(Date.parse(record?.expiresAt || ''))
    && Date.parse(record.expiresAt) > nowMs;
  const checks = {
    snapshotAvailable: snapshot.status === 'available',
    snapshotIdPresent: typeof snapshot.snapshotId === 'string' && snapshot.snapshotId.length > 0,
    locationIsConfiguredRepresentative: location.coordinatesStatus === 'region-representative'
      && location.id === snapshot.location?.id && Number.isFinite(location.latitude) && Number.isFinite(location.longitude),
    weatherFresh: fresh(weather),
    weatherSourceAndGrid: Boolean(weather.sourceName && weather.sourceUrl && completeCoordinates(weather)),
    weatherObservedAtHasVerifiedUtcOffset: Number.isFinite(expectedObservedAtMs),
    weatherObservedAtMatchesProviderLocalTime: Number.isFinite(expectedObservedAtMs)
      && Number.isFinite(observedAtMs) && observedAtMs === expectedObservedAtMs,
    weatherHourlyValues: weatherHours.length >= 24 && weatherHours.every(item => Number.isFinite(item.temperatureC)
      && Number.isFinite(item.windSpeedKmh) && Number.isFinite(item.uvIndex)),
    marineFresh: fresh(marine),
    marineSourceAndGrid: Boolean(marine.sourceName && marine.sourceUrl && completeCoordinates(marine)),
    waveHourlyValues: marineHours.length >= 24 && marineHours.every(item => Number.isFinite(item.waveHeightM))
  };
  if (tideProvider === 'open-meteo') Object.assign(checks, {
    modeledSeaLevelHourlyValues: marineHours.length >= 24 && marineHours.every(item => Number.isFinite(item.modelSeaLevelHeightMsl)),
    modeledTideFresh: tide.mode === 'modeled-sea-level-including-tides' && fresh(tide),
    modeledTideHourlyValues: tideHours.length >= 24 && tideHours.every(item => Number.isFinite(item.heightM)),
    modeledTideSharesMarineResponse: Boolean(tide.sourceResponseHash && tide.sourceResponseHash === marine.providerResponseHash),
    modeledTideSharesMarineGrid: completeCoordinates(tide)
      && Number(tide.providerCoordinates.latitude) === Number(marine.providerCoordinates?.latitude)
      && Number(tide.providerCoordinates.longitude) === Number(marine.providerCoordinates?.longitude),
    modeledTideDatumAndUnit: tide.verticalDatum === 'global mean sea level' && tide.unit === 'm'
  });
  else Object.assign(checks, {
    stationTideFresh: fresh(tide),
    stationIdMatchesConfiguration: Boolean(location.tideStationId && tide.stationId === location.tideStationId),
    stationTideHourlyValues: tideHours.length > 0 && tideHours.every(item => Number.isFinite(item.heightM))
  });
  return { status: Object.values(checks).every(Boolean) ? 'PASS' : 'BLOCKED', checks,
    hourlyCounts: { weather: weatherHours.length, marine: marineHours.length, modeledTide: tideHours.length },
    reasons: Object.entries(checks).filter(([, passed]) => !passed).map(([key]) => key) };
}

async function runQ275({ resourceSession, live, liveConfig }) {
  if (process.env.CODEX_TASK_ID === '01a12035-a6e7-7423-822d-3948cc060ef1') {
    const reason = 'The prior Stage27 live attempt reported nine graph provider requests, but its full action-model request count, cumulative tokens, estimated cost, and total elapsed time cannot be reconciled from retained receipts. Do not issue another provider request under a cumulative live budget when prior usage is unknown.';
    appendBoundedJsonl(q275EvidencePath, { event: 'attempt-blocked-before-provider', finalStatus: 'BLOCKED',
      providerCallsThisAttempt: 0, providerCallsStartedThisAttempt: false,
      priorAttempt: { knownGraphProviderRequests: 9, totalProviderRequests: null, totalTokens: null,
        estimatedCostUsd: null, totalElapsedMs: null, usageReconciled: false,
        evidence: ['output/resource-audit/stage27-execution-evidence-20261009.jsonl',
          'output/resource-audit/stage27-source-sol-first-independent-scope-review-20261009.json'] },
      reason, credentialValuesRecorded: false });
    recordQuest('Q27.5', 'BLOCKED', { attemptReceiptPath: q275EvidencePath,
      providerCallsThisAttempt: 0, priorKnownGraphProviderRequests: 9, priorTotalProviderRequests: null,
      priorTotalTokens: null, priorEstimatedCostUsd: null, priorElapsedMs: null,
      reason, credentialValuesRecorded: false });
    throw blocked(reason);
  }
  if (!live) throw blocked('Q27.5 requires the authorized --live path; offline fixtures cannot pass the real-model gate.');
  if (!liveConfig || !liveConfig.LLM_BASE_URL || !liveConfig.LLM_API_KEY || !liveConfig.LLM_MODEL) {
    throw blocked('The approved in-memory model loader did not return a complete configuration; no provider request was made.');
  }
  const budgetAccount = initializeQ275BudgetAccount();
  if (budgetAccount.remaining.requests <= 0 || budgetAccount.remaining.tokens <= 0
    || budgetAccount.remaining.estimatedCostUsd <= 0 || budgetAccount.remaining.activeIntervalMs <= 0) {
    throw blocked('The reconciled original Q27.5 account has no remaining allowance; no provider request was made.');
  }
  const r4Start = beginStage27R4Quest({ model: liveConfig.LLM_MODEL,
    executor: budgetAccount.executor, budgetWindowId: stage27R4BudgetWindowId, limits: STAGE27_LIVE_LIMITS,
    remainingBudget: budgetAccount.remaining, credentialValuesRecorded: false });
  if (!r4Start.started) {
    const reason = 'Q27.5 already has a persisted R4 attempt marker for this task; this run is blocked to prevent a second provider window.';
    appendBoundedJsonl(q275EvidencePath, { event: 'duplicate-attempt-blocked', finalStatus: 'BLOCKED',
      previousMarkerPath: path.relative(projectRoot, r4Start.markerPath), providerCallsThisAttempt: 0,
      providerCallsMayHaveStarted: false, reason, credentialValuesRecorded: false });
    recordQuest('Q27.5', 'BLOCKED', { evidencePath: q275EvidencePath,
      previousMarkerPath: path.relative(projectRoot, r4Start.markerPath), providerCallsThisAttempt: 0, reason });
    throw blocked(reason);
  }
  const reservedBudget = reserveModelBudgetAttempt({ filePath: stage27R4BudgetAccountPath,
    taskId: process.env.CODEX_TASK_ID, budgetWindowId: stage27R4BudgetWindowId, runId: invocationRunId,
    sourceRequestLimitApproval: budgetAccount.sourceRequestLimitApproval });
  appendBoundedJsonl(q275EvidencePath, { event: 'persistent-budget-attempt-reserved',
    executor: budgetAccount.executor, budgetWindowId: stage27R4BudgetWindowId,
    startMarkerPath: path.relative(projectRoot, stage27R4StartMarkerPath),
    remainingBeforeAttempt: reservedBudget.remaining, providerCallsMayHaveStarted: false });
  const graphCaps = { maxModelCalls: Math.min(STAGE27_LIVE_LIMITS.runModelCalls, reservedBudget.remaining.requests),
    maxTokens: Math.min(STAGE27_LIVE_LIMITS.runTokens, reservedBudget.remaining.tokens),
    maxCostUsd: Math.min(STAGE27_LIVE_LIMITS.runCostUsd, reservedBudget.remaining.estimatedCostUsd),
    maxRuntimeMs: Math.min(STAGE27_LIVE_LIMITS.runRuntimeMs, reservedBudget.remaining.activeIntervalMs) };
  const modelEnv = stage27ModelEnv(liveConfig, graphCaps);
  const date = '2026-10-11';
  const attemptStartedAt = Date.now();
  const attemptStartedMono = performance.now();
  const businessClockNow = new Date().toISOString();
  let modelWindowStartedAt = null;
  let modelWindowStartedMono = null;
  let graphSummary;
  let actionSummary;
  let browserTraceSummary;
  const attemptAudit = { taskId: process.env.CODEX_TASK_ID || null,
    attempt: stage27R4Invocation ? invocationRunId : 'stage27-repair-q275-one-shot',
    runId: stage27R4Invocation ? invocationRunId : null,
    budgetWindowId: stage27R4BudgetWindowId,
    startedAt: new Date(attemptStartedAt).toISOString(), businessClockNow,
    providerCallsMayHaveStarted: false, remainingBudgetBeforeAttempt: reservedBudget.remaining,
    traceCollection: 'modelUsage reconciled with modelCallCount, top-level steps, and collaboration parent/child model steps',
    limits: { ...STAGE27_LIVE_LIMITS, cumulativeRequestLimit: budgetAccount.modelLimits.requests },
    sourceRequestLimitAdjustment: budgetAccount.requestLimitAdjustment, runs: [], finalStatus: 'started' };
  let finalReceiptWritten = false;
  let databaseContext = null;
  let pendingError = null;
  let budgetWindowFinalized = false;
  const knownTraceByRunId = new Map();
  const runReferences = [];
  const startModelWindow = () => {
    assert.equal(modelWindowStartedAt, null, 'the R4 provider window starts exactly once');
    modelWindowStartedAt = Date.now();
    modelWindowStartedMono = performance.now();
    attemptAudit.modelWindowStartedAt = new Date(modelWindowStartedAt).toISOString();
    attemptAudit.providerCallsMayHaveStarted = true;
    appendQ275BudgetEvent({ event: 'repair-window-started', at: new Date(modelWindowStartedAt).toISOString(),
      activeStartedAt: attemptAudit.modelWindowStartedAt, monotonicStartMs: modelWindowStartedMono,
      providerCallsMayHaveStarted: true });
    appendBoundedJsonl(q275EvidencePath, { event: 'model-window-started', budgetWindowId: stage27R4BudgetWindowId,
      activeStartedAt: attemptAudit.modelWindowStartedAt, limits: STAGE27_LIVE_LIMITS,
      providerCallsMayHaveStarted: true, credentialValuesRecorded: false });
  };
  const finishBudgetWindow = () => {
    if (budgetWindowFinalized || modelWindowStartedMono === null) return null;
    budgetWindowFinalized = true;
    const activeIntervalMs = Math.ceil(performance.now() - modelWindowStartedMono);
    const completedAt = new Date().toISOString();
    appendQ275BudgetEvent({ event: 'repair-window-finished', at: completedAt,
      activeStartedAt: attemptAudit.modelWindowStartedAt, completedAt, activeIntervalMs,
      actualWallSpanMs: Date.now() - modelWindowStartedAt, providerCallsMayHaveStarted: true,
      usageReconciled: attemptAudit.traceCollectionIncomplete !== true && attemptAudit.runs.every(item =>
        item.providerAttempts.exactCount && (item.providerAttempts.providerRequestCount === 0 || item.providerAttempts.usageComplete)) });
    return activeIntervalMs;
  };
  const rememberTrace = trace => {
    if (!trace?.runId) return;
    knownTraceByRunId.set(trace.runId, trace);
    if (!attemptAudit.runs.some(item => item.runId === trace.runId)) {
      const usage = providerAttempts(trace);
      const identifiedUsage = { ...usage, providerRequests: usage.providerRequests.map(item => ({
        ...item, taskId: process.env.CODEX_TASK_ID || null, budgetWindowId: stage27R4BudgetWindowId
      })) };
      attemptAudit.runs.push({ taskId: process.env.CODEX_TASK_ID || null,
        budgetWindowId: stage27R4BudgetWindowId, runId: trace.runId,
        kind: trace.collaboration?.agents?.length ? 'collaboration-graph' : 'assistant-action',
        providerAttempts: identifiedUsage });
      if (identifiedUsage.exactCount && identifiedUsage.usageComplete) {
        appendQ275BudgetEvent({ event: 'repair-provider-usage-recorded', at: new Date().toISOString(),
          source: 'completed authenticated API trace', runId: trace.runId,
          usage: { requests: identifiedUsage.providerRequestCount, tokens: identifiedUsage.totalTokens,
            estimatedCostUsd: identifiedUsage.estimatedCostUsd },
          providerResponseIds: identifiedUsage.providerRequests.map(item => item.providerResponseId).filter(Boolean) });
      }
    }
  };
  try {
    await withDatabaseApi('sqlite', async context => {
      databaseContext = context;
      appendBoundedJsonl(q275EvidencePath, { event: 'attempt-start', ...attemptAudit });
      try {
        const guest = await seedLiveGuest(context, date, businessClockNow);
        await seedLiveEnvironment(context, date, businessClockNow);
        const actualSlot = await seedLiveSlot(context, date, businessClockNow);
        const status = assertOk(await request(context.baseUrl, '/assistant/status'), 200, 'assistant status before live acceptance');
        assert.equal(status.live, true, 'the test API uses the approved configured model in live mode');
        assert.equal(status.maxModelCalls, graphCaps.maxModelCalls);
        assert.equal(status.maxToolCalls, STAGE27_LIVE_LIMITS.toolCalls);
        assert.equal(status.maxRunTokens, graphCaps.maxTokens);
        assert.equal(status.maxEstimatedCostUsd, graphCaps.maxCostUsd);
        const guestLogin = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST',
          body: { username: guest.username, password: guest.password, role: 'guest' } }), 200, 'synthetic live guest login');
        assert.equal(guestLogin.user.id, guest.guestId);

        const crossDomainText = '请根据我的实际资料，分别综合查看温泉理疗、三餐营养、适合的运动活动，以及心理陪伴课程，并整理保守的只读候选建议；不要替我提交预约或更改既有安排。';
        attemptAudit.phase = 'four-domain-graph';
        startModelWindow();
        const graphWallStartedMono = performance.now();
        const graphResponse = assertOk(await boundedJsonRequest(context.baseUrl, '/assistant/chat', { method: 'POST', token: guestLogin.token,
          body: { role: 'guest', text: crossDomainText, clientRequestId: invocationRunId },
          timeoutMs: graphCaps.maxRuntimeMs }), 200, 'cross-domain live graph response');
        assert.ok(graphResponse.runId, 'cross-domain response exposes its actual run ID');
        runReferences.push({ runId: graphResponse.runId, kind: 'collaboration-graph', token: guestLogin.token });
        const graphTrace = await readLiveTrace(context.baseUrl, graphResponse.runId, guestLogin.token);
        rememberTrace(graphTrace);
        const graphUsage = providerAttempts(graphTrace);
        assertTraceBudget(graphUsage, { maxModelCalls: graphCaps.maxModelCalls,
          maxTokens: graphCaps.maxTokens, maxCostUsd: graphCaps.maxCostUsd,
          maxRuntimeMs: graphCaps.maxRuntimeMs }, 'cross-domain graph');
        const agents = graphTrace.collaboration?.agents || [];
        const requiredAgentIds = ['domain.physio', 'domain.nutrition', 'domain.exercise', 'domain.psychology'];
        assert.deepEqual(agents.map(agent => agent.agentId).sort(), [...requiredAgentIds].sort(),
          'one coordinator run has four distinct professional child runs');
        assert.equal(graphTrace.collaboration.parent.agentId, 'household.concierge');
        assert.equal(graphTrace.live, true);
        assert.equal(graphTrace.executionMode, 'live');
        assert.ok(agents.every(agent => agent.live && agent.status === 'completed'), 'all four provider-backed child runs completed');
        assert.equal(graphUsage.providerRequestCount, 9, 'all ordinary parent and child model requests reconcile (four two-call agents plus one coordinator)');
        assert.ok(graphUsage.collaborationCountMatchesDeclared, 'collaboration parent/child counts match the complete declared request count');
        assert.ok(graphUsage.providerRequests.every(item => item.status === 'completed' && item.usageReported === true),
          'each graph provider request completed with reported usage');
        const fiveRunIds = [graphTrace.runId, ...agents.map(agent => agent.runId)];
        assert.ok(fiveRunIds.every(Boolean) && new Set(fiveRunIds).size === 5,
          `coordinator and four agents have five distinct actual run IDs: ${JSON.stringify(fiveRunIds)}`);
        const reads = agents.flatMap(agent => agent.tools || []).filter(tool => tool.status === 'completed'
          && /^(get_|list_)/u.test(tool.toolName || ''));
        assert.ok(reads.length >= 2, 'at least two actual read-only business tools completed in child runs');
        assert.equal(graphTrace.collaboration.graphBudget.modelCalls, graphUsage.providerRequestCount);
        const graphWallMs = Math.ceil(performance.now() - graphWallStartedMono);
        assert.ok(graphWallMs <= graphCaps.maxRuntimeMs, 'graph wall time stayed within its bounded run cap');
        graphSummary = { runId: graphTrace.runId, parentAgentId: graphTrace.collaboration.parent.agentId,
          childRuns: agents.map(agent => ({ runId: agent.runId, agentId: agent.agentId, status: agent.status,
            modelRequests: (agent.modelSteps || []).filter(item => item.diagnostic?.providerRequestAttempted === true).length,
            tools: (agent.tools || []).filter(tool => tool.status === 'completed').map(tool => ({
              toolName: tool.toolName, status: tool.status, readOnly: /^(get_|list_)/u.test(tool.toolName || ''),
              resultSummary: tool.resultSummary || null })) })),
          sources: (graphTrace.sources || []).map(source => ({ type: source.type || null, id: source.id || null })),
          providerUsage: graphUsage, wallElapsedMs: graphWallMs, graphBudget: graphTrace.collaboration.graphBudget,
          sessionId: graphTrace.sessionId };
        attemptAudit.graphSummary = graphSummary;

        const totalRemainingCalls = reservedBudget.remaining.requests - graphUsage.providerRequestCount;
        const totalRemainingTokens = reservedBudget.remaining.tokens - graphUsage.totalTokens;
        const totalRemainingCost = Number((reservedBudget.remaining.estimatedCostUsd - graphUsage.estimatedCostUsd).toFixed(8));
        const totalRemainingRuntime = reservedBudget.remaining.activeIntervalMs
          - Math.ceil(performance.now() - modelWindowStartedMono);
        assert.ok(totalRemainingCalls > 0 && totalRemainingTokens > 0 && totalRemainingCost > 0 && totalRemainingRuntime > 30_000,
          `remaining total allowance safely covers the exact-slot model turn and deterministic confirmation: ${JSON.stringify({
            totalRemainingCalls, totalRemainingTokens, totalRemainingCost, totalRemainingRuntime })}`);
        const actionCaps = { maxModelCalls: Math.min(STAGE27_LIVE_LIMITS.runModelCalls, totalRemainingCalls),
          maxTokens: Math.min(STAGE27_LIVE_LIMITS.runTokens, totalRemainingTokens),
          maxCostUsd: Math.min(STAGE27_LIVE_LIMITS.runCostUsd, totalRemainingCost),
          maxRuntimeMs: Math.min(STAGE27_LIVE_LIMITS.runRuntimeMs, totalRemainingRuntime - 20_000) };
        assert.ok(actionCaps.maxModelCalls > 0 && actionCaps.maxTokens >= 256 && actionCaps.maxRuntimeMs > 0,
          'action turn starts only with positive remaining per-run and cumulative caps');
        context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: businessClockNow,
          ...stage27ModelEnv(liveConfig, actionCaps) });
        const actionStatus = assertOk(await request(context.baseUrl, '/assistant/status'), 200, 'assistant status before bounded action turn');
        assert.equal(actionStatus.maxModelCalls, actionCaps.maxModelCalls);
        assert.equal(actionStatus.maxRunTokens, actionCaps.maxTokens);
        assert.equal(actionStatus.maxEstimatedCostUsd, actionCaps.maxCostUsd);
        assert.equal(actionStatus.maxRunMs, actionCaps.maxRuntimeMs);

        const bookingText = `我想预约项目编号 ${actualSlot.projectId} 在 ${actualSlot.date} 的海水浴时段。我还没有选择时段。请先查询项目目录和当天的真实可选时段，然后在 propose_program_booking 中只提供项目编号和日期、明确省略 slotId，生成需要我选择时段的 needs_input 卡。不要替我选择，不要确认或提交预约。`;
        attemptAudit.phase = 'needs-input-action-proposal';
        const actionResponse = assertOk(await boundedJsonRequest(context.baseUrl, '/assistant/chat', { method: 'POST', token: guestLogin.token,
          body: { role: 'guest', sessionId: graphTrace.sessionId, text: bookingText,
            clientRequestId: `${invocationRunId}-needs-input` }, timeoutMs: actionCaps.maxRuntimeMs }),
        200, 'live booking proposal run');
        assert.ok(actionResponse.runId, 'action proposal exposes its actual run ID');
        runReferences.push({ runId: actionResponse.runId, kind: 'assistant-action', token: guestLogin.token });
        const actionTrace = await readLiveTrace(context.baseUrl, actionResponse.runId, guestLogin.token);
        rememberTrace(actionTrace);
        const actionUsage = providerAttempts(actionTrace);
        attemptAudit.actionTraceSummary = { runId: actionTrace.runId, status: actionTrace.status,
          live: actionTrace.live, executionMode: actionTrace.executionMode, stopReason: actionTrace.stopReason,
          providerUsage: actionUsage,
          actionCards: (actionTrace.actionCards || []).map(item => ({ id: item.id, actionType: item.actionType,
            status: item.status, version: item.version || null, slotId: item.impact?.slot?.id || null })),
          modelSteps: (actionTrace.modelUsage || []).map(item => ({ runId: item.runId, agentId: item.agentId,
            stepIndex: item.stepIndex, status: item.status, providerRequestStartedAt: item.providerRequestStartedAt || null,
            providerResponseReceivedAt: item.providerResponseReceivedAt || null,
            providerResponseId: item.providerResponseId || null, errorCode: item.errorCode || null })) };
        const card = (actionTrace.actionCards || []).find(item => item.actionType === 'book_program'
          && item.status === 'needs_input');
        assert.ok(card, 'the live model created a structured needs_input booking card without choosing a slot');
        assert.ok(Array.isArray(card.impact?.availableSlots) && card.impact.availableSlots.some(item => item.id === actualSlot.slotId),
          'the needs_input card offers the actual database slot from the live read-only query');
        const offeredSlot = card.impact.availableSlots.find(item => item.id === actualSlot.slotId);
        assert.equal(offeredSlot.localStart, actualSlot.localStart);
        assert.equal(offeredSlot.localEnd, actualSlot.localEnd);
        assert.ok(actionUsage.exactCount, 'action provider attempts reconcile with the full modelUsage and trace count');
        assert.ok(actionUsage.providerRequestCount >= 1, 'action-turn top-level provider calls are included in the attempt audit');
        assert.ok(actionUsage.providerRequestCount <= actionCaps.maxModelCalls);
        assert.ok(actionUsage.usageComplete, 'every action-turn provider request has reported usage');
        assert.ok(actionUsage.totalTokens <= actionCaps.maxTokens);
        assert.ok(actionUsage.estimatedCostUsd <= actionCaps.maxCostUsd);
        assert.ok(actionUsage.traceDurationMs !== null && actionUsage.traceDurationMs <= actionCaps.maxRuntimeMs);
        assert.ok(actionUsage.providerRequests.every(item => item.status === 'completed' && item.usageReported === true),
          'all action-turn provider requests completed and reported usage');
        const proposalReservations = await databaseQuery(context, `SELECT COUNT(*) AS count FROM reservations
          WHERE guest_id=? AND slot_id=? AND status='confirmed'`, [guest.guestId, actualSlot.slotId], 'get');
        assert.equal(Number(proposalReservations?.count || 0), 0,
          'the needs_input proposal created no reservation before guest selection and confirmation');
        const attemptProviderRequests = graphUsage.providerRequestCount + actionUsage.providerRequestCount;
        const attemptTokens = graphUsage.totalTokens + actionUsage.totalTokens;
        const attemptCostUsd = Number((graphUsage.estimatedCostUsd + actionUsage.estimatedCostUsd).toFixed(8));
        assert.ok(attemptProviderRequests <= reservedBudget.remaining.requests,
          'new requests remain within the reconciled original task allowance');
        assert.ok(attemptTokens <= reservedBudget.remaining.tokens);
        assert.ok(attemptCostUsd <= reservedBudget.remaining.estimatedCostUsd);
        const elapsedBeforeBrowser = Math.ceil(performance.now() - modelWindowStartedMono);
        assert.ok(elapsedBeforeBrowser < reservedBudget.remaining.activeIntervalMs,
          'the model phase remains within the original account’s remaining active interval');
        attemptAudit.phase = 'guest-web-selection-and-confirmation';
        browserTraceSummary = await runStage27LiveTraceBrowser({ resourceSession, apiBaseUrl: context.baseUrl,
          guestId: guest.guestId, guestUsername: guest.username, guestPassword: guest.password,
          runId: graphTrace.runId, sessionId: graphTrace.sessionId, actionRunId: actionTrace.runId,
          needsInputCardId: card.id, slotId: actualSlot.slotId,
          slotLabel: `${offeredSlot.localStart}–${offeredSlot.localEnd}`,
          activeDeadlineMonoMs: modelWindowStartedMono + reservedBudget.remaining.activeIntervalMs - 5_000,
          verifyBeforeConfirmation: async ({ guestId: pendingGuestId, slotId: pendingSlotId, actionCardId, selectionRunId }) => {
            const count = await databaseQuery(context, `SELECT COUNT(*) AS count FROM reservations
              WHERE guest_id=? AND slot_id=?`, [pendingGuestId, pendingSlotId], 'get');
            return { guestId: pendingGuestId, slotId: pendingSlotId, actionCardId, selectionRunId,
              reservationCount: Number(count?.count || 0), checkedAt: new Date().toISOString(),
              databaseDriver: context.driver };
          } });
        attemptAudit.browserConfirmationRaw = { browserFlow: browserTraceSummary.browserFlow,
          preConfirmationDatabaseReadback: browserTraceSummary.preConfirmationDatabaseReadback || null,
          screenshots: browserTraceSummary.screenshots || null };
        assert.equal(browserTraceSummary.browserFlow.selectionSubmitted, true,
          'the guest selected the offered slot through the actual webpage');
        assert.equal(browserTraceSummary.browserFlow.confirmationSubmitted, true,
          'the guest confirmed the pending action through the actual webpage');
        const selectionRunId = browserTraceSummary.browserFlow.selectionRunId;
        assert.ok(selectionRunId, 'the webpage selection returned the deterministic follow-up run ID');
        const selectionTrace = await readLiveTrace(context.baseUrl, selectionRunId, guestLogin.token);
        runReferences.push({ runId: selectionRunId, kind: 'assistant-action', token: guestLogin.token });
        rememberTrace(selectionTrace);
        const selectionUsage = providerAttempts(selectionTrace);
        const selectionCard = (selectionTrace.actionCards || []).find(item => item.id === browserTraceSummary.browserFlow.confirmedActionCardId);
        const selectionActionCardEvidence = selectionCard ? { id: selectionCard.id, actionType: selectionCard.actionType,
          status: selectionCard.status, slotId: selectionCard.impact?.slot?.id || selectionCard.impact?.slotId
            || selectionCard.parameters?.slotId || null } : null;
        const preConfirmationDatabaseReadback = browserTraceSummary.preConfirmationDatabaseReadback || null;
        const reservation = await databaseQuery(context, `SELECT id,status,slot_id FROM reservations
          WHERE guest_id=? AND slot_id=? AND status='confirmed'`, [guest.guestId, actualSlot.slotId], 'get');
        const afterCount = await databaseQuery(context, `SELECT COUNT(*) AS count FROM reservations
          WHERE guest_id=? AND slot_id=? AND status='confirmed'`, [guest.guestId, actualSlot.slotId], 'get');
        attemptAudit.confirmationContractEvidence = { browserFlow: browserTraceSummary.browserFlow,
          preConfirmationDatabaseReadback, selectionActionCard: selectionActionCardEvidence,
          databaseReservation: reservation || null, confirmedReservationCount: Number(afterCount?.count || 0),
          databaseReadAt: new Date().toISOString() };
        assert.equal(selectionUsage.providerRequestCount, 0,
          'exact slot selection used the existing deterministic server revalidation with no model request');
        assert.equal(selectionUsage.declaredModelCallCount, 0);
        assert.ok((selectionTrace.modelUsage || []).every(item => item.diagnostic?.providerRequestAttempted !== true),
          'selection trace records no model provider attempt');
        assert.ok((selectionTrace.steps || []).some(item => item.diagnostic?.kind === 'appointment_slot_selection_revalidation'
          && item.diagnostic?.source === 'verified_read_only_slot_results'
          && item.diagnostic?.modelToolCallRecorded === false && item.diagnostic?.selectedSlotId === actualSlot.slotId),
        'server trace ties the deterministic choice to the verified read-only offered slot');
        const confirmationContract = validateQ275ConfirmationContract({
          browserFlow: browserTraceSummary.browserFlow, preConfirmationDatabaseReadback,
          selectionActionCard: selectionActionCardEvidence, reservation,
          confirmedReservationCount: Number(afterCount?.count || 0),
          expected: { graphRunId: graphTrace.runId, proposalRunId: actionTrace.runId,
            needsInputCardId: card.id, selectionRunId, slotId: actualSlot.slotId }
        });
        attemptAudit.confirmationContract = confirmationContract;
        const totalProviderRequests = attemptProviderRequests;
        const totalTokens = attemptTokens;
        const totalCostUsd = attemptCostUsd;
        const totalElapsedMs = Math.ceil(performance.now() - modelWindowStartedMono);
        assert.ok(totalElapsedMs <= reservedBudget.remaining.activeIntervalMs,
          `graph, proposal, webpage confirmation, and closeout stayed in the existing active allowance: ${totalElapsedMs}ms`);
        actionSummary = { graphRunId: graphTrace.runId, proposalRunId: actionTrace.runId,
          selectionRunId, actionType: card.actionType, needsInputActionId: card.id,
          confirmedActionId: browserTraceSummary.browserFlow.confirmedActionCardId,
          actionStatus: selectionCard.status, businessType: 'reservation', businessId: reservation.id,
          slotId: reservation.slot_id, providerUsage: actionUsage,
          deterministicSlotSelection: { providerRequests: selectionUsage.providerRequestCount,
            trace: selectionTrace.stopReason || null }, guestWebConfirmation: browserTraceSummary.browserFlow.confirmation,
          confirmationContract, actualDatabaseReadback: reservation, totalElapsedMs };
        attemptAudit.finalStatus = 'completed';
        attemptAudit.actionTraceSummary = { ...attemptAudit.actionTraceSummary,
          offeredSlotId: actualSlot.slotId, needsInputStatus: card.status,
          selectionRunId, selectionProviderRequestCount: selectionUsage.providerRequestCount };
        attemptAudit.summary = { graph: graphUsage, action: actionUsage,
          totalProviderRequests, totalTokens, totalCostUsd, totalElapsedMs,
          modelWindowStartedAt: attemptAudit.modelWindowStartedAt,
          modelWindowId: stage27R4BudgetWindowId,
          confirmedActionId: browserTraceSummary.browserFlow.confirmedActionCardId,
          confirmedReservationId: reservation.id,
          cumulativeAccount: { requestTotal: budgetAccount.consumedBefore.requests + totalProviderRequests,
            tokenTotal: budgetAccount.consumedBefore.tokens + totalTokens,
            estimatedCostUsdTotal: Number((budgetAccount.consumedBefore.estimatedCostUsd + totalCostUsd).toFixed(8)),
            activeIntervalMsTotal: budgetAccount.consumedBefore.activeIntervalMs + totalElapsedMs },
          browserScreenshots: browserTraceSummary.screenshots };
      } catch (error) {
        pendingError = error;
        attemptAudit.finalStatus = error?.stageBlocked ? 'BLOCKED' : 'FAIL';
        attemptAudit.failure = { ...safeAttemptError(error), phase: attemptAudit.phase };
        throw error;
      } finally {
        for (const reference of runReferences) {
          if (knownTraceByRunId.has(reference.runId)) continue;
          try { rememberTrace(await readLiveTrace(context.baseUrl, reference.runId, reference.token, 6_000)); }
          catch { attemptAudit.traceCollectionIncomplete = true; }
        }
        attemptAudit.completedAt = new Date().toISOString();
        attemptAudit.elapsedMs = Math.ceil(performance.now() - attemptStartedMono);
        attemptAudit.actualWallSpanMs = Date.now() - attemptStartedAt;
        attemptAudit.providerWindowElapsedMs = finishBudgetWindow();
        attemptAudit.runs = attemptAudit.runs.map(item => ({ ...item,
          providerCallsMayHaveStarted: attemptAudit.providerCallsMayHaveStarted }));
        if (attemptAudit.traceCollectionIncomplete !== true && attemptAudit.runs.every(item =>
          item.providerAttempts.exactCount && (item.providerAttempts.providerRequestCount === 0 || item.providerAttempts.usageComplete))) {
          const accountAfter = initializeQ275BudgetAccount();
          attemptAudit.persistentAccountAfterAttempt = { budgetWindowId: stage27R4BudgetWindowId,
            cumulativeUsage: { requests: budgetAccount.modelLimits.requests - accountAfter.remaining.requests,
              tokens: 131_072 - accountAfter.remaining.tokens,
              estimatedCostUsd: Number((0.5 - accountAfter.remaining.estimatedCostUsd).toFixed(8)),
              activeIntervalMs: 300_000 - accountAfter.remaining.activeIntervalMs },
            remaining: accountAfter.remaining };
        }
        appendBoundedJsonl(q275EvidencePath, { event: 'attempt-final', ...attemptAudit });
        finalReceiptWritten = true;
      }
    }, { resourceSession, env: { BUSINESS_CLOCK_NOW: businessClockNow, ...modelEnv } });
  } catch (error) {
    if (!finalReceiptWritten) {
      attemptAudit.finalStatus = error?.stageBlocked ? 'BLOCKED' : 'FAIL';
      attemptAudit.failure = { ...safeAttemptError(error), phase: attemptAudit.phase };
      attemptAudit.completedAt = new Date().toISOString();
      attemptAudit.elapsedMs = Math.ceil(performance.now() - attemptStartedMono);
      attemptAudit.actualWallSpanMs = Date.now() - attemptStartedAt;
      attemptAudit.providerWindowElapsedMs = finishBudgetWindow();
      const unresolvedRequestPhase = attemptAudit.phase === 'four-domain-graph' ? 'collaboration-graph'
        : attemptAudit.phase === 'needs-input-action-proposal' ? 'assistant-action' : null;
      if (unresolvedRequestPhase && !runReferences.some(item => item.kind === unresolvedRequestPhase)) {
        attemptAudit.traceCollectionIncomplete = true;
      }
      appendBoundedJsonl(q275EvidencePath, { event: 'attempt-final', ...attemptAudit });
    }
    const knownRequestLowerBound = attemptAudit.runs.reduce((sum, item) => sum + item.providerAttempts.providerRequestCount, 0);
    const providerRequestCountExact = attemptAudit.traceCollectionIncomplete !== true;
    recordQuest('Q27.5', error?.stageBlocked ? 'BLOCKED' : 'FAIL', { attemptReceiptPath: q275EvidencePath,
      r4ReceiptPath: stage27R4ReceiptPath ? path.relative(projectRoot, stage27R4ReceiptPath) : null,
      runId: invocationRunId, budgetWindowId: stage27R4BudgetWindowId,
      errorType: String(error?.name || 'Error'), providerCallsMayHaveStarted: attemptAudit.providerCallsMayHaveStarted,
      knownRunCount: attemptAudit.runs.length,
      knownProviderRequestCount: providerRequestCountExact ? knownRequestLowerBound : null,
      knownProviderRequestLowerBound: knownRequestLowerBound,
      providerRequestCountExact,
      traceCollectionIncomplete: attemptAudit.traceCollectionIncomplete === true });
    const receipt = finalizeStage27R4Run(error?.stageBlocked ? 'BLOCKED' : 'FAIL', {
      providerCallsMayHaveStarted: attemptAudit.providerCallsMayHaveStarted,
      providerWindowElapsedMs: attemptAudit.providerWindowElapsedMs ?? null,
      knownRunCount: attemptAudit.runs.length,
      traceCollectionIncomplete: attemptAudit.traceCollectionIncomplete === true
    });
    if (receipt) error.message = `${error.message}; R4 evidence receipt: ${receipt.path}`;
    throw error;
  }

  recordQuest('Q27.5', 'PASS', { attemptReceiptPath: q275EvidencePath, runId: invocationRunId,
    r4ReceiptPath: stage27R4ReceiptPath ? path.relative(projectRoot, stage27R4ReceiptPath) : null,
    budgetWindowId: stage27R4BudgetWindowId, model: liveConfig.LLM_MODEL,
    graph: graphSummary, confirmedWrite: actionSummary, expandedTraceScreenshot: browserTraceSummary,
    safety: { syntheticGuestOnly: true, keySource: 'approved server-side in-memory loader', keyLogged: false,
      noPersonalHealthDataSent: true,
      totalProviderRequests: graphSummary.providerUsage.providerRequestCount + actionSummary.providerUsage.providerRequestCount,
      totalTokens: graphSummary.providerUsage.totalTokens + actionSummary.providerUsage.totalTokens,
      totalEstimatedCostUsd: Number((graphSummary.providerUsage.estimatedCostUsd + actionSummary.providerUsage.estimatedCostUsd).toFixed(8)),
      cumulativeRequestLimit: budgetAccount.modelLimits.requests,
      maxProviderRequestsPerAttempt: STAGE27_LIVE_LIMITS.totalModelCalls, maxTokensTotal: STAGE27_LIVE_LIMITS.totalTokens,
      maxCostUsdTotal: STAGE27_LIVE_LIMITS.totalCostUsd, maxTokensPerRun: STAGE27_LIVE_LIMITS.runTokens,
      maxCostUsdPerRun: STAGE27_LIVE_LIMITS.runCostUsd, maxRunMs: STAGE27_LIVE_LIMITS.runRuntimeMs,
      modelTimeoutMs: STAGE27_LIVE_LIMITS.modelTimeoutMs, toolTimeoutMs: STAGE27_LIVE_LIMITS.toolTimeoutMs,
      cumulativeElapsedMs: actionSummary.totalElapsedMs } });
  const receipt = finalizeStage27R4Run('PASS', { totalProviderRequests: actionSummary.providerUsage.providerRequestCount
    + graphSummary.providerUsage.providerRequestCount, totalTokens: actionSummary.providerUsage.totalTokens
    + graphSummary.providerUsage.totalTokens, estimatedCostUsd: Number((actionSummary.providerUsage.estimatedCostUsd
    + graphSummary.providerUsage.estimatedCostUsd).toFixed(8)), providerWindowElapsedMs: actionSummary.totalElapsedMs });
  return { output: [`Live coordinator ${graphSummary.runId} completed with four distinct professional child runs and ${graphSummary.providerUsage.providerRequestCount} reconciled provider requests.`,
    `After a separate exact-slot confirmation card, one isolated reservation ${actionSummary.businessId} was written and read back.`,
    `The pending card, confirmed card, and expanded live trace were captured in ${browserTraceSummary.screenshotDirectory}.`,
    ...(receipt ? [`R4 evidence receipt: ${receipt.path}`] : [])] };
}

async function runQ276({ resourceSession, live, liveEnvironment }) {
  const location = liveEnvironment?.location;
  const r4Start = beginStage27R4Quest({ region: '大连开发区', environmentRequestCap: 6,
    requiredVariables: requiredEnvironmentKeys,
    configuredVariableNames: liveEnvironment?.approvedConfiguration?.configuredKeys || [],
    approvedEnvironmentFileStatus: liveEnvironment?.approvedConfiguration?.file?.status || 'unknown',
    representativePointApplied: liveEnvironment?.representativePointApplied === true,
    coordinatesStatus: location?.coordinatesStatus || 'missing', credentialValuesRecorded: false });
  if (stage27R4Invocation && !r4Start.started) {
    const reason = 'Q27.6 already has a persisted R4 attempt marker for this task; this run is blocked to prevent a second environment attempt.';
    appendBoundedJsonl(q276EvidencePath, { event: 'duplicate-attempt-blocked', status: 'BLOCKED',
      providerCalls: 0, previousMarkerPath: path.relative(projectRoot, r4Start.markerPath), reason,
      credentialValuesRecorded: false });
    recordQuest('Q27.6', 'BLOCKED', { providerCalls: 0, evidencePath: q276EvidencePath,
      r4ReceiptPath: stage27R4ReceiptPath ? path.relative(projectRoot, stage27R4ReceiptPath) : null,
      previousMarkerPath: path.relative(projectRoot, r4Start.markerPath), reason });
    throw blocked(reason);
  }
  const missing = [...new Set(liveEnvironment?.missing || [])];
  const missingByDomain = liveEnvironment?.missingByDomain || {};
  const locationReady = Boolean(location?.id && location?.name && location?.timeZone
    && Number.isFinite(location.latitude) && location.latitude >= -90 && location.latitude <= 90
    && Number.isFinite(location.longitude) && location.longitude >= -180 && location.longitude <= 180);
  if (!live || !locationReady) {
    const reason = !live ? '真实环境请求的 --live 开关未启用。'
      : '没有可用的公开地区代表点坐标；没有发送天气、潮汐或海况请求。';
    appendBoundedJsonl(q276EvidencePath, { status: 'BLOCKED', providerCalls: 0,
      requiredVariables: requiredEnvironmentKeys, missingVariables: missing,
      regionConfirmed: '大连开发区', representativeLocation: { status: 'unavailable', institutionAddressUsed: false },
      tideMode: liveEnvironment?.tideProvider || 'open-meteo', tideStation: { status: 'optional-not-selected' }, reason,
      approvedConfiguration: liveEnvironment?.approvedConfiguration || null,
      credentialValuesRecorded: false });
    recordQuest('Q27.6', 'BLOCKED', { providerCalls: 0, evidencePath: q276EvidencePath,
      r4ReceiptPath: stage27R4ReceiptPath ? path.relative(projectRoot, stage27R4ReceiptPath) : null,
      missingVariables: missing, locationConfigured: locationReady, reason });
    const receipt = finalizeStage27R4Run('BLOCKED', { providerCalls: 0, missingVariables: missing, reason });
    throw blocked(`${reason}${receipt ? ` 证据：${receipt.path}` : ''}`);
  }

  const budgetBaseline = readJsonUnderLimit(stage27R4BaselinePath);
  const budgetIdentity = resolveStage27R4Executor(process.env.CODEX_TASK_ID, budgetBaseline);
  const environmentBaselineUsed = budgetIdentity.executor === 'worker'
    ? Number(budgetBaseline.environmentBudget.workerActualUsed) : Number(budgetBaseline.environmentBudget.sourceActualUsed);
  const environmentBudgetBefore = initializeEnvironmentBudgetFile({ filePath: stage27R4EnvironmentBudgetAccountPath,
    taskId: process.env.CODEX_TASK_ID, baselineUsed: environmentBaselineUsed, limit: STAGE27_R4_ENV_LIMITS.requests });
  if (environmentBudgetBefore.remaining <= 0) {
    const reason = `Q27.6 ${budgetIdentity.executor} environment provider allowance is exhausted; no request was sent.`;
    appendBoundedJsonl(q276EvidencePath, { event: 'provider-budget-exhausted', status: 'BLOCKED',
      executor: budgetIdentity.executor, actualUsed: environmentBudgetBefore.used,
      requestLimit: STAGE27_R4_ENV_LIMITS.requests, providerCallsThisAttempt: 0, reason });
    recordQuest('Q27.6', 'BLOCKED', { executor: budgetIdentity.executor, providerCalls: 0,
      totalEnvironmentProviderCallsInR4: environmentBudgetBefore.used, reason });
    finalizeStage27R4Run('BLOCKED', { executor: budgetIdentity.executor, providerCalls: 0, reason });
    throw blocked(reason);
  }

  const providerEnv = { NODE_ENV: 'test', ENVIRONMENT_MODE: 'live', ENVIRONMENT_LIVE: '1',
    ENVIRONMENT_TIDE_PROVIDER: liveEnvironment?.tideProvider || 'open-meteo',
    ENVIRONMENT_PROVIDER_BUDGET_LEDGER_PATH: stage27R4EnvironmentBudgetAccountPath,
    ENVIRONMENT_PROVIDER_BUDGET_BASELINE: String(environmentBaselineUsed),
    CODEX_TASK_ID: process.env.CODEX_TASK_ID,
    ENVIRONMENT_LOCATION_ID: location.id, ENVIRONMENT_LOCATION_NAME: location.name,
    ENVIRONMENT_LATITUDE: String(location.latitude), ENVIRONMENT_LONGITUDE: String(location.longitude),
    ENVIRONMENT_TIME_ZONE: location.timeZone, ENVIRONMENT_COORDINATES_STATUS: location.coordinatesStatus,
    ENVIRONMENT_LOCATION_SOURCE: location.locationSource || '',
    ENVIRONMENT_INSTITUTION_LOCATION_CONFIGURED: location.institutionLocationConfigured ? '1' : '0',
    ...(location.tideStationId ? { QWEATHER_TIDE_STATION_ID: location.tideStationId } : {}),
    ...(liveEnvironment.apiHost ? { QWEATHER_API_HOST: liveEnvironment.apiHost } : {}),
    ...(liveEnvironment.apiKey ? { QWEATHER_API_KEY: liveEnvironment.apiKey } : {}),
    ...(liveEnvironment.weatherBaseUrl ? { OPEN_METEO_WEATHER_BASE_URL: liveEnvironment.weatherBaseUrl } : {}),
    ...(liveEnvironment.marineBaseUrl ? { OPEN_METEO_MARINE_BASE_URL: liveEnvironment.marineBaseUrl } : {}) };
  const targetDate = new Date().toISOString().slice(0, 10);
  const businessClockNow = new Date().toISOString();
  let providerEvidence = null;
  let runError = null;
  const tideProvider = liveEnvironment?.tideProvider || 'open-meteo';
  const storedRows = async context => await databaseQuery(context, `SELECT domain,status,source_name AS sourceName,
    source_url AS sourceUrl,snapshot_key AS snapshotKey,observed_at AS observedAt,expires_at AS expiresAt,
    payload_hash AS payloadHash,payload_json AS payloadJson
    FROM environment_snapshots WHERE location_id=? AND target_date=? ORDER BY domain`, [location.id, targetDate], 'all');
  try {
    await withDatabaseApi('sqlite', async context => {
      const guest = await seedLiveGuest(context, targetDate, businessClockNow);
      const signed = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST',
        body: { username: guest.username, password: guest.password, role: 'guest' } }), 200, 'Q27.6 synthetic guest login');
      const snapshot = assertOk(await request(context.baseUrl, `/environment?date=${targetDate}`, { token: signed.token }), 200,
        'Q27.6 existing live environment adapter route');
      assert.equal(snapshot.location.id, location.id);
      const checks = q276DataChecks(snapshot, location, targetDate, Date.now(), tideProvider);
      const domains = ['weather', 'tide', 'marine'].map(domain => {
        const record = snapshot[domain] || {};
        return { domain, status: record.status || 'unknown', mode: record.mode || null, typeLabel: record.typeLabel || null,
          sourceName: record.sourceName || null, sourceUrl: record.sourceUrl || null, observedAt: record.observedAt || null,
          retrievedAt: record.retrievedAt || null, updatedAt: record.updatedAt || null, expiresAt: record.expiresAt || null,
          timezone: record.timezone || null, units: record.units || null, unit: record.unit || null,
          verticalDatum: record.verticalDatum || null, providerCoordinates: record.providerCoordinates || null,
          providerResponseHash: record.providerResponseHash || null, sourceResponseHash: record.sourceResponseHash || null,
          variableStatus: record.variableStatus || null, seaLevelReference: record.seaLevelReference || null,
          stationId: record.stationId || (domain === 'tide' ? location.tideStationId || null : null),
          forecastStart: record.forecastStart || null, forecastEnd: record.forecastEnd || null,
          targetDate: record.targetDate || targetDate, hourlyRecordCount: Array.isArray(record.hourly) ? record.hourly.length : 0,
          errorCode: record.errorCode || null, missingConfigurationFields: record.missingConfig || [] };
      });
      const persistedDomains = await storedRows(context);
      const cachedSnapshot = assertOk(await request(context.baseUrl, `/environment?date=${targetDate}`, { token: signed.token }), 200,
        'Q27.6 cached API snapshot re-read');
      const persistedWeather = persistedDomains.find(record => record.domain === 'weather');
      const persistedWeatherPayload = persistedWeather?.payloadJson ? JSON.parse(persistedWeather.payloadJson) : null;
      const sameInstant = (left, right) => Number.isFinite(Date.parse(left || ''))
        && Number.isFinite(Date.parse(right || '')) && Date.parse(left) === Date.parse(right);
      checks.checks.weatherApiCacheInstantMatches = sameInstant(cachedSnapshot.weather?.observedAt, snapshot.weather?.observedAt);
      checks.checks.weatherDatabaseInstantMatches = sameInstant(persistedWeather?.observedAt, snapshot.weather?.observedAt);
      checks.checks.weatherPayloadInstantMatches = sameInstant(persistedWeatherPayload?.observedAt, snapshot.weather?.observedAt);
      checks.status = Object.values(checks.checks).every(Boolean) ? 'PASS' : 'BLOCKED';
      checks.reasons = Object.entries(checks.checks).filter(([, passed]) => !passed).map(([key]) => key);
      const weatherTimeConsistency = { providerLocalObservationTime: snapshot.weather?.observedLocalTime || null,
        providerTimezone: snapshot.weather?.timezone || null, providerUtcOffsetSeconds: snapshot.weather?.utcOffsetSeconds ?? null,
        apiObservedAt: snapshot.weather?.observedAt || null, cachedApiObservedAt: cachedSnapshot.weather?.observedAt || null,
        databaseObservedAt: persistedWeather?.observedAt || null,
        payloadObservedAt: persistedWeatherPayload?.observedAt || null,
        localTimeToUtcMatches: checks.checks.weatherObservedAtMatchesProviderLocalTime,
        apiAndCacheMatch: checks.checks.weatherApiCacheInstantMatches,
        databaseMatchesApi: checks.checks.weatherDatabaseInstantMatches,
        payloadMatchesApi: checks.checks.weatherPayloadInstantMatches };
      const requestAccountAfter = reconcileEnvironmentBudget({ rows: readHashedBudgetJsonl(stage27R4EnvironmentBudgetAccountPath),
        taskId: process.env.CODEX_TASK_ID, baselineUsed: environmentBaselineUsed, limit: STAGE27_R4_ENV_LIMITS.requests });
      const requestDelta = requestAccountAfter.used - environmentBudgetBefore.used;
      const modeledTide = tideProvider === 'open-meteo';
      const siteSafety = { status: 'pending', seaBathingStatus: 'pending', stationObservationRequiredForSeaBathing: true,
        actualStationTideAvailable: !modeledTide && snapshot.tide?.status === 'available' && Boolean(snapshot.tide?.stationId),
        institutionApprovedThresholdsAvailable: snapshot.safetyThresholds?.institutionApproved === true,
        institutionPreciseLocationKnown: location.institutionLocationConfigured === true,
        realSiteOperationsAuthorized: false,
        reason: '地区代表点与模式海面高度不构成现场站点潮位、机构批准阈值或机构现场运营授权；下海项目保持待确认。' };
      providerEvidence = { recordType: 'stage27-r4-q276-provider-and-browser-evidence', status: 'BLOCKED',
        dataStatus: checks.status, overallStatus: snapshot.status, dataChecks: checks,
        providerCallsThisAttempt: requestDelta, environmentProviderRequestsUsed: requestAccountAfter.used,
        environmentProviderRequestLimit: STAGE27_R4_ENV_LIMITS.requests,
        providerRequestLimit: { maxRequests: STAGE27_R4_ENV_LIMITS.requests, maxDurationMsEach: STAGE27_R4_ENV_LIMITS.requestTimeoutMs },
        historicalProviderRequests: { countIncludedInBaseline: environmentBaselineUsed,
          detail: 'Earlier approved lookup/provider attempts are counted in the immutable baseline; this run does not infer missing per-provider response details.' },
        providerDocumentation: [
          { domain: 'weather', url: 'https://open-meteo.com/en/docs' },
          { domain: 'marine', url: 'https://open-meteo.com/en/docs/marine-weather-api' },
          ...(modeledTide ? [{ domain: 'modeled-sea-level-including-tides', url: 'https://open-meteo.com/en/docs/marine-weather-api' }]
            : [{ domain: 'station-tide', url: 'https://dev.qweather.com/en/docs/api/ocean/tide/' },
              { domain: 'qweather-api-host', url: 'https://dev.qweather.com/en/docs/configuration/api-host/' }])
        ], targetDate, snapshotId: snapshot.snapshotId, locationId: snapshot.location.id,
        representativeLocation: { status: location.coordinatesStatus, name: location.name,
          latitude: location.latitude, longitude: location.longitude, coordinateSystem: 'WGS84',
          source: location.locationSource, institutionAddressUsed: false },
        institutionLocationConfigured: location.institutionLocationConfigured, domains,
        persistedDomains: persistedDomains.map(({ payloadJson, ...record }) => record),
        weatherTimeConsistency, modeledTide, tideStation: modeledTide
          ? { status: 'optional-not-selected', source: 'same Open-Meteo Marine response', stationObservation: false }
          : { status: snapshot.tide?.status === 'available' ? 'provider-response-available' : 'unavailable',
            stationIdConfigured: Boolean(location.tideStationId), authorizationVerified: snapshot.tide?.status === 'available',
            stationId: location.tideStationId || null },
        siteSafety, approvedConfiguration: { file: liveEnvironment.approvedConfiguration?.file || null,
          configuredKeys: liveEnvironment.approvedConfiguration?.configuredKeys || [],
          configuredSourcesByKey: liveEnvironment.approvedConfiguration?.configuredSourcesByKey || {},
          missingVariables: missing, credentialValuesRecorded: false },
        missingSiteAuthorization: !location.institutionLocationConfigured, webAcceptance: null };
      if (checks.status === 'PASS') {
        const webAcceptance = await runStage27EnvironmentBrowser({ resourceSession, apiBaseUrl: context.baseUrl,
          guestUsername: guest.username, guestPassword: guest.password, targetDate, expectedSnapshotId: snapshot.snapshotId,
          expectedLocation: { id: location.id, name: location.name, timeZone: location.timeZone,
            latitude: location.latitude, longitude: location.longitude, coordinatesStatus: location.coordinatesStatus },
          expectedDomains: Object.fromEntries(domains.map(record => [record.domain, record.status])),
          expectedModeledSeaLevel: modeledTide ? { responseHash: snapshot.marine?.providerResponseHash || null,
            dataComplete: snapshot.tide?.status === 'available', tideStatus: snapshot.tide?.status || 'unknown' } : null });
        providerEvidence.webAcceptance = webAcceptance;
        const persistedAfterWeb = await storedRows(context);
        assert.deepEqual(persistedAfterWeb, persistedDomains,
          'Q27.6 webpage reused the same persisted provider snapshot without rewriting it');
        const afterBrowserAccount = reconcileEnvironmentBudget({ rows: readHashedBudgetJsonl(stage27R4EnvironmentBudgetAccountPath),
          taskId: process.env.CODEX_TASK_ID, baselineUsed: environmentBaselineUsed, limit: STAGE27_R4_ENV_LIMITS.requests });
        assert.equal(afterBrowserAccount.used, requestAccountAfter.used,
          'Q27.6 browser reused its persisted snapshot without another provider request');
        providerEvidence.webSnapshotReuse = { sameSnapshotId: true, persistedRowsUnchanged: true,
          providerCallsAddedByBrowser: afterBrowserAccount.used - requestAccountAfter.used };
      }
      appendBoundedJsonl(q276EvidencePath, providerEvidence);
    }, { resourceSession, env: { BUSINESS_CLOCK_NOW: businessClockNow, ...providerEnv } });
  } catch (error) {
    runError = error;
    if (providerEvidence) providerEvidence.runError = safeAttemptError(error);
    else providerEvidence = { recordType: 'stage27-r4-q276-provider-and-browser-evidence', status: 'FAIL',
      providerCallsThisAttempt: null, providerUsageReconciled: false, runError: safeAttemptError(error), credentialValuesRecorded: false };
  }
  let environmentBudgetAfter;
  try {
    environmentBudgetAfter = reconcileEnvironmentBudget({ rows: readHashedBudgetJsonl(stage27R4EnvironmentBudgetAccountPath),
      taskId: process.env.CODEX_TASK_ID, baselineUsed: environmentBaselineUsed, limit: STAGE27_R4_ENV_LIMITS.requests });
  } catch (error) {
    runError ||= error;
  }
  if (environmentBudgetAfter) {
    providerEvidence.providerCallsThisAttempt = environmentBudgetAfter.used - environmentBudgetBefore.used;
    providerEvidence.environmentProviderRequestsUsed = environmentBudgetAfter.used;
    providerEvidence.environmentProviderRemaining = environmentBudgetAfter.remaining;
    providerEvidence.budgetUsageReconciled = true;
  } else {
    providerEvidence.providerCallsThisAttempt ??= null;
    providerEvidence.budgetUsageReconciled = false;
  }
  const finalStatus = runError ? (runError?.stageBlocked ? 'BLOCKED' : 'FAIL')
    : providerEvidence.dataStatus === 'PASS' && providerEvidence.webAcceptance?.status === 'PASS' ? 'PASS' : 'BLOCKED';
  providerEvidence.status = finalStatus;
  providerEvidence.siteSafety = providerEvidence.siteSafety || { status: 'pending', seaBathingStatus: 'pending',
    reason: '机构精确位置、现场站点潮位与安全阈值未核实；下海项目保持待确认。' };
  appendBoundedJsonl(q276EvidencePath, { event: 'q276-final-reconciliation', status: finalStatus,
    providerCallsThisAttempt: providerEvidence.providerCallsThisAttempt, budgetUsageReconciled: providerEvidence.budgetUsageReconciled,
    siteSafety: providerEvidence.siteSafety, error: runError ? safeAttemptError(runError) : null });
  recordQuest('Q27.6', finalStatus, { evidencePath: q276EvidencePath,
    r4ReceiptPath: stage27R4ReceiptPath ? path.relative(projectRoot, stage27R4ReceiptPath) : null,
    credentialValuesRecorded: false, ...providerEvidence });
  const receipt = finalizeStage27R4Run(finalStatus, { ...providerEvidence,
    error: runError ? safeAttemptError(runError) : null });
  if (finalStatus === 'BLOCKED') throw blocked(`Q27.6 真实数据链路或网页验收仍缺少完整有效证据；机构地点、现场站点潮位或安全阈值未核实的下海项目继续待确认。${receipt ? `证据：${receipt.path}` : ''}`);
  if (finalStatus === 'FAIL') throw new Error(`Q27.6 live provider or browser acceptance failed; see ${q276EvidencePath}`);
  return { output: [`Q27.6 PASS: live environment data, the same persisted API/SQLite snapshot, source/grid/time/unit labels, and modeled tide dependency all passed.`,
    `Sea-bathing safety remains pending until an actual station tide and institution-approved thresholds are verified.${receipt ? ` Evidence: ${receipt.path}` : ''}`] };
}

async function runQ277({ resourceSession }) {
  if (!process.env.MYSQL_HOST || !process.env.MYSQL_PORT || !process.env.MYSQL_USER) {
    throw blocked('Q27.7 needs the isolated ResourceRunner MySQL instance; no connection variables are available.');
  }
  const date = '2026-10-11';
  const concurrency = 20;
  const capacity = 2;
  const loadSampleCount = 50;
  const runToken = crypto.createHash('sha256').update(invocationRunId || crypto.randomUUID()).digest('hex').slice(0, 10);
  let result;
  await withDatabaseApi('mysql', async context => {
    await seedLiveEnvironment(context, date);
    const slot = await seedLiveSlot(context, date);
    await databaseQuery(context, `UPDATE activity_slots SET capacity=?,is_closed=0 WHERE id=?`, [capacity, slot.slotId], 'run');
    const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
    assert.ok(source?.password_hash, 'the isolated MySQL seed account has a password hash');
    const stamp = sqlTime(context.driver, '2026-10-09T00:00:00.000Z');
    const mysqlConfig = await databaseQuery(context, `SELECT VERSION() AS version,
      @@innodb_buffer_pool_size AS innodbBufferPoolBytes, @@max_connections AS maxConnections`, [], 'get');
    const guests = [];
    for (let index = 1; index <= concurrency; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const id = `guest_q27_${runToken}_${suffix}`;
      const username = `q27_${runToken}_${suffix}`;
      await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
        VALUES(?,?,?,'guest',?,'','active',?)`, [id, username, source.password_hash, `阶段27并发客人${suffix}`, stamp], 'run');
      await databaseQuery(context, `INSERT INTO guest_profiles
        (user_id,gender,birth_date,room_no,check_in_date,check_out_date,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at)
        VALUES(?,'女','1980-01-01',?,'2026-10-09','2026-10-16','[]','[]','可独立行走',?,0,?)`,
      [id, `Q27-${suffix}`, JSON.stringify({ allergies: { status: 'none', items: [] }, mobility: { status: 'independent' } }), stamp], 'run');
      const signed = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST',
        body: { username, password: 'guest2026', role: 'guest' } }), 200, `MySQL concurrency guest ${suffix} login`);
      assert.equal(signed.user.id, id);
      guests.push({ id, token: signed.token });
    }
    const startedAt = Date.now();
    const attempts = await Promise.all(guests.map((guest, index) => fetch(`${context.baseUrl}/reservations`, {
      method: 'POST', headers: { authorization: `Bearer ${guest.token}`, 'content-type': 'application/json',
        'Idempotency-Key': `q27-race-${runToken}-${String(index + 1).padStart(2, '0')}` },
      body: JSON.stringify({ slotId: slot.slotId })
    }).then(async response => ({ status: response.status, body: await response.json(), guestId: guest.id }))
      .catch(error => ({ status: null, body: null, guestId: guest.id, exception: String(error.message || error).slice(0, 500) }))));
    const concurrencyElapsedMs = Date.now() - startedAt;
    const successes = attempts.filter(item => item.status === 201);
    const rejected = attempts.filter(item => item.status === 409 && item.body?.code === 'SLOT_FULL');
    const unexpected = attempts.filter(item => !(item.status === 201 || (item.status === 409 && item.body?.code === 'SLOT_FULL')));
    const booked = await databaseQuery(context, "SELECT COUNT(*) AS count FROM reservations WHERE slot_id=? AND status='confirmed'", [slot.slotId], 'get');
    const confirmedOrders = await databaseQuery(context, `SELECT id,guest_id AS guestId,slot_id AS slotId,status
      FROM reservations WHERE slot_id=? AND status='confirmed' ORDER BY id`, [slot.slotId], 'all');
    assert.equal(successes.length, capacity, 'only the two available places are booked');
    assert.equal(rejected.length, concurrency - capacity, 'all remaining requests are rejected as full');
    assert.equal(unexpected.length, 0, `no unrelated rejection or server error: ${JSON.stringify(unexpected).slice(0, 1200)}`);
    assert.equal(Number(booked.count), capacity, 'the database has exactly two confirmed reservations');
    assert.equal(confirmedOrders.length, capacity, 'SQL returns exactly two confirmed reservation rows');
    const confirmedIds = new Set(confirmedOrders.map(item => String(item.id)));
    const successIds = successes.map(item => String(item.body?.reservation?.id || item.body?.id || ''));
    assert.deepEqual([...confirmedIds].sort(), [...successIds].sort(), 'HTTP 201 reservation IDs match the exact SQL confirmed rows');
    assert.equal(new Set(confirmedOrders.map(item => item.guestId)).size, capacity, 'two distinct authenticated guests own the confirmed orders');

    const dean = assertOk(await login(context.baseUrl, 'dean'), 200, 'MySQL health-history performance admin login');
    const route = '/admin/operations/guests/guest_001/health-history';
    const staffRow = await databaseQuery(context, "SELECT id FROM users WHERE role='staff' LIMIT 1", [], 'get');
    assert.ok(staffRow?.id, 'the seeded health recorder exists');
    const recordSql = `INSERT INTO health_records(guest_id,record_type,value_text,unit,note,source,recorded_at,recorded_by,created_at)
      VALUES ${Array.from({ length: 100 }, () => "(?,?,?,?,?,'staff',?,?,?)").join(',')}`;
    for (let offset = 0; offset < 1000; offset += 100) {
      const values = [];
      for (let index = offset; index < offset + 100; index += 1) {
        values.push('guest_001', index % 2 ? '血压' : '心率', String(index % 2 ? 118 + (index % 10) : 60 + (index % 20)),
          index % 2 ? 'mmHg' : '次/分', `Q27 performance synthetic row ${String(index + 1).padStart(4, '0')}`,
          stamp, staffRow.id, stamp);
      }
      await databaseQuery(context, recordSql, values, 'run');
    }
    const recordCount = await databaseQuery(context, "SELECT COUNT(*) AS count FROM health_records WHERE guest_id='guest_001'", [], 'get');
    assert.ok(Number(recordCount.count) >= 1000, 'at least 1000 real health rows are present for the measured query');
    const durations = [];
    const warmupDurationsMs = [];
    const firstPageIds = [];
    for (let index = 0; index < 5 + loadSampleCount; index += 1) {
      const before = performance.now();
      const response = await request(context.baseUrl, route, { token: dean.token });
      const elapsedMs = performance.now() - before;
      assert.equal(response.status, 200, `health history sample ${index + 1} returned HTTP 200`);
      assert.equal(response.data.guestId, 'guest_001');
      assert.equal(response.data.items.length, 20, 'the ordinary API returns its bounded 20-row page');
      const pageIds = response.data.items.map(item => Number(item.id));
      assert.ok(pageIds.every(Number.isFinite), 'health history returns stable numeric record IDs');
      assert.deepEqual(pageIds, [...pageIds].sort((left, right) => right - left),
        'health history rows are ordered by recorded_at DESC,id DESC for this equal-time synthetic set');
      if (index === 5) firstPageIds.push(...pageIds);
      if (index >= 5) durations.push(elapsedMs);
      else warmupDurationsMs.push(Number(elapsedMs.toFixed(2)));
    }
    const sorted = [...durations].sort((left, right) => left - right);
    const percentile = value => Number(sorted[Math.max(0, Math.ceil(sorted.length * value) - 1)].toFixed(2));
    const p50Ms = percentile(0.50); const p95Ms = percentile(0.95);
    assert.ok(p95Ms <= 500, `health-history API p95 ${p95Ms}ms is within the 500ms target`);
    result = { driver: 'mysql', runId: invocationRunId, runToken, businessDate: date, slot, capacity,
      requestCount: attempts.length, successCount: successes.length, slotFullCount: rejected.length,
      unexpectedCount: unexpected.length, unexpectedResponses: unexpected, responseRecords: attempts,
      confirmedOrders, databaseConfirmedCount: Number(booked.count), concurrentElapsedMs: concurrencyElapsedMs,
      systemConfiguration: { node: process.version, platform: os.platform(), release: os.release(), arch: os.arch(),
        cpuCount: os.cpus().length },
      databaseConfiguration: { mysqlVersion: mysqlConfig.version, innodbBufferPoolBytes: Number(mysqlConfig.innodbBufferPoolBytes),
        maxConnections: Number(mysqlConfig.maxConnections), isolatedResourceManagedMysql: true },
      sample: { endpoint: route, method: 'GET', measuredCount: durations.length, warmupCount: 5, warmupDurationsMs,
        rowCount: Number(recordCount.count), responseRows: 20, accessPath: 'dean bearer token; real isolated API and MySQL',
        ordering: 'recorded_at DESC,id DESC', concurrentRequests: 1, p50Ms, p95Ms, targetP95Ms: 500,
        responseOrderingVerified: true, firstMeasuredPageIds: firstPageIds,
        rawDurationsMs: durations.map(value => Number(value.toFixed(2))) } };
  }, { resourceSession, env: { BUSINESS_CLOCK_NOW: '2026-10-09T00:00:00.000Z' } });
  recordQuest('Q27.7', 'PASS', { ...result, workload: '20 authenticated guest POST /reservations requests started concurrently for a two-place slot.' });
  return { output: [`20 concurrent MySQL booking requests produced ${result.successCount} confirmed reservations and ${result.slotFullCount} SLOT_FULL responses; no oversell.`,
    `${result.sample.measuredCount} warmed GET ${result.sample.endpoint} samples over ${result.sample.rowCount} health rows: p50 ${result.sample.p50Ms}ms, p95 ${result.sample.p95Ms}ms (target ≤ ${result.sample.targetP95Ms}ms).`] };
}

function directoryBytes(root) {
  if (!fs.existsSync(root)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    if (entry.isDirectory()) total += directoryBytes(name);
    else total += fs.lstatSync(name).size;
  }
  return total;
}

function sqliteCounts(databasePath) {
  const db = new DatabaseSync(databasePath);
  try {
    const names = ['users', 'guest_profiles', 'projects', 'activity_slots', 'reservations', 'meal_orders',
      'health_records', 'medical_advice', 'staff_reviews', 'audit_logs'];
    return Object.fromEntries(names.map(name => [name, Number(db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get().count)]));
  } finally { db.close(); }
}

async function availableLoopbackPort(excludedPorts = []) {
  const excluded = new Set(excludedPorts.map(Number));
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address()?.port;
        server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('could not reserve a loopback port')));
      });
    });
    if (!excluded.has(Number(result))) return result;
  }
  throw new Error('could not allocate a unique loopback port outside the excluded set');
}

async function chooseLoopbackPort(preferred, excludedPorts = []) {
  const excluded = new Set(excludedPorts.map(Number));
  if (excluded.has(Number(preferred))) return { port: await availableLoopbackPort(excludedPorts),
    preferredAvailable: false, preferredPortReason: 'already-assigned-in-this-run' };
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(preferred, '127.0.0.1', resolve);
    });
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return { port: preferred, preferredAvailable: true };
  } catch (error) {
    try { server.close(); } catch { /* the probe never retained the preferred port */ }
    if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    return { port: await availableLoopbackPort(excludedPorts), preferredAvailable: false, preferredPortReason: error.code };
  }
}

async function waitCleanApi(resourceSession, resourceId, baseUrl) {
  const deadline = Date.now() + 15_000;
  let last = 'not ready';
  while (Date.now() < deadline) {
    const state = (await resourceSession.status()).resources?.find(item => item.id === resourceId);
    if (!state || !['starting', 'running'].includes(state.status)) {
      const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error(`Q27.8 API stopped before readiness: ${tail.tail || state?.status || 'missing'}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(900) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 125));
  }
  throw new Error(`Q27.8 API readiness timed out (${last})`);
}

async function waitManagedUrl(resourceSession, resourceId, url, expectedStatus = 200) {
  const deadline = Date.now() + 35_000;
  let last = 'not ready';
  while (Date.now() < deadline) {
    const state = (await resourceSession.status()).resources?.find(item => item.id === resourceId);
    if (!state || !['starting', 'running'].includes(state.status)) {
      const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error(`managed Q27.8 service stopped before readiness: ${tail.tail || state?.status || 'missing'}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1200) });
      if (response.status === expectedStatus) return { status: response.status, url, checkedAt: new Date().toISOString() };
      last = `HTTP ${response.status}`;
    } catch (error) { last = String(error.message || error).slice(0, 250); }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
  throw new Error(`managed Q27.8 service readiness timed out for ${url}: ${last}; ${tail.tail || 'no log output'}`);
}

async function stopCleanApi(resourceSession, resource, reason) {
  const current = (await resourceSession.status()).resources?.find(item => item.id === resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await resourceSession.stop(resource.id, reason);
    assert.ok(stopped.ok, `Q27.8 API stop requested: ${JSON.stringify(stopped)}`);
  }
  const exit = await resourceSession.waitProcess(resource.id, 12_000);
  assert.ok(!exit.timedOut && !exit.unavailable && !['starting', 'running'].includes(exit.status),
    `Q27.8 exact API PID and children exited: ${JSON.stringify(exit)}`);
  const exitPids = Array.isArray(exit.pids) ? exit.pids : [];
  assert.ok(exitPids.length > 0 && exitPids.every(item => item.exitConfirmed === true),
    `Q27.8 guardian confirmed each exact API PID/child exit: ${JSON.stringify(exitPids)}`);
  return { resourceId: resource.id, pid: resource.pid, processStartTime: resource.processStartTime,
    processFingerprint: resource.processFingerprint, command: resource.command, cwd: resource.cwd, port: resource.port,
    tempDir: resource.tempDir, logPath: resource.logPath, exitCode: exit.exitCode, signal: exit.signal || null,
    status: exit.status, trackedPids: exitPids, allTrackedPidsExited: true };
}

async function stopManagedCleanProcess(resourceSession, resource, reason) {
  const current = (await resourceSession.status()).resources?.find(item => item.id === resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await resourceSession.stop(resource.id, reason);
    assert.ok(stopped.ok, `Q27.8 exact process stop requested: ${JSON.stringify(stopped)}`);
  }
  const exit = await resourceSession.waitProcess(resource.id, 20_000);
  assert.ok(!exit.timedOut && !exit.unavailable && !['starting', 'running'].includes(exit.status),
    `Q27.8 exact managed PID and children exited: ${JSON.stringify(exit)}`);
  const exitPids = Array.isArray(exit.pids) ? exit.pids : [];
  assert.ok(exitPids.length > 0 && exitPids.every(item => item.exitConfirmed === true),
    `Q27.8 guardian confirmed each exact PID/child exit: ${JSON.stringify(exitPids)}`);
  return { resourceId: resource.id, pid: resource.pid, processStartTime: resource.processStartTime,
    processFingerprint: resource.processFingerprint, command: resource.command, args: resource.args,
    cwd: resource.cwd, port: resource.port ?? null, tempDir: resource.tempDir, logPath: resource.logPath,
    exitCode: exit.exitCode, signal: exit.signal || null, status: exit.status,
    trackedPids: exitPids, allTrackedPidsExited: true };
}

function assertNoDatabaseHandles(paths) {
  const receipts = [];
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) continue;
    const result = spawnSync('lsof', ['-nP', filePath], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    assert.ok([0, 1].includes(result.status) && !result.error, `SQLite handle inspection completed for ${path.basename(filePath)}`);
    const output = String(result.stdout || '').trim();
    assert.equal(output, '', `no process retains a handle to ${path.basename(filePath)}`);
    receipts.push({ path: filePath, lsofExitCode: result.status, matchingHandles: 'none' });
  }
  return receipts;
}

async function startCleanApi(resourceSession, { label, cwd, databasePath, seed, businessClock }) {
  const port = await availableLoopbackPort();
  const resource = await resourceSession.startProcess({ label, kind: 'api', role: 'api', command: process.execPath,
    args: ['src/index.js'], cwd, port, env: { PATH: process.env.PATH || '', PORT: String(port),
      DB_DRIVER: 'sqlite', DB_PATH: databasePath, DEMO_SEED: seed ? '1' : '0', BUSINESS_CLOCK_NOW: businessClock,
      AUTH_SECRET: 'stage27-clean-install-secret', LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '',
      ENVIRONMENT_MODE: 'demo', ENVIRONMENT_LIVE: '0', TZ: 'UTC' }, leaseMs: limits.leaseMs });
  assert.equal(resource.status, 'running', `${label} API started under ResourceSession`);
  const baseUrl = `http://127.0.0.1:${port}/api`;
  await waitCleanApi(resourceSession, resource.id, baseUrl);
  return { resource, baseUrl };
}

async function runQ278({ resourceSession }) {
  const cleanRoot = await resourceSession.allocateDir('stage27-r5-clean-delivery');
  const checkout = path.join(cleanRoot, 'checkout');
  const npmCache = path.join(cleanRoot, 'npm-cache');
  const runId = invocationRunId || `unmanaged-Q27-8-${Date.now()}-${crypto.randomUUID()}`;
  const q278EvidencePath = path.join(stage27R5Root, `${runId}-q278-clean-delivery.json`);
  const excludedNames = new Set(['.git', 'node_modules', 'output', '.playwright-cli', 'dist', 'coverage', '.npm', 'data']);
  const evidence = { schemaVersion: 1, taskId: process.env.CODEX_TASK_ID || null, runId, status: 'RUNNING',
    startedAt: new Date().toISOString(), sourceCheckout: projectRoot, cleanCheckout: checkout, cleanRoot, npmCache,
    providerRequests: 0, copiedSecrets: false, resources: [], q8: {}, cleanupErrors: [],
    excluded: ['.git', 'node_modules', 'output', '.playwright-cli', 'dist', 'coverage', '.npm', 'data/backup',
      'user-generated media', '.env and .env.* except the public .env.example', '.DS_Store', '*.log'],
    includedBundledAssets: ['tracked server/media/mood source assets needed by the app'] };
  const closeManaged = async (resource, reason) => {
    if (!resource) return null;
    const receipt = await stopManagedCleanProcess(resourceSession, resource, reason);
    evidence.resources.push(receipt);
    return receipt;
  };
  let devStack;
  let preview;
  let restoredApi;
  let restoredApiStop;
  let browser;
  let failure;
  let copyMs;
  let copiedBytes;
  let install;
  let build;
  let tests;
  let nodeVersion;
  let npmVersion;
  let installBytes;
  let finalDirectoryBytes;
  let apiPortSelection;
  let webPortSelection;
  let previewPortSelection;
  let accountLogins = [];
  let slot;
  let booking;
  let backupCounts;
  let restoredCounts;
  let restoredReservationRow;
  let databaseHandleChecks = [];
  const date = '2026-10-11';
  const businessClock = '2026-10-10T00:00:00.000Z';
  const databasePath = path.join(cleanRoot, 'fresh-r5.sqlite');
  const backupPath = path.join(cleanRoot, 'fresh-r5-backup.sqlite');
  const restoredPath = path.join(cleanRoot, 'restored-r5.sqlite');
  let guestAccessToken;

  try {
    const copyStartedAt = Date.now();
    fs.cpSync(projectRoot, checkout, { recursive: true, filter(source) {
      const relative = path.relative(projectRoot, source);
      if (!relative || relative === '.') return true;
      const segments = relative.split(path.sep);
      const base = path.basename(source);
      if (segments.some(segment => excludedNames.has(segment))) return false;
      if (base === '.env.example') return true;
      if (base === '.env' || base.startsWith('.env.')) return false;
      if (base === '.DS_Store' || base.endsWith('.log')) return false;
      return true;
    } });
    const workspaceReadme = path.resolve(projectRoot, '../README.md');
    assert.ok(fs.existsSync(workspaceReadme), 'the workspace README is available as public setup documentation');
    fs.copyFileSync(workspaceReadme, path.join(checkout, 'README.md'));
    copyMs = Date.now() - copyStartedAt;
    assert.ok(fs.existsSync(path.join(checkout, '.env.example')), 'fresh copy contains the public .env.example');
    assert.ok(!fs.existsSync(path.join(checkout, '.env')), 'fresh copy contains no real .env');
    assert.ok(!fs.existsSync(path.join(checkout, 'node_modules')), 'fresh copy starts without node_modules');
    copiedBytes = directoryBytes(checkout);
    assert.ok(copiedBytes < limits.directoryBytes, `fresh source copy used ${copiedBytes} bytes under 512 MiB`);
    evidence.copy = { bytes: copiedBytes, elapsedMs: copyMs, hasPublicEnvExample: true, hasRealEnv: false,
      copiedNodeModules: false, lockfilePath: 'package-lock.json', lockfileBytes: fs.statSync(path.join(checkout, 'package-lock.json')).size };

    const nodeReceipt = await runManaged(resourceSession, { label: 'stage27-q278-clean-node-version', command: process.execPath,
      args: ['--version'], cwd: checkout });
    const npmReceipt = await runManaged(resourceSession, { label: 'stage27-q278-clean-npm-version', command: 'npm', args: ['--version'], cwd: checkout,
      env: { npm_config_cache: npmCache, npm_config_audit: 'false', npm_config_fund: 'false' } });
    nodeVersion = nodeReceipt.outputTail.trim(); npmVersion = npmReceipt.outputTail.trim();
    assert.match(nodeVersion, /^v\d+\./u, 'cold install Node version was recorded');
    assert.match(npmVersion, /^\d+\./u, 'cold install npm version was recorded');
    const installStartedAt = Date.now();
    install = await runManaged(resourceSession, { label: 'stage27-q278-clean-npm-ci-ignore-scripts', command: 'npm',
      args: ['ci', '--ignore-scripts'], cwd: checkout, timeoutMs: 840_000,
      env: { npm_config_cache: npmCache, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' } });
    install.elapsedWallMs = Date.now() - installStartedAt;
    assert.match(install.outputTail, /added \d+ packages|up to date/u, 'the one clean npm ci --ignore-scripts completed');
    installBytes = directoryBytes(cleanRoot);
    assert.ok(installBytes < limits.directoryBytes, `clean install used ${installBytes} bytes under 512 MiB`);
    evidence.install = { command: 'npm ci --ignore-scripts', nodeVersion, npmVersion, receipt: install,
      directoryBytesAfterInstall: installBytes, cachePath: npmCache };
    evidence.q8['8.5'] = { status: 'PARTIAL', evidence: 'fresh isolated source copy and one real npm ci --ignore-scripts completed; dev health and demo-account checks are still required' };

    build = await runManaged(resourceSession, { label: 'stage27-q278-clean-production-build', command: 'npm',
      args: ['run', 'build'], cwd: checkout, timeoutMs: 300_000,
      env: { npm_config_cache: npmCache, HAIYU_RESOURCE_MANAGED: '1' } });
    assert.ok(fs.existsSync(path.join(checkout, 'web', 'dist', 'index.html')), 'clean npm run build created web/dist/index.html');
    tests = await runManaged(resourceSession, { label: 'stage27-q278-clean-automated-tests', command: 'npm',
      args: ['test'], cwd: checkout, timeoutMs: 600_000,
      env: { npm_config_cache: npmCache, npm_config_update_notifier: 'false' } });
    assert.match(tests.outputTail, /# fail 0/u, 'clean npm test reports zero failing tests');
    evidence.build = { command: 'npm run build', receipt: build, outputExists: true };
    evidence.automatedTests = { command: 'npm test', receipt: tests, zeroFailures: true };
    evidence.q8['8.6'] = { status: 'PASS', evidence: 'npm test completed in the clean copy with # fail 0' };

    apiPortSelection = await chooseLoopbackPort(3020);
    webPortSelection = await chooseLoopbackPort(5180, [apiPortSelection.port]);
    previewPortSelection = await chooseLoopbackPort(5181, [apiPortSelection.port, webPortSelection.port]);
    const apiPort = apiPortSelection.port; const webPort = webPortSelection.port; const previewPort = previewPortSelection.port;
    const apiBaseUrl = `http://127.0.0.1:${apiPort}/api`;
    const devWebUrl = `http://127.0.0.1:${webPort}/`;
    const previewUrl = `http://127.0.0.1:${previewPort}/`;
    const managedEnv = { PATH: process.env.PATH || '/usr/bin:/bin', PORT: String(apiPort), WEB_PORT: String(webPort),
      API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`, DB_DRIVER: 'sqlite', DB_PATH: databasePath,
      DEMO_SEED: '1', BUSINESS_CLOCK_NOW: businessClock, AUTH_SECRET: 'stage27-r5-local-demo-secret',
      LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '', ENVIRONMENT_MODE: 'demo', ENVIRONMENT_LIVE: '0',
      HAIYU_RESOURCE_MANAGED: '1', TZ: 'UTC', npm_config_cache: npmCache, npm_config_audit: 'false',
      npm_config_fund: 'false', npm_config_update_notifier: 'false' };
    devStack = await resourceSession.startProcess({ label: 'stage27-q278-clean-npm-dev-stack', kind: 'dev-stack', role: 'dev-stack',
      command: 'npm', args: ['run', 'dev'], cwd: checkout, env: managedEnv, leaseMs: limits.leaseMs });
    assert.equal(devStack.status, 'running', 'clean npm run dev stack is registered with ResourceSession');
    await waitManagedUrl(resourceSession, devStack.id, `${apiBaseUrl}/health`);
    await waitManagedUrl(resourceSession, devStack.id, devWebUrl);
    const healthResponse = await fetch(`${apiBaseUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const healthBody = await healthResponse.json();
    assert.equal(healthResponse.status, 200, 'clean dev API health endpoint returns HTTP 200');
    assert.equal(healthBody.ok, true, 'clean dev API health response reports ok');

    for (const account of [
      { username: 'guest_demo', password: 'guest2026', role: 'guest' },
      { username: 'staff_demo', password: 'staff2026', role: 'staff' },
      { username: 'dean_demo', password: 'dean2026', role: 'dean' }
    ]) {
      const response = assertOk(await request(apiBaseUrl, '/auth/login', { method: 'POST', body: account }), 200,
        `clean dev demo account login ${account.role}`);
      assert.equal(response.user?.role, account.role, `${account.role} demo credentials sign in as the matching role`);
      accountLogins.push({ role: account.role, username: account.username, httpStatus: 200, userId: response.user.id,
        returnedRole: response.user.role, tokenPresent: Boolean(response.token) });
      if (account.role === 'guest') guestAccessToken = response.token;
    }
    assert.equal(accountLogins.length, 3, 'guest, staff, and dean demo accounts all log in');
    evidence.demoAccounts = accountLogins;
    evidence.dev = { command: 'npm run dev', resourceId: devStack.id, apiBaseUrl, webUrl: devWebUrl,
      apiPort: apiPortSelection, webPort: webPortSelection, health: { status: healthResponse.status, body: healthBody },
      demoAccounts: accountLogins };
    evidence.q8['8.5'] = { status: 'PASS', evidence: 'fresh isolated source copy, one real npm ci --ignore-scripts, dev health, and all three demo-account logins passed' };

    slot = await seedLiveSlot({ driver: 'sqlite', databasePath }, date, businessClock);
    await seedLiveEnvironment({ driver: 'sqlite', databasePath }, date, businessClock);
    const slotResponse = assertOk(await request(apiBaseUrl,
      `/projects/${encodeURIComponent(slot.projectId)}/slots?date=${date}`, { token: guestAccessToken }), 200,
    'fresh dev API project slot query');
    const visibleSlot = slotResponse.slots?.find(item => item.id === slot.slotId);
    assert.ok(visibleSlot, 'fresh dev API returns the synthetic reservation slot');
    assert.equal(visibleSlot.status, 'available', `fresh dev slot is bookable: ${visibleSlot.reason}`);
    const bookingResponse = await fetch(`${apiBaseUrl}/reservations`, { method: 'POST',
      headers: { authorization: `Bearer ${guestAccessToken}`, 'content-type': 'application/json',
        'Idempotency-Key': `q27-r5-clean-install-${crypto.randomUUID()}` },
      body: JSON.stringify({ slotId: slot.slotId }), signal: AbortSignal.timeout(8000) });
    const bookingBody = await bookingResponse.json();
    assert.equal(bookingResponse.status, 201, `clean dev reservation was confirmed: ${JSON.stringify(bookingBody)}`);
    booking = bookingBody.reservation;
    assert.ok(booking?.id, 'clean dev reservation has a real ID');
    assert.equal(booking.status, 'confirmed', 'clean dev reservation status is confirmed');
    evidence.dev.reservationCreated = { id: booking.id, status: booking.status,
      guestId: booking.guestId || null, slotId: slot.slotId, businessDate: date };
    guestAccessToken = null;
    evidence.q8['8.5'].dev = { apiHealth: true, threeDemoAccounts: true, localUrls: [apiBaseUrl, devWebUrl] };

    preview = await resourceSession.startProcess({ label: 'stage27-q278-clean-npm-preview', kind: 'vite', role: 'web-preview',
      command: 'npm', args: ['run', 'preview', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(previewPort), '--strictPort'],
      cwd: checkout, port: previewPort, env: managedEnv, leaseMs: limits.leaseMs });
    assert.equal(preview.status, 'running', 'clean production preview is registered with ResourceSession');
    await waitManagedUrl(resourceSession, preview.id, previewUrl);
    await waitManagedUrl(resourceSession, preview.id, `${previewUrl}api/health`);
    const previewHealth = await fetch(`${previewUrl}api/health`, { signal: AbortSignal.timeout(3000) });
    const previewHealthBody = await previewHealth.json();
    assert.equal(previewHealth.status, 200, 'preview proxy returns API health on the same local origin');
    assert.equal(previewHealthBody.ok, true, 'preview proxy health response reports ok');
    const browserOutputDirectory = path.join(stage27R5Root, `${runId}-browser-scenes`);
    fs.mkdirSync(stage27R5Root, { recursive: true, mode: 0o700 });
    browser = await runStage27R5CleanBrowserAcceptance({ resourceSession, checkoutRoot: checkout, webUrl: previewUrl,
      outputDirectory: browserOutputDirectory, taskId: process.env.CODEX_TASK_ID, runId });
    assert.equal(browser.status, 'PASS', 'four-scene clean production preview browser walkthrough passed');
    evidence.preview = { command: 'npm run preview -w web', resourceId: preview.id, url: previewUrl,
      port: previewPortSelection, apiHealth: { status: previewHealth.status, body: previewHealthBody },
      browserEvidencePath: browser.evidencePath, browserEvidenceSha256: browser.evidenceSha256,
      screenshotCount: browser.screenshotCount, screenshots: browser.screenshots,
      externalRequestCount: browser.externalRequestCount, httpErrorCount: browser.httpErrorCount };
    evidence.q8['8.7'] = { status: 'PASS', evidence: 'clean build exists and local production preview serves the home page and API without HTTP errors' };
    evidence.q8['8.8'] = { status: 'PASS', evidence: 'public, guest, staff, dean, and logout browser scenes completed in the managed browser' };

    await closeManaged(preview, 'q27.8-preview-browser-complete');
    preview = null;
    evidence.dev.stop = await closeManaged(devStack, 'q27.8-clean-dev-booking-and-browser-complete');
    devStack = null;
    databaseHandleChecks = assertNoDatabaseHandles([databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]);
    const liveDb = new DatabaseSync(databasePath);
    let backupReservationRow;
    let backupIntegrity;
    let restoredIntegrity;
    try {
      const integrity = liveDb.prepare('PRAGMA integrity_check').get();
      assert.equal(integrity.integrity_check, 'ok', 'closed source SQLite database passes integrity_check');
      const sourceReservationRow = liveDb.prepare('SELECT id,guest_id,slot_id,status FROM reservations WHERE id=?').get(booking.id);
      assert.ok(sourceReservationRow, 'source SQLite file still contains the same booking after all writers stop');
      assert.equal(sourceReservationRow.status, 'confirmed');
      evidence.databaseBeforeBackup = { integrityCheck: integrity.integrity_check, reservation: sourceReservationRow,
        tableCounts: sqliteCounts(databasePath) };
      liveDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const escapedBackupPath = backupPath.replaceAll("'", "''");
      liveDb.exec(`VACUUM INTO '${escapedBackupPath}'`);
    } finally { liveDb.close(); }
    databaseHandleChecks.push(...assertNoDatabaseHandles([databasePath, `${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`]));
    assert.ok(fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0, 'SQLite VACUUM INTO produced a real backup');
    fs.copyFileSync(backupPath, restoredPath);
    backupCounts = sqliteCounts(backupPath); restoredCounts = sqliteCounts(restoredPath);
    assert.deepEqual(restoredCounts, backupCounts, 'restored SQLite key table counts equal backup counts');
    const backupDb = new DatabaseSync(backupPath); const restoredDb = new DatabaseSync(restoredPath);
    try {
      backupReservationRow = backupDb.prepare('SELECT id,guest_id,slot_id,status FROM reservations WHERE id=?').get(booking.id);
      backupIntegrity = backupDb.prepare('PRAGMA integrity_check').get().integrity_check;
      restoredReservationRow = restoredDb.prepare('SELECT id,guest_id,slot_id,status FROM reservations WHERE id=?').get(booking.id);
      restoredIntegrity = restoredDb.prepare('PRAGMA integrity_check').get().integrity_check;
    } finally { backupDb.close(); restoredDb.close(); }
    assert.equal(backupIntegrity, 'ok', 'backup database passes SQLite integrity_check');
    assert.equal(restoredIntegrity, 'ok', 'restored database passes SQLite integrity_check');
    assert.deepEqual(restoredReservationRow, backupReservationRow, 'restored database retains the same reservation ID and keys');
    assert.equal(restoredReservationRow.id, booking.id);
    assert.equal(restoredReservationRow.guest_id, accountLogins.find(item => item.role === 'guest').userId);
    assert.equal(restoredReservationRow.slot_id, slot.slotId);
    assert.equal(restoredReservationRow.status, 'confirmed');

    restoredApi = await startCleanApi(resourceSession, { label: 'stage27-q278-restored-api-readback', cwd: path.join(checkout, 'server'),
      databasePath: restoredPath, seed: false, businessClock });
    const restoredLogin = assertOk(await request(restoredApi.baseUrl, '/auth/login', { method: 'POST',
      body: { username: 'guest_demo', password: 'guest2026', role: 'guest' } }), 200, 'restored API guest login');
    const reservationsResponse = assertOk(await request(restoredApi.baseUrl, '/reservations', { token: restoredLogin.token }), 200,
      'restored API guest reservation list');
    const reservations = Array.isArray(reservationsResponse) ? reservationsResponse : reservationsResponse.items;
    assert.ok(reservations?.some(item => item.id === booking.id), 'restored API returns the same reservation ID to the guest');
    restoredApiStop = await stopCleanApi(resourceSession, restoredApi.resource, 'q27.8-restored-api-readback-complete');
    evidence.resources.push(restoredApiStop);
    restoredApi = null;
    databaseHandleChecks.push(...assertNoDatabaseHandles([restoredPath, `${restoredPath}-wal`, `${restoredPath}-shm`, `${restoredPath}-journal`]));
    evidence.database = { freshPath: databasePath, backupPath, restoredPath, backupCounts, restoredCounts,
      integrityChecks: { source: 'ok', backup: backupIntegrity, restored: restoredIntegrity },
      reservation: restoredReservationRow, restoredApiReadback: { loginRole: restoredLogin.user.role,
        reservationId: booking.id, sameIdVisibleToGuest: true }, databaseHandleChecks };
    finalDirectoryBytes = directoryBytes(cleanRoot);
    assert.ok(finalDirectoryBytes < limits.directoryBytes,
      `clean install, cache, build, browser, and temporary databases used ${finalDirectoryBytes} bytes under 512 MiB`);
    evidence.directory = { bytesAfterCi: installBytes, finalBytesBeforeSessionCleanup: finalDirectoryBytes,
      maxBytes: limits.directoryBytes, withinLimit: true };
  } catch (error) {
    failure = error;
  }

  for (const [name, resource, reason] of [
    ['preview', preview, 'q27.8-preview-error-cleanup'], ['devStack', devStack, 'q27.8-dev-error-cleanup']
  ]) {
    if (!resource) continue;
    try { await closeManaged(resource, reason); }
    catch (error) { evidence.cleanupErrors.push(`${name}: ${String(error.message || error).slice(0, 1500)}`); }
    if (name === 'preview') preview = null;
    if (name === 'devStack') devStack = null;
  }
  if (restoredApi) {
    try {
      restoredApiStop = await stopCleanApi(resourceSession, restoredApi.resource, 'q27.8-restored-api-error-cleanup');
      evidence.resources.push(restoredApiStop);
      restoredApi = null;
    } catch (error) { evidence.cleanupErrors.push(`restoredApi: ${String(error.message || error).slice(0, 1500)}`); }
  }
  if (evidence.cleanupErrors.length && !failure) failure = new Error(`Q27.8 process cleanup failed: ${evidence.cleanupErrors.join('; ')}`);
  evidence.status = failure ? 'FAIL' : 'PASS';
  evidence.finishedAt = new Date().toISOString();
  evidence.nodeVersion = nodeVersion || null; evidence.npmVersion = npmVersion || null;
  evidence.install = evidence.install || (install ? { command: 'npm ci --ignore-scripts', receipt: install } : null);
  evidence.build = evidence.build || (build ? { command: 'npm run build', receipt: build } : null);
  evidence.automatedTests = evidence.automatedTests || (tests ? { command: 'npm test', receipt: tests } : null);
  evidence.browser = browser || null; evidence.restoredApiStop = restoredApiStop || null;
  evidence.ports = { api: apiPortSelection, devWeb: webPortSelection, preview: previewPortSelection };
  evidence.directory = evidence.directory || { bytesAfterCi: installBytes ?? null,
    finalBytesBeforeSessionCleanup: finalDirectoryBytes ?? null, maxBytes: limits.directoryBytes };
  evidence.error = failure ? String(failure.stack || failure.message || failure).slice(-9000) : null;
  fs.mkdirSync(stage27R5Root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(q278EvidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  assert.ok(fs.statSync(q278EvidencePath).size <= 8 * 1024 * 1024, 'Q27.8 evidence stays within 8 MiB');
  recordQuest('Q27.8', failure ? 'FAIL' : 'PASS', { evidencePath: path.relative(projectRoot, q278EvidencePath),
    evidenceSha256: sha256File(q278EvidencePath), cleanCheckout: checkout, sourceWorktree: projectRoot,
    copy: evidence.copy || null, install: evidence.install, build: evidence.build,
    automatedTests: evidence.automatedTests, dev: evidence.dev || null, preview: evidence.preview || null,
    browserStatus: browser?.status || null, q8: evidence.q8, database: evidence.database || null,
    restoredApiStop, ports: evidence.ports, providerRequests: 0, cleanupErrors: evidence.cleanupErrors });
  if (failure) throw Object.assign(failure, { q278EvidencePath });
  return { output: [`A fresh copy completed one npm ci --ignore-scripts, clean tests and build, then ran both dev and production preview under ResourceSession.`,
    `The real browser completed the public/guest/staff/dean flows; temporary SQLite reservation ${booking.id} survived backup/restore and guest API readback.`,
    `Q8.5–8.8 evidence: ${path.relative(projectRoot, q278EvidencePath)}.`] };
}

function stage27EvidenceRows() {
  const sourcePath = stage27R5Invocation ? stage27R5LedgerPath
    : stage27R3Invocation ? stage27R3LedgerPath : evidencePath;
  if (!fs.existsSync(sourcePath)) throw blocked('Q27 execution evidence JSONL is missing.');
  const rows = readJsonlUnderLimit(sourcePath);
  if (stage27R5Invocation && sourcePath === stage27R5LedgerPath) {
    let offset = 0;
    const prefix = crypto.createHash('sha256');
    rows.forEach((row, index) => {
      const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
      // This exact journal-less warm-smoke observation predates the current
      // append-only row journal. Preserve it only at its frozen byte position
      // and only when the complete serialized row still matches its recorded
      // SHA; every other R5 row must carry the full journal metadata.
      const frozenWarmSmokeHistory = index === 24 && offset === 56233
        && row.taskId === '01a126ea-4705-7771-ad75-e0d6ef0f4eb7'
        && row.runId === '01a126ea-4705-7771-ad75-e0d6ef0f4eb7-home-override-removal-20261011-64443e06-9d62-406a-9099-b72b18a0c801'
        && row.event === 'stage27-r5-vite-warm-smoke-home-override-removed'
        && row.eventId === '4573eaf1073cc187984a61cd852c635a49cfb1d51acfce49a43ad69f90631cec'
        && !row.journal && !row.eventSha256
        && crypto.createHash('sha256').update(line).digest('hex')
          === '59c5c6334387f447a598b3c03c15b6366702484483ed97920177b7886074aff8';
      if (frozenWarmSmokeHistory) {
        offset += line.byteLength;
        prefix.update(line);
        return;
      }
      assert.equal(row.journal?.lineNumber, index + 1, `R5 ledger row ${index + 1} keeps its stable line number`);
      assert.equal(row.journal?.byteOffset, offset, `R5 ledger row ${index + 1} keeps its stable byte offset`);
      assert.equal(row.journal?.prefixSha256Before, prefix.copy().digest('hex'), `R5 ledger row ${index + 1} records the exact prefix SHA`);
      const { eventSha256, ...unsigned } = row;
      assert.equal(eventSha256, crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
        `R5 ledger row ${index + 1} event hash verifies`);
      offset += line.byteLength;
      prefix.update(line);
    });
    assert.equal(offset, fs.statSync(sourcePath).size, 'R5 ledger rows cover the complete append-only file');
  }
  return rows.filter(item => item.taskId === process.env.CODEX_TASK_ID);
}

function stage27R5ExecutorIdentity() {
  if (!stage27R5Invocation) return null;
  if (stage27R5ExecutorIdentityCache) return stage27R5ExecutorIdentityCache;
  const protectionBytes = fs.readFileSync(stage27R5OfflineBaselinePath);
  const protectionBaseline = JSON.parse(protectionBytes.toString('utf8'));
  const baselineBytes = fs.readFileSync(stage27R5BaselinePath);
  const baseline = JSON.parse(baselineBytes.toString('utf8'));
  const forkReceiptPath = path.join(projectRoot, 'output/resource-audit/stage27-r5-source-sol-app-fork-receipt-20261011.json');
  const forkReceiptBytes = fs.readFileSync(forkReceiptPath);
  const forkReceipt = JSON.parse(forkReceiptBytes.toString('utf8'));
  stage27R5ExecutorIdentityCache = resolveStage27R5ExecutorIdentity({
    taskId: process.env.CODEX_TASK_ID,
    baseline, baselinePath: stage27R5BaselinePath, baselineBytes: baselineBytes.length,
    baselineSha256: crypto.createHash('sha256').update(baselineBytes).digest('hex'),
    forkReceipt, forkReceiptPath, forkReceiptBytes: forkReceiptBytes.length,
    forkReceiptSha256: crypto.createHash('sha256').update(forkReceiptBytes).digest('hex'),
    protectionBaseline, protectionBaselineBytes: protectionBytes.length,
    protectionBaselineSha256: crypto.createHash('sha256').update(protectionBytes).digest('hex')
  });
  return stage27R5ExecutorIdentityCache;
}

function readStage27R5PackagingReference(reference, label, limitBytes = 8 * 1024 * 1024) {
  const absolutePath = path.resolve(projectRoot, reference.path);
  assert.ok(absolutePath.startsWith(`${projectRoot}${path.sep}`), `${label} stays inside the project runtime root`);
  const bytes = fs.readFileSync(absolutePath);
  assert.ok(bytes.length <= limitBytes, `${label} stays under its bounded read limit`);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(bytes.length, reference.bytes, `${label} byte count matches the original source handoff`);
  assert.equal(sha256, reference.sha256, `${label} SHA matches the original source handoff`);
  return { path: reference.path, bytes: bytes.length, sha256,
    value: readJsonUnderLimit(absolutePath, limitBytes) };
}

function verifyR5AppendOnlyPrefix(filePath, reference, label) {
  assert.equal(path.resolve(reference.path), path.resolve(filePath), `${label} path is frozen`);
  const bytes = fs.readFileSync(filePath);
  assert.ok(bytes.length >= reference.bytes, `${label} retains its frozen byte prefix`);
  const prefixSha256 = crypto.createHash('sha256').update(bytes.subarray(0, reference.bytes)).digest('hex');
  assert.equal(prefixSha256, reference.sha256, `${label} frozen prefix SHA is unchanged`);
  return bytes;
}

function sourceAcceptedStage27Records() {
  if (!stage27R5Invocation) return new Map();
  const executorIdentity = stage27R5ExecutorIdentity();
  const sourceAcceptanceExecutor = Object.freeze({ ...executorIdentity,
    taskId: STAGE27_R5_SOURCE_PACKAGING_HANDOFF.sourceTaskId, role: 'source',
    evidenceOrigin: 'source_independent_acceptance',
    sourceTaskId: STAGE27_R5_SOURCE_PACKAGING_HANDOFF.sourceTaskId,
    workerTaskId: STAGE27_R5_SOURCE_PACKAGING_HANDOFF.workerTaskId,
    hostId: STAGE27_R5_SOURCE_PACKAGING_HANDOFF.hostId });
  const baseline = readJsonUnderLimit(stage27R5BaselinePath);
  assert.equal(baseline.r1ThroughR4Accepted, true, 'the source accepted the R1–R4 business/resource gates');
  const sourcePathByRange = new Map([
    ['Q27.1', 'stage27-r2-source-sol-final-independent-acceptance-and-handoff-20261010.json'],
    ['Q27.2', 'stage27-r3-source-sol-final-independent-acceptance-and-handoff-20261010.json'],
    ['Q27.3', 'stage27-r3-source-sol-final-independent-acceptance-and-handoff-20261010.json'],
    ['Q27.4', 'stage27-r3-source-sol-final-independent-acceptance-and-handoff-20261010.json'],
    ['Q27.5', 'stage27-r4-source-sol-final-independent-acceptance-and-handoff-20261011.json'],
    ['Q27.6', 'stage27-r4-source-sol-final-independent-acceptance-and-handoff-20261011.json']
  ]);
  const proofs = new Map();
  for (const fileName of new Set(sourcePathByRange.values())) {
    const fullPath = path.join(projectRoot, 'output/resource-audit', fileName);
    const stat = fs.statSync(fullPath);
    const manifest = (baseline.immutablePriorEvidence || []).find(item => item.path === fullPath);
    assert.ok(manifest, `source acceptance proof is protected in the R5 baseline: ${fileName}`);
    assert.equal(stat.size, manifest.bytes, `source acceptance proof byte count is unchanged: ${fileName}`);
    assert.equal(sha256File(fullPath), manifest.sha256, `source acceptance proof SHA is unchanged: ${fileName}`);
    proofs.set(fileName, { path: fullPath, value: readJsonUnderLimit(fullPath), bytes: stat.size, sha256: manifest.sha256 });
  }
  const byQuest = new Map();
  for (const [quest, fileName] of sourcePathByRange) {
    const proof = proofs.get(fileName);
    const value = proof.value;
    let sourceCommand;
    if (quest === 'Q27.1') {
      assert.equal(value.overall, 'PASS_WITH_ACCEPTED_HISTORY_EXCEPTION');
      sourceCommand = (value.actualSourceCommands || []).find(item => item.command?.includes('Q27.1'));
      assert.ok(Number(value.sourceTerminalPasses) >= 1, 'R2 source terminal suite passed');
    } else if (['Q27.2', 'Q27.3', 'Q27.4'].includes(quest)) {
      assert.equal(value.overall, 'PASS_WITH_ACCEPTED_HISTORY_EXCEPTION');
      sourceCommand = (value.sourceActualCommands || []).find(item => item.command?.includes(quest));
    } else {
      assert.equal(value.r4BusinessGate, 'PASS');
      const check = quest === 'Q27.5' ? value.q275 : value.q276;
      assert.equal(check?.status, 'PASS', `${quest} source business gate passed`);
      sourceCommand = { command: check.actualCommand, exitCode: check.exitCode };
    }
    assert.ok(sourceCommand && sourceCommand.exitCode === 0, `${quest} has an actual source-owned command that exited 0`);
    let verifiedR4EnvironmentProof = null;
    if (quest === 'Q27.6') {
      const environment = value.q276;
      assert.equal(environment?.status, 'PASS', 'source Q27.6 default environment proof passed');
      assert.equal(environment?.mode, 'Open-Meteo default modeled sea level including tides',
        'source Q27.6 used the user-selected Open-Meteo default mode');
      assert.equal(environment?.stationCredentialsRequired, false,
        'the selected default data mode does not require a QWeather station credential');
      assert.equal(environment?.dataChecks?.status, 'PASS', 'source Q27.6 verified its environment response checks');
      assert.deepEqual(environment?.dataChecks?.hourlyCounts, { weather: 24, marine: 24, modeledTide: 24 },
        'source Q27.6 verified each 24-hour data domain');
      assert.equal(environment?.snapshotReuse?.sameSnapshotId, true, 'source Q27.6 reused the same snapshot');
      verifiedR4EnvironmentProof = { sourceTaskId: value.sourceTaskId,
        status: environment.status, mode: environment.mode,
        dataChecksStatus: environment.dataChecks.status, hourlyCounts: environment.dataChecks.hourlyCounts,
        snapshotReused: environment.snapshotReuse.sameSnapshotId,
        stationCredentialsRequired: environment.stationCredentialsRequired,
        sourceProofPath: path.relative(projectRoot, proof.path), sourceProofSha256: proof.sha256 };
    }
    byQuest.set(quest, { quest, status: 'PASS', evidenceOrigin: 'source_independent_acceptance',
      sourceTaskId: value.sourceTaskId, sourceProofPath: path.relative(projectRoot, proof.path),
      sourceProofBytes: proof.bytes, sourceProofSha256: proof.sha256,
      actualSourceCommand: sourceCommand.command, actualSourceExitCode: sourceCommand.exitCode,
      acceptanceExecutor: sourceAcceptanceExecutor, verifiedR4EnvironmentProof });
  }

  const handoffBytes = fs.readFileSync(stage27R5PackagingHandoffPath);
  const handoff = { path: STAGE27_R5_SOURCE_PACKAGING_HANDOFF.path, bytes: handoffBytes.length,
    sha256: crypto.createHash('sha256').update(handoffBytes).digest('hex'),
    value: readJsonUnderLimit(stage27R5PackagingHandoffPath, 1024 * 1024) };
  const sourceLedgerReference = handoff.value.sourceExecutionLedgerMustStayExact;
  const sourceLedgerPath = path.join(projectRoot, STAGE27_R5_SOURCE_PACKAGING_HANDOFF.sourceProofs.sourceExecutionLedgerPath);
  const sourceLedgerBytes = verifyR5AppendOnlyPrefix(sourceLedgerPath, sourceLedgerReference, 'source execution ledger');
  const metadataHandoff = readStage27R5PackagingReference(STAGE27_R5_ROW_PROVENANCE_HANDOFF,
    'row-provenance/document-repair handoff', 1024 * 1024);
  const compatibilityNote = readStage27R5PackagingReference(STAGE27_R5_ROW_PROVENANCE_HANDOFF.compatibilityNote,
    'source-ledger append compatibility note', 64 * 1024);
  const sourceLedgerBinding = verifyStage27R5SourceLedgerWindow({
    executorIdentity, metadataHandoff, originalProofHandoff: handoff, compatibilityNote,
    sourceLedgerPath, sourceLedgerBytes
  });
  const workerLedgerReference = handoff.value.workerExecutionLedgerAppendOnlyPrefix;
  verifyR5AppendOnlyPrefix(path.resolve(projectRoot, workerLedgerReference.path), workerLedgerReference,
    'worker execution ledger');
  const readBound = (reference, label, limit) => readStage27R5PackagingReference(reference, label, limit);
  const proofBindings = STAGE27_R5_SOURCE_PACKAGING_HANDOFF.sourceProofs;
  const sourceProofs = verifyStage27R5SourceAcceptance({
    executorIdentity,
    handoff,
    q277Proof: readBound(proofBindings.Q27_7, 'source Q27.7 proof'),
    q277Evidence: { path: proofBindings.Q27_7.evidencePath,
      bytes: proofBindings.Q27_7.evidenceBytes, sha256: proofBindings.Q27_7.evidenceSha256,
      value: readJsonlUnderLimit(path.join(projectRoot, proofBindings.Q27_7.evidencePath)) },
    q278Proof: readBound(proofBindings.Q27_8, 'source Q27.8 proof'),
    commandEvidence: readBound(proofBindings.commandEvidence, 'source actual command evidence'),
    q279Rtm: readBound(proofBindings.Q27_9, 'source Q27.9 RTM proof', 16 * 1024 * 1024),
    sourceExecutionRows: readJsonlUnderLimit(sourceLedgerPath)
  });
  for (const sourceProof of sourceProofs) {
    const actualEvidencePath = path.relative(projectRoot, path.join(projectRoot, sourceProof.actualEvidencePath));
    byQuest.set(sourceProof.quest, { ...sourceProof,
      sourceProofPath: path.relative(projectRoot, path.join(projectRoot, sourceProof.sourceProofPath)),
      actualEvidencePath, evidencePath: actualEvidencePath,
      ...(sourceProof.quest === 'Q27.9' ? { summaryPath: actualEvidencePath } : {}),
      commandEvidencePath: path.relative(projectRoot, path.join(projectRoot, sourceProof.commandEvidencePath)),
      sourceLedgerBinding });
  }
  return byQuest;
}

function latestStage27QuestRecords() {
  const latest = sourceAcceptedStage27Records();
  const executorIdentity = stage27R5ExecutorIdentity();
  for (const row of stage27EvidenceRows()) if (/^Q27\.[1-9]$/.test(row.quest)) {
    const previous = latest.get(row.quest) || {};
    latest.set(row.quest, latest.has(row.quest)
      ? retainStage27R5ExecutorObservation(previous, row, executorIdentity)
      : row);
  }
  return latest;
}

function questEvidencePaths(questId, latest) {
  const record = latest.get(questId);
  const paths = [];
  if (questId === 'Q27.2') paths.push(path.relative(projectRoot, q272EvidencePath));
  paths.push(path.relative(projectRoot, evidencePath));
  for (const value of [record?.evidencePath, record?.expandedTraceScreenshot?.evidencePath,
    record?.expandedTraceScreenshot?.screenshotPath, record?.screenshotDirectory, record?.sourceProofPath]) {
    if (typeof value === 'string' && value.length < 2048) paths.push(path.isAbsolute(value) ? path.relative(projectRoot, value) : value);
  }
  return [...new Set(paths)];
}

function csvCell(value) { return `"${String(value ?? '').replaceAll('"', '""')}"`; }

function sha256File(filePath) {
  const digest = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let read;
    while ((read = fs.readSync(descriptor, chunk, 0, chunk.length, null)) > 0) digest.update(chunk.subarray(0, read));
  } finally { fs.closeSync(descriptor); }
  return digest.digest('hex');
}

function splitMarkdownRow(line) {
  return line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim());
}

function parseEvidenceTables(source) {
  const lines = source.split(/\r?\n/u);
  const evidence = new Map(); const api = new Map();
  let section = '';
  for (const line of lines) {
    if (/^##\s/u.test(line)) section = line;
    if (!line.startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    if (section === '## 证据索引' && cells.length >= 2 && /^[A-Z]\d{0,3}$/u.test(cells[0])) evidence.set(cells[0], cells[1]);
    if (section === '## 当前 API 路由与 RTM 邻接关系' && cells.length >= 5 && /^A\d{2,3}$/u.test(cells[0])) {
      api.set(cells[0], { id: cells[0], methodAndPath: cells[1], sourceLocation: cells[2], mapping: cells[3], testEvidence: cells[4] || '' });
    }
  }
  return { evidence, api };
}

let indexedSearchFiles = null;
function sourceSearchFiles() {
  if (indexedSearchFiles) return indexedSearchFiles;
  const files = []; const roots = [path.join(projectRoot, 'server'), path.join(projectRoot, 'web')];
  const skip = new Set(['node_modules', '.git', 'output', 'dist', 'coverage']);
  function walk(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || skip.has(entry.name)) continue;
      const resolved = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(resolved);
      else if (entry.isFile()) {
        files.push(resolved);
        if (files.length > 25_000) throw new Error('RTM evidence source search exceeds 25,000 files');
      }
    }
  }
  for (const root of roots) walk(root);
  indexedSearchFiles = files;
  return files;
}

function normalizeEvidencePath(raw) {
  let token = raw.trim().replace(/^['"`]|['"`,;]$/gu, '');
  token = token.replace(/:\d+(?:[-–—,、]\d+)*$/u, '');
  token = token.replace(/[).，；]+$/u, '');
  if (!token || token.startsWith('http:') || token.startsWith('https:')) return null;
  if (token.startsWith('项目源码/')) return path.resolve(projectRoot, token.slice('项目源码/'.length));
  if (token.startsWith('server/') || token.startsWith('web/')) return path.resolve(projectRoot, token);
  if (token.startsWith('output/')) return path.resolve(projectRoot, token);
  if (token.startsWith('docs/') || token.startsWith('wangshanchong/')) return path.resolve(projectRoot, '..', token);
  if (token.startsWith('../')) return path.resolve(path.dirname(rtmPath), token);
  if (path.isAbsolute(token)) return token;
  return null;
}

function expandEvidencePath(raw) {
  const token = raw.trim();
  if (token.includes('*')) {
    const normalized = normalizeEvidencePath(token.replace(/\*/gu, ''));
    if (!normalized) return [];
    const parent = path.dirname(normalized); const basePrefix = path.basename(token.replace(/\*/gu, ''));
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.startsWith(basePrefix))
      .map(entry => path.join(parent, entry.name));
  }
  const normalized = normalizeEvidencePath(token);
  if (normalized && fs.existsSync(normalized)) return [normalized];
  const basename = token.split('/').at(-1).replace(/:\d+(?:[-–—,、]\d+)*$/u, '').replace(/[).，；]+$/u, '');
  if (/\.(?:md|js|jsx|css|json|jsonl|png|jpg|svg|wav)$/iu.test(basename)) {
    return sourceSearchFiles().filter(file => path.basename(file) === basename);
  }
  return [];
}

function artifactForPath(filePath, lineRef = null) {
  const relative = path.relative(projectRoot, filePath) || '.';
  const stat = fs.statSync(filePath);
  if (stat.isFile()) {
    let lineCheck = null;
    if (lineRef) {
      const maxRead = Math.min(stat.size, 4 * 1024 * 1024);
      if (stat.size <= 4 * 1024 * 1024) {
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/u);
        lineCheck = { declared: lineRef, lineCount: lines.length,
          inBounds: lineRef.end <= lines.length, excerpt: lines.slice(Math.max(0, lineRef.start - 1), Math.min(lines.length, lineRef.end)).join('\n').slice(0, 500) };
      } else lineCheck = { declared: lineRef, lineCount: null, inBounds: null, note: `file exceeds bounded line inspection (${maxRead} bytes inspected limit)` };
    }
    return { path: relative, kind: 'file', bytes: stat.size, sha256: sha256File(filePath), lineCheck };
  }
  if (!stat.isDirectory()) return { path: relative, kind: 'other', bytes: stat.size, unresolved: true };
  const children = []; let totalBytes = 0; let overflow = false;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) {
        const childStat = fs.statSync(child); totalBytes += childStat.size;
        if (children.length >= 1000 || totalBytes > 512 * 1024 * 1024) { overflow = true; return; }
        children.push({ path: path.relative(projectRoot, child), bytes: childStat.size, sha256: sha256File(child) });
      }
      if (overflow) return;
    }
  }
  walk(filePath); children.sort((a, b) => a.path.localeCompare(b.path));
  return { path: relative, kind: 'directory', fileCount: children.length, bytes: totalBytes,
    sha256: crypto.createHash('sha256').update(JSON.stringify(children)).digest('hex'), children, boundedScanOverflow: overflow };
}

function referencedLine(text, basename) {
  const position = text.indexOf(basename);
  if (position < 0) return null;
  const match = text.slice(position + basename.length).match(/^:(\d+)(?:[–—-](\d+))?/u);
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2] || match[1]) };
}

function artifactFromDefinitionToken(raw, definitionText) {
  const hits = expandEvidencePath(raw);
  return hits.map(filePath => ({ artifact: artifactForPath(filePath,
    referencedLine(raw, path.basename(filePath)) || referencedLine(definitionText, path.basename(filePath))), absolutePath: filePath }));
}

function resolveApiEvidence(code, row) {
  const methodMatch = row.methodAndPath.replaceAll('`', '').match(/\b(GET|POST|PATCH|PUT|DELETE)\s+([^\s]+)/u);
  const sourceMatch = row.sourceLocation.match(/`([^`]+)`/u);
  if (!methodMatch || !sourceMatch) return { code, resolved: false, reason: 'API map row is missing a method/path or source path.', artifacts: [] };
  const method = methodMatch[1].toLowerCase(); const endpoint = methodMatch[2];
  const [sourceToken, sourceLineText] = sourceMatch[1].split(':');
  const sourceCandidates = expandEvidencePath(sourceToken);
  const appPath = sourceCandidates.find(candidate => path.basename(candidate) === 'app.js') || path.join(projectRoot, 'server/src/app.js');
  const appExists = fs.existsSync(appPath);
  let actualLines = [];
  if (appExists) {
    const appLines = fs.readFileSync(appPath, 'utf8').split(/\r?\n/u);
    actualLines = appLines.flatMap((line, index) =>
      line.includes(`routes.${method}('${endpoint}'`) || line.includes(`routes.${method}("${endpoint}"`) ? [index + 1] : []);
  }
  const artifacts = appExists ? [artifactForPath(appPath, { start: Number(sourceLineText), end: Number(sourceLineText) })] : [];
  const routeContractPath = path.resolve(projectRoot, '../docs/API运行契约.md');
  if (fs.existsSync(routeContractPath)) artifacts.push(artifactForPath(routeContractPath));
  const testRefs = [...row.testEvidence.matchAll(/([A-Za-z0-9_.-]+\.test\.js):(\d+)(?:[–—-](\d+))?/gu)];
  const routeParts = endpoint.replace(/^\/api/u, '').split('/').filter(part => part && !part.startsWith(':'));
  const routeTestAnchor = routeParts.at(-1) || '';
  const tests = testRefs.map(match => {
    const candidates = sourceSearchFiles().filter(file => path.basename(file) === match[1]);
    const testPath = candidates[0];
    if (!testPath) return { ref: match[0], resolved: false };
    const line = { start: Number(match[2]), end: Number(match[3] || match[2]) };
    const testArtifact = artifactForPath(testPath, line);
    artifacts.push(testArtifact);
    const testLines = fs.readFileSync(testPath, 'utf8').split(/\r?\n/u);
    const currentRouteTestLines = routeTestAnchor ? testLines.flatMap((text, index) => text.includes(routeTestAnchor) ? [index + 1] : []) : [];
    const declaredExcerptMatchesRoute = routeTestAnchor ? Boolean(testArtifact.lineCheck?.excerpt?.includes(routeTestAnchor)) : false;
    return { ref: match[0], resolved: testArtifact.lineCheck?.inBounds !== false, path: testArtifact.path,
      lineCheck: testArtifact.lineCheck, routeTestAnchor, currentRouteTestLines,
      declaredExcerptMatchesRoute, declaredLineReferenceStale: currentRouteTestLines.length > 0 && !declaredExcerptMatchesRoute };
  });
  const explicitNoTest = /无独立断言|仅核对源码和契约/u.test(row.testEvidence);
  return { code, resolved: appExists && actualLines.length > 0 && tests.every(test => test.resolved), method: method.toUpperCase(), endpoint,
    declaredSourceLine: Number(sourceLineText), actualRouteLines: actualLines, sourceLineDrift: actualLines.length > 0 && !actualLines.includes(Number(sourceLineText)),
    testReferences: tests, testAssertionNotListed: explicitNoTest, artifacts, reason: actualLines.length ? null : `Current server source does not contain ${method.toUpperCase()} ${endpoint}.` };
}

function resolveIndexedEvidence(code, definitions, apiRows) {
  if (/^A\d{2,3}$/u.test(code)) {
    const apiRow = apiRows.get(code);
    return apiRow ? resolveApiEvidence(code, apiRow) : { code, resolved: false, reason: 'Referenced API mapping row is absent.', artifacts: [] };
  }
  const definition = definitions.get(code);
  if (!definition) return { code, resolved: false, reason: 'Evidence code is missing from the RTM evidence index.', artifacts: [] };
  const tokens = [...definition.matchAll(/`([^`]+)`/gu)].map(match => match[1]);
  const artifacts = []; const unresolvedTokens = [];
  const addToken = raw => {
    const found = artifactFromDefinitionToken(raw, definition);
    if (found.length) artifacts.push(...found.map(item => item.artifact));
    else if (/\.(?:md|js|jsx|css|json|jsonl|png|jpg|svg|wav)(?:[:*]|$)/iu.test(raw.trim())) unresolvedTokens.push(raw);
  };
  for (const token of tokens) addToken(token);
  for (const match of definition.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) addToken(match[1]);
  for (const roundMatch of definition.matchAll(/第\s*(\d+)\s*轮报告/gu)) {
    addToken(`../wangshanchong/第${roundMatch[1]}轮报告.md`);
  }
  if (code === 'U3') addToken('../wangshanchong/第18轮报告.md');
  if (code === 'N1') {
    addToken('../docs/API运行契约.md'); addToken('项目源码/server/src/app.js'); addToken('项目源码/server/src/schema.js');
  }
  if (code === 'U1' && definition.includes('MoodPlayerDock')) {
    const candidates = sourceSearchFiles().filter(file => /MoodPlayerDock/u.test(fs.readFileSync(file, 'utf8')));
    for (const candidate of candidates) artifacts.push(artifactForPath(candidate));
  }
  const unique = [...new Map(artifacts.map(item => [item.path, item])).values()];
  const allNestedPaths = new Set(unique.flatMap(item => item.children?.map(child => path.basename(child.path)) || []));
  const remainingUnresolved = unresolvedTokens.filter(token => !allNestedPaths.has(token.split('/').at(-1)));
  return { code, definition, resolved: unique.length > 0 && remainingUnresolved.length === 0 && unique.every(item => !item.boundedScanOverflow),
    unresolvedTokens: remainingUnresolved, artifacts: unique, reason: unique.length ? null : 'No explicit source/report artifact resolved from the evidence index entry.' };
}

function expandEvidenceCodeReferences(text) {
  const found = new Set();
  for (const group of text.matchAll(/[（(]([^（）()]*)[）)]/gu)) {
    const inner = group[1];
    for (const range of inner.matchAll(/\b(A\d{2,3})\s*[–—-]\s*(A\d{2,3})\b/gu)) {
      const start = Number(range[1].slice(1)); const end = Number(range[2].slice(1));
      if (end >= start && end - start < 200) for (let value = start; value <= end; value += 1) found.add(`A${String(value).padStart(2, '0')}`);
    }
    for (const match of inner.matchAll(/\b(?:[UDTEMHN]\d{1,2}|A\d{2,3})\b/gu)) found.add(match[0]);
  }
  return [...found].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

function parseQ27References(text, latest, relation) {
  const ids = [...new Set([...text.matchAll(/\bQ27\.([1-9])\b/gu)].map(match => `Q27.${match[1]}`))];
  return ids.map(questId => {
    const record = latest.get(questId);
    return { questId, status: record?.status || 'MISSING', relation,
      evidenceOrigin: record?.evidenceOrigin || 'worker_self_validation',
      evidencePath: record?.sourceProofPath || (record?.evidencePath
        ? path.relative(projectRoot, record.evidencePath) : path.relative(projectRoot, evidencePath)),
      sourceProofPath: record?.sourceProofPath || null,
      sourceTaskId: record?.sourceTaskId || null, sourceProofSha256: record?.sourceProofSha256 || null,
      acceptanceExecutor: record?.acceptanceExecutor || null,
      verifiedR4EnvironmentProof: record?.verifiedR4EnvironmentProof || null,
      runId: record?.runId || invocationRunId || null };
  });
}

function manualRtmEvidence(id) {
  if (![63, 64].includes(id)) return [];
  const reviewPath = path.join(projectRoot, 'output/resource-audit/stage24-source-sol-final-independent-acceptance-and-pause-20261009.json');
  const reportPath = path.resolve(projectRoot, '../wangshanchong/第30轮报告.md');
  const review = readJsonUnderLimit(reviewPath);
  const report = fs.readFileSync(reportPath, 'utf8');
  const relevant = id === 63 ? /Q24\.1[–-]Q24\.4/u.test(report)
    : /Q24\.1[–-]Q24\.4/u.test(report) && /实际显示反馈版本/u.test(report);
  const stagePassed = review.stage24BusinessGate === 'PASS' && review.stage24Overall === 'PASS_WITH_ACCEPTED_HISTORY_EXCEPTION' && relevant;
  return [{ code: 'explicit-stage24-source-review', relation: 'historical independent acceptance explicitly used because the RTM row has no evidence-index code',
    resolved: stagePassed, artifacts: [artifactForPath(reviewPath), artifactForPath(reportPath)], reason: stagePassed ? null : 'Stage24 acceptance record/report did not verify the mapped behavior.' }];
}

async function runQ279() {
  if (!fs.existsSync(rtmPath)) throw blocked(`RTM source is missing: ${rtmPath}`);
  const sourceStat = fs.statSync(rtmPath);
  assert.ok(sourceStat.size <= 4 * 1024 * 1024, 'RTM source is under the bounded 4 MiB read limit');
  const source = fs.readFileSync(rtmPath, 'utf8');
  const { evidence: definitions, api: apiRows } = parseEvidenceTables(source);
  const parsed = [];
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    const cells = splitMarkdownRow(line);
    if (!/^\d{1,3}$/u.test(cells[0] || '')) continue;
    const currentSevenColumnLayout = cells.length >= 7;
    parsed.push({ sourceLine: index + 1, id: Number(cells[0]), mappingTitle: currentSevenColumnLayout ? cells[1] || '' : cells[1] || '',
      originalRtmName: currentSevenColumnLayout ? cells[2] || '' : cells[1] || '',
      requirement: currentSevenColumnLayout ? cells[3] || '' : cells[1] || '',
      currentRtmStatus: currentSevenColumnLayout ? cells[4] || '' : cells[2] || '',
      currentEvidenceText: currentSevenColumnLayout ? cells[5] || '' : cells[3] || '',
      futureQuestPlan: currentSevenColumnLayout ? cells[6] || '' : cells[4] || '' });
  }
  parsed.sort((left, right) => left.id - right.id);
  const ids = parsed.map(item => item.id);
  const missingIds = Array.from({ length: 109 }, (_, index) => index + 1).filter(id => !ids.includes(id));
  const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  assert.equal(parsed.length, 109, `109 RTM requirement rows parsed; actual=${parsed.length}`);
  assert.deepEqual(ids, Array.from({ length: 109 }, (_, index) => index + 1), 'RTM IDs 1–109 have no gaps or duplicates');
  assert.deepEqual(missingIds, []); assert.deepEqual(duplicates, []);
  const latest = latestStage27QuestRecords();
  const stageOutcomes = Object.fromEntries(Array.from({ length: 9 }, (_, index) => {
    const questId = `Q27.${index + 1}`;
    return [questId, questId === 'Q27.9' ? 'MAPPING_IN_PROGRESS' : latest.get(questId)?.status || 'MISSING'];
  }));
  const resolverCache = new Map();
  const resolveCode = code => {
    if (!resolverCache.has(code)) resolverCache.set(code, resolveIndexedEvidence(code, definitions, apiRows));
    return resolverCache.get(code);
  };
  const rows = parsed.map(item => {
    const currentEvidenceCodes = expandEvidenceCodeReferences(item.currentEvidenceText);
    const currentStage27Outcomes = parseQ27References(item.currentEvidenceText, latest, 'current evidence text');
    const futureQuestRefs = [...new Set([...item.futureQuestPlan.matchAll(/\bQ\d+\.\d+\b/gu)].map(match => match[0]))];
    const futureQuestOutcomes = futureQuestRefs.filter(questId => questId.startsWith('Q27.')).map(questId => ({
      questId, status: stageOutcomes[questId] || 'MISSING', relation: 'future Quest column is planning context, not current evidence',
      evidencePath: path.relative(projectRoot, evidencePath)
    }));
    const codeEvidence = currentEvidenceCodes.map(resolveCode);
    const additionalEvidence = manualRtmEvidence(item.id);
    const evidenceResolved = (codeEvidence.length + additionalEvidence.length) > 0 &&
      [...codeEvidence, ...additionalEvidence].every(entry => entry.resolved);
    const implementation = /^未实现/u.test(item.currentRtmStatus) ? 'unimplemented'
      : /^部分覆盖/u.test(item.currentRtmStatus) ? 'partial' : /^已实现/u.test(item.currentRtmStatus) ? 'implemented' : 'uncategorized';
    const failedCurrentQuest = currentStage27Outcomes.find(entry => entry.status === 'FAIL');
    const blockedCurrentQuest = currentStage27Outcomes.find(entry => entry.status === 'BLOCKED' || entry.status === 'MISSING');
    let status; let reason;
    if (implementation === 'unimplemented') {
      status = 'FAIL'; reason = 'The current RTM marks this capability unimplemented; a future Quest reference is not evidence of implementation.';
    } else if (failedCurrentQuest) {
      status = 'FAIL'; reason = `${failedCurrentQuest.questId} is explicitly cited in current evidence and failed in this task.`;
    } else if (implementation === 'partial') {
      status = 'BLOCKED'; reason = evidenceResolved
        ? 'Current evidence files resolve, but the RTM explicitly records incomplete scope; a passing sub-scenario cannot close the full requirement.'
        : 'The RTM records incomplete scope and at least one current evidence reference is unresolved.';
    } else if (blockedCurrentQuest) {
      status = 'BLOCKED'; reason = `${blockedCurrentQuest.questId} is directly cited in current evidence but is blocked or missing.`;
    } else if (implementation === 'implemented' && evidenceResolved) {
      status = 'PASS'; reason = 'The RTM marks this bounded requirement implemented and every current evidence reference resolves to a fingerprinted source/report artifact.';
    } else {
      status = 'BLOCKED'; reason = currentEvidenceCodes.length === 0 && additionalEvidence.length === 0
        ? 'No current evidence-index code or explicit acceptance artifact is attached; future Quest references remain plans.'
        : 'At least one current evidence-index reference could not be resolved or fingerprinted.';
    }
    const { quests: r5QuestSubscenarios, sourceEvidence: r5SourceEvidence } = buildStage27R5RowSourceEvidence({
      rowId: item.id, latestRecords: latest, enabled: stage27R5Invocation
    });
    const q276SourceRecord = currentStage27Outcomes.find(entry => entry.questId === 'Q27.6');
    const environmentAcceptance = deriveEnvironmentFunctionalAcceptance({
      mappingTitle: item.mappingTitle, originalRtmName: item.originalRtmName, requirement: item.requirement,
      currentEvidenceText: item.currentEvidenceText, currentStage27Outcomes,
      sourceEnvironmentProof: q276SourceRecord?.verifiedR4EnvironmentProof
    });
    const functionalAcceptanceStatus = environmentAcceptance?.status
      || (r5QuestSubscenarios.length ? 'SUBSCENARIO_PASS_PENDING_FULL_ACCEPTANCE' : 'UNVERIFIED');
    const functionalAcceptanceEvidence = environmentAcceptance ? { kind: 'source-verified-bounded-environment-subscenario',
      questId: 'Q27.6', sourceTaskId: q276SourceRecord?.sourceTaskId || null,
      sourceProofPath: q276SourceRecord?.sourceProofPath || null,
      sourceProofSha256: q276SourceRecord?.sourceProofSha256 || null,
      scope: environmentAcceptance.scope }
      : r5SourceEvidence.length ? { kind: 'source-verified-bounded-r5-subscenario',
        evidenceOrigin: 'source_independent_acceptance', sourceTaskId: STAGE27_R5_SOURCE_PACKAGING_HANDOFF.sourceTaskId,
        quests: r5SourceEvidence } : null;
    const sourceEvidence = [...currentStage27Outcomes.filter(entry => entry.evidenceOrigin === 'source_independent_acceptance'),
      ...r5SourceEvidence.map(record => ({ ...record,
        relation: 'source-accepted bounded R5 sub-scenario; full original RTM requirement remains unverified' }))];
    const workerEvidence = currentStage27Outcomes.filter(entry => entry.evidenceOrigin !== 'source_independent_acceptance');
    return { ...item, implementation, currentEvidenceCodes, currentStage27Outcomes, futureQuestRefs, futureQuestOutcomes,
      codeEvidence, additionalEvidence, evidenceResolved, mappingStatus: status, status, reason,
      functionalAcceptanceStatus, functionalAcceptanceEvidence,
      functionalAcceptanceReason: environmentAcceptance?.reason
        || (r5SourceEvidence.length ? `Source independently accepted ${r5QuestSubscenarios.join(', ')} for this bounded row-level sub-scenario; the complete original RTM requirement remains unverified.`
          : 'No complete source-independent functional acceptance for this RTM row is recorded in this R5 package.'),
      r5QuestSubscenarios, sourceEvidence, workerEvidence,
      rtmSource: { path: path.relative(projectRoot, rtmPath), line: item.sourceLine, sha256: sha256File(rtmPath), bytes: sourceStat.size } };
  });
  const counts = Object.fromEntries(['PASS', 'BLOCKED', 'FAIL'].map(status => [status, rows.filter(row => row.status === status).length]));
  const functionalAcceptanceCounts = Object.fromEntries(['UNVERIFIED', 'EXTERNAL_BLOCK', 'SUBSCENARIO_PASS_PENDING_FULL_ACCEPTANCE']
    .map(status => [status, rows.filter(row => row.functionalAcceptanceStatus === status).length]));
  assert.equal(rows.length, 109); assert.equal(counts.PASS + counts.BLOCKED + counts.FAIL, 109);
  const generatedAt = new Date().toISOString();
  const csvHeader = ['id', 'mappingTitle', 'originalRtmName', 'requirement', 'mappingStatus', 'functionalAcceptanceStatus', 'functionalAcceptanceEvidence', 'r5QuestSubscenarios',
    'currentRtmStatus', 'implementation', 'currentEvidenceText', 'currentEvidenceCodes', 'verifiedCurrentEvidence',
    'sourceEvidence', 'workerEvidence', 'currentStage27Outcomes', 'futureQuestPlan', 'futureQuestOutcomes', 'evidenceResolved', 'reason', 'functionalAcceptanceReason', 'sourceLine'];
  const csv = [csvHeader.map(csvCell).join(','), ...rows.map(row => [row.id, row.mappingTitle, row.originalRtmName, row.requirement, row.mappingStatus, row.functionalAcceptanceStatus,
    JSON.stringify(row.functionalAcceptanceEvidence),
    JSON.stringify(row.r5QuestSubscenarios), row.currentRtmStatus,
    row.implementation, row.currentEvidenceText, JSON.stringify(row.currentEvidenceCodes),
    JSON.stringify({ indexed: row.codeEvidence, additional: row.additionalEvidence }), JSON.stringify(row.sourceEvidence), JSON.stringify(row.workerEvidence),
    JSON.stringify(row.currentStage27Outcomes), row.futureQuestPlan, JSON.stringify(row.futureQuestOutcomes), row.evidenceResolved,
    row.reason, row.functionalAcceptanceReason, row.sourceLine].map(csvCell).join(','))].join('\n') + '\n';
  assert.ok(Buffer.byteLength(csv) < 8 * 1024 * 1024, 'RTM evidence CSV stays below 8 MiB');
  fs.writeFileSync(rtmCsvPath, csv, { encoding: 'utf8', mode: 0o600 });
  const evidenceRefCount = rows.reduce((sum, row) => sum + row.currentEvidenceCodes.length, 0);
  const unresolvedEvidenceCodeCount = [...resolverCache.values()].filter(item => !item.resolved).length;
  const apiTestLineReferenceCount = [...resolverCache.values()].reduce((sum, item) => sum + (item.testReferences?.length || 0), 0);
  const staleApiTestLineReferenceCount = [...resolverCache.values()].reduce((sum, item) => sum + (item.testReferences || []).filter(test => test.declaredLineReferenceStale).length, 0);
  const summary = { generatedAt, taskId: process.env.CODEX_TASK_ID, sourcePath: path.relative(projectRoot, rtmPath),
    sourceSha256: sha256File(rtmPath), outputCsv: path.relative(projectRoot, rtmCsvPath), parsedCount: rows.length,
    idsComplete: ids.length === 109 && missingIds.length === 0 && duplicates.length === 0, missingIds, duplicateIds: duplicates,
    statusCounts: counts, mappingStatusCounts: counts, functionalAcceptanceCounts,
    executorIdentity: stage27R5ExecutorIdentity(),
    functionalAcceptanceSemantics: 'R4 Q27.6 source proof supports only explicitly cited selected-default Open-Meteo data/display sub-scenarios; source identity, response completeness and snapshot checks must verify before classification. Safety-threshold rows remain UNVERIFIED until institution-approved thresholds and complete page/assistant flows are accepted. Q27.7/8 create only bounded sub-scenario passes for directly mapped rows. Mapping completeness never implies feature acceptance.',
    stage27Outcomes: stageOutcomes, stage27OutcomeProvenance: Object.fromEntries([...latest].map(([quest, record]) => [quest,
      { status: record.status, evidenceOrigin: record.evidenceOrigin || 'worker_self_validation',
        sourceTaskId: record.sourceTaskId || null, sourceProofPath: record.sourceProofPath || null,
        sourceProofSha256: record.sourceProofSha256 || null, runId: record.runId || null,
        acceptanceExecutor: record.acceptanceExecutor || null,
        verifiedR4EnvironmentProof: record.verifiedR4EnvironmentProof || null }])),
    currentEvidenceReferenceCount: evidenceRefCount,
    evidenceIndexCodeCount: definitions.size, apiMappingRowCount: apiRows.size, apiMappingFirstIds: [...apiRows.keys()].slice(0, 8),
    apiTestLineReferenceCount, staleApiTestLineReferenceCount,
    uniqueEvidenceCodes: [...resolverCache.keys()].length, unresolvedUniqueEvidenceCodes: [...resolverCache.values()].filter(item => !item.resolved).map(item => item.code),
    semantics: 'PASS is limited to RTM rows marked implemented whose current evidence-index artifacts resolve and are fingerprinted. BLOCKED preserves partial scope, missing evidence links, or directly blocked current-stage evidence. FAIL preserves rows explicitly marked unimplemented or a failure cited in current evidence. The future Quest column is carried as planning context only and never decides the current row status.',
    rows: rows.map(row => ({ id: row.id, mappingTitle: row.mappingTitle, originalRtmName: row.originalRtmName,
      requirement: row.requirement, currentRtmStatus: row.currentRtmStatus,
      currentEvidenceText: row.currentEvidenceText, currentEvidenceCodes: row.currentEvidenceCodes,
      mappingStatus: row.mappingStatus, functionalAcceptanceStatus: row.functionalAcceptanceStatus,
      functionalAcceptanceEvidence: row.functionalAcceptanceEvidence,
      functionalAcceptanceReason: row.functionalAcceptanceReason, r5QuestSubscenarios: row.r5QuestSubscenarios,
      sourceEvidence: row.sourceEvidence, workerEvidence: row.workerEvidence, status: row.status, reason: row.reason,
      currentStage27Outcomes: row.currentStage27Outcomes, futureQuestOutcomes: row.futureQuestOutcomes,
      evidenceResolved: row.evidenceResolved, codeEvidence: row.codeEvidence, additionalEvidence: row.additionalEvidence,
      sourceLine: row.sourceLine, rtmSource: row.rtmSource })) };
  fs.writeFileSync(rtmSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const qStatus = ids.length === 109 && missingIds.length === 0 && duplicates.length === 0 ? 'PASS' : 'FAIL';
  recordQuest('Q27.9', qStatus, { mappingPath: path.relative(projectRoot, rtmPath), outputCsv: path.relative(projectRoot, rtmCsvPath),
    summaryPath: path.relative(projectRoot, rtmSummaryPath), parsedCount: rows.length, missingIds, duplicateIds: duplicates,
    statusCounts: counts, stage27Outcomes: stageOutcomes, currentEvidenceReferenceCount: evidenceRefCount,
    unresolvedUniqueEvidenceCodes: summary.unresolvedUniqueEvidenceCodes, summarySha256: sha256File(rtmSummaryPath),
    apiTestLineReferenceCount, staleApiTestLineReferenceCount, csvBytes: fs.statSync(rtmCsvPath).size, unresolvedEvidenceCodeCount });
  const aggregate = stage27R5Invocation ? await writeStageAggregate() : null;
  if (aggregate) appendStage27R5Event(evidencePath, { event: 'stage27-r5-aggregate-generated', quest: 'Q27.aggregate',
    status: aggregate.overall, aggregatePath: path.relative(projectRoot, aggregatePath),
    aggregateSha256: sha256File(aggregatePath), rtmSummaryPath: path.relative(projectRoot, rtmSummaryPath) });
  const output = [`RTM items 1–109 are present with no missing or duplicate IDs: ${JSON.stringify(counts)}.`,
    `Implementation mapping and full functional acceptance are separate: ${JSON.stringify(functionalAcceptanceCounts)} functional states; Q27.7/8 mark bounded sub-scenarios only.`,
    `Verified current evidence references: ${evidenceRefCount}; unresolved unique codes: ${summary.unresolvedUniqueEvidenceCodes.length}.`,
    `API test-source references: ${apiTestLineReferenceCount}; declared line ranges whose excerpts do not contain the route anchor: ${staleApiTestLineReferenceCount}.`,
    `Future Quest references and their current Q27 outcomes are separately labeled as planning context; CSV and fingerprinted JSON: ${path.relative(projectRoot, rtmCsvPath)}, ${path.relative(projectRoot, rtmSummaryPath)}.`,
    ...(aggregate ? [`Combined source R1–R4 plus this task Q27.7–9 remains ${aggregate.overall}; aggregate: ${path.relative(projectRoot, aggregatePath)}.`] : [])];
  return { output };
}

async function summarizeStageQuest(questId) {
  if (stage27R5Invocation && questId === 'Q27.9') {
    const aggregate = await writeStageAggregate();
    appendStage27R5Event(evidencePath, { event: 'stage27-r5-stage-only-aggregate', quest: 'Q27.aggregate',
      status: aggregate.overall, aggregatePath: path.relative(projectRoot, aggregatePath),
      aggregateSha256: sha256File(aggregatePath), reranQuests: [] });
    if (aggregate.overall !== 'PASS') throw blocked(`Stage27 R5 aggregate is ${aggregate.overall}; no quests were rerun. See ${path.relative(projectRoot, aggregatePath)}.`);
    return { output: ['Aggregated only previously recorded source R1–R4 and worker R5 results: PASS.',
      `No quest was rerun; aggregate: ${path.relative(projectRoot, aggregatePath)}.`] };
  }
  const record = latestStage27QuestRecords().get(questId);
  if (!record) throw blocked(`${questId} has no fresh Q27 evidence in this task's JSONL.`);
  if (record.status === 'FAIL') throw new Error(`${questId} latest recorded result is FAIL: ${record.error || record.reason || 'see Q27 evidence JSONL'}`);
  if (record.status === 'BLOCKED') throw blocked(`${questId} latest recorded result is BLOCKED: ${record.reason || record.error || 'see Q27 evidence JSONL'}`);
  if (record.status !== 'PASS') throw blocked(`${questId} has an unrecognized recorded status: ${record.status}`);
  if (questId === 'Q27.9' && record.parsedCount !== 109) throw new Error('Q27.9 RTM evidence is not a complete 109-item mapping.');
  if (questId === 'Q27.9') {
    const aggregate = await writeStageAggregate();
    if (aggregate.counts.FAIL || aggregate.counts.MISSING) throw new Error(`Stage27 aggregate is ${aggregate.overall}: ${JSON.stringify(aggregate.counts)}`);
    if (aggregate.counts.BLOCKED) throw blocked(`Stage27 aggregate is BLOCKED: ${JSON.stringify(aggregate.counts)}`);
    return { output: [`Aggregated Q27.1–Q27.9: ${aggregate.overall}; ${JSON.stringify(aggregate.counts)}.`,
      `Fresh same-task evidence: ${path.relative(projectRoot, evidencePath)}; aggregate: ${path.relative(projectRoot, aggregatePath)}.`] };
  }
  return { output: [`Aggregated fresh Q27 evidence: ${record.status}.`,
    `Evidence source: ${path.relative(projectRoot, evidencePath)}; no test, browser, install, or provider run was repeated.`] };
}

async function writeStageAggregate() {
  const latest = latestStage27QuestRecords();
  const quests = Array.from({ length: 9 }, (_, index) => {
    const id = `Q27.${index + 1}`; const record = latest.get(id);
    return { quest: id, status: record?.status || 'MISSING', evidenceOrigin: record?.evidenceOrigin || 'worker_self_validation',
      sourceTaskId: record?.sourceTaskId || null, sourceProofPath: record?.sourceProofPath || null,
      sourceProofBytes: record?.sourceProofBytes || null, sourceProofSha256: record?.sourceProofSha256 || null,
      acceptanceExecutor: record?.acceptanceExecutor || null,
      verifiedR4EnvironmentProof: record?.verifiedR4EnvironmentProof || null,
      runId: record?.runId || null, recordedAt: record?.at || null,
      command: record?.actualSourceCommand || record?.actualCommand || null,
      exitCode: record?.actualSourceExitCode ?? record?.exitCode ?? null,
      actualEvidencePath: record?.actualEvidencePath || record?.evidencePath || null,
      actualEvidenceBytes: record?.actualEvidenceBytes || null,
      actualEvidenceSha256: record?.actualEvidenceSha256 || null,
      commandEvidencePath: record?.commandEvidencePath || null,
      commandEvidenceBytes: record?.commandEvidenceBytes || null,
      commandEvidenceSha256: record?.commandEvidenceSha256 || null,
      sourceAcceptance: record?.evidenceOrigin === 'source_independent_acceptance' ? {
        taskId: record.sourceTaskId, runId: record.runId,
        command: record.actualSourceCommand || null, exitCode: record.actualSourceExitCode ?? null,
        proofPath: record.sourceProofPath || null, proofBytes: record.sourceProofBytes || null,
        proofSha256: record.sourceProofSha256 || null,
        evidencePath: record.actualEvidencePath || record.evidencePath || null,
        evidenceBytes: record.actualEvidenceBytes || null,
        evidenceSha256: record.actualEvidenceSha256 || null,
        commandEvidencePath: record.commandEvidencePath || null,
        commandEvidenceBytes: record.commandEvidenceBytes || null,
        commandEvidenceSha256: record.commandEvidenceSha256 || null
      } : null,
      workerObservation: record?.workerObservation || null,
      sourceObservation: record?.sourceObservation || null,
      evidencePath: record?.actualEvidencePath || record?.evidencePath || record?.sourceProofPath
        || path.relative(projectRoot, evidencePath),
      error: record?.evidenceOrigin === 'source_independent_acceptance' && record?.status === 'PASS'
        ? null : record?.error || null,
      reason: record?.evidenceOrigin === 'source_independent_acceptance' && record?.status === 'PASS'
        ? null : record?.reason || null };
  });
  const counts = Object.fromEntries(['PASS', 'BLOCKED', 'FAIL', 'MISSING'].map(status => [status, quests.filter(item => item.status === status).length]));
  const rtmRecord = latest.get('Q27.9');
  const rtmSummaryFile = rtmRecord?.summaryPath ? path.resolve(projectRoot, rtmRecord.summaryPath) : null;
  const rtm = rtmSummaryFile && fs.existsSync(rtmSummaryFile) ? readJsonUnderLimit(rtmSummaryFile, 16 * 1024 * 1024) : null;
  const workerQ278 = latest.get('Q27.8');
  const base68Prior = { CURRENT_PASS: 64, CURRENT_PARTIAL: 2, R5_PENDING: 2 };
  let q278 = workerQ278?.q8 ? { q8: workerQ278.q8 } : null;
  if (workerQ278?.evidencePath) {
    const candidate = path.resolve(projectRoot, workerQ278.evidencePath);
    if (fs.existsSync(candidate)) q278 = readJsonUnderLimit(candidate, 8 * 1024 * 1024);
  }
  const receiptExit = value => value?.receipt?.exitCode ?? value?.receipt?.receipt?.exitCode ?? null;
  const cleanInstallPassed = receiptExit(q278?.install) === 0;
  const buildPassed = receiptExit(q278?.build) === 0 && q278?.build?.outputExists === true;
  const testsPassed = receiptExit(q278?.automatedTests) === 0 && q278?.automatedTests?.zeroFailures === true;
  const devPassed = q278?.dev?.health?.status === 200 && q278?.dev?.health?.body?.ok === true
    && Array.isArray(q278?.dev?.demoAccounts) && q278.dev.demoAccounts.length === 3
    && q278.dev.demoAccounts.every(account => account.httpStatus === 200 && account.tokenPresent);
  const previewPassed = q278?.preview?.apiHealth?.status === 200 && q278?.preview?.apiHealth?.body?.ok === true;
  const browserPassed = q278?.browser?.status === 'PASS';
  const base68Q8 = {
    'Q8.5': devPassed ? 'PASS' : cleanInstallPassed ? 'PARTIAL' : 'R5_PENDING',
    'Q8.6': testsPassed ? 'PASS' : receiptExit(q278?.automatedTests) === null ? 'CURRENT_PARTIAL' : 'FAIL',
    'Q8.7': previewPassed && browserPassed ? 'PASS' : buildPassed ? 'PARTIAL' : 'CURRENT_PARTIAL',
    'Q8.8': browserPassed ? 'PASS' : q278?.browser?.status === 'FAIL' ? 'FAIL' : 'R5_PENDING'
  };
  const q8Passes = Object.values(base68Q8).filter(status => status === 'PASS').length;
  const q8Partials = Object.values(base68Q8).filter(status => status === 'PARTIAL' || status === 'CURRENT_PARTIAL').length;
  const q8Pending = Object.values(base68Q8).filter(status => status === 'R5_PENDING').length;
  const q8Failures = Object.values(base68Q8).filter(status => status === 'FAIL').length;
  const base68 = { previousSourceR2States: base68Prior, q8R5States: base68Q8,
    currentCounts: { CURRENT_PASS: base68Prior.CURRENT_PASS + q8Passes,
      CURRENT_PARTIAL: q8Partials,
      R5_PENDING: q8Pending, CURRENT_FAIL: q8Failures },
    evidenceOrigin: 'prior source R2 handoff plus source-accepted Q27.8 clean install, tests, dev, preview, and browser evidence' };
  const allNineRecorded = counts.PASS === 9;
  const functionalCounts = rtm?.functionalAcceptanceCounts || null;
  const overall = counts.FAIL ? 'FAIL' : counts.BLOCKED || counts.MISSING ? 'BLOCKED'
    : allNineRecorded && rtm?.idsComplete && functionalCounts
      && functionalCounts.UNVERIFIED === 0 && functionalCounts.EXTERNAL_BLOCK === 0
      ? 'PASS' : allNineRecorded && rtm?.idsComplete ? 'NOT_FINAL_ACCEPTED' : 'BLOCKED';
  const aggregate = { at: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    executorIdentity: stage27R5ExecutorIdentity(), scope: 'Q27.1–Q27.9',
    runId: invocationRunId, mode: 'combine source-independent R1–R4 proof and this task R5 records without rerunning Q27.1–Q27.8',
    quests, counts, base68, rtmSummaryPath: rtmSummaryFile ? path.relative(projectRoot, rtmSummaryFile) : null,
    rtmMapping: rtm ? { idsComplete: rtm.idsComplete, parsedCount: rtm.parsedCount,
      mappingStatusCounts: rtm.mappingStatusCounts, functionalAcceptanceCounts: rtm.functionalAcceptanceCounts,
      unresolvedEvidenceCodeCount: rtm.unresolvedUniqueEvidenceCodes?.length ?? null } : null,
    stage27Overall: overall, overall };
  fs.writeFileSync(aggregatePath, `${JSON.stringify(aggregate, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return aggregate;
}

export async function run({ questId, stage, live, liveConfig, liveEnvironment, resourceSession }) {
  if (!resourceSession) throw new Error(`${questId} requires a Stage27 ResourceSession`);
  if (stage === 27) return await summarizeStageQuest(questId);
  if (questId === 'Q27.1' && process.env.CODEX_STAGE27_SCOPE === 'R2' && process.env.CODEX_TASK_ID) {
    return await runStage27R2QuestMap({ resourceSession });
  }
  if (questId === 'Q27.1') return await runQ271({ resourceSession });
  if (questId === 'Q27.2') return await runQ272({ resourceSession });
  if (questId === 'Q27.3' || questId === 'Q27.4') return await runQ273AndQ274({ resourceSession });
  if (questId === 'Q27.5') return await runQ275({ resourceSession, live, liveConfig });
  if (questId === 'Q27.6') return await runQ276({ resourceSession, live, liveEnvironment });
  if (questId === 'Q27.7') {
    try { return await runQ277({ resourceSession }); }
    catch (error) { recordQuest('Q27.7', error?.stageBlocked ? 'BLOCKED' : 'FAIL', { error: String(error.message || error).slice(0, 1200) }); throw error; }
  }
  if (questId === 'Q27.8') {
    try { return await runQ278({ resourceSession }); }
    catch (error) { recordQuest('Q27.8', error?.stageBlocked ? 'BLOCKED' : 'FAIL', { error: String(error.message || error).slice(0, 1200) }); throw error; }
  }
  if (questId === 'Q27.9' && process.env.CODEX_STAGE27_SCOPE === 'R2' && process.env.CODEX_TASK_ID) {
    return await runStage27R2Rtm();
  }
  if (questId === 'Q27.9') return await runQ279();
  if (questId === 'Q27.aggregate') {
    const aggregate = await writeStageAggregate();
    if (aggregate.counts.FAIL || aggregate.counts.MISSING) throw new Error(`Stage27 aggregate is ${aggregate.overall}: ${JSON.stringify(aggregate.counts)}`);
    if (aggregate.counts.BLOCKED) throw blocked(`Stage27 aggregate is BLOCKED: ${JSON.stringify(aggregate.counts)}`);
    return { output: [`Stage27 aggregate ${aggregate.overall}: ${JSON.stringify(aggregate.counts)}.`] };
  }
  throw blocked(`${questId || `Stage${stage || 27}`} is not yet eligible to pass because its required evidence has not been executed.`);
}
