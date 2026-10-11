import http from 'node:http';

const port = Number(process.env.PORT || 0);
let callNumber = 0;

function send(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

function completion(content, toolCalls = []) {
  return { id: `q22-recorded-${++callNumber}`, object: 'chat.completion', model: 'recorded-stage22',
    choices: [{ index: 0, message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 96, completion_tokens: 64, total_tokens: 160 } };
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
  const currentAgent = agentId(body);
  const toolReplies = (body.messages || []).filter(item => item.role === 'tool');
  const tools = (body.tools || []).map(item => item.function?.name).filter(Boolean);
  if (currentAgent.startsWith('domain.')) {
    if (!toolReplies.length) {
      const input = parseJson(userText);
      return send(response, 200, completion(null, tools.map((name, index) => toolCall(
        `q22_${currentAgent.split('.')[1]}_${callNumber}_${index + 1}`, name,
        name === 'get_exercise_context' ? { date: input.date } : {}))));
    }
    const results = toolReplies.map(item => parseJson(item.content));
    if (currentAgent === 'domain.nutrition') {
      const context = results.find(item => Array.isArray(item.data?.candidates))?.data || {};
      const mealTypes = new Set();
      const candidateIds = (context.candidates || []).filter(item => {
        if (mealTypes.has(item.mealType)) return false;
        mealTypes.add(item.mealType);
        return true;
      }).map(item => item.candidateId);
      return send(response, 200, completion(JSON.stringify({ candidateIds })));
    }
    const context = results.find(item => Array.isArray(item.data?.activities))?.data || {};
    const regenerate = /R2|海水浴|开放性伤口/u.test(userText);
    const candidateIds = (context.activities || []).filter(item => !regenerate || item.projectId !== 'project-sea-bath')
      .map(item => item.projectId);
    return send(response, 200, completion(JSON.stringify({ candidateIds })));
  }
  if (currentAgent === 'household.concierge') {
    const input = parseJson(userText);
    const allowedIds = new Set(Array.isArray(input.adoptedCandidateIds) ? input.adoptedCandidateIds : []);
    const candidates = (input.adoptedCandidates || []).filter(item => allowedIds.has(item.candidateId));
    const selectedCandidateIds = candidates.filter(item => item.domain === 'nutrition' || item.domain === 'exercise')
      .map(item => item.candidateId);
    return send(response, 200, completion(JSON.stringify({ selectedCandidateIds })));
  }
  return send(response, 200, completion('已按只读资料与医护退回原因整理候选；没有加入被明确排除的海水浴项目。'));
});

server.requestTimeout = 30_000;
server.headersTimeout = 5_000;
server.listen(port, '127.0.0.1', () => process.stdout.write(`Q22_RECORDED_MODEL_READY ${port}\n`));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
process.once('SIGINT', () => server.close(() => process.exit(0)));
