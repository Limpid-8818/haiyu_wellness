import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAIN_AGENT_CONTRACTS, HOUSEHOLD_AGENT } from '../../server/src/assistant-agents.js';
import { databaseQuery, request, withBothDatabaseApis, withDatabaseApi } from './q10-helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const recordedModel = path.join(projectRoot, 'scripts/resources/recorded-model-server.js');
const browserAcceptance = path.join(projectRoot, 'scripts/resources/stage20-browser-acceptance.js');
const evidencePath = path.join(projectRoot, 'output/resource-audit/stage20-execution-evidence-20261003.jsonl');
let activeResourceSession;

function recordEvidence(entry) {
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ recordedAt: new Date().toISOString(), taskId: process.env.CODEX_TASK_ID,
    worktree: projectRoot, ...entry });
  const bytes = Buffer.byteLength(line, 'utf8') + 1;
  const currentBytes = fs.existsSync(evidencePath) ? fs.statSync(evidencePath).size : 0;
  if (bytes > 48 * 1024 || currentBytes + bytes > 8 * 1024 * 1024) {
    throw new Error('Stage20 bounded execution evidence is at its configured size limit');
  }
  fs.appendFileSync(evidencePath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function chinaDate(offsetDays = 0) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date()).map(part => [part.type, part.value]));
  const shifted = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offsetDays));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('Q20 fixture port unavailable')));
    });
  });
}

async function startRecordedModel({ delayPlan = {} } = {}) {
  if (!activeResourceSession) throw new Error('Q20 requires a managed ResourceSession');
  const port = await reservePort();
  const resource = await activeResourceSession.startProcess({
    label: `q20-recorded-model-${crypto.randomUUID().slice(0, 8)}`, kind: 'stub', role: 'model-provider',
    command: process.execPath, args: [recordedModel], cwd: projectRoot, port,
    env: { PATH: process.env.PATH || '', PORT: String(port), Q20_FIXTURE_DELAY_PLAN: JSON.stringify(delayPlan) }
  });
  if (resource.status !== 'running') throw new Error(`Q20 recorded model did not start: ${JSON.stringify(resource)}`);
  try {
    const deadline = Date.now() + 8_000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch { /* managed readiness retry */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`Q20 recorded model readiness timed out (resource ${resource.id})`);
    return {
      baseUrl: `http://127.0.0.1:${port}/v1`, resource,
      async close() {
        const state = await activeResourceSession.status();
        const current = state.resources?.find(item => item.id === resource.id);
        if (current && ['starting', 'running'].includes(current.status)) {
          const stopped = await activeResourceSession.stop(resource.id, 'q20-recorded-model-complete');
          if (!stopped.ok) throw new Error(`could not stop Q20 recorded model ${resource.id}: ${stopped.error || 'unknown error'}`);
        }
        const exited = await activeResourceSession.waitProcess(resource.id, 10_000);
        if (exited.timedOut || exited.unavailable || ['starting', 'running'].includes(exited.status)) {
          throw new Error(`Q20 recorded model did not exit: ${JSON.stringify(exited)}`);
        }
      }
    };
  } catch (error) {
    const state = await activeResourceSession.status().catch(() => ({}));
    const current = state.resources?.find(item => item.id === resource.id);
    if (current && ['starting', 'running'].includes(current.status)) await activeResourceSession.stop(resource.id, 'q20-model-start-failure');
    await activeResourceSession.waitProcess(resource.id, 10_000).catch(() => {});
    throw error;
  }
}

function fixtureEnv(provider) {
  return {
    LLM_BASE_URL: provider.baseUrl, LLM_API_KEY: 'q20-recorded-fixture-key', LLM_MODEL: 'recorded-stage20',
    ASSISTANT_MODEL_SOURCE: 'recorded_fixture', NODE_ENV: 'test', Q20_ACCEPTANCE_HOOKS: '1', LLM_TIMEOUT_MS: '30000'
  };
}

async function withScenarioDatabases(stage, callback, env = {}) {
  const options = { resourceSession: activeResourceSession, env };
  if (stage === 20) {
    const outputs = [];
    await withBothDatabaseApis(async context => {
      if (env.ASSISTANT_MODEL_SOURCE === 'recorded_fixture') {
        const result = await request(context.baseUrl, '/assistant/status');
        assert.equal(result.status, 200, `${context.driver}: recorded fixture status endpoint`);
        assert.equal(result.data.executionMode, 'recorded_fixture',
          `${context.driver}: fixture environment did not reach API process (${JSON.stringify({ executionMode: result.data.executionMode, model: result.data.model, provider: result.data.provider })})`);
        assert.equal(result.data.model, env.LLM_MODEL, `${context.driver}: fixture model name reaches API process`);
        recordEvidence({ quest: 'Q20.fixture-config', scenario: 'recorded-provider-environment', driver: context.driver,
          executionMode: result.data.executionMode, model: result.data.model, provider: result.data.provider });
      }
      outputs.push(await callback(context));
    }, options);
    return outputs;
  }
  return await withDatabaseApi('sqlite', context => callback(context), options);
}

async function createSyntheticGuest(context, suffix, profile = {}) {
  const seed = await databaseQuery(context, "SELECT password_hash FROM users WHERE username='guest_demo'", [], 'get');
  assert.ok(seed?.password_hash, `${context.driver}: isolated guest password template exists`);
  const guestId = crypto.randomUUID();
  const username = `q20_${suffix}_${context.driver}_${guestId.slice(0, 8)}`;
  await databaseQuery(context, 'INSERT INTO users(id,username,password_hash,role,name) VALUES(?,?,?,?,?)',
    [guestId, username, seed.password_hash, 'guest', `Stage20 合成样本 ${suffix}`], 'run');
  const healthProfile = profile.healthProfile || {};
  await databaseQuery(context, `INSERT INTO guest_profiles
    (user_id,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version)
    VALUES(?,?,?,?,?,1)`, [guestId, JSON.stringify(profile.chronic || []), JSON.stringify(profile.allergies || []),
    profile.mobility || '可独立行走', JSON.stringify(healthProfile)], 'run');
  const login = await request(context.baseUrl, '/auth/login', { method: 'POST', body: {
    username, password: 'guest2026', role: 'guest'
  } });
  assert.equal(login.status, 200, `${context.driver}: synthetic guest login: ${JSON.stringify(login.data)}`);
  assert.equal(login.data.user.id, guestId);
  return { guestId, token: login.data.token, username };
}

function markedText(code, message, live) {
  return live ? message : `${code} ${message}`;
}

async function startRun(context, guest, text, { forceDomainCollaboration = false } = {}) {
  const body = { async: true, role: 'guest', text, clientRequestId: crypto.randomUUID(),
    ...(forceDomainCollaboration ? { forceDomainCollaboration: true } : {}) };
  const result = await request(context.baseUrl, '/assistant/chat', { method: 'POST', token: guest.token, body });
  assert.equal(result.status, 202, `Q20 assistant start: ${JSON.stringify(result.data)}`);
  assert.ok(result.data.runId && result.data.sessionId);
  return result.data;
}

