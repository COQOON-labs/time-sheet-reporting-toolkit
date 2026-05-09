/**
 * Sidepanel bootstrap.
 *
 * - Wires global tab routing + DEV-gating.
 * - Loads dashboard module (always).
 * - Lazy-loads dev-only tab modules (raw, reports, diagnostics) only when
 *   running with `import.meta.env.DEV` true or `?dev=1` in the URL.
 * - Owns the periodic refresh loop.
 */

import {
  extractTimeEntries, extractDailyOvertime, getOwnEmployee, buildDebugLog,
  diagnoseTimeEntries, diagnoseOvertime, planSyncUrls,
} from '../lib/attendance.js';
import { download, stamp } from '../lib/format.js';
import { STORAGE_KEYS } from '../lib/constants.js';
import { readPrefBool, writePrefBool } from '../lib/prefs.js';
import { state, setState, buildNameToIdMap } from './state.js';
import { send } from './messaging.js';
import { $ } from './dom.js';
import {
  wireDashboard,
  renderDashboard,
  syncDashboardFiltersFromState,
  kickoffInitialAutoSync,
  onSyncDoneRegister,
  onRefreshStateRegister,
  currentRange,
} from './dashboard.js';

const DEV_UI =
  import.meta.env.DEV ||
  new URLSearchParams(location.search).has('dev');

if (!DEV_UI) {
  document
    .querySelectorAll<HTMLElement>('[data-dev-only]')
    .forEach((el) => el.classList.add('hidden'));
}

const els = {
  status: $('#status') as HTMLParagraphElement,
  refresh: $('#refresh') as HTMLButtonElement,
  clear: $('#clear') as HTMLButtonElement,
  dashClearCache: $('#dash-clear-cache') as HTMLButtonElement,
  dashDebug: $('#dash-debug') as HTMLButtonElement,
  tabs: document.querySelectorAll<HTMLButtonElement>('.tab'),
  panels: document.querySelectorAll<HTMLElement>('.tab-panel'),
  tabsNav: document.querySelector<HTMLElement>('nav.tabs'),
};

// ---------- Tab routing ----------
els.tabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.tab;
    if (!id) return;
    els.tabs.forEach((b) => b.classList.toggle('active', b === btn));
    els.panels.forEach((p) => p.classList.toggle('active', p.id === `tab-${id}`));
  });
});

// Hide the tab nav entirely when only one tab remains visible (production).
if (els.tabsNav) {
  const visible = Array.from(els.tabs).filter((t) => !t.classList.contains('hidden'));
  if (visible.length <= 1) els.tabsNav.classList.add('hidden');
}

// ---------- Dev-only tab modules (lazy) ----------

type DevTabs = {
  renderRaw: () => void;
  rebuildReports: (items: typeof state.allItems) => void;
  reportsCount: () => number;
  renderDiagnostics: () => void;
};

let devTabs: DevTabs | null = null;

async function loadDevTabsIfNeeded(): Promise<void> {
  if (!DEV_UI || devTabs) return;
  const [raw, reps, diag] = await Promise.all([
    import('./raw-tab.js'),
    import('./reports-tab.js'),
    import('./diagnostics-tab.js'),
  ]);
  raw.wireRaw();
  reps.wireReports();
  diag.wireDiagnostics();
  devTabs = {
    renderRaw: raw.renderRaw,
    rebuildReports: reps.rebuildReports,
    reportsCount: reps.reportsCount,
    renderDiagnostics: diag.renderDiagnostics,
  };
}

// ---------- Refresh ----------

async function refresh(): Promise<void> {
  const res = await send('list', { limit: 5000 });
  const allItems = res.items ?? [];
  const timeEntries = extractTimeEntries(allItems);
  const dailyOvertime = extractDailyOvertime(allItems);
  const ownEmployee = getOwnEmployee(allItems);

  setState({
    allItems,
    timeEntries,
    dailyOvertime,
    ownEmployee,
    nameToId: buildNameToIdMap(timeEntries, ownEmployee),
  });

  syncDashboardFiltersFromState();
  renderDashboard();

  if (devTabs) {
    devTabs.rebuildReports(allItems);
    devTabs.renderRaw();
    devTabs.renderDiagnostics();
  }

  const reportsLabel = devTabs
    ? ` · ${devTabs.reportsCount()} report${devTabs.reportsCount() === 1 ? '' : 's'}`
    : '';
  const ec = timeEntries.length;
  els.status.textContent = `${allItems.length} req${reportsLabel} · ${ec} time entr${ec === 1 ? 'y' : 'ies'}`;
}

// ---------- Header buttons ----------

els.refresh.addEventListener('click', () => { void refresh(); });

els.clear.addEventListener('click', async () => {
  if (!confirm('Delete all captured requests?')) return;
  await send('clear');
  await refresh();
});

els.dashClearCache.addEventListener('click', async () => {
  if (!confirm(
    'Delete every captured request and all aggregated time entries from this browser?\n\n' +
    'This only affects your local cache — your Personio data is untouched. ' +
    'Next sync will re-fetch from Personio.',
  )) return;
  await send('clear');
  await refresh();
  els.status.textContent = 'Cache cleared.';
});

els.dashDebug.addEventListener('click', () => {
  const log = buildDebugLog(state.allItems);
  const range = currentRange();
  const payload = {
    generatedAt: new Date().toISOString(),
    range,
    plannedSyncUrls: planSyncUrls(state.allItems, range.from, range.to),
    lastSync: { urls: state.lastSyncUrls, result: state.lastSyncResult },
    summary: {
      totalCaptures: state.allItems.length,
      timeRelatedCaptures: log.timeRelated,
      detectedTimeEntries: state.timeEntries.length,
    },
    diagnostics: diagnoseTimeEntries(state.allItems),
    overtimeDiagnostics: diagnoseOvertime(state.allItems),
    captures: log.entries,
  };
  download(JSON.stringify(payload, null, 2), `personio-debug-${stamp()}.json`, 'application/json');
});

// ---------- Wire dashboard + initial load ----------

const initialAuto = readPrefBool(STORAGE_KEYS.autoSync, true);
wireDashboard({
  autoSyncInitial: initialAuto,
  onAutoSyncChange: (checked) => writePrefBool(STORAGE_KEYS.autoSync, checked),
});
onSyncDoneRegister(() => { void refresh(); });
onRefreshStateRegister(() => refresh());

void (async () => {
  await loadDevTabsIfNeeded();
  await refresh();
  kickoffInitialAutoSync();
})();
