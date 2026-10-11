import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './resource-runtime.js';
import { assertProtectedProcessIdentity } from './stage27-r5-offline-guards.js';

const playwrightWrapper = '/Users/wangshanchong/.codex/skills/playwright/scripts/playwright_cli.sh';
const playwrightConfig = fileURLToPath(new URL('./playwright-cli.config.json', import.meta.url));
const protectedChromeIdentity = Object.freeze({ pid: 7081, startTime: 'Thu Oct  1 17:27:01 2026',
  fingerprint: 'a30da864807c765187c20eb24b90dfaedb6d8273c8675d112e09016b42ec949d' });
const protectedVsCodeIdentity = Object.freeze({ pid: 67464, startTime: 'Thu Oct  8 10:04:43 2026',
  fingerprint: '5e8fbacc04ae022967ad83f46440dc1e63db1170cd175bb7bce9f24813dbbf37' });
const cloneParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const expectedCloneNames = ['code_sign_clone.7WCMBh', 'code_sign_clone.87prgQ', 'code_sign_clone.FGf0ku',
  'code_sign_clone.KlYqcP', 'code_sign_clone.Km1hwm', 'code_sign_clone.Ly34OH', 'code_sign_clone.b9cnAV',
  'code_sign_clone.fpg2xz', 'code_sign_clone.jcG5XI', 'code_sign_clone.ooLA7h', 'code_sign_clone.xkTnpB'];
const logLimitBytes = 8 * 1024 * 1024;
const leaseMs = 15 * 60 * 1000;

export function sampleProtectedProcessIdentity(expected, label = 'protected process', identityReader = processIdentity) {
  const hadTimezone = Object.prototype.hasOwnProperty.call(process.env, 'TZ');
  const previousTimezone = process.env.TZ;
  try {
    process.env.TZ = 'Asia/Shanghai';
    return assertProtectedProcessIdentity(identityReader(Number(expected?.pid)), expected, label);
  } finally {
    if (hadTimezone) process.env.TZ = previousTimezone;
    else delete process.env.TZ;
  }
}

