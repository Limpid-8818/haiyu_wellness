// G47：助手预约澄清模块，自 assistant.js 纯搬运；行为不变。
import { performance } from 'node:perf_hooks';
import { proposeGuestAction } from './assistant-actions.js';
import { isRealCalendarDate } from './assistant-tools.js';
import { measuredDurationMs } from './assistant-config.js';
import { db, json, now } from './db.js';
import { finishRun, insertStep, nextStepIndex } from './assistant-run.js';

export function hasExplicitBusinessAction(text) {
  const value = String(text || '').replace(
    /(?:不提供|不创建|不提交|不写入|不需要|不想|不愿意|不打算|先不|暂不|无需|不要|别|禁止|不代表|不能|不会|不自动)[^，,。；;\n]{0,12}(?:预约|预订|报名|取消|点餐|订餐|下单|换菜|替换|记录|记下|录入|调整|修改|停止活动|餐单|菜单|疗程变更)/gu,
    ''
  );
  const actions = /预约|预订|报名|取消|退订|点餐|订餐|下单|换菜|替换|记录|记下|录入|调整|修改|停止活动|休息调整|改期/u;
  const readOnly = /查看|查找|查询|查阅|看看|了解|读取|浏览|核对/u;
  for (const sentence of value.split(/[。！？!?；;\n]+/u)) {
    if (/(?:提交|办理|发起|完成)(?:.{0,12})?(?:预约|预订|报名)/u.test(sentence)) return true;
    const actionIndex = sentence.search(actions);
    if (actionIndex < 0) continue;
    const prefix = sentence.slice(0, actionIndex);
    if (/(?:我想|我要|我希望|希望|帮我|替我|为我|给我|请)(?:.{0,40})$/u.test(prefix)
      && !readOnly.test(prefix)) return true;
    if (/^(?:Q\d+:[A-Z0-9_.-]+\s*)?(?:请(?:帮我|替我|为我)?|帮我|替我|为我|给我)?\s*(?:取消|退订|点餐|订餐|下单|记录|记下|录入|换菜|替换|调整|修改|停止活动|休息调整|改期)/u.test(sentence.trim())) return true;
    if (/(?:把|将).{0,64}(?:替换为|换成|改成|调整为|修改为)/u.test(sentence)) return true;
  }
  return false;
}

export function isBookingActionRequest(text, role, intent) {
  if (role !== 'guest' || !intent.categories?.includes('schedule')) return false;
  const value = String(text || '');
  if (/取消|退订|休息调整|停止活动|调整疗程|改期/u.test(value)) return false;
  return /预约|预订|报名/u.test(value)
    && /(?:帮我|替我|为我|我想|我要|想要|希望|请)[^。！？!?；;\n]{0,120}(?:预约|预订|报名)|(?:提交|办理|发起|完成)(?:[^。！？!?；;\n]{0,12})(?:预约|预订|报名)|(?:预约|预订|报名).{0,16}(?:沙滩|项目|活动|海水浴|温泉|时段|名额)/u.test(value);
}

export function scopedGuestToolNames(intent, text) {
  const categories = new Set(intent.categories || []);
  if (!categories.size || categories.has('general')) return null;
  const value = String(text || '');
  const names = new Set(intent.toolNames || []);
  if (categories.has('schedule') || categories.has('projects')) {
    names.add('list_projects');
    names.add('list_project_slots');
    if (/我的日程|已有预约|预约记录|下个活动|我预约了|行程/u.test(value)) names.add('get_guest_schedule');
    if (/(?:帮我|替我|为我|我想|我要|想要|希望|请)[^。！？!?；;\n]{0,120}(?:预约|预订|报名)|(?:提交|办理|发起|完成)(?:[^。！？!?；;\n]{0,12})(?:预约|预订|报名)|(?:预约|预订|报名).{0,16}(?:沙滩|项目|活动|海水浴|温泉|时段|名额)/u.test(value)) {
      names.add('propose_program_booking');
    }
    if (/取消|退订/u.test(value)) names.add('propose_booking_cancellation');
    if (/休息|停止活动|调整疗程|改期/u.test(value)) names.add('propose_rest_change');
  }
  if (categories.has('meals')) {
    names.add('get_meal_menu');
    if (/下单|订餐|点餐|(?:预约|预订)[^。！？!?；;\n]{0,24}(?:早餐|午餐|晚餐)|(?:早餐|午餐|晚餐)[^。！？!?；;\n]{0,24}(?:配餐|订餐|下单|预约)/u.test(value)) {
      names.add('propose_meal_order');
    }
    if (/换菜|替换|不吃.{0,8}改成/u.test(value)) names.add('propose_dish_swap');
  }
  if (categories.has('health')) {
    names.add('get_health_summary');
    names.add('get_guest_profile');
    if (/记录|记下|录入|添加/u.test(value)) names.add('propose_health_metric');
  }
  if (categories.has('mood')) names.add('get_mood_summary');
  if (categories.has('profile')) names.add('get_guest_profile');
  if (categories.has('environment')) names.add('get_environment_snapshot');
  return names;
}

