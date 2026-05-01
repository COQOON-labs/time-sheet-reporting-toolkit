/**
 * Daily overtime extraction from /timesheet/{id} responses.
 *
 * Personio stores `timecards[].overtime.amount_minutes` with a `type` of
 * either 'daily_overtime' or 'daily_deficit'. We unify them into a signed
 * minutes value (positive = overtime, negative = deficit).
 */

import type { CapturedRequest } from './types.js';
import { isPlainObject } from './walk.js';
import { TIMESHEET_URL_RE } from './constants.js';

/** One day's overtime/deficit for a given employee. */
export type DailyOvertime = {
  date: string;
  employeeId: string;
  /** Net minutes (positive = overtime, negative = deficit). */
  minutes: number;
};

/** Pull `timecards[].overtime.amount_minutes` (sign-aware) out of every
 *  /timesheet/{id} response. Deduped by (date, employeeId). */
export function extractDailyOvertime(items: CapturedRequest[]): DailyOvertime[] {
  const byKey = new Map<string, DailyOvertime>();
  for (const it of items) {
    if (!it.bodyJson) continue;
    const m = TIMESHEET_URL_RE.exec(it.url);
    if (!m) continue;
    const employeeId = m[1]!;
    const body = it.bodyJson as Record<string, unknown>;
    const cards = body.timecards;
    if (!Array.isArray(cards)) continue;
    for (const card of cards) {
      if (!isPlainObject(card)) continue;
      const date = typeof card.date === 'string' ? card.date : null;
      if (!date) continue;
      const ot = card.overtime;
      if (!isPlainObject(ot)) continue;
      const v = ot.amount_minutes;
      if (typeof v !== 'number') continue;
      const type = ot.type;
      // 'daily_deficit' values are stored as positive minutes in some shapes;
      // when type is deficit and value is positive, flip the sign.
      let minutes = v;
      if (type === 'daily_deficit' && minutes > 0) minutes = -minutes;
      byKey.set(`${date}|${employeeId}`, { date, employeeId, minutes });
    }
  }
  return Array.from(byKey.values()).sort((a, b) => a.date.localeCompare(b.date));
}
