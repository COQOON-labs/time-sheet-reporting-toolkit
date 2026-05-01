/**
 * Sync controller — owns the active-sync lifecycle (manual + auto).
 * Extracted from dashboard.ts to keep the dashboard module focused on
 * filters/charts/tables.
 */

import { planSyncUrls, type DateRange } from '../lib/attendance.js';
import { state, setState } from './state.js';
import { send } from './messaging.js';

const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const TICK_MS = 30_000;

type SyncEls = {
  dashSync: HTMLButtonElement;
  dashAutoSync: HTMLInputElement;
  syncStatus: HTMLElement;
};

type SyncDeps = {
  els: SyncEls;
  getRange: () => DateRange;
};

let deps: SyncDeps | null = null;
let tickHandle: ReturnType<typeof setInterval> | null = null;
let syncDoneHandler: () => void = () => void 0;

export function wireSync(d: SyncDeps): void {
  deps = d;
  d.els.dashSync.addEventListener('click', () => { void runSync(); });
  d.els.dashAutoSync.addEventListener('change', () => {
    if (d.els.dashAutoSync.checked) void runSync({ silent: true });
  });
  if (tickHandle === null) {
    tickHandle = setInterval(() => maybeAutoSync(false), TICK_MS);
  }
}

export function onSyncDoneRegister(fn: () => void): void {
  syncDoneHandler = fn;
}

/** Run sync now if auto-sync is on and (force or interval elapsed). */
export function maybeAutoSync(force = false): void {
  if (!deps) return;
  if (!deps.els.dashAutoSync.checked) return;
  if (!force && Date.now() - state.lastAutoSyncAt < AUTO_SYNC_INTERVAL_MS) return;
  void runSync({ silent: true });
}

export async function runSync(opts: { silent?: boolean } = {}): Promise<void> {
  if (!deps) return;
  if (state.syncInFlight) return;
  const { els, getRange } = deps;
  const range = getRange();
  const urls = planSyncUrls(state.allItems, range.from, range.to);
  if (urls.length === 0) {
    if (!opts.silent) {
      els.syncStatus.textContent =
        'No time-tracking endpoints learned yet. Open Personio\'s Attendance or Project-Time page once so the extension can discover the URLs, then click Sync again.';
      els.syncStatus.style.color = 'var(--amber)';
    }
    return;
  }
  setState({ syncInFlight: true, lastSyncUrls: urls });
  els.dashSync.disabled = true;
  els.syncStatus.style.color = '';
  els.syncStatus.textContent =
    `${opts.silent ? 'Auto-syncing' : 'Syncing'} ${urls.length} request(s) for ${range.from} → ${range.to}…`;
  try {
    const res = await send('active-sync', { urls });
    const r = res.result;
    setState({ lastSyncResult: r, lastAutoSyncAt: Date.now() });
    els.syncStatus.style.color = r.failed > 0 ? 'var(--amber)' : 'var(--green)';
    els.syncStatus.textContent =
      `Sync done: ${r.fetched} ok, ${r.failed} failed` +
      (r.errors.length ? ` — first error: ${r.errors[0]}` : '');
    syncDoneHandler();
  } catch (err) {
    els.syncStatus.style.color = 'var(--red)';
    els.syncStatus.textContent = `Sync failed: ${String(err)}`;
  } finally {
    setState({ syncInFlight: false });
    els.dashSync.disabled = false;
  }
}
