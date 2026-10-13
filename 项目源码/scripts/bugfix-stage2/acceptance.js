import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {ResourceSession,processIdentity,processMatches} from '../resources/resource-runtime.js';
import {isCleanApiStop} from './stop-contract.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const flags=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>v.startsWith('--')?[...a,[v.slice(2),all[i+1]]]:a,[]));
const taskId=flags['task-id'];assert.ok(/^[a-f0-9-]{36}$/.test(taskId));assert.equal(process.env.CODEX_TASK_ID,taskId);
const apiPort=Number(flags['api-port']||58904),webPort=Number(flags['web-port']||58905);
const out=path.resolve(flags.out||path.join(root,'output/playwright',`stage2-${taskId}`));
assert.ok(out.startsWith(path.join(root,'output')+path.sep));assert.ok(!fs.existsSync(out),'unique attempt only');fs.mkdirSync(out,{recursive:true});
const auditRoot=path.resolve(flags['audit-root']||path.join(root,'output/resource-audit/bugfix-stage2',taskId,'runtime'));
const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}).format(new Date());
const clonesPath='/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const clones=()=>fs.existsSync(clonesPath)?fs.readdirSync(clonesPath).filter(name=>name.startsWith('code_sign_clone.')).sort():[];
const protectedIds=()=>[7081,67464].map(pid=>processIdentity(pid));
const receipt={taskId,root,date,apiPort,webPort,out,status:'RUNNING',clonesBefore:clones(),protectedBefore:protectedIds()};
for(const port of [apiPort,webPort])await new Promise((resolve,reject)=>{const s=net.createServer();s.on('error',reject);s.listen(port,'127.0.0.1',()=>s.close(resolve))});
const session=await ResourceSession.create({taskId,projectRoot:root,auditRoot,tempParent:'/tmp',limits:{leaseMs:900000,logBytes:8388608,directoryBytes:536870912}});
receipt.instanceId=session.instanceId;receipt.registryPath=session.registryPath;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));let failure;
try {
  const dataDir=await session.allocateDir('synthetic-sqlite');const database=path.join(dataDir,'team.sqlite');
  const runInit=()=>session.runProcess({label:'stage2-explicit-demo-initialization',kind:'test',role:'test',command:process.execPath,args:['scripts/init-demo-team.js','--local-demo','--database',database],cwd:root,
    env:{PATH:process.env.PATH,LLM_API_KEY:'',LLM_BASE_URL:'',ENVIRONMENT_LIVE:'0',BUSINESS_CLOCK_NOW:date+'T00:00:00.000Z'}},{timeoutMs:5000});
  const initial=await runInit();assert.equal(initial.exitCode,0,initial.tail);receipt.initialization=JSON.parse(initial.tail.split('\n').find(line=>line.startsWith('{')));
  let sql=new DatabaseSync(database,{readOnly:true});const clinician=sql.prepare("SELECT password_hash,job_type FROM users WHERE id='staff_001'").get();sql.close();
  const replay=await runInit();assert.equal(replay.exitCode,0,replay.tail);receipt.repeatedInitialization=JSON.parse(replay.tail.split('\n').find(line=>line.startsWith('{')));
  sql=new DatabaseSync(database,{readOnly:true});assert.deepEqual(sql.prepare("SELECT password_hash,job_type FROM users WHERE id='staff_001'").get(),clinician);assert.equal(sql.prepare('SELECT COUNT(*) AS count FROM users').get().count,7);sql.close();
  assert.equal(receipt.initialization.created,4);assert.equal(receipt.repeatedInitialization.created,0);
  const existing=path.join(dataDir,'synthetic-existing.sqlite');fs.writeFileSync(existing,'synthetic existing file, must remain byte-identical');
  const before=crypto.createHash('sha256').update(fs.readFileSync(existing)).digest('hex');
  const refused=await session.runProcess({label:'stage2-reject-existing-database',kind:'test',role:'test',command:process.execPath,args:['scripts/init-demo-team.js','--local-demo','--database',existing],cwd:root},{timeoutMs:5000});
  assert.equal(refused.exitCode,1);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(existing)).digest('hex'),before);
  receipt.existingDatabaseRefusedWithoutWrite=true;
  async function startApi(clock,first){
    const result=await session.startProcess({label:'stage2-api-'+(first?'booking':'execution'),kind:'api',role:'api',command:process.execPath,args:[path.join(root,'scripts/bugfix-stage2/api.js')],cwd:root,port:apiPort,datadir:dataDir,
      env:{PATH:process.env.PATH,DB_DRIVER:'sqlite',DB_PATH:database,DEMO_SEED:'0',PORT:String(apiPort),LLM_API_KEY:'',LLM_BASE_URL:'',LLM_MODEL:'',ENVIRONMENT_MODE:'unavailable',ENVIRONMENT_LIVE:'0',AUTH_SECRET:'stage2-synthetic-only',BUSINESS_CLOCK_NOW:clock,STAGE2_CATALOG_FIXTURE:first?'1':'0'}});
    for(let index=0;index<80;index++){const log=await session.rpc({op:'log-tail',id:result.id,maxBytes:4096});if(log.tail.includes('STAGE2_READY'))return result;await sleep(50)}
    throw new Error('API readiness failed');
  }
  const api=await startApi(date+'T00:00:00.000Z',true);
  const cache=await session.allocateDir('vite-cache');
  await session.startProcess({label:'stage2-vite',kind:'vite',role:'vite',command:process.execPath,args:[path.join(root,'node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port',String(webPort),'--strictPort'],cwd:path.join(root,'web'),port:webPort,
    env:{PATH:process.env.PATH,HAIYU_RESOURCE_MANAGED:'1',HAIYU_VITE_CACHE_DIR:cache,API_PROXY_TARGET:`http://127.0.0.1:${apiPort}`,WEB_PORT:String(webPort)}});
  let webReady=false;for(let index=0;index<80;index++){try{if((await fetch(`http://127.0.0.1:${webPort}`)).ok){webReady=true;break}}catch{}await sleep(50)}assert.ok(webReady);
  const browserDir=await session.allocateDir('browser');const prepared=path.join(browserDir,'prepared.json'),continueMarker=path.join(browserDir,'continue.json');
  const config=path.join(browserDir,'config.json');fs.writeFileSync(config,JSON.stringify({web:`http://127.0.0.1:${webPort}`,date,out,prepared,continueMarker,profile:path.join(browserDir,'profile'),launchConfig:path.join(root,'scripts/resources/playwright-cli.config.json'),playwrightModule:flags['playwright-module']||'/Users/wangshanchong/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs'}));
  const browser=await session.startProcess({label:'stage2-browser',kind:'browser',role:'browser',command:process.execPath,args:[path.join(root,'scripts/bugfix-stage2/browser-driver.js')],cwd:root,env:{PATH:process.env.PATH,STAGE2_BROWSER_CONFIG:config}});
  const deadline=Date.now()+12000;while(!fs.existsSync(prepared)&&Date.now()<deadline){const state=await session.status();if(!['running','starting'].includes(state.resources.find(row=>row.id===browser.id)?.status))break;await sleep(50)}
  if(!fs.existsSync(prepared)){const log=await session.rpc({op:'log-tail',id:browser.id,maxBytes:8192});throw new Error('booking phase failed: '+log.tail)}
  receipt.prepared=JSON.parse(fs.readFileSync(prepared));
  await session.stop(api.id,'synthetic-clock-progression');const stopped=await session.waitProcess(api.id,3000);assert.ok(isCleanApiStop(stopped),'API must have terminal state, exit0 and every exact PID exit');
  await startApi(date+'T09:00:00.000Z',false);fs.writeFileSync(continueMarker,'{}');
  const result=await session.waitProcess(browser.id,22000);receipt.browserExit={status:result.status,exitCode:result.exitCode,signal:result.signal};
  if(result.exitCode!==0){const log=await session.rpc({op:'log-tail',id:browser.id,maxBytes:8192});throw new Error('execution phase failed: '+log.tail)}
  receipt.business=JSON.parse(fs.readFileSync(path.join(out,'browser-result.json')));receipt.chrome=JSON.parse(fs.readFileSync(path.join(out,'browser-identity.json')));
  assert.equal(processMatches(receipt.chrome.pid,receipt.chrome),false);
  sql=new DatabaseSync(database,{readOnly:true});const guestId=receipt.business.objects.guestId;
  receipt.sql={executions:sql.prepare('SELECT * FROM service_executions').all(),assignments:sql.prepare('SELECT staff_id,status FROM staff_guest_assignments WHERE guest_id=?').all(guestId),orders:sql.prepare('SELECT id,status FROM meal_orders WHERE guest_id=?').all(guestId),feedback:sql.prepare('SELECT id,reservation_id,revision FROM wellness_feedback WHERE guest_id=?').all(guestId),serviceLogs:sql.prepare("SELECT actor_id,target_id,COUNT(*) AS count FROM audit_logs WHERE action='service.execution.record' GROUP BY actor_id,target_id").all()};
  assert.deepEqual(sql.prepare("SELECT password_hash,job_type FROM users WHERE id='staff_001'").get(),clinician);sql.close();
  assert.equal(receipt.sql.executions.length,3);assert.equal(receipt.sql.assignments.length,5);assert.equal(receipt.sql.orders[0].status,'delivered');assert.equal(receipt.sql.feedback.length,2);assert.ok(receipt.sql.serviceLogs.every(row=>row.count===1));
}catch(error){failure=error;receipt.error=error.stack||error.message}
finally{
  try{const state=await session.status();for(const row of [...state.resources].reverse())if(['starting','running'].includes(row.status)){await session.stop(row.id,'stage2-finish');await session.waitProcess(row.id,3000)}receipt.cleanup=await session.close('stage2-complete');receipt.tempRemoved=!fs.existsSync(session.tempDir);assert.equal(receipt.cleanup.ok,true);assert.equal(receipt.tempRemoved,true);receipt.clonesAfter=clones();receipt.protectedAfter=protectedIds();assert.deepEqual(receipt.clonesAfter,receipt.clonesBefore);assert.deepEqual(receipt.protectedAfter.map(row=>row?.fingerprint),receipt.protectedBefore.map(row=>row?.fingerprint));receipt.resourceResult='PASS'}
  catch(error){failure ||= error;receipt.resourceResult='FAIL';receipt.cleanupError=error.stack||error.message}
  receipt.status=failure?'FAIL':'PASS';fs.writeFileSync(path.join(out,'business.json'),JSON.stringify(receipt,null,2));
}
console.log(JSON.stringify({status:receipt.status,resourceResult:receipt.resourceResult,evidence:path.join(out,'business.json'),assertions:receipt.business?.assertions.length||0,error:receipt.error||receipt.cleanupError||null}));if(failure)process.exitCode=1;
