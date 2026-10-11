import http from 'node:http';

const port = Number(process.env.STAGE26_FIXTURE_PORT);
const projectId = process.env.STAGE26_FIXTURE_PROJECT_ID || 'project-sea-bath';
const date = process.env.STAGE26_FIXTURE_DATE || '2026-10-10';
let requests = 0;

function send(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) });
  response.end(encoded);
}

function collectToolPayload(messages) {
  const latest = [...(messages || [])].reverse().find(item => item.role === 'tool');
  if (!latest || typeof latest.content !== 'string') return null;
  try { return JSON.parse(latest.content); } catch { return null; }
}

function finalText(payload) {
  const value = payload?.data ?? payload;
  if (value?.pendingPlan) {
    const plan = value.pendingPlan;
    const risks = value.riskFlags?.length ? value.riskFlags.join('、') : '未标记风险';
    const rules = value.rules?.map(rule => rule.id).filter(Boolean).join('、') || '未发现命中规则';
    return `本周待审方案 ${plan.id} 第 ${plan.version} 版，状态 ${plan.status}。资料列出的风险：${risks}；规则引用：${rules}。该结果只供医护复核，不会自动批准。`;
  }
  const slots = value?.slots;
  if (Array.isArray(slots)) {
    const slot = slots.find(item => item.remaining !== undefined && /^1[2-9]:/.test(item.localStart || ''))
      || slots.find(item => item.remaining !== undefined) || slots[0];
    if (slot) return `${value.project?.name || '项目'} ${value.date} ${slot.localStart}-${slot.localEnd} 余量 ${slot.remaining} 人，时段 ${slot.slotId}，数据时间 ${slot.dataTime}。修改请打开运营页并由管理员确认。`;
  }
  return '已完成本地只读查询。';
}

function parseJson(value) {
  try { return JSON.parse(String(value || '')); } catch { return {}; }
}

function graphAgentId(payload) {
  const system = (payload.messages || []).filter(item => item.role === 'system')
    .map(item => String(item.content || '')).join('\n');
  return system.match(/agentId=(household\.concierge|domain\.(?:nutrition|exercise))/)?.[1] || '';
}

function graphUserInput(payload) {
  const text = String((payload.messages || []).filter(item => item.role === 'user').at(-1)?.content || '');
  return parseJson(text);
}

function graphToolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function graphResponse(payload, agent, requestId) {
  const input = graphUserInput(payload);
  const toolReplies = (payload.messages || []).filter(item => item.role === 'tool').map(item => parseJson(item.content));
  if (agent === 'household.concierge' && input.coordinationTask === 'wellness_draft') {
    const allowed = new Set(input.adoptedCandidateIds || []);
    const selectedMeals = new Set();
    const selectedCandidateIds = (input.adoptedCandidates || []).filter(item => allowed.has(item.candidateId)
      && (item.domain === 'nutrition'
        ? !selectedMeals.has(item.mealType) && selectedMeals.add(item.mealType)
        : item.domain === 'exercise' && item.availabilitySource === 'activity_slots' && item.availableSlotCount > 0))
      .map(item => item.candidateId);
    return { content: JSON.stringify({ selectedCandidateIds }) };
  }
  if (!agent?.startsWith('domain.')) return null;
  if (!toolReplies.length) {
    const calls = (payload.tools || []).map((item, index) => {
      const name = item.function?.name;
      return graphToolCall(`stage26-${requestId}-${index + 1}`, name,
        name === 'get_exercise_context' ? { date: input.date } : {});
    });
    return { content: null, toolCalls: calls };
  }
  if (agent === 'domain.nutrition') {
    const context = toolReplies.find(item => Array.isArray(item.data?.candidates))?.data || {};
    const selectedMeals = new Set();
    const candidateIds = (context.candidates || []).filter(item => {
      if (selectedMeals.has(item.mealType)) return false;
      selectedMeals.add(item.mealType);
      return true;
    }).map(item => item.candidateId);
    return { content: JSON.stringify({ candidateIds }) };
  }
  const context = toolReplies.find(item => Array.isArray(item.data?.activities))?.data || {};
  return { content: JSON.stringify({ candidateIds: (context.activities || []).map(item => item.projectId) }) };
}

const server = http.createServer((request, response) => {
  if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true, requests });
  if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) return send(response, 404, { error: { message: 'not found' } });
  let bytes = 0;
  const chunks = [];
  request.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    requests += 1;
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(response, 400, { error: { message: 'invalid fixture request' } }); }
    const mode = new URL(request.url, 'http://127.0.0.1').pathname.split('/')[1] || 'success';
    if (mode === 'fail') return send(response, 503, { error: { type: 'service_unavailable', code: 'fixture_unavailable', message: 'local stage26 fixture failure' } });
    if (mode === 'tools') {
      const graph = graphResponse(payload, graphAgentId(payload), requests);
      if (graph) return send(response, 200, { id: `fixture-${requests}`, object: 'chat.completion', created: 1,
        model: 'stage26-local-fixture', choices: [{ index: 0, finish_reason: graph.toolCalls?.length ? 'tool_calls' : 'stop',
          message: { role: 'assistant', content: graph.content, ...(graph.toolCalls?.length ? { tool_calls: graph.toolCalls } : {}) } }],
        usage: { prompt_tokens: 140, completion_tokens: 24, total_tokens: 164 } });
      const prior = collectToolPayload(payload.messages);
      if (prior) {
        return send(response, 200, { id: `fixture-${requests}`, object: 'chat.completion', created: 1,
          model: 'stage26-local-fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: finalText(prior) } }],
          usage: { prompt_tokens: 160, completion_tokens: 48, total_tokens: 208 } });
      }
      const available = new Set((payload.tools || []).map(item => item.function?.name));
      const toolName = available.has('search_staff_review_context') ? 'search_staff_review_context'
        : available.has('search_operations_capacity') ? 'search_operations_capacity' : '';
      if (toolName) {
        const args = toolName === 'search_operations_capacity' ? { projectId, date } : {};
        return send(response, 200, { id: `fixture-${requests}`, object: 'chat.completion', created: 1,
          model: 'stage26-local-fixture', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
            tool_calls: [{ id: `stage26-call-${requests}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] } }],
          usage: { prompt_tokens: 140, completion_tokens: 24, total_tokens: 164 } });
      }
    }
    return send(response, 200, { id: `fixture-${requests}`, object: 'chat.completion', created: 1,
      model: 'stage26-local-fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '本地协议夹具完成请求。' } }],
      usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } });
  });
});

server.listen(port, '127.0.0.1', () => console.log(`[stage26-fixture] ready port=${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
