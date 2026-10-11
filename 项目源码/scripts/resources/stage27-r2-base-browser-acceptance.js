import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './resource-runtime.js';
import { withTemporaryApi } from '../quests/helpers.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfig = path.join(projectRoot, 'scripts/resources/playwright-cli.config.json');
const expectedChromePid = 7081;
const expectedChromeStartTime = 'Thu Oct 1 17:27:01 2026';
const expectedChromeFingerprint = 'a30da864807c765187c20eb24b90dfaedb6d8273c8675d112e09016b42ec949d';
const protectedCloneNames = ['code_sign_clone.7WCMBh', 'code_sign_clone.87prgQ', 'code_sign_clone.FGf0ku',
  'code_sign_clone.KlYqcP', 'code_sign_clone.Km1hwm', 'code_sign_clone.Ly34OH', 'code_sign_clone.b9cnAV',
  'code_sign_clone.fpg2xz', 'code_sign_clone.jcG5XI', 'code_sign_clone.ooLA7h', 'code_sign_clone.xkTnpB'];
const cloneParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';

function stableProcessIdentity(pid) {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try { return processIdentity(pid); }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

function bounded(command, args, timeout = 5000, maxBuffer = 256 * 1024) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} interrupted by ${result.signal}`);
  return result;
}

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

function chromeSnapshot() {
  const identity = stableProcessIdentity(expectedChromePid);
  const handles = bounded('lsof', ['-nP', '-p', String(expectedChromePid), '-Fn'], 5000, 64 * 1024);
  assert.ok([0, 1].includes(handles.status), `protected Chrome lsof exited ${handles.status}`);
  const clonePaths = (handles.stdout || '').split(/\r?\n/u).filter(line => line.startsWith('n') && line.includes('/code_sign_clone.'))
    .map(line => line.slice(1).slice(0, 2048)).sort();
  const cacheNames = fsSync.readdirSync(cloneParent).filter(name => name.startsWith('code_sign_clone.')).sort();
  return { identity, lsofExitCode: handles.status, clonePaths, cacheNames };
}

function assertChrome(snapshot, label, baseline) {
  assert.equal(snapshot.identity?.pid, expectedChromePid, `${label}: protected Chrome still has PID ${expectedChromePid}`);
  assert.equal(snapshot.identity.startTime.replace(/\s+/gu, ' '), expectedChromeStartTime, `${label}: protected Chrome start time`);
  assert.equal(snapshot.identity.fingerprint, expectedChromeFingerprint, `${label}: protected Chrome fingerprint`);
  assert.deepEqual(snapshot.cacheNames, protectedCloneNames, `${label}: the pre-existing 11 Chrome code-sign caches remain intact`);
  for (const handlePath of snapshot.clonePaths) {
    const relative = path.relative(cloneParent, handlePath);
    assert.ok(relative && !relative.startsWith('..') && protectedCloneNames.includes(relative.split(path.sep)[0]),
      `${label}: Chrome handle remains in the known cache set (${handlePath})`);
  }
  if (baseline) assert.deepEqual(snapshot.clonePaths, baseline.clonePaths, `${label}: protected Chrome handles did not change`);
}

function processSummary(resource) {
  return resource ? { id: resource.id, label: resource.label, kind: resource.kind, role: resource.role,
    status: resource.status, pid: resource.pid, processGroup: resource.processGroup,
    processStartTime: resource.processStartTime, processFingerprint: resource.processFingerprint,
    command: resource.command, cwd: resource.cwd, tempDir: resource.tempDir, port: resource.port,
    logPath: resource.logPath, logBytes: resource.logBytes, maxLogBytes: resource.maxLogBytes,
    directoryPeakBytes: resource.directoryPeakBytes, maxDirectoryBytes: resource.maxDirectoryBytes,
    pids: resource.pids } : null;
}

async function waitForHttp(url, resourceSession, resourceId) {
  const deadline = Date.now() + 20_000;
  let reason = 'not ready';
  while (Date.now() < deadline) {
    const current = (await resourceSession.status()).resources?.find(item => item.id === resourceId);
    if (!current || !['starting', 'running'].includes(current.status)) {
      const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
      throw new Error(`Vite stopped before readiness: ${tail.tail || current?.status || 'resource missing'}`);
    }
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return; reason = `HTTP ${response.status}`; }
    catch (error) { reason = error.message; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const tail = await resourceSession.rpc({ op: 'log-tail', id: resourceId, maxBytes: 4096 }).catch(() => ({}));
  throw new Error(`Vite readiness timed out (${reason}): ${tail.tail || ''}`);
}

async function waitForFile(filePath, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${path.basename(filePath)}`);
}

async function stopResource(resourceSession, resource, reason) {
  if (!resource) return null;
  const current = (await resourceSession.status()).resources?.find(item => item.id === resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await resourceSession.stop(resource.id, reason);
    if (!stopped.ok) throw new Error(`${resource.label} stop failed: ${stopped.error || 'unknown'}`);
  }
  const exit = await resourceSession.waitProcess(resource.id, 20_000);
  assert.ok(!exit.timedOut && !exit.unavailable && !['starting', 'running'].includes(exit.status),
    `${resource.label} did not exit: ${JSON.stringify(exit)}`);
  return exit;
}

