import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantStatus } from '../../server/src/assistant.js';
import { normalizeChatCompletion, requestChatCompletion, toConversationMessage, toProviderMessages } from '../../server/src/model-adapter.js';
import { classifyAssistantIntent, getAssistantToolDefinitions, runAssistantTool, validateToolArguments } from '../../server/src/assistant-tools.js';
import { databaseQuery, login, request, withBothDatabaseApis, withDatabaseApi } from './q10-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordedModel = path.join(projectRoot, 'scripts/resources/recorded-model-server.js');
const UI_SOURCE = path.join(projectRoot, 'web/src/main.jsx');
const CSS_SOURCE = path.join(projectRoot, 'web/src/assistant.css');
const EVIDENCE_PATH = path.join(projectRoot, 'output/resource-audit/stage19-execution-evidence-20261003.jsonl');
let activeResourceSession;

function recordStageEvidence(entry) {
  fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  const line = JSON.stringify({ recordedAt: new Date().toISOString(), ...entry });
  if (Buffer.byteLength(line, 'utf8') > 48 * 1024) throw new Error('Stage19 execution evidence record exceeds the bounded record size');
  fs.appendFileSync(EVIDENCE_PATH, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function insertSlotFixture(context, suffix = context.driver) {
  const guestLogin = assertOk(await login(context.baseUrl, 'guest'), 200, `${context.driver}: guest login for available-slot fixture`);
  const businessDate = '2026-10-07';
  const view = assertOk(await request(context.baseUrl, `/projects/project-spa/slots?date=${businessDate}`,
    { token: guestLogin.token }), 200, `${context.driver}: generate current SPA slots`);
  const guestBookings = await databaseQuery(context, "SELECT slot_id FROM reservations WHERE guest_id=? AND status='confirmed'",
    [guestLogin.user.id]);
  const ownSlotIds = new Set(guestBookings.map(row => row.slot_id));
  const slot = (view.slots || []).find(item => item.bookable && Number(item.remaining) > 1 && !ownSlotIds.has(item.id));
  assert.ok(slot?.id, `${context.driver}: a future open SPA slot is available: ${JSON.stringify(view.slots)}`);
  const occupant = await addAssignedSyntheticGuest(context);
  assert.ok(occupant?.guestId, `${context.driver}: isolated guest exists for the occupied-slot fixture`);
  const timestamp = '2026-10-01 00:00:00.000';
  await databaseQuery(context, `INSERT INTO reservations
    (id,guest_id,slot_id,idempotency_key,request_fingerprint,status,created_at,environment_snapshot_id,availability_status,availability_reason,is_demo)
    VALUES(?,?,?,?,?,'confirmed',?,?,?,?,1)`, [`q19-reservation-${suffix}`, occupant.guestId, slot.id,
    `q19-reservation-${suffix}`, crypto.createHash('sha256').update(`q19-${suffix}`).digest('hex'), timestamp,
    'q19-synthetic-environment', 'available', 'Stage19 remaining-slot fixture'], 'run');
  const expected = await databaseQuery(context, `SELECT s.id,s.project_id AS projectId,s.business_date AS businessDate,s.capacity,
      COUNT(r.id) AS reservedCount,s.capacity-COUNT(r.id) AS availableCount
    FROM activity_slots s LEFT JOIN reservations r ON r.slot_id=s.id AND r.status='confirmed'
    WHERE s.id=? GROUP BY s.id,s.project_id,s.business_date,s.capacity`, [slot.id], 'get');
  assert.deepEqual({ id: expected.id, projectId: expected.projectId, businessDate: String(expected.businessDate).slice(0, 10),
    capacity: Number(expected.capacity), reservedCount: Number(expected.reservedCount), availableCount: Number(expected.availableCount) },
  { id: slot.id, projectId: 'project-spa', businessDate, capacity: Number(slot.capacity),
    reservedCount: Number(slot.booked) + 1, availableCount: Number(slot.remaining) - 1 });
  return { id: slot.id, expected };
}

async function addAssignedSyntheticGuest(context) {
  const guest = await databaseQuery(context, "SELECT id,password_hash FROM users WHERE username='guest_demo'", [], 'get');
  const staff = await databaseQuery(context, "SELECT id FROM users WHERE username='staff_demo'", [], 'get');
  const dean = await databaseQuery(context, "SELECT id FROM users WHERE username='dean_demo'", [], 'get');
  assert.ok(guest?.id && staff?.id && dean?.id);
  const guestId = crypto.randomUUID();
  const timestamp = '2026-09-01 00:00:00.000';
  await databaseQuery(context, 'INSERT INTO users(id,username,password_hash,role,name) VALUES(?,?,?,?,?)',
    [guestId, 'q19_existing_guest', guest.password_hash, 'guest', 'Stage19 合成客人'], 'run');
  await databaseQuery(context, "INSERT INTO guest_profiles(user_id,chronic_json,allergies_json) VALUES(?,'[]','[]')", [guestId], 'run');
  await databaseQuery(context, `INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at) VALUES(?,?,?,NULL,'active',?,?,?)`,
    [staff.id, guestId, timestamp, dean.id, timestamp, timestamp], 'run');
  return { guestId, staffId: staff.id };
}

function assertOk(result, expected = 200, label = 'request') {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data)}`);
  return result.data;
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('loopback port unavailable')));
    });
  });
}

async function startRecordedModel() {
  if (!activeResourceSession) throw new Error('Q19 requires a managed ResourceSession');
  const port = await reservePort();
  const resource = await activeResourceSession.startProcess({
    label: `q19-recorded-model-${crypto.randomUUID().slice(0, 8)}`, kind: 'stub', role: 'model-provider',
    command: process.execPath, args: [recordedModel], cwd: projectRoot, port,
    env: { PATH: process.env.PATH || '', PORT: String(port) }
  });
  assert.equal(resource.status, 'running', `recorded model did not start: ${JSON.stringify(resource)}`);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const deadline = Date.now() + 8_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch { /* wait for managed local fixture to bind */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`recorded model readiness timeout (resource ${resource.id})`);
  return {
    baseUrl, resource,
    async close() {
      const stopped = await activeResourceSession.stop(resource.id, 'q19-recorded-model-complete');
      if (!stopped.ok) throw new Error(`could not stop recorded model ${resource.id}: ${stopped.error || 'unknown error'}`);
      const exited = await activeResourceSession.waitProcess(resource.id, 10_000);
      if (exited.timedOut || exited.unavailable || ['starting', 'running'].includes(exited.status)) {
        throw new Error(`recorded model did not exit: ${JSON.stringify(exited)}`);
      }
    }
  };
}

const fixtureModelEnv = provider => ({
  LLM_BASE_URL: provider.baseUrl,
  LLM_API_KEY: 'q19-recorded-test-key',
  LLM_MODEL: 'recorded-stage19'
});

async function forDrivers(stage, callback, env = {}) {
  const options = { resourceSession: activeResourceSession, env };
  if (stage === 19) {
    const results = [];
    await withBothDatabaseApis(async context => { results.push(await callback(context)); }, options);
    return results;
  }
  return await withDatabaseApi('sqlite', context => callback(context), options);
}

async function waitForRun(baseUrl, runId, role, token) {
  const deadline = Date.now() + 105_000;
  while (Date.now() < deadline) {
    const result = await request(baseUrl, `/assistant/runs/${encodeURIComponent(runId)}?role=${encodeURIComponent(role)}`, { token });
    assert.equal(result.status, 200, `run status: ${JSON.stringify(result.data)}`);
    if (!['queued', 'running'].includes(result.data.status)) return result.data;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('assistant run did not finish within its bounded test window');
}

async function lastManagedApiLog() {
  const status = await activeResourceSession.status();
  const api = [...(status.resources || [])].reverse().find(resource => resource.kind === 'api');
  if (!api) return '';
  const log = await activeResourceSession.rpc({ op: 'log-tail', id: api.id, maxBytes: 4096 });
  return log.tail || '';
}

async function postAsyncRun(context, { role = 'public', text, token, guestId, sessionId, clientRequestId = crypto.randomUUID() }) {
  const body = { async: true, role, text, clientRequestId };
  if (guestId) body.guestId = guestId;
  if (sessionId) body.sessionId = sessionId;
  const result = await request(context.baseUrl, '/assistant/chat', { method: 'POST', token, body });
  assert.equal(result.status, 202, `async assistant start: ${JSON.stringify(result.data)}`);
  return { ...result.data, clientRequestId, body, token, role };
}

async function q191() {
  const normalized = normalizeChatCompletion({
    id: 'fixture-response', model: 'deepseek-flash',
    choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      reasoning_content: 'provider continuation state',
      tool_calls: [{ id: 'call_exact_1', type: 'function', function: { name: 'list_projects', arguments: '{"search":"睡眠"}' } }] } }],
    usage: { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 }
  });
  assert.equal(normalized.message.toolCalls[0].id, 'call_exact_1');
  assert.equal(normalized.message.toolCalls[0].name, 'list_projects');
  assert.equal(normalized.message.toolCalls[0].arguments, '{"search":"睡眠"}');
  assert.equal(normalized.message.reasoningContent, 'provider continuation state');
  assert.deepEqual(normalized.usage, { inputTokens: 19, outputTokens: 7, totalTokens: 26 });
  const invalidHistory = [
    toConversationMessage(normalized.message),
    { role: 'tool', toolCallId: 'call_wrong_1', content: 'unmatched result' }
  ];
  assert.throws(() => toProviderMessages(invalidHistory, true),
    error => error.code === 'MODEL_CONVERSATION_INVALID');

  const provider = await startRecordedModel();
  try {
    const deepSeekUrl = 'https://api.deepseek.com/v1';
    const apiKey = 'q19-protocol-fixture-key';
    const model = 'deepseek-flash';
    const tools = [
      { type: 'function', function: { name: 'lookup_first', description: 'Recorded read-only tool', parameters: { type: 'object', properties: {} } } },
      { type: 'function', function: { name: 'lookup_second', description: 'Recorded read-only tool', parameters: { type: 'object', properties: {} } } }
    ];
    const sentPayloads = [];
    const fetchToRecorder = async (_url, options) => {
      sentPayloads.push(JSON.parse(options.body));
      return await fetch(provider.baseUrl + '/chat/completions', options);
    };
    const userMessage = { role: 'user', content: 'Q19:PROTOCOL-FIXED Validate the complete tool round trip.' };
    const first = await requestChatCompletion({
      messages: [userMessage], tools, toolChoice: 'required',
      baseUrl: deepSeekUrl, apiKey, model, fetchImpl: fetchToRecorder
    });
    assert.equal(first.provider, 'deepseek');
    assert.equal(first.message.thinkingMode, 'disabled');
    assert.equal(first.message.reasoningContent, null);
    assert.deepEqual(first.message.toolCalls.map(call => call.id), ['call_protocol_1', 'call_protocol_2']);
    const internalAssistant = toConversationMessage(first.message);
    assert.equal(internalAssistant.thinkingMode, 'disabled');
    assert.equal(internalAssistant.reasoningContent, null);
    const continuation = [
      userMessage,
      internalAssistant,
      ...first.message.toolCalls.map(call => ({
        role: 'tool', toolCallId: call.id, content: 'recorded result for ' + call.name
      }))
    ];
    const wire = toProviderMessages(continuation, true);
    assert.deepEqual(wire[1].tool_calls.map(call => call.id), ['call_protocol_1', 'call_protocol_2']);
    assert.equal(Object.hasOwn(wire[1], 'reasoning_content'), false);
    assert.deepEqual(wire.slice(2).map(message => message.tool_call_id), ['call_protocol_1', 'call_protocol_2']);

    const final = await requestChatCompletion({
      messages: continuation, baseUrl: deepSeekUrl, apiKey, model, fetchImpl: fetchToRecorder
    });
    assert.equal(final.message.content, 'PROTOCOL_FINAL_OK');
    assert.equal(final.message.thinkingMode, 'disabled');
    assert.equal(sentPayloads.length, 2);
    assert.deepEqual(sentPayloads.map(payload => payload.thinking?.type), ['disabled', 'disabled']);
    assert.equal(sentPayloads[0].tool_choice, 'required');
    assert.equal(Object.hasOwn(sentPayloads[1], 'tools'), false);
    assert.equal(Object.hasOwn(sentPayloads[1], 'tool_choice'), false);
    assert.equal(Object.hasOwn(sentPayloads[1].messages[1], 'reasoning_content'), false);

    const recorderUrl = provider.baseUrl + '/chat/completions';
    for (const [marker, toolChoice] of [
      ['Q19:PROTOCOL-ILLEGAL-REQUIRED', 'required'],
      ['Q19:PROTOCOL-ILLEGAL-NAMED', { type: 'function', function: { name: 'lookup_first' } }]
    ]) {
      const response = await fetch(recorderUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: marker }], tools,
          tool_choice: toolChoice, thinking: { type: 'enabled' } })
      });
      assert.equal(response.status, 400, `${marker}: unsupported thinking/forced-choice combination is rejected`);
      assert.equal((await response.json()).error.code, 'RECORDED_PROTOCOL_UNSUPPORTED_THINKING_TOOL_CHOICE');
    }

    const autoPayloads = [];
    const fetchAutoToRecorder = async (_url, options) => {
      autoPayloads.push(JSON.parse(options.body));
      return await fetch(provider.baseUrl + '/chat/completions', options);
    };
    const autoUser = { role: 'user', content: 'Q19:PROTOCOL-AUTO Validate the supported optional thinking branch.' };
    const autoFirst = await requestChatCompletion({ messages: [autoUser], tools, toolChoice: 'auto',
      baseUrl: deepSeekUrl, apiKey, model, fetchImpl: fetchAutoToRecorder });
    assert.equal(autoFirst.message.thinkingMode, 'enabled');
    assert.equal(autoFirst.message.reasoningContent, 'RECORDED_PRIVATE_REASONING_SENTINEL');
    const autoHistory = [autoUser, toConversationMessage(autoFirst.message),
      ...autoFirst.message.toolCalls.map(call => ({ role: 'tool', toolCallId: call.id, content: `result:${call.id}` }))];
    const autoFinal = await requestChatCompletion({ messages: autoHistory, baseUrl: deepSeekUrl,
      apiKey, model, fetchImpl: fetchAutoToRecorder });
    assert.equal(autoFinal.message.content, 'PROTOCOL_FINAL_OK');
    assert.deepEqual(autoPayloads.map(payload => payload.thinking?.type), ['enabled', 'enabled']);
    assert.equal(autoPayloads[0].tool_choice, 'auto');
    assert.equal(Object.hasOwn(autoPayloads[1], 'tools'), false);
    assert.equal(autoPayloads[1].messages[1].reasoning_content, 'RECORDED_PRIVATE_REASONING_SENTINEL');

    const oldUser = { role: 'user', content: 'Q19:PROTOCOL-OLD Reproduce the old mode mismatch.' };
    const oldFirstResponse = await fetch(recorderUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [oldUser], tools, tool_choice: 'required', thinking: { type: 'disabled' } })
    });
    assert.equal(oldFirstResponse.status, 200);
    const oldFirst = await oldFirstResponse.json();
    const oldAssistant = oldFirst.choices[0].message;
    const oldHistory = [
      oldUser,
      { role: 'assistant', content: oldAssistant.content, tool_calls: oldAssistant.tool_calls },
      ...oldAssistant.tool_calls.map(call => ({ role: 'tool', tool_call_id: call.id, content: 'recorded result' }))
    ];
    const oldSecondResponse = await fetch(recorderUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: oldHistory })
    });
    assert.equal(oldSecondResponse.status, 400, 'the old implicit-default continuation is rejected');
    assert.equal((await oldSecondResponse.json()).error.code, 'RECORDED_PROTOCOL_MODE_MISMATCH');

    const badUser = { role: 'user', content: 'Q19:PROTOCOL-BAD-PAIR Reject a mismatched tool result.' };
    const badFirstResponse = await fetch(recorderUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [badUser], tools, tool_choice: 'required', thinking: { type: 'disabled' } })
    });
    assert.equal(badFirstResponse.status, 200);
    const badFirst = await badFirstResponse.json();
    const badCalls = badFirst.choices[0].message.tool_calls;
    const badSecondResponse = await fetch(recorderUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model, thinking: { type: 'disabled' },
        messages: [badUser, badFirst.choices[0].message,
          { role: 'tool', tool_call_id: 'call_not_matching', content: 'wrong id' },
          { role: 'tool', tool_call_id: badCalls[1].id, content: 'second result' }]
      })
    });
    assert.equal(badSecondResponse.status, 400, 'the strict recorder rejects an unmatched tool_call_id');
    assert.equal((await badSecondResponse.json()).error.code, 'RECORDED_PROTOCOL_TOOL_HISTORY_INVALID');

    await assert.rejects(requestChatCompletion({ messages: [userMessage], tools, toolChoice: 'required', thinkingMode: 'enabled',
      baseUrl: deepSeekUrl, apiKey, model, fetchImpl: async () => { throw new Error('unsupported payload must not be sent'); } }),
    error => error.code === 'MODEL_DEEPSEEK_TOOL_CHOICE_CONFLICT');

    const sensitiveMessages = [
      { role: 'system', content: 'PRIVATE_PROMPT_SENTINEL patient health details must never be retained' },
      { role: 'user', content: 'Q19:SAFE-ERROR PRIVATE_HEALTH_SENTINEL' }
    ];
    let diagnostic;
    try {
      await requestChatCompletion({ messages: sensitiveMessages, tools: [tools[0]], toolChoice: 'required', maxTokens: 123,
        baseUrl: deepSeekUrl, apiKey: 'sk-q19-fixture-only', model, fetchImpl: async () => new Response(JSON.stringify({ error: {
          type: 'invalid_request_error', code: 'unsupported_tool_choice',
          message: 'thinking mode does not support tool_choice required; echo PRIVATE_HEALTH_SENTINEL Bearer sk-q19-fixture-only'
        } }), { status: 400, headers: { 'content-type': 'application/json' } }) });
      assert.fail('the fixture HTTP 400 must be raised');
    } catch (error) { diagnostic = error.diagnostic; assert.equal(error.code, 'MODEL_HTTP_400'); }
    assert.equal(diagnostic.response.status, 400);
    assert.equal(diagnostic.response.type, 'invalid_request_error');
    assert.equal(diagnostic.response.code, 'unsupported_tool_choice');
    assert.match(diagnostic.response.message, /thinking mode does not support required or named tool choices/i);
    assert.equal(diagnostic.response.bodyTruncated, false);
    assert.equal(diagnostic.request.model, model);
    assert.equal(diagnostic.request.endpoint, 'api.deepseek.com/v1/chat/completions');
    assert.equal(diagnostic.request.thinking, 'disabled');
    assert.equal(diagnostic.request.toolChoice, 'required');
    assert.equal(diagnostic.request.toolCount, 1);
    assert.equal(diagnostic.request.maxTokens, 123);
    assert.deepEqual(diagnostic.request.messages.map(item => item.role), ['system', 'user']);
    const serializedDiagnostic = JSON.stringify(diagnostic);
    for (const forbidden of ['PRIVATE_PROMPT_SENTINEL', 'PRIVATE_HEALTH_SENTINEL', 'Bearer', 'sk-q19-fixture-only', 'patient health details']) {
      assert.equal(serializedDiagnostic.includes(forbidden), false, `safe diagnostic omits ${forbidden}`);
    }

    let cancelCount = 0;
    const largeBody = new TextEncoder().encode(JSON.stringify({ error: { type: 'invalid_request_error', code: 'unsupported_tool_choice',
      message: 'thinking mode does not support tool_choice required PRIVATE_HEALTH_SENTINEL ' + 'x'.repeat(6000) } }));
    const oversizedStream = new ReadableStream({
      start(controller) {
        controller.enqueue(largeBody.subarray(0, 2048));
        controller.enqueue(largeBody.subarray(2048, 4096));
        controller.enqueue(largeBody.subarray(4096));
      },
      cancel() { cancelCount += 1; }
    });
    let oversizedDiagnostic;
    try {
      await requestChatCompletion({ messages: [userMessage], tools: [tools[0]], toolChoice: 'required',
        baseUrl: deepSeekUrl, apiKey, model, fetchImpl: async () => new Response(oversizedStream, { status: 400 }) });
      assert.fail('the oversized fixture HTTP 400 must be raised');
    } catch (error) { oversizedDiagnostic = error.diagnostic; assert.equal(error.code, 'MODEL_HTTP_400'); }
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(oversizedDiagnostic.response.bodyBytesRead, 4096);
    assert.equal(oversizedDiagnostic.response.bodyTruncated, true);
    assert.equal(cancelCount, 1, 'oversized response body was cancelled at the byte limit');
    assert.equal(JSON.stringify(oversizedDiagnostic).includes('PRIVATE_HEALTH_SENTINEL'), false);

    return 'DeepSeek adapter and strict fixture accept disabled+required and enabled+auto, preserve each mode through exact tool_call_id results and no-tools continuation, reject enabled+required/named choices, and retain only bounded redacted HTTP 400 diagnostics.';
  } finally { await provider.close(); }
}

async function q192() {
  const publicTools = getAssistantToolDefinitions('public');
  const privateTools = getAssistantToolDefinitions('guest', { guestId: 'synthetic-guest' });
  assert.ok(publicTools.some(item => item.function.name === 'list_projects'));
  assert.equal(publicTools.some(item => item.function.name === 'get_health_summary'), false);
  assert.ok(privateTools.some(item => item.function.name === 'get_health_summary'));
  assert.ok(privateTools.every(item => item.type === 'function' && item.function.parameters.additionalProperties === false));
  assert.equal(validateToolArguments('list_project_slots', { projectId: 'project-spa', date: '2024-02-29' }, 'public').tool.name, 'list_project_slots');
  assert.equal(validateToolArguments('list_project_slots', { projectId: 'project-spa' }, 'public').tool.name, 'list_project_slots');
  assert.throws(() => validateToolArguments('list_project_slots', {}, 'public'), error => error.code === 'TOOL_ARGUMENTS_INVALID');
  assert.throws(() => validateToolArguments('list_project_slots', { projectId: 17 }, 'public'), error => error.code === 'TOOL_ARGUMENTS_INVALID');
  assert.throws(() => validateToolArguments('list_project_slots', { projectId: 'project-spa', date: 20261010 }, 'public'),
    error => error.code === 'TOOL_ARGUMENTS_INVALID');
  assert.throws(() => validateToolArguments('list_projects', { search: 'a', actorId: 'spoof' }, 'public'), error => error.code === 'TOOL_ARGUMENTS_INVALID');
  assert.throws(() => validateToolArguments('get_health_summary', {}, 'public'), error => error.code === 'TOOL_FORBIDDEN');
  for (const date of ['2026-02-30', '2026-13-01', '2023-02-29']) {
    assert.throws(() => validateToolArguments('list_project_slots', { projectId: 'project-spa', date }, 'public'),
      error => error.code === 'TOOL_ARGUMENTS_INVALID', `reject impossible calendar date ${date}`);
  }
  let executorCalls = 0;
  for (const date of ['2026-02-30', '2026-13-01', '2023-02-29']) {
    const result = await runAssistantTool('list_project_slots', { projectId: 'project-spa', date }, {
      role: 'public', executor: async () => { executorCalls += 1; return { data: {} }; }
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'TOOL_ARGUMENTS_INVALID');
  }
  assert.equal(executorCalls, 0, 'calendar validation fails before the tool executor is invoked');
  const mixed = classifyAssistantIntent('查一个放松项目，同时查看今天的天气和环境');
  assert.equal(mixed.category, 'mixed');
  assert.ok(mixed.toolNames.includes('list_projects') && mixed.toolNames.includes('get_environment_snapshot'));
  return 'Role-filtered schemas reject spoofed fields and impossible dates before execution; leap day validates and mixed intents retain both tool domains.';
}

async function q193({ stage, live, liveConfig }) {
  if (live) return await runLiveChain({ stage, liveConfig, questId: 'Q19.3' });
  const provider = await startRecordedModel();
  try {
    const result = await forDrivers(stage, async context => {
      const fixture = await insertSlotFixture(context);
      const date = String(fixture.expected.businessDate).slice(0, 10);
      const start = await postAsyncRun(context, { text: `Q19:SLOTS 请查询水疗 SPA 项目 ${date} 的剩余名额，并说明时段来源。` });
      const duplicate = await request(context.baseUrl, '/assistant/chat', { method: 'POST', body: start.body });
      assert.equal(duplicate.status, 202);
      assert.equal(duplicate.data.runId, start.runId, 'idempotent retry keeps the same runId');
      const run = await waitForRun(context.baseUrl, start.runId, 'public');
      assert.equal(run.status, 'completed', `recorded tool round-trip failed: ${JSON.stringify(run)}\n${await lastManagedApiLog()}`);
      assert.equal(run.live, true, 'local provider fixture reached the real adapter and API');
      assert.ok(run.steps.some(item => item.type === 'tool' && item.status === 'completed'));
      assert.match(run.reply, new RegExp(`剩余 ${Number(fixture.expected.availableCount)} 个名额`));
      assert.ok(run.sources.some(item => item.type === 'project_slot' && item.id === fixture.id));
      const executions = await databaseQuery(context, `SELECT tool_name,tool_call_id,status,error_code,arguments_json,result_json,source_json
        FROM tool_executions WHERE run_id=? ORDER BY started_at,id`, [run.runId]);
      const execution = executions.find(item => item.tool_name === 'list_project_slots');
      assert.ok(execution, 'the fixture executed the read-only slot tool');
      assert.match(execution.tool_call_id, /^call_stage19_slots/);
      assert.equal(execution.status, 'completed');
      const args = typeof execution.arguments_json === 'string' ? JSON.parse(execution.arguments_json) : execution.arguments_json;
      assert.deepEqual(args, { projectId: 'project-spa', date });
      const resultData = typeof execution.result_json === 'string' ? JSON.parse(execution.result_json) : execution.result_json;
      const slot = resultData.slots.find(item => item.id === fixture.id);
      assert.ok(slot);
      assert.deepEqual({ id: slot.id, status: slot.status, availableCount: slot.availableCount },
        { id: fixture.id, status: 'listed', availableCount: Number(fixture.expected.availableCount) });
      const trace = await databaseQuery(context, `SELECT step_index,step_type,status,summary,input_tokens,output_tokens,estimated_cost_usd
        FROM agent_steps WHERE run_id=? ORDER BY step_index`, [run.runId]);
      recordStageEvidence({ quest: 'Q19.3.fixture', driver: context.driver, runId: run.runId, intentCategory: run.intentCategory,
        finalAnswer: run.reply, model: run.model, provider: run.provider, inputTokens: run.inputTokens, outputTokens: run.outputTokens,
        estimatedCostUsd: run.estimatedCostUsd, slotDatabaseAssertion: { id: fixture.id, projectId: fixture.expected.projectId,
          date: String(fixture.expected.businessDate).slice(0, 10), capacity: Number(fixture.expected.capacity),
          reservedCount: Number(fixture.expected.reservedCount), availableCount: Number(fixture.expected.availableCount) },
        modelSteps: trace.filter(step => step.step_type === 'model'), toolExecutions: executions.map(item => ({ ...item,
          arguments_json: typeof item.arguments_json === 'string' ? JSON.parse(item.arguments_json) : item.arguments_json,
          result_json: typeof item.result_json === 'string' ? JSON.parse(item.result_json) : item.result_json,
          source_json: typeof item.source_json === 'string' ? JSON.parse(item.source_json) : item.source_json })) });
      return `${context.driver}: same-run idempotency, list_project_slots arguments/result, source ${fixture.id}, and database availability (5-1=4) match the final answer.`;
    }, fixtureModelEnv(provider));
    return ['Recorded fixture only; this is not a live-provider PASS.', ...(Array.isArray(result) ? result : [result])];
  } finally { await provider.close(); }
}

async function q194({ stage }) {
  const provider = await startRecordedModel();
  try {
    const results = await forDrivers(stage, async context => {
      const guest = assertOk(await login(context.baseUrl, 'guest'), 200, 'guest login for mixed-domain tools');
      const start = await postAsyncRun(context, { role: 'guest', token: guest.token, guestId: guest.user.id,
        text: 'Q19:MIXED 请查一下 SPA 项目，并同时查看 2026-10-10 的天气环境。' });
      const run = await waitForRun(context.baseUrl, start.runId, 'guest', guest.token);
      assert.equal(run.status, 'completed');
      assert.equal(run.intentCategory, 'mixed');
      assert.match(run.reply, /水疗 SPA/);
      assert.match(run.reply, /环境快照暂不可用/);
      assert.ok(run.sources.some(source => source.type === 'project'));
      const executions = await databaseQuery(context, `SELECT tool_call_id,tool_name,status,error_code,arguments_json,result_json,source_json
        FROM tool_executions WHERE run_id=? ORDER BY started_at,id`, [run.runId]);
      assert.equal(executions.length, 2);
      assert.deepEqual(executions.map(row => row.tool_call_id).sort(), ['call_stage19_environment', 'call_stage19_project']);
      const project = executions.find(row => row.tool_name === 'list_projects');
      const environment = executions.find(row => row.tool_name === 'get_environment_snapshot');
      assert.equal(project.status, 'completed');
      assert.equal(environment.status, 'failed');
      assert.equal(environment.error_code, 'TOOL_TIMEOUT');
      const projectData = typeof project.result_json === 'string' ? JSON.parse(project.result_json) : project.result_json;
      assert.ok(projectData.some(item => item.id === 'project-spa'));
      const modelSteps = await databaseQuery(context, `SELECT step_index,status,summary FROM agent_steps
        WHERE run_id=? AND step_type='model' ORDER BY step_index`, [run.runId]);
      assert.equal(modelSteps.length, 2);
      assert.match(modelSteps[0].summary, /产生 2 个工具调用/);
      const classification = classifyAssistantIntent('查询 SPA 项目并查看天气环境');
      assert.ok(classification.toolNames.includes('list_projects') && classification.toolNames.includes('get_environment_snapshot'));
      recordStageEvidence({ quest: 'Q19.4', driver: context.driver, runId: run.runId, intentCategory: run.intentCategory,
        actorId: guest.user.id, finalAnswer: run.reply, modelSteps,
        toolExecutions: executions.map(item => ({ ...item,
          arguments_json: typeof item.arguments_json === 'string' ? JSON.parse(item.arguments_json) : item.arguments_json,
          result_json: typeof item.result_json === 'string' ? JSON.parse(item.result_json) : item.result_json })) });
      return `${context.driver}: one model response issued both tools; project result and source survived the environment timeout with matching tool_call_id records.`;
    }, { ...fixtureModelEnv(provider), NODE_ENV: 'test', Q19_ACCEPTANCE_HOOKS: '1', Q19_TEST_ENV_TOOL_TIMEOUT_MS: '25' });
    return Array.isArray(results) ? results : [results];
  } finally { await provider.close(); }
}

async function q195({ stage }) {
  const status = assistantStatus();
  assert.ok(status.timeoutMs <= 60_000 && status.toolTimeoutMs <= 15_000 && status.maxRunMs <= 90_000 && status.maxToolRounds <= 4);
  assert.ok(status.maxModelCalls >= 1 && status.maxToolCalls >= 1 && status.maxRunTokens >= 1);
  assert.equal(status.modelRateEstimate.kind, 'budget_estimate_not_invoice');
  const timed = await runAssistantTool('list_projects', {}, {
    role: 'public', timeoutMs: 10,
    executor: async () => await new Promise(resolve => setTimeout(() => resolve({ data: [] }), 40))
  });
  assert.equal(timed.status, 'failed');
  assert.equal(timed.errorCode, 'TOOL_TIMEOUT');
  assert.match(timed.data.error, /超时/);

  const provider = await startRecordedModel();
  try {
    const cases = [
      { marker: 'Q19:MANY', env: { ASSISTANT_MAX_TOOL_CALLS: '2', LLM_TIMEOUT_MS: '90000' }, modelSteps: 1, tools: 2, answer: /工具调用数量上限/ },
      { marker: 'Q19:LOOP-MODEL', env: { ASSISTANT_MAX_MODEL_CALLS: '2' }, modelSteps: 2, tools: 1, answer: /模型调用次数上限/ },
      { marker: 'Q19:LOOP-ROUND', env: { ASSISTANT_MAX_TOOL_ROUNDS: '1' }, modelSteps: 2, tools: 1, answer: /工具调用轮次上限/ },
      { marker: 'Q19:LOW-TOKENS', env: { ASSISTANT_MAX_TOKENS: '1' }, modelSteps: 0, tools: 0,
        answer: /剩余预算不足以安全发送模型请求/, preflightBlocked: true, rejectionCode: 'GRAPH_TOKEN_BUDGET' },
      { marker: 'Q19:LOW-COST', env: { ASSISTANT_MAX_ESTIMATED_COST_USD: '0.00000001' }, modelSteps: 0, tools: 0,
        answer: /剩余预算不足以安全发送模型请求/, preflightBlocked: true, rejectionCode: 'GRAPH_COST_BUDGET' },
      { marker: 'Q19:SLOW', env: { ASSISTANT_MAX_RUNTIME_MS: '350', LLM_TIMEOUT_MS: '10000' }, modelSteps: 1, tools: 0, answer: null, failed: true }
    ];
    for (const testCase of cases) {
      const results = await forDrivers(stage, async context => {
        const startedAt = Date.now();
        const scenario = `${testCase.marker}-${context.driver.toUpperCase()}`;
        const start = await postAsyncRun(context, { text: `${scenario} budget boundary` });
        const run = await waitForRun(context.baseUrl, start.runId, 'public');
        assert.equal(run.status, testCase.failed ? 'failed' : 'completed', `${testCase.marker}/${context.driver}: ${run.errorCode || run.status}`);
        const persistedModelStepCount = Number(await databaseQuery(context, "SELECT COUNT(*) AS count FROM agent_steps WHERE run_id=? AND step_type='model'", [run.runId], 'get').then(row => row.count));
        assert.equal(persistedModelStepCount, testCase.modelSteps);
        const timedModelSteps = (run.steps || []).filter(step => step.type === 'model');
        assert.equal(timedModelSteps.length, testCase.modelSteps);
        assert.ok(timedModelSteps.every(step => Number.isFinite(step.durationMs) && step.durationMs > 0),
          `${testCase.marker}/${context.driver} stores measured time for completed and failed model requests`);
        assert.equal(Number(await databaseQuery(context, 'SELECT COUNT(*) AS count FROM tool_executions WHERE run_id=?', [run.runId], 'get').then(row => row.count)), testCase.tools);
        if (testCase.preflightBlocked) {
          const preflight = run.steps.at(-1)?.diagnostic?.modelPreflight;
          assert.equal(run.modelCallCount, 0, `${testCase.marker}/${context.driver} uses no provider request`);
          assert.equal(preflight?.providerRequestAttempted, false);
          assert.equal(preflight?.rejectionCode, testCase.rejectionCode);
        }
        if (testCase.answer) assert.match(run.reply, testCase.answer);
        if (testCase.failed) {
          assert.equal(run.errorCode, 'RUN_ABORTED');
          assert.ok(Date.now() - startedAt < 5_000, 'overall runtime cap aborts the pending provider request promptly');
        }
        if (testCase.marker === 'Q19:MANY') {
          const configured = assertOk(await request(context.baseUrl, '/assistant/status'), 200, 'runtime configuration');
          assert.equal(configured.maxToolCalls, 2);
          assert.equal(configured.timeoutMs, 60_000, 'configured model timeout is capped at 60 seconds');
          assert.equal(configured.toolTimeoutMs, 15_000, 'tool timeout is capped at 15 seconds');
        }
        recordStageEvidence({ quest: 'Q19.5', case: testCase.marker, driver: context.driver, runId: run.runId,
          status: run.status, errorCode: run.errorCode, reply: run.reply,
          preflightBlocked: Boolean(testCase.preflightBlocked),
          preflightRejectionCode: testCase.preflightBlocked ? run.steps.at(-1)?.diagnostic?.modelPreflight?.rejectionCode : null,
          modelSteps: await databaseQuery(context, `SELECT step_index,status,summary,duration_ms AS durationMs,input_tokens,output_tokens,estimated_cost_usd
            FROM agent_steps WHERE run_id=? AND step_type='model' ORDER BY step_index`, [run.runId]),
          toolExecutions: await databaseQuery(context, `SELECT tool_name,tool_call_id,status,error_code,arguments_json,result_json
            FROM tool_executions WHERE run_id=? ORDER BY started_at,id`, [run.runId]) });
        return `${testCase.marker}/${context.driver}: ${testCase.modelSteps} model steps, ${testCase.tools} tools, and the configured stop condition held.`;
      }, { ...fixtureModelEnv(provider), ...testCase.env });
      if (Array.isArray(results)) assert.equal(results.length, 2);
    }
    return 'Model requests (<=60s), tool calls (<=15s), total tools, model calls, tool rounds, tokens, estimated cost and overall runtime were exercised with short controlled budgets.';
  } finally { await provider.close(); }
}

async function q196({ stage }) {
  const provider = await startRecordedModel();
  try {
    const result = await forDrivers(stage, async context => {
      const target = await addAssignedSyntheticGuest(context);
      const guest = assertOk(await login(context.baseUrl, 'guest'), 200, 'guest login');
      assert.ok(await databaseQuery(context, 'SELECT id FROM users WHERE id=? AND role=?', [target.guestId, 'guest'], 'get'),
        'the denied target is a real guest account, not a missing-id 404 fixture');
      const denied = await request(context.baseUrl, '/assistant/chat', {
        method: 'POST', token: guest.token,
        body: { role: 'guest', guestId: target.guestId, text: 'Q19:FORGE 请读取另一位客人的档案。', clientRequestId: crypto.randomUUID() }
      });
      assert.equal(denied.status, 403, 'a guest cannot read a different existing guest');
      const staff = assertOk(await login(context.baseUrl, 'staff'), 200, 'assigned clinician login');
      const start = assertOk(await request(context.baseUrl, '/assistant/chat', {
        method: 'POST', token: staff.token,
        body: { async: true, role: 'staff', guestId: target.guestId, actorId: guest.user.id,
          text: 'Q19:STAFF 请查看当前负责客人的档案摘要。', clientRequestId: crypto.randomUUID() }
      }), 202, 'assigned clinician run');
      const run = await waitForRun(context.baseUrl, start.runId, 'staff', staff.token);
      assert.equal(run.status, 'completed');
      assert.equal(run.live, true);
      const runRow = await databaseQuery(context, 'SELECT actor_id,assistant_role FROM agent_runs WHERE id=?', [run.runId], 'get');
      assert.equal(runRow.actor_id, staff.user.id, 'actor identity comes from the authenticated server session, not actorId in the request body');
      assert.equal(runRow.assistant_role, 'staff');
      const execution = await databaseQuery(context, `SELECT status,error_code,tool_name,arguments_json,result_json,source_json
        FROM tool_executions WHERE run_id=?`, [run.runId], 'get');
      assert.equal(execution.status, 'completed');
      assert.equal(execution.tool_name, 'get_guest_profile');
      const args = typeof execution.arguments_json === 'string' ? JSON.parse(execution.arguments_json) : execution.arguments_json;
      assert.deepEqual(args, {});
      const sources = typeof execution.source_json === 'string' ? JSON.parse(execution.source_json) : execution.source_json;
      assert.ok(sources.some(source => source.type === 'guest_profile' && source.id === target.guestId));
      assert.ok(run.sources.some(source => source.type === 'guest_profile' && source.id === target.guestId));
      recordStageEvidence({ quest: 'Q19.6', driver: context.driver, deniedExistingGuest: target.guestId,
        deniedStatus: denied.status, clinicianRunId: run.runId, authenticatedActorId: staff.user.id,
        storedActorId: runRow.actor_id, assignedGuestId: target.guestId, toolName: execution.tool_name,
        toolArguments: args, toolStatus: execution.status, sourceIds: sources.map(source => source.id) });
      return `${context.driver}: guest access to another existing guest returned 403; assigned clinician read that guest, and persisted actor_id matched the authenticated staff account despite a spoof field.`;
    }, fixtureModelEnv(provider));
    return Array.isArray(result) ? result : [result];
  } finally { await provider.close(); }
}

async function q197({ stage }) {
  const provider = await startRecordedModel();
  try {
    const result = await forDrivers(stage, async context => {
      const start = await postAsyncRun(context, { text: 'Q19:PROJECT 请查询项目来源。' });
      const run = await waitForRun(context.baseUrl, start.runId, 'public');
      const stored = await databaseQuery(context, 'SELECT status,input_text,output_text,input_tokens,output_tokens,estimated_cost_usd FROM agent_runs WHERE id=?', [run.runId], 'get');
      assert.equal(stored.status, 'completed');
      assert.match(stored.input_text, /Q19:PROJECT/);
      assert.ok(stored.output_text);
      assert.ok(Number(stored.input_tokens) > 0 && Number(stored.output_tokens) > 0);
      assert.ok(Number(stored.estimated_cost_usd) >= 0);
      assert.ok((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM agent_steps WHERE run_id=?', [run.runId], 'get')).count >= 3);
      assert.equal((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM tool_executions WHERE run_id=?', [run.runId], 'get')).count, 1);
      const first = await request(context.baseUrl, `/assistant/history?sessionId=${encodeURIComponent(run.sessionId)}&role=public&limit=1`);
      assert.equal(first.status, 200);
      assert.equal(first.data.hasMore, true);
      const second = await request(context.baseUrl, `/assistant/history?sessionId=${encodeURIComponent(run.sessionId)}&role=public&limit=1&beforeId=${first.data.nextBeforeId}`);
      assert.equal(second.status, 200);
      assert.equal(second.data.messages.length, 1);
      const fetched = await request(context.baseUrl, `/assistant/runs/${encodeURIComponent(run.runId)}?role=public`);
      assert.equal(fetched.status, 200);
      assert.equal(fetched.data.runId, run.runId);
      assert.ok(fetched.data.sources.length);
      return `${context.driver}: run/step/tool/source provenance survives history paging and same-run refresh.`;
    }, fixtureModelEnv(provider));
    return Array.isArray(result) ? result : [result];
  } finally { await provider.close(); }
}

async function q198({ stage }) {
  const provider = await startRecordedModel();
  const effectRoot = await activeResourceSession.allocateDir(`q19-write-recovery-${crypto.randomUUID()}`);
  try {
    const env = { ...fixtureModelEnv(provider), NODE_ENV: 'test', Q19_ACCEPTANCE_HOOKS: '1',
      Q19_TEST_EFFECT_ROOT: effectRoot, Q19_TEST_EFFECT_PATH: 'effect-{driver}.json' };
    const result = await forDrivers(stage, async context => {
      const marker = `Q19:RETRY-${context.driver.toUpperCase()}`;
      const start = await postAsyncRun(context, { text: `${marker} 请查找 SPA 项目。` });
      const failed = await waitForRun(context.baseUrl, start.runId, 'public');
      assert.equal(failed.status, 'failed');
      assert.equal(failed.errorCode, 'MODEL_HTTP_503');
      assert.equal((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM tool_executions WHERE run_id=?', [start.runId], 'get')).count, 1);
      const retried = await request(context.baseUrl, `/assistant/runs/${encodeURIComponent(start.runId)}/retry`, {
        method: 'POST', body: { role: 'public' }
      });
      assert.ok([200, 202].includes(retried.status));
      const done = await waitForRun(context.baseUrl, start.runId, 'public');
      assert.equal(done.status, 'completed');
      assert.equal((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM tool_executions WHERE run_id=?', [start.runId], 'get')).count, 1,
        'recovery reuses the persisted idempotent read result');
      assert.ok(done.steps.some(step => step.type === 'tool' && step.status === 'reused'));
      const apiStatus = assertOk(await request(context.baseUrl, '/assistant/status'), 200, 'product tool registry');
      assert.equal(apiStatus.tools.includes('q19_test_write_once'), false, 'the write stub is absent from the production registry');

      const writeMarker = `Q19:WRITE-RECOVERY-${context.driver.toUpperCase()}`;
      const writeStart = await postAsyncRun(context, { text: `${writeMarker} 请使用隔离的一次性恢复写入桩。` });
      const effectPath = path.join(effectRoot, `effect-${context.driver}.json`);
      const effectDeadline = Date.now() + 8_000;
      let savedExecution;
      while (Date.now() < effectDeadline) {
        savedExecution = await databaseQuery(context, 'SELECT tool_call_id,status,result_json FROM tool_executions WHERE run_id=?', [writeStart.runId], 'get');
        if (savedExecution?.status === 'completed') break;
        await new Promise(resolve => setTimeout(resolve, 75));
      }
      assert.equal(savedExecution?.status, 'completed', 'the side effect and tool result are persisted before API restart');
      assert.equal(JSON.parse(fs.readFileSync(effectPath, 'utf8')).writeCount, 1);
      context.baseUrl = await context.restartApi();
      const interrupted = await waitForRun(context.baseUrl, writeStart.runId, 'public');
      assert.equal(interrupted.status, 'interrupted', 'API restart leaves the same run recoverable');
      const writeRetryResponse = await request(context.baseUrl, `/assistant/runs/${encodeURIComponent(writeStart.runId)}/retry`, {
        method: 'POST', body: { role: 'public' }
      });
      assert.ok([200, 202].includes(writeRetryResponse.status));
      const recovered = await waitForRun(context.baseUrl, writeStart.runId, 'public');
      assert.equal(recovered.status, 'completed');
      assert.match(recovered.reply, /没有重复执行副作用/);
      assert.equal(JSON.parse(fs.readFileSync(effectPath, 'utf8')).writeCount, 1, 'retry reuses the persisted write result');
      assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM tool_executions WHERE run_id=?', [writeStart.runId], 'get')).count), 1);
      const writeExecution = await databaseQuery(context, 'SELECT status,result_json,source_json FROM tool_executions WHERE run_id=?', [writeStart.runId], 'get');
      const writeResult = typeof writeExecution.result_json === 'string' ? JSON.parse(writeExecution.result_json) : writeExecution.result_json;
      assert.equal(writeResult.writeCount, 1);
      assert.ok(recovered.steps.some(step => step.type === 'tool' && step.status === 'reused'));
      recordStageEvidence({ quest: 'Q19.8.write-recovery', driver: context.driver, runId: writeStart.runId,
        toolCallId: savedExecution.tool_call_id, effectCount: JSON.parse(fs.readFileSync(effectPath, 'utf8')).writeCount,
        toolExecutionCount: 1, persistedResult: writeResult, recoveredStatus: recovered.status,
        reusedCheckpoint: recovered.steps.some(step => step.type === 'tool' && step.status === 'reused') });
      return `${context.driver}: ordinary read retry reused its checkpoint; test-only write side effect and result survived API restart under the same runId with counts 1/1.`;
    }, env);
    return Array.isArray(result) ? result : [result];
  } finally {
    await provider.close();
    await fs.promises.rm(effectRoot, { recursive: true, force: true });
  }
}

async function q199({ stage }) {
  const categories = new Map([
    ['今天有什么预约日程？', 'schedule'], ['有哪些康养项目？', 'projects'], ['查看今天的餐单', 'meals'],
    ['查看健康指标', 'health'], ['查看我的心情', 'mood'], ['查看个人档案', 'profile'], ['你好', 'general']
  ]);
  for (const [text, expected] of categories) assert.equal(classifyAssistantIntent(text).category, expected);
  const provider = await startRecordedModel();
  try {
    const result = await forDrivers(stage, async context => {
    const first = assertOk(await request(context.baseUrl, '/assistant/chat', {
      method: 'POST', body: { role: 'public', text: '请查看我的健康档案', clientRequestId: crypto.randomUUID() }
    }), 200, 'first privacy clarification');
    assert.match(first.reply, /登录/);
    const second = assertOk(await request(context.baseUrl, '/assistant/chat', {
      method: 'POST', body: { role: 'public', sessionId: first.sessionId, text: '仍然想看健康记录', clientRequestId: crypto.randomUUID() }
    }), 200, 'second privacy clarification');
    assert.equal(second.sessionId, first.sessionId);
    const third = assertOk(await request(context.baseUrl, '/assistant/chat', {
      method: 'POST', body: { role: 'public', sessionId: first.sessionId, text: '继续查健康记录', clientRequestId: crypto.randomUUID() }
    }), 200, 'bounded handoff');
    assert.match(third.reply, /工作人员/);
    const clarifications = await databaseQuery(context, `SELECT COUNT(*) AS count FROM agent_steps s
      JOIN agent_runs r ON r.id=s.run_id WHERE r.session_id=? AND s.step_type='clarification'`, [first.sessionId], 'get');
    assert.equal(Number(clarifications.count), 3);
    const counts = await databaseQuery(context, 'SELECT MAX(clarification_count) AS count FROM agent_runs WHERE session_id=?', [first.sessionId], 'get');
    assert.equal(Number(counts.count), 2);
    assert.equal((await databaseQuery(context, "SELECT COUNT(*) AS count FROM agent_runs WHERE session_id=? AND intent_category='schedule'", [first.sessionId], 'get')).count, 0,
      'privacy clarifications are tracked separately from appointment business clarifications');

    const guest = assertOk(await login(context.baseUrl, 'guest'), 200, 'guest login for business clarifications');
    const relax = await postAsyncRun(context, { role: 'guest', token: guest.token, guestId: guest.user.id,
      text: 'Q19:RELAX 我想轻松点，帮我找适合放松的项目。' });
    const relaxed = await waitForRun(context.baseUrl, relax.runId, 'guest', guest.token);
    assert.equal(relaxed.status, 'completed');
    assert.equal(relaxed.intentCategory, 'projects');
    assert.ok(relaxed.steps.some(step => step.type === 'tool'));
    assert.equal((await databaseQuery(context, 'SELECT tool_name FROM tool_executions WHERE run_id=?', [relaxed.runId], 'get')).tool_name, 'list_projects');

    const cross = await postAsyncRun(context, { role: 'guest', token: guest.token, guestId: guest.user.id,
      text: 'Q19:MIXED 请查找一个 SPA 项目，并一并查看当前天气环境。' });
    const mixed = await waitForRun(context.baseUrl, cross.runId, 'guest', guest.token);
    assert.equal(mixed.status, 'completed');
    assert.equal(mixed.intentCategory, 'mixed');
    assert.match(mixed.reply, /水疗 SPA/);
    assert.match(mixed.reply, /环境快照暂不可用/);
    const mixedExecutions = await databaseQuery(context, 'SELECT tool_name,status,error_code,tool_call_id FROM tool_executions WHERE run_id=?', [mixed.runId]);
    assert.equal(mixedExecutions.length, 2);
    assert.ok(mixedExecutions.some(item => item.tool_name === 'list_projects' && item.status === 'completed'));
    assert.ok(mixedExecutions.some(item => item.tool_name === 'get_environment_snapshot' && item.error_code === 'TOOL_TIMEOUT'));
    recordStageEvidence({ quest: 'Q19.9.cross-domain', driver: context.driver, runId: mixed.runId,
      actorId: guest.user.id, intentCategory: mixed.intentCategory, finalAnswer: mixed.reply,
      toolExecutions: mixedExecutions });

    const fixture = await insertSlotFixture(context, `appointment-${context.driver}`);
    const reservationsBefore = Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM reservations', [], 'get')).count);
    const firstMissing = await postAsyncRun(context, { role: 'guest', token: guest.token, guestId: guest.user.id,
      text: 'Q19:APPOINTMENT 我想预约 SPA。' });
    const firstMissingRun = await waitForRun(context.baseUrl, firstMissing.runId, 'guest', guest.token);
    assert.equal(firstMissingRun.clarificationCount, 0, 'a legal missing card field is not a model understanding failure');
    const firstCard = firstMissingRun.actionCards?.at(-1);
    assert.equal(firstCard?.actionType, 'book_program');
    assert.equal(firstCard?.status, 'needs_input');
    assert.ok(firstCard?.missingFields.includes('日期'));

    const secondStep = await postAsyncRun(context, { role: 'guest', token: guest.token, guestId: guest.user.id,
      sessionId: firstMissing.sessionId, text: 'Q19:APPOINTMENT-DATE 我想预约 SPA 项目，日期 2026-10-07。' });
    const secondMissingRun = await waitForRun(context.baseUrl, secondStep.runId, 'guest', guest.token);
    assert.equal(secondMissingRun.clarificationCount, 0);
    const secondCard = secondMissingRun.actionCards?.at(-1);
    assert.equal(secondCard?.status, 'needs_input');
    assert.ok(secondCard?.missingFields.includes('本人选择的时段'));

    const thirdStep = await postAsyncRun(context, { role: 'guest', token: guest.token, guestId: guest.user.id,
      sessionId: firstMissing.sessionId,
      text: `Q19:APPOINTMENT-SLOT 我想预约 SPA 项目，日期 2026-10-07，我选择时段编号 ${fixture.id}。` });
    const thirdRun = await waitForRun(context.baseUrl, thirdStep.runId, 'guest', guest.token);
    const confirmationCard = thirdRun.actionCards?.at(-1);
    assert.equal(confirmationCard?.status, 'pending_confirmation',
      `only the selected available slot advances to confirmation: ${JSON.stringify(confirmationCard)}`);
    const cardVersions = await databaseQuery(context, `SELECT version,status,parent_card_id FROM assistant_action_cards
      WHERE logical_action_id=(SELECT logical_action_id FROM assistant_action_cards WHERE id=?) ORDER BY version`, [confirmationCard.id]);
    assert.deepEqual(cardVersions.map(row => [Number(row.version), row.status]), [
      [1, 'superseded'], [2, 'superseded'], [3, 'pending_confirmation']
    ]);
    assert.equal(Number((await databaseQuery(context, 'SELECT COUNT(*) AS count FROM reservations', [], 'get')).count), reservationsBefore,
      'booking proposals do not create a reservation before card confirmation');
    const appointmentTool = await databaseQuery(context, 'SELECT tool_name,arguments_json FROM tool_executions WHERE run_id=?', [thirdRun.runId], 'get');
    assert.equal(appointmentTool.tool_name, 'propose_program_booking');
    const appointmentArgs = typeof appointmentTool.arguments_json === 'string' ? JSON.parse(appointmentTool.arguments_json) : appointmentTool.arguments_json;
    assert.deepEqual(appointmentArgs, { projectId: 'project-spa', date: '2026-10-07', slotId: fixture.id });
    recordStageEvidence({ quest: 'Q19.9.appointment', driver: context.driver, sessionId: firstMissing.sessionId,
      runIds: [firstMissingRun.runId, secondMissingRun.runId, thirdRun.runId],
      clarificationCounts: [firstMissingRun.clarificationCount, secondMissingRun.clarificationCount, thirdRun.clarificationCount],
      missingFields: [firstCard.missingFields, secondCard.missingFields], cardVersions,
      finalCardId: confirmationCard.id, finalTool: appointmentTool.tool_name,
      finalArguments: appointmentArgs, sourceSlotId: fixture.id, reservationCountUnchanged: true });
    return `${context.driver}: intent union called project and environment tools; guest booking questions advanced through persisted missing-field cards to a selected-slot confirmation without creating a reservation.`;
  }, { ...fixtureModelEnv(provider), NODE_ENV: 'test', Q19_ACCEPTANCE_HOOKS: '1', Q19_TEST_ENV_TOOL_TIMEOUT_MS: '25' });
    return Array.isArray(result) ? result : [result];
  } finally { await provider.close(); }
}

function q1910() {
  const source = fs.readFileSync(UI_SOURCE, 'utf8');
  const css = fs.readFileSync(CSS_SOURCE, 'utf8');
  for (const marker of ['async: true', 'clientRequestId', '/assistant/history?', '/assistant/runs/', 'sessionStorage', 'assistant-sources', '重试查询']) {
    assert.ok(source.includes(marker), `existing chat UI is missing ${marker}`);
  }
  assert.ok(source.includes('20_000'), 'UI should show a long-running progress state after 20 seconds');
  assert.ok(css.includes('.assistant-sources') && css.includes('.assistant-history-more'));
  return 'Existing chat surface uses runId polling, idempotent async requests, source cards, retry, history paging and a 20-second progress state.';
}

function q1911() {
  const source = fs.readFileSync(UI_SOURCE, 'utf8');
  assert.ok(source.includes('sessionStorage.setItem(storageKey'));
  assert.ok(source.includes('sessionStorage.getItem(storageKey'));
  assert.ok(source.includes('pollRun(saved.runId'));
  assert.ok(source.includes('retryAssistantRun') || source.includes('/retry'));
  return 'Session and active run identifiers restore after refresh; the same run can be polled or explicitly retried.';
}

async function runLiveChain({ liveConfig, questId }) {
  if (!liveConfig?.LLM_BASE_URL || !liveConfig?.LLM_API_KEY || !liveConfig?.LLM_MODEL) {
    const blocked = new Error('有效模型配置不可用');
    blocked.stageBlocked = true;
    throw blocked;
  }
  const startAt = Date.now();
  const liveEnv = {
    LLM_BASE_URL: liveConfig.LLM_BASE_URL,
    LLM_API_KEY: liveConfig.LLM_API_KEY,
    LLM_MODEL: liveConfig.LLM_MODEL
  };
  try {
    const result = await withDatabaseApi('sqlite', async context => {
      const slotFixture = questId === 'Q19.3' ? await insertSlotFixture(context, 'live') : null;
      const guest = questId === 'Q19.3'
        ? assertOk(await login(context.baseUrl, 'guest'), 200, 'guest login for live slot lookup')
        : null;
      const start = await postAsyncRun(context, { text: questId === 'Q19.3'
        ? '请查询水疗 SPA 项目在 2026-10-10 的时段和剩余名额。请调用 list_project_slots，使用 projectId="project-spa"、date="2026-10-10"，依据实际查询结果说明 slot ID、总容量、已占名额和剩余名额。不要猜测，也不要表示已经预约。'
        : '请通过项目目录只读工具查看康养项目，并概括一个项目名称。',
        ...(guest ? { role: 'guest', token: guest.token, guestId: guest.user.id } : {}) });
      const run = await waitForRun(context.baseUrl, start.runId, guest ? 'guest' : 'public', guest?.token);
      const modelSteps = await databaseQuery(context, `SELECT step_index,status,summary,input_tokens,output_tokens,estimated_cost_usd
        FROM agent_steps WHERE run_id=? AND step_type='model' ORDER BY step_index`, [run.runId]);
      const toolExecutions = await databaseQuery(context, `SELECT tool_name,tool_call_id,status,error_code,arguments_json,result_json,source_json
        FROM tool_executions WHERE run_id=? ORDER BY started_at,id`, [run.runId]);
      const decode = value => typeof value === 'string' ? JSON.parse(value) : value;
      recordStageEvidence({ quest: `${questId}.live`, runId: run.runId, status: run.status, errorCode: run.errorCode,
        finalAnswer: run.reply, model: run.model, provider: run.provider, inputTokens: run.inputTokens,
        outputTokens: run.outputTokens, estimatedCostUsd: run.estimatedCostUsd, modelSteps,
        slotDatabaseAssertion: slotFixture ? { id: slotFixture.id, projectId: slotFixture.expected.projectId,
          date: String(slotFixture.expected.businessDate).slice(0, 10), capacity: Number(slotFixture.expected.capacity),
          reservedCount: Number(slotFixture.expected.reservedCount), availableCount: Number(slotFixture.expected.availableCount) } : null,
        toolExecutions: toolExecutions.map(item => ({ ...item, arguments_json: decode(item.arguments_json),
          result_json: decode(item.result_json), source_json: decode(item.source_json) })) });
      assert.equal(run.status, 'completed', `live model run ended ${run.status} (${run.errorCode || 'no code'})`);
      assert.equal(run.live, true, 'LIVE_GATE_NOT_LIVE');
      assert.ok(['deepseek', 'openai-compatible'].includes(run.provider), 'LIVE_GATE_PROVIDER');
      assert.ok(run.model, 'LIVE_GATE_MODEL');
      assert.ok(run.inputTokens + run.outputTokens > 0, 'LIVE_GATE_USAGE');
      assert.ok(run.sources.length > 0, 'LIVE_GATE_SOURCES');
      if (questId === 'Q19.3') {
        const slotExecution = toolExecutions.find(item => item.tool_name === 'list_project_slots' && item.status === 'completed');
        assert.ok(slotExecution, 'LIVE_GATE_SLOT_TOOL');
        assert.deepEqual(decode(slotExecution.arguments_json), { projectId: 'project-spa', date: '2026-10-10' });
        const slot = decode(slotExecution.result_json).slots.find(item => item.id === slotFixture.id);
        assert.ok(slot, 'LIVE_GATE_SLOT_SOURCE');
        assert.deepEqual({ capacity: Number(slot.capacity), reservedCount: Number(slot.reservedCount), availableCount: Number(slot.availableCount) },
          { capacity: 5, reservedCount: 1, availableCount: 4 });
        assert.ok(run.sources.some(source => source.type === 'project_slot' && source.id === slotFixture.id));
        assert.match(run.reply, /(?:剩余|可用|空余).{0,8}4|4.{0,8}(?:个|名额)/, 'LIVE_GATE_FINAL_AVAILABILITY');
      } else {
        const toolCount = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM tool_executions WHERE run_id=? AND status=?', [run.runId, 'completed'], 'get');
        assert.ok(Number(toolCount.count) > 0, 'LIVE_GATE_TOOL_COUNT');
      }
      return { model: run.model, provider: run.provider, inputTokens: run.inputTokens, outputTokens: run.outputTokens,
        estimatedCostUsd: Number(run.estimatedCostUsd.toFixed(6)), runId: run.runId, sources: run.sources.map(source => source.id),
        ...(slotFixture ? { slotId: slotFixture.id, capacity: 5, reservedCount: 1, availableCount: 4, finalAnswer: run.reply } : {}) };
    }, { resourceSession: activeResourceSession, env: liveEnv });
    const detail = Array.isArray(result) ? result[0] : result;
    return [`REAL_MODEL_PASS ${JSON.stringify({ ...detail, durationMs: Date.now() - startAt })}`];
  } catch (error) {
    const runFailure = error?.code === 'ERR_ASSERTION'
      ? String(error.message).match(/live model run ended ([a-z]+) \((MODEL_[A-Z0-9_]+|no code)\)|\b(LIVE_GATE_[A-Z_]+)\b/i)
      : null;
    const safeCode = runFailure
      ? runFailure[3] || `${runFailure[1].toUpperCase()}_${runFailure[2]}`
      : error.code || error.message?.match(/MODEL_[A-Z0-9_]+|MODEL_HTTP_[0-9]+/)?.[0] || 'PROVIDER_ERROR';
    const blocked = new Error(`真实模型工具链未能验证（${safeCode}）；本次没有以录制夹具代替 live 结果`);
    blocked.stageBlocked = true;
    throw blocked;
  }
}

async function q1912({ stage, live, liveConfig }) {
  if (live) return await runLiveChain({ stage, liveConfig, questId: 'Q19.12' });
  const provider = await startRecordedModel();
  try {
    const result = await forDrivers(stage, async context => {
      const start = await postAsyncRun(context, { text: 'Q19:REASONING-UI 请从康养项目目录查询一个适合放松的项目。' });
      const run = await waitForRun(context.baseUrl, start.runId, 'public');
      assert.equal(run.status, 'completed');
      assert.ok(run.sources.length > 0 && run.steps.some(step => step.type === 'tool'));
      assert.equal(run.reply, '已依据只读结果完成答复。');
      assert.equal(JSON.stringify(run).includes('Q19_PRIVATE_REASONING_SENTINEL'), false,
        'provider reasoning remains internal and is not returned by the assistant API');
      return `${context.driver}: recorded end-to-end chain passed. It is explicitly a fixture, not a live-provider result.`;
    }, fixtureModelEnv(provider));
    return Array.isArray(result) ? result : [result];
  } finally { await provider.close(); }
}

const runners = {
  'Q19.1': async () => [await q191()],
  'Q19.2': async () => [await q192()],
  'Q19.3': q193,
  'Q19.4': q194,
  'Q19.5': async context => [await q195(context)],
  'Q19.6': q196,
  'Q19.7': q197,
  'Q19.8': q198,
  'Q19.9': q199,
  'Q19.10': async () => [q1910()],
  'Q19.11': async () => [q1911()],
  'Q19.12': q1912
};

export async function run({ questId, stage, live = false, liveConfig = null, resourceSession }) {
  if (!resourceSession) throw new Error('Stage19 requires a managed ResourceSession');
  activeResourceSession = resourceSession;
  const runner = runners[questId];
  if (!runner) throw new Error(`Unsupported Stage19 Quest: ${questId}`);
  const output = await runner({ stage, live, liveConfig });
  return { output: Array.isArray(output) ? output : [String(output)] };
}
