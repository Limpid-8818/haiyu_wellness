import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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
const taskId = process.env.CODEX_TASK_ID;
const cliWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const cliConfig = path.join(projectRoot, 'scripts/resources/playwright-cli.config.json');
const screenshotRoot = path.join(projectRoot, 'output/playwright');
const baseInstant = '2026-10-09T00:00:00.000Z';
const browserInstant = '2026-10-09T02:01:00.000Z';
const checkinInstant = '2026-10-10T06:05:00.000Z';
const today = '2026-10-09';
const tomorrow = '2026-10-10';
const coachDay = '2026-10-09';
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
  const fields = result.stdout.trim().split(/\r?\n/).at(-1).trim().split(/\s+/);
  assert.ok(fields.length >= 6, 'could not parse /tmp filesystem usage');
  return { label, command: 'df -Pk /tmp', exitCode: result.status, filesystem: fields[0], usedKiB: Number(fields[2]),
    availableKiB: Number(fields[3]), mountedOn: fields.slice(5).join(' '), at: new Date().toISOString() };
}
function protectedChromeSnapshot() {
  const oldTz = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  let identity;
  try { identity = processIdentity(protectedChrome.pid); }
  finally { if (oldTz === undefined) delete process.env.TZ; else process.env.TZ = oldTz; }
  const handles = runBounded('lsof', ['-nP', '-p', String(protectedChrome.pid), '-Fn'], 5000, 64 * 1024);
  assert.ok([0, 1].includes(handles.status), `protected Chrome lsof exited ${handles.status}`);
  const clonePaths = (handles.stdout || '').split(/\r?\n/).filter(line => line.startsWith('n') && line.includes('/code_sign_clone.'))
    .map(line => line.slice(1).slice(0, 2048)).sort();
  return { identity, lsofExitCode: handles.status, clonePaths };
}
function assertProtectedChrome(snapshot, label, priorPaths = null) {
  assert.equal(snapshot.identity?.pid, protectedChrome.pid, `${label}: protected Chrome PID`);
  assert.equal(snapshot.identity?.startTime.replace(/\s+/g, ' '), protectedChrome.startTime, `${label}: protected Chrome start time`);
  assert.equal(snapshot.identity?.fingerprint, protectedChrome.fingerprint, `${label}: protected Chrome fingerprint`);
  for (const name of snapshot.clonePaths) {
    const relative = path.relative(cacheParent, name);
    assert.ok(relative && !relative.startsWith('..') && expectedCacheNames.includes(relative.split(path.sep)[0]),
      `${label}: Chrome handle is under a pre-existing cache path (${name})`);
  }
  if (priorPaths) assert.deepEqual(snapshot.clonePaths, priorPaths, `${label}: protected Chrome handles changed`);
}
function assertGeneratedPageFunctionParses(source, label) {
  try { new Function(`return (${source});`); }
  catch (error) { throw new SyntaxError(`${label} generated browser flow is invalid: ${error.message}`); }
}
async function cacheNames() { return (await fs.readdir(cacheParent)).filter(name => name.startsWith('code_sign_clone.')).sort(); }
async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address()?.port;
      server.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('could not reserve loopback port'))); });
  });
}
async function waitForFile(filePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
async function waitForHttp(url, resourceSession, resourceId) {
  const deadline = Date.now() + 20_000;
  let last = 'not ready';
  while (Date.now() < deadline) {
    const current = (await resourceSession.status()).resources?.find(item => item.id === resourceId);
    if (!current || !['starting', 'running'].includes(current.status)) {
      const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error(`Vite stopped before readiness: ${tail.tail || current?.status || 'missing'}`);
    }
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; last = `HTTP ${response.status}`; }
    catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Vite readiness timeout (${last})`);
}
function sqlTime(value) { return value.replace('T', ' ').replace(/Z$/, ''); }
function slotId(projectId, date, start, end) {
  return `slot_${crypto.createHash('sha256').update(`${projectId}\0${date}\0${start}\0${end}`).digest('hex').slice(0, 32)}`;
}
function utc(date, time) { return new Date(`${date}T${time}:00+08:00`).toISOString(); }
async function api(context, route, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(`${context.baseUrl}${route}`, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers
  }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`${method} ${route} returned non-JSON HTTP ${response.status}`); }
  assert.ok(response.ok, `${method} ${route} returned ${response.status}: ${JSON.stringify(data).slice(0, 900)}`);
  return data;
}
async function seedEnvironment(context, date) {
  const demo = makeDemoEnvironment(date, baseInstant, DEMO_ENVIRONMENT_LOCATION);
  for (const [domain, stationId, payload] of [['weather', '', demo.weather], ['tide', DEMO_ENVIRONMENT_LOCATION.tideStationId, demo.tide], ['marine', '', demo.marine]]) {
    const key = `env:${crypto.createHash('sha256').update(JSON.stringify([DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain])).digest('hex').slice(0, 48)}`;
    const encoded = JSON.stringify(payload); const hash = crypto.createHash('sha256').update(encoded).digest('hex');
    await databaseQuery(context, `INSERT INTO environment_snapshots
      (snapshot_key,location_id,station_id,target_date,domain,status,source_name,source_url,observed_at,expires_at,
       payload_hash,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,'demo',?,?,?,?,?,?,?,?)
      ON CONFLICT(snapshot_key) DO UPDATE SET status=excluded.status,source_name=excluded.source_name,source_url=excluded.source_url,
       observed_at=excluded.observed_at,expires_at=excluded.expires_at,payload_hash=excluded.payload_hash,payload_json=excluded.payload_json,
      updated_at=excluded.updated_at`, [key, DEMO_ENVIRONMENT_LOCATION.id, stationId, date, domain,
      '阶段26隔离网页快照', payload.sourceUrl || '', sqlTime(baseInstant), sqlTime('2026-10-16T00:00:00.000Z'), hash, encoded, sqlTime(baseInstant), sqlTime(baseInstant)], 'run');
  }
}
async function insertSlot(context, date, start, end, projectId) {
  const id = slotId(projectId, date, start, end);
  await databaseQuery(context, `INSERT INTO activity_slots
    (id,project_id,business_date,starts_at,ends_at,local_start,local_end,capacity,is_closed,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,5,0,?,?) ON CONFLICT(id) DO UPDATE SET capacity=5,is_closed=0`,
  [id, projectId, date, utc(date, start), utc(date, end), start, end, sqlTime(baseInstant), sqlTime(baseInstant)], 'run');
  return { id, projectId, date, start, end };
}
async function prepareFixtures(context, fixtureBase, { stage27 = false } = {}) {
  const deanLogin = await login(context.baseUrl, 'dean');
  assert.equal(deanLogin.status, 200, 'seeded dean login');
  const dean = { id: deanLogin.data.user.id, token: deanLogin.data.token };
  const createStaff = async (username, name, jobType) => {
    const created = await api(context, '/dean/staff', { method: 'POST', token: dean.token,
      body: { name, username, phone: '', password: 'Stage26-browser-pass', jobType } });
    const signed = await api(context, '/auth/login', { method: 'POST', body: { username, password: 'Stage26-browser-pass', role: 'staff' } });
    return { id: created.id, username, name, jobType, token: signed.token };
  };
  const clinician = await createStaff('stage26_browser_clinician', '階段26醫護', 'clinician');
  const outsiderClinician = await createStaff('stage26_browser_unassigned_clinician', '階段26非负责医护', 'clinician');
  const coach = await createStaff('stage26_browser_coach', 'A Stage27 browser coach', 'coach');
  const therapist = await createStaff('stage26_browser_therapist', '階段26理疗师', 'therapist');
  const dietitian = await createStaff('stage26_browser_dietitian', '阶段26配餐员', 'dietitian');
  const administrator = await createStaff('stage26_browser_administrator', '阶段26运营管理员', 'administrator');
  const disabledCandidate = await createStaff('stage27_browser_disabled', '阶段27停用账号验证', 'coach');
  const source = await databaseQuery(context, "SELECT password_hash FROM users WHERE id='guest_001'", [], 'get');
  const guestId = 'guest_stage26_browser'; const guestName = '网页验收客人阶段26'; const username = 'stage26_browser_guest';
  const stamp = sqlTime(baseInstant);
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,?,?,'guest',?,'','active',?)`, [guestId, username, source.password_hash, guestName, stamp], 'run');
  await databaseQuery(context, `INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,
    chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at)
    VALUES(?,'女','1949-05-01','Q26-WEB','2026-10-09','2026-10-16','[]',?,?,?,0,?)`,
  [guestId, JSON.stringify(['磺胺类']), '可独立行走', JSON.stringify({ allergies: { status: 'reported', items: ['磺胺类'] }, mobility: { status: 'independent' } }), stamp], 'run');
  const guestLogin = await api(context, '/auth/login', { method: 'POST', body: { username, password: 'guest2026', role: 'guest' } });
  const guest = { id: guestId, name: guestName, username, token: guestLogin.token };
  const dietGuestId = 'guest_stage26_browser_dietitian'; const dietGuestName = '配餐岗位订单客人阶段26'; const dietGuestUsername = 'stage26_browser_diet_guest';
  await databaseQuery(context, `INSERT INTO users(id,username,password_hash,role,name,phone,status,created_at)
    VALUES(?,?,?,'guest',?,'','active',?)`, [dietGuestId, dietGuestUsername, source.password_hash, dietGuestName, stamp], 'run');
  await databaseQuery(context, `INSERT INTO guest_profiles(user_id,gender,birth_date,room_no,check_in,check_out,
    chronic_json,allergies_json,mobility,health_profile_json,health_profile_version,updated_at)
    VALUES(?,'女','1949-05-01','Q26-DIET','2026-10-09','2026-10-16','[]','[]','可独立行走',?,0,?)`,
  [dietGuestId, JSON.stringify({ allergies: { status: 'none', items: [] }, mobility: { status: 'independent' } }), stamp], 'run');
  const dietGuestLogin = await api(context, '/auth/login', { method: 'POST', body: { username: dietGuestUsername, password: 'guest2026', role: 'guest' } });
  const dietGuest = { id: dietGuestId, name: dietGuestName, username: dietGuestUsername, token: dietGuestLogin.token };
  await databaseQuery(context, `INSERT INTO staff_guest_assignments
    (staff_id,guest_id,start_at,end_at,status,created_by,created_at,updated_at)
    VALUES(?,?,?,NULL,'active',?,?,?)`, [clinician.id, guestId, stamp, dean.id, stamp, stamp], 'run');
  await api(context, `/dean/guests/${encodeURIComponent(dietGuestId)}/assignments`, { method: 'POST', token: dean.token,
    body: { staffId: dietitian.id } });
  await databaseQuery(context, `INSERT INTO health_records(guest_id,record_type,value,unit,note,recorded_at,recorded_by)
    VALUES(?,'blood_pressure','128/78','mmHg','阶段26网页只读历史',?,?)`, [guestId, stamp, clinician.id], 'run');
  const draftId = 'wellness_draft_q26_browser_clinician'; const itemId = 'wellness_item_q26_browser_clinician';
  await databaseQuery(context, `INSERT INTO wellness_drafts
    (id,guest_id,version,request_key,source_run_id,stay_start,stay_end,status,review_policy,review_sample_percent,evidence_json,created_at,
     review_status,review_thread_id,review_reason,reviewed_by,reviewed_at)
    VALUES(?,?,1,?,NULL,?,'2026-10-16','pending_review','auto',0,?,?,'pending_review',?,NULL,NULL,NULL)`,
  [draftId, guestId, `q26:${draftId}`, today, JSON.stringify({ sourceMode: 'stage26_local_fixture', ruleIds: ['R2'], riskCategory: 'allergy' }), stamp, draftId], 'run');
  await databaseQuery(context, `INSERT INTO wellness_draft_items
    (id,draft_id,business_date,slot_key,item_type,candidate_id,title,local_start,local_end,status,reason,location,rule_ids_json,source_ids_json,environment_snapshot_id,evidence_json)
    VALUES(?,?,?,'afternoon','activity','project-sea-bath','海水浴体验计划','14:00','15:00','mandatory_review',?,?,'["R2"]','[]',NULL,?)`,
  [itemId, draftId, tomorrow, '存在待核实健康风险，需医护复核。', '东湾体验区', JSON.stringify({ sourceMode: 'stage26_local_fixture' })], 'run');
  await seedEnvironment(context, today);
  await seedEnvironment(context, tomorrow);
  await seedEnvironment(context, '2026-10-11');
  await seedEnvironment(context, '2026-10-12');
  const noShowSlot = await insertSlot(context, today, '09:00', '10:00', 'project-sea-bath');
  const weatherSlot = await insertSlot(context, today, '14:00', '15:00', 'project-sea-bath');
  const alternateSlot = await insertSlot(context, today, '15:00', '16:00', 'project-sea-bath');
  const metricSlot = await insertSlot(context, tomorrow, '14:00', '15:00', 'project-sea-bath');
  const personaSlots = stage27 ? await Promise.all(Array.from({ length: 3 }, () =>
    insertSlot(context, tomorrow, '14:00', '15:00', 'project-sea-bath'))) : [];
  const noShowBooking = await api(context, '/reservations', { method: 'POST', token: guest.token,
    headers: { 'Idempotency-Key': 'stage26-browser-no-show-001' }, body: { slotId: noShowSlot.id } });
  const weatherBooking = await api(context, '/reservations', { method: 'POST', token: guest.token,
    headers: { 'Idempotency-Key': 'stage26-browser-weather-001' }, body: { slotId: weatherSlot.id } });
  const therapistSlot = await insertSlot(context, '2026-10-11', '10:00', '11:00', 'project-sea-bath');
  await api(context, `/admin/operations/slots/${encodeURIComponent(therapistSlot.id)}/assignments`, { method: 'POST', token: dean.token,
    body: { staffId: therapist.id, jobType: 'therapist' } });
  const therapistBooking = await api(context, '/reservations', { method: 'POST', token: guest.token,
    headers: { 'Idempotency-Key': 'stage26-browser-therapist-booking-001' }, body: { slotId: therapistSlot.id } });
  const mealMenu = await api(context, '/meals/menus', { method: 'POST', token: dietGuest.token,
    body: { businessDate: '2026-10-11' } });
  const mealOrder = await api(context, '/meals/orders', { method: 'POST', token: dietGuest.token,
    headers: { 'Idempotency-Key': 'stage26-browser-dietitian-order-001' },
    body: { menuId: mealMenu.menu.id, businessDate: '2026-10-11', mealType: 'lunch', version: mealMenu.menu.version } });
  const preAdvice = await api(context, '/me/advice', { token: guest.token });
  return { dean, clinician, outsiderClinician, coach, therapist, dietitian, administrator, disabledCandidate, guest, dietGuest, draftId, itemId, weatherSlot, alternateSlot,
    therapistSlot, therapistReservationId: therapistBooking.reservation.id, mealOrderId: mealOrder.order.id, metricSlot, personaSlots,
    noShowReservationId: noShowBooking.reservation.id, weatherReservationId: weatherBooking.reservation.id,
    noAdviceCount: preAdvice.length, fixtureBase };
}
function resourceSummary(resource) {
  if (!resource) return null;
  return { id: resource.id, label: resource.label, kind: resource.kind, role: resource.role, status: resource.status,
    pid: resource.pid, processGroup: resource.processGroup, processStartTime: resource.processStartTime,
    processFingerprint: resource.processFingerprint, command: resource.command, cwd: resource.cwd, tempDir: resource.tempDir,
    port: resource.port, logPath: resource.logPath, logBytes: resource.logBytes, maxLogBytes: resource.maxLogBytes,
    directoryPeakBytes: resource.directoryPeakBytes, maxDirectoryBytes: resource.maxDirectoryBytes, leaseExpiresAt: resource.leaseExpiresAt,
    pids: resource.pids };
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
function chromeCommandLine(pid) {
  const result = runBounded('ps', ['-ww', '-p', String(pid), '-o', 'command='], 3000, 64 * 1024);
  assert.equal(result.status, 0, `could not inspect isolated Chrome ${pid}`);
  return result.stdout.trim();
}
async function identifyIsolatedChrome(profilePath) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = runBounded('ps', ['-ww', '-Ao', 'pid=,command='], 4000, 1024 * 1024);
    assert.equal(result.status, 0, 'could not inspect process table');
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
    assert.ok(pids.length <= 1, `multiple isolated Chrome processes use profile ${profilePath}: ${pids.join(',')}`);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error('could not identify isolated Chrome main process');
}

