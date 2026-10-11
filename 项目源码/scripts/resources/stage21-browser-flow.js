async page => {
const assert = {
  equal(actual, expected, message) { if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`); },
  deepEqual(actual, expected, message) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); },
  ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); },
  includes(actual, expected, message) { if (!String(actual).includes(expected)) throw new Error(`${message}: missing ${expected}`); }
};
const webUrl = __WEB_URL__;
const screenshots = __SCREENSHOTS__;
const fixtureBookings = __FIXTURE_BOOKINGS__;
const pageErrors = [];
const consoleMessages = [];
const blockedRequests = [];
const failedRequests = [];
const draftResponses = [];
page.setDefaultTimeout(20000);
page.setDefaultNavigationTimeout(20000);
page.on('pageerror', error => pageErrors.push(String(error.message || error).slice(0, 500)));
page.on('console', message => {
  if (message.type() === 'error' || message.type() === 'warning') consoleMessages.push({ type: message.type(), text: message.text().slice(0, 500) });
});
page.on('requestfailed', request => {
  const url = request.url();
  let origin = 'invalid-url';
  try { origin = new URL(url).origin; } catch { /* bounded invalid URL marker */ }
  failedRequests.push({ origin, error: request.failure()?.errorText || 'unknown', url: url.slice(0, 500) });
});
page.on('response', response => {
  if (response.request().method() === 'POST' && response.url().endsWith('/api/me/therapy-drafts')) {
    void response.json().then(data => draftResponses.push(data)).catch(() => {});
  }
});
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.protocol === 'data:' || url.protocol === 'blob:' || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
  blockedRequests.push({ origin: url.origin, url: url.href.slice(0, 500), resourceType: route.request().resourceType() });
  return route.abort();
});

await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '我是客人 →', exact: true }).click();
await page.getByRole('button', { name: /进入工作区/ }).click();
await page.getByRole('button', { name: '我的', exact: true }).click();
await page.getByRole('button', { name: /我的档案/ }).click();
const assessment = page.locator('.stage21-assessment');
await assessment.getByRole('heading', { name: /健康初评/ }).waitFor({ state: 'visible' });

async function waitForQuestion(label) {
  await page.waitForFunction(expected => {
    const node = document.querySelector('#stage21-assessment-status')?.closest('form')?.querySelector('label[for="stage21-assessment-status"]');
    return Boolean(node && node.textContent.includes(expected));
  }, label, { timeout: 15000 });
}
async function answerQuestion(label, status, detail = '') {
  await waitForQuestion(label);
  await assessment.locator('#stage21-assessment-status').selectOption(status);
  if (status === 'reported' && label === '慢病史') await assessment.locator('#stage21-assessment-list').fill(detail);
  if (label === '行动能力') await assessment.locator('#stage21-assessment-details').fill(detail);
  await assessment.getByRole('button', { name: /保存并继续/ }).click();
  await page.waitForTimeout(100);
}

await waitForQuestion('长期用药说明');
await answerQuestion('长期用药说明', 'none');
await page.getByRole('button', { name: '我的', exact: true }).click();
await page.getByRole('button', { name: /我的档案/ }).click();
await waitForQuestion('饮食忌口');
const restoredProgress = await assessment.locator('.stage21-progress-line').innerText();
assert.includes(restoredProgress, '4/8', 'assessment progress after returning to profile');
await answerQuestion('饮食忌口', 'none');
await waitForQuestion('睡眠情况');
const sleepPending = await assessment.locator('.stage21-missing-list').innerText();
assert.includes(sleepPending, '睡眠情况', 'sleep remains an unanswered item');
await page.getByRole('button', { name: '我的', exact: true }).click();
await page.getByRole('button', { name: /我的档案/ }).click();
await waitForQuestion('睡眠情况');

const extraction = page.locator('.stage21-extraction');
const utterance = extraction.locator('#stage21-utterance');
await page.waitForFunction(() => document.querySelector('.stage21-extraction')?.getAttribute('aria-busy') === 'false', { timeout: 20000 });
async function submitExtraction(text) {
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url().endsWith('/api/me/health-intake-extractions'), { timeout: 30000 });
  await utterance.fill(text);
  await extraction.getByRole('button', { name: '提取候选', exact: true }).click();
  const response = await responsePromise;
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.status(), 201, `health extraction ${text} HTTP status: ${JSON.stringify(payload).slice(0, 1200)}`);
  return payload;
}
async function reopenProfile() {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: '我的', exact: true }).click();
  await page.getByRole('button', { name: /我的档案/ }).click();
  await page.locator('.stage21-extraction').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.stage21-extraction')?.getAttribute('aria-busy') === 'false', { timeout: 20000 });
}
async function latestExtractionSnapshot() {
  return await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.stage21-extraction-card')];
    return { count: cards.length, text: cards[0]?.innerText || '', body: document.querySelector('.stage21-extraction')?.innerText || '' };
  });
}
const firstExtractionPayload = await submitExtraction('最近睡不好、对虾过敏');
assert.equal(firstExtractionPayload.source?.utterance, '最近睡不好、对虾过敏', 'API preserves the first extraction utterance');
await reopenProfile();
const firstExtraction = extraction.locator('.stage21-extraction-card').filter({ hasText: firstExtractionPayload.id }).first();
try {
  await firstExtraction.waitFor({ state: 'visible', timeout: 10000 });
} catch (error) {
  const diagnostic = await extraction.innerText().catch(() => 'extraction section unavailable');
  throw new Error(`extraction card did not render after HTTP 201: ${diagnostic.slice(0, 3000)}; ${error.message}`);
}
await firstExtraction.locator('.stage21-candidate').first().waitFor({ state: 'visible' });
assert.equal(await firstExtraction.locator('.stage21-candidate').count(), 2, 'model returns sleep and allergy candidates');
const firstCardSnapshot = { ...(await latestExtractionSnapshot()), text: await firstExtraction.innerText() };
assert.ok(firstCardSnapshot.count > 0, `saved extraction card is present after reload: ${firstCardSnapshot.body.slice(0, 2500)}`);
assert.includes(firstCardSnapshot.text, '来源会话', 'source-bound extraction record is shown');
assert.includes(firstCardSnapshot.text, '最近睡不好', 'original utterance is visible in the extraction card');
const sleepCandidate = firstExtraction.locator('.stage21-candidate').filter({ hasText: '睡眠自述' });
const allergyCandidate = firstExtraction.locator('.stage21-candidate').filter({ hasText: '过敏自述' });
await sleepCandidate.locator('select').selectOption('confirm');
await allergyCandidate.locator('select').selectOption('reject');
await firstExtraction.getByRole('button', { name: /保存逐项选择/ }).click();
await page.getByText(/确认已写入待核实记录/).waitFor({ state: 'visible' });
const confirmedCardSnapshot = { ...(await latestExtractionSnapshot()), text: await firstExtraction.innerText() };
assert.includes(confirmedCardSnapshot.text, '部分确认，待核实', 'confirmed and rejected choices are reflected');

const vaguePayload = await submitExtraction('腿不太方便');
await reopenProfile();
const vagueExtraction = extraction.locator('.stage21-extraction-card').filter({ hasText: vaguePayload.id }).first();
const clarification = vagueExtraction.locator('.stage21-clarification');
await clarification.waitFor({ state: 'visible' });
assert.includes(await vagueExtraction.innerText(), '助行器', 'vague mobility gets a factual follow-up');
assert.equal(await vagueExtraction.locator('.stage21-candidate').count(), 0, 'vague mobility is not guessed as a candidate');
const clarifiedPayload = await submitExtraction('平时需要拐杖');
await reopenProfile();
const clarifiedExtraction = extraction.locator('.stage21-extraction-card').filter({ hasText: clarifiedPayload.id }).first();
await clarifiedExtraction.locator('.stage21-candidate').waitFor({ state: 'visible' });
assert.includes(await clarifiedExtraction.innerText(), '来源会话', 'clarification answer retains session source');
await clarifiedExtraction.locator('.stage21-candidate select').selectOption('confirm');
await clarifiedExtraction.getByRole('button', { name: /保存逐项选择/ }).click();
await page.getByText(/确认已写入待核实记录/).last().waitFor({ state: 'visible' });
const clarificationText = await clarifiedExtraction.innerText();

const layoutSnapshots = [];
for (const width of [1024, 1440, 1920]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(100);
  const layout = await page.evaluate(() => ({ viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth, stage21WorkspaceWidth: Math.round(document.querySelector('.stage21-health-workspace')?.getBoundingClientRect().width || 0) }));
  assert.ok(layout.documentWidth <= width, `${width}px health workspace has no horizontal overflow: ${JSON.stringify(layout)}`);
  layoutSnapshots.push({ page: 'health', ...layout });
  await page.screenshot({ path: screenshots.health[width], fullPage: false });
}

await page.setViewportSize({ width: 1440, height: 1000 });
await page.getByRole('button', { name: '日程', exact: true }).click();
await page.getByRole('heading', { name: '日程与疗程草案' }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '生成疗程草案', exact: true }).waitFor({ state: 'visible' });

async function generateDraft(expectedDayCount, expectedVersion, buttonName) {
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url().endsWith('/api/me/therapy-drafts'), { timeout: 120000 });
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  const response = await responsePromise;
  assert.equal(response.status(), 201, `draft version ${expectedVersion} HTTP status`);
  const draft = await response.json();
  assert.equal(draft.status, 'pending_review', `draft version ${expectedVersion} is pending review`);
  assert.equal(draft.active, false, `draft version ${expectedVersion} is inactive`);
  assert.ok(draft.draftId && draft.sourceRunId, `draft version ${expectedVersion} has IDs and a source run`);
  assert.equal(new Set(draft.items.map(item => item.businessDate)).size, expectedDayCount, `draft version ${expectedVersion} date count`);
  assert.ok(draft.items.every(item => item.businessDate < draft.stayEnd), `draft version ${expectedVersion} excludes checkout date`);
  assert.ok(draft.items.every(item => Array.isArray(item.sourceIds)), `draft version ${expectedVersion} carries source IDs`);
  const card = page.locator('.stage21-draft-card').filter({ hasText: draft.draftId });
  await card.waitFor({ state: 'visible' });
  assert.includes(await card.innerText(), `VERSION ${expectedVersion}`, 'visible version number');
  assert.includes(await card.innerText(), '待审核 · 未生效', 'visible pending/inactive status');
  assert.includes(await card.innerText(), `来源运行 ${draft.sourceRunId}`, 'visible source run ID');
  assert.equal(await card.locator('.stage21-day').count(), expectedDayCount, `visible day-card count for ${draft.draftId}`);
  return { draft, cardText: (await card.innerText()).slice(0, 24000) };
}

const threeDay = await generateDraft(3, 1, '生成疗程草案');
const upcoming = page.locator('.stage21-timeline-section').filter({ hasText: '待执行预约' }).first();
const cancelled = page.locator('.stage21-timeline-section').filter({ hasText: '取消记录' }).first();
assert.includes(await upcoming.innerText(), fixtureBookings.confirmedBookingId, 'confirmed reservation is in upcoming timeline');
assert.ok(!(await upcoming.innerText()).includes(fixtureBookings.cancelledBookingId), 'cancelled reservation is absent from upcoming timeline');
assert.includes(await cancelled.innerText(), fixtureBookings.cancelledBookingId, 'cancelled reservation appears in history');
assert.ok(!(await cancelled.innerText()).includes(fixtureBookings.confirmedBookingId), 'confirmed reservation is absent from cancelled history');
assert.ok(!(await upcoming.innerText()).includes(threeDay.draft.draftId), 'draft ID is not shown as a reservation');
assert.includes(await page.locator('.stage21-timeline-section').filter({ hasText: '疗程草案版本' }).innerText(), 'PROPOSED · INACTIVE', 'drafts have their own inactive section');

const threeDayLayouts = [];
for (const width of [1024, 1440, 1920]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(100);
  const layout = await page.evaluate(() => ({ viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth, draftWidth: Math.round(document.querySelector('.stage21-draft-card')?.getBoundingClientRect().width || 0) }));
  assert.ok(layout.documentWidth <= width, `${width}px three-day schedule has no horizontal overflow: ${JSON.stringify(layout)}`);
  threeDayLayouts.push({ page: 'three-day-schedule', ...layout });
  await page.screenshot({ path: screenshots.threeDay[width], fullPage: false });
}

await page.setViewportSize({ width: 1440, height: 1000 });
const stayUpdate = await page.evaluate(async () => {
  const guestToken = localStorage.getItem('community_token');
  const meResponse = await fetch('/api/me', { headers: { authorization: `Bearer ${guestToken}` } });
  if (!meResponse.ok) throw new Error('guest profile read failed while preparing the ten-night browser case');
  const me = await meResponse.json();
  const deanResponse = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'dean_demo', password: 'dean2026', role: 'dean' }) });
  if (!deanResponse.ok) throw new Error('isolated demo dean login failed while preparing the ten-night browser case');
  const dean = await deanResponse.json();
  const response = await fetch(`/api/dean/guests/${encodeURIComponent(me.id)}/stay`, { method: 'PATCH',
    headers: { authorization: `Bearer ${dean.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roomNo: 'B-21', checkIn: '2026-10-05', checkOut: '2026-10-15', stayPlan: 'ten_night' }) });
  if (!response.ok) throw new Error('isolated ten-night stay fixture failed with HTTP ' + response.status);
  return await response.json();
});
assert.equal(stayUpdate.profile.check_out, '2026-10-15', 'ten-night stay is stored in the isolated browser database');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '日程', exact: true }).click();
await page.getByText('2026-10-05 至 2026-10-15 · 离店日不排入').waitFor({ state: 'visible' });
const sevenDay2 = await generateDraft(7, 2, '生成疗程草案');
const sevenDay3 = await generateDraft(7, 3, '生成新版本草案');
const sevenDayCards = page.locator('.stage21-draft-card');
assert.equal(await sevenDayCards.count(), 2, 'two versions for the same ten-night stay are visible');
assert.ok(sevenDay2.draft.draftId !== sevenDay3.draft.draftId, 'same-stay versions have independent IDs');
assert.ok(sevenDay2.draft.sourceRunId !== sevenDay3.draft.sourceRunId, 'same-stay versions cite distinct source runs');
assert.equal(sevenDay2.draft.version, 2);
assert.equal(sevenDay3.draft.version, 3);
const proposed = page.locator('.stage21-timeline-section').filter({ hasText: '疗程草案版本' }).first();
assert.includes(await proposed.innerText(), sevenDay2.draft.draftId, 'older same-stay version remains readable');
assert.includes(await proposed.innerText(), sevenDay3.draft.draftId, 'new same-stay version is readable');
assert.includes(await proposed.innerText(), 'VERSION 2', 'version 2 shown in proposed section');
assert.includes(await proposed.innerText(), 'VERSION 3', 'version 3 shown in proposed section');
assert.includes(await upcoming.innerText(), fixtureBookings.confirmedBookingId, 'confirmed booking remains in separate timeline section');
assert.ok(!(await upcoming.innerText()).includes(sevenDay3.draft.draftId), 'new draft remains absent from bookings');
assert.ok(!(await cancelled.innerText()).includes(sevenDay3.draft.draftId), 'new draft remains absent from cancellation history');

