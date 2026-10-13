import fs from 'node:fs';
// Read only public budget fields. No secrets, paths or other environment fields
// are returned. Run with resource-runner before the first provider attempt.
const allowed=new Set(['ASSISTANT_MAX_MODEL_CALLS','ASSISTANT_MAX_TOKENS','ASSISTANT_MAX_TOOL_CALLS','ASSISTANT_MAX_RUNTIME_MS','LLM_TIMEOUT_MS']);
const values={};
for(const line of fs.readFileSync('/Users/wangshanchong/Codes/haiyu_wellness/项目源码/.env','utf8').split(/\r?\n/)){
  const match=line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);if(!match||!allowed.has(match[1]))continue;
  const raw=match[2].replace(/\s+#.*$/,'').trim().replace(/^(['"])(.*)\1$/,'$2');
  if(Number.isFinite(Number(raw))&&Number(raw)>0)values[match[1]]=Number(raw);
}
console.log(JSON.stringify({publicBudget:values,notExplicit:[...allowed].filter(key=>!(key in values))}));