async function waitForRun(context, guest, runId) {
  const deadline = Date.now() + 110_000;
  while (Date.now() < deadline) {
    const result = await request(context.baseUrl, `/assistant/runs/${encodeURIComponent(runId)}?role=guest`, { token: guest.token });
    assert.equal(result.status, 200, `Q20 run status: ${JSON.stringify(result.data)}`);
    if (!['queued', 'running'].includes(result.data.status)) return result.data;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Q20 run ${runId} exceeded its bounded test window`);
}

async function countsForGuest(context, guestId) {
  const reservations = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM reservations WHERE guest_id=?', [guestId], 'get');
  const menus = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM meal_menus WHERE guest_id=?', [guestId], 'get');
  const orders = await databaseQuery(context, 'SELECT COUNT(*) AS count FROM meal_orders WHERE guest_id=?', [guestId], 'get');
  return { reservations: Number(reservations.count), menus: Number(menus.count), orders: Number(orders.count) };
}

function assertNoBusinessWrites(before, after, label) {
  assert.deepEqual(after, before, `${label}: assistant did not write a booking, meal menu, or meal order`);
}

async function toolResult(context, childRunId, toolName) {
  const row = await databaseQuery(context, 'SELECT result_json FROM tool_executions WHERE run_id=? AND tool_name=? AND status=? ORDER BY started_at,id LIMIT 1',
    [childRunId, toolName, 'completed'], 'get');
  assert.ok(row, `${toolName} tool execution persisted`);
  return parseJson(row.result_json);
}

function assertCompletedAgent(run, agentId) {
  assert.equal(run.status, 'completed', `parent run status: ${run.status} (${run.errorCode || ''}); ${JSON.stringify({
    executionMode: run.executionMode, model: run.model, collaboration: run.collaboration ? {
      agents: run.collaboration.agents?.map(item => ({ agentId: item.agentId, status: item.status, errorCode: item.errorCode,
        executionMode: item.executionMode, modelSteps: item.modelSteps?.map(step => ({ status: step.status, errorCode: step.errorCode })) })),
      graphBudget: run.collaboration.graphBudget
    } : null
  })}`);
  assert.equal(run.executionMode, 'recorded_fixture', 'fixture result is accurately identified');
  assert.equal(run.live, false, 'recorded fixture is not reported as a live-provider result');
  assert.ok(run.collaboration, 'parent run includes collaboration graph');
  const agent = run.collaboration.agents.find(item => item.agentId === agentId);
  assert.ok(agent, `child run exists for ${agentId}`);
  assert.equal(agent.status, 'completed');
  assert.equal(agent.executionMode, 'recorded_fixture');
  assert.ok(agent.runId && agent.runId !== run.runId, 'child has an independent persistent run ID');
  assert.equal(agent.modelSteps.filter(step => step.status === 'completed').length, 2,
    `${agentId} made two independent model calls`);
  assert.ok(agent.tools.length >= 2 && agent.tools.every(tool => tool.status === 'completed'), `${agentId} tools completed`);
  const contract = DOMAIN_AGENT_CONTRACTS.find(item => item.agentId === agentId);
  const knowledgeIds = agent.sources.filter(source => source.type === 'domain_knowledge').map(source => source.id).sort();
  assert.deepEqual(knowledgeIds, [...contract.knowledgeSourceIds].sort(), `${agentId} cites both persisted knowledge sources`);
  assert.ok(agent.model, `${agentId} actual model recorded`);
  return agent;
}

function assertGraphBudgetAccounting(run, { expectedModelCalls = null, allowRejected = false } = {}) {
  const collaboration = run.collaboration;
  const budget = collaboration.graphBudget;
  const decisions = collaboration.budgetDecisions || [];
  const reservations = decisions.filter(item => item.phase === 'reservation');
  const granted = reservations.filter(item => item.outcome === 'reserved');
  const rejected = reservations.filter(item => item.outcome === 'rejected');
  const settlements = decisions.filter(item => item.phase === 'settlement');
  assert.equal(budget.modelCalls, granted.length, 'only granted provider reservations count as model calls');
  assert.equal(settlements.length, granted.length, 'every granted reservation settles and releases');
  const tracedModelSteps = (collaboration.parent.modelSteps || []).length
    + collaboration.agents.reduce((count, agent) => count + (agent.modelSteps || []).length, 0);
  assert.equal(tracedModelSteps, granted.length, 'only granted reservations appear as model steps');
  assert.equal(budget.reservedTokens, 0, 'all in-flight token reservations are released before graph completion');
  assert.equal(budget.reservedCostUsd, 0, 'all in-flight cost reservations are released before graph completion');
  assert.ok(budget.inputTokens + budget.outputTokens <= budget.maxTokens, 'actual usage remains within the graph token cap');
  assert.ok(budget.estimatedCostUsd <= budget.maxEstimatedCostUsd + 1e-9, 'estimated usage remains within the graph cost cap');
  assert.ok(budget.modelCalls <= budget.maxModelCalls && budget.toolCalls <= budget.maxToolCalls);
  assert.ok(budget.elapsedMs <= budget.maxRuntimeMs);
  if (expectedModelCalls !== null) assert.equal(budget.modelCalls, expectedModelCalls);
  if (!allowRejected) assert.equal(rejected.length, 0, 'the normal fixture graph must finish without a budget rejection');

  for (const item of granted) {
    assert.ok(item.runId && item.agentId && item.request.estimatedInputTokens > 0 && item.request.messageBytes > 0);
    assert.equal(item.providerRequestSent, false, 'reservation is recorded before dispatch');
    assert.ok(item.stateAfter.consumed.totalTokens + item.stateAfter.inFlight.reservedTokens <= item.stateAfter.limits.maxTokens);
    assert.ok(item.stateAfter.consumed.estimatedCostUsd + item.stateAfter.inFlight.reservedCostUsd
      <= item.stateAfter.limits.maxEstimatedCostUsd + 1e-9);
  }
  for (const item of rejected) {
    assert.ok(item.runId && item.agentId && item.request.estimatedInputTokens > 0);
    assert.equal(item.providerRequestSent, false, 'budget refusal is persisted before any provider request');
    assert.equal(item.reservation, null);
    assert.ok(item.rejectionCode);
    const trace = item.agentId === HOUSEHOLD_AGENT.agentId
      ? collaboration.parent : collaboration.agents.find(agent => agent.runId === item.runId);
    assert.ok(trace, 'budget refusal has a matching run trace');
    assert.equal(trace.modelSteps.some(step => step.status === 'failed' && String(step.summary).includes(item.rejectionCode)), false,
      'a request that was never sent must not be represented as a failed model step');
  }
  assert.equal(granted.length + rejected.length, reservations.length);
  assert.equal(reservations.some(item => JSON.stringify(item).includes('prompt') || JSON.stringify(item).includes('reasoning')),
    false, 'budget snapshots contain no prompt or internal reasoning fields');
}

function recordRunEvidence(quest, context, run, { scenario, guestId, notes = {} }) {
  const collaboration = run.collaboration || {};
  recordEvidence({ quest, scenario, driver: context.driver, parentRunId: run.runId, parentStatus: run.status,
    executionMode: run.executionMode, live: run.live, model: run.model, provider: run.provider,
    parentInputTokens: run.inputTokens, parentOutputTokens: run.outputTokens, parentEstimatedCostUsd: run.estimatedCostUsd,
    parentModelSteps: (collaboration.parent?.modelSteps || []).map(step => ({ stepIndex: step.stepIndex,
      status: step.status, errorCode: step.errorCode || null, finishReason: step.finishReason || null,
      inputTokens: step.inputTokens, outputTokens: step.outputTokens, durationMs: step.durationMs,
      diagnostic: step.diagnostic || null })),
    coordinatorValidationSteps: (collaboration.parent?.validationSteps || []).map(step => ({ stepIndex: step.stepIndex,
      status: step.status, errorCode: step.errorCode || null, diagnostic: step.diagnostic || null })),
    coordinatorStatus: collaboration.coordinatorStatus || null,
    coordinatorError: collaboration.coordinatorError ?? null,
    selectionSource: collaboration.selectionSource || null,
    fallbackSource: collaboration.fallbackSource || null,
    selectionValidation: collaboration.selectionValidation || null,
    finalAdoptedCandidateIds: collaboration.finalAdoptedCandidateIds || collaboration.selectedCandidateIds || [],
    guestFixtureId: guestId, graphDurationMs: collaboration.graphDurationMs,
    graphBudget: collaboration.graphBudget,
    budgetDecisions: collaboration.budgetDecisions || [],
    agents: (collaboration.agents || []).map(agent => ({ runId: agent.runId, agentId: agent.agentId,
      instructionVersion: agent.instructionVersion, status: agent.status, executionMode: agent.executionMode,
      model: agent.model, provider: agent.provider, inputTokens: agent.inputTokens, outputTokens: agent.outputTokens,
      estimatedCostUsd: agent.estimatedCostUsd, durationMs: agent.durationMs,
      modelSteps: agent.modelSteps.map(step => ({ status: step.status, durationMs: step.durationMs,
        inputTokens: step.inputTokens, outputTokens: step.outputTokens, estimatedCostUsd: step.estimatedCostUsd,
        diagnostic: step.diagnostic || null })),
      tools: agent.tools.map(tool => ({ toolName: tool.toolName, status: tool.status,
        durationMs: tool.durationMs, errorCode: tool.errorCode })),
      sourceIds: agent.sources.map(source => ({ type: source.type, id: source.id })), candidateIds: agent.candidateIds,
      errorCode: agent.errorCode })),
    candidates: (collaboration.candidates || []).map(candidate => ({ candidateId: candidate.candidateId,
      domain: candidate.domain, status: candidate.status, reason: candidate.reason,
      sourceIds: (candidate.sourceIds || []).map(source => source.id) })),
    selectedCandidateIds: collaboration.selectedCandidateIds, gaps: collaboration.gaps, notes });
}

async function validateContracts(context) {
  const statusResponse = await request(context.baseUrl, '/assistant/status');
  assert.equal(statusResponse.status, 200, 'Q20 status endpoint');
  const status = statusResponse.data;
  const contracts = status.agentContracts;
  const expectedIds = [HOUSEHOLD_AGENT.agentId, ...DOMAIN_AGENT_CONTRACTS.map(item => item.agentId)].sort();
  assert.deepEqual(contracts.map(item => item.agentId).sort(), expectedIds, 'status exposes the coordinator and four unique specialists');
  for (const expected of DOMAIN_AGENT_CONTRACTS) {
    const contract = contracts.find(item => item.agentId === expected.agentId);
    assert.equal(contract.instructionVersion, expected.instructionVersion);
    assert.deepEqual(contract.allowedTools, expected.allowedTools);
    assert.equal(contract.knowledgeSourceIds.length, 2, `${expected.agentId} has two declared source IDs`);
    assert.equal(contract.inputSchema.additionalProperties, false);
    assert.equal(contract.outputSchema.additionalProperties, false);
    const tools = await databaseQuery(context,
      `SELECT knowledge_id AS knowledgeId FROM domain_knowledge WHERE active=1 AND knowledge_id IN (?,?) ORDER BY knowledge_id`,
      expected.knowledgeSourceIds, 'all');
    assert.equal(tools.length, 2, `${expected.agentId} points to two actual domain-knowledge rows`);
  }
  recordEvidence({ quest: 'Q20.1', scenario: 'specialist-contracts', driver: context.driver,
    agentIds: expectedIds, contracts: contracts.map(item => ({ agentId: item.agentId,
      instructionVersion: item.instructionVersion, allowedTools: item.allowedTools,
      knowledgeSourceIds: item.knowledgeSourceIds })) });
  return `${context.driver}: five versioned contracts, exact tool allowlists, schemas, and eight persisted knowledge sources verified.`;
}

async function insertActivitySlot(context, { guestId, projectId, date, start = '07:30', end = '09:00', reserve = false, key }) {
  const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
  const suffix = key || crypto.randomUUID().slice(0, 10);
  const id = `q20-slot-${context.driver}-${suffix}`;
  await databaseQuery(context, `INSERT INTO activity_slots
    (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [id, projectId, date, `${date} ${start}:00.000`, `${date} ${end}:00.000`, start, end, 12, 0, stamp, stamp], 'run');
  let reservationId = null;
  if (reserve) {
    reservationId = `q20-reservation-${context.driver}-${suffix}`;
    await databaseQuery(context, `INSERT INTO reservations
      (id,guest_id,slot_id,idempotency_key,request_fingerprint,status,created_at,environment_snapshot_id,availability_status,availability_reason,is_demo)
      VALUES(?,?,?,?,?,'confirmed',?,?,?,?,1)`, [reservationId, guestId, id, reservationId,
      crypto.createHash('sha256').update(`${guestId}:${id}`).digest('hex'), stamp,
      'q20-synthetic-environment', 'available', 'Stage20 synthetic pre-existing reservation'], 'run');
  }
  return { id, reservationId, date, start, end };
}

async function runPhysioFixtures({ stage, live, liveConfig, provider }) {
  if (live) return await runLiveCases({ quest: 'Q20.2', stage, liveConfig, cases: [
    { name: 'hypertension', profile: { chronic: ['高血压'] }, text: '请依据海水浴、温泉和海泥的实际目录整理理疗候选。对限制项标注项目规则，不给处方或预约。' },
    { name: 'skin-break', profile: { healthProfile: { skin: { status: 'reported', details: '小腿有皮肤破损' } } }, text: '请依据海水浴、温泉和海泥的实际目录整理理疗候选。对限制项标注项目规则，不给处方或预约。' }
  ], validate: async (context, run, guest, before) => {
    const agent = assertLiveAgent(run, 'domain.physio');
    const candidates = run.collaboration.candidates;
    if (guest.caseName === 'hypertension') assert.ok(candidates.some(item => item.candidateId === 'project-marine-hot-spring' && item.status === 'requires_review' && item.reason.includes('R1')));
    if (guest.caseName === 'skin-break') assert.ok(candidates.some(item => ['project-sea-bath', 'project-sea-mud'].includes(item.candidateId) && item.status === 'rejected' && item.reason.includes('R2')));
    assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.2 live physio');
    return { agent, candidates };
  }});
  const providerHandle = provider || await startRecordedModel();
  try {
    return await withScenarioDatabases(stage, async context => {
      const outputs = [];
      for (const sample of [
        { name: 'hypertension', profile: { chronic: ['高血压'] }, code: 'Q20:PHYSIO-R1' },
        { name: 'skin-break', profile: { healthProfile: { skin: { status: 'reported', details: '小腿有皮肤破损' } } }, code: 'Q20:PHYSIO-R2' }
      ]) {
        const guest = await createSyntheticGuest(context, `physio-${sample.name}`, sample.profile);
        const before = await countsForGuest(context, guest.guestId);
        const start = await startRun(context, guest, markedText(sample.code,
          '请依据海水浴、温泉和海泥目录整理理疗候选。标注项目规则限制，不提供处方和预约。', false));
        const run = await waitForRun(context, guest, start.runId);
        recordRunEvidence('Q20.2.fixture', context, run, { scenario: sample.name, guestId: guest.guestId,
          notes: { ruleCheck: sample.name === 'hypertension' ? 'R1 requires clinician review' : 'R2 rejects sea-bath and sea-mud candidates' } });
        const agent = assertCompletedAgent(run, 'domain.physio');
        const contextTool = await toolResult(context, agent.runId, 'get_physio_context');
        const evaluations = contextTool.evaluations || [];
        if (sample.name === 'hypertension') {
          const hotSpring = evaluations.find(item => item.projectId === 'project-marine-hot-spring');
          assert.equal(hotSpring.outcome, 'restrict');
          assert.ok(hotSpring.matchedRules.some(item => item.ruleId === 'R1'));
          assert.ok(run.collaboration.candidates.some(item => item.candidateId === hotSpring.projectId && item.status === 'requires_review'));
        } else {
          for (const id of ['project-sea-bath', 'project-sea-mud']) {
            const item = evaluations.find(value => value.projectId === id);
            assert.ok(item.matchedRules.some(rule => rule.ruleId === 'R2'), `${id} matched R2`);
            assert.ok(run.collaboration.candidates.some(candidate => candidate.candidateId === id && candidate.status === 'rejected'));
          }
        }
        assert.ok(agent.sources.some(item => item.type === 'safety_rule' && ['R1', 'R2'].includes(item.id)));
        assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.2 fixture physio');
        outputs.push(`${context.driver}/${sample.name}: ${agent.runId} completed two model calls and two read tools; deterministic ${sample.name === 'hypertension' ? 'R1 review' : 'R2 exclusion'} held.`);
      }
      const diagnosticGuest = await createSyntheticGuest(context, 'physio-diagnostic');
      const diagnosticBefore = await countsForGuest(context, diagnosticGuest.guestId);
      const diagnosticStart = await startRun(context, diagnosticGuest,
        'Q20:DIAGNOSTIC 请依据海水浴、温泉和海泥目录整理理疗候选；只读筛选，不写入预约。');
      const diagnosticRun = await waitForRun(context, diagnosticGuest, diagnosticStart.runId);
      recordRunEvidence('Q20.2.diagnostic.fixture', context, diagnosticRun, {
        scenario: 'bounded-redacted-provider-error', guestId: diagnosticGuest.guestId,
        notes: { expectedHttpStatus: 400, errorMessagePersisted: true, rawBodyPersisted: false }
      });
      const diagnosticAgent = diagnosticRun.collaboration?.agents?.find(item => item.agentId === 'domain.physio');
      assert.ok(diagnosticAgent, `${context.driver}: diagnostic fixture retains the independent physio run`);
      const failedStep = diagnosticAgent.modelSteps.find(step => step.status === 'failed');
      assert.ok(failedStep?.diagnostic, `${context.driver}: safe provider diagnostic persists on the model step`);
      assert.equal(failedStep.diagnostic.response.status, 400);
      assert.equal(failedStep.diagnostic.response.code, 'unsupported_tool_choice');
      assert.match(failedStep.diagnostic.response.message, /thinking mode does not support required or named tool choices/i);
      assert.equal(failedStep.diagnostic.request.toolChoice, 'required');
      assert.equal(failedStep.diagnostic.request.toolCount, 2);
      assert.ok(failedStep.diagnostic.request.messages.some(item => item.role === 'system'));
      assert.ok(failedStep.diagnostic.request.messages.some(item => item.role === 'user'));
      const diagnosticJson = JSON.stringify(failedStep.diagnostic);
      for (const forbidden of ['PRIVATE_HEALTH_SENTINEL', 'Bearer', 'sk-q20-fixture-only', 'thinking mode does not support tool_choice required; echoed']) {
        assert.equal(diagnosticJson.includes(forbidden), false, `${context.driver}: diagnostic excludes ${forbidden}`);
      }
      assertNoBusinessWrites(diagnosticBefore, await countsForGuest(context, diagnosticGuest.guestId), 'Q20.2 diagnostic fixture');
      outputs.push(`${context.driver}: HTTP 400 diagnostic was bounded, redacted, persisted on the failed model step, and emitted in structured execution evidence.`);
      return outputs.join(' ');
    }, fixtureEnv(providerHandle));
  } finally { if (!provider) await providerHandle.close(); }
}

async function runNutrition({ stage, live, liveConfig, provider }) {
  if (live) return await runLiveCases({ quest: 'Q20.3', stage, liveConfig, cases: [
    { name: 'shrimp-allergy', profile: { allergies: ['虾'] }, text: '请查看明天早餐、午餐和晚餐的菜单候选，只按当前目录与已记录限制筛选，不写入餐单。' }
  ], validate: async (context, run, guest, before) => {
    const agent = assertLiveAgent(run, 'domain.nutrition');
    const ctx = await toolResult(context, agent.runId, 'get_nutrition_context');
    assert.ok(ctx.excluded.some(item => item.dishId === 'dish-shrimp-noodles' && item.reason.includes('过敏')));
    assert.ok(!run.collaboration.candidates.some(item => item.status === 'adopted' && item.candidateId.includes('dish-shrimp-noodles')));
    assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.3 live nutrition');
    return { agent, candidates: run.collaboration.candidates };
  }});
  const providerHandle = provider || await startRecordedModel();
  try {
    return await withScenarioDatabases(stage, async context => {
      const guest = await createSyntheticGuest(context, 'nutrition-shrimp', { allergies: ['虾'] });
      const before = await countsForGuest(context, guest.guestId);
      const start = await startRun(context, guest, markedText('Q20:NUTRITION',
        '请查看明天早餐、午餐和晚餐的菜单候选，只按当前目录与已记录限制筛选，不写入餐单。', false));
      const run = await waitForRun(context, guest, start.runId);
      recordRunEvidence('Q20.3.fixture', context, run, { scenario: 'shrimp-allergy-three-meals', guestId: guest.guestId,
        notes: { expectedExcludedDishId: 'dish-shrimp-noodles' } });
      const agent = assertCompletedAgent(run, 'domain.nutrition');
      const data = await toolResult(context, agent.runId, 'get_nutrition_context');
      const shrimp = data.excluded.find(item => item.dishId === 'dish-shrimp-noodles');
      assert.ok(shrimp && shrimp.reason.includes('过敏'), 'shrimp dish is excluded with a deterministic allergy reason');
      assert.ok(agent.sources.some(source => source.type === 'dish' && source.id === 'dish-shrimp-noodles'),
        'the complete persisted tool source survives compact model-context projection');
      assert.ok(!data.candidates.some(item => item.dish.id === 'dish-shrimp-noodles'));
      const adopted = run.collaboration.candidates.filter(item => item.domain === 'nutrition' && item.status === 'adopted');
      assert.ok(['breakfast', 'lunch', 'dinner'].every(meal => adopted.some(item => item.details.mealType === meal)),
        'three meal periods have an adopted safe candidate');
      assert.ok(!adopted.some(item => item.details.dishId === 'dish-shrimp-noodles'));
      assert.ok(run.collaboration.candidates.some(item => item.domain === 'nutrition' && item.status === 'rejected'
        && item.candidateId.includes('dish-shrimp-noodles') && item.reason.includes('过敏')));
      assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.3 fixture nutrition');
      recordEvidence({ quest: 'Q20.3.fixture-result', scenario: 'shrimp-allergy-three-meals', driver: context.driver,
        excludedDishId: 'dish-shrimp-noodles', exclusionReason: shrimp.reason, adoptedMeals: adopted.map(item => item.details.mealType) });
      return `${context.driver}: three meal candidates persisted; dish-shrimp-noodles was excluded with ${shrimp.reason}; no menu or order write occurred.`;
    }, fixtureEnv(providerHandle));
  } finally { if (!provider) await providerHandle.close(); }
}

async function runExercise({ stage, live, liveConfig, provider }) {
  if (live) return await runLiveCases({ quest: 'Q20.4', stage, liveConfig, cases: [
    { name: 'mobility-assistance', profile: { mobility: '需要协助', healthProfile: { mobility: { status: 'assistance', details: '步行时需要工作人员协助' } } }, text: '请查看运动活动目录与明日的开放时间，整理适合核对的候选，不创建预约。' },
    { name: 'independent', profile: { mobility: '可独立行走', healthProfile: { mobility: { status: 'independent', details: '' } } }, text: '请查看运动活动目录与明日的开放时间，整理适合核对的候选，不创建预约。' }
  ], prepare: async (context, guest, sample) => {
    const [start, end] = sample.name === 'mobility-assistance' ? ['07:30', '09:00'] : ['09:30', '11:00'];
    await insertActivitySlot(context, { guestId: guest.guestId, projectId: 'project-beach-walk', date: chinaDate(1), start, end, key: `live-${sample.name}` });
  }, validate: async (context, run, guest, before) => {
    const agent = assertLiveAgent(run, 'domain.exercise');
    const data = await toolResult(context, agent.runId, 'get_exercise_context');
    const swim = data.activities.find(item => item.projectId === 'project-swimming-training');
    if (guest.caseName === 'mobility-assistance') assert.ok(swim.matchedRules.some(item => item.ruleId === 'R4'));
    const beachWalk = run.collaboration.candidates.find(item => item.candidateId === 'project-beach-walk');
    const expectedWindow = guest.caseName === 'mobility-assistance' ? ['07:30', '09:00'] : ['09:30', '11:00'];
    assert.ok(beachWalk?.details.windows.some(item => item.start === expectedWindow[0] && item.end === expectedWindow[1]));
    assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.4 live exercise');
    return { agent, candidates: run.collaboration.candidates };
  }});
  const providerHandle = provider || await startRecordedModel();
  try {
    return await withScenarioDatabases(stage, async context => {
      const date = chinaDate(1);
      const outputs = [];
      for (const sample of [
        { name: 'mobility-assistance', profile: { mobility: '需要协助', healthProfile: { mobility: { status: 'assistance', details: '步行时需要工作人员协助' } } } },
        { name: 'independent', profile: { mobility: '可独立行走', healthProfile: { mobility: { status: 'independent', details: '' } } } }
      ]) {
        const guest = await createSyntheticGuest(context, `exercise-${sample.name}`, sample.profile);
        const [startTime, endTime] = sample.name === 'mobility-assistance' ? ['07:30', '09:00'] : ['09:30', '11:00'];
        const slot = await insertActivitySlot(context, { guestId: guest.guestId, projectId: 'project-beach-walk', date,
          start: startTime, end: endTime, key: `${context.driver}-${sample.name}` });
        const before = await countsForGuest(context, guest.guestId);
        const start = await startRun(context, guest, markedText('Q20:EXERCISE',
          '请查看运动活动目录与明日的开放时间，整理适合核对的候选，不创建预约。', false));
        const run = await waitForRun(context, guest, start.runId);
        recordRunEvidence('Q20.4.fixture', context, run, { scenario: sample.name, guestId: guest.guestId,
          notes: { expectedSlotId: slot.id, expectedSafetyRule: sample.name === 'mobility-assistance' ? 'R4' : null } });
        const agent = assertCompletedAgent(run, 'domain.exercise');
        const data = await toolResult(context, agent.runId, 'get_exercise_context');
        assert.equal(data.date, date, 'next business date is explicitly used by the exercise tool');
        assert.ok(data.activities.some(item => item.projectId === 'project-beach-walk'
          && item.openWindows.some(window => window.id === slot.id && window.start === slot.start && window.end === slot.end)),
        'actual activity slot is read from the exercise tool');
        assert.ok(agent.sources.some(source => source.type === 'project_slot' && source.id === slot.id));
        if (sample.name === 'mobility-assistance') {
          const swim = data.activities.find(item => item.projectId === 'project-swimming-training');
          assert.ok(swim.matchedRules.some(item => item.ruleId === 'R4' && item.action === 'reject'));
          const candidate = run.collaboration.candidates.find(item => item.candidateId === 'project-swimming-training');
          assert.equal(candidate.status, 'rejected');
          assert.ok(candidate.reason.includes('R4'));
        } else {
          const beachWalk = run.collaboration.candidates.find(item => item.candidateId === 'project-beach-walk');
          assert.equal(beachWalk.status, 'adopted');
          assert.equal(beachWalk.details.availabilitySource, 'activity_slots');
        }
        assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.4 fixture exercise');
        recordEvidence({ quest: 'Q20.4.fixture-result', scenario: sample.name, driver: context.driver,
          toolDate: data.date, activitySlotId: slot.id, safetyRule: sample.name === 'mobility-assistance' ? 'R4 rejects swimming training' : 'actual beach walk slot is adopted' });
        outputs.push(`${context.driver}/${sample.name}: ${agent.runId}, actual slot ${slot.id}; ${sample.name === 'mobility-assistance' ? 'R4 swim restriction' : 'open beach-walk window'} verified.`);
      }
      return outputs.join(' ');
    }, fixtureEnv(providerHandle));
  } finally { if (!provider) await providerHandle.close(); }
}

async function insertMoodFixture(context, guestId, mode) {
  const dates = [-2, -1, 0].map(offset => chinaDate(offset));
  const recordIds = dates.map(() => 100_000_000 + crypto.randomInt(1_000_000));
  const scores = mode === 'negative' ? [1, 2, 1] : [4, 3, 4];
  const stamp = new Date().toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
  for (let index = 0; index < dates.length; index += 1) {
    await databaseQuery(context, `INSERT INTO mood_records
      (id,guest_id,business_date,score,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`,
    [recordIds[index], guestId, dates[index], scores[index], `Stage20 ${mode} synthetic sample`, stamp, stamp], 'run');
  }
  if (mode === 'negative') {
    await databaseQuery(context, `INSERT INTO mood_focus_items
      (guest_id,rule_id,streak_start,streak_end,source_record_ids_json,status,created_at,updated_at)
      VALUES(?,?,?,?,?,'open',?,?)`, [guestId, 'demo-negative-streak-v1', dates[0], dates[2], JSON.stringify(recordIds), stamp, stamp], 'run');
  }
  return { dates, recordIds, scores };
}

async function runPsychology({ stage, live, liveConfig, provider }) {
  if (live) return await runLiveCases({ quest: 'Q20.5', stage, liveConfig, cases: [
    { name: 'negative-streak', profile: {}, moodMode: 'negative', text: '请给我一个陪伴练习，并查看当前可播放的课程资源。' },
    { name: 'ordinary', profile: {}, moodMode: 'ordinary', text: '请给我一个陪伴练习，并查看当前可播放的课程资源。' }
  ], validate: async (context, run, guest, before) => {
    const agent = assertLiveAgent(run, 'domain.psychology');
    const data = await toolResult(context, agent.runId, 'get_psychology_context');
    assert.ok(data.resources.some(item => item.id === 'breathing' && item.audioUrl));
    if (guest.caseName === 'negative-streak') assert.ok(data.focusItems.some(item => item.status === 'open' && item.sourceRecordIds.length === 3));
    else assert.equal(data.focusItems.length, 0);
    assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.5 live psychology');
    return { agent, candidates: run.collaboration.candidates };
  }});
  const providerHandle = provider || await startRecordedModel();
  try {
    return await withScenarioDatabases(stage, async context => {
      const outputs = [];
      for (const sample of [
        { name: 'negative-streak', moodMode: 'negative' }, { name: 'ordinary', moodMode: 'ordinary' }
      ]) {
        const guest = await createSyntheticGuest(context, `psychology-${sample.name}`);
        const fixture = await insertMoodFixture(context, guest.guestId, sample.moodMode);
        const before = await countsForGuest(context, guest.guestId);
        const start = await startRun(context, guest, markedText('Q20:PSYCHOLOGY',
          '请给我一个陪伴练习，并查看当前可播放的课程资源。', false));
        const run = await waitForRun(context, guest, start.runId);
        recordRunEvidence('Q20.5.fixture', context, run, { scenario: sample.name, guestId: guest.guestId,
          notes: { expectedMoodMode: sample.moodMode } });
        const agent = assertCompletedAgent(run, 'domain.psychology');
        const data = await toolResult(context, agent.runId, 'get_psychology_context');
        assert.ok(fixture.recordIds.every(id => data.recentMoods.some(item => Number(item.id) === id)), 'real mood records are cited by the context tool');
        assert.ok(data.resources.some(item => item.id === 'breathing' && item.audioUrl));
        if (sample.moodMode === 'negative') {
          const focus = data.focusItems.find(item => item.status === 'open');
          assert.ok(focus && fixture.recordIds.every(id => focus.sourceRecordIds.map(Number).includes(id)));
          assert.ok(agent.sources.some(source => source.type === 'mood_focus' && String(source.id) === String(focus.id)));
          assert.ok(run.reply.includes('不是心理诊断'));
        } else {
          assert.equal(data.focusItems.length, 0, 'ordinary sample has no focus item');
          assert.ok(agent.sources.some(source => source.type === 'mood_record'));
        }
        const selected = run.collaboration.candidates.find(item => item.domain === 'psychology' && item.status === 'adopted');
        assert.ok(selected?.details.audioUrl, 'psychology candidate is a real playable guided resource');
        const audioUrl = new URL(selected.details.audioUrl, `${new URL(context.baseUrl).origin}/`);
        const audio = await fetch(audioUrl, { signal: AbortSignal.timeout(5000) });
        assert.equal(audio.status, 200, 'selected audio is served from the existing local resource');
        assert.match(audio.headers.get('content-type') || '', /^audio\//);
        await audio.body?.cancel();
        assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.5 fixture psychology');
        recordEvidence({ quest: 'Q20.5.fixture-result', scenario: sample.name, driver: context.driver,
          moodRecordIds: fixture.recordIds, focusRuleId: sample.moodMode === 'negative' ? 'demo-negative-streak-v1' : null,
          audioResourceId: selected.candidateId, audioHttpStatus: audio.status });
        outputs.push(`${context.driver}/${sample.name}: ${agent.runId}, three real mood records, ${sample.moodMode === 'negative' ? 'open human-attention focus' : 'no focus item'}, and ${selected.candidateId} audio HTTP ${audio.status}.`);
      }
      return outputs.join(' ');
    }, fixtureEnv(providerHandle));
  } finally { if (!provider) await providerHandle.close(); }
}

async function runMixedGraph({ context, guest, text, marker = 'Q20:MIXED', expectPartial = false,
  expectBudgetRejected = false, expectCoordinatorError = null, before }) {
  const start = await startRun(context, guest, text, { forceDomainCollaboration: true });
  const run = await waitForRun(context, guest, start.runId);
  recordRunEvidence(expectPartial ? 'Q20.6.partial.fixture' : expectBudgetRejected ? 'Q20.6.budget-rejection.fixture' : 'Q20.6.fixture', context, run, {
    scenario: expectPartial ? 'exercise-agent-failure' : expectBudgetRejected ? 'oversized-model-input-budget-rejection' : marker,
    guestId: guest.guestId,
    notes: { beforeValidation: true, partialExpected: expectPartial, budgetRejectedExpected: expectBudgetRejected }
  });
  if (expectBudgetRejected) {
    assertGraphBudgetAccounting(run, { allowRejected: true });
    const refusals = run.collaboration.budgetDecisions.filter(item => item.phase === 'reservation' && item.outcome === 'rejected');
    assert.ok(refusals.some(item => item.rejectionCode === 'GRAPH_TOKEN_BUDGET'),
      'a request that exceeds remaining real graph capacity is refused with a persisted numeric snapshot');
    assert.ok(refusals.every(item => item.request.estimatedInputTokens && item.remainingBefore
      && item.remainingAfterInput && item.stateBefore && item.stateAfter));
    assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.6 budget refusal');
    return run;
  }
  assert.equal(run.status, 'completed', `mixed graph returns an honest partial completion: ${JSON.stringify({
    errorCode: run.errorCode, executionMode: run.executionMode, collaboration: run.collaboration ? {
      agents: run.collaboration.agents?.map(item => ({ agentId: item.agentId, status: item.status, errorCode: item.errorCode,
        executionMode: item.executionMode, modelSteps: item.modelSteps?.map(step => ({ status: step.status, errorCode: step.errorCode })) })),
      graphBudget: run.collaboration.graphBudget
    } : null
  })}`);
  const ids = run.collaboration.agents.map(item => item.agentId).sort();
  assert.deepEqual(ids, ['domain.exercise', 'domain.nutrition']);
  assert.ok(run.collaboration.parent.runId === run.runId && run.collaboration.parent.agentId === HOUSEHOLD_AGENT.agentId);
  assert.equal(run.collaboration.agents.filter(item => item.status === 'completed').length, expectPartial ? 1 : 2);
  if (!expectPartial) {
    assertGraphBudgetAccounting(run, { expectedModelCalls: 5 });
    for (const id of ['domain.exercise', 'domain.nutrition']) assertCompletedAgent(run, id);
    assert.equal(run.collaboration.gaps.length, 0);
    assert.equal(run.collaboration.graphBudget.modelCalls, 5, 'two child model calls plus one parent call share the five-call graph budget');
    assert.equal(run.collaboration.graphBudget.toolCalls, 4);
    if (!expectCoordinatorError) {
      assert.equal(run.collaboration.coordinatorError, null, 'normal parent selection has no coordinator error');
      assert.equal(run.collaboration.coordinatorStatus, 'completed');
      assert.equal(run.collaboration.selectionSource, 'model', 'selection is sourced from the actual coordinator model response');
      assert.equal(run.collaboration.fallbackSource, null);
      assert.deepEqual(run.collaboration.selectionValidation,
        { schemaValid: true, allowlistValid: true, responseComplete: true });
      assert.ok(run.collaboration.parent.modelSteps.length === 1);
      assert.equal(run.collaboration.parent.modelSteps[0].status, 'completed');
      assert.equal(run.collaboration.parent.modelSteps[0].finishReason, 'stop');
      assert.equal(run.collaboration.parent.validationSteps.length, 1);
      assert.equal(run.collaboration.parent.validationSteps[0].status, 'completed');
      assert.equal(run.collaboration.parent.validationSteps[0].errorCode, null);
      assert.deepEqual(run.collaboration.finalAdoptedCandidateIds, run.collaboration.selectedCandidateIds);
      const allowedIds = new Set(run.collaboration.candidates.filter(item => item.status === 'adopted').map(item => item.candidateId));
      assert.ok(run.collaboration.selectedCandidateIds.length > 0);
      assert.ok(run.collaboration.selectedCandidateIds.every(id => allowedIds.has(id)), 'model selection stays in the safe candidate allowlist');
    } else {
      assert.equal(run.collaboration.coordinatorError, expectCoordinatorError);
      assert.equal(run.collaboration.coordinatorStatus, 'failed');
      assert.equal(run.collaboration.selectionSource, null);
      assert.equal(run.collaboration.fallbackSource, 'completed_domain_candidates');
      assert.deepEqual(run.collaboration.selectedCandidateIds, [], 'invalid or failed coordinator output never becomes a default selection');
      assert.deepEqual(run.collaboration.finalAdoptedCandidateIds, []);
      assert.equal(run.collaboration.parent.validationSteps.length, 1);
      assert.equal(run.collaboration.parent.validationSteps[0].status, 'failed');
      assert.equal(run.collaboration.parent.validationSteps[0].errorCode, expectCoordinatorError);
      assert.ok(run.reply.includes('管家选择未完成'));
      assert.ok(run.reply.includes('回退来源：已完成专业领域智能体'));
      assert.ok(run.collaboration.candidates.some(item => item.domain === 'nutrition' && item.status === 'adopted'));
      if (expectCoordinatorError === 'MODEL_HTTP_503') {
        assert.equal(run.collaboration.parent.modelSteps.length, 1);
        assert.equal(run.collaboration.parent.modelSteps[0].status, 'failed');
        assert.equal(run.collaboration.parent.modelSteps[0].errorCode, 'MODEL_HTTP_503');
      } else {
        assert.equal(run.collaboration.parent.modelSteps.length, 1);
        assert.equal(run.collaboration.parent.modelSteps[0].status, 'completed');
      }
    }
    const exercise = run.collaboration.agents.find(item => item.agentId === 'domain.exercise');
    const exerciseData = await toolResult(context, exercise.runId, 'get_exercise_context');
    assert.equal(exerciseData.date, chinaDate(1));
    const bookedCandidate = run.collaboration.candidates.find(item => item.domain === 'exercise'
      && item.candidateId === 'project-beach-walk');
    assert.equal(bookedCandidate.status, 'rejected');
    assert.match(bookedCandidate.reason, /時間重疊/);
    const nutrition = run.collaboration.agents.find(item => item.agentId === 'domain.nutrition');
    const nutritionData = await toolResult(context, nutrition.runId, 'get_nutrition_context');
    assert.ok(nutritionData.excluded.some(item => item.dishId === 'dish-shrimp-noodles'));
    const settlements = run.collaboration.budgetDecisions.filter(item => item.phase === 'settlement');
    const nutritionSettlements = settlements.filter(item => item.runId === nutrition.runId);
    const exerciseSettlements = settlements.filter(item => item.runId === exercise.runId);
    if (marker === 'Q20:MIXED-ORDER-NUTRITION-FIRST') {
      assert.ok(nutritionSettlements[1].index < exerciseSettlements[0].index,
        'nutrition completed both calls and released reservations while exercise first response was delayed');
    } else if (marker === 'Q20:MIXED-ORDER-EXERCISE-FIRST') {
      assert.ok(exerciseSettlements[1].index < nutritionSettlements[0].index,
        'exercise completed both calls and released reservations while nutrition first response was delayed');
    }
  } else {
    assertGraphBudgetAccounting(run, { expectedModelCalls: 3 });
    assert.equal(run.collaboration.coordinatorError, null, 'a partial child result can still receive a valid model coordinator selection');
    assert.equal(run.collaboration.coordinatorStatus, 'completed');
    assert.equal(run.collaboration.selectionSource, 'model');
    assert.deepEqual(run.collaboration.selectionValidation,
      { schemaValid: true, allowlistValid: true, responseComplete: true });
    assert.equal(run.collaboration.parent.modelSteps.length, 1);
    assert.equal(run.collaboration.parent.modelSteps[0].status, 'completed');
    assert.equal(run.collaboration.parent.validationSteps[0].status, 'completed');
    const nutrition = run.collaboration.agents.find(item => item.agentId === 'domain.nutrition');
    assert.equal(nutrition.status, 'completed');
    assert.equal(nutrition.modelSteps.filter(step => step.status === 'completed').length, 2);
    const exercise = run.collaboration.agents.find(item => item.agentId === 'domain.exercise');
    assert.equal(exercise.status, 'failed');
    assert.ok(Number.isFinite(exercise.durationMs) && exercise.durationMs > 0,
      'a completed failed child retains its measured runtime instead of a fabricated zero');
    assert.ok(run.collaboration.gaps.some(item => item.agentId === 'domain.exercise' && item.errorCode === 'INJECTED_AGENT_FAILURE'));
    assert.ok(run.reply.includes('运动智能体未完成'));
    assert.ok(run.collaboration.candidates.some(item => item.domain === 'nutrition' && item.status === 'adopted'));
    assert.equal(run.collaboration.candidates.some(item => item.domain === 'exercise' && item.status === 'adopted'), false,
      'failed exercise child cannot be represented by fabricated success candidates');
    const allowedIds = new Set(run.collaboration.candidates.filter(item => item.status === 'adopted').map(item => item.candidateId));
    assert.ok(run.collaboration.selectedCandidateIds.length > 0
      && run.collaboration.selectedCandidateIds.every(id => allowedIds.has(id)),
    'partial completion selection only includes candidates from the completed domain');
  }
  assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), `Q20.6 ${expectPartial ? 'partial' : 'complete'} graph`);
  if (marker === 'Q20:MIXED-TIMING-OVERLAP') {
    const parentElapsedMs = run.collaboration.graphBudget.elapsedMs;
    const childElapsedMs = run.collaboration.agents.map(agent => agent.durationMs);
    assert.ok(Number.isFinite(parentElapsedMs) && parentElapsedMs > 0, 'parent graph reports measured wall time');
    assert.ok(childElapsedMs.every(value => Number.isFinite(value) && value > 0),
      'each completed child reports its measured runtime');
    assert.ok(parentElapsedMs >= Math.max(...childElapsedMs), 'parent wall time contains the longest child run');
    assert.ok(parentElapsedMs < childElapsedMs.reduce((sum, value) => sum + value, 0),
      'overlapping child durations are not added together as parent wall time');
    assert.ok(run.collaboration.agents.every(agent => agent.modelSteps.every(step => Number.isFinite(step.durationMs) && step.durationMs > 0)),
      'controlled delays appear in individual model-step durations');
    recordEvidence({ quest: 'Q20.6.timing', scenario: 'controlled-child-overlap-wall-and-child-durations',
      driver: context.driver, parentElapsedMs, childElapsedMs,
      childModelStepDurationsMs: run.collaboration.agents.map(agent => ({ agentId: agent.agentId,
        durationsMs: agent.modelSteps.map(step => step.durationMs) })),
      sumChildElapsedMs: childElapsedMs.reduce((sum, value) => sum + value, 0),
      overlappingChildrenNotDoubleCounted: true });
  }
  recordEvidence({ quest: 'Q20.6.fixture-result', scenario: expectPartial ? 'exercise-agent-failure' : 'mixed-exercise-nutrition-overlap-and-allergy',
    driver: context.driver, bookingAndMealWritesUnchanged: true, expectedChildAgentIds: ids });
  return run;
}

