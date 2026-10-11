import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { withTemporaryApi } from '../quests/helpers.js';
import { databaseQuery, login } from '../quests/q10-helpers.js';
import { processIdentity, processMatches } from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfigPath = path.join(projectRoot, 'scripts/resources/playwright-cli.config.json');
const screenshotRoot = path.join(projectRoot, 'output/playwright');
const taskId = process.env.CODEX_TASK_ID;
const testDates = { previous: '2026-10-08', today: '2026-10-09', checkout: '2026-10-14' };
const previousStart = '2026-10-08T01:00:00.000Z';
const currentStart = '2026-10-09T01:00:00.000Z';
const currentAfterStart = '2026-10-09T01:30:00.000Z';
const protectedChrome = { pid: 7081, startTime: 'Thu Oct 1 17:27:01 2026',
  fingerprint: 'a30da864807c765187c20eb24b90dfaedb6d8273c8675d112e09016b42ec949d' };
const cacheParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const expectedCacheNames = [
  'code_sign_clone.7WCMBh', 'code_sign_clone.87prgQ', 'code_sign_clone.FGf0ku', 'code_sign_clone.KlYqcP',
  'code_sign_clone.Km1hwm', 'code_sign_clone.Ly34OH', 'code_sign_clone.b9cnAV', 'code_sign_clone.fpg2xz',
  'code_sign_clone.jcG5XI', 'code_sign_clone.ooLA7h', 'code_sign_clone.xkTnpB'
];

function runBounded(command, args, timeout = 5000, maxBuffer = 128 * 1024) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} interrupted by ${result.signal}`);
  return result;
}

function dfSnapshot(label) {
  const result = runBounded('df', ['-Pk', '/tmp']);
  assert.equal(result.status, 0, `df -Pk /tmp exited ${result.status}`);
  const columns = result.stdout.trim().split(/\r?\n/).at(-1).trim().split(/\s+/);
  assert.ok(columns.length >= 6, 'could not parse /tmp filesystem usage');
  return { label, command: 'df -Pk /tmp', exitCode: result.status, filesystem: columns[0],
    usedKiB: Number(columns[2]), availableKiB: Number(columns[3]), mountedOn: columns.slice(5).join(' '), at: new Date().toISOString() };
}

function userChromeSnapshot() {
  const priorTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  let identity;
  try { identity = processIdentity(protectedChrome.pid); }
  finally { if (priorTimezone === undefined) delete process.env.TZ; else process.env.TZ = priorTimezone; }
  const handles = runBounded('lsof', ['-nP', '-p', String(protectedChrome.pid), '-Fn'], 5000, 64 * 1024);
  assert.ok([0, 1].includes(handles.status), `protected Chrome lsof exited ${handles.status}`);
  const clonePaths = (handles.stdout || '').split(/\r?\n/)
    .filter(line => line.startsWith('n') && line.includes('/code_sign_clone.'))
    .map(line => line.slice(1).slice(0, 2048)).sort();
  return { identity, identityTimezone: 'Asia/Shanghai', lsofExitCode: handles.status, clonePaths };
}

function assertProtectedChrome(snapshot, label) {
  assert.equal(snapshot.identity?.pid, protectedChrome.pid, `${label}: protected Chrome PID`);
  assert.equal(snapshot.identity?.startTime.replace(/\s+/g, ' '), protectedChrome.startTime, `${label}: protected Chrome start time`);
  assert.equal(snapshot.identity?.fingerprint, protectedChrome.fingerprint, `${label}: protected Chrome fingerprint`);
}

async function cacheNames() {
  return (await fs.readdir(cacheParent)).filter(name => name.startsWith('code_sign_clone.')).sort();
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('could not reserve loopback port')));
    });
  });
}

function slotId(projectId, date, start, end) {
  return `slot_${crypto.createHash('sha256').update(`${projectId}\u0000${date}\u0000${start}\u0000${end}`).digest('hex').slice(0, 32)}`;
}

function sqlTime(value) { return value.replace('T', ' ').replace(/Z$/, ''); }

async function seedEnvironment(context, date, observedAt) {
  const demo = makeDemoEnvironment(date, observedAt, DEMO_ENVIRONMENT_LOCATION);
  const snapshots = [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]];
  for (const [domain, stationId, payload] of snapshots) {
    const key = `env:${crypto.createHash('sha256').update(JSON.stringify(
      [DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain])).digest('hex').slice(0, 48)}`;
    const json = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(json).digest('hex');
    await databaseQuery(context, `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,
       payload_hash,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_key) DO UPDATE SET status=excluded.status,source_name=excluded.source_name,
       source_url=excluded.source_url,observed_at=excluded.observed_at,expires_at=excluded.expires_at,
       payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
    [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, payload.sourceName || 'Stage24 本地合成快照',
      payload.sourceUrl || '', observedAt, '2026-10-09T04:00:00.000Z', hash, json, observedAt, observedAt], 'run');
  }
}

