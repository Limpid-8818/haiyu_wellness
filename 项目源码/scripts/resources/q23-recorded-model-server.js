import http from 'node:http';

const port = Number(process.env.PORT || 0);
let sequence = 0;
let requestCount = 0;
const failedProviderFaults = new Set();
const successfulUsageFaults = new Set();

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function completion(content, toolCalls = [], body = {}) {
  const inputBytes = Buffer.byteLength(JSON.stringify({ messages: body.messages || [], tools: body.tools || [] }), 'utf8');
  const outputBytes = Buffer.byteLength(JSON.stringify({ content, toolCalls }), 'utf8');
  const promptTokens = Math.max(1, Math.ceil(inputBytes / 4));
  const completionTokens = Math.max(1, Math.ceil(outputBytes / 4));
  return { id: `q23-fixture-${++sequence}`, object: 'chat.completion', model: 'q23-recorded-fixture',
    choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens } };
}

function lastUserText(body) {
  return String((body.messages || []).filter(message => message.role === 'user').at(-1)?.content || '');
}

function parseAction(text) {
  const match = text.match(/^Q23ACTION ([a-z_]+) (\{.*\})$/s);
  if (match) {
    try { return { name: match[1], args: JSON.parse(match[2]) }; } catch { return null; }
  }
  const cancellationChoice = text.match(/我选择取消预约\s+([A-Za-z0-9_-]{4,64})/);
  if (cancellationChoice) return { name: 'propose_booking_cancellation', args: { reservationId: cancellationChoice[1] } };
  if (/我想取消一项预约/.test(text)) return { name: 'propose_booking_cancellation', args: {} };
  const booking = text.match(/沙滩漫步时段编号\s+([A-Za-z0-9_-]{4,64}).*?日期\s+(\d{4}-\d{2}-\d{2})/s);
  if (booking) return { name: 'propose_program_booking', args: { projectId: 'project-beach-walk', slotId: booking[1], date: booking[2] } };
  const meal = text.match(/预约\s+(\d{4}-\d{2}-\d{2})\s+早餐配餐/);
  if (meal) return { name: 'propose_meal_order', args: { businessDate: meal[1], mealType: 'breakfast' } };
  const dishSwap = text.match(/日期\s+(\d{4}-\d{2}-\d{2})\s+早餐项目行编号\s+([A-Za-z0-9_-]{4,64})\s+替换为菜品编号\s+([A-Za-z0-9_-]{4,64})，原因：(.+)/s);
  if (dishSwap) return { name: 'propose_dish_swap', args: { businessDate: dishSwap[1], itemId: dishSwap[2],
    dishId: dishSwap[3], reason: dishSwap[4].trim() } };
  const metric = text.match(/收缩压\s*(\d{2,3})\s*[，,。;；\s]*舒张压\s*(\d{2,3})/);
  if (metric) return { name: 'propose_health_metric', args: { metric: 'blood_pressure', systolic: Number(metric[1]), diastolic: Number(metric[2]), unit: 'mmHg' } };
  const rest = text.match(/为预约\s+([A-Za-z0-9_-]{4,64})\s+提交休息调整，原因：(.+)/s);
  if (rest) return { name: 'propose_rest_change', args: { reservationId: rest[1], reason: rest[2].trim() } };
  return null;
}

function naturalBookingRequest(text) {
  const projectId = text.match(/项目编号\s+([A-Za-z0-9_-]{1,64})/)?.[1];
  const date = text.match(/日期\s+(\d{4}-\d{2}-\d{2})/)?.[1];
  if (!projectId || !date || !/(?:我想|我要|希望|请).{0,24}(?:预约|预订|报名)/u.test(text)) return null;
  return { projectId, date };
}

function modelToolCall(name, args) {
  return { id: `q23-tool-${sequence + 1}-${name}`, type: 'function',
    function: { name, arguments: JSON.stringify(args) } };
}

function domainId(body) {
  const system = String((body.messages || []).find(message => message.role === 'system')?.content || '');
  return system.match(/agentId=([a-z.]+)/)?.[1] || '';
}

function parseToolData(message) {
  try {
    const value = JSON.parse(String(message.content || ''));
    return value?.status === 'completed' ? value.data : null;
  } catch { return null; }
}

function domainCandidateIds(id, messages) {
  const replies = messages.filter(message => message.role === 'tool').map(parseToolData).filter(Boolean);
  const output = [];
  for (const data of replies) {
    if (id === 'domain.physio') {
      for (const item of data.evaluations || []) {
        if (item.outcome !== 'reject' && !item.reviewRequired && item.projectId) output.push(item.projectId);
      }
    } else if (id === 'domain.nutrition') {
      for (const item of data.candidates || []) if (item.candidateId) output.push(item.candidateId);
    } else if (id === 'domain.exercise') {
      for (const item of data.activities || []) {
        if (item.projectId && (item.availabilitySource !== 'activity_slots'
          || (item.openWindows || []).some(slot => !slot.closed && Number(slot.availableCount) > 0))) {
          output.push(item.projectId);
        }
      }
    } else if (id === 'domain.psychology') {
      for (const item of data.resources || []) if (item.id) output.push(item.id);
    }
  }
  return [...new Set(output)];
}

