/**
 * Tiny typed wrapper around chrome.runtime.sendMessage. Replaces the
 * untyped `send<T>(msg)` that previously lived inline in sidepanel.ts.
 *
 * Each entry in `RequestMap` defines the kind, request payload, and
 * response payload — making it impossible to call with a wrong kind or
 * misshapen payload. The Envelope (`{ ok, error, ... }`) is consumed
 * inside `send()` so callers only ever see the strict `res` shape.
 */

import type { CapturedRequest, SyncRequest, SyncResult } from '../lib/types.js';

type RequestMap = {
  list: { req: { limit?: number }; res: { items: CapturedRequest[] } };
  clear: { req: Record<string, never>; res: Record<string, never> };
  export: { req: Record<string, never>; res: { json: string } };
  'active-sync': { req: { urls: SyncRequest[] }; res: { result: SyncResult } };
};

type Kind = keyof RequestMap;
type Envelope<K extends Kind> =
  | ({ ok: true } & RequestMap[K]['res'])
  | { ok: false; error: string };

export function send<K extends Kind>(
  kind: K,
  req: RequestMap[K]['req'] = {} as RequestMap[K]['req'],
): Promise<RequestMap[K]['res']> {
  const msg = { kind, ...req };
  return new Promise<RequestMap[K]['res']>((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response: Envelope<K>) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
      if (!response) return reject(new Error('No response from background'));
      if (response.ok === false) return reject(new Error(response.error));
      // Strip `ok` before handing back, so callers can't depend on it.
      const { ok: _ok, ...rest } = response;
      void _ok;
      resolve(rest as unknown as RequestMap[K]['res']);
    });
  });
}