async function runMixed({ stage, live, liveConfig, provider }) {
  if (live) return await runLiveCases({ quest: 'Q20.6', stage, liveConfig, cases: [
    { name: 'mixed', profile: { allergies: ['虾'] }, text: '给我明天的海边活动和三餐。请分别查看开放活动时间与菜单食材，排除不适用候选，不创建预约或餐单。' }
  ], prepare: async (context, guest) => {
    await insertActivitySlot(context, { guestId: guest.guestId, projectId: 'project-beach-walk', date: chinaDate(1), reserve: true, key: `live-mixed-${context.driver}` });
  }, validate: async (context, run, guest, before) => {
    const agents = run.collaboration.agents;
    assert.ok(agents.some(item => item.agentId === 'domain.exercise' && item.status === 'completed'));
    assert.ok(agents.some(item => item.agentId === 'domain.nutrition' && item.status === 'completed'));
    const nutrition = agents.find(item => item.agentId === 'domain.nutrition');
    const nutritionData = await toolResult(context, nutrition.runId, 'get_nutrition_context');
    assert.ok(nutritionData.excluded.some(item => item.dishId === 'dish-shrimp-noodles'));
    assert.equal(run.collaboration.coordinatorError, null, 'the live parent must not fall back from a coordinator error');
    assert.equal(run.collaboration.coordinatorStatus, 'completed');
    assert.equal(run.collaboration.selectionSource, 'model');
    assert.equal(run.collaboration.fallbackSource, null);
    assert.deepEqual(run.collaboration.selectionValidation,
      { schemaValid: true, allowlistValid: true, responseComplete: true });
    assert.equal(run.collaboration.parent.modelSteps.length, 1);
    assert.equal(run.collaboration.parent.modelSteps[0].status, 'completed');
    assert.equal(run.collaboration.parent.modelSteps[0].finishReason, 'stop');
    assert.equal(run.collaboration.parent.validationSteps.length, 1);
    assert.equal(run.collaboration.parent.validationSteps[0].status, 'completed');
    const selectedMealIds = run.collaboration.finalAdoptedCandidateIds.filter(id => /^(breakfast|lunch|dinner):/.test(id));
    assert.equal(new Set(selectedMealIds.map(id => id.split(':')[0])).size, 3, 'a selected meal candidate exists for breakfast, lunch, and dinner');
    assert.ok(!selectedMealIds.some(id => id.includes('dish-shrimp-noodles')), 'allergy-excluded shrimp is never selected');
    const selectedCandidates = run.collaboration.candidates.filter(item => selectedMealIds.includes(item.candidateId));
    assert.equal(selectedCandidates.length, selectedMealIds.length);
    assert.ok(selectedCandidates.every(item => item.status === 'adopted' && item.sourceIds.length > 0),
      'selected meals retain valid candidate status and source IDs');
    const shrimp = run.collaboration.candidates.find(item => item.candidateId.includes('dish-shrimp-noodles'));
    assert.ok(shrimp && shrimp.status === 'rejected' && shrimp.sourceIds.length > 0 && /过敏/.test(shrimp.reason));
    assertNoBusinessWrites(before, await countsForGuest(context, guest.guestId), 'Q20.6 live mixed');
    return { agent: agents, candidates: run.collaboration.candidates };
  }});
  const providerHandle = provider || await startRecordedModel({ delayPlan: {
    'Q20:MIXED-ORDER-NUTRITION-FIRST:domain.exercise:first': 250,
    'Q20:MIXED-ORDER-EXERCISE-FIRST:domain.nutrition:first': 250,
    'Q20:MIXED-TIMING-OVERLAP:domain.exercise:first': 300,
    'Q20:MIXED-TIMING-OVERLAP:domain.nutrition:first': 300,
    'Q20:MIXED-BUDGET-LIMIT:domain.exercise:first': 250
  } });
  const completeEnvironment = fixtureEnv(providerHandle);
  const partialEnvironment = { ...completeEnvironment, Q20_TEST_FAIL_AGENT: 'domain.exercise' };
  try {
    const complete = await withScenarioDatabases(stage, async context => {
      const guest = await createSyntheticGuest(context, 'mixed', { allergies: ['虾'] });
      await insertActivitySlot(context, { guestId: guest.guestId, projectId: 'project-beach-walk', date: chinaDate(1),
        reserve: true, key: `${context.driver}-mixed-existing` });
      const before = await countsForGuest(context, guest.guestId);
      const marker = context.driver === 'sqlite' ? 'Q20:MIXED-ORDER-NUTRITION-FIRST' : 'Q20:MIXED-ORDER-EXERCISE-FIRST';
      const run = await runMixedGraph({ context, guest, marker, text: markedText(marker,
        '给我明天的海边活动和三餐。分别查看开放活动时间与菜单食材，排除不适用候选，不创建预约或餐单。', false), before });
      return `${context.driver}: parent ${run.runId} completed both child agents with five model calls; ${marker} exercised staggered reservation release; booked-window and shrimp exclusions passed.`;
    }, completeEnvironment);
    const timingOverlap = await withScenarioDatabases(stage, async context => {
      const guest = await createSyntheticGuest(context, 'mixed-timing-overlap', { allergies: ['虾'] });
      await insertActivitySlot(context, { guestId: guest.guestId, projectId: 'project-beach-walk', date: chinaDate(1),
        reserve: true, key: `${context.driver}-mixed-timing-overlap` });
      const before = await countsForGuest(context, guest.guestId);
      const marker = 'Q20:MIXED-TIMING-OVERLAP';
      const run = await runMixedGraph({ context, guest, marker, text: markedText(marker,
        '给我明天的海边活动和三餐。分别查看开放活动时间与菜单食材，排除不适用候选，不创建预约或餐单。', false), before });
      return `${context.driver}: parent ${run.runId} recorded independent child runtimes and overlapped both controlled first-call delays without summing child time into the parent.`;
    }, completeEnvironment);
    const budgetRejected = await withScenarioDatabases(stage, async context => {
      const guest = await createSyntheticGuest(context, 'mixed-budget-limited', { allergies: ['虾'] });
      const before = await countsForGuest(context, guest.guestId);
      const longRequest = `给我明天的海边活动和三餐，分别查看开放活动时间与菜单候选，不创建预约或餐单。${'请按工具读取的真实候选、餐次、食材、过敏约束和知识逐项核对。'.repeat(100)}`;
      assert.ok(longRequest.length < 4000, 'budget pressure sample remains within the product request limit');
      const run = await runMixedGraph({ context, guest, marker: 'Q20:MIXED-BUDGET-LIMIT',
        text: markedText('Q20:MIXED-BUDGET-LIMIT', longRequest, false), expectBudgetRejected: true, before });
      return `${context.driver}: run ${run.runId} persisted an unsent GRAPH_TOKEN_BUDGET refusal snapshot without fabricating a model step.`;
    }, completeEnvironment);
    const partial = await withScenarioDatabases(stage, async context => {
      const guest = await createSyntheticGuest(context, 'mixed-partial', { allergies: ['虾'] });
      const before = await countsForGuest(context, guest.guestId);
      const run = await runMixedGraph({ context, guest, text: markedText('Q20:MIXED-FAIL',
        '给我明天的海边活动和三餐。请分别整理候选，不创建预约或餐单。', false), expectPartial: true, before });
      return `${context.driver}: parent ${run.runId} preserved nutrition candidates and reports the failed exercise child as a gap.`;
    }, partialEnvironment);
    const coordinatorFailures = [];
    const failureCases = [
      ['Q20:COORDINATOR-HTTP', 'MODEL_HTTP_503'],
      ['Q20:COORDINATOR-EMPTY', 'COORDINATOR_OUTPUT_EMPTY'],
      ['Q20:COORDINATOR-INVALID-JSON', 'COORDINATOR_OUTPUT_INVALID_JSON'],
      ['Q20:COORDINATOR-UNAUTHORIZED', 'COORDINATOR_CANDIDATE_NOT_ALLOWED']
    ];
    for (const [marker, expectedError] of failureCases) {
      coordinatorFailures.push(...await withScenarioDatabases(stage, async context => {
        const guest = await createSyntheticGuest(context, `mixed-coordinator-${marker.split('-').at(-1)}`, { allergies: ['虾'] });
        await insertActivitySlot(context, { guestId: guest.guestId, projectId: 'project-beach-walk',
          date: chinaDate(1), reserve: true, key: `${context.driver}-${marker.split('-').at(-1)}` });
        const before = await countsForGuest(context, guest.guestId);
        const run = await runMixedGraph({ context, guest, marker,
          text: markedText(marker, '给我明天的海边活动和三餐。分别查看开放活动时间与菜单食材，排除不适用候选，不创建预约或餐单。', false),
          expectCoordinatorError: expectedError, before });
        return `${context.driver}: ${marker} preserved domain candidates and reported ${expectedError} without model adoption.`;
      }, completeEnvironment));
    }
    return [...complete, ...timingOverlap, ...budgetRejected, ...partial, ...coordinatorFailures];
  } finally { if (!provider) await providerHandle.close(); }
}

