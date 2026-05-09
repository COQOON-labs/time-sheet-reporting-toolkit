/**
 * Background service worker. Persists captured requests to IndexedDB
 * (via the shared storage helper) and responds to UI queries.
 */

import { putRequest, listRequests, clearAll, pruneOlderThan } from '../lib/storage.js';
import type { CapturedRequest, SyncResult, SyncRequest } from '../lib/types.js';
import { TIMESHEET_URL_RE } from '../lib/constants.js';

/** Captures older than this are deleted at startup. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * chrome.storage.local key holding the identity hint. Survives clearAll()
 * (which only wipes IndexedDB) so the planner can still build seeded
 * timesheet probes immediately after the user empties the cache, instead
 * of producing an empty plan and forcing them to reload the page.
 */
const IDENTITY_KEY = 'a4p-identity';
type IdentityHint = { origin?: string | null; ownEmployeeId?: string | null };

type Incoming =
  | { kind: 'capture'; payload: CapturedRequest }
  | { kind: 'list'; limit?: number }
  | { kind: 'clear' }
  | { kind: 'get-origin' }
  | { kind: 'get-identity' }
  | { kind: 'active-sync'; urls: SyncRequest[] };

async function findPersonioTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({ url: ['*://*.personio.de/*', '*://*.personio.com/*'] });
  // Prefer the active tab if any; otherwise first match.
  return tabs.find((t) => t.active) ?? tabs[0] ?? null;
}

async function findPersonioOrigin(): Promise<string | null> {
  const tab = await findPersonioTab();
  if (!tab?.url) return null;
  try { return new URL(tab.url).origin; } catch { return null; }
}

async function readIdentityHint(): Promise<IdentityHint> {
  try {
    const r = await chrome.storage.local.get(IDENTITY_KEY);
    const v = r[IDENTITY_KEY] as IdentityHint | undefined;
    return v ?? {};
  } catch { return {}; }
}

async function writeIdentityHint(patch: IdentityHint): Promise<void> {
  try {
    const cur = await readIdentityHint();
    const next: IdentityHint = {
      origin: patch.origin ?? cur.origin ?? null,
      ownEmployeeId: patch.ownEmployeeId ?? cur.ownEmployeeId ?? null,
    };
    await chrome.storage.local.set({ [IDENTITY_KEY]: next });
  } catch { /* best-effort */ }
}

/**
 * Sniff a captured request for identity hints (origin + own employee id)
 * and persist them. Cheap — only string/regex matching on the URL plus a
 * shallow walk of /me-style response bodies.
 */
async function maybePersistIdentityHint(c: CapturedRequest): Promise<void> {
  const patch: IdentityHint = {};
  try {
    const u = new URL(c.url);
    if (/personio\.(de|com)$/.test(u.hostname)) patch.origin = u.origin;
    const m = TIMESHEET_URL_RE.exec(u.pathname);
    if (m) patch.ownEmployeeId = m[1] ?? null;
  } catch { /* ignore */ }
  if (!patch.ownEmployeeId && c.bodyJson && /\/my-organization\b|\/me\b|\/current[-_]?user\b/i.test(c.url)) {
    const id = findOwnIdInBody(c.bodyJson);
    if (id) patch.ownEmployeeId = id;
  }
  if (patch.origin || patch.ownEmployeeId) await writeIdentityHint(patch);
}

