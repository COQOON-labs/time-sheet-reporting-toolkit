/**
 * Content script — runs in the isolated world. Its jobs:
 *  1. Listen for postMessage events from the MAIN-world interceptor
 *     (registered separately via manifest `world: "MAIN"`) and forward
 *     them to the background service worker for storage.
 *  2. Mount the floating "📊 Reporting" launcher button + sidepanel iframe.
 */

import { MSG_NAMESPACE, type WindowMessage, type SyncResult, type CapturedRequest, type SyncRequest, toSyncRequest } from '../lib/types.js';
import { categorize, uid } from '../lib/identify.js';
import { utf8Bytes } from '../lib/format.js';
import { STORAGE_KEYS } from '../lib/constants.js';

// ---------- 1. Bridge postMessage -> background ----------
window.addEventListener('message', (event: MessageEvent<WindowMessage>) => {
  // Same-origin only — defense in depth against rogue iframes posting fake captures.
  if (event.source !== window) return;
  if (event.origin !== location.origin) return;
  const data = event.data;
  if (!data || data.source !== MSG_NAMESPACE || data.kind !== 'capture') return;
  chrome.runtime.sendMessage({ kind: 'capture', payload: data.payload }).catch(() => {
    // Service worker may be asleep; retry once.
    setTimeout(() => {
      chrome.runtime.sendMessage({ kind: 'capture', payload: data.payload }).catch(() => void 0);
    }, 250);
  });
});

// ---------- 1b. Active sync: fetch URLs with the page's session cookies ----------
chrome.runtime.onMessage.addListener((msg: { kind: string; urls?: SyncRequest[] }, _sender, sendResponse) => {
  if (msg.kind !== 'cs-fetch' || !Array.isArray(msg.urls)) return false;
  const urls = msg.urls;
  void (async () => {
    const result: SyncResult = { fetched: 0, failed: 0, errors: [], details: [] };
    // Run sequentially to avoid overwhelming the server / triggering rate limits.
    for (const item of urls) {
      const raw = toSyncRequest(item);
      const req = { ...raw, method: raw.method ?? ('GET' as const) };
      const url = req.url;
      try {
        const headers: Record<string, string> = {
          accept: 'application/json, */*',
          ...(req.headers ?? {}),
        };
        // Personio's Athena routes require the XSRF token from the cookie
        // for any state-changing or authenticated call (incl. /search GETs).
        if (!headers['x-athena-xsrf-token']) {
          const m = document.cookie.match(/(?:^|;\s*)ATHENA-XSRF-TOKEN=([^;]+)/);
          if (m) headers['x-athena-xsrf-token'] = decodeURIComponent(m[1]!);
        }
        let body: BodyInit | undefined;
        if (req.method === 'POST' && req.body !== undefined) {
          headers['content-type'] = headers['content-type'] ?? 'application/json';
          body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        }
        const res = await fetch(url, {
          method: req.method,
          credentials: 'include',
          cache: 'no-store',
          headers,
          body,
        });
        const text = await res.text();
        const bytes = utf8Bytes(text);
        let bodyJson: unknown = null;
        try { bodyJson = JSON.parse(text); } catch { /* not JSON */ }
        const id = await uid(`SYNC ${req.method} ${url} ${Date.now()}`);
        const captured: CapturedRequest = {
          id,
          url,
          method: req.method,
          status: res.status,
          capturedAt: Date.now(),
          category: categorize(url),
          bodyJson,
          bytes,
        };
        await chrome.runtime.sendMessage({ kind: 'capture', payload: captured });

        // Quick measure: how many JSON arrays + total rows came back
        let arrays = 0, rows = 0;
        const stack: unknown[] = [bodyJson];
        let depth = 0;
        while (stack.length && depth < 200) {
          const v = stack.pop();
          depth++;
          if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
            arrays++;
            rows += v.length;
          } else if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) stack.push((v as Record<string, unknown>)[k]);
          }
        }
        const ok = res.ok && bodyJson != null;
        result.details.push({ url, status: res.status, bytes, arrays, rows, ok, probe: req.probe });
        if (ok) result.fetched += 1;
        else if (req.probe) {
          // Probes are expected to fail for routes that don't exist on this
          // tenant — don't surface them as user-visible errors.
        } else {
          result.failed += 1; result.errors.push(`${res.status} ${url}`);
        }
      } catch (err) {
        if (req.probe) {
          result.details.push({ url, status: 0, bytes: 0, arrays: 0, rows: 0, ok: false, probe: true });
        } else {
          result.failed += 1;
          result.errors.push(`${String(err)} ${url}`);
          result.details.push({ url, status: 0, bytes: 0, arrays: 0, rows: 0, ok: false });
        }
      }
    }
    sendResponse(result);
  })();
  return true; // async sendResponse
});

