/**
 * Active-sync URL planner: given previously captured requests, build a list
 * of URLs to refetch with the page's cookies so we have data for a date
 * range that wasn't necessarily browsed.
 *
 * Permission model: Personio's /timesheet/{id} only returns 200 when you
 * are either (a) that person yourself or (b) their supervisor. We try to
 * be smart upfront so we don't spam 403s.
 *
 * Outputs are always normalized `SyncRequest` objects (never raw strings).
 */

import type { CapturedRequest, SyncRequest } from './types.js';
import { isPlainObject, walkObjects } from './walk.js';
import { monthWindows } from './parse.js';
import { TIMESHEET_URL_RE } from './constants.js';

const TIME_PATH_HINTS = /attendance|project-?time|time-?tracking|working-?time|\bdays\b|time-?entries|project_times|attendances|timesheet|timecard/i;
const TIME_PATH_EXCLUDE = /kiosk|terminal|stamp-?in|stamp-?out|live|status|setting|config|policy|policies|template|approval-rule|notification|kiosk-service|widget|is-eligible|csat|\/lang\/|\.json$|validate|calculate|propose|reject|approve|create|update|delete/i;
const DATE_PARAM_KEYS = ['start_date', 'startDate', 'from', 'start', 'date_from', 'dateFrom', 'begin', 'period_start'];
const END_PARAM_KEYS = ['end_date', 'endDate', 'to', 'end', 'date_to', 'dateTo', 'finish', 'period_end'];
const PAGINATION_PARAMS = ['page', 'cursor', 'limit', 'offset', 'per_page', 'pageSize'];

/** TIME_PATH_HINTS exposed for diagnostics module. */
export { TIME_PATH_HINTS };

// ---------- public ---------------------------------------------------------

