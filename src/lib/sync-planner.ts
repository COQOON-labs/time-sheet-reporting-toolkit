/**
 * Active-sync URL planner: given previously captured requests, build a list
 * of URLs to refetch with the page's cookies so we have data for a date
 * range that wasn't necessarily browsed.
 *
 * Permission model: Personio's /timesheet/{id} only returns 200 when you
 * are either (a) that person yourself or (b) their supervisor. We try to
 * be smart upfront so we don't spam 403s.
 */

import type { CapturedRequest, SyncRequest } from './types.js';
import { isPlainObject, walkObjects } from './walk.js';
import { monthWindows } from './parse.js';

const TIME_PATH_HINTS = /attendance|project-?time|time-?tracking|working-?time|\bdays\b|time-?entries|project_times|attendances|timesheet|timecard/i;
const TIME_PATH_EXCLUDE = /kiosk|terminal|stamp-?in|stamp-?out|live|status|setting|config|policy|policies|template|approval-rule|notification|kiosk-service|widget|is-eligible|csat|\/lang\/|\.json$|validate|calculate|propose|reject|approve|create|update|delete/i;
const DATE_PARAM_KEYS = ['start_date', 'startDate', 'from', 'start', 'date_from', 'dateFrom', 'begin', 'period_start'];
const END_PARAM_KEYS = ['end_date', 'endDate', 'to', 'end', 'date_to', 'dateTo', 'finish', 'period_end'];

/** TIME_PATH_HINTS exposed for diagnostics module. */
export { TIME_PATH_HINTS };

export function planSyncUrls(
  items: CapturedRequest[],
  from: string,
  to: string,
): SyncRequest[] {
  const months = monthWindows(from, to);
  const uniq = new Set<string>();
  const out: SyncRequest[] = [];

  const templates = new Set<string>();
  let origin: string | null = null;
  let employeeId: string | null = null;
  for (const it of items) {
    try {
      const u = new URL(it.url);
      if (!origin && /personio\.(de|com)$/.test(u.hostname) && u.pathname.startsWith('/svc/')) {
        origin = u.origin;
      }
      if (!employeeId) {
        const m = u.pathname.match(/\/timesheet\/(\d+)/);
        if (m) employeeId = m[1]!;
      }
      if (!TIME_PATH_HINTS.test(u.pathname)) continue;
      if (TIME_PATH_EXCLUDE.test(u.pathname)) continue;
      // Only replay the rich /timesheet/{id} endpoint.
      if (!/\/timesheet\/\d{3,}/.test(u.pathname)) continue;
      if (it.method && it.method !== 'GET') continue;
      if (it.status >= 400 && it.status < 500) continue;
      ['page', 'cursor', 'limit', 'offset', 'per_page', 'pageSize'].forEach((k) => u.searchParams.delete(k));
      templates.add(u.toString());
    } catch { /* ignore */ }
  }

  function addUrl(s: string): void {
    if (uniq.has(s)) return;
    uniq.add(s); out.push(s);
  }

  for (const tpl of templates) {
    const u = new URL(tpl);
    const dateKey = DATE_PARAM_KEYS.find((k) => u.searchParams.has(k));
    const endKey = END_PARAM_KEYS.find((k) => u.searchParams.has(k));

    if (dateKey && endKey && months.length > 0) {
      for (const w of months) {
        const u2 = new URL(tpl);
        u2.searchParams.set(dateKey, w.start);
        u2.searchParams.set(endKey, w.end);
        addUrl(u2.toString());
      }
    } else if (dateKey && months.length > 0) {
      for (const w of months) {
        const u2 = new URL(tpl);
        u2.searchParams.set(dateKey, w.start);
        addUrl(u2.toString());
      }
    } else {
      addUrl(tpl);
    }
  }

  // Probes for project metadata + permission discovery.
  if (origin) {
    const dead = new Set<string>();
    for (const it of items) {
      if (it.status >= 400 && it.status < 500) dead.add(it.url.split('?')[0]!);
    }

    if (employeeId) {
      const gqlUrl = `${origin}/graphql?op=TM_TrackableProjects_v2025091101`;
      out.push({
        url: gqlUrl,
        method: 'POST',
        body: {
          operationName: 'TM_TrackableProjects_v2025091101',
          query: 'TM_TrackableProjects_v2025091101',
          variables: { personId: { id: employeeId } },
        },
      });
    }

    const probes = [
      `${origin}/svc/attendance-bff/projects`,
      `${origin}/svc/attendance-bff/v1/projects`,
      `${origin}/svc/attendance-api/v1/projects`,
    ];
    for (const p of probes) {
      if (!dead.has(p.split('?')[0]!)) addUrl(p);
    }

    const peopleListUrl = `${origin}/people-list/bff/data`;
    if (!dead.has(peopleListUrl)) {
      out.push({
        url: peopleListUrl,
        method: 'POST',
        body: { filters: {}, page: 0, pageSize: 1000 },
      });
    }

    const orgUrl = `${origin}/platform/dashboard/api/v1/my-organization`;
    if (!dead.has(orgUrl)) addUrl(orgUrl);
  }

  // Fan out timesheet templates over every known employee id.
  const forbidden = new Set<string>();
  for (const it of items) {
    if (it.status !== 403) continue;
    const m = /\/timesheet\/(\d+)/.exec(it.url);
    if (m) forbidden.add(m[1]!);
  }
  const allowed = collectAllowedEmployeeIds(items);
  const candidatePool = allowed.size > 0 ? allowed : collectEmployeeIds(items);
  if (employeeId) candidatePool.add(employeeId);
  const knownEmployees = new Set(
    Array.from(candidatePool).filter((id) => !forbidden.has(id)),
  );
  if (knownEmployees.size > 0 && months.length > 0) {
    const expanded: SyncRequest[] = [];
    for (const item of out) {
      if (typeof item !== 'string') { expanded.push(item); continue; }
      const m = /\/timesheet\/(\d+)/.exec(item);
      if (!m) { expanded.push(item); continue; }
      for (const empId of knownEmployees) {
        expanded.push(item.replace(`/timesheet/${m[1]}`, `/timesheet/${empId}`));
      }
    }
    return Array.from(new Set(
      expanded.map((x) => typeof x === 'string' ? x : JSON.stringify(x))
    )).map((s) => {
      try { return JSON.parse(s) as SyncRequest; } catch { return s; }
    });
  }

  return out;
}

