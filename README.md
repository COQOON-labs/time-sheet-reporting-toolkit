# Reporting for Personio

A Chrome (Manifest V3) extension that captures Personio's web API responses
in the background while you browse and renders an in-page reporting
sidepanel with filters, search and charts.

## Features

- 🔌 Page-context fetch/XHR interceptor — captures every Personio API
  response without you doing anything special.
- 💾 Stores captured payloads in browser-local IndexedDB (nothing leaves
  your machine).
- 📊 Floating launcher button on every Personio page opens an in-page
  sidepanel with:
  - Full-text search over URLs and JSON bodies
  - Category filter (attendance, absences, payroll, employees, graphql, …)
  - Bar chart by category + per-minute timeline
  - Per-request inspector with pretty-printed response body
- ⬇️ One-click JSON export of the entire dataset.
- 🗑️ One-click clear.

## Getting started

```bash
npm install
npm run build
```

Then load the unpacked extension in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder
4. Visit your Personio tenant — the **📊 Reporting** button appears
   bottom-right. Click it to open the panel.

For development with HMR:

```bash
npm run dev
```

To produce a publishable zip:

```bash
npm run zip
```

## Permissions explained

| Permission                               | Why                                                 |
| ---------------------------------------- | --------------------------------------------------- |
| `storage`                                | Future settings UI (currently uses IndexedDB only). |
| `activeTab`, `scripting`                 | Inject the page-context interceptor.                |
| `host_permissions: *.personio.de / .com` | Restrict the extension strictly to Personio.        |

No data is ever sent off-device.

## Architecture

```
┌─────────────────────────────────────────────┐
│ Personio page (MAIN world)                  │
│  └─ inject.ts  ── wraps fetch + XHR ──┐     │
└───────────────────────────────────────│─────┘
                                        │ window.postMessage
┌───────────────────────────────────────▼─────┐
│ content.ts (isolated world)                 │
│  ├─ injects inject.ts                       │
│  ├─ mounts launcher + sidepanel iframe      │
│  └─ forwards captures to background         │
└───────────────────────────────────────│─────┘
                                        │ chrome.runtime.sendMessage
┌───────────────────────────────────────▼─────┐
│ background.ts (service worker)              │
│  └─ persists to IndexedDB                   │
└─────────────────────────────────────────────┘
                                        ▲
┌───────────────────────────────────────│─────┐
│ sidepanel.html  (iframe in page)      │     │
│  └─ queries background, renders UI ───┘     │
└─────────────────────────────────────────────┘
```
