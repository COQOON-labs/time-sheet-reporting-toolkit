/**
 * Dashboard tab: KPI cards, filter controls, charts, project/employee
 * tables, raw entries table. Reads from `state`, writes only to its own
 * DOM nodes.
 */

import {
  Chart,
  BarController, BarElement,
  LineController, LineElement, PointElement,
  LinearScale, CategoryScale,
  Tooltip, Legend, Filler,
} from 'chart.js';

import {
  filterEntries, sumHours, groupHoursBy, sortedHoursMap,
  todayIso, exportEntriesCsv,
  type TimeEntry, type DateRange,
} from '../lib/attendance.js';
import { escapeHtml, fmtHours, fmtOvertime, download } from '../lib/format.js';
import { BRAND, BRAND_RGBA_18 } from '../lib/constants.js';
import { state, setState } from './state.js';
import { $ } from './dom.js';
import { buildReportHtml } from './report-html.js';
import { wireSync, maybeAutoSync } from './sync-controller.js';

export { onSyncDoneRegister, onRefreshStateRegister } from './sync-controller.js';

Chart.register(
  BarController, BarElement,
  LineController, LineElement, PointElement,
  LinearScale, CategoryScale,
  Tooltip, Legend, Filler,
);

const els = {
  quickFilters: $('#quick-filters') as HTMLElement,
  dashFrom: $('#dash-from') as HTMLInputElement,
  dashTo: $('#dash-to') as HTMLInputElement,
  dashEmployee: $('#dash-employee') as HTMLSelectElement,
  dashProject: $('#dash-project') as HTMLSelectElement,
  dashSearch: $('#dash-search') as HTMLInputElement,
  dashExport: $('#dash-export') as HTMLButtonElement,
  dashReport: $('#dash-report') as HTMLButtonElement,
  dashSync: $('#dash-sync') as HTMLButtonElement,
  dashAutoSync: $('#dash-auto-sync') as HTMLInputElement,
  syncStatus: $('#sync-status') as HTMLElement,
  syncProgress: $('#sync-progress') as HTMLElement,
  syncProgressText: $('#sync-progress-text') as HTMLElement,
  kpiHours: $('#kpi-hours') as HTMLElement,
  kpiOvertime: $('#kpi-overtime') as HTMLElement,
  kpiEntries: $('#kpi-entries') as HTMLElement,
  kpiDays: $('#kpi-days') as HTMLElement,
  kpiProjects: $('#kpi-projects') as HTMLElement,
  kpiAvg: $('#kpi-avg') as HTMLElement,
  dashLine: $('#dash-line') as HTMLCanvasElement,
  dashBarProject: $('#dash-bar-project') as HTMLCanvasElement,
  tblProjects: $('#tbl-projects') as HTMLTableSectionElement,
  tblEmployees: $('#tbl-employees') as HTMLTableSectionElement,
  cardEmployees: $('#card-employees') as HTMLElement,
  entriesTable: $('#entries-table') as HTMLTableElement,
  entriesCount: $('#entries-count') as HTMLSpanElement,
  entriesEmpty: $('#entries-empty') as HTMLElement,
};

let dashLineChart: Chart | null = null;
let dashProjectChart: Chart | null = null;

// ---------- range computation ----------

export function currentRange(): DateRange {
  const today = todayIso();
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  const monthStart = (yy: number, mm: number): string =>
    new Date(Date.UTC(yy, mm, 1)).toISOString().slice(0, 10);
  const monthEnd = (yy: number, mm: number): string =>
    new Date(Date.UTC(yy, mm + 1, 0)).toISOString().slice(0, 10);

  switch (state.currentPreset) {
    case 'this-month': return { from: monthStart(y, m), to: today };
    case 'last-month': return { from: monthStart(y, m - 1), to: monthEnd(y, m - 1) };
    case 'last-3-months': return { from: monthStart(y, m - 2), to: today };
    case 'last-6-months': return { from: monthStart(y, m - 5), to: today };
    case 'this-year': return { from: `${y}-01-01`, to: today };
    case 'all': {
      // Personio (the company) was founded in 2012; their oldest tenant
      // data realistically starts ~2015. We deliberately do NOT clamp
      // `from` to the earliest already-captured date here, because on a
      // first-run sync that would collapse "All" to an empty range and
      // the user would have to keep clicking sync to walk further back
      // in time. Always reach back to 2015-01-01 so a single Sync covers
      // the full plausible history; the planner's month-window expansion
      // will skip months Personio responds to with 4xx.
      const EARLIEST = '2015-01-01';
      const dates: string[] = [];
      for (const e of state.timeEntries) dates.push(e.date);
      for (const o of state.dailyOvertime) dates.push(o.date);
      let min = EARLIEST;
      let max = today;
      for (const d of dates) {
        if (d < min) min = d;
        if (d > max) max = d;
      }
      return { from: min, to: max };
    }
    case 'custom':
      return {
        from: els.dashFrom.value || '1970-01-01',
        to: els.dashTo.value || today,
      };
    default: return { from: monthStart(y, m), to: today };
  }
}

