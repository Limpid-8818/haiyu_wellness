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
const firstMorning = { before: '2026-10-06T22:59:00.000Z', after: '2026-10-06T23:00:00.000Z', action: '2026-10-06T23:01:00.000Z' };
const secondMorning = { before: '2026-10-07T22:59:00.000Z', after: '2026-10-07T23:00:00.000Z', action: '2026-10-07T23:01:00.000Z' };
const thirdMorning = { before: '2026-10-08T22:59:00.000Z', after: '2026-10-08T23:00:00.000Z', action: '2026-10-08T23:01:00.000Z' };
const finalClock = '2026-10-09T08:45:00.000Z'; // 16:45 Asia/Shanghai
const protectedChrome = { pid: 7081, startTime: 'Thu Oct 1 17:27:01 2026',
  fingerprint: 'a30da864807c765187c20eb24b90dfaedb6d8273c8675d112e09016b42ec949d' };
const cacheParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const expectedCacheNames = ['code_sign_clone.7WCMBh', 'code_sign_clone.87prgQ', 'code_sign_clone.FGf0ku',
  'code_sign_clone.KlYqcP', 'code_sign_clone.Km1hwm', 'code_sign_clone.Ly34OH', 'code_sign_clone.b9cnAV',
  'code_sign_clone.fpg2xz', 'code_sign_clone.jcG5XI', 'code_sign_clone.ooLA7h', 'code_sign_clone.xkTnpB'];

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
  return { label, command: 'df -Pk /tmp', exitCode: result.status, filesystem: columns[0], usedKiB: Number(columns[2]),
    availableKiB: Number(columns[3]), mountedOn: columns.slice(5).join(' '), at: new Date().toISOString() };
}

function userChromeSnapshot() {
  const priorTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  let identity;
  try { identity = processIdentity(protectedChrome.pid); }
  finally { if (priorTimezone === undefined) delete process.env.TZ; else process.env.TZ = priorTimezone; }
  const handles = runBounded('lsof', ['-nP', '-p', String(protectedChrome.pid), '-Fn'], 5000, 64 * 1024);
  assert.ok([0, 1].includes(handles.status), `protected Chrome lsof exited ${handles.status}`);
  const clonePaths = (handles.stdout || '').split(/\r?\n/).filter(line => line.startsWith('n') && line.includes('/code_sign_clone.'))
    .map(line => line.slice(1).slice(0, 2048)).sort();
  return { identity, identityTimezone: 'Asia/Shanghai', lsofExitCode: handles.status, clonePaths };
}

function assertProtectedChrome(snapshot, label, baselineClonePaths = null) {
  assert.equal(snapshot.identity?.pid, protectedChrome.pid, `${label}: protected Chrome PID`);
  assert.equal(snapshot.identity?.startTime.replace(/\s+/g, ' '), protectedChrome.startTime, `${label}: protected Chrome start time`);
  assert.equal(snapshot.identity?.fingerprint, protectedChrome.fingerprint, `${label}: protected Chrome fingerprint`);
  for (const handlePath of snapshot.clonePaths) {
    const relative = path.relative(cacheParent, handlePath);
    const cacheName = relative.split(path.sep)[0];
    assert.ok(relative && !relative.startsWith('..') && expectedCacheNames.includes(cacheName),
      `${label}: protected Chrome handle is under the pre-existing cache set (${handlePath})`);
  }
  if (baselineClonePaths) assert.deepEqual(snapshot.clonePaths, baselineClonePaths, `${label}: protected Chrome clone handles changed during acceptance`);
}

async function cacheNames() { return (await fs.readdir(cacheParent)).filter(name => name.startsWith('code_sign_clone.')).sort(); }

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

async function waitForHttp(url, resourceSession, resourceId, label) {
  const stopAt = Date.now() + 20_000;
  let lastError = 'not ready';
  while (Date.now() < stopAt) {
    const current = (await resourceSession.status()).resources?.find(item => item.id === resourceId);
    if (!current || !['starting', 'running'].includes(current.status)) {
      const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error(`${label} stopped before readiness: ${tail.tail || current?.status || 'missing'}`);
    }
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; lastError = `HTTP ${response.status}`; }
    catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
  throw new Error(`${label} readiness timed out (${lastError}): ${tail.tail || ''}`);
}

