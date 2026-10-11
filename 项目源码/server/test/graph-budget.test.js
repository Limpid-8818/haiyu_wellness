import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { decideGraphModelReservation, decideOrdinaryModelReservation, estimateGraphInput,
  estimateGraphInputWithSafetyMargin, hasUnknownAttemptUsage, releaseGraphCostReservation } from '../src/graph-budget.js';

function budget(overrides = {}) {
  return {
    deadlineAt: performance.now() + 90_000,
    maxModelCalls: 5,
    maxTokens: 8_192,
    maxCost: 0.10,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    reservedTokens: 0,
    reservedCostUsd: 0,
    ...overrides
  };
}

const rates = { input: 0.30, output: 1.20 };

test('graph input estimate counts serialized messages and tool schemas without reducing the byte coefficient', () => {
  const messages = [{ role: 'user', content: '三餐' }];
  const tools = [{ type: 'function', function: { name: 'get_nutrition_context', parameters: { type: 'object' } } }];
  const payloadBytes = Buffer.byteLength(JSON.stringify({ messages, tools, toolChoice: 'required' }), 'utf8');
  assert.deepEqual(estimateGraphInput(messages, tools, 'required'), {
    messageBytes: payloadBytes,
    estimatedInputTokens: Math.ceil(payloadBytes / 3)
  });
});

test('graph input estimate includes structured-output request options', () => {
  const messages = [{ role: 'user', content: '选择候选' }];
  const responseFormat = { type: 'json_object' };
  const payloadBytes = Buffer.byteLength(JSON.stringify({ messages, tools: [], toolChoice: 'auto', responseFormat }), 'utf8');
  assert.deepEqual(estimateGraphInput(messages, [], 'auto', responseFormat), {
    messageBytes: payloadBytes,
    estimatedInputTokens: Math.ceil(payloadBytes / 3)
  });
});

test('a reservation refusal records token pressure and a released in-flight reservation restores headroom', () => {
  const shared = budget({ maxTokens: 1_000 });
  const first = decideGraphModelReservation({ budget: shared, estimatedInputTokens: 300,
    requestedOutputTokens: 512, rates });
  assert.equal(first.allowed, true);
  shared.modelCalls += 1;
  shared.reservedTokens += first.reservation.tokens;
  shared.reservedCostUsd += first.reservation.costUsd;

  const blocked = decideGraphModelReservation({ budget: shared, estimatedInputTokens: 300,
    requestedOutputTokens: 512, rates });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.rejectionCode, 'GRAPH_TOKEN_BUDGET');
  assert.equal(blocked.remainingBefore.tokens, 188);
  assert.equal(blocked.remainingAfterInput.tokens, -112);

  shared.reservedTokens -= first.reservation.tokens;
  shared.reservedCostUsd -= first.reservation.costUsd;
  shared.inputTokens = 180;
  shared.outputTokens = 50;
  const afterRelease = decideGraphModelReservation({ budget: shared, estimatedInputTokens: 300,
    requestedOutputTokens: 512, rates });
  assert.equal(afterRelease.allowed, true);
  assert.equal(afterRelease.maxOutputTokens, 470);
  assert.equal(afterRelease.reservation.tokens, 770);
});

test('the unchanged graph limits still reject requests blocked by estimated cost or runtime', () => {
  const costBlocked = decideGraphModelReservation({ budget: budget({ maxCost: 0.000006 }),
    estimatedInputTokens: 20, requestedOutputTokens: 512, rates });
  assert.equal(costBlocked.allowed, false);
  assert.equal(costBlocked.rejectionCode, 'GRAPH_COST_BUDGET');

  const timeBlocked = decideGraphModelReservation({ budget: budget({ deadlineAt: performance.now() - 1 }),
    estimatedInputTokens: 20, requestedOutputTokens: 512, rates });
  assert.equal(timeBlocked.allowed, false);
  assert.equal(timeBlocked.rejectionCode, 'GRAPH_RUNTIME_BUDGET');
});

test('ordinary preflight rejects a 2992-token input before provider admission when only 1717 remain', () => {
  const shared = budget({ inputTokens: 5_500, outputTokens: 975 });
  const result = decideOrdinaryModelReservation({ budget: shared, estimatedInputTokens: 2_992,
    requestedOutputTokens: 768, rates });
  assert.equal(result.remainingBefore.tokens, 1_717);
  assert.equal(result.allowed, false);
  assert.equal(result.rejectionCode, 'GRAPH_TOKEN_BUDGET');
  assert.equal(result.reservation, null);
});

test('ordinary preflight caps proposed output to the remaining token reservation', () => {
  const result = decideOrdinaryModelReservation({ budget: budget({ inputTokens: 100, maxTokens: 1_000 }),
    estimatedInputTokens: 300, requestedOutputTokens: 768, rates });
  assert.equal(result.allowed, true);
  assert.equal(result.maxOutputTokens, 600);
  assert.equal(result.reservation.tokens, 900);
});

test('ordinary preflight blocks unknown prior usage, exhausted request count, cost, and runtime', () => {
  const unknown = decideOrdinaryModelReservation({ budget: budget(), estimatedInputTokens: 20,
    requestedOutputTokens: 100, rates, usageKnown: false });
  assert.equal(unknown.rejectionCode, 'GRAPH_USAGE_UNKNOWN');
  assert.equal(hasUnknownAttemptUsage([{ providerRequestAttempted: true, inputTokens: 10, outputTokens: null }]), true);
  assert.equal(hasUnknownAttemptUsage([{ providerRequestAttempted: true, usageReported: false,
    inputTokens: 0, outputTokens: 0 }]), true, 'default database zeroes do not erase an explicit missing-usage diagnosis');
  assert.equal(hasUnknownAttemptUsage([{ providerRequestAttempted: false, inputTokens: null, outputTokens: null }]), false);

  const calls = decideOrdinaryModelReservation({ budget: budget({ modelCalls: 5 }), estimatedInputTokens: 20,
    requestedOutputTokens: 100, rates });
  assert.equal(calls.rejectionCode, 'GRAPH_MODEL_CALL_BUDGET');
  const cost = decideOrdinaryModelReservation({ budget: budget({ estimatedCostUsd: 0.10 }), estimatedInputTokens: 20,
    requestedOutputTokens: 100, rates });
  assert.equal(cost.rejectionCode, 'GRAPH_COST_BUDGET');
  const runtime = decideOrdinaryModelReservation({ budget: budget({ deadlineAt: performance.now() - 1 }),
    estimatedInputTokens: 20, requestedOutputTokens: 100, rates });
  assert.equal(runtime.rejectionCode, 'GRAPH_RUNTIME_BUDGET');
});

test('ordinary input estimate records the raw estimate and an explicit safety margin', () => {
  const messages = [{ role: 'user', content: 'ordinary input' }];
  const raw = estimateGraphInput(messages);
  const guarded = estimateGraphInputWithSafetyMargin(messages);
  assert.equal(guarded.rawEstimatedInputTokens, raw.estimatedInputTokens);
  assert.equal(guarded.safetyMarginTokens, Math.max(64, Math.ceil(raw.estimatedInputTokens * 0.15)));
  assert.equal(guarded.estimatedInputTokens, raw.estimatedInputTokens + guarded.safetyMarginTokens);
});

test('releasing the last fractional cost reservation clamps floating-point residue to zero', () => {
  const first = 0.000801;
  const second = 0.0008058;
  const total = first + second;
  assert.ok(Math.abs(releaseGraphCostReservation(total, first) - second) < 1e-15);
  assert.equal(releaseGraphCostReservation(releaseGraphCostReservation(total, first), second), 0);
});
