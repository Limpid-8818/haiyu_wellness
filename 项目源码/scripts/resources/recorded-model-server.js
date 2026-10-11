import http from 'node:http';

const port = Number(process.env.PORT || 0);
const counts = new Map();
const writeRecoveryHeldScenarios = new Set();
const protocolStates = new Map();

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function completion(content, toolCalls = [], model = 'recorded-stage19', reasoningContent = null) {
  const message = { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  if (reasoningContent !== null) message.reasoning_content = reasoningContent;
  return {
    id: 'recorded-' + Date.now(), object: 'chat.completion', model,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 32, completion_tokens: 18, total_tokens: 50 }
  };
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function extractScenario(messages) {
  const users = (messages || []).filter(item => item.role === 'user');
  const text = String(users.at(-1)?.content || '');
  return text.match(/Q\d+:[A-Z0-9_.-]+/)?.[0] || 'default';
}

function extractAgentId(messages) {
  const system = (messages || []).filter(item => item.role === 'system').map(item => String(item.content || '')).join('\n');
  return system.match(/agentId=(household\.concierge|domain\.(?:physio|nutrition|exercise|psychology))/)?.[1] || '';
}

function parseJson(text) {
  try { return JSON.parse(String(text || '')); } catch { return {}; }
}

function configuredFixtureDelayMs(scenario, agentId, hasToolReply) {
  const plan = parseJson(process.env.Q20_FIXTURE_DELAY_PLAN);
  const phase = hasToolReply ? 'second' : 'first';
  const value = Number(plan[`${scenario}:${agentId}:${phase}`]);
  return Number.isFinite(value) ? Math.max(0, Math.min(1000, Math.floor(value))) : 0;
}

function waitUntilClientLeaves(request, response, milliseconds) {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      response.off('close', finish);
      request.off('aborted', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    response.once('close', finish);
    request.once('aborted', finish);
  });
}

function parseToolReply(item) {
  try { return JSON.parse(item.content || '{}'); } catch { return {}; }
}

function rejectProtocol(response, code, message) {
  return sendJson(response, 400, { error: { type: 'invalid_request_error', code, message } });
}

