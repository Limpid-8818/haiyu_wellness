#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processIdentity } from './resource-runtime.js';
import { validateProtectedChromeSnapshot } from './protected-chrome-snapshot.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskId = process.env.CODEX_TASK_ID;
const sourceSolThreadId = '01a0cbfe-a161-72d0-992d-12fad655d4ef';
const cacheParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const expectedCacheNames = [
  'code_sign_clone.7WCMBh', 'code_sign_clone.87prgQ', 'code_sign_clone.FGf0ku',
  'code_sign_clone.KlYqcP', 'code_sign_clone.Km1hwm', 'code_sign_clone.Ly34OH',
  'code_sign_clone.b9cnAV', 'code_sign_clone.fpg2xz', 'code_sign_clone.jcG5XI',
  'code_sign_clone.ooLA7h', 'code_sign_clone.xkTnpB'
];
const protectedChrome = { pid: 7081, startTime: 'Thu Oct 1 17:27:01 2026',
  fingerprint: 'a30da864807c765187c20eb24b90dfaedb6d8273c8675d112e09016b42ec949d' };
const evidencePath = path.join(projectRoot, 'output/resource-audit/stage23-luna-browser-preflight-20261006.json');

function runBounded(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`${command} interrupted by ${result.signal}`);
  return result;
}

function captureUserChrome() {
  const priorTimezone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  let identity;
  try { identity = processIdentity(protectedChrome.pid); }
  finally { if (priorTimezone === undefined) delete process.env.TZ; else process.env.TZ = priorTimezone; }
  const handles = runBounded('lsof', ['-nP', '-p', String(protectedChrome.pid), '-Fn']);
  if (![0, 1].includes(handles.status)) throw new Error(`lsof PID ${protectedChrome.pid} exited ${handles.status}`);
  const clonePaths = [...new Set(String(handles.stdout || '').split(/\r?\n/).filter(line => line.startsWith('n')
    && line.includes('code_sign_clone.')).map(line => line.slice(1)))].sort();
  return { identity, identityTimezone: 'Asia/Shanghai', lsofCommand: `lsof -nP -p ${protectedChrome.pid} -Fn`,
    lsofExitCode: handles.status, clonePaths };
}

async function main() {
  if (!taskId) throw new Error('Stage23 Chrome preflight requires CODEX_TASK_ID');
  const cacheNames = fs.readdirSync(cacheParent).filter(name => name.startsWith('code_sign_clone.')).sort();
  const chrome = captureUserChrome();
  const configPath = path.join(projectRoot, 'scripts/resources/playwright-cli.config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const featureArgs = config.browser?.launchOptions?.args?.filter(value => value.startsWith('--disable-features=')) || [];
  const configValid = featureArgs.length === 1 && featureArgs[0].split('=')[1].split(',').includes('MacAppCodeSignClone');
  const snapshot = { ...chrome, cacheNames };
  const validation = validateProtectedChromeSnapshot(snapshot, { protectedChrome, cacheParent, expectedCacheNames });
  const status = validation.ok && configValid ? 'PASS_BASELINE_CAPTURED' : 'BLOCKED';
  const result = { schemaVersion: 1, status, executingAppThreadId: taskId, registryTaskId: taskId,
    sourceSolThreadId, capturedAt: new Date().toISOString(), browserLaunched: false,
    userProcessChanged: false, cacheParent, expectedCacheNames, observedCacheNames: cacheNames,
    chromeSnapshot: snapshot, acceptedThisRunBaseline: validation.ok ? validation.baseline : null,
    playwrightConfigPath: configPath, disableFeaturesArgs: featureArgs, configValid,
    reason: validation.ok ? (configValid ? null : 'Playwright config must contain one merged MacAppCodeSignClone argument') : validation.message,
    reasonCode: validation.ok ? (configValid ? null : 'PLAYWRIGHT_CONFIG_INVALID') : validation.code,
    evidencePath };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ status, evidencePath, browserLaunched: false, userProcessChanged: false,
    cacheNameCount: cacheNames.length, cacheNames, clonePaths: chrome.clonePaths, identity: chrome.identity,
    configValid, reason: result.reason, reasonCode: result.reasonCode })}\n`);
  if (status !== 'PASS_BASELINE_CAPTURED') process.exitCode = 2;
}

main().catch(error => {
  process.stderr.write(`PROTECTED_CHROME_PREFLIGHT_FAIL ${String(error?.message || error)}\n`);
  process.exitCode = 1;
});
