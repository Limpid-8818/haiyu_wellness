import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { assertOk, databaseQuery, login, request, withDatabaseApi } from '../quests/q10-helpers.js';
import { ResourceSession, processIdentity, processMatches } from './resource-runtime.js';
import { validateProtectedChromeSnapshot } from './protected-chrome-snapshot.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'playwright-cli.config.json');
const cacheParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const expectedCacheNames = [
  'code_sign_clone.7WCMBh', 'code_sign_clone.87prgQ', 'code_sign_clone.FGf0ku',
  'code_sign_clone.KlYqcP', 'code_sign_clone.Km1hwm', 'code_sign_clone.Ly34OH',
  'code_sign_clone.b9cnAV', 'code_sign_clone.fpg2xz', 'code_sign_clone.jcG5XI',
  'code_sign_clone.ooLA7h', 'code_sign_clone.xkTnpB'
];
const protectedChrome = { pid: 7081, startTime: 'Thu Oct 1 17:27:01 2026',
  fingerprint: 'a30da864807c765187c20eb24b90dfaedb6d8273c8675d112e09016b42ec949d' };
const fixedInstant = '2026-10-05T00:00:00.000Z';
const businessDate = '2026-10-06';

class BrowserBaselineBlocked extends Error {
  constructor(code, message) { super(message); this.code = code; this.stageBlocked = true; }
}

function runBounded(command, args, timeoutMs = 5000, maxBuffer = 128 * 1024) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} interrupted by ${result.signal}`);
  return result;
}

function dfSnapshot(label) {
  const result = runBounded('df', ['-Pk', '/tmp']);
  assert.equal(result.status, 0, `df -Pk /tmp exited ${result.status}`);
  const line = result.stdout.trim().split(/\r?\n/).at(-1).trim();
  const columns = line.split(/\s+/);
  assert.ok(columns.length >= 6, `could not parse df row: ${line.slice(0, 300)}`);
  return { label, command: 'df -Pk /tmp', exitCode: result.status, filesystem: columns[0],
    usedKiB: Number(columns[2]), availableKiB: Number(columns[3]), mountedOn: columns.slice(5).join(' '), at: new Date().toISOString() };
}

async function directoryBytes(directory) {
  let total = 0;
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) total += (await fs.stat(full)).size;
    }
  }
  await visit(directory);
  return total;
}

async function availableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address()?.port;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('no loopback port')));
    });
  });
}

async function cacheNames() {
  return (await fs.readdir(cacheParent)).filter(name => name.startsWith('code_sign_clone.')).sort();
}

function userChromeSnapshot() {
  const priorTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  let identity;
  try { identity = processIdentity(protectedChrome.pid); }
  finally { if (priorTz === undefined) delete process.env.TZ; else process.env.TZ = priorTz; }
  const handles = runBounded('lsof', ['-nP', '-p', String(protectedChrome.pid), '-Fn'], 5000, 64 * 1024);
  assert.ok([0, 1].includes(handles.status), `lsof PID ${protectedChrome.pid} exited ${handles.status}`);
  const clonePaths = String(handles.stdout || '').split(/\r?\n/).filter(line => line.startsWith('n')
    && line.includes('code_sign_clone.')).map(line => line.slice(1));
  return { identity, identityTimezone: 'Asia/Shanghai', command: `lsof -nP -p ${protectedChrome.pid} -Fn`,
    lsofExitCode: handles.status, clonePaths: [...new Set(clonePaths)].sort() };
}

async function waitForHttp(url, session, resourceId, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    const state = (await session.status()).resources?.find(item => item.id === resourceId);
    if (!state || !['starting', 'running'].includes(state.status)) {
      const log = await session.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error(`${label} exited before readiness (${state?.status || 'missing'}): ${log.tail || ''}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const log = await session.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
  throw new Error(`${label} readiness timed out (${lastError}): ${log.tail || ''}`);
}

async function waitForFile(filePath, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 8192) throw new Error(`browser open marker exceeded 8 KiB: ${filePath}`);
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for Playwright open marker');
}

function chromeCommandLine(pid) {
  const result = runBounded('ps', ['-ww', '-p', String(pid), '-o', 'command='], 3000, 64 * 1024);
  assert.equal(result.status, 0, `ps command lookup for Chrome PID ${pid} failed`);
  return result.stdout.trim();
}

