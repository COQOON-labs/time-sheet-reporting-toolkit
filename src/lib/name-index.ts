/**
 * Build name lookup maps (employee id → name, project id → name) from
 * captured responses, plus current-user discovery.
 *
 * All walks share the generic `walkObjects` helper to avoid the four
 * near-identical tree-walkers we used to maintain.
 */

import type { CapturedRequest } from './types.js';
import { isPlainObject, walkObjects } from './walk.js';
import { safeStringify } from './parse.js';

const ID_RE = /^\d{3,}$/;

/** Build a Map<employeeId, displayName> from any captures that look people-ish. */
export function buildEmployeeIndex(items: CapturedRequest[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const it of items) {
    if (!it.bodyJson) continue;
    const url = it.url.toLowerCase();
    const isPeopleish =
      /employee|person|people|directory|organization|orgunit|orgchart|team-?calendar|profile|reports|subordinate/.test(url)
      || /first[_-]?name|last[_-]?name|display[_-]?name|"full[_-]?name"/i.test(safeStringify(it.bodyJson));
    if (!isPeopleish) continue;
    walkObjects(it.bodyJson, (o) => recordPerson(o, out));
  }
  return out;
}

function recordPerson(o: Record<string, unknown>, out: Map<string, string>): void {
  const idCand =
    o.id ?? o.employee_id ?? o.employeeId ?? o.person_id ?? o.personId ?? o.user_id ?? o.userId;
  let idStr: string | null = null;
  if (typeof idCand === 'string' || typeof idCand === 'number') {
    const s = String(idCand);
    if (ID_RE.test(s)) idStr = s;
  } else if (isPlainObject(idCand)) {
    const inner = idCand.id;
    if (typeof inner === 'string' || typeof inner === 'number') {
      const s = String(inner);
      if (ID_RE.test(s)) idStr = s;
    }
  }
  if (!idStr || out.has(idStr)) return;

  const name = derivePersonName(o);
  if (name) {
    out.set(idStr, name);
    return;
  }
  // JSON:API style: { id, type:"employees", attributes:{...} }
  if ((o.type === 'employees' || o.type === 'employee' || o.type === 'person') && isPlainObject(o.attributes)) {
    const n = derivePersonName(o.attributes);
    if (n) out.set(idStr, n);
  }
}

export function derivePersonName(o: Record<string, unknown>): string | null {
  const dn = (o.display_name ?? o.displayName ?? o.full_name ?? o.fullName ?? o.name) as unknown;
  if (typeof dn === 'string' && dn.trim() && !/^\d+$/.test(dn)) return dn.trim();
  const first = (o.first_name ?? o.firstName ?? o.preferred_name ?? o.preferredName ?? o.given_name ?? o.givenName) as unknown;
  const last = (o.last_name ?? o.lastName ?? o.family_name ?? o.familyName ?? o.surname) as unknown;
  if (typeof first === 'string' && first.trim()) {
    return [first.trim(), typeof last === 'string' ? last.trim() : ''].filter(Boolean).join(' ');
  }
  return null;
}

/** Best-effort discovery of the current logged-in employee. */
export function getOwnEmployee(items: CapturedRequest[]): { id: string; name: string } | null {
  // 1. Explicit "current user" endpoints — usually carry id + email + name.
  for (const it of items) {
    if (!it.bodyJson) continue;
    if (!/navigation\/context|\/me\b|\/v1\/me\/|current[-_]?user|viewer|whoami|profile/i.test(it.url)) continue;
    const found = findCurrentUser(it.bodyJson);
    if (found) return found;
  }
  // 2. Fallback: first timesheet URL the inject hook captured = own.
  let fallbackId: string | null = null;
  for (const it of items) {
    const m = /\/timesheet\/(\d{3,})/.exec(it.url);
    if (m) { fallbackId = m[1]!; break; }
  }
  if (!fallbackId) return null;
  // Try to resolve the fallback id to a name via the people index.
  const names = buildEmployeeIndex(items);
  return { id: fallbackId, name: names.get(fallbackId) ?? '' };
}

function findCurrentUser(body: unknown): { id: string; name: string } | null {
  let result: { id: string; name: string } | null = null;
  walkObjects(body, (o) => {
    if (result) return;
    const idCand = o.id ?? o.employee_id ?? o.employeeId ?? o.person_id ?? o.personId ?? o.user_id ?? o.userId;
    if (typeof idCand !== 'string' && typeof idCand !== 'number') return;
    const idStr = String(idCand);
    if (!ID_RE.test(idStr)) return;
    const name = derivePersonName(o);
    if (!name) return;
    const hasEmail = typeof (o.email ?? o.work_email ?? o.workEmail ?? o.primary_email ?? o.primaryEmail) === 'string';
    if (hasEmail) {
      result = { id: idStr, name };
    } else if (typeof o.first_name === 'string' || typeof o.firstName === 'string') {
      // id+first_name without email is also a strong signal.
      result = { id: idStr, name };
    }
  });
  return result;
}

/** Build a Map<projectId, projectName> from any captures that mention projects. */
export function buildProjectIndex(items: CapturedRequest[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const it of items) {
    if (!it.bodyJson) continue;
    // GraphQL responses don't mention 'project' in the URL — sniff body too.
    const isProjectish = /project/i.test(it.url) || /trackableprojects|projectslist|"projects"/i.test(safeStringify(it.bodyJson));
    if (!isProjectish) continue;
    walkObjects(it.bodyJson, (o) => recordProject(o, out));
  }
  return out;
}

function recordProject(o: Record<string, unknown>, out: Map<string, string>): void {
  // GraphQL nested: { id: { id: "123" }, name: "..." }
  if (isPlainObject(o.id) && typeof (o.id as Record<string, unknown>).id !== 'undefined' && typeof o.name === 'string') {
    out.set(String((o.id as Record<string, unknown>).id), o.name);
    return;
  }
  // JSON:API: { id, type: "projects", attributes: { name } }
  if (typeof o.id !== 'undefined' && (o.type === 'projects' || o.type === 'project') && isPlainObject(o.attributes)) {
    const n = (o.attributes as Record<string, unknown>).name;
    if (typeof n === 'string') out.set(String(o.id), n);
    return;
  }
  // Flat: { id, name }
  if ((typeof o.id === 'string' || typeof o.id === 'number') && typeof o.name === 'string' && Object.keys(o).length <= 8) {
    out.set(String(o.id), o.name);
  }
}
