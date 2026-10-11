async page => {
const assert = {
  equal(actual, expected, message) { if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`); },
  ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); },
  includes(actual, expected, message) { if (!String(actual).includes(expected)) throw new Error(`${message}: missing ${expected}`); }
};
const webUrl = __WEB_URL__;
const screenshots = __SCREENSHOTS__;
const fixtures = __FIXTURES__;
const q227Only = __Q227_ONLY__;
const pageErrors = [];
const consoleMessages = [];
const blockedRequests = [];
const failedRequests = [];
const deniedResponses = [];
const conflictResponses = [];
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
  if (response.status() === 403) deniedResponses.push(new URL(response.url()).pathname);
  if (response.status() === 409) conflictResponses.push(new URL(response.url()).pathname);
  if (response.request().method() === 'POST' && response.url().endsWith('/api/me/therapy-drafts')) {
    void response.json().then(data => draftResponses.push({ status: response.status(), draftId: data.draftId, version: data.version,
      reviewStatus: data.reviewStatus, executionMode: data.evidence?.executionMode || null })).catch(() => {});
  }
});
await page.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.protocol === 'data:' || url.protocol === 'blob:' || ['127.0.0.1', 'localhost'].includes(url.hostname)) return route.continue();
  blockedRequests.push({ origin: url.origin, url: url.href.slice(0, 500), resourceType: route.request().resourceType() });
  return route.abort();
});

const widths = q227Only ? [1024] : [1024, 1440, 1920];
const layout = [];
async function captureWidths(screenName, files, selector) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.waitForTimeout(120);
    const state = await page.evaluate(selectorValue => ({ viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
      targetWidth: Math.round(document.querySelector(selectorValue)?.getBoundingClientRect().width || 0) }), selector);
    assert.ok(state.documentWidth <= width, `${screenName} at ${width}px has no horizontal overflow: ${JSON.stringify(state)}`);
    layout.push({ page: screenName, ...state });
    await page.screenshot({ path: files[width], fullPage: false });
  }
}

async function enter(role, username, password) {
  const roleName = role === 'guest' ? /我是客人/ : /我是工作人员/;
  await page.getByRole('button', { name: roleName }).first().click();
  await page.getByLabel('账号').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: /进入工作区/ }).click();
  if (role === 'guest') await page.getByRole('button', { name: '日程', exact: true }).waitFor({ state: 'visible' });
  else await page.getByRole('button', { name: '疗程审核', exact: true }).waitFor({ state: 'visible' });
}

async function logout() {
  await page.locator('button.logout-btn').click();
  await page.getByRole('button', { name: /我是客人/ }).first().waitFor({ state: 'visible' });
}

async function generateDraft(expectedVersion, buttonName) {
  const responsePromise = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url().endsWith('/api/me/therapy-drafts'), { timeout: 120000 });
  await page.getByRole('button', { name: buttonName, exact: true }).click();
  const response = await responsePromise;
  const draft = await response.json();
  assert.equal(response.status(), 201, `draft version ${expectedVersion} HTTP status`);
  assert.equal(draft.version, expectedVersion, `draft version ${expectedVersion} sequence`);
  assert.equal(draft.status, 'pending_review', `draft version ${expectedVersion} stays pending`);
  assert.equal(draft.reviewStatus, 'pending_review', `draft version ${expectedVersion} awaits review`);
  assert.ok(draft.draftId && draft.sourceRunId, `draft version ${expectedVersion} has persisted source IDs`);
  assert.equal(new Set(draft.items.map(item => item.businessDate)).size, 3, `draft version ${expectedVersion} uses the three-night stay window`);
  assert.ok(draft.items.every(item => item.businessDate < draft.stayEnd), `draft version ${expectedVersion} excludes checkout date`);
  assert.ok(draft.items.every(item => Array.isArray(item.sourceIds)), `draft version ${expectedVersion} carries source references`);
  const card = page.locator('.stage21-draft-card').filter({ hasText: draft.draftId });
  await card.waitFor({ state: 'visible' });
  assert.includes(await card.innerText(), `VERSION ${expectedVersion}`, 'visible version number');
  assert.includes(await card.innerText(), '等待医护审核', 'visible inactive review state');
  assert.includes(await card.innerText(), `来源运行 ${draft.sourceRunId}`, 'visible source run ID');
  assert.equal(await card.locator('.stage21-day').count(), 3, `visible day cards for ${draft.draftId}`);
  return draft;
}

async function readJsonResponse(response, label) {
  let value;
  try { value = await response.json(); } catch { throw new Error(`${label} returned non-JSON HTTP ${response.status()}`); }
  return value;
}

async function readReviewDetail(draftId) {
  return await page.evaluate(async id => {
    const token = localStorage.getItem('community_token');
    const response = await fetch(`/api/staff/therapy-drafts/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: response.status, body: await response.json() };
  }, draftId);
}

