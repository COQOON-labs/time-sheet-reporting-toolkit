/**
 * Tiny formatting / DOM helpers used by sidepanel + report renderer.
 * Pure, no side-effects, safe to unit-test.
 */

/** Escape user-controlled text for safe HTML insertion. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

/** Quote a single CSV cell per RFC 4180. */
export function escapeCsvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** UTF-8 byte length of a string (for accurate response-body sizing). */
export function utf8Bytes(s: string): number {
  // TextEncoder is available in service workers, content scripts and pages.
  return new TextEncoder().encode(s).length;
}

/** YYYY-MM-DD stamp from current time, e.g. for filenames. */
export function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Format decimal hours as "[-]Hh MMm". */
export function fmtHours(h: number): string {
  const sign = h < 0 ? '-' : '';
  const abs = Math.abs(h);
  const hh = Math.floor(abs);
  const mm = Math.round((abs - hh) * 60);
  return `${sign}${hh}h ${String(mm).padStart(2, '0')}m`;
}

/** Format signed minutes as "+/-Xh Ym" (used for overtime KPIs). */
export function fmtOvertime(minutes: number): string {
  const sign = minutes < 0 ? '-' : minutes > 0 ? '+' : '';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `${sign}${h}h ${m}m`;
}

/** Trigger a browser download of an in-memory string (sidepanel-only — needs DOM). */
export function download(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

