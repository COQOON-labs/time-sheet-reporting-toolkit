/**
 * Background service worker. Persists captured requests to IndexedDB
 * (via the shared storage helper) and responds to UI queries.
 */

import { putRequest, listRequests, clearAll, pruneOlderThan } from '../lib/storage.js';
import type { CapturedRequest, SyncResult, SyncRequest } from '../lib/types.js';

/** Captures older than this are deleted at startup. */
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

type Incoming =
  | { kind: 'capture'; payload: CapturedRequest }
  | { kind: 'list'; limit?: number }
  | { kind: 'clear' }
  | { kind: 'get-origin' }
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

/**
 * Resolve the (possibly bundler-rewritten) content-script file paths from
 * the runtime manifest, so chrome.scripting.executeScript injects exactly
 * what the regular auto-injection would have loaded.
 */
function contentScriptFiles(): string[] {
  const cs = chrome.runtime.getManifest().content_scripts ?? [];
  return cs.flatMap((s) => s.js ?? []);
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
      const files = contentScriptFiles();
      if (files.length === 0) throw new Error('manifest lists no content scripts');
      await chrome.scripting.executeScript({ target: { tabId }, files });
    } catch (injectErr) {
      throw new Error(
        `Could not reach Personio tab. Refresh the Personio page and try again. (${String(injectErr)})`,
      );
    }
    try {
      return await send();
    } catch (retryErr) {
      throw new Error(
        `Could not reach Personio tab after injecting helper. Refresh the Personio page and try again. (${String(retryErr)})`,
      );
    }
  }
}

chrome.runtime.onMessage.addListener((msg: Incoming, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.kind) {
        case 'capture':
          await putRequest(msg.payload);
          sendResponse({ ok: true });
          break;
        case 'list':
          sendResponse({ ok: true, items: await listRequests(msg.limit) });
          break;
        case 'clear':
          await clearAll();
          sendResponse({ ok: true });
          break;
        case 'get-origin':
          sendResponse({ ok: true, origin: await findPersonioOrigin() });
          break;
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
    console.info('[Reporting for Personio] installed');
  }
  void pruneOlderThan(Date.now() - RETENTION_MS);
});

chrome.runtime.onStartup.addListener(() => {
  void pruneOlderThan(Date.now() - RETENTION_MS);
});
