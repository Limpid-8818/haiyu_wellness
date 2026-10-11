import http from 'node:http';

const port = Number(process.env.PORT || 0);
let callNumber = 0;

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function completion(content, toolCalls = []) {
  return { id: `q21-recorded-${++callNumber}`, object: 'chat.completion', model: 'recorded-stage21',
    choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 84, completion_tokens: 52, total_tokens: 136 } };
}

function toolCall(id, name, args) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function parseJson(text) {
  try { return JSON.parse(String(text || '')); } catch { return {}; }
}

function lastUserText(body) {
  return String((body.messages || []).filter(item => item.role === 'user').at(-1)?.content || '');
}

function agentId(body) {
  const system = (body.messages || []).filter(item => item.role === 'system').map(item => String(item.content || '')).join('\n');
  return system.match(/agentId=(household\.concierge|domain\.(?:nutrition|exercise))/)?.[1] || '';
}

function extraction(text) {
  const marker = '客人原句：';
  const utterance = text.includes(marker) ? text.slice(text.lastIndexOf(marker) + marker.length).trim() : '';
  const candidates = [];
  const sleep = utterance.match(/最近睡不好|睡不好|睡眠不太好/u)?.[0];
  if (sleep) candidates.push({ field: 'sleep', status: 'reported', value: sleep, evidenceText: sleep });
  const shrimp = utterance.match(/(?:对)?虾过敏|虾过敏/u)?.[0];
  if (shrimp) candidates.push({ field: 'allergies', status: 'reported',
    value: shrimp.startsWith('对') ? '对虾过敏' : '虾', evidenceText: shrimp });
  const mobility = utterance.match(/(?:平时)?需要(?:用)?(?:拐杖|助行器|轮椅)|用(?:拐杖|助行器|轮椅)/u)?.[0];
  if (mobility) candidates.push({ field: 'mobility', status: 'assistance', value: mobility, evidenceText: mobility });
  return { candidates, clarificationQuestion: candidates.length ? null : null };
}

function isContext(data) {
  return Boolean(data && (Array.isArray(data.candidates) || Array.isArray(data.activities)));
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') return send(response, 200, { ok: true });
  if (request.method !== 'POST' || !/\/chat\/completions$/.test(request.url || '')) return send(response, 404, { error: 'not found' });
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 1024 * 1024) return send(response, 413, { error: 'request too large' });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return send(response, 400, { error: 'invalid json' }); }
  const userText = lastUserText(body);
  if (userText.includes('Q21:EXTRACT')) return send(response, 200, completion(JSON.stringify(extraction(userText))));

  const currentAgent = agentId(body);
  const toolReplies = (body.messages || []).filter(item => item.role === 'tool');
  const tools = (body.tools || []).map(item => item.function?.name).filter(Boolean);
  if (currentAgent.startsWith('domain.')) {
    if (!toolReplies.length) {
      const input = parseJson(userText);
      return send(response, 200, completion(null, tools.map((name, index) => toolCall(
        `q21_${currentAgent.split('.')[1]}_${callNumber}_${index + 1}`, name,
        name === 'get_exercise_context' ? { date: input.date } : {}))));
    }
    const results = toolReplies.map(item => parseJson(item.content));
    const domainInput = parseJson(userText);
    if (currentAgent === 'domain.nutrition') {
      const context = results.find(item => Array.isArray(item.data?.candidates))?.data || {};
      const byMeal = new Set();
      const candidateIds = (context.candidates || []).filter(item => {
        if (byMeal.has(item.mealType)) return false;
        byMeal.add(item.mealType);
        return true;
      }).map(item => item.candidateId);
      return send(response, 200, completion(JSON.stringify({ candidateIds })));
    }
    const context = results.find(item => Array.isArray(item.data?.activities))?.data || {};
    const omitRejectedExerciseCandidates = String(domainInput.request || '').includes('Q21:ZERO_ACTIVITY_INVENTORY');
    const candidateIds = (context.activities || []).filter(item => !omitRejectedExerciseCandidates || item.outcome !== 'reject')
      .map(item => item.projectId);
    return send(response, 200, completion(JSON.stringify({ candidateIds })));
  }

  if (currentAgent === 'household.concierge') {
    const input = parseJson(userText);
    const allowedIds = new Set(Array.isArray(input.adoptedCandidateIds) ? input.adoptedCandidateIds : []);
    const candidates = (input.adoptedCandidates || []).filter(item => allowedIds.has(item.candidateId));
    let selectedCandidateIds;
    if (input.coordinationTask === 'wellness_draft') {
      const selectedMeals = new Set();
      selectedCandidateIds = candidates.filter(item => {
        if (item.domain === 'nutrition') {
          if (selectedMeals.has(item.mealType)) return false;
          selectedMeals.add(item.mealType);
          return true;
        }
        return item.domain === 'exercise';
      }).map(item => item.candidateId);
    } else {
      const nutritionOnly = String(input.request || '').includes('Q21:ZERO_ACTIVITY_INVENTORY');
      selectedCandidateIds = candidates.filter(item => !nutritionOnly || item.domain === 'nutrition')
        .map(item => item.candidateId);
    }
    return send(response, 200, completion(JSON.stringify({ selectedCandidateIds })));
  }
  return send(response, 200, completion('已依据只读资料整理候选。'));
});

server.listen(port, '127.0.0.1', () => process.stdout.write(`Q21_RECORDED_MODEL_READY ${port}\n`));
server.requestTimeout = 30_000;
server.headersTimeout = 5_000;
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));
