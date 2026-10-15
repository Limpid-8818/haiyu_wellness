import { useCallback, useEffect, useRef, useState } from 'react';

// G20：统一数据加载 hook。generation 计数 + AbortController 双保险，
// 晚到的旧响应不再覆盖新数据（与既有手写守卫语义一致），卸载时中止在途请求。
// loadFn(signal, ...args) 返回数据；仅成功时写入 data，失败时保留旧数据并写入 error，
// 与全站既有 loading/error 时序保持一致。deps 变化时自动重载；返回的 load 可手动调用。
export function useQuery(loadFn, deps = [], options = {}) {
  const { initialLoading = true, fallbackMessage = '加载失败', onError } = options;
  const generationRef = useRef(0);
  const controllerRef = useRef(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(initialLoading);
  const [error, setError] = useState('');

  const load = useCallback(async (...args) => {
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await loadFn(controller.signal, ...args);
      if (generation !== generationRef.current) return result;
      setData(result);
      return result;
    } catch (queryError) {
      if (queryError?.name === 'AbortError') return undefined;
      if (generation === generationRef.current) {
        setError(queryError?.message || fallbackMessage);
        onError?.(queryError);
      }
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, deps);

  useEffect(() => {
    load();
    return () => {
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [load]);

  return { data, setData, loading, error, setError, load };
}
