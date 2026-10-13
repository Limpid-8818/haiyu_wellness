import assert from 'node:assert/strict';
assert.equal(process.env.DB_DRIVER,'sqlite');
assert.ok(process.env.DB_PATH?.startsWith('/tmp/haiyu-resource-'));
for(const name of ['LLM_API_KEY','LLM_BASE_URL','LLM_MODEL'])assert.equal(process.env[name],'');
assert.equal(process.env.ENVIRONMENT_MODE,'unavailable');
const {app}=await import('../../server/src/app.js');const {db}=await import('../../server/src/db.js');
const server=app.listen(Number(process.env.PORT),'127.0.0.1',()=>console.log('STAGE4_READY'));
let closing=false;const close=()=>{if(closing)return;closing=true;server.close(async()=>{await db.close();process.exit(0)})};
process.once('SIGTERM',close);process.once('SIGINT',close);