export async function runStage26BrowserAcceptance({ resourceSession, fixtureBase, artifactPrefix = 'stage26', runId = null, codeFingerprint = null }) {
  assert.ok(taskId && resourceSession && fixtureBase, 'Stage26 browser acceptance requires task, ResourceSession and local fixture');
  assert.ok(['stage26', 'stage27'].includes(artifactPrefix), `unsupported browser evidence prefix ${artifactPrefix}`);
  const imagePrefix = artifactPrefix === 'stage27' ? 'q27' : 'q26';
  const cli = runBounded('bash', ['-lc', 'command -v npx'], 5000, 16 * 1024);
  assert.equal(cli.status, 0, 'npx must be available for the bundled Playwright CLI');
  const cacheBaseline = await cacheNames();
  assert.deepEqual(cacheBaseline, expectedCacheNames, 'protected Chrome cache inventory must match the inherited baseline');
  const protectedBefore = protectedChromeSnapshot(); assertProtectedChrome(protectedBefore, 'before Stage26 browser');
  const protectedClonePaths = [...protectedBefore.clonePaths];
  const config = JSON.parse(await fs.readFile(cliConfig, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config must contain one merged Chrome feature flag');
  assert.ok(featureArgs[0].split('=')[1].split(',').includes('MacAppCodeSignClone'), 'Chrome flag preserves MacAppCodeSignClone');
  await fs.mkdir(screenshotRoot, { recursive: true });
  const runSlug = runId ? `-${String(runId).replace(/[^A-Za-z0-9_-]/gu, '-').slice(0, 80)}` : '';
  let suffix = 1; let screenshotDirectory = path.join(screenshotRoot, `${artifactPrefix}-${taskId}${runSlug}-${String(suffix).padStart(2, '0')}`);
  while (fsSync.existsSync(screenshotDirectory)) screenshotDirectory = path.join(screenshotRoot, `${artifactPrefix}-${taskId}${runSlug}-${String(++suffix).padStart(2, '0')}`);
  await fs.mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  const screenshots = { operations1280: path.join(screenshotDirectory, `${imagePrefix}-operations-1280.png`),
    operations1920: path.join(screenshotDirectory, `${imagePrefix}-operations-1920.png`),
    reservationDay: path.join(screenshotDirectory, `${imagePrefix}-reservations-day.png`),
    reservationWeek: path.join(screenshotDirectory, `${imagePrefix}-reservations-project-week.png`),
    reservationWeekAfter: path.join(screenshotDirectory, `${imagePrefix}-reservations-project-week-after-cancel.png`),
    therapistSchedule: path.join(screenshotDirectory, `${imagePrefix}-therapist-schedule.png`),
    dietitianOrders: path.join(screenshotDirectory, `${imagePrefix}-dietitian-orders.png`),
    clinicianAssistant: path.join(screenshotDirectory, `${imagePrefix}-clinician-assistant.png`),
    adminAssistant: path.join(screenshotDirectory, `${imagePrefix}-admin-capacity-assistant.png`),
    metricsDrilldown: path.join(screenshotDirectory, `${imagePrefix}-live-metrics-drilldown.png`),
    guestAdvice: path.join(screenshotDirectory, `${imagePrefix}-guest-published-advice.png`),
    ...(artifactPrefix === 'stage27' ? {
      publicNewsHome: path.join(screenshotDirectory, 'q27-public-news-home.png'),
      publicNewsDetail: path.join(screenshotDirectory, 'q27-public-news-detail.png'),
      legacyGuestProfile: path.join(screenshotDirectory, 'q27-legacy-guest-profile.png'),
      legacyHealthRecords: path.join(screenshotDirectory, 'q27-legacy-health-records.png'),
      legacyAssistant: path.join(screenshotDirectory, 'q27-legacy-assistant.png'),
      persona1Profile: path.join(screenshotDirectory, 'q27-persona-1-profile.png'),
      persona1Identity: path.join(screenshotDirectory, 'q27-persona-1-readonly-identity.png'),
      persona1Plan: path.join(screenshotDirectory, 'q27-persona-1-plan.png'),
      persona1Booking: path.join(screenshotDirectory, 'q27-persona-1-booking.png'),
      persona2Profile: path.join(screenshotDirectory, 'q27-persona-2-profile.png'),
      persona2Plan: path.join(screenshotDirectory, 'q27-persona-2-plan.png'),
      persona2Booking: path.join(screenshotDirectory, 'q27-persona-2-booking.png'),
      persona3Profile: path.join(screenshotDirectory, 'q27-persona-3-profile.png'),
      persona3Identity: path.join(screenshotDirectory, 'q27-persona-3-readonly-identity.png'),
      persona3Plan: path.join(screenshotDirectory, 'q27-persona-3-plan.png'),
      persona3Booking: path.join(screenshotDirectory, 'q27-persona-3-booking.png'),
      persona1Checkin: path.join(screenshotDirectory, 'q27-persona-1-checkin-feedback.png'),
      persona2Checkin: path.join(screenshotDirectory, 'q27-persona-2-checkin-feedback.png'),
      persona3Checkin: path.join(screenshotDirectory, 'q27-persona-3-checkin-feedback.png'),
      clinicianApprovals: path.join(screenshotDirectory, 'q27-clinician-approvals.png')
    } : {}) };
  const evidencePath = path.join(screenshotDirectory, `${artifactPrefix}-browser-evidence.json`);
  const evidence = { schemaVersion: 1, taskId, runId, codeFingerprint, worktree: projectRoot, observedAt: new Date().toISOString(), status: 'RUNNING',
    browserConfigPath: cliConfig, browserConfigFeatureArg: featureArgs[0], cacheParent,
    protectedChromeBaseline: protectedChrome, cacheSnapshots: [{ label: 'before-browser', names: cacheBaseline }],
    protectedChromeSnapshots: [{ label: 'before-browser', ...protectedBefore }], resources: [], cliSteps: [], screenshots,
    businessClock: browserInstant, limits: { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 },
    dfBefore: dfSnapshot('before-browser') };
  let browserOwner; let viteResource; let browserOpened = false; let chrome; let cliDirectory; let socketAlias;
  let socketAliasCreated = false; let sessionName; let fixtures; let flowResult; let failure; let cleanupError;
  async function runCli(args, label, timeoutMs = 60_000) {
    const resource = await resourceSession.startProcess({ label, kind: 'browser', role: 'browser-cli', command: 'bash',
      args: [cliWrapper, ...(args[0] === 'open' ? ['--config', cliConfig] : []), '--session', sessionName, ...args],
      cwd: cliDirectory, env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias } });
    let stopped = await resourceSession.waitProcess(resource.id, timeoutMs);
    if (stopped.timedOut) { await resourceSession.stop(resource.id, `${label}-timeout`); stopped = await resourceSession.waitProcess(resource.id, 15_000); }
    const tail = await resourceSession.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    evidence.cliSteps.push({ label, ...resourceSummary(resource), exitCode: stopped.exitCode ?? null,
      signal: stopped.signal || null, timedOut: Boolean(stopped.timedOut), outputTail: String(tail.tail || '').slice(-8192) });
    assert.equal(stopped.status, 'exited', `${label} did not exit: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(stopped.exitCode, 0, `${label} exit code: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(stopped.signal || null, null, `${label} was signaled`);
    return String(tail.tail || '');
  }
  try {
    sessionName = `stage26-${resourceSession.instanceId.slice(0, 8)}`;
    cliDirectory = await resourceSession.allocateDir('stage26-browser-cli');
    const socketsDirectory = await resourceSession.allocateDir('stage26-playwright-sockets');
    socketAlias = path.join('/tmp', `pw-${resourceSession.instanceId.slice(0, 8)}`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright socket alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDirectory, socketAlias, 'dir'); socketAliasCreated = true;
    const profilePath = path.join(cliDirectory, 'chrome-profile');
    const openMarker = path.join(cliDirectory, 'open-status.json');
    const ownerPath = path.join(cliDirectory, 'browser-session-owner.mjs');
    const flowPath = path.join(cliDirectory, 'stage26-browser-flow.mjs');
    await withTemporaryApi(async context => {
      fixtures = await prepareFixtures(context, fixtureBase, { stage27: artifactPrefix === 'stage27' });
      context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: browserInstant });
      evidence.fixtures = { guestId: fixtures.guest.id, guestName: fixtures.guest.name, reservationIds: {
        noShow: fixtures.noShowReservationId, weather: fixtures.weatherReservationId },
        sourceDraftId: fixtures.draftId, appointments: [fixtures.weatherSlot.id, fixtures.alternateSlot.id] };
      evidence.apiOrigin = new URL(context.baseUrl).origin;
      const webPort = await availablePort(); const webUrl = `http://127.0.0.1:${webPort}`;
      viteResource = await resourceSession.startProcess({ label: 'q26-vite', kind: 'vite', role: 'vite', command: 'npm',
        args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
        cwd: projectRoot, port: webPort, env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1',
          API_PROXY_TARGET: new URL(context.baseUrl).origin, WEB_PORT: String(webPort) } });
      assert.equal(viteResource.status, 'running', 'Stage26 Vite resource started under ResourceSession');
      await waitForHttp(webUrl, resourceSession, viteResource.id);
      const ownerSource = `
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const child = spawn('bash', [process.env.PLAYWRIGHT_WRAPPER, '--config', process.env.PLAYWRIGHT_CONFIG, '--session', process.env.PLAYWRIGHT_SESSION,
  'open', process.env.PLAYWRIGHT_URL, '--profile', process.env.PLAYWRIGHT_PROFILE, '--idle-timeout', '0'], {
  cwd: process.cwd(), env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
    PWTEST_SOCKETS_DIR: process.env.PLAYWRIGHT_SOCKETS_DIR, TMPDIR: process.env.PLAYWRIGHT_SOCKETS_DIR,
    TMP: process.env.PLAYWRIGHT_SOCKETS_DIR, TEMP: process.env.PLAYWRIGHT_SOCKETS_DIR }, stdio: ['ignore','pipe','pipe'] });
let output=''; for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk => { output=(output+chunk.toString()).slice(-4096); process.stdout.write(chunk); });
child.once('error', error => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({code:1,error:error.message,output})); process.exitCode=1; });
child.once('close', (code,signal) => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({code,signal,output})); if(code!==0) process.exitCode=1; });
setInterval(() => {}, 1000);
`;
      await fs.writeFile(ownerPath, ownerSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      browserOwner = await resourceSession.startProcess({ label: 'q26-playwright-session-owner', kind: 'browser', role: 'browser-session-owner',
        command: process.execPath, args: [ownerPath], cwd: cliDirectory, env: { PATH: process.env.PATH || '',
          PLAYWRIGHT_WRAPPER: cliWrapper, PLAYWRIGHT_CONFIG: cliConfig, PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath,
          PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: webUrl } });
      assert.equal(browserOwner.status, 'running', 'Playwright session owner started under ResourceSession'); browserOpened = true;
      const opened = await waitForFile(openMarker);
      evidence.cliSteps.push({ label: 'open', status: opened.code === 0 ? 'exited' : 'failed', exitCode: opened.code,
        signal: opened.signal || null, configPassedOnlyToOpen: true, outputTail: String(opened.output || '').slice(-4096) });
      assert.equal(opened.code, 0, `Playwright open failed: ${String(opened.output || '').slice(-1000)}`);
      assert.equal(opened.signal || null, null, 'Playwright open was signaled');
      chrome = await identifyIsolatedChrome(profilePath);
      assert.notEqual(chrome.pid, protectedChrome.pid, 'isolated browser is not user Chrome');
      assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Chrome uses the owned temporary profile');
      const chromeFlags = chrome.command.match(/--disable-features=[^\s]+/g) || [];
      assert.deepEqual(chromeFlags, [featureArgs[0]], 'isolated Chrome uses exactly the configured merged feature flag');
      evidence.chrome = { pid: chrome.pid, startTime: chrome.startTime, fingerprint: chrome.fingerprint,
        processGroup: chrome.pgid, profilePath, effectiveDisableFeatures: chromeFlags[0] };
      const protectedDuring = protectedChromeSnapshot(); assertProtectedChrome(protectedDuring, 'during browser', protectedClonePaths);
      evidence.protectedChromeSnapshots.push({ label: 'during-browser-open', ...protectedDuring });
      evidence.cacheSnapshots.push({ label: 'during-browser-open', names: await cacheNames() });
      assert.deepEqual(await cacheNames(), expectedCacheNames, 'browser created no extra protected Chrome cache');

      const flowSource = `
async page => {
const assert={ok(v,m){if(!v)throw new Error(m||'assertion failed')},equal(a,b,m){if(a!==b)throw new Error(m+': expected '+b+', got '+a)},deepEqual(a,b,m){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(m+': expected '+JSON.stringify(b)+', got '+JSON.stringify(a))},includes(a,b,m){if(!String(a).includes(b))throw new Error(m+': missing '+b)}};
const webUrl=${JSON.stringify(webUrl)}, fixtures=${JSON.stringify({ guest: { id: fixtures.guest.id, name: fixtures.guest.name, username: fixtures.guest.username },
  clinician: { id: fixtures.clinician.id, username: fixtures.clinician.username }, outsiderClinician: { id: fixtures.outsiderClinician.id, username: fixtures.outsiderClinician.username },
  coach: { id: fixtures.coach.id, username: fixtures.coach.username, name: fixtures.coach.name },
  therapist: { id: fixtures.therapist.id, username: fixtures.therapist.username, name: fixtures.therapist.name },
  dietitian: { id: fixtures.dietitian.id, username: fixtures.dietitian.username, name: fixtures.dietitian.name },
  dietGuest: { id: fixtures.dietGuest.id, name: fixtures.dietGuest.name },
  administrator: { id: fixtures.administrator.id, username: fixtures.administrator.username },
  disabledCandidate: { id: fixtures.disabledCandidate.id, username: fixtures.disabledCandidate.username },
  personaSlots: fixtures.personaSlots,
  weatherReservationId: fixtures.weatherReservationId, noShowReservationId: fixtures.noShowReservationId,
  alternateSlotId: fixtures.alternateSlot.id, therapistSlotId: fixtures.therapistSlot.id,
  therapistReservationId: fixtures.therapistReservationId, mealOrderId: fixtures.mealOrderId,
  metricSlotId: fixtures.metricSlot.id, sourceDraftId: fixtures.draftId, coachDay,
  guestAdviceTitle: '阶段26助手发布网页医嘱', guestAdviceContent: '医护人员已复核本周风险及规则来源。', screenshots })};
const screenshots=fixtures.screenshots;
const pageErrors=[], consoleErrors=[], externalRequests=[], failedRequests=[];
page.setDefaultTimeout(25000); page.setDefaultNavigationTimeout(25000);
async function markProgress(label){await page.evaluate(value=>{document.title='STAGE26_PROGRESS:'+value},label)}
page.on('pageerror',e=>pageErrors.push(String(e.message||e).slice(0,500)));
page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text().slice(0,500))});
page.on('requestfailed',r=>failedRequests.push({url:r.url().slice(0,500),error:r.failure()?.errorText||'unknown'}));
await page.route('**/*',route=>{const u=new URL(route.request().url());if(['data:','blob:'].includes(u.protocol)||['127.0.0.1','localhost'].includes(u.hostname))return route.continue();externalRequests.push({origin:u.origin,type:route.request().resourceType()});return route.abort()});
await page.addInitScript(({frozenAt})=>{const instant=Date.parse(frozenAt),NativeDate=Date;class FrozenDate extends NativeDate{constructor(...args){super(...(args.length?args:[instant]))}static now(){return instant}}Object.defineProperty(globalThis,'Date',{configurable:true,writable:true,value:FrozenDate})},{frozenAt:${JSON.stringify(browserInstant)}});
await page.setViewportSize({width:1280,height:1080}); await page.goto(webUrl,{waitUntil:'domcontentloaded'});
async function enterRole(button,account,password){await page.getByRole('button',{name:new RegExp(button)}).first().click();await page.getByLabel('账号').fill(account);await page.getByLabel('密码').fill(password);await page.getByRole('button',{name:/进入工作区/}).click();await page.waitForFunction(expectedUsername=>{let user=null;try{user=JSON.parse(localStorage.getItem('community_user')||'null')}catch{}return Boolean(localStorage.getItem('community_token'))&&user?.username===expectedUsername},account,{timeout:15000})}
let legacyBasePages=null;
if(${JSON.stringify(artifactPrefix === 'stage27')}){
  await page.locator('.news-section').waitFor({state:'visible'});
  await page.getByRole('button',{name:'阅读全文'}).first().click();
  await page.locator('.news-modal').waitFor({state:'visible'});
  const newsTitle=await page.locator('.news-modal h2').innerText();assert.ok(newsTitle.trim(),'public news detail has a title');
  await page.screenshot({path:screenshots.publicNewsDetail,fullPage:true});
  await page.getByRole('button',{name:'关闭新闻详情'}).click();
  await page.screenshot({path:screenshots.publicNewsHome,fullPage:true});
  await enterRole('我是客人','guest_demo','guest2026');
  await page.getByRole('button',{name:'我的'}).click();
  await page.getByRole('button',{name:'我的档案'}).click();
  await page.getByRole('heading',{name:'我的资料'}).waitFor({state:'visible'});
  const legacyProfileName=await page.locator('.app-header .user-menu strong').innerText();
  await page.screenshot({path:screenshots.legacyGuestProfile,fullPage:true});
  await page.getByRole('button',{name:'我的'}).click();
  await page.locator('.guest-my-entry').filter({hasText:'健康记录'}).click();
  await page.locator('.health-records-surface').waitFor({state:'visible'});
  const legacyHealthRows=await page.locator('.health-record-row').count();
  await page.screenshot({path:screenshots.legacyHealthRecords,fullPage:true});
  await page.getByRole('button',{name:'打开智能助手'}).click();
  const legacyAssistantInput=page.getByLabel(/输入给智能助手的内容/);
  await legacyAssistantInput.fill('请告诉我如何在个人空间查看健康记录。');await legacyAssistantInput.press('Enter');
  const legacyAssistantAnswer=page.locator('.assistant-message.assistant').last();
  await legacyAssistantAnswer.waitFor({state:'visible',timeout:30000});
  assert.ok((await legacyAssistantAnswer.innerText()).trim(),'legacy account assistant displays its actual reply');
  await page.screenshot({path:screenshots.legacyAssistant,fullPage:true});
  legacyBasePages={newsTitle,guestName:legacyProfileName,healthRecordCount:legacyHealthRows,assistantReplyVisible:true,
    screenshots:{publicNewsHome:screenshots.publicNewsHome,publicNewsDetail:screenshots.publicNewsDetail,
      guestProfile:screenshots.legacyGuestProfile,healthRecords:screenshots.legacyHealthRecords,assistant:screenshots.legacyAssistant}};
  await page.getByRole('button',{name:/退出登录/}).first().click();
}
await enterRole('院长管理入口','dean_demo','dean2026');
try { await page.getByRole('button',{name:'机构运营'}).waitFor({state:'visible',timeout:10000}); }
catch { const state=await page.evaluate(()=>({url:location.href,title:document.title,body:document.body.innerText.slice(0,2400),nav:[...document.querySelectorAll('nav button')].map(item=>item.innerText)}));throw new Error('dean navigation diagnostic: '+JSON.stringify({state,pageErrors,consoleErrors})); }
await page.getByRole('button',{name:'机构运营'}).click();
await page.getByTestId('stage26-operations').waitFor({state:'visible'});
await page.getByRole('button',{name:/查看明细/}).first().click();await page.getByTestId('stage26-detail').waitFor({state:'visible'});
const guestSearch=page.locator('.stage26-search');await guestSearch.getByPlaceholder('搜索住客或房间').fill(fixtures.guest.name);await guestSearch.getByRole('button',{name:'查询'}).click();
const guestRow=page.locator('.stage26-guest-list article').filter({hasText:fixtures.guest.name});await guestRow.waitFor({state:'visible'});await guestRow.getByRole('button',{name:'健康历史'}).click();
await page.getByTestId('stage26-health-history').waitFor({state:'visible'});assert.includes(await page.getByTestId('stage26-health-history').innerText(),'128/78','read-only health history');
await page.getByLabel('业务日期').fill('2026-10-10');
await page.locator('.stage26-slot-list article[data-slot-id="'+fixtures.metricSlotId+'"]').waitFor({state:'visible'});
const baselineSummaryResponse=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/admin/operations/summary?date=2026-10-10',{headers:{Authorization:'Bearer '+token},cache:'no-store'});return {status:response.status,body:await response.json()}});
assert.equal(baselineSummaryResponse.status,200,'administrator can read the baseline operations summary: '+JSON.stringify(baselineSummaryResponse));
const baselineMetricValues=baselineSummaryResponse.body.metrics?.slice(0,3).map(metric=>Number(metric.value));
const metricsBefore={guests:baselineMetricValues[0],reservations:baselineMetricValues[1],pendingReviews:baselineMetricValues[2]};
assert.equal(await page.getByLabel('业务日期').inputValue(),'2026-10-10','operations date filter is set to the metric booking date');
  await page.getByLabel('业务日期').fill('2026-10-09');
  await page.locator('.stage26-reservations article[data-reservation-id="'+fixtures.weatherReservationId+'"]').waitFor({state:'visible'});
const projectDayBeforeResponsePromise=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname.endsWith('/admin/operations/reservations')&&url.searchParams.get('date')==='2026-10-09'&&url.searchParams.get('status')==='all'&&url.searchParams.get('projectId')==='project-sea-bath'});
await page.getByLabel('项目筛选').selectOption('project-sea-bath');
const projectDayBeforeData=await projectDayBeforeResponsePromise.then(response=>response.json());
assert.ok(projectDayBeforeData.items.some(item=>item.id===fixtures.weatherReservationId),'daily project filter loads the source reservation');
const dayWeatherRow=page.locator('.stage26-reservations article[data-reservation-id="'+fixtures.weatherReservationId+'"]').first();
assert.equal(await dayWeatherRow.getAttribute('data-guest-id'),fixtures.guest.id,'daily board links reservation to its guest');
assert.equal(await dayWeatherRow.getAttribute('data-status'),'confirmed','daily board shows current reservation status');
const reservationDayBefore={view:'day',projectId:'project-sea-bath',reservationId:await dayWeatherRow.getAttribute('data-reservation-id'),guestId:await dayWeatherRow.getAttribute('data-guest-id'),status:await dayWeatherRow.getAttribute('data-status')};
await page.screenshot({path:screenshots.reservationDay,fullPage:true});
const projectWeekBeforeResponsePromise=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname.endsWith('/admin/operations/reservations')&&url.searchParams.get('from')==='2026-10-09'&&url.searchParams.get('status')==='all'&&url.searchParams.get('projectId')==='project-sea-bath'});
await page.getByRole('button',{name:'项目周'}).click();
await page.waitForFunction(()=>document.querySelector('[data-testid="stage26-reservation-view"]')?.dataset.view==='project-week');
const projectWeekBeforeData=await projectWeekBeforeResponsePromise.then(response=>response.json());
assert.ok(projectWeekBeforeData.items.some(item=>item.id===fixtures.weatherReservationId),'project-week view loads the same source reservation');
const weekWeatherRow=page.locator('.stage26-reservations article[data-reservation-id="'+fixtures.weatherReservationId+'"]').first();
await weekWeatherRow.waitFor({state:'visible'});assert.equal(await weekWeatherRow.getAttribute('data-guest-id'),fixtures.guest.id);assert.equal(await weekWeatherRow.getAttribute('data-status'),'confirmed');
const reservationWeekBefore={view:'project-week',projectId:'project-sea-bath',reservationId:await weekWeatherRow.getAttribute('data-reservation-id'),guestId:await weekWeatherRow.getAttribute('data-guest-id'),status:await weekWeatherRow.getAttribute('data-status')};
assert.equal(reservationWeekBefore.reservationId,reservationDayBefore.reservationId,'day and project-week views use the same source reservation');
assert.equal(reservationWeekBefore.guestId,reservationDayBefore.guestId,'day and project-week views use the same guest');
assert.equal(reservationWeekBefore.status,reservationDayBefore.status,'day and project-week views show the same status');
await page.screenshot({path:screenshots.reservationWeek,fullPage:true});
await page.getByRole('button',{name:'单日',exact:true}).click();
const layout=[];for(const width of [1280,1920]){await page.setViewportSize({width,height:1080});await page.waitForTimeout(160);const state=await page.evaluate(()=>({viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth}));assert.ok(state.documentWidth<=width&&state.bodyWidth<=width,'operations page has no horizontal overflow at '+width+': '+JSON.stringify(state));layout.push({page:'operations',...state});await page.screenshot({path:width===1280?screenshots.operations1280:screenshots.operations1920,fullPage:true})}
await markProgress('operations');
const noShowRow=page.locator('.stage26-reservations article').filter({hasText:fixtures.noShowReservationId});await noShowRow.waitFor({state:'visible'});await noShowRow.getByRole('button',{name:'登记未参加'}).click();await page.getByText('已登记未参加').waitFor({state:'visible'});await noShowRow.getByText(/no_show/).waitFor({state:'visible'});
const activeDayResponsePromise=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname.endsWith('/admin/operations/reservations')&&url.searchParams.get('date')==='2026-10-09'&&url.searchParams.get('status')==='active'});
await page.getByLabel('预约状态筛选').selectOption('active');
const activeDayData=await activeDayResponsePromise.then(response=>response.json());assert.ok(activeDayData.items.some(item=>item.id===fixtures.weatherReservationId),'day view loads the source reservation from the active API result');
await page.locator('.stage26-reservations article[data-reservation-id="'+fixtures.weatherReservationId+'"]').waitFor({state:'visible'});
const checkbox=page.getByRole('checkbox',{name:/选择海水浴 2026-10-09 14:00/});await checkbox.waitFor({state:'visible'});await checkbox.check();await page.getByLabel('调整原因').fill('阶段26浏览器验证：使用隔离天气快照调整');await page.getByRole('button',{name:'预览批量取消'}).click();
const preview=page.getByTestId('stage26-weather-preview');await preview.waitFor({state:'visible'});assert.includes(await preview.innerText(),'阶段26隔离网页快照','preview snapshot source');await preview.getByRole('button',{name:'确认批量取消'}).click();await page.getByText('批量取消已保存并通知客人').waitFor({state:'visible'});await page.getByRole('button',{name:'刷新预约'}).click();
await markProgress('weather-cancelled');
await page.waitForFunction(id=>[...document.querySelectorAll('.stage26-reservations article')].every(row=>row.dataset.reservationId!==id),fixtures.weatherReservationId);
const reservationDayAfter={view:'day',projectId:'project-sea-bath',statusFilter:'active',matchingReservations:await page.locator('.stage26-reservations article[data-reservation-id="'+fixtures.weatherReservationId+'"]').count()};
assert.equal(reservationDayAfter.matchingReservations,0,'cancelled reservation is absent from the active daily view');
const projectWeekAfterResponsePromise=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname.endsWith('/admin/operations/reservations')&&url.searchParams.get('from')==='2026-10-09'&&url.searchParams.get('status')==='active'&&url.searchParams.get('projectId')==='project-sea-bath'});
const projectDayAfterResponsePromise=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname.endsWith('/admin/operations/reservations')&&url.searchParams.get('date')==='2026-10-09'&&url.searchParams.get('status')==='active'&&url.searchParams.get('projectId')==='project-sea-bath'});
await page.getByLabel('项目筛选').selectOption('project-sea-bath');await page.getByRole('button',{name:'刷新预约'}).click();
const projectDayData=await projectDayAfterResponsePromise.then(response=>response.json());
assert.ok(!projectDayData.items.some(item=>item.id===fixtures.weatherReservationId),'cancelled reservation is absent from the active daily API result');
await page.getByRole('button',{name:'项目周'}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="stage26-reservation-view"]')?.dataset.view==='project-week');
const projectWeekAfterData=await projectWeekAfterResponsePromise.then(response=>response.json());
assert.ok(!projectWeekAfterData.items.some(item=>item.id===fixtures.weatherReservationId),'project-week active API response excludes the cancelled reservation');
await page.waitForFunction(id=>[...document.querySelectorAll('.stage26-reservations article')].every(row=>row.dataset.reservationId!==id),fixtures.weatherReservationId);
const reservationWeekAfter={view:'project-week',projectId:'project-sea-bath',statusFilter:'active',matchingReservations:await page.locator('.stage26-reservations article[data-reservation-id="'+fixtures.weatherReservationId+'"]').count()};
assert.equal(reservationWeekAfter.matchingReservations,0,'cancelled reservation is absent from the active project-week view');
await page.screenshot({path:screenshots.reservationWeekAfter,fullPage:true});
await page.getByRole('button',{name:'单日',exact:true}).click();await page.getByLabel('预约状态筛选').selectOption('all');
const cancelledRow=page.locator('.stage26-reservations article').filter({hasText:fixtures.weatherReservationId});try{await cancelledRow.waitFor({state:'visible',timeout:10000})}catch{throw new Error('weather rebooking row diagnostic: '+JSON.stringify({date:await page.getByLabel('业务日期').inputValue(),list:await page.locator('.stage26-reservations').innerText(),alerts:await page.locator('[role=alert]').allTextContents()}))};await cancelledRow.getByRole('button',{name:'查看替代时段'}).click();await page.getByTestId('stage26-rebooking').waitFor({state:'visible'});await page.getByLabel('可选时段').selectOption(fixtures.alternateSlotId);await page.getByRole('button',{name:'明确确认改约'}).click();await page.getByText('改约已确认并写入日程').waitFor({state:'visible'});
await page.getByRole('button',{name:/退出登录/}).click();
await page.getByRole('button',{name:'我是客人'}).first().click();
await page.getByRole('button',{name:'没有账号？客人注册'}).click();
await page.getByLabel('姓名').fill('阶段27慢病长者');await page.getByLabel('手机号').fill('13900002726');
await page.getByLabel('密码',{exact:true}).fill('Stage27-browser-new-pass');await page.getByLabel('确认密码').fill('Stage27-browser-new-pass');
await page.getByRole('button',{name:/注册并进入档案/}).click();await page.locator('.app-shell').waitFor({state:'visible'});
const browserGuest=await page.evaluate(()=>JSON.parse(localStorage.getItem('community_user')||'{}'));
assert.ok(browserGuest.id&&browserGuest.name==='阶段27慢病长者','chronic elder guest account was created by the public registration page');
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('院长管理入口','dean_demo','dean2026');
await page.getByRole('button',{name:'入住管理'}).click();await page.getByLabel('选择客人').selectOption(browserGuest.id);
await page.getByLabel('房间号').fill('Q26-METRIC');await page.getByLabel('入住日期').fill('2026-10-09');await page.getByLabel('离店日期').fill('2026-10-16');
await page.getByLabel('入住类别').selectOption('ten_night');await page.getByRole('button',{name:/保存入住登记/}).click();await page.getByText('入住信息已保存').waitFor({state:'visible'});
await page.getByRole('button',{name:'客人分工'}).click();await page.getByLabel('客人').selectOption(browserGuest.id);
await page.getByLabel('工作人员').selectOption(fixtures.clinician.id);await page.getByRole('button',{name:/建立负责关系/}).click();await page.getByText('负责关系已建立').waitFor({state:'visible'});
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是客人',browserGuest.username,'Stage27-browser-new-pass');
await page.getByRole('button',{name:'我的'}).click();await page.getByRole('button',{name:'我的档案'}).click();
await page.getByLabel('行动能力').fill('需要协助');await page.getByLabel('紧急联系人').fill('阶段27隔离联系人');
await page.getByRole('button',{name:/保存修改/}).click();await page.getByText('个人资料已保存').waitFor({state:'visible'});
const browserGuestProfile=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/me',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,guestId:body.id,mobility:body.profile?.mobility,roomNo:body.profile?.roomNo||body.profile?.room_no,
  checkIn:body.profile?.checkIn||body.profile?.check_in,checkOut:body.profile?.checkOut||body.profile?.check_out}});
assert.equal(browserGuestProfile.httpStatus,200);assert.equal(browserGuestProfile.guestId,browserGuest.id);assert.equal(browserGuestProfile.mobility,'需要协助');
await page.screenshot({path:screenshots.persona1Profile,fullPage:true});
const assessment=page.locator('.stage21-assessment');await assessment.waitFor({state:'visible'});
const assessmentField=page.locator('label[for="stage21-assessment-status"]');
assert.includes(await assessmentField.innerText(),'慢病史','new guest health assessment starts from its first unanswered field');
await page.locator('#stage21-assessment-status').selectOption('reported');await page.locator('#stage21-assessment-list').fill('高血压');await page.getByRole('button',{name:'保存并继续'}).click();
await page.waitForFunction(()=>document.querySelector('label[for="stage21-assessment-status"]')?.textContent.includes('长期用药说明'));
await page.locator('#stage21-assessment-status').selectOption('reported');await page.locator('.stage21-medication-inputs input').nth(0).fill('氨氯地平');await page.locator('.stage21-medication-inputs input').nth(1).fill('每日一次');await page.getByRole('button',{name:'保存并继续'}).click();
await page.waitForFunction(()=>document.querySelector('label[for="stage21-assessment-status"]')?.textContent.includes('过敏源'));
await page.locator('#stage21-assessment-status').selectOption('reported');await page.locator('#stage21-assessment-list').fill('磺胺类');
await page.getByRole('button',{name:'保存并继续'}).click();
for(let step=0;step<8;step++){
  await page.waitForFunction(()=>Boolean(document.querySelector('.stage21-complete'))||(()=>{const select=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return select?.value===''&&button?.disabled})(),null,{timeout:5000});
  if(await page.locator('.stage21-complete').count())break;
  const nextField=page.locator('label[for="stage21-assessment-status"]');if(!(await nextField.count()))break;
  const question=await nextField.innerText();
  const mobilityQuestion=question.includes('行动能力');
  const status=mobilityQuestion?'assistance':(question.includes('睡眠')||question.includes('皮肤')||question.includes('饮食忌口'))?'unknown':'none';
  const statusSelect=page.locator('#stage21-assessment-status');
  await page.waitForFunction(()=>{const select=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return select?.value===''&&button?.disabled},null,{timeout:5000}).catch(async error=>{const state=await page.evaluate(()=>{const node=document.querySelector('#stage21-assessment-status');return {title:document.title,label:document.querySelector('label[for="stage21-assessment-status"]')?.textContent,formPresent:Boolean(document.querySelector('.stage21-assessment-form')),value:node?.value??null,options:node?Array.from(node.options).map(option=>({value:option.value,label:option.textContent})):[],buttonDisabled:document.querySelector('.stage21-assessment-form button[type="submit"]')?.disabled??null,progress:document.querySelector('.stage21-progress-line strong')?.textContent}});throw new Error('assessment question did not settle before selection: '+JSON.stringify(state)+'; '+error.message)});
  const optionValues=await statusSelect.locator('option').evaluateAll(options=>options.map(option=>option.value));assert.ok(optionValues.includes(status),'health assessment offers the selected status for '+question+': '+JSON.stringify(optionValues));
  const selectedValues=await statusSelect.selectOption(status);assert.ok(selectedValues.includes(status),'health assessment accepted status '+status+' for '+question);
  await page.waitForFunction(expected=>{const select=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return select?.value===expected&&button&&!button.disabled},status,{timeout:5000}).catch(async error=>{const state=await page.evaluate(()=>{const node=document.querySelector('#stage21-assessment-status');return {title:document.title,label:document.querySelector('label[for="stage21-assessment-status"]')?.textContent,formPresent:Boolean(document.querySelector('.stage21-assessment-form')),value:node?.value??null,options:node?Array.from(node.options).map(option=>({value:option.value,label:option.textContent})):[],buttonDisabled:document.querySelector('.stage21-assessment-form button[type="submit"]')?.disabled??null,progress:document.querySelector('.stage21-progress-line strong')?.textContent}});throw new Error('assessment selection did not activate submit: '+JSON.stringify(state)+'; '+error.message)});
  if(status==='assistance')await page.locator('#stage21-assessment-details').fill('本人自述在陌生路面需要陪同协助');
  await page.getByRole('button',{name:'保存并继续'}).click();
  await page.waitForFunction(previous=>document.querySelector('label[for="stage21-assessment-status"]')?.textContent!==previous||Boolean(document.querySelector('.stage21-complete')),question);
}
const browserAssessmentProgress=await page.locator('.stage21-progress-line strong').innerText();assert.includes(browserAssessmentProgress,'8/8','first guest completed all eight health-intake fields through the webpage');
await page.locator('.stage21-complete').waitFor({state:'visible'});
await page.getByRole('button',{name:'日程',exact:true}).click();await page.getByRole('heading',{name:'日程与疗程草案'}).waitFor({state:'visible'});
await page.getByRole('button',{name:'生成疗程草案'}).click();
const browserPlan=page.locator('.stage21-draft-card').first();await browserPlan.waitFor({state:'visible',timeout:120000});
const browserPlanText=await browserPlan.innerText();assert.includes(browserPlanText,'等待医护审核','web-generated pending plan remains for human review');
const browserDraftId=await browserPlan.getAttribute('data-draft-id');assert.ok(browserDraftId,'web-generated plan has a real persisted ID');
assert.includes(browserPlanText,browserDraftId,'web-generated plan displays its persisted ID');
await page.screenshot({path:screenshots.persona1Plan,fullPage:true});
await page.getByRole('button',{name:'项目',exact:true}).click();await page.getByLabel('搜索项目').fill('海水浴');await page.getByRole('button',{name:'搜索',exact:true}).click();
const seaBathProject=page.locator('.project-card').filter({hasText:'海水浴'});await seaBathProject.waitFor({state:'visible'});
await seaBathProject.getByRole('button',{name:/查看详情/}).click();await page.getByLabel('预约日期').selectOption('2026-10-10');
const metricSlot=page.locator('.booking-slot-card[data-slot-id="'+fixtures.metricSlotId+'"]');await metricSlot.waitFor({state:'visible'});
assert.equal(await metricSlot.getAttribute('data-slot-status'),'available','browser-created guest can select the real open project slot');
await metricSlot.getByRole('button',{name:'选择时段'}).click();await page.getByRole('button',{name:'立即预约'}).click();
await page.getByRole('button',{name:'确认并预约'}).click();const browserBooking=page.locator('.booking-success');await browserBooking.waitFor({state:'visible'});
const browserReservationId=await browserBooking.getAttribute('data-reservation-id');assert.ok(browserReservationId,'project booking was committed from the guest page');assert.includes(await browserBooking.innerText(),browserReservationId,'guest booking confirmation displays its persisted ID');
await page.screenshot({path:screenshots.persona1Booking,fullPage:true});
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('院长管理入口','dean_demo','dean2026');await page.getByRole('button',{name:'机构运营'}).click();
await page.getByTestId('stage26-operations').waitFor({state:'visible'});await page.getByLabel('业务日期').fill('2026-10-10');
await page.locator('.stage26-slot-list article[data-slot-id="'+fixtures.metricSlotId+'"]').waitFor({state:'visible'});
const afterMetricValues=await page.locator('.stage26-metric').evaluateAll(cards=>cards.slice(0,3).map(card=>Number(card.querySelector('strong').textContent)));
await page.getByRole('button',{name:/刷新数据/}).click();
const refreshedSummaryResponse=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/admin/operations/summary?date=2026-10-10',{headers:{Authorization:'Bearer '+token},cache:'no-store'});return {status:response.status,body:await response.json()}});
assert.equal(refreshedSummaryResponse.status,200,'administrator can read the fresh operations summary: '+JSON.stringify(refreshedSummaryResponse));
const refreshedMetricValues=refreshedSummaryResponse.body.metrics?.slice(0,3).map(metric=>Number(metric.value));
const expectedMetricValues=[metricsBefore.guests+1,metricsBefore.reservations+1,metricsBefore.pendingReviews+1];
assert.equal(JSON.stringify(refreshedMetricValues),JSON.stringify(expectedMetricValues),'fresh operations summary reflects the guest registration, booking, and pending plan: '+JSON.stringify({before:metricsBefore,visibleBeforeRefresh:afterMetricValues,after:refreshedMetricValues,expected:expectedMetricValues}));
try { await page.waitForFunction(expected=>{
  const values=[...document.querySelectorAll('.stage26-metric')].slice(0,3).map(card=>Number(card.querySelector('strong')?.textContent));
  return values.length===3&&values.every((value,index)=>value===expected[index]);
},expectedMetricValues,{timeout:30000}); }
catch (error) { const dashboardState=await page.evaluate(()=>({date:document.querySelector('.stage26-filter-row input[type="date"]')?.value,generatedAt:document.querySelector('.stage26-filter-row')?.dataset.generatedAt,metrics:[...document.querySelectorAll('.stage26-metric')].slice(0,3).map(card=>({label:card.querySelector('span')?.textContent,value:card.querySelector('strong')?.textContent})),alerts:[...document.querySelectorAll('[role="alert"]')].map(item=>item.textContent)}));throw new Error('refreshed operations dashboard did not render fresh metrics: '+JSON.stringify({expected:expectedMetricValues,dashboardState,error:String(error)})); }
const settledMetricValues=await page.locator('.stage26-metric').evaluateAll(cards=>cards.slice(0,3).map(card=>Number(card.querySelector('strong').textContent)));
assert.equal(settledMetricValues[0],metricsBefore.guests+1,'browser registration adds one guest account to the dashboard');
assert.equal(settledMetricValues[1],metricsBefore.reservations+1,'browser booking adds one active reservation to the selected date');
assert.equal(settledMetricValues[2],metricsBefore.pendingReviews+1,'browser plan adds one pending review to the dashboard');
const metricDrilldowns=[];
for(const item of [{index:0,key:'guests',id:browserGuest.id},{index:1,key:'reservations',id:browserReservationId},{index:2,key:'pendingReviews',id:browserDraftId}]){
  await page.getByRole('button',{name:'查看明细'}).nth(item.index).click();
  const detailRow=page.getByTestId('stage26-detail-row-'+item.key+'-'+item.id);await detailRow.waitFor({state:'visible'});await detailRow.click();
  const selectedRecord=page.getByTestId('stage26-metric-record');await selectedRecord.waitFor({state:'visible'});
  const selectedText=await selectedRecord.innerText();assert.includes(selectedText,item.id,item.key+' detail row opens the exact record');
  if(item.key==='reservations'){assert.includes(selectedText,browserGuest.name);assert.includes(selectedText,'confirmed');}
  if(item.key==='pendingReviews'){assert.includes(selectedText,browserGuest.name);assert.includes(selectedText,'pending_review');}
  metricDrilldowns.push({kind:item.key,id:item.id,selectedText});
}
await page.screenshot({path:screenshots.metricsDrilldown,fullPage:true});
const browserMetrics={before:metricsBefore,after:{guests:settledMetricValues[0],reservations:settledMetricValues[1],pendingReviews:settledMetricValues[2]},
  newGuestId:browserGuest.id,newGuestName:browserGuest.name,newReservationId:browserReservationId,newDraftId:browserDraftId,drilldowns:metricDrilldowns};
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员',fixtures.administrator.username,'Stage26-browser-pass');
await page.getByRole('button',{name:'机构运营'}).click();await page.getByTestId('stage26-operations').waitFor({state:'visible'});
await page.getByLabel('业务日期').fill('2026-10-10');
await page.getByRole('button',{name:'打开智能助手'}).click();
const adminAssistantInput=page.getByLabel(/输入给智能助手的内容/);
await adminAssistantInput.fill('请查询明天下午海水浴项目的时段、剩余名额和数据更新时间。如果需要调整名额，请带我到运营页由管理员确认。');
await adminAssistantInput.press('Enter');
const operationsSourceButtons=page.getByTestId('assistant-operations-source');await operationsSourceButtons.first().waitFor({state:'visible',timeout:120000});
const adminAnswerText=await operationsSourceButtons.first().evaluate(element=>element.closest('.assistant-message')?.innerText||'');
assert.includes(adminAnswerText,'2026-10-10','administrator assistant answers about tomorrow');
assert.includes(adminAnswerText,'14:00','administrator assistant answers with an afternoon capacity source');
assert.includes(adminAnswerText,'余量','administrator assistant gives remaining capacity');
assert.includes(adminAnswerText,'数据时间','administrator assistant gives the data timestamp');
assert.includes(adminAnswerText,'管理员确认','administrator assistant routes changes for manual confirmation');
const assistantSlotId=adminAnswerText.match(/时段\\s+([^\\s，。]+)/)?.[1];assert.ok(assistantSlotId,'assistant answer names a real source slot');
const operationsSource=page.locator('[data-testid="assistant-operations-source"][data-source-id="'+assistantSlotId+'"]');await operationsSource.waitFor({state:'visible'});
const adminSourceEvidence={slotId:await operationsSource.getAttribute('data-source-id'),assistantRunId:await operationsSource.getAttribute('data-run-id'),toolName:await operationsSource.getAttribute('data-tool-name')};
assert.ok(adminSourceEvidence.slotId&&adminSourceEvidence.assistantRunId);assert.equal(adminSourceEvidence.toolName,'search_operations_capacity');
assert.equal(assistantSlotId,adminSourceEvidence.slotId,'assistant answer names its actual source slot');
const assistantRemaining=Number(adminAnswerText.match(/余量\\s+(\\d+)\\s*人/)?.[1]);assert.ok(Number.isFinite(assistantRemaining),'assistant answer exposes a numeric remaining count');
const assistantDataTime=adminAnswerText.match(/数据时间\\s+([^\\s，。]+)/)?.[1];assert.ok(assistantDataTime,'assistant answer exposes the tool data timestamp');
const adminRun=await page.evaluate(async runId=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/assistant/runs/'+encodeURIComponent(runId)+'?role=staff',{headers:{Authorization:'Bearer '+token}});return {status:response.status,body:await response.json()}},adminSourceEvidence.assistantRunId);
assert.equal(adminRun.status,200,'administrator can read actual assistant run evidence');
assert.equal(adminRun.body.toolCounts?.search_operations_capacity,1,'administrator assistant ran the real read-only capacity tool');
await operationsSource.click();
const sourceCapacityRow=page.locator('.stage26-slot-list article[data-slot-id="'+adminSourceEvidence.slotId+'"]');await sourceCapacityRow.waitFor({state:'visible'});
const sourceCapacityText=await sourceCapacityRow.innerText();assert.includes(sourceCapacityText,'2026-10-10','source navigation locates the requested date');
const dashboardRemaining=Number(sourceCapacityText.match(/余\\s+(\\d+)/)?.[1]);assert.equal(dashboardRemaining,assistantRemaining,'assistant and dashboard report identical remaining capacity');
const dashboardDataTime=await page.locator('.stage26-filter-row').getAttribute('data-generated-at');assert.ok(dashboardDataTime,'operations dashboard exposes its data timestamp');
assert.ok(Math.abs(Date.parse(dashboardDataTime)-Date.parse(assistantDataTime))<120_000,'assistant and dashboard timestamps are from the same current data window');
await page.screenshot({path:screenshots.adminAssistant,fullPage:true});
const adminCapacityEvidence={...adminSourceEvidence,assistantRemaining,dashboardRemaining,assistantDataTime,dashboardDataTime,
  dashboardBusinessDate:await sourceCapacityRow.getAttribute('data-business-date'),toolCount:adminRun.body.toolCounts.search_operations_capacity,
  manualConfirmationRequired:adminAnswerText.includes('管理员确认')};
assert.equal(adminCapacityEvidence.dashboardBusinessDate,'2026-10-10');
await markProgress('weather-rescheduled');
await page.getByLabel('业务日期').fill('2026-10-09');await page.locator('.stage26-slot-list article[data-slot-id="'+fixtures.alternateSlotId+'"]').waitFor({state:'visible'});
const coachSelect=page.locator('.stage26-slot-list article[data-slot-id="'+fixtures.alternateSlotId+'"] select[aria-label="海水浴 15:00岗位分配"]');await coachSelect.selectOption(fixtures.coach.id);await page.getByText('岗位任务已分配').waitFor({state:'visible'});
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员','stage26_browser_coach','Stage26-browser-pass');await page.getByTestId('stage26-staff-schedule').waitFor({state:'visible'});await markProgress('coach-schedule-loaded');
const coachDate=await page.getByLabel('业务日期').inputValue();assert.equal(coachDate,fixtures.coachDay,'coach schedule defaults to the current business date');await markProgress('coach-date-verified');
const coachTask=page.getByTestId('stage26-staff-task-'+fixtures.alternateSlotId);await coachTask.waitFor({state:'visible'});
assert.equal(await coachTask.getAttribute('data-reservation-status'),'confirmed','coach view uses the live confirmed reservation status');
const coachScheduleText=await coachTask.innerText();assert.includes(coachScheduleText,'coach','coach role visible in schedule');assert.includes(coachScheduleText,fixtures.guest.name,'rebooked guest visible in coach schedule');assert.includes(coachScheduleText,'15:00–16:00','rebooked slot visible in coach schedule');
const coachScheduleRefresh=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/schedule?date=2026-10-09',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();const row=(body.items||[]).find(item=>item.reservationId);return {httpStatus:response.status,items:(body.items||[]).map(item=>({reservationId:item.reservationId,guestId:item.guestId,status:item.reservationStatus})),target:row?{reservationId:row.reservationId,guestId:row.guestId,status:row.reservationStatus}:null}});
const coachReservationId=await coachTask.getAttribute('data-reservation-id'),coachGuestId=await coachTask.getAttribute('data-guest-id');
assert.equal(coachScheduleRefresh.httpStatus,200);assert.ok(coachScheduleRefresh.items.some(item=>item.reservationId===coachReservationId&&item.guestId===coachGuestId&&item.status==='confirmed'),'coach refresh returns the same confirmed reservation and guest');
const coachOperation={role:'coach',loginStatus:'authenticated',actionType:'schedule-read-refresh',action:'reloaded assigned daily schedule',reservationId:coachReservationId,guestId:coachGuestId,beforeStatus:'confirmed',afterStatus:'confirmed',refreshReadback:coachScheduleRefresh};
const coachReviewAccess=await page.evaluate(async draftId=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/therapy-drafts/'+encodeURIComponent(draftId),{headers:{Authorization:'Bearer '+token}});return response.status},browserDraftId);
assert.equal(coachReviewAccess,403,'non-clinician service role cannot read a pending medical review detail');
assert.equal(await page.getByRole('button',{name:/通过|批准|医护确认/}).count(),0,'coach webpage exposes no medical review action');await markProgress('coach-schedule-verified');
await markProgress('coach-page-content-loaded');
const coachLayout=await page.evaluate(()=>({viewportWidth:innerWidth,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth}));await markProgress('coach-layout:'+JSON.stringify(coachLayout));assert.ok(coachLayout.documentWidth<=coachLayout.viewportWidth&&coachLayout.bodyWidth<=coachLayout.viewportWidth,'coach schedule has no horizontal overflow');
await markProgress('coach-schedule');
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员',fixtures.therapist.username,'Stage26-browser-pass');await page.getByTestId('stage26-staff-schedule').waitFor({state:'visible'});
await page.getByLabel('业务日期').fill('2026-10-11');const therapistTask=page.getByTestId('stage26-staff-task-'+fixtures.therapistSlotId);await therapistTask.waitFor({state:'visible'});
assert.equal(await therapistTask.getAttribute('data-reservation-id'),fixtures.therapistReservationId,'therapist sees the actual source booking ID');
assert.equal(await therapistTask.getAttribute('data-guest-id'),fixtures.guest.id,'therapist sees the responsible guest ID');
assert.equal(await therapistTask.getAttribute('data-reservation-status'),'confirmed','therapist schedule status matches the reservation source');
const therapistText=await therapistTask.innerText();assert.includes(therapistText,fixtures.guest.name);assert.includes(therapistText,'海水浴');assert.includes(therapistText,'2026-10-11');
assert.equal(await page.getByRole('button',{name:/通过|批准|医护确认/}).count(),0,'therapist webpage exposes no medical review action');
const therapistScheduleRefresh=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/schedule?date=2026-10-11',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();const rows=(body.items||[]).map(item=>({reservationId:item.reservationId,guestId:item.guestId,status:item.reservationStatus}));return {httpStatus:response.status,rows}});
assert.equal(therapistScheduleRefresh.httpStatus,200);assert.ok(therapistScheduleRefresh.rows.some(item=>item.reservationId===fixtures.therapistReservationId&&item.guestId===fixtures.guest.id&&item.status==='confirmed'),'therapist refresh returns the same confirmed reservation and guest');
const therapistEvidence={reservationId:await therapistTask.getAttribute('data-reservation-id'),guestId:await therapistTask.getAttribute('data-guest-id'),
  status:await therapistTask.getAttribute('data-reservation-status'),businessDate:'2026-10-11',text:therapistText,refreshReadback:therapistScheduleRefresh};
const therapistOperation={role:'therapist',loginStatus:'authenticated',actionType:'schedule-read-refresh',action:'reloaded assigned daily schedule',reservationId:therapistEvidence.reservationId,
  guestId:therapistEvidence.guestId,beforeStatus:therapistEvidence.status,afterStatus:therapistEvidence.status,refreshReadback:therapistScheduleRefresh};
await page.screenshot({path:screenshots.therapistSchedule,fullPage:true});
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员',fixtures.dietitian.username,'Stage26-browser-pass');
await page.getByLabel('服务日期').fill('2026-10-11');await page.getByLabel('餐次').selectOption('lunch');
const mealOrderRow=page.getByTestId('stage26-meal-order-'+fixtures.mealOrderId);
await mealOrderRow.waitFor({state:'visible'});
const mealSourceGuestId=await mealOrderRow.getAttribute('data-guest-id');
assert.equal(mealSourceGuestId,fixtures.dietGuest.id,'dietitian order uses its actual assigned guest source');
assert.equal(await mealOrderRow.getAttribute('data-order-status'),'reserved','dietitian sees the source order status');
assert.includes(await mealOrderRow.innerText(),fixtures.dietGuest.name);assert.includes(await mealOrderRow.innerText(),fixtures.mealOrderId);
assert.includes(await mealOrderRow.innerText(),'2026-10-11');
const dietitianBefore={orderId:await mealOrderRow.getAttribute('data-order-id'),guestId:await mealOrderRow.getAttribute('data-guest-id'),
  status:await mealOrderRow.getAttribute('data-order-status'),businessDate:'2026-10-11',text:await mealOrderRow.innerText()};
assert.equal(await page.getByRole('button',{name:/医护确认并发布|通过|批准/}).count(),0,'dietitian webpage exposes no medical review action');
await mealOrderRow.getByRole('button',{name:'开始备餐'}).click();
await page.waitForFunction(id=>document.querySelector('[data-testid="stage26-meal-order-'+id+'"]')?.dataset.orderStatus==='preparing',fixtures.mealOrderId);
const mealPreparingRefresh=await page.evaluate(async id=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/meals/orders?date=2026-10-11&mealType=lunch',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();const row=body.find(item=>item.id===id);return {httpStatus:response.status,id:row?.id,status:row?.status}},fixtures.mealOrderId);
assert.equal(mealPreparingRefresh.httpStatus,200);assert.equal(mealPreparingRefresh.id,fixtures.mealOrderId);assert.equal(mealPreparingRefresh.status,'preparing');
await mealOrderRow.getByRole('button',{name:'标记已送达'}).click();
await page.waitForFunction(id=>document.querySelector('[data-testid="stage26-meal-order-'+id+'"]')?.dataset.orderStatus==='delivered',fixtures.mealOrderId);
const mealDeliveredRefresh=await page.evaluate(async id=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/meals/orders?date=2026-10-11&mealType=lunch',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();const row=body.find(item=>item.id===id);return {httpStatus:response.status,id:row?.id,status:row?.status}},fixtures.mealOrderId);
assert.equal(mealDeliveredRefresh.httpStatus,200);assert.equal(mealDeliveredRefresh.id,fixtures.mealOrderId);assert.equal(mealDeliveredRefresh.status,'delivered');
const dietitianEvidence={...dietitianBefore,initialStatus:dietitianBefore.status,transitions:['preparing','delivered'],
  preparingRefresh:mealPreparingRefresh,finalStatus:mealDeliveredRefresh.status,finalRefresh:mealDeliveredRefresh,text:await mealOrderRow.innerText()};
const dietitianOperation={role:'dietitian',loginStatus:'authenticated',actionType:'meal-order-status-transition',action:'started preparation then marked delivered',orderId:dietitianEvidence.orderId,
  guestId:dietitianEvidence.guestId,beforeStatus:dietitianEvidence.initialStatus,afterStatus:dietitianEvidence.finalStatus,transitions:dietitianEvidence.transitions,
  refreshReadback:{preparing:mealPreparingRefresh,delivered:mealDeliveredRefresh}};
await page.screenshot({path:screenshots.dietitianOrders,fullPage:true});
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员',fixtures.clinician.username,'Stage26-browser-pass');await page.getByRole('button',{name:'我负责的客人'}).click();
const search=page.getByLabel('搜索客人姓名或房间号');await search.fill(fixtures.guest.name);await page.getByRole('button',{name:'搜索'}).click();
const assignedGuest=page.locator('.guest-list .guest-row').filter({hasText:browserGuest.name});await search.fill(browserGuest.name);await page.getByRole('button',{name:'搜索'}).click();await assignedGuest.waitFor({state:'visible'});await assignedGuest.click();
await page.getByRole('button',{name:'打开智能助手'}).click();await markProgress('clinician-assistant-open');const assistantInput=page.getByLabel(/输入给智能助手的内容/);await assistantInput.fill('请读取我负责客人本周待审疗程的风险摘要和规则编号。');await markProgress('clinician-prompt-entered');await assistantInput.press('Enter');await markProgress('clinician-prompt-sent');
const reviewDraftTrigger=page.getByTestId('stage26-create-advice-draft');try{await reviewDraftTrigger.waitFor({state:'visible',timeout:120000})}catch(error){const diagnostic={assistantMessages:await page.locator('.assistant-message.assistant').allTextContents().catch(()=>[]),body:(await page.locator('body').innerText().catch(()=>'' )).slice(-2400),pageErrors,consoleErrors,failedRequests:failedRequests.slice(-8)};await markProgress('clinician-assistant-diagnostic:'+JSON.stringify(diagnostic).slice(0,3000));throw error}
const reviewAnswer=reviewDraftTrigger.locator('xpath=..');const reviewAnswerText=await reviewAnswer.innerText();assert.includes(reviewAnswerText,browserDraftId,'clinician assistant cites the web-generated pending plan');assert.includes(reviewAnswerText,'磺胺类','clinician assistant cites the guest risk');assert.includes(reviewAnswerText,'未核实','clinician assistant distinguishes assessment progress from the formal record');assert.includes(reviewAnswerText,'R5','clinician assistant cites the rule actually referenced by the generated plan');
const assessmentSource=page.locator('.assistant-sources article[data-source-type="health_assessment"]').last();await assessmentSource.waitFor({state:'visible'});
const assessmentSourceId=await assessmentSource.getAttribute('data-source-id');assert.equal(assessmentSourceId,browserGuest.id,'clinician assistant exposes the actual resumable health-assessment source');
const ruleSource=page.locator('.assistant-sources article[data-source-type="safety_rule"][data-source-id="R5"]').last();await ruleSource.waitFor({state:'visible'});
const ruleSourceId=await ruleSource.getAttribute('data-source-id');assert.equal(ruleSourceId,'R5','clinician assistant exposes the actual safety-rule source');
const reviewSource=page.getByTestId('assistant-review-source').last();await reviewSource.waitFor({state:'visible'});
const reviewSourceEvidence={draftId:await reviewSource.getAttribute('data-source-id'),guestId:await reviewSource.getAttribute('data-guest-id'),assistantRunId:await reviewSource.getAttribute('data-run-id'),toolName:await reviewSource.getAttribute('data-tool-name')};
assert.equal(reviewSourceEvidence.draftId,browserDraftId);assert.equal(reviewSourceEvidence.guestId,browserGuest.id);assert.ok(reviewSourceEvidence.assistantRunId);assert.equal(reviewSourceEvidence.toolName,'search_staff_review_context');
const actualReviewRun=await page.evaluate(async runId=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/assistant/runs/'+encodeURIComponent(runId)+'?role=staff',{headers:{Authorization:'Bearer '+token}});return {status:response.status,body:await response.json()}},reviewSourceEvidence.assistantRunId);
assert.equal(actualReviewRun.status,200,'clinician can read the actual assistant run evidence');assert.equal(actualReviewRun.body.toolCounts?.search_staff_review_context,1,'assistant run contains the real role-filtered review tool call');
await reviewSource.click();const linkedReview=page.getByTestId('wellness-review-detail');await page.waitForFunction(id=>document.querySelector('[data-testid="wellness-review-detail"]')?.dataset.draftId===id,browserDraftId);
const linkedReviewDetail=await page.evaluate(async draftId=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/therapy-drafts/'+encodeURIComponent(draftId),{headers:{Authorization:'Bearer '+token},cache:'no-store'});return {status:response.status,body:await response.json()}},browserDraftId);
assert.equal(linkedReviewDetail.status,200,'opened assistant source resolves to a readable clinician review detail');assert.equal(linkedReviewDetail.body.draftId,browserDraftId);assert.equal(linkedReviewDetail.body.guestId,browserGuest.id);assert.equal(linkedReviewDetail.body.guestName,browserGuest.name);assert.equal(linkedReviewDetail.body.reviewStatus,'pending_review');
const linkedReviewText=await linkedReview.innerText();const linkedReviewHeadText=await linkedReview.locator('.wellness-review-detail-head').innerText();
assert.includes(linkedReviewText,browserDraftId,'linked review detail displays the source plan ID');assert.includes(linkedReviewText,'待审核','linked review detail remains in a human-review state');
assert.includes(linkedReviewHeadText,browserGuest.name,'linked review header displays the same guest as the assistant source; '+JSON.stringify(linkedReviewHeadText.slice(0,700)));
const parentPlanRun=linkedReviewText.match(/来源父运行\\s+([^\\s·]+)/)?.[1];assert.ok(parentPlanRun&&parentPlanRun!=='未记录','linked review detail displays the real plan source run');
assert.ok(await page.locator('.wellness-review-actions').count()===1,'linked source opens the clinician review page with explicit human actions');
const approvalButton=page.locator('.wellness-review-actions').getByRole('button',{name:'审核通过并激活'});
await approvalButton.click();
await page.waitForFunction(id=>document.querySelector('[data-testid="wellness-review-detail"]')?.innerText.includes('已激活'),browserDraftId,{timeout:20000});
const clinicianApprovalRefresh=await page.evaluate(async draftId=>{const token=localStorage.getItem('community_token');
  const response=await fetch('/api/staff/therapy-drafts/'+encodeURIComponent(draftId),{headers:{Authorization:'Bearer '+token},cache:'no-store'});
  const body=await response.json();return {httpStatus:response.status,draftId:body.draftId,version:body.version,status:body.reviewStatus,
    reservationIds:(body.reservations||[]).filter(item=>item.status==='confirmed').map(item=>item.id)}},browserDraftId);
assert.equal(clinicianApprovalRefresh.httpStatus,200);assert.equal(clinicianApprovalRefresh.draftId,browserDraftId);
assert.equal(clinicianApprovalRefresh.status,'active');assert.ok(Number(clinicianApprovalRefresh.version)>=1);
await page.screenshot({path:screenshots.clinicianApprovals,fullPage:true});
const reviewEvidence={...reviewSourceEvidence,assessmentSourceId,ruleSourceId,parentPlanRun,toolCount:actualReviewRun.body.toolCounts.search_staff_review_context,linkedGuest:browserGuest.name,
  riskIncluded:reviewAnswerText.includes('高血压')&&reviewAnswerText.includes('磺胺类'),selfReportClearlyUnverified:reviewAnswerText.includes('未核实'),ruleIncluded:reviewAnswerText.includes('R5'),
  humanReviewCompleted:true,approvalAction:'clinician-approve-and-activate',approvalRefresh:clinicianApprovalRefresh};
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员','stage26_browser_coach','Stage26-browser-pass');
const unrelatedReviewAccess=await page.evaluate(async draftId=>{const token=localStorage.getItem('community_token');let user=null;try{user=JSON.parse(localStorage.getItem('community_user')||'null')}catch{}const response=await fetch('/api/staff/therapy-drafts/'+encodeURIComponent(draftId),{headers:{Authorization:'Bearer '+token}});return {status:response.status,username:user?.username||null,tokenPresent:Boolean(token)}},browserDraftId);
assert.equal(unrelatedReviewAccess.status,403,'non-clinical service staff cannot read medical review content; account='+(unrelatedReviewAccess.username||'missing')+', tokenPresent='+unrelatedReviewAccess.tokenPresent+', status='+unrelatedReviewAccess.status);
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员',fixtures.outsiderClinician.username,'Stage26-browser-pass');
const unassignedReviewAccess=await page.evaluate(async draftId=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/therapy-drafts/'+encodeURIComponent(draftId),{headers:{Authorization:'Bearer '+token}});return response.status},browserDraftId);
assert.equal(unassignedReviewAccess,403,'clinician without an active guest assignment cannot read the medical review content');
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员','stage26_browser_clinician','Stage26-browser-pass');
const ownReviewAccess=await page.evaluate(async draftId=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/therapy-drafts/'+encodeURIComponent(draftId),{headers:{Authorization:'Bearer '+token}});return response.status},browserDraftId);
assert.equal(ownReviewAccess,200,'assigned clinician can read the linked review source');
await page.getByRole('button',{name:'我负责的客人'}).click();
const originalSearch=page.getByLabel('搜索客人姓名或房间号');await originalSearch.fill(fixtures.guest.name);await page.getByRole('button',{name:'搜索'}).click();
const originalAssignedGuest=page.locator('.guest-list .guest-row').filter({hasText:fixtures.guest.name});await originalAssignedGuest.waitFor({state:'visible'});await originalAssignedGuest.click();
await page.getByRole('button',{name:'打开智能助手'}).click();const originalAssistantInput=page.getByLabel(/输入给智能助手的内容/);await originalAssistantInput.fill('请读取我负责客人本周待审疗程的风险摘要和规则编号。');await originalAssistantInput.press('Enter');
const draftTrigger=page.getByTestId('stage26-create-advice-draft');await draftTrigger.waitFor({state:'visible',timeout:120000});const answer=draftTrigger.locator('xpath=..');const answerText=await answer.innerText();
assert.includes(answerText,fixtures.sourceDraftId,'clinician assistant also reads the original assigned test source');assert.includes(answerText,'R2','original source retains rule evidence');
await answer.getByTestId('stage26-create-advice-draft').click();const draft=page.getByTestId('stage26-advice-draft');await draft.waitFor({state:'visible'});await draft.getByRole('button',{name:'取消草稿'}).click();await draft.waitFor({state:'hidden'});
await answer.getByTestId('stage26-create-advice-draft').click();await draft.waitFor({state:'visible'});await draft.getByLabel('标题').fill(fixtures.guestAdviceTitle);await draft.getByLabel('内容').fill(fixtures.guestAdviceContent);
await draft.getByRole('button',{name:'医护确认并发布'}).click();await page.getByText(/已由医护人员确认发布/).waitFor({state:'visible',timeout:15000});await page.screenshot({path:screenshots.clinicianAssistant,fullPage:true});
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是客人',fixtures.guest.username,'guest2026');await page.getByRole('button',{name:'我的'}).click();await page.getByRole('button',{name:/我的医嘱/}).click();await page.getByRole('heading',{name:fixtures.guestAdviceTitle}).waitFor({state:'visible'});await page.screenshot({path:screenshots.guestAdvice,fullPage:true});
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('我是工作人员',fixtures.disabledCandidate.username,'Stage26-browser-pass');
const disabledToken=await page.evaluate(()=>localStorage.getItem('community_token'));assert.ok(disabledToken,'disabled-candidate staff identity has a bearer token before deactivation');
const activeStaffStatus=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/schedule?date=2026-10-09',{headers:{Authorization:'Bearer '+token}});return response.status});assert.equal(activeStaffStatus,200,'staff can perform an authenticated role operation before deactivation');
await page.getByRole('button',{name:/退出登录/}).click();await enterRole('院长管理入口','dean_demo','dean2026');
const disableResponse=await page.evaluate(async id=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/dean/staff/'+encodeURIComponent(id),{method:'PATCH',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({status:'disabled'})});return {status:response.status,body:await response.json()}},fixtures.disabledCandidate.id);
assert.equal(disableResponse.status,200,'dean disabled the authenticated employee through the staff management API');assert.equal(disableResponse.body.status,'disabled');
const disabledOperation=await page.evaluate(async token=>{const response=await fetch('/api/staff/schedule?date=2026-10-09',{headers:{Authorization:'Bearer '+token}});return {status:response.status,body:await response.json()}},disabledToken);
assert.equal(disabledOperation.status,401,'a previously authenticated employee token cannot operate after account deactivation');assert.equal(disabledOperation.body.code,'ACCOUNT_INACTIVE');
const disabledStaffReadback=await page.evaluate(async id=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/dean/staff',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();const row=(Array.isArray(body)?body:[]).find(item=>item.id===id);return {httpStatus:response.status,staffId:row?.id,status:row?.status}},fixtures.disabledCandidate.id);
assert.equal(disabledStaffReadback.httpStatus,200);assert.equal(disabledStaffReadback.staffId,fixtures.disabledCandidate.id);assert.equal(disabledStaffReadback.status,'disabled','manager refresh confirms the same employee remains disabled');
const disabledEmployeeEvidence={staffId:fixtures.disabledCandidate.id,preDisableStatus:activeStaffStatus,managerDisableStatus:disableResponse.status,
  postDisableStatus:disabledOperation.status,postDisableCode:disabledOperation.body.code,tokenExistedBeforeDisable:true,refreshReadback:disabledStaffReadback};
const administratorOperation={role:'administrator',loginStatus:'authenticated',actionType:'employee-deactivation',action:'disabled a previously active employee',employeeId:disabledEmployeeEvidence.staffId,
  beforeStatus:'active',afterStatus:disabledStaffReadback.status,refreshReadback:disabledStaffReadback,staleTokenReadback:{httpStatus:disabledOperation.status,code:disabledOperation.body.code}};
assert.equal(pageErrors.length,0,'no browser page errors: '+JSON.stringify(pageErrors));
const result={layout,coachLayout,guestId:fixtures.guest.id,weatherReservationId:fixtures.weatherReservationId,noShowReservationId:fixtures.noShowReservationId,
  alternateSlotId:fixtures.alternateSlotId,sourceDraftId:${JSON.stringify('wellness_draft_q26_browser_clinician')},ruleId:'R5',sourceDraftRuleId:'R2',guestAdviceTitle:fixtures.guestAdviceTitle,
  reservationViews:{before:{day:reservationDayBefore,projectWeek:reservationWeekBefore},after:{day:reservationDayAfter,projectWeek:reservationWeekAfter}},
  browserMetrics:{...browserMetrics,after:{guests:settledMetricValues[0],reservations:settledMetricValues[1],pendingReviews:settledMetricValues[2]}},
  reviewEvidence:{...reviewEvidence,nonClinicalHttpStatus:unrelatedReviewAccess,unassignedClinicianHttpStatus:unassignedReviewAccess,assignedClinicianHttpStatus:ownReviewAccess},
  adminCapacityEvidence,therapist:therapistEvidence,dietitian:dietitianEvidence,disabledEmployeeEvidence,
  legacyBasePages,
  clinicianOperation:{role:'clinician',loginStatus:'authenticated',actionType:'therapy-plan-human-review',action:'approved and activated the guest plan',draftId:browserDraftId,
    guestId:browserGuest.id,beforeStatus:'pending_review',afterStatus:clinicianApprovalRefresh.status,refreshReadback:clinicianApprovalRefresh},
  guestJourney:{registration:{id:browserGuest.id,name:browserGuest.name,username:browserGuest.username},profile:{...browserGuestProfile,saved:true},
    assessment:{sourceId:browserGuest.id,reportedFields:['高血压','氨氯地平','磺胺类'],progress:browserAssessmentProgress},draft:{id:browserDraftId,version:clinicianApprovalRefresh.version,status:clinicianApprovalRefresh.status},
    reservation:{id:browserReservationId,status:'confirmed'},refreshReadback:{sameIds:true,sourceDraftId:browserDraftId,reservationId:browserReservationId}},
  roleOperations:[{role:'clinician',loginStatus:'authenticated',actionType:'therapy-plan-human-review',action:'approved and activated the guest plan',draftId:browserDraftId,
      guestId:browserGuest.id,beforeStatus:'pending_review',afterStatus:clinicianApprovalRefresh.status,refreshReadback:clinicianApprovalRefresh},
    coachOperation,therapistOperation,dietitianOperation,administratorOperation],
  nonMedicalReviewDenied:unrelatedReviewAccess.status===403&&coachReviewAccess===403,
  disabledEmployeeDenied:disabledEmployeeEvidence.postDisableStatus===401,
  screenshots,externalRequests,failedRequests,consoleErrors,pageErrors};
await page.evaluate(value=>{document.title='STAGE26_BROWSER_RESULT:'+JSON.stringify(value)},result);return result;
}`;
      await fs.writeFile(flowPath, flowSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      const output = await runCli(['run-code', '--filename', flowPath], 'q26-playwright-business-flow', 300_000);
      const match = output.match(/STAGE26_BROWSER_RESULT:(\{[^\r\n]*\})/);
      assert.ok(match, `browser flow omitted structured result: ${output.slice(-2200)}`);
      flowResult = JSON.parse(match[1]); evidence.browserFlow = flowResult;
      evidence.browserFlowOutputBytes = Buffer.byteLength(output, 'utf8');
      if (artifactPrefix === 'stage27') {
        const elderId = flowResult.guestJourney.registration.id;
        await databaseQuery(context, 'UPDATE guest_profiles SET birth_date=? WHERE user_id=?', ['1949-05-01', elderId], 'run');
        const elderIdentity = await databaseQuery(context, 'SELECT user_id AS guestId,birth_date AS birthDate FROM guest_profiles WHERE user_id=?', [elderId], 'get');
        assert.equal(elderIdentity?.guestId, elderId, 'registered elder identity matches the browser-created guest');
        assert.equal(elderIdentity?.birthDate, '1949-05-01', 'registered elder receives an institution-owned birth date in the isolated acceptance database');
        const persona1 = flowResult.guestJourney.registration;
        const personaSource = `async page => {
const assert={ok(v,m){if(!v)throw new Error(m||'assertion failed')},equal(a,b,m){if(a!==b)throw new Error(m+': expected '+b+', got '+a)},deepEqual(a,b,m){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(m+': expected '+JSON.stringify(b)+', got '+JSON.stringify(a))},includes(a,b,m){if(!String(a).includes(b))throw new Error(m+': missing '+b)}};
const data=${JSON.stringify({ persona1, draftId: flowResult.guestJourney.draft.id, clinician: { id: fixtures.clinician.id, username: fixtures.clinician.username }, personaSlots: fixtures.personaSlots, screenshots,
  password: 'Stage27-browser-new-pass' })};
page.setDefaultTimeout(25000);page.setDefaultNavigationTimeout(25000);
async function enter(button,account,password){await page.getByRole('button',{name:new RegExp(button)}).first().click();await page.getByLabel('账号').fill(account);await page.getByLabel('密码').fill(password);await page.getByRole('button',{name:/进入工作区/}).click();await page.waitForFunction(name=>{let u=null;try{u=JSON.parse(localStorage.getItem('community_user')||'null')}catch{}return Boolean(localStorage.getItem('community_token'))&&u?.username===name},account,{timeout:15000})}
async function leave(){const logout=page.getByRole('button',{name:/退出登录/}).first();if(!(await logout.count())){const token=await page.evaluate(()=>Boolean(localStorage.getItem('community_token')));assert.ok(!token,'logout can be skipped only when the browser is already signed out');return}await logout.click();await page.waitForFunction(()=>!localStorage.getItem('community_token'),null,{timeout:10000})}
async function register(name,phone){await page.getByRole('button',{name:'我是客人'}).first().click();await page.getByRole('button',{name:'没有账号？客人注册'}).click();await page.getByLabel('姓名').fill(name);await page.getByLabel('手机号').fill(phone);await page.getByLabel('密码',{exact:true}).fill(data.password);await page.getByLabel('确认密码').fill(data.password);await page.getByRole('button',{name:/注册并进入档案/}).click();await page.locator('.app-shell').waitFor({state:'visible'});const u=await page.evaluate(()=>JSON.parse(localStorage.getItem('community_user')||'{}'));assert.ok(u.id&&u.username&&u.name===name,'new guest was registered through the public page');return u}
async function admitAndAssign(u,room){await leave();await enter('院长管理入口','dean_demo','dean2026');await page.getByRole('button',{name:'入住管理'}).click();await page.getByLabel('选择客人').selectOption(u.id);await page.getByLabel('房间号').fill(room);await page.getByLabel('入住日期').fill('2026-10-09');await page.getByLabel('离店日期').fill('2026-10-16');await page.getByLabel('入住类别').selectOption('ten_night');await page.getByRole('button',{name:/保存入住登记/}).click();await page.getByText('入住信息已保存').waitFor({state:'visible'});await page.getByRole('button',{name:'客人分工'}).click();await page.getByLabel('客人').selectOption(u.id);await page.getByLabel('工作人员').selectOption(data.clinician.id);await page.getByRole('button',{name:/建立负责关系/}).click();await page.getByText('负责关系已建立').waitFor({state:'visible'});await leave()}
async function completeAssessment(mobility){let completed=0;for(let step=0;step<8;step++){
 await page.waitForFunction(()=>Boolean(document.querySelector('.stage21-complete'))||(()=>{const node=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return node?.value===''&&button?.disabled})(),null,{timeout:5000});
 if(await page.locator('.stage21-complete').count())break;
 const label=page.locator('label[for="stage21-assessment-status"]');if(!(await label.count()))break;const question=await label.innerText();
 let value='none';if(question.includes('行动能力'))value=mobility;else if(question.includes('睡眠')||question.includes('皮肤')||question.includes('饮食忌口'))value='unknown';
 const select=page.locator('#stage21-assessment-status');await page.waitForFunction(()=>{const node=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return node?.value===''&&button?.disabled},null,{timeout:5000}).catch(async error=>{const state=await page.evaluate(()=>{const node=document.querySelector('#stage21-assessment-status');return {title:document.title,label:document.querySelector('label[for="stage21-assessment-status"]')?.textContent,formPresent:Boolean(document.querySelector('.stage21-assessment-form')),value:node?.value??null,options:node?Array.from(node.options).map(option=>({value:option.value,label:option.textContent})):[],buttonDisabled:document.querySelector('.stage21-assessment-form button[type="submit"]')?.disabled??null,progress:document.querySelector('.stage21-progress-line strong')?.textContent}});throw new Error('assessment question did not settle before selection: '+JSON.stringify(state)+'; '+error.message)});
 const optionValues=await select.locator('option').evaluateAll(options=>options.map(option=>option.value));assert.ok(optionValues.includes(value),'health assessment offers the selected status for '+question+': '+JSON.stringify(optionValues));
 const selectedValues=await select.selectOption(value);assert.ok(selectedValues.includes(value),'health assessment accepted status '+value+' for '+question);
 await page.waitForFunction(expected=>{const node=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return node?.value===expected&&button&&!button.disabled},value,{timeout:5000}).catch(async error=>{const state=await page.evaluate(()=>{const node=document.querySelector('#stage21-assessment-status');return {title:document.title,label:document.querySelector('label[for="stage21-assessment-status"]')?.textContent,formPresent:Boolean(document.querySelector('.stage21-assessment-form')),value:node?.value??null,options:node?Array.from(node.options).map(option=>({value:option.value,label:option.textContent})):[],buttonDisabled:document.querySelector('.stage21-assessment-form button[type="submit"]')?.disabled??null,progress:document.querySelector('.stage21-progress-line strong')?.textContent}});throw new Error('assessment selection did not activate submit: '+JSON.stringify(state)+'; '+error.message)});
 if(value==='assistance')await page.locator('#stage21-assessment-details').fill('本人自述在陌生路面需要陪同协助');
 await page.getByRole('button',{name:'保存并继续'}).click();completed++;
 await page.waitForFunction(previous=>document.querySelector('label[for="stage21-assessment-status"]')?.textContent!==previous||Boolean(document.querySelector('.stage21-complete')),question,{timeout:15000});
 if(await page.locator('.stage21-complete').count())break}
 await page.locator('.stage21-complete').waitFor({state:'visible',timeout:10000});const progress=await page.locator('.stage21-progress-line strong').innerText();assert.includes(progress,'8/8','all health-intake fields completed from the browser');return {completedCount:8,progress}}
async function createJourney(u,personaIndex,slot,mobility){await enter('我是客人',u.username,data.password);await page.getByRole('button',{name:'我的'}).click();await page.getByRole('button',{name:'我的档案'}).click();await page.getByLabel('行动能力').fill(mobility==='assistance'?'行动受限，需要轮椅协助':'行动独立');await page.getByLabel('紧急联系人').fill('阶段27隔离联系人'+personaIndex);await page.getByRole('button',{name:/保存修改/}).click();await page.getByText('个人资料已保存').waitFor({state:'visible'});const profile=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/me',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,guestId:body.id,mobility:body.profile?.mobility,birthDate:body.profile?.birthDate||body.profile?.birth_date||'',roomNo:body.profile?.roomNo||body.profile?.room_no,checkIn:body.profile?.checkIn||body.profile?.check_in,checkOut:body.profile?.checkOut||body.profile?.check_out}});assert.equal(profile.httpStatus,200);assert.equal(profile.guestId,u.id);assert.equal(profile.roomNo,'Q27-'+personaIndex);assert.equal(profile.checkIn,'2026-10-09');assert.equal(profile.checkOut,'2026-10-16');assert.includes(profile.mobility,mobility==='assistance'?'轮椅':'独立');await page.screenshot({path:personaIndex===2?data.screenshots.persona2Profile:data.screenshots.persona3Profile,fullPage:true});const assessment=await completeAssessment(mobility);await page.getByRole('button',{name:'日程',exact:true}).click();await page.getByRole('heading',{name:'日程与疗程草案'}).waitFor({state:'visible'});await page.getByRole('button',{name:'生成疗程草案'}).click();const card=page.locator('.stage21-draft-card').first();await card.waitFor({state:'visible',timeout:120000});const draftId=await card.getAttribute('data-draft-id');assert.ok(draftId,'web-generated plan persisted its own draft ID');const planText=await card.innerText();await page.screenshot({path:personaIndex===2?data.screenshots.persona2Plan:data.screenshots.persona3Plan,fullPage:true});const token=await page.evaluate(()=>localStorage.getItem('community_token'));const plan=await page.evaluate(async({id,token})=>{const response=await fetch('/api/me/therapy-drafts/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,draftId:body.draftId,version:body.version,reviewStatus:body.reviewStatus,guestId:body.guestId}}, {id:draftId,token});assert.equal(plan.httpStatus,200);assert.equal(plan.draftId,draftId);assert.equal(plan.guestId,u.id);assert.ok(['pending_review','active','auto_activated'].includes(plan.reviewStatus),'plan has a persisted human-review or auto-activation state: '+JSON.stringify(plan));assert.ok(planText.includes('等待医护审核')||planText.includes('自动激活')||planText.includes('已激活'),'guest page renders a plan state');let mealSwapEvidence=null;if(personaIndex===2){await page.getByRole('button',{name:'膳食',exact:true}).click();const targetMenuRead=page.waitForResponse(response=>{const url=new URL(response.url());return response.request().method()==='GET'&&url.pathname.endsWith('/api/meals/menu')&&url.searchParams.get('date')===slot.date},{timeout:15000});await page.getByLabel('服务日期').fill(slot.date);const targetMenuResponse=await targetMenuRead;assert.equal(targetMenuResponse.status(),200,'guest meal page loaded the selected business date');await page.waitForFunction(expected=>{const input=document.querySelector('.meal-toolbar input[type=\"date\"]');const button=document.querySelector('.meal-empty button');return input?.value===expected&&Boolean(button)&&!button.disabled},slot.date,{timeout:15000});const generateResponsePromise=page.waitForResponse(response=>{const url=new URL(response.url());return response.request().method()==='POST'&&url.pathname.endsWith('/api/meals/menus')},{timeout:15000});await page.getByRole('button',{name:'生成此日期餐单'}).click();const generateResponse=await generateResponsePromise;const generatedMenu=await generateResponse.json();assert.equal(generateResponse.status(),201,'guest generated the meal menu from the webpage');assert.equal(generatedMenu.menu?.businessDate,slot.date,'generated menu belongs to the selected service date');assert.ok(generatedMenu.menu?.id,'generated menu has a persisted ID');await page.locator('.meal-day-grid').waitFor({state:'visible',timeout:30000});const beforeMenu=await page.evaluate(async date=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/meals/menu?date='+encodeURIComponent(date),{headers:{Authorization:'Bearer '+token},cache:'no-store'});return {httpStatus:response.status,body:await response.json()}},slot.date);assert.equal(beforeMenu.httpStatus,200);const beforeItem=beforeMenu.body.items.find(item=>item.dish&&item.eligibleReplacements?.length);assert.ok(beforeItem,'guest menu contains a real eligible replacement for one meal seat');const row=page.locator('.meal-item').filter({hasText:beforeItem.dish.name}).first();await row.getByRole('button',{name:'替换此餐位'}).click();const replacement=page.getByLabel('替换菜品');const options=await replacement.locator('option').evaluateAll(items=>items.map(item=>({value:item.value,label:item.textContent.trim()})).filter(item=>item.value));assert.ok(options.length);await replacement.selectOption(options[0].value);await page.getByLabel('替换原因').fill('阶段27网页验收：根据客人偏好调整餐位');let confirmMessages=[];await page.evaluate(()=>{window.__stage27ConfirmMessages=[];window.__stage27OriginalConfirm=window.confirm.bind(window);window.confirm=message=>{window.__stage27ConfirmMessages.push(String(message));return true}});try{await page.getByRole('button',{name:'确认替换'}).click();confirmMessages=await page.evaluate(()=>window.__stage27ConfirmMessages||[])}finally{await page.evaluate(()=>{if(window.__stage27OriginalConfirm)window.confirm=window.__stage27OriginalConfirm;delete window.__stage27OriginalConfirm;delete window.__stage27ConfirmMessages})}assert.equal(confirmMessages.length,1,'guest webpage invoked one meal-swap confirmation');const confirmMessage=confirmMessages[0];assert.includes(confirmMessage,'确认将');await page.getByText('餐位已替换').waitFor({state:'visible',timeout:15000});const afterMenu=await page.evaluate(async date=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/meals/menu?date='+encodeURIComponent(date),{headers:{Authorization:'Bearer '+token},cache:'no-store'});return {httpStatus:response.status,body:await response.json()}},slot.date);assert.equal(afterMenu.httpStatus,200);const afterItem=afterMenu.body.items.find(item=>item.id===beforeItem.id);assert.equal(afterMenu.body.menu.id,beforeMenu.body.menu.id);assert.ok(afterMenu.body.menu.version>beforeMenu.body.menu.version);assert.ok(afterItem?.dish?.id!==beforeItem.dish.id,'guest meal-swap persists a different dish ID');mealSwapEvidence={menuId:afterMenu.body.menu.id,itemId:beforeItem.id,businessDate:slot.date,beforeDishId:beforeItem.dish.id,afterDishId:afterItem.dish.id,versionBefore:beforeMenu.body.menu.version,versionAfter:afterMenu.body.menu.version,generationHttpStatus:generateResponse.status(),generatedMenuId:generatedMenu.menu.id,confirmationMessage:confirmMessage,confirmationAccepted:true,confirmationMode:'test-harness-confirm-intercepted-in-isolated-browser',refreshReadback:true};await page.screenshot({path:data.screenshots.persona2Plan,fullPage:true});}await page.getByRole('button',{name:'项目',exact:true}).click();await page.getByLabel('搜索项目').fill('海水浴');await page.getByRole('button',{name:'搜索',exact:true}).click();const project=page.locator('.project-card').filter({hasText:'海水浴'});await project.waitFor({state:'visible'});await project.getByRole('button',{name:/查看详情/}).click();await page.getByLabel('预约日期').selectOption(slot.date);const slotCard=page.locator('.booking-slot-card[data-slot-id="'+slot.id+'"]');await slotCard.waitFor({state:'visible'});assert.equal(await slotCard.getAttribute('data-slot-status'),'available');await slotCard.getByRole('button',{name:'选择时段'}).click();await page.getByRole('button',{name:'立即预约'}).click();await page.getByRole('button',{name:'确认并预约'}).click();const booking=page.locator('.booking-success');await booking.waitFor({state:'visible'});const reservationId=await booking.getAttribute('data-reservation-id');assert.ok(reservationId);assert.includes(await booking.innerText(),reservationId);await page.screenshot({path:personaIndex===2?data.screenshots.persona2Booking:data.screenshots.persona3Booking,fullPage:true});return {personaIndex,personaType:personaIndex===2?'mobility_limited':'youth',registration:{id:u.id,username:u.username,name:u.name},profile,assessment,plan:{...plan,visibleText:planText.slice(0,500)},mealSwap:mealSwapEvidence,reservation:{id:reservationId,status:'confirmed',slotId:slot.id,businessDate:slot.date,localStart:slot.start,localEnd:slot.end},refreshReadback:{sameGuestId:true,sameDraftId:plan.draftId,planVersion:plan.version,planStatus:plan.reviewStatus,sameReservationId:reservationId}}}
await leave();
await enter('我是客人',data.persona1.username,data.password);await page.getByRole('button',{name:'我的'}).click();await page.getByRole('button',{name:'我的档案'}).click();const elderBirthDate=await page.getByLabel('出生日期（只读）').inputValue();assert.equal(elderBirthDate,'1949-05-01','read-only profile displays institution-owned elder birth date');await page.screenshot({path:data.screenshots.persona1Identity,fullPage:true});await page.getByRole('button',{name:'日程',exact:true}).click();await page.getByRole('heading',{name:'日程与疗程草案'}).waitFor({state:'visible'});await page.getByRole('button',{name:/刷新日程/}).click();const elderPlanCard=page.locator('.stage21-draft-card[data-draft-id="'+data.draftId+'"]');await elderPlanCard.waitFor({state:'visible'});const elderToken=await page.evaluate(()=>localStorage.getItem('community_token'));const elderPlanRefresh=await page.evaluate(async({id,token})=>{const response=await fetch('/api/me/therapy-drafts/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,draftId:body.draftId,guestId:body.guestId,version:body.version,reviewStatus:body.reviewStatus}}, {id:data.draftId,token:elderToken});assert.equal(elderPlanRefresh.httpStatus,200);assert.equal(elderPlanRefresh.draftId,data.draftId);assert.equal(elderPlanRefresh.guestId,data.persona1.id);assert.equal(elderPlanRefresh.reviewStatus,'active');await leave();
const persona2User=await register('阶段27行动受限客人','13900002727');await admitAndAssign(persona2User,'Q27-2');const persona2=await createJourney(persona2User,2,data.personaSlots[1],'assistance');await leave();
const persona3User=await register('阶段27中青年客人','13900002728');await admitAndAssign(persona3User,'Q27-3');
const result={persona2,persona3Pending:{registration:{id:persona3User.id,username:persona3User.username,name:persona3User.name},stayAssigned:true},elderIdentity:{guestId:data.persona1.id,birthDate:'1949-05-01',pageVerified:true},elderPlanRefresh};
await page.evaluate(value=>{document.title='STAGE27_PERSONA_SETUP:'+JSON.stringify(value)},result);return result;
}`;
        const personaPath = path.join(cliDirectory, 'stage27-persona-setup.mjs');
        await fs.writeFile(personaPath, personaSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        const personaOutput = await runCli(['run-code', '--filename', personaPath], 'q27-playwright-persona-setup', 300_000);
        const personaMatch = personaOutput.match(/STAGE27_PERSONA_SETUP:(\{[^\r\n]*\})/);
        assert.ok(personaMatch, `persona browser flow omitted its structured result: ${personaOutput.slice(-1800)}`);
        const personaSetup = JSON.parse(personaMatch[1]);
        evidence.stage27PersonaSetup = personaSetup;
        const youthId = personaSetup.persona3Pending.registration.id;
        await databaseQuery(context, 'UPDATE guest_profiles SET birth_date=? WHERE user_id=?', ['2004-08-21', youthId], 'run');
        const youthIdentity = await databaseQuery(context, 'SELECT user_id AS guestId,birth_date AS birthDate FROM guest_profiles WHERE user_id=?', [youthId], 'get');
        assert.equal(youthIdentity?.guestId, youthId, 'registered youth identity matches the browser-created guest');
        assert.equal(youthIdentity?.birthDate, '2004-08-21', 'registered youth receives an institution-owned birth date in the isolated acceptance database');
        evidence.stage27PersonaSetup.youthIdentityProvisioning = { update: 'UPDATE guest_profiles SET birth_date=? WHERE user_id=?',
          guestId: youthId, birthDate: youthIdentity.birthDate, isolatedDatabase: context.databasePath };
        const completionSource = `async page => {
const assert={ok(v,m){if(!v)throw new Error(m||'assertion failed')},equal(a,b,m){if(a!==b)throw new Error(m+': expected '+b+', got '+a)},includes(a,b,m){if(!String(a).includes(b))throw new Error(m+': missing '+b)}};
const data=${JSON.stringify({ persona2: personaSetup.persona2, persona3: personaSetup.persona3Pending.registration, clinician: fixtures.clinician,
  screenshots, password: 'Stage27-browser-new-pass' })};page.setDefaultTimeout(25000);page.setDefaultNavigationTimeout(25000);
async function enter(button,account,password){await page.getByRole('button',{name:new RegExp(button)}).first().click();await page.getByLabel('账号').fill(account);await page.getByLabel('密码').fill(password);await page.getByRole('button',{name:/进入工作区/}).click();await page.waitForFunction(name=>{let u=null;try{u=JSON.parse(localStorage.getItem('community_user')||'null')}catch{}return Boolean(localStorage.getItem('community_token'))&&u?.username===name},account,{timeout:15000})}
async function leave(){const logout=page.getByRole('button',{name:/退出登录/}).first();if(!(await logout.count())){const token=await page.evaluate(()=>Boolean(localStorage.getItem('community_token')));assert.ok(!token,'logout can be skipped only when the browser is already signed out');return}await logout.click();await page.waitForFunction(()=>!localStorage.getItem('community_token'),null,{timeout:10000})}
async function completeAssessment(mobility){for(let step=0;step<8;step++){
 await page.waitForFunction(()=>Boolean(document.querySelector('.stage21-complete'))||(()=>{const node=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return node?.value===''&&button?.disabled})(),null,{timeout:5000});
 if(await page.locator('.stage21-complete').count())break;
 const label=page.locator('label[for="stage21-assessment-status"]');if(!(await label.count()))break;const question=await label.innerText();let value='none';
 if(question.includes('行动能力'))value=mobility;else if(question.includes('睡眠')||question.includes('皮肤')||question.includes('饮食忌口'))value='unknown';
 const select=page.locator('#stage21-assessment-status');await page.waitForFunction(()=>{const node=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return node?.value===''&&button?.disabled},null,{timeout:5000}).catch(async error=>{const state=await page.evaluate(()=>{const node=document.querySelector('#stage21-assessment-status');return {title:document.title,label:document.querySelector('label[for="stage21-assessment-status"]')?.textContent,formPresent:Boolean(document.querySelector('.stage21-assessment-form')),value:node?.value??null,options:node?Array.from(node.options).map(option=>({value:option.value,label:option.textContent})):[],buttonDisabled:document.querySelector('.stage21-assessment-form button[type="submit"]')?.disabled??null,progress:document.querySelector('.stage21-progress-line strong')?.textContent}});throw new Error('assessment question did not settle before selection: '+JSON.stringify(state)+'; '+error.message)});
 const optionValues=await select.locator('option').evaluateAll(options=>options.map(option=>option.value));assert.ok(optionValues.includes(value),'health assessment offers the selected status for '+question+': '+JSON.stringify(optionValues));
 const selectedValues=await select.selectOption(value);assert.ok(selectedValues.includes(value),'health assessment accepted status '+value+' for '+question);
 await page.waitForFunction(expected=>{const node=document.querySelector('#stage21-assessment-status');const button=document.querySelector('.stage21-assessment-form button[type="submit"]');return node?.value===expected&&button&&!button.disabled},value,{timeout:5000}).catch(async error=>{const state=await page.evaluate(()=>{const node=document.querySelector('#stage21-assessment-status');return {title:document.title,label:document.querySelector('label[for="stage21-assessment-status"]')?.textContent,formPresent:Boolean(document.querySelector('.stage21-assessment-form')),value:node?.value??null,options:node?Array.from(node.options).map(option=>({value:option.value,label:option.textContent})):[],buttonDisabled:document.querySelector('.stage21-assessment-form button[type="submit"]')?.disabled??null,progress:document.querySelector('.stage21-progress-line strong')?.textContent}});throw new Error('assessment selection did not activate submit: '+JSON.stringify(state)+'; '+error.message)});
 if(value==='assistance')await page.locator('#stage21-assessment-details').fill('本人自述在陌生路面需要陪同协助');
 await page.getByRole('button',{name:'保存并继续'}).click();
 await page.waitForFunction(previous=>document.querySelector('label[for="stage21-assessment-status"]')?.textContent!==previous||Boolean(document.querySelector('.stage21-complete')),question,{timeout:15000});
 if(await page.locator('.stage21-complete').count())break}
 await page.locator('.stage21-complete').waitFor({state:'visible',timeout:10000});assert.includes(await page.locator('.stage21-progress-line strong').innerText(),'8/8','youth completed all health-intake fields');return {completedCount:8,progress:await page.locator('.stage21-progress-line strong').innerText()}}
await enter('我是客人',data.persona3.username,data.password);await page.getByRole('button',{name:'我的'}).click();await page.getByRole('button',{name:'我的档案'}).click();const youthBirthDate=await page.getByLabel('出生日期（只读）').inputValue();assert.equal(youthBirthDate,'2004-08-21','read-only profile displays institution-owned youth birth date');await page.getByLabel('行动能力').fill('中青年，自述行动独立');await page.getByLabel('紧急联系人').fill('阶段27隔离联系人3');await page.getByRole('button',{name:/保存修改/}).click();await page.getByText('个人资料已保存').waitFor({state:'visible'});const profile=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/me',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,guestId:body.id,birthDate:body.profile?.birthDate||body.profile?.birth_date,mobility:body.profile?.mobility,roomNo:body.profile?.roomNo||body.profile?.room_no,checkIn:body.profile?.checkIn||body.profile?.check_in,checkOut:body.profile?.checkOut||body.profile?.check_out}});assert.equal(profile.httpStatus,200);assert.equal(profile.birthDate,'2004-08-21');assert.equal(profile.roomNo,'Q27-3');await page.screenshot({path:data.screenshots.persona3Profile,fullPage:true});await page.screenshot({path:data.screenshots.persona3Identity,fullPage:true});const assessment=await completeAssessment('independent');await page.getByRole('button',{name:'日程',exact:true}).click();await page.getByRole('heading',{name:'日程与疗程草案'}).waitFor({state:'visible'});await page.getByRole('button',{name:'生成疗程草案'}).click();const card=page.locator('.stage21-draft-card').first();await card.waitFor({state:'visible',timeout:120000});const draftId=await card.getAttribute('data-draft-id');assert.ok(draftId);const planText=await card.innerText();await page.screenshot({path:data.screenshots.persona3Plan,fullPage:true});const token=await page.evaluate(()=>localStorage.getItem('community_token'));const plan=await page.evaluate(async({id,token})=>{const response=await fetch('/api/me/therapy-drafts/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,draftId:body.draftId,version:body.version,reviewStatus:body.reviewStatus,guestId:body.guestId}}, {id:draftId,token});assert.equal(plan.httpStatus,200);assert.equal(plan.draftId,draftId);assert.equal(plan.guestId,data.persona3.id);assert.ok(['pending_review','active','auto_activated'].includes(plan.reviewStatus),'youth plan persisted a human-review or auto-activation state');assert.ok(planText.includes('等待医护审核')||planText.includes('自动激活')||planText.includes('已激活'));await page.getByRole('button',{name:'项目',exact:true}).click();await page.getByLabel('搜索项目').fill('海水浴');await page.getByRole('button',{name:'搜索',exact:true}).click();const project=page.locator('.project-card').filter({hasText:'海水浴'});await project.waitFor({state:'visible'});await project.getByRole('button',{name:/查看详情/}).click();const slot=${JSON.stringify(fixtures.personaSlots[2])};await page.getByLabel('预约日期').selectOption(slot.date);const slotCard=page.locator('.booking-slot-card[data-slot-id="'+slot.id+'"]');await slotCard.waitFor({state:'visible'});assert.equal(await slotCard.getAttribute('data-slot-status'),'available');await slotCard.getByRole('button',{name:'选择时段'}).click();await page.getByRole('button',{name:'立即预约'}).click();await page.getByRole('button',{name:'确认并预约'}).click();const booking=page.locator('.booking-success');await booking.waitFor({state:'visible'});const reservationId=await booking.getAttribute('data-reservation-id');assert.ok(reservationId);await page.screenshot({path:data.screenshots.persona3Booking,fullPage:true});
const persona3={personaIndex:3,personaType:'youth',registration:{id:data.persona3.id,username:data.persona3.username,name:data.persona3.name},profile,assessment,plan:{...plan,visibleText:planText.slice(0,500)},reservation:{id:reservationId,status:'confirmed',slotId:slot.id,businessDate:slot.date,localStart:slot.start,localEnd:slot.end}};
await leave();await enter('我是工作人员',data.clinician.username,'Stage26-browser-pass');await page.getByRole('button',{name:'疗程审核',exact:true}).click();await page.getByTestId('wellness-review-detail').waitFor({state:'visible'});
async function reviewOrConfirm(persona){const id=persona.plan.draftId;const initial=await page.evaluate(async draftId=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/therapy-drafts/'+encodeURIComponent(draftId),{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,draftId:body.draftId,guestId:body.guestId,version:body.version,status:body.reviewStatus}},id);assert.equal(initial.httpStatus,200);assert.equal(initial.draftId,id);assert.equal(initial.guestId,persona.registration.id);let action='already-activated';let result=initial;if(initial.status==='pending_review'){const row=page.locator('.wellness-review-row').filter({hasText:persona.registration.name});await row.waitFor({state:'visible',timeout:15000});await row.click();await page.waitForFunction(expected=>document.querySelector('[data-testid="wellness-review-detail"]')?.dataset.draftId===expected,id);const detailPanel=page.getByTestId('wellness-review-detail');const detail=await detailPanel.innerText();assert.ok(detail.trim().length>0,'clinician detail content is visibly rendered');assert.equal(await detailPanel.getAttribute('data-draft-id'),id,'clinician detail data attribute matches the selected draft');await page.locator('.wellness-review-actions').getByRole('button',{name:'审核通过并激活'}).click();await page.waitForFunction(expected=>{const el=document.querySelector('[data-testid="wellness-review-detail"]');return el?.dataset.draftId===expected&&el.innerText.includes('已激活')},id,{timeout:20000});action='clinician-approved-and-activated';result=await page.evaluate(async draftId=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/therapy-drafts/'+encodeURIComponent(draftId),{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,draftId:body.draftId,guestId:body.guestId,version:body.version,status:body.reviewStatus,reservationIds:(body.reservations||[]).filter(item=>item.status==='confirmed').map(item=>item.id)}},id);assert.equal(result.httpStatus,200);assert.equal(result.draftId,id);assert.equal(result.status,'active');await page.getByRole('button',{name:/刷新队列/}).click().catch(()=>{});}else assert.ok(['active','auto_activated'].includes(initial.status),'a plan must be pending human review or already active');return {draftId:id,guestId:persona.registration.id,beforeStatus:initial.status,action,afterStatus:result.status,version:result.version,refreshReadback:result}}
const persona2Review=await reviewOrConfirm(data.persona2);const persona3Review=await reviewOrConfirm(persona3);await page.screenshot({path:data.screenshots.clinicianApprovals,fullPage:true});
async function refreshGuestPlan(persona){await leave();await enter('我是客人',persona.registration.username,data.password);await page.getByRole('button',{name:'日程',exact:true}).click();await page.getByRole('heading',{name:'日程与疗程草案'}).waitFor({state:'visible'});await page.getByRole('button',{name:/刷新日程/}).click();const card=page.locator('.stage21-draft-card[data-draft-id="'+persona.plan.draftId+'"]');await card.waitFor({state:'visible'});await page.screenshot({path:persona.personaIndex===2?data.screenshots.persona2Plan:data.screenshots.persona3Plan,fullPage:true});const token=await page.evaluate(()=>localStorage.getItem('community_token'));const readback=await page.evaluate(async({id,token})=>{const response=await fetch('/api/me/therapy-drafts/'+encodeURIComponent(id),{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,draftId:body.draftId,guestId:body.guestId,version:body.version,status:body.reviewStatus}}, {id:persona.plan.draftId,token});assert.equal(readback.httpStatus,200);assert.equal(readback.draftId,persona.plan.draftId);assert.equal(readback.guestId,persona.registration.id);assert.equal(readback.version,persona.plan.version);assert.equal(readback.status,persona===data.persona2?persona2Review.afterStatus:persona3Review.afterStatus);await leave();return readback}
const refreshedPersona2Plan=await refreshGuestPlan(data.persona2);const refreshedPersona3Plan=await refreshGuestPlan(persona3);
const result={persona3:{...persona3,refreshReadback:{sameGuestId:true,sameDraftId:refreshedPersona3Plan.draftId,planVersion:refreshedPersona3Plan.version,planStatus:refreshedPersona3Plan.status,sameReservationId:persona3.reservation.id}},
  persona2Review,persona3Review,refreshedPersona2Plan,refreshedPersona3Plan};await page.evaluate(value=>{document.title='STAGE27_PERSONA_COMPLETION:'+JSON.stringify(value)},result);return result;
}`;
        const completionPath = path.join(cliDirectory, 'stage27-persona-completion.mjs');
        await fs.writeFile(completionPath, completionSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        const completionOutput = await runCli(['run-code', '--filename', completionPath], 'q27-playwright-persona-completion', 300_000);
        const completionMatch = completionOutput.match(/STAGE27_PERSONA_COMPLETION:(\{[^\r\n]*\})/);
        assert.ok(completionMatch, `persona completion flow omitted its structured result: ${completionOutput.slice(-1800)}`);
        const completion = JSON.parse(completionMatch[1]);
        evidence.stage27PersonaCompletion = completion;
        const persona1Journey = { personaIndex: 1, personaType: 'chronic_elder', registration: flowResult.guestJourney.registration,
          profile: { ...flowResult.guestJourney.profile, guestId: elderId, birthDate: '1949-05-01', mobility: '需要协助', saved: true },
          assessment: { ...flowResult.guestJourney.assessment, completedCount: 8, progress: flowResult.guestJourney.assessment.progress },
          plan: { draftId: flowResult.guestJourney.draft.id, version: flowResult.guestJourney.draft.version,
            reviewStatus: personaSetup.elderPlanRefresh.reviewStatus, status: personaSetup.elderPlanRefresh.reviewStatus },
          reservation: { ...flowResult.guestJourney.reservation, status: 'confirmed', slotId: fixtures.metricSlot.id, businessDate: fixtures.metricSlot.date,
            localStart: fixtures.metricSlot.start, localEnd: fixtures.metricSlot.end },
          review: { beforeStatus: 'pending_review', afterStatus: flowResult.guestJourney.draft.status, action: flowResult.clinicianOperation.action },
          refreshReadback: { sameGuestId: true, sameDraftId: flowResult.guestJourney.draft.id, sameReservationId: flowResult.guestJourney.reservation.id,
            planVersion: personaSetup.elderPlanRefresh.version, planStatus: personaSetup.elderPlanRefresh.reviewStatus } };
        flowResult.guestJourney.profile.birthDate = '1949-05-01';
        flowResult.guestJourney.assessment.completedCount = 8;
        const persona2Journey = { ...personaSetup.persona2,
          plan: { ...personaSetup.persona2.plan, reviewStatus: completion.refreshedPersona2Plan.status, status: completion.refreshedPersona2Plan.status },
          refreshReadback: { ...(personaSetup.persona2.refreshReadback || {}), sameGuestId: true,
            sameDraftId: completion.refreshedPersona2Plan.draftId, planVersion: completion.refreshedPersona2Plan.version,
            planStatus: completion.refreshedPersona2Plan.status, sameReservationId: personaSetup.persona2.reservation.id } };
        const persona3Journey = { ...completion.persona3,
          plan: { ...completion.persona3.plan, reviewStatus: completion.refreshedPersona3Plan.status, status: completion.refreshedPersona3Plan.status },
          refreshReadback: { ...(completion.persona3.refreshReadback || {}), planStatus: completion.refreshedPersona3Plan.status } };
        flowResult.personaJourneys = [persona1Journey, persona2Journey, persona3Journey];
        flowResult.clinicianPersonaReviews = [completion.persona2Review, completion.persona3Review];
        flowResult.youthIdentity = youthIdentity;
        const reservationIds = flowResult.personaJourneys.map(item => item.reservation.id);
        const slotIds = flowResult.personaJourneys.map(item => item.reservation.slotId);
        const beforeClockAdvance = await Promise.all(slotIds.map(id => databaseQuery(context,
          'SELECT id,business_date AS businessDate,starts_at AS startsAt,ends_at AS endsAt,local_start AS localStart,local_end AS localEnd FROM activity_slots WHERE id=?', [id], 'get')));
        assert.equal(beforeClockAdvance.length, 3);assert.ok(beforeClockAdvance.every(item => item?.id && item.businessDate));
        assert.ok(beforeClockAdvance.every(item => item.businessDate === '2026-10-10' && item.localStart === '14:00'
          && item.localEnd === '15:00' && new Date(item.startsAt).toISOString() === utc(item.businessDate, item.localStart)
          && new Date(item.endsAt).toISOString() === utc(item.businessDate, item.localEnd)),
          'each reserved slot has matching Shanghai business date, UTC instants and local labels');
        const afterClockAdvance = await Promise.all(slotIds.map(id => databaseQuery(context,
          'SELECT id,business_date AS businessDate,starts_at AS startsAt,ends_at AS endsAt,local_start AS localStart,local_end AS localEnd FROM activity_slots WHERE id=?', [id], 'get')));
        assert.deepEqual(afterClockAdvance, beforeClockAdvance,
          'the controlled API clock advance leaves every persisted slot date and instant unchanged');
        const priorClockInstant = browserInstant;
        context.baseUrl = await context.restartApi({ BUSINESS_CLOCK_NOW: checkinInstant }, { preservePort: true });
        evidence.stage27CheckinClockAdvance = { databasePath: context.databasePath, timeZone: 'Asia/Shanghai',
          priorApiInstant: priorClockInstant, checkinApiInstant: checkinInstant, method: 'managed-api-restart-same-port',
          before: beforeClockAdvance, after: afterClockAdvance, reservationIds, slotIds,
          slotRowsMutated: false, checkinWindow: '2026-10-10 14:00–15:00 Shanghai; API clock 14:05 Shanghai' };
        const checkinData = { personas: flowResult.personaJourneys.map(item => ({ ...item.registration,
          reservation: item.reservation, screenshot: screenshots['persona'+item.personaIndex+'Checkin'] })),
          password: 'Stage27-browser-new-pass', checkinInstant };
        const checkinSource = `async page => {
const assert={ok(v,m){if(!v)throw new Error(m||'assertion failed')},equal(a,b,m){if(a!==b)throw new Error(m+': expected '+b+', got '+a)}};
const data=${JSON.stringify(checkinData)};page.setDefaultTimeout(25000);page.setDefaultNavigationTimeout(25000);
await page.evaluate(frozenAt=>{const instant=Date.parse(frozenAt),NativeDate=Date;class FrozenDate extends NativeDate{constructor(...args){super(...(args.length?args:[instant]))}static now(){return instant}}Object.defineProperty(globalThis,'Date',{configurable:true,writable:true,value:FrozenDate})},data.checkinInstant);
async function enter(account){await page.getByRole('button',{name:/我是客人/}).first().click();await page.getByLabel('账号').fill(account.username);await page.getByLabel('密码').fill(data.password);await page.getByRole('button',{name:/进入工作区/}).click();await page.waitForFunction(name=>{let u=null;try{u=JSON.parse(localStorage.getItem('community_user')||'null')}catch{}return Boolean(localStorage.getItem('community_token'))&&u?.username===name},account.username,{timeout:15000})}
async function leave(){const logout=page.getByRole('button',{name:/退出登录/}).first();if(!(await logout.count())){const token=await page.evaluate(()=>Boolean(localStorage.getItem('community_token')));assert.ok(!token,'logout can be skipped only when the browser is already signed out');return}await logout.click();await page.waitForFunction(()=>!localStorage.getItem('community_token'),null,{timeout:10000})}
const verified=[];for(let index=0;index<data.personas.length;index++){const person=data.personas[index];await enter(person);await page.getByRole('button',{name:'日程',exact:true}).click();await page.locator('.q24-execution-section').waitFor({state:'visible'});const card=page.getByTestId('q24-appointment-'+person.reservation.id);await card.waitFor({state:'visible'});const checkinButton=page.getByTestId('q24-checkin-'+person.reservation.id);await checkinButton.waitFor({state:'visible'});await checkinButton.click();await page.waitForFunction(id=>document.querySelector('[data-testid="q24-appointment-'+id+'"]')?.innerText.includes('已签到'),person.reservation.id,{timeout:20000});const form=page.getByTestId('q24-feedback-'+person.reservation.id);await form.waitFor({state:'visible'});await form.getByLabel('海水浴的项目感受').selectOption('general');await form.getByLabel('补充说明').fill('阶段27隔离网页验收记录：已完成项目体验，当前感受一般。');await form.getByRole('button',{name:'保存感受'}).click();await page.waitForFunction(id=>{const form=document.querySelector('[data-testid="q24-feedback-'+id+'"]');return Boolean(form&&form.innerText.includes('反馈编号'))},person.reservation.id,{timeout:20000});const visibleCardText=await card.innerText();const firstRead=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/me/checkins',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();return {httpStatus:response.status,total:body.total,items:body.items}});assert.equal(firstRead.httpStatus,200);const firstItem=firstRead.items.find(item=>item.reservationId===person.reservation.id);assert.ok(firstItem?.checkin?.id&&firstItem?.feedback?.id,'server readback contains the actual check-in and feedback IDs');await page.getByRole('button',{name:/刷新日程/}).click();await page.waitForFunction(id=>document.querySelector('[data-testid="q24-appointment-'+id+'"]')?.innerText.includes('已签到'),person.reservation.id);const refreshed=await page.evaluate(async id=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/me/checkins',{headers:{Authorization:'Bearer '+token},cache:'no-store'});const body=await response.json();const item=body.items.find(row=>row.reservationId===id);return {httpStatus:response.status,reservationId:item?.reservationId,checkinId:item?.checkin?.id,feedbackId:item?.feedback?.id,feedbackRevision:item?.feedback?.revision,feeling:item?.feedback?.feeling,guestId:item?.feedback?.guestId}},person.reservation.id);assert.equal(refreshed.httpStatus,200);assert.equal(refreshed.reservationId,person.reservation.id);assert.equal(refreshed.checkinId,firstItem.checkin.id);assert.equal(refreshed.feedbackId,firstItem.feedback.id);assert.equal(refreshed.feedbackRevision,1);assert.equal(refreshed.feeling,'general');assert.equal(refreshed.guestId,person.id);const refreshedCardText=await card.innerText();assert.ok(refreshedCardText.includes(refreshed.feedbackId),'refreshed guest page displays the same feedback ID');await page.screenshot({path:person.screenshot,fullPage:true});verified.push({personaIndex:index+1,guestId:person.id,guestName:person.name,reservationId:person.reservation.id,slotId:person.reservation.slotId,
  businessDate:person.reservation.businessDate,checkinId:refreshed.checkinId,feedbackId:refreshed.feedbackId,feedbackRevision:refreshed.feedbackRevision,feeling:refreshed.feeling,
  webpageActionVerified:visibleCardText.includes('已签到'),pageRefreshed:true,refreshReadback:refreshed});await leave()}
const result={personas:verified,allThreeCheckedIn:verified.length===3,allThreeFeedbackSaved:verified.length===3&&verified.every(item=>item.feedbackId&&item.checkinId)};
await page.evaluate(value=>{document.title='STAGE27_CHECKIN_FEEDBACK:'+JSON.stringify(value)},result);return result;
}`;
        const checkinPath = path.join(cliDirectory, 'stage27-checkin-feedback.mjs');
        await fs.writeFile(checkinPath, checkinSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        const checkinOutput = await runCli(['run-code', '--filename', checkinPath], 'q27-playwright-checkin-feedback', 240_000);
        const checkinMatch = checkinOutput.match(/STAGE27_CHECKIN_FEEDBACK:(\{[^\r\n]*\})/);
        assert.ok(checkinMatch, `check-in browser flow omitted its structured result: ${checkinOutput.slice(-1800)}`);
        const checkinEvidence = JSON.parse(checkinMatch[1]);
        assert.equal(checkinEvidence.allThreeCheckedIn, true);assert.equal(checkinEvidence.allThreeFeedbackSaved, true);
        const databaseReadbacks = [];
        for (const journey of flowResult.personaJourneys) {
          const row = await databaseQuery(context, `SELECT r.id AS reservationId,r.guest_id AS guestId,r.status AS reservationStatus,
            c.id AS checkinId,f.id AS feedbackId,f.revision AS feedbackRevision,f.feeling FROM reservations r
            LEFT JOIN wellness_checkins c ON c.reservation_id=r.id LEFT JOIN wellness_feedback f ON f.reservation_id=r.id WHERE r.id=?`,
          [journey.reservation.id], 'get');
          assert.equal(row.reservationId, journey.reservation.id);assert.equal(row.guestId, journey.registration.id);assert.equal(row.reservationStatus, 'confirmed');
          const web = checkinEvidence.personas.find(item => item.reservationId === row.reservationId);
          assert.ok(web);assert.equal(row.checkinId, web.checkinId);assert.equal(row.feedbackId, web.feedbackId);assert.equal(Number(row.feedbackRevision), 1);
          databaseReadbacks.push(row);
        }
        flowResult.checkinFeedback = { ...checkinEvidence, databaseReadbacks,
          clockAdjustment: evidence.stage27CheckinClockAdvance, screenshots: [screenshots.persona1Checkin,screenshots.persona2Checkin,screenshots.persona3Checkin] };
        flowResult.personaJourneys = flowResult.personaJourneys.map(journey => {
          const checkin = checkinEvidence.personas.find(item => item.guestId === journey.registration.id);
          return { ...journey, checkinFeedback: checkin, refreshReadback: { ...(journey.refreshReadback || {}), sameGuestId: true,
            sameReservationId: checkin.reservationId, sameCheckinId: checkin.checkinId, sameFeedbackId: checkin.feedbackId } };
        });
        evidence.browserFlow = flowResult;
        evidence.stage27PersonaCompletion.checkinFeedback = flowResult.checkinFeedback;
      }
      for (const file of Object.values(screenshots)) await fs.access(file);
      const advice = await api(context, '/me/advice', { token: fixtures.guest.token });
      const published = advice.find(item => item.title === '阶段26助手发布网页医嘱');
      assert.ok(published && published.authorName === fixtures.clinician.name && published.createdAt, 'guest can read advice with actual author and time');
      assert.equal(advice.length, fixtures.noAdviceCount + 1, 'cancelled assistant draft wrote no extra advice row');
      evidence.guestReadback = { adviceId: published.id, authorName: published.authorName, createdAt: published.createdAt,
        rowsBefore: fixtures.noAdviceCount, rowsAfter: advice.length, cancelledDraftWasNotWritten: true };
    const moved = await api(context, `/admin/operations/reservations?date=${today}&status=all`, { token: fixtures.dean.token });
    const original = moved.items.find(item => item.id === fixtures.weatherReservationId);
    assert.equal(original.status, 'cancelled'); assert.ok(original.rescheduledTo, 'original weather reservation links to the confirmed rebooking');
    const afterSchedule = await api(context, `/staff/schedule?date=${today}`, { token: fixtures.coach.token });
    assert.ok(afterSchedule.items.some(item => item.reservationId === original.rescheduledTo && item.guestId === fixtures.guest.id),
      'coach schedule matches the explicitly rebooked reservation');
    }, 'haiyu-stage26-browser-', { NODE_ENV: 'test', BUSINESS_CLOCK_NOW: '2026-10-08T22:00:00.000Z',
      LLM_BASE_URL: `${fixtureBase}/tools`, LLM_API_KEY: 'stage26-local-fixture-key', LLM_MODEL: 'stage26-local-fixture',
      ASSISTANT_MODEL_SOURCE: 'recorded_fixture', Q21_ACCEPTANCE_HOOKS: '1',
      OPERATIONS_FAILURE_THRESHOLD: '3' }, { resourceSession });
    const closeOutput = await runCli(['close'], 'q26-playwright-close', 30_000); browserOpened = false;
    evidence.cliSteps.push({ label: 'close-session', status: 'exited', exitCode: 0, configPassedOnlyToOpen: true, outputTail: closeOutput.slice(-4096) });
    const chromeDeadline = Date.now() + 15_000;
    while (processMatches(chrome.pid, chrome) && Date.now() < chromeDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
    assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `isolated Chrome ${chrome.pid} exited after close`);
    const protectedAfter = protectedChromeSnapshot(); assertProtectedChrome(protectedAfter, 'after browser close', protectedClonePaths);
    evidence.protectedChromeSnapshots.push({ label: 'after-browser-close', ...protectedAfter });
    evidence.cacheSnapshots.push({ label: 'after-browser-close', names: await cacheNames() });
    assert.deepEqual(await cacheNames(), expectedCacheNames, 'protected Chrome cache set unchanged after close');
  } catch (error) { failure = error;
    if (browserOpened && cliDirectory) {
      try { evidence.failureSnapshot = await runCli(['snapshot'], 'q26-playwright-failure-snapshot', 20_000); }
      catch (snapshotError) { evidence.failureSnapshotError = String(snapshotError.message || snapshotError).slice(0, 1600); }
    }
  }
  finally {
    if (browserOpened && cliDirectory && socketAlias) {
      try { await runCli(['close'], 'q26-playwright-failure-close', 30_000); browserOpened = false; }
      catch (error) { cleanupError ||= `Playwright close: ${error.message}`; }
    }
    for (const [resource, reason] of [[browserOwner, 'q26-browser-owner-cleanup'], [viteResource, 'q26-vite-cleanup']]) {
      if (!resource) continue;
      try { const result = await stopAndWait(resourceSession, resource, reason); evidence.resources.push({ ...resourceSummary(resource),
        finalStatus: result.status, exitCode: result.exitCode ?? null, signal: result.signal || null, cleanup: 'stopped-and-verified-exited' }); }
      catch (error) { cleanupError ||= `${resource.label}: ${error.message}`; }
    }
    if (socketAlias && socketAliasCreated) {
      try {
        const handles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
        assert.ok([0,1].includes(handles.status), `lsof socket alias exited ${handles.status}`);
        assert.equal(handles.status === 0 && Boolean(handles.stdout.trim()), false, 'Playwright alias has no open handles');
        await fs.unlink(socketAlias); socketAliasCreated = false;
        evidence.cleanupSteps = [{ command: `lsof -nP +D ${socketAlias}`, exitCode: handles.status, matchingHandles: 'none' },
          { command: `unlink ${socketAlias}`, result: 'removed-exact-symlink' }];
      } catch (error) { cleanupError ||= `socket alias cleanup: ${error.message}`; }
    }
    try {
      evidence.dfAfter = dfSnapshot('after-browser');
      evidence.cacheSnapshots.push({ label: 'after-browser-cleanup', names: await cacheNames() });
      const protectedAfterCleanup = protectedChromeSnapshot(); assertProtectedChrome(protectedAfterCleanup, 'after browser cleanup', protectedClonePaths);
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-cleanup', ...protectedAfterCleanup });
      if (chrome) { evidence.chrome.exactIdentityExitedAfterCleanup = !processMatches(chrome.pid, chrome);
        assert.equal(evidence.chrome.exactIdentityExitedAfterCleanup, true, `isolated Chrome ${chrome.pid} remains`); }
      const status = await resourceSession.status(); evidence.sessionResourcesAtExit = (status.resources || []).map(resourceSummary);
      evidence.liveOwnedBrowserResourcesAfterCleanup = evidence.sessionResourcesAtExit.filter(item => ['starting','running'].includes(item.status)
        && ['api','vite','browser','stub'].includes(item.kind) && !String(item.label || '').includes('q26-mysql'));
      assert.equal(evidence.liveOwnedBrowserResourcesAfterCleanup.length, 0, 'no owned Stage26 API/Vite/browser resources remain');
    } catch (error) { cleanupError ||= `final browser resources: ${error.message}`; }
    evidence.status = failure || cleanupError ? 'FAIL' : 'PASS'; evidence.failure = failure ? String(failure.stack || failure.message || failure).slice(0, 12_000) : null;
    evidence.cleanupError = cleanupError || null; evidence.observedAtEnd = new Date().toISOString();
    const encoded = JSON.stringify(evidence, null, 2); assert.ok(Buffer.byteLength(encoded) <= 2 * 1024 * 1024, 'Stage26 browser evidence stays under 2 MiB');
    await fs.writeFile(evidencePath, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  if (failure) throw failure;
  assert.equal(cleanupError, undefined, `browser cleanup failed: ${cleanupError}`);
  return { status: 'PASS', evidencePath, screenshotDirectory, screenshots, layout: flowResult.layout, coachLayout: flowResult.coachLayout,
    guestReadback: evidence.guestReadback, dfBefore: evidence.dfBefore, dfAfter: evidence.dfAfter,
    guestJourney: flowResult.guestJourney, roleOperations: flowResult.roleOperations,
    nonMedicalReviewDenied: flowResult.nonMedicalReviewDenied, disabledEmployeeDenied: flowResult.disabledEmployeeDenied,
    disabledEmployeeEvidence: flowResult.disabledEmployeeEvidence, browserFlow: flowResult };
}

export async function runStage27LiveTraceBrowser({ resourceSession, apiBaseUrl, guestId, guestUsername,
  guestPassword, runId, sessionId, actionRunId, needsInputCardId, slotId, slotLabel,
  activeDeadlineMonoMs, verifyBeforeConfirmation, offlineFixture = false }) {
  assert.ok(taskId && resourceSession && apiBaseUrl && guestId && guestUsername && guestPassword
    && runId && sessionId && actionRunId && needsInputCardId && slotId && slotLabel,
  'Q27.5 browser workflow needs the active ResourceSession, shared live API/session, graph/action run, offered slot, and guest');
  const cacheBaseline = await cacheNames();
  assert.deepEqual(cacheBaseline, expectedCacheNames, 'protected Chrome cache inventory matches the inherited baseline');
  const protectedBefore = protectedChromeSnapshot(); assertProtectedChrome(protectedBefore, 'before Q27 live trace');
  const executionModeLabel = offlineFixture ? '离线网页夹具 · 未调用模型' : '真实模型服务';
  const protectedClonePaths = [...protectedBefore.clonePaths];
  const config = JSON.parse(await fs.readFile(cliConfig, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config contains one merged Chrome feature flag');
  assert.ok(featureArgs[0].split('=')[1].split(',').includes('MacAppCodeSignClone'), 'merged Chrome flag preserves MacAppCodeSignClone');
  await fs.mkdir(screenshotRoot, { recursive: true });
  let suffix = 1;
  let screenshotDirectory = path.join(screenshotRoot, `stage27-${taskId}-${String(suffix).padStart(2, '0')}`);
  while (fsSync.existsSync(screenshotDirectory)) screenshotDirectory = path.join(screenshotRoot, `stage27-${taskId}-${String(++suffix).padStart(2, '0')}`);
  await fs.mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  const pendingScreenshotPath = path.join(screenshotDirectory, offlineFixture ? 'q27-offline-pending-confirmation.png' : 'q27-live-pending-confirmation.png');
  const confirmedScreenshotPath = path.join(screenshotDirectory, offlineFixture ? 'q27-offline-confirmed-action.png' : 'q27-live-confirmed-action.png');
  const traceScreenshotPath = path.join(screenshotDirectory, offlineFixture ? 'q27-offline-expanded-trace.png' : 'q27-live-expanded-trace.png');
  const evidencePath = path.join(screenshotDirectory, 'q27-live-expanded-trace-evidence.json');
  const evidence = { schemaVersion: 1, taskId, worktree: projectRoot, observedAt: new Date().toISOString(), status: 'RUNNING',
    offlineFixture: Boolean(offlineFixture), executionModeLabel,
    apiOrigin: new URL(apiBaseUrl).origin, runId, sessionId, browserConfigPath: cliConfig, browserConfigFeatureArg: featureArgs[0],
    cacheParent, cacheSnapshots: [{ label: 'before-browser', names: cacheBaseline }],
    protectedChromeSnapshots: [{ label: 'before-browser', ...protectedBefore }], resources: [], cliSteps: [],
    screenshots: { pendingConfirmation: pendingScreenshotPath, confirmedAction: confirmedScreenshotPath,
      liveExpandedTrace: traceScreenshotPath }, limits: { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 },
    dfBefore: dfSnapshot('before-q27-live-trace') };
  let browserOwner; let viteResource; let browserOpened = false; let chrome; let cliDirectory; let socketAlias;
  let socketAliasCreated = false; let sessionName; let failure; let cleanupError; let result;
  async function runCli(args, label, timeoutMs = 60_000) {
    const activeRemainingMs = Number.isFinite(activeDeadlineMonoMs)
      ? Math.floor(activeDeadlineMonoMs - performance.now() - 1_000) : timeoutMs;
    assert.ok(activeRemainingMs > 0, `${label} starts only while the original Q27.5 budget window still has time`);
    const boundedTimeoutMs = Math.min(timeoutMs, activeRemainingMs);
    const resource = await resourceSession.startProcess({ label, kind: 'browser', role: 'browser-cli', command: 'bash',
      args: [cliWrapper, ...(args[0] === 'open' ? ['--config', cliConfig] : []), '--session', sessionName, ...args],
      cwd: cliDirectory, env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias } });
    let stopped = await resourceSession.waitProcess(resource.id, boundedTimeoutMs);
    if (stopped.timedOut) { await resourceSession.stop(resource.id, `${label}-timeout`); stopped = await resourceSession.waitProcess(resource.id, 15_000); }
    const tail = await resourceSession.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    evidence.cliSteps.push({ label, ...resourceSummary(resource), exitCode: stopped.exitCode ?? null,
      signal: stopped.signal || null, timedOut: Boolean(stopped.timedOut), outputTail: String(tail.tail || '').slice(-8192) });
    assert.equal(stopped.status, 'exited', `${label} did not exit: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(stopped.exitCode, 0, `${label} exit code: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(stopped.signal || null, null, `${label} was signaled`);
    return String(tail.tail || '');
  }
  try {
    sessionName = `stage27-${resourceSession.instanceId.slice(0, 8)}-trace`;
    cliDirectory = await resourceSession.allocateDir('stage27-live-trace-cli');
    const socketsDirectory = await resourceSession.allocateDir('stage27-live-trace-sockets');
    socketAlias = path.join('/tmp', `pw-${resourceSession.instanceId.slice(0, 8)}-trace`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDirectory, socketAlias, 'dir'); socketAliasCreated = true;
    const profilePath = path.join(cliDirectory, 'chrome-profile');
    const openMarker = path.join(cliDirectory, 'open-status.json');
    const ownerPath = path.join(cliDirectory, 'browser-session-owner.mjs');
    const flowPath = path.join(cliDirectory, 'q27-live-pending-flow.mjs');
    const confirmationFlowPath = path.join(cliDirectory, 'q27-live-confirmation-flow.mjs');
    const apiOrigin = new URL(apiBaseUrl).origin;
    const webPort = await availablePort(); const webUrl = `http://127.0.0.1:${webPort}`;
    const viteTarget = await resourceSession.startProcess({ label: 'q27-live-trace-vite', kind: 'vite', role: 'vite', command: 'npm',
      args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      cwd: projectRoot, port: webPort, env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1',
        API_PROXY_TARGET: apiOrigin, WEB_PORT: String(webPort) } });
    viteResource = viteTarget;
    assert.equal(viteResource.status, 'running', 'Q27 live trace Vite started under ResourceSession');
    await waitForHttp(webUrl, resourceSession, viteResource.id);
    const ownerSource = `
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const child = spawn('bash', [process.env.PLAYWRIGHT_WRAPPER, '--config', process.env.PLAYWRIGHT_CONFIG, '--session', process.env.PLAYWRIGHT_SESSION,
  'open', process.env.PLAYWRIGHT_URL, '--profile', process.env.PLAYWRIGHT_PROFILE, '--idle-timeout', '0'], {
  cwd: process.cwd(), env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
    PWTEST_SOCKETS_DIR: process.env.PLAYWRIGHT_SOCKETS_DIR, TMPDIR: process.env.PLAYWRIGHT_SOCKETS_DIR,
    TMP: process.env.PLAYWRIGHT_SOCKETS_DIR, TEMP: process.env.PLAYWRIGHT_SOCKETS_DIR }, stdio: ['ignore','pipe','pipe'] });
let output=''; for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk => { output=(output+chunk.toString()).slice(-4096); process.stdout.write(chunk); });
child.once('error', error => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({code:1,error:error.message,output})); process.exitCode=1; });
child.once('close', (code,signal) => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({code,signal,output})); if(code!==0) process.exitCode=1; });
setInterval(() => {}, 1000);
`;
    await fs.writeFile(ownerPath, ownerSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    browserOwner = await resourceSession.startProcess({ label: 'q27-live-trace-playwright-owner', kind: 'browser', role: 'browser-session-owner',
      command: process.execPath, args: [ownerPath], cwd: cliDirectory, env: { PATH: process.env.PATH || '',
        PLAYWRIGHT_WRAPPER: cliWrapper, PLAYWRIGHT_CONFIG: cliConfig, PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath,
        PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: webUrl } });
    assert.equal(browserOwner.status, 'running', 'Playwright session owner started under ResourceSession'); browserOpened = true;
    const opened = await waitForFile(openMarker);
    evidence.cliSteps.push({ label: 'open', status: opened.code === 0 ? 'exited' : 'failed', exitCode: opened.code,
      signal: opened.signal || null, configPassedOnlyToOpen: true, outputTail: String(opened.output || '').slice(-4096) });
    assert.equal(opened.code, 0, `Playwright open failed: ${String(opened.output || '').slice(-1000)}`);
    assert.equal(opened.signal || null, null, 'Playwright open was not signaled');
    chrome = await identifyIsolatedChrome(profilePath);
    assert.notEqual(chrome.pid, protectedChrome.pid, 'Q27 isolated browser is not user Chrome');
    assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Q27 Chrome uses its exact isolated profile');
    const chromeFlags = chrome.command.match(/--disable-features=[^\s]+/g) || [];
    assert.deepEqual(chromeFlags, [featureArgs[0]], 'Q27 Chrome uses the one merged configured feature flag');
    evidence.chrome = { pid: chrome.pid, startTime: chrome.startTime, fingerprint: chrome.fingerprint,
      processGroup: chrome.pgid, profilePath, effectiveDisableFeatures: chromeFlags[0] };
    const protectedDuring = protectedChromeSnapshot(); assertProtectedChrome(protectedDuring, 'during Q27 trace browser', protectedClonePaths);
    evidence.protectedChromeSnapshots.push({ label: 'during-browser-open', ...protectedDuring });
    evidence.cacheSnapshots.push({ label: 'during-browser-open', names: await cacheNames() });
    assert.deepEqual(await cacheNames(), cacheBaseline, 'Q27 trace created no additional protected Chrome cache directory');

    const pendingFlowSource = `
async page => {
const assert={ok(v,m){if(!v)throw new Error(m||'assertion failed')},equal(a,b,m){if(a!==b)throw new Error(m+': expected '+b+', got '+a)},deepEqual(a,b,m){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(m+': expected '+JSON.stringify(b)+', got '+JSON.stringify(a))},includes(a,b,m){if(!String(a).includes(b))throw new Error(m+': missing '+b)}};
const webUrl=${JSON.stringify(webUrl)}, guest=${JSON.stringify({ guestId, guestUsername, guestPassword, runId, sessionId })};
const booking=${JSON.stringify({ actionRunId, needsInputCardId, slotId, slotLabel, pendingScreenshotPath })};
const externalRequests=[], pageErrors=[], chatRequests=[]; page.setDefaultTimeout(25000); page.setDefaultNavigationTimeout(25000);
page.on('request',request=>{if(request.url().includes('/api/assistant/chat')&&request.method()==='POST')chatRequests.push({url:request.url(),postData:request.postData()||''})});
await page.addInitScript(()=>{window.__q27ExternalRequests=[];window.__q27PageErrors=[]});
page.on('pageerror',error=>{const message=String(error.message||error).slice(0,500);pageErrors.push(message);
  void page.evaluate(value=>{const items=window.__q27PageErrors||[];items.push(value);window.__q27PageErrors=items},message).catch(()=>{})});
await page.route('**/*',async route=>{const url=new URL(route.request().url());if(['data:','blob:'].includes(url.protocol)||['127.0.0.1','localhost'].includes(url.hostname))return route.continue();
  externalRequests.push(url.origin);try{await page.evaluate(value=>{const items=window.__q27ExternalRequests||[];items.push(value);window.__q27ExternalRequests=items},url.origin)}catch{}
  return route.abort()});
await page.setViewportSize({width:1280,height:1080}); await page.goto(webUrl,{waitUntil:'domcontentloaded'});
const storageKey='assistant-session:guest:'+guest.guestId+':none';
await page.evaluate(({key,value})=>sessionStorage.setItem(key,JSON.stringify(value)),{key:storageKey,value:{sessionId:guest.sessionId,runId:guest.runId,reply:''}});
await page.locator('.hero-actions').getByRole('button',{name:/我是客人/}).click(); await page.getByLabel('账号').fill(guest.guestUsername); await page.getByLabel('密码').fill(guest.guestPassword);
await page.getByRole('button',{name:/进入工作区/}).click();
await page.waitForFunction(username=>{let user=null;try{user=JSON.parse(localStorage.getItem('community_user')||'null')}catch{}return user?.username===username&&Boolean(localStorage.getItem('community_token'))},guest.guestUsername,{timeout:20000});
await page.getByRole('button',{name:'打开智能助手'}).click();
const graphMessages=page.locator('.assistant-message.assistant[data-run-id="'+guest.runId+'"]');
const graphTraceMessages=page.locator('.assistant-message.assistant[data-run-id="'+guest.runId+'"]:has(.assistant-trace-toggle)');
await graphTraceMessages.waitFor({state:'visible',timeout:90000});
assert.equal(await graphTraceMessages.count(),1,'the graph run has exactly one assistant message carrying its collaboration trace');
const graphMessage=graphTraceMessages;
const graphMessageCount=await graphMessages.count();
if(${Boolean(offlineFixture)})assert.equal(graphMessageCount,2,'the offline recovery fixture preserves both persisted assistant replies for one graph run');
const graphMessageIdsBeforeReload=await graphMessages.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-message-id')));
assert.equal(new Set(graphMessageIdsBeforeReload).size,graphMessageIdsBeforeReload.length,'separate persistent history rows keep separate DOM identities');
const graphTraceMessageIdBeforeReload=await graphMessage.getAttribute('data-message-id');
assert.equal(await graphMessage.getAttribute('data-run-id'),guest.runId,'web message is the same persisted live parent run');
const proposalCard=page.locator('.assistant-action-card.status-needs_input[data-action-card-id="'+booking.needsInputCardId+'"]');
await proposalCard.waitFor({state:'visible',timeout:30000});
assert.equal(await proposalCard.count(),1,'the session shows exactly one persisted proposal card');
const proposalMessages=page.locator('.assistant-message.assistant').filter({has:proposalCard});
assert.equal(await proposalMessages.count(),1,'the proposal card belongs to exactly one assistant history message');
const proposalMessage=proposalMessages;
assert.equal(await proposalMessage.getAttribute('data-run-id'),booking.actionRunId,'the proposal card remains attached to its source run');
await page.getByRole('button',{name:'关闭智能助手'}).click();
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForFunction(username=>{let user=null;try{user=JSON.parse(localStorage.getItem('community_user')||'null')}catch{}return user?.username===username&&Boolean(localStorage.getItem('community_token'))},guest.guestUsername,{timeout:20000});
await page.getByRole('button',{name:'打开智能助手'}).click();
await graphMessage.waitFor({state:'visible',timeout:90000});
assert.equal(await graphTraceMessages.count(),1,'refresh recovery restores one trace-bearing message for the graph run');
const graphMessageIds=await graphMessages.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-message-id')));
assert.deepEqual(graphMessageIds,graphMessageIdsBeforeReload,'refresh recovery does not append duplicate copies of persisted messages');
const graphTraceMessageId=await graphMessage.getAttribute('data-message-id');
assert.equal(graphTraceMessageId,graphTraceMessageIdBeforeReload,'the run trace remains attached to the same persistent assistant message after refresh');
const recoveredProposalCard=page.locator('.assistant-action-card.status-needs_input[data-action-card-id="'+booking.needsInputCardId+'"]');
await recoveredProposalCard.waitFor({state:'visible',timeout:30000});
assert.equal(await recoveredProposalCard.count(),1,'refresh recovery restores the proposal card once');
const needsInput=proposalMessage.locator('.assistant-action-card.status-needs_input[data-action-card-id="'+booking.needsInputCardId+'"]');
await needsInput.waitFor({state:'visible',timeout:15000});
const choice=needsInput.locator('.assistant-action-choices button').filter({hasText:booking.slotLabel});
assert.equal(await choice.count(),1,'needs_input card displays the exact slot offered by the database');
const selectionResponsePromise=page.waitForResponse(response=>response.url().includes('/api/assistant/chat')&&response.request().method()==='POST',{timeout:30000});
await choice.click();
const selectionResponse=await selectionResponsePromise; assert.equal(selectionResponse.status(),202,'webpage slot selection starts one assistant follow-up run');
const selectionStart=await selectionResponse.json(); assert.ok(selectionStart.runId,'webpage selection response exposes its actual run ID');
const selectionMessages=page.locator('.assistant-message.assistant[data-run-id="'+selectionStart.runId+'"]');
const selectionMessage=selectionMessages;
await selectionMessage.waitFor({state:'visible',timeout:90000}).catch(async error=>{const state=await page.evaluate(async({runId,sessionId})=>{
  const token=localStorage.getItem('community_token')||'';let response;let body=null;try{response=await fetch('/api/assistant/runs/'+encodeURIComponent(runId)+'?role=guest',
    {headers:{authorization:'Bearer '+token},signal:AbortSignal.timeout(5000)});body=await response.json()}catch(failure){return {fetchError:String(failure),tokenPresent:Boolean(token),sessionId}}
  return {httpStatus:response.status,body,tokenPresent:Boolean(token),sessionId,chatRequests:window.__q27ChatRequests||[]};
},{runId:selectionStart.runId,sessionId:selectionStart.sessionId});throw new Error('selected slot run did not render; server state='+JSON.stringify({...state,selectionStart,chatRequests})+'; '+error.message)});
assert.equal(await selectionMessages.count(),1,'the slot-selection follow-up has one persisted assistant message');
const pending=selectionMessage.locator('.assistant-action-card.status-pending_confirmation');
await pending.waitFor({state:'visible',timeout:15000});
const pendingCardId=await pending.getAttribute('data-action-card-id');
assert.ok(pendingCardId,'deterministic server revalidation rendered a new pending confirmation card');
assert.includes(await pending.innerText(),booking.slotLabel,'pending card names the exact selected slot');
await page.screenshot({path:booking.pendingScreenshotPath,fullPage:true});
const browserState=await page.evaluate(({externalRequests,pageErrors})=>{const merge=(current,additional)=>{const values=Array.isArray(current)?current:[];
  for(const value of additional||[])if(!values.includes(value))values.push(value);return values};
  window.__q27ExternalRequests=merge(window.__q27ExternalRequests,externalRequests);
  window.__q27PageErrors=merge(window.__q27PageErrors,pageErrors);
  return {externalRequests:[...window.__q27ExternalRequests],pageErrors:[...window.__q27PageErrors]};},{externalRequests,pageErrors});
const result={runId:guest.runId,sessionId:guest.sessionId,actionRunId:booking.actionRunId,
  needsInputCardId:booking.needsInputCardId,selectionRunId:selectionStart.runId,
  pendingActionCardId:pendingCardId,selectedSlotId:booking.slotId,selectionSubmitted:true,
  graphMessageCount:graphMessageIds.length,graphMessageIds,graphTraceMessageId,historyRecoveredAfterReload:true,
  pendingScreenshotPath:booking.pendingScreenshotPath,externalRequests:browserState.externalRequests,pageErrors:browserState.pageErrors};
await page.evaluate(value=>{document.title='STAGE27_PENDING_RESULT:'+JSON.stringify(value)},result);return result;
}`;
    assertGeneratedPageFunctionParses(pendingFlowSource, 'Q27.5 pending-card');
    await fs.writeFile(flowPath, pendingFlowSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const pendingOutput = await runCli(['run-code', '--filename', flowPath], 'q27-live-slot-selection-browser-flow', 120_000);
    const pendingMatch = pendingOutput.match(/STAGE27_PENDING_RESULT:(\{[^\r\n]*\})/);
    assert.ok(pendingMatch, `Q27 pending-card browser flow omitted structured result: ${pendingOutput.slice(-1800)}`);
    const pendingResult = JSON.parse(pendingMatch[1]);
    assert.equal(pendingResult.selectionSubmitted, true);
    assert.equal(typeof verifyBeforeConfirmation, 'function', 'Q27 checks the database while the pending webpage card is still awaiting confirmation');
    const confirmationBefore = await verifyBeforeConfirmation({ guestId, slotId, actionCardId: pendingResult.pendingActionCardId,
      selectionRunId: pendingResult.selectionRunId });
    assert.equal(Number(confirmationBefore?.reservationCount || 0), 0,
      'database readback confirms there is no reservation before the webpage confirmation click');
    evidence.preConfirmationDatabaseReadback = confirmationBefore;
    evidence.pendingBrowserFlow = pendingResult;

    const confirmationFlowSource = `
async page => {
const assert={ok(v,m){if(!v)throw new Error(m||'assertion failed')},equal(a,b,m){if(a!==b)throw new Error(m+': expected '+b+', got '+a)},includes(a,b,m){if(!String(a).includes(b))throw new Error(m+': missing '+b)}};
const booking=${JSON.stringify({ ...pendingResult, confirmedScreenshotPath, traceScreenshotPath })};
page.setDefaultTimeout(25000);page.setDefaultNavigationTimeout(25000);
const selectionMessages=page.locator('.assistant-message.assistant[data-run-id="'+booking.selectionRunId+'"]');
assert.equal(await selectionMessages.count(),1,'the confirmation follow-up is selected by its unique persisted run');
const selectionMessage=selectionMessages;
const pending=selectionMessage.locator('.assistant-action-card.status-pending_confirmation[data-action-card-id="'+booking.pendingActionCardId+'"]');
await pending.waitFor({state:'visible',timeout:15000});
const confirmationResponsePromise=page.waitForResponse(response=>response.url().includes('/api/assistant/actions/'+booking.pendingActionCardId+'/confirm')
  && response.request().method()==='POST',{timeout:30000});
await pending.getByRole('button',{name:'确认并提交'}).click();
const confirmationResponse=await confirmationResponsePromise;
let confirmation=null,confirmationBodyError=null;
try{confirmation=await confirmationResponse.json()}catch(error){confirmationBodyError=String(error.message||error).slice(0,500);confirmation={}}
const confirmed=selectionMessage.locator('.assistant-action-card.status-confirmed[data-action-card-id="'+booking.pendingActionCardId+'"]');
let confirmedCardVisible=false;
if(confirmationResponse.status()===200&&confirmation.actionCard?.status==='confirmed'){
  try{await confirmed.waitFor({state:'visible',timeout:30000});confirmedCardVisible=true}catch{}
}
await page.screenshot({path:booking.confirmedScreenshotPath,fullPage:true});
const graphMessages=page.locator('.assistant-message.assistant[data-run-id="'+booking.runId+'"]');
const graphTraceMessages=page.locator('.assistant-message.assistant[data-run-id="'+booking.runId+'"]:has(.assistant-trace-toggle)');
assert.equal(await graphTraceMessages.count(),1,'the exact graph run has one trace-bearing history message after slot confirmation');
const graphMessage=graphTraceMessages;
const graphMessageIds=await graphMessages.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-message-id')));
const graphTraceMessageId=await graphMessage.getAttribute('data-message-id');
await graphMessage.waitFor({state:'visible',timeout:15000});
const graphTrace=graphMessage.locator('.assistant-trace-body');
await graphMessage.locator('.assistant-trace-toggle').click(); await graphTrace.waitFor({state:'visible'});
const traceText=await graphTrace.innerText();
for(const agent of ['household.concierge','domain.physio','domain.nutrition','domain.exercise','domain.psychology'])assert.includes(traceText,agent,'expanded web trace');
assert.includes(traceText,${JSON.stringify(executionModeLabel)},'expanded trace displays the declared execution mode');
await page.screenshot({path:booking.traceScreenshotPath,fullPage:true});
const browserEvidence=await page.evaluate(()=>({externalRequests:window.__q27ExternalRequests||[],pageErrors:window.__q27PageErrors||[]}));
const result={runId:booking.runId,sessionId:booking.sessionId,actionRunId:booking.actionRunId,
  needsInputCardId:booking.needsInputCardId,selectionRunId:booking.selectionRunId,
  pendingActionCardId:booking.pendingActionCardId,confirmedActionCardId:confirmation.actionCard?.id||null,
  selectedSlotId:booking.selectedSlotId,selectionSubmitted:true,confirmationSubmitted:true,
  confirmation:{httpStatus:confirmationResponse.status(),actionCardId:confirmation.actionCard?.id||null,
    actionCardStatus:confirmation.actionCard?.status||null,businessType:confirmation.actionCard?.result?.businessType||null,
    reservationId:confirmation.actionCard?.result?.businessId||null},confirmationBodyError,
  confirmedCardVisible,
  visibleAgentIds:['household.concierge','domain.physio','domain.nutrition','domain.exercise','domain.psychology'],
  graphMessageCount:graphMessageIds.length,graphMessageIds,graphTraceMessageId,
  traceExpanded:true,executionModeVisible:traceText.includes(${JSON.stringify(executionModeLabel)}),executionModeLabel:${JSON.stringify(executionModeLabel)},offlineFixture:${Boolean(offlineFixture)},
  externalRequests:browserEvidence.externalRequests,pageErrors:browserEvidence.pageErrors,
  viewport:{width:1280,height:1080},screenshots:{pendingConfirmation:booking.pendingScreenshotPath,
    confirmedAction:booking.confirmedScreenshotPath,liveExpandedTrace:booking.traceScreenshotPath}};
await page.evaluate(value=>{document.title='STAGE27_TRACE_RESULT:'+JSON.stringify(value)},result);return result;
}`;
    assertGeneratedPageFunctionParses(confirmationFlowSource, 'Q27.5 confirmation');
    await fs.writeFile(confirmationFlowPath, confirmationFlowSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const output = await runCli(['run-code', '--filename', confirmationFlowPath], 'q27-live-confirmation-browser-flow', 120_000);
    const match = output.match(/STAGE27_TRACE_RESULT:(\{[^\r\n]*\})/);
    assert.ok(match, `Q27 confirmation browser flow omitted structured result: ${output.slice(-1800)}`);
    result = JSON.parse(match[1]); evidence.browserFlow = result;
    const screenshotEvidence = {};
    for (const [key, screenshotPath] of Object.entries({ pendingConfirmation: pendingScreenshotPath,
      confirmedAction: confirmedScreenshotPath, liveExpandedTrace: traceScreenshotPath })) {
      const png = await fs.readFile(screenshotPath);
      assert.ok(png.length > 10_000, `Q27 ${key} screenshot is a real non-empty PNG (${png.length} bytes)`);
      screenshotEvidence[key] = { path: screenshotPath, bytes: png.length,
        sha256: crypto.createHash('sha256').update(png).digest('hex') };
    }
    evidence.screenshotFiles = screenshotEvidence;
    const closeOutput = await runCli(['close'], 'q27-live-trace-playwright-close', 30_000); browserOpened = false;
    evidence.cliSteps.push({ label: 'close-session', status: 'exited', exitCode: 0, configPassedOnlyToOpen: true,
      outputTail: closeOutput.slice(-4096) });
    const chromeDeadline = Date.now() + 15_000;
    while (processMatches(chrome.pid, chrome) && Date.now() < chromeDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
    assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `isolated Chrome ${chrome.pid} exited after close`);
    const protectedAfter = protectedChromeSnapshot(); assertProtectedChrome(protectedAfter, 'after Q27 trace browser', protectedClonePaths);
    evidence.protectedChromeSnapshots.push({ label: 'after-browser-close', ...protectedAfter });
    evidence.cacheSnapshots.push({ label: 'after-browser-close', names: await cacheNames() });
    assert.deepEqual(await cacheNames(), cacheBaseline, 'protected Chrome cache set stayed unchanged after trace capture');
  } catch (error) { failure = error;
    if (browserOpened && cliDirectory) {
      try { evidence.failureSnapshot = await runCli(['snapshot'], 'q27-live-trace-failure-snapshot', 20_000); }
      catch (snapshotError) { evidence.failureSnapshotError = String(snapshotError.message || snapshotError).slice(0, 1200); }
    }
  } finally {
    if (browserOpened && cliDirectory && socketAlias) {
      try { await runCli(['close'], 'q27-live-trace-failure-close', 30_000); browserOpened = false; }
      catch (error) { cleanupError ||= `Playwright close: ${error.message}`; }
    }
    for (const [resource, reason] of [[browserOwner, 'q27-live-trace-owner-cleanup'], [viteResource, 'q27-live-trace-vite-cleanup']]) {
      if (!resource) continue;
      try { const stopped = await stopAndWait(resourceSession, resource, reason); evidence.resources.push({ ...resourceSummary(resource),
        finalStatus: stopped.status, exitCode: stopped.exitCode ?? null, signal: stopped.signal || null, cleanup: 'stopped-and-verified-exited' }); }
      catch (error) { cleanupError ||= `${resource.label}: ${error.message}`; }
    }
    if (socketAlias && socketAliasCreated) {
      try {
        const handles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
        assert.ok([0,1].includes(handles.status), `lsof on Q27 Playwright alias exited ${handles.status}`);
        assert.equal(handles.status === 0 && Boolean(handles.stdout.trim()), false, 'Q27 Playwright alias has no open handles');
        await fs.unlink(socketAlias); socketAliasCreated = false;
        evidence.cleanupSteps = [{ command: `lsof -nP +D ${socketAlias}`, exitCode: handles.status, matchingHandles: 'none' },
          { command: `unlink ${socketAlias}`, result: 'removed-exact-symlink' }];
      } catch (error) { cleanupError ||= `Playwright alias cleanup: ${error.message}`; }
    }
    try {
      evidence.dfAfter = dfSnapshot('after-q27-live-trace');
      evidence.cacheSnapshots.push({ label: 'after-browser-cleanup', names: await cacheNames() });
      const protectedAfterCleanup = protectedChromeSnapshot(); assertProtectedChrome(protectedAfterCleanup, 'after Q27 trace cleanup', protectedClonePaths);
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-cleanup', ...protectedAfterCleanup });
      if (chrome) { evidence.chrome.exactIdentityExitedAfterCleanup = !processMatches(chrome.pid, chrome);
        assert.equal(evidence.chrome.exactIdentityExitedAfterCleanup, true, `isolated Chrome ${chrome.pid} remains after cleanup`); }
      const status = await resourceSession.status();
      evidence.liveOwnedBrowserResourcesAfterCleanup = (status.resources || []).filter(item => ['starting','running'].includes(item.status)
        && ['vite','browser'].includes(item.kind) && String(item.label || '').startsWith('q27-live-trace'));
      assert.equal(evidence.liveOwnedBrowserResourcesAfterCleanup.length, 0, 'no Q27 Vite or browser resource remains');
    } catch (error) { cleanupError ||= `final Q27 browser resource check: ${error.message}`; }
    evidence.status = failure || cleanupError ? 'FAIL' : 'PASS';
    evidence.failure = failure ? String(failure.stack || failure.message || failure).slice(0, 10_000) : null;
    evidence.cleanupError = cleanupError || null; evidence.observedAtEnd = new Date().toISOString();
    const encoded = JSON.stringify(evidence, null, 2); assert.ok(Buffer.byteLength(encoded) <= 2 * 1024 * 1024, 'Q27 trace evidence stays under 2 MiB');
    await fs.writeFile(evidencePath, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  if (failure) throw failure;
  assert.equal(cleanupError, undefined, `Q27 live trace cleanup failed: ${cleanupError}`);
  return { status: 'PASS', screenshotDirectory, evidencePath, screenshots: evidence.screenshotFiles,
    preConfirmationDatabaseReadback: evidence.preConfirmationDatabaseReadback,
    browserFlow: result, dfBefore: evidence.dfBefore, dfAfter: evidence.dfAfter };
}

export async function runStage27EnvironmentBrowser({ resourceSession, apiBaseUrl, guestUsername,
  guestPassword, targetDate, expectedSnapshotId, expectedLocation, expectedDomains,
  expectedModeledSeaLevel = null, offlineFixture = false }) {
  assert.ok(taskId && resourceSession && apiBaseUrl && guestUsername && guestPassword
    && targetDate && expectedSnapshotId && expectedLocation?.id,
  'Q27.6 browser workflow needs the active ResourceSession, live API, synthetic guest, date, and exact environment snapshot');
  const cacheBaseline = await cacheNames();
  assert.deepEqual(cacheBaseline, expectedCacheNames, 'protected Chrome cache inventory matches the inherited baseline');
  const protectedBefore = protectedChromeSnapshot(); assertProtectedChrome(protectedBefore, 'before Q27 environment browser');
  const protectedClonePaths = [...protectedBefore.clonePaths];
  const config = JSON.parse(await fs.readFile(cliConfig, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  assert.equal(featureArgs.length, 1, 'Playwright config contains one merged Chrome feature flag');
  assert.ok(featureArgs[0].split('=')[1].split(',').includes('MacAppCodeSignClone'), 'merged Chrome flag preserves MacAppCodeSignClone');
  await fs.mkdir(screenshotRoot, { recursive: true });
  let suffix = 1;
  let screenshotDirectory = path.join(screenshotRoot, `stage27-${taskId}-q276-${String(suffix).padStart(2, '0')}`);
  while (fsSync.existsSync(screenshotDirectory)) screenshotDirectory = path.join(screenshotRoot,
    `stage27-${taskId}-q276-${String(++suffix).padStart(2, '0')}`);
  await fs.mkdir(screenshotDirectory, { recursive: true, mode: 0o700 });
  const screenshotPath = path.join(screenshotDirectory, offlineFixture ? 'q276-offline-environment-panel.png' : 'q276-live-environment-panel.png');
  const evidencePath = path.join(screenshotDirectory, 'q276-live-environment-browser-evidence.json');
  const evidence = { schemaVersion: 1, taskId, worktree: projectRoot, observedAt: new Date().toISOString(), status: 'RUNNING',
    offlineFixture: Boolean(offlineFixture), apiOrigin: new URL(apiBaseUrl).origin, targetDate, expectedSnapshotId, expectedLocation, expectedDomains, expectedModeledSeaLevel,
    browserConfigPath: cliConfig, browserConfigFeatureArg: featureArgs[0], cacheParent,
    cacheSnapshots: [{ label: 'before-browser', names: cacheBaseline }],
    protectedChromeSnapshots: [{ label: 'before-browser', ...protectedBefore }], resources: [], cliSteps: [],
    screenshotPath, limits: { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 },
    dfBefore: dfSnapshot('before-q27-q276-environment-browser') };
  let browserOwner; let viteResource; let browserOpened = false; let chrome; let cliDirectory; let socketAlias;
  let socketAliasCreated = false; let sessionName; let failure; let cleanupError; let result;
  async function runCli(args, label, timeoutMs = 60_000) {
    const resource = await resourceSession.startProcess({ label, kind: 'browser', role: 'browser-cli', command: 'bash',
      args: [cliWrapper, ...(args[0] === 'open' ? ['--config', cliConfig] : []), '--session', sessionName, ...args],
      cwd: cliDirectory, env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
        PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias } });
    let stopped = await resourceSession.waitProcess(resource.id, timeoutMs);
    if (stopped.timedOut) { await resourceSession.stop(resource.id, `${label}-timeout`); stopped = await resourceSession.waitProcess(resource.id, 15_000); }
    const tail = await resourceSession.rpc({ op: 'log-tail', id: resource.id, maxBytes: 32 * 1024 }).catch(() => ({}));
    evidence.cliSteps.push({ label, ...resourceSummary(resource), exitCode: stopped.exitCode ?? null,
      signal: stopped.signal || null, timedOut: Boolean(stopped.timedOut), outputTail: String(tail.tail || '').slice(-8192) });
    assert.equal(stopped.status, 'exited', `${label} did not exit: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(stopped.exitCode, 0, `${label} exit code: ${String(tail.tail || '').slice(-1200)}`);
    assert.equal(stopped.signal || null, null, `${label} was signaled`);
    return String(tail.tail || '');
  }
  try {
    sessionName = `stage27-${resourceSession.instanceId.slice(0, 8)}-q276`;
    cliDirectory = await resourceSession.allocateDir('stage27-q276-browser-cli');
    const socketsDirectory = await resourceSession.allocateDir('stage27-q276-browser-sockets');
    socketAlias = path.join('/tmp', `pw-${resourceSession.instanceId.slice(0, 8)}-q276`);
    try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright alias ${socketAlias}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.symlink(socketsDirectory, socketAlias, 'dir'); socketAliasCreated = true;
    const profilePath = path.join(cliDirectory, 'chrome-profile');
    const openMarker = path.join(cliDirectory, 'open-status.json');
    const ownerPath = path.join(cliDirectory, 'browser-session-owner.mjs');
    const flowPath = path.join(cliDirectory, 'q276-environment-panel-flow.mjs');
    const apiOrigin = new URL(apiBaseUrl).origin;
    const webPort = await availablePort(); const webUrl = `http://127.0.0.1:${webPort}`;
    viteResource = await resourceSession.startProcess({ label: 'q27-q276-environment-vite', kind: 'vite', role: 'vite', command: 'npm',
      args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      cwd: projectRoot, port: webPort, env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1',
        API_PROXY_TARGET: apiOrigin, WEB_PORT: String(webPort) } });
    assert.equal(viteResource.status, 'running', 'Q27.6 environment Vite started under ResourceSession');
    await waitForHttp(webUrl, resourceSession, viteResource.id);
    const ownerSource = `
import { spawn } from 'node:child_process'; import fs from 'node:fs';
const child = spawn('bash', [process.env.PLAYWRIGHT_WRAPPER, '--config', process.env.PLAYWRIGHT_CONFIG, '--session', process.env.PLAYWRIGHT_SESSION,
  'open', process.env.PLAYWRIGHT_URL, '--profile', process.env.PLAYWRIGHT_PROFILE, '--idle-timeout', '0'], {
  cwd: process.cwd(), env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1',
    PWTEST_SOCKETS_DIR: process.env.PLAYWRIGHT_SOCKETS_DIR, TMPDIR: process.env.PLAYWRIGHT_SOCKETS_DIR,
    TMP: process.env.PLAYWRIGHT_SOCKETS_DIR, TEMP: process.env.PLAYWRIGHT_SOCKETS_DIR }, stdio: ['ignore','pipe','pipe'] });
let output=''; for (const stream of [child.stdout,child.stderr]) stream.on('data', chunk => { output=(output+chunk.toString()).slice(-4096); process.stdout.write(chunk); });
child.once('error', error => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({code:1,error:error.message,output})); process.exitCode=1; });
child.once('close', (code,signal) => { fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER, JSON.stringify({code,signal,output})); if(code!==0) process.exitCode=1; });
setInterval(() => {}, 1000);
`;
    await fs.writeFile(ownerPath, ownerSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    browserOwner = await resourceSession.startProcess({ label: 'q27-q276-environment-playwright-owner', kind: 'browser', role: 'browser-session-owner',
      command: process.execPath, args: [ownerPath], cwd: cliDirectory, env: { PATH: process.env.PATH || '',
        PLAYWRIGHT_WRAPPER: cliWrapper, PLAYWRIGHT_CONFIG: cliConfig, PLAYWRIGHT_SESSION: sessionName, PLAYWRIGHT_PROFILE: profilePath,
        PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketAlias, PLAYWRIGHT_URL: webUrl } });
    assert.equal(browserOwner.status, 'running', 'Q27.6 Playwright owner started under ResourceSession'); browserOpened = true;
    const opened = await waitForFile(openMarker);
    evidence.cliSteps.push({ label: 'open', status: opened.code === 0 ? 'exited' : 'failed', exitCode: opened.code,
      signal: opened.signal || null, configPassedOnlyToOpen: true, outputTail: String(opened.output || '').slice(-4096) });
    assert.equal(opened.code, 0, `Q27.6 Playwright open failed: ${String(opened.output || '').slice(-1000)}`);
    assert.equal(opened.signal || null, null, 'Q27.6 Playwright open was not signaled');
    chrome = await identifyIsolatedChrome(profilePath);
    assert.notEqual(chrome.pid, protectedChrome.pid, 'Q27.6 isolated browser is not user Chrome');
    assert.ok(chrome.command.includes(`--user-data-dir=${profilePath}`), 'Q27.6 Chrome uses its exact isolated profile');
    const chromeFlags = chrome.command.match(/--disable-features=[^\s]+/g) || [];
    assert.deepEqual(chromeFlags, [featureArgs[0]], 'Q27.6 Chrome uses the one merged configured feature flag');
    evidence.chrome = { pid: chrome.pid, startTime: chrome.startTime, fingerprint: chrome.fingerprint,
      processGroup: chrome.pgid, profilePath, effectiveDisableFeatures: chromeFlags[0] };
    const protectedDuring = protectedChromeSnapshot(); assertProtectedChrome(protectedDuring, 'during Q27.6 environment browser', protectedClonePaths);
    evidence.protectedChromeSnapshots.push({ label: 'during-browser-open', ...protectedDuring });
    evidence.cacheSnapshots.push({ label: 'during-browser-open', names: await cacheNames() });
    assert.deepEqual(await cacheNames(), cacheBaseline, 'Q27.6 browser created no additional protected Chrome cache directory');

    const flowSource = `
async page => {
const assert={ok(v,m){if(!v)throw new Error(m||'assertion failed')},equal(a,b,m){if(a!==b)throw new Error(m+': expected '+b+', got '+a)},deepEqual(a,b,m){if(JSON.stringify(a)!==JSON.stringify(b))throw new Error(m+': expected '+JSON.stringify(b)+', got '+JSON.stringify(a))},includes(a,b,m){if(!String(a).includes(b))throw new Error(m+': missing '+b)}};
const webUrl=${JSON.stringify(webUrl)},guest=${JSON.stringify({ guestUsername, guestPassword })};
const targetDate=${JSON.stringify(targetDate)},expectedSnapshotId=${JSON.stringify(expectedSnapshotId)};
const expectedLocation=${JSON.stringify(expectedLocation)},expectedDomains=${JSON.stringify(expectedDomains)},expectedModeledSeaLevel=${JSON.stringify(expectedModeledSeaLevel)},screenshotPath=${JSON.stringify(screenshotPath)};
const externalRequests=[],pageErrors=[];page.setDefaultTimeout(25000);page.setDefaultNavigationTimeout(25000);
await page.addInitScript(()=>{window.__q276ExternalRequests=[];window.__q276PageErrors=[]});
page.on('pageerror',error=>{const message=String(error.message||error).slice(0,500);pageErrors.push(message);
  void page.evaluate(value=>{const rows=window.__q276PageErrors||[];rows.push(value);window.__q276PageErrors=rows},message).catch(()=>{})});
await page.route('**/*',async route=>{const url=new URL(route.request().url());if(['data:','blob:'].includes(url.protocol)||['127.0.0.1','localhost'].includes(url.hostname))return route.continue();
  externalRequests.push(url.origin);try{await page.evaluate(value=>{const rows=window.__q276ExternalRequests||[];rows.push(value);window.__q276ExternalRequests=rows},url.origin)}catch{}
  return route.abort()});
await page.setViewportSize({width:1280,height:900});
await page.goto(webUrl,{waitUntil:'domcontentloaded'});
await page.locator('.hero-actions').getByRole('button',{name:/我是客人/}).click();await page.getByLabel('账号').fill(guest.guestUsername);await page.getByLabel('密码').fill(guest.guestPassword);
const envResponsePromise=page.waitForResponse(response=>{const url=new URL(response.url());return url.pathname.endsWith('/api/environment')&&url.searchParams.get('date')===targetDate},{timeout:30000});
await page.getByRole('button',{name:/进入工作区/}).click();
await page.waitForFunction(username=>{let user=null;try{user=JSON.parse(localStorage.getItem('community_user')||'null')}catch{}return user?.username===username&&Boolean(localStorage.getItem('community_token'))},guest.guestUsername,{timeout:20000});
const panel=page.locator('.environment-panel-home');await panel.waitFor({state:'visible',timeout:30000});
const response=await envResponsePromise;assert.equal(response.status(),200,'environment panel loaded the authenticated API snapshot');
const apiSnapshot=await response.json();assert.equal(apiSnapshot.snapshotId,expectedSnapshotId,'webpage and API display the exact same environment snapshot');
assert.equal(apiSnapshot.targetDate,targetDate,'webpage and API use the same target date');assert.equal(apiSnapshot.location.id,expectedLocation.id);
if(${Boolean(offlineFixture)}){assert.equal(apiSnapshot.providerFixture?.mode,'offline_fixture','API marks this as an offline fixture');
  assert.includes(await panel.innerText(),'离线网页夹具 · 未访问外部供应商','page discloses that provider data is a local fixture');}
for(const domain of ['weather','tide','marine'])assert.equal(apiSnapshot[domain]?.status,expectedDomains[domain],domain+' status matches live API evidence');
const locationText=await panel.locator('.environment-location').innerText();assert.includes(locationText,expectedLocation.name,'webpage marks the region representative point');
assert.includes(locationText,'非机构精确地址','webpage states this is not the institution address');
const panelText=await panel.innerText();
assert.includes(panelText,apiSnapshot.weather.sourceName||'来源不可用','webpage displays the actual weather source');
assert.includes(panelText,apiSnapshot.marine.sourceName||'来源不可用','webpage displays the actual marine source');
assert.includes(panelText,'有效波高','webpage shows wave height in its own field');
assert.includes(panelText,'含潮汐的模式海面高度（预测）','webpage labels modeled sea level explicitly as a forecast');
assert.includes(panelText,apiSnapshot.weather.observedAt,'webpage displays the same normalized UTC weather observation instant as the API');
assert.includes(panelText,apiSnapshot.expiresAt||'有效至 无有效期','webpage displays snapshot expiry');
if(expectedModeledSeaLevel){const tide=apiSnapshot.tide,marine=apiSnapshot.marine,expected=expectedModeledSeaLevel;
  assert.equal(tide.mode,'modeled-sea-level-including-tides','tide domain is the modeled sea-level-with-tides feature');
  assert.equal(tide.status,expected.tideStatus,'modeled tide status matches the adapter evidence');
  assert.equal(tide.typeLabel,'含潮汐的模式海面高度（预测）');assert.equal(tide.verticalDatum,'global mean sea level');assert.equal(tide.unit,'m');
  assert.equal(tide.sourceResponseHash,marine.providerResponseHash,'modeled tide uses the same response as Marine');
  assert.equal(tide.sourceResponseHash,expected.responseHash,'browser snapshot matches the adapter response hash');
  assert.equal(tide.retrievedAt,marine.retrievedAt,'modeled tide shares Marine retrieval time');assert.equal(tide.expiresAt,marine.expiresAt,'modeled tide shares Marine expiry');
  assert.deepEqual(tide.providerCoordinates,marine.providerCoordinates,'modeled tide and Marine share the same provider grid');
  assert.equal(marine.variableStatus?.modeledSeaLevelIncludingTides,'available','the Marine response contains complete model sea-level values');
  assert.ok(tide.hourly?.length>=24&&tide.hourly.every(item=>Number.isFinite(item.heightM)),'the modeled tide domain has a full hourly series');
  assert.includes(panelText,'全球平均海平面基准','webpage identifies the model datum');
  assert.includes(panelText,'不是官方站点实测潮位','webpage discloses that the model is not a station observation');
  assert.includes(locationText,'站点潮位：当前模式不提供','modeled mode explains that station tide is outside its scope');
  assert.equal(locationText.includes('潮汐站 未配置'),false,'missing station configuration is not presented as a requirement in modeled mode');
  assert.includes(panelText,'站点高潮 / 低潮时刻','page distinguishes station tide events from modeled sea level');
  assert.includes(panelText,'当前模式不提供站点精确潮汐时刻','modeled mode explains that it has no exact station high/low event times');
}
const browserState=await page.evaluate(({externalRequests,pageErrors})=>{const merge=(current,extra)=>{const rows=Array.isArray(current)?current:[];for(const value of extra||[])if(!rows.includes(value))rows.push(value);return rows};
  window.__q276ExternalRequests=merge(window.__q276ExternalRequests,externalRequests);window.__q276PageErrors=merge(window.__q276PageErrors,pageErrors);
  return {externalRequests:[...window.__q276ExternalRequests],pageErrors:[...window.__q276PageErrors]};},{externalRequests,pageErrors});
await panel.screenshot({path:screenshotPath});
const result={status:apiSnapshot.status,targetDate,snapshotId:apiSnapshot.snapshotId,expiresAt:apiSnapshot.expiresAt,
  location:apiSnapshot.location,domains:Object.fromEntries(['weather','tide','marine'].map(domain=>[domain,{status:apiSnapshot[domain]?.status,
    sourceName:apiSnapshot[domain]?.sourceName||null,sourceUrl:apiSnapshot[domain]?.sourceUrl||null,
    observedAt:apiSnapshot[domain]?.observedAt||null,retrievedAt:apiSnapshot[domain]?.retrievedAt||null,
    updatedAt:apiSnapshot[domain]?.updatedAt||null,expiresAt:apiSnapshot[domain]?.expiresAt||null,
    units:apiSnapshot[domain]?.units||null,providerCoordinates:apiSnapshot[domain]?.providerCoordinates||null,
  stationId:apiSnapshot[domain]?.stationId||null,providerResponseHash:apiSnapshot[domain]?.providerResponseHash||null,
  variableStatus:apiSnapshot[domain]?.variableStatus||null,mode:apiSnapshot[domain]?.mode||null,verticalDatum:apiSnapshot[domain]?.verticalDatum||null}])),
  modeledTideSharesMarineResponse:apiSnapshot.tide?.sourceResponseHash===apiSnapshot.marine?.providerResponseHash,
  externalRequests:browserState.externalRequests,pageErrors:browserState.pageErrors,screenshotPath};
assert.equal(result.externalRequests.length,0,'Q27.6 environment browser made no external browser request');
assert.equal(result.pageErrors.length,0,'Q27.6 environment browser had no page exception');
await page.evaluate(value=>{document.title='STAGE27_Q276_RESULT:'+JSON.stringify(value)},result);return result;
}`;
    assertGeneratedPageFunctionParses(flowSource, 'Q27.6 environment panel');
    await fs.writeFile(flowPath, flowSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const output = await runCli(['run-code', '--filename', flowPath], 'q27-q276-environment-panel-flow', 90_000);
    const match = output.match(/STAGE27_Q276_RESULT:(\{[^\r\n]*\})/);
    assert.ok(match, `Q27.6 environment browser omitted structured result: ${output.slice(-1800)}`);
    result = JSON.parse(match[1]); evidence.browserFlow = result;
    const png = await fs.readFile(screenshotPath);
    assert.ok(png.length > 8_000, `Q27.6 environment screenshot is a real non-empty PNG (${png.length} bytes)`);
    evidence.screenshot = { path: screenshotPath, bytes: png.length, sha256: crypto.createHash('sha256').update(png).digest('hex') };
    const closeOutput = await runCli(['close'], 'q27-q276-environment-browser-close', 30_000); browserOpened = false;
    evidence.cliSteps.push({ label: 'close-session', status: 'exited', exitCode: 0, configPassedOnlyToOpen: true,
      outputTail: closeOutput.slice(-4096) });
    const chromeDeadline = Date.now() + 15_000;
    while (processMatches(chrome.pid, chrome) && Date.now() < chromeDeadline) await new Promise(resolve => setTimeout(resolve, 100));
    evidence.chrome.exactIdentityExitedAfterClose = !processMatches(chrome.pid, chrome);
    assert.equal(evidence.chrome.exactIdentityExitedAfterClose, true, `Q27.6 isolated Chrome ${chrome.pid} exited after close`);
    const protectedAfter = protectedChromeSnapshot(); assertProtectedChrome(protectedAfter, 'after Q27.6 environment browser', protectedClonePaths);
    evidence.protectedChromeSnapshots.push({ label: 'after-browser-close', ...protectedAfter });
    evidence.cacheSnapshots.push({ label: 'after-browser-close', names: await cacheNames() });
    assert.deepEqual(await cacheNames(), cacheBaseline, 'protected Chrome cache set stayed unchanged after Q27.6 capture');
  } catch (error) { failure = error;
    if (browserOpened && cliDirectory) {
      try { evidence.failureSnapshot = await runCli(['snapshot'], 'q27-q276-environment-failure-snapshot', 20_000); }
      catch (snapshotError) { evidence.failureSnapshotError = String(snapshotError.message || snapshotError).slice(0, 1200); }
    }
  } finally {
    if (browserOpened && cliDirectory && socketAlias) {
      try { await runCli(['close'], 'q27-q276-environment-failure-close', 30_000); browserOpened = false; }
      catch (error) { cleanupError ||= `Playwright close: ${error.message}`; }
    }
    for (const [resource, reason] of [[browserOwner, 'q27-q276-environment-owner-cleanup'], [viteResource, 'q27-q276-environment-vite-cleanup']]) {
      if (!resource) continue;
      try { const stopped = await stopAndWait(resourceSession, resource, reason); evidence.resources.push({ ...resourceSummary(resource),
        finalStatus: stopped.status, exitCode: stopped.exitCode ?? null, signal: stopped.signal || null, cleanup: 'stopped-and-verified-exited' }); }
      catch (error) { cleanupError ||= `${resource.label}: ${error.message}`; }
    }
    if (socketAlias && socketAliasCreated) {
      try {
        const handles = runBounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
        assert.ok([0, 1].includes(handles.status), `lsof on Q27.6 Playwright alias exited ${handles.status}`);
        assert.equal(handles.status === 0 && Boolean(handles.stdout.trim()), false, 'Q27.6 Playwright alias has no open handles');
        await fs.unlink(socketAlias); socketAliasCreated = false;
        evidence.cleanupSteps = [{ command: `lsof -nP +D ${socketAlias}`, exitCode: handles.status, matchingHandles: 'none' },
          { command: `unlink ${socketAlias}`, result: 'removed-exact-symlink' }];
      } catch (error) { cleanupError ||= `Playwright alias cleanup: ${error.message}`; }
    }
    try {
      evidence.dfAfter = dfSnapshot('after-q27-q276-environment-browser');
      evidence.cacheSnapshots.push({ label: 'after-browser-cleanup', names: await cacheNames() });
      const protectedAfterCleanup = protectedChromeSnapshot(); assertProtectedChrome(protectedAfterCleanup, 'after Q27.6 environment cleanup', protectedClonePaths);
      evidence.protectedChromeSnapshots.push({ label: 'after-browser-cleanup', ...protectedAfterCleanup });
      if (chrome) { evidence.chrome.exactIdentityExitedAfterCleanup = !processMatches(chrome.pid, chrome);
        assert.equal(evidence.chrome.exactIdentityExitedAfterCleanup, true, `Q27.6 isolated Chrome ${chrome.pid} remains after cleanup`); }
      const status = await resourceSession.status();
      evidence.liveOwnedBrowserResourcesAfterCleanup = (status.resources || []).filter(item => ['starting', 'running'].includes(item.status)
        && ['vite', 'browser'].includes(item.kind) && String(item.label || '').startsWith('q27-q276-environment'));
      assert.equal(evidence.liveOwnedBrowserResourcesAfterCleanup.length, 0, 'no Q27.6 environment Vite or browser resource remains');
    } catch (error) { cleanupError ||= `final Q27.6 browser resource check: ${error.message}`; }
    evidence.status = failure || cleanupError ? 'FAIL' : 'PASS';
    evidence.failure = failure ? String(failure.stack || failure.message || failure).slice(0, 10_000) : null;
    evidence.cleanupError = cleanupError || null; evidence.observedAtEnd = new Date().toISOString();
    const encoded = JSON.stringify(evidence, null, 2);
    assert.ok(Buffer.byteLength(encoded) <= 2 * 1024 * 1024, 'Q27.6 browser evidence stays under 2 MiB');
    await fs.writeFile(evidencePath, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  if (failure) throw failure;
  assert.equal(cleanupError, undefined, `Q27.6 environment browser cleanup failed: ${cleanupError}`);
  return { status: 'PASS', screenshotPath, evidencePath, browserFlow: result, dfBefore: evidence.dfBefore, dfAfter: evidence.dfAfter };
}