const sevenDayLayouts = [];
for (const width of [1024, 1440, 1920]) {
  await page.setViewportSize({ width, height: 1000 });
  await page.waitForTimeout(100);
  const layout = await page.evaluate(() => ({ viewportWidth: innerWidth, documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth, draftWidth: Math.round(document.querySelector('.stage21-draft-card')?.getBoundingClientRect().width || 0) }));
  assert.ok(layout.documentWidth <= width, `${width}px seven-day schedule has no horizontal overflow: ${JSON.stringify(layout)}`);
  sevenDayLayouts.push({ page: 'seven-day-schedule', ...layout });
  await page.screenshot({ path: screenshots.sevenDay[width], fullPage: false });
}

assert.deepEqual(draftResponses.map(item => item.status), ['pending_review', 'pending_review', 'pending_review']);
assert.deepEqual(pageErrors, [], 'browser reports no page errors');
const knownFontOrigins = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const unexpectedBlockedRequests = [...new Set(blockedRequests.map(item => item.origin))].filter(origin => !knownFontOrigins.includes(origin));
const unexpectedFailedRequests = failedRequests.filter(item => !knownFontOrigins.includes(item.origin));
const unexpectedConsoleErrors = consoleMessages.filter(item => item.type === 'error'
  && !/fonts\.(?:googleapis|gstatic)\.com|ERR_BLOCKED_BY_CLIENT/.test(item.text)
  && !(item.text.includes('net::ERR_FAILED') && failedRequests.some(request => knownFontOrigins.includes(request.origin))));
