/**
 * Centralized sidepanel state + tiny pub/sub. Every render function is a
 * pure read of `state`; state is mutated via `setState({...})` which then
 * notifies subscribers.
 */

import type { CapturedRequest, SyncRequest, SyncResult } from '../lib/types.js';
import type { TimeEntry, DailyOvertime } from '../lib/attendance.js';

export type AppState = {
  allItems: CapturedRequest[];
  timeEntries: TimeEntry[];
  dailyOvertime: DailyOvertime[];
  ownEmployee: { id: string; name: string } | null;
  /** Memoized name→employeeId lookup, recomputed when timeEntries identity changes. */
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

const subscribers = new Set<() => void>();

export function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function setState(patch: Partial<AppState>): void {
  Object.assign(state, patch);
  for (const fn of subscribers) {
    try { fn(); } catch (err) { console.error('subscriber failed:', err); }
  }
}

/** Build an employee-name → employee-id map from current state. Cheap to
 *  call but we cache it inside state.nameToId, recomputed only when the
 *  caller passes a new TimeEntry[] identity. */
export function buildNameToIdMap(): Map<string, string> {
  const m = new Map<string, string>();
  if (state.ownEmployee && state.ownEmployee.name) {
    m.set(state.ownEmployee.name, state.ownEmployee.id);
  }
  for (const e of state.timeEntries) {
    const match = /\/timesheet\/(\d{3,})/.exec(e.source);
    if (match && e.employee && e.employee !== '—' && !e.employee.startsWith('Employee #')) {
      m.set(e.employee, match[1]!);
    }
  }
  return m;
}
