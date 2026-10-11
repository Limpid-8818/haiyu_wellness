import { recordProviderFailure, recordProviderSuccess } from './stage26-operations.js';

export class ModelRequestError extends Error {
  constructor(code, message = '模型请求失败', diagnostic = null) {
    super(message);
    this.name = 'ModelRequestError';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

export function modelEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!base) return '';
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

function isDeepSeekEndpoint(url) {
  try { return new URL(url).hostname === 'api.deepseek.com' || new URL(url).hostname.endsWith('.api.deepseek.com'); }
  catch { return false; }
}

function isNamedToolChoice(toolChoice) {
  return Boolean(toolChoice && typeof toolChoice === 'object'
    && toolChoice.type === 'function' && typeof toolChoice.function?.name === 'string'
    && toolChoice.function.name.length > 0);
}

function isForcedToolChoice(toolChoice) {
  return toolChoice === 'required' || isNamedToolChoice(toolChoice);
}

function previousToolRoundThinkingMode(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const toolCalls = message?.toolCalls ?? message?.tool_calls;
    if (message?.role !== 'assistant' || !Array.isArray(toolCalls) || toolCalls.length === 0) continue;
    if (message.thinkingMode === 'enabled' || message.thinkingMode === 'disabled') return message.thinkingMode;
    return typeof message.reasoningContent === 'string' || typeof message.reasoning_content === 'string'
      ? 'enabled' : 'disabled';
  }
  return null;
}

export function resolveDeepSeekThinkingMode({ messages = [], toolChoice = 'auto', thinkingMode } = {}) {
  const forcedChoice = isForcedToolChoice(toolChoice);
  const previousMode = previousToolRoundThinkingMode(messages);
  const selectedMode = thinkingMode || previousMode || (forcedChoice ? 'disabled' : 'enabled');
  if (!['enabled', 'disabled'].includes(selectedMode)) throw new ModelRequestError('MODEL_THINKING_MODE_INVALID');
  if (forcedChoice && selectedMode === 'enabled') {
    throw new ModelRequestError('MODEL_DEEPSEEK_TOOL_CHOICE_CONFLICT');
  }
  return selectedMode;
}

export function toProviderMessages(messages, deepSeek = false) {
  const providerMessages = messages.map(message => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === 'assistant') {
      const assistant = { role: 'assistant', content: message.content ?? null };
      if (Array.isArray(message.toolCalls) && message.toolCalls.length) {
        assistant.tool_calls = message.toolCalls.map(call => ({
          id: call.id, type: 'function',
          function: { name: call.name, arguments: call.arguments }
        }));
      }
      const hasEnabledReasoning = message.thinkingMode === 'enabled'
        || (!Object.hasOwn(message, 'thinkingMode') && typeof message.reasoningContent === 'string');
      if (deepSeek && hasEnabledReasoning && typeof message.reasoningContent === 'string') {
        assistant.reasoning_content = message.reasoningContent;
      }
      return assistant;
    }
    return { role: message.role, content: message.content };
  });
  validateProviderToolHistory(providerMessages);
  return providerMessages;
}

function validateProviderToolHistory(messages) {
  let outstanding = new Set();
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      if (outstanding.size) throw new ModelRequestError('MODEL_CONVERSATION_INVALID');
      const ids = message.tool_calls.map(call => call.id);
      if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
        throw new ModelRequestError('MODEL_CONVERSATION_INVALID');
      }
      outstanding = new Set(ids);
      continue;
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !outstanding.has(message.tool_call_id)) {
        throw new ModelRequestError('MODEL_CONVERSATION_INVALID');
      }
      outstanding.delete(message.tool_call_id);
      continue;
    }
    if (outstanding.size) throw new ModelRequestError('MODEL_CONVERSATION_INVALID');
  }
  if (outstanding.size) throw new ModelRequestError('MODEL_CONVERSATION_INVALID');
}

export function buildChatCompletionPayload({ messages, tools = [], toolChoice = 'auto', model, maxTokens = 768,
  deepSeek = false, thinkingMode, responseFormat = null }) {
  const payload = {
    model, messages: toProviderMessages(messages, deepSeek),
    temperature: 0.2, max_tokens: maxTokens
  };
  if (tools.length) {
    payload.tools = tools;
    payload.tool_choice = toolChoice;
  }
  if (responseFormat) payload.response_format = responseFormat;
  if (deepSeek) payload.thinking = { type: resolveDeepSeekThinkingMode({ messages, toolChoice, thinkingMode }) };
  return payload;
}

