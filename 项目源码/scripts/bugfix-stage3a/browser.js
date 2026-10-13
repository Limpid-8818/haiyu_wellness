import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {processIdentity} from '../resources/resource-runtime.js';
const cfg=JSON.parse(fs.readFileSync(process.env.STAGE3A_BROWSER_CONFIG));assert.ok(cfg.profile.startsWith('/tmp/haiyu-resource-'));
const {chromium}=await import(pathToFileURL(cfg.playwrightModule).href);
const launch=JSON.parse(fs.readFileSync(cfg.launchConfig)).browser.launchOptions;
const context=await chromium.launchPersistentContext(cfg.profile,{...launch,viewport:{width:1440,height:900}});
const page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(5000);
const evidence={assertions:[],http:[],screenshots:[],pageErrors:[],externalRequests:[]};
page.on('pageerror',error=>evidence.pageErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const check=(value,label)=>{evidence.assertions.push({label,pass:Boolean(value)});assert.ok(value,label)};
const save=()=>fs.writeFileSync(path.join(cfg.out,'browser.json'),JSON.stringify(evidence,null,2));
const snap=async(name,selector)=>{const file=path.join(cfg.out,name+'.png');if(selector)await page.locator(selector).first().screenshot({path:file});else await page.screenshot({path:file});evidence.screenshots.push(file)};
const tokens={};let guestId,runId,sessionId;
async function call(role,route,method='GET',body,expected=200){
  const response=await page.request.fetch(cfg.web+'/api'+route,{method,headers:{'Content-Type':'application/json',...(tokens[role]?{Authorization:`Bearer ${tokens[role]}`}:{})},...(body===undefined?{}:{data:body})});const data=await response.json();
  evidence.http.push({route,method,role,status:response.status(),code:data.code||null});check(response.status()===expected,`${method} ${route} HTTP${expected}`);return data;
}
async function login(){
  await page.goto(cfg.web);await page.getByRole('button',{name:/^我是客人/}).first().click();
  await page.getByLabel('账号',{exact:true}).fill('19900007001');await page.getByLabel('密码',{exact:true}).fill('Synthetic-stage3a-only-123');
  await page.getByRole('button',{name:'进入工作区　→',exact:true}).click();await page.locator('.side-nav').waitFor();await page.locator('[data-testid="guest-agent-results"]').waitFor();
}
async function prepare(){
  const ps=spawnSync('ps',['-axo','pid=,comm='],{encoding:'utf8',timeout:5000,maxBuffer:131072});assert.equal(ps.status,0);
  const identities=ps.stdout.split('\n').filter(line=>/\/Google Chrome$/.test(line)).map(line=>{const pid=Number(line.trim().split(/\s/)[0]);const identity=processIdentity(pid);const command=spawnSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:2000}).stdout.trim();return identity?{...identity,command}:null}).filter(row=>row?.command.includes(`--user-data-dir=${cfg.profile}`));
  assert.equal(identities.length,1);check(identities[0].command.includes('MacAppCodeSignClone'),'Chrome clone protection enabled');fs.writeFileSync(path.join(cfg.out,'chrome.json'),JSON.stringify(identities[0],null,2));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(url.hostname)||['blob:','data:'].includes(url.protocol))return route.continue();evidence.externalRequests.push(url.origin);return route.abort()});
  tokens.admin=(await call(null,'/auth/login','POST',{username:'admin_demo',password:'staff2026',role:'staff'})).token;
  tokens.clinician=(await call(null,'/auth/login','POST',{username:'staff_demo',password:'staff2026',role:'staff'})).token;
  const registered=await call(null,'/auth/register','POST',{name:'阶段3A合成资料缺项客人',phone:'19900007001',password:'Synthetic-stage3a-only-123',confirmPassword:'Synthetic-stage3a-only-123'},201);guestId=registered.user.id;tokens.guest=registered.token;
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());const end=new Date(date+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+3);
  await call('admin',`/dean/guests/${guestId}/stay`,'PATCH',{roomNo:'合成房间',checkIn:date,checkOut:end.toISOString().slice(0,10),stayPlan:'three_night'});
  const clinician=(await call('admin','/dean/staff')).find(row=>row.username==='staff_demo');await call('admin',`/dean/guests/${guestId}/assignments`,'POST',{staffId:clinician.id},201);
  const intake=await call('guest','/me/health-intakes','POST',{baseProfileVersion:0,profile:{mobility:{status:'independent',details:'可独立行走'},sleep:{status:'reported',details:'近期睡眠一般'}}},201);
  await call('clinician',`/staff/health-intakes/${intake.pendingIntakes[0].id}/confirm`,'POST',{baseProfileVersion:0});
  evidence.empty=await call('guest','/agent/status');check(evidence.empty.state==='not_run'&&!evidence.empty.run,'configured guest has no actual run');check(evidence.empty.serviceHealth.state==='unknown','configuration is not provider health');check(evidence.empty.agents.every(row=>row.state!=='done'),'no fixed done events');
  await call('guest','/agent/status?guestId=guest_001','GET',undefined,403);
  await login();await page.getByText('尚未运行',{exact:true}).waitFor();await snap('01-no-run');
  evidence.guestId=guestId;return {guestId,emptyState:evidence.empty.state};
}
async function submit(){
  await page.getByRole('button',{name:'打开智能助手',exact:true}).click();await page.locator('.assistant-window').waitFor();
  const text='我想了解温泉或海水浴，看看明天三餐吃什么，安排一点轻松的运动，再找一个舒缓心情的陪伴课程。请从理疗、营养、运动和心理陪伴四方面一起帮我整理建议，说明用到了哪些资料，未核实的信息请指出来。';
  await page.locator('.assistant-input input').fill(text);
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/api/assistant/chat')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();const response=await responsePromise;const started=await response.json();check(response.status()===202,'native async chat starts once');
  runId=started.runId;sessionId=started.sessionId;evidence.started={...started,text};save();return {runId,sessionId,guestId};
}
async function observe(){
  const run=await call('guest',`/assistant/runs/${runId}?role=guest`);evidence.observations||=[];evidence.observations.push({status:run.status,at:new Date().toISOString()});save();return {status:run.status,runId,modelCalls:run.modelCallCount,tools:run.toolCallCount};
}
async function verify(){
  const run=await call('guest',`/assistant/runs/${runId}?role=guest`);assert.ok(!['queued','running'].includes(run.status),'only verify terminal run');evidence.run=run;
  if(await page.getByRole('button',{name:'关闭智能助手',exact:true}).count())await page.getByRole('button',{name:'关闭智能助手',exact:true}).click();
  await page.reload();const home=page.locator('[data-testid="guest-agent-results"]');await home.getByText(`运行 ${runId}`,{exact:false}).waitFor();evidence.home=await call('guest','/agent/status');check(evidence.home.run.runId===runId,'home reads same parent run after refresh');
  const six=['慢病史','长期用药说明','过敏源','饮食忌口','皮肤状况','客群标签'];check(six.every(label=>run.reply.includes(label)),'final reply explicitly lists all six health gaps');check(run.reply.includes('未知不代表没有'),'unknown is not absence');
  await snap('02-home-result');await home.getByRole('button',{name:'打开原运行详情',exact:true}).click();await home.locator('.assistant-trace-toggle').click();
  const parent=home.locator('.assistant-trace-run');if(await parent.count())await snap('03-parent-coordinator','[data-testid="guest-agent-results"] .assistant-trace-run');
  for(const domain of ['physio','nutrition','exercise','psychology']){const agent=home.locator('.assistant-trace-agent').filter({hasText:run.collaboration?.agents?.find(row=>row.agentId==='domain.'+domain)?.name||'missing'});if(await agent.count())await snap('04-domain-'+domain,`[data-testid="guest-agent-results"] .assistant-trace-agent:nth-of-type(${(run.collaboration?.agents||[]).findIndex(row=>row.agentId==='domain.'+domain)+1})`).catch(async()=>{await agent.first().scrollIntoViewIfNeeded();await snap('04-domain-'+domain)});}
  await snap('05-sources','[data-testid="guest-agent-results"] .assistant-sources');
  const reply=home.locator('p').filter({hasText:'尚未提供或核实：'}).first();await reply.screenshot({path:path.join(cfg.out,'06-complete-reply.png')});evidence.screenshots.push(path.join(cfg.out,'06-complete-reply.png'));fs.writeFileSync(path.join(cfg.out,'visible-reply.txt'),await reply.innerText());
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await login();await home.getByText(`运行 ${runId}`,{exact:false}).waitFor();check((await home.innerText()).includes(runId),'relogin retains original run');await snap('07-relogin');
  const complete=run.status==='completed'&&run.collaboration?.agents?.length===4&&run.collaboration.agents.every(row=>row.status==='completed')&&run.collaboration.coordinatorStatus==='completed'&&run.collaboration.selectionSource==='model'&&run.modelCallCount===9&&run.toolCallCount>=8&&run.usageReported;
  evidence.businessResult=complete?'PASS':'FAIL';check(evidence.pageErrors.length===0,'no page errors');check(evidence.externalRequests.length===0,'no browser external traffic');save();return {guestId,runId,sessionId,status:run.status,businessResult:evidence.businessResult,modelCalls:run.modelCallCount,toolCalls:run.toolCallCount,usage:run.traceUsage,homeState:evidence.home.state};
}
let serial=1,closing=false;
try{while(!closing){const file=path.join(cfg.channel,`command-${serial}.json`);if(!fs.existsSync(file)){await sleep(75);continue}const cmd=JSON.parse(fs.readFileSync(file));let result;
  try{result=cmd.op==='prepare'?await prepare():cmd.op==='submit'?await submit():cmd.op==='observe'?await observe():cmd.op==='verify'?await verify():cmd.op==='close'?(closing=true,{closed:true}):(()=>{throw new Error('unsupported op')})();}
  catch(error){evidence.failure=error.message;save();await snap('failure-'+serial).catch(()=>{});fs.writeFileSync(path.join(cfg.out,'failure-visible.txt'),(await page.locator('body').innerText()).slice(-16000));result={error:error.message};}
  fs.writeFileSync(path.join(cfg.channel,`reply-${serial}.json`),JSON.stringify(result));serial++;
}}finally{save();await context.close()}
