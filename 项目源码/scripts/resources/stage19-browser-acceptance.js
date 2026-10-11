import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTemporaryApi } from '../quests/helpers.js';
import { ResourceSession, processIdentity, processMatches } from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskId = process.env.CODEX_TASK_ID;
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'playwright-cli.config.json');
const screenshotDirectory = path.join(projectRoot, 'output/playwright/stage19-20261003');
const evidencePath = path.join(screenshotDirectory, 'stage19-browser-evidence.json');
const diagnosticScreenshotPath = path.join(screenshotDirectory,
  `assistant-flow-failure-debug-${new Date().toISOString().replaceAll(':', '-')}.png`);
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
  return { label, command: 'df -Pk /tmp', exitCode: result.status,
    filesystem: columns[0], usedKiB: Number(columns[2]), availableKiB: Number(columns[3]),
    mountedOn: columns.slice(5).join(' '), at: new Date().toISOString() };
}

async function cacheNames() {
  return (await fs.readdir(cacheParent)).filter(name => name.startsWith('code_sign_clone.')).sort();
}

function userChromeSnapshot() {
  const identity = processIdentity(userChromeBaseline.pid);
  const handles = runBounded('lsof', ['-nP', '-p', String(userChromeBaseline.pid), '-Fn'], 5000, 64 * 1024);
  assert.ok([0, 1].includes(handles.status), `lsof PID ${userChromeBaseline.pid} exited ${handles.status}`);
  const clonePaths = (handles.stdout || '').split(/\r?\n/)
    .filter(line => line.startsWith('n') && line.includes('code_sign_clone.'))
    .map(line => line.slice(1));
  return { identity, lsofCommand: `lsof -nP -p ${userChromeBaseline.pid} -Fn`,
    lsofExitCode: handles.status, clonePaths };
}