function normalizeReportedTokenCount(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const count = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export function normalizeChatCompletion(data) {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  if (!message || message.role !== 'assistant') throw new ModelRequestError('MODEL_RESPONSE_INVALID');
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls.map(call => ({
    id: typeof call?.id === 'string' ? call.id : '',
    name: typeof call?.function?.name === 'string' ? call.function.name : '',
    arguments: typeof call?.function?.arguments === 'string' ? call.function.arguments : ''
  })) : [];
  const inputTokens = normalizeReportedTokenCount(data?.usage?.prompt_tokens);
  const outputTokens = normalizeReportedTokenCount(data?.usage?.completion_tokens);
  const totalTokens = normalizeReportedTokenCount(data?.usage?.total_tokens);
  return {
    id: typeof data.id === 'string' ? data.id : '',
    model: typeof data.model === 'string' ? data.model : '',
    message: {
      role: 'assistant',
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls,
      reasoningContent: typeof message.reasoning_content === 'string' ? message.reasoning_content : null
    },
    usage: {
      inputTokens,
      outputTokens,
      totalTokens
    },
    usageReported: inputTokens !== null && outputTokens !== null,
    usageFieldsReported: { inputTokens: inputTokens !== null, outputTokens: outputTokens !== null,
      totalTokens: totalTokens !== null },
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : ''
  };
}

export function toConversationMessage(message) {
  return {
    role: 'assistant', content: message.content,
    toolCalls: message.toolCalls,
    reasoningContent: message.reasoningContent ?? null,
    thinkingMode: message.thinkingMode ?? (typeof message.reasoningContent === 'string' ? 'enabled' : null)
  };
}

function safeDiagnosticIdentifier(value, maximumLength = 96) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /^(?:bearer|sk[-_]|api[-_]?key)/i.test(normalized)) return null;
  return /^[A-Za-z0-9_.:-]+$/.test(normalized) ? normalized : null;
}

function safeMessageId(value) {
  if (typeof value !== 'string' || !value) return null;
  return /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : '[redacted]';
}

function safeToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') return ['none', 'auto', 'required'].includes(toolChoice) ? toolChoice : 'other';
  if (isNamedToolChoice(toolChoice)) return { type: 'function', function: { name: safeDiagnosticIdentifier(toolChoice.function.name, 128) || '[redacted]' } };
  return toolChoice === undefined || toolChoice === null ? null : 'other';
}

function safeRequestMetadata({ url, payload, provider }) {
  let endpoint = null;
  try {
    const parsed = new URL(url);
    const pathname = /^[A-Za-z0-9/_-]{1,192}$/.test(parsed.pathname) ? parsed.pathname : '[redacted-path]';
    endpoint = `${parsed.host}${pathname}`;
  } catch { endpoint = '[invalid-endpoint]'; }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  return {
    provider,
    model: safeDiagnosticIdentifier(payload.model, 128) || '[redacted]',
    endpoint,
    thinking: payload.thinking?.type || null,
    toolChoice: safeToolChoice(payload.tool_choice),
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    maxTokens: Number.isSafeInteger(payload.max_tokens) ? payload.max_tokens : null,
    messageCount: messages.length,
    messages: messages.slice(0, 32).map(message => ({
      role: ['system', 'user', 'assistant', 'tool'].includes(message.role) ? message.role : 'other',
      toolCallIds: Array.isArray(message.tool_calls) ? message.tool_calls.slice(0, 16).map(call => safeMessageId(call.id)) : [],
      toolCallId: message.role === 'tool' ? safeMessageId(message.tool_call_id) : null
    })),
    messagesTruncated: messages.length > 32
  };
}

function safeProviderErrorMessage(rawMessage, status) {
  const message = typeof rawMessage === 'string' ? rawMessage.slice(0, 1024).toLowerCase() : '';
  if (/thinking/.test(message) && /(tool[_ -]?choice|tool call|function)/.test(message)
    && /(required|named|specific|force|support|unsupported|incompatible|only)/.test(message)) {
    return 'Provider thinking mode does not support required or named tool choices.';
  }
  if (/(rate.?limit|too many requests|quota)/.test(message)) return 'Provider rate limited the request.';
  if (/(context|token).{0,32}(length|limit|maximum|exceed)/.test(message)) return 'Provider rejected the request context length.';
  if (/(unauthori[sz]ed|invalid.{0,16}(api|credential|authorization)|authentication)/.test(message)) {
    return 'Provider rejected the request credentials.';
  }
  if (/(invalid request|unsupported parameter|unknown parameter|invalid parameter)/.test(message)) {
    return `Provider rejected request parameters (HTTP ${status}).`;
  }
  return `Provider returned HTTP ${status}.`;
}

