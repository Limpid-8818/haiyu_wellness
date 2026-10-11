import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ResourceSession, processIdentity } from './resource-runtime.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskId = process.env.CODEX_TASK_ID;
const evidencePath = path.join(projectRoot, 'output/resource-audit/stage22-q227-build-20261004.json');

function bounded(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 });
  return { command: [command, ...args].join(' '), exitCode: result.status,
    stdout: result.stdout || '', stderr: result.stderr || '', error: result.error?.message || null };
}

async function main() {
  assert.ok(taskId, 'Q22.7 build requires CODEX_TASK_ID');
  let session;
  let buildResource;
  let buildResult;
  let buildLogTail = '';
  let buildTimedOut = false;
  let resourcesBeforeClose = [];
  let failure = null;
  let cleanupFailure = null;
  let sessionCleanup = null;
  const owner = { pid: process.pid, start: processIdentity(process.pid), command: process.argv.join(' '), cwd: process.cwd() };
  try {
    session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp' });
    buildResource = await session.startProcess({ label: 'stage22-q227-vite-build', kind: 'build', role: 'build',
      command: 'npm', args: ['run', 'build'], cwd: projectRoot,
      env: { PATH: process.env.PATH || '', npm_config_offline: 'true', NODE_DISABLE_COMPILE_CACHE: '1' } });
    buildResult = await session.waitProcess(buildResource.id, 120_000);
    if (buildResult.timedOut) {
      buildTimedOut = true;
      await session.stop(buildResource.id, 'stage22-q227-build-timeout');
      buildResult = await session.waitProcess(buildResource.id, 15_000);
    }
    buildLogTail = (await session.rpc({ op: 'log-tail', id: buildResource.id, maxBytes: 32 * 1024 })).tail || '';
    if (buildResult.status !== 'exited' || buildResult.exitCode !== 0 || buildTimedOut) {
      failure = new Error(`npm run build failed: status=${buildResult.status}, exitCode=${buildResult.exitCode}, timedOut=${buildTimedOut}`);
    }
  } catch (error) { failure = error; }
  if (session) {
    try {
      const state = await session.status();
      resourcesBeforeClose = (state.resources || []).map(resource => ({ id: resource.id, label: resource.label,
        kind: resource.kind, role: resource.role, pid: resource.pid, processStartTime: resource.processStartTime,
        processFingerprint: resource.processFingerprint, command: resource.command, cwd: resource.cwd, tempDir: resource.tempDir,
        port: resource.port || null, logPath: resource.logPath, logBytes: resource.logBytes,
        status: resource.status, exitCode: resource.exitCode ?? null, signal: resource.signal || null }));
      const live = (state.resources || []).filter(resource => ['starting', 'running'].includes(resource.status));
      if (live.length) {
        cleanupFailure = new Error(`build resources remain running before close: ${live.map(item => `${item.pid}:${item.label}`).join(', ')}`);
      }
    } catch (error) { cleanupFailure ||= error; }
    try { sessionCleanup = await session.close(failure || cleanupFailure ? 'stage22-q227-build-failure' : 'stage22-q227-build-complete'); }
    catch (error) { cleanupFailure ||= error; }
  }
  const evidence = { schemaVersion: 1, taskId, status: failure || cleanupFailure ? 'FAIL' : 'PASS',
    command: 'CODEX_TASK_ID=01a105f3-88a9-7022-b399-d43613f117cc node scripts/resources/stage22-q227-build.js',
    buildCommand: 'npm run build', preStartBaseline: 'output/resource-audit/stage22-q227-pre-build-resource-baseline-20261004.json',
    cwd: projectRoot, owner, resourceSessionId: session?.instanceId || null,
    tempDir: session?.tempDir || null, limits: session?.limits || null,
    resource: buildResource ? { id: buildResource.id, label: buildResource.label, pid: buildResource.pid,
      processStartTime: buildResource.processStartTime, processFingerprint: buildResource.processFingerprint,
      command: buildResource.command || 'npm run build', cwd: buildResource.cwd, tempDir: buildResource.tempDir,
      port: buildResource.port || null, logPath: buildResource.logPath, logBytes: buildResult?.logBytes ?? null,
      exitCode: buildResult?.exitCode ?? null, signal: buildResult?.signal || null, status: buildResult?.status || null,
      timedOut: buildTimedOut, directoryPeakBytes: buildResult?.directoryPeakBytes ?? null } : null,
    outputTail: buildLogTail, resourcesBeforeClose,
    cleanup: sessionCleanup?.cleanupRecord || null, tempDirRemoved: session ? !fs.existsSync(session.tempDir) : null,
    postBuildDisk: [bounded('df', ['-k', '/tmp']), bounded('du', ['-sk', '/tmp', 'output/resource-audit', 'output/playwright', 'web/dist'])],
    failure: failure ? String(failure.stack || failure).slice(0, 4000) : null,
    cleanupFailure: cleanupFailure ? String(cleanupFailure.stack || cleanupFailure).slice(0, 4000) : null,
    completedAtUtc: new Date().toISOString() };
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status: evidence.status, evidencePath, resource: evidence.resource,
    tempDirRemoved: evidence.tempDirRemoved, failure: evidence.failure, cleanupFailure: evidence.cleanupFailure }, null, 2)}\n`);
  if (failure || cleanupFailure) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
