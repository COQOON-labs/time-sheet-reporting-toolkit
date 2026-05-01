/**
 * Best-effort categorization of a Personio request URL by pathname.
 * Used by inject (capture) + content (active-sync replay).
 */

export function categorize(url: string): string {
  try {
    const p = new URL(url, location.href).pathname.toLowerCase();
    if (p.includes('project-time') || p.includes('projecttime') || p.includes('project_time')) return 'project-time';
    if (p.includes('attendance')) return 'attendance';
    if (p.includes('absence') || p.includes('time-off') || p.includes('timeoff')) return 'absences';
    if (p.includes('payroll') || p.includes('payslip')) return 'payroll';
    if (p.includes('employee')) return 'employees';
    if (p.includes('graphql')) return 'graphql';
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