await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
await enter('guest', 'guest_demo', 'guest2026');
await page.getByRole('button', { name: '日程', exact: true }).click();
await page.getByRole('heading', { name: '日程与疗程草案' }).waitFor({ state: 'visible' });
await page.getByText('2026-10-06 至 2026-10-09 · 离店日不排入').waitFor({ state: 'visible' });
const draft1 = await generateDraft(1, '生成疗程草案');
const beforeReviewTimeline = await page.evaluate(async () => {
  const token = localStorage.getItem('community_token');
  const response = await fetch('/api/me/timeline', { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, data: await response.json() };
});
assert.equal(beforeReviewTimeline.status, 200, 'guest timeline endpoint responds');
assert.ok(beforeReviewTimeline.data.proposedDrafts.some(item => item.draftId === draft1.draftId), 'pending plan is listed as a proposed draft');
assert.ok(!beforeReviewTimeline.data.upcomingBookings.some(item => item.id === draft1.draftId), 'draft is not a confirmed reservation');
assert.ok(draft1.items.some(item => item.type === 'activity' && item.candidateId === 'project-beach-walk'),
  'the isolated plan includes an actual beach-walk candidate for clinician review');
if (!q227Only) await captureWidths('guest-timeline-pending', screenshots.guestTimelinePending, '.stage21-timeline-section');

await logout();
await enter('staff', 'staff_demo', 'staff2026');
await page.getByRole('heading', { name: '疗程审核', exact: true }).waitFor({ state: 'visible' });
const firstQueueRow = page.locator('.wellness-review-row').filter({ hasText: fixtures.guestName }).first();
await firstQueueRow.waitFor({ state: 'visible' });
assert.includes(await firstQueueRow.innerText(), '强制复核', 'reported chronic history is marked for mandatory clinician review');
await firstQueueRow.click();
await page.locator('.wellness-review-detail-head').filter({ hasText: draft1.draftId }).waitFor({ state: 'visible' });
const detail1Response = await readReviewDetail(draft1.draftId);
assert.equal(detail1Response.status, 200, 'clinician can read the generated version');
const detail1 = detail1Response.body;
assert.equal(detail1.reviewStatus, 'pending_review');
assert.ok(detail1.history.length === 0, 'new version has no prior review events');
const editedItemIndex = detail1.items.findIndex(item => item.type === 'activity' && item.candidateId === 'project-beach-walk');
assert.ok(editedItemIndex >= 0, 'draft has a beach-walk activity item');
const editedItem = detail1.items[editedItemIndex];
const currentSlotId = [...editedItem.sourceIds].reverse().find(source => source.type === 'project_slot')?.id;
assert.ok(currentSlotId, 'draft item cites a persisted activity slot');
const invalidRevision = await page.evaluate(async ({ draftId, itemId }) => {
  const token = localStorage.getItem('community_token');
  const response = await fetch(`/api/staff/therapy-drafts/${encodeURIComponent(draftId)}/revisions`, { method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': 'stage22:browser:invalid:0001' },
    body: JSON.stringify({ version: 1, reason: 'Stage22 浏览器负向校验：拒绝不存在的时段。',
      edits: [{ itemId, slotId: 'slot_invalid_stage22_browser', reason: '不存在的时段不能激活。' }] }) });
  return { status: response.status, body: await response.json() };
}, { draftId: draft1.draftId, itemId: editedItem.id });
assert.equal(invalidRevision.status, 409, `invalid slot revision is rejected without reserving: ${JSON.stringify(invalidRevision.body)}`);
const itemCard = page.locator('.wellness-evidence-item').nth(editedItemIndex);
const alternativeSelect = itemCard.locator('select');
await alternativeSelect.waitFor({ state: 'visible' });
const choices = await alternativeSelect.locator('option').evaluateAll(options => options.map(option => ({ value: option.value, text: option.textContent.trim() })));
const replacement = choices.find(option => option.value && option.value !== currentSlotId);
assert.ok(replacement, `clinician receives an available alternative slot; choices=${JSON.stringify(choices).slice(0, 1600)}`);
await alternativeSelect.selectOption(replacement.value);
const reviseReason = '依据入住日期与当前可预约名额，将沙滩漫步调整到另一真实时段；保持医护复核。';
await page.getByLabel('修订或退回原因').fill(reviseReason);
const reviseResponsePromise = page.waitForResponse(response => response.request().method() === 'PUT'
  && response.url().endsWith(`/api/staff/therapy-drafts/${draft1.draftId}/revisions`), { timeout: 30000 });
await page.getByRole('button', { name: '保存新待审版本', exact: true }).click();
const reviseResponse = await reviseResponsePromise;
const revision = await readJsonResponse(reviseResponse, 'clinician revision');
assert.equal(reviseResponse.status(), 200, 'valid slot revision succeeds');
assert.equal(revision.version, 2, 'revision creates version 2');
assert.equal(revision.reviewStatus, 'pending_review', 'revision remains inactive pending review');
assert.equal(revision.supersedesDraftId, draft1.draftId, 'new version points to its reviewed source version');
const revisionItem = revision.items.find(item => item.evidence?.revisedFromItemId === editedItem.id);
assert.ok(revisionItem, 'revised item retains its source item linkage');
assert.ok(revisionItem.sourceIds.some(source => source.type === 'project_slot' && source.id === replacement.value),
  'new version cites the selected real slot');
await page.locator('.wellness-review-detail-head').filter({ hasText: revision.draftId }).waitFor({ state: 'visible' });
assert.equal(revision.approvalAction, 'approved_after_revision', 'API identifies the exact clinician revision before approval');
assert.equal(revision.approvalContext?.revisionEventId, revision.history.find(event => event.action === 'revision')?.id,
  'review detail links the approval choice to the recorded revision event');
const revisedApprovalButton = page.getByRole('button', { name: '修改后通过并激活', exact: true });
await revisedApprovalButton.waitFor({ state: 'visible' });
await revisedApprovalButton.scrollIntoViewIfNeeded();
await page.waitForTimeout(3000); // Let the revision toast clear before capturing the primary approval control.
const approvalButtonViewport = await revisedApprovalButton.evaluate(button => {
  const rect = button.getBoundingClientRect();
  return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), viewportHeight: innerHeight };
});
assert.ok(approvalButtonViewport.top >= 0 && approvalButtonViewport.bottom <= approvalButtonViewport.viewportHeight,
  `revised approval button is fully in the captured viewport: ${JSON.stringify(approvalButtonViewport)}`);
