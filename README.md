# 📊 Reporting for Personio

A Chrome (Manifest V3) extension that turns your everyday Personio
browsing into a personal time-tracking analytics tool. It silently
captures the API responses your Personio tab is already loading, stores
them locally in IndexedDB, and renders an in-page **dashboard** with
filters, charts, KPIs, CSV export and a printable HTML report — all
without your data ever leaving your machine.

> **Privacy first.** No external server, no telemetry, no analytics SDK.
> Captures stay in your browser and are auto-deleted after 90 days.

---

## ✨ Features

### Dashboard (default view)

- 📈 **KPIs at a glance:** total hours, overtime, entry count, distinct
  days worked, project count, average hours / day.
- ⏱️ **Overtime card** — surfaces the daily-overtime balance Personio
  itself computes, summed across the selected range.
- 📊 **Charts:** hours-per-day line chart + top-projects horizontal bar.
- 📅 **Quick range presets:** This month · Last month · Last 3 months ·
  Last 6 months · This year · All · Custom (free date pickers).
- 🧑‍🤝‍🧑 **Employee + project filter** with full-text search across
  comments. The current user (own employee) is auto-selected when
  visible in the data.
- 🗂️ **Two summary tables:** hours per project and hours per employee
  (employee table only shown when more than one is in scope).
- 📥 **CSV export** of the filtered entries.
- 📰 **HTML report** opens in a new tab — printable, self-contained,
  delivered via a `blob:` URL (no payload in the URL bar / referrer).
- 🔁 **Active sync (manual + auto)** — replays previously seen
  timesheet endpoints with the page's session cookies to backfill data
  for date ranges you didn't actively browse.

### Capture engine

- Runs in the **MAIN world** so it can wrap `window.fetch` and
  `XMLHttpRequest` directly. Bridges captures back to the isolated
  content script via `postMessage` (with same-origin enforcement).
- **Tight allow-list** of stored endpoints — only the routes the
  dashboard actually consumes (`/timesheet/{id}`, `/navigation/context`,
  `/my-organization`, `/people-list`, `/graphql`, `/employees`,
  `/persons`).
- **90-day retention:** the background worker prunes stale rows on
  every write.

---

## 🚀 Getting started

```bash
npm install
npm run build
```

Then load the unpacked extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder
4. Visit your Personio tenant — the floating **📊 Reporting** button
   appears bottom-right. Click it to open the dashboard.

For development with HMR:

```bash
npm run dev
```

To produce a publishable zip:

```bash
npm run zip
```

To run the test suite:

```bash
npm test
```

---

## 🔐 Privacy & permissions

| Permission                               | Why                                                  |
| ---------------------------------------- | ---------------------------------------------------- |
| `storage`                                | UI preferences (auto-sync toggle).                   |
| `activeTab`, `scripting`                 | Inject the page-context interceptor.                 |
| `host_permissions: *.personio.de / .com` | Restrict the extension strictly to Personio domains. |

**Data handling:**

- All captured payloads live in **browser-local IndexedDB**.
- Records are pruned automatically after **90 days**.
- Only an explicit allow-list of Personio time-tracking endpoints is
  persisted — analytics, feature-flag, and asset traffic is dropped at
  the interceptor.
- The HTML report opens via a `blob:` URL so the payload never appears
  in URL bar history or referrer headers; the URL is revoked after
  60 seconds.
- The `postMessage` bridge enforces same-origin (`event.origin ===
  location.origin`) on top of `event.source === window`.
- **Nothing is ever transmitted to a third party.**

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│  Personio page (MAIN world)                         │
│   └─ inject.ts  ─ wraps fetch + XHR  ─────┐         │
└───────────────────────────────────────────│─────────┘
                                            │ window.postMessage
                                            │ (same-origin checked)
┌───────────────────────────────────────────▼─────────┐
│  content.ts  (ISOLATED world)                       │
│   ├─ injects inject.ts                              │
│   ├─ mounts launcher button + sidepanel iframe      │
│   └─ forwards captures + handles active-sync fetch  │
└───────────────────────────────────────────│─────────┘
                                            │ chrome.runtime.sendMessage
┌───────────────────────────────────────────▼─────────┐
│  background.ts  (service worker)                    │
│   ├─ persists to IndexedDB (90-day TTL)             │
│   └─ list / clear / active-sync RPCs                │
└─────────────────────────────────────────────────────┘
                                            ▲
