import React, { Suspense, lazy, useEffect } from 'react';
import { Loading, PageTitle } from '../../shared/ui.jsx';
import { OperationsWorkbench } from './OperationsWorkbench.jsx';
import { StaffDailySchedule } from './DailySchedule.jsx';
import { WellnessReviewWorkbench, WellnessHistoryWorkbench } from './wellness-workbench.jsx';
import { DietitianMealWorkbench } from './dietitian-workbench.jsx';
import { StaffGuests, StaffOverview, StaffAccount } from './guests.jsx';
import { ProjectAdmin, RulesWorkbench } from './admin-projects.jsx';
import { StaffManagement, CapabilitiesMatrix, StayManagement, AssignmentManagement } from './admin-org.jsx';

// G18：院长意见页按需加载。
const DeanTeam = lazy(() => import('../dean/DeanTeam.jsx').then(m => ({ default: m.DeanTeam })));

export function StaffView({ section, me, notify, onGuestChange, go, reviewDraftId = '', onReviewDraftOpened, operationsSource = null }) {
  useEffect(() => {
    if (section !== 'guests') onGuestChange(null);
  }, [section, onGuestChange]);
  if (!me) return <Loading/>;
  if (section === 'meal-prep' && me.jobType === 'dietitian') return <DietitianMealWorkbench notify={notify}/>;
  const canManage = Boolean(me.capabilities?.staffManagement);
  const canReview = Boolean(me.capabilities?.medicalAdvicePublish);
  const backSection = me.capabilities?.operationsSummaryView ? 'overview' : 'account';
  if (section === 'guests') return <StaffGuests notify={notify} onGuestChange={onGuestChange} canReview={canReview}/>;
  if (section === 'operations' && canManage) return <OperationsWorkbench notify={notify} me={me} initialSource={operationsSource}/>;
  if ((section === 'daily' && me.jobType === 'coach') || (section === 'therapy' && me.jobType === 'therapist')) {
    return <StaffDailySchedule jobType={me.jobType} notify={notify}/>;
  }
  if (section === 'wellness-review' && canReview) return <WellnessReviewWorkbench notify={notify} initialDraftId={reviewDraftId} onInitialDraftOpened={onReviewDraftOpened}/>;
  if (section === 'wellness-history' && (canReview || canManage)) return <WellnessHistoryWorkbench canOpenDetails={canReview} notify={notify}/>;
  if (section === 'team') return <Suspense fallback={<Loading/>}><DeanTeam notify={notify}/></Suspense>;
  if (section === 'staff-admin' && canManage) return <StaffManagement me={me} notify={notify}/>;
  if (section === 'projects-admin' && canManage) return <ProjectAdmin notify={notify}/>;
  if (section === 'capabilities' && canManage) return <CapabilitiesMatrix notify={notify}/>;
  if (section === 'admissions' && canManage) return <StayManagement notify={notify}/>;
  if (section === 'assignments' && canManage) return <AssignmentManagement notify={notify}/>;
  if (section === 'rules' && canReview) return <RulesWorkbench/>;
  if (section === 'account') return <StaffAccount me={me} notify={notify}/>;
  if (section === 'overview' && !me.capabilities?.operationsSummaryView) return <UnavailableStaffPage title="运营汇总暂不可用" backSection={backSection} go={go}/>;
  if (['review', 'daily', 'therapy', 'meal-prep'].includes(section)) {
    const page = {
      review: ['医护审核台', '医护工作入口已就绪。医护建议权限只授予医护岗位。'],
      daily: ['每日安排', '教练工作入口已就绪，具体服务排程将在后续阶段接入。'],
      therapy: ['理疗工作台', '理疗师工作入口已就绪，服务排程将在后续阶段接入。'],
      'meal-prep': ['备餐单', '配餐工作入口已就绪，餐单与备餐流程将在后续阶段接入。']
    }[section];
    return <UnavailableStaffPage title={page[0]} description={page[1]} backSection="guests" go={go}/>;
  }
  if (canManage && ['staff-admin', 'projects-admin', 'capabilities', 'admissions', 'assignments'].includes(section)) return <UnavailableStaffPage title="当前账号无权打开此页面" backSection={backSection} go={go}/>;
  return <StaffOverview me={me}/>;
}

function UnavailableStaffPage({ title, description = '当前岗位没有查看此页面的权限。', backSection, go }) {
  const backLabel = backSection === 'overview' ? '返回工作概览' : backSection === 'guests' ? '返回客人列表' : '返回我的账号';
  return <><PageTitle eyebrow="WORKSPACE" title={title} desc={description}/><section className="surface stage11-placeholder"><span aria-hidden="true">⌁</span><div><h2>工作入口已准备</h2><p>{description}</p><button type="button" className="outline-btn" onClick={() => go(backSection)}>← {backLabel}</button></div></section></>;
}
