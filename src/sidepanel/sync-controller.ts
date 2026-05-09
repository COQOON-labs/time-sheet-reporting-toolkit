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
let retryHandle: ReturnType<typeof setTimeout> | null = null;
let syncDoneHandler: () => void = () => void 0;
let refreshStateHandler: () => Promise<void> = async () => void 0;

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

/** Called by the retry path to pull freshly-captured requests into state
 *  before we re-plan sync URLs. */
export function onRefreshStateRegister(fn: () => Promise<void>): void {
  refreshStateHandler = fn;
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
  // Ask the background for the open Personio tab's origin so we can plan
  // probe URLs even on the very first sync — before any passive captures
  // have landed in IndexedDB.
  let seedOrigin: string | null = null;
  try {
    const r = await send('get-origin', {});
    seedOrigin = (r as { origin?: string | null }).origin ?? null;
  } catch { /* old background, no get-origin handler — fall back to history-only */ }
  const urls = planSyncUrls(state.allItems, range.from, range.to, { seedOrigin });
  if (urls.length === 0) {
    if (!opts.silent) {
      els.syncStatus.textContent =
        'Waiting for Personio data… open or reload the Attendance / Project-Time page in another tab so the extension can learn the endpoints, then click Sync again.';
      els.syncStatus.style.color = 'var(--amber)';
    }
    // Keep retrying silently every few seconds so the user usually does
    // not have to click Sync again after the page finishes loading.
    if (!retryHandle) {
      retryHandle = setTimeout(() => {
        retryHandle = null;
        if (!deps) return;
        // Pull any captures that arrived in the meantime, then re-plan.
        void refreshStateHandler().then(() => {
          if (!deps) return;
          if (deps.els.dashAutoSync.checked) void runSync({ silent: true });
        });
      }, 4_000);
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
    // Probe outcomes are tracked in details[].probe but not in r.failed.
    const probeMisses = r.details.filter((d) => d.probe && !d.ok).length;
    const learned = r.details.filter((d) => d.probe && d.ok).length;
    const notes: string[] = [];
    if (learned > 0) notes.push(`learned ${learned} new endpoint${learned === 1 ? '' : 's'}`);
    if (probeMisses > 0) notes.push(`${probeMisses} optional probe${probeMisses === 1 ? '' : 's'} skipped`);
    const noteSuffix = notes.length ? ` (· ${notes.join(', ')})` : '';
    els.syncStatus.style.color = r.failed > 0 ? 'var(--amber)' : 'var(--green)';
    els.syncStatus.textContent =
      `Sync done: ${r.fetched} ok, ${r.failed} failed${noteSuffix}` +
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
