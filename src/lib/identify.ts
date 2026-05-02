/**
 * Maps a captured URL to one of the coarse categories used by the
 * dev-only Raw-requests filter. Only categories that can actually be
 * produced by the inject allow-list (`STORE_PATH_RE`) are returned —
 * keeping this list tight makes the dropdown reflect reality.
 */
export function categorize(url: string): string {
  try {
    const p = new URL(url, location.href).pathname.toLowerCase();
    if (p.includes('attendance') || p.includes('timesheet')) return 'attendance';
    if (p.includes('graphql')) return 'graphql';
    if (p.includes('employee') || p.includes('person') || p.includes('people')) return 'directory';
    if (p.includes('navigation') || p.includes('organization')) return 'org';
    return 'other';
  } catch {
    return 'other';
  }
}

/**
 * Short, deterministic id derived from any input string.
 *
 * Used to assign stable ids to captured requests. Async because subtle.digest
 * is async; collisions are acceptable since we only use 8 hex bytes.
 */
export async function uid(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
