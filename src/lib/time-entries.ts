/**
 * TimeEntry domain: schema, normalization, extraction, filtering, aggregation.
 *
 * Personio exposes time entries through several different endpoints with
 * subtly different field names. We don't bind to one schema — instead we
 * walk every captured /timesheet/{id} response, find arrays that look like
 * time entries (date + duration OR start/end), and normalize them into a
 * single `TimeEntry` shape.
 */

import type { CapturedRequest } from './types.js';
import { isPlainObject } from './walk.js';
import {
  pick,
  pickLabel,
  parseTime,
  toIsoDate,
  durationToHours,
} from './parse.js';
import { buildEmployeeIndex, buildProjectIndex } from './name-index.js';
import { UNKNOWN, PROJECT_ID_PREFIX, EMPLOYEE_ID_PREFIX } from './constants.js';

export type TimeEntry = {
  /** Stable id (uses source id when available). */
  id: string;
  /** ISO date (YYYY-MM-DD) — the day this entry counts for. */
  date: string;
  /** Worked time in hours (decimal). */
  hours: number;
  /** Project label (best-effort; UNKNOWN if not present). */
  project: string;
  /** Optional secondary breakdown (activity / category / task). */
  activity: string;
  /** Employee label (best-effort; UNKNOWN for own entries without context). */
  employee: string;
  /** Optional comment / description. */
  comment: string;
  /** Source pathname for debugging. */
  source: string;
};

export type DateRange = { from: string; to: string }; // YYYY-MM-DD inclusive

const DATE_KEYS = ['date', 'day', 'work_date', 'workDate', 'start_date', 'startDate', 'attendance_date', 'attendanceDate'];
const START_KEYS = ['start', 'start_time', 'startTime', 'start_at', 'startAt', 'from', 'begin', 'beginTime'];
const END_KEYS = ['end', 'end_time', 'endTime', 'end_at', 'endAt', 'to', 'finish', 'finishTime'];
const DURATION_KEYS = ['duration', 'duration_minutes', 'durationMinutes', 'duration_seconds', 'durationSeconds', 'minutes', 'seconds', 'hours', 'worked_hours', 'workedHours', 'time_worked', 'timeWorked', 'net_duration', 'netDuration'];
const BREAK_KEYS = ['break', 'breaks', 'break_minutes', 'breakMinutes', 'pause', 'pause_minutes'];

const PROJECT_KEYS = ['project', 'project_name', 'projectName', 'project_title', 'projectTitle'];
const PROJECT_ID_KEYS = ['project_id', 'projectId'];
const ACTIVITY_KEYS = ['activity', 'activity_name', 'activityName', 'category', 'task', 'task_name', 'taskName', 'type'];
const EMPLOYEE_KEYS = ['employee', 'employee_name', 'employeeName', 'user', 'user_name', 'userName', 'person'];
const EMPLOYEE_ID_KEYS = ['employee_id', 'employeeId', 'user_id', 'userId'];
const COMMENT_KEYS = ['comment', 'comments', 'note', 'notes', 'description'];
const ID_KEYS = ['id', 'uuid', '_id'];

export function isLikelyTimeEntry(row: Record<string, unknown>): boolean {
  const hasDate = DATE_KEYS.some((k) => k in row && row[k] != null);
  const hasDuration = DURATION_KEYS.some((k) => k in row && row[k] != null);
  const hasStartEnd =
    START_KEYS.some((k) => k in row && row[k] != null) &&
    END_KEYS.some((k) => k in row && row[k] != null);
  const hasProject = PROJECT_KEYS.some((k) => k in row) ||
    PROJECT_ID_KEYS.some((k) => k in row);
  return (hasDate && (hasDuration || hasStartEnd)) ||
    hasStartEnd ||
    (hasDate && hasProject && hasDuration);
}

export function normalizeRow(
  row: Record<string, unknown>,
  source: string,
  urlEmployeeId?: string | null,
): TimeEntry | null {
  // Skip non-work periods (breaks, time-off entries inside attendance arrays).
  const t = (row.type ?? row.period_type) as unknown;
  if (typeof t === 'string') {
    const tl = t.toLowerCase();
    if (tl === 'break' || tl === 'pause' || tl === 'time_off' || tl === 'absence') {
      return null;
    }
  }

  let date: string | null = null;
  for (const k of DATE_KEYS) {
    if (k in row) { date = toIsoDate(row[k]); if (date) break; }
  }
  if (!date) {
    for (const k of START_KEYS) {
      if (k in row) { date = toIsoDate(row[k]); if (date) break; }
    }
  }
  if (!date) return null;

  let hours: number | null = null;
  for (const k of DURATION_KEYS) {
    if (k in row && row[k] != null) {
      hours = durationToHours(row[k], k);
      if (hours != null) break;
    }
  }
  if (hours == null) {
    const startV = pick(row, START_KEYS);
    const endV = pick(row, END_KEYS);
    const s = parseTime(startV);
    const e = parseTime(endV);
    if (s != null && e != null && e > s) {
      hours = (e - s) / 3_600_000;
      const br = pick(row, BREAK_KEYS);
      const brHours = br != null ? durationToHours(br, 'minutes') : null;
      if (brHours != null) hours = Math.max(0, hours - brHours);
    }
  }
  if (hours == null || hours <= 0 || hours > 24) return null;

  const project = pickLabel(pick(row, PROJECT_KEYS), PROJECT_ID_KEYS)
    ?? (() => {
      const pid = pick(row, PROJECT_ID_KEYS);
      return pid != null ? `${PROJECT_ID_PREFIX}${pid}` : UNKNOWN;
    })();
  const activity = pickLabel(pick(row, ACTIVITY_KEYS), []) ?? '';
  const employee = pickLabel(pick(row, EMPLOYEE_KEYS), EMPLOYEE_ID_KEYS)
    ?? (urlEmployeeId ? `${EMPLOYEE_ID_PREFIX}${urlEmployeeId}` : UNKNOWN);
  const comment = (pick(row, COMMENT_KEYS) as string | undefined) ?? '';

  const idVal = pick(row, ID_KEYS);
  const id = idVal != null
    ? String(idVal)
    : `${date}|${project}|${employee}|${hours.toFixed(3)}`;

  return {
    id,
    date,
    hours: Number(hours.toFixed(4)),
    project,
    activity: typeof activity === 'string' ? activity : String(activity),
    employee,
    comment: typeof comment === 'string' ? comment : String(comment),
    source,
  };
}