export function hasExplicitMissingAppointmentSlot(text) {
  return /还没有选择|还没(?:有)?选|尚未选择|尚未选|没有选择|没有选|未选择|未选|先列出可选(?:时段|时间)|列出可选(?:时段|时间)|请列出.{0,8}(?:时段|时间)|不要替我选|别替我选|不要自动选|不需要你选/u.test(String(text || ''));
}

export function explicitAppointmentDetails(text) {
  const value = String(text || '');
  const projectMatch = value.match(/(?:项目(?:编号|ID)|project(?:\s*id)?)[：:\s]+([a-z0-9_-]{1,64})/iu);
  const dateMatch = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/u);
  const projectId = projectMatch?.[1] || null;
  const date = dateMatch?.[1] || null;
  return projectId && date && isRealCalendarDate(date) ? { projectId, date } : null;
}

export async function recordReadOnlyAppointmentSlotClarification({ runId, role, intent, text }) {
  if (!isBookingActionRequest(text, role, intent) || !hasExplicitMissingAppointmentSlot(text)) return null;
  const details = explicitAppointmentDetails(text);
  if (!details) return null;
  const rows = await db.prepare(`SELECT tool_name AS toolName,arguments_json AS argumentsJson,
      result_json AS resultJson,status,error_code AS errorCode
    FROM tool_executions WHERE run_id=? ORDER BY started_at,id LIMIT 4`).all(runId);
  if (rows.length !== 2 || rows.some(row => row.status !== 'completed' || row.errorCode)) return null;
  const byName = new Map(rows.map(row => [row.toolName, row]));
  if (byName.size !== 2 || !byName.has('list_projects') || !byName.has('list_project_slots')) return null;
  const projectsResult = json(byName.get('list_projects').resultJson, null);
  const slotResult = json(byName.get('list_project_slots').resultJson, null);
  const slotArgs = json(byName.get('list_project_slots').argumentsJson, null);
  if (!Array.isArray(projectsResult) || !projectsResult.some(project => project?.id === details.projectId)
    || slotArgs?.projectId !== details.projectId || slotArgs?.date !== details.date
    || slotResult?.project?.id !== details.projectId || slotResult?.date !== details.date
    || !Array.isArray(slotResult?.slots)) return null;
  const offeredSlots = slotResult.slots.filter(slot => slot && typeof slot.id === 'string'
    && slot.status === 'listed' && Number(slot.availableCount) > 0)
    .map(slot => ({ id: slot.id, localStart: String(slot.localStart || ''),
      localEnd: String(slot.localEnd || ''), availableCount: Number(slot.availableCount) }));
  const projectName = slotResult.project.name
    || projectsResult.find(project => project.id === details.projectId)?.name || details.projectId;
  const status = offeredSlots.length ? 'awaiting_guest_slot_selection' : 'no_bookable_slots';
  const stopReason = offeredSlots.length ? 'APPOINTMENT_SLOT_SELECTION_REQUESTED' : 'APPOINTMENT_NO_BOOKABLE_SLOTS';
  const state = { flow: 'appointment', status, clarificationCount: 0, failureReason: null,
    protocolDisposition: offeredSlots.length ? 'VERIFIED_READ_ONLY_SLOT_LIST_AWAITING_GUEST_DECISION'
      : 'VERIFIED_READ_ONLY_SLOT_LIST_HAS_NO_BOOKABLE_OPTIONS',
    projectId: details.projectId, projectName, date: details.date, sourceRunId: runId,
    readOnlyTools: ['list_projects', 'list_project_slots'], offeredSlots };
  await db.prepare(`UPDATE agent_runs SET intent_category='schedule',clarification_count=0,
      clarification_state_json=?,stop_reason=? WHERE id=?`)
    .run(JSON.stringify(state), stopReason, runId);
  const reply = offeredSlots.length
    ? `已核对${projectName}在${details.date}的可选时段：${offeredSlots.map(slot =>
      `${slot.localStart}–${slot.localEnd}（时段编号 ${slot.id}，余量 ${slot.availableCount}）`).join('；')}。请你明确选择一个时段；我不会替你选择，也尚未提交预约。`
    : `已核对${projectName}在${details.date}的时段，目前没有可预约的选项；没有生成预约，也没有提交预约。`;
  return { state, reply, stopReason };
}

