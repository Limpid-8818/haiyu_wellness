import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTemporaryApi } from '../quests/helpers.js';
import { ResourceSession } from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskId = process.env.CODEX_TASK_ID;
const businessNow = '2026-10-01T10:00:00.000Z';
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'playwright-cli.config.json');
const screenshotDirectory = path.resolve(projectRoot, 'output/playwright/stage18-20261002-sol-review-retry05');
const evidencePath = path.join(screenshotDirectory, 'stage18-sol-review-evidence.json');
const screenshots = {
  bodyScan: path.join(screenshotDirectory, 'q18-5-body-scan-play-pause-seek.png'),
  oceanPlaying: path.join(screenshotDirectory, 'q18-6-ocean-chat-route-playing.png'),
  oceanPaused: path.join(screenshotDirectory, 'q18-6-ocean-chat-route-paused.png')
};

function assertExited(result, label) {
  assert.equal(result.status, 'exited', label + ' status=' + result.status + ': ' + (result.tail || ''));
  assert.equal(result.exitCode, 0, label + ' exit=' + result.exitCode + ': ' + (result.tail || ''));
  assert.equal(result.timedOut, false, label + ' timed out: ' + (result.tail || ''));
}

async function availableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('could not allocate loopback port')));
    });
  });
}

async function waitForHttp(url, session, resourceId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    const status = await session.status();
    const resource = status.resources?.find(item => item.id === resourceId);
    if (!resource || !['starting', 'running'].includes(resource.status)) {
      const log = await session.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error('Vite exited before readiness: ' + (resource?.status || 'missing') + ' ' + (log.tail || ''));
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = 'HTTP ' + response.status;
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const log = await session.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
  throw new Error('Vite readiness timed out: ' + lastError + '; ' + (log.tail || ''));
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await fs.readFile(filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Playwright open did not finish within ' + timeoutMs + 'ms');
}

async function main() {
  assert.ok(taskId, 'Stage18 review supplement requires CODEX_TASK_ID');
  await fs.access(path.dirname(screenshotDirectory)).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  try { await fs.access(screenshotDirectory); throw new Error('refusing to reuse supplement directory ' + screenshotDirectory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.mkdir(screenshotDirectory, { recursive: true });

  const session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
  let outcome = 'stage18-sol-review-supplement-complete';
  let primaryError = null;
  let cliWorkDir;
  let browserOwner;
  let vite;
  let browserOpened = false;
  let socketDirectoryAlias;
  let databasePath;
  let apiOrigin;
  let webPort;
  let browserSessionName;
  let browserEvidence = null;
  let playwrightOutputTail = null;
  let cleanupError = null;

  async function cli(args, label, timeoutMs = 60_000) {
    const resource = await session.startProcess({
      label, kind: 'browser', role: 'browser', command: 'bash',
      args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfigPath] : []),
        '--session', browserSessionName, ...args], cwd: cliWorkDir,
      env: {
        PATH: process.env.PATH || '', npm_config_offline: 'true',
        PWTEST_SOCKETS_DIR: socketDirectoryAlias, TMPDIR: socketDirectoryAlias,
        TMP: socketDirectoryAlias, TEMP: socketDirectoryAlias, NODE_DISABLE_COMPILE_CACHE: '1'
      }
    });
    const waited = await session.waitProcess(resource.id, timeoutMs);
    let result = waited;
    const timedOut = Boolean(waited?.timedOut);
    if (timedOut) {
      await session.stop(resource.id, label + '-timeout');
      result = await session.waitProcess(resource.id, 15_000);
    }
    if (!result?.status) {
      // Retry the exact resource lookup once. A transient status RPC can return
      // an unavailable shape even though the guardian still has the exit row.
      const snapshot = await session.status().catch(error => ({ statusError: error.message, resources: [] }));
      const current = snapshot.resources?.find(item => item.id === resource.id);
      if (current) result = { ...current, timedOut: Boolean(timedOut || result?.timedOut) };
    }
    const log = await session.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    result = { ...result, timedOut: timedOut || Boolean(result?.timedOut), tail: log.tail || '' };
    if (!result.status) {
      throw new Error(label + ' exit state could not be confirmed for resource ' + resource.id +
        ': ' + JSON.stringify({ waited, statusError: result.statusError, tail: result.tail }));
    }
    assertExited(result, label);
    return result.tail;
  }

  async function stopAndVerify(resource, label, reason) {
    if (!resource) return null;
    const status = await session.status();
    const current = status.resources?.find(item => item.id === resource.id);
    if (current && ['starting', 'running'].includes(current.status)) {
      const stopped = await session.stop(resource.id, reason);
      if (!stopped.ok) throw new Error(label + ' stop failed: ' + JSON.stringify(stopped));
    }
    const exited = await session.waitProcess(resource.id, 15_000);
    if (exited.timedOut || exited.unavailable || ['starting', 'running'].includes(exited.status)) {
      throw new Error(label + ' did not exit: ' + JSON.stringify(exited));
    }
    return exited;
  }

  async function closeBrowserAndVite(reason) {
    const errors = [];
    if (browserOpened && cliWorkDir) {
      try {
        await cli(['close'], 'stage18-review-playwright-close', 30_000);
        browserOpened = false;
      } catch (error) { errors.push('browser close: ' + error.message); }
    }
    if (browserOwner) {
      try { await stopAndVerify(browserOwner, 'Playwright session owner', reason); }
      catch (error) { errors.push(error.message); }
      browserOwner = null;
    }
    if (vite) {
      try { await stopAndVerify(vite, 'Vite', reason); }
      catch (error) { errors.push(error.message); }
      vite = null;
    }
    if (socketDirectoryAlias) {
      const handles = spawnSync('lsof', ['+D', socketDirectoryAlias], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024
      });
      if (handles.error || handles.signal || ![0, 1].includes(handles.status)) {
        errors.push('could not verify Playwright socket alias handles: ' + (handles.error?.message || handles.signal || handles.status));
      } else if (handles.status === 0 && handles.stdout.trim()) {
        errors.push('Playwright socket alias still has open handles: ' + handles.stdout.slice(0, 2048));
      } else {
        try { await fs.unlink(socketDirectoryAlias); }
        catch (error) { if (error.code !== 'ENOENT') errors.push('socket alias removal: ' + error.message); }
        socketDirectoryAlias = null;
      }
    }
    if (errors.length) throw new Error(errors.join('; '));
  }

  try {
    const sqliteDirectory = await session.allocateDir('sqlite');
    databasePath = path.join(sqliteDirectory, 'mood.sqlite');
    cliWorkDir = await session.allocateDir('browser-cli');
    const socketDirectory = await session.allocateDir('playwright-sockets');
    socketDirectoryAlias = path.join('/tmp', 'pw-s18r-' + session.instanceId.slice(0, 8));
    try { await fs.lstat(socketDirectoryAlias); throw new Error('refusing to replace existing socket alias ' + socketDirectoryAlias); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketDirectory, socketDirectoryAlias, 'dir');
    const profilePath = path.join(cliWorkDir, 'chrome-profile');
    const openMarker = path.join(cliWorkDir, 'open-status.json');
    const ownerScript = path.join(cliWorkDir, 'browser-session-owner.mjs');
    browserSessionName = 'stage18-review-' + session.instanceId.slice(0, 8);
    const ownerCode = [
      "import { spawn } from 'node:child_process';",
      "import fs from 'node:fs';",
      "const child = spawn('bash', [process.env.PLAYWRIGHT_WRAPPER, '--config', process.env.PLAYWRIGHT_CONFIG,",
      "  '--session', process.env.PLAYWRIGHT_SESSION, 'open', 'about:blank', '--profile', process.env.PLAYWRIGHT_PROFILE, '--idle-timeout', '0'], {",
      "  cwd: process.cwd(), env: { ...process.env, npm_config_offline: 'true', PWTEST_SOCKETS_DIR: process.env.PLAYWRIGHT_SOCKETS_DIR,",
      "    TMPDIR: process.env.PLAYWRIGHT_SOCKETS_DIR, TMP: process.env.PLAYWRIGHT_SOCKETS_DIR, TEMP: process.env.PLAYWRIGHT_SOCKETS_DIR,",
      "    NODE_DISABLE_COMPILE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe']",
      "});",
      "let output = '';",
      "for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4096); process.stdout.write(chunk); });",
      "child.once('error', error => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code: 1, error: error.message, output })); process.exitCode = 1; });",
      "child.once('close', (code, signal) => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code, signal, output })); process.stdout.write('PLAYWRIGHT_OPEN_COMPLETE\\n'); if (code !== 0) process.exitCode = 1; });",
      "setInterval(() => {}, 1000);"
    ].join('\n');
    await fs.writeFile(ownerScript, ownerCode);
    await fs.writeFile(path.join(cliWorkDir, '.keep'), 'managed Playwright profile and output\n');

    await withTemporaryApi(async ({ baseUrl }) => {
      try {
      apiOrigin = new URL(baseUrl).origin;
      webPort = await availableLoopbackPort();
      vite = await session.startProcess({
        label: 'stage18-review-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort,
        env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1', API_PROXY_TARGET: apiOrigin, WEB_PORT: String(webPort) }
      });
      assert.equal(vite.status, 'running', 'Vite failed to start: ' + JSON.stringify(vite));
      const webUrl = 'http://127.0.0.1:' + webPort;
      await waitForHttp(webUrl, session, vite.id);
      browserOwner = await session.startProcess({
        label: 'stage18-review-playwright-session-owner', kind: 'browser', role: 'browser',
        command: process.execPath, args: [ownerScript], cwd: cliWorkDir,
        env: {
          PATH: process.env.PATH || '', PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfigPath,
          PLAYWRIGHT_SESSION: browserSessionName, PLAYWRIGHT_PROFILE: profilePath,
          PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketDirectoryAlias
        }
      });
      assert.equal(browserOwner.status, 'running', 'Playwright session owner failed: ' + JSON.stringify(browserOwner));
      const openText = await waitForFile(openMarker, 45_000);
      const openResult = JSON.parse(openText);
      assert.equal(openResult.code, 0, 'Playwright open failed: ' + openText);
      browserOpened = true;

      const templatePath = path.join(projectRoot, 'scripts/resources/stage18-sol-review-browser-flow.js');
      const template = await fs.readFile(templatePath, 'utf8');
      const browserScript = path.join(cliWorkDir, 'stage18-sol-review-browser-flow.js');
      const browserSource = template
        .replace('__STAGE18_BASE_URL__', JSON.stringify(webUrl))
        .replace('__STAGE18_NOW__', JSON.stringify(businessNow))
        .replace('__STAGE18_SHOTS__', JSON.stringify(screenshots));
      await fs.writeFile(browserScript, browserSource);
      const tail = await cli(['run-code', '--filename', browserScript], 'stage18-review-playwright-flow', 240_000);
      playwrightOutputTail = tail.slice(-32 * 1024);
      const resultMarker = '### Result\n';
      const resultIndex = tail.indexOf(resultMarker);
      const resultLine = resultIndex < 0 ? null : tail.slice(resultIndex + resultMarker.length).split(/\r?\n/)[0];
      if (!resultLine) throw new Error('Playwright flow did not return structured evidence: ' + tail.slice(-3000));
      try { browserEvidence = JSON.parse(resultLine); }
      catch (error) {
        throw new Error('Playwright structured result line was not valid JSON: ' + error.message + '; ' + resultLine.slice(0, 3000));
      }
      if (browserEvidence.status !== 'PASS') browserEvidence.playwrightOutputTail = playwrightOutputTail;
      const screenshotBytes = {};
      for (const [key, file] of Object.entries(screenshots)) {
        try { screenshotBytes[key] = (await fs.stat(file)).size; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      browserEvidence.taskId = taskId;
      browserEvidence.resourceSessionId = session.instanceId;
      browserEvidence.apiOrigin = apiOrigin;
      browserEvidence.vitePort = webPort;
      browserEvidence.browserSession = browserSessionName;
      browserEvidence.screenshotBytes = screenshotBytes;
      browserEvidence.evidencePath = evidencePath;
      await fs.writeFile(evidencePath, JSON.stringify(browserEvidence, null, 2) + '\n');
      assert.equal(browserEvidence.status, 'PASS', 'browser supplement assertions failed: ' + JSON.stringify({
        flowError: browserEvidence.flowError,
        unexpectedConsoleErrors: browserEvidence.consoleEvidence?.unexpectedConsoleErrorCount,
        unexpectedPageErrors: browserEvidence.consoleEvidence?.unexpectedPageErrorCount
      }));
      for (const [key, file] of Object.entries(screenshots)) {
        assert.ok(screenshotBytes[key] > 0, 'required screenshot missing: ' + file);
      }
      } finally {
        // The managed API helper stops its API after this callback returns, so
        // clients and Vite must be verified exited before that boundary.
        await closeBrowserAndVite('stage18-review-browser-callback-finished');
      }
    }, 'haiyu-stage18-review-', { BUSINESS_CLOCK_NOW: businessNow }, { databasePath, resourceSession: session });
  } catch (error) {
    primaryError = error;
    outcome = 'stage18-sol-review-supplement-failed';
    if (!browserEvidence) {
      browserEvidence = {
        status: 'FAIL', taskId, resourceSessionId: session.instanceId,
        flowError: String(error?.stack || error), screenshotDirectory,
        evidencePath, apiOrigin, vitePort: webPort, browserSession: browserSessionName,
        ...(playwrightOutputTail ? { playwrightOutputTail } : {})
      };
      await fs.writeFile(evidencePath, JSON.stringify(browserEvidence, null, 2) + '\n').catch(() => {});
    }
  } finally {
    try { await closeBrowserAndVite(outcome); }
    catch (error) { cleanupError = error; outcome = 'stage18-sol-review-supplement-cleanup-failed'; }
    try {
      const closed = await session.close(outcome);
      if (!closed.ok) cleanupError = cleanupError || new Error('ResourceSession close did not confirm cleanup: ' + JSON.stringify(closed));
    } catch (error) { cleanupError = cleanupError || error; }
  }

  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  console.log(JSON.stringify({
    status: 'PASS', taskId, sessionId: session.instanceId, apiOrigin, vitePort: webPort,
    browserSession: browserSessionName, evidencePath, screenshots, consoleEvidence: browserEvidence.consoleEvidence
  }));
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