function assertLiveAgent(run, agentId) {
  assert.equal(run.status, 'completed', `live graph status: ${run.status} (${run.errorCode || 'no error code'})`);
  assert.equal(run.executionMode, 'live', 'parent identifies real provider execution');
  assert.equal(run.live, true);
  const agent = run.collaboration.agents.find(item => item.agentId === agentId);
  assert.ok(agent && agent.status === 'completed', `${agentId} completed against the real provider`);
  assert.equal(agent.executionMode, 'live');
  assert.equal(agent.live, true);
  assert.ok(agent.model && agent.provider);
  assert.ok(agent.inputTokens + agent.outputTokens > 0);
  assert.equal(agent.modelSteps.filter(step => step.status === 'completed').length, 2);
  assert.ok(agent.tools.length >= 2 && agent.tools.every(tool => tool.status === 'completed'));
  const contract = DOMAIN_AGENT_CONTRACTS.find(item => item.agentId === agentId);
  const knowledgeIds = agent.sources.filter(source => source.type === 'domain_knowledge').map(source => source.id).sort();
  assert.deepEqual(knowledgeIds, [...contract.knowledgeSourceIds].sort());
  return agent;
}

async function runLiveCases({ quest, stage, liveConfig, cases, prepare, validate }) {
  if (!liveConfig?.LLM_BASE_URL || !liveConfig?.LLM_API_KEY || !liveConfig?.LLM_MODEL) {
    const blocked = new Error('Stage20 live model configuration is unavailable');
    blocked.stageBlocked = true;
    throw blocked;
  }
  const outputs = [];
  const startAt = Date.now();
  const env = { LLM_BASE_URL: liveConfig.LLM_BASE_URL, LLM_API_KEY: liveConfig.LLM_API_KEY, LLM_MODEL: liveConfig.LLM_MODEL,
    NODE_ENV: 'test', LLM_TIMEOUT_MS: '30000' };
  try {
    await withDatabaseApi('sqlite', async context => {
      for (const sample of cases) {
        const guest = await createSyntheticGuest(context, `live-${quest}-${sample.name}`, sample.profile);
        guest.caseName = sample.name;
        if (sample.moodMode) await insertMoodFixture(context, guest.guestId, sample.moodMode);
        await prepare?.(context, guest, sample);
        const before = await countsForGuest(context, guest.guestId);
        const start = await startRun(context, guest, sample.text);
        const run = await waitForRun(context, guest, start.runId);
        let detail;
        try { detail = await validate(context, run, guest, before); }
        catch (error) {
          recordRunEvidence(`${quest}.live.failed`, context, run, { scenario: sample.name, guestId: guest.guestId,
            notes: { failureCode: error.code || error.name || 'LIVE_ASSERTION_FAILED' } });
          throw error;
        }
        const liveAgents = Array.isArray(detail.agent) ? detail.agent : [detail.agent];
        recordRunEvidence(`${quest}.live`, context, run, { scenario: sample.name, guestId: guest.guestId,
          notes: { actualProvider: true, sourcesVerified: liveAgents.reduce((total, agent) => total + agent.sources.length, 0) } });
        outputs.push({ scenario: sample.name, parentRunId: run.runId,
          agents: liveAgents.map(agent => ({ runId: agent.runId,
            agentId: agent.agentId, model: agent.model, provider: agent.provider, inputTokens: agent.inputTokens,
            outputTokens: agent.outputTokens, estimatedCostUsd: agent.estimatedCostUsd, durationMs: agent.durationMs,
            toolNames: agent.tools.map(tool => tool.toolName), sourceIds: agent.sources.map(source => source.id) })),
          estimatedCostUsd: run.estimatedCostUsd, durationMs: run.collaboration.graphDurationMs,
          candidateDecisions: (detail.candidates || []).map(item => ({ candidateId: item.candidateId, status: item.status, reason: item.reason })) });
      }
    }, { resourceSession: activeResourceSession, env });
  } catch (error) {
    if (error?.stageBlocked === true) throw error;
    const rawErrorCode = String(error?.code || '');
    const providerCode = /^(?:MODEL_|GRAPH_|AGENT_|COORDINATOR_)/.test(rawErrorCode)
      ? rawErrorCode
      : String(error?.message?.match(/(?:MODEL|GRAPH|AGENT|COORDINATOR)_[A-Z0-9_]+/)?.[0] || '');
    const providerFailure = /^(MODEL_|GRAPH_(RUNTIME|MODEL_CALL|TOKEN|COST)|AGENT_(REQUIRED_TOOL_MISSING|OUTPUT_INVALID)|COORDINATOR_(MODEL_FAILED|OUTPUT_INVALID))/.test(providerCode)
      || (error?.name === 'TypeError' && /fetch failed|network|socket/i.test(error.message || ''))
      || /ECONNRESET|ECONNREFUSED|ETIMEDOUT|429|502|503|504/.test(error?.message || '');
    if (!providerFailure) throw error;
    const safeCode = providerCode || 'LIVE_PROVIDER_ERROR';
    recordEvidence({ quest: `${quest}.live.blocked`, scenario: 'real-model-chain', status: 'BLOCKED', safeCode,
      durationMs: Date.now() - startAt });
    const blocked = new Error(`Stage20 ${quest} live provider chain could not be confirmed (${safeCode}); no recorded fixture was used as a live result.`);
    blocked.stageBlocked = true;
    throw blocked;
  }
  return [`REAL_MODEL_PASS ${JSON.stringify({ quest, actualProvider: true, scenarios: outputs, durationMs: Date.now() - startAt })}`];
}

