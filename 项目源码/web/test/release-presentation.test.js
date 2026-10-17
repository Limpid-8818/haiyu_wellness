import { describe, it, expect } from 'vitest';
import { BUSINESS_LABELS, businessText, businessTime, notificationCategory, checkinAvailability } from '../src/lib/release-presentation.js';

describe('package-local presentation entry (G04)', () => {
  it('keeps every public business label and unknown text', () => {
    for (const [key, value] of Object.entries(BUSINESS_LABELS)) expect(businessText(key)).toBe(value);
    expect(businessText('future_status')).toBe('future_status');
    expect(businessText(null)).toBe('');
  });
  it('preserves Shanghai timestamps and invalid/missing time labels', () => {
    expect(businessTime('2030-01-01T00:05:00Z')).toContain('08:05');
    expect(businessTime('bad')).toBe('时间待核对');
    expect(businessTime(null)).toBe('时间未记录');
  });
  it('keeps notification categories tied to type/source', () => {
    expect(notificationCategory({ notificationType: 'care', sourceType: 'wellness_review_event' }).key).toBe('revision');
    expect(notificationCategory({ notificationType: 'brief', sourceType: 'daily_brief' }).key).toBe('brief');
    expect(notificationCategory({ notificationType: 'future' }).key).toBe('update');
  });
  it('opens check-in exactly at start and preserves inactive/already-checked states', () => {
    const item = { startsAt: '2030-01-01T01:00:00Z', reservationStatus: 'confirmed' };
    expect(checkinAvailability(item, '2030-01-01T00:59:59Z').canCheckin).toBe(false);
    expect(checkinAvailability(item, item.startsAt).canCheckin).toBe(true);
    expect(checkinAvailability({ ...item, reservationStatus: 'cancelled' }, item.startsAt).checkinState).toBe('inactive');
    expect(checkinAvailability({ ...item, checkin: {} }, item.startsAt).checkinState).toBe('checked');
  });
});
