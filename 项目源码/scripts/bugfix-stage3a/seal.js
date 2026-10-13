import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {processMatches} from '../resources/resource-runtime.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const repo=path.dirname(root),taskId=process.argv[2];assert.equal(taskId,process.env.CODEX_TASK_ID);
const base=path.join(root,'output/resource-audit/bugfix-stage3a',taskId);
const read=file=>JSON.parse(fs.readFileSync(file));
const ref=file=>({path:file,bytes:fs.statSync(file).size,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
const audit=read(path.join(base,'runtime/final-scope02.json')),runner=read(path.join(base,'audit-final-runner.json'));
assert.equal(audit.status,'PASS');assert.equal(runner.status,'PASS');assert.equal(runner.resource.exitCode,0);assert.ok(runner.cleanup.ok&&runner.tempDirRemoved);
const selfEvents=fs.readFileSync(runner.registryPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.instanceId===runner.instanceId);
const owner=selfEvents.find(row=>row.event==='runner_started');
const guardian=selfEvents.find(row=>row.event==='guardian_started');
const guardianExit=selfEvents.find(row=>row.event==='guardian_pid_exited');assert.ok(guardianExit?.exitConfirmed);
const selfIdentities=[{pid:owner.ownerPid,startTime:owner.ownerStartTime,fingerprint:owner.ownerFingerprint},
  {pid:guardian.guardianPid,startTime:guardian.guardianStartTime,fingerprint:guardian.guardianFingerprint},...runner.resource.pids];
assert.ok(selfIdentities.every(identity=>!processMatches(identity.pid,identity)));
assert.ok(!fs.existsSync(audit.selfAuditSession.root)&&!fs.existsSync(audit.selfAuditSession.socket));
assert.ok(!fs.existsSync(path.join(root,'node_modules')),'own dependency link removed');
const attemptRoot=path.join(root,'output/playwright/bugfix-stage3a',taskId);
const attempts=['worker-real01-preflight02','worker-real02'].map(attempt=>{
  const dir=path.join(attemptRoot,attempt),browser=read(path.join(dir,'browser.json')),owner=read(path.join(dir,'owner.json')),exit=read(path.join(dir,'owner-exit.json'));
  assert.equal(owner.resourceResult,'PASS');assert.equal(exit.code,0);assert.ok(owner.sql.runs.every(run=>run.session_id===browser.run.sessionId));
  assert.equal(owner.sql.runs.filter(run=>run.parent_run_id===browser.run.runId).length,4);assert.ok(Object.values(owner.sql.writes).every(n=>n===0));
  return {attempt,businessResult:browser.businessResult,guestId:browser.guestId,runId:browser.run.runId,sessionId:browser.run.sessionId,
    homeState:browser.home.state,usage:browser.run.traceUsage,modelCalls:browser.run.modelCallCount,toolCalls:browser.run.toolCallCount,
    budget:browser.run.collaboration.graphBudget,httpCount:browser.http.length,assertions:browser.assertions.length,pngCount:browser.screenshots.length,
    references:[...['browser.json','owner.json','owner-exit.json','chrome.json','visible-reply.txt'].map(name=>ref(path.join(dir,name))),...browser.screenshots.map(file=>ref(file))]};
});
assert.equal(attempts[0].businessResult,'FAIL');assert.equal(attempts[1].businessResult,'PASS');assert.equal(attempts[1].modelCalls,9);assert.equal(attempts[1].toolCalls,8);assert.equal(attempts[1].usage.usageReported,true);
const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
const changed=[...new Set([...git(['diff','--name-only']).trim().split('\n'),...git(['ls-files','--others','--exclude-standard']).trim().split('\n')].filter(Boolean))];
const files=changed.map(file=>({...ref(path.join(repo,file)),relativePath:file,category:/^(AGENTS.md|docs\/BUG修复分阶段|docs\/当前开发交接|docs\/阶段3智能体|wangshanchong\/第69轮)/.test(file)?'inherited-source-coordination':file.endsWith('.md')?'candidate-documentation':'candidate-product-or-verification'}));
const tests=read(path.join(base,'tests-final02.json')),build=read(path.join(base,'build-final.json')),secret=read(path.join(base,'secret-check.json'));
for(const result of [tests,build,secret])assert.equal(result.status,'PASS');
const packet={status:'PASS_CANDIDATE_SOURCE_PENDING',workerTaskId:taskId,sourceTaskId:'01a0cbfe-a161-72d0-992d-12fad655d4ef',worktree:repo,
  head:git(['rev-parse','HEAD']).trim(),branch:git(['rev-parse','--abbrev-ref','HEAD']).trim(),scope:['F04','F06','R01','U05'],sourceIndependentResult:'NOT_RUN',overall:'NOT_FINAL_ACCEPTED',
  inherited:'stage1/2 merged and pushed on d19d590; old FAIL/history exception/109 not fully accepted; V01/3B/4-6 not run',
  files,gitStatus:git(['status','--short']),gitDiffStat:git(['diff','--stat']),gitWrites:0,attempts,
  tests:{exitCode:tests.resource.exitCode,count:40,regressionStage1And2:18,reference:ref(path.join(base,'tests-final02.json'))},
  build:{exitCode:build.resource.exitCode,reference:ref(path.join(base,'build-final.json'))},
  publicBudget:{modelCalls:50,tokens:16384,toolCalls:12,maxRunMs:90000,mainEnvModified:false,
    originalExplicit:JSON.parse(read(path.join(base,'public-budget02.json')).resource.tail),mainStatusAfterMerge:'SOURCE_MUST_VERIFY'},
  resource:{status:'PASS',instanceCount:audit.instanceCount,includesAuditSelf:true,exitGaps:audit.historicalGaps,
    liveIdentities:audit.currentResourceProcessIdentities.length,temp:audit.remainingRegisteredTempRoots.length,sockets:audit.remainingRegisteredSocketPaths.length,
    deletedOpen:audit.deletedOpenTaskPaths.length,portListeners:audit.registeredPortListeners.length,structuralErrors:audit.structuralErrors.length,
    auditSelf:{status:'PASS',runnerExit:runner.resource.exitCode,exactIdentitiesAbsent:selfIdentities.length,guardianExitConfirmed:true,tempRemoved:true,socketRemoved:true},
    references:[ref(path.join(base,'runtime/final-scope02.json')),ref(path.join(base,'audit-final-runner.json'))],dependencyLinkRemoved:true},
  secretCheck:{status:'PASS',...JSON.parse(secret.resource.tail),reference:ref(path.join(base,'secret-check.json'))},
  preservedFailures:[ref(path.join(base,'build-fail01.json')),ref(path.join(attemptRoot,'worker-real01/browser.json')),ref(path.join(attemptRoot,'worker-real01/owner.json'))],
  sourceReplay:ref(path.join(root,'scripts/bugfix-stage3a/README.md')),report:ref(path.join(repo,'wangshanchong/第70轮报告.md'))};
const target=path.join(base,'worker-final-packet.json');fs.writeFileSync(target,JSON.stringify(packet,null,2),{flag:'wx'});
console.log(JSON.stringify({status:packet.status,packet:ref(target),resources:packet.resource.instanceCount,tests:40,realAttempts:2,sourcePending:true}));
