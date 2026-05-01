import { describe, it, expect } from 'vitest';
import {
  isLikelyTimeEntry,
  normalizeRow,
  extractTimeEntries,
  filterEntries,
  sumHours,
  groupHoursBy,
  type TimeEntry,
} from '../src/lib/time-entries.js';
import type { CapturedRequest } from '../src/lib/types.js';

const mkReq = (
  bodyJson: unknown,
  url = 'https://example/api/v1/timesheet/12345',
): CapturedRequest => ({
  id: 'r1',
  url,
  method: 'GET',
  status: 200,
  category: 'time',
  capturedAt: Date.now(),
  bodyJson,
});

describe('isLikelyTimeEntry', () => {
  it('accepts shape with date + hours', () => {
    expect(isLikelyTimeEntry({ date: '2024-01-15', hours: 8 })).toBe(true);
  });
  it('accepts attendance shape with start/end', () => {
    expect(isLikelyTimeEntry({ start_at: '2024-01-15T08:00Z', end_at: '2024-01-15T17:00Z' }))
      .toBe(true);
  });
  it('rejects unrelated shapes', () => {
    expect(isLikelyTimeEntry({ id: 1, name: 'x' })).toBe(false);
  });
});

describe('normalizeRow', () => {
  it('extracts date + hours', () => {
    const e = normalizeRow({ date: '2024-01-15', hours: 7.5 }, '/x');
    expect(e?.date).toBe('2024-01-15');
    expect(e?.hours).toBe(7.5);
  });
  it('computes hours from start/end if missing', () => {
    const e = normalizeRow({
      day: '2024-01-15',
      start_at: '2024-01-15T08:00:00Z',
      end_at: '2024-01-15T16:30:00Z',
    }, '/x');
    expect(e?.hours).toBeCloseTo(8.5);
  });
  it('returns null without a date', () => {
    expect(normalizeRow({ hours: 8 }, '/x')).toBeNull();
  });
  it('skips break / time_off rows', () => {
    expect(normalizeRow({ date: '2024-01-15', hours: 1, type: 'break' }, '/x')).toBeNull();
    expect(normalizeRow({ date: '2024-01-15', hours: 1, type: 'time_off' }, '/x')).toBeNull();
  });
});

describe('extractTimeEntries', () => {
  it('walks nested arrays in JSON bodies of /timesheet/<id> URLs', () => {
    const items = [
      mkReq({ data: { entries: [
        { date: '2024-01-15', hours: 8, project_id: 1 },
        { date: '2024-01-16', hours: 6, project_id: 1 },
      ]}}),
    ];
    const entries = extractTimeEntries(items);
    expect(entries).toHaveLength(2);
    expect(entries[0].hours).toBe(8);
  });
  it('ignores non-timesheet URLs', () => {
    const items = [mkReq(
      [{ date: '2024-01-15', hours: 8 }],
      'https://example/api/something-else',
    )];
    expect(extractTimeEntries(items)).toHaveLength(0);
  });
});

describe('filterEntries / sumHours / groupHoursBy', () => {
  const entries: TimeEntry[] = [
    { id: '1', date: '2024-01-10', hours: 2, project: 'P1', activity: '', employee: 'Alice', comment: '', source: '/x' },
    { id: '2', date: '2024-01-11', hours: 4, project: 'P1', activity: '', employee: 'Bob',   comment: '', source: '/x' },
    { id: '3', date: '2024-01-12', hours: 1, project: 'P2', activity: '', employee: 'Alice', comment: '', source: '/x' },
  ];
  const r = { from: '2024-01-01', to: '2024-12-31' };

  it('filters by date range', () => {
    expect(filterEntries(entries, { from: '2024-01-11', to: '2024-01-12' }, '', '', '')).toHaveLength(2);
  });
  it('filters by project', () => {
    expect(filterEntries(entries, r, '', 'P1', '')).toHaveLength(2);
  });
  it('filters by employee', () => {
    expect(filterEntries(entries, r, 'Alice', '', '')).toHaveLength(2);
  });
  it('filters by free-text search', () => {
    expect(filterEntries(entries, r, '', '', 'bob')).toHaveLength(1);
  });
  it('sums hours', () => {
    expect(sumHours(entries)).toBeCloseTo(7);
  });
  it('groups by project', () => {
    const m = groupHoursBy(entries, 'project');
    expect(m.get('P1')).toBe(6);
    expect(m.get('P2')).toBe(1);
  });
  it('groups by employee', () => {
    const m = groupHoursBy(entries, 'employee');
    expect(m.get('Alice')).toBe(3);
    expect(m.get('Bob')).toBe(4);
  });
});
