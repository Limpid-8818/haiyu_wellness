import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ResourceSession, processIdentity, processMatches } from '../resources/resource-runtime.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const flags = Object.fromEntries(process.argv.slice(2).reduce((rows, value, index, all) => value.startsWith('--') ? [...rows, [value.slice(2), all[index + 1]]] : rows, []));
assert.ok(flags['task-id'], 'pass the actual caller task ID');
assert.equal(process.env.CODEX_TASK_ID, flags['task-id'], 'caller environment must match CLI');
const apiPort = Number(flags['api-port'] || 58900), webPort = Number(flags['web-port'] || 58901);
const out = path.resolve(flags.out || path.join(root, 'output/playwright', `bugfix-stage1-${flags['task-id']}-${Date.now()}`));
assert.ok(out.startsWith(path.join(root, 'output') + path.sep), 'evidence must be within this worktree output');
assert.ok(!fs.existsSync(out), 'do not overwrite an earlier attempt');
fs.mkdirSync(out, { recursive: true });
const receipt = { taskId: flags['task-id'], worktree: root, apiPort, webPort, out, status: 'RUNNING', cli: [] };
const bounded = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
  if (r.error || r.signal) throw r.error || new Error(`${cmd}: ${r.signal}`); return r;
};
const cloneParent = '/private/var/folders/pt/kwyn99lj5gn2g1n3xhc2xfxh0000gn/X/com.google.Chrome.code_sign_clone';
const clones = () => fs.existsSync(cloneParent) ? fs.readdirSync(cloneParent).filter(name => name.startsWith('code_sign_clone.')).sort() : [];
const protectedProcesses = () => [7081, 67464].map(pid => processIdentity(pid));
receipt.clonesBefore = clones(); receipt.protectedBefore = protectedProcesses();
for (const port of [apiPort, webPort]) await new Promise((resolve, reject) => {
  const probe = net.createServer(); probe.on('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve));
});
const config = path.join(root, 'scripts/resources/playwright-cli.config.json');
const feature = JSON.parse(fs.readFileSync(config)).browser.launchOptions.args.find(arg => arg.startsWith('--disable-features='));
assert.ok(feature.includes('MacAppCodeSignClone'));
const session = await ResourceSession.create({ taskId: flags['task-id'], projectRoot: root, tempParent: '/tmp',
  limits: { leaseMs: 900000, logBytes: 8388608, directoryBytes: 536870912 } });
receipt.instanceId = session.instanceId; receipt.registryPath = session.registryPath;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failure;
try {
  const dbDir = await session.allocateDir('synthetic-sqlite');
  const dbPath = path.join(dbDir, 'stage1.sqlite');
  const api = await session.startProcess({ label: 'stage1-api', kind: 'api', role: 'api', command: process.execPath,
    args: [path.join(root, 'scripts/bugfix-stage1/api.js')], cwd: root, port: apiPort, datadir: dbDir,
    env: { PATH: process.env.PATH, DB_DRIVER: 'sqlite', DB_PATH: dbPath, DEMO_SEED: '0', PORT: String(apiPort),
      LLM_API_KEY: '', LLM_BASE_URL: '', LLM_MODEL: '', ENVIRONMENT_MODE: 'unavailable', ENVIRONMENT_LIVE: '0',
      STAGE25_SCHEDULER_ENABLED: '0', AUTH_SECRET: 'stage1-isolated-synthetic-only', HAIYU_RESOURCE_MANAGED: '1' } });
  const deadline = Date.now() + 8000;
  let ready;
  while (Date.now() < deadline) {
    const log = await session.rpc({ op: 'log-tail', id: api.id, maxBytes: 4096 });
    const match = log.tail?.match(/STAGE1_READY:(.*)/) || log.tail?.match(/STAGE1_READY (\{.*\})/);
    if (match) { ready = JSON.parse(match[1]); break; } await sleep(75);
  }
  assert.ok(ready, 'isolated synthetic API must initialize through normal health APIs'); receipt.fixture = ready;
  const cache = await session.allocateDir('vite-cache');
  const vite = await session.startProcess({ label: 'stage1-vite', kind: 'vite', role: 'vite', command: process.execPath,
    args: [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'],
    cwd: path.join(root, 'web'), port: webPort,
    env: { PATH: process.env.PATH, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`, WEB_PORT: String(webPort),
      HAIYU_RESOURCE_MANAGED: '1', HAIYU_VITE_CACHE_DIR: cache } });
  let webReady = false;
  for (let index = 0; index < 80; index++) {
    try { if ((await fetch(`http://127.0.0.1:${webPort}`)).ok) { webReady = true; break; } } catch {}
    await sleep(75);
  }
  assert.ok(webReady, 'Vite ready');
  const browserDir = await session.allocateDir('browser');
  const playwrightModule = path.resolve(flags['playwright-module'] || '/Users/wangshanchong/.npm/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs');
  assert.ok(fs.existsSync(playwrightModule), 'existing Playwright library required; no installation fallback');
  const flowPath = path.join(browserDir, 'flow.js');
  fs.writeFileSync(flowPath, fs.readFileSync(path.join(root, 'scripts/bugfix-stage1/browser-flow.js'), 'utf8')
    .replace('__CONFIG__', JSON.stringify({ web: `http://127.0.0.1:${webPort}`, date: ready.date, out })));
  const browserConfig = path.join(browserDir, 'config.json');
  fs.writeFileSync(browserConfig, JSON.stringify({ playwrightModule, profile: path.join(browserDir, 'profile'),
    launchConfig: config, flowPath, out }));
  const result = await session.runProcess({ label: 'stage1-browser', kind: 'browser', role: 'browser', command: process.execPath,
    args: [path.join(root, 'scripts/bugfix-stage1/browser-driver.js')], cwd: root,
    env: { PATH: process.env.PATH, STAGE1_BROWSER_CONFIG: browserConfig }
  }, { timeoutMs: 30000 });
  receipt.browserExit = { status: result.status, exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut };
  assert.equal(result.exitCode, 0, result.tail);
  receipt.business = JSON.parse(fs.readFileSync(path.join(out, 'browser-result.json')));
  receipt.chrome = JSON.parse(fs.readFileSync(path.join(out, 'browser-identity.json')));
  assert.equal(processMatches(receipt.chrome.pid, receipt.chrome), false, 'exact task Chrome identity exited');
  receipt.chromeExited = true;
  const sql = new DatabaseSync(dbPath, { readOnly: true });
  receipt.sql = {
    orders: sql.prepare('SELECT id,guest_id,status,menu_version FROM meal_orders').all(),
    reviews: sql.prepare('SELECT guest_id,status,reviewed_by,review_note FROM meal_restriction_reviews').all(),
    checks: sql.prepare('SELECT order_id,checked_by,note FROM meal_order_checks').all(),
    audit: sql.prepare("SELECT action,COUNT(*) AS count FROM audit_logs WHERE action IN ('meal.order.review','meal.order.status','meal.restriction.resolve') GROUP BY action").all()
  }; sql.close();
  assert.equal(receipt.sql.orders[0].id, receipt.business.objects.order.id);
  assert.equal(receipt.sql.orders[0].status, 'preparing');
  assert.equal(receipt.sql.audit.find(row => row.action === 'meal.order.review').count, 1);
  assert.equal(receipt.sql.audit.find(row => row.action === 'meal.order.status').count, 1);
  void vite;
} catch (error) { failure = error; receipt.error = error.stack || error.message; }
finally {
  try {
    const state = await session.status();
    for (const resource of [...state.resources].reverse()) {
      if (['running', 'starting'].includes(resource.status)) {
        await session.stop(resource.id, 'stage1-finish');
        await session.waitProcess(resource.id, 3000);
      }
    }
    receipt.cleanup = await session.close('stage1-complete');
    receipt.tempRemoved = !fs.existsSync(session.tempDir);
    assert.equal(receipt.cleanup.ok, true); assert.equal(receipt.tempRemoved, true);
    receipt.clonesAfter = clones(); receipt.protectedAfter = protectedProcesses();
    assert.deepEqual(receipt.clonesAfter, receipt.clonesBefore);
    assert.deepEqual(receipt.protectedAfter.map(item => item?.fingerprint), receipt.protectedBefore.map(item => item?.fingerprint));
    receipt.resourceResult = 'PASS';
  } catch (error) { receipt.resourceResult = 'FAIL'; receipt.cleanupError = error.stack || error.message; failure ||= error; }
  receipt.status = failure ? 'FAIL' : 'PASS';
  fs.writeFileSync(path.join(out, 'business.json'), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ status: receipt.status, resourceResult: receipt.resourceResult, evidence: path.join(out, 'business.json'),
  assertions: receipt.business?.assertions.length || 0, error: receipt.error || receipt.cleanupError || null }));
if (failure) process.exitCode = 1;