function assertUserChromeUnchanged(snapshot, label) {
  assert.ok(snapshot.identity, `${label}: user Chrome PID ${userChromeBaseline.pid} is unavailable`);
  assert.equal(snapshot.identity.pid, userChromeBaseline.pid);
  assert.equal(snapshot.identity.startTime.replace(/\s+/g, ' '), userChromeBaseline.startTime.replace(/\s+/g, ' '), `${label}: user Chrome start time changed`);
  assert.equal(snapshot.identity.fingerprint, userChromeBaseline.fingerprint, `${label}: user Chrome identity changed`);
  assert.ok(snapshot.clonePaths.some(file => file.includes('code_sign_clone.Ly34OH')),
    `${label}: expected retained user Chrome clone handle was not observed`);
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
  throw new Error(`timed out waiting for browser open marker`);
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
    assert.equal(result.status, 0, 'could not inspect process table for the isolated Chrome profile');
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
    if (matches.length > 1) throw new Error(`multiple Chrome main processes use the isolated profile: ${matches.map(x => x.pid).join(',')}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('could not identify Chrome main process for the isolated profile');
}

function assertChromeLaunch(chrome, profilePath, featureArg) {
  assert.notEqual(chrome.pid, userChromeBaseline.pid, 'browser acceptance must use an isolated Chrome process');
  assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Chrome command lacks the isolated profile');
  const featureArgs = chrome.command.match(/--disable-features=[^\s]+/g) || [];
  assert.equal(featureArgs.length, 1, 'Chrome command must contain exactly one --disable-features argument');
  assert.equal(featureArgs.at(-1), featureArg, 'effective Chrome --disable-features does not match the merged config');
  assert.ok(featureArgs.at(-1).split('=')[1].split(',').includes('MacAppCodeSignClone'),
    'effective Chrome feature list does not disable MacAppCodeSignClone');
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
  return {
    id: resource.id, label: resource.label, kind: resource.kind, role: resource.role,
    status: resource.status, pid: resource.pid, processGroup: resource.processGroup,
    processStartTime: resource.processStartTime, processFingerprint: resource.processFingerprint,
    command: resource.command, cwd: resource.cwd, tempDir: resource.tempDir, port: resource.port,
    logPath: resource.logPath, logBytes: resource.logBytes, maxLogBytes: resource.maxLogBytes,
    directoryPeakBytes: resource.directoryPeakBytes, maxDirectoryBytes: resource.maxDirectoryBytes,
    leaseExpiresAt: resource.leaseExpiresAt, pids: resource.pids
  };
}

async function main() {
  assert.ok(taskId, 'Stage19 browser acceptance requires CODEX_TASK_ID');
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const screenshots = {
    progress1440: path.join(screenshotDirectory, 'assistant-progress-1440x1000.png'),
    viewport1024: path.join(screenshotDirectory, 'assistant-1024x1000.png'),
    viewport1440: path.join(screenshotDirectory, 'assistant-1440x1000.png'),
    viewport1920: path.join(screenshotDirectory, 'assistant-1920x1000.png')
  };
  for (const file of [...Object.values(screenshots), evidencePath]) {
    try { await fs.access(file); throw new Error(`refusing to overwrite existing Stage19 browser artifact ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  const config = JSON.parse(await fs.readFile(playwrightConfigPath, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config must contain one merged --disable-features argument');
  const featureArg = featureArgs[0];
  assert.ok(featureArg.split('=')[1].split(',').includes('MacAppCodeSignClone'));

  const evidence = {
    schemaVersion: 1, title: 'Stage19 assistant browser acceptance', taskId,
    observedAt: new Date().toISOString(), status: 'RUNNING', worktree: projectRoot,
    browserConfigPath: playwrightConfigPath, browserConfigFeatureArg: featureArg,
    cacheParent, expectedCacheNames, cacheSnapshots: [], userChromeSnapshots: [],
    resources: [], cliSteps: [], screenshots, cleanupSteps: [],
    resourceLimits: { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 }
  };
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
  let sessionCloseResult;
  let lastSessionResources = [];

  function recordCache(label) {
    return cacheNames().then(names => {
      const item = { label, at: new Date().toISOString(), names };
      evidence.cacheSnapshots.push(item);
      if (JSON.stringify(names) !== JSON.stringify(expectedCacheNames)) {
        throw new Error(`${label}: Chrome code-sign clone cache names changed; preserved observed list ${JSON.stringify(names)}`);
      }
      return names;
    });
  }

  function recordUserChrome(label) {
    const snapshot = userChromeSnapshot();
    assertUserChromeUnchanged(snapshot, label);
    evidence.userChromeSnapshots.push({ label, at: new Date().toISOString(), ...snapshot });
    return snapshot;
  }

  async function runCli(args, label, timeoutMs = 60_000) {
    const resource = await session.startProcess({
      label, kind: 'browser', role: 'browser-cli', command: 'bash',
      args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfigPath] : []),
        '--session', sessionName, ...args], cwd: cliWorkDir,
      env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias }
    });
    let result = await session.waitProcess(resource.id, timeoutMs);
    const timedOut = Boolean(result.timedOut);
    if (timedOut) {
      await session.stop(resource.id, `${label}-timeout`);
      result = await session.waitProcess(resource.id, 15_000);
    }
    const log = await session.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    const item = {
      label, command: `bash ${playwrightWrapper} ${args[0] === 'open' ? `--config ${playwrightConfigPath} ` : ''}--session ${sessionName} ${args.join(' ')}`,
      resourceId: resource.id, pid: resource.pid, pgid: resource.pgid,
      processStartTime: resource.processStartTime, processFingerprint: resource.processFingerprint,
      logPath: resource.logPath, status: result.status, exitCode: result.exitCode ?? null,
      signal: result.signal || null, timedOut: timedOut || Boolean(result.timedOut),
      logBytes: result.logBytes, outputTail: String(log.tail || '').slice(-8192)
    };
    evidence.cliSteps.push(item);
    evidence.resources.push({ label, id: resource.id, kind: resource.kind, pid: resource.pid,
      processStartTime: resource.processStartTime, pgid: resource.pgid, logPath: resource.logPath });
    assert.equal(item.status, 'exited', `${label} status=${item.status}: ${item.outputTail.slice(-1200)}`);
    assert.equal(item.exitCode, 0, `${label} exit=${item.exitCode}: ${item.outputTail.slice(-1200)}`);
    assert.equal(item.signal, null, `${label} was signaled`);
    assert.equal(item.timedOut, false, `${label} timed out`);
    return item.outputTail;
  }

  try {
    evidence.dfBefore = dfSnapshot('before-browser');
    const userBefore = recordUserChrome('before-browser');
    evidence.userChromeBaselineObserved = {
      pid: userBefore.identity.pid, startTime: userBefore.identity.startTime,
      fingerprint: userBefore.identity.fingerprint, clonePaths: userBefore.clonePaths
    };
    await recordCache('before-browser-launch');

    session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
    evidence.resourceSessionId = session.instanceId;
    evidence.resourceTempDir = session.tempDir;
    evidence.resourceLimits = session.limits;
    sessionName = `stage19-${session.instanceId.slice(0, 8)}`;
    cliWorkDir = await session.allocateDir('browser-cli');
    const socketsDir = await session.allocateDir('playwright-sockets');
    socketAlias = path.join('/tmp', `pw-${session.instanceId.slice(0, 8)}`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright socket alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDir, socketAlias, 'dir');
    const profilePath = path.join(cliWorkDir, 'chrome-profile');
    openMarker = path.join(cliWorkDir, 'open-status.json');
    const ownerPath = path.join(cliWorkDir, 'browser-session-owner.mjs');
    const browserFlowPath = path.join(cliWorkDir, 'stage19-assistant-flow.mjs');
    await fs.writeFile(path.join(cliWorkDir, '.keep'), 'managed Stage19 Playwright profile and CLI output\n');
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
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  output = (output + chunk.toString()).slice(-4096); process.stdout.write(chunk);
});
child.once('error', error => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code: 1, error: error.message, output })); process.exitCode = 1; });
child.once('close', (code, signal) => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code, signal, output })); process.stdout.write('PLAYWRIGHT_OPEN_COMPLETE\\n'); if (code !== 0) process.exitCode = 1; });
setInterval(() => {}, 1000);
`);

    const modelPort = await availableLoopbackPort();
    const modelUrl = `http://127.0.0.1:${modelPort}/v1`;
    modelResource = await session.startProcess({ label: 'stage19-recorded-model-provider', kind: 'stub', role: 'model-provider',
      command: process.execPath, args: [path.join(projectRoot, 'scripts/resources/recorded-model-server.js')],
      cwd: projectRoot, port: modelPort, env: { PATH: process.env.PATH || '', PORT: String(modelPort) } });
    evidence.resources.push({ label: modelResource.label, id: modelResource.id, kind: modelResource.kind,
      pid: modelResource.pid, processStartTime: modelResource.processStartTime, pgid: modelResource.pgid,
      port: modelPort, logPath: modelResource.logPath });
    await waitForResourceHttp(`http://127.0.0.1:${modelPort}/health`, session, modelResource.id, 'recorded model fixture');

    await withTemporaryApi(async ({ baseUrl }) => {
      const apiOrigin = new URL(baseUrl).origin;
      evidence.apiOrigin = apiOrigin;
      const webPort = await availableLoopbackPort();
      webUrl = `http://127.0.0.1:${webPort}`;
      viteResource = await session.startProcess({ label: 'stage19-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort,
        env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1', API_PROXY_TARGET: apiOrigin, WEB_PORT: String(webPort) } });
      evidence.resources.push({ label: viteResource.label, id: viteResource.id, kind: viteResource.kind,
        pid: viteResource.pid, processStartTime: viteResource.processStartTime, pgid: viteResource.pgid,
        port: webPort, logPath: viteResource.logPath });
      assert.equal(viteResource.status, 'running', `Vite did not start: ${JSON.stringify(viteResource)}`);
      await waitForResourceHttp(webUrl, session, viteResource.id, 'Vite');

      browserOwner = await session.startProcess({ label: 'stage19-playwright-session-owner', kind: 'browser', role: 'browser-session-owner',
        command: process.execPath, args: [ownerPath], cwd: cliWorkDir,
        env: { PATH: process.env.PATH || '', PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfigPath,
          PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker,
          PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: webUrl } });
      evidence.resources.push({ label: browserOwner.label, id: browserOwner.id, kind: browserOwner.kind,
        pid: browserOwner.pid, processStartTime: browserOwner.processStartTime, pgid: browserOwner.pgid,
        logPath: browserOwner.logPath });
      assert.equal(browserOwner.status, 'running', `Playwright session owner did not start: ${JSON.stringify(browserOwner)}`);
      browserOpened = true;
      const openResult = await waitForFile(openMarker);
      evidence.cliSteps.push({ label: 'open', exitCode: openResult.code, signal: openResult.signal || null,
        status: openResult.code === 0 ? 'exited' : 'failed', configPassedOnlyToOpen: true,
        outputTail: String(openResult.output || '').slice(-4096) });
      assert.equal(openResult.code, 0, `Playwright open exited ${openResult.code}: ${String(openResult.output || '').slice(-1000)}`);
      assert.equal(openResult.signal, null, 'Playwright open was signaled');

      chrome = await findChromeForProfile(profilePath);
      const effectiveFeatureArgs = assertChromeLaunch(chrome, profilePath, featureArg);
      evidence.chrome = { pid: chrome.pid, startTime: chrome.startTime, processGroup: chrome.pgid,
        fingerprint: chrome.fingerprint, executable: chrome.executable, profilePath,
        effectiveDisableFeaturesArgs: effectiveFeatureArgs, effectiveDisableFeatures: effectiveFeatureArgs.at(-1) };
      recordUserChrome('during-browser-open');
      await recordCache('during-after-browser-open');

      const shots = Object.fromEntries(Object.entries(screenshots).map(([key, value]) => [key, value]));
      const browserFlow = String.raw`async page => {
const assert = {
  equal(actual, expected, message) { if (actual !== expected) throw new Error(message + ': expected ' + expected + ', got ' + actual); },
  ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); },
  includes(actual, expected, message) { if (!String(actual).includes(expected)) throw new Error(message + ': "' + actual + '" does not include "' + expected + '"'); }
};
const baseUrl = __BASE_URL__;
const shots = __SHOTS__;
const pageErrors = [];
const blockedOrigins = [];
const chatResponses = [];
const assistantApiResponses = [];
const assistantRunResponses = [];
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(20000);
page.on('pageerror', error => pageErrors.push(error.message));
page.on('response', response => {
  if (response.url().endsWith('/api/assistant/chat')) chatResponses.push(response.status());
  if (response.url().includes('/api/assistant/')) assistantApiResponses.push({
    method: response.request().method(), path: new URL(response.url()).pathname, status: response.status()
  });
  if (response.request().method() === 'GET' && /\/api\/assistant\/runs\/run_/.test(response.url())) {
    void response.json().then(data => assistantRunResponses.push({
      runId: data.runId, status: data.status, retryable: data.retryable,
      sourceCount: data.sources?.length || 0,
      sources: (data.sources || []).slice(0, 4).map(source => ({ type: source.type, id: source.id })),
      steps: (data.steps || []).map(step => ({ type: step.type, status: step.status, sourceCount: step.sources?.length || 0, errorCode: step.errorCode || null }))
    })).catch(() => {});
  }
});
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.protocol === 'data:' || url.protocol === 'blob:' || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
  blockedOrigins.push(url.origin);
  return route.abort();
});
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '我是客人 →', exact: true }).click();
await page.getByRole('button', { name: /进入工作区/ }).click();
await page.getByRole('button', { name: '打开智能助手', exact: true }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '打开智能助手', exact: true }).click();
const panel = page.getByRole('region', { name: '智能助手对话' });
await panel.waitFor({ state: 'visible' });
await panel.getByText('健康支持助手', { exact: true }).waitFor({ state: 'visible' });
const input = panel.getByLabel('输入给智能助手的内容');
const modeMessages = panel.locator('.assistant-message.assistant:has(.assistant-mode)');
async function submit(text, { waitForAnswer = true } = {}) {
  const previousModes = await modeMessages.count();
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' &&
    response.url().endsWith('/api/assistant/chat'));
  await input.fill(text);
  await panel.getByRole('button', { name: '发送消息', exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 202, 'chat is accepted asynchronously');
  const accepted = await response.json();
  assert.ok(accepted.runId && accepted.sessionId, '202 response includes stable runId and sessionId');
  if (waitForAnswer) {
    await page.waitForFunction(count => document.querySelectorAll('.assistant-window .assistant-message.assistant .assistant-mode').length > count,
      previousModes, { timeout: 30000 }).catch(async error => {
        const debug = await page.evaluate(() => ({
          messages: document.querySelector('.assistant-window .assistant-messages')?.innerText.slice(-4000) || '',
          storage: Object.fromEntries(Object.keys(sessionStorage).filter(key => key.startsWith('assistant-session:')).map(key => [key, sessionStorage.getItem(key)])),
          title: document.title
        }));
        await page.screenshot({ path: __DIAGNOSTIC_SCREENSHOT__ });
        throw new Error(JSON.stringify({ waitError: error.message, debug, assistantApiResponses, pageErrors }));
      });
  }
  return accepted;
}
async function savedRun() {
  return await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(item => item.startsWith('assistant-session:guest:'));
    return key ? { key, value: JSON.parse(sessionStorage.getItem(key) || 'null') } : null;
  });
}
let phase = 'first-chat';
try {
const first = await submit('Q19:PROJECT 请查找睡眠相关项目并显示查询来源。');
const firstSource = panel.locator('.assistant-sources').last();
await firstSource.waitFor({ state: 'visible' });
const sourceText = await firstSource.innerText();
assert.includes(sourceText, '查询来源', 'successful tool result is rendered as a source card');
const sourceIds = await firstSource.locator('small').allInnerTexts();
assert.ok(sourceIds.length > 0, 'source card exposes source IDs');
phase = 'restore-first-run';
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '打开智能助手', exact: true }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '打开智能助手', exact: true }).click();
await page.getByRole('region', { name: '智能助手对话' }).waitFor({ state: 'visible' });
await page.locator('.assistant-window .assistant-sources').first().waitFor({ state: 'visible', timeout: 15000 });
const restored = await savedRun();
assert.ok(restored?.value?.sessionId === first.sessionId && restored?.value?.runId === first.runId,
  'refresh restores the same session and completed run');

const historyRunIds = [first.runId];
phase = 'history-pagination';
for (let index = 1; index < 16; index += 1) {
  const accepted = await submit('浏览器历史验收第 ' + index + ' 条，只读查询。');
  historyRunIds.push(accepted.runId);
}
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '打开智能助手', exact: true }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '打开智能助手', exact: true }).click();
await page.getByRole('region', { name: '智能助手对话' }).waitFor({ state: 'visible' });
const loadEarlier = page.getByRole('button', { name: '加载更早消息', exact: true });
await loadEarlier.waitFor({ state: 'visible' });
const historyBefore = await panel.locator('.assistant-message').count();
assert.equal(historyBefore, 30, 'first restored history page contains the configured 30 messages');
await loadEarlier.click();
await page.waitForFunction(() => document.querySelectorAll('.assistant-window .assistant-message').length === 32, null, { timeout: 15000 });
const historyAfter = await panel.locator('.assistant-message').count();
assert.equal(historyAfter, 32, 'loading earlier history prepends the remaining messages');

phase = 'retry-after-provider-error';
await panel.getByRole('button', { name: '清空', exact: true }).click();
const retryStart = await submit('Q19:RETRY-BROWSER 请查睡眠项目；本轮会注入一次供应商故障。');
const retryButton = panel.getByRole('button', { name: '重试查询', exact: true });
await retryButton.waitFor({ state: 'visible', timeout: 30000 });
assert.equal(chatResponses.filter(code => code === 202).length, 17, 'all normal/history/failure chats use the async endpoint');
await retryButton.click();
await page.waitForFunction(() => {
  const panel = document.querySelector('.assistant-window');
  return panel && ![...panel.querySelectorAll('button')].some(button => button.textContent.trim() === '重试查询') &&
    panel.querySelector('.assistant-sources');
}, null, { timeout: 30000 });
const retrySaved = await savedRun();
assert.equal(retrySaved?.value?.runId, retryStart.runId, 'retry resumes the same runId');
const retrySources = await panel.locator('.assistant-sources small').allInnerTexts();
assert.ok(retrySources.length > 0, 'retry recovers a source card after the injected 503');

phase = 'slow-progress-and-refresh';
await panel.getByRole('button', { name: '清空', exact: true }).click();
const slowStart = await submit('Q19:SLOW 请查询项目目录并保持查询运行超过20秒。', { waitForAnswer: false });
await page.waitForFunction(() => document.querySelector('.assistant-window .typing')?.textContent.includes('仍在处理，刷新页面后也可继续查看进度…'), null, { timeout: 30000 });
await page.screenshot({ path: shots.progress1440, fullPage: false });
const pendingSaved = await savedRun();
assert.equal(pendingSaved?.value?.runId, slowStart.runId, 'in-progress runId is saved before refresh');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '打开智能助手', exact: true }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '打开智能助手', exact: true }).click();
await page.getByRole('region', { name: '智能助手对话' }).waitFor({ state: 'visible' });
await page.locator('.assistant-window .assistant-sources').waitFor({ state: 'visible', timeout: 30000 });
const slowRestored = await savedRun();
assert.equal(slowRestored?.value?.sessionId, slowStart.sessionId, 'refresh preserves the in-progress session');
assert.equal(slowRestored?.value?.runId, slowStart.runId, 'refresh resumes the same in-progress run');
const slowSources = await panel.locator('.assistant-sources small').allInnerTexts();
assert.ok(slowSources.length > 0, 'completed resumed run renders its tool source');

phase = 'responsive-layouts';
const layouts = [];
for (const width of [1024, 1440, 1920]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(100);
  const layout = await page.evaluate(() => ({
    viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
    assistantWidth: Math.round(document.querySelector('.assistant-window').getBoundingClientRect().width),
    assistantRight: Math.round(document.querySelector('.assistant-window').getBoundingClientRect().right)
  }));
  assert.ok(layout.documentWidth <= width, width + 'px page has no horizontal overflow: ' + JSON.stringify(layout));
  assert.ok(layout.assistantWidth <= 430 && layout.assistantRight <= width, width + 'px assistant fits in viewport: ' + JSON.stringify(layout));
  layouts.push({ width, ...layout, noHorizontalOverflow: true });
  await page.screenshot({ path: shots['viewport' + width], fullPage: false });
}
assert.equal(JSON.stringify(pageErrors), '[]', 'browser reports no page errors');
const externalOrigins = [...new Set(blockedOrigins)];
assert.ok(externalOrigins.every(origin => ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'].includes(origin)),
  'all non-local requests are blocked and only known font origins were attempted: ' + JSON.stringify(externalOrigins));
const stage19Result = { status: 'PASS', fixtureProvider: 'recorded-local-only',
  firstRunId: first.runId, firstSessionId: first.sessionId, sourceIds, historyRunIds,
  historyBefore, historyAfter, retryRunId: retryStart.runId, slowRunId: slowStart.runId,
  runIdRestoredAfterRefresh: true, retryAfterInjected503: true, progressAfter20Seconds: true,
  layouts, externalOrigins, chatResponses, screenshots: Object.values(shots) };
await page.evaluate(result => { document.title = 'STAGE19_BROWSER_RESULT:' + JSON.stringify(result); }, stage19Result);
} catch (error) {
  const debug = await page.evaluate(() => ({
    messages: document.querySelector('.assistant-window .assistant-messages')?.innerText.slice(-2200) || '',
    sourceCards: document.querySelectorAll('.assistant-window .assistant-sources').length,
    storage: Object.fromEntries(Object.keys(sessionStorage).filter(key => key.startsWith('assistant-session:')).map(key => [key, sessionStorage.getItem(key)])),
    title: document.title
  })).catch(e => ({ error: e.message }));
  await page.waitForTimeout(100);
  await page.screenshot({ path: __DIAGNOSTIC_SCREENSHOT__ }).catch(() => {});
  throw new Error(JSON.stringify({ phase, error: error.message, debug, assistantApiResponses: assistantApiResponses.slice(-12),
    assistantRunResponses: assistantRunResponses.slice(-8), pageErrors }));
}
}`;
      await fs.writeFile(browserFlowPath, browserFlow
        .replace('__BASE_URL__', JSON.stringify(webUrl))
        .replace('__SHOTS__', JSON.stringify(shots))
        .replaceAll('__DIAGNOSTIC_SCREENSHOT__', JSON.stringify(diagnosticScreenshotPath)));
      const flowOutput = await runCli(['run-code', '--filename', browserFlowPath], 'stage19-playwright-assistant-flow', 240_000);
      const resultMatch = flowOutput.match(/STAGE19_BROWSER_RESULT:(\{[^\r\n]*\})/);
      assert.ok(resultMatch, `browser flow omitted structured result: ${flowOutput.slice(-2000)}`);
      evidence.browserFlow = JSON.parse(resultMatch[1]);
      evidence.browserFlowOutputBytes = Buffer.byteLength(flowOutput);
      await recordCache('during-after-chat-history-retry-and-refresh-flow');
      recordUserChrome('during-after-browser-flow');
      for (const file of Object.values(screenshots)) await fs.access(file);

      const closeOutput = await runCli(['close'], 'stage19-playwright-close', 30_000);
      browserOpened = false;
      evidence.cliSteps.push({ label: 'close-session', status: 'exited', exitCode: 0,
        outputTail: closeOutput.slice(-4096), configPassedOnlyToOpen: true });
      const chromeDeadline = Date.now() + 15_000;
      while (processMatches(chrome.pid, chrome) && Date.now() < chromeDeadline) await new Promise(resolve => setTimeout(resolve, 100));
      evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
      assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `Chrome PID ${chrome.pid} remains after CLI close`);
      await recordCache('after-browser-close');
      recordUserChrome('after-browser-close');
      const socketHandles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
      assert.ok([0, 1].includes(socketHandles.status), `lsof socket alias check exited ${socketHandles.status}`);
      assert.equal(socketHandles.status === 0 && Boolean(socketHandles.stdout.trim()), false,
        `Playwright socket alias still has open handles: ${String(socketHandles.stdout || '').slice(0, 1000)}`);
      evidence.cleanupSteps.push({ action: 'lsof-playwright-socket-alias', command: `lsof -nP +D ${socketAlias}`,
        exitCode: socketHandles.status, matchingHandles: socketHandles.stdout.trim() ? 'present' : 'none' });
      await fs.unlink(socketAlias);
      evidence.cleanupSteps.push({ action: 'remove-exact-playwright-socket-alias', path: socketAlias, status: 'removed' });
      socketAlias = null;
      await stopAndWait(session, browserOwner, 'stage19-browser-flow-complete');
      await stopAndWait(session, viteResource, 'stage19-browser-flow-complete');
      await stopAndWait(session, modelResource, 'stage19-browser-flow-complete');
      recordUserChrome('after-browser-session-owner-exit');
      await recordCache('after-browser-session-owner-exit');
      evidence.screenshotBytes = {};
      for (const [key, file] of Object.entries(screenshots)) evidence.screenshotBytes[key] = (await fs.stat(file)).size;
    }, 'haiyu-stage19-browser-', {
      LLM_BASE_URL: modelUrl,
      LLM_API_KEY: 'stage19-recorded-provider-key', LLM_MODEL: 'recorded-stage19', LLM_TIMEOUT_MS: '30000'
    }, { resourceSession: session });
  } catch (error) {
    failure = error;
  } finally {
    if (session) {
      if (browserOpened && cliWorkDir && socketAlias) {
        try {
          const output = await runCli(['close'], 'stage19-playwright-failure-close', 30_000);
          evidence.cleanupSteps.push({ action: 'playwright-cli-close-after-failure', status: 'exited', exitCode: 0,
            outputTail: output.slice(-2000) });
          browserOpened = false;
        } catch (error) { cleanupFailure ||= `Playwright close after failure: ${error.message}`; }
      }
      for (const [resource, reason] of [[browserOwner, 'stage19-browser-owner-cleanup'],
        [viteResource, 'stage19-vite-cleanup'], [modelResource, 'stage19-model-cleanup']]) {
        try {
          if (resource) {
            const exited = await stopAndWait(session, resource, reason);
            evidence.cleanupSteps.push({ action: 'stop-managed-resource', label: resource.label,
              pid: resource.pid, status: exited.status, exitCode: exited.exitCode ?? null, signal: exited.signal || null });
          }
        } catch (error) { cleanupFailure ||= `${resource?.label || 'resource'} cleanup: ${error.message}`; }
      }
      if (socketAlias) {
        try {
          const handles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
          if (![0, 1].includes(handles.status)) throw new Error(`lsof exited ${handles.status}`);
          if (handles.status === 0 && handles.stdout.trim()) throw new Error(`handles remain: ${handles.stdout.slice(0, 1000)}`);
          await fs.unlink(socketAlias).catch(error => { if (error.code !== 'ENOENT') throw error; });
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
        sessionCloseResult = await session.close(failure || cleanupFailure ? 'stage19-browser-failure' : 'stage19-browser-complete');
        evidence.sessionCleanup = sessionCloseResult?.cleanupRecord || null;
        evidence.resourceTempDirRemoved = !await fs.stat(session.tempDir).then(() => true).catch(error => error.code === 'ENOENT' ? false : Promise.reject(error));
      } catch (error) { cleanupFailure ||= `ResourceSession close: ${error.message}`; }
    }

    try { await recordCache('after-ResourceSession-cleanup'); }
    catch (error) { cleanupFailure ||= error.message; }
    try { recordUserChrome('after-ResourceSession-cleanup'); }
    catch (error) { cleanupFailure ||= error.message; }
    try { evidence.dfAfter = dfSnapshot('after-browser-cleanup'); }
    catch (error) { cleanupFailure ||= error.message; }
    if (chrome) {
      evidence.chrome = { ...(evidence.chrome || {}), exactIdentityExitedAfterCleanup: !processMatches(chrome.pid, chrome) };
      if (processMatches(chrome.pid, chrome)) cleanupFailure ||= `isolated Chrome PID ${chrome.pid} survived cleanup`;
    }
    evidence.resources = lastSessionResources.length ? lastSessionResources : evidence.resources;
    evidence.status = failure || cleanupFailure ? 'FAIL' : 'PASS';
    evidence.completedAt = new Date().toISOString();
    evidence.failure = failure ? String(failure.stack || failure).slice(0, 6000) : null;
    evidence.cleanupFailure = cleanupFailure;
    evidence.cacheNamesUnchanged = evidence.cacheSnapshots.length >= 2 && evidence.cacheSnapshots.every(snapshot =>
      JSON.stringify(snapshot.names) === JSON.stringify(expectedCacheNames));
    if (screenshotDirectory) {
      try { await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' }); }
      catch (error) {
        if (!failure) failure = error;
        evidence.status = 'FAIL';
        evidence.failure = `could not write browser evidence: ${error.message}`;
      }
    }
  }
  if (failure || cleanupFailure) throw new Error(`Stage19 browser ${evidence.status}: ${failure?.message || cleanupFailure}`);
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