await captureWidths('clinician-review-pending-revision', screenshots.clinicianReview, '.wellness-review-layout');
const approveResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
  && response.url().endsWith(`/api/staff/therapy-drafts/${revision.draftId}/approve`), { timeout: 30000 });
await page.getByRole('button', { name: '修改后通过并激活', exact: true }).click();
const approveResponse = await approveResponsePromise;
const approved = await readJsonResponse(approveResponse, 'clinician approval');
assert.equal(approveResponse.status(), 200, 'clinician approves revised version');
assert.equal(approved.reviewStatus, 'active', 'approved version becomes active');
assert.equal(approved.approvalAction, 'approved_after_revision', 'revised approval action is explicit in the detail response');
assert.ok(approved.reservations?.length > 0, 'approval creates associated actual reservations');
assert.ok(approved.reservations.every(item => item.status === 'confirmed'), 'created reservations are confirmed');
const approvedDetail = await readReviewDetail(revision.draftId);
assert.equal(approvedDetail.status, 200, 'approved revised detail can be read');
const revisedApprovalEvent = approvedDetail.body.history.find(event => event.action === 'approved_after_revision');
assert.ok(revisedApprovalEvent, 'history stores the distinct revised-approval action');
assert.equal(revisedApprovalEvent.payload.revisionEventId, revision.history.find(event => event.action === 'revision')?.id,
  'revised approval event points to the exact clinician revision');
assert.equal(revisedApprovalEvent.payload.fromVersion, 1);
assert.equal(revisedApprovalEvent.payload.toVersion, 2);
assert.ok(revisedApprovalEvent.reason.includes(revisedApprovalEvent.payload.revisionEventId), 'approval reason exposes its revision event link');

