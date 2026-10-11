import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity, processMatches, ResourceSession } from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskId = process.env.CODEX_TASK_ID;
const expectedTaskId = '01a0fa2e-fa14-72e2-80e3-c7f24b4991f1';
const wrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const configPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'playwright-cli.config.json');
const auditPath = path.join(projectRoot, 'output/resource-audit/stage18-browser-cache-remediation-20261002.json');
const appendixPath = path.join(projectRoot, 'output/resource-audit/stage18-browser-cache-probe-evidence-20261002.json');
const userChromeBaseline = {
  pid: 7081,
  startTime: 'Thu Oct  1 17:27:01 2026',
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
  return {
    label, command: 'df -Pk /tmp', exitCode: result.status,
    filesystem: columns[0], usedKiB: Number(columns[2]), availableKiB: Number(columns[3]),
    mountedOn: columns.slice(5).join(' '), at: new Date().toISOString()
  };
}

function cacheNames(cacheParent) {
  return fs.readdir(cacheParent).then(names => names.filter(name => name.startsWith('code_sign_clone.')).sort());
}

function userChromeSnapshot() {
  const identity = processIdentity(userChromeBaseline.pid);
  const handles = runBounded('lsof', ['-nP', '-p', String(userChromeBaseline.pid), '-Fn'], 5000, 64 * 1024);
  assert.ok([0, 1].includes(handles.status), `lsof PID ${userChromeBaseline.pid} exited ${handles.status}`);
  const paths = (handles.stdout || '').split(/\r?\n/)
    .filter(line => line.startsWith('n') && line.includes('code_sign_clone.'))
    .map(line => line.slice(1));
  return {
    identity,
    lsof: { command: `lsof -nP -p ${userChromeBaseline.pid} -Fn`, exitCode: handles.status, clonePaths: paths }
  };
}

function assertUserChromeUnchanged(snapshot, label) {
  assert.ok(snapshot.identity, `${label}: user Chrome PID ${userChromeBaseline.pid} is unavailable`);
  assert.equal(snapshot.identity.pid, userChromeBaseline.pid);
  assert.equal(snapshot.identity.startTime, userChromeBaseline.startTime, `${label}: PID 7081 start time changed`);
  assert.equal(snapshot.identity.fingerprint, userChromeBaseline.fingerprint, `${label}: PID 7081 identity changed`);
  assert.ok(snapshot.lsof.clonePaths.some(file => file.includes('code_sign_clone.Ly34OH')),
    `${label}: expected retained PID 7081 clone handle was not observed`);
}

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('no loopback port')));
    });
  });
}