function refreshDashFilters(): void {
  const employees = Array.from(new Set(state.timeEntries.map((e) => e.employee).filter((x) => x && x !== '—'))).sort();
  const projects = Array.from(new Set(state.timeEntries.map((e) => e.project).filter((x) => x && x !== '—'))).sort();

  const fillSelect = (sel: HTMLSelectElement, opts: string[], includeAll: boolean): void => {
    const current = sel.value;
    const allOpt = includeAll ? '<option value="">All</option>' : '';
    sel.innerHTML = allOpt + opts.map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join('');
    if (opts.includes(current)) sel.value = current;
    else if (!includeAll && opts.length > 0) sel.value = opts[0]!;
  };

  const ownInList = state.ownEmployee?.name && employees.includes(state.ownEmployee.name);
  const employeeIncludeAll = employees.length > 1;
  fillSelect(els.dashEmployee, employees, employeeIncludeAll);
  if (!state.employeeSelectTouched && ownInList) {
    els.dashEmployee.value = state.ownEmployee!.name;
  }
  fillSelect(els.dashProject, projects, true);

  els.cardEmployees.style.display = employees.length > 1 ? '' : 'none';

  const r = currentRange();
  if (state.currentPreset !== 'custom') {
    els.dashFrom.value = r.from;
    els.dashTo.value = r.to;
  }
}

// ---------- overtime ----------

