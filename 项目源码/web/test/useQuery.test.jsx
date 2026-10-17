import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useQuery } from '../src/lib/useQuery.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('lib/useQuery（G20 统一数据加载）', () => {
  it('成功加载后写入 data 并结束 loading', async () => {
    const { result } = renderHook(() => useQuery(async () => ({ value: 7 }), []));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual({ value: 7 });
    expect(result.current.error).toBe('');
  });

  it('失败时写入 error 并保留旧数据', async () => {
    let shouldFail = false;
    const { result } = renderHook(() => useQuery(async () => {
      if (shouldFail) throw new Error('读取失败');
      return { version: 1 };
    }, []));
    await waitFor(() => expect(result.current.data).toEqual({ version: 1 }));
    shouldFail = true;
    await act(async () => { await result.current.load(); });
    expect(result.current.error).toBe('读取失败');
    expect(result.current.data).toEqual({ version: 1 });
  });

  it('晚到的旧响应不覆盖新数据（竞态守卫）', async () => {
    const first = deferred();
    const second = deferred();
    const calls = [first, second];
    let callIndex = -1;
    const { result, rerender } = renderHook(({ dep }) => useQuery(async () => {
      callIndex += 1;
      return calls[callIndex].promise.then(value => ({ dep, value }));
    }, [dep]), { initialProps: { dep: 'a' } });

    rerender({ dep: 'b' });
    // 先完成的第二个请求（新数据）
    await act(async () => { second.resolve({ ok: true }); });
    await waitFor(() => expect(result.current.data).toEqual({ dep: 'b', value: { ok: true } }));
    // 晚到的第一个请求（旧数据）不得覆盖
    await act(async () => { first.resolve({ stale: true }); });
    expect(result.current.data).toEqual({ dep: 'b', value: { ok: true } });
  });

  it('deps 变化时自动重载', async () => {
    const loads = vi.fn(async (_signal, date) => ({ date: date ?? 'auto' }));
    const { result, rerender } = renderHook(({ date }) => useQuery(loads, [date]), { initialProps: { date: 'd1' } });
    await waitFor(() => expect(result.current.data).toEqual({ date: 'auto' }));
    expect(loads).toHaveBeenCalledTimes(1);
    // 手动调用可透传参数（如 StayManagement 的 load(filter, search)）
    await act(async () => { await result.current.load('manual'); });
    expect(result.current.data).toEqual({ date: 'manual' });
    expect(loads).toHaveBeenCalledTimes(2);
  });
});