// ---------- 2. Launcher + sidepanel ----------
const HOST_ID = 'a4p-host';
let panelOpen = false;

function mountLauncher(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.all = 'initial';
  document.documentElement.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    .btn {
      position: fixed; right: 18px; bottom: 18px; z-index: 2147483647;
      background: #7c3aed; color: #fff; border: none; border-radius: 999px;
      padding: 12px 18px; font: 600 13px/1 system-ui, sans-serif;
      cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.18);
      display: flex; align-items: center; gap: 8px;
    }
    .btn:hover { background: #6d28d9; }
    .wrap {
      position: fixed; top: 0; right: 0; height: 100vh; z-index: 2147483646;
      width: 980px; max-width: 100vw; min-width: 380px;
      transform: translateX(100%); transition: transform .25s ease;
      display: flex;
    }
    .wrap.open { transform: translateX(0); }
    .grip {
      width: 6px; cursor: ew-resize; background: transparent;
      border-left: 1px solid rgba(0,0,0,.08);
    }
    .grip:hover, .grip.dragging { background: rgba(124,58,237,.25); }
    .panel {
      flex: 1; height: 100%; border: none; background: #fff;
      box-shadow: -8px 0 32px rgba(0,0,0,.2);
    }
  `;

  const btn = document.createElement('button');
  btn.className = 'btn';
  btn.textContent = '📊 Reporting';

  const wrap = document.createElement('div');
  wrap.className = 'wrap';

  const grip = document.createElement('div');
  grip.className = 'grip';
  grip.title = 'Drag to resize';

  const iframe = document.createElement('iframe');
  iframe.className = 'panel';
  iframe.src = chrome.runtime.getURL('src/sidepanel/sidepanel.html');

  wrap.append(grip, iframe);

  // Restore last width
  const stored = Number(localStorage.getItem(STORAGE_KEYS.panelWidth));
  if (stored && stored > 380) wrap.style.width = `${stored}px`;

  // Drag-to-resize
  let dragging = false;
  function stopDrag(): void {
    if (!dragging) return;
    dragging = false;
    grip.classList.remove('dragging');
    iframe.style.pointerEvents = '';
    document.body.style.userSelect = '';
    const w = parseInt(wrap.style.width, 10);
    if (Number.isFinite(w)) localStorage.setItem(STORAGE_KEYS.panelWidth, String(w));
  }
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    grip.classList.add('dragging');
    // Block iframe from swallowing pointer events while dragging.
    iframe.style.pointerEvents = 'none';
    document.body.style.userSelect = 'none';
    try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // If the primary button was released somewhere we couldn't observe,
    // bail out instead of resizing forever.
    if ((e.buttons & 1) === 0) { stopDrag(); return; }
    const w = Math.min(Math.max(window.innerWidth - e.clientX, 380), window.innerWidth - 40);
    wrap.style.width = `${w}px`;
  });
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
  window.addEventListener('blur', stopDrag);

  btn.addEventListener('click', () => {
    panelOpen = !panelOpen;
    wrap.classList.toggle('open', panelOpen);
  });

  root.append(style, btn, wrap);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountLauncher, { once: true });
} else {
  mountLauncher();
}
