import React, { useState } from 'react';
import { SourceDetails } from '../../SourceDetails.jsx';

export function agentStateLabel(state) {
  return ({ not_run: '尚未运行', queued: '等待执行', running: '正在执行', completed: '已完成', partial_failure: '部分任务未完成', failed: '执行失败', interrupted: '执行已中断' })[state] || state;
}

export function AssistantActionCard({ card, busy, onConfirm, onRefresh, onChoose, onNavigate }) {
  const result = card.result || {};
  const labels = { needs_input: '需要补充信息', pending_confirmation: '等待本人确认', confirmed: result.actualState === 'cancelled' ? '已取消' : '已完成',
    rejected: '当前条件不允许', stale: '信息已变化', expired: '已过期', failed: '未能完成', superseded: '已更新' };
  const resultLabel = result.businessType === 'reservation' ? '预约' : result.businessType === 'meal_order' ? '配餐订单'
    : result.businessType === 'meal_menu' ? '餐单' : result.businessType === 'health_record' ? '健康记录'
      : result.businessType === 'wellness_draft' ? '疗程调整草稿' : '业务记录';
  const detail = result.businessId ? `${resultLabel}编号 ${result.businessId} · 状态 ${result.actualState || '已保存'}` : '';
  return <section className={`assistant-action-card status-${card.status}`} aria-label="助手操作确认卡" data-action-card-id={card.id}>
    <header><strong>{labels[card.status] || '操作信息'}</strong><small>版本 {card.version}</small></header>
    <p>{card.impact?.summary || '请核对以下操作信息。'}</p>
    {card.missingFields?.length > 0 && <p>还需要：{card.missingFields.join('、')}</p>}
    {card.impact?.project && <p>{card.impact.project.name} · {card.impact.date || ''}</p>}
    {card.impact?.slot && <p>时段 {card.impact.slot.start}–{card.impact.slot.end} · 剩余 {card.impact.slot.remaining}</p>}
    {card.impact?.reservation && <p>原预约：{card.impact.reservation.projectName} · {card.impact.reservation.businessDate} {card.impact.reservation.localStart}</p>}
    {card.impact?.items?.length > 0 && <ul>{card.impact.items.map(item => <li key={item.id}>{item.slot || item.dishName}: {item.dishName || item.dishId}</li>)}</ul>}
    {card.status === 'needs_input' && card.impact?.availableSlots?.length > 0 && <div className="assistant-action-choices">{card.impact.availableSlots.map(slot => <button type="button" key={slot.id} onClick={() => onChoose(`我选择 ${slot.localStart} 至 ${slot.localEnd}，时段编号 ${slot.id}`)}>{slot.localStart}–{slot.localEnd} · 余 {slot.remaining}</button>)}</div>}
    {card.status === 'needs_input' && card.impact?.reservations?.length > 0 && <div className="assistant-action-choices">{card.impact.reservations.map(item => <button type="button" key={item.reservationId} onClick={() => onChoose(`我选择取消预约 ${item.reservationId}`)}>{item.projectName} · {item.businessDate} {item.localStart}</button>)}</div>}
    {card.impact?.dish && <p>替换为：{card.impact.dish.name}</p>}
    {card.impact?.record && <p>记录：{card.impact.record.metric} · {JSON.stringify(card.impact.record.values)} {card.impact.record.unit}</p>}
    {card.impact?.resultMessage && <p role="status">{card.impact.resultMessage}</p>}
    {detail && <p role="status">{detail}</p>}
    <footer>
      {card.status === 'pending_confirmation' && <button type="button" className="primary-btn" onClick={onConfirm} disabled={busy}>{busy ? '正在复核…' : '确认并提交'}</button>}
      {card.status === 'confirmed' && <button type="button" className="outline-btn" onClick={onNavigate}>查看相关页面</button>}
      {['stale', 'expired', 'failed', 'rejected'].includes(card.status) && <button type="button" className="outline-btn" onClick={onRefresh}>重新核对</button>}
    </footer>
  </section>;
}

export function assistantExecutionModeLabel(mode) {
  if (mode === 'live') return '真实模型服务';
  if (mode === 'recorded_fixture') return '录制模型夹具';
  if (mode === 'offline_fixture') return '离线网页夹具 · 未调用模型';
  return '安全引导模式';
}