async function insertActualSlot(context, date, start = '08:30', end = '09:00') {
  const id = slotId('project-beach-walk', date, start, end);
  const startsAt = new Date(`${date}T${start}:00+08:00`).toISOString();
  const endsAt = new Date(`${date}T${end}:00+08:00`).toISOString();
  const stamp = '2026-10-08T00:00:00.000Z';
  await databaseQuery(context, `INSERT INTO activity_slots
    (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,5,0,?,?) ON CONFLICT(id) DO UPDATE SET capacity=5,is_closed=0,updated_at=excluded.updated_at`,
  [id, 'project-beach-walk', date, startsAt, endsAt, start, end, stamp, stamp], 'run');
  return { id, date, start, end, startsAt, endsAt };
}

async function callApi(baseUrl, route, { method = 'GET', token, body, idempotencyKey } = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' })
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

function requireStatus(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data).slice(0, 800)}`);
  return result.data;
}

async function prepareAppointments(context, resourceSession, modelUrl) {
  const guestLogin = requireStatus(await login(context.baseUrl, 'guest'), 200, 'browser guest login');
  const guestId = guestLogin.user.id;
  const profile = { chronic: { status: 'none', items: [] }, medications: { status: 'none', items: [] },
    allergies: { status: 'none', items: [] }, dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'independent', details: '可独立行走' }, sleep: { status: 'reported', details: '睡眠正常' },
    skin: { status: 'reported', details: '皮肤完整' }, audienceTags: { status: 'none', items: [] } };
  await databaseQuery(context, `UPDATE guest_profiles SET check_in=?,check_out=?,chronic_json='[]',allergies_json='[]',mobility=?,
    health_profile_json=?,health_profile_version=health_profile_version+1,updated_at=? WHERE user_id=?`,
  [testDates.previous, '可独立行走', JSON.stringify(profile), '2026-10-08T00:00:00.000Z', guestId], 'run');
  await seedEnvironment(context, testDates.previous, '2026-10-08T00:00:00.000Z');
  await seedEnvironment(context, testDates.today, '2026-10-08T00:00:00.000Z');
  const oldSlot = await insertActualSlot(context, testDates.previous);
  const todaySlot = await insertActualSlot(context, testDates.today);
  const oldBooking = requireStatus(await callApi(context.baseUrl, '/reservations', { method: 'POST', token: guestLogin.token,
    body: { slotId: oldSlot.id }, idempotencyKey: 'q24-browser-old-booking-0001' }), 201, 'real previous-day appointment');
  const oldAppointmentId = oldBooking.reservation.id;

  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: '2026-10-08T01:30:00.000Z' });
  const oldCheckin = requireStatus(await callApi(context.baseUrl, `/me/reservations/${encodeURIComponent(oldAppointmentId)}/checkin`,
    { method: 'POST', token: guestLogin.token, body: {} }), 201, 'previous-day actual check-in');
  const oldFeedback = requireStatus(await callApi(context.baseUrl, `/me/reservations/${encodeURIComponent(oldAppointmentId)}/feedback`,
    { method: 'POST', token: guestLogin.token, body: { feeling: 'comfortable', note: '昨日的已提交记录。' } }), 201, 'previous-day feedback fixture');
  const todayBooking = requireStatus(await callApi(context.baseUrl, '/reservations', { method: 'POST', token: guestLogin.token,
    body: { slotId: todaySlot.id }, idempotencyKey: 'q24-browser-today-booking-0001' }), 201, 'real current-day appointment');
  const currentAppointmentId = todayBooking.reservation.id;

  const draftId = `wellness_draft_q24_browser_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const itemId = `wellness_item_q24_browser_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const stamp = '2026-10-08T01:30:00.000Z';
  await databaseQuery(context, `INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
     evidence_json,created_at,review_status,review_thread_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,1,?,NULL,?,?,'active','auto',0,?,?,'active',?,NULL,NULL,NULL)`,
  [draftId, guestId, `q24-browser-baseline:${draftId}`, testDates.previous, testDates.checkout,
    JSON.stringify({ sourceMode: 'recorded_fixture', fixturePurpose: 'Q24 browser baseline only' }), stamp, draftId], 'run');
  await databaseQuery(context, `INSERT INTO wellness_draft_items
    (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
     rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
    VALUES(?,?,?,'morning','activity','project-beach-walk','滨海漫步',?,?, 'proposed','现有已激活演示基线。',
     '海屿服务区（演示地点）','[]',?,NULL,?)`,
  [itemId, draftId, testDates.today, todaySlot.start, todaySlot.end,
    JSON.stringify([{ type: 'project_slot', id: todaySlot.id, label: '真实预约时段' }]), JSON.stringify({ sourceMode: 'recorded_fixture' })], 'run');
  await databaseQuery(context, 'UPDATE reservations SET wellness_draft_id=?,wellness_draft_item_id=? WHERE id=?',
    [draftId, itemId, currentAppointmentId], 'run');
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: currentAfterStart });
  return { guestId, guestName: guestLogin.user.name, token: guestLogin.token,
    previousAppointmentId: oldAppointmentId, previousCheckinId: oldCheckin.id, previousFeedbackId: oldFeedback.id,
    currentAppointmentId, currentSlotId: todaySlot.id, baselineDraftId: draftId,
    modelUrl, clockNow: currentAfterStart, stay: { checkIn: testDates.previous, checkOut: testDates.checkout } };
}

function resourceSummary(resource) {
  if (!resource) return null;
  return { id: resource.id, label: resource.label, kind: resource.kind, role: resource.role, status: resource.status,
    pid: resource.pid, processGroup: resource.processGroup, processStartTime: resource.processStartTime,
    processFingerprint: resource.processFingerprint, command: resource.command, cwd: resource.cwd, tempDir: resource.tempDir,
    port: resource.port, logPath: resource.logPath, logBytes: resource.logBytes, maxLogBytes: resource.maxLogBytes,
    directoryPeakBytes: resource.directoryPeakBytes, maxDirectoryBytes: resource.maxDirectoryBytes,
    leaseExpiresAt: resource.leaseExpiresAt, pids: resource.pids };
}

async function waitForHttp(url, resourceSession, resourceId, label) {
  const deadline = Date.now() + 20_000;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    const current = (await resourceSession.status()).resources?.find(item => item.id === resourceId);
    if (!current || !['starting', 'running'].includes(current.status)) {
      const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error(`${label} stopped before readiness: ${tail.tail || current?.status || 'missing'}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
  throw new Error(`${label} readiness timed out (${lastError}): ${tail.tail || ''}`);
}