async function waitForFile(filePath, timeoutMs = 45_000) {
  const stopAt = Date.now() + timeoutMs;
  while (Date.now() < stopAt) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${filePath}`);
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
    assert.equal(result.status, 0, 'could not inspect process table for isolated Chrome');
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
    assert.ok(pids.length <= 1, `multiple isolated Chrome processes use profile: ${pids.join(',')}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('could not identify isolated Chrome main process');
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

function slotId(date, start, end, projectId) {
  return `slot_${crypto.createHash('sha256').update(`${projectId}\0${date}\0${start}\0${end}`).digest('hex').slice(0, 32)}`;
}
function utc(date, time) { return new Date(`${date}T${time}:00+08:00`).toISOString(); }
function sqlTime(value) { return value.replace('T', ' ').replace(/Z$/, ''); }

async function api(context, route, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${context.baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  return { status: response.status, data };
}
function ok(result, expected, label) {
  assert.equal(result.status, expected, `${label}: ${JSON.stringify(result.data).slice(0, 1000)}`);
  return result.data;
}

async function restartApi(context, instant) {
  context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: instant });
  return context.baseUrl;
}

async function seedEnvironment(context, date, observedAt = firstMorning.before) {
  const demo = makeDemoEnvironment(date, observedAt, DEMO_ENVIRONMENT_LOCATION);
  for (const [domain, stationId, payload] of [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]]) {
    const key = `env:${crypto.createHash('sha256').update(JSON.stringify([DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain])).digest('hex').slice(0, 48)}`;
    const encoded = JSON.stringify(payload);
    const hash = crypto.createHash('sha256').update(encoded).digest('hex');
    await databaseQuery(context, `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,
       payload_hash,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_key) DO UPDATE SET status=excluded.status,source_name=excluded.source_name,source_url=excluded.source_url,
       observed_at=excluded.observed_at,expires_at=excluded.expires_at,payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,updated_at=excluded.updated_at`,
    [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain, payload.sourceName || 'Stage25 本地环境快照', payload.sourceUrl || '',
      sqlTime(observedAt), sqlTime('2026-10-16T00:00:00.000Z'), hash, encoded, sqlTime(observedAt), sqlTime(observedAt)], 'run');
  }
}

async function insertSlot(context, date, start, end, projectId) {
  const id = slotId(date, start, end, projectId);
  await databaseQuery(context, `INSERT INTO activity_slots
    (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 5, 0, ?, ?)
    ON CONFLICT(id) DO UPDATE SET capacity=5,is_closed=0`,
  [id, projectId, date, utc(date, start), utc(date, end), start, end, sqlTime(firstMorning.before), sqlTime(firstMorning.before)], 'run');
  return { id, projectId, date, start, end };
}

async function createReviewSource(context, guest, clinician, slots) {
  const draftId = `wellness_draft_q25_browser_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const itemId = `wellness_item_q25_browser_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const at = sqlTime(firstMorning.before);
  await databaseQuery(context, `INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,
     evidence_json,created_at,review_status,review_thread_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,1,?,NULL,?,?,'pending_review','auto',0,?,?,'pending_review',?,NULL,NULL,NULL)`,
  [draftId, guest.id, `q25-browser:${draftId}`, '2026-10-07', '2026-10-14',
    JSON.stringify({ sourceMode: 'stage25_local_fixture', purpose: 'real approval and correction source for browser-visible care' }), at, draftId], 'run');
  await databaseQuery(context, `INSERT INTO wellness_draft_items
    (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,
     rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
    VALUES(?,?,?,'morning','activity',?,'滨海漫步',?,?,'pending_review',?,'海屿服务区（本地验收）','[]',?,NULL,?)`,
  [itemId, draftId, slots.approval.date, slots.approval.projectId, slots.approval.start, slots.approval.end, '阶段25浏览器中的医护纠正路径。',
    JSON.stringify([{ type: 'project_slot', id: slots.approval.id, label: '真实项目时段' }]), JSON.stringify({ sourceMode: 'stage25_local_fixture' })], 'run');
  const approved = ok(await api(context, `/staff/therapy-drafts/${encodeURIComponent(draftId)}/approve`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': 'q25-browser-approve-0001' }, body: { version: 1 }
  }), 200, 'browser setup actual clinician approval');
  const corrected = ok(await api(context, `/staff/therapy-drafts/${encodeURIComponent(draftId)}/correction`, {
    method: 'POST', token: clinician.token, headers: { 'Idempotency-Key': 'q25-browser-correct-0001' },
    body: { version: 1, reason: '客人日程核对后调整安排。', edits: [{ itemId, slotId: slots.correction.id,
      title: '调整后的滨海漫步', reason: '根据客人实际安排调整时段。' }] }
  }), 200, 'browser setup actual clinician correction');
  return { approvalEventId: approved.eventId, correctionEventId: corrected.eventId };
}

