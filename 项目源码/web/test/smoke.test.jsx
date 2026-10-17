import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { Home } from '../src/components/public/Home.jsx';
import { Login } from '../src/components/public/Login.jsx';
import { GuestMeals } from '../src/components/guest/meals.jsx';
import { DeanTeam } from '../src/components/dean/DeanTeam.jsx';
import { OperationsWorkbench } from '../src/components/staff/OperationsWorkbench.jsx';
import { WellnessHistoryWorkbench } from '../src/components/staff/wellness-workbench.jsx';
import { ClinicianHealthReview } from '../src/components/staff/guests.jsx';

const originalFetch = globalThis.fetch;

function routeFetch(handler) {
  globalThis.fetch = vi.fn(async (url, options) => {
    const body = handler(String(url), options || {});
    return new Response(JSON.stringify(body ?? {}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('页面渲染冒烟（G14 web）', () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('Home 渲染公开首页与社区动态', async () => {
    routeFetch((url) => (url.includes('/api/news') ? [{ id: 'n1', category: '健康管理', title: '秋日海滨漫步', summary: '演示摘要', publishedAt: '2026-10-15T00:00:00Z' }] : {}));
    render(<Home onEnter={() => {}}/>);
    expect(screen.getByRole('heading', { name: /把日子过得/ })).toBeDefined();
    await waitFor(() => expect(screen.getByText('秋日海滨漫步')).toBeDefined());
  });

  it('Login 渲染预填的演示账号（dev 行为不变，G02）', () => {
    render(<Login role="guest" onBack={() => {}} onLogin={() => {}}/>);
    const username = document.getElementById('login-username');
    const password = document.getElementById('login-password');
    expect(username.value).toBe('guest_demo');
    expect(password.value).toBe('guest2026');
    expect(screen.getByText(/演示账号已预填/)).toBeDefined();
  });

  it('GuestMeals 渲染已生成餐单与订单状态', async () => {
    routeFetch((url) => {
      if (url.includes('/meals/restriction-review')) return { unrecognized: [], history: [], responsibleClinicians: [], review: null };
      if (url.includes('/meals/dishes')) return { items: [{ id: 'd1', name: '花生粥（演示）' }] };
      if (url.includes('/meals/menu')) {
        return {
          status: 'ready',
          menu: { id: 'menu_1', version: 1, ruleBasis: {} },
          items: [
            { id: 'i1', mealType: 'breakfast', slot: 'main', dish: { id: 'd1', name: '花生粥（演示）', ingredients: ['大米'], allergens: ['花生'], nutritionLabels: [] }, currentlyRestricted: false, selectionReason: '目录规则推荐' },
            { id: 'i2', mealType: 'breakfast', slot: 'side', dish: null, selectionReason: '待补充' },
            { id: 'i3', mealType: 'breakfast', slot: 'soup', dish: null, selectionReason: '待补充' }
          ],
          orders: [],
          currentRuleBasis: { effectiveHealthConstraints: { conflictState: 'clear' } }
        };
      }
      return {};
    });
    render(<GuestMeals me={{ id: 'guest_1', name: '顾斌' }} notify={() => {}}/>);
    await waitFor(() => expect(screen.getByText('花生粥（演示）')).toBeDefined());
    expect(screen.getByRole('heading', { name: '每日膳食' })).toBeDefined();
    expect(screen.getAllByText('待配餐员补充').length).toBe(2);
  });

  it('DeanTeam 渲染工作人员列表', async () => {
    routeFetch((url) => (url.includes('/dean/staff') ? [
      { id: 'staff_001', name: '王医生', username: 'staff_demo', phone: '13900000001', guestViews: 2, adviceCount: 1 }
    ] : {}));
    render(<DeanTeam notify={() => {}}/>);
    await waitFor(() => expect(screen.getByText('王医生')).toBeDefined());
    expect(screen.getByText(/工作人员管理/)).toBeDefined();
  });

  it('OperationsWorkbench 渲染运营指标与时段容量', async () => {
    routeFetch((url) => {
      if (url.includes('/admin/operations/summary')) {
        return { generatedAt: '2026-10-15T00:00:00Z', metrics: [{ key: 'guests', label: '在住客人', value: '3', detailKey: 'guests' }] };
      }
      if (url.includes('/admin/operations/slots')) {
        return { items: [{ id: 'slot_1', projectName: '水疗 SPA', businessDate: '2026-10-15T00:00:00Z', localStart: '14:00', localEnd: '15:00', outdoor: false, booked: 0, capacity: 4, remaining: 4, isClosed: false }] };
      }
      if (url.includes('/admin/operations/reservations')) return { items: [] };
      if (url.includes('/admin/operations/incidents')) return { items: [] };
      if (url.includes('/dean/staff')) return [];
      return {};
    });
    render(<OperationsWorkbench notify={() => {}} me={{ id: 'staff_001', name: '管理员', jobType: 'administrator', capabilities: { staffManagement: true } }}/>);
    await waitFor(() => expect(screen.getByText('在住客人')).toBeDefined());
    expect(screen.getByText('住客检索')).toBeDefined();
    await waitFor(() => expect(screen.getAllByText(/水疗 SPA/).length).toBeGreaterThan(0));
  });
  it('ClinicianHealthReview 加载失败时不崩溃并显示空队列（存量同型缺陷回归）', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: '服务器内部错误', code: 'INTERNAL_ERROR' }), { status: 500 }));
    const notices = [];
    render(<ClinicianHealthReview guestId="guest_001" notify={(message) => notices.push(message)} onGuestRefresh={() => {}}/>);
    await waitFor(() => expect(notices.length).toBeGreaterThan(0));
    expect(screen.getByText('当前没有待核实采集')).toBeDefined();
    expect(screen.getByText(/正式档案版本 0/)).toBeDefined();
  });

  it('WellnessHistoryWorkbench 首帧（接口未返回）不崩溃并显示 0 条（G20 迁移回归）', () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {})); // 永不决断，锁定首帧 null 数据
    render(<WellnessHistoryWorkbench canOpenDetails={false} notify={() => {}}/>);
    expect(screen.getByText('审核事件')).toBeDefined();
    expect(screen.getByText('0 条')).toBeDefined();
  });

  it('WellnessHistoryWorkbench 渲染审核历史条目', async () => {
    routeFetch((url) => {
      if (url.includes('/staff/therapy-review-history')) {
        return { items: [{ id: 1, action: 'approved', guestName: '林海宁', actorName: '王医生', actorRole: 'clinician', reason: '资料已核对', draftId: 'wd1', createdAt: '2026-10-16T01:00:00Z', fromVersion: 1, toVersion: 2 }], total: 1 };
      }
      if (url.includes('/staff/therapy-review-attention')) return { items: [] };
      return {};
    });
    render(<WellnessHistoryWorkbench canOpenDetails={false} notify={() => {}}/>);
    await waitFor(() => expect(screen.getByText('1 条')).toBeDefined());
    expect(screen.getByText(/林海宁 · 王医生/)).toBeDefined();
  });
});
