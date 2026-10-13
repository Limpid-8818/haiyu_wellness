import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { processIdentity } from '../resources/resource-runtime.js';
const cfg = JSON.parse(fs.readFileSync(process.env.STAGE1_BROWSER_CONFIG));
assert.ok(cfg.profile.startsWith('/tmp/haiyu-resource-'));
const { chromium } = await import(pathToFileURL(cfg.playwrightModule).href);
const launch = JSON.parse(fs.readFileSync(cfg.launchConfig)).browser.launchOptions;
const context = await chromium.launchPersistentContext(cfg.profile, { ...launch, viewport: { width: 1440, height: 900 } });
const external = [];
try {
  const ps = spawnSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 });
  assert.equal(ps.status, 0);
  const identities = ps.stdout.split('\n').filter(row => /\/Google Chrome$/.test(row)).map(row => {
    const pid = Number(row.trim().split(/\s/)[0]);
    const identity = processIdentity(pid);
    const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 128 * 1024 }).stdout.trim();
    return identity ? { ...identity, command } : null;
  }).filter(identity => identity?.command.includes(`--user-data-dir=${cfg.profile}`));
  assert.equal(identities.length, 1);
  const flag = launch.args.find(arg => arg.startsWith('--disable-features='));
  assert.ok(identities[0].command.includes(flag));
  fs.writeFileSync(path.join(cfg.out, 'browser-identity.json'), JSON.stringify(identities[0], null, 2));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost'].includes(url.hostname) || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    external.push(url.origin); return route.abort();
  });
  const page = context.pages()[0] || await context.newPage();
  const flowText = fs.readFileSync(cfg.flowPath, 'utf8');
  const flow = Function('return ' + flowText)();
  const business = await flow(page);
  assert.deepEqual(external, [], 'no external browser requests');
  fs.writeFileSync(path.join(cfg.out, 'browser-result.json'), JSON.stringify({ ...business, externalRequests: external }, null, 2));
} catch (error) {
  const page = context.pages()[0];
  if (page) {
    await page.screenshot({ path: path.join(cfg.out, 'failure.png') }).catch(() => {});
    fs.writeFileSync(path.join(cfg.out, 'failure-visible.txt'), (await page.locator('body').innerText().catch(() => '')).slice(-20000));
  }
  throw error;
} finally { await context.close(); }