export function AssistantCollaborationTrace({ collaboration, onSelectResource, onAdopt }) {
  const [expanded, setExpanded] = useState(false);
  const parent = collaboration.parent || {};
  const selectionVerified = collaboration.coordinatorStatus === 'completed'
    && collaboration.selectionSource === 'model'
    && collaboration.selectionValidation?.schemaValid === true
    && collaboration.selectionValidation?.allowlistValid === true
    && collaboration.selectionValidation?.responseComplete === true;
  return <section className="assistant-collaboration">
    <button type="button" className="assistant-trace-toggle" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <span>本次如何生成</span><small>{collaboration.agents?.length || 0} 个专业任务 · {assistantExecutionModeLabel(collaboration.executionMode)}</small><b aria-hidden="true">{expanded ? '−' : '+'}</b>
    </button>
    {expanded && <div className="assistant-trace-body">
      <div className="assistant-trace-run"><strong>{parent.name || '海屿管家'} · 协调任务</strong><SourceDetails><small>runId {parent.runId || '—'}</small></SourceDetails><small>{parent.agentId || 'household.concierge'} · v{parent.instructionVersion || '—'} · {assistantExecutionModeLabel(parent.executionMode)}</small>
        {parent.model && <small>模型 {parent.model}</small>}
        {collaboration.coordinatorError
          ? <small className="assistant-trace-coordinator-status failed">管家选择未完成（{collaboration.coordinatorError}）；回退来源：已完成领域智能体候选，未标为管家采用。</small>
          : selectionVerified
            ? <small className="assistant-trace-coordinator-status">选择来源：实际管家模型响应；schema 与候选白名单均通过；最终采纳 {collaboration.finalAdoptedCandidateIds?.length ?? collaboration.selectedCandidateIds?.length ?? 0} 项</small>
            : <small className="assistant-trace-coordinator-status unverified">管家选择状态未验证：该记录缺少完整的结构化选择与来源证据。</small>}
        {(parent.modelSteps || []).map(step => <small className="assistant-trace-step" key={`parent-step-${step.stepIndex}`}>{step.summary} · {step.status === 'completed' ? '完成' : step.status === 'failed' ? `失败（${step.errorCode || '未知原因'}）` : step.status} · {step.finishReason ? `finish_reason ${step.finishReason} · ` : ''}{formatTraceDuration(step.durationMs)} · {Number(step.inputTokens || 0) + Number(step.outputTokens || 0)} tokens</small>)}
        {(parent.validationSteps || []).map(step => <small className={`assistant-trace-validation ${step.status === 'failed' ? 'failed' : ''}`} key={`parent-validation-${step.stepIndex}`}>验证 step {step.status === 'completed' ? '通过' : `失败（${step.errorCode || '未知原因'}）`} · schema {step.diagnostic?.schemaValid === true ? '通过' : step.diagnostic?.schemaValid === false ? '失败' : '未执行'} · 白名单 {step.diagnostic?.allowlistValid === true ? '通过' : step.diagnostic?.allowlistValid === false ? '失败' : '未执行'}{step.diagnostic?.finishReason ? ` · finish_reason ${step.diagnostic.finishReason}` : ''}</small>)}
      </div>
      {(collaboration.agents || []).map(agent => <article className={`assistant-trace-agent ${agent.status === 'failed' ? 'failed' : ''}`} key={agent.runId}>
        <strong>{agent.name || agent.agentId} <span>{agent.status === 'completed' ? '已完成' : agent.status === 'failed' ? '未完成' : agent.status}</span></strong>
        <SourceDetails><small>runId {agent.runId}</small></SourceDetails><small>{agent.agentId} · v{agent.instructionVersion || '—'} · {assistantExecutionModeLabel(agent.executionMode)}</small>
        <small>{agent.model || '未取得模型'} · {formatTraceDuration(agent.durationMs)} · {Number(agent.inputTokens || 0) + Number(agent.outputTokens || 0)} tokens · 估算 ${Number(agent.estimatedCostUsd || 0).toFixed(6)}</small>
        {(agent.tools || []).map((tool, index) => <SourceDetails><small className="assistant-trace-tool" key={`${agent.runId}-${tool.toolName}-${index}`}>工具 {tool.toolName} · {tool.status === 'completed' ? '完成' : '失败'} · {formatTraceDuration(tool.durationMs)}</small></SourceDetails>)}
        {(agent.sources || []).length > 0 && <div className="assistant-trace-sources"><b>引用</b>{agent.sources.map(source => <SourceDetails><small key={`${agent.runId}-${source.type}:${source.id}`}>{source.label || source.type} · {source.id}</small></SourceDetails>)}</div>}
      </article>)}
      {(collaboration.gaps || []).map(gap => <div className="assistant-trace-gap" key={`${gap.agentId}:${gap.runId || 'missing'}`}>领域缺口：{gap.domain} 未完成（{gap.errorCode || '未知原因'}）</div>)}
      {(collaboration.candidates || []).length > 0 && <div className="assistant-trace-candidates"><b>候选复核</b>{collaboration.candidates.map(candidate => <div className={`assistant-trace-candidate ${candidate.status}`} key={`${candidate.domain}:${candidate.candidateId}`}>
        <strong>{candidate.title}</strong><span>{collaboration.coordinatorError && candidate.status === 'adopted'
          ? '领域候选（未经管家选择）'
          : `${candidateStatusLabel(candidate.status)}${selectionVerified && collaboration.selectedCandidateIds?.includes(candidate.candidateId)
            ? ' · 管家采用' : selectionVerified && candidate.status === 'adopted' ? ' · 管家未选择'
              : !selectionVerified && candidate.status === 'adopted' ? ' · 管家选择未验证' : ''}`}</span><small>{candidate.reason}</small>
        {(candidate.sourceIds || []).length > 0 && <SourceDetails><small>来源 ID：{candidate.sourceIds.map(source => source.id).join('、')}</small></SourceDetails>}
        {candidate.domain === 'psychology' && candidate.status === 'adopted' && candidate.details?.audioUrl && onSelectResource && <button type="button" className="assistant-resource-button" onClick={() => onSelectResource({
          id: candidate.details.resourceId || candidate.candidateId, title: candidate.title, audioUrl: candidate.details.audioUrl,
          durationSeconds: candidate.details.durationSeconds, source: candidate.details.resourceSource, license: candidate.details.license
        })}>打开陪伴课程</button>}
        {onAdopt && selectionVerified && candidate.status === 'adopted'
          && collaboration.finalAdoptedCandidateIds?.includes(candidate.candidateId)
          && <button type="button" className="assistant-resource-button" disabled={false}
            onClick={() => onAdopt(collaboration)}>采纳此方案</button>}
      </div>)}</div>}
      {collaboration.graphBudget && <small className="assistant-trace-budget">协作预算：模型 {collaboration.graphBudget.modelCalls}/{collaboration.graphBudget.maxModelCalls} 次 · 工具 {collaboration.graphBudget.toolCalls}/{collaboration.graphBudget.maxToolCalls} 次 · {Number(collaboration.graphBudget.inputTokens || 0) + Number(collaboration.graphBudget.outputTokens || 0)} tokens · ${Number(collaboration.graphBudget.estimatedCostUsd || 0).toFixed(6)} · {formatTraceDuration(collaboration.graphDurationMs)}</small>}
    </div>}
  </section>;
}

export function candidateStatusLabel(status) {
  if (status === 'adopted') return '可参考';
  if (status === 'rejected') return '已排除';
  if (status === 'requires_review') return '待人工复核';
  return '未采用';
}

export function formatTraceDuration(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '耗时记录不可用';
  return `${Math.max(0, Math.round(Number(value)))} ms`;
}

export function assistantWelcome(role) {
  if (role === 'public') return '你好，我是海屿接待助手。你可以问我入住服务、客人空间或工作人员入口。先告诉我，你想了解什么？';
  if (role === 'guest') return '你好，我是你的健康支持助手。你可以说“录入我的身体情况”，我会一次问一两个问题，帮你整理给工作人员。';
  if (role === 'dean') return '你好，我是院长管理助手。我可以根据工作记录帮你整理问题和改进意见。';
  return '你好，我是工作助手。你可以输入客人观察、交接内容或服务需求，我会帮你整理成可核对的工作材料。';
}