/** Recursively look for a numeric `employee.id` / `id` on a /me-style body. */
function findOwnIdInBody(v: unknown, depth = 0): string | null {
  if (depth > 6 || v == null) return null;
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = findOwnIdInBody(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  // Direct hit on common id fields.
  for (const k of ['employee_id', 'employeeId', 'person_id', 'personId']) {
    const id = normalizeId(o[k]);
    if (id) return id;
  }
  // Nested employee/person/me/user objects.
  for (const k of ['employee', 'person', 'me', 'user', 'current_user', 'currentUser', 'profile', 'data']) {
    if (o[k] && typeof o[k] === 'object') {
      const nested = o[k] as Record<string, unknown>;
      const id = normalizeId(nested.id ?? nested.employee_id ?? nested.employeeId);
      if (id) return id;
      const r = findOwnIdInBody(nested, depth + 1);
      if (r) return r;
    }
  }
  return null;
}

function normalizeId(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return String(v);
  if (typeof v === 'string' && /^\d{3,}$/.test(v)) return v;
  return null;
}

/**
 * Resolve content-script entries from the runtime manifest, grouped by
 * execution world so chrome.scripting.executeScript injects each into the
 * same world as the manifest auto-injection would have.
 */
function contentScriptEntries(): Array<{ files: string[]; world: chrome.scripting.ExecutionWorld }> {
  const cs = chrome.runtime.getManifest().content_scripts ?? [];
  const out: Array<{ files: string[]; world: chrome.scripting.ExecutionWorld }> = [];
  for (const s of cs) {
    const files = s.js ?? [];
    if (files.length === 0) continue;
    // chrome.types: `world` is "ISOLATED" | "MAIN" | undefined.
    const world = (s as { world?: chrome.scripting.ExecutionWorld }).world ?? 'ISOLATED';
    out.push({ files, world });
  }
  return out;
}

/**
 * Send the active-sync request to the Personio tab's content script. If the
 * content script isn't loaded yet (common after extension install/reload
 * against a tab that hasn't been refreshed), inject it on the fly via
 * chrome.scripting and retry once. Surfaces a friendly error if that still
 * fails — most often because the tab is on a non-matching subdomain.
 */
async function sendToContentScript(
  tab: chrome.tabs.Tab,
  urls: SyncRequest[],
): Promise<SyncResult> {
  const tabId = tab.id;
  if (tabId == null) throw new Error('Personio tab has no id.');
  const send = (): Promise<SyncResult> =>
    chrome.tabs.sendMessage<unknown, SyncResult>(tabId, { kind: 'cs-fetch', urls });
  try {
    return await send();
  } catch (err) {
    const msg = String(err);
    const noReceiver = /Receiving end does not exist|Could not establish connection/i.test(msg);
    if (!noReceiver) throw err;
    // Content script missing — try to inject and retry once.
    try {
      const entries = contentScriptEntries();
      if (entries.length === 0) throw new Error('manifest lists no content scripts');
      // Inject each manifest entry into its declared world. Failures of
      // individual entries (e.g. MAIN-world inject.ts on a hardened page)
      // shouldn't prevent the ISOLATED-world content.ts from registering
      // its message listener — gather but don't rethrow per-entry.
      const errors: string[] = [];
      for (const { files, world } of entries) {
        try {
          await chrome.scripting.executeScript({ target: { tabId }, files, world });
        } catch (e) {
          errors.push(`${world}: ${String(e)}`);
        }
      }
      if (errors.length === entries.length) {
        throw new Error(errors.join('; '));
      }
    } catch (injectErr) {
      throw new Error(
        `Could not reach Personio tab. Refresh the Personio page and try again. (${String(injectErr)})`,
      );
    }
    // The bundled content-script loader uses a dynamic import() to load
    // the real module — listener registration happens *after* injection
    // resolves. Poll-retry the message a few times before giving up.
    const RETRY_DELAYS_MS = [100, 250, 500, 1000];
    let retryErr: unknown = null;
    for (const delay of RETRY_DELAYS_MS) {
      await new Promise((r) => setTimeout(r, delay));
      try {
        return await send();
      } catch (e) {
        retryErr = e;
      }
    }
    throw new Error(
      `Could not reach Personio tab after injecting helper. Refresh the Personio page and try again. (${String(retryErr)})`,
    );
  }
}

chrome.runtime.onMessage.addListener((msg: Incoming, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.kind) {
        case 'capture':
          await putRequest(msg.payload);
          void maybePersistIdentityHint(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'list':
          sendResponse({ ok: true, items: await listRequests(msg.limit) });
          break;
        case 'clear':
          // Wipe IndexedDB but DON'T touch the identity hint — that's how
          // the planner can still seed timesheet probes immediately after
          // a cache clear, instead of returning an empty plan.
          await clearAll();
          sendResponse({ ok: true });
          break;
        case 'get-origin':
          sendResponse({ ok: true, origin: await findPersonioOrigin() });
          break;
        case 'get-identity': {
          const hint = await readIdentityHint();
          // Always prefer a fresh tab-derived origin (handles tenant switch
          // mid-session) but fall back to the persisted one.
          const origin = (await findPersonioOrigin()) ?? hint.origin ?? null;
          if (origin && origin !== hint.origin) await writeIdentityHint({ origin });
          sendResponse({ ok: true, origin, ownEmployeeId: hint.ownEmployeeId ?? null });
          break;
        }
        case 'active-sync': {
          const tab = await findPersonioTab();
          if (tab?.id == null) {
            sendResponse({ ok: false, error: 'No Personio tab open. Open Personio in a tab first.' });
            break;
          }
          const result = await sendToContentScript(tab, msg.urls);
          sendResponse({ ok: true, result });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  // Indicate async sendResponse.
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  if (import.meta.env.DEV) {
    console.info('[Time Sheet Reporting Toolkit] installed');
  }
  void pruneOlderThan(Date.now() - RETENTION_MS);
});

chrome.runtime.onStartup.addListener(() => {
  void pruneOlderThan(Date.now() - RETENTION_MS);
});
