/**
 * Tiny DOM helper shared across all sidepanel modules.
 *
 * Replaces five copies of the same `$()` selector wrapper that previously
 * lived in dashboard / main / raw-tab / reports-tab / diagnostics-tab.
 */

/** Throws if the selector matches no element. Use for required wiring. */
export function $<T extends Element = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}

/** All matches (for repeated UI like tab buttons). */
export function $$<T extends Element = HTMLElement>(sel: string): NodeListOf<T> {
  return document.querySelectorAll<T>(sel);
}
