import assert from 'node:assert/strict';
assert.ok(['live','offline_rehearsal'].includes(process.env.STAGE6_MODE));
if(process.env.STAGE6_MODE==='live')await import('./live-api.js');else await import('./offline-api.js');
