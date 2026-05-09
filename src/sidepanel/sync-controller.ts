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
  syncProgress: HTMLElement;
  syncProgressText: HTMLElement;
};

type SyncDeps = {
  els: SyncEls;
  getRange: () => DateRange;
};

let deps: SyncDeps | null = null;
let tickHandle: ReturnType<typeof setInterval> | null = null;
let retryHandle: ReturnType<typeof setTimeout> | null = null;
let progressListenerWired = false;
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
  wireProgressListener();
}

/**
 * Listen for `sync-progress` beacons broadcast by the content script as
 * each URL completes. Updates the dashboard progress bar non-blockingly.
 */
function wireProgressListener(): void {
  if (progressListenerWired) return;
  progressListenerWired = true;
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (
      !msg || typeof msg !== 'object' ||
      (msg as { kind?: unknown }).kind !== 'sync-progress'
    ) return;
    const { completed, total } = msg as { completed?: unknown; total?: unknown };
    if (typeof completed !== 'number' || typeof total !== 'number') return;
    if (!deps) return;
    showProgress(completed, total);
  });
}

function showProgress(completed: number, total: number): void {
  if (!deps) return;
  const { syncProgress, syncProgressText } = deps.els;
  syncProgress.hidden = false;
  syncProgress.classList.add('is-determinate');
  const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
  const bar = syncProgress.querySelector<HTMLElement>('.sync-progress__bar');
  if (bar) bar.style.width = `${pct}%`;
  syncProgressText.textContent = total > 0 ? `${completed}/${total}` : '';
}

function hideProgress(): void {
  if (!deps) return;
  const { syncProgress, syncProgressText } = deps.els;
  syncProgress.hidden = true;
  syncProgress.classList.remove('is-determinate');
  syncProgressText.textContent = '';
  const bar = syncProgress.querySelector<HTMLElement>('.sync-progress__bar');
  if (bar) bar.style.width = '';
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
  // Ask the background for both the open Personio tab's origin AND a
  // persisted identity hint (own employee id, sniffed from past captures
  // and stored in chrome.storage.local). The hint survives Clear-cache,
  // so the planner can keep building seeded probes even when IndexedDB
  // was just emptied — no need for the user to reload the Personio tab.
  let seedOrigin: string | null = null;
  let ownEmployeeIdHint: string | null = null;
  try {
    const r = await send('get-identity', {});
    seedOrigin = r.origin;
    ownEmployeeIdHint = r.ownEmployeeId;
  } catch {
    // Older background build — fall back to origin-only.
    try {
      const r = await send('get-origin', {});
      seedOrigin = (r as { origin?: string | null }).origin ?? null;
    } catch { /* history-only */ }
  }
  const urls = planSyncUrls(state.allItems, range.from, range.to, {
    seedOrigin,
    ownEmployeeIdHint,
  });
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
  // Show progress bar immediately. The content script will switch us into
  // determinate mode as soon as it starts emitting per-URL beacons.
  showProgress(0, urls.length);
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
    hideProgress();
  }
}