/** Employee ids the current user is *allowed* to view (200 timesheet OR direct_report). */
function collectAllowedEmployeeIds(items: CapturedRequest[]): Set<string> {
  const ids = new Set<string>();
  for (const it of items) {
    if (it.status === 200) {
      const m = /\/timesheet\/(\d+)/.exec(it.url);
      if (m) ids.add(m[1]!);
    }
    if (!it.bodyJson) continue;
    if (/\/my-organization\b|\/organization\/me\b|\/manager\/reports\b|direct[-_]?reports/i.test(it.url)) {
      walkObjects(it.bodyJson, (o) => recordDirectReports(o, ids));
    }
  }
  return ids;
}

function recordDirectReports(o: Record<string, unknown>, ids: Set<string>): void {
  for (const k of ['direct_reports', 'directReports', 'reports', 'subordinates']) {
    const arr = o[k];
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (!isPlainObject(r)) continue;
      const id = r.id ?? r.employee_id ?? r.person_id;
      if (typeof id === 'string' || typeof id === 'number') ids.add(String(id));
    }
  }
}

/** All employee/person ids visible to the current user (broader fallback). */
function collectEmployeeIds(items: CapturedRequest[]): Set<string> {
  const ids = new Set<string>();
  for (const it of items) {
    // Many endpoints leak the full visible-employee list right in the URL.
    try {
      const u = new URL(it.url);
      for (const key of ['employee_ids', 'employeeIds', 'person_ids', 'personIds', 'ids']) {
        const v = u.searchParams.get(key);
        if (!v) continue;
        for (const id of v.split(',')) {
          const t = id.trim();
          if (/^\d{3,}$/.test(t)) ids.add(t);
        }
      }
    } catch { /* ignore */ }

    if (!it.bodyJson) continue;
    if (!/employee|person|people|directory|non-working|people-list|orgunit|org-units|orgchart|teamcalendar|team-calendar/i.test(it.url)) continue;
    walkObjects(it.bodyJson, (o) => recordEmployeeIds(o, ids));
  }
  return ids;
}

function recordEmployeeIds(o: Record<string, unknown>, ids: Set<string>): void {
  if (o.type === 'employees' || o.type === 'employee' || o.type === 'person') {
    if (typeof o.id === 'string' || typeof o.id === 'number') ids.add(String(o.id));
  }
  for (const k of ['employee_id', 'employeeId', 'person_id', 'personId']) {
    const val = o[k];
    if (typeof val === 'string' || typeof val === 'number') ids.add(String(val));
    if (isPlainObject(val) && (typeof val.id === 'string' || typeof val.id === 'number')) {
      ids.add(String(val.id));
    }
  }
}