async function findChromeForProfile(profilePath, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = runBounded('ps', ['-ww', '-Ao', 'pid=,command='], 4000, 1024 * 1024);
    assert.equal(result.status, 0, 'could not inspect process table for isolated Chrome');
    const matches = result.stdout.split(/\r?\n/).flatMap(line => {
      const item = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!item || !item[2].includes(`--user-data-dir=${profilePath}`)) return [];
      if (!item[2].includes('/Google Chrome.app/Contents/MacOS/Google Chrome') || item[2].includes('/Helpers/')) return [];
      return [{ pid: Number(item[1]) }];
    });
    if (matches.length === 1) {
      const identity = processIdentity(matches[0].pid);
      assert.ok(identity, `isolated Chrome PID ${matches[0].pid} disappeared during identity capture`);
      return { ...identity, command: chromeCommandLine(matches[0].pid) };
    }
    if (matches.length > 1) throw new Error(`multiple Chrome main processes use isolated profile: ${matches.map(item => item.pid).join(',')}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('could not identify Chrome main process for isolated profile');
}

function assertChromeLaunch(chrome, profilePath, expectedFeatureArg) {
  assert.notEqual(chrome.pid, protectedChrome.pid, 'browser acceptance uses an isolated Chrome process');
  assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Chrome command lacks isolated profile');
  const featureArgs = chrome.command.match(/--disable-features=[^\s]+/g) || [];
  assert.equal(featureArgs.length, 1, 'Chrome command has exactly one --disable-features argument');
  assert.equal(featureArgs[0], expectedFeatureArg, 'effective Chrome feature argument matches the approved config');
  assert.ok(featureArgs[0].split('=')[1].split(',').includes('MacAppCodeSignClone'));
  return featureArgs;
}

async function stopAndWait(session, resource, reason, timeoutMs = 15000) {
  if (!resource) return null;
  const current = (await session.status()).resources?.find(item => item.id === resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await session.stop(resource.id, reason);
    if (!stopped.ok) throw new Error(`${resource.label || resource.id} stop failed: ${stopped.error || 'unknown error'}`);
  }
  const exited = await session.waitProcess(resource.id, timeoutMs);
  if (exited.timedOut || exited.unavailable || ['starting', 'running'].includes(exited.status)) {
    throw new Error(`${resource.label || resource.id} did not exit: ${JSON.stringify(exited)}`);
  }
  return exited;
}

async function seedEnvironment(context) {
  const demo = makeDemoEnvironment(businessDate, fixedInstant, DEMO_ENVIRONMENT_LOCATION);
  for (const [domain, stationId, payload] of [['weather', '', demo.weather],
    ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]]) {
    const key = `env:${crypto.createHash('sha256').update(JSON.stringify([
      DEMO_ENVIRONMENT_LOCATION.id, stationId, businessDate, domain])).digest('hex').slice(0, 48)}`;
    const data = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    await databaseQuery(context, `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,
       payload_hash,payload_json,created_at,updated_at)
      VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?) ON CONFLICT(snapshot_key) DO UPDATE SET
       status=excluded.status,source_name=excluded.source_name,source_url=excluded.source_url,observed_at=excluded.observed_at,
       expires_at=excluded.expires_at,payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
    [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, businessDate, domain, 'Stage23浏览器合成环境', payload.sourceUrl || '',
      fixedInstant, '2026-10-07T00:00:00.000Z', hash, data, fixedInstant, fixedInstant], 'run');
  }
}

