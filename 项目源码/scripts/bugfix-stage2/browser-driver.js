import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { processIdentity } from '../resources/resource-runtime.js';
import { prepareJourney, finishJourney } from './browser-flow.js';
const cfg=JSON.parse(fs.readFileSync(process.env.STAGE2_BROWSER_CONFIG));
assert.ok(cfg.profile.startsWith('/tmp/haiyu-resource-'));
const {chromium}=await import(pathToFileURL(cfg.playwrightModule).href);
const launch=JSON.parse(fs.readFileSync(cfg.launchConfig)).browser.launchOptions;
const context=await chromium.launchPersistentContext(cfg.profile,{...launch,viewport:{width:1440,height:900}});
const evidence={assertions:[],http:[],screenshots:[],pageErrors:[],externalRequests:[]};
const page=context.pages()[0]||await context.newPage();page.setDefaultTimeout(5000);
page.on('pageerror',err=>evidence.pageErrors.push(err.message));page.on('dialog',dialog=>dialog.accept());
try {
  const all=spawnSync('ps',['-axo','pid=,comm='],{encoding:'utf8',timeout:5000,maxBuffer:131072});assert.equal(all.status,0);
  const identities=all.stdout.split('\n').filter(row=>/\/Google Chrome$/.test(row)).map(row=>{
    const pid=Number(row.trim().split(/\s/)[0]);const identity=processIdentity(pid);
    const command=spawnSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:2000,maxBuffer:131072}).stdout.trim();
    return identity?{...identity,command}:null;
  }).filter(row=>row?.command.includes(`--user-data-dir=${cfg.profile}`));
  assert.equal(identities.length,1);assert.ok(identities[0].command.includes(launch.args.find(arg=>arg.startsWith('--disable-features='))));
  fs.writeFileSync(path.join(cfg.out,'browser-identity.json'),JSON.stringify(identities[0],null,2));
  await context.route('**/*',route=>{
    const url=new URL(route.request().url());if(['127.0.0.1','localhost'].includes(url.hostname)||['data:','blob:'].includes(url.protocol))return route.continue();
    evidence.externalRequests.push(url.origin);return route.abort();
  });
  await page.goto(cfg.web);
  const state=await prepareJourney(page,cfg,evidence);
  fs.writeFileSync(path.join(cfg.out,'preparation.json'),JSON.stringify(evidence,null,2));
  fs.writeFileSync(cfg.prepared,JSON.stringify({ready:true,objects:evidence.objects}));
  const until=Date.now()+8000;
  while(!fs.existsSync(cfg.continueMarker)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(fs.existsSync(cfg.continueMarker),'owner must restart isolated API at service completion time');
  await finishJourney(page,cfg,evidence,state);
  fs.writeFileSync(path.join(cfg.out,'browser-result.json'),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({status:'PASS',assertions:evidence.assertions.length,http:evidence.http.length,png:evidence.screenshots.length}));
} catch(error) {
  fs.writeFileSync(path.join(cfg.out,'partial-result.json'),JSON.stringify(evidence,null,2));
  await page.screenshot({path:path.join(cfg.out,'failure.png')}).catch(()=>{});
  fs.writeFileSync(path.join(cfg.out,'failure-visible.txt'),(await page.locator('body').innerText().catch(()=>'')).slice(-16000));
  throw error;
} finally {await context.close();}
