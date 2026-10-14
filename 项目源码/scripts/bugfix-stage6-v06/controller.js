import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {fileURLToPath} from 'node:url';
import {callerContract} from './contract.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function createController({taskId,attempt,date,apiPort=58924,webPort=58925,mode,purpose='full',captureMethod='isolated_dom'}){
  assert.match(taskId,/^[a-f0-9-]{36}$/);assert.match(attempt,/^[a-z0-9-]+$/);assert.match(date,/^\d{4}-\d{2}-\d{2}$/);
  callerContract(taskId,attempt,apiPort,webPort,mode,purpose);assert.ok(['diagnostic_resize','isolated_dom'].includes(captureMethod));if(purpose==='full')assert.equal(captureMethod,'isolated_dom');const out=path.join(root,'output/playwright/bugfix-stage6',taskId,attempt);assert.ok(!fs.existsSync(out));
  const node=execFileSync('/usr/bin/which',['node'],{encoding:'utf8',timeout:5000}).trim(),publicPath=execFileSync('/usr/bin/printenv',['PATH'],{encoding:'utf8',timeout:5000}).trim();
  const child=spawn(node,['scripts/bugfix-stage6-v06/owner.js','--task-id',taskId,'--out',out,'--date',date,'--api-port',String(apiPort),'--web-port',String(webPort),'--mode',mode,'--purpose',purpose,'--capture-method',captureMethod],{cwd:root,env:{PATH:publicPath,CODEX_TASK_ID:taskId},stdio:['pipe','pipe','pipe']});
  const state={pid:child.pid,out,ready:false,buffer:'',replies:[],exit:null,stdoutBytes:0,stderrBytes:0};
  child.stdout.on('data',chunk=>{state.stdoutBytes+=chunk.length;if(state.stdoutBytes>8388608)child.kill('SIGTERM');state.buffer+=chunk.toString();const lines=state.buffer.split('\n');state.buffer=lines.pop();for(const line of lines){if(line==='OWNER_READY')state.ready=true;if(line.startsWith('PHASE_RESULT '))state.replies.push(JSON.parse(line.slice(13)))}});
  child.stderr.on('data',chunk=>{state.stderrBytes+=chunk.length;if(state.stderrBytes>8388608)child.kill('SIGTERM')});
  child.on('exit',(code,signal)=>{state.exit={pid:child.pid,code,signal,observedAt:new Date().toISOString(),method:'child-process-exit-event'};if(fs.existsSync(out))fs.writeFileSync(path.join(out,'owner-exit.json'),JSON.stringify(state.exit,null,2))});
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));const ready=Date.now()+5000;while(!state.ready&&!state.exit&&Date.now()<ready)await sleep(50);assert.ok(state.ready);
  return {state,async command(op){assert.match(op,/^[A-Za-z]+$/);assert.ok(!state.exit);child.stdin.write(JSON.stringify({op})+'\n');const end=Date.now()+40000;while(Date.now()<end){const index=state.replies.findIndex(x=>x.op===op);if(index>=0){const result=state.replies.splice(index,1)[0];if(op==='close'){const end=Date.now()+3000;while(!state.exit&&Date.now()<end)await sleep(50);assert.ok(state.exit)}return result}if(state.exit)throw new Error('owner exited before reply');await sleep(75)}throw new Error('phase exceeds 40 second bound')}};
}
