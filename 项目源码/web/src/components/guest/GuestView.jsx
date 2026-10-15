import React, { useCallback, useEffect, useState } from 'react';
import { request } from '../../lib/request.js';
import { fmtDate, fmtDateTime } from '../../lib/date.js';
import { useQuery } from '../../lib/useQuery.js';
import { PageTitle, Metric, SectionHead, Empty, Loading } from '../../shared/ui.jsx';
import { admissionLabel } from '../../app/navigation.js';
import { BusinessReason } from '../../SourceDetails.jsx';
import { SourceDetails } from '../../SourceDetails.jsx';
import { businessText } from '../../../../shared/release-presentation.js';
import { AssistantCollaborationTrace, agentStateLabel } from '../assistant/assistant-parts.jsx';
import { MoodSpace } from '../../MoodSpace.jsx';
import EnvironmentPanel from '../../EnvironmentPanel.jsx';
import { GuestProfile } from './health-profile.jsx';
import { GuestHealth, GuestAdvice } from './health-metrics.jsx';
import { GuestSchedule, GuestReservations } from './schedule.jsx';
import { GuestProjects } from './projects.jsx';
import { GuestMeals } from './meals.jsx';
import { GuestDailyBrief } from './brief.jsx';

export function GuestView({ section, me, notify, onSaved, go, activeResource, onSelectResource }) {
  if (!me) return <Loading/>;
  if (section === 'profile') return <GuestProfile me={me} notify={notify} onSaved={onSaved}/>;
  if (section === 'health') return <GuestHealth me={me}/>;
  if (section === 'advice') return <GuestAdvice me={me}/>;
  if (section === 'schedule') return <GuestSchedule me={me} onSelectResource={onSelectResource}/>;
  if (section === 'projects') return <GuestProjects go={go}/>;
  if (section === 'meals') return <GuestMeals me={me} notify={notify}/>;
  if (section === 'my') return <GuestMy me={me} go={go}/>;
  if (section === 'reservations') return <GuestReservations go={go}/>;
  if (section === 'mood') return <MoodSpace requestApi={request} activeResource={activeResource} onSelectResource={onSelectResource}/>;

  return <GuestOverview me={me} go={go}/>;
}

function GuestMy({ me, go }) {
  const entries = [
    { id: 'profile', title: '我的档案', description: '查看与更新你可以编辑的联系资料。', detail: '联系资料可修改，正式健康档案由负责医护核实。' },
    { id: 'reservations', title: '我的预约', description: '查看服务时间、已确认预约和取消记录。', detail: '预约记录来自服务端。' },
    { id: 'mood', title: '心情与陪伴', description: '记录今天的心情、查看近 7/30 日变化并播放本地演示资源。', detail: '每天一条记录，保留修改历史。' },
    { id: 'health', title: '健康记录', description: `现有健康记录 ${me.health?.length || 0} 条。`, detail: '新增或撤回自己的指标记录。' },
    { id: 'advice', title: '我的医嘱', description: `现有医嘱 ${me.advice?.length || 0} 条。`, detail: '按负责医护的建议执行；如有疑问请联系医护。' }
  ];
  return <><PageTitle eyebrow="PERSONAL SPACE" title="我的" desc="个人档案入口与当前可查看的数据。"/><div className="guest-my-grid">{entries.map(entry => <button className="surface guest-my-entry" type="button" key={entry.id} onClick={() => go(entry.id)}><span className="guest-my-entry-icon" aria-hidden="true">{entry.id === 'health' ? '⌁' : entry.id === 'mood' ? '♡' : entry.id === 'accessibility' ? 'Aa' : entry.id === 'advice' ? '✚' : entry.id === 'reservations' ? '▦' : '◯'}</span><span className="guest-my-entry-copy"><strong>{entry.title}</strong><span>{entry.description}</span></span><span className="guest-my-entry-detail">{entry.detail}</span><span className="guest-my-entry-arrow" aria-hidden="true">→</span></button>)}</div></>;
}

const placeholderCopy = {
  schedule: { title: '日程', lead: '日程页面待开发。当前没有可预约的日程内容。', sub: '此处不会生成预约或活动安排。' },
  meals: { title: '膳食', lead: '膳食页面待开发。当前没有个人餐单或饮食数据。', sub: '此处不会展示模拟餐单或个性化建议。' },
  mood: { title: '心情记录', lead: '心情记录页面待开发。当前没有心情数据。', sub: '此处不会展示模拟的心情记录。' }
};

