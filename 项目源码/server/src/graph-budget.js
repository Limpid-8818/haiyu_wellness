import { performance } from 'node:perf_hooks';

export function estimateGraphInput(messages, tools = [], toolChoice = 'auto', responseFormat = null) {
  const request = { messages, tools, toolChoice };
  if (responseFormat) request.responseFormat = responseFormat;
  const bytes = Buffer.byteLength(JSON.stringify(request), 'utf8');
  return { messageBytes: bytes, estimatedInputTokens: Math.ceil(bytes / 3) };
}

// Keep a small safety margin for provider-side framing and tokenizer variance.
// The post-response check still settles against reported usage when available.
export function estimateGraphInputWithSafetyMargin(messages, tools = [], toolChoice = 'auto', responseFormat = null) {
  const estimate = estimateGraphInput(messages, tools, toolChoice, responseFormat);
  const safetyMarginTokens = Math.max(64, Math.ceil(estimate.estimatedInputTokens * 0.15));
  return { ...estimate, rawEstimatedInputTokens: estimate.estimatedInputTokens,
    safetyMarginTokens, estimatedInputTokens: estimate.estimatedInputTokens + safetyMarginTokens };
}

export function graphBudgetRemaining(budget) {
  const consumedTokens = budget.inputTokens + budget.outputTokens;
  return {
    consumedTokens,
    consumedCostUsd: budget.estimatedCostUsd,
    tokens: budget.maxTokens - consumedTokens - budget.reservedTokens,
    costUsd: budget.maxCost - budget.estimatedCostUsd - budget.reservedCostUsd
  };
}

export function releaseGraphCostReservation(current, amount) {
  const remaining = Math.max(0, current - amount);
  const roundingTolerance = Number.EPSILON * Math.max(1, Math.abs(current), Math.abs(amount)) * 8;
  return remaining <= roundingTolerance ? 0 : remaining;
}

export function decideGraphModelReservation({ budget, estimatedInputTokens, requestedOutputTokens, rates,
  nowMs = performance.now(), signalAborted = false }) {
  const remainingBefore = graphBudgetRemaining(budget);
  const inputCostUsd = estimatedInputTokens * rates.input / 1_000_000;
  const tokensAfterInput = remainingBefore.tokens - estimatedInputTokens;
  const costAfterInput = remainingBefore.costUsd - inputCostUsd;
  const outputAffordableByCost = Math.floor(Math.max(0, costAfterInput) * 1_000_000 / rates.output);
  let rejectionCode = null;

  if (signalAborted || nowMs >= budget.deadlineAt) rejectionCode = 'GRAPH_RUNTIME_BUDGET';
  else if (budget.modelCalls >= budget.maxModelCalls) rejectionCode = 'GRAPH_MODEL_CALL_BUDGET';
  else if (remainingBefore.tokens < 1 || tokensAfterInput < 1) rejectionCode = 'GRAPH_TOKEN_BUDGET';
  else if (remainingBefore.costUsd <= 0 || costAfterInput <= 0 || outputAffordableByCost < 1) rejectionCode = 'GRAPH_COST_BUDGET';

  const maxOutputTokens = rejectionCode ? 0 : Math.min(
    requestedOutputTokens,
    tokensAfterInput,
    outputAffordableByCost
  );
  if (!rejectionCode && maxOutputTokens < 1) {
    rejectionCode = tokensAfterInput < 1 ? 'GRAPH_TOKEN_BUDGET' : 'GRAPH_COST_BUDGET';
  }
  if (rejectionCode) {
    return {
      allowed: false,
      rejectionCode,
      maxOutputTokens: 0,
      reservation: null,
      remainingBefore,
      remainingAfterInput: { tokens: tokensAfterInput, costUsd: costAfterInput }
    };
  }

  const reservation = {
    tokens: estimatedInputTokens + maxOutputTokens,
    costUsd: inputCostUsd + maxOutputTokens * rates.output / 1_000_000
  };
  return {
    allowed: true,
    rejectionCode: null,
    maxOutputTokens,
    reservation,
    remainingBefore,
    remainingAfterInput: { tokens: tokensAfterInput, costUsd: costAfterInput },
    remainingAfterReservation: {
      tokens: tokensAfterInput - maxOutputTokens,
      costUsd: costAfterInput - maxOutputTokens * rates.output / 1_000_000
    }
  };
}

export function decideOrdinaryModelReservation({ budget, estimatedInputTokens, requestedOutputTokens, rates,
  usageKnown = true, nowMs = performance.now(), signalAborted = false }) {
  if (!usageKnown) {
    return { allowed: false, rejectionCode: 'GRAPH_USAGE_UNKNOWN', maxOutputTokens: 0, reservation: null,
      remainingBefore: graphBudgetRemaining(budget),
      remainingAfterInput: { tokens: null, costUsd: null } };
  }
  return decideGraphModelReservation({ budget, estimatedInputTokens, requestedOutputTokens, rates,
    nowMs, signalAborted });
}

export function hasUnknownAttemptUsage(steps) {
  const known = value => value !== null && value !== undefined && value !== ''
    && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
  return steps.some(step => step.providerRequestAttempted === true
    && (step.usageReported === false || !known(step.inputTokens) || !known(step.outputTokens)));
}
