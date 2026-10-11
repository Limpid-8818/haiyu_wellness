async page => {
const assert = {
  equal(actual, expected, message) { if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`); },
  ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); },
  includes(actual, expected, message) { if (!String(actual).includes(expected)) throw new Error(`${message}: missing ${expected}`); }
};
const webUrl = __WEB_URL__;
const screenshots = __SCREENSHOTS__;
const fixtures = __FIXTURES__;
const pageErrors = [];
const consoleErrors = [];
const externalRequests = [];
const failedRequests = [];
page.setDefaultTimeout(25_000);
page.setDefaultNavigationTimeout(25_000);
page.on('pageerror', error => pageErrors.push(String(error.message || error).slice(0, 500)));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 500)); });
page.on('requestfailed', request => failedRequests.push({ url: request.url().slice(0, 500), error: request.failure()?.errorText || 'unknown' }));
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (['data:', 'blob:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
  externalRequests.push({ origin: url.origin, type: route.request().resourceType() });
  return route.abort();
});

async function enterGuest() {
  await page.getByRole('button', { name: /我是客人/ }).first().click();
  await page.getByLabel('账号').fill(fixtures.username);
  await page.getByLabel('密码').fill('guest2026');
  await page.getByRole('button', { name: /进入工作区/ }).click();
  await page.getByTestId('stage25-daily-brief').waitFor({ state: 'visible' });
  await page.getByTestId('stage25-notification-center').waitFor({ state: 'visible' });
}

async function captureHomeWidths() {
  const layout = [];
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.waitForTimeout(150);
    const state = await page.evaluate(() => ({ viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
    assert.ok(state.documentWidth <= width && state.bodyWidth <= width,
      `home at ${width}px has no horizontal clipping: ${JSON.stringify(state)}`);
    layout.push({ page: 'daily-brief-home', ...state });
    const screenshotPath = width === 1280 ? screenshots.home1280 : screenshots.home1920;
    await page.screenshot({ path: screenshotPath, fullPage: true });
  }
  return layout;
}

await page.addInitScript(({ frozenAt }) => {
  const instant = Date.parse(frozenAt);
  const NativeDate = Date;
  class FrozenDate extends NativeDate { constructor(...args) { super(...(args.length ? args : [instant])); } static now() { return instant; } }
  Object.defineProperty(globalThis, 'Date', { configurable: true, writable: true, value: FrozenDate });
}, { frozenAt: fixtures.businessClockNow });
await page.setViewportSize({ width: 1280, height: 1080 });
await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
await enterGuest();
const brief = page.getByTestId('stage25-daily-brief');
await brief.getByText(fixtures.guestName, { exact: false }).waitFor({ state: 'visible' });
const briefText = await brief.innerText();
assert.includes(briefText, '入住第 3 天', 'brief day number comes from actual stay dates');
assert.includes(briefText, fixtures.activityName, 'brief displays actual confirmed activity');
assert.includes(briefText, fixtures.adviceTitle, 'brief displays actual published advice');
assert.includes(briefText, fixtures.moodFocusId, 'brief exposes the three-day care source ID');
assert.includes(briefText, fixtures.correctionEventId, 'brief exposes the actual correction event ID');
assert.includes(briefText, fixtures.environmentSourceId, 'brief exposes the environment source ID');
assert.includes(briefText, fixtures.dinnerLabel, 'brief displays the actual saved dinner order');
const activityRow = brief.locator(`[data-source-id="${fixtures.activityId}"]`);
await activityRow.waitFor({ state: 'visible' });
const layout = await captureHomeWidths();

const centerFirst = page.locator('.stage25-notification-list li').first();
await centerFirst.waitFor({ state: 'visible' });
const centerIdentity = await centerFirst.evaluate(node => ({ id: node.dataset.notificationId, sourceId: node.dataset.sourceId,
  targetType: node.dataset.targetType, targetId: node.dataset.targetId, targetUrl: node.dataset.targetUrl,
  message: node.querySelector('strong')?.textContent || '' }));
const chatMessagesBefore = await page.locator('.assistant-message').count();
await page.getByRole('button', { name: '打开智能助手' }).click();
const assistantNotice = page.getByTestId('stage25-assistant-notice');
await assistantNotice.waitFor({ state: 'visible' });
const assistantIdentity = await assistantNotice.evaluate(node => ({ id: node.dataset.notificationId, sourceId: node.dataset.sourceId,
  targetType: node.dataset.targetType, targetId: node.dataset.targetId, targetUrl: node.dataset.targetUrl,
  message: node.querySelector('strong')?.textContent || '' }));
assert.equal(JSON.stringify(assistantIdentity), JSON.stringify(centerIdentity), 'assistant doorway and notification center share the exact event and target');
assert.equal(await page.locator('.assistant-message').count(), chatMessagesBefore, 'notification is not added to persistent chat messages');
const initialChatMessages = await page.locator('.assistant-message').allInnerTexts();
assert.equal(initialChatMessages.some(text => text.includes(centerIdentity.message)), false,
  'notification content does not become an assistant chat message');

for (let reload = 0; reload < 2; reload += 1) {
  await page.getByRole('button', { name: '关闭智能助手' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId(`stage25-notice-${centerIdentity.id}`).waitFor({ state: 'visible' });
  const count = await page.locator('.stage25-notification-list li').filter({ has: page.getByText(centerIdentity.message, { exact: true }) }).count();
  assert.equal(count, 1, `notification center contains one source event after reload ${reload + 1}`);
  await page.getByRole('button', { name: '打开智能助手' }).click();
  await page.getByTestId('stage25-assistant-notice').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.assistant-message').count(), chatMessagesBefore, `chat history remains unchanged after reload ${reload + 1}`);
  const identity = await page.getByTestId('stage25-assistant-notice').evaluate(node => ({ id: node.dataset.notificationId,
    sourceId: node.dataset.sourceId, targetType: node.dataset.targetType, targetId: node.dataset.targetId,
    targetUrl: node.dataset.targetUrl, message: node.querySelector('strong')?.textContent || '' }));
  assert.equal(JSON.stringify(identity), JSON.stringify(centerIdentity), `assistant notice identity survives reload ${reload + 1}`);
}

await page.getByTestId('stage25-assistant-notice').getByRole('button', { name: '标为已读' }).click();
await page.locator(`[data-testid="stage25-notice-${centerIdentity.id}"].read`).waitFor({ state: 'visible' });
assert.equal(await page.getByTestId('stage25-assistant-notice').getByRole('button', { name: '标为已读' }).count(), 0,
  'read state is synchronized to the assistant doorway');

const cdp = await page.context().newCDPSession(page);
await cdp.send('Browser.setPermission', { origin: new URL(webUrl).origin,
  permission: { name: 'notifications' }, setting: 'granted' });
assert.equal(await page.evaluate(() => Notification.permission), 'granted', 'isolated browser granted the native Notification API permission');
await page.getByTestId('stage25-assistant-notice').getByRole('button', { name: '开启浏览器提醒' }).click();
await page.getByText('浏览器提醒已显示', { exact: false }).waitFor({ state: 'visible' });
const grantedPermission = await page.evaluate(() => Notification.permission);
assert.equal(grantedPermission, 'granted');
const grantedStatus = await page.getByTestId('stage25-assistant-notice').innerText();
assert.includes(grantedStatus, '浏览器提醒已显示', 'user click invokes the browser Notification constructor path');

await cdp.send('Browser.setPermission', { origin: new URL(webUrl).origin,
  permission: { name: 'notifications' }, setting: 'denied' });
assert.equal(await page.evaluate(() => Notification.permission), 'denied', 'isolated browser denied the native Notification API permission');
await page.getByTestId('stage25-assistant-notice').getByRole('button', { name: '开启浏览器提醒' }).click();
await page.getByText('浏览器通知未获允许', { exact: false }).waitFor({ state: 'visible' });
const deniedPermission = await page.evaluate(() => Notification.permission);
assert.equal(deniedPermission, 'denied');
assert.equal(await page.locator(`[data-testid="stage25-notice-${centerIdentity.id}"]`).count(), 1,
  'denied browser permission leaves the in-app notification available');
const permissionPaths = [{ permission: grantedPermission, userClickRequired: true, apiPath: 'Notification constructor executed' },
  { permission: deniedPermission, userClickRequired: true, apiPath: 'denied; in-app notice retained' }];
await cdp.detach();

await page.getByRole('button', { name: '关闭智能助手' }).click();
await page.getByTestId(`stage25-activity-schedule`).getByRole('button', { name: `查看预约 ${fixtures.activityId}` }).click();
await page.getByRole('heading', { name: '我的预约', exact: true }).waitFor({ state: 'visible' });
await page.getByText(fixtures.activityId, { exact: false }).waitFor({ state: 'visible' });
assert.includes(await page.locator('body').innerText(), fixtures.activityId, 'brief activity link opens the actual reservation');
await page.getByRole('button', { name: '管家', exact: true }).click();
await page.getByTestId('stage25-daily-brief').waitFor({ state: 'visible' });
await page.getByTestId('stage25-meal-schedule').getByRole('button', { name: '查看膳食' }).last().click();
await page.getByRole('heading', { name: '每日膳食', exact: true }).waitFor({ state: 'visible' });
await page.getByText(fixtures.mealOrderId, { exact: false }).waitFor({ state: 'visible' });
assert.includes(await page.locator('body').innerText(), fixtures.mealOrderId, 'brief meal link opens the actual saved meal order');

await page.getByRole('button', { name: '退出登录' }).click();
await page.getByRole('button', { name: /我是工作人员/ }).first().click();
await page.getByLabel('账号').fill('staff_demo');
await page.getByLabel('密码').fill('staff2026');
await page.getByRole('button', { name: /进入工作区/ }).click();
await page.getByRole('button', { name: '我负责的客人', exact: true }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '我负责的客人', exact: true }).click();
const staffTasks = page.getByTestId('stage25-staff-care-tasks');
await staffTasks.waitFor({ state: 'visible' });
const moodTask = staffTasks.locator(`li[data-source-id=${JSON.stringify(String(fixtures.moodFocusId))}]`);
const correctionTask = staffTasks.locator(`li[data-source-id=${JSON.stringify(String(fixtures.correctionEventId))}]`);
await moodTask.waitFor({ state: 'visible' });
await correctionTask.waitFor({ state: 'visible' });
assert.equal(await moodTask.count(), 1, 'assigned clinician sees one mood follow-up task for its exact source ID');
assert.equal(await correctionTask.count(), 1, 'assigned clinician sees one correction follow-up task for its exact source ID');
const staffTaskText = await staffTasks.innerText();
assert.includes(staffTaskText, fixtures.moodFocusId, 'assigned clinician sees the mood follow-up source ID');
assert.includes(staffTaskText, fixtures.correctionEventId, 'assigned clinician sees the corrected-plan source ID');
assert.includes(staffTaskText, fixtures.guestName, 'assigned clinician sees the correct guest name');
await staffTasks.screenshot({ path: screenshots.staffTasks });

assert.equal(pageErrors.length, 0, `browser page errors: ${JSON.stringify(pageErrors)}`);
const allowedFontOrigins = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const unexpectedExternal = [...new Set(externalRequests.map(item => item.origin))].filter(origin => !allowedFontOrigins.includes(origin));
assert.equal(unexpectedExternal.length, 0, `unexpected external browser requests: ${unexpectedExternal.join(', ')}`);
const unexpectedFailed = failedRequests.filter(item => !allowedFontOrigins.some(origin => item.url.startsWith(origin)));
assert.equal(unexpectedFailed.length, 0, `unexpected failed browser requests: ${JSON.stringify(unexpectedFailed)}`);
const unexpectedConsole = consoleErrors.filter(value => !/fonts\.(?:googleapis|gstatic)\.com|ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(value));
assert.equal(unexpectedConsole.length, 0, `unexpected console errors: ${JSON.stringify(unexpectedConsole)}`);
const result = { status: 'PASS', guestId: fixtures.guestId, guestName: fixtures.guestName,
  briefId: fixtures.briefId, firstNotificationId: centerIdentity.id, notificationSourceId: centerIdentity.sourceId,
  notificationTarget: { type: centerIdentity.targetType, id: centerIdentity.targetId, url: centerIdentity.targetUrl },
  targetActivityId: fixtures.activityId, mealOrderId: fixtures.mealOrderId, moodFocusId: fixtures.moodFocusId,
  correctionEventId: fixtures.correctionEventId, permissionPaths, layout, screenshots: Object.values(screenshots),
  pageErrors, unexpectedExternal, failedRequests: failedRequests.slice(0, 20),
  readStateSynchronized: true, repeatedReloads: 2,
  chatMessagesBefore: chatMessagesBefore, chatMessagesAfter: await page.locator('.assistant-message').count() };
await page.evaluate(value => { document.title = 'STAGE25_BROWSER_RESULT:' + JSON.stringify(value); }, result);
return result;
}
