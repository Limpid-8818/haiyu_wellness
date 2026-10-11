#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
  ResourceSession, processIdentity, processMatches
} from './resource-runtime.js';

const taskId = '01a126ea-4705-7771-ad75-e0d6ef0f4eb7';
const projectRoot = process.cwd();
const workerBaselinePath = path.join(projectRoot, 'output/resource-audit/stage27-r5-source-sol-startup-binding-repair-handoff-baseline-20261011.json');
const resourceLimits = { logBytes: 8 * 1024 * 1024, directoryBytes: 512 * 1024 * 1024, leaseMs: 15 * 60 * 1000 };
const protectedProcessNames = ['Chrome7081', 'VsCode67464'];
const evidence = {
  recordType: 'stage27-r5-vite-warm-start-smoke',
  taskId,
  projectRoot,
  status: 'RUNNING',
  command: { executable: 'npm', args: ['run', 'dev', '-w', 'web'], cwd: projectRoot },
  providerRequests: 0,
  mysqlStarted: false,
  apiStarted: false,
  browserStarted: false,
  installCommands: 0,
  readinessDeadlineMs: 60_000,
  limits: resourceLimits,
  errors: []
};

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function dfSample() {
  const text = execFileSync('df', ['-Pk', '/tmp'], { encoding: 'utf8', timeout: 3000 });
  return text.trim().split('\n').slice(-1)[0] || null;
}

function protectedProcessSnapshot(expected) {
  const result = {};
  for (const name of protectedProcessNames) {
    const baseline = expected[name];
    if (!baseline) throw new Error(`protected process ${name} is missing from the frozen baseline`);
    const current = processIdentity(baseline.pid);
    assert.ok(current, `${name} PID ${baseline.pid} must remain present`);
    assert.equal(current.startTime, baseline.startTime, `${name} exact start time must remain unchanged`);
    assert.equal(current.fingerprint, baseline.fingerprint, `${name} exact fingerprint must remain unchanged`);
    result[name] = { pid: current.pid, startTime: current.startTime, fingerprint: current.fingerprint };
  }
  return result;
}

async function bindLoopbackPort(port = 0) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const assignedPort = server.address()?.port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!Number.isInteger(assignedPort) || assignedPort < 1) throw new Error('could not select a loopback port');
  return assignedPort;
}

function connectOutcome(port, timeoutMs = 250) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = outcome => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.once('connect', () => finish({ listening: true }));
    socket.once('error', error => finish({ listening: error.code !== 'ECONNREFUSED', code: error.code || null }));
    socket.setTimeout(timeoutMs, () => finish({ listening: true, code: 'ETIMEDOUT' }));
  });
}

async function chooseApiProxyPort(excluded) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const port = await bindLoopbackPort(0);
    if (excluded.has(port)) continue;
    const outcome = await connectOutcome(port);
    if (!outcome.listening && outcome.code === 'ECONNREFUSED') return port;
  }
  throw new Error('could not identify an unused loopback destination for API_PROXY_TARGET');
}

async function chooseWebPort() {
  try {
    const port = await bindLoopbackPort(5180);
    return { port, selection: 'preferred-default-5180-was-free' };
  } catch (error) {
    if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    return { port: await bindLoopbackPort(0), selection: '5180-was-occupied-selected-free-loopback-port' };
  }
}

function listenerSnapshot(port) {
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpnc'], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024
  });
  if (result.error) throw result.error;
  if (result.status === 1 && !result.stdout) return [];
  if (result.status !== 0) throw new Error(`lsof exited ${result.status}: ${(result.stderr || '').slice(0, 500)}`);
  let current = null;
  const rows = new Map();
  for (const line of (result.stdout || '').split('\n')) {
    if (line.startsWith('p') && /^p\d+$/.test(line)) {
      const pid = Number(line.slice(1));
      current = rows.get(pid) || { pid, command: null, names: [] };
      rows.set(pid, current);
    } else if (current && line.startsWith('c')) current.command = line.slice(1);
    else if (current && line.startsWith('n')) current.names.push(line.slice(1));
  }
  return [...rows.values()];
}