function chromeSnapshot() {
  const identity = sampleProtectedProcessIdentity(protectedChromeIdentity,
    'protected Chrome identity before/after R5 browser use');
  const result = spawnSync('lsof', ['-nP', '-p', String(protectedChromeIdentity.pid), '-Fn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
  assert.ok([0, 1].includes(result.status) && !result.error, 'protected Chrome handle inspection completed');
  const clonePaths = String(result.stdout || '').split(/\r?\n/u).filter(line => line.startsWith('n') && line.includes('/code_sign_clone.'))
    .map(line => line.slice(1).slice(0, 2048)).sort();
  const cacheNames = fs.readdirSync(cloneParent).filter(name => name.startsWith('code_sign_clone.')).sort();
  assert.deepEqual(cacheNames, expectedCloneNames, 'all eleven existing Chrome code-sign caches are retained');
  return { identity, lsofExitCode: result.status, clonePaths, cacheNames };
}

function vscodeSnapshot() {
  return sampleProtectedProcessIdentity(protectedVsCodeIdentity,
    'protected VS Code identity');
}

function resourceReceipt(resource, startedAt, status) {
  return { resourceId: resource.id, label: resource.label, role: resource.role, kind: resource.kind,
    status, exitCode: resource.exitCode ?? null, signal: resource.signal || null, elapsedMs: Date.now() - startedAt,
    pid: resource.pid, processStartTime: resource.processStartTime, processFingerprint: resource.processFingerprint,
    command: resource.command, cwd: resource.cwd, port: resource.port, tempDir: resource.tempDir,
    logPath: resource.logPath, logBytes: resource.logBytes ?? null, maxLogBytes: resource.maxLogBytes,
    directoryPeakBytes: resource.directoryPeakBytes ?? null, maxDirectoryBytes: resource.maxDirectoryBytes,
    trackedPids: resource.pids || [], allTrackedPidsExited: resource.pids?.every(item => item.exitConfirmed === true) === true,
    outputTail: String(resource.tail || '').slice(-12 * 1024) };
}

async function waitForFile(filePath, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Playwright CLI did not write its managed open marker within ${timeoutMs}ms`);
}

async function stopResource(resourceSession, resource, reason) {
  if (!resource) return null;
  const state = await resourceSession.status();
  const current = state.resources?.find(item => item.id === resource.id);
  if (current && ['starting', 'running'].includes(current.status)) {
    const stopped = await resourceSession.stop(resource.id, reason);
    assert.ok(stopped.ok, `stop request accepted for exact resource ${resource.id}`);
  }
  const exit = await resourceSession.waitProcess(resource.id, 15_000);
  assert.ok(!exit.timedOut && !exit.unavailable && !['starting', 'running'].includes(exit.status),
    `exact browser owner exited: ${JSON.stringify(exit)}`);
  const pids = Array.isArray(exit.pids) ? exit.pids : [];
  assert.ok(pids.length > 0 && pids.every(item => item.exitConfirmed === true),
    `guardian confirmed all exact browser process exits: ${JSON.stringify(pids)}`);
  return { resourceId: resource.id, pid: resource.pid, processStartTime: resource.processStartTime,
    processFingerprint: resource.processFingerprint, command: resource.command, cwd: resource.cwd,
    status: exit.status, exitCode: exit.exitCode, signal: exit.signal || null, pids,
    allTrackedPidsExited: true };
}

export async function runStage27R5CleanBrowserAcceptance({ resourceSession, checkoutRoot, webUrl, outputDirectory, taskId, runId }) {
  assert.ok(fs.existsSync(playwrightWrapper), 'Playwright CLI wrapper exists');
  assert.ok(fs.existsSync(playwrightConfig), 'isolated Chrome configuration exists');
  assert.ok(fs.existsSync(path.join(checkoutRoot, 'web', 'dist', 'index.html')), 'preview serves the clean-copy production build');
  assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(taskId), 'R5 browser task identity is a real task UUID');
  assert.ok(/^[A-Za-z0-9._-]{1,180}$/u.test(runId), 'browser evidence run ID is path safe');
  fs.mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const chromeBefore = chromeSnapshot();
  const vscodeBefore = vscodeSnapshot();
  const tempDirectory = await resourceSession.allocateDir('stage27-r5-playwright');
  const socketsDirectory = await resourceSession.allocateDir('stage27-r5-playwright-sockets');
  const socketAlias = path.join('/tmp', `pw-r5-${resourceSession.instanceId.slice(0, 8)}`);
  assert.ok(!fs.existsSync(socketAlias), `no existing task socket alias is replaced: ${socketAlias}`);
  fs.symlinkSync(socketsDirectory, socketAlias, 'dir');
  const profilePath = path.join(tempDirectory, 'chrome-profile');
  const openMarker = path.join(tempDirectory, 'open-status.json');
  const ownerPath = path.join(tempDirectory, 'browser-owner.mjs');
  const flowPath = path.join(tempDirectory, 'four-scenes-flow.mjs');
  const sessionName = `stage27-r5-${taskId.slice(0, 8)}-${runId.slice(-10)}`;
  const playwrightEnv = { PATH: process.env.PATH || '/usr/bin:/bin', npm_config_offline: 'true',
    NODE_DISABLE_COMPILE_CACHE: '1', PWTEST_SOCKETS_DIR: socketAlias, TMPDIR: socketAlias, TMP: socketAlias, TEMP: socketAlias };
  const evidence = { schemaVersion: 1, recordType: 'stage27-r5-clean-copy-browser-acceptance', taskId, runId,
    checkoutRoot, previewUrl: webUrl, startedAt: new Date().toISOString(), status: 'RUNNING',
    protectedChromeBefore: chromeBefore, protectedVsCodeBefore: vscodeBefore, resources: [], cliSteps: [],
    screenshots: [], assertions: [], externalRequests: [], httpErrors: [], pageErrors: [], consoleErrors: [] };
  const screenshotPaths = Object.fromEntries(['public-home-1280', 'public-news', 'public-assistant', 'guest-profile-1280',
    'guest-health', 'guest-advice', 'staff-1920', 'dean-1920'].map(name => [name, path.join(outputDirectory, `${name}.png`)]));
  const cli = async (args, label, timeoutMs = 60_000) => {
    const startedAt = Date.now();
    const resource = await resourceSession.runProcess({ label, kind: 'browser', role: 'playwright-cli',
      command: 'bash', args: [playwrightWrapper, ...(args[0] === 'open' ? ['--config', playwrightConfig] : []),
        '--session', sessionName, ...args], cwd: checkoutRoot,
      env: { ...playwrightEnv, CODEX_TASK_ID: taskId, CODEX_STAGE27_SCOPE: 'R5' }, leaseMs }, { timeoutMs });
    const receipt = resourceReceipt(resource, startedAt, resource.status);
    evidence.cliSteps.push(receipt);
    assert.equal(resource.status, 'exited', `${label} exited`);
    assert.equal(resource.exitCode, 0, `${label} returned zero: ${receipt.outputTail}`);
    assert.equal(resource.signal || null, null, `${label} was not signaled`);
    assert.equal(receipt.allTrackedPidsExited, true, `${label} descendants exited exactly`);
    return receipt.outputTail;
  };

  const ownerSource = `import {spawn} from 'node:child_process';import fs from 'node:fs';
const child=spawn('bash',[process.env.PLAYWRIGHT_WRAPPER,'--config',process.env.PLAYWRIGHT_CONFIG,'--session',process.env.PLAYWRIGHT_SESSION,'open','about:blank','--persistent','--profile',process.env.PLAYWRIGHT_PROFILE,'--idle-timeout','0'],{cwd:process.cwd(),env:{PATH:process.env.PATH||'/usr/bin:/bin',CODEX_TASK_ID:process.env.CODEX_TASK_ID,CODEX_STAGE27_SCOPE:'R5',npm_config_offline:'true',NODE_DISABLE_COMPILE_CACHE:'1',PWTEST_SOCKETS_DIR:process.env.PLAYWRIGHT_SOCKETS_DIR,TMPDIR:process.env.PLAYWRIGHT_SOCKETS_DIR,TMP:process.env.PLAYWRIGHT_SOCKETS_DIR,TEMP:process.env.PLAYWRIGHT_SOCKETS_DIR},stdio:['ignore','pipe','pipe']});let out='';for(const s of [child.stdout,child.stderr])s.on('data',c=>{out=(out+c.toString()).slice(-4096)});child.once('error',e=>{fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER,JSON.stringify({code:1,error:e.message,out}));process.exitCode=1});child.once('close',(code,signal)=>{fs.writeFileSync(process.env.PLAYWRIGHT_OPEN_MARKER,JSON.stringify({code,signal,out}));if(code!==0)process.exitCode=1});setInterval(()=>{},1000);`;
  fs.writeFileSync(ownerPath, ownerSource, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  let owner;
  let browserOpened = false;
  let flowError;
  let closeReceipt;
  let ownerExit;
  try {
    owner = await resourceSession.startProcess({ label: 'stage27-r5-playwright-owner', kind: 'browser', role: 'browser-session-owner',
      command: process.execPath, args: [ownerPath], cwd: tempDirectory,
      env: { ...playwrightEnv, CODEX_TASK_ID: taskId, CODEX_STAGE27_SCOPE: 'R5',
        PLAYWRIGHT_WRAPPER: playwrightWrapper, PLAYWRIGHT_CONFIG: playwrightConfig, PLAYWRIGHT_SESSION: sessionName,
        PLAYWRIGHT_PROFILE: profilePath, PLAYWRIGHT_OPEN_MARKER: openMarker, PLAYWRIGHT_SOCKETS_DIR: socketAlias }, leaseMs });
    assert.equal(owner.status, 'running', 'Playwright owner is a registered ResourceSession process');
    evidence.resources.push(resourceReceipt(owner, Date.now(), owner.status));
    browserOpened = true;
    const openOutput = await waitForFile(openMarker);
    evidence.openStatus = openOutput;
    assert.equal(openOutput.code, 0, `Playwright opened an isolated about:blank tab: ${String(openOutput.out || '').slice(-1000)}`);
    await cli(['snapshot'], 'stage27-r5-initial-about-blank-snapshot');

    const flow = `async page => {
const cfg=${JSON.stringify({ webUrl, screenshots: screenshotPaths, runId })};
const ensure=(value,message)=>{if(!value)throw new Error(message)};
const checks=[];const mark=(scene,action,expected,actual)=>checks.push({scene,action,expected,actual,result:'PASS'});
const external=[];const httpErrors=[];const pageErrors=[];const consoleErrors=[];const failedRequests=[];
page.setDefaultTimeout(25000);page.setDefaultNavigationTimeout(25000);
page.on('pageerror',error=>pageErrors.push(String(error.message||error).slice(0,500)));
page.on('console',message=>{if(message.type()==='error')consoleErrors.push(message.text().slice(0,500))});
page.on('response',response=>{if(response.status()>=400){const url=new URL(response.url());httpErrors.push({status:response.status(),origin:url.origin,path:url.pathname})}});
page.on('requestfailed',request=>failedRequests.push({url:request.url(),errorText:request.failure()?.errorText||null}));
await page.route('**/*',route=>{const url=new URL(route.request().url());if(['data:','blob:'].includes(url.protocol)||['127.0.0.1','localhost'].includes(url.hostname))return route.continue();external.push({origin:url.origin,resourceType:route.request().resourceType(),action:'aborted-before-network'});return route.abort()});
await page.setViewportSize({width:1280,height:900});await page.goto(cfg.webUrl,{waitUntil:'domcontentloaded'});
await page.getByText('海屿康养社区',{exact:false}).first().waitFor();await page.locator('.featured-copy h3').waitFor();
const health=await page.evaluate(async()=>{const response=await fetch('/api/health');return{status:response.status,body:await response.json()}});
ensure(health.status===200&&health.body.ok===true,'production preview proxies its same-origin API health check');
const newsTitle=(await page.locator('.featured-copy h3').innerText()).trim();ensure(newsTitle.length>0,'public news story is visible');
await page.getByRole('button',{name:/阅读全文/}).first().click();await page.locator('.news-modal').waitFor({state:'visible'});
const modalTitle=(await page.locator('.news-modal h2').innerText()).trim();const newsBody=(await page.locator('.news-modal .modal-body').innerText()).trim();
ensure(modalTitle===newsTitle&&newsBody.length>0,'selected public news opens with matching title and readable content');
await page.screenshot({path:cfg.screenshots['public-news'],fullPage:true});await page.getByRole('button',{name:'关闭新闻详情'}).click();
await page.getByRole('button',{name:'打开智能助手'}).click();const assistant=page.locator('.assistant-window');await assistant.waitFor({state:'visible'});
const publicQuestion='我想了解海屿社区服务，应从哪里开始？';await page.getByLabel('输入给智能助手的内容').fill(publicQuestion);
await page.getByRole('button',{name:'发送消息'}).click();
await page.waitForFunction(()=>document.querySelectorAll('.assistant-message.assistant').length>=2&&
  [...document.querySelectorAll('.assistant-message.assistant')].at(-1)?.innerText?.trim().length>0,null,{timeout:30000});
const publicAssistantReply=(await page.locator('.assistant-message.assistant').last().innerText()).trim();
ensure(publicAssistantReply.length>=12,'anonymous assistant returned a visible local public guide');
await page.screenshot({path:cfg.screenshots['public-assistant'],fullPage:true});
await page.getByRole('button',{name:'关闭智能助手'}).click();await assistant.waitFor({state:'hidden'});
const publicLayout=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
ensure(publicLayout.document<=publicLayout.viewport&&publicLayout.body<=publicLayout.viewport,'public layout fits a natural 1280px desktop viewport');
mark('public','news and anonymous assistant','news opens and anonymous public question receives an offline guide',{newsTitle,modalTitle,newsBodyCharacters:newsBody.length,question:publicQuestion,reply:publicAssistantReply,apiHealth:health,viewport:publicLayout});
await page.screenshot({path:cfg.screenshots['public-home-1280'],fullPage:true});

async function login(roleButton,username,password){await page.getByRole('button',{name:new RegExp(roleButton)}).first().click();await page.getByLabel('账号').fill(username);await page.getByLabel('密码').fill(password);await page.getByRole('button',{name:/进入工作区/}).click();await page.waitForFunction(()=>Boolean(localStorage.getItem('community_token')&&localStorage.getItem('community_user')),null,{timeout:15000});await page.locator('.app-header .user-menu strong').waitFor();return{user:(await page.locator('.app-header .user-menu strong').innerText()).trim(),navigation:(await page.locator('.side-nav').innerText()).trim()}}
async function logout(){await page.getByRole('button',{name:'退出登录'}).first().click();await page.waitForFunction(()=>!localStorage.getItem('community_token')&&!localStorage.getItem('community_user'),null,{timeout:10000});}
async function openGuestMenu(label){await page.getByRole('button',{name:'我的',exact:true}).click();await page.locator('.guest-my-entry').filter({hasText:label}).click();}

await login('我是客人','guest_demo','guest2026');await openGuestMenu('我的档案');await page.getByRole('heading',{name:'我的资料'}).waitFor();
const disabledProfileFields=await page.locator('.form-surface input:disabled').count();ensure(disabledProfileFields>=4,'identity/stay fields remain read-only');
const phone='139'+String(Date.now()).slice(-8);await page.getByLabel('联系电话').fill(phone);await page.getByRole('button',{name:/保存修改/}).click();
await page.locator('.toast').filter({hasText:'个人资料已保存'}).waitFor({timeout:12000});await page.reload({waitUntil:'domcontentloaded'});
await page.locator('.app-shell').waitFor();await openGuestMenu('我的档案');await page.getByLabel('联系电话').waitFor();
const persistedPhone=await page.getByLabel('联系电话').inputValue();ensure(persistedPhone===phone,'guest contact persists after a real reload');
await page.screenshot({path:cfg.screenshots['guest-profile-1280'],fullPage:true});
await openGuestMenu('健康记录');await page.locator('.health-records-surface').waitFor({state:'visible'});
const healthText=(await page.locator('.health-records-surface').innerText()).trim();ensure(healthText.length>0,'guest reads the recorded health history');
await page.screenshot({path:cfg.screenshots['guest-health'],fullPage:true});
await openGuestMenu('我的医嘱');await page.getByRole('heading',{name:'我的医嘱'}).waitFor();
const adviceWriteControls=await page.locator('.advice-list form,.advice-list button,.advice-list input,.advice-list textarea').count();
ensure(adviceWriteControls===0,'guest advice view is read-only');await page.screenshot({path:cfg.screenshots['guest-advice'],fullPage:true});
const guestLayout=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
ensure(guestLayout.document<=guestLayout.viewport&&guestLayout.body<=guestLayout.viewport,'guest desktop layout fits a natural 1280px viewport');
mark('guest','save contact and read health/advice','contact survives reload, institution fields are read-only, health/advice render read-only',{phone,persistedPhone,disabledProfileFields,healthHistoryCharacters:healthText.length,adviceWriteControls,viewport:guestLayout});
await logout();await page.reload({waitUntil:'domcontentloaded'});ensure((await page.locator('body').innerText()).includes('我是客人'),'guest logout returns to public entry');

const staff=await login('我是工作人员','staff_demo','staff2026');ensure(staff.navigation.includes('我负责的客人'),'staff sees assigned guest navigation');
await page.getByRole('button',{name:'我负责的客人',exact:true}).click();await page.getByRole('heading',{name:'我负责的客人'}).waitFor();
const assigned=page.locator('.guest-row').filter({hasText:'林海宁'}).first();await assigned.waitFor({state:'visible'});
const assignedGuestName=(await assigned.innerText()).trim();await assigned.click();await page.locator('.profile-hero h2').waitFor();
const adviceTitle='R5 clean-copy suggestion '+cfg.runId;const adviceContent='本地四场景演示建议；仅用于本机验收。';
await page.getByRole('button',{name:/新增建议/}).click();await page.locator('.advice-form').waitFor({state:'visible'});
await page.getByLabel('标题').fill(adviceTitle);await page.getByLabel('建议内容').fill(adviceContent);
const adviceResponsePromise=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.includes('/api/staff/guests/')&&new URL(response.url()).pathname.endsWith('/advice'),{timeout:20000});
await page.getByRole('button',{name:/发布建议/}).click();const adviceResponse=await adviceResponsePromise;const adviceResult=await adviceResponse.json();
ensure(adviceResponse.status()===201&&Number.isSafeInteger(Number(adviceResult.id)),'staff publish created one persisted advice row with ID');
await page.locator('.toast').filter({hasText:'医嘱已发布，客人可以查看'}).waitFor({timeout:12000});
await page.locator('.staff-advice-row').filter({hasText:adviceTitle}).waitFor({state:'visible'});
const guestListData=await page.evaluate(async()=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/staff/guests',{headers:{authorization:'Bearer '+token}});return{status:response.status,rows:await response.json()}});
const matchingGuest=guestListData.rows.find(item=>item.name==='林海宁');ensure(guestListData.status===200&&matchingGuest?.id,'staff assigned guest API returned the same visible guest');
await page.setViewportSize({width:1920,height:1080});const staffLayout=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
ensure(staffLayout.document<=staffLayout.viewport&&staffLayout.body<=staffLayout.viewport,'staff page naturally fits a 1920px desktop viewport');
await page.screenshot({path:cfg.screenshots['staff-1920'],fullPage:true});
mark('staff','publish advice to assigned guest','assigned guest is visible and staff creates a persisted advice row',{assignedGuestName,guestId:matchingGuest.id,adviceId:String(adviceResult.id),adviceTitle,adviceResponseStatus:adviceResponse.status(),viewport:staffLayout});
await logout();await page.reload({waitUntil:'domcontentloaded'});

const dean=await login('院长管理入口','dean_demo','dean2026');ensure(dean.navigation.includes('院长意见'),'dean sees staff management navigation');
await page.getByRole('button',{name:'院长意见',exact:true}).click();await page.getByRole('heading',{name:'工作人员管理'}).waitFor();
await page.locator('.guest-list .guest-row').first().waitFor({state:'visible'});
const staffWithAdvice=await page.evaluate(async({adviceTitle,guestId})=>{const token=localStorage.getItem('community_token');const headers={authorization:'Bearer '+token};const staffResponse=await fetch('/api/dean/staff',{headers});const staffRows=await staffResponse.json();for(const staff of staffRows){const response=await fetch('/api/dean/staff/'+encodeURIComponent(staff.id)+'/logs',{headers});const detail=await response.json();const log=(detail.logs||[]).find(item=>item.action==='advice.create'&&item.targetId===guestId&&item.detail===adviceTitle);if(log)return{staff,detail,log};}return null;},{adviceTitle,guestId:matchingGuest.id});
ensure(staffWithAdvice?.staff?.id,'dean API finds the actual employee audit log for the guest advice');
const staffButton=page.locator('.guest-list .guest-row').filter({hasText:staffWithAdvice.staff.username}).first();await staffButton.click();
await page.locator('.staff-log-list').waitFor({state:'visible'});const visibleLogs=(await page.locator('.staff-log-list').innerText()).trim();
ensure(visibleLogs.includes(adviceTitle),'dean browser visibly reads the same employee advice log');
const deanOpinion='R5 local acceptance review '+cfg.runId;
await page.locator('.review-form textarea').fill(deanOpinion);
const reviewResponsePromise=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/reviews'),{timeout:20000});
await page.getByRole('button',{name:/记录意见/}).click();const reviewResponse=await reviewResponsePromise;const reviewResult=await reviewResponse.json();
ensure(reviewResponse.status()===201&&Number.isSafeInteger(Number(reviewResult.id)),'dean opinion saved with a real review record ID');
await page.locator('.review-history').getByText(deanOpinion,{exact:true}).waitFor({state:'visible'});
const deanReadback=await page.evaluate(async({staffId,reviewId,opinion})=>{const token=localStorage.getItem('community_token');const response=await fetch('/api/dean/staff/'+encodeURIComponent(staffId)+'/logs',{headers:{authorization:'Bearer '+token}});const detail=await response.json();return{status:response.status,review:(detail.reviews||[]).find(item=>String(item.id)===String(reviewId)&&item.content===opinion),logs:detail.logs||[]};},{staffId:staffWithAdvice.staff.id,reviewId:reviewResult.id,opinion:deanOpinion});
ensure(deanReadback.status===200&&deanReadback.review,'dean API reads back its same review ID and content');
await page.setViewportSize({width:1920,height:1080});const deanLayout=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth,body:document.body.scrollWidth}));
ensure(deanLayout.document<=deanLayout.viewport&&deanLayout.body<=deanLayout.viewport,'dean page naturally fits a 1920px desktop viewport');
await page.screenshot({path:cfg.screenshots['dean-1920'],fullPage:true});
mark('dean','read staff log and save an opinion','dean sees the matching employee advice log and reads the same saved review ID',{staffId:staffWithAdvice.staff.id,staffName:staffWithAdvice.staff.name,adviceId:String(adviceResult.id),adviceLogId:String(staffWithAdvice.log.id),reviewId:String(reviewResult.id),reviewReadback:deanReadback.review,viewport:deanLayout});
await logout();await page.reload({waitUntil:'domcontentloaded'});await page.getByText('我是客人',{exact:false}).first().waitFor();
const publicAfterLogout=await page.locator('body').innerText();const tokenAfterLogout=await page.evaluate(()=>({token:localStorage.getItem('community_token'),user:localStorage.getItem('community_user')}));
ensure(tokenAfterLogout.token===null&&tokenAfterLogout.user===null,'all account session data is cleared after logout');
ensure(!publicAfterLogout.includes(phone)&&!publicAfterLogout.includes('guest_demo')&&!publicAfterLogout.includes('staff_demo')&&!publicAfterLogout.includes('dean_demo'),'private phone and demo account IDs are absent from the returned public page');
mark('logout','clear the dean session and return to public view','private identity/session data is absent',{tokenAfterLogout,privatePhoneAbsent:!publicAfterLogout.includes(phone),demoAccountsAbsent:true});

