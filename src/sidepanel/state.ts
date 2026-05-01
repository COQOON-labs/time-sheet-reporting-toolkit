/**
 * Centralized sidepanel state. Mutated via `setState({...})`. Render
 * functions read directly from `state` and are invoked from `main.ts`
 * after each refresh — no implicit pub/sub.
 */

import type { CapturedRequest, SyncRequest, SyncResult } from '../lib/types.js';
import type { TimeEntry, DailyOvertime } from '../lib/attendance.js';
import { TIMESHEET_URL_RE } from '../lib/constants.js';
import { EMPLOYEE_ID_PREFIX, UNKNOWN } from '../lib/constants.js';

export type AppState = {
  allItems: CapturedRequest[];
  timeEntries: TimeEntry[];
  dailyOvertime: DailyOvertime[];
  ownEmployee: { id: string; name: string } | null;
  /** Memoized name→employeeId lookup, recomputed in `main.refresh()`. */
  nameToId: Map<string, string>;

  // Filter state (dashboard)
  currentPreset: string;
  employeeSelectTouched: boolean;

  // Sync
  lastSyncResult: SyncResult | null;
  lastSyncUrls: SyncRequest[];
  syncInFlight: boolean;
  lastAutoSyncAt: number;
};

export const state: AppState = {
  allItems: [],
  timeEntries: [],
  dailyOvertime: [],
  ownEmployee: null,
  nameToId: new Map(),

  currentPreset: 'this-month',
  employeeSelectTouched: false,

  lastSyncResult: null,
  lastSyncUrls: [],
  syncInFlight: false,
  lastAutoSyncAt: 0,
};

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
}

/**
 * Pure: derive an employee-name → employee-id map from inputs.
 * No reads from the global `state` so it can be called in any order.
 */
export function buildNameToIdMap(
  timeEntries: TimeEntry[],
  ownEmployee: { id: string; name: string } | null,
): Map<string, string> {
  const m = new Map<string, string>();
  if (ownEmployee && ownEmployee.name) m.set(ownEmployee.name, ownEmployee.id);
  for (const e of timeEntries) {
    const match = TIMESHEET_URL_RE.exec(e.source);
    if (
      match
      && e.employee
      && e.employee !== UNKNOWN
      && !e.employee.startsWith(EMPLOYEE_ID_PREFIX)
    ) {
      m.set(e.employee, match[1]!);
    }
  }
  return m;
}

