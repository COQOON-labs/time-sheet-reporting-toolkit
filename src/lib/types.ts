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
  /** Pretty-printed JSON body if response was JSON, else null. */
  bodyJson: unknown | null;
  /** Size of response body in bytes. */
  bytes: number;
};

export type WindowMessage = {
  source: typeof MSG_NAMESPACE;
  kind: 'capture';
  payload: CapturedRequest;
};

export type SyncRequest =
  | string
  | { url: string; method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> };

export type RuntimeMessage =
  | { kind: 'open-sidepanel' }
  | { kind: 'list'; limit?: number }
  | { kind: 'list-result'; items: CapturedRequest[] }
  | { kind: 'clear' }
  | { kind: 'export' }
  | { kind: 'export-result'; json: string }
  | { kind: 'active-sync'; urls: SyncRequest[] }
  | { kind: 'cs-fetch'; urls: SyncRequest[] };

export type SyncResult = {
  fetched: number;
  failed: number;
  errors: string[];
  /** Per-URL outcome for debugging which endpoints returned what. */
  details: Array<{ url: string; status: number; bytes: number; arrays: number; rows: number; ok: boolean }>;
};
