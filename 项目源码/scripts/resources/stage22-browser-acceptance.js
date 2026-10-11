import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTemporaryApi } from '../quests/helpers.js';
import { DEMO_ENVIRONMENT_LOCATION } from '../../server/src/environment-config.js';
import { makeDemoEnvironment } from '../../server/src/environment-providers.js';
import { ResourceSession, processIdentity, processMatches } from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskId = process.env.CODEX_TASK_ID;
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'playwright-cli.config.json');
const screenshotRoot = path.join(projectRoot, 'output/playwright');
const stageDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date()).replaceAll('-', '');
const retryPrefix = 'stage22-' + stageDate + '-retry';
let retryNumber = 1;
let screenshotDirectory = path.join(screenshotRoot, retryPrefix + String(retryNumber).padStart(2, '0'));
while (fsSync.existsSync(screenshotDirectory)) {
  retryNumber += 1;
  screenshotDirectory = path.join(screenshotRoot, retryPrefix + String(retryNumber).padStart(2, '0'));
}
const evidencePath = path.join(screenshotDirectory, 'stage22-browser-evidence.json');
const diagnosticScreenshotPath = path.join(screenshotDirectory, 'stage22-browser-failure-debug.png');
const cacheParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const expectedCacheNames = [
  'code_sign_clone.7WCMBh', 'code_sign_clone.87prgQ', 'code_sign_clone.FGf0ku',
  'code_sign_clone.KlYqcP', 'code_sign_clone.Km1hwm', 'code_sign_clone.Ly34OH',
  'code_sign_clone.b9cnAV', 'code_sign_clone.fpg2xz', 'code_sign_clone.jcG5XI',
  'code_sign_clone.ooLA7h', 'code_sign_clone.xkTnpB'
];
const userChromeBaseline = {
  pid: 7081,
  startTime: 'Thu Oct 1 17:27:01 2026',
  fingerprint: 'a30da864807c765187c20eb24b90dfaedb6d8273c8675d112e09016b42ec949d'
};
const q227Only = process.argv.includes('--q227-only');

async function browserApiRequest(baseUrl, route, { method = 'GET', token, body, idempotencyKey } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`${method} ${route} returned HTTP ${response.status}: ${JSON.stringify(data).slice(0, 800)}`);
  return data;
}