await page.getByRole('button', { name: '疗程审核历史', exact: true }).click();
await page.getByRole('heading', { name: '疗程审核历史', exact: true }).waitFor({ state: 'visible' });
if (q227Only) {
  await page.getByLabel('审核动作').selectOption('approved_after_revision');
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.wellness-history-results')?.innerText.includes('修改后通过'));
  const filteredRows = page.locator('.wellness-history-row');
  assert.equal(await filteredRows.count(), 1, 'the revised-approval history filter returns exactly one event');
  const filteredHistoryText = await filteredRows.first().innerText();
  assert.includes(filteredHistoryText, '修改后通过', 'history uses the distinct revised-approval label');
  assert.includes(filteredHistoryText, revisedApprovalEvent.payload.revisionEventId, 'visible history includes the revision event link');
  assert.includes(filteredHistoryText, '依据入住日期与当前可预约名额', 'visible history includes the clinician revision reason');
  await captureWidths('clinician-history-revised-approval-filter', screenshots.clinicianHistory, '.wellness-history-workbench');
  assert.ok(pageErrors.length === 0, `browser page errors: ${JSON.stringify(pageErrors)}`);
  const knownFontOrigins = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
  const unexpectedBlockedRequests = [...new Set(blockedRequests.map(item => item.origin))].filter(origin => !knownFontOrigins.includes(origin));
  const unexpectedFailedRequests = failedRequests.filter(item => !knownFontOrigins.includes(item.origin));
  assert.ok(unexpectedBlockedRequests.length === 0, `unexpected external browser requests: ${JSON.stringify(unexpectedBlockedRequests)}`);
  assert.ok(unexpectedFailedRequests.length === 0, `unexpected failed requests: ${JSON.stringify(unexpectedFailedRequests)}`);
  const result = { status: 'PASS', scenario: 'Q22.7 clinician-revision approval and filtered history', browser: 'Playwright CLI using project resource config',
    widths, review: { button: '修改后通过并激活', approvalAction: approved.approvalAction,
      revisionEventId: revisedApprovalEvent.payload.revisionEventId, fromVersion: revisedApprovalEvent.payload.fromVersion,
      toVersion: revisedApprovalEvent.payload.toVersion, reservations: approved.reservations.length },
    history: { filter: 'approved_after_revision', label: '修改后通过', rows: await filteredRows.count(), reasonAndVersionLinkVisible: true },
    layout, pageErrors, blockedRequests: blockedRequests.slice(0, 20), failedRequests: failedRequests.slice(0, 20) };
  await page.evaluate(value => { document.title = 'STAGE22_BROWSER_RESULT:' + JSON.stringify(value); }, result);
  return result;
}
const historyRowsAfterApproval = page.locator('.wellness-history-row');
await historyRowsAfterApproval.first().waitFor({ state: 'visible' });
const historyAfterApprovalText = await historyRowsAfterApproval.allInnerTexts();
assert.ok(historyAfterApprovalText.some(text => text.includes('修订')), 'immutable history includes revision');
assert.ok(historyAfterApprovalText.some(text => text.includes('修改后通过')), 'immutable history includes distinct revised approval');

await logout();
await enter('guest', 'guest_demo', 'guest2026');
await page.getByRole('button', { name: '日程', exact: true }).click();
await page.getByRole('heading', { name: '日程与疗程草案' }).waitFor({ state: 'visible' });
const draft3 = await generateDraft(3, '生成新版本草案');
const unsafeCandidatesBeforeReturn = [...new Set(draft3.items.map(item => item.candidateId)
  .filter(candidateId => ['project-sea-bath', 'project-sea-mud'].includes(candidateId)))];

await logout();
await enter('staff', 'staff_demo', 'staff2026');
await page.getByRole('heading', { name: '疗程审核', exact: true }).waitFor({ state: 'visible' });
const thirdQueueRow = page.locator('.wellness-review-row').filter({ hasText: fixtures.guestName }).first();
await thirdQueueRow.waitFor({ state: 'visible' });
await thirdQueueRow.click();
await page.locator('.wellness-review-detail-head').filter({ hasText: draft3.draftId }).waitFor({ state: 'visible' });
const returnReason = 'R2：皮肤有开放性伤口时必须排除海水浴和海泥敷体；请重新生成并遵守 R2。';
await page.getByRole('textbox', { name: '退回原因', exact: true }).fill(returnReason);
const returnResponsePromise = page.waitForResponse(response => response.request().method() === 'POST'
  && response.url().endsWith(`/api/staff/therapy-drafts/${draft3.draftId}/return`), { timeout: 30000 });
