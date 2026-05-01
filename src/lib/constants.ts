/**
 * Shared constants: domain tokens used in normalized data + storage keys.
 *
 * Keeping these centralized prevents subtle bugs from comparing against
 * the wrong literal (e.g. `e.employee !== '—'` vs `!e.employee`).
 */

/** Placeholder for any normalized field whose source value couldn't be resolved. */
export const UNKNOWN = '—';

/** Project label prefix used when only a numeric id is available. */
export const PROJECT_ID_PREFIX = 'Project #';

/** Employee label prefix used when only a numeric id is available. */
export const EMPLOYEE_ID_PREFIX = 'Employee #';

/** localStorage keys (sidepanel-context). */
export const STORAGE_KEYS = {
  autoSync: 'a4p-auto-sync',
  panelWidth: 'a4p-panel-width',
} as const;

/** IndexedDB metadata. */
export const DB = {
  name: 'analytics-for-personio',
  version: 1,
  store: 'requests',
} as const;

/** Matches /timesheet/{employeeId} on Personio's BFF; group 1 is the id. */
export const TIMESHEET_URL_RE = /\/timesheet\/(\d{3,})/i;

/** Brand color, also referenced via CSS custom property `--brand`. */
export const BRAND = '#7c3aed';
export const BRAND_RGBA_18 = 'rgba(124,58,237,.18)';
