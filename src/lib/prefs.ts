/**
 * Thin wrapper around localStorage with a typed key registry. Centralizes
 * the keys so we can grep them in one place and avoid string drift.
 */

import { STORAGE_KEYS } from './constants.js';

type PrefKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];

function readPref(key: PrefKey): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writePref(key: PrefKey, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* quota / privacy mode */ }
}

export function readPrefBool(key: PrefKey, fallback = false): boolean {
  const v = readPref(key);
  if (v === null) return fallback;
  return v === '1';
}

export function writePrefBool(key: PrefKey, value: boolean): void {
  writePref(key, value ? '1' : '0');
}