async function runContracts({ stage }) {
  return await withScenarioDatabases(stage, validateContracts);
}

async function runBrowserAcceptance(resourceSession) {
  const result = await resourceSession.runProcess({ label: 'q20-browser-acceptance-runner', kind: 'probe', role: 'browser-acceptance',
    command: process.execPath, args: [browserAcceptance], cwd: projectRoot,
    env: { PATH: process.env.PATH || '', CODEX_TASK_ID: process.env.CODEX_TASK_ID || '' },
    leaseMs: resourceSession.limits.leaseMs }, { timeoutMs: 360_000 });
  if (result.status !== 'exited' || result.exitCode !== 0 || result.signal || result.timedOut) {
    const error = new Error(`Q20.7 managed browser acceptance failed (${result.status}/${result.exitCode ?? 'no exit code'}): ${(result.tail || '').slice(-6000)}`);
    if (result.exitCode === 2) error.stageBlocked = true;
    throw error;
  }
  const marker = (result.tail || '').split(/\r?\n/).find(line => line.startsWith('STAGE20_BROWSER_RESULT:'));
  assert.ok(marker, `Q20.7 browser runner omitted summary: ${(result.tail || '').slice(-2000)}`);
  const summary = JSON.parse(marker.slice('STAGE20_BROWSER_RESULT:'.length));
  recordEvidence({ quest: 'Q20.7', scenario: 'assistant-collaboration-ui', browserEvidencePath: summary.evidencePath,
    screenshotPaths: summary.screenshots, widths: summary.widths, failureWidths: summary.failureWidths,
    coordinatorFailure: summary.coordinatorFailure, fixtureMode: summary.executionMode,
    parentRunId: summary.parentRunId, childRunIds: summary.childRunIds, agentIds: summary.agentIds,
    toolNames: summary.toolNames, candidateDecisions: summary.candidateDecisions,
    cacheNamesUnchanged: summary.cacheNamesUnchanged, chrome: summary.chrome,
    resourceIds: summary.resources?.map(item => item.id) || [] });
  return [`Managed browser verified valid model selection and coordinator-failure fallback at 1024, 1440, and 1920 px; evidence ${summary.evidencePath}.`];
}

const runners = {
  'Q20.1': args => runContracts(args),
  'Q20.2': args => runPhysioFixtures(args),
  'Q20.3': args => runNutrition(args),
  'Q20.4': args => runExercise(args),
  'Q20.5': args => runPsychology(args),
  'Q20.6': args => runMixed(args),
  'Q20.7': async ({ resourceSession }) => runBrowserAcceptance(resourceSession)
};

export async function run({ questId, stage, live = false, liveConfig = null, resourceSession }) {
  if (!resourceSession) throw new Error('Stage20 requires a managed ResourceSession');
  activeResourceSession = resourceSession;
  const runner = runners[questId];
  if (!runner) throw new Error(`Unsupported Stage20 Quest: ${questId}`);
  const output = await runner({ questId, stage, live, liveConfig, resourceSession });
  return { output: Array.isArray(output) ? output : [String(output)] };
}
