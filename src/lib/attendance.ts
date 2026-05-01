/**
 * Re-export barrel — kept for backward compatibility with the original
 * monolithic module. New code should import from the focused modules
 * directly:
 *
 *   - ./time-entries   → TimeEntry, normalizeRow, extractTimeEntries, filter/group/sum
 *   - ./name-index     → buildEmployeeIndex, buildProjectIndex, getOwnEmployee
 *   - ./overtime       → DailyOvertime, extractDailyOvertime
 *   - ./sync-planner   → planSyncUrls, monthWindows
 *   - ./diagnostics    → diagnoseTimeEntries, buildDebugLog (dev-only)
 *   - ./parse          → todayIso, isoDaysAgo, dateSeries, monthWindows, durationToHours, …
 *   - ./format         → fmtHours
 */

export type { TimeEntry, DateRange } from './time-entries.js';
export {
  extractTimeEntries,
  filterEntries,
  sumHours,
  groupHoursBy,
  sortedHoursMap,
  inRange,
  exportEntriesCsv,
  isLikelyTimeEntry,
  normalizeRow,
} from './time-entries.js';

export { getOwnEmployee, buildEmployeeIndex, buildProjectIndex, derivePersonName } from './name-index.js';

export type { DailyOvertime } from './overtime.js';
export { extractDailyOvertime } from './overtime.js';

export { planSyncUrls, TIME_PATH_HINTS } from './sync-planner.js';

export { diagnoseTimeEntries, buildDebugLog, type DiagRow, type DebugEntry } from './diagnostics.js';

export {
  todayIso,
  isoDaysAgo,
  dateSeries,
  monthWindows,
  durationToHours,
  parseTime,
  toIsoDate,
  pick,
  pickLabel,
  safeStringify,
} from './parse.js';

// fmtHours used to live here; it's now in lib/format.
export { fmtHours } from './format.js';