async function waitForFile(filePath, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for browser open marker');
}

function chromeCommandLine(pid) {
  const result = runBounded('ps', ['-ww', '-p', String(pid), '-o', 'command='], 3000, 64 * 1024);
  assert.equal(result.status, 0, `could not read isolated Chrome PID ${pid}`);
  return result.stdout.trim();
}

async function isolatedChrome(profilePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runBounded('ps', ['-ww', '-Ao', 'pid=,command='], 4000, 1024 * 1024);
    assert.equal(result.status, 0, 'could not inspect the process table for isolated Chrome');
    const pids = result.stdout.split(/\r?\n/).flatMap(line => {
      const match = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!match || !match[2].includes(`--user-data-dir=${profilePath}`)
        || !match[2].includes('/Google Chrome.app/Contents/MacOS/Google Chrome') || match[2].includes('/Helpers/')) return [];
      return [Number(match[1])];
    });
    if (pids.length === 1) {
      const identity = processIdentity(pids[0]);
      assert.ok(identity, 'isolated Chrome disappeared during identity capture');
      return { ...identity, command: chromeCommandLine(pids[0]) };
    }
    assert.ok(pids.length <= 1, `multiple isolated Chrome processes use the profile: ${pids.join(',')}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('could not identify isolated Chrome main process');
}

async function stopAndWait(resourceSession, resource, reason, timeoutMs = 15_000) {
  if (!resource) return null;
  const current = (await resourceSession.status()).resources?.find(item => item.id === resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await resourceSession.stop(resource.id, reason);
    if (!stopped.ok) throw new Error(`${resource.label} stop failed: ${stopped.error || 'unknown error'}`);
  }
  const result = await resourceSession.waitProcess(resource.id, timeoutMs);
  assert.ok(!result.timedOut && !result.unavailable && !['starting', 'running'].includes(result.status),
    `${resource.label} did not exit: ${JSON.stringify(result)}`);
  return result;
}

export async function runStage24BrowserAcceptance({ resourceSession }) {
  assert.ok(taskId, 'Stage24 browser acceptance requires CODEX_TASK_ID');
  assert.ok(resourceSession, 'Stage24 browser acceptance requires the current managed ResourceSession');
  const npx = runBounded('bash', ['-lc', 'command -v npx'], 5000, 16 * 1024);
  assert.equal(npx.status, 0, 'npx must be available for the bundled Playwright CLI');
  const cacheBaseline = await cacheNames();
  assert.deepEqual(cacheBaseline, expectedCacheNames, 'protected Chrome cache set must match its read-only preflight');
  const protectedBefore = userChromeSnapshot();
  assertProtectedChrome(protectedBefore, 'before-browser');
  const config = JSON.parse(await fs.readFile(playwrightConfigPath, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config must contain one merged disable-features argument');
  assert.ok(featureArgs[0].split('=')[1].split(',').includes('MacAppCodeSignClone'), 'merged Chrome flags must preserve MacAppCodeSignClone');

  await fs.mkdir(screenshotRoot, { recursive: true });
  let suffix = 1;
  let screenshotDirectory = path.join(screenshotRoot, `stage24-${taskId}-${String(suffix).padStart(2, '0')}`);
  while (fsSync.existsSync(screenshotDirectory)) {
    suffix += 1;
    screenshotDirectory = path.join(screenshotRoot, `stage24-${taskId}-${String(suffix).padStart(2, '0')}`);
  }
  await fs.mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  const screenshots = {
    schedule1280: path.join(screenshotDirectory, 'q24-schedule-feedback-diff-1280.png'),
    schedule1920: path.join(screenshotDirectory, 'q24-schedule-feedback-diff-1920.png'),
    mood1280: path.join(screenshotDirectory, 'q24-mood-replanning-source-1280.png'),
    mood1920: path.join(screenshotDirectory, 'q24-mood-replanning-source-1920.png')
  };
  const evidencePath = path.join(screenshotDirectory, 'stage24-browser-evidence.json');
  const diagnosticPath = path.join(screenshotDirectory, 'stage24-browser-failure-debug.png');
  const evidence = { schemaVersion: 1, taskId, worktree: projectRoot, observedAt: new Date().toISOString(), status: 'RUNNING',
    browserConfigPath: playwrightConfigPath, browserConfigFeatureArg: featureArgs[0], cacheParent,
    protectedChromeBaseline: protectedChrome, cacheSnapshots: [{ label: 'before-browser', names: cacheBaseline }],
    protectedChromeSnapshots: [{ label: 'before-browser', ...protectedBefore }], resources: [], cliSteps: [], screenshots,
    businessClock: currentAfterStart, limits: { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 },
    dfBefore: dfSnapshot('before-browser') };

  let modelResource;
  let viteResource;
  let browserOwner;
  let browserOpened = false;
  let chrome;
  let socketAlias;
  let socketAliasCreated = false;
  let cliDirectory;
  let sessionName;
  let failure;

  async function runCli(args, label, timeoutMs = 60_000) {
    const resource = await resourceSession.startProcess({ label, kind: 'browser', role: 'browser-cli', command: 'bash',
      args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfigPath] : []), '--session', sessionName, ...args],
      cwd: cliDirectory,
      env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias } });
    let result = await resourceSession.waitProcess(resource.id, timeoutMs);
    if (result.timedOut) {
      await resourceSession.stop(resource.id, `${label}-timeout`);
      result = await resourceSession.waitProcess(resource.id, 15_000);
    }
    const tail = await resourceSession.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    evidence.cliSteps.push({ label, command: `bash ${playwrightWrapper} ${args[0] === 'open' ? `--config ${playwrightConfigPath} ` : ''}--session ${sessionName} ${args.join(' ')}`,
      ...resourceSummary(resource), exitCode: result.exitCode ?? null, signal: result.signal || null, timedOut: Boolean(result.timedOut),
      outputTail: String(tail.tail || '').slice(-8192) });
    assert.equal(result.status, 'exited', `${label} did not exit cleanly: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(result.exitCode, 0, `${label} exit code: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(result.signal || null, null, `${label} was signaled`);
    return String(tail.tail || '');
  }

  try {
    sessionName = `stage24-${resourceSession.instanceId.slice(0, 8)}`;
    cliDirectory = await resourceSession.allocateDir('stage24-browser-cli');
    const socketsDirectory = await resourceSession.allocateDir('stage24-playwright-sockets');
    socketAlias = path.join('/tmp', `pw-${resourceSession.instanceId.slice(0, 8)}`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright socket alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDirectory, socketAlias, 'dir');
    socketAliasCreated = true;
    const profilePath = path.join(cliDirectory, 'chrome-profile');
    const openMarker = path.join(cliDirectory, 'open-status.json');
    const ownerPath = path.join(cliDirectory, 'browser-session-owner.mjs');
    const flowPath = path.join(cliDirectory, 'stage24-browser-flow.mjs');
    const modelPort = await availablePort();
    const modelUrl = `http://127.0.0.1:${modelPort}/v1`;
    modelResource = await resourceSession.startProcess({ label: 'q24-browser-recorded-model-fixture', kind: 'stub', role: 'model-provider',
      command: process.execPath, args: [path.join(projectRoot, 'scripts/resources/q22-recorded-model-server.js')], cwd: projectRoot,
      port: modelPort, env: { PATH: process.env.PATH || '', PORT: String(modelPort) } });
    assert.equal(modelResource.status, 'running', 'recorded fixture provider must start under ResourceSession');
    await waitForHttp(`http://127.0.0.1:${modelPort}/health`, resourceSession, modelResource.id, 'recorded model fixture');

    const initialClock = '2026-10-08T00:00:00.000Z';
    await withTemporaryApi(async context => {
      const fixtures = await prepareAppointments(context, resourceSession, modelUrl);
      evidence.fixtures = { ...fixtures, token: undefined };
      evidence.apiOrigin = new URL(context.baseUrl).origin;
      const webPort = await availablePort();
      const webUrl = `http://127.0.0.1:${webPort}`;
      viteResource = await resourceSession.startProcess({ label: 'q24-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort, env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1',
          API_PROXY_TARGET: new URL(context.baseUrl).origin, WEB_PORT: String(webPort) } });
      assert.equal(viteResource.status, 'running', 'Vite must start under ResourceSession');
      await waitForHttp(webUrl, resourceSession, viteResource.id, 'Vite');
      const ownerPath = path.join(cliDirectory, 'browser-session-owner.mjs');
      await fs.writeFile(ownerPath, `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const child = spawn('bash', [process.env.PLAYWRIGHT_WRAPPER, '--config', process.env.PLAYWRIGHT_CONFIG,
  '--session', process.env.PLAYWRIGHT_SESSION, 'open', process.env.PLAYWRIGHT_URL,
  '--profile', process.env.PLAYWRIGHT_PROFILE, '--idle-timeout', '0'], {
  cwd: process.cwd(), env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
    PWTEST_SOCKETS_DIR: process.env.PLAYWRIGHT_SOCKETS_DIR, TMPDIR: process.env.PLAYWRIGHT_SOCKETS_DIR,
    TMP: process.env.PLAYWRIGHT_SOCKETS_DIR, TEMP: process.env.PLAYWRIGHT_SOCKETS_DIR }, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4096); process.stdout.write(chunk); });
child.once('error', error => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code: 1, error: error.message, output })); process.exitCode = 1; });
child.once('close', (code, signal) => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code, signal, output })); if (code !== 0) process.exitCode = 1; });
setInterval(() => {}, 1000);
`);
      const owner = await resourceSession.startProcess({ label: 'q24-playwright-session-owner', kind: 'browser', role: 'browser-session-owner',
        command: process.execPath, args: [ownerPath], cwd: cliDirectory,
        env: { PATH: process.env.PATH || '', PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfigPath,
          PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker,
          PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: webUrl } });
      browserOwner = owner;
      assert.equal(browserOwner.status, 'running', 'Playwright owner must start under ResourceSession');
      browserOpened = true;
      const opened = await waitForFile(openMarker);
      evidence.cliSteps.push({ label: 'open', exitCode: opened.code, signal: opened.signal || null,
        status: opened.code === 0 ? 'exited' : 'failed', configPassedOnlyToOpen: true, outputTail: String(opened.output || '').slice(-4096) });
      assert.equal(opened.code, 0, `Playwright open: ${String(opened.output || '').slice(-1000)}`);
      assert.equal(opened.signal || null, null, 'Playwright open was signaled');
      chrome = await isolatedChrome(profilePath);
      assert.notEqual(chrome.pid, protectedChrome.pid, 'isolated browser must not be the protected user Chrome');
      assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Chrome uses the managed isolated profile');
      const disableArgs = chrome.command.match(/--disable-features=[^\s]+/g) || [];
      assert.deepEqual(disableArgs, [featureArgs[0]], 'isolated Chrome uses the single merged project launch flag');
      evidence.chrome = { pid: chrome.pid, startTime: chrome.startTime, fingerprint: chrome.fingerprint,
        processGroup: chrome.pgid, profilePath, effectiveDisableFeatures: disableArgs[0] };
      const protectedDuring = userChromeSnapshot();
      assertProtectedChrome(protectedDuring, 'during-browser-open');
      assert.deepEqual(protectedDuring.clonePaths, protectedBefore.clonePaths, 'protected Chrome handles remain unchanged');
      evidence.protectedChromeSnapshots.push({ label: 'during-browser-open', ...protectedDuring });
      const cacheDuring = await cacheNames();
      assert.deepEqual(cacheDuring, expectedCacheNames, 'isolated browser did not create or remove protected Chrome caches');
      evidence.cacheSnapshots.push({ label: 'during-browser-open', names: cacheDuring });
      await runCli(['snapshot'], 'q24-playwright-initial-snapshot', 30_000);

      let flow = await fs.readFile(new URL('./stage24-browser-flow.js', import.meta.url), 'utf8');
      flow = flow.replace('__WEB_URL__', JSON.stringify(webUrl)).replace('__SCREENSHOTS__', JSON.stringify(screenshots))
        .replace('__FIXTURES__', JSON.stringify({ guestName: fixtures.guestName, currentAppointmentId: fixtures.currentAppointmentId,
          previousAppointmentId: fixtures.previousAppointmentId, previousFeedbackId: fixtures.previousFeedbackId,
          baselineDraftId: fixtures.baselineDraftId, businessDate: testDates.today, frozenAt: currentAfterStart }));
      await fs.writeFile(flowPath, flow);
      const output = await runCli(['run-code', '--filename', flowPath], 'q24-playwright-business-flow', 240_000);
      const resultLine = output.match(/STAGE24_BROWSER_RESULT:(\{[^\r\n]*\})/);
      assert.ok(resultLine, `browser flow omitted structured evidence: ${output.slice(-2000)}`);
      evidence.browserFlow = JSON.parse(resultLine[1]);
      evidence.browserFlowOutputBytes = Buffer.byteLength(output, 'utf8');
      evidence.cacheSnapshots.push({ label: 'after-browser-flow', names: await cacheNames() });
      const protectedAfter = userChromeSnapshot();
      assertProtectedChrome(protectedAfter, 'after-browser-flow');
      assert.deepEqual(protectedAfter.clonePaths, protectedBefore.clonePaths, 'protected Chrome handles unchanged after browser flow');
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-flow', ...protectedAfter });
      for (const file of Object.values(screenshots)) await fs.access(file);
      const closedOutput = await runCli(['close'], 'q24-playwright-close', 30_000);
      browserOpened = false;
      evidence.cliSteps.push({ label: 'close-session', status: 'exited', exitCode: 0, configPassedOnlyToOpen: true,
        outputTail: closedOutput.slice(-4096) });
      const chromeDeadline = Date.now() + 15_000;
      while (processMatches(chrome.pid, chrome) && Date.now() < chromeDeadline) await new Promise(resolve => setTimeout(resolve, 100));
      evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
      assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `isolated Chrome PID ${chrome.pid} remains after close`);
      const cacheAfter = await cacheNames();
      assert.deepEqual(cacheAfter, expectedCacheNames, 'protected Chrome cache set after browser close');
      evidence.cacheSnapshots.push({ label: 'after-browser-close', names: cacheAfter });
      const protectedAfterClose = userChromeSnapshot();
      assertProtectedChrome(protectedAfterClose, 'after-browser-close');
      assert.deepEqual(protectedAfterClose.clonePaths, protectedBefore.clonePaths, 'protected Chrome handles unchanged after browser close');
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-close', ...protectedAfterClose });
    }, 'haiyu-stage24-browser-', { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: initialClock,
      LLM_BASE_URL: modelUrl, LLM_API_KEY: 'stage24-recorded-fixture-only', LLM_MODEL: 'recorded-stage22-fixture',
      LLM_TIMEOUT_MS: '30000', ASSISTANT_MODEL_SOURCE: 'recorded_fixture',
      WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '100' }, { resourceSession });
  } catch (error) {
    failure = error;
    if (browserOpened && cliDirectory && socketAlias) {
      try { await runCli(['close'], 'q24-playwright-failure-close', 30_000); browserOpened = false; }
      catch { /* cleanup is retried and recorded below */ }
    }
  } finally {
    for (const [resource, reason] of [[browserOwner, 'q24-browser-owner-cleanup'], [viteResource, 'q24-vite-cleanup'],
      [modelResource, 'q24-recorded-model-cleanup']]) {
      if (!resource) continue;
      try {
        const exited = await stopAndWait(resourceSession, resource, reason);
        evidence.resources.push({ ...resourceSummary(resource), finalStatus: exited.status, exitCode: exited.exitCode ?? null,
          signal: exited.signal || null, cleanup: 'stopped-and-verified-exited' });
      } catch (error) { evidence.cleanupError ||= `${resource.label}: ${error.message}`; }
    }
    if (socketAlias && socketAliasCreated) {
      try {
        const handles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
        assert.ok([0, 1].includes(handles.status), `lsof socket alias exited ${handles.status}`);
        assert.equal(handles.status === 0 && Boolean(handles.stdout.trim()), false, 'Playwright socket alias has no open handles');
        await fs.unlink(socketAlias);
        socketAliasCreated = false;
        evidence.cleanupSteps = [{ action: 'lsof-playwright-socket-alias', command: `lsof -nP +D ${socketAlias}`,
          exitCode: handles.status, matchingHandles: 'none' }, { action: 'remove-exact-playwright-socket-alias', status: 'removed', path: socketAlias }];
      } catch (error) { evidence.cleanupError ||= `Playwright socket alias: ${error.message}`; }
    }
    try {
      const status = await resourceSession.status();
      evidence.sessionResourcesAtExit = (status.resources || []).map(resourceSummary);
      evidence.liveBrowserResourcesAfterCleanup = evidence.sessionResourcesAtExit.filter(item =>
        ['starting', 'running'].includes(item.status) && ['api', 'vite', 'browser', 'stub'].includes(item.kind)
        && !String(item.label || '').includes('q24-mysql'));
      assert.equal(evidence.liveBrowserResourcesAfterCleanup.length, 0,
        `Stage24 browser-owned API/Vite/fixture/browser resources remain active: ${JSON.stringify(evidence.liveBrowserResourcesAfterCleanup)}`);
    } catch (error) { evidence.cleanupError ||= `resource status: ${error.message}`; }
    try {
      evidence.dfAfter = dfSnapshot('after-browser');
      evidence.cacheSnapshots.push({ label: 'after-browser-cleanup', names: await cacheNames() });
      const protectedFinal = userChromeSnapshot();
      assertProtectedChrome(protectedFinal, 'after-browser-cleanup');
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-cleanup', ...protectedFinal });
      assert.deepEqual(protectedFinal.clonePaths, protectedBefore.clonePaths, 'protected Chrome handles unchanged after cleanup');
      if (chrome) {
        evidence.chrome.exactIdentityExitedAfterCleanup = !processMatches(chrome.pid, chrome);
        assert.equal(evidence.chrome.exactIdentityExitedAfterCleanup, true, `isolated Chrome PID ${chrome.pid} remains after browser cleanup`);
      }
    } catch (error) { evidence.cleanupError ||= `final protected-resource snapshot: ${error.message}`; }
    evidence.status = failure || evidence.cleanupError ? 'FAIL' : 'PASS';
    evidence.failure = failure ? String(failure.stack || failure.message || failure).slice(0, 12_000) : null;
    evidence.observedAtEnd = new Date().toISOString();
    const serialized = JSON.stringify(evidence, null, 2);
    assert.ok(Buffer.byteLength(serialized) <= 2 * 1024 * 1024, 'Stage24 browser evidence must remain bounded');
    await fs.writeFile(evidencePath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  if (failure) throw failure;
  assert.equal(evidence.cleanupError, undefined, `browser cleanup failed: ${evidence.cleanupError}`);
  return { ...evidence.browserFlow, evidencePath, screenshotDirectory, resources: evidence.resources,
    dfBefore: evidence.dfBefore, dfAfter: evidence.dfAfter };
}