async function prepareBrowserFixtures(baseUrl, databasePath) {
  const guestLogin = await browserApiRequest(baseUrl, '/auth/login', {
    method: 'POST', body: { username: 'guest_demo', password: 'guest2026', role: 'guest' }
  });
  const deanLogin = await browserApiRequest(baseUrl, '/auth/login', {
    method: 'POST', body: { username: 'dean_demo', password: 'dean2026', role: 'dean' }
  });
  const guestId = guestLogin.user.id;
  await browserApiRequest(baseUrl, `/dean/guests/${encodeURIComponent(guestId)}/stay`, {
    method: 'PATCH', token: deanLogin.token,
    body: { roomNo: 'B-22', checkIn: '2026-10-06', checkOut: '2026-10-09', stayPlan: 'three_night' }
  });

  const completeProfile = {
    chronic: { status: 'reported', items: ['高血压'] },
    medications: { status: 'none', items: [] },
    allergies: { status: 'none', items: [] },
    dietaryRestrictions: { status: 'none', items: [] },
    mobility: { status: 'independent', details: '可独立行走' },
    sleep: { status: 'reported', details: '睡眠正常' },
    skin: { status: 'reported', details: '皮肤有开放性伤口' },
    audienceTags: { status: 'none', items: [] }
  };
  const database = new DatabaseSync(databasePath);
  const environmentSnapshots = [];
  try {
    database.exec('PRAGMA busy_timeout=3000');
    database.exec('BEGIN IMMEDIATE');
    database.prepare(`UPDATE guest_profiles SET chronic_json=?,allergies_json=?,mobility=?,health_profile_json=?,
      health_profile_version=health_profile_version+1,updated_at=? WHERE user_id=?`).run(
      JSON.stringify(['高血压']), JSON.stringify([]), '可独立行走', JSON.stringify(completeProfile),
      '2026-10-05T00:00:00.000Z', guestId);
    for (const date of ['2026-10-06', '2026-10-07', '2026-10-08']) {
      const demo = makeDemoEnvironment(date, '2026-10-05T00:00:00.000Z', DEMO_ENVIRONMENT_LOCATION);
      const payloads = [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide],
        ['marine', '', demo.marine]];
      for (const [domain, stationId, payload] of payloads) {
        const key = `env:${crypto.createHash('sha256').update(JSON.stringify(
          [DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain])).digest('hex').slice(0, 48)}`;
        const payloadJson = JSON.stringify(payload);
        const payloadHash = crypto.createHash('sha256').update(payloadJson).digest('hex');
        database.prepare(`INSERT INTO environment_snapshots
          (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,
           payload_hash,payload_json,created_at,updated_at)
          VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)
          ON CONFLICT(snapshot_key) DO UPDATE SET status=excluded.status,source_name=excluded.source_name,
            source_url=excluded.source_url,observed_at=excluded.observed_at,expires_at=excluded.expires_at,
            payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
          .run(key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, payload.sourceName || 'Stage22 合成环境快照',
            payload.sourceUrl || '', '2026-10-05T00:00:00.000Z', '2026-10-05T02:00:00.000Z', payloadHash, payloadJson,
            '2026-10-05T00:00:00.000Z', '2026-10-05T00:00:00.000Z');
        environmentSnapshots.push({ date, domain, status: 'demo', payloadHash });
      }
    }
    database.exec('COMMIT');
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch { /* preserve the setup error */ }
    throw error;
  } finally { database.close(); }

  const slotsByDate = [];
  for (const date of ['2026-10-06', '2026-10-07', '2026-10-08']) {
    const slots = await browserApiRequest(baseUrl, `/projects/project-beach-walk/slots?date=${date}`, { token: guestLogin.token });
    slotsByDate.push({ date, count: slots.slots.length, bookable: slots.slots.filter(item => item.bookable).length });
  }
  return { guestId, guestName: guestLogin.user.name, stay: { checkIn: '2026-10-06', checkOut: '2026-10-09' },
    healthProfileCompleteness: 100, healthReviewReason: '高血压需由医护核对', environmentSnapshots, slotsByDate };
}

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

async function cacheNames() {
  return (await fs.readdir(cacheParent)).filter(name => name.startsWith('code_sign_clone.')).sort();
}

function userChromeSnapshot() {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  let identity;
  try { identity = processIdentity(userChromeBaseline.pid); }
  finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
  const handles = runBounded('lsof', ['-nP', '-p', String(userChromeBaseline.pid), '-Fn'], 5000, 64 * 1024);
  assert.ok([0, 1].includes(handles.status), `lsof PID ${userChromeBaseline.pid} exited ${handles.status}`);
  const clonePaths = (handles.stdout || '').split(/\r?\n/).filter(line => line.startsWith('n') && line.includes('code_sign_clone.')).map(line => line.slice(1));
  return { identity, identityTimezone: 'Asia/Shanghai', lsofCommand: `lsof -nP -p ${userChromeBaseline.pid} -Fn`,
    lsofExitCode: handles.status, clonePaths };
}

function assertUserChromeUnchanged(snapshot, label) {
  if (!snapshot.identity || snapshot.identity.pid !== userChromeBaseline.pid
    || snapshot.identity.startTime.replace(/\s+/g, ' ') !== userChromeBaseline.startTime.replace(/\s+/g, ' ')
    || snapshot.identity.fingerprint !== userChromeBaseline.fingerprint
    || !snapshot.clonePaths.some(file => file.includes('code_sign_clone.Ly34OH'))) {
    throw new BrowserBaselineBlocked('USER_CHROME_BASELINE_CHANGED', `${label}: protected Chrome PID ${userChromeBaseline.pid} no longer matches its recorded identity; no user process was changed`);
  }
}

async function availableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('no loopback port')));
    });
  });
}

async function waitForResourceHttp(url, session, resourceId, label, timeoutMs = 20_000) {
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
  assert.equal(result.status, 0, `ps command lookup for Chrome PID ${pid} failed`);
  return result.stdout.trim();
}

async function findChromeForProfile(profilePath, timeoutMs = 15_000) {
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

function assertChromeLaunch(chrome, profilePath, featureArg) {
  assert.notEqual(chrome.pid, userChromeBaseline.pid, 'browser acceptance uses an isolated Chrome process');
  assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Chrome command lacks isolated profile');
  const featureArgs = chrome.command.match(/--disable-features=[^\s]+/g) || [];
  assert.equal(featureArgs.length, 1, 'Chrome command has exactly one --disable-features argument');
  assert.equal(featureArgs[0], featureArg, 'effective Chrome --disable-features matches merged config');
  assert.ok(featureArgs[0].split('=')[1].split(',').includes('MacAppCodeSignClone'));
  return featureArgs;
}

async function stopAndWait(session, resource, reason, timeoutMs = 15_000) {
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

function resourceEvidence(resource) {
  return { id: resource.id, label: resource.label, kind: resource.kind, role: resource.role,
    status: resource.status, pid: resource.pid, processGroup: resource.processGroup, processStartTime: resource.processStartTime,
    processFingerprint: resource.processFingerprint, processGroup: resource.pgid, command: resource.command, cwd: resource.cwd, tempDir: resource.tempDir,
    port: resource.port, logPath: resource.logPath, logBytes: resource.logBytes, maxLogBytes: resource.maxLogBytes,
    directoryPeakBytes: resource.directoryPeakBytes, maxDirectoryBytes: resource.maxDirectoryBytes,
    leaseExpiresAt: resource.leaseExpiresAt, pids: resource.pids };
}

async function main() {
  assert.ok(taskId, 'Stage22 browser acceptance requires CODEX_TASK_ID');
  assert.equal(runBounded('bash', ['-lc', 'command -v npx']).status, 0, 'npx must be available for the bundled Playwright CLI');
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const screenshotFile = (width, suffix) => path.join(screenshotDirectory, `stage22-${width}x1000-${suffix}.png`);
  const screenshotSet = suffix => Object.fromEntries((q227Only ? [1024] : [1024, 1440, 1920]).map(width => [width, screenshotFile(width, suffix)]));
  const screenshots = q227Only
    ? { clinicianReview: screenshotSet('q227-revised-approval-button'), clinicianHistory: screenshotSet('q227-revised-approval-history') }
    : { clinicianReview: screenshotSet('clinician-review'), clinicianHistory: screenshotSet('clinician-history'),
      guestTimelinePending: screenshotSet('guest-timeline-pending'), guestTimelineRegenerated: screenshotSet('guest-timeline-regenerated') };
  const screenshotPaths = Object.values(screenshots).flatMap(values => Object.values(values));
  for (const file of [...screenshotPaths, evidencePath, diagnosticScreenshotPath]) {
    try { await fs.access(file); throw new Error(`refusing to overwrite existing Stage22 browser artifact ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const config = JSON.parse(await fs.readFile(playwrightConfigPath, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config has one merged --disable-features argument');
  const featureArg = featureArgs[0];
  assert.ok(featureArg.split('=')[1].split(',').includes('MacAppCodeSignClone'));

  const evidence = { schemaVersion: 1, title: q227Only ? 'Stage22 Q22.7 revised-approval browser acceptance' : 'Stage22 clinician review, history and guest regeneration browser acceptance', taskId,
    observedAt: new Date().toISOString(), status: 'RUNNING', worktree: projectRoot,
    browserConfigPath: playwrightConfigPath, browserConfigFeatureArg: featureArg, cacheParent, expectedCacheNames,
    cacheSnapshots: [], userChromeSnapshots: [], resources: [], cliSteps: [], screenshots,
    resourceLimits: { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 } };
  let session;
  let modelResource;
  let viteResource;
  let browserOwner;
  let cliWorkDir;
  let socketAlias;
  let sessionName;
  let webUrl;
  let openMarker;
  let chrome;
  let browserOpened = false;
  let failure = null;
  let cleanupFailure = null;
  let blocked = false;
  let blockedReason = null;
  let sessionCloseResult;
  let lastSessionResources = [];

  async function recordCache(label) {
    const names = await cacheNames();
    evidence.cacheSnapshots.push({ label, at: new Date().toISOString(), names });
    if (JSON.stringify(names) !== JSON.stringify(expectedCacheNames)) {
      throw new BrowserBaselineBlocked('CHROME_CACHE_BASELINE_CHANGED', `${label}: Chrome code-sign clone cache names changed; observed items are preserved`);
    }
    return names;
  }

  function recordUserChrome(label) {
    const snapshot = userChromeSnapshot();
    evidence.userChromeSnapshots.push({ label, at: new Date().toISOString(), ...snapshot });
    assertUserChromeUnchanged(snapshot, label);
    return snapshot;
  }

  async function runCli(args, label, timeoutMs = 60_000) {
    const resource = await session.startProcess({ label, kind: 'browser', role: 'browser-cli', command: 'bash',
      args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfigPath] : []), '--session', sessionName, ...args],
      cwd: cliWorkDir,
      env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias } });
    let result = await session.waitProcess(resource.id, timeoutMs);
    const timedOut = Boolean(result.timedOut);
    if (timedOut) {
      await session.stop(resource.id, `${label}-timeout`);
      result = await session.waitProcess(resource.id, 15_000);
    }
    const log = await session.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    const item = { label,
      command: `bash ${playwrightWrapper} ${args[0] === 'open' ? `--config ${playwrightConfigPath} ` : ''}--session ${sessionName} ${args.join(' ')}`,
      resourceId: resource.id, pid: resource.pid, processGroup: resource.processGroup,
      processStartTime: resource.processStartTime, processFingerprint: resource.processFingerprint, processGroup: resource.pgid, logPath: resource.logPath,
      status: result.status, exitCode: result.exitCode ?? null, signal: result.signal || null,
      timedOut: timedOut || Boolean(result.timedOut), logBytes: result.logBytes, outputTail: String(log.tail || '').slice(-8192) };
    evidence.cliSteps.push(item);
    assert.equal(item.status, 'exited', `${label} status=${item.status}: ${item.outputTail.slice(-1200)}`);
    assert.equal(item.exitCode, 0, `${label} exit=${item.exitCode}: ${item.outputTail.slice(-1200)}`);
    assert.equal(item.signal, null, `${label} was signaled`);
    assert.equal(item.timedOut, false, `${label} timed out`);
    return item.outputTail;
  }

  try {
    evidence.dfBefore = dfSnapshot('before-browser');
    await recordCache('before-browser-launch');
    const userBefore = recordUserChrome('before-browser');
    evidence.userChromeBaselineObserved = { pid: userBefore.identity.pid, startTime: userBefore.identity.startTime,
      fingerprint: userBefore.identity.fingerprint, clonePaths: userBefore.clonePaths };

    session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
    evidence.resourceSessionId = session.instanceId;
    evidence.resourceTempDir = session.tempDir;
    evidence.resourceLimits = session.limits;
    sessionName = `stage22-${session.instanceId.slice(0, 8)}`;
    cliWorkDir = await session.allocateDir('browser-cli');
    const socketsDir = await session.allocateDir('playwright-sockets');
    socketAlias = path.join('/tmp', `pw-${session.instanceId.slice(0, 8)}`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright socket alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDir, socketAlias, 'dir');
    const profilePath = path.join(cliWorkDir, 'chrome-profile');
    openMarker = path.join(cliWorkDir, 'open-status.json');
    const ownerPath = path.join(cliWorkDir, 'browser-session-owner.mjs');
    const browserFlowPath = path.join(cliWorkDir, 'stage22-assistant-flow.mjs');
    await fs.writeFile(path.join(cliWorkDir, '.keep'), 'managed Stage22 Playwright profile and CLI output\n');
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
    const modelUrl = `http://127.0.0.1:${modelPort}/v1`;
    modelResource = await session.startProcess({ label: 'stage22-recorded-model-provider', kind: 'stub', role: 'model-provider',
      command: process.execPath, args: [path.join(projectRoot, 'scripts/resources/q22-recorded-model-server.js')],
      cwd: projectRoot, port: modelPort, env: { PATH: process.env.PATH || '', PORT: String(modelPort) } });
    await waitForResourceHttp(`http://127.0.0.1:${modelPort}/health`, session, modelResource.id, 'recorded model fixture');

    await withTemporaryApi(async ({ baseUrl, databasePath }) => {
      const apiOrigin = new URL(baseUrl).origin;
      evidence.apiOrigin = apiOrigin;
      evidence.fixtures = await prepareBrowserFixtures(baseUrl, databasePath);
      const webPort = await availableLoopbackPort();
      webUrl = `http://127.0.0.1:${webPort}`;
      viteResource = await session.startProcess({ label: 'stage22-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort,
        env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1', API_PROXY_TARGET: apiOrigin, WEB_PORT: String(webPort) } });
      assert.equal(viteResource.status, 'running', `Vite did not start: ${JSON.stringify(viteResource)}`);
      await waitForResourceHttp(webUrl, session, viteResource.id, 'Vite');

      browserOwner = await session.startProcess({ label: 'stage22-playwright-session-owner', kind: 'browser', role: 'browser-session-owner',
        command: process.execPath, args: [ownerPath], cwd: cliWorkDir,
        env: { PATH: process.env.PATH || '', PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfigPath,
          PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker,
          PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: webUrl } });
      assert.equal(browserOwner.status, 'running', `Playwright session owner did not start: ${JSON.stringify(browserOwner)}`);
      browserOpened = true;
      const openResult = await waitForFile(openMarker);
      evidence.cliSteps.push({ label: 'open', exitCode: openResult.code, signal: openResult.signal || null,
        status: openResult.code === 0 ? 'exited' : 'failed', configPassedOnlyToOpen: true,
        outputTail: String(openResult.output || '').slice(-4096) });
      assert.equal(openResult.code, 0, `Playwright open exited ${openResult.code}: ${String(openResult.output || '').slice(-1000)}`);
      assert.equal(openResult.signal, null);
      chrome = await findChromeForProfile(profilePath);
      const effectiveFeatureArgs = assertChromeLaunch(chrome, profilePath, featureArg);
      evidence.chrome = { pid: chrome.pid, startTime: chrome.startTime, processGroup: chrome.pgid,
        fingerprint: chrome.fingerprint, executable: chrome.executable, profilePath,
        effectiveDisableFeaturesArgs: effectiveFeatureArgs, effectiveDisableFeatures: effectiveFeatureArgs[0] };
      recordUserChrome('during-browser-open');
      await recordCache('during-after-browser-open');

      await runCli(['snapshot'], 'stage22-playwright-initial-snapshot', 30_000);
      let browserFlow = await fs.readFile(path.join(projectRoot, 'scripts/resources/stage22-browser-flow.js'), 'utf8');
      browserFlow = browserFlow.replace('__WEB_URL__', JSON.stringify(webUrl))
        .replace('__SCREENSHOTS__', JSON.stringify(screenshots))
        .replace('__FIXTURES__', JSON.stringify(evidence.fixtures))
        .replace('__Q227_ONLY__', JSON.stringify(q227Only));
      const flowPath = path.join(cliWorkDir, 'stage22-assistant-flow.mjs');
      await fs.writeFile(flowPath, browserFlow);
      const output = await runCli(['run-code', '--filename', flowPath], 'stage22-playwright-assistant-flow', 180_000);
      const resultMatch = output.match(/STAGE22_BROWSER_RESULT:(\{[^\r\n]*\})/);
      assert.ok(resultMatch, `browser flow omitted structured result: ${output.slice(-2000)}`);
      evidence.browserFlow = JSON.parse(resultMatch[1]);
      evidence.browserFlowOutputBytes = Buffer.byteLength(output, 'utf8');
      await recordCache('during-after-collaboration-flow');
      recordUserChrome('during-after-browser-flow');
      for (const file of screenshotPaths) await fs.access(file);

      const closeOutput = await runCli(['close'], 'stage22-playwright-close', 30_000);
      browserOpened = false;
      evidence.cliSteps.push({ label: 'close-session', status: 'exited', exitCode: 0, outputTail: closeOutput.slice(-4096), configPassedOnlyToOpen: true });
      const chromeDeadline = Date.now() + 15_000;
      while (processMatches(chrome.pid, chrome) && Date.now() < chromeDeadline) await new Promise(resolve => setTimeout(resolve, 100));
      evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
      assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `isolated Chrome PID ${chrome.pid} remains after close`);
      await recordCache('after-browser-close');
      recordUserChrome('after-browser-close');
      const socketHandles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
      assert.ok([0, 1].includes(socketHandles.status), `lsof socket alias check exited ${socketHandles.status}`);
      assert.equal(socketHandles.status === 0 && Boolean(socketHandles.stdout.trim()), false,
        `Playwright socket alias still has open handles: ${String(socketHandles.stdout || '').slice(0, 1000)}`);
      evidence.cleanupSteps = [{ action: 'lsof-playwright-socket-alias', command: `lsof -nP +D ${socketAlias}`,
        exitCode: socketHandles.status, matchingHandles: socketHandles.stdout.trim() ? 'present' : 'none' }];
      await fs.unlink(socketAlias);
      evidence.cleanupSteps.push({ action: 'remove-exact-playwright-socket-alias', path: socketAlias, status: 'removed' });
      socketAlias = null;
      await stopAndWait(session, browserOwner, 'stage22-browser-flow-complete');
      browserOwner = null;
      await stopAndWait(session, viteResource, 'stage22-browser-flow-complete');
      viteResource = null;
      await stopAndWait(session, modelResource, 'stage22-browser-flow-complete');
      modelResource = null;
      recordUserChrome('after-browser-session-owner-exit');
      await recordCache('after-browser-session-owner-exit');
      evidence.screenshotBytes = {};
      for (const file of screenshotPaths) evidence.screenshotBytes[path.basename(file)] = (await fs.stat(file)).size;
    }, 'haiyu-stage22-browser-', {
      LLM_BASE_URL: modelUrl, LLM_API_KEY: 'stage22-recorded-provider-key', LLM_MODEL: 'recorded-stage22',
      ASSISTANT_MODEL_SOURCE: 'recorded_fixture', NODE_ENV: 'test', LLM_TIMEOUT_MS: '30000',
      WELLNESS_DRAFT_REVIEW_POLICY: 'sampled_review', WELLNESS_DRAFT_REVIEW_SAMPLE_PERCENT: '100',
      BUSINESS_CLOCK_NOW: '2026-10-05T00:00:00.000Z'
    }, { resourceSession: session });
  } catch (error) {
    if (error?.stageBlocked === true) { blocked = true; blockedReason = error.message; }
    else failure = error;
  } finally {
    if (session) {
      if (browserOpened && cliWorkDir && socketAlias) {
        try {
          const output = await runCli(['close'], 'stage22-playwright-failure-close', 30_000);
          evidence.cleanupSteps ||= [];
          evidence.cleanupSteps.push({ action: 'playwright-cli-close-after-failure', status: 'exited', exitCode: 0, outputTail: output.slice(-2000) });
          browserOpened = false;
        } catch (error) { cleanupFailure ||= `Playwright close after failure: ${error.message}`; }
      }
      for (const [resource, reason] of [[browserOwner, 'stage22-browser-owner-cleanup'],
        [viteResource, 'stage22-vite-cleanup'], [modelResource, 'stage22-model-cleanup']]) {
        try {
          if (resource) {
            const exited = await stopAndWait(session, resource, reason);
            evidence.cleanupSteps ||= [];
            evidence.cleanupSteps.push({ action: 'stop-managed-resource', label: resource.label, pid: resource.pid,
              status: exited.status, exitCode: exited.exitCode ?? null, signal: exited.signal || null });
          }
        } catch (error) { cleanupFailure ||= `${resource?.label || 'resource'} cleanup: ${error.message}`; }
      }
      if (socketAlias) {
        try {
          const handles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
          if (![0, 1].includes(handles.status)) throw new Error(`lsof exited ${handles.status}`);
          if (handles.status === 0 && handles.stdout.trim()) throw new Error(`handles remain: ${handles.stdout.slice(0, 1000)}`);
          await fs.unlink(socketAlias).catch(error => { if (error.code !== 'ENOENT') throw error; });
          evidence.cleanupSteps ||= [];
          evidence.cleanupSteps.push({ action: 'remove-exact-playwright-socket-alias-after-failure', path: socketAlias,
            lsofExitCode: handles.status, status: 'removed' });
          socketAlias = null;
        } catch (error) { cleanupFailure ||= `Playwright socket alias cleanup: ${error.message}`; }
      }
      try {
        const status = await session.status();
        lastSessionResources = (status.resources || []).map(resourceEvidence);
        const live = lastSessionResources.filter(resource => ['starting', 'running'].includes(resource.status));
        if (live.length) cleanupFailure ||= `resources remain active before session close: ${live.map(item => `${item.label}:${item.pid}`).join(', ')}`;
      } catch (error) { cleanupFailure ||= `resource status capture: ${error.message}`; }
      try {
        sessionCloseResult = await session.close(failure || cleanupFailure || blocked ? 'stage22-browser-failure' : 'stage22-browser-complete');
        evidence.sessionCleanup = sessionCloseResult?.cleanupRecord || null;
        evidence.resourceTempDirRemoved = !await fs.stat(session.tempDir).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error));
      } catch (error) { cleanupFailure ||= `ResourceSession close: ${error.message}`; }
    }
    try { await recordCache('after-ResourceSession-cleanup'); }
    catch (error) { if (error?.stageBlocked) { blocked = true; blockedReason ||= error.message; } else cleanupFailure ||= error.message; }
    try { recordUserChrome('after-ResourceSession-cleanup'); }
    catch (error) { if (error?.stageBlocked) { blocked = true; blockedReason ||= error.message; } else cleanupFailure ||= error.message; }
    try { evidence.dfAfter = dfSnapshot('after-browser-cleanup'); }
    catch (error) { cleanupFailure ||= error.message; }
    if (chrome) {
      evidence.chrome = { ...(evidence.chrome || {}), exactIdentityExitedAfterCleanup: !processMatches(chrome.pid, chrome) };
      if (processMatches(chrome.pid, chrome)) cleanupFailure ||= `isolated Chrome PID ${chrome.pid} survived cleanup`;
    }
    evidence.resources = lastSessionResources.length ? lastSessionResources : evidence.resources;
    evidence.status = blocked ? 'BLOCKED' : failure || cleanupFailure ? 'FAIL' : 'PASS';
    evidence.blockedReason = blockedReason;
    evidence.completedAt = new Date().toISOString();
    evidence.failure = failure ? String(failure.stack || failure).slice(0, 6000) : null;
    evidence.cleanupFailure = cleanupFailure;
    evidence.cacheNamesUnchanged = evidence.cacheSnapshots.length >= 2 && evidence.cacheSnapshots.every(snapshot =>
      JSON.stringify(snapshot.names) === JSON.stringify(expectedCacheNames));
    try { await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' }); }
    catch (error) {
      if (!failure) failure = error;
      evidence.status = 'FAIL';
      evidence.failure = `could not write browser evidence: ${error.message}`;
    }
  }
  if (blocked) {
    const summary = { status: 'BLOCKED', reason: blockedReason, evidencePath, cacheNamesUnchanged: evidence.cacheNamesUnchanged,
      resources: evidence.resources.map(item => ({ id: item.id, pid: item.pid, status: item.status })) };
    console.log(`STAGE22_BROWSER_RESULT:${JSON.stringify(summary)}`);
    process.exitCode = 2;
    return;
  }
  if (failure || cleanupFailure) throw new Error(`Stage22 browser FAIL: ${failure?.message || cleanupFailure}`);
  const flow = evidence.browserFlow;
  const summary = { status: 'PASS', evidencePath, screenshots: screenshotPaths, widths: flow.widths,
    review: flow.review, history: flow.history, drafts: flow.drafts, timeline: flow.timeline,
    cacheNamesUnchanged: evidence.cacheNamesUnchanged, chrome: { pid: evidence.chrome.pid,
      exactIdentityExitedAfterCleanup: evidence.chrome.exactIdentityExitedAfterCleanup },
    resources: evidence.resources.map(item => ({ id: item.id, pid: item.pid, status: item.status })) };
  console.log(`STAGE22_BROWSER_RESULT:${JSON.stringify(summary)}`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = error?.stageBlocked ? 2 : 1;
});