await page.getByRole('button', { name: '退回并要求重新生成', exact: true }).click();
const returnResponse = await returnResponsePromise;
const returned = await readJsonResponse(returnResponse, 'clinician return');
assert.equal(returnResponse.status(), 200, 'clinician can return a pending version');
assert.equal(returned.reviewStatus, 'returned');
assert.equal(returned.reviewReason, returnReason, 'return reason is retained exactly');
await page.locator('.wellness-review-reason').filter({ hasText: returnReason }).waitFor({ state: 'visible' });
await page.getByRole('button', { name: '疗程审核历史', exact: true }).click();
await page.getByRole('heading', { name: '疗程审核历史', exact: true }).waitFor({ state: 'visible' });
const historyRows = page.locator('.wellness-history-row');
await historyRows.first().waitFor({ state: 'visible' });
const historyText = await historyRows.allInnerTexts();
assert.ok(historyText.some(text => text.includes('修订')), 'history page records revision');
assert.ok(historyText.some(text => text.includes('修改后通过')), 'history page records distinct revised approval');
assert.ok(historyText.some(text => text.includes('退回') && text.includes(returnReason)), 'history page preserves return reason');
await captureWidths('clinician-review-history', screenshots.clinicianHistory, '.wellness-history-workbench');

await logout();
await enter('guest', 'guest_demo', 'guest2026');
await page.getByRole('button', { name: '日程', exact: true }).click();
await page.getByRole('heading', { name: '日程与疗程草案' }).waitFor({ state: 'visible' });
const returnedCard = page.locator('.stage21-draft-card').filter({ hasText: draft3.draftId });
await returnedCard.waitFor({ state: 'visible' });
assert.includes(await returnedCard.innerText(), returnReason, 'guest sees the clinician return reason');
await page.getByRole('button', { name: '生成新版本草案', exact: true }).waitFor({ state: 'visible' });
const regenerated = await generateDraft(4, '生成新版本草案');
assert.equal(regenerated.evidence?.regeneration?.draftId, draft3.draftId, 'new version records the returned source draft');
assert.equal(regenerated.evidence?.regeneration?.reason, returnReason, 'new version records the exact return reason');
assert.equal(regenerated.reviewStatus, 'pending_review', 'regenerated plan awaits a new clinician decision');
assert.ok(regenerated.items.every(item => item.title !== '海水浴' && item.candidateId !== 'project-sea-bath'),
  'R2 regeneration does not copy a sea-bath suggestion');
const afterRegenerationTimeline = await page.evaluate(async () => {
  const token = localStorage.getItem('community_token');
  const response = await fetch('/api/me/timeline', { headers: { authorization: `Bearer ${token}` } });
  return { status: response.status, data: await response.json() };
});
assert.equal(afterRegenerationTimeline.status, 200, 'guest schedule readback succeeds');
assert.ok(afterRegenerationTimeline.data.upcomingBookings.length > 0, 'approved version reservations remain in upcoming bookings');
assert.ok(afterRegenerationTimeline.data.proposedDrafts.some(item => item.draftId === regenerated.draftId),
  'new pending version remains in the proposed draft list');
assert.ok(!afterRegenerationTimeline.data.upcomingBookings.some(item => item.id === regenerated.draftId),
  'pending regenerated version is not a reservation');
await captureWidths('guest-timeline-regenerated', screenshots.guestTimelineRegenerated, '.stage21-timeline-section');

await logout();
await enter('staff', 'staff_demo', 'staff2026');
await page.getByRole('button', { name: '疗程审核历史', exact: true }).click();
await page.getByRole('heading', { name: '疗程审核历史', exact: true }).waitFor({ state: 'visible' });
const finalHistoryRows = page.locator('.wellness-history-row');
await finalHistoryRows.first().waitFor({ state: 'visible' });
const finalHistoryText = await finalHistoryRows.allInnerTexts();
assert.ok(finalHistoryText.some(text => text.includes('修订')), 'final immutable history retains revision');
assert.ok(finalHistoryText.some(text => text.includes('修改后通过')), 'final immutable history retains distinct revised approval');
assert.ok(finalHistoryText.some(text => text.includes('退回') && text.includes(returnReason)), 'final immutable history retains return');

