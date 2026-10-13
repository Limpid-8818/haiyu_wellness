import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {ResourceSession,processIdentity} from '../resources/resource-runtime.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const flags=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>v.startsWith('--')?[...a,[v.slice(2),all[i+1]]]:a,[]));
const taskId=flags['task-id'];assert.equal(taskId,process.env.CODEX_TASK_ID);assert.match(taskId,/^[a-f0-9-]{36}$/);
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const out=path.resolve(flags.out);assert.ok(out.startsWith(root+'/output/'));assert.ok(!fs.existsSync(out));fs.mkdirSync(out,{recursive:true});
const apiPort=Number(flags['api-port']||58912),webPort=Number(flags['web-port']||58913);
const auditRoot=path.join(root,'output/resource-audit/bugfix-stage3b',taskId,'runtime');
const cloneParent='/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const clones=()=>fs.existsSync(cloneParent)?fs.readdirSync(cloneParent).filter(name=>name.startsWith('code_sign_clone.')).sort():[];
const receipt={taskId,root,out,apiPort,webPort,status:'RUNNING',syntheticClock:date+'T00:00:00.000Z',
  catalogFixture:'explicit stage2 synthetic indoor exercise; production catalog unchanged',owner:processIdentity(process.pid),clonesBefore:clones(),commands:[]};