const unexpectedErrors=httpErrors.filter(item=>['127.0.0.1','localhost'].includes(new URL(cfg.webUrl).hostname));
ensure(pageErrors.length===0,'browser completed without uncaught page errors');
ensure(unexpectedErrors.length===0,'preview and API returned no HTTP errors or missing static resources');
ensure(external.length===0,'preview did not attempt any off-device provider or external request');
ensure(consoleErrors.length===0,'browser completed without console errors');
const result={status:'PASS',assertions:checks,externalRequests:external,httpErrors,unexpectedHttpErrors:unexpectedErrors,
  pageErrors,consoleErrors,failedRequests,viewports:[1280,1920],scenes:['public','guest','staff','dean','logout'],
  public:{newsTitle,assistantQuestion:publicQuestion,assistantReply:publicAssistantReply,apiHealth:health},
  guest:{phone,persistedPhone,disabledProfileFields,healthHistoryCharacters:healthText.length,adviceWriteControls},
  staff:{guestId:matchingGuest.id,adviceId:String(adviceResult.id),adviceTitle},
  dean:{staffId:staffWithAdvice.staff.id,adviceLogId:String(staffWithAdvice.log.id),reviewId:String(reviewResult.id),review:deanReadback.review},
  logout:{tokenAfterLogout,privatePhoneAbsent:!publicAfterLogout.includes(phone)}};
