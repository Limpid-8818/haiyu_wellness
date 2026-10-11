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
page.on('requestfailed', request => {
  const url = request.url();
  failedRequests.push({ url: url.slice(0, 500), error: request.failure()?.errorText || 'unknown' });
});
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (['data:', 'blob:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
  externalRequests.push({ origin: url.origin, type: route.request().resourceType() });
  return route.abort();
});
await page.addInitScript(({ frozenAt }) => {
  const instant = Date.parse(frozenAt);
  const NativeDate = Date;
  class FrozenDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [instant])); }
    static now() { return instant; }
  }
  Object.defineProperty(globalThis, 'Date', { configurable: true, writable: true, value: FrozenDate });
}, { frozenAt: fixtures.frozenAt });

async function enterGuest() {
  await page.getByRole('button', { name: /我是客人/ }).first().click();
  await page.getByLabel('账号').fill('guest_demo');
  await page.getByLabel('密码').fill('guest2026');
  await page.getByRole('button', { name: /进入工作区/ }).click();
  await page.getByRole('button', { name: '日程', exact: true }).waitFor({ state: 'visible' });
}

async function openSchedule() {
  await page.getByRole('button', { name: '日程', exact: true }).click();
  await page.getByRole('heading', { name: '日程与疗程草案', exact: true }).waitFor({ state: 'visible' });
  await page.locator(`[data-testid="q24-appointment-${fixtures.currentAppointmentId}"]`).waitFor({ state: 'visible' });
}

async function captureWidths(files, pageName) {
  const layout = [];
  for (const width of [1280, 1920]) {
    await page.setViewportSize({ width, height: 1080 });
    await page.waitForTimeout(150);
    const state = await page.evaluate(() => ({ viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
    assert.ok(state.documentWidth <= width && state.bodyWidth <= width,
      `${pageName} at ${width}px has no horizontal clipping: ${JSON.stringify(state)}`);
    layout.push({ page: pageName, ...state });
    await page.screenshot({ path: files[width], fullPage: true });
  }
  return layout;
}

await page.setViewportSize({ width: 1280, height: 1080 });
await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
await enterGuest();
await openSchedule();
const currentCard = page.locator(`[data-testid="q24-appointment-${fixtures.currentAppointmentId}"]`);
const oldCard = page.locator(`[data-testid="q24-appointment-${fixtures.previousAppointmentId}"]`);
await oldCard.waitFor({ state: 'visible' });
assert.includes(await oldCard.innerText(), '已过修改时段', 'yesterday feedback is visibly read-only');
assert.equal(await oldCard.locator('button[type="submit"]').count(), 0, 'yesterday entry has no feedback submit action');
assert.equal(await oldCard.locator('select').isDisabled(), true, 'yesterday entry selection is disabled');

const checkinResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
  && response.url().endsWith(`/api/me/reservations/${fixtures.currentAppointmentId}/checkin`), { timeout: 30_000 });
await currentCard.getByRole('button', { name: '签到', exact: true }).click();
const checkinResponse = await checkinResponsePromise;
const checkin = await checkinResponse.json();
assert.equal(checkinResponse.status(), 201, 'started appointment accepts the guest check-in');
assert.equal(checkin.reservationId, fixtures.currentAppointmentId, 'check-in points to the actual reservation');
await currentCard.getByText(`签到编号 ${checkin.id}`).waitFor({ state: 'visible' });
await page.reload({ waitUntil: 'domcontentloaded' });
await openSchedule();
assert.includes(await currentCard.innerText(), `签到编号 ${checkin.id}`, 'refresh preserves the actual check-in ID');

const currentFeedbackForm = currentCard.locator('form[data-testid^="q24-feedback-"]');
await currentFeedbackForm.locator('select').selectOption('uncomfortable');
await currentFeedbackForm.locator('textarea').fill('浏览器验收：项目后感到不适，保留为第一版。');
const createFeedbackResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
  && response.url().endsWith(`/api/me/reservations/${fixtures.currentAppointmentId}/feedback`), { timeout: 30_000 });
await currentFeedbackForm.getByRole('button', { name: '保存感受', exact: true }).click();
const createFeedbackResponse = await createFeedbackResponsePromise;
const firstFeedback = await createFeedbackResponse.json();
assert.equal(createFeedbackResponse.status(), 201, 'feedback is persisted for the actual appointment');
assert.equal(firstFeedback.reservationId, fixtures.currentAppointmentId, 'feedback preserves the actual reservation ID');
assert.equal(firstFeedback.checkinId, checkin.id, 'feedback is linked to the actual check-in');
await currentCard.getByText(`反馈编号 ${firstFeedback.id} · 第 1 版`).waitFor({ state: 'visible' });
assert.includes(await currentCard.innerText(), '不舒服', 'first feedback value is shown after save');

await page.getByRole('button', { name: /刷新日程/ }).click();
await currentCard.getByText(`反馈编号 ${firstFeedback.id} · 第 1 版`).waitFor({ state: 'visible' });
await currentFeedbackForm.locator('select').selectOption('general');
await currentFeedbackForm.locator('textarea').fill('浏览器验收：当天复核后更正为一般。');
const updateFeedbackResponsePromise = page.waitForResponse(response => response.request().method() === 'PUT'
  && response.url().endsWith(`/api/me/feedback/${firstFeedback.id}`), { timeout: 30_000 });
await currentFeedbackForm.getByRole('button', { name: '保存当天修改', exact: true }).click();
const updateFeedbackResponse = await updateFeedbackResponsePromise;
const secondFeedback = await updateFeedbackResponse.json();
assert.equal(updateFeedbackResponse.status(), 200, 'same-day feedback revision succeeds');
assert.equal(secondFeedback.id, firstFeedback.id, 'same-day edit keeps the original feedback ID');
assert.equal(secondFeedback.revision, 2, 'same-day edit creates revision 2');
assert.equal(secondFeedback.revisions.length, 2, 'both feedback versions remain readable');
await currentCard.getByText(`反馈编号 ${firstFeedback.id} · 第 2 版`).waitFor({ state: 'visible' });
await currentCard.getByText('修改记录（2 版）').click();
assert.includes(await currentCard.innerText(), '第 1 版 · 不舒服', 'first feedback version remains visible');
assert.includes(await currentCard.innerText(), '第 2 版 · 一般', 'second feedback version remains visible');

await page.getByRole('button', { name: '我的', exact: true }).click();
await page.getByRole('heading', { name: '我的', exact: true }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: /心情与陪伴/ }).click();
await page.getByRole('heading', { name: '心情与陪伴', exact: true }).waitFor({ state: 'visible' });
const moodResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
  && response.url().endsWith('/api/me/moods'), { timeout: 30_000 });
