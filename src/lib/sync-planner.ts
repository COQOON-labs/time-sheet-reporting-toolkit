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
  opts: {
    seedOrigin?: string | null;
    ownEmployeeIdHint?: string | null;
    /** When true, ignore the incremental cache and refetch every month. */
    force?: boolean;
  } = {},
): SyncRequest[] {
  const months = monthWindows(from, to);
  const ctx = analyzeHistory(items, opts.seedOrigin ?? null, opts.ownEmployeeIdHint ?? null);
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

  const expanded = expandOverEmployees(out, ctx, months);
  return opts.force ? expanded : skipAlreadyCachedMonths(expanded, items);
}

/**
 * Incremental cache: drop URLs that target a closed past month whose
 * (path, start_date, end_date) we have a 2xx capture for already. The
 * current month and the previous month are always re-fetched because
 * Personio time entries are routinely backdated/edited within that
 * window. Probes are never skipped — they are cheap and the planner uses
 * them to learn endpoints, not to fetch payload.
 */
function skipAlreadyCachedMonths(
  reqs: SyncRequest[],
  items: CapturedRequest[],
): SyncRequest[] {
  // (pathOnly, start, end) -> true once we have a 2xx for this exact slice
  const cached = new Set<string>();
  for (const it of items) {
    if (it.status < 200 || it.status >= 300) continue;
    try {
      const u = new URL(it.url);
      const start = pickParam(u, DATE_PARAM_KEYS);
      const end = pickParam(u, END_PARAM_KEYS);
      if (!start || !end) continue;
      cached.add(`${u.origin}${u.pathname}|${start}|${end}`);
    } catch { /* ignore */ }
  }

  // Boundary: the first day of the previous calendar month. Any month
  // whose end_date is strictly before this is "closed" and safe to skip
  // when already cached.
  const now = new Date();
  const closedBefore = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString().slice(0, 10);

  return reqs.filter((r) => {
    if (r.probe) return true;
    let u: URL;
    try { u = new URL(r.url); } catch { return true; }
    const start = pickParam(u, DATE_PARAM_KEYS);
    const end = pickParam(u, END_PARAM_KEYS);
    if (!start || !end) return true;
    if (end >= closedBefore) return true; // recent enough — always refetch
    const key = `${u.origin}${u.pathname}|${start}|${end}`;
    return !cached.has(key);
  });
}

function pickParam(u: URL, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = u.searchParams.get(k);
    if (v) return v;
  }
  return null;
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
  /** Path-only URLs that returned 2xx in any prior sync — once we've seen
   *  one succeed, we no longer treat it as a speculative probe (so failures
   *  on a later sync DO surface as real errors). */
  confirmedEndpoints: Set<string>;
  forbiddenEmployees: Set<string>;
  candidateEmployees: Set<string>;
};

function analyzeHistory(
  items: CapturedRequest[],
  seedOrigin: string | null,
  ownEmployeeIdHint: string | null,
): HistoryContext {
  let origin: string | null = null;
  let ownEmployeeId: string | null = null;
  const confirmed = new Set<string>();
  const forbidden = new Set<string>();
  // Per-path failure ledger: only mark a path "dead" once we've seen a
  // sustained pattern of client-error responses, not after a single 4xx
  // (which can be transient — auth flake, race, deploy). 5xx and network
  // errors (status 0) are explicitly NOT counted as evidence-of-dead, since
  // they signal a service problem rather than "this route doesn't exist".
  const failureLedger = new Map<string, number[]>(); // pathOnly -> failure timestamps (ms)
  const lastFailureAt = new Map<string, number>();
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
    const pathOnly = it.url.split('?')[0]!;
    if (it.status >= 200 && it.status < 300) confirmed.add(pathOnly);
    if (it.status >= 400 && it.status < 500) {
      const arr = failureLedger.get(pathOnly) ?? [];
      arr.push(it.capturedAt);
      failureLedger.set(pathOnly, arr);
      const prev = lastFailureAt.get(pathOnly) ?? 0;
      if (it.capturedAt > prev) lastFailureAt.set(pathOnly, it.capturedAt);
    }
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
  // Fallback: caller persists the last-known own employee id in
  // chrome.storage.local so we can still build seeded probes after the
  // user clears the cache (which only wipes IndexedDB).
  if (!ownEmployeeId && ownEmployeeIdHint) ownEmployeeId = ownEmployeeIdHint;
  const dead = computeDeadEndpoints(failureLedger, lastFailureAt, confirmed);
  const allowed = collectAllowedEmployeeIds(items);
  const candidate = allowed.size > 0 ? allowed : collectEmployeeIds(items);
  if (ownEmployeeId) candidate.add(ownEmployeeId);
  return {
    origin, ownEmployeeId,
    deadEndpoints: dead, confirmedEndpoints: confirmed,
    forbiddenEmployees: forbidden,
    candidateEmployees: candidate,
  };
}

/** Window over which we count consecutive client errors before declaring
 *  a path dead. A single isolated 4xx isn't enough. */
const DEAD_FAILURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** How many client errors inside the window before we stop probing. */
const DEAD_FAILURE_THRESHOLD = 3;
/** After this long with no fresh failure, give the path one more chance —
 *  Personio occasionally rolls out new BFF versions and routes that 404'd
 *  yesterday may serve 200 today. */
const DEAD_REPROBE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

function computeDeadEndpoints(
  failureLedger: Map<string, number[]>,
  lastFailureAt: Map<string, number>,
  confirmed: Set<string>,
): Set<string> {
  const now = Date.now();
  const dead = new Set<string>();
  for (const [path, failures] of failureLedger) {
    // A path that has ever returned 2xx is alive. A transient 4xx in its
    // history doesn't undo that.
    if (confirmed.has(path)) continue;
    const recent = failures.filter((t) => now - t <= DEAD_FAILURE_WINDOW_MS);
    if (recent.length < DEAD_FAILURE_THRESHOLD) continue;
    // Time-based re-probe: if we haven't seen a fresh failure in a while,
    // give it another shot.
    const last = lastFailureAt.get(path) ?? 0;
    if (now - last > DEAD_REPROBE_AFTER_MS) continue;
    dead.add(path);
  }
  return dead;
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
  const { origin, deadEndpoints, confirmedEndpoints, ownEmployeeId } = ctx;
  const isDead = (url: string): boolean => deadEndpoints.has(url.split('?')[0]!);
  // A URL that has previously returned 2xx is no longer speculative — emit
  // it as a regular request so failures bubble up properly to the user.
  const probeFlag = (url: string): { probe: true } | Record<string, never> =>
    confirmedEndpoints.has(url.split('?')[0]!) ? {} : { probe: true };

  if (ownEmployeeId) {
    const gqlUrl = `${origin}/graphql?op=TM_TrackableProjects_v2025091101`;
    out.push({
      url: gqlUrl,
      method: 'POST',
      ...probeFlag(gqlUrl),
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
    if (!isDead(p)) out.push({ url: p, method: 'GET', ...probeFlag(p) });
  }

  const peopleListUrl = `${origin}/people-list/bff/data`;
  if (!isDead(peopleListUrl)) {
    out.push({
      url: peopleListUrl,
      method: 'POST',
      ...probeFlag(peopleListUrl),
      body: { filters: {}, page: 0, pageSize: 1000 },
    });
  }

  const orgUrl = `${origin}/platform/dashboard/api/v1/my-organization`;
  if (!isDead(orgUrl)) out.push({ url: orgUrl, method: 'GET', ...probeFlag(orgUrl) });

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