export async function latestAppointmentSlotClarification(sessionId, currentRunId) {
  const previous = await db.prepare(`SELECT r.id,r.intent_category AS intentCategory,
      r.clarification_count AS clarificationCount,r.clarification_state_json AS clarificationStateJson
    FROM agent_runs r JOIN assistant_messages m ON m.run_id=r.id AND m.role='user'
    WHERE r.session_id=? AND r.id<>? ORDER BY m.id DESC LIMIT 1`).get(sessionId, currentRunId);
  if (previous?.intentCategory !== 'schedule' || Number(previous.clarificationCount) !== 0) return null;
  const state = json(previous.clarificationStateJson, {});
  if (state.flow !== 'appointment' || state.status !== 'awaiting_guest_slot_selection'
    || state.sourceRunId !== previous.id || !state.projectId || !isRealCalendarDate(state.date)
    || !Array.isArray(state.offeredSlots) || !state.offeredSlots.length) return null;
  return state;
}

export function appointmentSlotClarificationFromCard(card, row) {
  if (card?.status !== 'needs_input' || card.actionType !== 'book_program') return null;
  const parameters = card.parameters || {};
  const offeredSlots = (Array.isArray(card.impact?.availableSlots) ? card.impact.availableSlots : [])
    .filter(slot => slot && typeof slot.id === 'string' && slot.id)
    .map(slot => ({ ...slot, localStart: String(slot.localStart || slot.start || ''),
      localEnd: String(slot.localEnd || slot.end || '') }));
  if (!parameters.projectId || !isRealCalendarDate(parameters.date) || !offeredSlots.length) return null;
  return { flow: 'appointment', status: 'awaiting_guest_slot_selection', projectId: parameters.projectId,
    projectName: card.impact?.project?.name || parameters.projectId, date: parameters.date,
    sourceRunId: row?.sourceRunId || null, sourceCardId: card.id, sourceCardVersion: Number(card.version), offeredSlots };
}

export function containsSlotSelectionLanguage(text) {
  return /(?:选择|选定|选中|选|时段编号|时段号)/u.test(String(text || ''));
}

export function explicitOfferedSlotSelection(text, clarification) {
  const value = String(text || '');
  if (/(?:不要|别|没有|没|未|尚未|还没有).{0,10}(?:选择|选定|选中|选)/u.test(value)) return null;
  if (!/(?:我(?:本人)?(?:选择|选定|选中|选)|我决定(?:选择|选)|就选|选择这个时段|选这个时段)/u.test(value)) return null;
  const matches = clarification.offeredSlots.filter(slot => value.includes(slot.id));
  if (matches.length !== 1) return null;
  const mentionedDate = value.match(/\b(20\d{2}-\d{2}-\d{2})\b/u)?.[1];
  if (mentionedDate && mentionedDate !== clarification.date) return null;
  return matches[0];
}

export async function completeAppointmentSlotSelection({ run, user, guestId, clarification, selectedSlot, started }) {
  const validationStartedAt = performance.now();
  let actionCard;
  try {
    actionCard = await proposeGuestAction({ actionType: 'book_program',
      parameters: { projectId: clarification.projectId, date: clarification.date, slotId: selectedSlot.id },
      user, role: 'guest', guestId, sessionId: run.session_id, runId: run.id,
      ...(clarification.sourceCardId ? { expectedPreviousCard: {
        id: clarification.sourceCardId, version: clarification.sourceCardVersion, status: 'needs_input'
      } } : {}) });
  } catch (error) {
    if (error?.code === 'ASSISTANT_ACTION_STALE') {
      return await rejectAppointmentSlotSelection({ run, clarification, started, reason: 'source_card_changed' });
    }
    throw error;
  }
  const stopReason = actionCard.status === 'pending_confirmation'
    ? 'APPOINTMENT_SLOT_REVALIDATED' : 'APPOINTMENT_SLOT_REVALIDATION_REJECTED';
  await db.prepare(`UPDATE agent_runs SET intent_category='schedule',clarification_count=0,
      clarification_state_json='{}' WHERE id=?`).run(run.id);
  const validationStep = await nextStepIndex(run.id);
  await insertStep(run.id, validationStep, { type: 'clarification', status: 'completed',
    summary: '客人明确选定已展示的时段；服务端重新核验并生成确认卡',
    diagnostic: { kind: 'appointment_slot_selection_revalidation', sourceRunId: clarification.sourceRunId,
      source: 'verified_read_only_slot_results', selectedSlotId: selectedSlot.id,
      actionCardId: actionCard.id, actionCardStatus: actionCard.status,
      modelToolCallRecorded: false, confirmationRequired: actionCard.status === 'pending_confirmation' },
    startedAt: now(), completedAt: now(), durationMs: measuredDurationMs(validationStartedAt) });
  const projectName = actionCard.impact?.project?.name || clarification.projectName || clarification.projectId;
  const slot = actionCard.impact?.slot || selectedSlot;
  const reply = actionCard.status === 'pending_confirmation'
    ? `你选择的${projectName} ${clarification.date} ${slot.start || selectedSlot.localStart}–${slot.end || selectedSlot.localEnd}时段已通过服务端复核。请在确认卡中再次确认；确认前不会创建预约。`
    : actionCard.status === 'rejected'
      ? `你选择的时段未通过当前服务端复核：${actionCard.impact?.summary || '时段状态已变化，请重新查询并选择。'}`
      : `已更新预约确认卡，请按卡片提示补齐信息；确认前不会创建预约。`;
  await insertStep(run.id, await nextStepIndex(run.id), { type: 'final', status: 'completed',
    summary: '已说明服务端复核结果及下一步明确确认要求',
    diagnostic: { stopReason, actionCardId: actionCard.id, actionCardStatus: actionCard.status },
    startedAt: now(), completedAt: now(), durationMs: measuredDurationMs(started) });
  return await finishRun(run.id, { status: 'completed', output: reply, live: false, stopReason });
}