async function prepareBrowserFixture(context) {
  const guestId = 'guest_q25_browser';
  const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
  const initialSql = sqlTime(firstMorning.before);
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,? ,?,'guest',?,'','active',?)`, [guestId, 'q25_browser_guest', source.password_hash, '林海宁（阶段25）', initialSql], 'run');
  await databaseQuery(context, `INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,
    emergency_contact,chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)`, [guestId, '女', '1958-06-18', 'Q25-BROWSER', '2026-10-07', '2026-10-14',
      '', '[]', '[]', '可独立行走', JSON.stringify({}), initialSql], 'run');
  const guestLogin = ok(await api(context, '/auth/login', { method: 'POST', body: {
    username: 'q25_browser_guest', password: 'guest2026', role: 'guest'
  } }), 200, 'browser fixture guest login');
  const clinician = ok(await login(context.baseUrl, 'staff'), 200, 'browser fixture clinician login');
  const dean = await databaseQuery(context, "SELECT id FROM users WHERE role='dean' LIMIT 1", [], 'get');
  await databaseQuery(context, `INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
    VALUES(?,?,?,NULL,'active',?,?,?)`, [clinician.user.id, guestId, initialSql, dean.id, initialSql, initialSql], 'run');
  for (const date of ['2026-10-09', '2026-10-10', '2026-10-11']) await seedEnvironment(context, date);
  const activity = await insertSlot(context, '2026-10-09', '17:30', '18:00', 'project-beach-walk');
  const approval = await insertSlot(context, '2026-10-10', '10:00', '11:00', 'project-marine-hot-spring');
  const correction = await insertSlot(context, '2026-10-10', '11:00', '12:00', 'project-marine-hot-spring');
  const reservation = ok(await api(context, '/reservations', { method: 'POST', token: guestLogin.token,
    headers: { 'Idempotency-Key': 'q25-browser-activity-0001' }, body: { slotId: activity.id } }),
  201, 'browser fixture actual confirmed activity reservation');
  const advice = ok(await api(context, `/staff/guests/${encodeURIComponent(guestId)}/advice`, { method: 'POST', token: clinician.token,
    body: { title: '活动前随身补水', content: '这是工作人员实际发布的医护建议，请按现场安排执行。', priority: 'important' }
  }), 201, 'browser fixture actual advice');
  const menu = ok(await api(context, '/meals/menus', { method: 'POST', token: guestLogin.token,
    body: { businessDate: '2026-10-09' } }), 201, 'browser fixture actual menu');
  const dinner = ok(await api(context, '/meals/orders', { method: 'POST', token: guestLogin.token,
    headers: { 'Idempotency-Key': 'q25-browser-dinner-0001' },
    body: { menuId: menu.menu.id, businessDate: '2026-10-09', mealType: 'dinner', version: menu.menu.version }
  }), 201, 'browser fixture actual dinner order');
  const review = await createReviewSource(context, { id: guestId, token: guestLogin.token }, clinician, { approval, correction });

  await restartApi(context, firstMorning.after);
  await restartApi(context, firstMorning.action);
  const firstMood = ok(await api(context, '/me/moods', { method: 'POST', token: guestLogin.token,
    body: { score: 1, note: '浏览器验收第一天的低分记录。' } }), 201, 'browser fixture day one mood');
  await restartApi(context, secondMorning.before);
  await restartApi(context, secondMorning.after);
  await restartApi(context, secondMorning.action);
  const secondMood = ok(await api(context, '/me/moods', { method: 'POST', token: guestLogin.token,
    body: { score: 2, note: '浏览器验收第二天的低分记录。' } }), 201, 'browser fixture day two mood');
  await restartApi(context, thirdMorning.before);
  await restartApi(context, thirdMorning.after);
  await restartApi(context, thirdMorning.action);
  const thirdMood = ok(await api(context, '/me/moods', { method: 'POST', token: guestLogin.token,
    body: { score: 1, note: '浏览器验收第三天的低分记录。' } }), 201, 'browser fixture day three mood');
  await restartApi(context, finalClock);
  const brief = ok(await api(context, '/me/daily-brief', { token: guestLogin.token }), 200, 'browser fixture current daily brief');
  assert.equal(brief.status, 'ready');
  const focus = await databaseQuery(context, `SELECT id,source_record_ids_json AS sourceIds FROM mood_focus_items
    WHERE guest_id=? AND status='open' ORDER BY id DESC LIMIT 1`, [guestId], 'get');
  assert.ok(focus?.id, 'browser fixture generated a real three-day mood focus item');
  assert.ok(review.correctionEventId, 'browser fixture used the real clinician correction route');
  const taskRows = await databaseQuery(context, `SELECT source_type AS sourceType,source_id AS sourceId FROM care_follow_up_tasks
    WHERE guest_id=? AND assignee_id=?`, [guestId, clinician.user.id], 'all');
  assert.ok(taskRows.some(item => item.sourceType === 'mood_focus_item' && item.sourceId === String(focus.id)));
  assert.ok(taskRows.some(item => item.sourceType === 'wellness_review_event' && item.sourceId === review.correctionEventId));
  const environmentSourceId = brief.brief.environment.find(item => item.domain === 'weather')?.sourceId;
  const dinnerMeal = brief.brief.meals.find(item => item.mealType === 'dinner');
  assert.ok(environmentSourceId, 'weather source snapshot has a saved ID');
  assert.ok(dinnerMeal?.items?.length, 'dinner order contains saved menu items');
  return {
    guestId, guestName: guestLogin.user.name, username: 'q25_browser_guest', briefId: brief.id,
    activityId: reservation.reservation.id, activityName: '沙滩漫步', adviceId: advice.id, adviceTitle: '活动前随身补水',
    mealOrderId: dinner.order.id, dinnerLabel: dinnerMeal.items.join('、'), environmentSourceId, businessClockNow: finalClock,
    moodIds: [firstMood.id, secondMood.id, thirdMood.id], moodFocusId: String(focus.id), correctionEventId: review.correctionEventId,
    clinicianUsername: clinician.user.username, firstNotificationId: null
  };
}

export async function runStage25BrowserAcceptance({ resourceSession }) {
  assert.ok(taskId, 'Stage25 browser acceptance requires CODEX_TASK_ID');
  assert.ok(resourceSession, 'Stage25 browser acceptance requires the active ResourceSession');
  const npx = runBounded('bash', ['-lc', 'command -v npx'], 5000, 16 * 1024);
  assert.equal(npx.status, 0, 'npx must be available for bundled Playwright CLI');
  const cacheBaseline = await cacheNames();
  assert.deepEqual(cacheBaseline, expectedCacheNames, 'protected Chrome code-sign cache set must match the inherited baseline');
  const protectedBefore = userChromeSnapshot();
  assertProtectedChrome(protectedBefore, 'before Stage25 browser');
  const protectedClonePaths = [...protectedBefore.clonePaths];
  const config = JSON.parse(await fs.readFile(playwrightConfigPath, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config must have one merged disable-features argument');
  assert.ok(featureArgs[0].split('=')[1].split(',').includes('MacAppCodeSignClone'), 'merged Chrome flags preserve MacAppCodeSignClone');

  await fs.mkdir(screenshotRoot, { recursive: true });
  let suffix = 1;
  let screenshotDirectory = path.join(screenshotRoot, `stage25-${taskId}-${String(suffix).padStart(2, '0')}`);
  while (fsSync.existsSync(screenshotDirectory)) screenshotDirectory = path.join(screenshotRoot, `stage25-${taskId}-${String(++suffix).padStart(2, '0')}`);
  await fs.mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  const screenshots = { home1280: path.join(screenshotDirectory, 'q25-daily-brief-home-1280.png'),
    home1920: path.join(screenshotDirectory, 'q25-daily-brief-home-1920.png'),
    staffTasks: path.join(screenshotDirectory, 'q25-staff-care-follow-ups.png') };
  const evidencePath = path.join(screenshotDirectory, 'stage25-browser-evidence.json');
  const evidence = { schemaVersion: 1, taskId, worktree: projectRoot, observedAt: new Date().toISOString(), status: 'RUNNING',
    browserConfigPath: playwrightConfigPath, browserConfigFeatureArg: featureArgs[0], cacheParent,
    protectedChromeBaseline: protectedChrome, cacheSnapshots: [{ label: 'before-browser', names: cacheBaseline }],
    protectedChromeSnapshots: [{ label: 'before-browser', ...protectedBefore }], resources: [], cliSteps: [], screenshots,
    businessClock: finalClock, limits: { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 },
    dfBefore: dfSnapshot('before-browser') };
  let browserOwner;
  let viteResource;
  let browserOpened = false;
  let chrome;
  let cliDirectory;
  let socketAlias;
  let socketAliasCreated = false;
  let sessionName;
  let result;
  let failure;

  async function runCli(args, label, timeoutMs = 60_000) {
    const resource = await resourceSession.startProcess({ label, kind: 'browser', role: 'browser-cli', command: 'bash',
      args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfigPath] : []), '--session', sessionName, ...args],
      cwd: cliDirectory, env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias } });
    let stopped = await resourceSession.waitProcess(resource.id, timeoutMs);
    if (stopped.timedOut) {
      await resourceSession.stop(resource.id, `${label}-timeout`);
      stopped = await resourceSession.waitProcess(resource.id, 15_000);
    }
    const tail = await resourceSession.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    evidence.cliSteps.push({ label, ...resourceSummary(resource), exitCode: stopped.exitCode ?? null,
      signal: stopped.signal || null, timedOut: Boolean(stopped.timedOut), outputTail: String(tail.tail || '').slice(-8192) });
    assert.equal(stopped.status, 'exited', `${label} did not exit cleanly: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(stopped.exitCode, 0, `${label} exit code: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(stopped.signal || null, null, `${label} was signaled`);
    return String(tail.tail || '');
  }

  try {
    sessionName = `stage25-${resourceSession.instanceId.slice(0, 8)}`;
    cliDirectory = await resourceSession.allocateDir('stage25-browser-cli');
    const socketsDirectory = await resourceSession.allocateDir('stage25-playwright-sockets');
    socketAlias = path.join('/tmp', `pw-${resourceSession.instanceId.slice(0, 8)}`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright socket alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDirectory, socketAlias, 'dir');
    socketAliasCreated = true;
    const profilePath = path.join(cliDirectory, 'chrome-profile');
    const openMarker = path.join(cliDirectory, 'open-status.json');
    const ownerPath = path.join(cliDirectory, 'browser-session-owner.mjs');
    const flowPath = path.join(cliDirectory, 'stage25-browser-flow.mjs');

    await withTemporaryApi(async context => {
      const fixtures = await prepareBrowserFixture(context);
      evidence.fixtures = { ...fixtures };
      evidence.apiOrigin = new URL(context.baseUrl).origin;
      const webPort = await availablePort();
      const webUrl = `http://127.0.0.1:${webPort}`;
      viteResource = await resourceSession.startProcess({ label: 'q25-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort, env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1',
          API_PROXY_TARGET: new URL(context.baseUrl).origin, WEB_PORT: String(webPort) } });
      assert.equal(viteResource.status, 'running', 'Stage25 Vite resource started under ResourceSession');
      await waitForHttp(webUrl, resourceSession, viteResource.id, 'Stage25 Vite');
      const ownerSource = `
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
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output=(output+chunk.toString()).slice(-4096); process.stdout.write(chunk); });
child.once('error', error => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code: 1, error: error.message, output })); process.exitCode=1; });
child.once('close', (code, signal) => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({ code, signal, output })); if (code!==0) process.exitCode=1; });
setInterval(() => {}, 1000);
`;
      await fs.writeFile(ownerPath, ownerSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      browserOwner = await resourceSession.startProcess({ label: 'q25-playwright-session-owner', kind: 'browser', role: 'browser-session-owner',
        command: process.execPath, args: [ownerPath], cwd: cliDirectory, env: { PATH: process.env.PATH || '',
          PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfigPath, PLAYWRIGHT_SESSION: sessionName,
          PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: webUrl } });
      assert.equal(browserOwner.status, 'running', 'Playwright session owner started under ResourceSession');
      browserOpened = true;
      const opened = await waitForFile(openMarker);
      evidence.cliSteps.push({ label: 'open', exitCode: opened.code, signal: opened.signal || null,
        status: opened.code === 0 ? 'exited' : 'failed', configPassedOnlyToOpen: true, outputTail: String(opened.output || '').slice(-4096) });
      assert.equal(opened.code, 0, `Playwright open: ${String(opened.output || '').slice(-1200)}`);
      assert.equal(opened.signal || null, null, 'Playwright open was signaled');
      chrome = await isolatedChrome(profilePath);
      assert.notEqual(chrome.pid, protectedChrome.pid, 'isolated browser is separate from protected user Chrome');
      assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Chrome uses the managed isolated profile');
      const disableArgs = chrome.command.match(/--disable-features=[^\s]+/g) || [];
      assert.deepEqual(disableArgs, [featureArgs[0]], 'isolated Chrome uses the single merged configured launch flag');
      evidence.chrome = { pid: chrome.pid, startTime: chrome.startTime, fingerprint: chrome.fingerprint,
        processGroup: chrome.pgid, profilePath, effectiveDisableFeatures: disableArgs[0] };
      const protectedDuring = userChromeSnapshot();
      assertProtectedChrome(protectedDuring, 'during Stage25 browser', protectedClonePaths);
      evidence.protectedChromeSnapshots.push({ label: 'during-browser', ...protectedDuring });
      assert.deepEqual(await cacheNames(), expectedCacheNames, 'isolated browser did not create or remove inherited cache entries');
      evidence.cacheSnapshots.push({ label: 'during-browser-open', names: await cacheNames() });
      await runCli(['snapshot'], 'q25-playwright-initial-snapshot', 30_000);

      const flow = (await fs.readFile(new URL('./stage25-browser-flow.js', import.meta.url), 'utf8'))
        .replace('__WEB_URL__', JSON.stringify(webUrl)).replace('__SCREENSHOTS__', JSON.stringify(screenshots))
        .replace('__FIXTURES__', JSON.stringify(fixtures));
      await fs.writeFile(flowPath, flow, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const output = await runCli(['run-code', '--filename', flowPath], 'q25-playwright-business-flow', 240_000);
      const resultLine = output.match(/STAGE25_BROWSER_RESULT:(\{[^\r\n]*\})/);
      assert.ok(resultLine, `browser flow omitted structured evidence: ${output.slice(-2400)}`);
      evidence.browserFlow = JSON.parse(resultLine[1]);
      evidence.browserFlowOutputBytes = Buffer.byteLength(output, 'utf8');
      evidence.cacheSnapshots.push({ label: 'after-browser-flow', names: await cacheNames() });
      const protectedAfter = userChromeSnapshot();
      assertProtectedChrome(protectedAfter, 'after Stage25 browser flow', protectedClonePaths);
      assert.deepEqual(protectedAfter.clonePaths, protectedBefore.clonePaths, 'protected Chrome clone handles unchanged');
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-flow', ...protectedAfter });
      for (const file of Object.values(screenshots)) await fs.access(file);
      const closed = await runCli(['close'], 'q25-playwright-close', 30_000);
      browserOpened = false;
      evidence.cliSteps.push({ label: 'close-session', status: 'exited', exitCode: 0, configPassedOnlyToOpen: true, outputTail: closed.slice(-4096) });
      const deadline = Date.now() + 15_000;
      while (processMatches(chrome.pid, chrome) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
      assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `isolated Chrome PID ${chrome.pid} remains after close`);
      const protectedAfterClose = userChromeSnapshot();
      assertProtectedChrome(protectedAfterClose, 'after Stage25 browser close', protectedClonePaths);
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-close', ...protectedAfterClose });
      evidence.cacheSnapshots.push({ label: 'after-browser-close', names: await cacheNames() });
      result = { ...evidence.browserFlow, evidencePath, screenshotDirectory, dfBefore: evidence.dfBefore };
    }, 'haiyu-stage25-browser-', { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: firstMorning.before }, { resourceSession });
  } catch (error) {
    failure = error;
    if (browserOpened && cliDirectory && socketAlias) {
      try { await runCli(['close'], 'q25-playwright-failure-close', 30_000); browserOpened = false; }
      catch { /* outer cleanup retries through the owned session process */ }
    }
  } finally {
    for (const [resource, reason] of [[browserOwner, 'q25-browser-owner-cleanup'], [viteResource, 'q25-vite-cleanup']]) {
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
      } catch (error) { evidence.cleanupError ||= `socket alias cleanup: ${error.message}`; }
    }
    try {
      evidence.dfAfter = dfSnapshot('after-browser');
      evidence.cacheSnapshots.push({ label: 'after-browser-cleanup', names: await cacheNames() });
      const protectedAfterCleanup = userChromeSnapshot();
      assertProtectedChrome(protectedAfterCleanup, 'after browser cleanup', protectedClonePaths);
      assert.deepEqual(protectedAfterCleanup.clonePaths, protectedBefore.clonePaths, 'protected Chrome handles unchanged after cleanup');
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-cleanup', ...protectedAfterCleanup });
      if (chrome) {
        evidence.chrome.exactIdentityExitedAfterCleanup = !processMatches(chrome.pid, chrome);
        assert.equal(evidence.chrome.exactIdentityExitedAfterCleanup, true, `isolated Chrome PID ${chrome.pid} remains after cleanup`);
      }
      const session = await resourceSession.status();
      evidence.sessionResourcesAtExit = (session.resources || []).map(resourceSummary);
      evidence.liveBrowserResourcesAfterCleanup = evidence.sessionResourcesAtExit.filter(item =>
        ['starting', 'running'].includes(item.status) && ['api', 'vite', 'browser', 'stub'].includes(item.kind)
        && !String(item.label || '').includes('q25-mysql'));
      assert.equal(evidence.liveBrowserResourcesAfterCleanup.length, 0,
        `Stage25 API/Vite/browser resources remain active: ${JSON.stringify(evidence.liveBrowserResourcesAfterCleanup)}`);
    } catch (error) { evidence.cleanupError ||= `final resources: ${error.message}`; }
    evidence.status = failure || evidence.cleanupError ? 'FAIL' : 'PASS';
    evidence.failure = failure ? String(failure.stack || failure.message || failure).slice(0, 14_000) : null;
    evidence.observedAtEnd = new Date().toISOString();
    const encodedEvidence = JSON.stringify(evidence, null, 2);
    assert.ok(Buffer.byteLength(encodedEvidence) <= 2 * 1024 * 1024, 'Stage25 browser evidence stays under 2 MiB');
    await fs.writeFile(evidencePath, encodedEvidence, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  if (failure) throw failure;
  assert.equal(evidence.cleanupError, undefined, `browser cleanup failed: ${evidence.cleanupError}`);
  return { ...result, resources: evidence.resources, dfBefore: evidence.dfBefore, dfAfter: evidence.dfAfter };
}