async function readBoundedErrorBody(response, maxBytes = 4096) {
  const reader = response.body?.getReader?.();
  if (!reader) return { value: null, bytesRead: 0, truncated: false };
  const chunks = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    while (bytesRead < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      const remaining = maxBytes - bytesRead;
      const copiedBytes = Math.min(remaining, chunk.byteLength);
      if (copiedBytes) chunks.push(Buffer.from(chunk.subarray(0, copiedBytes)));
      bytesRead += copiedBytes;
      if (chunk.byteLength > remaining || bytesRead === maxBytes) {
        truncated = true;
        await reader.cancel('provider error diagnostic byte limit reached').catch(() => {});
        break;
      }
    }
    const text = Buffer.concat(chunks, bytesRead).toString('utf8');
    try { return { value: JSON.parse(text), bytesRead, truncated }; }
    catch { return { value: null, bytesRead, truncated }; }
  } catch {
    try { await reader.cancel('provider error diagnostic read failed').catch(() => {}); } catch { /* response already closed */ }
    return { value: null, bytesRead, truncated };
  } finally {
    try { reader.releaseLock(); } catch { /* cancellation may still be settling */ }
  }
}

async function makeProviderErrorDiagnostic(response, requestMetadata) {
  const bounded = await readBoundedErrorBody(response);
  const error = bounded.value?.error && typeof bounded.value.error === 'object' ? bounded.value.error : {};
  const status = response.status;
  return {
    request: requestMetadata,
    response: {
      status,
      type: safeDiagnosticIdentifier(error.type, 64),
      code: safeDiagnosticIdentifier(error.code, 96),
      message: safeProviderErrorMessage(error.message, status),
      bodyBytesRead: bounded.bytesRead,
      bodyTruncated: bounded.truncated
    }
  };
}

export async function requestChatCompletion({
  messages, tools = [], toolChoice = 'auto', signal, timeoutMs = 60_000,
  baseUrl = process.env.LLM_BASE_URL, apiKey = process.env.LLM_API_KEY,
  model = process.env.LLM_MODEL || 'gpt-4o-mini', maxTokens = 768, fetchImpl = fetch, thinkingMode,
  responseFormat = null, onRequestAttempt = null
}) {
  const url = modelEndpoint(baseUrl);
  if (!url || !apiKey) throw new ModelRequestError('MODEL_NOT_CONFIGURED');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const deepSeek = isDeepSeekEndpoint(url);
  let providerAttempted = false;
  let supplierKey = '';
  let requestAuditError = null;
  try {
    const resolvedThinkingMode = deepSeek ? resolveDeepSeekThinkingMode({ messages, toolChoice, thinkingMode }) : null;
    const payload = buildChatCompletionPayload({ messages, tools, toolChoice, model, maxTokens, deepSeek,
      thinkingMode: resolvedThinkingMode || thinkingMode, responseFormat });
    const provider = deepSeek ? 'deepseek' : 'openai-compatible';
    try { supplierKey = new URL(url).hostname.toLowerCase(); } catch { supplierKey = 'unknown-provider'; }
    if (onRequestAttempt) {
      try { await onRequestAttempt(); }
      catch (error) {
        requestAuditError = new ModelRequestError('MODEL_REQUEST_AUDIT_FAILED');
        requestAuditError.cause = error;
        throw requestAuditError;
      }
    }
    providerAttempted = true;
    const response = await fetchImpl(url, {
      method: 'POST', signal: requestSignal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const diagnostic = await makeProviderErrorDiagnostic(response, safeRequestMetadata({ url, payload, provider }));
      throw new ModelRequestError(`MODEL_HTTP_${response.status}`, '模型请求失败', diagnostic);
    }
    let data;
    try { data = await response.json(); }
    catch { throw new ModelRequestError('MODEL_RESPONSE_INVALID'); }
    const completion = normalizeChatCompletion(data);
    completion.message.thinkingMode = resolvedThinkingMode;
    if (deepSeek && resolvedThinkingMode !== 'enabled') completion.message.reasoningContent = null;
    await recordProviderSuccess({ supplier: supplierKey, feature: 'assistant.chat' });
    return { ...completion, provider };
  } catch (error) {
    if (requestAuditError) throw requestAuditError;
    if (providerAttempted && supplierKey) {
      await recordProviderFailure({ supplier: supplierKey, feature: 'assistant.chat',
        errorCode: error?.code || 'MODEL_PROVIDER_ERROR',
        impact: '助手资料查询暂时降级；运营页面、预约与其他本地服务仍可继续。' }).catch(() => {});
    }
    if (error instanceof ModelRequestError) throw error;
    if (requestSignal.aborted) {
      throw new ModelRequestError(controller.signal.aborted ? 'MODEL_TIMEOUT' : 'RUN_ABORTED');
    }
    throw new ModelRequestError('MODEL_NETWORK_ERROR');
  } finally {
    clearTimeout(timer);
  }
}