export async function rejectAppointmentSlotSelection({ run, clarification, started, reason }) {
  await db.prepare("UPDATE agent_runs SET intent_category='schedule',clarification_count=0,clarification_state_json='{}' WHERE id=?")
    .run(run.id);
  await insertStep(run.id, await nextStepIndex(run.id), { type: 'clarification', status: 'completed',
    summary: '时段选择未能匹配当前预约卡中的唯一有效候选；保留原卡且未提交预约',
    diagnostic: { kind: 'appointment_slot_selection_rejected', sourceCardId: clarification.sourceCardId || null,
      sourceCardVersion: clarification.sourceCardVersion || null, reason, modelToolCallRecorded: false,
      providerRequestAttempted: false, confirmationRequired: true },
    startedAt: now(), completedAt: now(), durationMs: measuredDurationMs(started) });
  const reply = reason === 'source_card_changed'
    ? '预约卡已过期或发生变化，这次选择没有生效。请先查看最新卡片或重新查询时段；没有创建预约。'
    : '请从当前预约卡列出的时段中明确选择一个。此次选择没有匹配到唯一候选，原确认卡保持不变，也没有创建预约。';
  await insertStep(run.id, await nextStepIndex(run.id), { type: 'final', status: 'completed',
    summary: '已说明时段选择未生效并保留当前卡片',
    diagnostic: { stopReason: 'APPOINTMENT_SLOT_SELECTION_REJECTED', providerRequestAttempted: false },
    startedAt: now(), completedAt: now(), durationMs: measuredDurationMs(started) });
  return await finishRun(run.id, { status: 'completed', output: reply, live: false,
    stopReason: reason === 'source_card_changed' ? 'APPOINTMENT_SLOT_SELECTION_STALE' : 'APPOINTMENT_SLOT_SELECTION_REJECTED',
    inputTokens: Number(run.input_tokens || 0), outputTokens: Number(run.output_tokens || 0),
    estimatedCost: Number(run.estimated_cost_usd || 0) });
}

export async function recordBookingUnderstandingOutcome({ runId, sessionId, role, intent, text }) {
  if (!isBookingActionRequest(text, role, intent)) return { count: 0, state: null };
  const cards = await db.prepare('SELECT id,status FROM assistant_action_cards WHERE source_run_id=? AND action_type=\'book_program\' LIMIT 4')
    .all(runId);
  if (cards.length) {
    await db.prepare("UPDATE agent_runs SET intent_category='schedule',clarification_count=0,clarification_state_json='{}' WHERE id=?")
      .run(runId);
    return { count: 0, state: null, structuredActionCardIds: cards.map(card => card.id) };
  }
  const previous = await db.prepare(`SELECT r.intent_category AS intentCategory,r.clarification_count AS clarificationCount
    FROM agent_runs r JOIN assistant_messages m ON m.run_id=r.id AND m.role='user'
    WHERE r.session_id=? AND r.id<>? ORDER BY m.id DESC LIMIT 1`).get(sessionId, runId);
  const priorCount = previous?.intentCategory === 'schedule' ? Number(previous.clarificationCount || 0) : 0;
  const count = Math.min(3, priorCount + 1);
  const showBookingEntry = count >= 3;
  const state = { flow: 'appointment', status: 'unresolved', clarificationCount: count,
    failureReason: 'MODEL_DID_NOT_PRODUCE_BOOKING_ACTION',
    ...(showBookingEntry ? { entryPage: 'projects', entryPath: '/guest/projects' } : {}) };
  await db.prepare("UPDATE agent_runs SET intent_category='schedule',clarification_count=?,clarification_state_json=?,stop_reason='APPOINTMENT_UNDERSTANDING_UNRESOLVED' WHERE id=?")
    .run(count, JSON.stringify(state), runId);
  return { count, state };
}
