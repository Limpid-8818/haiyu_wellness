import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { withDatabaseApi, databaseQuery, request, assertOk } from '../quests/q10-helpers.js';
import { runStage27EnvironmentBrowser, runStage27LiveTraceBrowser } from './stage26-browser-acceptance.js';
import { ResourceSession } from './resource-runtime.js';
import { runStage27R4OfflineTests } from './stage27-r4-offline-tests.mjs';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { readHashedBudgetJsonl } from './stage27-r4-budget-accounts.js';
import { validateQ275ConfirmationContract } from './stage27-r4-confirmation-contract.js';

const workerTaskId = '01a12558-3f36-72c0-857c-fdd666eccf86';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const auditRoot = path.join(projectRoot, 'output/resource-audit/stage27-r4', workerTaskId);
const persistentModelBudgetPath = path.join(auditRoot, 'q275-persistent-model-budget.jsonl');
const sourcePersistentModelBudgetPath = path.join(projectRoot, 'output/resource-audit/stage27-r4',
  '01a0cbfe-a161-72d0-992d-12fad655d4ef', 'q275-persistent-model-budget.jsonl');
const sourceRequestLimitApprovalPath = path.join(projectRoot,
  'output/resource-audit/stage27-r4-source-sol-source-only-extra12-approval-20261011.json');
const sourceHandoffBaselinePath = path.join(projectRoot, 'output/resource-audit/stage27-r4-source-sol-message-and-time-repair-handoff-baseline-20261010.json');
const resourceLimits = { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 };

