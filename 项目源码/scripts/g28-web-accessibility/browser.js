import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const cfg = JSON.parse(fs.readFileSync(process.argv[2]));
const { chromium } = await import(pathToFileURL(cfg.playwrightModule).href);
const launch = JSON.parse(fs.readFileSync(cfg.launchConfig)).browser.launchOptions;
const proof = { status: 'RUNNING', journey: cfg.journey, measurements: [], checks: [], writes: [], screenshots: [],
  nativeBrowserZoom: 'NOT_TESTED: effective CSS viewport halved for reflow only; deviceScaleFactor unchanged', externalBlocked: [], trace: false, video: false };
const save = () => fs.writeFileSync(cfg.proof, JSON.stringify(proof, null, 2));
function check(value, text) { assert.ok(value, text); proof.checks.push(text); save(); }
let context;
try {
  context = await chromium.launchPersistentContext(cfg.profile, { ...launch, headless: true, viewport: { width: 1440, height: 1000 } });
  const page = context.pages()[0] || await context.newPage(); page.setDefaultTimeout(4000);
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === cfg.web || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    proof.externalBlocked.push(url.origin); return route.abort();
  });
  page.on('response', async response => {
    const request = response.request();
    if (['GET', 'HEAD'].includes(request.method())) return;
    const pathname = new URL(response.url()).pathname;
    proof.writes.push({ path: pathname, method: request.method(), status: response.status(),
      protection: request.headers()['x-community-request'] === '1', bearer: Boolean(request.headers().authorization), body: request.postDataJSON() });
    save();
  });
  async function shot(name) {
    const file = path.join(cfg.out, name + '.png'); assert.ok(!fs.existsSync(file));
    await page.screenshot({ path: file }); proof.screenshots.push({ file, bytes: fs.statSync(file).size }); save();
  }
  async function measure(label, width = 1440) {
    await page.setViewportSize({ width, height: width === 720 ? 500 : 1000 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(() => {
      const rgba = text => (text.match(/[\d.]+/g) || []).map(Number);
      const blend = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)); };
      const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((n, v, i) => n + v * [.2126, .7152, .0722][i], 0);
      const ratio = (a, b) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      function backgrounds(el) {
        if (!el) return [[255, 255, 255]];
        const style = getComputedStyle(el);
        const below = backgrounds(el.parentElement);
        let paints = [rgba(style.backgroundColor)];
        if (style.backgroundImage.startsWith('linear-gradient')) {
          // Conservative worst stop, composited through ancestors; not an inferred solid white background.
          paints = (style.backgroundImage.match(/rgba?\([^)]+\)/g) || []).map(rgba);
        }
        return below.flatMap(bg => paints.map(fg => blend(fg, bg)));
      }
      const samples = [], failures = [], controls = [], fontFailures = [];
      for (const el of document.querySelectorAll('body *')) {
        if (el.closest('svg,[aria-hidden="true"],.sr-only,.banner-orb,.staff-symbol,.sun,.wave,.about-number,.hero-scroll,.feature-symbol,.login-quote>span')) continue;
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        if (el.closest(':disabled,[aria-disabled="true"]')) continue;
        const modal = document.querySelector('dialog:modal');
        if (modal && !modal.contains(el)) continue;
        const style = getComputedStyle(el), rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        if (el.matches('button,input:not([type="checkbox"]):not([type="radio"]),select,textarea,summary')) {
          controls.push({ tag: el.tagName, name: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim().slice(0, 70), height: rect.height, width: rect.width, font: parseFloat(style.fontSize) });
        }
        const text = [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join('').trim();
        if (!text) continue;
        const fg = rgba(style.color), bgs = backgrounds(el);
        const contrast = Math.min(...bgs.map(bg => ratio(blend(fg, bg), bg)));
        const sample = { tag: el.tagName, class: el.className, text: text.slice(0, 90), font: parseFloat(style.fontSize), lineHeight: style.lineHeight,
          color: style.color, backgrounds: bgs, contrast: Math.round(contrast * 100) / 100 };
        samples.push(sample);
        if (contrast < 4.5) failures.push(sample);
        if (sample.font < 14) fontFailures.push(sample);
      }
      const workspace = document.querySelector('.workspace');
      return { viewport: innerWidth, document: document.documentElement.scrollWidth, workspace: workspace?.getBoundingClientRect().width ?? null,
        normalTextSamples: samples.length, minContrast: Math.min(...samples.map(s => s.contrast)), minFont: Math.min(...samples.map(s => s.font)), contrastFailures: failures, fontFailures,
        targetFailures: controls.filter(c => c.height < 43.9 || c.width < 43.9),
        samples: samples.filter(s => /page-title|release-boundary|assistant|environment|mood|org-state|metric|side-nav|privacy|user-menu|meal|query-state|form-lead/.test(s.class)).slice(0, 50), controls: controls.slice(0, 35) };
    });
    proof.measurements.push({ label, ...result }); save();
    check(result.document <= width + 1, label + ': no document horizontal overflow');
    check(result.fontFailures.length === 0, label + ': rendered normal text at least 14px');
    check(result.targetFailures.length === 0, label + ': visible enabled controls at least 44px');
    check(result.contrastFailures.length === 0, label + ': composited normal text contrast at least 4.5:1');
  }
  async function navigate(section, heading) {
    await page.evaluate(next => { location.hash = next; }, section);
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  }
  async function confirmFlow(trigger, title, buttonName, expectedPath, expectedMethod, screenshot = false) {
    const before = proof.writes.length;
    await trigger.focus(); await trigger.click();
    const dialog = page.getByRole('dialog', { name: title }); await dialog.waitFor();
    check(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(el => el === document.activeElement), title + ': safe initial focus');
    await page.keyboard.press('Shift+Tab');
    check(await dialog.getByRole('button', { name: buttonName, exact: true }).evaluate(el => el === document.activeElement), title + ': reverse Tab wrap');
    await page.keyboard.press('Tab');
    check(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate(el => el === document.activeElement), title + ': forward Tab wrap');
    const hash = new URL(page.url()).hash;
    await page.getByRole('navigation', { name: '工作区导航' }).getByRole('button').first().evaluate(el => el.focus());
    check(await dialog.evaluate(el => el.contains(document.activeElement)), title + ': native modal blocks background focus');
    check(new URL(page.url()).hash === hash && proof.writes.length === before, title + ': opening made zero writes');
    if (screenshot) { await measure('guest-confirm-1024', 1024); await shot('guest-confirm-1024'); }
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    check(await trigger.evaluate(el => el === document.activeElement), title + ': focus returned after Escape');
    check(proof.writes.length === before, title + ': cancel made zero writes');
    await trigger.click();
    const response = page.waitForResponse(r => new URL(r.url()).pathname === expectedPath && r.request().method() === expectedMethod);
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: buttonName, exact: true }).click();
    check((await response).ok(), title + ': confirmed real synthetic request succeeded');
    await page.getByRole('dialog', { name: title }).waitFor({ state: 'hidden' });
    const writes = proof.writes.slice(before).filter(w => w.path === expectedPath);
    check(writes.length === 1 && writes[0].protection && !writes[0].bearer, title + ': one Cookie/CSRF-protected write');
  }
  await page.goto(cfg.web);
  await page.getByRole('button', { name: /^我是客人/ }).first().waitFor();
  if (cfg.journey === 'guest' && !cfg.focus) await measure('public-home');
  await page.getByRole('button', { name: cfg.journey === 'guest' ? /^我是客人/ : /^我是工作人员/ }).first().click();
  await page.getByLabel('账号', { exact: true }).waitFor();
  if (cfg.journey === 'guest' && !cfg.focus) { await measure('login'); await shot('login-1440-final'); }
  await page.getByLabel('账号', { exact: true }).fill(cfg.journey === 'guest' ? 'g28-guest' : 'g28-admin');
  await page.getByLabel('密码', { exact: true }).fill('Synthetic-G28-123');
  await page.getByRole('button', { name: /进入工作区/ }).click();
  await page.locator('.workspace .page-title').waitFor();
  await page.locator('.assistant-fab').waitFor();
  if (cfg.focus === 'reflow') {
    await navigate('meals', '每日膳食'); await page.locator('.meal-item').first().waitFor();
    await measure('generated-meals-1440'); await measure('generated-meals-effective-200-percent', 720);
    await navigate('reservations', '我的预约');
    const trigger = page.getByRole('button', { name: '取消预约', exact: true }).first();
    await trigger.focus(); await trigger.click();
    const dialog = page.getByRole('dialog', { name: '取消预约' });
    await measure('confirmation-effective-200-percent', 720);
    const before = proof.writes.length;
    await dialog.evaluate(el => { el.querySelector('p').textContent += ' 合成长描述用于滚动验收。'.repeat(150); });
    check(await dialog.evaluate(el => el.scrollHeight > el.clientHeight && el.getBoundingClientRect().height <= innerHeight - 30), 'long modal body is bounded and scrolls inside 720 CSS px reflow');
    await dialog.getByRole('button', { name: '取消', exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    check(await dialog.getByRole('button', { name: '确认取消预约', exact: true }).evaluate(el => el === document.activeElement), 'long reflow modal keeps reverse Tab reachable');
    await page.keyboard.press('Tab'); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    check(await trigger.evaluate(el => el === document.activeElement), 'long reflow modal restores focus');
    check(proof.writes.length === before, 'long reflow modal Escape makes zero writes');
  } else if (cfg.journey === 'guest') {
    for (const width of [1024, 1440, 1920]) await measure('guest-overview-' + width, width);
    await measure('guest-overview-1440', 1440); if (!fs.existsSync(path.join(cfg.out, 'guest-1440.png'))) await shot('guest-1440');
    await page.locator('.assistant-fab').click(); await page.locator('.assistant-input input').waitFor();
    await page.locator('.assistant-window').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
    await measure('lazy-assistant-loaded'); await page.locator('.assistant-fab').click();
    await navigate('meals', '每日膳食'); await page.locator('.meal-toolbar').waitFor(); await measure('guest-meals');
    await navigate('schedule', '日程与疗程草案'); await measure('guest-schedule');
    await navigate('mood', '心情与陪伴'); await measure('guest-mood');
    await navigate('reservations', '我的预约');
    await confirmFlow(page.getByRole('button', { name: '取消预约', exact: true }).first(), '取消预约', '确认取消预约', '/api/reservations/g28-res', 'DELETE', true);
    await measure('guest-effective-200-percent', 720); await shot('guest-720-reflow');
  } else {
    for (const width of [1024, 1440, 1920]) await measure('lazy-staff-workbench-' + width, width);
    await navigate('staff-admin', '员工账号管理'); await page.getByText('合成G28教练', { exact: true }).waitFor();
    await measure('staff-accounts-1440'); await shot('staff-1440');
    const row = page.getByRole('row').filter({ hasText: '合成G28教练' });
    await confirmFlow(row.getByRole('button', { name: '停用', exact: true }), '停用员工账号', '确认停用', '/api/dean/staff/g28-coach', 'PATCH');
    await measure('staff-effective-200-percent', 720);
    await row.getByRole('button', { name: '重新启用', exact: true }).waitFor();
  }
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,command='], { encoding: 'utf8', timeout: 3000 });
  proof.chromeCommands = ps.stdout.split('\n').filter(line => line.includes('--user-data-dir=' + cfg.profile));
  check(proof.chromeCommands.length > 0 && proof.chromeCommands.every(line => line.includes('MacAppCodeSignClone')), 'actual owned Chrome launch has merged clone-disable flag');
  proof.cloneDuring = fs.existsSync(cfg.cloneParent) ? fs.readdirSync(cfg.cloneParent).filter(n => n.startsWith('code_sign_clone.')).sort() : [];
  check(proof.screenshots.reduce((n, s) => n + s.bytes, 0) <= 8388608, 'screenshot bytes bounded');
  proof.status = 'PASS';
} catch (error) { proof.status = 'FAIL'; proof.error = error.stack; process.exitCode = 1; }
finally { if (context) await context.close(); proof.contextClosed = true; save(); }
console.log(JSON.stringify({ status: proof.status, checks: proof.checks.length, measurements: proof.measurements.length, error: proof.error }));
