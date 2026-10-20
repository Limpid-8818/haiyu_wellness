import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { GuestDailyBrief } from '../src/components/guest/brief.jsx';
import { GuestProfile } from '../src/components/guest/health-profile.jsx';
import { GuestHealth } from '../src/components/guest/health-metrics.jsx';
import { GuestProjects } from '../src/components/guest/projects.jsx';
import { GuestSchedule } from '../src/components/guest/schedule.jsx';
import { MoodSpace } from '../src/MoodSpace.jsx';
import EnvironmentPanel from '../src/EnvironmentPanel.jsx';
import { StaffDailySchedule } from '../src/components/staff/DailySchedule.jsx';
import { DietitianMealWorkbench } from '../src/components/staff/dietitian-workbench.jsx';
import { WellnessReviewWorkbench } from '../src/components/staff/wellness-workbench.jsx';
import { StayManagement } from '../src/components/staff/admin-org.jsx';

const originalFetch = globalThis.fetch;

function routeFetch(handler) {
  globalThis.fetch = vi.fn(async (url, options) => {
    const body = handler(String(url), options || {});
    return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

const me = { id: 'guest_001', name: '林海宁', role: 'guest', roomNo: '海屿 101' };
const noop = () => {};

describe('页面渲染冒烟补齐（测试成绩书配套）', () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('GuestDailyBrief 渲染每日简报与站内提醒', async () => {
    routeFetch((url) => {
      if (url.includes('/me/daily-brief')) {
        return { status: 'ready', businessDate: '2026-10-13', brief: { greeting: '早上好，林海宁', stay: {}, activities: [], meals: [], advice: [], environment: [], careItems: [], missing: [] } };
      }
      if (url.includes('/me/wellness-notifications')) return { items: [], unreadCount: 0 };
      return {};
    });
    render(<GuestDailyBrief me={me} go={noop}/>);
    expect(screen.getByRole('heading', { name: '每日简报' })).toBeDefined();
    expect(screen.getByRole('heading', { name: '站内提醒' })).toBeDefined();
    await waitFor(() => expect(screen.getByText(/早上好，林海宁/)).toBeDefined());
  });

  it('GuestProfile 渲染个人资料与健康自述区', async () => {
    routeFetch((url) => {
      if (url.includes('/me/health-assessment')) return { version: 0, profile: {} };
      if (url.includes('/me/health-intake-extractions')) return { items: [] };
      if (url.includes('/me/health-intakes')) return { history: [], pendingIntakes: [] };
      if (url.includes('/me/health-profile')) return { verifiedProfile: {}, pendingIntakes: [], history: [] };
      return {};
    });
    render(<GuestProfile me={me} notify={noop} onSaved={noop}/>);
    expect(screen.getByRole('heading', { name: '健康自述' })).toBeDefined();
    expect(screen.getByRole('heading', { name: /健康初评/ })).toBeDefined();
    await waitFor(() => expect(screen.getByRole('heading', { name: /口语自述提取/ })).toBeDefined());
  });

  it('GuestHealth 渲染健康记录与趋势区', async () => {
    routeFetch((url) => {
      if (url.includes('/me/health-records')) return [];
      if (url.includes('/me/health-trends')) return { points: [] };
      if (url.includes('/me/health-summary')) return {};
      return {};
    });
    render(<GuestHealth me={me}/>);
    await waitFor(() => expect(screen.getByRole('heading', { name: '新增健康记录' })).toBeDefined());
    expect(screen.getByRole('heading', { name: /趋势/ })).toBeDefined();
  });

  it('GuestProjects 渲染项目目录', async () => {
    routeFetch((url) => {
      if (url.includes('/api/projects') && url.includes('/slots')) return { slots: [] };
      if (url.includes('/api/projects/')) return { id: 'project-spa', name: '水疗 SPA', category: 'water_therapy', introduction: '演示项目详情' };
      if (url.includes('/api/projects')) return { items: [{ id: 'project-spa', name: '水疗 SPA', category: 'water_therapy', summary: '温和水疗', intensity: 'low' }] };
      if (url.includes('/reservations')) return { items: [] };
      return {};
    });
    render(<GuestProjects go={noop}/>);
    await waitFor(() => expect(screen.getByText('水疗 SPA')).toBeDefined());
  });

  it('GuestSchedule 渲染疗程草案与签到反馈区', async () => {
    routeFetch((url) => {
      if (url.includes('/me/checkins')) return { items: [] };
      if (url.includes('/me/replanning-events')) return { items: [] };
      if (url.includes('/me/therapy-drafts')) return { items: [] };
      if (url.includes('/me/timeline')) return { items: [] };
      if (url.includes('/me/wellness-notifications')) return { items: [], unreadCount: 0 };
      if (url.includes('/reservations')) return { items: [] };
      return {};
    });
    render(<GuestSchedule me={me} onSelectResource={noop}/>);
    await waitFor(() => expect(screen.getByRole('heading', { name: '项目签到与感受' })).toBeDefined());
    expect(screen.getByRole('heading', { name: /疗程草案版本/ })).toBeDefined();
  });

  it('MoodSpace 使用注入 API 渲染心情记录与资源目录', async () => {
    const requestApi = vi.fn(async (path) => {
      if (path.includes('/me/moods/')) return {};
      if (path.includes('/me/moods')) return [];
      if (path.includes('/me/mood-summary')) return {};
      if (path.includes('/me/mood-trends')) return { points: [], replanEvents: [] };
      if (path.includes('/me/mood-focus-items')) return [];
      if (path.includes('/mood/resources')) {
        return [{ id: 'breathing', title: '呼吸放松', category: '呼吸', durationSeconds: 180, audioUrl: '/api/mood/resources/breathing/audio', coverUrl: '', license: '演示' }];
      }
      return {};
    });
    render(<MoodSpace requestApi={requestApi}/>);
    await waitFor(() => expect(screen.getByText('呼吸放松')).toBeDefined());
  });

  it('EnvironmentPanel 使用注入 API 渲染今日天气与潮汐', async () => {
    const requestApi = vi.fn(async () => ({ status: 'unavailable', location: { name: '大连开发区代表点' }, weather: null, tide: null, marine: null }));
    render(<EnvironmentPanel requestApi={requestApi}/>);
    expect(screen.getByRole('heading', { name: '今日天气与潮汐' })).toBeDefined();
    await waitFor(() => expect(screen.getByText('环境数据不可用')).toBeDefined());
  });

  it('StaffDailySchedule 渲染当日服务安排', async () => {
    routeFetch((url) => {
      if (url.includes('/staff/schedule')) {
        return { date: '2026-10-13', items: [{ reservationId: 'res_1', guestName: '林海宁', projectName: '水疗 SPA', localStart: '09:30', localEnd: '10:30', status: 'confirmed', executions: [] }] };
      }
      return {};
    });
    render(<StaffDailySchedule jobType="coach" notify={noop}/>);
    await waitFor(() => expect(screen.getByText(/林海宁/)).toBeDefined());
  });

  it('DietitianMealWorkbench 空订单显示空态', async () => {
    routeFetch((url) => (url.includes('/staff/meals/orders') ? { items: [] } : {}));
    render(<DietitianMealWorkbench notify={noop}/>);
    await waitFor(() => expect(screen.getByRole('heading', { name: '当前没有可备餐订单' })).toBeDefined());
  });

  it('WellnessReviewWorkbench 渲染复核队列空态', async () => {
    routeFetch((url) => {
      if (url.includes('/staff/therapy-review-attention')) return { items: [] };
      if (url.includes('/staff/therapy-drafts')) return { items: [] };
      return {};
    });
    render(<WellnessReviewWorkbench notify={noop}/>);
    await waitFor(() => expect(screen.getByText(/暂无待复核|没有|队列|复核/)).toBeDefined());
  });

  it('StayManagement 渲染入住管理列表', async () => {
    routeFetch((url) => {
      if (url.includes('/dean/guests')) return [{ id: 'guest_001', name: '林海宁', roomNo: '海屿 101', checkIn: '2026-10-13', checkOut: '2026-10-16', stayStatus: 'in_stay' }];
      return {};
    });
    render(<StayManagement notify={noop}/>);
    await waitFor(() => expect(screen.getByText('林海宁')).toBeDefined());
  });
});
