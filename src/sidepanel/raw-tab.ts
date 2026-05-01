/**
 * Raw-requests tab (dev-only). Lists every captured request with body
 * preview. Search + category filter.
 */

import type { CapturedRequest } from '../lib/types.js';
import { state } from './state.js';
import { $ } from './dom.js';

const els = {
  search: $('#search') as HTMLInputElement,
  category: $('#category') as HTMLSelectElement,
  list: $('#list') as HTMLElement,
  rowTpl: $('#row-tpl') as HTMLTemplateElement,
};

function rawFiltered(): CapturedRequest[] {
  const q = els.search.value.trim().toLowerCase();
  const cat = els.category.value;
  return state.allItems.filter((it) => {
    if (cat && it.category !== cat) return false;
    if (!q) return true;
    if (it.url.toLowerCase().includes(q)) return true;
    if (it.bodyJson && JSON.stringify(it.bodyJson).toLowerCase().includes(q)) return true;
    return false;
  });
}

export function renderRaw(): void {
  const cats = Array.from(new Set(state.allItems.map((i) => i.category))).sort();
  const current = els.category.value;
  els.category.innerHTML =
    '<option value="">All categories</option>' +
    cats.map((c) => `<option value="${c}">${c}</option>`).join('');
  if (cats.includes(current)) els.category.value = current;

  const items = rawFiltered();
  els.list.innerHTML = '';
  if (items.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = state.allItems.length === 0
      ? 'No requests captured yet.'
      : 'No matches for current filter.';
    els.list.appendChild(p);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items.slice(0, 500)) frag.appendChild(rawRow(it));
  els.list.appendChild(frag);
}

function rawRow(it: CapturedRequest): Node {
  const node = els.rowTpl.content.cloneNode(true) as DocumentFragment;
  node.querySelector('.method')!.textContent = it.method;
  const status = node.querySelector('.status') as HTMLElement;
  status.textContent = String(it.status);
  status.dataset.ok = String(Math.floor(it.status / 100));
  node.querySelector('.cat')!.textContent = it.category;
  node.querySelector('time')!.textContent = new Date(it.capturedAt).toLocaleString();
  node.querySelector('.url')!.textContent = it.url;
  node.querySelector('.body')!.textContent = it.bodyJson
    ? JSON.stringify(it.bodyJson, null, 2)
    : '(non-JSON or empty response)';
  return node;
}

export function wireRaw(): void {
  els.search.addEventListener('input', renderRaw);
  els.category.addEventListener('change', renderRaw);
}