function handleProtocolScenario(body, scenario, count, response) {
  const mode = body.thinking?.type;
  const state = protocolStates.get(scenario);
  if (count === 1) {
    const initialMessages = body.messages || [];
    const tools = body.tools;
    const namedChoice = body.tool_choice && typeof body.tool_choice === 'object'
      && body.tool_choice.type === 'function' && typeof body.tool_choice.function?.name === 'string';
    if (mode === 'enabled' && (body.tool_choice === 'required' || namedChoice)) {
      return rejectProtocol(response, 'RECORDED_PROTOCOL_UNSUPPORTED_THINKING_TOOL_CHOICE',
        'thinking mode does not support required or named tool choices');
    }
    if (!['enabled', 'disabled'].includes(mode)) {
      return rejectProtocol(response, 'RECORDED_PROTOCOL_MODE_REQUIRED', 'thinking mode must be explicit on the first request');
    }
    const expectedToolChoice = scenario === 'Q19:PROTOCOL-AUTO' ? 'auto' : 'required';
    if (!Array.isArray(tools) || tools.length !== 2 || body.tool_choice !== expectedToolChoice
      || initialMessages.some(item => item.role === 'assistant' || item.role === 'tool')) {
      return rejectProtocol(response, 'RECORDED_PROTOCOL_INITIAL_REQUEST_INVALID', 'first request must declare two tools with a supported choice and contain no tool history');
    }
    const names = tools.map(item => item.function?.name);
    if (names.some(name => typeof name !== 'string' || !name) || new Set(names).size !== names.length) {
      return rejectProtocol(response, 'RECORDED_PROTOCOL_INITIAL_REQUEST_INVALID', 'tool names must be unique');
    }
    const expectedCalls = [
      { id: 'call_protocol_1', name: names[0] },
      { id: 'call_protocol_2', name: names[1] }
    ];
    const reasoningContent = mode === 'enabled' ? 'RECORDED_PRIVATE_REASONING_SENTINEL' : null;
    protocolStates.set(scenario, { mode, expectedCalls, reasoningContent });
    const calls = expectedCalls.map(call => toolCall(call.id, call.name, {}));
    return sendJson(response, 200, completion(null, calls, 'recorded-stage19', reasoningContent));
  }

  if (!state) return rejectProtocol(response, 'RECORDED_PROTOCOL_STATE_MISSING', 'first request was not recorded');
  if (mode !== state.mode) {
    return rejectProtocol(response, 'RECORDED_PROTOCOL_MODE_MISMATCH', 'thinking mode changed during a tool round trip');
  }
  if (Object.hasOwn(body, 'tools') || Object.hasOwn(body, 'tool_choice')) {
    return rejectProtocol(response, 'RECORDED_PROTOCOL_FINAL_TOOLS_PRESENT', 'final continuation must omit inactive tools');
  }
  const messages = body.messages || [];
  const assistantToolMessages = messages.filter(item => item.role === 'assistant'
    && Array.isArray(item.tool_calls) && item.tool_calls.length);
  const replies = messages.filter(item => item.role === 'tool');
  if (assistantToolMessages.length !== 1) {
    return rejectProtocol(response, 'RECORDED_PROTOCOL_TOOL_HISTORY_INVALID', 'history must contain exactly one assistant tool-call message');
  }
  const assistant = assistantToolMessages[0];
  const actualCalls = assistant.tool_calls.map(call => ({ id: call.id, name: call.function?.name }));
  if (JSON.stringify(actualCalls) !== JSON.stringify(state.expectedCalls)) {
    return rejectProtocol(response, 'RECORDED_PROTOCOL_TOOL_HISTORY_INVALID', 'assistant tool calls do not match the recorded call IDs');
  }
  const replyIds = replies.map(item => item.tool_call_id);
  const expectedIds = state.expectedCalls.map(call => call.id);
  if (replyIds.length !== expectedIds.length || new Set(replyIds).size !== replyIds.length
    || expectedIds.some(id => replyIds.filter(replyId => replyId === id).length !== 1)
    || replyIds.some(id => !expectedIds.includes(id))) {
    return rejectProtocol(response, 'RECORDED_PROTOCOL_TOOL_HISTORY_INVALID', 'each tool call must have exactly one matching tool result');
  }
  if (state.mode === 'enabled' && assistant.reasoning_content !== state.reasoningContent) {
    return rejectProtocol(response, 'RECORDED_PROTOCOL_REASONING_MISSING', 'enabled-mode reasoning continuation was not preserved');
  }
  if (state.mode === 'disabled' && assistant.reasoning_content != null) {
    return rejectProtocol(response, 'RECORDED_PROTOCOL_REASONING_UNEXPECTED', 'disabled mode must not carry reasoning content');
  }
  return sendJson(response, 200, completion('PROTOCOL_FINAL_OK', [], 'recorded-stage19',
    state.mode === 'enabled' ? 'RECORDED_FINAL_REASONING_SENTINEL' : null));
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return sendJson(response, 200, { ok: true });
  if (request.method !== 'POST' || !/\/chat\/completions$/.test(request.url || '')) return sendJson(response, 404, { error: 'not found' });
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) return sendJson(response, 413, { error: 'request too large' });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return sendJson(response, 400, { error: 'invalid json' }); }
  const scenario = extractScenario(body.messages);
  const count = (counts.get(scenario) || 0) + 1;
  counts.set(scenario, count);
  if (scenario.startsWith('Q19:PROTOCOL-')) return handleProtocolScenario(body, scenario, count, response);
  if (scenario === 'Q20:DIAGNOSTIC') {
    return rejectProtocol(response, 'unsupported_tool_choice',
      'thinking mode does not support tool_choice required; echoed PRIVATE_HEALTH_SENTINEL and Bearer sk-q20-fixture-only');
  }
  const privateReasoning = scenario === 'Q19:REASONING-UI' ? 'Q19_PRIVATE_REASONING_SENTINEL' : null;
  if (scenario === 'Q19:ERROR') return sendJson(response, 503, { error: 'recorded provider failure' });
  if (scenario.startsWith('Q19:RETRY') && count === 2) return sendJson(response, 503, { error: 'recorded retry checkpoint' });
  if (scenario.startsWith('Q19:SLOW') && count === 1) await waitUntilClientLeaves(request, response, 25_000);
  if (response.destroyed || response.writableEnded) return;
  const toolNames = (body.tools || []).map(item => item.function?.name);
  const toolReplies = (body.messages || []).filter(item => item.role === 'tool');
  const hasToolReply = toolReplies.length > 0;
  const agentId = extractAgentId(body.messages);
  const fixtureDelayMs = configuredFixtureDelayMs(scenario, agentId, hasToolReply);
  if (fixtureDelayMs) await new Promise(resolve => setTimeout(resolve, fixtureDelayMs));
  if (response.destroyed || response.writableEnded) return;
  if (agentId.startsWith('domain.')) {
    if (!hasToolReply) {
      const input = parseJson((body.messages || []).filter(item => item.role === 'user').at(-1)?.content);
      const calls = (body.tools || []).map((item, index) => {
        const name = item.function?.name;
        const args = name === 'get_exercise_context' ? { date: input.date } : {};
        return toolCall(`call_stage20_${agentId.split('.')[1]}_${index + 1}`, name, args);
      });
      return sendJson(response, 200, completion(null, calls, 'recorded-stage20'));
    }
    const parsed = toolReplies.map(item => parseToolReply(item));
    const context = parsed.find(item => item.data?.evaluations || item.data?.candidates || item.data?.activities || item.data?.resources)?.data || {};
    let candidateIds = [];
    if (agentId === 'domain.physio') candidateIds = (context.evaluations || []).map(item => item.projectId);
    else if (agentId === 'domain.nutrition') {
      const byMeal = new Set();
      candidateIds = (context.candidates || []).filter(item => {
        if (byMeal.has(item.mealType)) return false;
        byMeal.add(item.mealType);
        return true;
      }).map(item => item.candidateId);
    } else if (agentId === 'domain.exercise') candidateIds = (context.activities || []).map(item => item.projectId);
    else if (agentId === 'domain.psychology') candidateIds = (context.resources || []).slice(0, 2).map(item => item.id);
    return sendJson(response, 200, completion(JSON.stringify({ candidateIds }), [], 'recorded-stage20'));
  }
  if (agentId === 'household.concierge' && !hasToolReply) {
    if (body.response_format?.type !== 'json_object' || Object.hasOwn(body, 'tools') || Object.hasOwn(body, 'tool_choice')) {
      return rejectProtocol(response, 'RECORDED_COORDINATOR_REQUEST_INVALID', 'coordinator requires JSON mode without inactive tools');
    }
    const systemText = (body.messages || []).filter(item => item.role === 'system').map(item => String(item.content || '')).join('\n');
    if (!/json/i.test(systemText) || !systemText.includes('selectedCandidateIds')) {
      return rejectProtocol(response, 'RECORDED_COORDINATOR_SCHEMA_MISSING', 'coordinator prompt must describe the JSON selection shape');
    }
    if (scenario === 'Q20:COORDINATOR-HTTP') {
      return sendJson(response, 503, { error: { type: 'server_error', code: 'recorded_coordinator_unavailable', message: 'recorded coordinator failure' } });
    }
    if (scenario === 'Q20:COORDINATOR-EMPTY') return sendJson(response, 200, completion('', [], 'recorded-stage20'));
    if (scenario === 'Q20:COORDINATOR-INVALID-JSON') return sendJson(response, 200, completion('{invalid-json', [], 'recorded-stage20'));
    if (scenario === 'Q20:COORDINATOR-UNAUTHORIZED') {
      return sendJson(response, 200, completion(JSON.stringify({ selectedCandidateIds: ['unauthorized:candidate'] }), [], 'recorded-stage20'));
    }
    const input = parseJson((body.messages || []).filter(item => item.role === 'user').at(-1)?.content);
    const selectedCandidateIds = (input.adoptedCandidates || []).map(item => item.candidateId);
    return sendJson(response, 200, completion(JSON.stringify({ selectedCandidateIds }), [], 'recorded-stage20'));
  }
  if (scenario.startsWith('Q19:WRITE-RECOVERY') && hasToolReply && !writeRecoveryHeldScenarios.has(scenario)) {
    writeRecoveryHeldScenarios.add(scenario);
    await waitUntilClientLeaves(request, response, 25_000);
    if (response.destroyed || response.writableEnded) return;
  }
  if (scenario.startsWith('Q19:WRITE-RECOVERY') && hasToolReply && writeRecoveryHeldScenarios.has(scenario)) {
    return sendJson(response, 200, completion('验收写入结果已从检查点恢复，没有重复执行副作用。'));
  }
  if (scenario === 'Q19:REASONING-UI' && hasToolReply) {
    return sendJson(response, 200, completion('已依据只读结果完成答复。', [], 'recorded-stage19', privateReasoning));
  }
  if (hasToolReply && !scenario.startsWith('Q19:LOOP') && !scenario.startsWith('Q19:WRITE-RECOVERY')) {
    if (scenario === 'Q19:MIXED') {
      const results = toolReplies.map(parseToolReply);
      const project = results.find(result => Array.isArray(result.data));
      const projects = project?.data || [];
      const names = projects.map(item => item.name).filter(Boolean).slice(0, 2).join('、') || '目录中暂未匹配到项目';
      const environmentFailed = results.some(result => result.status === 'failed');
      return sendJson(response, 200, completion(`项目查询结果：${names}。${environmentFailed ? '环境快照暂不可用，请稍后再查；项目查询结果仍然有效。' : '环境快照查询完成。'}`));
    }
    if (['Q19:SLOTS', 'Q19:APPOINTMENT-COMPLETE'].includes(scenario)) {
      const result = toolReplies.map(parseToolReply).find(item => item.data?.slots);
      const slot = result?.data?.slots?.[0];
      if (slot) return sendJson(response, 200, completion(`${result.data.date} 水疗 SPA 时段 ${slot.id} 剩余 ${slot.availableCount} 个名额；这是只读查询，不代表预约确认。`));
      return sendJson(response, 200, completion('该日期没有可展示的水疗 SPA 时段；这不是预约确认。'));
    }
    return sendJson(response, 200, completion('已依据只读查询结果完成答复；时段与服务资料仅供参考。'));
  }
  let calls = [];
  if (scenario === 'Q19:MULTI') {
    const tool = toolNames.includes('list_projects') ? 'list_projects' : toolNames[0];
    calls = [toolCall('call_stage19_1', tool, { search: '睡眠' }), toolCall('call_stage19_2', tool, { search: '海洋' })];
  } else if (scenario === 'Q19:BADARGS') {
    calls = [toolCall('call_stage19_bad', 'list_projects', { search: 42 })];
  } else if (scenario === 'Q19:FORGE') {
    calls = [toolCall('call_stage19_forge', 'get_mood_summary', { guestId: 'another-guest', actorId: 'another-user' })];
  } else if (scenario === 'Q19:MIXED') {
    calls = [toolCall('call_stage19_project', 'list_projects', { search: 'SPA' }),
      toolCall('call_stage19_environment', 'get_environment_snapshot', { date: '2026-10-10' })];
  } else if (scenario === 'Q19:APPOINTMENT' || scenario === 'Q19:APPOINTMENT-DATE' || scenario === 'Q19:APPOINTMENT-SLOT') {
    const text = String((body.messages || []).filter(message => message.role === 'user').at(-1)?.content || '');
    const args = { projectId: 'project-spa' };
    const date = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
    const slot = text.match(/时段编号\s+([A-Za-z0-9_-]{4,64})/);
    if (date) args.date = date[1];
    if (slot) args.slotId = slot[1];
    calls = [toolCall(`call_stage19_appointment_${count}`, 'propose_program_booking', args)];
  } else if (scenario === 'Q19:SLOTS' || scenario === 'Q19:APPOINTMENT-COMPLETE') {
    const text = String((body.messages || []).filter(message => message.role === 'user').at(-1)?.content || '');
    const date = text.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1] || '2026-10-10';
    calls = [toolCall('call_stage19_slots', 'list_project_slots', { projectId: 'project-spa', date })];
  } else if (scenario === 'Q19:RELAX') {
    calls = [toolCall('call_stage19_relax', 'list_projects', { search: '水疗' })];
  } else if (scenario === 'Q19:STAFF') {
    calls = [toolCall('call_stage19_staff_profile', 'get_guest_profile', {})];
  } else if (scenario.startsWith('Q19:WRITE-RECOVERY')) {
    if (toolNames.includes('q19_test_write_once')) calls = [toolCall('call_stage19_write_once', 'q19_test_write_once', { note: 'persist before restart' })];
  } else if (scenario.startsWith('Q19:LOOP')) {
    const tool = toolNames.includes('list_projects') ? 'list_projects' : toolNames[0];
    if (tool) calls = [toolCall(`call_stage19_loop_${count}`, tool, { search: `round-${count}` })];
  } else if (scenario.startsWith('Q19:MANY')) {
    const tool = toolNames.includes('list_projects') ? 'list_projects' : toolNames[0];
    if (tool) calls = Array.from({ length: 6 }, (_, index) => toolCall(`call_stage19_many_${index + 1}`, tool, { search: `batch-${index + 1}` }));
  } else if (scenario.startsWith('Q19:RETRY')) {
    calls = [toolCall('call_stage19_retry', 'list_projects', { search: '' })];
  } else if (scenario === 'Q19:HEALTH' && toolNames.includes('get_health_summary')) {
    calls = [toolCall('call_stage19_health', 'get_health_summary', {})];
  } else if (scenario.startsWith('Q19:LOW-TOKENS') || scenario.startsWith('Q19:LOW-COST')) {
    const tool = toolNames.includes('list_projects') ? 'list_projects' : toolNames[0];
    if (tool) calls = [toolCall('call_stage19_budget', tool, { search: '' })];
  } else {
    const tool = toolNames.includes('list_projects') ? 'list_projects' : toolNames[0];
    if (tool) calls = [toolCall(`call_stage19_${count}`, tool, { search: ['Q19:PROJECT', 'Q19:SLOW', 'Q19:REASONING-UI'].includes(scenario) ? '' : '睡眠' })];
  }
  if (calls.length) return sendJson(response, 200, completion(null, calls, 'recorded-stage19', privateReasoning));
  return sendJson(response, 200, completion('已记录你的问题。请告诉我更具体的需求，或联系工作人员协助。'));
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`RECORDED_MODEL_READY ${typeof address === 'object' && address ? address.port : port}\n`);
});
server.requestTimeout = 30_000;
server.headersTimeout = 5_000;
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));