assert.ok(pageErrors.length === 0, `browser page errors: ${JSON.stringify(pageErrors)}`);
const knownFontOrigins = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];
const unexpectedBlockedRequests = [...new Set(blockedRequests.map(item => item.origin))].filter(origin => !knownFontOrigins.includes(origin));
const unexpectedFailedRequests = failedRequests.filter(item => !knownFontOrigins.includes(item.origin));
const unexpectedDeniedResponses = deniedResponses.filter(route => route !== '/api/staff/therapy-review-attention');
assert.ok(unexpectedDeniedResponses.length === 0, `unexpected HTTP 403 responses: ${JSON.stringify(deniedResponses)}`);
const unexpectedConflictResponses = conflictResponses.filter(route => !/^\/api\/staff\/therapy-drafts\/[^/]+\/revisions$/.test(route));
assert.ok(unexpectedConflictResponses.length === 0, `unexpected HTTP 409 responses: ${JSON.stringify(conflictResponses)}`);
const unexpectedConsoleErrors = consoleMessages.filter(item => item.type === 'error'
  && !/fonts\.(?:googleapis|gstatic)\.com|ERR_BLOCKED_BY_CLIENT/.test(item.text)
  && !(item.text.includes('net::ERR_FAILED') && failedRequests.some(request => knownFontOrigins.includes(request.origin)))
  && !(item.text.includes('403 (Forbidden)') && deniedResponses.length > 0
    && deniedResponses.every(route => route === '/api/staff/therapy-review-attention'))
  && !(item.text.includes('409 (Conflict)') && conflictResponses.length > 0
    && conflictResponses.every(route => /^\/api\/staff\/therapy-drafts\/[^/]+\/revisions$/.test(route))));
assert.ok(unexpectedBlockedRequests.length === 0, `unexpected external browser requests: ${JSON.stringify(unexpectedBlockedRequests)}`);
assert.ok(unexpectedFailedRequests.length === 0, `unexpected failed requests: ${JSON.stringify(unexpectedFailedRequests)}`);
assert.ok(unexpectedConsoleErrors.length === 0, `unexpected console errors: ${JSON.stringify(unexpectedConsoleErrors)}`);
const result = { status: 'PASS', browser: 'Playwright CLI using the project resource config', widths,
  guest: { id: fixtures.guestId, name: fixtures.guestName, stay: fixtures.stay, profileCompleteness: fixtures.healthProfileCompleteness },
  drafts: [draft1, revision, draft3, regenerated].map(item => ({ draftId: item.draftId, version: item.version,
    status: item.status || item.reviewStatus, reviewStatus: item.reviewStatus, sourceRunId: item.sourceRunId || null,
    stayStart: item.stayStart, stayEnd: item.stayEnd, itemCount: item.items?.length || 0,
    candidateIds: [...new Set((item.items || []).map(entry => entry.candidateId).filter(Boolean))] })),
  review: { invalidSlotStatus: invalidRevision.status, invalidSlotErrorCode: invalidRevision.body.code || null,
    editedItemId: editedItem.id, oldSlotId: currentSlotId, replacementSlotId: replacement.value, revisionDraftId: revision.draftId,
    revisionStatus: revision.reviewStatus, approvedDraftId: approved.draftId, approvalStatus: approved.reviewStatus,
    reservationCount: approved.reservations.length },
  returnAndRegeneration: { returnedDraftId: draft3.draftId, returnReason, reasonVisibleToGuest: true,
    unsafeCandidatesBeforeReturn, regeneratedDraftId: regenerated.draftId, sourceLink: regenerated.evidence?.regeneration,
    seaBathAbsentAfterRegeneration: regenerated.items.every(item => item.title !== '海水浴' && item.candidateId !== 'project-sea-bath') },
  history: { actions: finalHistoryText.map(text => text.match(/修订|通过|退回|自动激活|纠正/)?.[0]).filter(Boolean),
    revisionApprovalAndReturnVisible: true },
  timeline: { upcomingReservationCount: afterRegenerationTimeline.data.upcomingBookings.length,
    proposedDraftCount: afterRegenerationTimeline.data.proposedDrafts.length, draftSeparateFromReservations: true },
  layout, pageErrors, consoleMessages: consoleMessages.slice(0, 30), deniedResponses, conflictResponses,
  blockedRequests: blockedRequests.slice(0, 30),
  failedRequests: failedRequests.slice(0, 30), draftResponses };
await page.evaluate(value => { document.title = 'STAGE22_BROWSER_RESULT:' + JSON.stringify(value); }, result);
return result;
}
