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

async function findPersonioTabId(): Promise<number | null> {
  return (await findPersonioTab())?.id ?? null;
}

async function findPersonioOrigin(): Promise<string | null> {
  const tab = await findPersonioTab();
  if (!tab?.url) return null;
  try { return new URL(tab.url).origin; } catch { return null; }
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
          const tabId = await findPersonioTabId();
          if (tabId == null) {
            sendResponse({ ok: false, error: 'No Personio tab open. Open Personio in a tab first.' });
            break;
          }
          const result = await chrome.tabs.sendMessage<unknown, SyncResult>(
            tabId,
            { kind: 'cs-fetch', urls: msg.urls },
          );
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