export function planSyncUrls(
  items: CapturedRequest[],
  from: string,
  to: string,
  opts: { seedOrigin?: string | null } = {},
): SyncRequest[] {
  const months = monthWindows(from, to);
  const ctx = analyzeHistory(items, opts.seedOrigin ?? null);
  const templates = extractTimesheetTemplates(items);
  const out: SyncRequest[] = [];
  const seen = new Set<string>();

  const push = (req: SyncRequest): void => {
    const key = `${req.method ?? 'GET'} ${req.url} ${JSON.stringify(req.body ?? null)}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(req);
  };

  expandOverMonths(templates, months).forEach(push);

  // First-run seed: we know the tenant origin (either from a passive
  // capture or via chrome.tabs.query) and we know the user's own employee
  // id (either from a captured /timesheet/{id} URL or from a /my-org
  // response body). The user has not yet browsed any timesheet pages, so
  // `templates` is empty. Speculatively probe the well-known /timesheet
  // BFF variants — marked as probes so failures don't surface as scary
  // errors. Whichever variant returns 200 will be captured and used as a
  // real template on the next sync.
  if (ctx.origin && ctx.ownEmployeeId && templates.length === 0) {
    const seeded = seededTimesheetTemplates(ctx).filter(
      (u) => !ctx.deadEndpoints.has(u.split('?')[0]!),
    );
    for (const r of expandOverMonths(seeded, months)) push({ ...r, probe: true });
  }

  buildProbeRequests(ctx).forEach(push);

  return expandOverEmployees(out, ctx, months);
}

function seededTimesheetTemplates(ctx: HistoryContext): string[] {
  const { origin, ownEmployeeId } = ctx;
  if (!origin || !ownEmployeeId) return [];
  // Personio ships at least these BFF variants across tenants; we don't
  // know up front which one this tenant uses, so we list them all.
  return [
    `${origin}/svc/attendance-bff/v1/timesheet/${ownEmployeeId}?start_date=2000-01-01&end_date=2000-01-31`,
    `${origin}/svc/attendance-bff/timesheet/${ownEmployeeId}?start_date=2000-01-01&end_date=2000-01-31`,
    `${origin}/svc/attendance-api/v1/timesheet/${ownEmployeeId}?start_date=2000-01-01&end_date=2000-01-31`,
  ];
}

// ---------- history analysis ----------------------------------------------

type HistoryContext = {
  origin: string | null;
  ownEmployeeId: string | null;
  deadEndpoints: Set<string>;
  forbiddenEmployees: Set<string>;
  candidateEmployees: Set<string>;
};

function analyzeHistory(items: CapturedRequest[], seedOrigin: string | null): HistoryContext {
  let origin: string | null = null;
  let ownEmployeeId: string | null = null;
  const dead = new Set<string>();
  const forbidden = new Set<string>();
  for (const it of items) {
    try {
      const u = new URL(it.url);
      if (!origin && /personio\.(de|com)$/.test(u.hostname) && u.pathname.startsWith('/svc/')) {
        origin = u.origin;
      }
      if (!ownEmployeeId) {
        const m = TIMESHEET_URL_RE.exec(u.pathname);
        if (m) ownEmployeeId = m[1]!;
      }
    } catch { /* ignore */ }
    if (it.status >= 400 && it.status < 500) dead.add(it.url.split('?')[0]!);
    if (it.status === 403) {
      const m = TIMESHEET_URL_RE.exec(it.url);
      if (m) forbidden.add(m[1]!);
    }
    if (!ownEmployeeId && it.bodyJson && /\/my-organization\b|\/me\b|\/current[-_]?user\b/i.test(it.url)) {
      ownEmployeeId = findOwnIdInBody(it.bodyJson);
    }
  }
  // Fallback: caller already knows which Personio tab is open (via
  // chrome.tabs.query) even before we've seen any captures — use that so
  // first-run sync can immediately probe the well-known endpoints.
  if (!origin && seedOrigin) origin = seedOrigin;
  const allowed = collectAllowedEmployeeIds(items);
  const candidate = allowed.size > 0 ? allowed : collectEmployeeIds(items);
  if (ownEmployeeId) candidate.add(ownEmployeeId);
  return {
    origin, ownEmployeeId,
    deadEndpoints: dead, forbiddenEmployees: forbidden,
    candidateEmployees: candidate,
  };
}

function findOwnIdInBody(body: unknown): string | null {
  let found: string | null = null;
  walkObjects(body, (o) => {
    if (found) return;
    for (const k of ['me', 'self', 'current_user', 'currentUser', 'viewer']) {
      const v = o[k];
      if (isPlainObject(v)) {
        const id = v.id ?? v.employee_id ?? v.person_id;
        if (typeof id === 'string' || typeof id === 'number') {
          found = String(id);
          return;
        }
      }
    }
  });
  return found;
}

// ---------- timesheet template extraction ---------------------------------

function extractTimesheetTemplates(items: CapturedRequest[]): string[] {
  const templates = new Set<string>();
  for (const it of items) {
    try {
      const u = new URL(it.url);
      if (!TIME_PATH_HINTS.test(u.pathname)) continue;
      if (TIME_PATH_EXCLUDE.test(u.pathname)) continue;
      // Only replay the rich /timesheet/{id} endpoint.
      if (!TIMESHEET_URL_RE.test(u.pathname)) continue;
      if (it.method && it.method !== 'GET') continue;
      if (it.status >= 400 && it.status < 500) continue;
      PAGINATION_PARAMS.forEach((k) => u.searchParams.delete(k));
      templates.add(u.toString());
    } catch { /* ignore */ }
  }
  return Array.from(templates);
}

// ---------- expansion -----------------------------------------------------

function expandOverMonths(
  templates: string[],
  months: Array<{ start: string; end: string }>,
): SyncRequest[] {
  const out: SyncRequest[] = [];
  for (const tpl of templates) {
    const u = new URL(tpl);
    const dateKey = DATE_PARAM_KEYS.find((k) => u.searchParams.has(k));
    const endKey = END_PARAM_KEYS.find((k) => u.searchParams.has(k));
    if (months.length === 0 || !dateKey) {
      out.push({ url: tpl, method: 'GET' });
      continue;
    }
    for (const w of months) {
      const u2 = new URL(tpl);
      u2.searchParams.set(dateKey, w.start);
      if (endKey) u2.searchParams.set(endKey, w.end);
      out.push({ url: u2.toString(), method: 'GET' });
    }
  }
  return out;
}

function expandOverEmployees(
  reqs: SyncRequest[],
  ctx: HistoryContext,
  months: Array<{ start: string; end: string }>,
): SyncRequest[] {
  const known = new Set(
    Array.from(ctx.candidateEmployees).filter((id) => !ctx.forbiddenEmployees.has(id)),
  );
  if (known.size === 0 || months.length === 0) return reqs;

  const expanded: SyncRequest[] = [];
  const seen = new Set<string>();
  const push = (r: SyncRequest): void => {
    const key = `${r.method ?? 'GET'} ${r.url}`;
    if (seen.has(key)) return;
    seen.add(key); expanded.push(r);
  };
  for (const r of reqs) {
    const m = TIMESHEET_URL_RE.exec(r.url);
    if (!m) { push(r); continue; }
    for (const empId of known) {
      push({ ...r, url: r.url.replace(`/timesheet/${m[1]}`, `/timesheet/${empId}`) });
    }
  }
  return expanded;
}

// ---------- probe requests ------------------------------------------------

function buildProbeRequests(ctx: HistoryContext): SyncRequest[] {
  const out: SyncRequest[] = [];
  if (!ctx.origin) return out;
  const { origin, deadEndpoints, ownEmployeeId } = ctx;
  const isDead = (url: string): boolean => deadEndpoints.has(url.split('?')[0]!);

  if (ownEmployeeId) {
    const gqlUrl = `${origin}/graphql?op=TM_TrackableProjects_v2025091101`;
    out.push({
      url: gqlUrl,
      method: 'POST',
      probe: true,
      body: {
        operationName: 'TM_TrackableProjects_v2025091101',
        query: 'TM_TrackableProjects_v2025091101',
        variables: { personId: { id: ownEmployeeId } },
      },
    });
  }

  for (const p of [
    `${origin}/svc/attendance-bff/projects`,
    `${origin}/svc/attendance-bff/v1/projects`,
    `${origin}/svc/attendance-api/v1/projects`,
  ]) {
    if (!isDead(p)) out.push({ url: p, method: 'GET', probe: true });
  }

  const peopleListUrl = `${origin}/people-list/bff/data`;
  if (!isDead(peopleListUrl)) {
    out.push({
      url: peopleListUrl,
      method: 'POST',
      probe: true,
      body: { filters: {}, page: 0, pageSize: 1000 },
    });
  }

  const orgUrl = `${origin}/platform/dashboard/api/v1/my-organization`;
  if (!isDead(orgUrl)) out.push({ url: orgUrl, method: 'GET', probe: true });

  return out;
}

// ---------- employee-id discovery -----------------------------------------

/** Employee ids the current user is *allowed* to view (200 timesheet OR direct_report). */
function collectAllowedEmployeeIds(items: CapturedRequest[]): Set<string> {
  const ids = new Set<string>();
  for (const it of items) {
    if (it.status === 200) {
      const m = TIMESHEET_URL_RE.exec(it.url);
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
