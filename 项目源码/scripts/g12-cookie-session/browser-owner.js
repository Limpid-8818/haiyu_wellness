import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ResourceSession } from '../resources/resource-runtime.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskId = process.env.CODEX_TASK_ID;
assert.match(taskId, /^[a-f0-9-]{36}$/);
const out = process.env.G12_AUDIT_ROOT;
assert.equal(out, path.join(root, 'output/resource-audit/engineering-20261018/g12', taskId));
const attempt = process.env.G12_ATTEMPT;
const proof = path.join(out, attempt + '-browser.json');
assert.ok(!fs.existsSync(proof));
const session = await ResourceSession.create({ taskId, projectRoot: root, auditRoot: path.join(out, 'runtime', attempt + '-services'),
  limits: { leaseMs: 900000, logBytes: 8388608, directoryBytes: 536870912 } });
const receipt = { taskId, instanceId: session.instanceId, registryPath: session.registryPath, privateEnvRead: false,
  modelHttp: 0, weatherHttp: 0, scheduler: false, install: false, status: 'RUNNING' };
const save = () => fs.writeFileSync(path.join(out, attempt + '-owner.json'), JSON.stringify(receipt, null, 2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_TASK_ID: taskId, HAIYU_RESOURCE_MANAGED: '1',
  NODE_ENV: 'test', DB_DRIVER: 'sqlite', DB_PATH: ':memory:', DEMO_SEED: '0', AUTH_SECRET: 'g12-browser-synthetic-only-secret',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '', ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0', STAGE25_SCHEDULER_ENABLED: '0' };
let api, vite;
async function freePort() {
  const s = net.createServer(); await new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', resolve); });
  const port = s.address().port; await new Promise(resolve => s.close(resolve)); return port;
}
async function ready(resource, url) {
  const until = Date.now() + 7000;
  while (Date.now() < until) {
    const state = (await session.status()).resources.find(r => r.id === resource.id);
    assert.equal(state.status, 'running', 'owned service must remain running');
    try { if ((await fetch(url)).ok) return; } catch { /* bounded readiness */ }
    await sleep(80);
  }
  throw new Error('owned service readiness failed');
}
try {
  const apiPort = await freePort(); const webPort = await freePort(); assert.notEqual(apiPort, webPort);
  const web = `http://127.0.0.1:${webPort}`;
  Object.assign(receipt, { apiPort, webPort }); save();
  api = await session.startProcess({ label: 'g12-synthetic-api', kind: 'api', role: 'api', command: process.execPath,
    args: ['scripts/g12-cookie-session/api.js'], cwd: root, port: apiPort,
    env: { ...env, PORT: String(apiPort), CORS_ALLOWED_ORIGINS: web } });
  await ready(api, `http://127.0.0.1:${apiPort}/api/assistant/status`);
  const cache = await session.allocateDir('vite-cache');
  vite = await session.startProcess({ label: 'g12-vite', kind: 'vite', role: 'vite', command: process.execPath,
    args: [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    cwd: path.join(root, 'web'), port: webPort, env: { ...env, HAIYU_VITE_CACHE_DIR: cache, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` } });
  await ready(vite, web);
  const profileRoot = await session.allocateDir('browser-profile');
  const config = path.join(profileRoot, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ web, profile: path.join(profileRoot, 'profile'), proof,
    playwrightModule: '/Users/wangshanchong/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs',
    launchConfig: path.join(root, 'scripts/resources/playwright-cli.config.json') }));
  const browser = await session.runProcess({ label: 'g12-headless-core-browser', kind: 'browser', role: 'browser', command: process.execPath,
    args: ['scripts/g12-cookie-session/browser.js', config], cwd: root, env }, { timeoutMs: 25000 });
  receipt.browser = { exitCode: browser.exitCode, timedOut: browser.timedOut, tail: browser.tail };
  assert.equal(browser.exitCode, 0, browser.tail); assert.equal(browser.timedOut, false);
  assert.equal(JSON.parse(fs.readFileSync(proof)).status, 'PASS'); receipt.status = 'PASS';
} catch (error) { receipt.status = 'FAIL'; receipt.error = error.stack; process.exitCode = 1; }
finally {
  for (const resource of [vite, api].filter(Boolean)) {
    await session.stop(resource.id, 'g12-browser-complete');
    const stopped = await session.waitProcess(resource.id, 3000);
    assert.ok(['stopped', 'exited'].includes(stopped.status)); assert.ok(stopped.pids.every(p => p.exitConfirmed));
  }
  receipt.cleanup = await session.close('g12-browser-complete'); receipt.tempRemoved = !fs.existsSync(session.tempDir);
  save(); assert.ok(receipt.cleanup.ok && receipt.tempRemoved);
}
console.log(JSON.stringify({ status: receipt.status, proof, cleanup: receipt.cleanup.ok }));