async function waitForHttp(url, session, resourceId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    const state = (await session.status()).resources?.find(item => item.id === resourceId);
    if (!state || !['starting', 'running'].includes(state.status)) {
      throw new Error(`local page server ended early: ${state?.status || 'missing'}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const text = await response.text();
        assert.ok(text.includes('<title>stage18-local-browser-resource-probe</title>'));
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`local page server readiness timed out: ${lastError}`);
}

async function waitForFile(filePath, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for Playwright open marker`);
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
    assert.equal(result.status, 0, 'could not inspect process table for the new Chrome profile');
    const matches = result.stdout.split(/\r?\n/).flatMap(line => {
      const item = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!item || !item[2].includes(`--user-data-dir=${profilePath}`)) return [];
      if (!item[2].includes('/Google Chrome.app/Contents/MacOS/Google Chrome')) return [];
      if (item[2].includes('/Helpers/')) return [];
      return [{ pid: Number(item[1]), command: item[2] }];
    });
    if (matches.length === 1) {
      const identity = processIdentity(matches[0].pid);
      assert.ok(identity, `Chrome PID ${matches[0].pid} disappeared during identity capture`);
      const command = chromeCommandLine(matches[0].pid);
      return { ...identity, command };
    }
    if (matches.length > 1) throw new Error(`multiple Chrome main processes use the isolated profile: ${matches.map(x => x.pid).join(',')}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('could not identify Chrome main process for the isolated profile');
}

function assertChromeLaunch(chrome, profilePath, mergedFeatureArg) {
  assert.notEqual(chrome.pid, userChromeBaseline.pid, 'isolated probe must not reuse user Chrome PID 7081');
  assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Chrome command lacks the isolated profile');
  const disableFeatureArgs = chrome.command.match(/--disable-features=[^\s]+/g) || [];
  assert.ok(disableFeatureArgs.length >= 1, 'Chrome command has no --disable-features switch');
  assert.equal(disableFeatureArgs.at(-1), mergedFeatureArg,
    'the final effective --disable-features switch must match the merged config');
  assert.ok(disableFeatureArgs.at(-1).split('=')[1].split(',').includes('MacAppCodeSignClone'),
    'the final effective Chrome feature list does not disable MacAppCodeSignClone');
  return { disableFeatureArgs, effectiveFeatureArg: disableFeatureArgs.at(-1) };
}

async function main() {
  assert.equal(taskId, expectedTaskId, 'CODEX_TASK_ID must be the corrected Stage18 task ID');
  const audit = JSON.parse(await fs.readFile(auditPath, 'utf8'));
  const cacheParent = audit.historicalStage18Browsers.parentCacheInventoryBefore.path;
  const expectedNames = [...audit.browserProbe.cacheSnapshots.before.names].sort();
  assert.equal(expectedNames.length, 11, 'the recorded preserved cache baseline must contain 11 entries');
  assert.deepEqual(expectedNames, [...audit.browserProbe.cacheSnapshots.after.names].sort(),
    'historical pre-probe cache baseline differs from the recorded post-cleanup state');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config must contain exactly one merged --disable-features argument');
  const mergedFeatureArg = featureArgs[0];
  assert.ok(mergedFeatureArg.split('=')[1].split(',').includes('MacAppCodeSignClone'));

  const evidence = {
    schemaVersion: 1,
    title: 'Stage18 corrected short browser cache probe',
    taskId, observedAt: new Date().toISOString(), status: 'RUNNING',
    worktree: projectRoot,
    cacheParent,
    expectedCacheNames: expectedNames,
    configPath,
    configFeatureArg: mergedFeatureArg,
    playwrightWrapper: wrapper,
    cliSteps: [],
    resources: [],
    cleanup: { steps: [], status: 'RUNNING' }
  };
  let session;
  let server;
  let browserOwner;
  let cliWorkDir;
  let socketAlias;
  let openMarker;
  let serverUrl;
  let chrome;
  let chromeEffectiveFlags;
  let browserOpenStarted = false;
  let closeAttempted = false;
  let primaryError = null;
  let cleanupErrors = [];

  try {
    evidence.dfBefore = dfSnapshot('before-browser-probe');
    evidence.userChromeBefore = userChromeSnapshot();
    assertUserChromeUnchanged(evidence.userChromeBefore, 'before probe');
    evidence.cacheSnapshots = [];
    const beforeNames = await cacheNames(cacheParent);
    evidence.cacheSnapshots.push({ label: 'before-browser-launch', at: new Date().toISOString(), names: beforeNames });
    assert.deepEqual(beforeNames, expectedNames, 'cache list changed before the corrected browser probe');

    session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
    evidence.resourceSessionId = session.instanceId;
    evidence.resourceTempDir = session.tempDir;
    evidence.resourceLimits = session.limits;
    const sessionName = `stage18-cache-probe-${session.instanceId.slice(0, 8)}`;
    const workDir = await session.allocateDir('browser-cli');
    cliWorkDir = workDir;
    const socketsDir = await session.allocateDir('playwright-sockets');
    socketAlias = path.join('/tmp', `pw-${session.instanceId.slice(0, 8)}`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing socket alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDir, socketAlias, 'dir');
    const profilePath = path.join(workDir, 'chrome-profile');
    openMarker = path.join(workDir, 'open-status.json');
    const runCodePath = path.join(workDir, 'local-page-probe.js');
    const serverPath = path.join(workDir, 'local-page-server.mjs');
    const ownerPath = path.join(workDir, 'browser-session-owner.mjs');
    await fs.writeFile(path.join(workDir, '.keep'), 'isolated Stage18 browser profile\n');
    await fs.writeFile(serverPath, `
import http from 'node:http';
const html = '<!doctype html><html><head><title>stage18-local-browser-resource-probe</title></head><body><main id="probe">local-only</main></body></html>';
const server = http.createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' });
  response.end(html);
});
server.listen(Number(process.env.PROBE_PORT), '127.0.0.1', () => process.stdout.write('LOCAL_PAGE_READY\\n'));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
setInterval(() => {}, 1000);
`);
    await fs.writeFile(ownerPath, `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const child = spawn('bash', [process.env.PLAYWRIGHT_WRAPPER, '--config', process.env.PLAYWRIGHT_CONFIG,
  '--session', process.env.PLAYWRIGHT_SESSION, 'open', process.env.PLAYWRIGHT_URL,
  '--profile', process.env.PLAYWRIGHT_PROFILE, '--idle-timeout', '0'], {
  cwd: process.cwd(), env: {
    PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
    PWTEST_SOCKETS_DIR: process.env.PLAYWRIGHT_SOCKETS_DIR,
    TMPDIR: process.env.PLAYWRIGHT_SOCKETS_DIR, TMP: process.env.PLAYWRIGHT_SOCKETS_DIR,
    TEMP: process.env.PLAYWRIGHT_SOCKETS_DIR
  }, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
  output = (output + chunk.toString()).slice(-4096);
  process.stdout.write(chunk);
});
child.once('error', error => {
  fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code: 1, error: error.message, output }));
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code, signal, output }));
  process.stdout.write('PLAYWRIGHT_OPEN_COMPLETE\\n');
  if (code !== 0) process.exitCode = 1;
});
setInterval(() => {}, 1000);
`);

    const port = await availableLoopbackPort();
    serverUrl = `http://127.0.0.1:${port}/probe`;
    server = await session.startProcess({
      label: 'stage18-cache-probe-local-page-server', kind: 'api', role: 'test-page-server',
      command: process.execPath, args: [serverPath], cwd: workDir, port,
      env: { PATH: process.env.PATH || '', PROBE_PORT: String(port) }
    });
    evidence.resources.push({ label: 'local-page-server', id: server.id, pid: server.pid, pgid: server.pgid,
      startTime: server.processStartTime, fingerprint: server.processFingerprint, port: server.port, logPath: server.logPath });
    await waitForHttp(serverUrl, session, server.id);

    browserOwner = await session.startProcess({
      label: 'stage18-cache-probe-browser-session-owner', kind: 'browser', role: 'browser-session-owner',
      command: process.execPath, args: [ownerPath], cwd: workDir,
      env: {
        PATH: process.env.PATH || '', PLAYWRIGHT_WRAPPER: wrapper, PLAYWRIGHT_CONFIG: configPath,
        PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker,
        PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: serverUrl
      }
    });
    evidence.resources.push({ label: 'browser-session-owner', id: browserOwner.id, pid: browserOwner.pid,
      pgid: browserOwner.pgid, startTime: browserOwner.processStartTime, fingerprint: browserOwner.processFingerprint,
      logPath: browserOwner.logPath });
    browserOpenStarted = true;
    const openResult = await waitForFile(openMarker);
    evidence.cliSteps.push({
      label: 'open', command: `bash ${wrapper} --config ${configPath} --session ${sessionName} open ${serverUrl} --profile ${profilePath} --idle-timeout 0`,
      exitCode: openResult.code, signal: openResult.signal || null, status: openResult.code === 0 ? 'exited' : 'failed',
      configPassedOnlyToOpen: true, outputTail: String(openResult.output || '').slice(-4096)
    });
    assert.equal(openResult.code, 0, `Playwright open exited ${openResult.code}: ${String(openResult.output || '').slice(-1000)}`);
    assert.equal(openResult.signal, null, 'Playwright open was signaled');

    chrome = await findChromeForProfile(profilePath);
    chromeEffectiveFlags = assertChromeLaunch(chrome, profilePath, mergedFeatureArg);
    evidence.chrome = {
      pid: chrome.pid, startTime: chrome.startTime, pgid: chrome.pgid, uid: chrome.uid,
      fingerprint: chrome.fingerprint, executable: chrome.executable, command: chrome.command,
      launchFlags: chromeEffectiveFlags.disableFeatureArgs,
      effectiveDisableFeatures: chromeEffectiveFlags.effectiveFeatureArg,
      isolatedProfile: profilePath
    };
    assert.notEqual(chrome.pid, userChromeBaseline.pid);

    const duringOpen = await cacheNames(cacheParent);
    evidence.cacheSnapshots.push({ label: 'during-after-browser-open', at: new Date().toISOString(), names: duringOpen });
    assert.deepEqual(duringOpen, expectedNames, 'Chrome cache list changed during open');

    await fs.writeFile(runCodePath, `async page => {
  const title = await page.title();
  const text = await page.locator('#probe').innerText();
  if (title !== 'stage18-local-browser-resource-probe') throw new Error('unexpected title: ' + title);
  if (text !== 'local-only') throw new Error('unexpected #probe text: ' + text);
  return { status: 'PASS', title, text, url: page.url() };
}\n`);

    async function runCli(args, label, timeoutMs = 30_000) {
      const resource = await session.startProcess({
        label, kind: 'browser', role: 'browser-cli', command: 'bash',
        args: [wrapper, '--session', sessionName, ...args], cwd: cliWorkDir,
        env: {
          PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
          PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias
        }
      });
      const first = await session.waitProcess(resource.id, timeoutMs);
      let final = first;
      const timedOut = Boolean(first.timedOut);
      if (timedOut) {
        await session.stop(resource.id, `${label}-timeout`);
        final = await session.waitProcess(resource.id, 15_000);
      }
      const log = await session.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
      const item = {
        label: args[0], command: `bash ${wrapper} --session ${sessionName} ${args.join(' ')}`,
        resourceId: resource.id, pid: resource.pid, startTime: resource.processStartTime,
        fingerprint: resource.processFingerprint, pgid: resource.pgid, logPath: resource.logPath,
        logBytes: final.logBytes, exitCode: final.exitCode ?? null, signal: final.signal || null,
        status: final.status, timedOut: timedOut || Boolean(final.timedOut), outputTail: String(log.tail || '').slice(-8192)
      };
      evidence.cliSteps.push(item);
      evidence.resources.push({ label, id: resource.id, pid: resource.pid, pgid: resource.pgid,
        startTime: resource.processStartTime, fingerprint: resource.processFingerprint, logPath: resource.logPath });
      assert.equal(item.status, 'exited', `${label} status=${item.status}: ${item.outputTail.slice(-1000)}`);
      assert.equal(item.exitCode, 0, `${label} exit=${item.exitCode}: ${item.outputTail.slice(-1000)}`);
      assert.equal(item.timedOut, false, `${label} timed out`);
      assert.equal(item.signal, null, `${label} was signaled`);
      return item;
    }

    evidence.assertion = await runCli(['run-code', '--filename', runCodePath], 'stage18-cache-probe-run-code');
    evidence.pageAssertion = {
      expectedTitle: 'stage18-local-browser-resource-probe', expectedSelector: '#probe', expectedText: 'local-only',
      executed: true, cliOutputTail: evidence.assertion.outputTail
    };
    const duringAssertion = await cacheNames(cacheParent);
    evidence.cacheSnapshots.push({ label: 'during-after-title-and-dom-assertion', at: new Date().toISOString(), names: duringAssertion });
    assert.deepEqual(duringAssertion, expectedNames, 'Chrome cache list changed while the page assertion ran');

    closeAttempted = true;
    const closeStep = await runCli(['close'], 'stage18-cache-probe-close');
    evidence.browserClose = { attempted: true, exitCode: closeStep.exitCode, status: closeStep.status };
    browserOpenStarted = false;
    const closedChrome = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15_000;
      const poll = () => {
        if (!processMatches(chrome.pid, chrome)) return resolve(true);
        if (Date.now() >= deadline) return reject(new Error(`Chrome PID ${chrome.pid} did not exit after close`));
        setTimeout(poll, 100);
      };
      poll();
    });
    evidence.chrome.exactIdentityExitedAfterClose = closedChrome;
    const afterClose = await cacheNames(cacheParent);
    evidence.cacheSnapshots.push({ label: 'after-browser-close', at: new Date().toISOString(), names: afterClose });
    assert.deepEqual(afterClose, expectedNames, 'Chrome cache list changed after close');
    evidence.cacheNamesUnchanged = evidence.cacheSnapshots.every(snapshot =>
      JSON.stringify(snapshot.names) === JSON.stringify(expectedNames));
    assert.equal(evidence.cacheNamesUnchanged, true);
  } catch (error) {
    primaryError = error;
  } finally {
    if (session && browserOpenStarted && !closeAttempted && cliWorkDir && socketAlias) {
      closeAttempted = true;
      try {
        const status = await session.status();
        const ownerState = status.resources?.find(item => item.id === browserOwner?.id)?.status;
        if (['starting', 'running'].includes(ownerState)) {
          const name = `stage18-cache-probe-${session.instanceId.slice(0, 8)}`;
          const closeResource = await session.startProcess({
            label: 'stage18-cache-probe-close-cleanup', kind: 'browser', role: 'browser-cli', command: 'bash',
            args: [wrapper, '--session', name, 'close'], cwd: cliWorkDir,
            env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
              PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias }
          });
          const result = await session.waitProcess(closeResource.id, 20_000);
          if (result.timedOut) await session.stop(closeResource.id, 'close-cleanup-timeout');
          evidence.cliSteps.push({ label: 'close-cleanup', resourceId: closeResource.id, pid: closeResource.pid,
            startTime: closeResource.processStartTime, logPath: closeResource.logPath,
            status: result.status, exitCode: result.exitCode ?? null, timedOut: Boolean(result.timedOut) });
          evidence.cleanup.steps.push({ action: 'playwright-cli-close', status: result.status,
            exitCode: result.exitCode ?? null, timedOut: Boolean(result.timedOut) });
        } else evidence.cleanup.steps.push({ action: 'playwright-cli-close', status: 'session-owner-not-running', exitCode: null });
      } catch (error) {
        cleanupErrors.push(`Playwright close cleanup: ${error.message}`);
        evidence.cleanup.steps.push({ action: 'playwright-cli-close', error: error.message.slice(0, 1000) });
      }
    }

    if (session && browserOwner) {
      try {
        const state = (await session.status()).resources?.find(item => item.id === browserOwner.id)?.status;
        if (['starting', 'running'].includes(state)) await session.stop(browserOwner.id, 'browser-probe-finished');
        const result = await session.waitProcess(browserOwner.id, 15_000);
        if (result.timedOut) throw new Error(`browser owner PID ${browserOwner.pid} timed out while exiting`);
        evidence.cleanup.steps.push({ action: 'stop-browser-session-owner', pid: browserOwner.pid,
          status: result.status, exitCode: result.exitCode ?? null, timedOut: false });
      } catch (error) { cleanupErrors.push(`browser owner cleanup: ${error.message}`); }
    }

    if (session && chrome) {
      const deadline = Date.now() + 15_000;
      while (processMatches(chrome.pid, chrome) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      evidence.chrome = { ...(evidence.chrome || {}), exactIdentityExitedAfterCleanup:
        !processMatches(chrome.pid, chrome) };
      if (processMatches(chrome.pid, chrome)) cleanupErrors.push(`Chrome PID ${chrome.pid} remains after close cleanup`);
    }

    if (session && server) {
      try {
        const state = (await session.status()).resources?.find(item => item.id === server.id)?.status;
        if (['starting', 'running'].includes(state)) await session.stop(server.id, 'browser-client-stopped');
        const result = await session.waitProcess(server.id, 15_000);
        if (result.timedOut) throw new Error(`page server PID ${server.pid} timed out while exiting`);
        evidence.cleanup.steps.push({ action: 'stop-local-page-server', pid: server.pid,
          port: server.port, status: result.status, exitCode: result.exitCode ?? null, timedOut: false });
      } catch (error) { cleanupErrors.push(`page server cleanup: ${error.message}`); }
    }

    if (socketAlias) {
      try {
        const handles = runBounded('lsof', ['+D', socketAlias], 5000, 64 * 1024);
        evidence.cleanup.socketAliasHandleCheck = { command: `lsof +D ${socketAlias}`, exitCode: handles.status,
          matchingOutputBytes: Buffer.byteLength(handles.stdout || '') };
        if (![0, 1].includes(handles.status)) throw new Error(`lsof alias check exited ${handles.status}`);
        if (handles.status === 0 && handles.stdout.trim()) throw new Error(`open handle remains under socket alias: ${handles.stdout.slice(0, 1000)}`);
        await fs.unlink(socketAlias).catch(error => { if (error.code !== 'ENOENT') throw error; });
        evidence.cleanup.steps.push({ action: 'remove-socket-alias-after-handle-check', path: socketAlias, status: 'removed' });
      } catch (error) { cleanupErrors.push(`socket alias cleanup: ${error.message}`); }
    }

    if (session) {
      try {
        const closed = await session.close(primaryError ? 'browser-probe-failed' : 'browser-probe-complete');
        evidence.cleanup.resourceSession = {
          status: closed.status, cleanupRecord: closed.cleanupRecord,
          tempDir: session.tempDir, tempDirRemoved: !await fs.access(session.tempDir).then(() => true).catch(() => false)
        };
        evidence.cleanup.steps.push({ action: 'resource-session-close', status: closed.status,
          exitCode: 0, tempDirRemoved: evidence.cleanup.resourceSession.tempDirRemoved });
      } catch (error) {
        cleanupErrors.push(`ResourceSession cleanup: ${error.message}`);
        evidence.cleanup.resourceSession = { status: 'failed', tempDir: session.tempDir,
          tempDirRemoved: !await fs.access(session.tempDir).then(() => true).catch(() => false), error: error.message.slice(0, 2000) };
      }
    }
  }

  try {
    evidence.cacheSnapshots ||= [];
    const finalNames = await cacheNames(audit.historicalStage18Browsers.parentCacheInventoryBefore.path);
    evidence.cacheSnapshots.push({ label: 'after-resource-session-cleanup', at: new Date().toISOString(), names: finalNames });
    evidence.cacheNamesUnchanged = evidence.cacheSnapshots.every(snapshot =>
      JSON.stringify(snapshot.names) === JSON.stringify(expectedNames));
    evidence.userChromeAfter = userChromeSnapshot();
    assertUserChromeUnchanged(evidence.userChromeAfter, 'after probe');
    evidence.dfAfter = dfSnapshot('after-browser-and-resource-cleanup');
  } catch (error) { cleanupErrors.push(`post-cleanup observation: ${error.message}`); }

  evidence.cleanup.errors = cleanupErrors;
  evidence.cleanup.status = cleanupErrors.length === 0 && evidence.cleanup.resourceSession?.status === 'cleaned' ? 'PASS' : 'FAIL';
  evidence.status = primaryError || cleanupErrors.length || evidence.cleanup.status !== 'PASS' ||
    evidence.cacheNamesUnchanged !== true ? 'FAIL' : 'PASS';
  if (primaryError) evidence.failure = String(primaryError.stack || primaryError).slice(0, 3000);
  evidence.finishedAt = new Date().toISOString();
  if (evidence.dfBefore && evidence.dfAfter) {
    evidence.dfDeltaKiB = {
      used: evidence.dfAfter.usedKiB - evidence.dfBefore.usedKiB,
      available: evidence.dfAfter.availableKiB - evidence.dfBefore.availableKiB
    };
  }
  await fs.mkdir(path.dirname(appendixPath), { recursive: true });
  await fs.writeFile(appendixPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`STAGE18_BROWSER_CACHE_PROBE ${JSON.stringify(evidence)}\n`);
  if (evidence.status !== 'PASS') process.exitCode = 1;
}

main().catch(error => {
  process.stderr.write(`STAGE18_BROWSER_CACHE_PROBE_FATAL ${String(error.stack || error).slice(0, 3000)}\n`);
  process.exitCode = 1;
});