function GuestPlaceholder({ kind }) {
  const copy = placeholderCopy[kind];
  return <><PageTitle eyebrow="GUEST SPACE" title={copy.title} desc={copy.lead}/><section className="surface guest-placeholder-panel"><div className="guest-placeholder-state" role="status"><strong>页面尚未接入</strong><p>{copy.sub}</p></div></section></>;
}

function GuestOverview({ me, go }) {
  const profile = me.profile || {};
  return <><PageTitle eyebrow="PERSONAL SPACE" title={`你好，${me.name}`} desc="这里是你的康养主页，重要的信息都会在这里清晰呈现。"/><GuestDailyBrief me={me} go={go}/><div className="welcome-banner"><div><span className="banner-kicker">今日状态</span><h2>把今天过得松弛一点</h2><p>你的个人资料和健康信息已安全保存。需要帮助时，工作人员会在这里留下新的建议。</p></div><div className="banner-orb">海</div></div><div className="metric-grid"><Metric label="入住状态" value={admissionLabel(me.admissionStatus)} hint={profile.roomNo ? `房间 ${profile.roomNo}` : '等待机构办理入住'} tone="teal"/><button type="button" className="metric-card blue metric-button" onClick={() => go('health')}><span>健康记录</span><strong>{`${me.health?.length || 0} 条`}</strong><small>点击查看详情　→</small></button><button type="button" className="metric-card orange metric-button" onClick={() => go('advice')}><span>当前医嘱</span><strong>{`${me.advice?.length || 0} 条`}</strong><small>点击查看详情　→</small></button></div><EnvironmentPanel requestApi={request}/><GuestAgentResults/><div className="two-col"><section className="surface"><SectionHead title="我的健康概览" link="查看全部" onClick={() => go('health')}/><div className="health-glance"><div className="health-icon">⌁</div><div><strong>{me.health?.[0]?.type || '还没有健康记录'}</strong><p>{me.health?.[0] ? `${me.health[0].value} ${me.health[0].unit} · ${fmtDate(me.health[0].recordedAt)}` : '可以在“我的健康”中查看工作人员记录。'}</p></div><span className="health-status">已记录</span></div></section><section className="surface"><SectionHead title="最近的医嘱" link="查看全部" onClick={() => go('advice')}/><div className="advice-preview">{me.advice?.[0] ? <><div className="advice-priority important">重要</div><strong>{me.advice[0].title}</strong><p>{me.advice[0].content}</p><small>{me.advice[0].authorName || '工作人员'} · {fmtDate(me.advice[0].createdAt)}</small></> : <Empty text="暂无新的医嘱"/>}</div></section></div></>;
}

function GuestAgentResults() {
  const [open, setOpen] = useState(false);
  const { data: status, error, load } = useQuery(async (signal) => request('/agent/status', { signal }),
    [], { fallbackMessage: '暂时无法读取协作记录' });
  const run = status?.run;
  return <section className="surface" data-testid="guest-agent-results"><SectionHead title="管家协作" link="刷新协作" onClick={load}/>
    {error ? <p role="alert">{error}</p> : !status ? <p>正在读取协作记录…</p> : <>
      <p>{agentStateLabel(status.state)}</p>
      {run ? <><small>{fmtDateTime(run.createdAt)}</small><BusinessReason value={businessText(run.reply || '任务尚未返回答复。')}/>
        <button type="button" className="outline-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起原运行详情' : '打开原运行详情'}</button>
        {open && <div data-run-id={run.runId}><SourceDetails><p>会话 {run.sessionId}</p></SourceDetails><div className="assistant-sources"><strong>查询来源</strong>{run.sources.map(source => <article key={`${source.type}:${source.id}`}><span>{source.label}</span><SourceDetails><small>{source.id}</small></SourceDetails></article>)}</div>
          {run.collaboration && <AssistantCollaborationTrace collaboration={run.collaboration}/>}
          {run.steps.map(step => <p key={step.stepIndex}>{step.summary} · {step.status}</p>)}</div>}</> : <p>当前授权范围内没有协作记录。可使用右下角助手整理建议。</p>}
    </>}
  </section>;
}
