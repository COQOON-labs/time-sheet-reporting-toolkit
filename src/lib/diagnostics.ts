/**
 * Diagnostics: helpers used by the dev-only "Detection diagnostics" card
 * and the "Debug log" button. Not loaded in production.
 */

import type { CapturedRequest } from './types.js';
import { isPlainObject } from './walk.js';
import {
  isLikelyTimeEntry,
  normalizeRow,
  walkArrays,
  type TimeEntry,
} from './time-entries.js';
import { TIME_PATH_HINTS } from './sync-planner.js';

export type DiagRow = {
  source: string;
  rows: number;
  sampleKeys: string[];
  reason: string;
  accepted: number;
};

export function diagnoseTimeEntries(items: CapturedRequest[]): DiagRow[] {
  const out = new Map<string, DiagRow>();
  for (const it of items) {
    if (!it.bodyJson) continue;
    let source = it.url;
    try { source = new URL(it.url).pathname; } catch { /* keep raw */ }
    for (const arr of walkArrays(it.bodyJson, 0)) {
      if (arr.length < 1) continue;
      const sample = arr.slice(0, 10);
      const matchRate = sample.filter(isLikelyTimeEntry).length / sample.length;
      const sampleKeys = Object.keys(arr[0] ?? {}).slice(0, 12);
      let reason: string;
      let accepted = 0;
      if (matchRate < 0.3) {
        reason = `skipped — only ${Math.round(matchRate * 100)}% of rows look like time entries`;
      } else {
        for (const row of arr) {
          if (!isLikelyTimeEntry(row)) continue;
          if (normalizeRow(row, source)) accepted++;
        }
        if (accepted === 0) {
          reason = 'matched shape but no row could be normalized (date/duration parse failed)';
        } else if (accepted < arr.length) {
          reason = `accepted ${accepted}/${arr.length}`;
        } else {
          reason = `accepted ${accepted}`;
        }
      }
      const key = `${source}::${sampleKeys.join(',')}`;
      const prev = out.get(key);
      if (!prev || prev.rows < arr.length) {
        out.set(key, { source, rows: arr.length, sampleKeys, reason, accepted });
      }
    }
  }
  const suspicious = (k: string[]): boolean =>
    k.some((x) => /date|day|hour|duration|start|end|project|attendance|time|work/i.test(x));
  return Array.from(out.values()).sort((a, b) => {
    if (a.accepted !== b.accepted) return b.accepted - a.accepted;
    const sa = suspicious(a.sampleKeys) ? 1 : 0;
    const sb = suspicious(b.sampleKeys) ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return b.rows - a.rows;
  });
}

export type DebugEntry = {
  url: string;
  pathname: string;
  method: string;
  status: number;
  capturedAt: number;
  bytes: number;
  topLevelType: 'array' | 'object' | 'null' | 'other';
  topLevelKeys: string[];
  arrays: Array<{
    path: string;
    length: number;
    rowKeys: string[];
    sampleRow: unknown;
    looksLikeTimeEntry: boolean;
    normalizedSample: TimeEntry | null;
  }>;
};

export function buildDebugLog(items: CapturedRequest[]): {
  capturedTotal: number;
  timeRelated: number;
  entries: DebugEntry[];
} {
  const out: DebugEntry[] = [];
  for (const it of items) {
    let pathname = it.url;
    try { pathname = new URL(it.url).pathname; } catch { /* keep */ }
    if (!TIME_PATH_HINTS.test(pathname)) continue;

    const body = it.bodyJson;
    const arrays: DebugEntry['arrays'] = [];
    if (body != null) {
      const stack: Array<{ value: unknown; path: string; depth: number }> = [
        { value: body, path: '', depth: 0 },
      ];
      while (stack.length) {
        const { value, path, depth } = stack.pop()!;
        if (depth > 6 || value == null) continue;
        if (Array.isArray(value)) {
          if (value.length > 0 && value.every(isPlainObject)) {
            const rows = value as Record<string, unknown>[];
            const sample = rows[0]!;
            const norm = normalizeRow(sample, pathname);
            arrays.push({
              path: path || '$',
              length: rows.length,
              rowKeys: Object.keys(sample).slice(0, 30),
              sampleRow: sample,
              looksLikeTimeEntry: isLikelyTimeEntry(sample),
              normalizedSample: norm,
            });
          }
          continue;
        }
        if (isPlainObject(value)) {
          for (const k of Object.keys(value)) {
            stack.push({ value: value[k], path: path ? `${path}.${k}` : k, depth: depth + 1 });
          }
        }
      }
    }

    out.push({
      url: it.url,
      pathname,
      method: it.method,
      status: it.status,
      capturedAt: it.capturedAt,
      bytes: it.bytes,
      topLevelType: Array.isArray(body)
        ? 'array'
        : body == null
          ? 'null'
          : typeof body === 'object'
            ? 'object'
            : 'other',
      topLevelKeys: isPlainObject(body) ? Object.keys(body).slice(0, 30) : [],
      arrays,
    });
  }
  return {
    capturedTotal: items.length,
    timeRelated: out.length,
    entries: out.sort((a, b) => b.capturedAt - a.capturedAt),
  };
}

/**
 * Per-day breakdown of every `timecards[]` entry we see, so we can sanity-
 * check whether holidays / vacation / sick days are correctly handled by
 * Personio's own `overtime.amount_minutes` field.
 *
 * Personio cards have these relevant fields:
 *   - `is_off_day`            true on weekends / holidays / full vacation
 *   - `state`                 'trackable' | 'non_trackable' | …
 *   - `overtime.type`         'daily_overtime' | 'daily_deficit' | absent
 *   - `time_off.items[].type` 'holiday' | 'vacation' | 'sick' | …
 *   - `target_hours.effective_work_duration_minutes`  daily target
 *
 * The payload below groups by every combination so we can spot half-day
 * vacations (time_off + overtime present) and unexpected card states.
 */
