import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRegisteredQuest, terminalQuestsForRange } from '../quest-registry.js';
import { runStage27R2BaseBrowserAcceptance } from '../resources/stage27-r2-base-browser-acceptance.js';

const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const workspaceRoot=path.resolve(projectRoot,'..');
const producerTaskId='01a1249a-b40b-7773-972f-9dc732c007a8';
const outputRoot=path.join(projectRoot,'output/resource-audit');
let taskId='';
let evidencePath='';
let ledgerState=null;
let activeRunId='';
const rtmPath=path.join(workspaceRoot,'docs/RTM当前实现映射.md');
const contractPath=path.join(workspaceRoot,'docs/API运行契约.md');
const workbookSnapshotPath=path.join(outputRoot,'stage27-r2-'+producerTaskId+'-workbook-source-20261010.json');
const bt=String.fromCharCode(96);

function requireTask(){
  const actual=String(process.env.CODEX_TASK_ID||'').trim();
  assert.match(actual,/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    'R2 requires the actual nonempty Codex task ID');
  assert.equal(process.env.CODEX_STAGE27_SCOPE,'R2','R2 scope must be explicitly selected');
  taskId=actual;
  evidencePath=path.join(outputRoot,'stage27-r2-'+taskId+'-execution-evidence-20261010.jsonl');
  ledgerState=scanEvidenceLedger(evidencePath);
  return taskId;
}
function digest(data){return crypto.createHash('sha256').update(data).digest('hex');}
function digestFile(file){
  const fd=fs.openSync(file,'r');const hash=crypto.createHash('sha256');const buffer=Buffer.allocUnsafe(64*1024);
  try{let bytesRead=0;while((bytesRead=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,bytesRead));}
  finally{fs.closeSync(fd);}
  return hash.digest('hex');
}
function readJson(file,limit=16*1024*1024){const s=fs.statSync(file);assert.ok(s.size<=limit,path.basename(file)+' under read limit');return JSON.parse(fs.readFileSync(file,'utf8'));}
function scanEvidenceLedger(file){
  const exists=fs.existsSync(file);const initialSize=exists?fs.statSync(file).size:0;
  assert.ok(initialSize<=8*1024*1024,'task evidence ledger remains under 8 MiB');
  const records=[];const hash=crypto.createHash('sha256');let bytesReadTotal=0;let lineNumber=0;let lineStart=0;let carry=Buffer.alloc(0);
  if(exists){
    const fd=fs.openSync(file,'r');const chunk=Buffer.allocUnsafe(16*1024);
    try{
      let count=0;
      while((count=fs.readSync(fd,chunk,0,chunk.length,null))>0){
        const input=carry.length?Buffer.concat([carry,chunk.subarray(0,count)]):chunk.subarray(0,count);
        let cursor=0;let newline=-1;
        while((newline=input.indexOf(0x0a,cursor))>=0){
          const row=input.subarray(cursor,newline);assert.ok(row.length<=64*1024,'task ledger line remains under 64 KiB');
          const fullLine=input.subarray(cursor,newline+1);hash.update(fullLine);lineNumber+=1;
          const record=JSON.parse(row.toString('utf8'));const byteOffsetEnd=lineStart+fullLine.length;
          records.push({lineNumber,byteOffsetStart:lineStart,byteOffsetEnd,eventSha256:digest(row),
            prefixBytes:byteOffsetEnd,prefixSha256:hash.copy().digest('hex'),record});
          lineStart=byteOffsetEnd;cursor=newline+1;
        }
        carry=Buffer.from(input.subarray(cursor));bytesReadTotal+=count;
        assert.ok(carry.length<=64*1024,'task ledger trailing line remains under 64 KiB');
      }
    }finally{fs.closeSync(fd);}
  }
  assert.equal(bytesReadTotal,initialSize,'task ledger size stayed stable while reading');
  assert.equal(carry.length,0,'append-only JSONL ledger ends on a complete newline');
  return{path:file,bytes:initialSize,lineCount:lineNumber,hash,records,wholeSha256:hash.copy().digest('hex')};
}
function ledger(){
  if(!ledgerState||ledgerState.path!==evidencePath)return scanEvidenceLedger(evidencePath);
  const size=fs.existsSync(evidencePath)?fs.statSync(evidencePath).size:0;
  if(size!==ledgerState.bytes)ledgerState=scanEvidenceLedger(evidencePath);
  return ledgerState;
}
function nextAttempt(event){
  const attempts=ledger().records.filter(item=>item.record?.taskId===taskId&&item.record?.event===event)
    .map(item=>Number(item.record.attempt)).filter(Number.isSafeInteger);
  return Math.max(0,...attempts)+1;
}
function newRunId(){return new Date().toISOString().replace(/[-:.]/gu,'')+'-'+crypto.randomBytes(6).toString('hex');}
function appendEvidence(entry){
  fs.mkdirSync(outputRoot,{recursive:true,mode:0o700});
  const state=ledger();const line=JSON.stringify({at:new Date().toISOString(),taskId,worktree:workspaceRoot,...entry})+'\n';
  const bytes=Buffer.from(line,'utf8');assert.ok(bytes.length<=64*1024,'evidence JSONL line under 64 KiB');
  assert.ok(state.bytes+bytes.length<=8*1024*1024,'evidence ledger under 8 MiB');
  const fd=fs.openSync(evidencePath,'a',0o600);
  try{let offset=0;while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset);}
  finally{fs.closeSync(fd);}
  const recordBytes=bytes.subarray(0,bytes.length-1);const prefixHash=state.hash.copy();prefixHash.update(bytes);
  state.hash.update(bytes);const byteOffsetStart=state.bytes;state.bytes+=bytes.length;state.lineCount+=1;
  const record=JSON.parse(recordBytes.toString('utf8'));const reference={path:path.relative(workspaceRoot,evidencePath),
    taskId,lineNumber:state.lineCount,byteOffsetStart,byteOffsetEnd:state.bytes,event:entry.event||null,
    eventSha256:digest(recordBytes),prefixBytes:state.bytes,prefixSha256:prefixHash.digest('hex')};
  state.records.push({...reference,record});state.wholeSha256=state.hash.copy().digest('hex');
  return reference;
}
function validateLedgerReferences(references){
  const fresh=scanEvidenceLedger(evidencePath);const byLine=new Map(fresh.records.map(item=>[item.lineNumber,item]));
  const checked=references.map(reference=>{
    const actual=byLine.get(reference.lineNumber);assert.ok(actual,'referenced JSONL line exists');
    assert.equal(actual.byteOffsetStart,reference.byteOffsetStart,'referenced start byte matches');
    assert.equal(actual.byteOffsetEnd,reference.byteOffsetEnd,'referenced end byte matches');
    assert.equal(actual.eventSha256,reference.eventSha256,'referenced event digest matches exact JSON bytes');
    assert.equal(actual.prefixBytes,reference.prefixBytes,'referenced ledger prefix length matches');
    assert.equal(actual.prefixSha256,reference.prefixSha256,'referenced ledger prefix digest matches');
    assert.equal(actual.record.taskId,reference.taskId,'referenced event task identity matches');
    assert.equal(actual.record.event,reference.event,'referenced event type matches');
    return{lineNumber:reference.lineNumber,byteOffsetStart:reference.byteOffsetStart,byteOffsetEnd:reference.byteOffsetEnd,
      event:reference.event,eventSha256:reference.eventSha256,prefixBytes:reference.prefixBytes,prefixSha256:reference.prefixSha256};
  });
  ledgerState=fresh;
  return{status:'PASS',checkedAt:new Date().toISOString(),ledgerPath:path.relative(workspaceRoot,evidencePath),
    ledgerBytes:fresh.bytes,ledgerLineCount:fresh.lineCount,ledgerSha256:fresh.wholeSha256,
    validatedReferenceCount:checked.length,references:checked};
}
function sourceFingerprints(){
  return ['QuestMap.md','项目源码/package.json','项目源码/server/src/app.js','项目源码/web/src/main.jsx','docs/API运行契约.md']
    .map(relative=>{const bytes=fs.readFileSync(path.join(workspaceRoot,relative));return{path:relative,bytes:bytes.length,sha256:digest(bytes)};});
}
function readBoundedText(file,limit=2*1024*1024){
  const stat=fs.statSync(file);assert.ok(stat.size<=limit,path.basename(file)+' under static-check read limit');
  return fs.readFileSync(file,'utf8');
}
function supplementalAcceptanceAssertions(commands){
  const modelCardPath=path.join(workspaceRoot,'docs/模型接入卡.md');
  const readmePath=path.join(workspaceRoot,'README.md');
  const envExamplePath=path.join(projectRoot,'.env.example');
  const packagePath=path.join(projectRoot,'package.json');
  const modelCard=readBoundedText(modelCardPath);const readme=readBoundedText(readmePath);
  const envExample=readBoundedText(envExamplePath);const packageJson=readJson(packagePath,2*1024*1024);
  const docsEvidence=[modelCardPath,readmePath,envExamplePath].map(file=>({path:path.relative(workspaceRoot,file),
    bytes:fs.statSync(file).size,sha256:digestFile(file)}));
  const requiredModelTerms={officialReference:/https:\/\/developers\.openai\.com\/api\/reference/iu.test(modelCard),
    configurationNames:['LLM_BASE_URL','LLM_API_KEY','LLM_MODEL'].every(term=>modelCard.includes(term)),
    successResponse:modelCard.includes('choices[0].message.content')&&modelCard.includes('入住咨询可以先了解房型'),
    failureAndTimeout:/非 2xx/u.test(modelCard)&&/超时/u.test(modelCard)&&modelCard.includes('安全引导模式'),
    noRecognizedSecretLiteral:!/(?:sk-[A-Za-z0-9_-]{20,}|Bearer\s+[A-Za-z0-9_-]{32,})/u.test(modelCard)};
  const modelCardPassed=Object.values(requiredModelTerms).every(Boolean);
  const q710={questId:'Q7.10',result:modelCardPassed?'PASS':'FAIL',action:'read the current model integration card and safe example configuration',
    expected:'official API references, server-side variable names, response shape, timeout/failure rules, and no real key',
    actual:{...requiredModelTerms,realModelRequestMade:false,environmentFileRead:false},evidence:docsEvidence};
  const q85DocsPresent=readme.includes('npm ci --ignore-scripts')&&readme.includes('npm run dev')
    &&['dev','test','build'].every(name=>typeof packageJson.scripts?.[name]==='string')
    &&envExample.includes('PORT=')&&envExample.includes('WEB_PORT=');
  const q85={questId:'Q8.5',result:q85DocsPresent?'R5_PENDING':'FAIL',action:'inspect documented local setup and example configuration without clean-installing dependencies',
    expected:'README and package scripts describe a reproducible setup; clean install and four-role run remain for R5',
    actual:{readmeHasCleanInstall:readme.includes('npm ci --ignore-scripts'),readmeHasDevCommand:readme.includes('npm run dev'),
      localScripts:{dev:typeof packageJson.scripts?.dev==='string',test:typeof packageJson.scripts?.test==='string',build:typeof packageJson.scripts?.build==='string'},
      exampleHasApiAndWebPorts:envExample.includes('PORT=')&&envExample.includes('WEB_PORT='),
      cleanInstallExecuted:false,devServerStandaloneRun:false,reason:'R2 keeps the existing dependency installation and does not start a second development-server flow.'},evidence:docsEvidence};
  const npmTest=commands.find(item=>item.label==='stage27-r2-npm-test');
  const q86={questId:'Q8.6',result:npmTest?.commandPassed?'PARTIAL':'FAIL',action:'run the repository-local automated test command',
    expected:'npm test exits zero with no failing test; GitHub Actions CI is reported separately as out of local scope',
    actual:{commandPassed:npmTest?.commandPassed===true,exitCode:npmTest?.exitCode??null,testSummary:npmTest?.testSummary||null,
      githubActions:'OUT_OF_SCOPE; not invoked from this local task'},evidence:[]};
  const build=commands.find(item=>item.label==='stage27-r2-npm-build');
  const distPath=path.join(projectRoot,'web/dist/index.html');const distExists=fs.existsSync(distPath)&&fs.statSync(distPath).isFile();
  const q87={questId:'Q8.7',result:build?.commandPassed&&distExists?'PARTIAL':'FAIL',action:'build the local frontend and inspect the generated entry point',
    expected:'npm run build succeeds and web/dist/index.html exists; preview-server interaction remains unrun in R2',
    actual:{buildPassed:build?.commandPassed===true,exitCode:build?.exitCode??null,distIndexExists:distExists,
      previewServerStarted:false,reason:'R2 includes the managed Vite development browser flow and build command; no separate preview server was started.'},
    evidence:distExists?[{path:path.relative(workspaceRoot,distPath),bytes:fs.statSync(distPath).size,sha256:digestFile(distPath)}]:[]};
  const q88={questId:'Q8.8',result:'R5_PENDING',action:'record the four-scene end-to-end demonstration boundary',
    expected:'a full public, guest, staff, and dean demonstration is completed only in the later R5 scope',
    actual:{fullFourSceneDemonstration:false,completedRoleSlices:['public','guest','staff','dean'],
      modelAndEnvironmentProvidersNotCalled:true,status:'PENDING_R5'},evidence:[{path:'docs/阶段27R2执行与验收计划_20261010.md',
      sha256:digestFile(path.join(workspaceRoot,'docs/阶段27R2执行与验收计划_20261010.md'))}]};
  return[q710,q85,q86,q87,q88];
}
function parseQuestMap(){
  const file=path.join(workspaceRoot,'QuestMap.md');const stat=fs.statSync(file);
  assert.ok(stat.size<=2*1024*1024,'QuestMap under 2 MiB');
  const lines=fs.readFileSync(file,'utf8').split(/\r?\n/u);const h=/^#{3}\s+.*?Quest\s+(\d+\.\d+)\s*[：:]\s*(.*)$/u;const quests=[];
  for(let i=0;i<lines.length;i+=1){
    const m=lines[i].match(h);if(!m||Number(m[1].split('.')[0])>8)continue;
    let end=i+1;while(end<lines.length&&!h.test(lines[end]))end+=1;
    const body=lines.slice(i+1,end);
    const expectedAction=body.filter(line=>/^\s*-\s+\[[ xX]\]\s+/u.test(line))
      .map(line=>line.replace(/^\s*-\s+\[[ xX]\]\s+/u,'').replace(/\*\*/gu,'').trim());
    const objective=body.find(line=>/^\s*-\s+\*\*🎯 关卡目标\*\*/u.test(line))||'';
    quests.push({id:'Q'+m[1],title:m[2].replace(/\*\*/gu,'').trim(),expectedAction,
      objective:objective.replace(/^\s*-\s+\*\*🎯 关卡目标\*\*：?/u,'').trim(),questMapLine:i+1});
  }
  const ids=quests.map(item=>item.id);
  assert.equal(quests.length,68);assert.equal(new Set(ids).size,ids.length);
  return{path:'QuestMap.md',sha256:digestFile(file),bytes:stat.size,quests};
}
async function runManaged(resourceSession,label,args){
  const start=Date.now();
  const r=await resourceSession.runProcess({label,kind:'test',role:'acceptance-command',command:'npm',args,cwd:projectRoot,
    env:{PATH:process.env.PATH||'/usr/bin:/bin',TZ:'UTC',CODEX_TASK_ID:taskId,CODEX_STAGE27_SCOPE:'R2',npm_config_offline:'true'},
    leaseMs:15*60*1000},{timeoutMs:15*60*1000});
  const result={label,command:['npm',...args],status:r.status,exitCode:r.exitCode??null,signal:r.signal||null,
    timedOut:r.timedOut===true,pid:r.pid,processStartTime:r.processStartTime,processFingerprint:r.processFingerprint,
    resourceId:r.id,logPath:r.logPath,logBytes:r.logBytes??null,directoryPeakBytes:r.directoryPeakBytes??null,
    maxLogBytes:r.maxLogBytes,maxDirectoryBytes:r.maxDirectoryBytes,pids:r.pids||[],
    allTrackedPidsExited:r.pids?.every(item=>item.exitConfirmed===true)===true,
    outputTail:String(r.tail||'').slice(-12*1024),elapsedMs:Date.now()-start};
  result.commandPassed=result.status==='exited'&&result.exitCode===0&&!result.signal&&!result.timedOut&&result.allTrackedPidsExited;
  return result;
}
function historicalEvidence(questId){
  const reportRoot=path.join(workspaceRoot,'wangshanchong');
  const names=fs.readdirSync(reportRoot).filter(name=>/^第\d+轮报告\.md$/u.test(name)).sort();
  const pattern=new RegExp('(?<![A-Za-z0-9])'+questId.replace('.','\\.')+'(?![A-Za-z0-9])','u');
  for(const name of names){
    const file=path.join(reportRoot,name);const text=fs.readFileSync(file,'utf8');const lines=text.split(/\r?\n/u);const found=[];
    for(let i=0;i<lines.length;i+=1){
      const line=lines[i];
      if(pattern.test(line)&&(/^\s*\|/u.test(line)||/退出码|PASS|FAIL|BLOCKED|HTTP|实测|实际/u.test(line)))
        found.push({line:i+1,text:line.trim().slice(0,1800)});
    }
    if(!found.length)continue;
    const taskPattern=new RegExp('Luna task(?:\\/thread)? ID[^\\n]*'+bt+'([0-9a-f-]{36})'+bt,'iu');
    return{report:path.relative(workspaceRoot,file),reportSha256:digestFile(file),
      date:(text.match(/^日期：([^\r\n]+)/mu)||[])[1]||null,
      executorTaskId:(text.match(taskPattern)||[])[1]||null,lines:found.slice(0,4)};
  }
  return null;
}
function exclusiveArtifact(file,text){
  fs.writeFileSync(file,text,{encoding:'utf8',mode:0o600,flag:'wx'});
  const stat=fs.statSync(file);assert.ok(stat.size<=8*1024*1024,path.basename(file)+' under 8 MiB');
  return{path:path.relative(workspaceRoot,file),bytes:stat.size,sha256:digestFile(file)};
}
function csvCell(value){const text=Array.isArray(value)?JSON.stringify(value):String(value??'');return'"'+text.replace(/"/gu,'""')+'"';}

export async function runStage27R2QuestMap({resourceSession}){
  requireTask();assert.ok(resourceSession,'Q27.1 requires ResourceSession');
  const q271Attempt=nextAttempt('q271-attempt-started');activeRunId=newRunId();
  const previousAttempts=ledger().records.filter(item=>item.record?.taskId===taskId&&item.record?.event==='q271-attempt-started')
    .map(item=>({attempt:item.record.attempt,runId:item.record.runId,startedAt:item.record.at}));
  const ledgerReferences=[appendEvidence({event:'q271-attempt-started',attempt:q271Attempt,runId:activeRunId})];
  const questMap=parseQuestMap();const terminalIds=terminalQuestsForRange(1,8);
  assert.equal(terminalIds.length,29);const mapIds=new Set(questMap.quests.map(q=>q.id));
  for(const id of terminalIds)assert.ok(mapIds.has(id),id+' is mapped in QuestMap');
  const commands=[];
  for(const [label,args] of [
    ['stage27-r2-npm-ls-workspaces',['ls','--workspaces','--depth=0']],
    ['stage27-r2-npm-test',['test']],
    ['stage27-r2-npm-build',['run','build']]
  ]){
    try{
      const result=await runManaged(resourceSession,label,args);
      if(label.includes('npm-ls')){
        result.serverWorkspaceVisible=/server@/u.test(result.outputTail)&&/\bserver\b/u.test(result.outputTail);
        result.webWorkspaceVisible=/web@/u.test(result.outputTail)&&/\bweb\b/u.test(result.outputTail);
        result.commandPassed=result.commandPassed&&result.serverWorkspaceVisible&&result.webWorkspaceVisible;
      }
      if(label.includes('npm-test')){
        const metric=name=>{const m=result.outputTail.match(new RegExp('# '+name+'\\s+(\\d+)','u'));return m?Number(m[1]):null;};
        result.testSummary={tests:metric('tests'),suites:metric('suites'),passed:metric('pass'),
          failed:metric('fail'),skipped:metric('skipped'),cancelled:metric('cancelled')};
        result.commandPassed=result.commandPassed&&result.testSummary.tests!==null&&result.testSummary.passed!==null
          &&result.testSummary.failed===0&&result.testSummary.cancelled===0;
      }
      if(label.includes('npm-build'))result.buildOutputConfirmed=/built in/u.test(result.outputTail);
      commands.push(result);appendEvidence({event:'managed-base-command',...result});
    }catch(error){
      const result={label,command:['npm',...args],commandPassed:false,error:String(error?.message||error).slice(0,4000),receipt:error?.receipt||null};
      commands.push(result);appendEvidence({event:'managed-base-command-error',...result});
    }
  }
  const terminalRows=[];const terminalLines=new Map();
  for(const questId of terminalIds){
    const executedAt=new Date().toISOString();const start=Date.now();let row;
    try{
      const result=await runRegisteredQuest(questId,{resourceSession});
      assert.ok(result&&Array.isArray(result.output),questId+' returned actual terminal output');
      const output=result.output.map(value=>String(value));
      row={questId,status:'CURRENT_PASS',executedAt,elapsedMs:Date.now()-start,exitCode:0,
        actualOutput:output,actualOutputSha256:digest(Buffer.from(output.join('\n'))),actualOutcome:output};
    }catch(error){
      row={questId,status:error?.stageBlocked?'BLOCKED':'FAIL',executedAt,elapsedMs:Date.now()-start,exitCode:null,
        actualOutcome:String(error?.message||error).slice(0,4000),errorType:String(error?.name||'Error')};
    }
    terminalRows.push(row);const reference=appendEvidence({event:'registered-terminal-quest',attempt:q271Attempt,runId:activeRunId,...row});
    terminalLines.set(questId,reference);ledgerReferences.push(reference);
  }
  let browserBundle=null;
  try{
    const result=await runStage27R2BaseBrowserAcceptance({resourceSession,attempt:q271Attempt,runId:activeRunId});
    const absolutePath=path.resolve(projectRoot,result.evidencePath);const evidence=readJson(absolutePath);
    assert.equal(evidence.taskId,taskId);assert.equal(evidence.status,'PASS');assert.equal(evidence.screenshots.length,6);
    browserBundle={evidence,absolutePath,relativePath:path.relative(workspaceRoot,absolutePath)};
  }catch(error){
    ledgerReferences.push(appendEvidence({event:'base-browser-acceptance-error',error:String(error?.stack||error?.message||error).slice(-6000),
      attempt:q271Attempt,runId:activeRunId}));
  }
  const fingerprints=sourceFingerprints();const browserAssertions=(browserBundle?.evidence.assertions||[])
    .map((item,index)=>({...item,source:'browser',browserAssertionIndex:index}));
  const supplementalAssertions=supplementalAcceptanceAssertions(commands).map(item=>{
    const ledgerReference=appendEvidence({event:'supplemental-acceptance-assertion',attempt:q271Attempt,runId:activeRunId,...item});
    ledgerReferences.push(ledgerReference);return{...item,source:'static',ledgerReference};
  });
  const assertions=[...browserAssertions,...supplementalAssertions];
  const terminalById=new Map(terminalRows.map(item=>[item.questId,item]));
  const itemRows=questMap.quests.map(quest=>{
    const terminal=terminalById.get(quest.id);
    const current=assertions.filter(item=>item.questId===quest.id);
    if(terminal||current.length){
      const resultStatus=terminal&&terminal.status!=='CURRENT_PASS'?terminal.status:
        current.some(item=>item.result==='FAIL')?'FAIL':
          current.some(item=>item.result==='R5_PENDING')?'R5_PENDING':
            current.some(item=>item.result==='UNVERIFIED')?'UNVERIFIED':
              current.some(item=>item.result==='PARTIAL')?'CURRENT_PARTIAL':
                terminal||current.every(item=>item.result==='PASS')?'CURRENT_PASS':'UNVERIFIED';
      const old=historicalEvidence(quest.id);
      const evidence=[];
      if(terminal)evidence.push({...terminalLines.get(quest.id),kind:'current-terminal-output'});
      if(current.some(item=>item.source==='browser')&&browserBundle)evidence.push({path:browserBundle.relativePath,
        sha256:digestFile(browserBundle.absolutePath),kind:'current-browser-assertions',
        assertionIndexes:current.filter(item=>item.source==='browser').map(item=>item.browserAssertionIndex)});
      for(const item of current.filter(assertion=>assertion.source==='static'))evidence.push({...item.ledgerReference,
        kind:'current-static-acceptance-assertion',result:item.result,sourceEvidence:item.evidence});
      return{...quest,resultStatus,actualOutcome:{terminal:terminal?.actualOutcome||null,
        currentAssertions:current.map(item=>({action:item.action,expected:item.expected,actual:item.actual,result:item.result}))},
        actor:current.some(item=>item.source==='browser')?'当前R2隔离SQLite浏览器，由实际Codex任务控制；进程由ResourceSession登记':
          current.some(item=>item.source==='static')?'当前R2受管本地命令与只读文档核查':'当前R2受管Quest注册运行器',
        executedAt:browserBundle?.evidence.startedAt||new Date().toISOString(),
        evidence,historicalEvidence:old,currentSourceFingerprints:fingerprints};
    }
    const old=historicalEvidence(quest.id);
    if(old){
      const reportedPass=old.lines.some(item=>/\bPASS\b|通过|均为 HTTP 200/u.test(item.text));
      return{...quest,resultStatus:reportedPass?'HISTORICAL_REPORTED_PASS':'HISTORICAL_RESULT_UNCLEAR',
        actualOutcome:old.lines,actor:'历史Luna App task；保留原报告自述，不作为本轮独立复验',
        executedAt:old.date,executorTaskId:old.executorTaskId,
        evidence:old.lines.map(item=>({path:old.report,line:item.line,reportSha256:old.reportSha256,kind:'historical-executor-report-line'})),
        applicability:'历史报告只证明该报告时点/工作树；当前源码指纹另列，R2不声称历史运行使用当前源码。',
        historicalEvidence:old,currentSourceFingerprints:fingerprints};
    }
    return{...quest,resultStatus:'UNVERIFIED',
      actualOutcome:'未找到当前逐项断言或包含本Quest编号的历史结果行；明确保留为未验收。',
      actor:'当前R2映射核对',executedAt:new Date().toISOString(),evidence:[],currentSourceFingerprints:fingerprints};
  });
  const commandGate=commands.every(item=>item.commandPassed===true)
    &&commands.find(item=>item.label.includes('npm-build'))?.buildOutputConfirmed===true;
  const terminalFailures=terminalRows.filter(item=>item.status!=='CURRENT_PASS');
  const browserPassed=browserBundle?.evidence.status==='PASS';
  const counts=Object.fromEntries([...new Set(itemRows.map(item=>item.resultStatus))]
    .map(value=>[value,itemRows.filter(item=>item.resultStatus===value).length]));
  const mappingQuality=itemRows.every(item=>item.expectedAction?.length>0&&item.actor&&item.resultStatus
    &&Array.isArray(item.evidence)&&item.currentSourceFingerprints?.length
    &&(item.evidence.length>0||item.resultStatus==='UNVERIFIED'||item.resultStatus==='HISTORICAL_RESULT_UNCLEAR'));
  const browserNetworkPolicy=browserPassed?{
    externalRequestsAborted:browserBundle.evidence.externalRequests.every(item=>item.action==='aborted-before-network'),
    intentionalUnauthorizedObserved:browserBundle.evidence.httpErrors.some(item=>item.status===401&&item.path==='/api/auth/login'),
    onlyDocumentedExpectedHttpErrors:browserBundle.evidence.httpErrors.every(item=>(item.status===401&&item.path==='/api/auth/login')
      ||(item.status===400&&item.path==='/api/me/password')
      ||(item.status===503&&item.path==='/api/staff/guests')),
    noUnexpectedHttpErrors:Array.isArray(browserBundle.evidence.unexpectedHttpErrors)&&browserBundle.evidence.unexpectedHttpErrors.length===0,
    noUnexpectedNetworkFailures:Array.isArray(browserBundle.evidence.unexpectedNetworkFailures)&&browserBundle.evidence.unexpectedNetworkFailures.length===0,
    noUnexpectedConsoleErrors:Array.isArray(browserBundle.evidence.unexpectedConsoleErrors)&&browserBundle.evidence.unexpectedConsoleErrors.length===0
  }:{externalRequestsAborted:false,intentionalUnauthorizedObserved:false,onlyDocumentedExpectedHttpErrors:false,
    noUnexpectedHttpErrors:false,noUnexpectedNetworkFailures:false,noUnexpectedConsoleErrors:false};
  const browserAssertionsClean=browserPassed&&browserBundle.evidence.assertions.length>=20
    &&browserBundle.evidence.pageErrors.length===0&&Object.values(browserNetworkPolicy).every(Boolean);
  const supplementalGate=supplementalAssertions.every(item=>item.result!=='FAIL');
  const status=commandGate&&terminalFailures.length===0&&browserAssertionsClean&&mappingQuality&&supplementalGate?'PASS':'FAIL';
  const test=commands.find(item=>item.label.includes('npm-test'));const build=commands.find(item=>item.label.includes('npm-build'));
  const npmLs=commands.find(item=>item.label.includes('npm-ls'));
  const csv=[['questId','title','expectedAction','resultStatus','actualOutcome','actor','executedAt','executorTaskId','evidence','questMapLine','currentSourceFingerprints','applicability']
    .map(csvCell).join(','),...itemRows.map(item=>[item.id,item.title,item.expectedAction,item.resultStatus,item.actualOutcome,
      item.actor,item.executedAt,item.executorTaskId||'',item.evidence,item.questMapLine,item.currentSourceFingerprints,item.applicability||'']
      .map(csvCell).join(','))].join('\n')+'\n';
  const ledgerReferenceValidation=validateLedgerReferences(ledgerReferences);
  const jsonPath=path.join(outputRoot,'stage27-r2-'+taskId+'-'+activeRunId+'-q271-base-68-evidence-20261010.json');
  const csvPath=path.join(outputRoot,'stage27-r2-'+taskId+'-'+activeRunId+'-q271-base-68-evidence-20261010.csv');
  const csvArtifact=exclusiveArtifact(csvPath,csv);
  const summary={recordType:'stage27-r2-q271-base-questmap-evidence',taskId,createdAt:new Date().toISOString(),status,
    attempt:q271Attempt,runId:activeRunId,priorAttempts:previousAttempts,
    scope:'Q27.1 only; Stage1–8; 68 QuestMap items',questMap:{path:questMap.path,sha256:questMap.sha256,bytes:questMap.bytes},
    terminalQuestIds:terminalIds,terminalQuestCount:terminalRows.length,terminalPassCount:terminalRows.length-terminalFailures.length,
    terminalFailures,commands,browser:browserBundle?{status:'PASS',path:browserBundle.relativePath,
      sha256:digestFile(browserBundle.absolutePath),assertions:browserAssertions,screenshotCount:browserBundle.evidence.screenshots.length,
      screenshots:browserBundle.evidence.screenshots,consoleErrors:browserBundle.evidence.consoleErrors,
      unexpectedConsoleErrors:browserBundle.evidence.unexpectedConsoleErrors,
      externalRequests:browserBundle.evidence.externalRequests,httpErrors:browserBundle.evidence.httpErrors,
      networkPolicy:browserNetworkPolicy}:{status:'FAIL_OR_BLOCKED'},supplementalAcceptanceAssertions:supplementalAssertions,
    questMapRows:itemRows,resultStatusCounts:counts,
    mappingQuality:mappingQuality?'PASS':'FAIL',ledgerReferenceValidation,
    productAcceptance:'NOT_FINAL_ACCEPTED; Q27.1 reconciles evidence and does not accept all Stage27 or all 109 requirements.',
    artifacts:{executionEvidence:path.relative(workspaceRoot,evidencePath),csv:csvArtifact.path,browser:browserBundle?.relativePath||null}};
  const jsonArtifact=exclusiveArtifact(jsonPath,JSON.stringify(summary,null,2)+'\n');
  const summaryLine=appendEvidence({event:'q271-summary',attempt:q271Attempt,runId:activeRunId,status,jsonPath:jsonArtifact.path,csvPath:csvArtifact.path,
    jsonSha256:jsonArtifact.sha256,resultStatusCounts:counts,commandGate,terminalPassCount:summary.terminalPassCount,
    browserStatus:summary.browser.status,testSummary:test?.testSummary||null,buildExitCode:build?.exitCode??null,npmLsExitCode:npmLs?.exitCode??null});
  assert.equal(readJson(jsonPath).questMapRows.length,68);
  if(status!=='PASS')throw new Error('Q27.1 base regression failed; inspect '+jsonArtifact.path);
  return{output:[
    'Q27.1 PASS: all 68 QuestMap IDs have current, historical, or explicitly pending/unverified mapped results.',
    'npm ls '+npmLs?.commandPassed+'; npm test '+test?.commandPassed+' '+JSON.stringify(test?.testSummary||null)
      +'; build '+build?.commandPassed+' (exit '+build?.exitCode+').',
    'Registered terminal cases: '+summary.terminalPassCount+'/'+terminalRows.length+'; browser screenshots: '+summary.browser.screenshotCount+'.',
    'Per-item states: '+JSON.stringify(counts)+'; product acceptance remains NOT_FINAL_ACCEPTED.',
    'Evidence: '+jsonArtifact.path+'; '+csvArtifact.path+'; '+summary.browser.path+'; JSONL line '+summaryLine.lineNumber+'.'
  ]};
}

function markdownTable(lines,heading,headerPrefix){
  const title=lines.findIndex(line=>line.startsWith(heading));
  assert.ok(title>=0,'table heading exists: '+heading);
  const header=lines.findIndex((line,index)=>index>title&&line.startsWith(headerPrefix));
  assert.ok(header>=0,'table header exists: '+heading);
  const rows=[];
  for(let i=header+2;i<lines.length&&lines[i].startsWith('|');i+=1)
    rows.push({line:i+1,cells:lines[i].trim().replace(/^\|/u,'').replace(/\|$/u,'').split('|').map(cell=>cell.trim())});
  return rows;
}

function currentContract(){
  const lines=fs.readFileSync(contractPath,'utf8').split(/\r?\n/u);const rows=[];
  for(let i=0;i<lines.length;i+=1){
    const m=lines[i].match(new RegExp('^\\|\\s*(\\d+)\\s*\\|\\s*'+bt+'(GET|POST|PUT|PATCH|DELETE)\\s+([^'+bt+']+)'+bt+'\\s*\\|'));
    if(m)rows.push({id:Number(m[1]),method:m[2],path:m[3].split('?')[0],line:i+1});
  }
  return rows;
}

function currentApiMap(){
  const lines=fs.readFileSync(rtmPath,'utf8').split(/\r?\n/u);
  return markdownTable(lines,'## 当前 API 路由与 RTM 邻接关系','| API |').map(row=>{
    assert.equal(row.cells.length,5,'API map row has five columns');
    const route=row.cells[1].match(new RegExp(bt+'(GET|POST|PUT|PATCH|DELETE)\\s+([^'+bt+']+)'+bt));
    const source=row.cells[2].replaceAll(bt,'').match(/^(.*):(\d+)$/u);
    return{line:row.line,id:Number(row.cells[0].slice(1)),method:route?.[1]||null,path:route?.[2]||null,
      source:source?.[1]||null,sourceLine:source?Number(source[2]):null,testEvidence:row.cells[4]};
  });
}

function currentRequirements(){
  const lines=fs.readFileSync(rtmPath,'utf8').split(/\r?\n/u);
  return markdownTable(lines,'## RTM 1–109 逐项映射','| ID |').map(row=>{
    assert.equal(row.cells.length,7,'RTM row has seven columns');
    return{line:row.line,id:Number(row.cells[0]),mappingTitle:row.cells[1],originalName:row.cells[2],
      originalRequirement:row.cells[3],currentStatus:row.cells[4],currentEvidence:row.cells[5],plannedQuests:row.cells[6]};
  });
}

function routeAnchor(pathname){
  const suffix=pathname.startsWith('/api/')?pathname.slice(4):pathname;
  const escaped=suffix.replace(/[.*+?^$()|[\]\\]/gu,'\\$&').replace(/:[A-Za-z][A-Za-z0-9_]*/gu,'[^/]+');
  return new RegExp(escaped+'(?![A-Za-z0-9_-])','u');
}

export async function runStage27R2Rtm(){
  requireTask();
  const q279Attempt=nextAttempt('q279-attempt-started');activeRunId=newRunId();
  const previousAttempts=ledger().records.filter(item=>item.record?.taskId===taskId&&item.record?.event==='q279-attempt-started')
    .map(item=>({attempt:item.record.attempt,runId:item.record.runId,startedAt:item.record.at}));
  const q279StartRef=appendEvidence({event:'q279-attempt-started',attempt:q279Attempt,runId:activeRunId});
  const snapshot=readJson(workbookSnapshotPath);
  assert.equal(snapshot.taskId,producerTaskId,'workbook snapshot retains its original producer identity');
  const workbookPath=path.join(workspaceRoot,snapshot.sourcePath);
  assert.equal(digestFile(workbookPath),snapshot.sourceSha256,'original workbook still matches the source snapshot');
  const requirements=currentRequirements();
  assert.equal(requirements.length,109);
  assert.deepEqual(requirements.map(item=>item.id),Array.from({length:109},(_,i)=>i+1),
    'RTM IDs 1–109 are complete without duplicates');
  assert.equal(snapshot.rows.length,109);
  const originalById=new Map(snapshot.rows.map(row=>[row.id,row]));
  const routes=currentApiMap();const contract=currentContract();
  assert.equal(routes.length,123);assert.equal(contract.length,123);
  assert.deepEqual(routes.map(row=>row.id),contract.map(row=>row.id),'API row IDs follow the current contract');
  const contractById=new Map(contract.map(row=>[row.id,row]));
  let directlyReferenced=0;let noDirectAssertion=0;
  for(const route of routes){
    const expected=contractById.get(route.id);
    assert.ok(expected&&route.method===expected.method&&route.path===expected.path,
      'API method and path match the current contract at A'+route.id);
    const sourceRoutePath=route.path.startsWith('/api/')?route.path.slice(4):route.path;
    const sourceLines=fs.readFileSync(path.join(workspaceRoot,route.source),'utf8').split(/\r?\n/u);
    assert.ok(route.sourceLine>0&&route.sourceLine<=sourceLines.length,'current app source line exists');
    assert.ok(sourceLines[route.sourceLine-1].includes('routes.'+route.method.toLowerCase()+'(')
      &&sourceLines[route.sourceLine-1].includes(sourceRoutePath),'current app source line matches API-prefix-stripped route');
    if(route.testEvidence.startsWith('未在当前 server/test')){
      noDirectAssertion+=1;continue;
    }
    const refs=[...route.testEvidence.matchAll(/(项目源码\/server\/test\/[^:；|]+):(\d+)/gu)];
    assert.ok(refs.length,'API test evidence has real test source line references or explicit absence');
    for(const ref of refs){
      const testLines=fs.readFileSync(path.join(workspaceRoot,ref[1]),'utf8').split(/\r?\n/u);
      const number=Number(ref[2]);
      assert.ok(number>0&&number<=testLines.length,'test reference line exists');
      assert.ok(routeAnchor(route.path).test(testLines[number-1]),
        'test reference line contains the route path for A'+route.id);
    }
    directlyReferenced+=1;
  }
  const currentApiIds=new Set(routes.map(item=>item.id));
  const functionCounts={IMPLEMENTED:0,PARTIAL:0,UNIMPLEMENTED:0,UNVERIFIED:0,EXTERNAL_BLOCK:0,OUT_OF_SCOPE:0};
  const acceptanceCounts={UNVERIFIED:0,EXTERNAL_BLOCK:0};
  const rows=requirements.map(item=>{
    const original=originalById.get(item.id);assert.ok(original,'original workbook row exists');
    assert.equal(item.originalName,original.originalName,'original RTM name is preserved');
    assert.equal(item.originalRequirement,original.originalRequirement,'full original requirement is preserved');
    assert.ok(item.currentStatus&&item.currentEvidence,'current implementation state and evidence exist');
    const apiIds=[...new Set([...item.currentEvidence.matchAll(/\bA(\d{1,3})\b/gu)].map(match=>Number(match[1])))];
    for(const id of apiIds)assert.ok(currentApiIds.has(id),'RTM API reference A'+id+' resolves');
    const functionState=item.currentStatus.startsWith('已实现')?'IMPLEMENTED'
      :item.currentStatus.startsWith('部分覆盖')?'PARTIAL'
        :item.currentStatus.startsWith('未实现')?'UNIMPLEMENTED':'UNVERIFIED';
    functionCounts[functionState]+=1;
    const environmentRequirement=/天气|潮汐|海况|海浪|浪高|环境服务/u.test(item.originalRequirement);
    const explicitExternalGap=/(?:未配置|未连接).{0,40}(?:机构)?(?:地点|坐标|站点|凭证|天气|潮汐|海况|实时)|(?:真实|机构)?(?:地点|坐标|站点|凭证).{0,40}未配置|(?:不能作为|不能用于).{0,24}(?:真实|实测|安全)|演示快照[^。；]{0,30}未连接/iu.test(item.currentEvidence);
    const blocked=environmentRequirement&&explicitExternalGap;
    const acceptanceState=blocked?'EXTERNAL_BLOCK':'UNVERIFIED';
    acceptanceCounts[acceptanceState]+=1;
    const qRefs=[...new Set([...item.currentEvidence.matchAll(/\bQ27\.\d+\b/gu)].map(match=>match[0]))];
    return{id:item.id,mappingTitle:item.mappingTitle,originalRequirementName:item.originalName,
      originalRequirement:item.originalRequirement,currentState:item.currentStatus,functionState,acceptanceState,
      acceptanceStateEvidence:blocked?'The original requirement depends on live weather/tide/marine conditions, while the current evidence explicitly records an unconfigured institution location, station, or live connection. This remains externally blocked, not feature-failed.':'The current implementation is mapped, but this item has no Stage27 final acceptance evidence in R2.',
      currentEvidence:item.currentEvidence,currentApiIds:apiIds.map(id=>'A'+String(id).padStart(2,'0')),
      plannedQuests:item.plannedQuests,currentStage27References:qRefs.map(questId=>({questId,
        status:questId==='Q27.1'?'R2_EXECUTED':questId==='Q27.9'?'R2_MAPPING_ONLY':'NOT_EXECUTED_IN_R2',
        note:'R3–R5 and other Stage27 functions are outside the authorized R2 task.'})),
      mappingSource:{path:'docs/RTM当前实现映射.md',line:item.line,sha256:digestFile(rtmPath)},
      originalSource:{path:snapshot.sourcePath,sheet:snapshot.sheet,row:original.workbookRow,sha256:snapshot.sourceSha256}};
  });
  const mappingQuality={status:'PASS',requirementCount:109,idsComplete:true,
    originalNamesAndFullTextMatchWorkbook:true,apiMapCount:123,contractAndAppMethodPathLineReferencesMatch:true,
    routesWithDirectCurrentTestPathReferences:directlyReferenced,
    routesExplicitlyMarkedWithoutDirectRequestAssertion:noDirectAssertion,
    note:'Lack of a direct current request assertion is called out explicitly and is not counted as test coverage.'};
  const productAcceptance={overall:'NOT_FINAL_ACCEPTED',functionStateCounts:functionCounts,
    acceptanceStateCounts:acceptanceCounts,
    note:'RTM mapping quality is independent of feature acceptance. R3–R5 and full Stage27 acceptance were not run.'};
  const csvHeader=['id','mappingTitle','originalRequirementName','originalRequirement','currentState','functionState',
    'acceptanceState','acceptanceStateEvidence','currentApiIds','currentEvidence','plannedQuests','currentStage27References','mappingSource'];
  const csv=[csvHeader.map(csvCell).join(','),...rows.map(row=>[row.id,row.mappingTitle,row.originalRequirementName,
    row.originalRequirement,row.currentState,row.functionState,row.acceptanceState,row.acceptanceStateEvidence,row.currentApiIds,row.currentEvidence,
    row.plannedQuests,row.currentStage27References,row.mappingSource].map(csvCell).join(','))].join('\n')+'\n';
  const ledgerReferenceValidation=validateLedgerReferences([q279StartRef]);
  const csvPath=path.join(outputRoot,'stage27-r2-'+taskId+'-'+activeRunId+'-q279-rtm-mapping-20261010.csv');
  const jsonPath=path.join(outputRoot,'stage27-r2-'+taskId+'-'+activeRunId+'-q279-rtm-mapping-20261010.json');
  const csvArtifact=exclusiveArtifact(csvPath,csv);
  const summary={recordType:'stage27-r2-q279-rtm-mapping-evidence',taskId,producerTaskId:snapshot.taskId,consumerTaskId:taskId,
    generatedAt:new Date().toISOString(),attempt:q279Attempt,runId:activeRunId,priorAttempts:previousAttempts,
    executionLedgerReference:q279StartRef,ledgerReferenceValidation,
    status:'PASS',mappingQuality,productAcceptance,rows,
    sourceSnapshots:{workbook:{path:snapshot.sourcePath,producerTaskId:snapshot.taskId,consumerTaskId:taskId,
        sourceBytes:snapshot.sourceBytes,sha256:snapshot.sourceSha256},
      rtm:{path:path.relative(workspaceRoot,rtmPath),sha256:digestFile(rtmPath)},
      apiContract:{path:path.relative(workspaceRoot,contractPath),sha256:digestFile(contractPath)},
      appSource:{path:'项目源码/server/src/app.js',sha256:digestFile(path.join(projectRoot,'server/src/app.js'))}},
    artifactCsv:csvArtifact.path};
  const jsonArtifact=exclusiveArtifact(jsonPath,JSON.stringify(summary,null,2)+'\n');
  appendEvidence({event:'q279-summary',status:'PASS',attempt:q279Attempt,runId:activeRunId,mappingQuality,productAcceptance,
    jsonPath:jsonArtifact.path,csvPath:csvArtifact.path,jsonSha256:jsonArtifact.sha256,csvSha256:csvArtifact.sha256});
  return{output:[
    'Q27.9 PASS: all 109 original IDs/names/full text are preserved, and all 123 API routes match current contract and source lines.',
    'Mapping quality PASS; direct test references '+directlyReferenced+'; explicitly no direct current assertion '+noDirectAssertion+'.',
    'Function states '+JSON.stringify(functionCounts)+'; acceptance states '+JSON.stringify(acceptanceCounts)+'.',
    'Product acceptance remains NOT_FINAL_ACCEPTED; matrix completeness does not mean 109 functions pass.',
    'Evidence: '+jsonArtifact.path+'; '+csvArtifact.path+'.'
  ]};
}
