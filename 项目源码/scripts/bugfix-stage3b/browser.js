import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {processIdentity} from '../resources/resource-runtime.js';
const cfg=JSON.parse(fs.readFileSync(process.env.STAGE3B_BROWSER_CONFIG));assert.ok(cfg.profile.startsWith('/tmp/haiyu-resource-'));
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
const tokens={};let guestId,runId,sessionId,draft,revised,adoptBody,adoptKey,approvalKey;
async function call(role,route,method='GET',body,expected=200,key){
  const response=await page.request.fetch(cfg.web+'/api'+route,{method,headers:{'Content-Type':'application/json',...(tokens[role]?{Authorization:`Bearer ${tokens[role]}`}:{}) ,...(key?{'Idempotency-Key':key}:{})},...(body===undefined?{}:{data:body})});const data=await response.json();
  evidence.http.push({route,method,role,status:response.status(),code:data.code||null});check(response.status()===expected,`${method} ${route} HTTP${expected}`);return data;
}
async function login(){
  await page.goto(cfg.web);await page.getByRole('button',{name:/^我是客人/}).first().click();
  await page.getByLabel('账号',{exact:true}).fill('19900007401');await page.getByLabel('密码',{exact:true}).fill('Synthetic-stage3b-only-123');
  await page.getByRole('button',{name:'进入工作区　→',exact:true}).click();await page.locator('.side-nav').waitFor();await page.locator('[data-testid="guest-agent-results"]').waitFor();
}
async function prepare(){
  const ps=spawnSync('ps',['-axo','pid=,comm='],{encoding:'utf8',timeout:5000,maxBuffer:131072});assert.equal(ps.status,0);
  const identities=ps.stdout.split('\n').filter(line=>/\/Google Chrome$/.test(line)).map(line=>{const pid=Number(line.trim().split(/\s/)[0]);const identity=processIdentity(pid);const command=spawnSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:2000}).stdout.trim();return identity?{...identity,command}:null}).filter(row=>row?.command.includes(`--user-data-dir=${cfg.profile}`));
  assert.equal(identities.length,1);check(identities[0].command.includes('MacAppCodeSignClone'),'Chrome clone protection enabled');fs.writeFileSync(path.join(cfg.out,'chrome.json'),JSON.stringify(identities[0],null,2));
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(url.hostname)||['blob:','data:'].includes(url.protocol))return route.continue();evidence.externalRequests.push(url.origin);return route.abort()});
  tokens.admin=(await call(null,'/auth/login','POST',{username:'admin_demo',password:'staff2026',role:'staff'})).token;
  tokens.clinician=(await call(null,'/auth/login','POST',{username:'staff_demo',password:'staff2026',role:'staff'})).token;
  const registered=await call(null,'/auth/register','POST',{name:'阶段3B合成闭环客人',phone:'19900007401',password:'Synthetic-stage3b-only-123',confirmPassword:'Synthetic-stage3b-only-123'},201);guestId=registered.user.id;tokens.guest=registered.token;
  const date=cfg.date; const future=new Date(date+'T12:00:00Z');future.setUTCDate(future.getUTCDate()+1);evidence.targetDate=future.toISOString().slice(0,10);const end=new Date(date+'T12:00:00Z');end.setUTCDate(end.getUTCDate()+3);
  await call('admin',`/dean/guests/${guestId}/stay`,'PATCH',{roomNo:'合成房间',checkIn:date,checkOut:end.toISOString().slice(0,10),stayPlan:'three_night'});
  const clinician=(await call('admin','/dean/staff')).find(row=>row.username==='staff_demo');await call('admin',`/dean/guests/${guestId}/assignments`,'POST',{staffId:clinician.id},201);
  const intake=await call('guest','/me/health-intakes','POST',{baseProfileVersion:0,profile:{chronic:{status:'none',items:[]},medications:{status:'none',items:[]},allergies:{status:'none',items:[]},dietaryRestrictions:{status:'none',items:[]},mobility:{status:'independent',details:'合成客人可独立行走'},sleep:{status:'reported',details:'睡眠正常'},skin:{status:'reported',details:'皮肤完整，状况良好'},audienceTags:{status:'none',items:[]}}},201);
  await call('clinician',`/staff/health-intakes/${intake.pendingIntakes[0].id}/confirm`,'POST',{baseProfileVersion:0});
  evidence.empty=await call('guest','/agent/status');check(evidence.empty.state==='not_run'&&!evidence.empty.run,'configured guest has no actual run');check(evidence.empty.serviceHealth.state==='unknown','configuration is not provider health');check(evidence.empty.agents.every(row=>row.state!=='done'),'no fixed done events');
  await call('guest','/agent/status?guestId=guest_001','GET',undefined,403);
  const outsider=await call('admin','/dean/staff','POST',{username:'stage3b_outsider',password:'Synthetic-stage3b-only-123',name:'合成无负责关系医护',jobType:'clinician',phone:''},201);tokens.outsider=(await call(null,'/auth/login','POST',{username:'stage3b_outsider',password:'Synthetic-stage3b-only-123',role:'staff'})).token;
  tokens.otherGuest=(await call(null,'/auth/register','POST',{name:'合成另一客人',phone:'19900007402',password:'Synthetic-stage3b-only-123',confirmPassword:'Synthetic-stage3b-only-123'},201)).token;
  for(const project of ['stage2-indoor-exercise','project-sea-mud'])await call('guest',`/projects/${project}/slots?date=${evidence.targetDate}`);
  const later=new Date(evidence.targetDate+'T12:00:00Z');later.setUTCDate(later.getUTCDate()+1);evidence.revisionDate=later.toISOString().slice(0,10);await call('guest',`/projects/stage2-indoor-exercise/slots?date=${evidence.revisionDate}`);
  await login();await page.getByText('尚未运行',{exact:true}).waitFor();await snap('01-no-run');
  evidence.guestId=guestId;return {guestId,emptyState:evidence.empty.state};
}
async function submit(){
  await page.getByRole('button',{name:'打开智能助手',exact:true}).click();await page.locator('.assistant-window').waitFor();
  const text='明天想做室内海泥理疗，看看三餐吃什么，安排一点轻松的室内运动，再找一个舒缓心情的陪伴课程。请从理疗、营养、运动和心理陪伴四方面一起帮我整理建议，引用实际资料，未核实的信息请指出来。现在不要预约或下单。';
  await page.locator('.assistant-input input').fill(text);
  const responsePromise=page.waitForResponse(response=>response.url().endsWith('/api/assistant/chat')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();const response=await responsePromise;const started=await response.json();check(response.status()===202,'native async chat starts once');
  runId=started.runId;sessionId=started.sessionId;evidence.started={...started,text};save();return {runId,sessionId,guestId};
}
async function observe(){
  const run=await call('guest',`/assistant/runs/${runId}?role=guest`);evidence.observations||=[];evidence.observations.push({status:run.status,at:new Date().toISOString()});save();return {status:run.status,runId,modelCalls:run.modelCallCount,tools:run.toolCallCount};
}
async function schedule(){
  if(await page.getByRole('button',{name:'关闭智能助手',exact:true}).count())await page.getByRole('button',{name:'关闭智能助手',exact:true}).click();
  await page.locator('.side-nav').getByRole('button',{name:'日程',exact:true}).click();await page.getByRole('heading',{name:'日程与疗程草案',exact:true}).waitFor();
}
async function nativeResponse(url,method,action){const promise=page.waitForResponse(r=>r.url().endsWith('/api'+url)&&r.request().method()===method);await action();const response=await promise;const data=await response.json();evidence.http.push({role:'native',route:url,method,status:response.status()});check(response.ok(),`native ${method} ${url}`);return {data,key:response.request().headers()['idempotency-key'],body:response.request().postDataJSON()};}
async function adopt(){
  const run=await call('guest',`/assistant/runs/${runId}?role=guest`);evidence.run=run;
  check(run.executionMode==='live'&&run.collaboration.agents.length===4&&run.collaboration.agents.every(a=>a.status==='completed')&&run.collaboration.coordinatorStatus==='completed','live four children and coordinator complete');check(run.modelCallCount===9&&run.toolCallCount===8&&run.usageReported,'live usage and actual tools');
  const window=page.locator('.assistant-window');await window.locator('.assistant-trace-toggle').waitFor();if((await window.locator('.assistant-trace-toggle').getAttribute('aria-expanded'))!=='true')await window.locator('.assistant-trace-toggle').click();
  await snap('02-native-adoption-entry','.assistant-window');
  const first=await nativeResponse('/me/therapy-drafts','POST',()=>window.getByRole('button',{name:'采纳此方案',exact:true}).first().click());draft=first.data;adoptKey=first.key;adoptBody=first.body;evidence.adoption={draft,key:adoptKey,body:adoptBody};save();
  check(adoptKey.length<=120,'native adoption key is bounded');check(draft.reviewStatus==='pending_review'&&draft.version===1,'adoption saves pending version1');
  const replay=await nativeResponse('/me/therapy-drafts','POST',()=>window.getByRole('button',{name:'采纳此方案',exact:true}).first().click());check(replay.data.draftId===draft.draftId&&replay.data.deduplicated,'native repeated adoption has one draft');
  await call('guest','/me/therapy-drafts','POST',{...adoptBody,sessionId:'as_11111111-1111-4111-8111-111111111111'},409,adoptKey);
  await call('guest','/me/therapy-drafts','POST',{...adoptBody,sessionId:'as_11111111-1111-4111-8111-111111111111'},409,'stage3b-wrong-session');
  await call('guest','/me/therapy-drafts','POST',{...adoptBody,candidateId:'not-selected',selectedCandidateIds:['not-selected']},409,'stage3b-wrong-candidate');
  await call('otherGuest','/me/therapy-drafts','POST',adoptBody,403,'stage3b-other-guest');
  check((await call('guest','/reservations')).items.length===0,'pending draft has no reservations');
  await schedule();let card=page.locator(`[data-draft-id="${draft.draftId}"]`);await card.waitFor();
  const suggestions=card.locator('[data-testid="adopted-domain-suggestions"]');check((await suggestions.locator('[data-suggestion-domain]').evaluateAll(rows=>[...new Set(rows.map(r=>r.dataset.suggestionDomain))])).length===4,'guest sees all four persisted domains');
  await snap('03-pending-version1',`[data-draft-id="${draft.draftId}"] > header`);await snap('04-four-domains',`[data-draft-id="${draft.draftId}"] [data-testid="adopted-domain-suggestions"]`);
  for(const detail of await suggestions.locator('details').all())await detail.locator('summary').click();await snap('05-four-domain-sources',`[data-draft-id="${draft.draftId}"] [data-testid="adopted-domain-suggestions"]`);
  await suggestions.getByRole('button',{name:'打开陪伴资源',exact:true}).first().click();
  const companion=draft.evidence.selectedSuggestions.find(s=>s.domain==='psychology');await page.locator('.mood-player-dock').getByText(companion.title,{exact:true}).waitFor();
  check((await call('guest','/mood/resources')).some(resource=>resource.id===companion.details.resourceId),'persisted companion resource reads actual catalog');
  const audio=await page.request.get(new URL(companion.details.audioUrl,cfg.web).href);check(audio.ok()&&audio.headers()['content-type'].includes('audio'),'actual companion audio is readable');evidence.http.push({route:companion.details.audioUrl,method:'GET',status:audio.status()});await snap('05a-companion-player','.mood-player-dock');
  await page.reload();await schedule();await card.waitFor();await page.getByRole('button',{name:'退出登录',exact:true}).click();await login();await schedule();await card.waitFor();check((await card.innerText()).includes(runId),'pending draft survives refresh and relogin');
  evidence.adoption={draft,key:adoptKey,body:adoptBody};save();return {guestId,runId,sessionId,draftId:draft.draftId,version:draft.version};
}
async function review(){
  await call('guest',`/staff/therapy-drafts/${draft.draftId}/approve`,'POST',{version:1},403,'stage3b-guest-approve');
  await call('outsider',`/staff/therapy-drafts/${draft.draftId}`,'GET',undefined,403);
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('button',{name:/^我是工作人员/}).first().click();await page.getByLabel('账号',{exact:true}).fill('staff_demo');await page.getByLabel('密码',{exact:true}).fill('staff2026');await page.getByRole('button',{name:'进入工作区　→',exact:true}).click();await page.locator('.side-nav').waitFor();await page.locator('.side-nav').getByRole('button',{name:'疗程审核',exact:true}).click();
  await page.locator('.wellness-review-row').filter({hasText:draft.draftId}).click();await page.locator('.wellness-review-detail-head').waitFor();await snap('06-clinician-pending','.wellness-review-detail-head');
  const activity=draft.items.find(item=>item.type==='activity'&&item.candidateId==='stage2-indoor-exercise');check(Boolean(activity),'actual indoor exercise item exists');
  const sourceSlot=activity.sourceIds.filter(s=>s.type==='project_slot').at(-1).id;
  const options=await call('clinician',`/staff/therapy-drafts/${draft.draftId}/alternatives?itemId=${activity.id}`);
  const alternative=options.alternatives.find(row=>row.date===evidence.revisionDate&&row.projectName==='合成室内教练指导'&&row.slotId!==sourceSlot&&row.localStart==='09:00');check(Boolean(alternative),'actual non-overlapping revision alternative');
  const item=page.locator('.wellness-evidence-item').filter({hasText:activity.title}).first();await item.locator('select').selectOption(alternative.slotId);
  await page.locator('.wellness-review-actions textarea').first().fill('负责医护已核实合成完整资料，将室内运动移至后天避免与理疗重叠；保留四域同源建议和陪伴资源，不批准户外活动。');
  const revision=await nativeResponse(`/staff/therapy-drafts/${draft.draftId}/revisions`,'PUT',()=>page.getByRole('button',{name:'保存新待审版本',exact:true}).click());revised=revision.data;
  check(revised.version===2&&revised.supersedesDraftId===draft.draftId&&revised.reviewThreadId===draft.reviewThreadId,'clinical revision preserves v1 v2 thread/source chain');
  check((await call('guest',`/me/therapy-drafts/${draft.draftId}`)).reviewStatus==='superseded','old immutable version remains readable');
  await call('clinician',`/staff/therapy-drafts/${draft.draftId}/approve`,'POST',{version:1},409,'stage3b-obsolete-version');
  await call('clinician',`/staff/therapy-drafts/${revised.draftId}/approve`,'POST',{version:1},409,'stage3b-wrong-version');
  const therapy=revised.items.find(i=>i.type==='activity'&&i.candidateId==='project-sea-mud');check(Boolean(therapy),'actual indoor physio item exists');const closedItem=revised.items.find(i=>i.type==='activity'&&i.evidence.clinicianRevision);check(Boolean(closedItem),'later revised activity is available for atomic failure check');const slotId=closedItem.sourceIds.filter(s=>s.type==='project_slot').at(-1).id;
  await call('admin',`/admin/projects/stage2-indoor-exercise/slots/${slotId}`,'PATCH',{closed:true});await call('clinician',`/staff/therapy-drafts/${revised.draftId}/approve`,'POST',{version:2},409,'stage3b-atomic-approve');
  check((await call('guest','/reservations')).items.length===0,'later closed slot rolls back all earlier reservations');check((await call('guest',`/me/therapy-drafts/${revised.draftId}`)).reviewStatus==='pending_review','failed activation preserves pending state');
  await call('admin',`/admin/projects/stage2-indoor-exercise/slots/${slotId}`,'PATCH',{closed:false});
  await page.getByText(`VERSION 2 · ${revised.draftId}`,{exact:true}).waitFor();await snap('07-clinician-version2','.wellness-review-detail-head');
  const approval=await nativeResponse(`/staff/therapy-drafts/${revised.draftId}/approve`,'POST',()=>page.getByRole('button',{name:'修改后通过并激活',exact:true}).click());approvalKey=approval.key;revised=approval.data;
  check(revised.reviewStatus==='active'&&revised.reservations.length>=2,'normal clinical approval creates actual linked reservations');
  const replay=await call('clinician',`/staff/therapy-drafts/${revised.draftId}/approve`,'POST',{version:2},200,approvalKey);check(replay.replayed&&replay.reservations.length===revised.reservations.length,'approval replay does not consume capacity twice');
  await snap('08-clinician-approval');
  // Source replay captures the completed detail separately from the approval toast.
  await page.getByRole('tab',{name:/^已完成/}).click();
  await page.locator(`.wellness-review-row[data-draft-id="${revised.draftId}"]`).click();
  await page.locator('.wellness-review-detail-head').getByText('已激活',{exact:true}).waitFor();
  check((await page.locator('.wellness-review-detail-head').innerText()).includes(revised.draftId),'clinician completed detail shows the same active version');
  await snap('08a-clinician-active-detail','.wellness-review-detail-head');
  evidence.review={revised,revisionKey:revision.key,approvalKey};save();return {draftId:revised.draftId,version:revised.version,reservations:revised.reservations.length};
}
async function verify(){
  const run=await call('guest',`/assistant/runs/${runId}?role=guest`);check(run.modelCallCount===9&&run.toolCallCount===8,'adoption review activation do not run another model graph');
  const bookings=await call('guest','/reservations');check(bookings.items.length===revised.reservations.length,'guest reads same booking count');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await login();await schedule();const card=page.locator(`[data-draft-id="${revised.draftId}"]`);await card.waitFor();check((await card.innerText()).includes('医护已通过 · 已激活'),'guest actual active version2 card');
  check((await card.locator('[data-suggestion-domain]').evaluateAll(rows=>new Set(rows.map(r=>r.dataset.suggestionDomain)).size))===4,'active version retains all four domain suggestions');
  await snap('09-guest-active-version2',`[data-draft-id="${revised.draftId}"] > header`);await snap('10-guest-active-four-domains',`[data-draft-id="${revised.draftId}"] [data-testid="adopted-domain-suggestions"]`);
  const rows=page.locator('.reservation-row');for(const booking of bookings.items){check((await rows.filter({hasText:booking.id}).innerText()).includes(booking.projectName),'guest visible same booking id and actual project');}
  await snap('11-actual-bookings','.reservation-list-panel');await page.reload();await schedule();await card.waitFor();check((await call('guest',`/me/therapy-drafts/${revised.draftId}`)).sourceRunId===runId,'active refreshed source run unchanged');
  check(evidence.pageErrors.length===0,'no page errors');check(evidence.externalRequests.length===0,'no browser external requests');evidence.businessResult='PASS';save();return {guestId,runId,sessionId,draftId:revised.draftId,version:revised.version,modelCalls:run.modelCallCount,toolCalls:run.toolCallCount,usage:run.traceUsage,reservations:bookings.items.map(b=>b.id),businessResult:'PASS'};
}

let serial=1,closing=false;
try{while(!closing){const file=path.join(cfg.channel,`command-${serial}.json`);if(!fs.existsSync(file)){await sleep(75);continue}const cmd=JSON.parse(fs.readFileSync(file));let result;
  try{result=cmd.op==='prepare'?await prepare():cmd.op==='submit'?await submit():cmd.op==='observe'?await observe():cmd.op==='adopt'?await adopt():cmd.op==='review'?await review():cmd.op==='verify'?await verify():cmd.op==='close'?(closing=true,{closed:true}):(()=>{throw new Error('unsupported op')})();}
  catch(error){evidence.failure=error.message;save();await snap('failure-'+serial).catch(()=>{});fs.writeFileSync(path.join(cfg.out,'failure-visible.txt'),(await page.locator('body').innerText()).slice(-16000));result={error:error.message};}
  fs.writeFileSync(path.join(cfg.channel,`reply-${serial}.json`),JSON.stringify(result));serial++;
}}finally{save();await context.close()}