function sha256(filePath, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!fs.existsSync(filePath)) return { exists: false, bytes: 0, hash: null };
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) throw new Error(`${path.basename(filePath)} exceeds the bounded hash-read limit of ${maxBytes} bytes.`);
  const bytes = fs.readFileSync(filePath);
  if (bytes.byteLength !== stat.size) throw new Error(`${path.basename(filePath)} changed during its bounded hash read.`);
  return { exists: true, bytes: bytes.byteLength, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`;
}

function sqlTime(value) { return value.replace('T', ' ').replace(/Z$/u, ''); }

function randomId(prefix) { return `${prefix}${crypto.randomUUID()}`; }

function fixturePayloads(targetDate) {
  const time = Array.from({ length: 24 }, (_, hour) => `${targetDate}T${String(hour).padStart(2, '0')}:00`);
  return {
    weather: { latitude: 39.05, longitude: 121.78, timezone: 'Asia/Shanghai', utc_offset_seconds: 28800,
      current: { time: `${targetDate}T22:45`, temperature_2m: 20.1, wind_speed_10m: 8.2 },
      hourly_units: { temperature_2m: '°C', wind_speed_10m: 'km/h', uv_index: 'index' },
      hourly: { time, temperature_2m: time.map((_, index) => 17 + index / 10),
        wind_speed_10m: time.map(() => 8.2), uv_index: time.map((_, index) => index >= 10 && index <= 15 ? 4 : 1) } },
    marine: { latitude: 39, longitude: 121.75, timezone: 'Asia/Shanghai',
      hourly_units: { wave_height: 'm', sea_level_height_msl: 'm' },
      hourly: { time, wave_height: time.map((_, index) => 0.35 + (index % 4) / 100),
        sea_level_height_msl: time.map((_, index) => 0.15 + (index % 6) / 100) } }
  };
}

async function availableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('Could not reserve a local test port.')));
    });
  });
}

async function waitForLocalFixture(url, resourceSession, resourceId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const item = (await resourceSession.status()).resources?.find(resource => resource.id === resourceId);
    if (!item || !['starting', 'running'].includes(item.status)) throw new Error(`Local provider fixture exited early: ${JSON.stringify(item)}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch { /* the server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Local provider fixture did not become ready.');
}

function serverSource() {
  return `import fs from 'node:fs';
import http from 'node:http';
const payloads=JSON.parse(process.env.FIXTURE_PAYLOADS);
const logPath=process.env.FIXTURE_REQUEST_LOG;
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/__health'){res.writeHead(200,{'content-type':'text/plain'});res.end('ok');return;}
  const kind=url.pathname==='/v1/forecast'?'weather':url.pathname==='/v1/marine'?'marine':null;
  if(!kind){res.writeHead(404,{'content-type':'application/json'});res.end(JSON.stringify({error:'fixture route not found'}));return;}
  fs.appendFileSync(logPath,JSON.stringify({method:req.method,path:url.pathname,latitude:url.searchParams.get('latitude'),
    longitude:url.searchParams.get('longitude'),hourly:url.searchParams.get('hourly'),at:new Date().toISOString()})+'\\n',{mode:0o600});
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payloads[kind]));
});
server.listen(Number(process.env.FIXTURE_PORT),'127.0.0.1');
process.once('SIGTERM',()=>server.close(()=>process.exit(0)));
process.once('SIGINT',()=>server.close(()=>process.exit(0)));
`;
}

async function insertSyntheticGuest(context, bookingDate, businessClockNow) {
  const username = `offline_${crypto.randomUUID().slice(0, 8)}`;
  const guestId = `guest_offline_${crypto.randomUUID()}`;
  const password = 'guest2026';
  const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
  assert.ok(source?.password_hash, 'isolated SQLite seed includes a safe password hash to clone');
  const stamp = sqlTime(businessClockNow);
  const checkIn = new Date(`${bookingDate}T00:00:00+08:00`);
  checkIn.setUTCDate(checkIn.getUTCDate() - 1);
  const checkOut = new Date(checkIn);
  checkOut.setUTCDate(checkOut.getUTCDate() + 7);
  const dateAt = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(value);
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,?,?,'guest',?,'','active',?)`, [guestId, username, source.password_hash, '离线夹具验收客人', stamp], 'run');
  await databaseQuery(context, `INSERT INTO guest_profiles
    (user_id,gender,birth_date,room_no,check_in,check_out,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at)
    VALUES(?,'女','1980-01-01','OFFLINE-01',?,?,'[]','[]','可独立行走',?,0,?)`,
  [guestId, dateAt(checkIn), dateAt(checkOut), JSON.stringify({ allergies: { status: 'none', items: [] }, mobility: { status: 'independent' } }), stamp], 'run');
  return { guestId, username, password };
}

async function seedDemoEnvironment(context, date, businessClockNow) {
  const demo = makeDemoEnvironment(date, businessClockNow, DEMO_ENVIRONMENT_LOCATION);
  const stamp = sqlTime(businessClockNow);
  for (const [domain, stationId, data] of [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]]) {
    const key = `env:${crypto.createHash('sha256').update(JSON.stringify([DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain])).digest('hex').slice(0, 48)}`;
    const encoded = JSON.stringify(data);
    const payloadHash = crypto.createHash('sha256').update(encoded).digest('hex');
    await databaseQuery(context, `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,
       payload_hash,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)`,
    [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, data.sourceName || 'Offline-only demo fixture',
      data.sourceUrl || '', stamp, sqlTime(new Date(Date.parse(businessClockNow) + 6 * 86_400_000).toISOString()),
      payloadHash, encoded, stamp, stamp], 'run');
  }
}

async function seedBookingSlot(context, date, businessClockNow) {
  const projectId = 'project-marine-hot-spring';
  const localStart = '15:00'; const localEnd = '16:00';
  const slotId = `slot_${crypto.createHash('sha256').update(`${projectId}\0${date}\0${localStart}\0${localEnd}`).digest('hex').slice(0, 32)}`;
  const stamp = sqlTime(businessClockNow);
  await databaseQuery(context, `INSERT INTO activity_slots
    (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,2,0,?,?)`, [slotId, projectId, date,
    sqlTime(new Date(`${date}T${localStart}:00+08:00`).toISOString()), sqlTime(new Date(`${date}T${localEnd}:00+08:00`).toISOString()),
    localStart, localEnd, stamp, stamp], 'run');
  return { projectId, slotId, localStart, localEnd };
}

async function seedOfflineAssistant(context, guest, booking, businessClockNow) {
  const stamp = sqlTime(businessClockNow);
  const futureExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
  const sessionId = `as_${crypto.randomUUID()}`;
  const graphRunId = randomId('run_');
  const actionRunId = randomId('run_');
  const needsInputCardId = randomId('assistant_action_card_');
  const modelIds = ['domain.physio', 'domain.nutrition', 'domain.exercise', 'domain.psychology'];
  const orchestration = { executionMode: 'offline_fixture', coordinatorStatus: 'completed', selectionSource: 'offline_fixture',
    coordinatorError: null, candidates: [], selectedCandidateIds: [], finalAdoptedCandidateIds: [], gaps: [],
    graphBudget: { modelCalls: 0, maxModelCalls: 24, toolCalls: 0, maxToolCalls: 24, inputTokens: 0,
      outputTokens: 0, estimatedCostUsd: 0, elapsedMs: 3 }, graphDurationMs: 3, concurrencyLimit: 2 };
  await databaseQuery(context, `INSERT INTO assistant_sessions
    (id,user_id,assistant_role,related_guest_id,status,started_at,last_message_at,expires_at,mode,model_name)
    VALUES(?,?,'guest',?,'active',?,?,?,'recorded_fixture',NULL)`,
  [sessionId, guest.guestId, guest.guestId, stamp, stamp, futureExpiry], 'run');
  const insertRun = async ({ id, clientRequestId, inputText, outputText, parentRunId = null, agentId, orchestrationJson = '{}' }) => {
    await databaseQuery(context, `INSERT INTO agent_runs
      (id,session_id,actor_id,assistant_role,client_request_id,status,input_text,output_text,created_at,updated_at,completed_at,
       parent_run_id,agent_id,instruction_version,agent_input_json,structured_output_json,orchestration_json,execution_mode)
      VALUES(?,?,?,'guest',?,'completed',?,?,?,?,?,?,?,?,?,?,?,'offline_fixture')`,
    [id, sessionId, guest.guestId, clientRequestId, inputText, outputText, stamp, stamp, stamp,
      parentRunId, agentId, 'fixture-v1', JSON.stringify({ request: inputText }), '{}', orchestrationJson], 'run');
  };
  const graphRequest = '请按理疗、营养、运动和心理四个专业方向整理只读建议。';
  const earlierGraphReply = '离线网页夹具：上一条同运行记录的领域进度消息，仅用于验证历史保留。';
  const graphReply = '离线网页夹具：四个领域的演示轨迹已记录，本内容未调用模型。';
  await insertRun({ id: graphRunId, clientRequestId: randomId('offline-graph-'), inputText: graphRequest,
    outputText: graphReply, agentId: 'household.concierge', orchestrationJson: JSON.stringify(orchestration) });
  for (const agentId of modelIds) await insertRun({ id: randomId('run_'), clientRequestId: randomId('offline-child-'),
    inputText: graphRequest, outputText: `${agentId} 离线演示轨迹。`, parentRunId: graphRunId, agentId });
  const actionReply = '离线网页夹具：已准备室内海洋温泉时段供客人选择，尚未提交预约。';
  await insertRun({ id: actionRunId, clientRequestId: randomId('offline-action-'), inputText: '准备海水浴时段选择卡。',
    outputText: actionReply, agentId: 'household.concierge' });
  await databaseQuery(context, `INSERT INTO assistant_messages(session_id,user_id,role,content,created_at,run_id)
    VALUES(?,?,'user',?,?,NULL)`, [sessionId, guest.guestId, graphRequest, stamp], 'run');
  await databaseQuery(context, `INSERT INTO assistant_messages(session_id,user_id,role,content,created_at,run_id)
    VALUES(?,?,'assistant',?,?,?)`, [sessionId, guest.guestId, earlierGraphReply, stamp, graphRunId], 'run');
  await databaseQuery(context, `INSERT INTO assistant_messages(session_id,user_id,role,content,created_at,run_id)
    VALUES(?,?,'assistant',?,?,?)`, [sessionId, guest.guestId, graphReply, stamp, graphRunId], 'run');
  await databaseQuery(context, `INSERT INTO assistant_messages(session_id,user_id,role,content,created_at,run_id)
    VALUES(?,?,'assistant',?,?,?)`, [sessionId, guest.guestId, actionReply, stamp, actionRunId], 'run');
  const project = await databaseQuery(context, 'SELECT id,name FROM projects WHERE id=?', [booking.projectId], 'get');
  assert.ok(project, 'the seeded catalog contains the sea-bathing program');
  const slot = { id: booking.slotId, start: booking.localStart, end: booking.localEnd,
    localStart: booking.localStart, localEnd: booking.localEnd, remaining: 2 };
  const parameters = { projectId: booking.projectId, date: booking.date };
  const impact = { summary: '请选择你本人要预约的具体时段。', project: { id: project.id, name: project.name },
    date: booking.date, availableSlots: [slot] };
  await databaseQuery(context, `INSERT INTO assistant_action_cards
    (id,logical_action_id,parent_card_id,guest_id,session_id,source_run_id,action_type,version,status,
     parameters_json,impact_json,missing_fields_json,basis_json,request_fingerprint,error_code,expires_at,created_at,updated_at)
    VALUES(?,?,NULL,?,?,?,'book_program',1,'needs_input',?,?,?,?,?,NULL,?,?,?)`,
  [needsInputCardId, randomId('logical_'), guest.guestId, sessionId, actionRunId,
    JSON.stringify(parameters), JSON.stringify(impact), JSON.stringify(['本人选择的时段']),
    JSON.stringify({ source: 'offline_only_fixture', availabilityChecked: true }),
    crypto.createHash('sha256').update(JSON.stringify(parameters)).digest('hex'), futureExpiry, stamp, stamp], 'run');
  return { sessionId, graphRunId, actionRunId, needsInputCardId };
}

async function managedCommand(session, label, command, args, cwd = projectRoot, timeoutMs = 600_000, outputMaxChars = 12_000) {
  const resource = await session.runProcess({ label, kind: label === 'npm-test' ? 'test' : 'build', role: 'verification-command',
    command, args, cwd, env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1' } }, { timeoutMs });
  const summary = { label, status: resource.status, pid: resource.pid, exitCode: resource.exitCode ?? null,
    signal: resource.signal || null, timedOut: Boolean(resource.timedOut), outputTail: String(resource.tail || '').slice(-outputMaxChars) };
  assert.equal(summary.status, 'exited', `${label} did not exit: ${summary.outputTail.slice(-3000)}`);
  assert.equal(summary.exitCode, 0, `${label} failed: ${summary.outputTail.slice(-3000)}`);
  assert.equal(summary.signal, null, `${label} was signaled`);
  return summary;
}

async function main() {
  assert.equal(process.env.CODEX_TASK_ID, workerTaskId, 'run only under the assigned Stage 27 R4 worker identity');
  const sourceBaselineStat = fs.statSync(sourceHandoffBaselinePath);
  assert.ok(sourceBaselineStat.size < 16 * 1024 * 1024, 'source handoff baseline is stat-bounded before reading');
  const sourceHandoffBaselineBytes = fs.readFileSync(sourceHandoffBaselinePath);
  const sourceHandoffBaseline = JSON.parse(sourceHandoffBaselineBytes.toString('utf8'));
  assert.ok(Array.isArray(sourceHandoffBaseline.currentCodeBaseline), 'source handoff baseline contains the code fingerprint list');
  const sourceHandoffBaselineFingerprint = { path: sourceHandoffBaselinePath, bytes: sourceBaselineStat.size,
    sha256: crypto.createHash('sha256').update(sourceHandoffBaselineBytes).digest('hex') };
  const persistentModelBudgetBefore = sha256(persistentModelBudgetPath, { maxBytes: 8 * 1024 * 1024 });
  if (persistentModelBudgetBefore.exists) readHashedBudgetJsonl(persistentModelBudgetPath);
  const sourcePersistentModelBudgetBefore = sha256(sourcePersistentModelBudgetPath, { maxBytes: 8 * 1024 * 1024 });
  if (sourcePersistentModelBudgetBefore.exists) readHashedBudgetJsonl(sourcePersistentModelBudgetPath);
  const sourceRequestLimitApprovalBefore = sha256(sourceRequestLimitApprovalPath, { maxBytes: 64 * 1024 });
  const session = await ResourceSession.create({ taskId: workerTaskId, projectRoot,
    limits: resourceLimits, tempParent: '/tmp' });
  const reportId = `offline-verification-20261011-confirmation-contract-${new Date().toISOString().replace(/[^0-9TZ]/gu, '-')}-${crypto.randomUUID()}`;
  const reportDirectory = path.join(auditRoot, reportId);
  fs.mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
  const reportPath = path.join(reportDirectory, 'offline-verification.json');
  const report = { schemaVersion: 1, taskId: workerTaskId, worktree: projectRoot, reportId,
    startedAt: new Date().toISOString(), status: 'RUNNING', scope: 'offline local fixtures only; no external provider or model calls',
    limits: resourceLimits, resourceSession: { instanceId: session.instanceId, tempDir: session.tempDir,
      socketPath: session.socketPath, registryPath: session.registryPath, guardianPid: session.guardian?.pid || null,
      guardianIdentity: session.guardianIdentity }, modelProviderCalls: 0, externalEnvironmentProviderCalls: 0,
    sourceModelBudgetUsed: false, persistentEnvironmentBudgetLedgerAccessed: false,
    persistentModelBudgetBefore, sourceHandoffBaseline: sourceHandoffBaselineFingerprint,
    sourcePersistentModelBudgetBefore, sourceRequestLimitApproval: sourceRequestLimitApprovalBefore,
    commands: [], focusedChecks: null, environmentBrowser: null, bookingBrowser: null,
    localProviderFixture: null, errors: [], resourceCleanup: null };
  let fixtureResource = null;
  let cleanupFailure = null;
  try {
    report.focusedChecks = await runStage27R4OfflineTests(path.join(session.tempDir, 'offline-tests'));
    assert.equal(report.focusedChecks.status, 'PASS');

    const targetDate = shanghaiDate();
    const bookingDate = addDays(targetDate, 1);
    const businessClockNow = new Date().toISOString();
    const port = await availableLoopbackPort();
    const requestLogPath = path.join(session.tempDir, 'local-provider-requests.jsonl');
    const fixtureScriptPath = path.join(session.tempDir, 'local-provider-fixture.mjs');
    fs.writeFileSync(fixtureScriptPath, serverSource(), { mode: 0o600, flag: 'wx' });
    fixtureResource = await session.startProcess({ label: 'q276-offline-provider-fixture', kind: 'probe', role: 'local-http-fixture',
      command: process.execPath, args: [fixtureScriptPath], cwd: session.tempDir, port,
      env: { PATH: process.env.PATH || '', FIXTURE_PORT: String(port), FIXTURE_REQUEST_LOG: requestLogPath,
        FIXTURE_PAYLOADS: JSON.stringify(fixturePayloads(targetDate)) } });
    assert.equal(fixtureResource.status, 'running', 'local provider fixture is managed by ResourceSession');
    await waitForLocalFixture(`http://127.0.0.1:${port}/__health`, session, fixtureResource.id);
    const localBudgetPath = path.join(session.tempDir, 'environment-budget.jsonl');
    const environment = { CODEX_TASK_ID: workerTaskId, NODE_ENV: 'test', BUSINESS_CLOCK_NOW: businessClockNow,
      ENVIRONMENT_MODE: 'live', ENVIRONMENT_LIVE: '1', ENVIRONMENT_OFFLINE_FIXTURE: '1',
      ENVIRONMENT_TIDE_PROVIDER: 'open-meteo', ENVIRONMENT_PROVIDER_BUDGET_LEDGER_PATH: localBudgetPath,
      ENVIRONMENT_PROVIDER_BUDGET_BASELINE: '0', ENVIRONMENT_LOCATION_ID: 'dalian-etdz-region-representative',
      ENVIRONMENT_LOCATION_NAME: '大连经济技术开发区地区代表点（非机构精确地址）',
      ENVIRONMENT_LATITUDE: '39.052585', ENVIRONMENT_LONGITUDE: '121.787513', ENVIRONMENT_TIME_ZONE: 'Asia/Shanghai',
      ENVIRONMENT_COORDINATES_STATUS: 'region-representative',
      ENVIRONMENT_LOCATION_SOURCE: 'https://www.wikidata.org/wiki/Q1000487#P625',
      ENVIRONMENT_INSTITUTION_LOCATION_CONFIGURED: '0', OPEN_METEO_WEATHER_BASE_URL: `http://127.0.0.1:${port}/v1/forecast`,
      OPEN_METEO_MARINE_BASE_URL: `http://127.0.0.1:${port}/v1/marine` };

    await withDatabaseApi('sqlite', async context => {
      const guest = await insertSyntheticGuest(context, bookingDate, businessClockNow);
      const signed = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST',
        body: { username: guest.username, password: guest.password, role: 'guest' } }), 200, 'offline fixture guest login');
      const snapshot = assertOk(await request(context.baseUrl, `/environment?date=${targetDate}`, { token: signed.token }), 200,
        'live environment adapter against the local fixture only');
      assert.equal(snapshot.status, 'available');
      assert.equal(snapshot.location.id, environment.ENVIRONMENT_LOCATION_ID);
      assert.equal(snapshot.location.coordinatesStatus, 'region-representative');
      assert.equal(snapshot.providerFixture?.mode, 'offline_fixture');
      assert.equal(snapshot.weather.status, 'available');
      const expectedWeatherObservedAt = `${targetDate}T14:45:00.000Z`;
      assert.equal(snapshot.weather.observedAt, expectedWeatherObservedAt,
        'the first API response normalizes the 22:45 Asia/Shanghai observation to 14:45Z');
      assert.equal(snapshot.weather.observedLocalTime, `${targetDate}T22:45`,
        'the first API response retains the provider-local observation string');
      assert.equal(snapshot.weather.current.time, `${targetDate}T22:00`,
        'the current weather values map to the matching local forecast hour');
      assert.equal(snapshot.marine.status, 'available');
      assert.equal(snapshot.tide.status, 'available');
      assert.equal(snapshot.marine.hourly.length, 24);
      assert.ok(snapshot.marine.hourly.every(item => Number.isFinite(item.waveHeightM)
        && Number.isFinite(item.modelSeaLevelHeightMsl)));
      assert.equal(snapshot.tide.typeLabel, '含潮汐的模式海面高度（预测）');
      assert.equal(snapshot.tide.verticalDatum, 'global mean sea level');
      assert.equal(snapshot.tide.sourceResponseHash, snapshot.marine.providerResponseHash);
      assert.deepEqual(snapshot.tide.providerCoordinates, snapshot.marine.providerCoordinates);
      assert.equal(snapshot.tide.retrievedAt, snapshot.marine.retrievedAt);
      assert.equal(snapshot.tide.expiresAt, snapshot.marine.expiresAt);
      assert.ok(Date.parse(snapshot.expiresAt) > Date.now());
      const seaBathing = assertOk(await request(context.baseUrl,
        `/environment?date=${targetDate}&projectId=project-sea-bath`, { token: signed.token }), 200,
      'sea-bathing availability using the same local fixture snapshot');
      assert.equal(seaBathing.availability.status, 'pending', 'modeled MSL does not release sea-bathing activity');
      assert.ok(seaBathing.availability.windows.length > 0, 'sea-bathing schedule includes assessed windows');
      assert.ok(seaBathing.availability.windows.every(window => window.status === 'pending' && window.tideHeightM === null),
        'modeled sea level leaves all sea-bathing windows pending without station tide');
      const storedBeforeBrowser = await databaseQuery(context, `SELECT domain,status,payload_hash AS payloadHash,observed_at AS observedAt,
        payload_json AS payloadJson,created_at AS createdAt,updated_at AS updatedAt
        FROM environment_snapshots WHERE location_id=? AND target_date=? ORDER BY domain`,
      [environment.ENVIRONMENT_LOCATION_ID, targetDate], 'all');
      assert.deepEqual(storedBeforeBrowser.map(row => row.domain), ['marine', 'tide', 'weather']);
      const savedWeather = storedBeforeBrowser.find(row => row.domain === 'weather');
      assert.equal(new Date(savedWeather.observedAt).toISOString(), expectedWeatherObservedAt,
        'SQLite observed_at stores the same canonical UTC instant as the first API response');
      const savedWeatherPayload = JSON.parse(savedWeather.payloadJson);
      assert.equal(savedWeatherPayload.observedAt, expectedWeatherObservedAt,
        'the immutable snapshot payload stores the same canonical UTC instant');
      assert.equal(savedWeatherPayload.observedLocalTime, `${targetDate}T22:45`,
        'the snapshot retains the local observation string alongside its UTC instant');
      const cachedSnapshot = assertOk(await request(context.baseUrl, `/environment?date=${targetDate}`, { token: signed.token }), 200,
        'cached weather snapshot readback');
      assert.equal(cachedSnapshot.snapshotId, snapshot.snapshotId, 'cache readback retains the same environment snapshot');
      assert.equal(cachedSnapshot.weather.observedAt, expectedWeatherObservedAt,
        'the cached API response preserves the same UTC observation instant');
      const expectedModeledSeaLevel = { responseHash: snapshot.marine.providerResponseHash,
        dataComplete: true, tideStatus: snapshot.tide.status };
      report.environmentBrowser = await runStage27EnvironmentBrowser({ resourceSession: session,
        apiBaseUrl: context.baseUrl, guestUsername: guest.username, guestPassword: guest.password, targetDate,
        expectedSnapshotId: snapshot.snapshotId,
        expectedLocation: { id: snapshot.location.id, name: snapshot.location.name,
          timeZone: snapshot.location.timeZone, latitude: snapshot.location.latitude,
          longitude: snapshot.location.longitude, coordinatesStatus: snapshot.location.coordinatesStatus },
        expectedDomains: { weather: snapshot.weather.status, tide: snapshot.tide.status, marine: snapshot.marine.status },
        expectedModeledSeaLevel, offlineFixture: true });
      assert.equal(report.environmentBrowser.status, 'PASS');
      const storedAfterBrowser = await databaseQuery(context, `SELECT domain,status,payload_hash AS payloadHash,observed_at AS observedAt,
        payload_json AS payloadJson,created_at AS createdAt,updated_at AS updatedAt
        FROM environment_snapshots WHERE location_id=? AND target_date=? ORDER BY domain`,
      [environment.ENVIRONMENT_LOCATION_ID, targetDate], 'all');
      assert.deepEqual(storedAfterBrowser, storedBeforeBrowser, 'browser reuses persisted SQLite snapshots without rewriting them');
      report.localProviderFixture = { host: '127.0.0.1', externalProviderRequests: 0,
        requestLogPath: 'within-resource-session-only', requests: fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line)),
        persistentEnvironmentLedgerUsed: false, persistentEnvironmentLedgerTouched: false,
        testBudget: { path: 'within-resource-session-only', ...sha256(localBudgetPath) } };
      const offlineEnvCalls = report.localProviderFixture.requests.length;
      assert.equal(offlineEnvCalls, 2, 'only one local weather and one local Marine response were consumed');
      const localBudgetRows = readHashedBudgetJsonl(localBudgetPath);
      const localFinished = localBudgetRows.filter(row => row.event === 'environment-provider-request-finished');
      assert.equal(localFinished.length, 2);
      assert.ok(localFinished.every(row => row.outcome === 'success'));
      report.environmentBrowser.persistedRowsUnchanged = true;
      report.environmentBrowser.providerCallsAddedByBrowser = 0;
      report.environmentBrowser.seaBathingAvailability = { status: seaBathing.availability.status,
        pendingWindows: seaBathing.availability.windows.length, seaStatus: 'missing', stationTide: 'missing' };

      const guestForBooking = await insertSyntheticGuest(context, bookingDate, businessClockNow);
      const guestLogin = assertOk(await request(context.baseUrl, '/auth/login', { method: 'POST',
        body: { username: guestForBooking.username, password: guestForBooking.password, role: 'guest' } }), 200, 'offline booking guest login');
      await seedDemoEnvironment(context, bookingDate, businessClockNow);
      const slot = await seedBookingSlot(context, bookingDate, businessClockNow);
      const booking = { ...slot, date: bookingDate };
      const trace = await seedOfflineAssistant(context, guestForBooking, booking, businessClockNow);
      const seededHistory = assertOk(await request(context.baseUrl,
        `/assistant/history?sessionId=${encodeURIComponent(trace.sessionId)}&role=guest&limit=30`, { token: guestLogin.token }),
      200, 'offline fixture assistant history');
      report.bookingBrowserSeedHistory = { sessionId: seededHistory.sessionId,
        messageCount: seededHistory.messages?.length || 0,
        runIds: (seededHistory.messages || []).map(message => message.runId).filter(Boolean),
        graphAssistantMessages: (seededHistory.messages || []).filter(message => message.role === 'assistant' && message.runId === trace.graphRunId)
          .map(message => ({ id: message.id, content: message.content })),
        actionCardRunIds: (seededHistory.messages || []).filter(message => message.actionCards?.length)
          .map(message => message.runId), hasMore: Boolean(seededHistory.hasMore) };
      assert.equal(report.bookingBrowserSeedHistory.graphAssistantMessages.length, 2,
        'history API returns both persisted assistant messages for the same collaboration run');
      assert.equal(new Set(report.bookingBrowserSeedHistory.graphAssistantMessages.map(message => message.id)).size, 2,
        'the two assistant messages have distinct persistent row IDs and are not recovery-render duplicates');
      assert.ok(report.bookingBrowserSeedHistory.runIds.includes(trace.actionRunId),
        'seeded booking assistant reply appears in the authenticated history endpoint');
      assert.deepEqual(report.bookingBrowserSeedHistory.actionCardRunIds, [trace.actionRunId],
        'seeded slot choice card is attached to its persisted assistant history message');
      const before = await databaseQuery(context, `SELECT COUNT(*) AS count FROM reservations WHERE guest_id=? AND slot_id=? AND status='confirmed'`,
        [guestForBooking.guestId, booking.slotId], 'get');
      assert.equal(Number(before.count), 0);
      try {
        report.bookingBrowser = await runStage27LiveTraceBrowser({ resourceSession: session, apiBaseUrl: context.baseUrl,
          guestId: guestForBooking.guestId, guestUsername: guestForBooking.username, guestPassword: guestForBooking.password,
          runId: trace.graphRunId, sessionId: trace.sessionId, actionRunId: trace.actionRunId,
          needsInputCardId: trace.needsInputCardId, slotId: booking.slotId,
          slotLabel: `${booking.localStart}–${booking.localEnd}`, offlineFixture: true,
          verifyBeforeConfirmation: async ({ guestId, slotId, actionCardId, selectionRunId }) => {
            const row = await databaseQuery(context, `SELECT COUNT(*) AS count FROM reservations WHERE guest_id=? AND slot_id=?`,
              [guestId, slotId], 'get');
            return { guestId, slotId, reservationCount: Number(row?.count || 0), actionCardId, selectionRunId,
              checkedAt: new Date().toISOString(), databaseDriver: context.driver };
          } });
      } catch (error) {
        report.bookingBrowserDiagnostic = {
          latestRuns: await databaseQuery(context, `SELECT id,status,input_text AS inputText,output_text AS outputText,
            error_code AS errorCode,stop_reason AS stopReason,execution_mode AS executionMode,created_at AS createdAt
            FROM agent_runs WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 40`, [trace.sessionId], 'all'),
          latestRunsAcrossSessions: await databaseQuery(context, `SELECT id,session_id AS sessionId,status,input_text AS inputText,
            output_text AS outputText,error_code AS errorCode,stop_reason AS stopReason,execution_mode AS executionMode,created_at AS createdAt
            FROM agent_runs ORDER BY rowid DESC LIMIT 20`, [], 'all'),
          latestSteps: await databaseQuery(context, `SELECT run_id AS runId,step_index AS stepIndex,step_type AS type,
            status,summary,error_code AS errorCode,diagnostic_json AS diagnosticJson FROM agent_steps
            WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id=? ORDER BY created_at DESC,id DESC LIMIT 12)
            ORDER BY run_id,step_index`, [trace.sessionId], 'all'),
          actionCards: await databaseQuery(context, `SELECT id,status,error_code AS errorCode,parameters_json AS parametersJson,
            impact_json AS impactJson,expires_at AS expiresAt FROM assistant_action_cards WHERE session_id=? ORDER BY created_at DESC`,
          [trace.sessionId], 'all')
        };
        throw error;
      }
      const bookingBrowserFlow = report.bookingBrowser?.browserFlow || {};
      const selectionActionCard = await databaseQuery(context, `SELECT id,action_type AS actionType,status,
        parameters_json AS parametersJson,impact_json AS impactJson FROM assistant_action_cards WHERE id=?`,
      [bookingBrowserFlow.confirmedActionCardId || ''], 'get');
      const selectionActionCardEvidence = selectionActionCard ? { id: selectionActionCard.id,
        actionType: selectionActionCard.actionType, status: selectionActionCard.status,
        slotId: JSON.parse(selectionActionCard.impactJson || '{}')?.slot?.id
          || JSON.parse(selectionActionCard.impactJson || '{}')?.slotId
          || JSON.parse(selectionActionCard.parametersJson || '{}')?.slotId || null } : null;
      const reservationRows = await databaseQuery(context, `SELECT id,status,slot_id AS slotId FROM reservations
        WHERE guest_id=? AND slot_id=? AND status='confirmed'`, [guestForBooking.guestId, booking.slotId], 'all');
      const confirmedCount = await databaseQuery(context, `SELECT COUNT(*) AS count FROM reservations
        WHERE guest_id=? AND slot_id=? AND status='confirmed'`, [guestForBooking.guestId, booking.slotId], 'get');
      report.bookingBrowser.confirmationContractEvidence = { browserFlow: bookingBrowserFlow,
        preConfirmationDatabaseReadback: report.bookingBrowser.preConfirmationDatabaseReadback || null,
        selectionActionCard: selectionActionCardEvidence, databaseReservations: reservationRows,
        confirmedReservationCount: Number(confirmedCount?.count || 0), databaseReadAt: new Date().toISOString() };
      assert.equal(report.bookingBrowser.status, 'PASS');
      assert.equal(report.bookingBrowser.browserFlow.offlineFixture, true);
      assert.equal(report.bookingBrowser.browserFlow.executionModeLabel, '离线网页夹具 · 未调用模型');
      assert.deepEqual(report.bookingBrowser.browserFlow.externalRequests, []);
      const confirmationContract = validateQ275ConfirmationContract({
        browserFlow: bookingBrowserFlow,
        preConfirmationDatabaseReadback: report.bookingBrowser.preConfirmationDatabaseReadback,
        selectionActionCard: selectionActionCardEvidence, reservation: reservationRows[0] || null,
        confirmedReservationCount: Number(confirmedCount?.count || 0),
        expected: { graphRunId: trace.graphRunId, proposalRunId: trace.actionRunId,
          needsInputCardId: trace.needsInputCardId, selectionRunId: bookingBrowserFlow.selectionRunId,
          slotId: booking.slotId }
      });
      report.bookingBrowser.confirmationContract = confirmationContract;
      report.bookingBrowser.databaseReadback = reservationRows[0];
      report.bookingBrowser.offlineOnly = true;
      assert.equal(guestLogin.user.id, guestForBooking.guestId);
      const finalLocalBudgetRows = readHashedBudgetJsonl(localBudgetPath);
      const finalLocalFinished = finalLocalBudgetRows.filter(row => row.event === 'environment-provider-request-finished');
      assert.equal(finalLocalFinished.length, 4, 'two local weather/Marine requests for each of the two fixture dates are budgeted');
      assert.ok(finalLocalFinished.every(row => row.outcome === 'success'));
      report.localProviderFixture.finalTestBudget = { ...sha256(localBudgetPath), finishedRequests: finalLocalFinished.length,
        outcomes: finalLocalFinished.map(row => row.outcome) };
    }, { resourceSession: session, env: environment });

    const requestRows = fs.readFileSync(requestLogPath, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line));
    report.localProviderFixture.requests = requestRows;
    assert.equal(requestRows.length, 4, 'the environment panel and next-day booking revalidation each make one local weather/Marine pair');
    assert.deepEqual(requestRows.map(row => row.path).sort(), ['/v1/forecast', '/v1/forecast', '/v1/marine', '/v1/marine']);
    report.localProviderFixture.requestCountByPath = Object.fromEntries(['/v1/forecast', '/v1/marine'].map(route =>
      [route, requestRows.filter(row => row.path === route).length]));
    const fixtureStop = await session.stop(fixtureResource.id, 'offline-provider-fixture-complete');
    assert.equal(fixtureStop.ok, true);
    const fixtureExit = await session.waitProcess(fixtureResource.id, 10_000);
    assert.ok(['exited', 'stopped'].includes(fixtureExit.status), `local fixture reached a terminal status: ${JSON.stringify(fixtureExit)}`);
    assert.equal(fixtureExit.exitCode, 0);
    assert.equal(fixtureExit.signal || null, null);
    assert.equal(Boolean(fixtureExit.timedOut), false);
    report.localProviderFixture.process = { pid: fixtureResource.pid, status: fixtureExit.status,
      exitCode: fixtureExit.exitCode, signal: fixtureExit.signal || null };
    fixtureResource = null;

    const changedJs = ['scripts/quests/helpers.js', 'scripts/quests/q14.js', 'scripts/quests/q27.js',
      'scripts/resources/stage26-browser-acceptance.js', 'scripts/resources/stage27-r4-budget-accounts.js',
      'scripts/resources/stage27-r4-confirmation-contract.js', 'scripts/resources/stage27-r4-offline-tests.mjs',
      'scripts/resources/run-stage27-r4-offline-acceptance.mjs',
      'server/src/environment-providers.js', 'server/src/environment-config.js', 'server/src/environment.js',
      'server/src/environment-availability.js'];
    for (const file of changedJs) report.commands.push(await managedCommand(session, `node-check-${path.basename(file)}`,
      process.execPath, ['--check', path.join(projectRoot, file)]));
    report.commands.push(await managedCommand(session, 'git-diff-check', 'git', ['diff', '--check']));
    report.commands.push(await managedCommand(session, 'npm-test', 'npm', ['test']));
    report.commands.push(await managedCommand(session, 'npm-build', 'npm', ['run', 'build']));

    const sourceCodePurposes = {
      'server/src/environment-providers.js': 'Normalize provider-local weather observation timestamps with the response UTC offset or timezone; keep local forecast-hour mapping.',
      'scripts/quests/q27.js': 'Record and validate the real Q27.5 webpage confirmation against the selected card and SQLite before PASS; apply only the approved source-only +12 request event in the existing window; retain Q27.6 time checks.',
      'scripts/quests/q14.js': 'Update the existing weather adapter regression to assert UTC normalization and retained local time.',
      'scripts/resources/stage26-browser-acceptance.js': 'Return actual confirmation HTTP status, card and reservation IDs before business-contract assertions so failures retain raw evidence.',
      'scripts/resources/stage27-r4-confirmation-contract.js': 'Validate the real nested HTTP confirmation response against the selected card, exact slot, pre-write evidence, and independent SQLite readback.',
      'scripts/resources/stage27-r4-budget-accounts.js': 'Verify and account for the single source-only +12 request approval in the existing cumulative window without changing other limits.',
      'scripts/resources/run-stage27-r4-offline-acceptance.mjs': 'Seed same-session graph retry history and proposal, run the actual offline browser confirmation, save raw HTTP and SQLite evidence before contract assertions, and record repair evidence.',
      'scripts/resources/stage27-r4-offline-tests.mjs': 'Cover booking confirmation contract failures, one-time source-only allowance checks, and environment timestamp cases.',
      'web/src/main.jsx': 'Keep persisted messages with the same runId distinct and attach recovered run data to the latest matching assistant reply.',
      'web/src/EnvironmentPanel.jsx': 'Explain that modeled mode does not provide station tide or exact station high/low events.'
    };
    const codeChanges = [];
    for (const baselineFile of sourceHandoffBaseline.currentCodeBaseline) {
      const currentFile = sha256(baselineFile.path);
      if (!currentFile.exists || currentFile.hash !== baselineFile.sha256) {
        const relativePath = path.relative(projectRoot, baselineFile.path).split(path.sep).join('/');
        codeChanges.push({ path: relativePath, purpose: sourceCodePurposes[relativePath] || 'Changed after the source handoff code fingerprint; review required.',
          baselineBytes: baselineFile.bytes, baselineSha256: baselineFile.sha256,
          currentBytes: currentFile.bytes, currentSha256: currentFile.hash, exists: currentFile.exists });
      }
    }
    report.codeChangesSinceSourceHandoffBaseline = { baselineFileCount: sourceHandoffBaseline.currentCodeBaseline.length,
      changedFileCount: codeChanges.length, files: codeChanges };
    const taskScopedCodeChanges = [
      ['scripts/quests/q27.js', 'Use immutable source identity/window and verified one-time approval; save booking confirmation evidence before contract checks.'],
      ['scripts/resources/stage26-browser-acceptance.js', 'Return nested HTTP confirmation response evidence without preemptive reservation-ID assertions.'],
      ['scripts/resources/stage27-r4-budget-accounts.js', 'Verify the approved +12 event and keep all non-request caps unchanged.'],
      ['scripts/resources/stage27-r4-confirmation-contract.js', 'Share the strict browser-response/action-card/SQLite confirmation contract.'],
      ['scripts/resources/stage27-r4-offline-tests.mjs', 'Test negative booking contracts and source-only allowance boundaries.'],
      ['scripts/resources/run-stage27-r4-offline-acceptance.mjs', 'Run managed offline SQLite/browser evidence and retain source/worker account hashes.']
    ].map(([relativePath, purpose]) => {
      const currentFile = sha256(path.join(projectRoot, relativePath));
      return { path: relativePath, purpose, exists: currentFile.exists, bytes: currentFile.bytes, sha256: currentFile.hash };
    });
    report.taskScopedCodeChanges = taskScopedCodeChanges;
    report.gitEvidence = {
      head: await managedCommand(session, 'git-head', 'git', ['rev-parse', 'HEAD'], projectRoot, 30_000),
      status: await managedCommand(session, 'git-status-short', 'git', ['status', '--short', '--untracked-files=all'], projectRoot, 30_000, 100_000),
      diffStat: await managedCommand(session, 'git-diff-stat', 'git', ['diff', '--stat'], projectRoot, 30_000, 30_000),
      stagedDiffStat: await managedCommand(session, 'git-staged-diff-stat', 'git', ['diff', '--cached', '--stat'], projectRoot, 30_000, 30_000),
      writesRequested: false
    };

    const modelBudgetAfter = sha256(persistentModelBudgetPath, { maxBytes: 8 * 1024 * 1024 });
    assert.deepEqual(modelBudgetAfter, persistentModelBudgetBefore, 'offline acceptance leaves the exhausted persistent model window unchanged');
    report.persistentModelBudgetAfter = modelBudgetAfter;
    const sourceModelBudgetAfter = sha256(sourcePersistentModelBudgetPath, { maxBytes: 8 * 1024 * 1024 });
    assert.deepEqual(sourceModelBudgetAfter, sourcePersistentModelBudgetBefore,
      'offline verification leaves the source-only model budget account unchanged');
    report.sourcePersistentModelBudgetAfter = sourceModelBudgetAfter;
    const sourceApprovalAfter = sha256(sourceRequestLimitApprovalPath, { maxBytes: 64 * 1024 });
    assert.deepEqual(sourceApprovalAfter, sourceRequestLimitApprovalBefore,
      'offline verification leaves the source approval record unchanged');
    report.sourceRequestLimitApprovalAfter = sourceApprovalAfter;
    report.workerModelBudgetRequestsBefore = persistentModelBudgetBefore.exists
      ? readHashedBudgetJsonl(persistentModelBudgetPath).filter(row => row.event === 'repair-provider-usage-recorded')
        .reduce((sum, row) => sum + Number(row.usage?.requests || 0), 0) : null;
    report.status = 'PASS_OFFLINE_VERIFICATION_ONLY';
  } catch (error) {
    report.status = 'FAIL_OFFLINE_VERIFICATION';
    report.errors.push(String(error?.stack || error?.message || error).slice(0, 16_000));
  } finally {
    if (fixtureResource) {
      try {
        const status = (await session.status()).resources?.find(item => item.id === fixtureResource.id);
        if (status && ['starting', 'running'].includes(status.status)) await session.stop(fixtureResource.id, 'offline-fixture-finally');
        const result = await session.waitProcess(fixtureResource.id, 10_000);
        report.localProviderFixture ||= {};
        report.localProviderFixture.process = { pid: fixtureResource.pid, status: result.status,
          exitCode: result.exitCode ?? null, signal: result.signal || null, timedOut: Boolean(result.timedOut) };
      } catch (error) { cleanupFailure ||= `local fixture shutdown: ${error.message}`; }
    }
    try {
      const status = await session.status();
      const liveResources = (status.resources || []).filter(item => ['starting', 'running'].includes(item.status));
      report.resourceCleanup = { resourcesBeforeClose: status.resources || [], liveResourcesBeforeClose: liveResources,
        allResourcesExitedBeforeGuardianClose: liveResources.length === 0 };
      assert.equal(liveResources.length, 0, `managed processes remain before ResourceSession close: ${JSON.stringify(liveResources)}`);
    } catch (error) { cleanupFailure ||= `pre-close resource inventory: ${error.message}`; }
    try {
      const closed = await session.close(report.status === 'PASS_OFFLINE_VERIFICATION_ONLY' ? 'offline-verification-complete' : 'offline-verification-failed');
      report.resourceCleanup ||= {};
      report.resourceCleanup.close = closed;
      report.resourceCleanup.guardianExitObservation = session.guardianExitObservation;
      report.resourceCleanup.guardianIdentity = session.guardianIdentity;
      report.resourceCleanup.tempDirPresentAfterClose = fs.existsSync(session.tempDir);
      report.resourceCleanup.socketPresentAfterClose = fs.existsSync(session.socketPath);
      report.resourceCleanup.registryPath = session.registryPath;
      report.resourceCleanup.registryInstanceEvents = fs.readFileSync(session.registryPath, 'utf8').split(/\r?\n/u)
        .filter(Boolean).map(line => JSON.parse(line)).filter(row => row.instanceId === session.instanceId);
      const cleanup = [...report.resourceCleanup.registryInstanceEvents].reverse().find(row =>
        ['instance_cleaned', 'instance_cleanup_blocked', 'instance_cleanup_preserved'].includes(row.event));
      report.resourceCleanup.instanceCleanupRecord = cleanup || null;
      assert.equal(report.resourceCleanup.tempDirPresentAfterClose, false);
      assert.equal(report.resourceCleanup.socketPresentAfterClose, false);
      assert.equal(cleanup?.event, 'instance_cleaned');
      assert.equal(cleanup?.openHandleCheck, 'lsof +D and lsof +L1 completed with no matching handles');
      assert.equal(closed.ok, true);
    } catch (error) { cleanupFailure ||= `ResourceSession close: ${error.message}`; }
    report.completedAt = new Date().toISOString();
    report.cleanupFailure = cleanupFailure;
    if (cleanupFailure) report.status = 'BLOCKED_RESOURCE_CLEANUP';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ status: report.status, reportPath, environmentScreenshot: report.environmentBrowser?.screenshotPath || null,
    bookingScreenshots: report.bookingBrowser?.screenshots || null, resourceRegistry: session.registryPath,
    cleanupStatus: report.resourceCleanup?.instanceCleanupRecord?.event || null }));
  if (report.status !== 'PASS_OFFLINE_VERIFICATION_ONLY') process.exitCode = 1;
}

await main();