function sumOvertimeMinutes(range: DateRange, employeeName: string | ''): number {
  if (state.dailyOvertime.length === 0) return 0;
  const filterId = employeeName ? state.nameToId.get(employeeName) : null;
  let total = 0;
  const seen = new Set<string>();
  for (const d of state.dailyOvertime) {
    if (d.date < range.from || d.date > range.to) continue;
    if (filterId && d.employeeId !== filterId) continue;
    const k = `${d.date}|${d.employeeId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    total += d.minutes;
  }
  return total;
}

// ---------- render ----------

export function renderDashboard(): void {
  const range = currentRange();
  const filtered = filterEntries(
    state.timeEntries, range,
    els.dashEmployee.value, els.dashProject.value, els.dashSearch.value,
  );

  const total = sumHours(filtered);
  const byProject = sortedHoursMap(groupHoursBy(filtered, 'project'));
  const byEmployee = sortedHoursMap(groupHoursBy(filtered, 'employee'));
  const byDate = groupHoursBy(filtered, 'date');
  const distinctDays = new Set(filtered.map((e) => e.date)).size;

  els.kpiHours.textContent = fmtHours(total);
  els.kpiOvertime.textContent = fmtOvertime(sumOvertimeMinutes(range, els.dashEmployee.value));
  els.kpiEntries.textContent = String(filtered.length);
  els.kpiDays.textContent = String(distinctDays);
  els.kpiProjects.textContent = String(byProject.length);
  els.kpiAvg.textContent = distinctDays > 0 ? fmtHours(total / distinctDays) : '0h';

  drawDashCharts(byDate, byProject);
  renderHoursTable(els.tblProjects, byProject, total);
  renderHoursTable(els.tblEmployees, byEmployee, total);
  renderEntriesTable(filtered);
  els.entriesCount.textContent = `(${filtered.length})`;
  els.entriesEmpty.classList.toggle('hidden', filtered.length > 0);
}

function drawDashCharts(
  byDate: Map<string, number>,
  byProject: [string, number][],
): void {
  const dates = Array.from(byDate.keys()).sort();
  dashLineChart?.destroy();
  dashLineChart = new Chart(els.dashLine, {
    type: 'line',
    data: {
      labels: dates,
      datasets: [{
        label: 'Hours',
        data: dates.map((d) => byDate.get(d) ?? 0),
        borderColor: BRAND,
        backgroundColor: BRAND_RGBA_18,
        fill: true, tension: 0.25, pointRadius: 2,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } },
    },
  });

  const top = byProject.slice(0, 12);
  dashProjectChart?.destroy();
  dashProjectChart = new Chart(els.dashBarProject, {
    type: 'bar',
    data: {
      labels: top.map(([k]) => k),
      datasets: [{ label: 'Hours', data: top.map(([, v]) => v), backgroundColor: BRAND }],
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true } },
    },
  });
}

function renderHoursTable(
  tbody: HTMLTableSectionElement,
  rows: [string, number][],
  total: number,
): void {
  tbody.innerHTML = '';
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" class="muted center">No data in this range.</td></tr>';
    return;
  }
  const max = rows[0]![1];
  const frag = document.createDocumentFragment();
  for (const [k, v] of rows.slice(0, 50)) {
    const pct = total > 0 ? (v / total) * 100 : 0;
    const tr = document.createElement('tr');
    const widthPx = max > 0 ? Math.round((v / max) * 80) : 0;
    tr.innerHTML = `
      <td>${escapeHtml(k)}</td>
      <td class="num">${fmtHours(v)}<span class="bar" style="width:80px"><i style="width:${widthPx}px"></i></span></td>
      <td class="num">${pct.toFixed(1)}%</td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

function renderEntriesTable(entries: TimeEntry[]): void {
  const tbody = els.entriesTable.querySelector('tbody')!;
  tbody.innerHTML = '';
  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date));
  const VISIBLE = 500;
  const frag = document.createDocumentFragment();
  for (const e of sorted.slice(0, VISIBLE)) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${e.date}</td>
      <td class="num">${fmtHours(e.hours)}</td>
      <td>${escapeHtml(e.project)}</td>
      <td>${escapeHtml(e.activity)}</td>
      <td>${escapeHtml(e.employee)}</td>
      <td>${escapeHtml(e.comment)}</td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
  if (sorted.length > VISIBLE) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="6" class="muted center">… ${sorted.length - VISIBLE} more entries hidden</td>`;
    tbody.appendChild(tr);
  }
}

// ---------- sync (delegated to sync-controller) ----------

// ---------- wiring ----------

export function wireDashboard(opts: {
  /** Persist auto-sync checkbox via prefs module. */
  autoSyncInitial: boolean;
  onAutoSyncChange: (checked: boolean) => void;
}): void {
  els.dashAutoSync.checked = opts.autoSyncInitial;

  els.quickFilters.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.qf');
    if (!btn) return;
    const preset = btn.dataset.preset;
    if (!preset) return;
    setState({ currentPreset: preset });
    els.quickFilters.querySelectorAll('.qf').forEach((b) =>
      b.classList.toggle('active', (b as HTMLButtonElement).dataset.preset === preset),
    );
    const isCustom = preset === 'custom';
    els.dashFrom.disabled = !isCustom;
    els.dashTo.disabled = !isCustom;
    refreshDashFilters();
    renderDashboard();
    maybeAutoSync(true);
  });

  els.dashFrom.addEventListener('change', () => {
    if (state.currentPreset !== 'custom') return;
    renderDashboard();
    maybeAutoSync(true);
  });
  els.dashTo.addEventListener('change', () => {
    if (state.currentPreset !== 'custom') return;
    renderDashboard();
    maybeAutoSync(true);
  });
  els.dashEmployee.addEventListener('change', () => {
    setState({ employeeSelectTouched: true });
    renderDashboard();
  });
  els.dashProject.addEventListener('change', renderDashboard);
  els.dashSearch.addEventListener('input', renderDashboard);

  els.dashExport.addEventListener('click', () => {
    const range = currentRange();
    const filtered = filterEntries(
      state.timeEntries, range,
      els.dashEmployee.value, els.dashProject.value, els.dashSearch.value,
    );
    download(exportEntriesCsv(filtered), `time-entries-${range.from}_${range.to}.csv`, 'text/csv');
  });

  els.dashReport.addEventListener('click', () => {
    const range = currentRange();
    const filtered = filterEntries(
      state.timeEntries, range,
      els.dashEmployee.value, els.dashProject.value, els.dashSearch.value,
    );
    const html = buildReportHtml({
      range,
      filters: {
        employee: els.dashEmployee.value || 'All',
        project: els.dashProject.value || 'All',
        search: els.dashSearch.value || '',
      },
      entries: filtered,
      overtimeMinutes: sumOvertimeMinutes(range, els.dashEmployee.value),
      printHelperUrl: chrome.runtime.getURL('print-helper.js'),
    });
    // Use a Blob URL instead of a `data:` URL: Blob URLs are scoped to the
    // creating origin, never appear in the URL bar / history with the data
    // payload, and don't bloat referrer logs.
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      chrome.tabs.create({ url });
    } else {
      window.open(url, '_blank');
    }
    // Revoke shortly after; the new tab has already loaded the resource.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });

  wireSync({
    els: {
      dashSync: els.dashSync,
      dashAutoSync: els.dashAutoSync,
      syncStatus: els.syncStatus,
      syncProgress: els.syncProgress,
      syncProgressText: els.syncProgressText,
    },
    getRange: currentRange,
  });

  // Persist the auto-sync preference (sync-controller owns the run-on-enable behavior).
  els.dashAutoSync.addEventListener('change', () => {
    opts.onAutoSyncChange(els.dashAutoSync.checked);
  });

  // initial: dates disabled because default preset is "this-month"
  els.dashFrom.disabled = true;
  els.dashTo.disabled = true;
}

/** Re-populate select dropdowns when state changes (called after refresh). */
export function syncDashboardFiltersFromState(): void {
  refreshDashFilters();
}

/** Trigger an initial silent sync if auto-sync is on. */
export function kickoffInitialAutoSync(): void {
  maybeAutoSync(true);
}
