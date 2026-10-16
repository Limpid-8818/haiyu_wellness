import React, { useEffect, useRef, useState } from 'react';
// G18 阶段 2：助手样式随分包就近加载（原经 styles/index.css 顶层 @import 全量进首屏）。
import '../../styles/assistant.css';
import { request } from '../../lib/request.js';
import { WELLNESS_NOTIFICATION_EVENT, publishWellnessNotificationUpdate } from '../guest/brief.jsx';
import { wellnessTargetSection } from '../../app/navigation.js';
import { AssistantActionCard, AssistantCollaborationTrace, assistantExecutionModeLabel, assistantWelcome } from './assistant-parts.jsx';
import { SourceDetails } from '../../SourceDetails.jsx';

export function AssistantWidget({ role = 'public', user = null, guestId = '', onAuthExpired, onSelectResource, onNavigate,
  onOpenReviewSource, onOpenOperationsSource }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState('');
  const [status, setStatus] = useState(null);
  const [sending, setSending] = useState(false);
  const [progress, setProgress] = useState('');
  const [historyCursor, setHistoryCursor] = useState(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [confirmingActionId, setConfirmingActionId] = useState('');
  const [assistantNotices, setAssistantNotices] = useState([]);
  const [browserReminderStatus, setBrowserReminderStatus] = useState('');
  const [adviceDraft, setAdviceDraft] = useState(null);
  const [adviceSaving, setAdviceSaving] = useState(false);
  const [advicePublishNotice, setAdvicePublishNotice] = useState('');
  const controllerRef = useRef(null);
  const generationRef = useRef(0);
  const identityKey = `${role}:${user?.id || 'public'}:${['staff', 'dean'].includes(role) ? guestId || 'none' : 'none'}`;
  const identityRef = useRef(identityKey);
  const storageKey = `assistant-session:${identityKey}`;

  useEffect(() => {
    let active = true;
    request('/assistant/status').then((data) => { if (active) setStatus(data); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (role !== 'guest') { setAssistantNotices([]); return undefined; }
    let active = true;
    const refreshNotices = () => request('/me/wellness-notifications').then(data => {
      if (active) setAssistantNotices(Array.isArray(data.items) ? data.items : []);
    }).catch(() => {});
    void refreshNotices();
    window.addEventListener(WELLNESS_NOTIFICATION_EVENT, refreshNotices);
    return () => { active = false; window.removeEventListener(WELLNESS_NOTIFICATION_EVENT, refreshNotices); };
  }, [role, identityKey]);

  useEffect(() => {
    identityRef.current = identityKey;
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setText('');
    setMessages([]);
    setSessionId('');
    setAdviceDraft(null);
    setSending(false);
    setProgress('');
    setHistoryCursor(null);
    setHistoryHasMore(false);
    setOpen(false);
    setAdvicePublishNotice('');
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { saved = null; }
    if (saved?.sessionId) {
      setSessionId(saved.sessionId);
      const generation = generationRef.current;
      const controller = new AbortController();
      controllerRef.current = controller;
      const params = new URLSearchParams({ sessionId: saved.sessionId, role, limit: '30' });
      const historyRequest = request(`/assistant/history?${params.toString()}`, { signal: controller.signal })
        .then((data) => {
          if (generation !== generationRef.current || identityRef.current !== identityKey) return;
          setMessages(data.messages || []);
          setHistoryCursor(data.nextBeforeId || null);
          setHistoryHasMore(Boolean(data.hasMore));
          return data.messages || [];
        })
        .catch(() => [])
        .finally(() => { if (controllerRef.current === controller) controllerRef.current = null; });
      if (saved.runId) {
        setSending(true);
        setProgress('正在恢复上次查询…');
        void historyRequest.then(messages => pollRun(saved.runId, controller, generation, messages, saved.reply))
          .catch(() => {}).finally(() => {
          if (generation === generationRef.current && identityRef.current === identityKey) {
            setSending(false);
            setProgress('');
          }
        });
      }
    }
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [identityKey, role, storageKey]);

  useEffect(() => {
    if (open && !messages.length) setMessages([{ role: 'assistant', content: assistantWelcome(role),
      clientMessageId: `welcome:${identityKey}` }]);
  }, [open, role, identityKey, messages.length]);

  function clearConversation() {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    setMessages([]);
    setSessionId('');
    setText('');
    setSending(false);
    setProgress('');
    setHistoryCursor(null);
    setHistoryHasMore(false);
    setAdviceDraft(null);
    setAdvicePublishNotice('');
    sessionStorage.removeItem(storageKey);
  }

  function upsertRunMessage(run, mergeLatestHistory = false) {
    const message = {
      role: 'assistant', content: run.reply || '助手暂时没有返回内容。', runId: run.runId,
      mode: assistantExecutionModeLabel(run.executionMode || (run.live ? 'live' : 'safe_guidance')), sources: run.sources || [],
      clarificationState: run.clarificationState || null,
      collaboration: run.collaboration || null,
      actionCards: run.actionCards || [],
      retryable: Boolean(run.retryable), error: run.status === 'failed'
    };
    setMessages((previous) => {
      const runMatches = previous.map((item, index) => item.runId === run.runId ? index : -1).filter(index => index >= 0);
      const exactReplyMatches = runMatches.filter(index => previous[index].role === 'assistant'
        && previous[index].content === message.content);
      let match = exactReplyMatches.at(-1) ?? runMatches.at(-1) ?? -1;
      if (match < 0 && mergeLatestHistory) {
        const exactHistoryMatches = previous.map((item, index) => item.role === 'assistant'
          && !item.runId && item.content === message.content ? index : -1).filter(index => index >= 0);
        if (exactHistoryMatches.length === 1) match = exactHistoryMatches[0];
      }
      if (match < 0) return [...previous, message];
      const next = [...previous];
      next[match] = { ...next[match], ...message };
      return next;
    });
  }

  function updateActionCard(actionCard) {
    setMessages(previous => previous.map(message => ({
      ...message,
      actionCards: (message.actionCards || []).map(card => card.id === actionCard.id ? actionCard : card)
    })));
  }

  async function confirmActionCard(card) {
    if (!sessionId || confirmingActionId) return;
    setConfirmingActionId(card.id);
    try {
      const response = await request(`/assistant/actions/${encodeURIComponent(card.id)}/confirm`, {
        method: 'POST', body: JSON.stringify({ sessionId, version: card.version }),
        headers: { 'Idempotency-Key': `assistant-action:${card.id}:v${card.version}` },
        onUnauthorized: onAuthExpired
      });
      if (response.actionCard) updateActionCard(response.actionCard);
    } catch (error) {
      setProgress(error.message || '确认请求暂时无法完成');
    } finally { setConfirmingActionId(''); }
  }

  async function adoptCollaboration(collaboration) {
    const parentRunId = collaboration?.parent?.runId;
    const selectedCandidateIds = Array.isArray(collaboration?.finalAdoptedCandidateIds)
      ? collaboration.finalAdoptedCandidateIds : collaboration?.selectedCandidateIds;
    if (!sessionId || !parentRunId || !Array.isArray(selectedCandidateIds) || !selectedCandidateIds.length) return;
    const encoded = new TextEncoder().encode([...selectedCandidateIds].sort().join('\n'));
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    const suffix = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('').slice(0,48);
    const key = `adopt:${parentRunId}:${suffix}`;
    setAdviceSaving(true);
    setAdvicePublishNotice('正在保存已选方案…');
    try {
      const result = await request('/me/therapy-drafts', {
        method: 'POST', body: JSON.stringify({ action: 'adopt_candidate', sourceRunId: parentRunId,
          sessionId, selectedCandidateIds, candidateId: selectedCandidateIds[0] }),
        headers: { 'Idempotency-Key': key }, onUnauthorized: onAuthExpired
      });
      setAdviceDraft(result);
      setAdvicePublishNotice(`已保存疗程草案 ${result.draftId} · 版本 ${result.version}，来源运行 ${result.sourceRunId || parentRunId}；仍需医护审核。`);
      window.dispatchEvent(new CustomEvent(WELLNESS_NOTIFICATION_EVENT));
    } catch (error) {
      setAdvicePublishNotice(error.message || '方案保存失败，请稍后重试');
    } finally { setAdviceSaving(false); }
  }

  function navigateForAction(card) {
    const page = card.impact?.page || card.result?.page;
    const section = ({ schedule: 'schedule', reservations: 'reservations', projects: 'projects',
      meals: 'meals', health: 'health', wellness: 'schedule' })[page];
    if (section) onNavigate?.(section);
  }

  async function pollRun(runId, controller, generation, historyMessages = [], savedReply = null) {
    const startedAt = Date.now();
    for (;;) {
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      // G21：服务端状态卡在 running 时不再无限轮询，120 秒后转入可读的失败提示。
      if (Date.now() - startedAt > 120_000) throw new Error('处理时间过长，已停止自动刷新；结果可稍后在历史记录中查看。');
      const data = await request(`/assistant/runs/${encodeURIComponent(runId)}?role=${encodeURIComponent(role)}`, { signal: controller.signal });
      if (generation !== generationRef.current || identityRef.current !== identityKey) return data;
      const steps = data.steps || [];
      const lastStep = [...steps].reverse().find(step => step.status === 'running') || [...steps].reverse()[0];
      if (data.status === 'queued' || data.status === 'running') {
        setProgress(Date.now() - startedAt >= 20_000
          ? '仍在处理，刷新页面后也可继续查看进度…'
          : (lastStep?.summary || '正在整理你的信息…'));
      } else {
        const lastHistoryMessage = historyMessages.at(-1);
        const replyAlreadyPersisted = Boolean(savedReply && savedReply === data.reply && lastHistoryMessage?.role === 'assistant' &&
          lastHistoryMessage.content === data.reply);
        upsertRunMessage(data, replyAlreadyPersisted);
        setProgress('');
        try { sessionStorage.setItem(storageKey, JSON.stringify({ sessionId: data.sessionId, runId: data.runId, reply: data.reply })); } catch { /* storage can be unavailable */ }
        return data;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 500);
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
      });
    }
  }

  async function loadEarlierHistory() {
    if (!sessionId || !historyCursor || !historyHasMore || sending) return;
    try {
      const params = new URLSearchParams({ sessionId, role, beforeId: String(historyCursor), limit: '30' });
      if (['staff', 'dean'].includes(role) && guestId) params.set('guestId', guestId);
      const data = await request(`/assistant/history?${params.toString()}`);
      setMessages(previous => [...(data.messages || []), ...previous]);
      setHistoryCursor(data.nextBeforeId || null);
      setHistoryHasMore(Boolean(data.hasMore));
    } catch { /* keep the current page visible when history is unavailable */ }
  }

  async function retryRun(runId) {
    if (sending) return;
    const controller = new AbortController();
    const generation = generationRef.current;
    controllerRef.current = controller;
    setSending(true);
    setProgress('正在重试上次查询…');
    try {
      await request(`/assistant/runs/${encodeURIComponent(runId)}/retry`, {
        method: 'POST', body: JSON.stringify({ role }), signal: controller.signal
      });
      await pollRun(runId, controller, generation);
    } catch (error) {
      if (error?.name !== 'AbortError') setProgress(error.message || '重试暂时不可用');
    } finally {
      if (generation === generationRef.current) {
        controllerRef.current = null;
        setSending(false);
      }
    }
  }

  async function send(value = text) {
    const content = String(value || '').trim();
    if (!content || sending) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const body = { role, text: content, async: true, clientRequestId: crypto.randomUUID() };
    if (sessionId) body.sessionId = sessionId;
    if (['staff', 'dean'].includes(role) && guestId) body.guestId = guestId;
    setText('');
    setAdviceDraft(null);
    setMessages((previous) => [...previous, { role: 'user', content, clientMessageId: crypto.randomUUID() }]);
    setSending(true);
    setProgress('已提交，正在排队…');
    try {
      const data = await request('/assistant/chat', { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
      if (generation !== generationRef.current || identityRef.current !== identityKey) return;
      setSessionId(data.sessionId || '');
      try { sessionStorage.setItem(storageKey, JSON.stringify({ sessionId: data.sessionId, runId: data.runId })); } catch { /* ignore unavailable storage */ }
      await pollRun(data.runId, controller, generation);
    } catch (error) {
      if (error?.name === 'AbortError' || generation !== generationRef.current || identityRef.current !== identityKey) return;
      if (error.status === 401 && role !== 'public') {
        onAuthExpired?.();
        return;
      }
      const sessionError = [403, 404, 409].includes(error.status);
      setMessages((previous) => [...previous, {
        role: 'assistant',
        content: sessionError ? `当前助手会话无法继续：${error.message || '会话状态已变化'}。为保护隐私，刚才的内容没有自动重发，请点击“重新开始”后再输入。` : (error.message || '助手暂时无法回复，请稍后再试。'),
        clientMessageId: crypto.randomUUID(),
        error: true,
        restart: sessionError
      }]);
    } finally {
      if (generation === generationRef.current && identityRef.current === identityKey) {
        controllerRef.current = null;
        setSending(false);
        setProgress('');
      }
    }
  }

  async function publishAssistantAdvice(event) {
    event.preventDefault();
    if (!adviceDraft || !guestId || adviceSaving) return;
    setAdviceSaving(true);
    try {
      const result = await request(`/staff/guests/${encodeURIComponent(guestId)}/advice`, { method: 'POST',
        body: JSON.stringify({ title: adviceDraft.title, content: adviceDraft.content, priority: adviceDraft.priority }) });
      setAdviceDraft(null);
      setAdvicePublishNotice(`已由医护人员确认发布，医嘱编号 ${result.id}`);
      setProgress('');
    } catch (error) { setAdvicePublishNotice(error.message || '发布失败，请检查医嘱草稿'); }
    finally { setAdviceSaving(false); }
  }

  const currentAssistantNotice = role === 'guest' ? assistantNotices[0] : null;

  async function markAssistantNoticeRead(item) {
    if (!item || item.readAt) return;
    try {
      await request(`/me/wellness-notifications/${encodeURIComponent(item.id)}/read`, { method: 'PATCH', body: '{}' });
      publishWellnessNotificationUpdate();
    } catch { /* the notification center remains the source of truth */ }
  }

  function openAssistantNotice(item) {
    const section = wellnessTargetSection(item?.targetUrl);
    if (section) onNavigate?.(section);
    void markAssistantNoticeRead(item);
  }

  async function enableBrowserReminder() {
    if (typeof window.Notification === 'undefined') {
      setBrowserReminderStatus('此浏览器不支持通知；站内提醒仍保留在个人主页。');
      return;
    }
    try {
      const permission = window.Notification.permission === 'default'
        ? await window.Notification.requestPermission() : window.Notification.permission;
      if (permission === 'granted') {
        new window.Notification('海屿康养社区', { body: currentAssistantNotice?.message || '你有新的站内提醒。' });
        setBrowserReminderStatus('浏览器提醒已显示；站内提醒仍会保留在个人主页。');
      } else if (permission === 'denied') {
        setBrowserReminderStatus('浏览器通知未获允许；你仍可在个人主页查看站内提醒。');
      } else {
        setBrowserReminderStatus('浏览器尚未允许通知；你仍可在个人主页查看站内提醒。');
      }
    } catch { setBrowserReminderStatus('浏览器提醒暂不可用；站内提醒仍保留在个人主页。'); }
  }

  const latestActionCardMessageIndex = new Map();
  messages.forEach((message, index) => (message.actionCards || []).forEach(card => latestActionCardMessageIndex.set(card.id, index)));
  const visibleActionCards = messages.map((message, index) => {
    const seen = new Set();
    return (message.actionCards || []).filter(card => {
      if (latestActionCardMessageIndex.get(card.id) !== index || seen.has(card.id)) return false;
      seen.add(card.id);
      return true;
    });
  });

  return <>
    <button type="button" className={`assistant-fab ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-label={open ? '关闭智能助手' : '打开智能助手'}><span>{open ? '×' : '✦'}</span><small>{open ? '关闭' : 'AI 助手'}</small></button>
    {open && <section className="assistant-window" aria-label="智能助手对话">
      <header><div className="assistant-title"><span className="assistant-avatar">✦</span><div><strong>{role === 'public' ? '海屿接待助手' : role === 'guest' ? '健康支持助手' : role === 'dean' ? '院长管理助手' : '工作人员助手'}</strong><small><i/> {status?.executionMode === 'live' ? `已连接 ${status.model || '模型服务'}` : status?.executionMode === 'recorded_fixture' ? '录制模型夹具 · 验收环境' : '安全引导模式 · 可接入真实 API'}</small></div></div><button type="button" className="assistant-clear" onClick={clearConversation}>清空</button></header>
      <div className="assistant-messages" aria-live="polite">
        {historyHasMore && <button type="button" className="assistant-history-more" onClick={loadEarlierHistory} disabled={sending}>加载更早消息</button>}
        {currentAssistantNotice && <article className="stage25-assistant-notice" data-testid="stage25-assistant-notice" data-notification-id={currentAssistantNotice.id} data-source-id={currentAssistantNotice.sourceId} data-target-type={currentAssistantNotice.targetType} data-target-id={currentAssistantNotice.targetId} data-target-url={currentAssistantNotice.targetUrl}>
          <span className="eyebrow">站内提醒 · {currentAssistantNotice.sourceType}</span>
          <strong>{currentAssistantNotice.message}</strong>
          <SourceDetails><small>来源 {currentAssistantNotice.sourceId} · 目标 {currentAssistantNotice.targetType}:{currentAssistantNotice.targetId}</small></SourceDetails>
          <div><button type="button" onClick={() => openAssistantNotice(currentAssistantNotice)}>打开提醒</button>
            {!currentAssistantNotice.readAt && <button type="button" onClick={() => void markAssistantNoticeRead(currentAssistantNotice)}>标为已读</button>}
            <button type="button" onClick={() => void enableBrowserReminder()}>开启浏览器提醒</button></div>
          <small>仅当此浏览器开着时显示；站内通知保留在这里。{browserReminderStatus && ` ${browserReminderStatus}`}</small>
        </article>}
        {messages.map((message, index) => <div className={`assistant-message ${message.role} ${message.error ? 'assistant-error' : ''}`}
          data-run-id={message.runId || ''} data-message-id={message.id ?? ''}
          key={message.id !== undefined && message.id !== null ? `history-${message.id}`
            : message.clientMessageId || (message.runId ? `${message.role}-${message.runId}` : `${message.role}-local-${index}`)}>
          <div>{message.content}</div>
          {role === 'guest' && message.clarificationState?.entryPage === 'projects' && <button type="button"
            className="assistant-error-action appointment-entry" data-testid="assistant-booking-entry"
            onClick={() => onNavigate?.('projects')}>前往预约页面</button>}
          {role === 'guest' && visibleActionCards[index].map(card => <AssistantActionCard key={card.id} card={card}
            busy={confirmingActionId === card.id} onConfirm={() => confirmActionCard(card)}
            onRefresh={() => send('请重新核对当前业务状态并生成新的操作确认卡。')} onChoose={value => send(value)}
            onNavigate={() => navigateForAction(card)}/>) }
          {message.restart && <button type="button" className="assistant-error-action" onClick={clearConversation}>重新开始</button>}
          {message.retryable && message.runId && <button type="button" className="assistant-error-action" onClick={() => retryRun(message.runId)} disabled={sending}>重试查询</button>}
          {role === 'staff' && user?.jobType === 'clinician' && guestId && message.role === 'assistant' && message.runId && !message.error && !message.actionCards?.length && message.content
            && <button type="button" className="stage26-draft-trigger" data-testid="stage26-create-advice-draft" onClick={() => setAdviceDraft({
              runId: message.runId, title: '医护建议草稿', content: message.content, priority: 'normal'
            })}>转成医嘱草稿</button>}
          {adviceDraft && adviceDraft.runId === message.runId && <form className="stage26-advice-draft" data-testid="stage26-advice-draft" onSubmit={publishAssistantAdvice}>
            <strong>医嘱草稿 · 发布前请医护人员核对</strong>
            <label>标题<input required maxLength={200} value={adviceDraft.title} onChange={event => setAdviceDraft(current => ({ ...current, title: event.target.value }))}/></label>
            <label>内容<textarea required maxLength={5000} rows={5} value={adviceDraft.content} onChange={event => setAdviceDraft(current => ({ ...current, content: event.target.value }))}/></label>
            <label>重要程度<select value={adviceDraft.priority} onChange={event => setAdviceDraft(current => ({ ...current, priority: event.target.value }))}><option value="normal">建议</option><option value="important">重要</option><option value="urgent">紧急</option></select></label>
            <div><button type="submit" className="primary-btn" disabled={adviceSaving}>{adviceSaving ? '发布中…' : '医护确认并发布'}</button><button type="button" className="outline-btn" onClick={() => setAdviceDraft(null)} disabled={adviceSaving}>取消草稿</button></div>
            <small>取消只清除此编辑草稿；不会写入客人医嘱。</small>
          </form>}
          {message.sources?.length > 0 && <div className="assistant-sources"><strong>查询来源</strong>{message.sources.map(source => {
            const canOpenReview = role === 'staff' && user?.jobType === 'clinician' && source.type === 'wellness_draft';
            const canOpenOperations = role === 'staff' && user?.jobType === 'administrator' && source.type === 'project_slot';
            return <article key={`${source.type}:${source.id}`} data-source-type={source.type} data-source-id={source.id}>
              <span>{source.label}</span><SourceDetails><small>{source.id}</small></SourceDetails>
              {canOpenReview && <button type="button" data-testid="assistant-review-source" data-source-id={source.id}
                data-guest-id={guestId} data-run-id={message.runId || ''} data-tool-name="search_staff_review_context"
                onClick={() => onOpenReviewSource?.(source.id)}>打开待审方案</button>}
              {canOpenOperations && <button type="button" data-testid="assistant-operations-source" data-source-id={source.id}
                data-run-id={message.runId || ''} data-tool-name="search_operations_capacity"
                onClick={() => onOpenOperationsSource?.(source, message.content)}>打开运营时段</button>}
            </article>;
          })}</div>}
          {message.collaboration && <AssistantCollaborationTrace collaboration={message.collaboration} onSelectResource={onSelectResource}
            onAdopt={role === 'guest' ? adoptCollaboration : null}/>}
          {message.mode && <small className="assistant-mode">{message.mode}</small>}
          {message.quickReplies?.length > 0 && <div className="quick-replies">{message.quickReplies.map((quickReply) => <button type="button" key={quickReply} onClick={() => send(quickReply)} disabled={sending}>{quickReply}</button>)}</div>}
        </div>)}
        {advicePublishNotice && <div className="assistant-message assistant-mode" role="status">{advicePublishNotice}</div>}
        {sending && <div className="assistant-message assistant"><div className="typing">{progress || '正在整理你的信息…'}<span>·</span><span>·</span><span>·</span></div></div>}
      </div>
      <form className="assistant-input" onSubmit={(event) => { event.preventDefault(); send(); }}><label className="sr-only" htmlFor={`assistant-input-${identityKey.replace(/[^a-z0-9_-]/gi, '-')}`}>输入给智能助手的内容</label><input id={`assistant-input-${identityKey.replace(/[^a-z0-9_-]/gi, '-')}`} value={text} onChange={(event) => setText(event.target.value)} placeholder={role === 'guest' ? '描述你的身体情况或想了解的事…' : role === 'public' ? '输入你想了解的内容…' : '输入工作内容或客人情况…'} disabled={sending}/><button type="submit" disabled={sending || !text.trim()} aria-label="发送消息">↑</button></form>
      <footer>AI 建议仅作辅助，健康风险请联系现场工作人员</footer>
    </section>}
  </>;
}
