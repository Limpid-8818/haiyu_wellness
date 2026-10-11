import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ResourceSession } from './resource-runtime.js';
import { runQ232OfflineEntryRegression } from '../quests/q23.js';

const taskId = process.argv[2] || process.env.CODEX_TASK_ID;
const safePath = process.env.PATH || '/usr/bin:/bin';
if (!taskId) throw new Error('Q23.2 offline entry regression requires CODEX_TASK_ID from ResourceRunner');
for (const key of Object.keys(process.env)) delete process.env[key];
process.env.PATH = safePath;
process.env.CODEX_TASK_ID = taskId;
process.env.TZ = 'UTC';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const resourceSession = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp', limits: {
  leaseMs: 15 * 60 * 1000, logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024
} });
let result = null;
let failure = null;
try {
  result = await runQ232OfflineEntryRegression(resourceSession);
} catch (error) {
  failure = error;
} finally {
  try {
    const cleanup = await resourceSession.close(failure ? 'q232-offline-entry-regression-failure' : 'q232-offline-entry-regression-complete');
    if (!cleanup?.ok || cleanup.status !== 'cleaned') {
      failure = failure || new Error(`Q23.2 offline ResourceSession cleanup failed: ${JSON.stringify(cleanup)}`);
    }
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], 'Q23.2 offline flow and resource cleanup failed') : error;
  }
}

if (failure) {
  console.error(JSON.stringify({ status: 'FAIL', taskId, instanceId: resourceSession.instanceId,
    registryPath: resourceSession.registryPath, tempDirRemoved: !resourceSession.tempDir
      || !fs.existsSync(resourceSession.tempDir),
    error: String(failure.stack || failure).slice(0, 6000) }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ status: 'PASS', taskId, instanceId: resourceSession.instanceId,
    registryPath: resourceSession.registryPath, tempDirRemoved: !resourceSession.tempDir
      || !fs.existsSync(resourceSession.tempDir),
    output: result.output, evidence: result.evidence }));
}