┌───────────────────────────────────────────│─────────┐
│  sidepanel.html  (iframe in page)         │         │
│   └─ queries background, renders UI ──────┘         │
│       ├─ dashboard.ts  (KPIs · charts · tables)     │
│       ├─ sync-controller.ts (manual + auto sync)    │
│       └─ raw-tab / reports-tab / diagnostics-tab    │
│         (dev-only, lazy-loaded)                     │
└─────────────────────────────────────────────────────┘
```

### Module map

```
src/
├── manifest.json
├── inject/inject.ts            MAIN-world fetch + XHR hook
├── content/content.ts          Bridge + sync executor + UI mount
├── background/background.ts    Service worker + IndexedDB
├── popup/popup.html            Toolbar popup with privacy hint
├── sidepanel/
│   ├── sidepanel.html / .css   Layout + theme
│   ├── main.ts                 Bootstrap + tab routing + refresh loop
│   ├── state.ts                Plain mutable store (no pub/sub)
│   ├── messaging.ts            Typed wrapper over chrome.runtime
│   ├── dom.ts                  $/$$ helpers
│   ├── dashboard.ts            Default tab
│   ├── sync-controller.ts      Manual + auto sync lifecycle
│   ├── report-html.ts          Self-contained HTML report builder
│   ├── raw-tab.ts              dev-only
│   ├── reports-tab.ts          dev-only
│   └── diagnostics-tab.ts      dev-only
└── lib/
    ├── attendance.ts           Barrel re-export
    ├── constants.ts            URL regex, brand colors, storage keys
    ├── types.ts                CapturedRequest, SyncRequest, ...
    ├── parse.ts                Date utils, monthWindows, safePathname
    ├── format.ts               escapeHtml, escapeCsvCell, utf8Bytes,
    │                           fmtHours, fmtOvertime, download, stamp
    ├── identify.ts             URL → category, content hash
    ├── walk.ts                 Generic JSON walker + isPlainObject
    ├── name-index.ts           id → name lookup builders
    ├── time-entries.ts         Extract + dedup time entries
    ├── overtime.ts             Daily-overtime extraction
    ├── sync-planner.ts         Build active-sync request list
    ├── reports.ts              Generic report grouping (dev tab)
    ├── diagnostics.ts          Detector explanations (dev tab)
    ├── prefs.ts                chrome.storage typed bool helpers
    └── storage.ts              IndexedDB wrapper (idb)
```

### Key design decisions

- **Pure functions over hidden state.** Extractors
  (`extractTimeEntries`, `extractDailyOvertime`, `planSyncUrls`, …)
  take their inputs as arguments and return new data — no globals.
- **Strict typed messaging.** `messaging.ts` defines a `RequestMap`
  keyed by message kind; the response is a discriminated `Envelope`
  union (`{ ok: true, ... } | { ok: false, error }`) so the happy
  path always matches the declared response type.
- **Single source of truth for regexes & constants.**
  `TIMESHEET_URL_RE`, `BRAND`, `EMPLOYEE_ID_PREFIX`, etc. live in
  `lib/constants.ts` and are imported everywhere.
- **DEV-gated UI.** Tabs marked `data-dev-only` are hidden in
  production builds. Their TS modules are dynamically `import()`-ed
  only when the dev gate is open, so the production bundle stays small.
- **Allow-list everything.** Both the inject-side capture filter and
  the storage-side persistence filter use explicit allow-lists. New
  endpoints require a code change.

---

## 🧪 Testing

```bash
npm test
```

40+ unit tests cover the pure-function libs:

- `parse.test.ts` — date parsing, hour parsing, month-window expansion.
- `time-entries.test.ts` — extractor + cross-endpoint dedup, including
  the employee-disambiguation regression test.
- `overtime.test.ts` — daily-overtime extraction.

The UI layer is intentionally test-free; correctness is enforced by
keeping it a thin shell over the tested libs.

---

## 🧰 Tech stack

- **TypeScript 5** (strict mode)
- **Vite 5** + [`@crxjs/vite-plugin`](https://crxjs.dev/) for MV3 HMR
- **Chart.js 4** (bar + line)
- **idb** for IndexedDB
- **Vitest 4** for unit tests
- Zero runtime dependencies on UI frameworks

---

## 📜 License

[MIT](LICENSE) © Benjamin Gröner.

Not affiliated with Personio SE & Co. KG.
