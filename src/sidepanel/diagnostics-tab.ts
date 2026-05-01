/**
 * Detection-diagnostics card (dev-only).
 *
 * Reports which captured JSON arrays look time-entry-shaped, and why each
 * one was kept or skipped. Loaded lazily only when DEV_UI is true so the
 * production bundle doesn't pay for it.
 */

import { diagnoseTimeEntries } from '../lib/attendance.js';
import { escapeHtml } from '../lib/format.js';
import { state } from './state.js';

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

const els = {
  diagSummary: $('#diag-summary') as HTMLElement,
  diagRows: $('#diag-rows') as HTMLTableSectionElement,
  diagShowAll: $('#diag-show-all') as HTMLInputElement,
};

export function renderDiagnostics(): void {
  const all = diagnoseTimeEntries(state.allItems);
  const showAll = els.diagShowAll.checked;
  const suspicious = (k: string[]): boolean =>
    k.some((x) => /date|day|hour|duration|start|end|project|attendance|time|work/i.test(x));
  const diag = showAll ? all : all.filter((d) => d.accepted > 0 || suspicious(d.sampleKeys));
  const accepted = all.reduce((s, d) => s + d.accepted, 0);

  if (all.length === 0) {
    els.diagSummary.textContent = state.allItems.length === 0
      ? 'Waiting for captured requests… browse Personio to start collecting.'
      : `Captured ${state.allItems.length} requests but no JSON arrays were found.`;
  } else if (diag.length === 0) {
    els.diagSummary.textContent =
      `Inspected ${all.length} JSON array(s); none look related to time tracking. ` +
      `Open Personio's Attendance or Project-Time page so the relevant endpoints fire, then come back here. ` +
      `Tick "show all sources" to see everything that was captured.`;
  } else {
    els.diagSummary.textContent =
      `Inspected ${all.length} JSON array(s) across ${state.allItems.length} request(s); ${accepted} time entries accepted. ` +
      `Showing ${diag.length} time-related source(s).`;
  }
  els.diagRows.innerHTML = '';
  for (const d of diag.slice(0, 50)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td title="${escapeHtml(d.source)}">${escapeHtml(d.source.length > 60 ? '…' + d.source.slice(-60) : d.source)}</td>
      <td class="num">${d.rows}</td>
      <td><code>${escapeHtml(d.sampleKeys.join(', '))}</code></td>
      <td>${escapeHtml(d.reason)}</td>`;
    els.diagRows.appendChild(tr);
  }
}

export function wireDiagnostics(): void {
  els.diagShowAll.addEventListener('change', renderDiagnostics);
}
