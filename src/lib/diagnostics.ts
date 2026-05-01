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