function coordinatorCandidateIds(body) {
  const user = (body.messages || []).filter(message => message.role === 'user').at(-1);
  try {
    const value = JSON.parse(String(user?.content || ''));
    const allowed = new Set(value.adoptedCandidateIds || []);
    return [...new Set((value.adoptedCandidates || []).map(item => item.candidateId)
      .filter(id => typeof id === 'string' && allowed.has(id)))];
  } catch { return []; }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && req.url === '/stats') return send(res, 200, { requestCount });
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url || '')) return send(res, 404, { error: 'not found' });
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) return send(res, 413, { error: 'request too large' });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, { error: 'invalid json' }); }
  requestCount += 1;
  const messages = body.messages || [];
  const tools = (body.tools || []).map(tool => tool.function?.name).filter(Boolean);
  const toolReplies = (body.messages || []).filter(message => message.role === 'tool');
  const booking = naturalBookingRequest(lastUserText(body));
  const priorCalls = messages.filter(message => message.role === 'assistant')
    .flatMap(message => message.tool_calls || []).map(call => call.function?.name).filter(Boolean);

  const providerFaultKey = lastUserText(body);
  if (/Q23_RECORDED_FAULT=provider-no-usage-once(?:-[a-z]+)?/.test(providerFaultKey)
    && !failedProviderFaults.has(providerFaultKey)) {
    failedProviderFaults.add(providerFaultKey);
    return send(res, 503, { error: { message: 'controlled offline fixture failure' } });
  }

  const successfulUsageFault = providerFaultKey.match(
    /Q23_RECORDED_FAULT=success-usage-(missing|null|partial|zero)-once(?:-[a-z]+)?/);
  if (successfulUsageFault && !successfulUsageFaults.has(providerFaultKey)) {
    successfulUsageFaults.add(providerFaultKey);
    const mode = successfulUsageFault[1];
    const result = completion(null, [modelToolCall('list_projects', { search: '沙滩漫步' })], body);
    if (mode === 'missing') delete result.usage;
    if (mode === 'null') result.usage = { prompt_tokens: null, completion_tokens: null, total_tokens: null };
    if (mode === 'partial') result.usage = { prompt_tokens: 0, total_tokens: 0 };
    if (mode === 'zero') result.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    return send(res, 200, result);
  }

  const agent = domainId(body);
  if (agent.startsWith('domain.')) {
    if (!toolReplies.length) {
      const requiredTools = tools.filter(name => /^get_[a-z_]+_(?:context|knowledge)$/.test(name));
      return send(res, 200, completion(null, requiredTools.map(name => ({
        id: `q23-tool-${sequence + 1}-${name}`, type: 'function',
        function: { name, arguments: '{}' }
      })), body));
    }
    return send(res, 200, completion(JSON.stringify({ candidateIds: domainCandidateIds(agent, messages) }), [], body));
  }

  if (agent === 'household.concierge') {
    return send(res, 200, completion(JSON.stringify({ selectedCandidateIds: coordinatorCandidateIds(body) }), [], body));
  }

  if (booking && tools.includes('propose_program_booking') && priorCalls.includes('list_project_slots')) {
    if (/Q23_RECORDED_FAULT=first-turn-no-card/.test(lastUserText(body))) {
      return send(res, 200, completion('可选时段已列出，请选择其中一个。', [], body));
    }
    if (priorCalls.includes('propose_program_booking')) {
      return send(res, 200, completion('已根据服务端校验结果生成操作卡；尚未执行任何业务操作。', [], body));
    }
    return send(res, 200, completion(null, [modelToolCall('propose_program_booking', booking)], body));
  }

  if (booking && !toolReplies.length && ['list_projects', 'list_project_slots', 'propose_program_booking'].every(name => tools.includes(name))) {
    return send(res, 200, completion(null, [
      modelToolCall('list_projects', { search: '沙滩漫步' }),
      modelToolCall('list_project_slots', { projectId: booking.projectId, date: booking.date })
    ], body));
  }

  if (toolReplies.length) return send(res, 200, completion('已根据服务端校验结果生成操作卡；尚未执行任何业务操作。', [], body));

  const action = parseAction(lastUserText(body));
  if (!action) return send(res, 200, completion('本次离线验收没有指定结构化工具调用。', [], body));
  const allowed = tools.includes(action.name);
  if (!allowed) return send(res, 200, completion(`当前模型请求没有提供 ${action.name} 工具。`, [], body));
  return send(res, 200, completion(null, [{ id: `q23-tool-${sequence + 1}`, type: 'function',
    function: { name: action.name, arguments: JSON.stringify(action.args) } }], body));
});

server.requestTimeout = 20_000;
server.headersTimeout = 5_000;
server.listen(port, '127.0.0.1', () => process.stdout.write(`Q23_RECORDED_MODEL_READY ${port}\n`));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));
