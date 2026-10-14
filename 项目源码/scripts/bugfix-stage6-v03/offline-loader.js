// Only the explicitly offline owned API installs this test adapter.
import assert from 'node:assert/strict';
export async function resolve(specifier,context,nextResolve){if(specifier==='./model-adapter.js'&&context.parentURL?.endsWith('/server/src/assistant.js')){assert.equal(process.env.STAGE6_MODE,'offline_rehearsal');assert.equal(process.env.LLM_API_KEY,'');assert.equal(process.env.LLM_BASE_URL,'');return {url:new URL('./offline-adapter.js',import.meta.url).href,shortCircuit:true};}return nextResolve(specifier,context);}
