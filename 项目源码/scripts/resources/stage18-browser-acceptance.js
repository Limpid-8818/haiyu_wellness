import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { withTemporaryApi } from '../quests/helpers.js';
import { ResourceSession } from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'playwright-cli.config.json');
const taskId = process.env.CODEX_TASK_ID;
const businessNow = '2026-10-01T10:00:00.000Z';
const screenshotDirectory = path.resolve(projectRoot, process.env.HAIYU_STAGE18_SCREENSHOT_DIR || 'output/playwright/stage18-20261002');
const captureScreenshots = process.env.HAIYU_STAGE18_CAPTURE_SCREENSHOTS !== '0';

function assertExited(result, label) {
  assert.equal(result.status, 'exited', `${label} status=${result.status}: ${result.tail || ''}`);
  assert.equal(result.exitCode, 0, `${label} exit=${result.exitCode}: ${result.tail || ''}`);
  assert.equal(result.timedOut, false, `${label} timed out: ${result.tail || ''}`);
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
      throw new Error(`Vite exited before readiness: ${resource?.status || 'missing'} ${log.tail || ''}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const log = await session.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
  throw new Error(`Vite readiness timed out: ${lastError}; ${log.tail || ''}`);
}

async function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await fs.readFile(filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Playwright open did not finish within ${timeoutMs}ms`);
}

async function addTrendFixtures(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const guest = database.prepare("SELECT id FROM users WHERE username='guest_demo' AND role='guest'").get();
    assert.ok(guest?.id, 'demo guest fixture is available');
    const insert = database.prepare(`INSERT INTO mood_records
      (guest_id,business_date,score,note,created_at,updated_at) VALUES(?,?,?,?,?,?)`);
    for (const [date, score, note] of [
      ['2026-09-26', 2, 'stage18-browser-note-0926'],
      ['2026-09-29', 4, 'stage18-browser-note-0929']
    ]) {
      const stamp = `${date}T10:00:00.000Z`;
      insert.run(guest.id, date, score, note, stamp, stamp);
    }
  } finally { database.close(); }
}

