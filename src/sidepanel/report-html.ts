/**
 * Print-ready HTML report builder. Self-contained: inline CSS + a small
 * <script> for the print button. Opened in a new tab via a Blob URL
 * (created by the dashboard).
 */

import type { TimeEntry, DateRange } from '../lib/attendance.js';
import { escapeHtml, fmtHours } from '../lib/format.js';
import { UNKNOWN } from '../lib/constants.js';

type Filters = { employee: string; project: string; search: string };

export function buildReportHtml(opts: {
  range: DateRange;
  filters: Filters;
  entries: TimeEntry[];
}): string {
  const { range, filters, entries } = opts;
  const total = entries.reduce((s, e) => s + e.hours, 0);

  // Group: project → employee → entries[]
  const projectMap = new Map<string, Map<string, TimeEntry[]>>();
  for (const e of entries) {
    const proj = e.project || UNKNOWN;
    const emp = e.employee || UNKNOWN;
    if (!projectMap.has(proj)) projectMap.set(proj, new Map());
    const empMap = projectMap.get(proj)!;
    if (!empMap.has(emp)) empMap.set(emp, []);
    empMap.get(emp)!.push(e);
  }
  const projects = Array.from(projectMap.entries())
    .map(([proj, empMap]) => {
      const employees = Array.from(empMap.entries())
        .map(([emp, items]) => ({
          name: emp,
          hours: items.reduce((s, e) => s + e.hours, 0),
          entries: items.slice().sort((a, b) => a.date.localeCompare(b.date)),
        }))
        .sort((a, b) => b.hours - a.hours);
      const projTotal = employees.reduce((s, e) => s + e.hours, 0);
      return { project: proj, hours: projTotal, employees };
    })
    .sort((a, b) => b.hours - a.hours);

  const generated = new Date().toLocaleString();
  const titleRange = `${range.from} → ${range.to}`;

  const projectsHtml = projects.map((p) => {
    const employeesHtml = p.employees.map((emp) => {
      const rowsHtml = emp.entries.map((e) => `
        <tr>
          <td>${escapeHtml(e.date)}</td>
          <td class="num">${fmtHours(e.hours)}</td>
          <td>${escapeHtml(e.activity)}</td>
          <td>${escapeHtml(e.comment)}</td>
        </tr>`).join('');
      return `
        <div class="emp-block">
          <h3>${escapeHtml(emp.name)} <span class="muted">— ${fmtHours(emp.hours)}</span></h3>
          <table>
            <thead><tr><th>Date</th><th class="num">Hours</th><th>Activity</th><th>Comment</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`;
    }).join('');
    const pct = total > 0 ? ((p.hours / total) * 100).toFixed(1) : '0.0';
    return `
      <section class="project">
        <h2>${escapeHtml(p.project)} <span class="muted">— ${fmtHours(p.hours)} (${pct}%)</span></h2>
        ${employeesHtml}
      </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="UTF-8" />
<title>Personio Report ${titleRange}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #1a1a1a; margin: 32px; line-height: 1.4; }
  header { border-bottom: 2px solid #222; padding-bottom: 12px; margin-bottom: 24px; }
  header h1 { margin: 0 0 4px; font-size: 22px; }
  header .meta { color: #666; font-size: 13px; }
  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 12px; margin: 24px 0; }
  .kpi { border: 1px solid #ddd; border-radius: 6px; padding: 10px 12px; }
  .kpi span { display: block; font-size: 11px; text-transform: uppercase; color: #666; letter-spacing: .04em; }
  .kpi strong { display: block; font-size: 18px; font-weight: 600; margin-top: 2px; }
  .filters { font-size: 12px; color: #555; margin-bottom: 16px; }
  .filters b { color: #222; }
  .project { margin: 28px 0; page-break-inside: avoid; }
  .project h2 { font-size: 17px; margin: 0 0 8px; padding-bottom: 4px; border-bottom: 1px solid #ccc; }
  .emp-block { margin: 12px 0 18px 16px; page-break-inside: avoid; }
  .emp-block h3 { font-size: 14px; margin: 0 0 6px; font-weight: 600; }
  .muted { color: #888; font-weight: 400; font-size: 0.9em; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; background: #f5f5f5; padding: 6px 8px; border-bottom: 1px solid #ccc; font-weight: 600; }
  td { padding: 5px 8px; border-bottom: 1px solid #eee; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 11px; color: #888; }
  .print-hint { background: #fffbe6; border: 1px solid #f0d97a; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 20px; }
  @media print { .print-hint { display: none; } body { margin: 16px; } }
</style>
</head><body>
  <div class="print-hint">
    <b>Tipp:</b> Drucken / als PDF speichern → <kbd>Cmd</kbd>+<kbd>P</kbd> (Mac) bzw. <kbd>Ctrl</kbd>+<kbd>P</kbd> (Win/Linux), Ziel auf „Save as PDF“.
  </div>
  <header>
    <h1>Time Report</h1>
    <div class="meta">${escapeHtml(titleRange)} · generated ${escapeHtml(generated)}</div>
  </header>
  <div class="summary">
    <div class="kpi"><span>Total hours</span><strong>${fmtHours(total)}</strong></div>
    <div class="kpi"><span>Entries</span><strong>${entries.length}</strong></div>
    <div class="kpi"><span>Projects</span><strong>${projects.length}</strong></div>
  </div>
  <div class="filters">
    Filters: <b>Employee:</b> ${escapeHtml(filters.employee)} · <b>Project:</b> ${escapeHtml(filters.project)}${filters.search ? ` · <b>Search:</b> ${escapeHtml(filters.search)}` : ''}
  </div>
  ${projectsHtml || '<p style="color:#888">No entries match the current filters.</p>'}
  <footer>Generated by Time Sheet Reporting Toolkit · unofficial · not affiliated with Personio SE · ${escapeHtml(generated)}</footer>
</body></html>`;
}
