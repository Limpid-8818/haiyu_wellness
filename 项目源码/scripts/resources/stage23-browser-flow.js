async page => {
  const assert = {
    ok(value, message) { if (!value) throw new Error(message || 'assertion failed'); },
    equal(actual, expected, message) { if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`); },
    includes(actual, expected, message) { if (!String(actual).includes(expected)) throw new Error(`${message}: missing ${expected}`); },
    deepEqual(actual, expected, message) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${message}: ${JSON.stringify(actual)}`);
    }
  };
  const webUrl = __WEB_URL__;
  const fixture = __FIXTURE__;
  const screenshots = __SCREENSHOTS__;
  const phase = __FLOW_PHASE__;
  const errors = [];
  page.setDefaultTimeout(25000);
  page.setDefaultNavigationTimeout(25000);
  page.on('pageerror', error => errors.push(String(error.message || error).slice(0, 500)));

  async function capture(name) {
    const layout = [];
    for (const width of [1024, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForTimeout(150);
      const state = await page.evaluate(() => ({ viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
      assert.ok(state.documentWidth <= width && state.bodyWidth <= width,
        `${name} at ${width}px overflows: ${JSON.stringify(state)}`);
      layout.push({ page: name, ...state });
      await page.screenshot({ path: screenshots[name][width], fullPage: false });
    }
    return layout;
  }

  async function assistantOpen() {
    const open = page.getByRole('button', { name: '打开智能助手' });
    if (await open.count()) await open.click();
    await page.getByRole('region', { name: '智能助手对话' }).waitFor({ state: 'visible' });
  }

  async function send(text) {
    await assistantOpen();
    const input = page.getByLabel('输入给智能助手的内容');
    await input.fill(text);
    await page.getByRole('button', { name: '发送消息' }).click();
    await page.waitForFunction(() => document.querySelector('.assistant-input input')?.disabled === true, null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('.assistant-input input')?.disabled === false, null, { timeout: 90000 });
  }

  async function latestAction() {
    return await page.evaluate(async () => {
      const user = JSON.parse(localStorage.getItem('community_user') || 'null');
      const key = `assistant-session:guest:${user?.id}:none`;
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (!saved?.sessionId) throw new Error('assistant session was not saved in this browser tab');
      const token = localStorage.getItem('community_token');
      const query = new URLSearchParams({ sessionId: saved.sessionId, role: 'guest', limit: '30' });
      const response = await fetch(`/api/assistant/history?${query}`, { headers: { authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(`assistant history returned ${response.status}`);
      const cards = (data.messages || []).flatMap(message => message.actionCards || []);
      return { sessionId: saved.sessionId, cards, latest: cards.at(-1) || null };
    });
  }

  async function latestAssistantRun() {
    return await page.evaluate(async () => {
      const user = JSON.parse(localStorage.getItem('community_user') || 'null');
      const key = `assistant-session:guest:${user?.id}:none`;
      const saved = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (!saved?.sessionId) throw new Error('assistant session was not saved in this browser tab');
      const token = localStorage.getItem('community_token');
      const query = new URLSearchParams({ sessionId: saved.sessionId, role: 'guest', limit: '30' });
      const historyResponse = await fetch(`/api/assistant/history?${query}`, { headers: { authorization: `Bearer ${token}` } });
      const history = await historyResponse.json();
      if (!historyResponse.ok) throw new Error(`assistant history returned ${historyResponse.status}`);
      const runId = [...(history.messages || [])].reverse().find(message => message.role === 'assistant' && message.runId)?.runId;
      if (!runId) throw new Error('latest assistant message has no persisted run ID');
      const runResponse = await fetch(`/api/assistant/runs/${encodeURIComponent(runId)}?role=guest`,
        { headers: { authorization: `Bearer ${token}` } });
      const run = await runResponse.json();
      if (!runResponse.ok) throw new Error(`assistant run returned ${runResponse.status}`);
      return run;
    });
  }

  async function reservationItems() {
    return await page.evaluate(async () => {
      const token = localStorage.getItem('community_token');
      const response = await fetch('/api/reservations', { headers: { authorization: `Bearer ${token}` } });
      const data = await response.json();
      if (!response.ok) throw new Error(`reservations returned ${response.status}`);
      return data.items || [];
    });
  }

  async function confirm(cardId) {
    const card = page.locator(`[data-action-card-id="${cardId}"]`);
    await card.getByRole('button', { name: '确认并提交' }).click();
    await page.locator(`[data-action-card-id="${cardId}"].status-confirmed`).waitFor({ state: 'visible' });
    return card;
  }

  async function cardScreens(cardId, screenName) {
    const card = page.locator(`[data-action-card-id="${cardId}"]`);
    await card.scrollIntoViewIfNeeded();
    return await capture(screenName);
  }

  async function closeAssistant() {
    const close = page.getByRole('button', { name: '关闭智能助手' });
    if (await close.count()) await close.click();
  }

  async function openAssistantAfterReload() {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '日程', exact: true }).waitFor({ state: 'visible' });
    await assistantOpen();
  }

  const layoutChecks = [];
  let pending;
  let rows;
  if (phase === 'initial') {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(webUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /我是客人/ }).first().click();
    await page.getByLabel('账号').fill('guest_demo');
    await page.getByLabel('密码').fill('guest2026');
    await page.getByRole('button', { name: /进入工作区/ }).click();
    await page.getByRole('button', { name: '日程', exact: true }).waitFor({ state: 'visible' });

    await send(`请按我选定的沙滩漫步时段编号 ${fixture.bookingSlot.id} 提交预约，日期 ${fixture.businessDate}。`);
    pending = await latestAction();
    const firstRun = await latestAssistantRun();
    const firstRunSummary = { runId: firstRun.runId, status: firstRun.status, stopReason: firstRun.stopReason,
      errorCode: firstRun.errorCode, toolCounts: firstRun.toolCounts,
      steps: (firstRun.steps || []).map(step => ({ type: step.type, status: step.status,
        summary: step.summary, errorCode: step.errorCode })) };
    assert.equal(pending.latest?.actionType, 'book_program',
      `booking confirmation card is persisted from the guest's UI request; run=${JSON.stringify(firstRunSummary)}`);
    assert.equal(pending.latest.status, 'pending_confirmation', 'booking waits for the guest confirmation');
    assert.equal(pending.latest.impact.slot.id, fixture.bookingSlot.id, 'card shows the guest-selected slot');
    rows = await reservationItems();
    assert.equal(rows.length, fixture.baselineReservationCount, 'proposal alone does not create a reservation');
    layoutChecks.push(...await cardScreens(pending.latest.id, 'bookingPending'));
    return { phase, cardId: pending.latest.id, sessionId: pending.sessionId,
      status: pending.latest.status, reservationCount: rows.length };
  }
  if (phase !== 'continue') throw new Error(`unknown Stage23 browser flow phase ${phase}`);

  await openAssistantAfterReload();
  const expiredState = await latestAction();
  pending = { latest: expiredState.cards.find(card => card.id === fixture.expiredCardId), sessionId: expiredState.sessionId };
  assert.ok(pending.latest, 'expired proposal is present in refreshed assistant history');
  const expired = page.locator(`[data-action-card-id="${fixture.expiredCardId}"]`);
  await expired.waitFor({ state: 'visible' });
  assert.ok(await expired.evaluate(element => element.classList.contains('status-expired')), 'reloaded card is expired');
  assert.includes(await expired.innerText(), '已过期', 'expired card explains that confirmation is no longer valid');
  assert.equal(await expired.getByRole('button', { name: '重新核对' }).count(), 1, 'expired card offers revalidation');
  layoutChecks.push(...await capture('bookingExpired'));
  rows = await reservationItems();
  assert.equal(rows.length, fixture.baselineReservationCount, 'expired action remains write-free');
  const recheck = page.waitForResponse(response => response.request().method() === 'POST'
    && response.url().endsWith('/api/assistant/chat'), { timeout: 30000 });
  await expired.getByRole('button', { name: '重新核对' }).click();
  await recheck;
  await page.waitForFunction(() => !document.querySelector('.assistant-input input')?.disabled, null, { timeout: 90000 });
  rows = await reservationItems();
  assert.equal(rows.length, fixture.baselineReservationCount, 'revalidation does not confirm the expired card');

  await send(`请按我选定的沙滩漫步时段编号 ${fixture.bookingSlot.id} 提交预约，日期 ${fixture.businessDate}。`);
  const nextBooking = await latestAction();
  assert.equal(nextBooking.latest?.actionType, 'book_program');
  assert.equal(nextBooking.latest.status, 'pending_confirmation');
  const bookingCard = await confirm(nextBooking.latest.id);
  const bookingState = await latestAction();
  const confirmedBooking = bookingState.cards.find(card => card.id === nextBooking.latest.id);
  assert.equal(confirmedBooking?.status, 'confirmed', 'confirmed booking card persists with a result');
  assert.ok(confirmedBooking?.result?.businessId, 'booking result contains the real reservation ID');
  const confirmedReservationId = confirmedBooking.result.businessId;
  rows = await reservationItems();
  assert.equal(rows.length, fixture.baselineReservationCount + 1, 'confirmation creates exactly one reservation');
  assert.equal(rows.find(item => item.id === confirmedReservationId)?.status, 'confirmed');
  layoutChecks.push(...await cardScreens(confirmedBooking.id, 'bookingConfirmed'));

  await bookingCard.getByRole('button', { name: '查看相关页面' }).click();
  await page.getByRole('heading', { name: '日程与疗程草案' }).waitFor({ state: 'visible' });
  await page.locator('.reservation-row').filter({ hasText: confirmedReservationId }).waitFor({ state: 'visible' });
  await closeAssistant();
  layoutChecks.push(...await capture('scheduleBooking'));

  await send('我想取消一项预约');
  const cancellationChoice = await latestAction();
  assert.equal(cancellationChoice.latest?.actionType, 'cancel_booking');
  assert.equal(cancellationChoice.latest.status, 'needs_input', 'cancellation requires an explicit reservation choice');
  const choices = page.locator(`[data-action-card-id="${cancellationChoice.latest.id}"] .assistant-action-choices button`);
  assert.ok(await choices.count() >= 2, 'UI lists the guest reservations for explicit selection');
  const selectedChoice = choices.filter({ hasText: fixture.bookingSlot.localStart }).first();
  await selectedChoice.waitFor({ state: 'visible' });
  await selectedChoice.click();
  await page.locator('.assistant-action-card.status-pending_confirmation').last().waitFor({ state: 'visible' });
  const selectedCancellation = await latestAction();
  assert.equal(selectedCancellation.latest?.actionType, 'cancel_booking');
  assert.equal(selectedCancellation.latest.status, 'pending_confirmation');
  assert.equal(selectedCancellation.latest.parameters.reservationId, confirmedReservationId,
    'selected reservation ID is bound into the confirmation card');
  const cancellationCard = await confirm(selectedCancellation.latest.id);
  const cancellationState = await latestAction();
  const cancelledAction = cancellationState.cards.find(card => card.id === selectedCancellation.latest.id);
  assert.equal(cancelledAction?.result?.businessId, confirmedReservationId);
  assert.equal(cancelledAction?.result?.actualState, 'cancelled');
  rows = await reservationItems();
  assert.equal(rows.find(item => item.id === confirmedReservationId)?.status, 'cancelled');
  layoutChecks.push(...await cardScreens(cancelledAction.id, 'bookingCancelled'));

  await openAssistantAfterReload();
  const refreshedBooking = await latestAction();
  const oldCard = refreshedBooking.cards.find(card => card.id === confirmedBooking.id);
  assert.equal(oldCard?.result?.actualState, 'cancelled', 'refresh hydrates the original card with the current reservation state');
  const oldCardUi = page.locator(`[data-action-card-id="${confirmedBooking.id}"]`);
  await oldCardUi.waitFor({ state: 'visible' });
  assert.includes(await oldCardUi.innerText(), '已取消', 'the original booking card visibly changes to cancelled');
  layoutChecks.push(...await cardScreens(confirmedBooking.id, 'bookingCardRefreshedCancelled'));

  await send(`请帮我预约 ${fixture.businessDate} 早餐配餐。`);
  const mealProposal = await latestAction();
  assert.equal(mealProposal.latest?.actionType, 'book_meal');
  assert.equal(mealProposal.latest.status, 'pending_confirmation');
  const mealCard = await confirm(mealProposal.latest.id);
  const mealState = await latestAction();
  const mealOrder = mealState.cards.find(card => card.id === mealProposal.latest.id);
  assert.equal(mealOrder?.status, 'confirmed');
  assert.ok(mealOrder?.result?.businessId, 'meal order has a real ID');
  assert.equal(mealOrder?.result?.actualState, 'reserved');
  layoutChecks.push(...await cardScreens(mealOrder.id, 'mealConfirmed'));
  await mealCard.getByRole('button', { name: '查看相关页面' }).click();
  await page.getByRole('heading', { name: '每日膳食' }).waitFor({ state: 'visible' });
  await page.getByLabel('服务日期').fill(fixture.businessDate);
  await page.locator('.meal-order-status').first().waitFor({ state: 'visible' });
  await closeAssistant();
  layoutChecks.push(...await capture('mealOrderPage'));

  await send('请记录我的血压，收缩压130，舒张压80，单位mmHg。');
  const metricProposal = await latestAction();
  assert.equal(metricProposal.latest?.actionType, 'record_metric');
  assert.equal(metricProposal.latest.status, 'pending_confirmation');
  const metricCard = await confirm(metricProposal.latest.id);
  const metricState = await latestAction();
  const metric = metricState.cards.find(card => card.id === metricProposal.latest.id);
  assert.equal(metric?.status, 'confirmed');
  assert.ok(metric?.result?.businessId, 'health action contains the persisted health record ID');
  layoutChecks.push(...await cardScreens(metric.id, 'healthMetricConfirmed'));
  await metricCard.getByRole('button', { name: '查看相关页面' }).click();
  await page.getByRole('heading', { name: /健康/ }).first().waitFor({ state: 'visible' });
  await page.locator('.health-record-row').filter({ hasText: '130/80' }).waitFor({ state: 'visible' });
  await closeAssistant();
  layoutChecks.push(...await capture('healthMetricPage'));

  await send(`请为预约 ${fixture.restReservationId} 提交休息调整，原因：近期疲劳，希望医护重新评估安排。`);
  const restProposal = await latestAction();
  assert.equal(restProposal.latest?.actionType, 'rest_change');
  assert.equal(restProposal.latest.status, 'pending_confirmation');
  const restCard = await confirm(restProposal.latest.id);
  const restState = await latestAction();
  const rest = restState.cards.find(card => card.id === restProposal.latest.id);
  assert.equal(rest?.status, 'confirmed');
  assert.ok(rest?.result?.businessId, `rest request saves a versioned review draft ID: ${JSON.stringify(rest)}`);
  assert.equal(rest?.result?.actualState, 'pending_review', 'rest draft remains pending clinician review');
  layoutChecks.push(...await cardScreens(rest.id, 'restChangeConfirmed'));
  await restCard.getByRole('button', { name: '查看相关页面' }).click();
  await page.getByRole('heading', { name: '日程与疗程草案' }).waitFor({ state: 'visible' });
  const restDraft = page.locator('.stage21-draft-card').filter({ hasText: rest.result.businessId });
  await restDraft.waitFor({ state: 'visible' });
  assert.includes(await restDraft.innerText(), '等待医护审核', 'rest draft is shown as inactive and pending review');
  assert.includes(await restDraft.innerText(), '休息调整（待医护审核）', 'the visible version contains the confirmed rest adjustment');
  rows = await reservationItems();
  assert.equal(rows.find(item => item.id === fixture.restReservationId)?.status, 'cancelled', 'rest confirmation cancels its selected original reservation');
  assert.equal(rows.some(item => item.status === 'confirmed'), false, 'the pending rest draft creates no replacement reservation');
  await closeAssistant();
  layoutChecks.push(...await capture('scheduleRestPending'));

  const beforeUnderstandingMisses = await reservationItems();
  const reservationSnapshot = rows => rows.map(item => ({ id: item.id, status: item.status })).sort((a, b) => a.id.localeCompare(b.id));
  const unresolvedRuns = [];
  for (let count = 1; count <= 3; count += 1) {
    await send('我想预约沙滩漫步，但目前无法说明日期和时段，请先按我实际提供的信息理解。');
    const run = await latestAssistantRun();
    assert.equal(run.status, 'completed', `unresolved booking run ${count} is persisted as completed`);
    assert.equal(run.stopReason, 'APPOINTMENT_UNDERSTANDING_UNRESOLVED');
    assert.equal(run.clarificationCount, count, `understanding miss count ${count} advances once`);
    assert.equal(run.actionCards.length, 0, 'a failed understanding attempt does not create an action card');
    const entry = page.getByTestId('assistant-booking-entry');
    assert.equal(await entry.count(), count === 3 ? 1 : 0, 'booking entry appears only on the third unresolved turn');
    unresolvedRuns.push({ runId: run.runId, stopReason: run.stopReason, clarificationCount: run.clarificationCount,
      modelCallCount: run.modelCallCount, toolCallCount: run.toolCallCount, actionCardCount: run.actionCards.length });
    if (count === 3) {
      await entry.scrollIntoViewIfNeeded();
      layoutChecks.push(...await capture('bookingUnderstandingFallback'));
    }
  }
  const afterUnderstandingMisses = await reservationItems();
  assert.deepEqual(reservationSnapshot(afterUnderstandingMisses), reservationSnapshot(beforeUnderstandingMisses),
    'three unresolved turns do not create, cancel or change any reservation');
  await page.getByTestId('assistant-booking-entry').click();
  await page.getByRole('heading', { name: '海滨项目库' }).waitFor({ state: 'visible' });
  const bookingUnderstandingFallback = { runIds: unresolvedRuns.map(item => item.runId), unresolvedRuns,
    reservationsUnchanged: true, entryPage: 'projects', destinationHeading: '海滨项目库', screenshotWidths: [1024, 1440, 1920] };

  assert.deepEqual(errors, [], `browser page errors: ${JSON.stringify(errors)}`);
  const result = { executionMode: 'recorded_fixture',
    initialProposalCardId: pending.latest.id, expiredCardId: pending.latest.id,
    confirmedBookingCardId: confirmedBooking.id, confirmedReservationId,
    cancellationCardId: cancelledAction.id, cancelledReservationId: confirmedReservationId,
    mealCardId: mealOrder.id, mealOrderId: mealOrder.result.businessId,
    metricCardId: metric.id, healthRecordId: metric.result.businessId,
    restCardId: rest.id, restDraftId: rest.result.businessId, bookingUnderstandingFallback, layoutChecks, pageErrors: errors.length };
  await page.evaluate(value => sessionStorage.setItem('__stage23FlowResult', JSON.stringify(value)), result);
  return result;
}
