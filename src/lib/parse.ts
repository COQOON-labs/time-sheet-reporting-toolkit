/**
 * Low-level value parsing — date/time/duration coercion, label picking.
 * Pure, side-effect-free helpers shared across the time-entry pipeline.
 */

import { isPlainObject } from './walk.js';

/** Pick the first non-empty value matching any of `keys` in object `o`. */
export function pick(o: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    if (k in o && o[k] != null && o[k] !== '') return o[k];
  }
  return undefined;
}

/** Recursively look up a nested label-ish field, e.g. project.name. */
export function pickLabel(v: unknown, fallbackKeys: readonly string[]): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (isPlainObject(v)) {
    for (const k of ['name', 'title', 'label', 'display_name', 'displayName', 'first_name', 'firstName']) {
      if (typeof v[k] === 'string') {
        // For employee: combine first + last if both present
        if (k === 'first_name' || k === 'firstName') {
          const last = (v.last_name ?? v.lastName) as string | undefined;
          return [v[k] as string, last].filter(Boolean).join(' ');
        }
        return v[k] as string;
      }
    }
    const nested = pick(v, fallbackKeys);
    if (nested != null) return pickLabel(nested, fallbackKeys);
  }
  return undefined;
}

/** Parse various time/date encodings → epoch ms (or null). */
export function parseTime(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') {
    // Heuristic: < 10^11 → seconds, else ms
    return v < 1e11 ? v * 1000 : v;
  }
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

export function toIsoDate(v: unknown): string | null {
  const t = parseTime(v);
  if (t == null) return null;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** Convert any duration-ish value to hours. */
export function durationToHours(v: unknown, key: string): number | null {
  if (v == null) return null;
  // string "HH:MM" or "HH:MM:SS"
  if (typeof v === 'string') {
    const m = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/.exec(v.trim());
    if (m) {
      const [, hh, mm, ss] = m;
      return Number(hh) + Number(mm) / 60 + Number(ss ?? 0) / 3600;
    }
    const n = Number(v);
    if (Number.isNaN(n)) return null;
    return numToHours(n, key);
  }
  if (typeof v === 'number') return numToHours(v, key);
  return null;
}

function numToHours(n: number, key: string): number {
  const k = key.toLowerCase();
  if (k.includes('hour')) return n;
  if (k.includes('second')) return n / 3600;
  if (k.includes('minute')) return n / 60;
  // "duration" without unit hint — typical Personio uses seconds for "duration".
  if (k === 'duration') return n / 3600;
  // Fallback heuristic by magnitude.
  if (n > 1000) return n / 3600; // assume seconds
  if (n > 24) return n / 60;     // assume minutes
  return n;                      // assume hours
}

/** ISO date helpers. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Inclusive list of [start, end] for each calendar month touching [from, to]. */
export function monthWindows(from: string, to: string): Array<{ start: string; end: string }> {
  const out: Array<{ start: string; end: string }> = [];
  const a = new Date(from + 'T00:00:00Z');
  const b = new Date(to + 'T00:00:00Z');
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) return out;
  let y = a.getUTCFullYear();
  let m = a.getUTCMonth();
  while (true) {
    const start = new Date(Date.UTC(y, m, 1));
    const end = new Date(Date.UTC(y, m + 1, 0));
    const sIso = start.toISOString().slice(0, 10);
    const eIso = end.toISOString().slice(0, 10);
    out.push({
      start: sIso < from ? from : sIso,
      end: eIso > to ? to : eIso,
    });
    if (y === b.getUTCFullYear() && m === b.getUTCMonth()) break;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    if (out.length > 240) break; // safety
  }
  return out;
}

export function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s ? s.slice(0, 5000) : '';
  } catch { return ''; }
}

/** Best-effort URL pathname extraction with safe fallback. */
export function safePathname(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}
