/**
 * Re-export barrel — narrow façade exposed to the sidepanel/UI layer.
 *
 * Only the symbols actually consumed by UI modules are re-exported here.
 * Lib-internal helpers (`pick`, `pickLabel`, `parseTime`, `toIsoDate`,
 * `durationToHours`, `monthWindows`, `safeStringify`, `derivePersonName`,
 * `buildEmployeeIndex`, `buildProjectIndex`, `isLikelyTimeEntry`,
 * `normalizeRow`, `TIME_PATH_HINTS`, `isoDaysAgo`, `dateSeries`) are
 * kept module-local to make their usage easy to audit.
 *
 * UI code should keep importing from this barrel; tests + lib code
 * should import from the focused modules directly.
 */

export type { TimeEntry, DateRange } from './time-entries.js';
export {
  extractTimeEntries,
  filterEntries,
  sumHours,
  groupHoursBy,
  sortedHoursMap,
  exportEntriesCsv,
} from './time-entries.js';

export { getOwnEmployee } from './name-index.js';

export type { DailyOvertime } from './overtime.js';
export { extractDailyOvertime } from './overtime.js';

export { planSyncUrls } from './sync-planner.js';

export {
  diagnoseTimeEntries,
  buildDebugLog,
  diagnoseOvertime,
  type DiagRow,
  type DebugEntry,
  type OvertimeDiagGroup,
} from './diagnostics.js';

export { todayIso } from './parse.js';
