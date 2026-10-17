import { describe, it, expect } from 'vitest';
import { businessToday, shanghaiDateOffset, slotDateLabel, mealLocalTime, healthValueToUtc, healthBusinessDate, localDateValue, fmtDate } from '../src/lib/date.js';

describe('lib/date（G27 前端统一实现）', () => {
  it('businessToday 返回上海时间 ISO 日期', () => {
    expect(businessToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('shanghaiDateOffset 按天偏移且保持 ISO 日期格式', () => {
    const today = shanghaiDateOffset();
    const tomorrow = shanghaiDateOffset(1);
    expect(new Date(`${tomorrow}T12:00:00+08:00`) - new Date(`${today}T12:00:00+08:00`)).toBe(86_400_000);
  });

  it('slotDateLabel 渲染中文月日与星期', () => {
    expect(slotDateLabel('2026-10-15')).toContain('10月15日');
  });

  it('mealLocalTime 对空值与非法值返回 —', () => {
    expect(mealLocalTime('')).toBe('—');
    expect(mealLocalTime('not-a-date')).toBe('—');
    expect(mealLocalTime('2026-10-15T02:00:00Z')).toContain('2026');
  });

  it('healthValueToUtc 把上海本地时间转换为 UTC ISO', () => {
    expect(healthValueToUtc('2026-10-15T08:00')).toBe('2026-10-15T00:00:00.000Z');
  });

  it('healthValueToUtc 拒绝非法输入', () => {
    expect(() => healthValueToUtc('2026/10/15')).toThrow('请选择有效的记录时间');
    expect(() => healthValueToUtc('')).toThrow('请选择有效的记录时间');
  });

  it('healthBusinessDate 返回记录的上海业务日期', () => {
    expect(healthBusinessDate('2026-10-15T17:30:00Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(healthBusinessDate('')).toBe('');
  });

  it('localDateValue/fmtDate 基本形状', () => {
    expect(localDateValue()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fmtDate('')).toBe('—');
    expect(fmtDate('2026-10-15T00:00:00Z')).toContain('10月');
  });
});
