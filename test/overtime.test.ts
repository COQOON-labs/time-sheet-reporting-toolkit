import { describe, it, expect } from 'vitest';
import { extractDailyOvertime } from '../src/lib/overtime.js';
import type { CapturedRequest } from '../src/lib/types.js';

const mkReq = (
  bodyJson: unknown,
  url = 'https://example/api/v1/timesheet/12345',
): CapturedRequest => ({
  id: 'r', url, method: 'GET', status: 200, category: 'time',
  capturedAt: Date.now(), bodyJson,
});

describe('extractDailyOvertime', () => {
  it('extracts timecards[].overtime.amount_minutes', () => {
    const items = [mkReq({
      timecards: [
        { date: '2024-01-15', overtime: { type: 'daily_overtime', amount_minutes: 30 } },
        { date: '2024-01-16', overtime: { type: 'daily_overtime', amount_minutes: 60 } },
      ],
    })];
    const out = extractDailyOvertime(items);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ date: '2024-01-15', employeeId: '12345', minutes: 30 });
    expect(out[1].minutes).toBe(60);
  });

  it('flips sign for daily_deficit when stored positive', () => {
    const items = [mkReq({
      timecards: [
        { date: '2024-01-15', overtime: { type: 'daily_deficit', amount_minutes: 120 } },
      ],
    })];
    expect(extractDailyOvertime(items)[0].minutes).toBe(-120);
  });

  it('dedupes by (date, employeeId), last write wins', () => {
    const items = [mkReq({
      timecards: [
        { date: '2024-01-15', overtime: { type: 'daily_overtime', amount_minutes: 30 } },
        { date: '2024-01-15', overtime: { type: 'daily_overtime', amount_minutes: 99 } },
      ],
    })];
    const out = extractDailyOvertime(items);
    expect(out).toHaveLength(1);
    expect(out[0].minutes).toBe(99);
  });

  it('returns empty array when nothing matches', () => {
    expect(extractDailyOvertime([mkReq({ foo: 'bar' })])).toEqual([]);
  });

  it('ignores non-timesheet URLs', () => {
    const items = [mkReq(
      { timecards: [{ date: '2024-01-15', overtime: { amount_minutes: 30 } }] },
      'https://example/api/other',
    )];
    expect(extractDailyOvertime(items)).toEqual([]);
  });
});
