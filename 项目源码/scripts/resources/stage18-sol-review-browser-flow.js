async (page) => {
  const baseUrl = __STAGE18_BASE_URL__;
  const businessNow = __STAGE18_NOW__;
  const shots = __STAGE18_SHOTS__;
  const consoleLimit = 16;
  const pageErrorLimit = 16;
  const requestFailureLimit = 20;
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const responseEvidence = [];
  const blockedExternal = [];
  let totalConsoleErrors = 0;
  let totalPageErrors = 0;
  let totalRequestFailures = 0;
  const assertions = {};
  let flowError = null;

  function requireCondition(value, message) {
    if (!value) throw new Error(message);
  }
  function near(actual, expected, tolerance) {
    return Math.abs(Number(actual) - Number(expected)) <= tolerance;
  }
  function recordConsole(message) {
    if (message.type() !== 'error') return;
    totalConsoleErrors += 1;
    if (consoleErrors.length >= consoleLimit) return;
    const location = message.location() || {};
    consoleErrors.push({
      observedAt: new Date().toISOString(), type: message.type(),
      text: String(message.text() || '').slice(0, 1200),
      url: String(location.url || page.url()).slice(0, 600),
      lineNumber: location.lineNumber ?? null, columnNumber: location.columnNumber ?? null
    });
  }
  function recordPageError(error) {
    totalPageErrors += 1;
    if (pageErrors.length >= pageErrorLimit) return;
    pageErrors.push({
      observedAt: new Date().toISOString(), name: String(error?.name || 'Error').slice(0, 100),
      text: String(error?.message || error).slice(0, 1200),
      stack: String(error?.stack || '').slice(0, 1600), url: String(page.url()).slice(0, 600)
    });
  }
  page.on('console', recordConsole);
  page.on('pageerror', recordPageError);
  page.on('requestfailed', request => {
    totalRequestFailures += 1;
    if (requestFailures.length >= requestFailureLimit) return;
    requestFailures.push({
      observedAt: new Date().toISOString(), url: String(request.url()).slice(0, 600),
      method: request.method(), failure: String(request.failure()?.errorText || '').slice(0, 500)
    });
  });
  page.on('response', response => {
    const url = response.url();
    if (url.includes('/api/mood/resources/missing/audio') || url.includes('/api/assistant/chat')) {
      responseEvidence.push({
        observedAt: new Date().toISOString(), url: String(url).slice(0, 600),
        status: response.status(), method: response.request().method()
      });
    }
  });

  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(20_000);
  await page.addInitScript((iso) => {
    const NativeDate = Date;
    const fixedEpoch = NativeDate.parse(iso);
    class FrozenDate extends NativeDate {
      constructor(...args) { super(...(args.length ? args : [fixedEpoch])); }
      static now() { return fixedEpoch; }
    }
    Object.setPrototypeOf(FrozenDate, NativeDate);
    window.Date = FrozenDate;
    window.__stage18ChatResponses = [];
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async function(input, init) {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
      const method = String(init?.method || (typeof input === 'object' ? input.method : 'GET')).toUpperCase();
      let requestBody = null;
      if (typeof init?.body === 'string') {
        try { requestBody = JSON.parse(init.body); } catch {}
      }
      const response = await nativeFetch(input, init);
      if (url.pathname === '/api/assistant/chat' && method === 'POST') {
        try {
          const body = await response.clone().json();
          window.__stage18ChatResponses.push({
            requestSessionId: requestBody?.sessionId || null,
            requestText: requestBody?.text || '',
            responseSessionId: body.sessionId || null,
            mode: body.mode || null, live: body.live ?? null
          });
        } catch {}
      }
      return response;
    };
  }, businessNow);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'data:' || url.protocol === 'blob:' || ['127.0.0.1', 'localhost'].includes(url.hostname)) {
      return route.continue();
    }
    blockedExternal.push({ observedAt: new Date().toISOString(), origin: url.origin, url: url.href.slice(0, 600) });
    return route.abort();
  });

  let bodyScanEvidence = null;
  let oceanEvidence = null;
  let missingAudioEvidence = null;
  let chatEvidence = null;
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '我是客人 →', exact: true }).click();
    await page.getByRole('button', { name: /进入工作区/ }).click();
    await page.getByRole('button', { name: '管家', exact: true }).waitFor({ state: 'visible' });

    async function openMood() {
      await page.getByRole('button', { name: '我的', exact: true }).click();
      const entry = page.locator('.guest-my-entry').filter({ hasText: '心情与陪伴' });
      await entry.waitFor({ state: 'visible' });
      await entry.click();
      await page.getByRole('heading', { name: '心情与陪伴', exact: true }).waitFor({ state: 'visible' });
      await page.getByRole('group', { name: '选择心情档位' }).waitFor({ state: 'visible' });
      await page.getByText('正在读取心情记录和陪伴资源…', { exact: true }).waitFor({ state: 'detached' });
    }
    async function getAudioSnapshot() {
      return await page.locator('.mood-player-dock audio').evaluate(audio => ({
        title: document.querySelector('.mood-player-copy strong')?.textContent?.trim() || '',
        src: audio.currentSrc, durationSeconds: audio.duration, currentTimeSeconds: audio.currentTime,
        paused: audio.paused, volume: audio.volume, muted: audio.muted,
        readyState: audio.readyState, networkState: audio.networkState
      }));
    }
    async function waitForAudioMetadata(minimumDuration) {
      await page.waitForFunction(minimum => {
        const audio = document.querySelector('.mood-player-dock audio');
        return Boolean(audio && audio.readyState >= 2 && Number.isFinite(audio.duration) && audio.duration >= minimum);
      }, minimumDuration);
    }
    async function waitForPlaying() {
      await page.waitForFunction(() => {
        const audio = document.querySelector('.mood-player-dock audio');
        return Boolean(audio && !audio.paused && audio.currentTime > 0.25);
      });
    }
    async function selectResource(title) {
      const card = page.locator('.mood-resource-card').filter({ hasText: title });
      await card.waitFor({ state: 'visible' });
      await card.getByRole('button').click();
      await page.getByTestId('mood-player-dock').locator('audio').waitFor({ state: 'visible' });
    }

    await openMood();
    const dock = page.getByTestId('mood-player-dock');

    await selectResource('身体扫描');
    await waitForAudioMetadata(100);
    const bodyUsage = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().includes('/mood-resources/body-scan/usage'));
    await dock.getByRole('button', { name: '播放', exact: true }).click();
    const bodyUsageResponse = await bodyUsage;
    requireCondition(bodyUsageResponse.status() === 201, '身体扫描播放使用事件未记录');
    const bodyBeforePlay = await getAudioSnapshot();
    requireCondition(bodyBeforePlay.title === '身体扫描', '当前播放器标题不是身体扫描');
    requireCondition(bodyBeforePlay.src.includes('/api/mood/resources/body-scan/audio'), 'currentSrc不是身体扫描资源路由');
    requireCondition(bodyBeforePlay.durationSeconds > 100 && bodyBeforePlay.durationSeconds < 110, '身体扫描解码时长超出预期');
    await waitForPlaying();
    await page.waitForTimeout(900);
    const bodyBeforeSeek = await getAudioSnapshot();
    const seekTarget = 31.5;
    await dock.locator('audio').evaluate((audio, target) => { audio.currentTime = target; }, seekTarget);
    await page.waitForFunction(target => {
      const audio = document.querySelector('.mood-player-dock audio');
      return Boolean(audio && Math.abs(audio.currentTime - target) < 0.25);
    }, seekTarget);
    const bodyAfterSeek = await getAudioSnapshot();
    requireCondition(near(bodyAfterSeek.currentTimeSeconds, seekTarget, 0.25), '身体扫描 seek 后 currentTime 未到目标位置');
    await page.waitForTimeout(700);
    const bodyAfterSeekPlayback = await getAudioSnapshot();
    requireCondition(bodyAfterSeekPlayback.currentTimeSeconds > seekTarget + 0.3, 'seek 后播放时间没有继续推进');
    await dock.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.mood-player-dock audio')?.paused === true);
    const bodyAfterPause = await getAudioSnapshot();
    requireCondition(bodyAfterPause.paused, '身体扫描暂停状态未生效');
    bodyScanEvidence = {
      resourceId: 'body-scan', title: bodyAfterPause.title, currentSrc: bodyAfterPause.src,
      decodedDurationSeconds: bodyAfterPause.durationSeconds, decodedReadyState: bodyAfterPause.readyState,
      usageResponseStatus: bodyUsageResponse.status(),
      beforeSeekCurrentTimeSeconds: bodyBeforeSeek.currentTimeSeconds,
      seekRequestedSeconds: seekTarget, afterSeekCurrentTimeSeconds: bodyAfterSeek.currentTimeSeconds,
      afterSeekPlaybackCurrentTimeSeconds: bodyAfterSeekPlayback.currentTimeSeconds,
      afterPauseCurrentTimeSeconds: bodyAfterPause.currentTimeSeconds, pausedAfterAction: bodyAfterPause.paused,
      volume: bodyAfterPause.volume, muted: bodyAfterPause.muted,
      seekAction: 'HTMLAudioElement.currentTime assignment followed by observed currentTime and continuing playback'
    };
    await dock.screenshot({ path: shots.bodyScan });

    await selectResource('海浪声');
    await waitForAudioMetadata(55);
    const oceanUsage = page.waitForResponse(response =>
      response.request().method() === 'POST' && response.url().includes('/mood-resources/ocean-waves/usage'));
    await dock.getByRole('button', { name: '播放', exact: true }).click();
    const oceanUsageResponse = await oceanUsage;
    requireCondition(oceanUsageResponse.status() === 201, '海浪声播放使用事件未记录');
    await waitForPlaying();
    await dock.locator('audio').evaluate(audio => { audio.volume = 0.37; audio.muted = false; });
    await page.waitForTimeout(700);
    const oceanBeforeRoute = await getAudioSnapshot();
    requireCondition(oceanBeforeRoute.title === '海浪声', '当前播放器标题不是海浪声');
    requireCondition(oceanBeforeRoute.src.includes('/api/mood/resources/ocean-waves/audio'), 'currentSrc不是海浪声资源路由');
    requireCondition(!oceanBeforeRoute.paused && oceanBeforeRoute.volume === 0.37 && !oceanBeforeRoute.muted,
      '海浪声播放中未保留调整后的音量状态');
    const audioNodeStored = await page.evaluate(() => {
      const audio = document.querySelector('.mood-player-dock audio');
      window.__stage18OceanAudioNode = audio;
      window.__stage18AssistantWindowNode = null;
      window.__stage18AssistantWindowNode = document.querySelector('.assistant-window');
      return Boolean(audio);
    });
    requireCondition(audioNodeStored, '无法记录海浪声 audio DOM 实例');

    await page.getByRole('button', { name: '管家', exact: true }).click();
    await page.getByRole('button', { name: '打开智能助手', exact: true }).click();
    const assistantWindow = page.locator('.assistant-window');
    await assistantWindow.waitFor({ state: 'visible' });
    const chatInput = page.getByLabel('输入给智能助手的内容');
    await chatInput.fill('本地演示消息：请确认海浪声播放器在站内切换时继续播放。');
    const chatRequestPromise = page.waitForRequest(request =>
      request.method() === 'POST' && new URL(request.url()).pathname === '/api/assistant/chat');
    const chatResponsePromise = page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/assistant/chat');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const chatRequest = await chatRequestPromise;
    const chatResponse = await chatResponsePromise;
    requireCondition(chatResponse.status() === 200, '本地演示管家消息请求失败');
    const chatResult = await chatResponse.json();
    requireCondition(chatResult.mode === '安全引导模式' && chatResult.live === false, '聊天未使用本地安全引导模式');
    requireCondition(/^as_[0-9a-f-]{36}$/.test(chatResult.sessionId), '管家响应未返回有效 sessionId');
    await assistantWindow.locator('.assistant-message.user').filter({ hasText: '本地演示消息' }).waitFor({ state: 'visible' });
    await assistantWindow.locator('.assistant-message.assistant').filter({ hasText: chatResult.reply }).last().waitFor({ state: 'visible' });
    const chatObservations = await page.evaluate(() => window.__stage18ChatResponses || []);
    requireCondition(chatObservations.length === 1, '浏览器只应发送一条管家演示消息');
    requireCondition(chatObservations[0].responseSessionId === chatResult.sessionId, '拦截到的 sessionId 与页面响应不一致');
    requireCondition(chatObservations[0].mode === '安全引导模式' && chatObservations[0].live === false,
      '聊天观测未标记为本地演示模式');
    const assistantNodeBeforeReturn = await page.evaluate(() => {
      window.__stage18AssistantWindowNode = document.querySelector('.assistant-window');
      return Boolean(window.__stage18AssistantWindowNode);
    });
    requireCondition(assistantNodeBeforeReturn, '管家聊天窗口没有挂载');
    const timeBeforeReturn = oceanBeforeRoute.currentTimeSeconds;

    await page.getByRole('button', { name: '我的', exact: true }).click();
    await page.locator('.guest-my-entry').filter({ hasText: '心情与陪伴' }).click();
    await page.getByRole('heading', { name: '心情与陪伴', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('group', { name: '选择心情档位' }).waitFor({ state: 'visible' });
    await page.waitForTimeout(900);
    const oceanAfterReturn = await getAudioSnapshot();
    const returnIdentity = await page.evaluate(() => ({
      sameAudioNode: document.querySelector('.mood-player-dock audio') === window.__stage18OceanAudioNode,
      sameAssistantWindowNode: document.querySelector('.assistant-window') === window.__stage18AssistantWindowNode,
      chatSessionId: window.__stage18ChatResponses?.[0]?.responseSessionId || null,
      chatResponseCount: window.__stage18ChatResponses?.length || 0
    }));
    const authToken = await page.evaluate(() => localStorage.getItem('community_token'));
    const historyResponse = await page.evaluate(async input => {
      const response = await fetch('/api/assistant/history?role=guest&sessionId=' + encodeURIComponent(input.sessionId), {
        headers: { authorization: 'Bearer ' + input.token }
      });
      return { status: response.status, body: await response.json() };
    }, { sessionId: chatResult.sessionId, token: authToken });
    requireCondition(returnIdentity.sameAudioNode, '站内导航后海浪声 audio DOM 实例被重建');
    requireCondition(returnIdentity.sameAssistantWindowNode, '站内导航后原管家聊天窗口被重建');
    requireCondition(returnIdentity.chatSessionId === chatResult.sessionId && returnIdentity.chatResponseCount === 1,
      '返回页面后聊天 sessionId 或对话组件状态发生变化');
    requireCondition(historyResponse.status === 200 && historyResponse.body.sessionId === chatResult.sessionId,
      '返回后从服务端读取的聊天 sessionId 不一致');
    requireCondition(historyResponse.body.messages.length === 2, '原聊天 session 的消息记录没有保留');
    chatEvidence = {
      requestText: chatRequest.postDataJSON()?.text || null,
      requestSessionId: chatRequest.postDataJSON()?.sessionId || null,
      responseSessionId: chatResult.sessionId,
      historySessionIdAfterReturn: historyResponse.body.sessionId,
      historyMessageCount: historyResponse.body.messages.length,
      mode: chatResult.mode, live: chatResult.live,
      sameSessionIdAfterReturn: chatResult.sessionId === historyResponse.body.sessionId,
      originalUserMessageVisibleAfterReturn: await assistantWindow.locator('.assistant-message.user').filter({ hasText: '本地演示消息' }).count() === 1,
      assistantWindowSameDomInstance: returnIdentity.sameAssistantWindowNode
    };
    requireCondition(oceanAfterReturn.src === oceanBeforeRoute.src && !oceanAfterReturn.paused,
      '从原管家入口返回后海浪声没有继续播放或 source 改变');
    requireCondition(oceanAfterReturn.currentTimeSeconds > timeBeforeReturn + 0.35,
      '跨页面实际 currentTime 没有推进');
    requireCondition(near(oceanAfterReturn.volume, 0.37, 0.005) && oceanAfterReturn.muted === false,
      '跨页面返回后海浪声音量或 muted 状态改变');
    oceanEvidence = {
      resourceId: 'ocean-waves', title: oceanAfterReturn.title, currentSrc: oceanAfterReturn.src,
      decodedDurationSeconds: oceanAfterReturn.durationSeconds, decodedReadyState: oceanAfterReturn.readyState,
      usageResponseStatus: oceanUsageResponse.status(), volumeSetWhilePlaying: 0.37, mutedSetWhilePlaying: false,
      beforeRouteCurrentTimeSeconds: timeBeforeReturn,
      afterReturnCurrentTimeSeconds: oceanAfterReturn.currentTimeSeconds,
      currentTimeAdvancedSeconds: oceanAfterReturn.currentTimeSeconds - timeBeforeReturn,
      sourceUnchanged: oceanAfterReturn.src === oceanBeforeRoute.src,
      sameAudioDomInstance: returnIdentity.sameAudioNode,
      volumeAfterReturn: oceanAfterReturn.volume, mutedAfterReturn: oceanAfterReturn.muted,
      pausedAfterReturn: oceanAfterReturn.paused,
      assistantSessionIdFromResponse: chatResult.sessionId,
      assistantSessionIdAfterReturn: historyResponse.body.sessionId,
      assistantHistoryMessageCount: historyResponse.body.messages.length,
      assistantMode: chatResult.mode, assistantLive: chatResult.live,
      assistantRequestSessionId: chatRequest.postDataJSON()?.sessionId || null,
      assistantResponseAndHistorySessionIdSame: chatResult.sessionId === historyResponse.body.sessionId,
      assistantWindowSameDomInstance: returnIdentity.sameAssistantWindowNode,
      assistantUserMessageStillVisible: await assistantWindow.locator('.assistant-message.user').filter({ hasText: '本地演示消息' }).count() === 1
    };
    await page.screenshot({ path: shots.oceanPlaying, fullPage: false });

    await page.getByRole('button', { name: '关闭智能助手', exact: true }).click();
    await assistantWindow.waitFor({ state: 'detached' });
    await dock.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.mood-player-dock audio')?.paused === true);
    const oceanPausedBeforeRoute = await getAudioSnapshot();
    await page.getByRole('button', { name: '管家', exact: true }).click();
    await page.getByRole('button', { name: '我的', exact: true }).click();
    await page.locator('.guest-my-entry').filter({ hasText: '心情与陪伴' }).click();
    await page.getByRole('heading', { name: '心情与陪伴', exact: true }).waitFor({ state: 'visible' });
    await page.waitForTimeout(450);
    const oceanPausedAfterRoute = await getAudioSnapshot();
    const pausedIdentity = await page.evaluate(() =>
      document.querySelector('.mood-player-dock audio') === window.__stage18OceanAudioNode);
    requireCondition(pausedIdentity, '暂停状态跨页面时海浪声 audio DOM 实例被重建');
    requireCondition(oceanPausedBeforeRoute.paused && oceanPausedAfterRoute.paused,
      '暂停后跨页面播放器恢复为播放状态');
    requireCondition(near(oceanPausedAfterRoute.currentTimeSeconds, oceanPausedBeforeRoute.currentTimeSeconds, 0.15),
      '暂停后跨页面 currentTime 位置发生变化');
    requireCondition(near(oceanPausedAfterRoute.volume, 0.37, 0.005) && oceanPausedAfterRoute.muted === false,
      '暂停后跨页面音量或 muted 状态没有保留');
    oceanEvidence.pausedBeforeRoute = {
      currentTimeSeconds: oceanPausedBeforeRoute.currentTimeSeconds, paused: oceanPausedBeforeRoute.paused,
      volume: oceanPausedBeforeRoute.volume, muted: oceanPausedBeforeRoute.muted
    };
    oceanEvidence.pausedAfterRoute = {
      currentTimeSeconds: oceanPausedAfterRoute.currentTimeSeconds, paused: oceanPausedAfterRoute.paused,
      volume: oceanPausedAfterRoute.volume, muted: oceanPausedAfterRoute.muted,
      sameAudioDomInstance: pausedIdentity,
      positionDeltaSeconds: oceanPausedAfterRoute.currentTimeSeconds - oceanPausedBeforeRoute.currentTimeSeconds
    };
    await page.screenshot({ path: shots.oceanPaused, fullPage: false });

    const missingResponsePromise = page.waitForResponse(response =>
      response.url().includes('/api/mood/resources/missing/audio') && response.status() === 404);
    await dock.locator('audio').evaluate(audio => {
      audio.src = '/api/mood/resources/missing/audio';
      audio.load();
    });
    const missingResponse = await missingResponsePromise;
    await dock.getByRole('alert').waitFor({ state: 'visible' });
    const alertText = await dock.getByRole('alert').innerText();
    requireCondition(alertText.includes('资源加载失败'), 'missing-audio场景未显示资源失败提示');
    await dock.getByRole('button', { name: '重新加载', exact: true }).click();
    await page.waitForFunction(() => {
      const audio = document.querySelector('.mood-player-dock audio');
      return Boolean(audio && audio.readyState >= 2 && audio.duration > 55 && audio.currentSrc.includes('/ocean-waves/audio'));
    });
    await dock.getByRole('alert').waitFor({ state: 'detached' });
    const restoredOcean = await getAudioSnapshot();
    requireCondition(restoredOcean.src.includes('/api/mood/resources/ocean-waves/audio'),
      'retry没有恢复海浪声真实资源');
    missingAudioEvidence = {
      requestUrl: missingResponse.url(), httpStatus: missingResponse.status(),
      visibleAlert: alertText.slice(0, 300), restoredCurrentSrc: restoredOcean.src,
      restoredDurationSeconds: restoredOcean.durationSeconds, retrySucceeded: true
    };
  } catch (error) {
    flowError = String(error?.stack || error).slice(0, 4000);
  }

  const blockedOrigins = [...new Set(blockedExternal.map(item => item.origin))];
  const missingResponseEvent = responseEvidence.find(item =>
    item.url.includes('/api/mood/resources/missing/audio') && item.status === 404);
  for (const event of consoleErrors) {
    const eventMs = Date.parse(event.observedAt);
    const missingMs = missingResponseEvent ? Date.parse(missingResponseEvent.observedAt) : NaN;
    const locationMatchesMissing = event.url.includes('/api/mood/resources/missing/audio') ||
      event.text.includes('/api/mood/resources/missing/audio');
    const correlatedMissing404 = Number.isFinite(missingMs) && Math.abs(eventMs - missingMs) <= 5000 &&
      /404|failed to load resource/i.test(event.text);
    const externalOrigin = (() => {
      try { return new URL(event.url).origin; } catch { return ''; }
    })();
    if (locationMatchesMissing || correlatedMissing404) event.category = 'expected_missing_audio_recovery';
    else if (blockedOrigins.includes(externalOrigin)) event.category = 'expected_external_request_intercept';
    else event.category = 'unexpected_console_error';
  }
  for (const event of pageErrors) event.category = 'unexpected_pageerror';
  const expectedMissingAudioConsoleErrorCount = consoleErrors.filter(event =>
    event.category === 'expected_missing_audio_recovery').length;
  const expectedExternalConsoleErrorCount = consoleErrors.filter(event =>
    event.category === 'expected_external_request_intercept').length;
  const unexpectedConsoleErrorCount = consoleErrors.filter(event =>
    event.category === 'unexpected_console_error').length;
  const unexpectedPageErrorCount = pageErrors.length;
  const status = flowError || unexpectedConsoleErrorCount || unexpectedPageErrorCount ? 'FAIL' : 'PASS';
  const evidence = {
    status, taskId: null, observedAt: new Date().toISOString(),
    businessNow, businessTimeZone: 'Asia/Shanghai',
    assertions, bodyScan: bodyScanEvidence, oceanWaves: oceanEvidence,
    missingAudioRecovery: missingAudioEvidence, chat: chatEvidence,
    consoleEvidence: {
      originalTextCaptured: true, maximumStoredEventsPerType: consoleLimit,
      maximumConsoleTextCharacters: 1200, maximumPageErrorTextCharacters: 1200,
      totalConsoleErrors: totalConsoleErrors, storedConsoleErrors: consoleErrors.length,
      droppedConsoleErrorEvents: Math.max(0, totalConsoleErrors - consoleErrors.length),
      expectedMissingAudioConsoleErrorCount, expectedExternalConsoleErrorCount,
      unexpectedConsoleErrorCount, consoleErrors,
      totalPageErrors, storedPageErrors: pageErrors.length,
      droppedPageErrorEvents: Math.max(0, totalPageErrors - pageErrors.length),
      unexpectedPageErrorCount, pageErrors,
      requestFailures, totalRequestFailures,
      responseEvidence, blockedExternalRequests: blockedExternal,
      blockedExternalOrigins: blockedOrigins
    },
    flowError
  };
  return evidence;
}