assert.deepEqual(unexpectedBlockedRequests, [], 'only known font origins were blocked');
assert.deepEqual(unexpectedFailedRequests, [], 'only known font requests failed');
assert.deepEqual(unexpectedConsoleErrors, [], 'no unexpected browser console errors');

const result = { status: 'PASS', browser: 'Playwright CLI with project config', widths: [1024, 1440, 1920],
  healthAssessment: { resumedQuestion: '饮食忌口', sleepRemainsMissingAfterReopen: true, progress: restoredProgress },
  extraction: { firstExtractionId: firstCardSnapshot.text.match(/提取编号\s+(\S+)/)?.[1] || null,
    confirmedSleepRejectedAllergy: true, originalTextVisible: true, clarificationQuestion: clarificationText.slice(0, 300),
    clarifiedMobilitySourceVisible: true },
  drafts: [threeDay.draft, sevenDay2.draft, sevenDay3.draft].map(item => ({ draftId: item.draftId, version: item.version,
    status: item.status, active: item.active, sourceRunId: item.sourceRunId, stayStart: item.stayStart, stayEnd: item.stayEnd,
    dates: [...new Set(item.items.map(entry => entry.businessDate))], itemCount: item.items.length })),
  timeline: { confirmedBookingId: fixtureBookings.confirmedBookingId, cancelledBookingId: fixtureBookings.cancelledBookingId,
    confirmedSeparateFromDrafts: true, cancelledAbsentFromUpcoming: true },
  layout: [...layoutSnapshots, ...threeDayLayouts, ...sevenDayLayouts], pageErrors, consoleMessages: consoleMessages.slice(0, 30),
  blockedRequests: blockedRequests.slice(0, 30), failedRequests: failedRequests.slice(0, 30), draftResponses: draftResponses.length };
await page.evaluate(value => { document.title = 'STAGE21_BROWSER_RESULT:' + JSON.stringify(value); }, result);
return result;
}
