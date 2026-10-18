import fs from 'node:fs';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const cfg = JSON.parse(fs.readFileSync(process.argv[2]));
assert.ok(cfg.profile.startsWith('/tmp/haiyu-resource-'));
const { chromium } = await import(pathToFileURL(cfg.playwrightModule).href);
const launch = JSON.parse(fs.readFileSync(cfg.launchConfig)).browser.launchOptions;
const proof = { status: 'RUNNING', headless: true, browserContexts: 1, pages: 1, checks: [], http: [], screenshots: 0, trace: false, video: false };
const save = () => fs.writeFileSync(cfg.proof, JSON.stringify(proof, null, 2));
const check = (value, message) => { assert.ok(value, message); proof.checks.push(message); save(); };
let context;
try {
  context = await chromium.launchPersistentContext(cfg.profile, { ...launch, headless: true, viewport: { width: 1440, height: 900 } });
  const page = context.pages()[0] || await context.newPage(); page.setDefaultTimeout(5000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === cfg.web || ['data:', 'blob:'].includes(url.protocol) ? route.continue() : route.abort();
  });
  await page.addInitScript(() => {
    for (const storage of [localStorage, sessionStorage]) {
      storage.setItem('community_token', 'legacy-forged-token');
      storage.setItem('community_user', JSON.stringify({ id: 'forged', role: 'dean', name: 'forged' }));
    }
  });
  async function invisible(label) {
    const state = await page.evaluate(() => ({ cookie: document.cookie,
      legacy: [localStorage, sessionStorage].some(storage => storage.getItem('community_token') !== null || storage.getItem('community_user') !== null) }));
    check(!state.cookie.includes('haiyu_session') && !state.legacy, label + ': JS cannot read session cookie; legacy storage cleared');
  }
  async function native(route, action, expected = 200) {
    const waiting = page.waitForResponse(r => new URL(r.url()).pathname === '/api' + route && r.request().method() === 'POST');
    await action(); const response = await waiting; const data = await response.json();
    const headers = response.request().headers();
    proof.http.push({ route, status: response.status(), origin: headers.origin,
      protection: headers['x-community-request'] === '1', bearerHeader: Boolean(headers.authorization), bodyHasToken: Object.hasOwn(data, 'token') });
    check(response.status() === expected && !Object.hasOwn(data, 'token'), route + ': native cookie response successful without token body');
    check(headers.origin === cfg.web && headers['x-community-request'] === '1' && !headers.authorization, route + ': real browser Origin and protection header, no Bearer');
    return data;
  }
  await page.goto(cfg.web); await page.getByRole('button', { name: /^我是客人/ }).first().waitFor();
  check(await page.locator('.app-shell').count() === 0, 'forged cached dean cannot enter workspace'); await invisible('anonymous initial');
  await page.getByRole('button', { name: /^我是客人/ }).first().click();
  await page.getByLabel('账号', { exact: true }).fill('g12_browser');
  await page.getByLabel('密码', { exact: true }).fill('Synthetic-G12-123');
  await native('/auth/login', () => page.getByRole('button', { name: '进入工作区', exact: false }).click());
  await page.locator('.app-shell').waitFor();
  let cookie = (await context.cookies()).find(c => c.name === 'haiyu_session');
  check(cookie?.httpOnly && cookie.sameSite === 'Lax' && !cookie.secure && cookie.path === '/' && cookie.domain === '127.0.0.1', 'actual browser cookie is HttpOnly host-only Lax and usable over development HTTP');
  proof.cookieAttributes = { httpOnly: cookie.httpOnly, sameSite: cookie.sameSite, secure: cookie.secure, path: cookie.path, domain: cookie.domain, expiresInSeconds: Math.round(cookie.expires - Date.now() / 1000) };
  await invisible('after login');
  await page.reload(); await page.locator('.app-shell').waitFor();
  check((await page.locator('.user-menu').innerText()).includes('合成G12浏览器客人'), 'refresh restores actual guest from /me'); await invisible('after refresh');
  await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button', { name: '我的', exact: true }).click();
  await page.locator('.guest-my-entry').filter({ hasText: '我的档案' }).click();
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await page.getByLabel('当前密码', { exact: true }).fill('Synthetic-G12-123');
  await page.getByLabel('新密码（至少 8 位）', { exact: true }).fill('Synthetic-G12-456');
  await native('/me/password', () => page.getByRole('button', { name: '确认修改', exact: true }).click());
  const renewed = (await context.cookies()).find(c => c.name === 'haiyu_session');
  check(renewed?.httpOnly && renewed.value !== cookie.value, 'password change renews current HttpOnly cookie'); cookie = null;
  const me = await page.evaluate(async () => { const r = await fetch('/api/me', { credentials: 'same-origin' }); return { status: r.status, data: await r.json() }; });
  check(me.status === 200 && me.data.id === 'g12-browser-guest', 'actual request after password change succeeds');
  await page.reload(); await page.locator('.app-shell').waitFor(); await invisible('after password change and reload');
  await native('/auth/logout', () => page.getByRole('button', { name: '退出', exact: true }).click());
  await page.getByRole('button', { name: /^我是客人/ }).first().waitFor();
  check(!(await context.cookies()).some(c => c.name === 'haiyu_session'), 'actual browser removes cookie after backend logout');
  check(new URL(page.url()).hash === '', 'logout clears old workspace deep link');
  await page.reload(); await page.getByRole('button', { name: /^我是客人/ }).first().waitFor();
  check(await page.locator('.app-shell').count() === 0, 'refresh after logout stays signed out');
  const status = await page.evaluate(async () => (await fetch('/api/me', { credentials: 'same-origin' })).status);
  check(status === 401, '/me is 401 after actual cookie removal'); await invisible('after logout refresh');
  proof.status = 'PASS';
} catch (error) { proof.status = 'FAIL'; proof.error = error.stack; process.exitCode = 1; }
finally { if (context) await context.close(); proof.contextClosed = true; save(); }
console.log(JSON.stringify({ status: proof.status, checks: proof.checks.length, contextClosed: proof.contextClosed }));