function requestRoot(port, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = http.get({ hostname: '127.0.0.1', port, path: '/', agent: false,
      headers: { connection: 'close' } }, response => {
      const chunks = [];
      let capturedBytes = 0;
      response.on('data', chunk => {
        if (capturedBytes < 16 * 1024) {
          const remaining = 16 * 1024 - capturedBytes;
          const part = chunk.subarray(0, remaining);
          chunks.push(part);
          capturedBytes += part.length;
        }
      });
      response.once('error', error => finish(error));
      response.once('end', () => finish(null, {
        statusCode: response.statusCode,
        contentType: response.headers['content-type'] || null,
        connection: response.headers.connection || null,
        body: Buffer.concat(chunks).toString('utf8')
      }));
      response.resume();
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`root GET timed out after ${timeoutMs}ms`)));
    request.once('error', error => finish(error));
  });
}

function readInstanceEvents(registryPath, instanceId) {
  if (!registryPath || !fs.existsSync(registryPath)) return [];
  return fs.readFileSync(registryPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.instanceId === instanceId);
}

async function waitForManagedReady({ session, resourceId, port, deadlineAt }) {
  let lastRequestError = null;
  let lastResourceStatus = null;
  let lastListeners = [];
  let lastHttp = null;
  let responseCount = 0;
  while (Date.now() < deadlineAt) {
    const current = (await session.status()).resources?.find(item => item.id === resourceId);
    lastResourceStatus = current?.status || 'missing';
    if (!current || !['starting', 'running'].includes(current.status)) {
      throw new Error(`managed Vite command stopped before readiness (${lastResourceStatus}, exit=${current?.exitCode ?? 'unknown'})`);
    }

    try { lastListeners = listenerSnapshot(port); }
    catch (error) { throw new Error(`could not verify the real TCP listener: ${error.message}`); }
    const listenerNames = [...new Set(lastListeners.flatMap(row => row.names))];
    if (lastListeners.length && !listenerNames.every(name => name === `127.0.0.1:${port}`)) {
      throw new Error(`Vite listener is not bound only to 127.0.0.1:${port}: ${JSON.stringify(lastListeners)}`);
    }

    try {
      lastHttp = await requestRoot(port);
      responseCount += 1;
      lastRequestError = null;
    } catch (error) { lastRequestError = String(error.message || error); }

    if (lastHttp?.statusCode === 200 && /text\/html/iu.test(lastHttp.contentType || '')
      && /@vite\/client/u.test(lastHttp.body)) {
      const status = await session.status();
      const latest = status.resources?.find(item => item.id === resourceId);
      const tracked = latest?.pids || [];
      const identities = lastListeners.map(listener => {
        const identity = processIdentity(listener.pid);
        const matchedResource = tracked.find(item => item.pid === listener.pid && identity
          && item.startTime === identity.startTime && item.fingerprint === identity.fingerprint);
        return { ...listener, identity, registeredInResourceSession: Boolean(matchedResource), registeredProcess: matchedResource || null };
      });
      if (identities.length === 1 && identities[0].registeredInResourceSession) {
        const text = identities[0].names.join(' ');
        assert.equal(text, `127.0.0.1:${port}`, 'the listener address and request URL use the same loopback interface and port');
        assert.ok(identities[0].identity?.fingerprint, 'the actual listener PID has an exact identity');
        assert.equal(latest.command, 'npm run dev -w web', 'the actual unmodified workspace command was used');
        return { http: { statusCode: lastHttp.statusCode, contentType: lastHttp.contentType,
          bodyContainsViteClient: true, getCount: responseCount, requestedPath: '/' },
          listener: identities[0], resource: latest };
      }
    }
    await delay(150);
  }
  throw new Error(`Vite did not become ready within 60000ms; status=${lastResourceStatus}; `
    + `listener=${JSON.stringify(lastListeners)}; lastHttp=${lastHttp?.statusCode ?? null}; `
    + `requestError=${lastRequestError}; GET count=${responseCount}`);
}

