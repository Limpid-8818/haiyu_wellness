import { describe, it, expect } from 'vitest';
import { asText, initials, normalizeHealthRecord, normalizeAdvice, normalizeGuestSummary, normalizeGuestList } from '../src/lib/normalize.js';

describe('lib/normalize', () => {
  it('normalizeHealthRecord 兼容 snake_case 行', () => {
    const row = normalizeHealthRecord({ record_type: 'blood_pressure', recorded_at: '2026-10-15T00:00:00Z', recorded_by: 'staff_001', value: 1 });
    expect(row.type).toBe('blood_pressure');
    expect(row.recordedAt).toBe('2026-10-15T00:00:00Z');
    expect(row.recordedBy).toBe('staff_001');
    expect(row.value).toBe(1);
  });

  it('normalizeAdvice 保留 camelCase 优先', () => {
    const row = normalizeAdvice({ created_at: 'a', createdAt: 'b', author_name: '王医生' });
    expect(row.createdAt).toBe('b');
    expect(row.authorName).toBe('王医生');
  });

  it('normalizeGuestSummary 归一化档案字段并映射健康/医嘱列表', () => {
    const data = normalizeGuestSummary({
      profile: { birth_date: '1950-01-01', room_no: 'B-102', check_in: '2026-10-14', chronic: ['高血压'] },
      health: [{ record_type: 'sleep' }],
      advice: [{ author_name: '王医生' }]
    });
    expect(data.profile.birthDate).toBe('1950-01-01');
    expect(data.profile.roomNo).toBe('B-102');
    expect(data.profile.checkIn).toBe('2026-10-14');
    expect(data.profile.chronic).toEqual(['高血压']);
    expect(data.health[0].type).toBe('sleep');
    expect(data.advice[0].authorName).toBe('王医生');
  });

  it('normalizeGuestList 缺失字段兜底为空', () => {
    const rows = normalizeGuestList([{ room_no: 'A-203' }, { id: 'g2' }]);
    expect(rows[0].roomNo).toBe('A-203');
    expect(rows[0].chronic).toEqual([]);
    expect(rows[1].roomNo).toBe('');
  });

  it('normalizeGuestList 对非数组返回空数组', () => {
    expect(normalizeGuestList(null)).toEqual([]);
  });

  it('asText/initials 基础取值', () => {
    expect(asText(null)).toBe('');
    expect(asText(42)).toBe('42');
    expect(initials('顾斌')).toBe('顾');
    expect(initials()).toBe('');
  });
});
