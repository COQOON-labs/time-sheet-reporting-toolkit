/**
 * Page-context interceptor. Runs in the page's MAIN world (not the
 * isolated content-script world) so it can wrap window.fetch and
 * XMLHttpRequest. Captured responses are forwarded to the content
 * script via window.postMessage.
 */

import { MSG_NAMESPACE, type CapturedRequest, type WindowMessage } from '../lib/types.js';
import { categorize, uid } from '../lib/identify.js';

declare global {
  interface Window {
    __A4P_INSTALLED__?: boolean;
  }
  interface XMLHttpRequest {
    __a4p_url?: string;
    __a4p_method?: string;
  }
}

(() => {
  if (window.__A4P_INSTALLED__) return;
  window.__A4P_INSTALLED__ = true;

  function isInteresting(url: string): boolean {
    try {
      const u = new URL(url, location.href);
      // Capture all JSON-ish traffic on Personio domains; skip static assets
      // and noisy 3rd-party tracking proxied through the same origin.
      if (!/personio\.(de|com)$/.test(u.hostname)) return false;
      if (/\.(js|css|png|jpg|jpeg|svg|gif|woff2?|ico|map|webp|avif)(\?|$)/i.test(u.pathname)) return false;
      // Drop obvious analytics/feature-flag noise — they're never reports.
      if (/gs-amplitude|amplitude|datadog|sentry|launchdarkly|optimizely|segment\.io/i.test(u.pathname)) return false;
      if (/\/mySegments\//i.test(u.pathname)) return false; // split.io feature flags
      return true;
    } catch {
      return false;
    }
  }

  function emit(req: CapturedRequest): void {
    const msg: WindowMessage = { source: MSG_NAMESPACE, kind: 'capture', payload: req };
    window.postMessage(msg, location.origin);
  }

  async function tryParseJson(text: string): Promise<unknown | null> {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Paths whose responses are worth persisting in IndexedDB. Tight allow-list
  // matching exactly what the dashboard actually consumes:
  //   /timesheet/{id}            → time entries + overtime
  //   /navigation/context        → current-user (own employee) discovery
  //   /my-organization           → manager direct_reports for permission detection
  //   /people-list/...           → name lookup for employee IDs
  //   /graphql                   → TM_TrackableProjects_v… (project name index)
  //   /employees|/persons        → JSON:API people directories (employee names)
  const STORE_PATH_RE = /\/timesheet\/|navigation\/context|my-organization|people-list|graphql|\/employees(\/|$|\?)|\/persons(\/|$|\?)/i;

  function shouldStore(url: string): boolean {
    try { return STORE_PATH_RE.test(new URL(url, location.href).pathname); }
    catch { return false; }
  }

  // ---- fetch hook ----
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const res = await origFetch(input as RequestInfo, init);
    if (!isInteresting(url)) return res;

    // Clone and parse asynchronously without blocking the caller.
    const cloned = res.clone();
    cloned
      .text()
      .then(async (text) => {
        if (!shouldStore(url)) return;
        const json = await tryParseJson(text);
        const id = await uid(`${method} ${url} ${Date.now()}`);
        emit({
          id,
          url,
          method,
          status: res.status,
          capturedAt: Date.now(),
          category: categorize(url),
          bodyJson: json,
          bytes: text.length,
        });
      })
      .catch(() => void 0);

    return res;
  };

  // ---- XHR hook ----
  const OrigXHR = window.XMLHttpRequest;

  const origOpen = OrigXHR.prototype.open;
  OrigXHR.prototype.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    this.__a4p_method = method.toUpperCase();
    this.__a4p_url = typeof url === 'string' ? url : url.toString();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origOpen as any).call(this, method, url, ...rest);
  };

  const origSend = OrigXHR.prototype.send;
  OrigXHR.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    this.addEventListener('loadend', async () => {
      const url = this.__a4p_url ?? '';
      if (!isInteresting(url)) return;
      if (!shouldStore(url)) return;
      let text = '';
      try {
        text = typeof this.responseText === 'string' ? this.responseText : '';
      } catch {
        // responseType !== '' or 'text' — skip body
      }
      const json = await tryParseJson(text);
      const id = await uid(`${this.__a4p_method} ${url} ${Date.now()}`);
      emit({
        id,
        url,
        method: this.__a4p_method ?? 'GET',
        status: this.status,
        capturedAt: Date.now(),
        category: categorize(url),
        bodyJson: json,
        bytes: text.length,
      });
    });
    return origSend.call(this, body);
  };

  // Console marker so users can verify activation in DevTools (DEV builds only).
  if (import.meta.env.DEV) {
    console.info('%c[Reporting for Personio] interceptor installed', 'color:#7c3aed;font-weight:bold');
  }

  // ---- bootstrap scanner ----
  // Personio bootstraps some data (incl. the project list) at page load,
  // before the SPA fires any XHR. Scan the DOM and `window` after load for
  // arrays of `{ id, name }` objects so we can resolve project ids → names
  // even without an observable network request.
  function scanBootstrap(): void {
    if (!/personio\.(de|com)$/.test(location.hostname)) return;
    const found: Array<{ where: string; data: unknown }> = [];
    const HINT = /project|employee|person|people|trackable/i;

    // 1) Inline <script> tags that look like JSON or assignments.
    for (const s of Array.from(document.scripts)) {
      const t = s.textContent;
      if (!t || t.length < 50 || t.length > 2_000_000) continue;
      if (!HINT.test(t)) continue;
      const blocks = t.match(/[\[{][\s\S]{200,200000}?[}\]]/g);
      if (!blocks) continue;
      for (const b of blocks) {
        if (!HINT.test(b)) continue;
        try {
          const parsed = JSON.parse(b);
          found.push({ where: `inline-script[${s.src || 'embedded'}]`, data: parsed });
        } catch { /* ignore */ }
      }
    }

    // 2) Walk window for arrays whose objects look like { id, name } or
    //    { id, first_name, last_name } and whose nearby keys mention
    //    project / employee / person.
    const seen = new WeakSet<object>();
    function visit(v: unknown, path: string, depth: number): void {
      if (depth > 6 || v == null) return;
      if (typeof v !== 'object') return;
      if (seen.has(v as object)) return;
      seen.add(v as object);
      if (Array.isArray(v)) {
        if (v.length > 0 && v.length < 10000) {
          const sample = v.slice(0, 5);
          const isIdName = sample.every((x) => x && typeof x === 'object'
            && 'id' in (x as object)
            && ('name' in (x as object)
              || 'first_name' in (x as object)
              || 'firstName' in (x as object)
              || 'display_name' in (x as object)
              || 'displayName' in (x as object)));
          if (isIdName && HINT.test(path)) {
            found.push({ where: `window.${path}`, data: v });
          }
        }
        if (v.length < 500) for (let i = 0; i < v.length; i++) visit(v[i], `${path}[${i}]`, depth + 1);
        return;
      }
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o);
      if (keys.length > 200) return;
      for (const k of keys) {
        if (/^_/.test(k)) continue;
        try { visit(o[k], path ? `${path}.${k}` : k, depth + 1); } catch { /* getter that throws */ }
      }
    }
    try { visit(window as unknown as Record<string, unknown>, '', 0); } catch { /* ignore */ }

    if (found.length === 0) return;
    void uid(`bootstrap ${location.href} ${Date.now()}`).then((id) => {
      emit({
        id,
        url: `${location.origin}/__bootstrap__/index`,
        method: 'GET',
        status: 200,
        capturedAt: Date.now(),
        category: 'project-time',
        bodyJson: { bootstrapHits: found },
        bytes: 0,
      });
    });
  }

  if (document.readyState === 'complete') {
    setTimeout(scanBootstrap, 1500);
  } else {
    window.addEventListener('load', () => setTimeout(scanBootstrap, 1500), { once: true });
  }
})();