async function main() {
  assert.ok(taskId, 'Stage18 browser acceptance requires CODEX_TASK_ID');
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const screenshots = {
    trend7: path.join(screenshotDirectory, 'mood-trend-7d-source-and-gap.png'),
    trend30: path.join(screenshotDirectory, 'mood-trend-30d-source-and-gap.png'),
    player: path.join(screenshotDirectory, 'mood-player-native-audio.png'),
    recovery: path.join(screenshotDirectory, 'mood-player-error-recovery.png'),
    desktop1024: path.join(screenshotDirectory, 'mood-space-1024x1000.png'),
    desktop1440: path.join(screenshotDirectory, 'mood-space-1440x1000.png'),
    desktop1920: path.join(screenshotDirectory, 'mood-space-1920x1000.png')
  };
  for (const file of Object.values(screenshots)) {
    try { await fs.access(file); if (captureScreenshots) throw new Error(`refusing to overwrite existing screenshot ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  const session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
  let vite;
  let browserOwner;
  let cliWorkDir;
  let openMarker;
  let socketDirectoryAlias;
  let browserOpened = false;
  let outcome = 'stage18-browser-acceptance-complete';
  const sessionName = `stage18-${session.instanceId.slice(0, 8)}`;

  async function cli(args, label, timeoutMs = 60_000) {
    const resource = await session.startProcess({
      label, kind: 'browser', role: 'browser', command: 'bash',
      args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfigPath] : []),
        '--session', sessionName, ...args], cwd: cliWorkDir,
      env: { PATH: process.env.PATH || '', npm_config_offline: 'true', PWTEST_SOCKETS_DIR: socketDirectoryAlias,
        TMPDIR: socketDirectoryAlias, TMP: socketDirectoryAlias, TEMP: socketDirectoryAlias, NODE_DISABLE_COMPILE_CACHE: '1' }
    });
    let result = await session.waitProcess(resource.id, timeoutMs);
    const timedOut = Boolean(result.timedOut);
    if (timedOut) {
      await session.stop(resource.id, `${label}-timeout`);
      result = await session.waitProcess(resource.id, 15_000);
    }
    const log = await session.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    result = { ...result, timedOut: timedOut || Boolean(result.timedOut), tail: log.tail || '' };
    assertExited(result, label);
    return result.tail;
  }

  try {
    const sqliteDirectory = await session.allocateDir('sqlite');
    const databasePath = path.join(sqliteDirectory, 'mood.sqlite');
    cliWorkDir = await session.allocateDir('browser-cli');
    const socketDirectory = await session.allocateDir('playwright-sockets');
    socketDirectoryAlias = path.join('/tmp', `pw-${session.instanceId.slice(0, 8)}`);
    try { await fs.lstat(socketDirectoryAlias); throw new Error(`refusing to replace existing path ${socketDirectoryAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketDirectory, socketDirectoryAlias, 'dir');
    const profilePath = path.join(cliWorkDir, 'chrome-profile');
    openMarker = path.join(cliWorkDir, 'open-status.json');
    const ownerScript = path.join(cliWorkDir, 'browser-session-owner.mjs');
    await fs.writeFile(ownerScript, `
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const child = spawn('bash', [process.env.PLAYWRIGHT_WRAPPER, '--config', process.env.PLAYWRIGHT_CONFIG,
  '--session', process.env.PLAYWRIGHT_SESSION, 'open', 'about:blank',
  '--profile', process.env.PLAYWRIGHT_PROFILE, '--idle-timeout', '0'], {
  cwd: process.cwd(), env: { ...process.env, npm_config_offline: 'true', PWTEST_SOCKETS_DIR: process.env.PLAYWRIGHT_SOCKETS_DIR,
    TMPDIR: process.env.PLAYWRIGHT_SOCKETS_DIR, TMP: process.env.PLAYWRIGHT_SOCKETS_DIR,
    TEMP: process.env.PLAYWRIGHT_SOCKETS_DIR, NODE_DISABLE_COMPILE_CACHE: '1' }, stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4096); process.stdout.write(chunk); });
child.once('error', error => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code: 1, error: error.message, output })); process.exitCode = 1; });
child.once('close', (code, signal) => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code, signal, output })); process.stdout.write('PLAYWRIGHT_OPEN_COMPLETE\\n'); if (code !== 0) process.exitCode = 1; });
setInterval(() => {}, 1000);
`);
    await fs.writeFile(path.join(cliWorkDir, '.keep'), 'managed Playwright profile and CLI output\n');

    await withTemporaryApi(async ({ baseUrl }) => {
      await addTrendFixtures(databasePath);
      const apiOrigin = new URL(baseUrl).origin;
      const webPort = await availableLoopbackPort();
      vite = await session.startProcess({
        label: 'stage18-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort,
        env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1', API_PROXY_TARGET: apiOrigin, WEB_PORT: String(webPort) }
      });
      assert.equal(vite.status, 'running', `Vite did not start: ${JSON.stringify(vite)}`);
      const webUrl = `http://127.0.0.1:${webPort}`;
      await waitForHttp(webUrl, session, vite.id);
      browserOwner = await session.startProcess({
        label: 'stage18-playwright-session-owner', kind: 'browser', role: 'browser',
        command: process.execPath, args: [ownerScript], cwd: cliWorkDir,
        env: { PATH: process.env.PATH || '', PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfigPath,
          PLAYWRIGHT_SESSION: sessionName,
          PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketDirectoryAlias }
      });
      assert.equal(browserOwner.status, 'running', `Playwright session owner did not start: ${JSON.stringify(browserOwner)}`);
      const openText = await waitForFile(openMarker, 45_000);
      const openResult = JSON.parse(openText);
      assert.equal(openResult.code, 0, `Playwright open failed: ${openText}`);
      browserOpened = true;

      const browserScript = path.join(cliWorkDir, 'stage18-ui-flow.mjs');
      const browserFlow = String.raw`async (page) => {
const assert = {
  equal(actual, expected, message) { if (actual !== expected) throw new Error(message + ': expected ' + expected + ', got ' + actual); },
  ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); },
  includes(actual, expected, message) { if (!String(actual).includes(expected)) throw new Error(message + ': "' + actual + '" does not include "' + expected + '"'); },
  async emptyLocators(locator, message) { if (await locator.count() !== 0) throw new Error(message + ': count=' + await locator.count()); },
  deepEqual(actual, expected, message) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); }
};
const baseUrl = __STAGE18_BASE_URL__;
const shots = __STAGE18_SHOTS__;
const businessNow = __STAGE18_NOW__;
const captureScreenshots = __STAGE18_CAPTURE_SCREENSHOTS__;
const pageErrors = [];
const blockedExternalRequests = [];
const usageResponses = [];
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(20000);
await page.addInitScript((iso) => {
  const NativeDate = Date;
  const fixedEpoch = NativeDate.parse(iso);
  class FrozenDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [fixedEpoch])); }
    static now() { return fixedEpoch; }
  }
  Object.setPrototypeOf(FrozenDate, NativeDate);
  window.Date = FrozenDate;
}, businessNow);
page.on('pageerror', error => pageErrors.push(error.message));
page.on('response', response => { if (response.url().includes('/mood-resources/') && response.url().includes('/usage')) usageResponses.push(response.status()); });
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.protocol === 'data:' || url.protocol === 'blob:' || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
  blockedExternalRequests.push(url.origin);
  return route.abort();
});

await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '我是客人 →', exact: true }).click();
await page.getByRole('button', { name: /进入工作区/ }).click();
await page.getByRole('button', { name: '我的', exact: true }).waitFor({ state: 'visible' });
async function openMood() {
  await page.getByRole('button', { name: '我的', exact: true }).click();
  const entry = page.locator('.guest-my-entry').filter({ hasText: '心情与陪伴' });
  await entry.waitFor({ state: 'visible' });
  await entry.click();
  await page.getByRole('heading', { name: '心情与陪伴', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('group', { name: '选择心情档位' }).waitFor({ state: 'visible' });
}
await openMood();

const dock = page.getByTestId('mood-player-dock');
await page.getByText('正在读取心情记录和陪伴资源…', { exact: true }).waitFor({ state: 'detached' });
const quickGroup = page.getByRole('group', { name: '选择心情档位' });
const createPromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/me/moods'));
await quickGroup.getByRole('button', { name: /有些烦闷/ }).click();
const createResponse = await createPromise;
assert.equal(createResponse.status(), 201, 'quick mood choice immediately creates the daily record');
const created = await createResponse.json();
assert.equal(created.score, 2, 'quick choice score');
await page.locator('.mood-today-saved').waitFor({ state: 'visible' });
assert.includes(await page.locator('.mood-today-saved').innerText(), String(created.id), 'created record ID is visible');
await page.getByRole('button', { name: '编辑今日记录', exact: true }).click();
await quickGroup.getByRole('button', { name: /比较平静/ }).click();
await page.getByLabel('想留下一句备注吗？').fill('stage18-browser-today-note');
const updatePromise = page.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith('/api/me/moods/' + created.id));
await page.getByRole('button', { name: '保存修改', exact: true }).click();
const updateResponse = await updatePromise;
assert.equal(updateResponse.status(), 200, 'same-day explicit edit updates successfully');
const updated = await updateResponse.json();
assert.equal(updated.id, created.id, 'editing retains the quick-choice record ID');
assert.equal(updated.score, 4, 'edited score');
assert.equal(updated.note, 'stage18-browser-today-note', 'edited note');
await page.getByText(/已更新今天的记录/).waitFor({ state: 'visible' });

const sevenGroup = page.getByRole('group', { name: '心情趋势时间范围' });
const seven = sevenGroup.getByRole('button', { name: '7 日', exact: true });
assert.equal(await seven.getAttribute('aria-pressed'), 'true', 'seven-day range initially selected');
const sevenCalendar = page.locator('.mood-calendar-7');
await page.waitForFunction(() => document.querySelectorAll('.mood-calendar-7 .mood-day').length === 7);
assert.equal(await page.locator('.mood-calendar-7 .mood-day.empty').count(), 4, 'seven-day trend keeps four missing dates blank');
const sourceDay = sevenCalendar.getByRole('button', { name: /2026-09-26/ });
await sourceDay.click();
const selected = page.locator('.mood-selected-record');
await selected.waitFor({ state: 'visible' });
assert.includes(await selected.innerText(), 'stage18-browser-note-0926', 'selected trend point shows its original note');
assert.includes(await selected.innerText(), '2026-09-26', 'selected trend point shows its date');
const sourceText = await selected.innerText();
const sourceId = sourceText.match(/#(\d+)/)?.[1];
assert.ok(sourceId, 'selected trend point shows its source record ID');
if (captureScreenshots) await page.locator('.mood-trend-section').screenshot({ path: shots.trend7 });

const thirty = sevenGroup.getByRole('button', { name: '30 日', exact: true });
await thirty.click();
await page.waitForFunction(() => document.querySelectorAll('.mood-calendar-30 .mood-day').length === 30);
assert.equal(await page.locator('.mood-calendar-30 .mood-day.empty').count(), 27, '30-day trend keeps all 27 missing dates blank');
await page.locator('.mood-calendar-30').getByRole('button', { name: /2026-09-29/ }).click();
await selected.waitFor({ state: 'visible' });
assert.includes(await selected.innerText(), 'stage18-browser-note-0929', '30-day selected date shows source note');
assert.ok((await selected.innerText()).match(/记录编号\s*#\d+/), '30-day selected date exposes the source ID');
if (captureScreenshots) await page.locator('.mood-trend-section').screenshot({ path: shots.trend30 });

const breathingCard = page.locator('.mood-resource-card').filter({ hasText: '慢慢呼吸' });
await breathingCard.getByRole('button', { name: '打开播放器', exact: true }).click();
await dock.locator('audio').waitFor({ state: 'visible' });
const audio = dock.locator('audio');
await page.waitForFunction(() => {
  const media = document.querySelector('.mood-player-dock audio');
  return Boolean(media && media.readyState >= 1 && media.duration > 30);
});
assert.equal(await audio.getAttribute('controls'), '', 'native audio controls are enabled');
const playResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/mood-resources/breathing/usage'));
await dock.getByRole('button', { name: '播放', exact: true }).click();
const playResponse = await playResponsePromise;
assert.equal(playResponse.status(), 201, 'first play records usage');
await page.waitForFunction(() => {
  const media = document.querySelector('.mood-player-dock audio');
  return Boolean(media && !media.paused && media.currentTime > 0);
});
const playing = await audio.evaluate(media => ({ currentTime: media.currentTime, duration: media.duration, src: media.currentSrc, paused: media.paused }));
assert.ok(playing.duration > 30 && playing.currentTime > 0 && !playing.paused, 'browser decodes and plays the actual WAV file');
assert.ok(playing.src.includes('/api/mood/resources/breathing/audio'), 'native player loads the registered audio route');
await audio.evaluate(media => { media.currentTime = 4; });
await page.waitForFunction(() => Math.abs(document.querySelector('.mood-player-dock audio').currentTime - 4) < 0.4);
await dock.getByRole('button', { name: '暂停', exact: true }).click();
await page.waitForFunction(() => document.querySelector('.mood-player-dock audio').paused);
const beforeRoute = await audio.evaluate(media => ({ currentTime: media.currentTime, src: media.currentSrc, duration: media.duration }));
if (captureScreenshots) await page.locator('.mood-player-dock').screenshot({ path: shots.player });

await page.getByRole('button', { name: '我的', exact: true }).click();
await page.getByRole('heading', { name: '我的', exact: true }).waitFor({ state: 'visible' });
assert.equal(await dock.count(), 1, 'player dock remains mounted after route change');
const afterRoute = await dock.locator('audio').evaluate(media => ({ currentTime: media.currentTime, src: media.currentSrc, duration: media.duration, paused: media.paused }));
assert.equal(afterRoute.src, beforeRoute.src, 'route change preserves the loaded audio source');
assert.ok(Math.abs(afterRoute.currentTime - beforeRoute.currentTime) < 0.5, 'route change preserves playback position');
assert.equal(afterRoute.paused, true, 'route change preserves the paused playback state');

await dock.locator('audio').evaluate(media => { media.src = '/api/mood/resources/missing/audio'; media.load(); });
await dock.getByRole('alert').waitFor({ state: 'visible' });
assert.includes(await dock.getByRole('alert').innerText(), '资源加载失败', 'media error is announced');
await dock.getByRole('button', { name: '重新加载', exact: true }).click();
await page.waitForFunction(() => {
  const media = document.querySelector('.mood-player-dock audio');
  return Boolean(media && media.readyState >= 1 && media.duration > 30 && media.currentSrc.includes('/breathing/audio'));
});
if (captureScreenshots) await page.locator('.mood-player-dock').screenshot({ path: shots.recovery });
assert.equal(await dock.getByRole('alert').count(), 0, 'retry clears the media error');

await page.getByRole('button', { name: '我的', exact: true }).click();
await page.locator('.guest-my-entry').filter({ hasText: '心情与陪伴' }).click();
await page.getByRole('heading', { name: '心情与陪伴', exact: true }).waitFor({ state: 'visible' });
for (const width of [1024, 1440, 1920]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(100);
  const layout = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.ok(layout.documentWidth <= layout.width, width + 'px layout has no horizontal overflow: ' + JSON.stringify(layout));
  if (captureScreenshots) await page.screenshot({ path: shots['desktop' + width], fullPage: false });
}
assert.deepEqual(pageErrors, [], 'browser page errors');
const blockedOrigins = [...new Set(blockedExternalRequests)];
assert.ok(blockedOrigins.every(origin => origin === 'https://fonts.googleapis.com'), 'all attempted external asset requests are intercepted: ' + JSON.stringify(blockedOrigins));
assert.deepEqual(usageResponses, [201], 'one user playback creates one usage event while pausing and seeking do not duplicate it');
return {
  status: 'PASS', businessNow, timeZone: 'Asia/Shanghai',
  sameDayQuickSelectionAndEdit: { createdId: String(created.id), updatedId: String(updated.id), score: updated.score, note: updated.note },
  trend: { sevenDay: { samples: 3, missingDays: 4, selectedDate: '2026-09-26', sourceId, note: 'stage18-browser-note-0926' },
    thirtyDay: { samples: 3, missingDays: 27, selectedDate: '2026-09-29', note: 'stage18-browser-note-0929' } },
  media: { durationSeconds: playing.duration, playedAtSeconds: playing.currentTime, seekedToSeconds: beforeRoute.currentTime,
    paused: afterRoute.paused, routePersistentSource: afterRoute.src, recovery: 'missing route -> announced error -> retry restored WAV' },
  usageResponses, layouts: [1024, 1440, 1920].map(width => ({ width, noHorizontalOverflow: true })),
  screenshots: shots, blockedExternalRequests: blockedOrigins
};
}`;
      await fs.writeFile(browserScript, browserFlow
        .replace('__STAGE18_BASE_URL__', JSON.stringify(webUrl))
        .replace('__STAGE18_SHOTS__', JSON.stringify(screenshots))
        .replace('__STAGE18_NOW__', JSON.stringify(businessNow))
        .replace('__STAGE18_CAPTURE_SCREENSHOTS__', JSON.stringify(captureScreenshots)));
      const evidence = await cli(['run-code', '--filename', browserScript], 'stage18-playwright-ui-flow', 180_000);
      for (const screenshot of Object.values(screenshots)) {
        await fs.access(screenshot);
        if (captureScreenshots && !evidence.includes(path.basename(screenshot))) throw new Error(`Playwright omitted screenshot evidence ${screenshot}`);
      }
      await cli(['close'], 'stage18-playwright-close', 30_000);
      browserOpened = false;
      const stopped = await session.stop(browserOwner.id, 'playwright-browser-closed');
      assert.ok(stopped.ok, `browser owner stop failed: ${JSON.stringify(stopped)}`);
      const exited = await session.waitProcess(browserOwner.id, 15_000);
      assert.ok(!exited.timedOut && ['exited', 'stopped'].includes(exited.status), `browser owner did not exit: ${JSON.stringify(exited)}`);
      const viteStopped = await session.stop(vite.id, 'stage18-browser-acceptance-complete');
      assert.ok(viteStopped.ok, `Vite stop failed: ${JSON.stringify(viteStopped)}`);
      const viteExited = await session.waitProcess(vite.id, 15_000);
      assert.ok(!viteExited.timedOut && ['exited', 'stopped'].includes(viteExited.status), `Vite did not exit: ${JSON.stringify(viteExited)}`);
      const artifactSizes = {};
      for (const [key, file] of Object.entries(screenshots)) artifactSizes[key] = (await fs.stat(file)).size;
      const browserEvidence = { status: 'PASS', taskId, sessionId: session.instanceId, apiOrigin, vitePort: webPort,
        browserSession: sessionName, screenshots: Object.values(screenshots), screenshotBytes: artifactSizes,
        flowTail: evidence.slice(-8000), cliCloseTail: 'closed and browser owner exit confirmed' };
      await fs.writeFile(path.join(screenshotDirectory, 'stage18-browser-evidence.json'), `${JSON.stringify(browserEvidence, null, 2)}\n`);
      console.log(JSON.stringify(browserEvidence));
    }, 'haiyu-stage18-browser-', { BUSINESS_CLOCK_NOW: businessNow }, { databasePath, resourceSession: session });
  } catch (error) {
    outcome = 'stage18-browser-acceptance-failed';
    throw error;
  } finally {
    if (browserOpened && cliWorkDir) {
      try {
        await session.runProcess({
          label: 'stage18-playwright-failure-close', kind: 'browser', role: 'browser', command: 'bash',
          args: [playwrightWrapper, '--session', sessionName, 'close'], cwd: cliWorkDir,
          env: { PATH: process.env.PATH || '', npm_config_offline: 'true', PWTEST_SOCKETS_DIR: socketDirectoryAlias,
            TMPDIR: socketDirectoryAlias, TMP: socketDirectoryAlias, TEMP: socketDirectoryAlias, NODE_DISABLE_COMPILE_CACHE: '1' }
        }, { timeoutMs: 20_000 });
      } catch { /* ResourceSession verifies and stops any remaining browser process below. */ }
      browserOpened = false;
    }
    if (browserOwner) {
      const status = await session.status().catch(() => ({ resources: [] }));
      const ownerStatus = status.resources?.find(item => item.id === browserOwner.id)?.status;
      if (['starting', 'running'].includes(ownerStatus)) await session.stop(browserOwner.id, outcome);
      await session.waitProcess(browserOwner.id, 15_000).catch(() => null);
    }
    if (socketDirectoryAlias) {
      const handles = spawnSync('lsof', ['+D', socketDirectoryAlias], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
      if (handles.error || handles.signal || ![0, 1].includes(handles.status)) {
        throw new Error(`could not verify Playwright socket-directory handles: ${handles.error?.message || handles.signal || handles.status}`);
      }
      if (handles.status === 0 && handles.stdout.trim()) throw new Error(`Playwright socket-directory handles remain: ${handles.stdout.slice(0, 2048)}`);
      await fs.unlink(socketDirectoryAlias).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    if (vite) {
      const status = await session.status().catch(() => ({ resources: [] }));
      const viteStatus = status.resources?.find(item => item.id === vite.id)?.status;
      if (['starting', 'running'].includes(viteStatus)) await session.stop(vite.id, outcome);
      await session.waitProcess(vite.id, 15_000).catch(() => null);
    }
    await session.close(outcome);
  }
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
