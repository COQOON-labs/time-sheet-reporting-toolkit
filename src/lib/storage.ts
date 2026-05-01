import { openDB, type IDBPDatabase } from 'idb';
import type { CapturedRequest } from './types.js';
import { DB } from './constants.js';

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB.name, DB.version, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(DB.store)) {
          const s = d.createObjectStore(DB.store, { keyPath: 'id' });
          s.createIndex('capturedAt', 'capturedAt');
          s.createIndex('category', 'category');
        }
      },
    });
  }
  return dbPromise;
}

export async function putRequest(req: CapturedRequest): Promise<void> {
  const d = await db();
  await d.put(DB.store, req);
}

export async function listRequests(limit = 5000): Promise<CapturedRequest[]> {
  const d = await db();
  const tx = d.transaction(DB.store, 'readonly');
  const idx = tx.store.index('capturedAt');
  const out: CapturedRequest[] = [];
  let cursor = await idx.openCursor(null, 'prev');
  while (cursor && out.length < limit) {
    out.push(cursor.value as CapturedRequest);
    cursor = await cursor.continue();
  }
  return out;
}

export async function clearAll(): Promise<void> {
  const d = await db();
  await d.clear(DB.store);
}

export async function exportAll(): Promise<string> {
  const items = await listRequests(Number.MAX_SAFE_INTEGER);
  return JSON.stringify({ exportedAt: new Date().toISOString(), items }, null, 2);
}

/**
 * Drop captures older than `cutoffMs` (epoch ms). Returns the count of
 * rows removed. Cheap because the `capturedAt` index is range-scanned.
 */
export async function pruneOlderThan(cutoffMs: number): Promise<number> {
  const d = await db();
  const tx = d.transaction(DB.store, 'readwrite');
  const idx = tx.store.index('capturedAt');
  let removed = 0;
  let cursor = await idx.openCursor(IDBKeyRange.upperBound(cutoffMs, true));
  while (cursor) {
    await cursor.delete();
    removed += 1;
    cursor = await cursor.continue();
  }
  await tx.done;
  return removed;
}