await page.getByRole('button', { name: /很难受/ }).click();
const moodResponse = await moodResponsePromise;
const mood = await moodResponse.json();
assert.equal(moodResponse.status(), 201, 'guest creates the current-day mood through the UI');
assert.equal(mood.score, 1, 'low mood is the actual saved source record');

await openSchedule();
const events = await page.evaluate(async () => {
  const response = await fetch('/api/me/replanning-events', { headers: { authorization: `Bearer ${localStorage.getItem('community_token')}` } });
  return { status: response.status, data: await response.json() };
});
assert.equal(events.status, 200, 'guest can read owned replanning source events');
const moodEvent = events.data.items.find(item => item.sourceType === 'mood' && String(item.sourceId) === String(mood.id)
  && item.sourceVersion === mood.revision);
assert.ok(moodEvent?.requiresAttention, 'saved low mood has a source event requiring a review candidate');
const evaluateResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
  && response.url().endsWith(`/api/me/replanning-events/${moodEvent.id}/evaluate`), { timeout: 180_000 });
await page.locator(`[data-testid="q24-evaluate-${moodEvent.id}"]`).click({ timeout: 30_000 });
const evaluateResponse = await evaluateResponsePromise;
const candidate = await evaluateResponse.json();
assert.equal(evaluateResponse.status(), 200, 'existing planning coordinator returns a persisted candidate');
assert.equal(candidate.sourceId, String(mood.id), 'candidate event points to the actual mood ID');
assert.equal(candidate.sourceVersion, mood.revision, 'candidate preserves exact mood version');
assert.equal(candidate.candidate.reviewStatus, 'pending_review', 'candidate remains inactive until review');
assert.equal(candidate.baseline.draftId, fixtures.baselineDraftId, 'candidate compares against the active baseline');
assert.ok(candidate.changes.length > 0, 'candidate diff has real saved schedule changes');
const diffCard = page.locator(`[data-testid="q24-diff-${moodEvent.id}"]`);
await diffCard.waitFor({ state: 'visible' });
assert.includes(await diffCard.innerText(), mood.id, 'visible diff attributes its source to the mood record');
assert.includes(await diffCard.innerText(), candidate.candidate.draftId, 'visible diff shows the actual candidate draft');
assert.includes(await diffCard.innerText(), '待审核', 'visible diff explains that candidate is not yet active');
const reservationReadback = await page.evaluate(async () => {
  const response = await fetch('/api/reservations', { headers: { authorization: `Bearer ${localStorage.getItem('community_token')}` } });
  return { status: response.status, data: await response.json() };
});
assert.equal(reservationReadback.status, 200, 'reservation readback succeeds');
const originalReservation = reservationReadback.data.items.find(item => item.id === fixtures.currentAppointmentId);
assert.equal(originalReservation?.status, 'confirmed', 'the original appointment remains confirmed while candidate awaits review');
assert.ok(!reservationReadback.data.items.some(item => item.id === candidate.candidate.draftId),
  'pending candidate does not appear as a booked appointment');
