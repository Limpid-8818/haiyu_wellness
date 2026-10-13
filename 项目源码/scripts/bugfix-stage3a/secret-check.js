import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadApprovedLlmConfig} from '../resources/load-approved-llm-config.js';
const config=await loadApprovedLlmConfig();assert.ok(config.configured,'approved config available');
const secret=config.env.LLM_API_KEY;assert.ok(secret.length>=8);
let checked=0;
for(const root of process.argv.slice(2)){
  const pending=[path.resolve(root)];while(pending.length){const item=pending.pop(),stat=fs.lstatSync(item);if(stat.isDirectory()){for(const name of fs.readdirSync(item))pending.push(path.join(item,name));continue}
    if(stat.isSymbolicLink()||!stat.isFile()||!/(?:\.jsonl?|\.log|\.txt|\.md)$/.test(item))continue;
    assert.ok(stat.size<=8*1024*1024,'bounded new evidence');checked++;assert.ok(!fs.readFileSync(item,'utf8').includes(secret),'secret not present in new evidence');
  }
}
console.log(JSON.stringify({status:'PASS',checkedFiles:checked,secretMatches:0}));