async function apiWithHeaders(baseUrl, route, { token, method = 'GET', body, idempotencyKey } = {}) {
  const response = await fetch(`${baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}

async function prepareFixtures(context) {
  const guest = assertOk(await login(context.baseUrl, 'guest'), 200, 'browser guest login');
  const dean = assertOk(await login(context.baseUrl, 'dean'), 200, 'browser dean login');
  const stay = await request(context.baseUrl, `/dean/guests/${encodeURIComponent(guest.user.id)}/stay`, {
    method: 'PATCH', token: dean.token,
    body: { roomNo: 'B-23', checkIn: '2026-10-05', checkOut: '2026-10-09', stayPlan: 'ten_night' }
  });
  assert.ok(stay.status === 200, `browser fixture stay: ${JSON.stringify(stay.data)}`);
  await seedEnvironment(context);
  const slotsResult = assertOk(await request(context.baseUrl,
    `/projects/project-beach-walk/slots?date=${businessDate}`, { token: guest.token }), 200, 'browser bookable slots');
  const bookable = (slotsResult.slots || []).filter(slot => slot.bookable);
  if (bookable.length < 4) {
    const environment = assertOk(await request(context.baseUrl,
      `/environment?date=${businessDate}&projectId=project-beach-walk`, { token: guest.token }), 200, 'browser environment diagnostic');
    throw new Error(`browser needs four available slots (observed ${bookable.length}); env=${JSON.stringify({
      modeStatus: environment.status, demoRules: environment.demoRules,
      domains: Object.fromEntries(['weather','tide','marine'].map(domain => [domain, {
        status: environment[domain]?.status, freshness: environment[domain]?.freshness,
        expiresAt: environment[domain]?.expiresAt, sample: environment[domain]?.hourly?.find(item => item.time?.includes('T07:00'))
      }])), availability: environment.availability?.windows?.slice(0, 2),
      firstSlots: (slotsResult.slots || []).slice(0, 4).map(slot => ({ id: slot.id, localStart: slot.localStart,
        status: slot.status, reason: slot.reason })) })}`);
  }
  const restResult = await apiWithHeaders(context.baseUrl, '/reservations', { method: 'POST', token: guest.token,
    idempotencyKey: 'q23-browser-rest-reservation', body: { slotId: bookable[0].id } });
  assert.ok([200, 201].includes(restResult.status), `create rest fixture reservation: ${JSON.stringify(restResult.data)}`);
  const menuResult = await request(context.baseUrl, '/meals/menus', { method: 'POST', token: guest.token,
    body: { businessDate } });
  assert.ok([200, 201].includes(menuResult.status), `prepare browser meal menu: ${JSON.stringify(menuResult.data)}`);
  const reservationList = assertOk(await request(context.baseUrl, '/reservations', { token: guest.token }), 200, 'initial browser reservations');
  return { guestId: guest.user.id, guestName: guest.user.name,
    businessDate, bookingSlot: bookable[2], restReservationId: restResult.data.reservation.id,
    restReservationSlot: bookable[0], baselineReservationCount: reservationList.items.length };
}

function expireActionCard(databasePath, cardId) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout=5000');
    database.exec('BEGIN IMMEDIATE');
    const result = database.prepare(`UPDATE assistant_action_cards SET expires_at=?,updated_at=?
      WHERE id=? AND status='pending_confirmation'`).run('2026-10-04T00:00:00.000Z', fixedInstant, cardId);
    assert.equal(Number(result.changes), 1, 'the browser pending card is isolated and can be expired for UI revalidation');
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* keep the primary failure */ }
    throw error;
  } finally { database.close(); }
}

function readActionCards(databasePath, guestId) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database.prepare(`SELECT id,session_id,action_type,version,status,parameters_json,impact_json,
      result_json,error_code,expires_at,created_at FROM assistant_action_cards
      WHERE guest_id=? ORDER BY created_at,id`).all(guestId).map(row => ({
      id: row.id, sessionId: row.session_id, actionType: row.action_type, version: Number(row.version),
      status: row.status, parameters: JSON.parse(row.parameters_json || '{}'), impact: JSON.parse(row.impact_json || '{}'),
      result: row.result_json ? JSON.parse(row.result_json) : null, errorCode: row.error_code || null,
      expiresAt: row.expires_at || null, createdAt: row.created_at
    }));
  } finally { database.close(); }
}

async function appendBrowserEvidence(entry) {
  const outputPath = path.join(projectRoot, 'output/resource-audit/stage23-execution-evidence-20261005.jsonl');
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ taskId: process.env.CODEX_TASK_ID, recordedAt: new Date().toISOString(), ...entry });
  const byteLength = Buffer.byteLength(line, 'utf8') + 1;
  const existing = fsSync.existsSync(outputPath) ? fsSync.statSync(outputPath).size : 0;
  if (byteLength > 48 * 1024 || existing + byteLength > 8 * 1024 * 1024) throw new Error('Stage23 evidence file reached its 8 MiB limit');
  await fs.appendFile(outputPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function runStage23BrowserAcceptance(resourceSession) {
  const taskId = process.env.CODEX_TASK_ID;
  assert.ok(taskId, 'Stage23 browser acceptance requires CODEX_TASK_ID');
  assert.equal(runBounded('bash', ['-lc', 'command -v npx']).status, 0, 'npx must be available');
  const stageDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replaceAll('-', '');
  const root = path.join(projectRoot, 'output/playwright');
  await fs.mkdir(root, { recursive: true });
  let retry = 1;
  let screenshotDirectory = path.join(root, `stage23-${stageDate}-retry${String(retry).padStart(2, '0')}`);
  while (fsSync.existsSync(screenshotDirectory)) {
    retry += 1;
    screenshotDirectory = path.join(root, `stage23-${stageDate}-retry${String(retry).padStart(2, '0')}`);
  }
  const evidencePath = path.join(screenshotDirectory, 'stage23-browser-evidence.json');
  const screenshotNames = ['bookingPending','bookingExpired','bookingConfirmed','scheduleBooking','bookingCancelled',
    'bookingCardRefreshedCancelled','mealConfirmed','mealOrderPage','healthMetricConfirmed','healthMetricPage',
    'restChangeConfirmed','scheduleRestPending','bookingUnderstandingFallback'];
  const screenshots = Object.fromEntries(screenshotNames.map(name => [name, Object.fromEntries([1024, 1440, 1920].map(width =>
    [width, path.join(screenshotDirectory, `stage23-${width}x1000-${name}.png`)]))]));
  const reservedArtifacts = [...Object.values(screenshots).flatMap(perWidth => Object.values(perWidth)), evidencePath];
  for (const file of reservedArtifacts) {
    try { await fs.access(file); throw new Error(`refusing to overwrite existing Stage23 browser artifact ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(screenshotDirectory, { recursive: true });

  const config = JSON.parse(await fs.readFile(playwrightConfigPath, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config contains one merged disable-features argument');
  const featureArg = featureArgs[0];
  assert.ok(featureArg.split('=')[1].split(',').includes('MacAppCodeSignClone'));
  const evidence = { schemaVersion: 1, taskId, executingAppThreadId: taskId, registryTaskId: taskId,
    sourceSolThreadId: '01a0cbfe-a161-72d0-992d-12fad655d4ef',
    title: 'Stage23 assistant confirmation and business result browser acceptance',
    observedAt: new Date().toISOString(), status: 'RUNNING', executionMode: 'recorded_fixture', worktree: projectRoot,
    browserConfigPath: playwrightConfigPath, browserConfigFeatureArg: featureArg, cacheParent, expectedCacheNames,
    cacheSnapshots: [], userChromeSnapshots: [], protectedChromeSnapshots: [], protectedChromeBaselineObserved: null,
    resources: [], cliSteps: [], screenshots,
    resourceLimits: { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 },
    dfBefore: dfSnapshot('before-stage23-browser'), resourceSessionId: resourceSession.instanceId,
    resourceTempDir: resourceSession.tempDir, resourceSessionLimits: resourceSession.limits };
  let modelResource;
  let viteResource;
  let browserOwner;
  let cliWorkDir;
  let socketAlias;
  let sessionName;
  let profilePath;
  let openMarker;
  let chrome;
  let browserOpened = false;
  let failure = null;
  const cleanupErrors = [];

  async function recordProtectedSnapshot(label) {
    const names = await cacheNames();
    evidence.cacheSnapshots.push({ label, at: new Date().toISOString(), names });
    const snapshot = { ...userChromeSnapshot(), cacheNames: names };
    const at = new Date().toISOString();
    evidence.userChromeSnapshots.push({ label, at, ...snapshot });
    evidence.protectedChromeSnapshots.push({ label, at, ...snapshot });
    const validation = validateProtectedChromeSnapshot(snapshot, { protectedChrome, cacheParent,
      expectedCacheNames, baseline: evidence.protectedChromeBaselineObserved });
    if (!validation.ok) {
      throw new BrowserBaselineBlocked(validation.code,
        `${label}: ${validation.message}; current cache and handle evidence was preserved`);
    }
    if (!evidence.protectedChromeBaselineObserved) evidence.protectedChromeBaselineObserved = validation.baseline;
    return snapshot;
  }

  async function runCli(args, label, timeoutMs = 60000) {
    const resource = await resourceSession.startProcess({ label, kind: 'browser', role: 'browser-cli', command: 'bash',
      args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfigPath] : []), '--session', sessionName, ...args],
      cwd: cliWorkDir, env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias } });
    let result = await resourceSession.waitProcess(resource.id, timeoutMs);
    const didTimeout = Boolean(result.timedOut);
    if (didTimeout) {
      await resourceSession.stop(resource.id, `${label}-timeout`);
      result = await resourceSession.waitProcess(resource.id, 15000);
    }
    const log = await resourceSession.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    const step = { label, command: `bash ${playwrightWrapper} ${args[0] === 'open' ? `--config ${playwrightConfigPath} ` : ''}--session ${sessionName} ${args.join(' ')}`,
      resourceId: resource.id, pid: resource.pid, processStartTime: resource.processStartTime,
      processFingerprint: resource.processFingerprint, processGroup: resource.pgid, cwd: resource.cwd,
      tempDir: resource.tempDir, port: resource.port, logPath: resource.logPath,
      status: result.status, exitCode: result.exitCode ?? null, signal: result.signal || null,
      timedOut: didTimeout || Boolean(result.timedOut), logBytes: result.logBytes, outputTail: String(log.tail || '').slice(-8192) };
    evidence.cliSteps.push(step);
    assert.equal(step.status, 'exited', `${label} status=${step.status}: ${step.outputTail.slice(-1200)}`);
    assert.equal(step.exitCode, 0, `${label} exit=${step.exitCode}: ${step.outputTail.slice(-1200)}`);
    assert.equal(step.signal, null, `${label} received a signal`);
    assert.equal(step.timedOut, false, `${label} timed out`);
    return step.outputTail;
  }

  async function stopChromeAndRecord() {
    if (!browserOpened) return;
    await runCli(['close'], 'stage23-playwright-close', 30000);
    browserOpened = false;
    const deadline = Date.now() + 15000;
    while (chrome && processMatches(chrome.pid, chrome) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    evidence.chrome.exactIdentityExitedAfterClose = !chrome || !processMatches(chrome.pid, chrome);
    assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `isolated Chrome PID ${chrome?.pid} remains after close`);
    await recordProtectedSnapshot('after-browser-close');
    const socketHandles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
    assert.ok([0, 1].includes(socketHandles.status), `lsof socket alias check exited ${socketHandles.status}`);
    assert.equal(socketHandles.status === 0 && Boolean(socketHandles.stdout.trim()), false,
      `Playwright socket alias still has open handles: ${String(socketHandles.stdout || '').slice(0, 1000)}`);
    evidence.cleanupSteps ||= [];
    evidence.cleanupSteps.push({ action: 'lsof-playwright-socket-alias', command: `lsof -nP +D ${socketAlias}`,
      exitCode: socketHandles.status, matchingHandles: socketHandles.stdout.trim() ? 'present' : 'none' });
    await fs.unlink(socketAlias);
    evidence.cleanupSteps.push({ action: 'remove-exact-playwright-socket-alias', path: socketAlias, status: 'removed' });
    socketAlias = null;
  }

  async function stopOwnedResource(resource, reason, key) {
    if (!resource) return;
    const exited = await stopAndWait(resourceSession, resource, reason);
    evidence.cleanupResources ||= [];
    evidence.cleanupResources.push({ id: resource.id, label: resource.label, pid: resource.pid,
      startTime: resource.processStartTime, fingerprint: resource.processFingerprint, exit: exited });
    if (key === 'browserOwner') browserOwner = null;
    if (key === 'viteResource') viteResource = null;
    if (key === 'modelResource') modelResource = null;
  }

  async function cleanupBeforeApiClose() {
    if (browserOpened) {
      try { await stopChromeAndRecord(); }
      catch (error) { cleanupErrors.push(`Playwright close: ${error.message}`); }
    }
    try { await stopOwnedResource(browserOwner, 'stage23-browser-owner-finished', 'browserOwner'); }
    catch (error) { cleanupErrors.push(`browser owner exit: ${error.message}`); }
    if (chrome && processMatches(chrome.pid, chrome)) {
      try {
        if (chrome.pid === protectedChrome.pid || !chrome.command.includes(`--user-data-dir=${profilePath}`)) {
          throw new Error(`refusing to signal unverified Chrome PID ${chrome.pid}`);
        }
        const before = processIdentity(chrome.pid);
        if (!before || before.fingerprint !== chrome.fingerprint) throw new Error(`isolated Chrome PID ${chrome.pid} identity changed`);
        process.kill(chrome.pid, 'SIGTERM');
        const termDeadline = Date.now() + 5000;
        while (processMatches(chrome.pid, chrome) && Date.now() < termDeadline) await new Promise(resolve => setTimeout(resolve, 100));
        let signal = 'SIGTERM';
        if (processMatches(chrome.pid, chrome)) {
          const stillSame = processIdentity(chrome.pid);
          if (!stillSame || stillSame.fingerprint !== chrome.fingerprint) throw new Error(`Chrome PID ${chrome.pid} identity changed before forced exit`);
          process.kill(chrome.pid, 'SIGKILL');
          signal = 'SIGKILL';
          const killDeadline = Date.now() + 5000;
          while (processMatches(chrome.pid, chrome) && Date.now() < killDeadline) await new Promise(resolve => setTimeout(resolve, 100));
        }
        evidence.cleanupSteps ||= [];
        evidence.cleanupSteps.push({ action: 'terminate-exact-isolated-chrome-after-cli-close-failure', pid: chrome.pid,
          processStartTime: chrome.startTime, fingerprint: chrome.fingerprint, signal,
          exactIdentityExited: !processMatches(chrome.pid, chrome) });
      } catch (error) { cleanupErrors.push(`isolated Chrome PID ${chrome.pid} cleanup: ${error.message}`); }
    }
    if (chrome) {
      evidence.chrome ||= { pid: chrome.pid, startTime: chrome.startTime, fingerprint: chrome.fingerprint };
      evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
      if (!evidence.chrome.exactIdentityExitedAfterClose) cleanupErrors.push(`isolated Chrome PID ${chrome.pid} remains running`);
    }
    if (socketAlias && (!chrome || !processMatches(chrome.pid, chrome))) {
      try {
        const handles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
        assert.ok([0, 1].includes(handles.status), `lsof socket alias exited ${handles.status}`);
        if (handles.status === 0 && handles.stdout.trim()) throw new Error(`socket alias has open handles: ${handles.stdout.slice(0, 1000)}`);
        await fs.unlink(socketAlias);
        evidence.cleanupSteps ||= [];
        evidence.cleanupSteps.push({ action: 'lsof-and-remove-exact-playwright-socket-alias', path: socketAlias,
          lsofExitCode: handles.status, matchingHandles: 'none', status: 'removed' });
        socketAlias = null;
      } catch (error) { cleanupErrors.push(`socket alias cleanup: ${error.message}`); }
    }
    try { await stopOwnedResource(viteResource, 'stage23-vite-finished', 'viteResource'); }
    catch (error) { cleanupErrors.push(`Vite exit: ${error.message}`); }
    try { await stopOwnedResource(modelResource, 'stage23-recorded-model-finished', 'modelResource'); }
    catch (error) { cleanupErrors.push(`recorded model exit: ${error.message}`); }
  }

  try {
    await recordProtectedSnapshot('before-browser-launch');
    await fs.access(playwrightWrapper);
    const sessionNameId = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    sessionName = `stage23-${sessionNameId}`;
    cliWorkDir = await resourceSession.allocateDir(`stage23-browser-cli-${sessionNameId}`);
    const socketsDir = await resourceSession.allocateDir(`stage23-playwright-sockets-${sessionNameId}`);
    socketAlias = path.join('/tmp', `pw-stage23-${sessionNameId}`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright socket alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDir, socketAlias, 'dir');
    profilePath = path.join(cliWorkDir, 'chrome-profile');
    openMarker = path.join(cliWorkDir, 'open-status.json');
    const ownerPath = path.join(cliWorkDir, 'browser-session-owner.mjs');
    await fs.writeFile(path.join(cliWorkDir, '.keep'), 'Managed Stage23 browser profile, CLI socket and output.\n');
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

    const modelPort = await availableLoopbackPort();
    modelResource = await resourceSession.startProcess({ label: 'stage23-browser-recorded-model', kind: 'stub', role: 'model-provider',
      command: process.execPath, args: [path.join(projectRoot, 'scripts/resources/q23-recorded-model-server.js')],
      cwd: projectRoot, port: modelPort, env: { PATH: process.env.PATH || '', PORT: String(modelPort) } });
    await waitForHttp(`http://127.0.0.1:${modelPort}/health`, resourceSession, modelResource.id, 'Stage23 browser recorded model');

    await withDatabaseApi('sqlite', async context => {
      try {
      evidence.apiOrigin = new URL(context.baseUrl).origin;
      evidence.fixtures = await prepareFixtures(context);
      const webPort = await availableLoopbackPort();
      const webUrl = `http://127.0.0.1:${webPort}`;
      viteResource = await resourceSession.startProcess({ label: 'stage23-browser-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort,
        env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1', API_PROXY_TARGET: evidence.apiOrigin, WEB_PORT: String(webPort) } });
      assert.equal(viteResource.status, 'running', `Vite failed to start: ${JSON.stringify(viteResource)}`);
      await waitForHttp(webUrl, resourceSession, viteResource.id, 'Stage23 Vite');

      browserOwner = await resourceSession.startProcess({ label: 'stage23-playwright-session-owner', kind: 'browser', role: 'browser-session-owner',
        command: process.execPath, args: [ownerPath], cwd: cliWorkDir,
        env: { PATH: process.env.PATH || '', PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfigPath,
          PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker,
          PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: webUrl } });
      assert.equal(browserOwner.status, 'running', 'Playwright open owner should start under the ResourceSession');
      browserOpened = true;
      const openResult = await waitForFile(openMarker);
      evidence.cliSteps.push({ label: 'open', status: openResult.code === 0 ? 'exited' : 'failed', exitCode: openResult.code,
        signal: openResult.signal || null, configPassedOnlyToOpen: true, outputTail: String(openResult.output || '').slice(-4096) });
      assert.equal(openResult.code, 0, `Playwright open failed: ${String(openResult.output || '').slice(-1000)}`);
      assert.equal(openResult.signal, null, 'Playwright open was signaled');
      chrome = await findChromeForProfile(profilePath);
      const effectiveFeatureArgs = assertChromeLaunch(chrome, profilePath, featureArg);
      evidence.chrome = { pid: chrome.pid, startTime: chrome.startTime, processGroup: chrome.pgid,
        fingerprint: chrome.fingerprint, executable: chrome.executable, profilePath,
        effectiveDisableFeaturesArgs: effectiveFeatureArgs, effectiveDisableFeatures: effectiveFeatureArgs[0] };
      await recordProtectedSnapshot('during-browser-open');
      await runCli(['snapshot'], 'stage23-playwright-initial-snapshot', 30000);

      const flowTemplate = await fs.readFile(path.join(projectRoot, 'scripts/resources/stage23-browser-flow.js'), 'utf8');
      const flowPath = path.join(cliWorkDir, 'stage23-assistant-flow.mjs');
      const renderFlow = (phase, expiredCardId = null) => flowTemplate
        .replace('__WEB_URL__', JSON.stringify(webUrl))
        .replace('__FIXTURE__', JSON.stringify({ ...evidence.fixtures, ...(expiredCardId ? { expiredCardId } : {}) }))
        .replace('__SCREENSHOTS__', JSON.stringify(screenshots))
        .replace('__FLOW_PHASE__', JSON.stringify(phase));
      await fs.writeFile(flowPath, renderFlow('initial'));
      await runCli(['run-code', '--filename', flowPath], 'stage23-playwright-assistant-pending', 90000);
      const pendingCard = readActionCards(context.databasePath, evidence.fixtures.guestId)
        .findLast(card => card.actionType === 'book_program');
      assert.ok(pendingCard, 'browser flow persisted a booking action card');
      evidence.browserPending = { cardId: pendingCard.id, sessionId: pendingCard.sessionId,
        status: pendingCard.status, reservationCount: evidence.fixtures.baselineReservationCount };
      assert.equal(evidence.browserPending.status, 'pending_confirmation');
      expireActionCard(context.databasePath, evidence.browserPending.cardId);
      await fs.writeFile(flowPath, renderFlow('continue', evidence.browserPending.cardId));
      await runCli(['run-code', '--filename', flowPath], 'stage23-playwright-assistant-confirmation-flow', 240000);
      const resultReaderPath = path.join(cliWorkDir, 'stage23-read-flow-result.mjs');
      await fs.writeFile(resultReaderPath,
        "async page => await page.evaluate(() => JSON.parse(sessionStorage.getItem('__stage23FlowResult') || 'null'))");
      const resultReaderOutput = await runCli(['run-code', '--filename', resultReaderPath], 'stage23-playwright-read-flow-result', 30000);
      const resultHeading = resultReaderOutput.lastIndexOf('### Result');
      assert.ok(resultHeading >= 0, `short result-reader response contains a Result section: ${resultReaderOutput.slice(-1500)}`);
      const resultPayload = resultReaderOutput.slice(resultHeading + '### Result'.length).split(/\r?\n### /, 1)[0].trim();
      const flowResult = JSON.parse(resultPayload);
      assert.ok(flowResult.bookingUnderstandingFallback?.runIds?.length === 3);
      const browserCards = readActionCards(context.databasePath, evidence.fixtures.guestId);
      const cardWithStatus = (actionType, status) => browserCards.findLast(card => card.actionType === actionType && card.status === status);
      for (const [actionType, expectedStatus] of [['book_program','confirmed'], ['cancel_booking','confirmed'],
        ['book_meal','confirmed'], ['record_metric','confirmed'], ['rest_change','confirmed']]) {
        const card = cardWithStatus(actionType, expectedStatus);
        assert.ok(card, `browser did not persist ${actionType} action card`);
      }
      const confirmedBooking = cardWithStatus('book_program', 'confirmed');
      const confirmedCancellation = cardWithStatus('cancel_booking', 'confirmed');
      const mealCard = cardWithStatus('book_meal', 'confirmed');
      const metricCard = cardWithStatus('record_metric', 'confirmed');
      const restCard = cardWithStatus('rest_change', 'confirmed');
      evidence.browserFlow = { executionMode: 'recorded_fixture', actionCards: browserCards,
        initialProposalCardId: evidence.browserPending.cardId, expiredCardId: evidence.browserPending.cardId,
        confirmedBookingCardId: confirmedBooking?.id || null, confirmedReservationId: confirmedBooking?.result?.businessId || null,
        cancellationCardId: confirmedCancellation?.id || null,
        mealCardId: mealCard?.id || null, mealOrderId: mealCard?.result?.businessId || null,
        metricCardId: metricCard?.id || null, healthRecordId: metricCard?.result?.businessId || null,
        restCardId: restCard?.id || null, restDraftId: restCard?.result?.businessId || null,
        bookingUnderstandingFallback: flowResult.bookingUnderstandingFallback,
        screenshotWidths: [1024, 1440, 1920], pageErrors: flowResult.pageErrors };
      await recordProtectedSnapshot('during-browser-flow');
      for (const file of reservedArtifacts.filter(item => item.endsWith('.png'))) await fs.access(file);
      await stopChromeAndRecord();
      } finally {
        await cleanupBeforeApiClose();
      }
    }, { seed: true, env: {
      BUSINESS_CLOCK_NOW: fixedInstant, NODE_ENV: 'test', ENVIRONMENT_MODE: 'demo', ENVIRONMENT_LIVE: '0',
      LLM_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
      LLM_API_KEY: 'q23-browser-recorded-fixture-only', LLM_MODEL: 'q23-recorded-fixture', LLM_TIMEOUT_MS: '20000',
      ASSISTANT_MODEL_SOURCE: 'recorded_fixture'
    }, resourceSession });
  } catch (error) {
    failure = error;
    evidence.failure = { name: error?.name || 'Error', message: String(error?.message || error).slice(0, 3000),
      code: error?.code || null, blocked: error?.stageBlocked === true };
  } finally {
    await cleanupBeforeApiClose();
    try {
      const resources = (await resourceSession.status()).resources || [];
      evidence.resources = resources.map(item => ({ id: item.id, label: item.label, kind: item.kind, role: item.role,
        status: item.status, pid: item.pid, processStartTime: item.processStartTime, processFingerprint: item.processFingerprint,
        command: item.command, cwd: item.cwd, tempDir: item.tempDir, port: item.port, logPath: item.logPath,
        logBytes: item.logBytes, maxLogBytes: item.maxLogBytes, directoryPeakBytes: item.directoryPeakBytes,
        maxDirectoryBytes: item.maxDirectoryBytes, leaseExpiresAt: item.leaseExpiresAt, pids: item.pids }));
      evidence.resourceTempDirectoryBytes = await directoryBytes(resourceSession.tempDir);
    } catch (error) { cleanupErrors.push(`resource snapshot: ${error.message}`); }
    try { await recordProtectedSnapshot('after-browser-owner-exit'); }
    catch (error) {
      if (error?.stageBlocked) failure ||= error;
      cleanupErrors.push(`final Chrome baseline audit: ${error.message}`);
    }
    try { evidence.dfAfter = dfSnapshot('after-stage23-browser'); }
    catch (error) { cleanupErrors.push(`df snapshot: ${error.message}`); }
    if (cleanupErrors.length) evidence.cleanupFailures = cleanupErrors;
    evidence.status = failure || cleanupErrors.length ? (failure?.stageBlocked ? 'BLOCKED' : 'FAIL') : 'PASS';
    evidence.completedAt = new Date().toISOString();
    try { await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
    catch (error) {
      cleanupErrors.push(`browser evidence save: ${error.message}`);
      evidence.cleanupFailures = cleanupErrors;
      evidence.status = 'FAIL';
    }
    let evidenceSaved = false;
    try { evidenceSaved = (await fs.stat(evidencePath)).isFile(); } catch { /* preserve missing-file status in the durable registry record */ }
    try { await appendBrowserEvidence({ quest: 'Q23.BROWSER', scenario: 'assistant-action-ui-confirmation-refresh-responsive',
      status: evidence.status, browserEvidencePath: evidencePath, screenshotCount: reservedArtifacts.filter(item => item.endsWith('.png')).length,
      chromePid: evidence.chrome?.pid || null, resourceIds: evidence.resources.map(item => item.id),
      failure: evidence.failure || null, cleanupFailures: cleanupErrors, evidenceSaved }); }
    catch (error) { cleanupErrors.push(`browser JSONL evidence: ${error.message}`); }
  }

  if (failure || cleanupErrors.length) {
    const details = [failure?.message, ...cleanupErrors].filter(Boolean).join('; ');
    const error = new Error(`Stage23 browser acceptance ${evidence.status}: ${details}; evidence ${evidencePath}`);
    if (failure?.stageBlocked) error.stageBlocked = true;
    throw error;
  }
  return { evidencePath, screenshots: reservedArtifacts.filter(item => item.endsWith('.png')),
    browserFlow: evidence.browserFlow, browserPending: evidence.browserPending,
    chrome: evidence.chrome, cacheNamesUnchanged: true, resourceIds: evidence.resources.map(item => item.id),
    dfBefore: evidence.dfBefore, dfAfter: evidence.dfAfter };
}
