// Runtime-only environment accounting. The frozen scripts/resources implementation stays
// independent; synthetic compatibility tests lock the shared JSONL contract (G04).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ENVIRONMENT_PROVIDER_LIMITS = Object.freeze({ requests: 6, requestTimeoutMs: 15_000 });
const EMPTY_HASH = crypto.createHash('sha256').digest('hex');

function fail(message, code = 'R4_BUDGET_UNKNOWN') {
  return Object.assign(new Error(message), { code, stageBlocked: true });
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

function validateBinding({ taskId, baselineUsed, limit }) {
  if (typeof taskId !== 'string' || !taskId.trim()
    || !Number.isSafeInteger(baselineUsed) || baselineUsed < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > ENVIRONMENT_PROVIDER_LIMITS.requests
    || baselineUsed > limit) {
    throw fail('Environment budget requires a task ID, a nonnegative integer baseline and a limit within the six-request cap.',
      'R4_ENV_BUDGET_BINDING');
  }
}

function inspectEnvironmentBudget({ rows, taskId, baselineUsed, limit }) {
  validateBinding({ taskId, baselineUsed, limit });
  const first = rows?.[0];
  if (!Array.isArray(rows) || !first || first.event !== 'environment-budget-baseline-reconciled'
    || first.taskId !== taskId || first.baselineUsed !== baselineUsed || first.limit !== limit) {
    throw fail('Q27.6 environment account does not match this executor baseline and limit.');
  }
  let used = baselineUsed;
  const open = new Set();
  const seen = new Set();
  for (const row of rows) {
    if (row.recordType !== 'stage27-r4-environment-budget-event' || row.taskId !== taskId) {
      throw fail('Q27.6 environment account contains an unexpected record type or executor ID.');
    }
  }
  for (const row of rows.slice(1)) {
    if (row.event === 'environment-provider-request-reserved') {
      if (typeof row.attemptId !== 'string' || !row.attemptId || seen.has(row.attemptId)
        || row.usedBefore !== used || open.size || used >= limit) {
        throw fail('Q27.6 provider reservation is malformed or exceeds its cumulative limit.');
      }
      used += 1;
      seen.add(row.attemptId);
      open.add(row.attemptId);
    } else if (row.event === 'environment-provider-request-finished') {
      if (!open.delete(row.attemptId) || !['success', 'failed'].includes(row.outcome)) {
        throw fail('Q27.6 provider completion does not match a reserved request.');
      }
    } else {
      throw fail(`Q27.6 contains an unknown provider accounting event (${String(row.event || 'missing')}).`);
    }
  }
  return { used, remaining: limit - used, open };
}

export function reconcileEnvironmentBudget({ rows, taskId, baselineUsed, limit = ENVIRONMENT_PROVIDER_LIMITS.requests }) {
  const { used, remaining, open } = inspectEnvironmentBudget({ rows, taskId, baselineUsed, limit });
  if (open.size) throw fail('Q27.6 has an in-flight provider request; further requests are blocked.');
  return { used, remaining };
}

function withAccountLock(filePath, taskId, action) {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let descriptor;
  try { descriptor = fs.openSync(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') {
      // Neither mtime nor a PID alone proves an exact owner identity has exited.
      // All pre-existing locks remain untouched, including apparently old ones.
      throw fail('Q27.6 environment budget lock exists; owner identity is unverified. No automatic stale-lock recovery.',
        'R4_ENV_BUDGET_BUSY');
    }
    throw error;
  }
  const owned = fs.fstatSync(descriptor);
  try {
    fs.writeSync(descriptor, `${JSON.stringify({ taskId, at: new Date().toISOString(), pid: process.pid })}\n`);
    fs.fsyncSync(descriptor);
    return action();
  } finally {
    fs.closeSync(descriptor);
    const current = fs.lstatSync(lockPath);
    if (current.dev !== owned.dev || current.ino !== owned.ino) {
      throw fail('Environment budget lock identity changed; replacement lock was preserved.', 'R4_ENV_BUDGET_LOCK_CHANGED');
    }
    fs.unlinkSync(lockPath);
  }
}

export async function reserveEnvironmentProviderRequest({ filePath, taskId, baselineUsed, provider,
  limit = ENVIRONMENT_PROVIDER_LIMITS.requests }) {
  // Preserve the ordinary unconfigured path: no mkdir, lock, read or journal write.
  // A configured path without a valid caller must never silently disable accounting.
  if (!filePath) return null;
  validateBinding({ taskId, baselineUsed, limit });
  return withAccountLock(filePath, taskId, () => {
    let rows = readHashedBudgetJsonl(filePath);
    if (!rows.length) {
      // Existing empty files are ambiguous (including truncation); never reset one.
      if (fs.existsSync(filePath)) throw fail('Existing environment account is empty; refusing to reset its usage.');
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
        // Serialize completion too; a competing reservation can never race a journal append.
        return withAccountLock(filePath, taskId, () => {
          const state = inspectEnvironmentBudget({ rows: readHashedBudgetJsonl(filePath), taskId, baselineUsed, limit });
          if (state.open.size !== 1 || !state.open.has(attemptId)) {
            throw fail('Environment provider completion has no matching in-flight reservation.');
          }
          return appendHashedBudgetEvent(filePath, { recordType: 'stage27-r4-environment-budget-event', taskId,
            event: 'environment-provider-request-finished', attemptId,
            outcome: ['success', 'failed'].includes(outcome) ? outcome : 'failed', at: new Date().toISOString() });
        });
      } };
  });
}
