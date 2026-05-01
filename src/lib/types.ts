/** Shared message + record types between page-context, content script, and UI. */

export const MSG_NAMESPACE = 'A4P';

export type CapturedRequest = {
  /** Stable unique id (sha-1 of url+timestamp) */
  id: string;
  url: string;
  method: string;
  status: number;
  capturedAt: number; // epoch ms
  /** Best-effort category derived from URL pathname. */
  category: string;
  /** Parsed JSON body if response was JSON, else null. */
  bodyJson: unknown;
  /** UTF-8 byte size of response body. */
  bytes: number;
};

export type WindowMessage = {
  source: typeof MSG_NAMESPACE;
  kind: 'capture';
  payload: CapturedRequest;
};

/**
 * Replay-fetch instruction sent from the sidepanel to the content script.
 * Always normalized to an object — string-only entries from older callers
 * should be wrapped via `toSyncRequest()`.
 */
export type SyncRequest = {
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
};

export function toSyncRequest(v: string | SyncRequest): SyncRequest {
  return typeof v === 'string' ? { url: v, method: 'GET' } : v;
}

export type SyncResult = {
  fetched: number;
  failed: number;
  errors: string[];
  /** Per-URL outcome for debugging which endpoints returned what. */
  details: Array<{ url: string; status: number; bytes: number; arrays: number; rows: number; ok: boolean }>;
};
