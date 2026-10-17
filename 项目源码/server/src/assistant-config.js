// G47：助手共享配置与微助手模块，自 assistant.js 纯搬运；行为不变。
import { performance } from 'node:perf_hooks';
import { now } from './db.js';

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
export const TOOL_TIMEOUT_MS = positiveEnvNumber('ASSISTANT_TOOL_TIMEOUT_MS', 15_000, 15_000);
export const MAX_RUN_MS = positiveEnvNumber('ASSISTANT_MAX_RUNTIME_MS', 90_000, 300_000);
export const MAX_MODEL_CALLS = positiveEnvNumber('ASSISTANT_MAX_MODEL_CALLS', 50, 100);
export const MAX_TOOL_ROUNDS = positiveEnvNumber('ASSISTANT_MAX_TOOL_ROUNDS', 4, 20);
export const MAX_TOOL_CALLS = positiveEnvNumber('ASSISTANT_MAX_TOOL_CALLS', 12, 100);
export const MAX_RUN_TOKENS = positiveEnvNumber('ASSISTANT_MAX_TOKENS', 16_384, 256_000);
export const MAX_RUN_COST_USD = positiveEnvNumber('ASSISTANT_MAX_ESTIMATED_COST_USD', 0.10, 10);
// DeepSeek's published peak cache-miss/output rates are used as an upper-bound
// estimate. The provider rates page is intentionally centralized and replaceable:
// https://api-docs.deepseek.com/quick_start/pricing/
export const MODEL_RATE_TABLE = Object.freeze({
  'deepseek-flash': Object.freeze({ input: 0.30, output: 1.20 }),
  'deepseek-v4-pro': Object.freeze({ input: 1.32, output: 3.96 }),
  default: Object.freeze({ input: 0.30, output: 1.20 })
});

export function positiveEnvNumber(name, fallback, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

export function measuredDurationMs(startedAt, endedAt = performance.now()) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return null;
  return Math.max(1, Math.ceil(endedAt - startedAt));
}

export function finiteDurationMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const duration = Number(value);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function safeProviderResponseId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : null;
}

export const modelTimeoutMs = positiveEnvNumber('LLM_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 60_000);
export const sessionTtlMs = positiveEnvNumber('ASSISTANT_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);

export function q19AcceptanceHooksEnabled() {
  return process.env.NODE_ENV === 'test' && process.env.Q19_ACCEPTANCE_HOOKS === '1';
}

export function modelRates(model) {
  const name = String(model || '').toLowerCase();
  const configured = MODEL_RATE_TABLE[name] || MODEL_RATE_TABLE.default;
  return {
    input: positiveEnvNumber('ASSISTANT_INPUT_USD_PER_MILLION_TOKENS', configured.input, 100),
    output: positiveEnvNumber('ASSISTANT_OUTPUT_USD_PER_MILLION_TOKENS', configured.output, 100)
  };
}

export function endpointConfigured() {
  return Boolean(String(process.env.LLM_BASE_URL || '').trim() && String(process.env.LLM_API_KEY || '').trim());
}

export function assistantExecutionMode() {
  if (process.env.ASSISTANT_MODEL_SOURCE === 'recorded_fixture') return 'recorded_fixture';
  if (endpointConfigured()) return 'live';
  return 'fallback';
}

export function estimatedModelCost(inputTokens, outputTokens, model) {
  const rates = modelRates(model);
  return inputTokens * rates.input / 1_000_000 + outputTokens * rates.output / 1_000_000;
}

export function approximateTokens(messages) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 4);
}