let session;
let resource;
let cacheDir;
let npmCacheDir;
let apiProxyPort;
let webSelection;
let startAt;
let successful = false;
let sessionClose;
let stopResult;
let waitResult;
let resourceBeforeStop;
let resourceAfterStop;
let cleanupSummary;
let instanceEvents = [];
let protectedBefore;
let protectedAfter;
let apiProxyAfter;
let webListenersAfter = [];
let dfBefore;
let dfAfter;

try {
  assert.equal(projectRoot, path.resolve(projectRoot), 'smoke must run from the project root');
  assert.ok(fs.existsSync(workerBaselinePath), 'frozen startup-repair baseline must be present');
  const baseline = JSON.parse(fs.readFileSync(workerBaselinePath, 'utf8'));
  assert.equal(baseline.workerTaskId, taskId, 'the frozen baseline belongs to this worker task');
  assert.equal(baseline.sourceInputCount, 224, 'the frozen source input count is unchanged');
  assert.equal(baseline.all936SegmentManifest.length, 936, 'the frozen resource segment count is unchanged');
  assert.equal(baseline.currentPhysicalResiduals, 0, 'the frozen baseline has no current physical residuals');
  assert.equal(baseline.newLifecycleGaps, 0, 'the frozen baseline has no new lifecycle gaps');
  assert.equal(baseline.workerAdditionalColdAuthorized, 0, 'the worker has no additional install authorization');
  assert.equal(baseline.workerFullQ277Q278AuthorizedThisRepair, false, 'full Q27.7/8 is outside the worker repair scope');
  evidence.baselinePath = path.relative(projectRoot, workerBaselinePath);
  evidence.protectedProcessesBefore = protectedBefore = protectedProcessSnapshot(baseline.protectedUserProcessIdentities);
  dfBefore = dfSample();

  webSelection = await chooseWebPort();
  apiProxyPort = await chooseApiProxyPort(new Set([webSelection.port]));
  evidence.web = { port: webSelection.port, selection: webSelection.selection,
    baseUrl: `http://127.0.0.1:${webSelection.port}/` };
  evidence.apiProxyTarget = `http://127.0.0.1:${apiProxyPort}`;
  evidence.apiProxyTargetUnusedBeforeStart = true;

  session = await ResourceSession.create({ taskId, projectRoot, tempParent: '/tmp', limits: resourceLimits });
  cacheDir = await session.allocateDir('vite-cache');
  npmCacheDir = await session.allocateDir('npm-cache');
  assert.ok(path.relative(session.tempDir, cacheDir).startsWith('vite-cache'), 'Vite cache is inside the ResourceSession temp root');
  assert.ok(path.relative(session.tempDir, npmCacheDir).startsWith('npm-cache'), 'npm runtime cache is inside the ResourceSession temp root');
  evidence.resourceSession = { instanceId: session.instanceId, owner: session.ownerIdentity,
    guardian: session.guardianIdentity, registryPath: session.registryPath, tempDir: session.tempDir,
    socketPath: session.socketPath, cacheDir, npmCacheDir };
  startAt = Date.now();
  resource = await session.startProcess({
    label: 'stage27-r5-vite-warm-dev', kind: 'vite', role: 'vite', command: 'npm',
    args: ['run', 'dev', '-w', 'web'], cwd: projectRoot, port: webSelection.port,
    leaseMs: resourceLimits.leaseMs,
    env: {
      PATH: process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
      CODEX_TASK_ID: taskId,
      HAIYU_RESOURCE_MANAGED: '1',
      HAIYU_VITE_CACHE_DIR: cacheDir,
      WEB_PORT: String(webSelection.port),
      API_PROXY_TARGET: `http://127.0.0.1:${apiProxyPort}`,
      npm_config_cache: npmCacheDir,
      npm_config_update_notifier: 'false',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_logs_max: '1'
    }
  });
  evidence.resource = { id: resource.id, status: resource.status, pid: resource.pid,
    startTime: resource.processStartTime, fingerprint: resource.processFingerprint, command: resource.command,
    port: resource.port, logPath: resource.logPath, logBytes: resource.logBytes };
  assert.equal(resource.status, 'running', 'npm dev process started as a registered ResourceSession service');
  const ready = await waitForManagedReady({ session, resourceId: resource.id, port: webSelection.port,
    deadlineAt: startAt + 60_000 });
  evidence.readyElapsedMs = Date.now() - startAt;
  evidence.http = ready.http;
  evidence.listener = ready.listener;
  const logTail = await session.rpc({ op: 'log-tail', id: resource.id, maxBytes: 4096 });
  evidence.viteLogAddressMatched = new RegExp(`http://127\\.0\\.0\\.1:${webSelection.port}/?`, 'u')
    .test(String(logTail.tail || '').replace(/\u001b\[[0-9;]*m/gu, ''));
  evidence.viteLogTail = String(logTail.tail || '').slice(-4096);
  assert.equal(evidence.viteLogAddressMatched, true, 'Vite startup log reports the same 127.0.0.1 URL');
  assert.ok(evidence.readyElapsedMs <= 60_000, 'readiness completed within the 60-second window');
  successful = true;
} catch (error) {
  evidence.errors.push(String(error?.stack || error).slice(0, 4000));
} finally {
  evidence.startupResult = successful ? 'PASS' : 'FAIL';
  if (session && resource) {
    try {
      resourceBeforeStop = (await session.status()).resources?.find(item => item.id === resource.id) || null;
      stopResult = await session.stop(resource.id, 'stage27-r5-vite-warm-smoke-complete');
      waitResult = await session.waitProcess(resource.id, 10_000);
      resourceAfterStop = (await session.status()).resources?.find(item => item.id === resource.id) || null;
      evidence.stoppedResource = resourceAfterStop;
      evidence.waitResult = waitResult;
      const pids = resourceAfterStop?.pids || waitResult?.pids || [];
      evidence.exactPidExitChecks = pids.map(item => ({
        pid: item.pid, startTime: item.startTime, fingerprint: item.fingerprint,
        main: item.main, exitConfirmed: item.exitConfirmed === true,
        currentIdentity: processIdentity(item.pid),
        identityStillPresent: processMatches(item.pid, { startTime: item.startTime, fingerprint: item.fingerprint })
      }));
      evidence.allExactPidsExited = evidence.exactPidExitChecks.length > 0
        && evidence.exactPidExitChecks.every(item => item.exitConfirmed && !item.identityStillPresent);
      evidence.stopAcknowledged = stopResult?.ok === true;
      if (!evidence.allExactPidsExited) throw new Error('one or more registered Vite/npm PIDs lack exact exit confirmation');
      if (!evidence.stopAcknowledged) throw new Error('ResourceSession did not acknowledge the Vite stop');
    } catch (error) { evidence.errors.push(`service stop: ${String(error.message || error).slice(0, 2000)}`); }
  } else if (session) {
    try { resourceAfterStop = (await session.status()).resources?.[0] || null; }
    catch (error) { evidence.errors.push(`resource status: ${String(error.message || error).slice(0, 1000)}`); }
  }

  if (session) {
    try {
      sessionClose = await session.close(evidence.errors.length ? 'stage27-r5-vite-warm-smoke-error' : 'stage27-r5-vite-warm-smoke-complete');
      evidence.sessionCleanup = sessionClose;
    } catch (error) { evidence.errors.push(`ResourceSession cleanup: ${String(error.message || error).slice(0, 2000)}`); }
    instanceEvents = readInstanceEvents(session.registryPath, session.instanceId);
    const summaries = instanceEvents.filter(item => item.event === 'resource_cleanup_summary');
    cleanupSummary = summaries.find(item => item.resourceId === resource?.id) || summaries[0] || null;
    evidence.registry = {
      path: session.registryPath,
      bytes: fs.existsSync(session.registryPath) ? fs.statSync(session.registryPath).size : null,
      instanceId: session.instanceId,
      ownerEvents: instanceEvents.filter(item => ['runner_started', 'guardian_started', 'guardian_pid_exited', 'instance_cleaned', 'instance_cleanup_blocked'].includes(item.event)),
      resourceSummary: cleanupSummary,
      exactProcessExitEvents: instanceEvents.filter(item => item.event === 'pid_exit_confirmed')
    };
    evidence.tempRootRemoved = !fs.existsSync(session.tempDir);
    evidence.guardianSocketRemoved = !fs.existsSync(session.socketPath);
    evidence.viteCacheRemoved = !cacheDir || !fs.existsSync(cacheDir);
    evidence.npmCacheRemoved = !npmCacheDir || !fs.existsSync(npmCacheDir);
    evidence.resourceLogRemoved = !resource?.logPath || !fs.existsSync(resource.logPath);
    const terminal = instanceEvents.filter(item => ['instance_cleaned', 'instance_cleanup_preserved', 'instance_cleanup_blocked'].includes(item.event)).at(-1);
    evidence.resourceSessionCleaned = terminal?.event === 'instance_cleaned' && sessionClose?.ok === true
      && sessionClose?.status === 'cleaned' && evidence.tempRootRemoved && evidence.guardianSocketRemoved;
    evidence.openHandleAuditPassed = String(terminal?.openHandleCheck || '').includes('lsof +D and lsof +L1 completed with no matching handles');
    evidence.limitsObserved = cleanupSummary ? {
      logPeakBytes: cleanupSummary.logPeakBytes,
      maxLogBytes: cleanupSummary.maxLogBytes,
      directoryPeakBytes: cleanupSummary.directoryPeakBytes,
      maxDirectoryBytes: cleanupSummary.maxDirectoryBytes,
      port: cleanupSummary.port,
      leaseExpiry: instanceEvents.find(item => item.event === 'process_starting')?.leaseMs || null
    } : null;
    try { webListenersAfter = listenerSnapshot(webSelection?.port || 5180); }
    catch (error) { evidence.errors.push(`post-stop listener check: ${String(error.message || error).slice(0, 1000)}`); }
    evidence.webListenersAfterStop = webListenersAfter;
    if (apiProxyPort) {
      apiProxyAfter = await connectOutcome(apiProxyPort);
      evidence.apiProxyTargetUnusedAfterStop = !apiProxyAfter.listening && apiProxyAfter.code === 'ECONNREFUSED';
    }
    try {
      const baseline = JSON.parse(fs.readFileSync(workerBaselinePath, 'utf8'));
      protectedAfter = protectedProcessSnapshot(baseline.protectedUserProcessIdentities);
      evidence.protectedProcessesAfter = protectedAfter;
      evidence.protectedProcessesUnchanged = JSON.stringify(protectedBefore) === JSON.stringify(protectedAfter);
    } catch (error) { evidence.errors.push(`protected process recheck: ${String(error.message || error).slice(0, 1000)}`); }
    try { dfAfter = dfSample(); evidence.diskSpaceSamples = { before: dfBefore, after: dfAfter }; }
    catch (error) { evidence.errors.push(`post-cleanup disk-space sample: ${String(error.message || error).slice(0, 1000)}`); }
  }

  evidence.resourceCleanupPassed = Boolean(evidence.resourceSessionCleaned && evidence.openHandleAuditPassed
    && evidence.allExactPidsExited && evidence.resourceLogRemoved && evidence.viteCacheRemoved
    && evidence.npmCacheRemoved && evidence.webListenersAfterStop?.length === 0
    && evidence.apiProxyTargetUnusedAfterStop && evidence.protectedProcessesUnchanged
    && cleanupSummary?.logPeakBytes <= resourceLimits.logBytes
    && cleanupSummary?.directoryPeakBytes <= resourceLimits.directoryBytes);
  evidence.status = evidence.startupResult === 'PASS' && evidence.resourceCleanupPassed
    && evidence.apiProxyTargetUnusedBeforeStart === true ? 'PASS' : 'FAIL';
  if (evidence.status !== 'PASS' && evidence.errors.length === 0) evidence.errors.push('one or more startup or resource cleanup assertions did not pass');
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (evidence.status !== 'PASS') process.exitCode = 1;
}