export type OvertimeDiagGroup = {
  cardType: string;
  overtimeType: string;
  isOffDay: boolean | null;
  state: string;
  timeOffType: string;
  count: number;
  sumMinutes: number;
  sampleDate: string | null;
  sampleEmployeeId: string | null;
  sampleCard: unknown;
};

/** Card where `time_off` *and* `overtime` are both populated (half-day vacation
 *  / sick day with partial work). These are easy to mis-count. */
export type SuspiciousOvertimeRow = {
  date: string;
  employeeId: string;
  isOffDay: boolean;
  timeOffType: string;
  timeOffMinutes: number;
  overtimeType: string;
  overtimeMinutes: number;
  targetMinutes: number | null;
  workedMinutes: number | null;
};

export function diagnoseOvertime(items: CapturedRequest[]): {
  totalCards: number;
  totalMinutes: number;
  groups: OvertimeDiagGroup[];
  suspicious: SuspiciousOvertimeRow[];
  unknownShapeSamples: unknown[];
  byEmployee: Array<{ employeeId: string; cards: number; sumMinutes: number }>;
} {
  const groups = new Map<string, OvertimeDiagGroup>();
  const unknown: unknown[] = [];
  const suspicious: SuspiciousOvertimeRow[] = [];
  const perEmp = new Map<string, { cards: number; sumMinutes: number }>();
  let totalCards = 0;
  let totalMinutes = 0;

  for (const it of items) {
    if (!it.bodyJson) continue;
    const m = /\/timesheet\/(\d{3,})/.exec(it.url);
    if (!m) continue;
    const employeeId = m[1]!;
    const body = it.bodyJson as Record<string, unknown>;
    const cards = body.timecards;
    if (!Array.isArray(cards)) continue;

    for (const card of cards) {
      if (!isPlainObject(card)) continue;
      totalCards++;
      const date = typeof card.date === 'string' ? card.date : null;
      const cardType = typeof card.type === 'string' ? card.type : '(none)';
      const isOffDay = typeof card.is_off_day === 'boolean' ? card.is_off_day : null;
      const state = typeof card.state === 'string' ? card.state : '(none)';

      // time_off shape
      let timeOffType = '(none)';
      let timeOffMinutes = 0;
      const to = card.time_off;
      if (isPlainObject(to)) {
        const items = to.items;
        if (Array.isArray(items) && items.length > 0 && isPlainObject(items[0])) {
          const first = items[0] as Record<string, unknown>;
          if (typeof first.type === 'string') timeOffType = first.type;
        }
        if (typeof to.aggregated_duration_minutes === 'number') {
          timeOffMinutes = to.aggregated_duration_minutes;
        }
      }

      // overtime shape
      const ot = card.overtime;
      let overtimeType = '(no overtime field)';
      let minutes = 0;
      if (isPlainObject(ot)) {
        overtimeType = typeof ot.type === 'string' ? ot.type : '(no type)';
        if (typeof ot.amount_minutes === 'number') {
          minutes = ot.amount_minutes;
          if (overtimeType === 'daily_deficit' && minutes > 0) minutes = -minutes;
        } else if (ot.amount_minutes != null) {
          unknown.push({ where: 'amount_minutes not number', sample: ot });
        }
      }
      totalMinutes += minutes;

      // Per-employee total
      const e = perEmp.get(employeeId) ?? { cards: 0, sumMinutes: 0 };
      e.cards++;
      e.sumMinutes += minutes;
      perEmp.set(employeeId, e);

      // Suspicious: time_off AND overtime both populated → potential half-day issue
      if (timeOffType !== '(none)' && overtimeType !== '(no overtime field)' && date) {
        const target = isPlainObject(card.target_hours)
          && typeof card.target_hours.effective_work_duration_minutes === 'number'
          ? card.target_hours.effective_work_duration_minutes
          : null;
        let worked: number | null = null;
        if (Array.isArray(card.periods)) {
          worked = 0;
          for (const p of card.periods) {
            if (isPlainObject(p) && p.type === 'work' && typeof p.duration_in_minutes === 'number') {
              worked += p.duration_in_minutes;
            }
          }
        }
        suspicious.push({
          date, employeeId,
          isOffDay: isOffDay === true,
          timeOffType, timeOffMinutes,
          overtimeType, overtimeMinutes: minutes,
          targetMinutes: target,
          workedMinutes: worked,
        });
      }

      const key = `${cardType}|${overtimeType}|off=${isOffDay}|state=${state}|to=${timeOffType}`;
      const prev = groups.get(key);
      if (prev) {
        prev.count++;
        prev.sumMinutes += minutes;
      } else {
        groups.set(key, {
          cardType, overtimeType, isOffDay, state, timeOffType,
          count: 1, sumMinutes: minutes,
          sampleDate: date, sampleEmployeeId: employeeId, sampleCard: card,
        });
      }
    }
  }

  return {
    totalCards,
    totalMinutes,
    groups: Array.from(groups.values()).sort((a, b) => Math.abs(b.sumMinutes) - Math.abs(a.sumMinutes)),
    suspicious: suspicious.sort((a, b) => a.date.localeCompare(b.date)),
    unknownShapeSamples: unknown.slice(0, 5),
    byEmployee: Array.from(perEmp.entries())
      .map(([employeeId, v]) => ({ employeeId, ...v }))
      .sort((a, b) => Math.abs(b.sumMinutes) - Math.abs(a.sumMinutes)),
  };
}