const session=await ResourceSession.create({taskId,projectRoot:root,auditRoot,tempParent:'/tmp',limits:{leaseMs:900000,logBytes:8388608,directoryBytes:536870912}});
Object.assign(receipt,{instanceId:session.instanceId,registryPath:session.registryPath,tempDir:session.tempDir});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let channel,dbPath,browser,serial=0,closed=false;
const save=()=>fs.writeFileSync(path.join(out,'owner.json'),JSON.stringify(receipt,null,2));
async function browserOp(op){
  const id=++serial,file=path.join(channel,`command-${id}.json`),reply=path.join(channel,`reply-${id}.json`);
  fs.writeFileSync(file,JSON.stringify({op,id}));const until=Date.now()+30000;
  while(Date.now()<until&&!fs.existsSync(reply)){const status=await session.status();if(!['starting','running'].includes(status.resources.find(r=>r.id===browser.id)?.status))break;await sleep(100)}
  if(!fs.existsSync(reply))throw new Error('BROWSER_PHASE_NO_REPLY:'+op);
  const result=JSON.parse(fs.readFileSync(reply));if(result.error)throw new Error(result.error);return result;
}
async function prepare(){
  for(const port of [apiPort,webPort])await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve))});
  const data=await session.allocateDir('synthetic-sqlite');dbPath=path.join(data,'stage3b.sqlite');
  const init=await session.runProcess({label:'stage3b-demo-prerequisite',kind:'test',role:'test',command:process.execPath,args:['scripts/init-demo-team.js','--local-demo','--database',dbPath],cwd:root,env:{PATH:process.env.PATH,LLM_API_KEY:'',LLM_BASE_URL:''}},{timeoutMs:5000});assert.equal(init.exitCode,0);receipt.init={exitCode:init.exitCode};
  const env={PATH:process.env.PATH,DB_DRIVER:'sqlite',DB_PATH:dbPath,DEMO_SEED:'0',PORT:String(apiPort),LLM_TIMEOUT_MS:'60000',LLM_API_KEY:'',LLM_BASE_URL:'',LLM_MODEL:'',ENVIRONMENT_MODE:'unavailable',ENVIRONMENT_LIVE:'0',STAGE25_SCHEDULER_ENABLED:'0',AUTH_SECRET:'stage3b-synthetic-only',HAIYU_RESOURCE_MANAGED:'1',ASSISTANT_MAX_MODEL_CALLS:'50',ASSISTANT_MAX_TOOL_CALLS:'12',ASSISTANT_MAX_RUNTIME_MS:'90000',BUSINESS_CLOCK_NOW:date+'T00:00:00.000Z'};
  await session.startProcess({label:'stage3b-api',kind:'api',role:'api',command:process.execPath,args:['scripts/bugfix-stage3b/api.js'],cwd:root,env,port:apiPort,datadir:data});
  for(let i=0;i<80;i++){try{const r=await fetch(`http://127.0.0.1:${apiPort}/api/assistant/status`);if(r.ok){receipt.budget=await r.json();break}}catch{}await sleep(75)}assert.ok(receipt.budget);
  const cache=await session.allocateDir('vite-cache');await session.startProcess({label:'stage3b-vite',kind:'vite',role:'vite',command:process.execPath,args:[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],cwd:path.join(root,'web'),port:webPort,env:{PATH:process.env.PATH,HAIYU_RESOURCE_MANAGED:'1',HAIYU_VITE_CACHE_DIR:cache,WEB_PORT:String(webPort),API_PROXY_TARGET:`http://127.0.0.1:${apiPort}`}});
  for(let i=0;i<80;i++){try{if((await fetch(`http://127.0.0.1:${webPort}`)).ok)break}catch{}await sleep(75)}
  channel=await session.allocateDir('browser');const cfg=path.join(channel,'config.json');fs.writeFileSync(cfg,JSON.stringify({web:`http://127.0.0.1:${webPort}`,date,out,channel,profile:path.join(channel,'profile'),launchConfig:path.join(root,'scripts/resources/playwright-cli.config.json'),playwrightModule:flags['playwright-module']||'/Users/wangshanchong/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs'}));
  browser=await session.startProcess({label:'stage3b-browser',kind:'browser',role:'browser',command:process.execPath,args:['scripts/bugfix-stage3b/browser.js'],cwd:root,env:{PATH:process.env.PATH,STAGE3B_BROWSER_CONFIG:cfg}});
  return await browserOp('prepare');
}
async function verify(){
  const result=await browserOp('verify');const sql=new DatabaseSync(dbPath,{readOnly:true});const guestId=result.guestId,runId=result.runId;
  receipt.sql={runs:sql.prepare('SELECT id,session_id,parent_run_id,agent_id,status,input_tokens,output_tokens FROM agent_runs WHERE actor_id=?').all(guestId),
    tools:sql.prepare('SELECT t.run_id,t.tool_name,t.status FROM tool_executions t JOIN agent_runs r ON r.id=t.run_id WHERE r.id=? OR r.parent_run_id=?').all(runId,runId),
    drafts:sql.prepare('SELECT id,version,source_run_id,review_status,review_thread_id,supersedes_draft_id,evidence_json FROM wellness_drafts WHERE guest_id=? ORDER BY version').all(guestId),
    items:sql.prepare('SELECT i.id,i.draft_id,i.item_type,i.candidate_id,i.evidence_json,i.source_ids_json FROM wellness_draft_items i JOIN wellness_drafts d ON d.id=i.draft_id WHERE d.guest_id=?').all(guestId),
    reservations:sql.prepare('SELECT r.id,r.slot_id,r.wellness_draft_id,r.wellness_draft_item_id,r.status,s.project_id,s.business_date,s.local_start,s.local_end FROM reservations r JOIN activity_slots s ON s.id=r.slot_id WHERE guest_id=?').all(guestId),
    reviewEvents:sql.prepare('SELECT draft_id,review_thread_id,action,from_version,to_version,request_key FROM wellness_review_events WHERE guest_id=?').all(guestId),
    writes:Object.fromEntries(['meal_menus','meal_orders','medical_advice'].map(table=>[table,sql.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE guest_id=?`).get(guestId).count]))};sql.close();
  assert.equal(receipt.sql.runs.length,5);assert.ok(receipt.sql.runs.every(run=>run.session_id===result.sessionId));assert.equal(receipt.sql.runs.filter(run=>run.parent_run_id===runId).length,4);
  assert.equal(receipt.sql.drafts.length,2);assert.equal(receipt.sql.drafts[0].review_status,'superseded');assert.equal(receipt.sql.drafts[1].review_status,'active');
  assert.ok(receipt.sql.drafts.every(draft=>draft.source_run_id===runId&&JSON.parse(draft.evidence_json).domainAgents.length===4));
  assert.ok(receipt.sql.reservations.length>0&&receipt.sql.reservations.every(r=>r.wellness_draft_id===result.draftId));assert.equal(receipt.sql.reviewEvents.length,2);
  assert.ok(Object.values(receipt.sql.writes).every(n=>n===0));receipt.business=result;receipt.status=result.businessResult;return result;
}
async function close(){
  if(closed)return;closed=true;
  try{if(browser)await browserOp('close')}catch(error){receipt.browserCloseError=error.message}
  const state=await session.status();for(const r of [...state.resources].reverse())if(['starting','running'].includes(r.status)){await session.stop(r.id,'stage3b-complete');await session.waitProcess(r.id,3000)}
  receipt.cleanup=await session.close('stage3b-complete');receipt.tempRemoved=!fs.existsSync(session.tempDir);receipt.clonesAfter=clones();
  receipt.resourceResult=receipt.cleanup.ok&&receipt.tempRemoved&&JSON.stringify(receipt.clonesBefore)===JSON.stringify(receipt.clonesAfter)?'PASS':'FAIL';
  receipt.businessResult=receipt.business?.businessResult||'NOT_RUN';
  if(receipt.status==='RUNNING')receipt.status=receipt.businessResult;
  if(receipt.resourceResult!=='PASS')receipt.status='FAIL';save();
}
const lease=setTimeout(()=>void close().finally(()=>process.exit(1)),850000);
const input=readline.createInterface({input:process.stdin});
console.log('OWNER_READY');
for await(const line of input){
  let cmd;try{cmd=JSON.parse(line);assert.ok(['prepare','submit','observe','adopt','review','verify','close'].includes(cmd.op));const started=Date.now();
    const result=cmd.op==='prepare'?await prepare():cmd.op==='verify'?await verify():cmd.op==='close'?await close():await browserOp(cmd.op);
    receipt.commands.push({op:cmd.op,exitCode:0,durationMs:Date.now()-started});save();console.log('PHASE_RESULT '+JSON.stringify({op:cmd.op,ok:true,result}));
    if(cmd.op==='close')break;
  }catch(error){receipt.commands.push({op:cmd?.op,exitCode:1,error:error.message});receipt.status='FAIL';save();console.log('PHASE_RESULT '+JSON.stringify({op:cmd?.op,ok:false,error:error.message}));}
}
clearTimeout(lease);await close();input.close();console.log('OWNER_CLOSED');