await page.evaluate(value=>{document.title='R5_BROWSER_RESULT:'+JSON.stringify(value)},result);return result;
}`;
    fs.writeFileSync(flowPath, flow, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const flowOutput = await cli(['run-code', '--filename', flowPath], 'stage27-r5-four-scenes-browser-flow', 360_000);
    const flowTitle = await cli(['eval', 'document.title'], 'stage27-r5-browser-result-title', 30_000);
    const marker = `${flowOutput}\n${flowTitle}`.match(/R5_BROWSER_RESULT:(\{[^\r\n]*\})/u);
    assert.ok(marker, `browser flow returned structured evidence: ${`${flowOutput}\n${flowTitle}`.slice(-3000)}`);
    const flowResult = JSON.parse(marker[1]);
    assert.equal(flowResult.status, 'PASS');
    evidence.assertions = flowResult.assertions;
    evidence.externalRequests = flowResult.externalRequests;
    evidence.httpErrors = flowResult.httpErrors;
    evidence.pageErrors = flowResult.pageErrors;
    evidence.consoleErrors = flowResult.consoleErrors;
    evidence.failedRequests = flowResult.failedRequests;
    evidence.scenes = flowResult.scenes;
    evidence.viewports = flowResult.viewports;
    evidence.public = flowResult.public; evidence.guest = flowResult.guest;
    evidence.staff = flowResult.staff; evidence.dean = flowResult.dean; evidence.logout = flowResult.logout;
    await cli(['snapshot'], 'stage27-r5-final-browser-snapshot', 30_000);
    const finalView = await cli(['eval', 'document.title'], 'stage27-r5-final-browser-title', 30_000);
    assert.ok(finalView.includes('R5_BROWSER_RESULT:'), 'final UI snapshot still displays structured scene evidence');
    closeReceipt = await cli(['close'], 'stage27-r5-playwright-close', 30_000);
    browserOpened = false;
  } catch (error) { flowError = error; }

  const cleanupErrors = [];
  if (browserOpened) {
    try {
      const closeOutput = await cli(['close'], 'stage27-r5-playwright-failure-close', 30_000);
      evidence.failureCloseTail = closeOutput.slice(-4000);
      browserOpened = false;
    } catch (error) { cleanupErrors.push(`Playwright CLI close failed: ${String(error.message || error)}`); }
  }
  try { ownerExit = await stopResource(resourceSession, owner, 'stage27-r5-browser-complete'); }
  catch (error) { cleanupErrors.push(`browser owner stop failed: ${String(error.message || error)}`); }
  try {
    const handles = spawnSync('lsof', ['-nP', '+D', socketAlias], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 });
    assert.ok([0, 1].includes(handles.status) && !handles.error, 'task socket handle check completed');
    assert.equal(String(handles.stdout || '').trim(), '', 'no process retains the R5 Playwright socket alias');
    fs.unlinkSync(socketAlias);
    evidence.socketAlias = { path: socketAlias, matchingHandles: 'none', removed: true };
  } catch (error) { cleanupErrors.push(`Playwright socket cleanup failed: ${String(error.message || error)}`); }
  try {
    evidence.protectedChromeAfter = chromeSnapshot();
    evidence.protectedVsCodeAfter = vscodeSnapshot();
    assert.equal(evidence.protectedChromeAfter.identity.fingerprint, chromeBefore.identity.fingerprint,
      'protected Chrome process identity remains unchanged');
    assert.deepEqual(evidence.protectedChromeAfter.clonePaths, chromeBefore.clonePaths, 'protected Chrome handle paths remain unchanged');
    assert.deepEqual(evidence.protectedChromeAfter.cacheNames, chromeBefore.cacheNames, 'protected Chrome caches remain unchanged');
    assert.equal(evidence.protectedVsCodeAfter.fingerprint, vscodeBefore.fingerprint, 'protected VS Code process identity remains unchanged');
  } catch (error) { cleanupErrors.push(`protected user application identity changed: ${String(error.message || error)}`); }

  evidence.ownerExit = ownerExit; evidence.playwrightClose = closeReceipt;
  evidence.cleanupErrors = cleanupErrors; evidence.cleanupCompletedAt = new Date().toISOString();
  evidence.status = cleanupErrors.length ? 'BLOCKED' : flowError ? 'FAIL' : 'PASS';
  evidence.error = flowError ? String(flowError.stack || flowError.message || flowError).slice(-8000) : null;
  for (const [name, filePath] of Object.entries(screenshotPaths)) {
    if (!fs.existsSync(filePath)) continue;
    const bytes = fs.readFileSync(filePath);
    const genuinePng = bytes.length > 1024 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    evidence.screenshots.push({ name, path: path.relative(path.resolve(fileURLToPath(new URL('../..', import.meta.url))), filePath),
      bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), genuinePng });
    if (!genuinePng && !flowError) flowError = new Error(`${name} screenshot is not a genuine PNG`);
  }
  if (flowError) evidence.status = 'FAIL';
  evidence.finishedAt = new Date().toISOString();
  const evidencePath = path.join(outputDirectory, 'browser-acceptance.json');
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  assert.ok(fs.statSync(evidencePath).size <= 8 * 1024 * 1024, 'browser evidence stays below 8 MiB');
  if (cleanupErrors.length) throw new Error(`R5 browser cleanup is BLOCKED; evidence retained at ${evidencePath}: ${cleanupErrors.join('; ')}`);
  if (flowError) throw Object.assign(flowError, { r5BrowserEvidencePath: evidencePath });
  return { status: 'PASS', evidencePath, evidenceSha256: crypto.createHash('sha256').update(fs.readFileSync(evidencePath)).digest('hex'),
    screenshotCount: evidence.screenshots.length, screenshots: evidence.screenshots,
    assertions: evidence.assertions, public: evidence.public, guest: evidence.guest, staff: evidence.staff, dean: evidence.dean,
    externalRequestCount: evidence.externalRequests.length, httpErrorCount: evidence.httpErrors.length,
    browserClose: closeReceipt, ownerExit };
}
