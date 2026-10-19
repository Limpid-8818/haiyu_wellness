import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { ResourceSession } from '../resources/resource-runtime.js';
const root = process.cwd(), taskId = process.env.CODEX_TASK_ID, out = process.env.G28_AUDIT_ROOT, attempt = process.env.G28_ATTEMPT;
assert.match(taskId, /^[a-f0-9-]{36}$/);
assert.equal(out, path.join(root, 'output/resource-audit/engineering-20261019/g28', taskId));
const focus = process.argv[3] || '';
const journey = process.argv[2]; assert.ok(['guest', 'staff'].includes(journey));
const session = await ResourceSession.create({ taskId, projectRoot: root, auditRoot: path.join(out, 'runtime', attempt + '-owner'),
  limits: { leaseMs: 900000, logBytes: 8388608, directoryBytes: 536870912 } });
const receipt = { taskId, hostId: 'local', journey, instanceId: session.instanceId, registryPath: session.registryPath, status: 'RUNNING' };
const save = () => fs.writeFileSync(path.join(out, attempt + '-owner.json'), JSON.stringify(receipt, null, 2));
const env = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_TASK_ID: taskId, HAIYU_RESOURCE_MANAGED: '1',
  NODE_ENV: 'test', DEMO_SEED: '1', AUTH_SECRET: 'g28-synthetic-only-secret', DB_DRIVER: 'sqlite',
  LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '', ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0', STAGE25_SCHEDULER_ENABLED: '0' };
const cloneParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
function cloneSnapshot() {
  return fs.existsSync(cloneParent) ? fs.readdirSync(cloneParent).filter(n => n.startsWith('code_sign_clone.')).sort().map(name => {
    const stat = fs.lstatSync(path.join(cloneParent, name)); return { name, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs };
  }) : [];
}
async function freePort() {
  const server = net.createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function ready(resource, url) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    assert.equal((await session.status()).resources.find(r => r.id === resource.id).status, 'running');
    try { if ((await fetch(url)).ok) return; } catch { /* bounded readiness only */ }
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error('G28 owned service not ready');
}
let api, vite;
try {
  receipt.cloneBefore = cloneSnapshot(); save();
  const data = await session.allocateDir('synthetic-data');
  const apiPort = await freePort(), webPort = await freePort(); assert.notEqual(apiPort, webPort);
  const web = `http://127.0.0.1:${webPort}`;
  Object.assign(receipt, { apiPort, webPort }); save();
  api = await session.startProcess({ label: 'g28-synthetic-api', kind: 'api', role: 'api', command: process.execPath,
    args: ['scripts/g28-web-accessibility/api.js'], cwd: root, port: apiPort,
    env: { ...env, DB_PATH: path.join(data, 'fixture.sqlite'), PORT: String(apiPort), CORS_ALLOWED_ORIGINS: web } });
  await ready(api, `http://127.0.0.1:${apiPort}/api/assistant/status`);
  const cache = await session.allocateDir('vite-cache'), envDir = await session.allocateDir('empty-env');
  vite = await session.startProcess({ label: 'g28-vite', kind: 'vite', role: 'vite', command: process.execPath,
    args: ['scripts/g28-web-accessibility/vite.js'], cwd: root, port: webPort,
    env: { ...env, HAIYU_VITE_CACHE_DIR: cache, G28_ENV_DIR: envDir, WEB_PORT: String(webPort), API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` } });
  await ready(vite, web);
  const profile = await session.allocateDir('browser');
  const config = path.join(profile, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ journey, focus, web, profile: path.join(profile, 'profile'), out,
    proof: path.join(out, attempt + '-browser.json'), playwrightModule: '/Users/wangshanchong/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs',
    launchConfig: path.join(root, 'scripts/resources/playwright-cli.config.json'), cloneParent }));
  const browser = await session.runProcess({ label: 'g28-headless-browser', kind: 'browser', role: 'browser', command: process.execPath,
    args: ['scripts/g28-web-accessibility/browser.js', config], cwd: root, env: { ...env, TMPDIR: profile, XDG_CACHE_HOME: profile } }, { timeoutMs: 27000 });
  receipt.browser = { exit: browser.exitCode, timedOut: browser.timedOut, tail: browser.tail };
  assert.equal(browser.exitCode, 0, browser.tail); assert.equal(browser.timedOut, false);
  receipt.status = 'PASS';
} catch (error) { receipt.status = 'FAIL'; receipt.error = error.stack; process.exitCode = 1; }
finally {
  for (const resource of [vite, api].filter(Boolean)) {
    await session.stop(resource.id, 'g28-browser-complete');
    const stopped = await session.waitProcess(resource.id, 3000);
    assert.ok(['stopped', 'exited'].includes(stopped.status)); assert.ok(stopped.pids.every(p => p.exitConfirmed));
  }
  receipt.cleanup = await session.close('g28-browser-complete'); receipt.tempRemoved = !fs.existsSync(session.tempDir);
  receipt.cloneAfter = cloneSnapshot(); save();
  assert.deepEqual(receipt.cloneBefore, receipt.cloneAfter, 'no new code-sign clone caches');
  assert.ok(receipt.cleanup.ok && receipt.tempRemoved);
}
console.log(JSON.stringify({ status: receipt.status, journey, cleanup: receipt.cleanup.ok }));
