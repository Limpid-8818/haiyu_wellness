// Import in a persistent node_repl; every phase is bounded to 40 seconds.
// The owner continues serving the async graph between calls, under its lease.
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function createController({taskId,attempt,apiPort=58908,webPort=58909,tokens}){
  assert.match(taskId,/^[a-f0-9-]{36}$/);assert.match(attempt,/^[a-z0-9-]+$/);
  const out=path.join(root,'output/playwright/bugfix-stage3a',taskId,attempt);
  assert.ok(!fs.existsSync(out),'do not reuse any attempt');
  const args=['scripts/bugfix-stage3a/owner.js','--task-id',taskId,'--out',out,'--api-port',String(apiPort),'--web-port',String(webPort),...(tokens?['--tokens',String(tokens)]:[])];
  const nodePath=execFileSync('/usr/bin/which',['node'],{encoding:'utf8',timeout:5000}).trim();
  const publicPath=execFileSync('/usr/bin/printenv',['PATH'],{encoding:'utf8',timeout:5000}).trim();
  const child=spawn(nodePath,args,{cwd:root,env:{PATH:publicPath,CODEX_TASK_ID:taskId},stdio:['pipe','pipe','pipe']});
  const state={pid:child.pid,out,buffer:'',ready:false,replies:[],exit:null,stderrBytes:0,stdoutBytes:0};
  child.stdout.on('data',chunk=>{state.stdoutBytes+=chunk.length;if(state.stdoutBytes>8388608)child.kill('SIGTERM');state.buffer+=chunk.toString();const lines=state.buffer.split('\n');state.buffer=lines.pop();for(const line of lines){if(line==='OWNER_READY')state.ready=true;if(line.startsWith('PHASE_RESULT '))state.replies.push(JSON.parse(line.slice(13)))}});
  child.stderr.on('data',chunk=>{state.stderrBytes+=chunk.length;if(state.stderrBytes>8388608)child.kill('SIGTERM')});
  child.on('exit',(code,signal)=>{state.exit={pid:child.pid,code,signal,observedAt:new Date().toISOString(),observationMethod:'child-process-exit-event'};if(fs.existsSync(out))fs.writeFileSync(path.join(out,'owner-exit.json'),JSON.stringify(state.exit,null,2))});
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const readyUntil=Date.now()+5000;
  while(!state.ready&&!state.exit&&Date.now()<readyUntil)await sleep(50);assert.ok(state.ready,'owner must become ready');
  return {state,async command(op){assert.ok(['prepare','submit','observe','verify','close'].includes(op));assert.ok(!state.exit,'owner has exited');child.stdin.write(JSON.stringify({op})+'\n');const until=Date.now()+40000;
    while(Date.now()<until){const index=state.replies.findIndex(row=>row.op===op);if(index>=0){const result=state.replies.splice(index,1)[0];if(op==='close'){const exitUntil=Date.now()+3000;while(!state.exit&&Date.now()<exitUntil)await sleep(50);assert.ok(state.exit,'must observe actual owner exit')}return result}if(state.exit)throw new Error('owner exited before phase reply');await sleep(75)}throw new Error('phase exceeds 40-second bound');}};
}
