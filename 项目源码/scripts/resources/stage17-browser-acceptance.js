import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTemporaryApi } from '../quests/helpers.js';
import { ResourceSession } from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverRoot = path.join(projectRoot, 'server');
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfigPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'playwright-cli.config.json');
const screenshotDirectory = path.resolve(projectRoot, process.env.HAIYU_STAGE17_SCREENSHOT_DIR || 'output/playwright/stage17-20261002-acceptance');
const taskId = process.env.CODEX_TASK_ID || 'stage17-browser-acceptance';
const businessNow = '2026-10-01T10:00:00.000Z';

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
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('could not allocate a loopback port')));
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

async function main() {
  await fs.mkdir(screenshotDirectory, { recursive: true });
  const screenshots = {
    screenshot1440: path.join(screenshotDirectory, 'health-ui-1440x1000.png'),
    screenshot1024: path.join(screenshotDirectory, 'health-ui-1024x1000.png'),
    bloodPressureTooltip: path.join(screenshotDirectory, 'health-trend-bp-tooltip.png'),
    outlierTooltip: path.join(screenshotDirectory, 'health-trend-steps-outlier-tooltip.png'),
    sleepGap7: path.join(screenshotDirectory, 'health-trend-sleep-gap-7d.png'),
    sleepGap30: path.join(screenshotDirectory, 'health-trend-sleep-gap-30d.png'),
    invalidSleep: path.join(screenshotDirectory, 'health-form-invalid-sleep-25h.png'),
    yesterdayRetract: path.join(screenshotDirectory, 'health-yesterday-retract-expired.png')
  };
  for (const file of Object.values(screenshots)) {
    try { await fs.access(file); throw new Error(`refusing to overwrite existing screenshot ${file}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  const session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
  let vite;
  let browserOwner;
  let apiResult;
  let cliWorkDir;
  let openMarker;
  let socketDirectoryAlias;
  let browserOpened = false;
  let outcome = 'stage17-browser-acceptance-complete';

  async function cli(args, label, timeoutMs = 60_000) {
    const resource = await session.startProcess({
      label, kind: 'browser', role: 'browser', command: 'bash',
      args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfigPath] : []),
        '--session', sessionName, ...args], cwd: cliWorkDir,
      env: {
        PATH: process.env.PATH || '', npm_config_offline: 'true',
        PWTEST_SOCKETS_DIR: socketDirectoryAlias, TMPDIR: socketDirectoryAlias,
        TMP: socketDirectoryAlias, TEMP: socketDirectoryAlias, NODE_DISABLE_COMPILE_CACHE: '1'
      }
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

  const sessionName = `stage17-${session.instanceId.slice(0, 8)}`;
  try {
    const sqliteDirectory = await session.allocateDir('sqlite');
    const databasePath = path.join(sqliteDirectory, 'health.sqlite');
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
const wrapper = process.env.PLAYWRIGHT_WRAPPER;
const marker = process.env.PLAYWRIGHT_OPEN_MARKER;
let output = '';
function remember(chunk) { output = (output + chunk.toString()).slice(-4096); }
const args = [wrapper, '--config', process.env.PLAYWRIGHT_CONFIG, '--session', process.env.PLAYWRIGHT_SESSION,
  'open', 'about:blank', '--profile', process.env.PLAYWRIGHT_PROFILE, '--idle-timeout', '0'];
const child = spawn('bash', args, { cwd: process.cwd(), env: { ...process.env, npm_config_offline: 'true',
  PWTEST_SOCKETS_DIR: process.env.PLAYWRIGHT_SOCKETS_DIR,
  TMPDIR: process.env.PLAYWRIGHT_SOCKETS_DIR, TMP: process.env.PLAYWRIGHT_SOCKETS_DIR,
  TEMP: process.env.PLAYWRIGHT_SOCKETS_DIR, NODE_DISABLE_COMPILE_CACHE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { remember(chunk); process.stdout.write(chunk); });
child.once('error', error => {
  fs.writeFileSync(marker, JSON.stringify({ code: 1, error: error.message, output }));
  process.exitCode = 1;
});
child.once('close', (code, signal) => {
  fs.writeFileSync(marker, JSON.stringify({ code, signal, output }));
  process.stdout.write('PLAYWRIGHT_OPEN_COMPLETE\\n');
  if (code !== 0) process.exitCode = 1;
});
setInterval(() => {}, 1000);
`);
    await fs.writeFile(path.join(cliWorkDir, '.keep'), 'resource-managed Playwright profile and CLI output\n');

    await withTemporaryApi(async ({ baseUrl }) => {
      apiResult = { origin: new URL(baseUrl).origin, databasePath };
      const webPort = await availableLoopbackPort();
      vite = await session.startProcess({
        label: 'stage17-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort,
        env: {
          PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1',
          API_PROXY_TARGET: apiResult.origin, WEB_PORT: String(webPort)
        }
      });
      assert.equal(vite.status, 'running', `Vite did not start: ${JSON.stringify(vite)}`);
      const webUrl = `http://127.0.0.1:${webPort}`;
      await waitForHttp(webUrl, session, vite.id);

      browserOwner = await session.startProcess({
        label: 'stage17-playwright-session-owner', kind: 'browser', role: 'browser',
        command: process.execPath, args: [ownerScript], cwd: cliWorkDir,
        env: {
          PATH: process.env.PATH || '', PLAYWRIGHT_WRAPPER: playwrightWrapper,
          PLAYWRIGHT_CONFIG: playwrightConfigPath,
          PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath,
          PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketDirectoryAlias
        }
      });
      assert.equal(browserOwner.status, 'running', `Playwright session owner did not start: ${JSON.stringify(browserOwner)}`);
      const openText = await waitForFile(openMarker, 45_000);
      const openResult = JSON.parse(openText);
      assert.equal(openResult.code, 0, `Playwright open failed: ${openText}`);
      browserOpened = true;

      const browserScript = path.join(cliWorkDir, 'stage17-ui-flow.mjs');
      const browserFlow = String.raw`async (page) => {
const assert = {
  equal(actual, expected, message) { if (actual !== expected) throw new Error(message + ': expected ' + expected + ', got ' + actual); },
  ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); },
  includes(actual, expected, message) { if (!String(actual).includes(expected)) throw new Error(message + ': "' + actual + '" does not include "' + expected + '"'); },
  deepEqual(actual, expected, message) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); }
};
const baseUrl = __STAGE17_BASE_URL__;
const shots = __STAGE17_SHOTS__;
const businessNow = __STAGE17_NOW__;
const pageErrors = [];
const blockedExternalRequests = [];
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

async function openHealth() {
  await page.getByRole('button', { name: '我的', exact: true }).click();
  const entry = page.locator('.guest-my-entry').filter({ hasText: '健康记录' });
  await entry.waitFor({ state: 'visible' });
  await entry.click();
  await page.getByRole('heading', { name: '我的健康状况', exact: true }).waitFor({ state: 'visible' });
  await page.locator('.health-entry-form').waitFor({ state: 'visible' });
}
await openHealth();

const form = page.locator('.health-entry-form');
const recordRows = page.locator('.health-record-row');
await page.getByText('正在加载健康记录…', { exact: true }).waitFor({ state: 'detached' });
await page.waitForFunction(() => {
  const surface = document.querySelector('.health-records-surface');
  return Boolean(surface?.querySelector('.health-record-list') ||
    [...(surface?.querySelectorAll('.health-chart-state') || [])].some(node => node.textContent.includes('暂无健康记录')));
});
const invalidRecordIdsBefore = await recordRows.locator('.health-record-time small').allInnerTexts();
const invalidRowsBefore = invalidRecordIdsBefore.length;
await form.locator('select').selectOption('sleep');
await form.locator('input[type="number"]').fill('25');
await form.locator('input[type="datetime-local"]').fill('2026-10-01T12:00');
await form.locator('input[type="text"]').fill('stage17-invalid-sleep-25h');
const invalidResponsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/me/health-records'));
await form.getByRole('button', { name: /保存记录/ }).click();
const invalidResponse = await invalidResponsePromise;
const invalidPayload = await invalidResponse.json();
assert.equal(invalidResponse.status(), 400, 'sleep 25 h response status');
assert.equal(invalidPayload.code, 'HEALTH_METRIC_FIELD_INVALID', 'sleep 25 h API validation code');
assert.equal(invalidPayload.details.field, 'value', 'sleep 25 h API validation field');
const invalidField = form.locator('label.health-form-field').filter({ hasText: '睡眠时长' }).locator('input[type="number"]');
await invalidField.waitFor({ state: 'visible' });
assert.equal(await invalidField.getAttribute('aria-invalid'), 'true', 'invalid sleep field aria-invalid');
const fieldError = form.locator('label.health-form-field').filter({ hasText: '睡眠时长' }).locator('.health-field-error[role="alert"]');
await fieldError.waitFor({ state: 'visible' });
const invalidText = await fieldError.innerText();
assert.includes(invalidText, '演示录入范围', 'visible sleep validation text');
const invalidBorder = await invalidField.evaluate(node => getComputedStyle(node).borderTopColor);
assert.equal(invalidBorder, 'rgb(217, 109, 97)', 'invalid sleep red border');
await page.getByText('正在加载健康记录…', { exact: true }).waitFor({ state: 'detached' });
const invalidRecordIdsAfter = await recordRows.locator('.health-record-time small').allInnerTexts();
const invalidRowsAfter = invalidRecordIdsAfter.length;
assert.deepEqual(invalidRecordIdsAfter, invalidRecordIdsBefore, 'invalid input creates no record');
await page.locator('.health-entry-surface').screenshot({ path: shots.invalidSleep });

const entries = [
  { key: 'bpPast', metric: 'blood_pressure', values: ['124', '82'], unit: 'mmHg', date: '2026-09-29', recordedLocal: '2026-09-29T09:00', note: 'stage17-proof-bp-0929' },
  { key: 'bpToday', metric: 'blood_pressure', values: ['132', '84'], unit: 'mmHg', date: '2026-10-01', recordedLocal: '2026-10-01T09:00', note: 'stage17-proof-bp-1001' },
  { key: 'sleepPast', metric: 'sleep', values: ['6'], unit: 'h', date: '2026-09-29', recordedLocal: '2026-09-29T09:15', note: 'stage17-proof-sleep-0929' },
  { key: 'sleepToday', metric: 'sleep', values: ['7'], unit: 'h', date: '2026-10-01', recordedLocal: '2026-10-01T09:15', note: 'stage17-proof-sleep-1001' },
  { key: 'stepsOutlier', metric: 'steps', values: ['42000'], unit: '步', date: '2026-10-01', recordedLocal: '2026-10-01T10:00', note: 'stage17-proof-steps-outlier' },
  { key: 'weightToday', metric: 'weight', values: ['63.4'], unit: 'kg', date: '2026-10-01', recordedLocal: '2026-10-01T11:00', note: 'stage17-proof-weight-today' },
  { key: 'weightYesterday', metric: 'weight', values: ['61.8'], unit: 'kg', date: '2026-09-30', recordedLocal: '2026-09-30T11:00', note: 'stage17-proof-weight-yesterday' }
];
const savedRecords = {};
async function saveRecord(entry) {
  await form.locator('select').selectOption(entry.metric);
  const numberInputs = form.locator('input[type="number"]');
  assert.equal(await numberInputs.count(), entry.values.length, entry.key + ' input count');
  for (let index = 0; index < entry.values.length; index += 1) await numberInputs.nth(index).fill(entry.values[index]);
  await form.locator('input[type="datetime-local"]').fill(entry.recordedLocal);
  await form.locator('input[type="text"]').fill(entry.note);
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST' && response.url().includes('/api/me/health-records'));
  await form.getByRole('button', { name: /保存记录/ }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 201, entry.key + ' POST status');
  const saved = await response.json();
  assert.equal(saved.metric, entry.metric, entry.key + ' saved metric');
  assert.equal(saved.unit, entry.unit, entry.key + ' saved unit');
  assert.equal(saved.source, 'guest', entry.key + ' auth-derived source');
  savedRecords[entry.key] = saved;
  await page.locator('.health-record-row').filter({ hasText: entry.note }).waitFor({ state: 'visible' });
  return saved;
}
for (const entry of entries) {
  const saved = await saveRecord(entry);
  if (entry.key === 'stepsOutlier') {
    assert.equal(saved.demoOutlier, true, '42,000 steps is accepted and marked by the demo threshold');
    assert.includes(saved.demoRule.note, '不代表诊断', 'outlier API rule is non-diagnostic');
  }
}
async function assertRecordRow(entry) {
  const saved = savedRecords[entry.key];
  const row = page.locator('.health-record-row').filter({ hasText: entry.note });
  await row.waitFor({ state: 'visible' });
  const idText = await row.locator('.health-record-time small').innerText();
  assert.includes(idText, String(saved.id), entry.key + ' visible record ID');
  const metricUnit = await row.locator('.health-record-metric small').innerText();
  assert.includes(metricUnit, entry.unit, entry.key + ' list unit');
  const rowValue = (await row.locator('.health-record-value').innerText()).replace('演示异常值', '').replace(/\s+/g, '').trim();
  const expectedValue = entry.metric === 'blood_pressure' ? entry.values.join('/') : entry.values[0];
  assert.equal(rowValue, expectedValue, entry.key + ' list value');
  const rowTime = await row.locator('.health-record-time strong').innerText();
  assert.equal(rowTime.replace(/\D/g, '').slice(0, 8), entry.date.replace(/-/g, ''), entry.key + ' Shanghai business date in record list');
  return row;
}

await page.reload({ waitUntil: 'domcontentloaded' });
await openHealth();
for (const entry of entries) await assertRecordRow(entry);

const trendSelect = page.getByRole('combobox', { name: '趋势指标' });
const trendLabels = { blood_pressure: '血压', sleep: '睡眠时长', steps: '步数', weight: '体重' };
const windowGroup = page.getByRole('group', { name: '趋势窗口' });
async function selectTrend(metric, days) {
  await trendSelect.selectOption(metric);
  const button = windowGroup.getByRole('button', { name: String(days) + '日', exact: true });
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  const chartName = trendLabels[metric] + '最近' + days + '日趋势图';
  const chart = page.getByRole('img', { name: chartName, exact: true });
  await chart.waitFor({ state: 'visible' });
  await page.locator('.health-chart-footnote').waitFor({ state: 'visible' });
  assert.equal(await button.getAttribute('aria-pressed'), 'true', days + '-day window active');
  return chart;
}
for (const metric of Object.keys(trendLabels)) {
  for (const days of [7, 30]) {
    await selectTrend(metric, days);
    assert.includes(await page.locator('.health-metric-chart').getAttribute('aria-label'), String(days) + '日', metric + ' ' + days + '-day chart');
  }
}

async function chartTitles() {
  return await page.locator('.health-metric-chart g[tabindex="0"]').evaluateAll(nodes => nodes.map(node => node.querySelector('title')?.textContent || ''));
}
async function assertTooltipFor({ recordKey, seriesLabel, value, unit, date, outlier = false }) {
  const saved = savedRecords[recordKey];
  const expectedTitle = seriesLabel + ' ' + value + ' ' + unit + ' · ' + date + ' · 记录 ' + saved.id;
  const points = page.locator('.health-metric-chart g[tabindex="0"]');
  const titles = await chartTitles();
  const index = titles.indexOf(expectedTitle);
  assert.ok(index >= 0, 'SVG chart point maps to saved sample: ' + expectedTitle + '; found ' + JSON.stringify(titles));
  await points.nth(index).hover();
  const tooltip = page.locator('.health-chart-tooltip');
  await tooltip.waitFor({ state: 'visible' });
  const strong = await tooltip.locator('strong').innerText();
  const dateText = await tooltip.locator('span').innerText();
  const sourceText = await tooltip.locator('small').first().innerText();
  assert.equal(strong, seriesLabel + '：' + value + ' ' + unit, 'tooltip value and unit');
  assert.equal(dateText, date + ' · 上海业务日', 'tooltip Asia/Shanghai date');
  assert.equal(sourceText, '源记录：' + saved.id, 'tooltip source ID matches listed sample');
  const row = await assertRecordRow(entries.find(entry => entry.key === recordKey));
  if (outlier) assert.includes(await tooltip.locator('.health-demo-note').innerText(), '不代表诊断', 'visible outlier tooltip disclaimer');
  return { recordKey, recordId: String(saved.id), value: strong, businessDate: dateText, source: sourceText,
    outlierText: outlier ? await tooltip.locator('.health-demo-note').innerText() : null, recordRow: await row.innerText() };
}

const bpChartPoints = [];
await selectTrend('blood_pressure', 7);
for (const item of [
  { recordKey: 'bpPast', date: '2026-09-29', systolic: 124, diastolic: 82 },
  { recordKey: 'bpToday', date: '2026-10-01', systolic: 132, diastolic: 84 }
]) {
  bpChartPoints.push(await assertTooltipFor({ recordKey: item.recordKey, seriesLabel: '收缩压', value: item.systolic, unit: 'mmHg', date: item.date }));
  if (item.recordKey === 'bpToday') await page.locator('.health-trend-surface').screenshot({ path: shots.bloodPressureTooltip });
  bpChartPoints.push(await assertTooltipFor({ recordKey: item.recordKey, seriesLabel: '舒张压', value: item.diastolic, unit: 'mmHg', date: item.date }));
}

async function assertSleepGap(days, expectedMissingDays, screenshotPath) {
  await selectTrend('sleep', days);
  const titles = await chartTitles();
  const expectedTitles = [
    '睡眠时长 6 h · 2026-09-29 · 记录 ' + savedRecords.sleepPast.id,
    '睡眠时长 7 h · 2026-10-01 · 记录 ' + savedRecords.sleepToday.id
  ];
  assert.deepEqual(titles, expectedTitles, days + '-day visible plot points contain only the two valid dates and IDs');
  assert.ok(!titles.some(title => title.includes('2026-09-30')), days + '-day chart has no point for the missing day');
  const pathData = await page.locator('.health-metric-chart > path').evaluateAll(nodes => nodes.map(node => (node.getAttribute('d') || '').trim()));
  assert.equal(pathData.length, 2, days + '-day chart splits the two valid dates into separate path runs');
  assert.ok(pathData.every(value => value.startsWith('M ') && value.split(/\s+/).length === 3),
    days + '-day line paths contain only isolated move points and do not connect across the missing date: ' + JSON.stringify(pathData));
  const footnote = await page.locator('.health-chart-footnote').innerText();
  assert.includes(footnote, '有效采样 2 天', days + '-day visible sample count');
  assert.includes(footnote, '缺失 ' + expectedMissingDays + ' 天', days + '-day visible missing-day count');
  const tooltip = await assertTooltipFor({ recordKey: 'sleepToday', seriesLabel: '睡眠时长', value: 7, unit: 'h', date: '2026-10-01' });
  await page.locator('.health-trend-surface').screenshot({ path: screenshotPath });
  return { days, visiblePoints: titles, pathData, footnote, hoveredTooltip: tooltip.value, hoveredDate: tooltip.businessDate, hoveredRecordId: tooltip.recordId };
}
const sleepGap7 = await assertSleepGap(7, 5, shots.sleepGap7);
const sleepGap30 = await assertSleepGap(30, 28, shots.sleepGap30);

await selectTrend('steps', 7);
const stepsTooltip = await assertTooltipFor({ recordKey: 'stepsOutlier', seriesLabel: '步数', value: 42000, unit: '步', date: '2026-10-01', outlier: true });
await page.locator('.health-trend-surface').screenshot({ path: shots.outlierTooltip });

const yesterdayEntry = entries.find(entry => entry.key === 'weightYesterday');
const yesterdayRow = await assertRecordRow(yesterdayEntry);
const yesterdayAction = yesterdayRow.locator('.health-record-action');
const yesterdayText = await yesterdayAction.innerText();
const yesterdayExpiry = yesterdayAction.locator('.health-expired-label');
const yesterdayTitle = await yesterdayExpiry.getAttribute('title');
assert.includes(yesterdayText, '已过撤回时间', 'yesterday own record page state');
assert.includes(yesterdayTitle, '仅可撤回上海时间当天', 'yesterday retraction explanation');
assert.equal(await yesterdayAction.getByRole('button', { name: '撤回', exact: true }).count(), 0, 'yesterday record has no retract button');
await yesterdayRow.screenshot({ path: shots.yesterdayRetract });

const todayEntry = entries.find(entry => entry.key === 'weightToday');
const todayRow = await assertRecordRow(todayEntry);
await todayRow.getByRole('button', { name: '撤回', exact: true }).click();
await page.getByPlaceholder('请说明撤回原因').fill('Stage17 2026-10-02 browser evidence');
const retractResponsePromise = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/api/me/health-records/'));
await page.getByRole('button', { name: '确认撤回', exact: true }).click();
const retractResponse = await retractResponsePromise;
assert.equal(retractResponse.status(), 200, 'same-day retraction status');
const retractedRow = page.locator('.health-record-row.retracted').filter({ hasText: todayEntry.note });
await retractedRow.waitFor({ state: 'visible' });
const retractionAudit = await retractedRow.innerText();
assert.includes(retractionAudit, '已撤回', 'same-day retraction status in history');
assert.includes(retractionAudit, 'Stage17 2026-10-02 browser evidence', 'same-day reason retained in audit');

await page.evaluate(() => window.scrollTo(0, 0));
await page.setViewportSize({ width: 1440, height: 1000 });
await page.waitForTimeout(150);
const layout1440 = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
assert.ok(layout1440.documentWidth <= layout1440.width, '1440px layout has no horizontal overflow: ' + JSON.stringify(layout1440));
await page.screenshot({ path: shots.screenshot1440, fullPage: false });
await page.setViewportSize({ width: 1024, height: 1000 });
await page.waitForTimeout(150);
const layout1024 = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
assert.ok(layout1024.documentWidth <= layout1024.width, '1024px layout has no horizontal overflow: ' + JSON.stringify(layout1024));
await page.screenshot({ path: shots.screenshot1024, fullPage: false });
assert.deepEqual(pageErrors, [], 'browser page errors');
return {
  status: 'PASS', dateContext: { businessNow, timeZone: 'Asia/Shanghai', businessToday: '2026-10-01' },
  invalidSleep: { status: invalidResponse.status(), code: invalidPayload.code, field: invalidPayload.details.field, visibleText: invalidText, borderColor: invalidBorder, rowsBefore: invalidRowsBefore, rowsAfter: invalidRowsAfter, recordIdsBefore: invalidRecordIdsBefore, recordIdsAfter: invalidRecordIdsAfter },
  bloodPressureTooltips: bpChartPoints, sleepGap7, sleepGap30, outlierTooltip: stepsTooltip,
  yesterdayRetractionState: { recordId: String(savedRecords.weightYesterday.id), visibleText: yesterdayText, actionTitle: yesterdayTitle },
  sameDayRetraction: { status: retractResponse.status(), recordId: String(savedRecords.weightToday.id), auditText: retractionAudit },
  layout: { at1440: layout1440, at1024: layout1024 }, screenshots: shots, blockedExternalRequests: [...new Set(blockedExternalRequests)]
};
}`;
      await fs.writeFile(browserScript, browserFlow
        .replace('__STAGE17_BASE_URL__', JSON.stringify(webUrl))
        .replace('__STAGE17_SHOTS__', JSON.stringify(screenshots))
        .replace('__STAGE17_NOW__', JSON.stringify(businessNow)));


      const flow = await cli(['run-code', '--filename', browserScript], 'stage17-playwright-ui-flow', 120_000);
      for (const screenshot of Object.values(screenshots)) {
        await fs.access(screenshot);
        if (!flow.includes(path.basename(screenshot))) throw new Error(`Playwright UI flow omitted screenshot evidence ${screenshot}`);
      }
      const closeResult = await cli(['close'], 'stage17-playwright-close', 30_000);
      browserOpened = false;
      const browserStopped = await session.stop(browserOwner.id, 'playwright-browser-closed');
      assert.ok(browserStopped.ok, `browser owner stop failed: ${JSON.stringify(browserStopped)}`);
      const browserExited = await session.waitProcess(browserOwner.id, 15_000);
      assert.ok(!browserExited.timedOut && ['exited', 'stopped'].includes(browserExited.status),
        `browser owner did not exit: ${JSON.stringify(browserExited)}`);
      const viteStopped = await session.stop(vite.id, 'stage17-browser-acceptance-complete');
      assert.ok(viteStopped.ok, `Vite stop failed: ${JSON.stringify(viteStopped)}`);
      const viteExited = await session.waitProcess(vite.id, 15_000);
      assert.ok(!viteExited.timedOut && ['exited', 'stopped'].includes(viteExited.status), `Vite did not exit: ${JSON.stringify(viteExited)}`);
      console.log(JSON.stringify({
        status: 'PASS', taskId, sessionId: session.instanceId,
        api: apiResult, vite: { port: webPort }, browserSession: sessionName,
        screenshots: Object.values(screenshots), browserEvidence: flow.slice(-8000), cliCloseTail: closeResult.slice(-1000)
      }));
    }, 'haiyu-stage17-browser-', { BUSINESS_CLOCK_NOW: businessNow }, { databasePath, resourceSession: session });
  } catch (error) {
    outcome = 'stage17-browser-acceptance-failed';
    throw error;
  } finally {
    if (browserOpened && cliWorkDir) {
      try {
        await session.runProcess({
          label: 'stage17-playwright-failure-close', kind: 'browser', role: 'browser', command: 'bash',
          args: [playwrightWrapper, '--session', sessionName, 'close'], cwd: cliWorkDir,
          env: {
            PATH: process.env.PATH || '', npm_config_offline: 'true',
            PWTEST_SOCKETS_DIR: socketDirectoryAlias, TMPDIR: socketDirectoryAlias,
            TMP: socketDirectoryAlias, TEMP: socketDirectoryAlias, NODE_DISABLE_COMPILE_CACHE: '1'
          }
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
      const handles = spawnSync('lsof', ['+D', socketDirectoryAlias], {
        encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024
      });
      if (handles.error || handles.signal || ![0, 1].includes(handles.status)) {
        throw new Error(`could not verify Playwright socket-directory handles: ${handles.error?.message || handles.signal || handles.status}`);
      }
      if (handles.status === 0 && handles.stdout.trim()) {
        throw new Error(`Playwright socket-directory handles remain: ${handles.stdout.slice(0, 2048)}`);
      }
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
