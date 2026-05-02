import { describe, it, expect } from 'vitest';
import {
  durationToHours,
  parseTime,
  toIsoDate,
  monthWindows,
  pick,
  pickLabel,
} from '../src/lib/parse.js';

describe('durationToHours', () => {
  it('parses HH:MM strings', () => {
    expect(durationToHours('08:30', 'duration')).toBeCloseTo(8.5);
  });
  it('parses HH:MM:SS strings', () => {
    expect(durationToHours('01:30:30', 'duration')).toBeCloseTo(1.508, 2);
  });
  it('treats key with "minute" as minutes', () => {
    expect(durationToHours(90, 'duration_minutes')).toBeCloseTo(1.5);
  });
  it('treats key with "second" as seconds', () => {
    expect(durationToHours(3600, 'duration_seconds')).toBeCloseTo(1);
  });
  it('treats raw "duration" key as seconds', () => {
    expect(durationToHours(7200, 'duration')).toBeCloseTo(2);
  });
  it('falls back by magnitude (>1000 → seconds)', () => {
    expect(durationToHours(3600, 'value')).toBeCloseTo(1);
  });
  it('returns null on garbage', () => {
    expect(durationToHours('abc', 'duration')).toBeNull();
    expect(durationToHours(null, 'duration')).toBeNull();
  });
});

describe('parseTime', () => {
  it('parses ISO strings to ms', () => {
    expect(parseTime('2024-01-15T08:00:00Z')).toBe(Date.parse('2024-01-15T08:00:00Z'));
  });
  it('treats large numbers as ms', () => {
    expect(parseTime(1_700_000_000_000)).toBe(1_700_000_000_000);
  });
  it('treats small numbers as seconds', () => {
    expect(parseTime(1_700_000_000)).toBe(1_700_000_000_000);
  });
  it('returns null on bad input', () => {
    expect(parseTime('not-a-date')).toBeNull();
    expect(parseTime(null)).toBeNull();
  });
});

describe('toIsoDate', () => {
  it('rounds an ISO datetime to YYYY-MM-DD', () => {
    expect(toIsoDate('2024-03-15T13:45:00Z')).toBe('2024-03-15');
  });
  it('returns null on garbage', () => {
    expect(toIsoDate('xx')).toBeNull();
  });
});

describe('monthWindows', () => {
  it('clips first + last month to [from, to]', () => {
    const w = monthWindows('2024-01-15', '2024-03-10');
    expect(w).toEqual([
      { start: '2024-01-15', end: '2024-01-31' },
      { start: '2024-02-01', end: '2024-02-29' },
      { start: '2024-03-01', end: '2024-03-10' },
    ]);
  });
  it('handles single-month range', () => {
    expect(monthWindows('2024-05-10', '2024-05-20'))
      .toEqual([{ start: '2024-05-10', end: '2024-05-20' }]);
  });
  it('returns empty for inverted range', () => {
    expect(monthWindows('2024-05-10', '2024-04-01')).toEqual([]);
  });
});

describe('pick / pickLabel', () => {
  it('pick returns first non-empty', () => {
    expect(pick({ a: '', b: 'x', c: 'y' }, ['a', 'b', 'c'])).toBe('x');
    expect(pick({ a: null, b: undefined, c: 0 }, ['a', 'b', 'c'])).toBe(0);
    expect(pick({ a: null, b: undefined }, ['a', 'b'])).toBeUndefined();
  });
  it('pickLabel resolves nested name', () => {
    expect(pickLabel({ name: 'Alice' }, [])).toBe('Alice');
    expect(pickLabel({ first_name: 'Alice', last_name: 'Doe' }, [])).toBe('Alice Doe');
    expect(pickLabel('Bob', [])).toBe('Bob');
    expect(pickLabel(null, [])).toBeUndefined();
  });
});