export async function runStage27R2BaseBrowserAcceptance({ resourceSession, attempt = 1, runId }) {
  assert.ok(resourceSession, 'R2 browser acceptance requires the active ResourceSession');
  const taskId = process.env.CODEX_TASK_ID || 'missing-task-id';
  assert.match(taskId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    'browser evidence records the actual Codex task identity');
  assert.equal(process.env.CODEX_STAGE27_SCOPE, 'R2', 'browser flow is explicitly scoped to R2');
  assert.match(String(runId || ''), /^[0-9TZ-]+-[0-9a-f]{12}$/u, 'browser run has a unique identifier');
  assert.ok(fsSync.existsSync(playwrightWrapper), 'the installed Playwright CLI wrapper is available');
  assert.ok(fsSync.existsSync(playwrightConfig), 'the project Playwright config exists');
  const config = JSON.parse(await fs.readFile(playwrightConfig, 'utf8'));
  assert.equal(config.browser?.launchOptions?.channel, 'chrome');
  assert.ok((config.browser?.launchOptions?.args || []).some(value => value.includes('MacAppCodeSignClone')),
    'the configured isolated Chrome feature merge is enabled');

  const baselineChrome = chromeSnapshot();
  assertChrome(baselineChrome, 'before isolated browser', null);
  const protectedVsCode = stableProcessIdentity(67464);
  assert.equal(protectedVsCode?.pid, 67464, 'protected VS Code process 67464 is present before acceptance');
  assert.ok(Number.isSafeInteger(attempt) && attempt > 0, 'browser attempt number is positive');
  const outputDirectory = path.join(projectRoot, 'output/playwright', `stage27-r2-${taskId}-${runId}`);
  await fs.mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  const tempDirectory = await resourceSession.allocateDir('stage27-r2-browser');
  const socketsDirectory = await resourceSession.allocateDir('stage27-r2-playwright-sockets');
  const socketAlias = path.join('/tmp', `pw-${resourceSession.instanceId.slice(0, 8)}`);
  try { await fs.lstat(socketAlias); throw new Error(`refusing to replace existing Playwright socket alias ${socketAlias}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await fs.symlink(socketsDirectory, socketAlias, 'dir');

  const evidence = { schemaVersion: 1, taskId, producerTaskId: taskId, attempt, runId, status: 'RUNNING', startedAt: new Date().toISOString(),
    worktree: projectRoot, browserConfig: path.relative(projectRoot, playwrightConfig),
    playwrightWrapper, protectedChromeBefore: baselineChrome, protectedVsCodeBefore: protectedVsCode,
    resources: [], assertions: [], screenshots: [], consoleErrors: [], pageErrors: [], externalRequests: [], cliSteps: [] };
  const screenshot = name => path.join(outputDirectory, `${name}.png`);
  const sessionName = `stage27-r2-${taskId.slice(0, 8)}-${runId.slice(-12)}`;
  const profilePath = path.join(tempDirectory, 'chrome-profile');
  const openMarker = path.join(tempDirectory, 'open-status.json');
  const ownerPath = path.join(tempDirectory, 'browser-owner.mjs');
  const flowPath = path.join(tempDirectory, 'base-flow.mjs');
  const playwrightEnv = { PATH: process.env.PATH || '/usr/bin:/bin', npm_config_offline: 'true',
    NODE_DISABLE_COMPILE_CACHE: '1', PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias };
  const runCli = async (args, label, timeoutMs = 60_000) => {
    const startedAt = Date.now();
    const resource = await resourceSession.runProcess({ label, kind: 'browser', role: 'playwright-cli',
      command: 'bash', args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfig] : []),
        '--session', sessionName, ...args], cwd: projectRoot,
      env: { ...playwrightEnv, CODEX_TASK_ID: taskId, CODEX_STAGE27_SCOPE: 'R2' }, leaseMs: 15 * 60 * 1000 }, { timeoutMs });
    const receipt = { label, exitCode: resource.exitCode, signal: resource.signal || null,
      status: resource.status, elapsedMs: Date.now() - startedAt, pid: resource.pid,
      processStartTime: resource.processStartTime, processFingerprint: resource.processFingerprint,
      resourceId: resource.id, logPath: resource.logPath, logBytes: resource.logBytes,
      allTrackedPidsExited: resource.pids?.every(item => item.exitConfirmed === true) === true,
      outputTail: String(resource.tail || '').slice(-64 * 1024) };
    evidence.cliSteps.push(receipt);
    assert.equal(receipt.status, 'exited', `${label} exits cleanly`);
    assert.equal(receipt.exitCode, 0, `${label} exit code is 0: ${receipt.outputTail}`);
    assert.equal(receipt.signal, null, `${label} was not signaled`);
    assert.equal(receipt.allTrackedPidsExited, true, `${label} descendants exited`);
    return receipt.outputTail;
  };

  let viteResource;
  let browserOwner;
  let browserOpened = false;
  let apiAndBrowserResult;
  let executionError;
  try {
    apiAndBrowserResult = await withTemporaryApi(async context => {
    const health = await fetch(context.baseUrl.replace(/\/api$/u, '/api/health'));
    const healthJson = await health.json();
    assert.equal(health.status, 200); assert.equal(healthJson.ok, true);
    assert.ok(fsSync.existsSync(context.databasePath), 'the API created its SQLite database inside the managed resource directory');
    const dbHeader = await fs.readFile(context.databasePath);
    assert.equal(dbHeader.subarray(0, 15).toString('ascii'), 'SQLite format 3', 'managed database is a real SQLite file');
    evidence.assertions.push({ questId: 'Q1.3', result: 'PASS', action: 'GET /api/health on the isolated SQLite API',
      expected: 'HTTP 200 and ok=true', actual: { status: health.status, ok: healthJson.ok } });
    evidence.assertions.push({ questId: 'Q1.5', result: 'PASS', action: 'inspect DB_PATH created by managed API startup',
      expected: 'SQLite database exists under ResourceSession', actual: { path: context.databasePath,
        bytes: dbHeader.length, header: dbHeader.subarray(0, 15).toString('ascii') } });
    const databaseIdentityBeforeRestart = await fs.stat(context.databasePath);
    const restartedBaseUrl = await context.restartApi();
    const restartResponse = await fetch(restartedBaseUrl.replace(/\/api$/u, '/api/health'));
    const restartHealth = await restartResponse.json();
    const databaseIdentityAfterRestart = await fs.stat(context.databasePath);
    assert.equal(restartResponse.status, 200, 'API restarts successfully against the same task-owned SQLite path');
    assert.equal(restartHealth.ok, true, 'restarted API health is ok');
    assert.equal(databaseIdentityAfterRestart.ino, databaseIdentityBeforeRestart.ino, 'API restart reused the same SQLite file');
    evidence.assertions.push({ questId: 'Q1.5', result: 'PASS', action: 'stop and restart the managed API with the same DB_PATH',
      expected: 'HTTP 200, ok=true, and unchanged SQLite file identity', actual: { status: restartResponse.status,
        ok: restartHealth.ok, databasePath: context.databasePath, inodeBefore: databaseIdentityBeforeRestart.ino,
        inodeAfter: databaseIdentityAfterRestart.ino } });
    const webPort = await availablePort();
    const webUrl = `http://127.0.0.1:${webPort}`;
    viteResource = await resourceSession.startProcess({ label: 'stage27-r2-vite', kind: 'vite', role: 'vite',
      command: 'npm', args: ['run', 'dev', '-w', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
      cwd: projectRoot, port: webPort, env: { PATH: process.env.PATH || '', HAIYU_RESOURCE_MANAGED: '1',
      API_PROXY_TARGET: new URL(restartedBaseUrl).origin, WEB_PORT: String(webPort), CODEX_TASK_ID: taskId,
      CODEX_STAGE27_SCOPE: 'R2' } });
    assert.equal(viteResource.status, 'running', 'Vite started as a managed resource');
    evidence.resources.push(processSummary(viteResource));
    await waitForHttp(webUrl, resourceSession, viteResource.id);
    const proxy = await fetch(`${webUrl}/api/health`);
    const proxyJson = await proxy.json();
    assert.equal(proxy.status, 200); assert.equal(proxyJson.ok, true);
    evidence.assertions.push({ questId: 'Q1.4', result: 'PASS', action: 'browser-origin same-host /api/health request through Vite proxy',
      expected: 'HTTP 200 and ok=true', actual: { status: proxy.status, ok: proxyJson.ok, origin: webUrl } });
    evidence.assertions.push({ questId: 'Q1.1', result: 'PASS', action: 'read package.json workspace configuration and run npm ls --workspaces --depth=0',
      expected: 'server and web workspaces resolve', actual: 'captured by the managed Q27.1 npm workspace command' });

    const ownerSource = `import {spawn} from 'node:child_process';import fs from 'node:fs';
const child=spawn('bash',[process.env.PLAYWRIGHT_WRAPPER,'--config',process.env.PLAYWRIGHT_CONFIG,'--session',process.env.PLAYWRIGHT_SESSION,'open',process.env.PLAYWRIGHT_URL,'--profile',process.env.PLAYWRIGHT_PROFILE,'--idle-timeout','0'],{cwd:process.cwd(),env:{PATH:process.env.PATH||'/usr/bin:/bin',CODEX_TASK_ID:process.env.CODEX_TASK_ID,CODEX_STAGE27_SCOPE:process.env.CODEX_STAGE27_SCOPE,npm_config_offline:'true',NODE_DISABLE_COMPILE_CACHE:'1',PWTEST_SOCKETS_DIR:process.env.PLAYWRIGHT_SOCKETS_DIR,TMPDIR:process.env.PLAYWRIGHT_SOCKETS_DIR,TMP:process.env.PLAYWRIGHT_SOCKETS_DIR,TEMP:process.env.PLAYWRIGHT_SOCKETS_DIR},stdio:['ignore','pipe','pipe']});let out='';for(const s of [child.stdout,child.stderr])s.on('data',c=>{out=(out+c.toString()).slice(-4096)});child.once('error',e=>{fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER,JSON.stringify({code:1,error:e.message,out}));process.exitCode=1});child.once('close',(code,signal)=>{fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER,JSON.stringify({code,signal,out}));if(code!==0)process.exitCode=1});setInterval(()=>{},1000);`;
    await fs.writeFile(ownerPath, ownerSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const browserPort = await availablePort();
    browserOwner = await resourceSession.startProcess({ label: 'stage27-r2-playwright-owner', kind: 'browser', role: 'browser-session-owner',
      command: process.execPath, args: [ownerPath], cwd: tempDirectory, env: { ...playwrightEnv, CODEX_TASK_ID: taskId,
        CODEX_STAGE27_SCOPE: 'R2',
        PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfig, PLAYWRIGHT_SESSION: sessionName,
        PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketAlias,
        PLAYWRIGHT_URL: webUrl, PORT: String(browserPort) } });
    assert.equal(browserOwner.status, 'running', 'Playwright owner started as a managed resource');
    evidence.resources.push(processSummary(browserOwner));
    browserOpened = true;
    const openStatus = await waitForFile(openMarker);
    evidence.openStatus = openStatus;
    assert.equal(openStatus.code, 0, `Playwright open completed: ${String(openStatus.out || '').slice(-1000)}`);
    assert.equal(openStatus.signal || null, null);
    const home = screenshot('public-home-1280');
    const news = screenshot('public-news-detail');
    const profile = screenshot('guest-profile');
    const healthPage = screenshot('guest-health');
    const staffPage = screenshot('staff-guests');
    const deanPage = screenshot('dean-team');
    const screenshots = { home, news, profile, healthPage, staffPage, deanPage };
    const dynamicFlow = `async page => {
const ensure=(v,m)=>{if(!v)throw new Error(m)};const checks=[];const mark=(questId,action,expected,actual)=>checks.push({questId,action,expected,actual,result:'PASS'});
const screenshots=${JSON.stringify(screenshots)};const webUrl=${JSON.stringify(webUrl)};const runId=${JSON.stringify(runId)};const errors=[];const consoleErrors=[];const external=[];const httpErrors=[];const requestFailures=[];
page.setDefaultTimeout(20000);page.setDefaultNavigationTimeout(20000);page.on('pageerror',e=>errors.push(String(e.message||e).slice(0,500)));page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text().slice(0,500))});page.on('response',response=>{if(response.status()>=400){const url=new URL(response.url());httpErrors.push({status:response.status(),origin:url.origin,path:url.pathname})}});page.on('requestfailed',request=>requestFailures.push({url:request.url(),errorText:request.failure()?.errorText||null}));
await page.route('**/*',route=>{const u=new URL(route.request().url());if(['data:','blob:'].includes(u.protocol)||['127.0.0.1','localhost'].includes(u.hostname))return route.continue();external.push({origin:u.origin,type:route.request().resourceType(),action:'aborted-before-network'});return route.abort()});
async function checkAssistantEntry(role){const panel=page.locator('.assistant-window');await page.getByRole('button',{name:'打开智能助手'}).click();await panel.waitFor({state:'visible'});await panel.getByLabel('输入给智能助手的内容').waitFor({state:'visible'});await panel.getByRole('button',{name:'发送消息'}).waitFor({state:'visible'});const opened=await panel.isVisible();await page.getByRole('button',{name:'关闭智能助手'}).click();await panel.waitFor({state:'hidden'});ensure(opened&&!await panel.isVisible(),'assistant opens with input/send and closes without leaving an overlay');mark('Q7.1','open and close the floating assistant in the '+role+' context','input and send control are visible; close returns to the page',{role,opened,closed:!await panel.isVisible()});}
await page.setViewportSize({width:1280,height:1000});await page.goto(webUrl,{waitUntil:'domcontentloaded'});await page.getByText('海屿康养社区',{exact:false}).first().waitFor();
const sameOriginHealth=await page.evaluate(async()=>{const response=await fetch('/api/health');return {status:response.status,body:await response.json()}});ensure(sameOriginHealth.status===200&&sameOriginHealth.body.ok===true,'same-origin Vite proxy returns API health');mark('Q1.4','open the public site and fetch /api/health from the browser origin','HTTP 200 and ok=true through same-origin Vite proxy',sameOriginHealth);
const publicText=await page.locator('body').innerText();ensure(publicText.includes('社区动态'),'news section present');ensure(publicText.includes('我是客人')&&publicText.includes('我是工作人员')&&publicText.includes('院长管理入口'),'three public role entries present');ensure(!publicText.includes('林海宁'),'public page does not expose the seeded guest identity');
const weather=page.getByRole('button',{name:'切换演示天气'});const weatherBefore=await weather.innerText();ensure(weatherBefore.includes('演示数据'),'weather card labels demo data');await weather.click();const weatherAfter=await weather.innerText();ensure(weatherAfter!==weatherBefore,'weather card changes');await page.screenshot({path:screenshots.home,fullPage:true});
mark('Q1.2','open the public page in controlled browser','brand title visible',await page.title());mark('Q2.1','inspect public home and three role entries','brand, community news and three role buttons visible','visible');mark('Q2.2','click demo weather card','demo-labeled card changes local presentation',{before:weatherBefore,after:weatherAfter});
await checkAssistantEntry('public');
const featured=(await page.locator('.featured-copy h3').innerText()).trim();ensure(featured.length>0,'featured news title visible');await page.getByRole('button',{name:/阅读全文/}).first().click();await page.locator('.news-modal').waitFor({state:'visible'});const modalTitle=(await page.locator('.news-modal h2').innerText()).trim();const body=(await page.locator('.news-modal .modal-body').innerText()).trim();ensure(modalTitle===featured,'modal title matches selected news');ensure(body.length>0,'news body readable');await page.screenshot({path:screenshots.news,fullPage:true});await page.getByRole('button',{name:'关闭新闻详情'}).click();await page.locator('.news-modal').waitFor({state:'hidden'});mark('Q2.4','inspect server-backed featured news','featured card contains loaded story',{title:featured});mark('Q2.6','open and close news detail','title/body match, modal closes to home',{title:modalTitle,bodyCharacters:body.length});
async function chooseRole(button){await page.getByRole('button',{name:new RegExp(button)}).first().click();await page.getByLabel('账号').waitFor({state:'visible'});const title=(await page.locator('.login-panel h1').innerText()).trim();const badge=(await page.locator('.role-badge').innerText()).trim();const lead=(await page.locator('.form-lead').innerText()).trim();const passType=await page.getByLabel('密码').getAttribute('type');ensure(passType==='password','password input is masked');return {title,badge,lead,passType}}
async function login(roleButton,role,username,password){await page.getByRole('button',{name:new RegExp(roleButton)}).first().click();await page.getByLabel('账号').fill(username);await page.getByLabel('密码').fill(password);await page.getByRole('button',{name:/进入工作区/}).click();await page.waitForFunction(()=>Boolean(localStorage.getItem('community_token')&&localStorage.getItem('community_user')),null,{timeout:15000});await page.locator('.app-header .user-menu strong').waitFor();const user=await page.locator('.app-header .user-menu strong').innerText();const nav=await page.locator('.side-nav').innerText();return {user,nav}}
const loginForms=[];for(const [button,badge,space] of [['我是客人','客人入口','个人空间'],['我是工作人员','工作人员入口','工作台'],['院长管理入口','院长管理入口','院长空间']]){const form=await chooseRole(button);ensure(form.title==='欢迎回来'&&form.badge===badge&&form.lead.includes(space)&&form.passType==='password','role form identifies the correct role and masks password: '+button);loginForms.push({button,...form});await page.locator('.back-btn').click();await page.getByRole('button',{name:/我是客人/}).first().waitFor()}mark('Q3.3','open all three role login forms in sequence','guest/staff/dean role labels and workspace text are distinct; password stays masked',loginForms);const guestForm=await chooseRole('我是客人');const title=guestForm.title;ensure(title.includes('欢迎回来'),'guest login title');await page.getByLabel('账号').fill('guest_demo');await page.getByLabel('密码').fill('wrong-password');const wrongLoginResponsePromise=page.waitForResponse(response=>response.status()===401&&new URL(response.url()).pathname==='/api/auth/login',{timeout:15000});await page.getByRole('button',{name:/进入工作区/}).click();const wrongLoginResponse=await wrongLoginResponsePromise;await page.getByRole('alert').waitFor({state:'visible'});const loginError=(await page.getByRole('alert').innerText()).trim();ensure(loginError.length>0,'invalid password presents readable error');mark('Q3.4','submit wrong password before valid login','API returns HTTP 401 and the form shows a readable error',{status:wrongLoginResponse.status(),path:new URL(wrongLoginResponse.url()).pathname,error:loginError});
await page.getByLabel('密码').fill('guest2026');await page.getByRole('button',{name:/进入工作区/}).click();await page.waitForFunction(()=>Boolean(localStorage.getItem('community_token')&&localStorage.getItem('community_user')),null,{timeout:15000});await page.locator('.app-header .user-menu strong').waitFor();const guestName=(await page.locator('.app-header .user-menu strong').innerText()).trim();ensure(guestName.length>0,'guest identity header visible');await checkAssistantEntry('guest');await page.getByRole('button',{name:'我的',exact:true}).click();await page.locator('.guest-my-entry').filter({hasText:'我的档案'}).click();await page.getByRole('heading',{name:'我的资料'}).waitFor();const disabledFields=await page.locator('.form-surface input:disabled').count();ensure(disabledFields>=4,'institution and identity fields are disabled');await page.screenshot({path:screenshots.profile,fullPage:true});mark('Q3.6','inspect guest navigation after authenticated login','guest navigation lacks staff/dean items',{navigation:await page.locator('.side-nav').innerText()});mark('Q4.1','open guest profile','name and registered stay information visible',{guestName,profileHeading:'我的资料'});mark('Q4.2','inspect profile inputs','institution-entered fields are disabled',{disabledFields});
const phone=page.getByLabel('联系电话');const originalPhone=await phone.inputValue();const savedPhone='13900000000';ensure(originalPhone!==savedPhone,'profile phone fixture changes to a distinct synthetic value');await phone.fill(savedPhone);await page.getByRole('button',{name:/保存修改/}).click();await page.getByRole('status').filter({hasText:'个人资料已保存'}).waitFor({timeout:10000});await page.reload({waitUntil:'domcontentloaded'});await page.locator('.app-shell').waitFor();await page.getByRole('button',{name:'我的',exact:true}).click();await page.locator('.guest-my-entry').filter({hasText:'我的档案'}).click();await page.getByLabel('联系电话').waitFor();const persistedPhone=await page.getByLabel('联系电话').inputValue();ensure(persistedPhone===savedPhone,'saved phone persists after page reload');mark('Q4.4','save a synthetic phone field and reload the guest profile','success toast appears and saved value survives reload',{status:'个人资料已保存',originalPhone,savedPhone,persistedPhone});
await page.getByRole('button',{name:'我的',exact:true}).click();await page.locator('.guest-my-entry').filter({hasText:'健康记录'}).click();await page.locator('.health-records-surface').waitFor();await page.screenshot({path:screenshots.healthPage,fullPage:true});mark('Q4.6','open guest health-records page','health records surface visible',{heading:await page.locator('.health-records-surface h2').innerText()});
await page.getByRole('button',{name:'我的',exact:true}).click();await page.locator('.guest-my-entry').filter({hasText:'我的医嘱'}).click();await page.getByRole('heading',{name:'我的医嘱'}).waitFor();mark('Q4.8','open guest advice page','read-only advice page is rendered',{heading:'我的医嘱'});
await page.getByRole('button',{name:'退出登录'}).first().click();await page.waitForFunction(()=>!localStorage.getItem('community_token'),null,{timeout:10000});await page.reload({waitUntil:'domcontentloaded'});ensure((await page.locator('body').innerText()).includes('我是客人'),'logout and reload return to public entry');mark('Q3.7','logout and reload','public entry returns without a token',{loggedOut:!await page.evaluate(()=>Boolean(localStorage.getItem('community_token')))});
const staff=await login('我是工作人员','staff','staff_demo','staff2026');ensure(staff.nav.includes('我负责的客人'),'staff guest navigation present');ensure(!staff.nav.includes('院长意见'),'staff does not see dean menu');mark('Q3.6','login as staff and inspect role navigation','staff menu appears and dean menu absent',{user:staff.user,nav:staff.nav});
await checkAssistantEntry('staff');
await page.getByRole('button',{name:'我的账号',exact:true}).click();await page.getByRole('heading',{name:'我的账号'}).waitFor();await page.getByRole('button',{name:'修改密码'}).click();
await page.getByLabel('当前密码').fill('wrong-r2-current-password');await page.getByLabel('新密码（至少 8 位）').fill('R2TemporaryPassword-20261010');const wrongPasswordResponsePromise=page.waitForResponse(response=>response.status()===400&&new URL(response.url()).pathname==='/api/me/password',{timeout:15000});await page.getByRole('button',{name:'确认修改'}).click();const wrongPasswordResponse=await wrongPasswordResponsePromise;await page.locator('.toast').waitFor({state:'visible'});const wrongPasswordToast=(await page.locator('.toast').innerText()).trim();ensure(!wrongPasswordToast.includes('密码已修改'),'wrong current password does not show success');
async function submitPasswordChange(currentPassword,newPassword){if(await page.getByRole('button',{name:'修改密码'}).count())await page.getByRole('button',{name:'修改密码'}).click();await page.getByLabel('当前密码').fill(currentPassword);await page.getByLabel('新密码（至少 8 位）').fill(newPassword);await page.getByRole('button',{name:'确认修改'}).click();await page.locator('.toast').filter({hasText:'密码已修改'}).waitFor({timeout:10000});}
const rotatedPassword='R2TemporaryPassword-'+runId.slice(-8);await submitPasswordChange('staff2026',rotatedPassword);await page.getByRole('button',{name:'退出登录'}).first().click();await page.waitForFunction(()=>!localStorage.getItem('community_token'),null,{timeout:10000});await page.reload({waitUntil:'domcontentloaded'});const rotatedStaff=await login('我是工作人员','staff','staff_demo',rotatedPassword);ensure(rotatedStaff.user.length>0,'new password authenticates in the isolated SQLite app');await page.getByRole('button',{name:'我的账号',exact:true}).click();await page.getByRole('heading',{name:'我的账号'}).waitFor();await submitPasswordChange(rotatedPassword,'staff2026');mark('Q3.9','reject a wrong old password and verify a valid password change by logging in with the new password','wrong old password is rejected; new password logs in; test account is restored to its original demo password',{wrongPasswordStatus:wrongPasswordResponse.status(),wrongPasswordToast,passwordLogin:rotatedStaff.user,restoredDemoAccount:true});
const overviewNav=page.getByRole('button',{name:'工作概览',exact:true});if(await overviewNav.count()){await overviewNav.click();await page.getByText('今日工作台',{exact:true}).waitFor();await page.waitForFunction(()=>{const values=[...document.querySelectorAll('.metric-grid .metric-card strong')].map(node=>node.textContent.trim());return values.length>=3&&values.every(value=>value&&value!=='…')});const overviewText=await page.locator('body').innerText();ensure(overviewText.includes('负责客人')&&overviewText.includes('有效医嘱')&&overviewText.includes('近期工作记录'),'staff overview shows the expected metrics and recent work section');const metricValues=await page.locator('.metric-grid .metric-card strong').allTextContents();mark('Q5.4','open staff overview','staff overview banner, loaded guest/advice metrics and recent work section render',{banner:'今日工作台',metrics:metricValues.map(value=>value.trim())});}else checks.push({questId:'Q5.4',result:'UNVERIFIED',action:'inspect current staff role capabilities',expected:'staff overview page and statistics are available',actual:'not exposed by this demo staff role'});
let guestListFailureInjected=false;await page.route('**/api/staff/guests*',async route=>{const requestUrl=new URL(route.request().url());if(!guestListFailureInjected&&requestUrl.pathname==='/api/staff/guests'){guestListFailureInjected=true;await new Promise(resolve=>setTimeout(resolve,700));await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'R2 controlled outage',message:'R2 controlled outage'})});return;}await route.continue();});
await page.getByRole('button',{name:'我负责的客人',exact:true}).click();await page.getByText('正在加载客人列表…',{exact:true}).waitFor({state:'visible'});const loadingText=(await page.locator('.guest-list').innerText()).trim();ensure(loadingText.includes('正在加载客人列表…')&&!loadingText.includes('暂无结果'),'loading state is distinct from an empty result');mark('Q8.1','delay the first controlled staff guest-list response','loading text remains visible while the API request is pending',{loadingText,delayedMs:700});
await page.locator('.guest-list .query-state').filter({hasText:'R2 controlled outage'}).waitFor({state:'visible'});const failedListText=(await page.locator('.guest-list').innerText()).trim();ensure(failedListText.includes('R2 controlled outage'),'controlled API failure appears in the list state');await page.getByRole('button',{name:'重试加载'}).click();await page.getByRole('button',{name:/林海宁/}).first().waitFor({state:'visible'});mark('Q8.3','return one controlled 503 then click the manual retry button','error is visible and the list recovers on the next successful request',{error:'R2 controlled outage',retry:'重试加载',recovered:true});
await page.getByRole('button',{name:'我负责的客人',exact:true}).click();await page.getByRole('heading',{name:'我负责的客人'}).waitFor();const assignedGuestButton=page.getByRole('button',{name:/林海宁/}).first();await assignedGuestButton.waitFor({state:'visible'});const assignedGuestText=await assignedGuestButton.innerText();ensure(assignedGuestText.includes('A-203'),'authorized guest row includes the expected demo room');const guestRows=await page.locator('.guest-row').count();ensure(guestRows>0,'assigned guest list contains at least one row');await page.screenshot({path:screenshots.staffPage,fullPage:true});mark('Q5.6','open assigned guest list','林海宁 and A-203 render after the asynchronous list request completes',{count:guestRows,assignedGuest:assignedGuestText.trim()});
const search=page.getByLabel('搜索客人姓名或房间号');await search.fill('R2-NO-SUCH-ROOM');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByText('暂无结果',{exact:true}).waitFor();mark('Q8.2','search an absent room marker after the successful retry','explicit empty state appears without a blank list',{query:'R2-NO-SUCH-ROOM',emptyState:'暂无结果'});mark('Q5.7','search for an absent room marker','explicit empty result appears',{query:'R2-NO-SUCH-ROOM',empty:true});await search.fill('林海宁');await page.getByRole('button',{name:'搜索',exact:true}).click();await page.getByRole('button',{name:/林海宁/}).first().waitFor();await page.getByRole('button',{name:/林海宁/}).first().click();await page.locator('.profile-hero h2').waitFor();mark('Q5.9','select authorized guest','profile and health details open',{guest:await page.locator('.profile-hero h2').innerText()});
const adviceTitle='R2 browser suggestion '+runId;const adviceContent='Controlled local acceptance suggestion; no model fills or submits this form.';await page.getByRole('button',{name:/新增建议/}).click();await page.locator('.advice-form').waitFor({state:'visible'});await page.getByLabel('标题').fill(adviceTitle);await page.getByLabel('建议内容').fill(adviceContent);await page.getByRole('button',{name:/发布建议/}).click();await page.locator('.toast').filter({hasText:'医嘱已发布，客人可以查看'}).waitFor({timeout:10000});await page.locator('.staff-advice-row').filter({hasText:adviceTitle}).waitFor({state:'visible'});const adviceBeforeReload=await page.locator('.staff-advice-row').filter({hasText:adviceTitle}).innerText();await page.reload({waitUntil:'domcontentloaded'});await page.locator('.app-shell').waitFor();await page.getByRole('button',{name:'我负责的客人',exact:true}).click();await page.getByRole('button',{name:/林海宁/}).first().waitFor({state:'visible'});await page.getByRole('button',{name:/林海宁/}).first().click();await page.locator('.profile-hero h2').waitFor();await page.locator('.staff-advice-row').filter({hasText:adviceTitle}).waitFor({state:'visible'});const adviceAfterReload=await page.locator('.staff-advice-row').filter({hasText:adviceTitle}).innerText();ensure(adviceAfterReload.includes(adviceContent),'submitted suggestion persists after reload');const adviceCountBeforeEmpty=await page.locator('.staff-advice-row').count();await page.getByRole('button',{name:/新增建议/}).click();await page.locator('.advice-form').waitFor({state:'visible'});await page.getByRole('button',{name:/发布建议/}).click();await page.locator('.toast').filter({hasText:'请填写建议标题和内容'}).waitFor({timeout:10000});const adviceCountAfterEmpty=await page.locator('.staff-advice-row').count();ensure(adviceCountAfterEmpty===adviceCountBeforeEmpty,'empty suggestion submission creates no row');mark('Q5.11','submit a staff-authored suggestion and reject an empty submission','success is shown, row survives reload, and empty text creates no record',{title:adviceTitle,visibleBeforeReload:adviceBeforeReload.includes(adviceTitle),visibleAfterReload:adviceAfterReload.includes(adviceTitle),emptySubmissionRejected:true,rowCountBeforeEmpty:adviceCountBeforeEmpty,rowCountAfterEmpty:adviceCountAfterEmpty});
let latePollStartedResolve;let latePollFinishedResolve;const latePollStarted=new Promise(resolve=>{latePollStartedResolve=resolve});const latePollFinished=new Promise(resolve=>{latePollFinishedResolve=resolve});let latePollOutcome='pending';const lateMarker='R2_LATE_STAFF_REPLY_MUST_NOT_LEAK_'+runId;const lateRequestText='R2 delayed staff request '+runId;
await page.route('**/api/assistant/chat',async route=>{const body=route.request().postDataJSON();if(body?.text===lateRequestText){await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({sessionId:'r2-late-session',runId:'r2-late-run'})});return;}await route.continue();});
await page.route('**/api/assistant/runs/r2-late-run*',async route=>{if(route.request().method()==='GET'){latePollStartedResolve();await new Promise(resolve=>setTimeout(resolve,3000));try{await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({runId:'r2-late-run',status:'completed',reply:lateMarker,executionMode:'safe_guidance',sources:[],actionCards:[]})});latePollOutcome='delayed-response-released-after-account-switch';}catch(error){latePollOutcome='request-cancelled-after-account-switch';}finally{latePollFinishedResolve();}return;}await route.continue();});
await page.getByRole('button',{name:'打开智能助手'}).click();const staffAssistant=page.locator('.assistant-window');await staffAssistant.waitFor({state:'visible'});await staffAssistant.getByLabel('输入给智能助手的内容').fill(lateRequestText);await staffAssistant.getByRole('button',{name:'发送消息'}).click();await Promise.race([latePollStarted,new Promise((_,reject)=>setTimeout(()=>reject(new Error('delayed assistant poll was not observed')),10000))]);
await page.getByRole('button',{name:'退出登录'}).first().click();await page.waitForFunction(()=>!localStorage.getItem('community_token'),null,{timeout:10000});await page.reload({waitUntil:'domcontentloaded'});
const guestAfterStaff=await login('我是客人','guest','guest_demo','guest2026');ensure(guestAfterStaff.user.length>0,'guest account logs in after staff logout');await Promise.race([latePollFinished,new Promise(resolve=>setTimeout(resolve,3500))]);await page.getByRole('button',{name:'打开智能助手'}).click();const guestAssistantPanel=page.locator('.assistant-window');await guestAssistantPanel.waitFor({state:'visible'});const guestAssistantText=await guestAssistantPanel.innerText();ensure(!guestAssistantText.includes(lateMarker),'late staff reply is absent from the guest assistant context');mark('Q7.8','switch from a staff account while its local stub response is delayed, then inspect the guest assistant','the delayed staff reply and session stay out of the guest panel',{latePollOutcome,staffRequestStubbed:true,guestUser:guestAfterStaff.user,guestPanelContainsLateReply:guestAssistantText.includes(lateMarker)});await page.getByRole('button',{name:'退出登录'}).first().click();await page.waitForFunction(()=>!localStorage.getItem('community_token'),null,{timeout:10000});await page.reload({waitUntil:'domcontentloaded'});
const dean=await login('院长管理入口','dean','dean_demo','dean2026');ensure(dean.nav.includes('院长意见'),'dean nav exists');await checkAssistantEntry('dean');
let deanStaffRows=[];let actualDeanStaffId='';let actualDeanStaffName='';const draftPeerId='r2-draft-isolation-peer';
await page.route('**/api/dean/staff',async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch();const rows=await response.json();deanStaffRows=Array.isArray(rows)?rows:[];if(deanStaffRows.length){actualDeanStaffId=String(deanStaffRows[0].id);actualDeanStaffName=String(deanStaffRows[0].name);const peer={...deanStaffRows[0],id:draftPeerId,name:'R2草稿隔离样本',username:'r2_draft_peer',guestViews:0,adviceCount:0};await route.fulfill({response,body:JSON.stringify([...deanStaffRows,peer])});return;}await route.fulfill({response,body:JSON.stringify(deanStaffRows)});});
await page.route('**/api/dean/staff/r2-draft-isolation-peer/logs',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({staff:{id:draftPeerId,name:'R2草稿隔离样本',username:'r2_draft_peer',phone:''},logs:[],reviews:[]})}));
await page.getByRole('button',{name:'院长意见',exact:true}).click();await page.getByRole('heading',{name:'工作人员管理'}).waitFor();await page.locator('.guest-row').first().waitFor({state:'visible'});const staffRows=await page.locator('.guest-row').count();ensure(staffRows>0,'dean sees staff rows after the list request completes');await page.screenshot({path:screenshots.deanPage,fullPage:true});mark('Q6.2','open dean staff workspace','staff names and work counts visible after the asynchronous list request completes',{staffRows});await page.getByRole('button',{name:/王医生|陈医生|staff_demo/}).first().click().catch(async()=>{await page.locator('.guest-row').first().click()});await page.locator('.review-form').waitFor();ensure(await page.locator('.staff-log-list').count()>0,'selected staff audit history section visible');mark('Q6.4','select one staff member','staff work log and opinion area rendered',{logs:await page.locator('.staff-log-list').innerText()});
ensure(actualDeanStaffId&&actualDeanStaffName,'the controlled dean list retains a real staff row plus one synthetic UI-only peer');const staffAButton=page.locator('.guest-list .guest-row').filter({hasText:actualDeanStaffName}).first();const staffPeerButton=page.getByRole('button',{name:/R2草稿隔离样本/});await staffAButton.click();await page.locator('.review-form').waitFor({state:'visible'});const reviewDraft=page.locator('.review-form textarea');const draftA='R2 draft for staff A '+runId;const draftB='R2 draft for staff B '+runId;await reviewDraft.fill(draftA);await staffPeerButton.click();await page.locator('.review-form').waitFor({state:'visible'});const peerInitialDraft=await page.locator('.review-form textarea').inputValue();ensure(peerInitialDraft==='','staff A draft does not appear in the second staff member form');await page.locator('.review-form textarea').fill(draftB);await staffAButton.click();await page.locator('.review-form').waitFor({state:'visible'});const draftAAfterReturn=await page.locator('.review-form textarea').inputValue();ensure(draftAAfterReturn===draftA,'staff A draft remains attached to staff A');await staffPeerButton.click();await page.locator('.review-form').waitFor({state:'visible'});const draftBAfterReturn=await page.locator('.review-form textarea').inputValue();ensure(draftBAfterReturn===draftB,'staff B draft remains attached to staff B');mark('Q6.7','switch between one real staff row and a local synthetic UI peer with separate unsent drafts','each staff ID retains its own text and the peer starts empty',{realStaff:actualDeanStaffName,peer:'R2草稿隔离样本',peerInitialDraft,draftAAfterReturnMatches:draftAAfterReturn===draftA,draftBAfterReturnMatches:draftBAfterReturn===draftB,peerIsSyntheticUiFixture:true});
await staffAButton.click();await page.locator('.review-form').waitFor({state:'visible'});const deanOpinion='R2 dean opinion '+runId;await page.locator('.review-form textarea').fill(deanOpinion);await page.getByRole('button',{name:/记录意见/}).click();await page.locator('.toast').filter({hasText:'院长意见已记录'}).waitFor({timeout:10000});await page.locator('.review-history').getByText(deanOpinion,{exact:true}).waitFor({state:'visible'});await page.reload({waitUntil:'domcontentloaded'});await page.locator('.app-shell').waitFor();await page.getByRole('button',{name:'院长意见',exact:true}).click();await page.getByRole('heading',{name:'工作人员管理'}).waitFor();await page.locator('.guest-list .guest-row').filter({hasText:actualDeanStaffName}).first().click();await page.locator('.review-history').getByText(deanOpinion,{exact:true}).waitFor({state:'visible'});mark('Q6.6','submit a nonempty dean opinion for the real staff row and reload the page','the saved opinion remains under the selected staff member',{staff:actualDeanStaffName,opinion:deanOpinion,persistedAfterReload:true});
await page.setViewportSize({width:1920,height:1080});const widths=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));ensure(widths.document<=widths.viewport&&widths.body<=widths.viewport,'desktop layout does not overflow horizontally');mark('Q8.4','sample wide desktop layout at 1920px','document and body fit viewport',{widths});
ensure(errors.length===0,'browser page has no uncaught JavaScript errors');const expectedHttpErrors=httpErrors.filter(item=>(item.status===401&&item.path==='/api/auth/login')||(item.status===400&&item.path==='/api/me/password')||(item.status===503&&item.path==='/api/staff/guests'));const unexpectedHttpErrors=httpErrors.filter(item=>!expectedHttpErrors.includes(item));ensure(unexpectedHttpErrors.length===0,'only the intentional wrong-password and controlled guest-list outage responses return HTTP errors');const expectedCancelledAssistant=requestFailures.filter(item=>new URL(item.url).pathname==='/api/assistant/runs/r2-late-run');const unexpectedNetworkFailures=requestFailures.filter(item=>!external.some(request=>new URL(item.url).origin===request.origin&&request.action==='aborted-before-network')&&!expectedCancelledAssistant.includes(item));ensure(unexpectedNetworkFailures.length===0,'all request failures are from blocked external requests or the account-switch cancellation probe');const expectedResponseConsole=message=>(message.includes('401')&&httpErrors.some(item=>item.status===401&&item.path==='/api/auth/login'))||(message.includes('400')&&httpErrors.some(item=>item.status===400&&item.path==='/api/me/password'))||(message.includes('503')&&httpErrors.some(item=>item.status===503&&item.path==='/api/staff/guests'));const unexpectedConsoleErrors=consoleErrors.filter(message=>!(message.includes('net::ERR_FAILED')&&external.length>0)&&!expectedResponseConsole(message)&&!(message.includes('ERR_ABORTED')&&expectedCancelledAssistant.length>0));ensure(unexpectedConsoleErrors.length===0,'browser console has no errors beyond blocked external fonts and the deliberate negative/cancellation probes');const result={assertions:checks,errors,consoleErrors,unexpectedConsoleErrors,externalRequests:external,httpErrors,expectedHttpErrors,unexpectedHttpErrors,requestFailures,expectedCancelledAssistant,unexpectedNetworkFailures,viewportSamples:[widths],visiblePages:['public','guest-profile','guest-health','guest-advice','staff-guests','dean-team'],assistantRoleChecks:checks.filter(item=>item.questId==='Q7.1').map(item=>item.actual)};await page.evaluate(value=>{document.title='R2_BROWSER_RESULT:'+JSON.stringify(value)},result);return result;
}`;
    await fs.writeFile(flowPath, dynamicFlow, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const output = await runCli(['run-code', '--filename', flowPath], 'stage27-r2-base-browser-flow', 300_000);
    const marker = output.match(/R2_BROWSER_RESULT:(\{[^\r\n]*\})/u);
    assert.ok(marker, `Playwright flow did not return structured evidence: ${output.slice(-4000)}`);
    const flow = JSON.parse(marker[1]);
    evidence.assertions.push(...flow.assertions);
    evidence.pageErrors = flow.errors; evidence.consoleErrors = flow.consoleErrors; evidence.externalRequests = flow.externalRequests;
    evidence.unexpectedConsoleErrors = flow.unexpectedConsoleErrors; evidence.httpErrors = flow.httpErrors;
    evidence.unexpectedHttpErrors = flow.unexpectedHttpErrors; evidence.requestFailures = flow.requestFailures;
    evidence.unexpectedNetworkFailures = flow.unexpectedNetworkFailures;
    evidence.viewportSamples = flow.viewportSamples; evidence.visiblePages = flow.visiblePages;
    await runCli(['snapshot'], 'stage27-r2-final-browser-snapshot', 30_000);
    await runCli(['close'], 'stage27-r2-playwright-close', 30_000);
    browserOpened = false;
    const currentVsCode = stableProcessIdentity(67464);
    assert.equal(currentVsCode?.fingerprint, protectedVsCode.fingerprint, 'protected VS Code process identity stayed unchanged');
    const postChrome = chromeSnapshot(); assertChrome(postChrome, 'after isolated browser', baselineChrome);
    evidence.protectedChromeAfter = postChrome; evidence.protectedVsCodeAfter = currentVsCode;
    return { webUrl, apiHealth: { status: health.status, ok: healthJson.ok }, proxyHealth: { status: proxy.status, ok: proxyJson.ok },
      sqliteBytes: dbHeader.length, flowAssertions: flow.assertions.length };
    }, 'haiyu-stage27-r2-', { DB_DRIVER: 'sqlite', DEMO_SEED: '1', LLM_BASE_URL: '', LLM_API_KEY: '', LLM_MODEL: '',
      ENVIRONMENT_MODE: 'demo', ENVIRONMENT_LIVE: '0' }, { resourceSession });
  } catch (error) { executionError = error; }

  const cleanup = [];
  const cleanupErrors = [];
  if (browserOpened) {
    try {
      const closeResource = await resourceSession.runProcess({ label: 'stage27-r2-playwright-failure-close', kind: 'browser', role: 'playwright-cli',
        command: 'bash', args: [playwrightWrapper, '--session', sessionName, 'close'], cwd: projectRoot,
        env: { ...playwrightEnv, CODEX_TASK_ID: taskId, CODEX_STAGE27_SCOPE: 'R2' }, leaseMs: 15 * 60 * 1000 }, { timeoutMs: 30_000 });
      const closeReceipt = { action: 'playwright-cli-close-after-flow', status: closeResource.status,
        exitCode: closeResource.exitCode, pid: closeResource.pid, resourceId: closeResource.id,
        allTrackedPidsExited: closeResource.pids?.every(item => item.exitConfirmed === true) === true };
      cleanup.push(closeReceipt);
      assert.equal(closeResource.status, 'exited'); assert.equal(closeResource.exitCode, 0); assert.equal(closeReceipt.allTrackedPidsExited, true);
      browserOpened = false;
    } catch (error) { cleanupErrors.push(`Playwright close: ${String(error.message || error)}`); }
  }
  for (const [resource, reason] of [[browserOwner, 'stage27-r2-browser-closed'], [viteResource, 'stage27-r2-browser-complete']]) {
    try { cleanup.push({ action: `stop-exact-${resource?.label || 'missing'}-resource`, exit: await stopResource(resourceSession, resource, reason) }); }
    catch (error) { cleanupErrors.push(`${resource?.label || 'resource'} stop: ${String(error.message || error)}`); }
  }
  try {
    const handles = bounded('lsof', ['-nP', '+D', socketAlias], 5000, 64 * 1024);
    assert.ok([0, 1].includes(handles.status), `Playwright socket lsof exited ${handles.status}`);
    assert.equal((handles.stdout || '').trim(), '', 'no process retains the task-owned Playwright socket alias');
    cleanup.push({ action: 'lsof-task-playwright-socket-alias', exitCode: handles.status, matchingHandles: 'none' });
    await fs.unlink(socketAlias);
    cleanup.push({ action: 'remove-exact-task-playwright-socket-alias', path: socketAlias, status: 'removed' });
  } catch (error) { cleanupErrors.push(`socket alias cleanup: ${String(error.message || error)}`); }

  const resourceStateAfterCleanup = await resourceSession.status();
  const activeAfterCleanup = (resourceStateAfterCleanup.resources || []).filter(item => ['starting', 'running'].includes(item.status));
  if (executionError || cleanupErrors.length || activeAfterCleanup.length) {
    evidence.cleanup = cleanup; evidence.resourceStatus = resourceStateAfterCleanup;
    evidence.cleanupErrors = cleanupErrors; evidence.activeResourcesAfterCleanup = activeAfterCleanup.map(item => ({id:item.id,label:item.label,status:item.status}));
    for (const name of ['public-home-1280', 'public-news-detail', 'guest-profile', 'guest-health', 'staff-guests', 'dean-team']) {
      const file = screenshot(name);
      try {
        const bytes = await fs.readFile(file);
        const genuinePng = bytes.length > 1024 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        evidence.screenshots.push({ path: path.relative(projectRoot, file), bytes: bytes.length,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex'), genuinePng });
      } catch (error) { if (error.code !== 'ENOENT') cleanupErrors.push(`screenshot evidence read: ${String(error.message || error)}`); }
    }
    evidence.status = cleanupErrors.length || activeAfterCleanup.length ? 'BLOCKED' : 'FAIL';
    evidence.error = String(executionError?.stack || executionError?.message || 'browser flow did not complete').slice(-6000);
    evidence.finishedAt = new Date().toISOString();
    const failedDestination = path.join(projectRoot, 'output/resource-audit', `stage27-r2-${taskId}-${runId}-browser-evidence-20261010.json`);
    await fs.writeFile(failedDestination, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (cleanupErrors.length || activeAfterCleanup.length) throw new Error(`R2 browser cleanup BLOCKED: ${JSON.stringify({cleanupErrors,active:activeAfterCleanup.map(item=>({id:item.id,label:item.label,status:item.status})),executionError:String(executionError?.message||'')})}`);
    throw executionError;
  }

  for (const name of ['public-home-1280', 'public-news-detail', 'guest-profile', 'guest-health', 'staff-guests', 'dean-team']) {
    const file = screenshot(name);
    const bytes = await fs.readFile(file);
    assert.ok(bytes.length > 1024 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])), `${path.basename(file)} is a genuine PNG`);
    evidence.screenshots.push({ path: path.relative(projectRoot, file), bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  }
  const resourceState = resourceStateAfterCleanup;
  evidence.resources = [...evidence.resources, ...(resourceState.resources || []).map(processSummary)
    .filter(item => item && !evidence.resources.some(existing => existing?.id === item.id))];
  const active = (resourceState.resources || []).filter(item => ['starting', 'running'].includes(item.status));
  assert.deepEqual(active.map(item => ({ id: item.id, label: item.label })), [], 'all R2 browser/API/Vite resources have stopped');
  evidence.cleanup = cleanup; evidence.resourceStatus = resourceState; evidence.apiAndBrowser = apiAndBrowserResult;
  evidence.status = 'PASS'; evidence.finishedAt = new Date().toISOString();
  const destination = path.join(projectRoot, 'output/resource-audit', `stage27-r2-${taskId}-${runId}-browser-evidence-20261010.json`);
  await fs.writeFile(destination, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const stat = await fs.stat(destination); assert.ok(stat.size <= 16 * 1024 * 1024, 'browser evidence JSON remains under 16 MiB');
  return { status: 'PASS', evidencePath: path.relative(projectRoot, destination),
    assertionCount: evidence.assertions.length, screenshotCount: evidence.screenshots.length,
    screenshots: evidence.screenshots, apiAndBrowser: apiAndBrowserResult };
}