const scheduleLayout = await captureWidths({ 1280: screenshots.schedule1280, 1920: screenshots.schedule1920 }, 'schedule-feedback-and-diff');

await page.getByRole('button', { name: '我的', exact: true }).click();
await page.getByRole('button', { name: /心情与陪伴/ }).click();
await page.getByRole('heading', { name: '心情与陪伴', exact: true }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '30 日', exact: true }).click();
const moodDay = page.locator(`.mood-day[aria-label^="${fixtures.businessDate}"]`);
await moodDay.waitFor({ state: 'visible' });
await moodDay.click();
const moodEventCard = page.getByTestId('mood-replan-event');
await moodEventCard.waitFor({ state: 'visible' });
const trendText = await moodEventCard.innerText();
assert.includes(trendText, String(mood.id), '30-day mood trend event shows the exact mood source ID');
assert.includes(trendText, `来源版本 ${mood.revision}`, '30-day mood trend shows the source version');
assert.includes(trendText, candidate.candidate.draftId, '30-day mood trend links the candidate draft ID');
assert.includes(trendText, `第 ${candidate.candidate.version} 版`, '30-day mood trend displays the candidate version');
assert.includes(trendText, '待医护审核', '30-day mood trend displays the current review status');
assert.includes(trendText, '不表示心情变化导致了疗程调整', 'trend copy avoids causal claims');
const moodLayout = await captureWidths({ 1280: screenshots.mood1280, 1920: screenshots.mood1920 }, 'mood-trend-source-chain');

assert.equal(pageErrors.length, 0, `browser page errors: ${JSON.stringify(pageErrors)}`);
const allowedFontOrigins = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const unexpectedExternal = [...new Set(externalRequests.map(item => item.origin))].filter(origin => !allowedFontOrigins.includes(origin));
assert.equal(unexpectedExternal.length, 0, `unexpected external browser requests: ${unexpectedExternal.join(', ')}`);
const unexpectedFailed = failedRequests.filter(item => !allowedFontOrigins.some(origin => item.url.startsWith(origin)));
assert.equal(unexpectedFailed.length, 0, `unexpected failed browser requests: ${JSON.stringify(unexpectedFailed)}`);
const unexpectedConsoleErrors = consoleErrors.filter(value => !/fonts\.(?:googleapis|gstatic)\.com|ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED/.test(value));
assert.equal(unexpectedConsoleErrors.length, 0, `unexpected console errors: ${JSON.stringify(unexpectedConsoleErrors)}`);
const result = { status: 'PASS', taskId: fixtures.taskId || null, guestId: fixtures.guestId || null,
  previousAppointmentId: fixtures.previousAppointmentId, previousFeedbackId: fixtures.previousFeedbackId,
  currentAppointmentId: fixtures.currentAppointmentId, currentSlotId: fixtures.currentSlotId,
  checkinId: checkin.id, feedbackId: firstFeedback.id, feedbackRevision: secondFeedback.revision,
  feedbackVersions: secondFeedback.revisions.map(item => ({ revision: item.revision, feeling: item.feeling, note: item.note })),
  historicalFeedbackReadOnly: true, moodRecordId: mood.id, moodRevision: mood.revision, moodSourceEventId: moodEvent.id,
  baselineDraftId: fixtures.baselineDraftId, candidateDraftId: candidate.candidate.draftId,
  candidateVersion: candidate.candidate.version, candidateStatus: candidate.candidate.reviewStatus,
  diffRows: candidate.changes.length, originalAppointmentStayedConfirmed: true,
  trend: { days: 30, sourceId: mood.id, sourceVersion: mood.revision, candidateDraftId: candidate.candidate.draftId,
    candidateVersion: candidate.candidate.version, reviewStatus: candidate.candidate.reviewStatus, causalClaim: false },
  layout: [...scheduleLayout, ...moodLayout], screenshots: Object.values(screenshots), pageErrors,
  externalRequests: externalRequests.slice(0, 20), failedRequests: failedRequests.slice(0, 20) };
await page.evaluate(value => { document.title = 'STAGE24_BROWSER_RESULT:' + JSON.stringify(value); }, result);
return result;
}