export function* walkArrays(
  v: unknown,
  depth: number,
): Generator<Record<string, unknown>[]> {
  if (depth > 8 || v == null) return;
  if (Array.isArray(v)) {
    if (v.length > 0 && v.every(isPlainObject)) {
      yield v as Record<string, unknown>[];
      // Also recurse into each element — Personio nests time entries
      // inside parent rows (timecards[].periods[]).
      for (const item of v) yield* walkArrays(item, depth + 1);
    }
    return;
  }
  if (isPlainObject(v)) {
    for (const k of Object.keys(v)) yield* walkArrays(v[k], depth + 1);
  }
}

/** Build a deduped list of time entries from all captured responses. */
export function extractTimeEntries(items: CapturedRequest[]): TimeEntry[] {
  const projectNames = buildProjectIndex(items);
  const employeeNames = buildEmployeeIndex(items);
  const byId = new Map<string, TimeEntry>();
  for (const it of items) {
    if (!it.bodyJson) continue;
    // Only the rich /timesheet/{id} endpoint carries project_id + comment + employee context.
    if (!/\/timesheet\/\d{3,}/.test(it.url)) continue;
    let source = it.url;
    try { source = new URL(it.url).pathname; } catch { /* keep raw */ }
    const urlEmpMatch = /\/timesheet\/(\d{3,})/.exec(it.url);
    const urlEmpId = urlEmpMatch ? urlEmpMatch[1] : null;
    for (const arr of walkArrays(it.bodyJson, 0)) {
      const sample = arr.slice(0, 10);
      const matchRate = sample.filter(isLikelyTimeEntry).length / sample.length;
      if (matchRate < 0.3) continue;
      for (const row of arr) {
        if (!isLikelyTimeEntry(row)) continue;
        const norm = normalizeRow(row, source, urlEmpId);
        if (!norm) continue;
        if (norm.project.startsWith(PROJECT_ID_PREFIX)) {
          const id = norm.project.slice(PROJECT_ID_PREFIX.length);
          const name = projectNames.get(id);
          if (name) norm.project = name;
        }
        if (norm.employee.startsWith(EMPLOYEE_ID_PREFIX)) {
          const id = norm.employee.slice(EMPLOYEE_ID_PREFIX.length);
          const name = employeeNames.get(id);
          if (name) norm.employee = name;
        }
        byId.set(norm.id, norm);
      }
    }
  }
  // Cross-endpoint dedup: same time slot captured via two endpoints, keep the
  // more complete one.
  const bySig = new Map<string, TimeEntry>();
  for (const e of byId.values()) {
    const sig = `${e.date}|${e.hours.toFixed(3)}|${e.comment}`;
    const prev = bySig.get(sig);
    if (!prev || completeness(e) > completeness(prev)) {
      bySig.set(sig, e);
    }
  }
  return Array.from(bySig.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function completeness(e: TimeEntry): number {
  let s = 0;
  if (e.project && e.project !== UNKNOWN && !e.project.startsWith(PROJECT_ID_PREFIX)) s += 2;
  if (e.employee && e.employee !== UNKNOWN && !e.employee.startsWith(EMPLOYEE_ID_PREFIX)) s += 2;
  if (e.activity) s += 1;
  return s;
}

// ---------- Aggregations ----------

export function inRange(e: TimeEntry, r: DateRange): boolean {
  return e.date >= r.from && e.date <= r.to;
}

export function filterEntries(
  entries: TimeEntry[],
  range: DateRange,
  employee: string | '',
  project: string | '',
  search: string,
): TimeEntry[] {
  const q = search.trim().toLowerCase();
  return entries.filter((e) => {
    if (!inRange(e, range)) return false;
    if (employee && e.employee !== employee) return false;
    if (project && e.project !== project) return false;
    if (!q) return true;
    return (
      e.project.toLowerCase().includes(q) ||
      e.activity.toLowerCase().includes(q) ||
      e.employee.toLowerCase().includes(q) ||
      e.comment.toLowerCase().includes(q)
    );
  });
}

export function sumHours(entries: TimeEntry[]): number {
  return entries.reduce((s, e) => s + e.hours, 0);
}

export function groupHoursBy(
  entries: TimeEntry[],
  key: 'project' | 'activity' | 'employee' | 'date',
): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entries) {
    const k = e[key] || UNKNOWN;
    m.set(k, (m.get(k) ?? 0) + e.hours);
  }
  return m;
}

export function sortedHoursMap(m: Map<string, number>): [string, number][] {
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
}

export function exportEntriesCsv(entries: TimeEntry[]): string {
  const cols: (keyof TimeEntry)[] = ['date', 'hours', 'project', 'activity', 'employee', 'comment'];
  const esc = (s: string): string =>
    /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const head = cols.join(',');
  const body = entries
    .map((e) => cols.map((c) => esc(String(e[c] ?? ''))).join(','))
    .join('\n');
  return `${head}\n${body}\n`;
}
