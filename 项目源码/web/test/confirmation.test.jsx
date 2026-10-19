import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useConfirmation } from '../src/shared/Confirmation.jsx';
import { GuestReservations } from '../src/components/guest/schedule.jsx';
import { GuestMeals } from '../src/components/guest/meals.jsx';
import { StaffManagement, StayManagement } from '../src/components/staff/admin-org.jsx';
import { localDateValue } from '../src/lib/date.js';

beforeEach(() => {
  // jsdom has no top layer. Real background inertness is checked in Chromium.
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); delete HTMLDialogElement.prototype.showModal; delete HTMLDialogElement.prototype.close; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Harness({ action }) {
  const { confirm, confirmation } = useConfirmation();
  return <><button onClick={() => confirm({ title: '确认操作', description: '保留原确认内容', confirmLabel: '确认执行', action })}>打开确认</button>{confirmation}</>;
}
function openHarness(action = vi.fn()) {
  const rendered = render(<Harness action={action}/>);
  const trigger = screen.getByRole('button', { name: '打开确认' });
  trigger.focus(); fireEvent.click(trigger);
  return { ...rendered, trigger, action, dialog: screen.getByRole('dialog') };
}
it('safe initial focus, labelled modal, forward/reverse Tab wrap, Escape and focus return', () => {
  const { dialog, trigger, action } = openHarness();
  const cancel = within(dialog).getByRole('button', { name: '取消' });
  const submit = within(dialog).getByRole('button', { name: '确认执行' });
  expect(document.activeElement).toBe(cancel);
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(document.getElementById(dialog.getAttribute('aria-describedby')).textContent).toBe('保留原确认内容');
  fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true }); expect(document.activeElement).toBe(submit);
  fireEvent.keyDown(submit, { key: 'Tab' }); expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(action).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
});
it('waiting rejects double submit and cancellation, then restores focus', async () => {
  let resolve;
  const action = vi.fn(() => new Promise(done => { resolve = done; }));
  const { dialog, trigger } = openHarness(action);
  fireEvent.click(within(dialog).getByRole('button', { name: '确认执行' }));
  fireEvent.click(within(dialog).getByRole('button', { name: '正在处理…' }));
  fireEvent.keyDown(dialog, { key: 'Escape' }); fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
  expect(action).toHaveBeenCalledTimes(1); expect(screen.getByRole('status').textContent).toContain('正在处理');
  resolve(); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
it('error stays readable, can retry, then unmount aborts active request', async () => {
  let signal;
  const action = vi.fn().mockRejectedValueOnce(new Error('合成网络错误')).mockImplementation(next => {
    signal = next;
    return new Promise((resolve, reject) => next.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  const view = openHarness(action);
  fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('合成网络错误'));
  fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
  expect(action).toHaveBeenCalledTimes(2); view.unmount(); expect(signal.aborted).toBe(true);
});
it('unmounting an unanswered dialog never invokes its action', () => {
  const view = openHarness(); view.unmount(); expect(view.action).not.toHaveBeenCalled();
});

const member = { id: 'staff1', name: '合成员工', username: 'synthetic', jobType: 'coach', status: 'active', role: 'staff' };
const guest = { id: 'guest1', name: '合成客人', stayStatus: 'in_house', roomNo: 'G28', checkIn: '2026-10-18', stayPlan: 'three_night' };
const menu = { status: 'ready', menu: { id: 'menu1', version: 3, ruleBasis: {} }, orders: [],
  currentRuleBasis: { effectiveHealthConstraints: { conflictState: 'clear' } },
  items: [{ id: 'item1', mealType: 'breakfast', slot: 'main', dish: { id: 'd1', name: '原合成菜品' }, eligibleReplacements: [{ id: 'd2', name: '新合成菜品' }] }] };
const cases = [
  { name: '员工停用', Component: StaffManagement, props: { me: { id: 'admin1' }, notify: vi.fn() },
    routes: { '/dean/staff': [member] }, trigger: '停用', confirm: '确认停用', path: '/dean/staff/staff1', method: 'PATCH', body: { status: 'disabled' } },
  { name: '客人离店', Component: StayManagement, props: { notify: vi.fn() }, routes: { '/dean/guests': [guest] },
    trigger: '办理离店', confirm: '确认离店', path: '/dean/guests/guest1/stay', method: 'PATCH',
    body: { roomNo: 'G28', checkIn: guest.checkIn, checkOut: localDateValue(), stayPlan: 'three_night' } },
  { name: '取消预约', Component: GuestReservations, props: { go: vi.fn() },
    routes: { '/reservations': { items: [{ id: 'r1', projectName: '合成项目', businessDate: '2099-10-19', localStart: '10:00', localEnd: '11:00', startsAt: '2099-10-19T02:00:00Z', status: 'confirmed' }] } },
    trigger: '取消预约', confirm: '确认取消预约', path: '/reservations/r1', method: 'DELETE' },
  { name: '膳食换菜', Component: GuestMeals, props: { me: { id: 'guest1' }, notify: vi.fn() },
    routes: { '/meals/menu': menu, '/meals/dishes': { items: [] }, '/meals/restriction-review': { unrecognized: [], history: [] } },
    trigger: '确认替换', confirm: '确认替换', path: '/meals/menus/menu1/items/item1', method: 'PATCH', body: { version: 3, dishId: 'd2', reason: '合成替换原因' },
    prepare: async () => {
      fireEvent.click(await screen.findByRole('button', { name: '替换此餐位' }));
      fireEvent.change(screen.getByLabelText('替换菜品'), { target: { value: 'd2' } });
      fireEvent.change(screen.getByLabelText('替换原因'), { target: { value: '合成替换原因' } });
    } },
];
describe.each(cases)('$name exact request contract', fixture => {
  it('open/cancel writes zero; confirm writes once with cookie protections and unchanged body', async () => {
    const writes = [];
    let release;
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const pathname = new URL(url, 'http://local').pathname.replace('/api', '');
      if (options.method && options.method !== 'GET') {
        writes.push({ pathname, ...options });
        await new Promise(done => { release = done; });
      }
      return new Response(JSON.stringify(fixture.routes[pathname] || {}), { status: 200 });
    }));
    render(<fixture.Component {...fixture.props}/>);
    if (fixture.prepare) await fixture.prepare();
    const trigger = await screen.findByRole('button', { name: fixture.trigger, exact: true });
    trigger.focus(); fireEvent.click(trigger);
    expect(writes).toHaveLength(0);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '取消', exact: true }));
    expect(writes).toHaveLength(0); expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: fixture.confirm, exact: true }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '正在处理…' }));
    expect(writes).toHaveLength(1);
    expect(writes[0].pathname).toBe(fixture.path); expect(writes[0].method).toBe(fixture.method);
    expect(writes[0].body ? JSON.parse(writes[0].body) : undefined).toEqual(fixture.body);
    expect(writes[0].credentials).toBe('same-origin'); expect(writes[0].headers['X-Community-Request']).toBe('1');
    release(); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
  it('request rejection remains actionable; retry is aborted when its owning page unmounts', async () => {
    let writes = 0, requestSignal;
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
      const pathname = new URL(url, 'http://local').pathname.replace('/api', '');
      if (options.method && options.method !== 'GET') {
        writes += 1;
        if (writes === 1) return new Response(JSON.stringify({ error: '合成服务拒绝，请稍后重试' }), { status: 503 });
        requestSignal = options.signal;
        await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
      }
      return new Response(JSON.stringify(fixture.routes[pathname] || {}), { status: 200 });
    }));
    const view = render(<fixture.Component {...fixture.props}/>);
    if (fixture.prepare) await fixture.prepare();
    fireEvent.click(await screen.findByRole('button', { name: fixture.trigger, exact: true }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: fixture.confirm, exact: true }));
    await waitFor(() => expect(within(screen.getByRole('dialog')).getByRole('alert').textContent).toBe('合成服务拒绝，请稍后重试'));
    expect(writes).toBe(1);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: fixture.confirm, exact: true }));
    expect(writes).toBe(2); view.unmount(); expect(requestSignal.aborted).toBe(true);
  });
});
