/**
 * Reports tab (dev-only): heuristic grouping of captured JSON arrays into
 * "reports" — generic table view + CSV export.
 */

import type { CapturedRequest } from '../lib/types.js';
import {
  buildReports, exportCsv, filterRows, formatCell, sortRows,
  type Report, type ReportRow,
} from '../lib/reports.js';
import { Chart } from 'chart.js';
import { escapeHtml, download, stamp } from '../lib/format.js';
import { state } from './state.js';
import { $ } from './dom.js';

const els = {
  reportList: $('#report-list') as HTMLUListElement,
  reportTitle: $('#report-title') as HTMLHeadingElement,
  reportMeta: $('#report-meta') as HTMLParagraphElement,
  reportSearch: $('#report-search') as HTMLInputElement,
  exportCsvBtn: $('#export-csv') as HTMLButtonElement,
  sumRows: $('#sum-rows') as HTMLElement,
  sumCols: $('#sum-cols') as HTMLElement,
  sumCaps: $('#sum-caps') as HTMLElement,
  sumLast: $('#sum-last') as HTMLElement,
  table: $('#report-table') as HTMLTableElement,
  reportEmpty: $('#report-empty') as HTMLParagraphElement,
  chartCategory: $('#chart-category') as HTMLCanvasElement,
  chartTimeline: $('#chart-timeline') as HTMLCanvasElement,
  reportCount: $('#report-count') as HTMLSpanElement,
};

let reports: Report[] = [];
let selectedReportId: string | null = null;
let sortCol: string | null = null;
let sortDir: 'asc' | 'desc' = 'asc';
let categoryChart: Chart | null = null;
let timelineChart: Chart | null = null;

function prettyLabel(r: Report): string {
  const tail = r.pathname.split('/').filter(Boolean).slice(-2).join('/');
  return `${r.category} · /${tail}${r.jsonPath ? ` › ${r.jsonPath}` : ''}`;
}

function renderReportList(): void {
  els.reportList.innerHTML = '';
  if (reports.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted empty-li';
    li.textContent = 'No reports yet.';
    els.reportList.appendChild(li);
    return;
  }
  for (const r of reports) {
    const li = document.createElement('li');
    li.className = 'report-item' + (r.id === selectedReportId ? ' selected' : '');
    li.innerHTML = `
      <div class="ri-label" title="${escapeHtml(r.id)}">${escapeHtml(prettyLabel(r))}</div>
      <div class="ri-meta">
        <span class="badge">${r.rows.length} rows</span>
        <span class="badge">${r.columns.length} cols</span>
      </div>`;
    li.addEventListener('click', () => {
      selectedReportId = r.id;
      sortCol = null;
      renderReportList();
      renderReport();
    });
    els.reportList.appendChild(li);
  }
}

function renderReport(): void {
  const r = reports.find((x) => x.id === selectedReportId) ?? null;
  if (!r) {
    els.reportTitle.textContent = 'No report selected';
    els.reportMeta.textContent = '';
    els.table.querySelector('thead')!.innerHTML = '';
    els.table.querySelector('tbody')!.innerHTML = '';
    els.reportEmpty.classList.remove('hidden');
    setSummary(0, 0, 0, null);
    return;
  }
  els.reportEmpty.classList.add('hidden');
  els.reportTitle.textContent = prettyLabel(r);
  els.reportMeta.textContent = r.id;

  let rows = filterRows(r.rows, r.columns, els.reportSearch.value);
  if (sortCol && r.columns.includes(sortCol)) {
    rows = sortRows(rows, sortCol, sortDir);
  }

  setSummary(rows.length, r.columns.length, r.captureCount, r.lastSeen);
  renderTable(r.columns, rows);
}

function setSummary(rows: number, cols: number, caps: number, last: number | null): void {
  els.sumRows.textContent = String(rows);
  els.sumCols.textContent = String(cols);
  els.sumCaps.textContent = String(caps);
  els.sumLast.textContent = last ? new Date(last).toLocaleString() : '–';
}

function renderTable(columns: string[], rows: ReportRow[]): void {
  const thead = els.table.querySelector('thead')!;
  const tbody = els.table.querySelector('tbody')!;
  thead.innerHTML = '';
  tbody.innerHTML = '';

  const trh = document.createElement('tr');
  for (const c of columns) {
    const th = document.createElement('th');
    th.textContent = c;
    if (sortCol === c) th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    th.addEventListener('click', () => {
      if (sortCol === c) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else { sortCol = c; sortDir = 'asc'; }
      renderReport();
    });
    trh.appendChild(th);
  }
  thead.appendChild(trh);

  const VISIBLE = 1000;
  const slice = rows.slice(0, VISIBLE);
  const frag = document.createDocumentFragment();
  for (const row of slice) {
    const tr = document.createElement('tr');
    for (const c of columns) {
      const td = document.createElement('td');
      const val = formatCell(row[c]);
      td.textContent = val.length > 200 ? val.slice(0, 200) + '…' : val;
      td.title = val;
      tr.appendChild(td);
    }
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  if (rows.length > VISIBLE) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = columns.length;
    td.className = 'muted center';
    td.textContent = `… ${rows.length - VISIBLE} more rows hidden (filter to narrow)`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

function drawOverviewCharts(): void {
  const top = reports.slice(0, 10);
  categoryChart?.destroy();
  categoryChart = new Chart(els.chartCategory, {
    type: 'bar',
    data: {
      labels: top.map((r) => prettyLabel(r)),
      datasets: [{ label: 'Rows per report', data: top.map((r) => r.rows.length), backgroundColor: '#7c3aed' }],
    },
    options: {
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });

  const buckets = new Map<number, number>();
  const bucketSize = 60_000;
  for (const it of state.allItems) {
    const k = Math.floor(it.capturedAt / bucketSize) * bucketSize;
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  const sorted = Array.from(buckets.entries()).sort((a, b) => a[0] - b[0]);
  timelineChart?.destroy();
  timelineChart = new Chart(els.chartTimeline, {
    type: 'line',
    data: {
      labels: sorted.map(([t]) => new Date(t).toLocaleTimeString()),
      datasets: [{
        label: 'Captures / min',
        data: sorted.map(([, v]) => v),
        borderColor: '#7c3aed',
        backgroundColor: 'rgba(124,58,237,.18)',
        fill: true, tension: 0.25, pointRadius: 2,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
    },
  });
}

export function rebuildReports(items: CapturedRequest[]): void {
  reports = buildReports(items);
  els.reportCount.textContent = String(reports.length);
  if (!selectedReportId || !reports.find((r) => r.id === selectedReportId)) {
    selectedReportId = reports[0]?.id ?? null;
    sortCol = null;
  }
  renderReportList();
  renderReport();
  drawOverviewCharts();
}

export function reportsCount(): number { return reports.length; }

export function wireReports(): void {
  els.reportSearch.addEventListener('input', renderReport);
  els.exportCsvBtn.addEventListener('click', () => {
    const r = reports.find((x) => x.id === selectedReportId);
    if (!r) return;
    let rows = filterRows(r.rows, r.columns, els.reportSearch.value);
    if (sortCol && r.columns.includes(sortCol)) rows = sortRows(rows, sortCol, sortDir);
    const csv = exportCsv(r.columns, rows);
    const safe = r.id.replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
    download(csv, `${safe}-${stamp()}.csv`, 'text/csv');
  });
}
