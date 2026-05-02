/**
 * Heuristic "report" extractor.
 *
 * Personio's UI talks to many different JSON endpoints. We don't know the
 * shape ahead of time, so we walk each captured response and look for
 * arrays of objects ("rows") that look like a report/table. We then group
 * them by URL pathname so the same endpoint accumulates rows over time
 * (e.g. paginated calls).
 */

import type { CapturedRequest } from './types.js';
import { isPlainObject } from './walk.js';
import { safePathname } from './parse.js';
import { escapeCsvCell } from './format.js';

export type ReportRow = Record<string, unknown>;

export type Report = {
  /** Stable id: pathname + JSON path inside the response. */
  id: string;
  /** Human label, e.g. "attendance · /api/v1/attendances [data]". */
  label: string;
  /** Pathname of the originating request. */
  pathname: string;
  /** JSON path inside the body where the array was found ("" = root). */
  jsonPath: string;
  /** Best-guess category from the originating request. */
  category: string;
  /** Union of all column keys observed across rows. */
  columns: string[];
  /** All rows merged across captured responses for this report id. */
  rows: ReportRow[];
  /** Most recent capturedAt timestamp. */
  lastSeen: number;
  /** Number of distinct captures that contributed rows. */
  captureCount: number;
};

const MIN_ROWS = 2;
const MAX_DEPTH = 6;
const MAX_ROWS_PER_REPORT = 20_000;

/** Walk a JSON value and yield every array-of-objects with its path. */
function* findArrays(
  value: unknown,
  path: string,
  depth: number,
): Generator<{ path: string; rows: ReportRow[] }> {
  if (depth > MAX_DEPTH || value == null) return;

  if (Array.isArray(value)) {
    if (value.length >= MIN_ROWS && value.every((v) => isPlainObject(v))) {
      yield { path, rows: value as ReportRow[] };
    }
    // Don't recurse into arrays of arrays / primitives — usually noise.
    return;
  }

  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const next = path ? `${path}.${k}` : k;
      yield* findArrays(v, next, depth + 1);
    }
  }
}

function rowKey(row: ReportRow): string {
  // Prefer a real id column if present.
  for (const k of ['id', 'uuid', 'employee_id', 'employeeId', 'key']) {
    const v = row[k];
    if (v != null && (typeof v === 'string' || typeof v === 'number')) {
      return `${k}:${v}`;
    }
  }
  // Fallback: hash of all primitive values, stable across key order.
  const parts = Object.keys(row)
    .sort()
    .map((k) => {
      const v = row[k];
      if (v == null) return `${k}=`;
      if (typeof v === 'object') return `${k}=#`;
      return `${k}=${String(v)}`;
    });
  return parts.join('|');
}

/** Merge all captured requests into a deduped list of reports. */
export function buildReports(items: CapturedRequest[]): Report[] {
  const acc = new Map<string, Report>();

  // Iterate oldest → newest so the newest version of a row wins.
  const ordered = [...items].sort((a, b) => a.capturedAt - b.capturedAt);

  for (const it of ordered) {
    if (!it.bodyJson) continue;
    const pathname = safePathname(it.url);

    for (const found of findArrays(it.bodyJson, '', 0)) {
      const id = `${pathname}#${found.path || '$'}`;
      let rep = acc.get(id);
      if (!rep) {
        rep = {
          id,
          label: `${it.category} · ${pathname}${found.path ? ` [${found.path}]` : ''}`,
          pathname,
          jsonPath: found.path,
          category: it.category,
          columns: [],
          rows: [],
          lastSeen: 0,
          captureCount: 0,
        };
        acc.set(id, rep);
      }
      rep.captureCount += 1;
      rep.lastSeen = Math.max(rep.lastSeen, it.capturedAt);

      // Merge rows by stable key.
      const byKey = new Map<string, ReportRow>();
      for (const r of rep.rows) byKey.set(rowKey(r), r);
      for (const r of found.rows) byKey.set(rowKey(r), r);
      rep.rows = Array.from(byKey.values()).slice(-MAX_ROWS_PER_REPORT);

      // Refresh column union (preserve first-seen order).
      const cols = new Set(rep.columns);
      for (const r of rep.rows) for (const k of Object.keys(r)) cols.add(k);
      rep.columns = Array.from(cols);
    }
  }

  // Sort reports by row count desc — most useful first.
  return Array.from(acc.values()).sort((a, b) => b.rows.length - a.rows.length);
}

/** Format any cell value to a string for display + search. */
export function formatCell(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Try to coerce a value for sorting (numbers / dates first). */
export function sortValue(v: unknown): number | string {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    // ISO-ish date?
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== '') return n;
    return v.toLowerCase();
  }
  return formatCell(v).toLowerCase();
}

/** Filter rows by a free-text query (case-insensitive substring on any cell). */
export function filterRows(rows: ReportRow[], columns: string[], q: string): ReportRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((r) =>
    columns.some((c) => formatCell(r[c]).toLowerCase().includes(needle)),
  );
}

export function sortRows(
  rows: ReportRow[],
  column: string,
  dir: 'asc' | 'desc',
): ReportRow[] {
  const sorted = [...rows].sort((a, b) => {
    const av = sortValue(a[column]);
    const bv = sortValue(b[column]);
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  });
  return dir === 'desc' ? sorted.reverse() : sorted;
}

export function exportCsv(columns: string[], rows: ReportRow[]): string {
  const head = columns.map(escapeCsvCell).join(',');
  const body = rows
    .map((r) => columns.map((c) => escapeCsvCell(formatCell(r[c]))).join(','))
    .join('\n');
  return `${head}\n${body}\n`;
}
