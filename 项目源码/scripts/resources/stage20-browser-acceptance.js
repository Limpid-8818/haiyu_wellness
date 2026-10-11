import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTemporaryApi } from '../quests/helpers.js';
import { ResourceSession, processIdentity, processMatches } from './resource-runtime.js';
import { validateProtectedChromeSnapshot } from './protected-chrome-snapshot.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskId = process.env.CODEX_TASK_ID;
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'playwright-cli.config.json');
const screenshotRoot = path.join(projectRoot, 'output/playwright');
const stageDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
  .format(new Date()).replaceAll('-', '');
const retryPrefix = 'stage20-' + stageDate + '-retry';
let retryNumber = 1;
let screenshotDirectory = path.join(screenshotRoot, retryPrefix + String(retryNumber).padStart(2, '0'));
while (fsSync.existsSync(screenshotDirectory)) {
  retryNumber += 1;
  screenshotDirectory = path.join(screenshotRoot, retryPrefix + String(retryNumber).padStart(2, '0'));
}
const evidencePath = path.join(screenshotDirectory, 'assistant-collaboration-browser-evidence.json');
const diagnosticScreenshotPath = path.join(screenshotDirectory, 'assistant-collaboration-failure-debug.png');
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
    lsofExitCode: handles.status, clonePaths: [...new Set(clonePaths)].sort() };
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
  assert.ok(taskId, 'Stage20 browser acceptance requires CODEX_TASK_ID');
  assert.equal(runBounded('bash', ['-lc', 'command -v npx']).status, 0, 'npx must be available for the bundled Playwright CLI');
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const screenshotFile = (width, suffix) => path.join(screenshotDirectory, 'assistant-collaboration-' + width + 'x1000-' + suffix + '.png');
  const screenshots = {
    traceTop: Object.fromEntries([1024, 1440, 1920].map(width => [width,
      screenshotFile(width, 'trace-top')])),
    candidateDecisions: Object.fromEntries([1024, 1440, 1920].map(width => [width,
      screenshotFile(width, 'candidate-decisions-top')])),
    candidateDecisionTail: Object.fromEntries([1024, 1440, 1920].map(width => [width,
      screenshotFile(width, 'candidate-decisions-tail')])),
    coordinatorFailure: Object.fromEntries([1024, 1440, 1920].map(width => [width,
      screenshotFile(width, 'coordinator-failure')]))
  };
  const screenshotPaths = [...Object.values(screenshots.traceTop), ...Object.values(screenshots.candidateDecisions),
    ...Object.values(screenshots.candidateDecisionTail), ...Object.values(screenshots.coordinatorFailure)];
  for (const file of [...screenshotPaths, evidencePath, diagnosticScreenshotPath]) {
    try { await fs.access(file); throw new Error(`refusing to overwrite existing Stage20 browser artifact ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const config = JSON.parse(await fs.readFile(playwrightConfigPath, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config has one merged --disable-features argument');
  const featureArg = featureArgs[0];
  assert.ok(featureArg.split('=')[1].split(',').includes('MacAppCodeSignClone'));

  const evidence = { schemaVersion: 1, title: 'Stage20 assistant collaboration browser acceptance', taskId,
    observedAt: new Date().toISOString(), status: 'RUNNING', worktree: projectRoot,
    browserConfigPath: playwrightConfigPath, browserConfigFeatureArg: featureArg, cacheParent, expectedCacheNames,
    cacheSnapshots: [], userChromeSnapshots: [], protectedChromeSnapshots: [], protectedChromeBaselineObserved: null,
    resources: [], cliSteps: [], screenshots,
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

  async function recordProtectedSnapshot(label) {
    const names = await cacheNames();
    evidence.cacheSnapshots.push({ label, at: new Date().toISOString(), names });
    const snapshot = { ...userChromeSnapshot(), cacheNames: names };
    const at = new Date().toISOString();
    evidence.userChromeSnapshots.push({ label, at, ...snapshot });
    evidence.protectedChromeSnapshots.push({ label, at, ...snapshot });
    const validation = validateProtectedChromeSnapshot(snapshot, { protectedChrome: userChromeBaseline,
      cacheParent, expectedCacheNames, baseline: evidence.protectedChromeBaselineObserved });
    if (!validation.ok) throw new BrowserBaselineBlocked(validation.code, `${label}: ${validation.message}; observed items are preserved`);
    if (!evidence.protectedChromeBaselineObserved) evidence.protectedChromeBaselineObserved = validation.baseline;
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
    const userBefore = await recordProtectedSnapshot('before-browser-launch');
    evidence.userChromeBaselineObserved = { pid: userBefore.identity.pid, startTime: userBefore.identity.startTime,
      fingerprint: userBefore.identity.fingerprint, clonePaths: userBefore.clonePaths };

    session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
    evidence.resourceSessionId = session.instanceId;
    evidence.resourceTempDir = session.tempDir;
    evidence.resourceLimits = session.limits;
    sessionName = `stage20-${session.instanceId.slice(0, 8)}`;
    cliWorkDir = await session.allocateDir('browser-cli');
    const socketsDir = await session.allocateDir('playwright-sockets');
    socketAlias = path.join('/tmp', `pw-${session.instanceId.slice(0, 8)}`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright socket alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDir, socketAlias, 'dir');
    const profilePath = path.join(cliWorkDir, 'chrome-profile');
    openMarker = path.join(cliWorkDir, 'open-status.json');
    const ownerPath = path.join(cliWorkDir, 'browser-session-owner.mjs');
    const browserFlowPath = path.join(cliWorkDir, 'stage20-assistant-flow.mjs');
    await fs.writeFile(path.join(cliWorkDir, '.keep'), 'managed Stage20 Playwright profile and CLI output\n');
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
    modelResource = await session.startProcess({ label: 'stage20-recorded-model-provider', kind: 'stub', role: 'model-provider',
      command: process.execPath, args: [path.join(projectRoot, 'scripts/resources/recorded-model-server.js')],
      cwd: projectRoot, port: modelPort, env: { PATH: process.env.PATH || '', PORT: String(modelPort) } });
    await waitForResourceHttp(`http://127.0.0.1:${modelPort}/health`, session, modelResource.id, 'recorded model fixture');

    await withTemporaryApi(async ({ baseUrl }) => {
      const apiOrigin = new URL(baseUrl).origin;
      evidence.apiOrigin = apiOrigin;
      const webPort = await availableLoopbackPort();
      webUrl = `http://127.0.0.1:${webPort}`;
      viteResource = await session.startProcess({ label: 'stage20-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort,
        env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1', API_PROXY_TARGET: apiOrigin, WEB_PORT: String(webPort) } });
      assert.equal(viteResource.status, 'running', `Vite did not start: ${JSON.stringify(viteResource)}`);
      await waitForResourceHttp(webUrl, session, viteResource.id, 'Vite');

      browserOwner = await session.startProcess({ label: 'stage20-playwright-session-owner', kind: 'browser', role: 'browser-session-owner',
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
      await recordProtectedSnapshot('during-browser-open');

      await runCli(['snapshot'], 'stage20-playwright-initial-snapshot', 30_000);
      const browserFlow = String.raw`async page => {
const assert = {
  equal(actual, expected, message) { if (actual !== expected) throw new Error(message + ': expected ' + expected + ', got ' + actual); },
  deepEqual(actual, expected, message) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual)); },
  ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); },
  includes(actual, expected, message) { if (!String(actual).includes(expected)) throw new Error(message + ': missing ' + expected); }
};
const webUrl = __WEB_URL__;
  const screenshots = __SCREENSHOTS__;
const pageErrors = [];
const consoleMessages = [];
const blockedRequests = [];
const failedRequests = [];
const chatResponses = [];
const assistantRunResponses = [];
page.setDefaultTimeout(20000);
page.setDefaultNavigationTimeout(20000);
page.on('pageerror', error => pageErrors.push(String(error.message || error).slice(0, 500)));
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push({ type: message.type(), text: message.text().slice(0, 500) });
});
page.on('requestfailed', request => {
  const url = request.url();
  let origin = 'invalid-url';
  try { origin = new URL(url).origin; } catch { /* keep bounded invalid URL marker */ }
  failedRequests.push({ origin, error: request.failure()?.errorText || 'unknown', url: url.slice(0, 500) });
});
page.on('response', response => {
  if (response.request().method() === 'POST' && response.url().endsWith('/api/assistant/chat')) chatResponses.push(response.status());
  if (response.request().method() === 'GET' && /\/api\/assistant\/runs\/run_/.test(response.url())) {
    void response.json().then(data => assistantRunResponses.push({
      runId: data.runId, status: data.status, executionMode: data.executionMode,
      collaboration: data.collaboration ? {
        parent: { runId: data.collaboration.parent.runId, agentId: data.collaboration.parent.agentId,
          modelSteps: data.collaboration.parent.modelSteps, validationSteps: data.collaboration.parent.validationSteps },
        agents: data.collaboration.agents.map(agent => ({ runId: agent.runId, agentId: agent.agentId, status: agent.status,
          toolNames: agent.tools.map(tool => tool.toolName), sources: agent.sources.map(source => ({ type: source.type, id: source.id })) })),
        candidates: data.collaboration.candidates.map(candidate => ({ candidateId: candidate.candidateId, domain: candidate.domain,
          status: candidate.status, reason: candidate.reason })), selectedCandidateIds: data.collaboration.selectedCandidateIds,
        finalAdoptedCandidateIds: data.collaboration.finalAdoptedCandidateIds,
        coordinatorStatus: data.collaboration.coordinatorStatus, coordinatorError: data.collaboration.coordinatorError,
        selectionSource: data.collaboration.selectionSource, fallbackSource: data.collaboration.fallbackSource,
        selectionValidation: data.collaboration.selectionValidation,
        gaps: data.collaboration.gaps, graphBudget: data.collaboration.graphBudget
      } : null
    })).catch(() => {});
  }
});
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.protocol === 'data:' || url.protocol === 'blob:' || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
  blockedRequests.push({ origin: url.origin, url: url.href.slice(0, 500), resourceType: route.request().resourceType() });
  return route.abort();
});
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '我是客人 →', exact: true }).click();
await page.getByRole('button', { name: /进入工作区/ }).click();
await page.getByRole('button', { name: '打开智能助手', exact: true }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '打开智能助手', exact: true }).click();
const panel = page.getByRole('region', { name: '智能助手对话' });
await panel.waitFor({ state: 'visible' });
await panel.getByText('健康支持助手', { exact: true }).waitFor({ state: 'visible' });
const input = panel.getByLabel('输入给智能助手的内容');
const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/assistant/chat'));
await input.fill('给我明天的海边活动和三餐。分别查看开放活动时间与菜单食材，排除不适用候选，不创建预约或餐单。');
await panel.getByRole('button', { name: '发送消息', exact: true }).click();
const chatResponse = await responsePromise;
assert.equal(chatResponse.status(), 202, 'assistant chat uses the persisted async run endpoint');
const accepted = await chatResponse.json();
assert.ok(accepted.runId && accepted.sessionId, 'async response includes the parent run and session IDs');
await page.waitForFunction(runId => {
  const card = [...document.querySelectorAll('.assistant-window .assistant-message.assistant')].find(node => node.innerText.includes('录制模型夹具'));
  const track = [...document.querySelectorAll('.assistant-window .assistant-message.assistant')].find(node => node.innerText.includes('本次如何生成'));
  return Boolean(card && track && card.innerText.includes('餐食候选')) && sessionStorage && runId;
}, accepted.runId, { timeout: 60000 });
const assistantMessage = page.locator('.assistant-window .assistant-message.assistant').filter({ hasText: '本次如何生成' }).first();
await assistantMessage.waitFor({ state: 'visible' });
const assistantText = await assistantMessage.innerText();
assert.ok(assistantText.includes('录制模型夹具'), 'UI labels the recorded provider accurately');
assert.ok(!assistantText.includes('真实模型服务'), 'fixture is not mislabeled as a live model');
await assistantMessage.locator('.assistant-trace-toggle').click();
const trace = assistantMessage.locator('.assistant-trace-body');
await trace.waitFor({ state: 'visible' });
const traceText = await trace.innerText();
for (const text of ['household.concierge', 'domain.nutrition', 'domain.exercise', 'run_', 'get_nutrition_context',
  'get_exercise_context', 'dish-shrimp-noodles', '已排除', '来源 ID']) assert.includes(traceText, text, 'visible trace');
const finalRunResponse = await page.evaluate(async runId => {
  const token = localStorage.getItem('community_token');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const response = await fetch('/api/assistant/runs/' + encodeURIComponent(runId) + '?role=guest', {
      headers: token ? { authorization: 'Bearer ' + token } : {}
    });
    if (!response.ok) throw new Error('assistant run detail returned HTTP ' + response.status);
    const data = await response.json();
    if (!['queued', 'running'].includes(data.status)) return data;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('assistant graph detail timed out');
}, accepted.runId);
assert.ok(finalRunResponse?.collaboration, 'parent/child graph response was captured from the API');
assert.equal(finalRunResponse.collaboration.parent.runId, accepted.runId);
assert.deepEqual(finalRunResponse.collaboration.agents.map(agent => agent.agentId).sort(), ['domain.exercise', 'domain.nutrition']);
assert.ok(finalRunResponse.collaboration.agents.every(agent => agent.runId !== accepted.runId && agent.status === 'completed'));
assert.ok(finalRunResponse.collaboration.agents.every(agent => agent.tools.length === 2));
assert.equal(finalRunResponse.collaboration.coordinatorError, null);
assert.equal(finalRunResponse.collaboration.coordinatorStatus, 'completed');
assert.equal(finalRunResponse.collaboration.selectionSource, 'model');
assert.deepEqual(finalRunResponse.collaboration.selectionValidation,
  { schemaValid: true, allowlistValid: true, responseComplete: true });
assert.ok(finalRunResponse.collaboration.parent.modelSteps.length === 1);
assert.equal(finalRunResponse.collaboration.parent.modelSteps[0].status, 'completed');
assert.equal(finalRunResponse.collaboration.parent.modelSteps[0].finishReason, 'stop');
assert.equal(finalRunResponse.collaboration.parent.validationSteps.length, 1);
assert.equal(finalRunResponse.collaboration.parent.validationSteps[0].status, 'completed');
assert.deepEqual(finalRunResponse.collaboration.finalAdoptedCandidateIds, finalRunResponse.collaboration.selectedCandidateIds);
assert.equal(JSON.stringify(finalRunResponse).includes('reasoningContent'), false, 'run detail excludes internal reasoning fields');
assert.ok(finalRunResponse.collaboration.candidates.some(item => item.candidateId.includes('dish-shrimp-noodles')
  && item.status === 'rejected' && item.reason.includes('过敏')));
const finalRun = async runId => await page.evaluate(async id => {
  const token = localStorage.getItem('community_token');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const response = await fetch('/api/assistant/runs/' + encodeURIComponent(id) + '?role=guest', {
      headers: token ? { authorization: 'Bearer ' + token } : {}
    });
    if (!response.ok) throw new Error('assistant run detail returned HTTP ' + response.status);
    const data = await response.json();
    if (!['queued', 'running'].includes(data.status)) return data;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('assistant graph detail timed out');
}, runId);

const widths = [];
for (const width of [1024, 1440, 1920]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(120);
  const layout = await assistantMessage.evaluate(node => {
    const panel = node.closest('.assistant-window');
    const traceBody = node.querySelector('.assistant-trace-body');
    const bounds = panel?.getBoundingClientRect();
    return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
      assistantWidth: Math.round(bounds?.width || 0), assistantRight: Math.round(bounds?.right || 0),
      traceScrollWidth: traceBody?.scrollWidth || 0, traceClientWidth: traceBody?.clientWidth || 0,
      traceBodyHeight: traceBody?.clientHeight || 0, traceBodyScrollHeight: traceBody?.scrollHeight || 0,
      candidateCount: traceBody?.querySelectorAll('.assistant-trace-candidate').length || 0 };
  });
  assert.ok(layout.documentWidth <= width, width + 'px page does not horizontally overflow: ' + JSON.stringify(layout));
  assert.ok(layout.assistantWidth <= 430 && layout.assistantRight <= width, width + 'px assistant fits: ' + JSON.stringify(layout));
  assert.ok(layout.traceScrollWidth <= layout.traceClientWidth + 1, width + 'px track contents wrap instead of overflowing: ' + JSON.stringify(layout));
  await assistantMessage.evaluate(node => {
    const body = node.querySelector('.assistant-trace-body');
    const messages = node.closest('.assistant-window')?.querySelector('.assistant-messages');
    if (body) body.scrollTop = 0;
    if (messages) messages.scrollTop = messages.scrollHeight;
  });
  await page.screenshot({ path: screenshots.traceTop[width], fullPage: false });
  const decisionOffsets = await assistantMessage.evaluate(node => {
    const body = node.querySelector('.assistant-trace-body');
    const candidates = body?.querySelector('.assistant-trace-candidates');
    if (!body || !candidates) throw new Error('candidate decision section is missing from the trace');
    const start = Math.max(0, body.scrollTop + candidates.getBoundingClientRect().top - body.getBoundingClientRect().top);
    return { start, tail: Math.max(0, start + candidates.scrollHeight - body.clientHeight) };
  });
  widths.push({ width, ...layout, candidateDecisionScroll: decisionOffsets, noHorizontalOverflow: true });
  await assistantMessage.evaluate((node, offset) => {
    const body = node.querySelector('.assistant-trace-body');
    const messages = node.closest('.assistant-window')?.querySelector('.assistant-messages');
    if (body) body.scrollTop = offset.start;
    if (messages) messages.scrollTop = messages.scrollHeight;
  }, decisionOffsets);
  await page.waitForTimeout(120);
  await page.screenshot({ path: screenshots.candidateDecisions[width], fullPage: false });
  await assistantMessage.evaluate((node, offset) => {
    const body = node.querySelector('.assistant-trace-body');
    const messages = node.closest('.assistant-window')?.querySelector('.assistant-messages');
    if (body) body.scrollTop = offset.tail;
    if (messages) messages.scrollTop = messages.scrollHeight;
  }, decisionOffsets);
  await page.waitForTimeout(120);
  await page.screenshot({ path: screenshots.candidateDecisionTail[width], fullPage: false });
}

const failureResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
  && response.url().endsWith('/api/assistant/chat'));
await input.fill('Q20:COORDINATOR-INVALID-JSON 给我明天的海边活动和三餐。分别查看开放活动时间与菜单食材，排除不适用候选，不创建预约或餐单。');
await panel.getByRole('button', { name: '发送消息', exact: true }).click();
const failureChatResponse = await failureResponsePromise;
assert.equal(failureChatResponse.status(), 202, 'coordinator failure preserves the async run and domain candidate response');
const failureAccepted = await failureChatResponse.json();
assert.ok(failureAccepted.runId && failureAccepted.runId !== accepted.runId);
await page.waitForFunction(runId => {
  const cards = [...document.querySelectorAll('.assistant-window .assistant-message.assistant')];
  return cards.some(node => node.innerText.includes('管家选择未完成') && node.innerText.includes('回退来源')) && runId;
}, failureAccepted.runId, { timeout: 60000 });
const failureAssistantMessage = page.locator('.assistant-window .assistant-message.assistant')
  .filter({ hasText: '管家选择未完成' }).last();
await failureAssistantMessage.locator('.assistant-trace-toggle').click();
const failureTrace = failureAssistantMessage.locator('.assistant-trace-body');
await failureTrace.waitFor({ state: 'visible' });
const failureTraceText = await failureTrace.innerText();
for (const value of ['COORDINATOR_OUTPUT_INVALID_JSON', '回退来源', '领域候选（未经管家选择）',
  'domain.nutrition', 'domain.exercise', 'schema 失败']) assert.includes(failureTraceText, value, 'coordinator failure trace');
const failedSelectionLabels = await failureAssistantMessage.locator('.assistant-trace-candidate span').allTextContents();
assert.ok(failedSelectionLabels.every(value => !value.includes('管家采用')),
  'fallback candidates are never labeled as coordinator selections');
const failureRunResponse = await finalRun(failureAccepted.runId);
assert.equal(failureRunResponse.status, 'completed', 'completed domain candidates remain available when parent selection fails');
assert.equal(failureRunResponse.collaboration.coordinatorError, 'COORDINATOR_OUTPUT_INVALID_JSON');
assert.equal(failureRunResponse.collaboration.coordinatorStatus, 'failed');
assert.equal(failureRunResponse.collaboration.selectionSource, null);
assert.equal(failureRunResponse.collaboration.fallbackSource, 'completed_domain_candidates');
assert.deepEqual(failureRunResponse.collaboration.selectedCandidateIds, []);
assert.deepEqual(failureRunResponse.collaboration.finalAdoptedCandidateIds, []);
assert.equal(failureRunResponse.collaboration.parent.modelSteps[0].status, 'completed');
assert.equal(failureRunResponse.collaboration.parent.validationSteps[0].status, 'failed');
assert.equal(failureRunResponse.collaboration.parent.validationSteps[0].errorCode, 'COORDINATOR_OUTPUT_INVALID_JSON');
assert.ok(failureRunResponse.collaboration.candidates.some(item => item.domain === 'nutrition' && item.status === 'adopted'));
assert.equal(JSON.stringify(failureRunResponse).includes('reasoningContent'), false, 'failed coordinator detail also excludes internal reasoning');

const failureWidths = [];
for (const width of [1024, 1440, 1920]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(120);
  const layout = await failureAssistantMessage.evaluate(node => {
    const panel = node.closest('.assistant-window');
    const traceBody = node.querySelector('.assistant-trace-body');
    const bounds = panel?.getBoundingClientRect();
    return { viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
      assistantWidth: Math.round(bounds?.width || 0), assistantRight: Math.round(bounds?.right || 0),
      traceScrollWidth: traceBody?.scrollWidth || 0, traceClientWidth: traceBody?.clientWidth || 0,
      candidateCount: traceBody?.querySelectorAll('.assistant-trace-candidate').length || 0 };
  });
  assert.ok(layout.documentWidth <= width, width + 'px failed-selection page does not horizontally overflow: ' + JSON.stringify(layout));
  assert.ok(layout.assistantWidth <= 430 && layout.assistantRight <= width, width + 'px failure warning fits: ' + JSON.stringify(layout));
  assert.ok(layout.traceScrollWidth <= layout.traceClientWidth + 1, width + 'px failure trace wraps without horizontal overflow: ' + JSON.stringify(layout));
  assert.ok(layout.candidateCount > 0);
  await failureAssistantMessage.evaluate(node => {
    const body = node.querySelector('.assistant-trace-body');
    const messages = node.closest('.assistant-window')?.querySelector('.assistant-messages');
    if (body) body.scrollTop = 0;
    if (messages) messages.scrollTop = messages.scrollHeight;
  });
  await page.screenshot({ path: screenshots.coordinatorFailure[width], fullPage: false });
  failureWidths.push({ width, ...layout, coordinatorFailureVisible: true, fallbackCandidatesUnselected: true });
}
assert.deepEqual(chatResponses, [202, 202], 'both normal and coordinator-failure graph requests were accepted asynchronously');
const knownFontOrigins = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const unexpectedBlockedRequests = [...new Set(blockedRequests.map(item => item.origin))].filter(origin => !knownFontOrigins.includes(origin));
const unexpectedFailedRequests = failedRequests.filter(item => !knownFontOrigins.includes(item.origin));
const unexpectedConsoleErrors = consoleMessages.filter(item => item.type === 'error'
  && !/fonts\.(?:googleapis|gstatic)\.com|ERR_BLOCKED_BY_CLIENT/.test(item.text)
  && !(item.text.includes('net::ERR_FAILED') && failedRequests.some(request => knownFontOrigins.includes(request.origin))));
assert.deepEqual(pageErrors, [], 'browser reports no page errors');
assert.deepEqual(unexpectedBlockedRequests, [], 'only known web-font origins were blocked: ' + JSON.stringify(unexpectedBlockedRequests));
assert.deepEqual(unexpectedFailedRequests, [], 'only the known web-font requests failed: ' + JSON.stringify(unexpectedFailedRequests));
assert.deepEqual(unexpectedConsoleErrors, [], 'no unexpected browser console errors: ' + JSON.stringify(unexpectedConsoleErrors));
const browserResult = { status: 'PASS', executionMode: finalRunResponse.executionMode, parentRunId: accepted.runId,
  normalCoordinator: { status: finalRunResponse.collaboration.coordinatorStatus,
    selectionSource: finalRunResponse.collaboration.selectionSource,
    selectionValidation: finalRunResponse.collaboration.selectionValidation,
    parentModelSteps: finalRunResponse.collaboration.parent.modelSteps,
    selectedCandidateIds: finalRunResponse.collaboration.finalAdoptedCandidateIds },
  failureRunId: failureAccepted.runId,
  coordinatorFailure: { error: failureRunResponse.collaboration.coordinatorError,
    fallbackSource: failureRunResponse.collaboration.fallbackSource,
    parentModelSteps: failureRunResponse.collaboration.parent.modelSteps,
    validationSteps: failureRunResponse.collaboration.parent.validationSteps,
    selectedCandidateIds: failureRunResponse.collaboration.finalAdoptedCandidateIds },
  childRunIds: finalRunResponse.collaboration.agents.map(agent => agent.runId),
  agentIds: finalRunResponse.collaboration.agents.map(agent => agent.agentId),
  toolNames: finalRunResponse.collaboration.agents.flatMap(agent => agent.tools.map(tool => tool.toolName)),
  candidateDecisions: finalRunResponse.collaboration.candidates.map(item => ({ candidateId: item.candidateId,
    domain: item.domain, status: item.status, reason: item.reason })),
  sourceIds: finalRunResponse.collaboration.agents.flatMap(agent => agent.sources.map(source => source.id)),
  widths, failureWidths, pageErrors, consoleMessages: consoleMessages.slice(0, 30), blockedRequests: blockedRequests.slice(0, 30),
  failedRequests: failedRequests.slice(0, 30),
  cacheNamesUnchanged: true };
await page.evaluate(result => { document.title = 'STAGE20_BROWSER_RESULT:' + JSON.stringify(result); }, browserResult);
return browserResult;
}`;
      const flowPath = path.join(cliWorkDir, 'stage20-assistant-flow.mjs');
      await fs.writeFile(flowPath, browserFlow.replace('__WEB_URL__', JSON.stringify(webUrl)).replace('__SCREENSHOTS__', JSON.stringify(screenshots)));
      const output = await runCli(['run-code', '--filename', flowPath], 'stage20-playwright-assistant-flow', 180_000);
      const resultMatch = output.match(/STAGE20_BROWSER_RESULT:(\{[^\r\n]*\})/);
      assert.ok(resultMatch, `browser flow omitted structured result: ${output.slice(-2000)}`);
      evidence.browserFlow = JSON.parse(resultMatch[1]);
      evidence.browserFlowOutputBytes = Buffer.byteLength(output, 'utf8');
      await recordProtectedSnapshot('during-after-collaboration-flow');
      for (const file of screenshotPaths) await fs.access(file);

      const closeOutput = await runCli(['close'], 'stage20-playwright-close', 30_000);
      browserOpened = false;
      evidence.cliSteps.push({ label: 'close-session', status: 'exited', exitCode: 0, outputTail: closeOutput.slice(-4096), configPassedOnlyToOpen: true });
      const chromeDeadline = Date.now() + 15_000;
      while (processMatches(chrome.pid, chrome) && Date.now() < chromeDeadline) await new Promise(resolve => setTimeout(resolve, 100));
      evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
      assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `isolated Chrome PID ${chrome.pid} remains after close`);
      await recordProtectedSnapshot('after-browser-close');
      const socketHandles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
      assert.ok([0, 1].includes(socketHandles.status), `lsof socket alias check exited ${socketHandles.status}`);
      assert.equal(socketHandles.status === 0 && Boolean(socketHandles.stdout.trim()), false,
        `Playwright socket alias still has open handles: ${String(socketHandles.stdout || '').slice(0, 1000)}`);
      evidence.cleanupSteps = [{ action: 'lsof-playwright-socket-alias', command: `lsof -nP +D ${socketAlias}`,
        exitCode: socketHandles.status, matchingHandles: socketHandles.stdout.trim() ? 'present' : 'none' }];
      await fs.unlink(socketAlias);
      evidence.cleanupSteps.push({ action: 'remove-exact-playwright-socket-alias', path: socketAlias, status: 'removed' });
      socketAlias = null;
      await stopAndWait(session, browserOwner, 'stage20-browser-flow-complete');
      browserOwner = null;
      await stopAndWait(session, viteResource, 'stage20-browser-flow-complete');
      viteResource = null;
      await stopAndWait(session, modelResource, 'stage20-browser-flow-complete');
      modelResource = null;
      await recordProtectedSnapshot('after-browser-session-owner-exit');
      evidence.screenshotBytes = {};
      for (const file of screenshotPaths) evidence.screenshotBytes[path.basename(file)] = (await fs.stat(file)).size;
    }, 'haiyu-stage20-browser-', {
      LLM_BASE_URL: modelUrl, LLM_API_KEY: 'stage20-recorded-provider-key', LLM_MODEL: 'recorded-stage20',
      ASSISTANT_MODEL_SOURCE: 'recorded_fixture', NODE_ENV: 'test', Q20_ACCEPTANCE_HOOKS: '1', LLM_TIMEOUT_MS: '30000'
    }, { resourceSession: session });
  } catch (error) {
    if (error?.stageBlocked === true) { blocked = true; blockedReason = error.message; }
    else failure = error;
  } finally {
    if (session) {
      if (browserOpened && cliWorkDir && socketAlias) {
        try {
          const output = await runCli(['close'], 'stage20-playwright-failure-close', 30_000);
          evidence.cleanupSteps ||= [];
          evidence.cleanupSteps.push({ action: 'playwright-cli-close-after-failure', status: 'exited', exitCode: 0, outputTail: output.slice(-2000) });
          browserOpened = false;
        } catch (error) { cleanupFailure ||= `Playwright close after failure: ${error.message}`; }
      }
      for (const [resource, reason] of [[browserOwner, 'stage20-browser-owner-cleanup'],
        [viteResource, 'stage20-vite-cleanup'], [modelResource, 'stage20-model-cleanup']]) {
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
        sessionCloseResult = await session.close(failure || cleanupFailure || blocked ? 'stage20-browser-failure' : 'stage20-browser-complete');
        evidence.sessionCleanup = sessionCloseResult?.cleanupRecord || null;
        evidence.resourceTempDirRemoved = !await fs.stat(session.tempDir).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error));
      } catch (error) { cleanupFailure ||= `ResourceSession close: ${error.message}`; }
    }
    try { await recordProtectedSnapshot('after-ResourceSession-cleanup'); }
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
    console.log(`STAGE20_BROWSER_RESULT:${JSON.stringify(summary)}`);
    process.exitCode = 2;
    return;
  }
  if (failure || cleanupFailure) throw new Error(`Stage20 browser FAIL: ${failure?.message || cleanupFailure}`);
  const flow = evidence.browserFlow;
  const summary = { status: 'PASS', evidencePath, screenshots: screenshotPaths, widths: flow.widths.map(item => item.width),
    failureWidths: flow.failureWidths.map(item => item.width),
    coordinatorFailure: flow.coordinatorFailure,
    executionMode: flow.executionMode, parentRunId: flow.parentRunId, childRunIds: flow.childRunIds,
    agentIds: flow.agentIds, toolNames: flow.toolNames,
    candidateDecisions: flow.candidateDecisions.map(item => ({ candidateId: item.candidateId, status: item.status })),
    cacheNamesUnchanged: evidence.cacheNamesUnchanged, chrome: { pid: evidence.chrome.pid,
      exactIdentityExitedAfterCleanup: evidence.chrome.exactIdentityExitedAfterCleanup },
    resources: evidence.resources.map(item => ({ id: item.id, pid: item.pid, status: item.status })) };
  console.log(`STAGE20_BROWSER_RESULT:${JSON.stringify(summary)}`);
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = error?.stageBlocked ? 2 : 1;
});
