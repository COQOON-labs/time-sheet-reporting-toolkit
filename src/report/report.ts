import { renderReport, type ReportPayload } from '../sidepanel/report-html.js';

const REPORT_KEY_PREFIX = 'report:';

async function load(): Promise<void> {
  const root = document.getElementById('root');
  if (!root) return;

  const params = new URLSearchParams(location.search);
  const key = params.get('key');
  if (!key) {
    root.innerHTML = '<p style="color:#b91c1c">No report key in URL.</p>';
    return;
  }

  const storageKey = REPORT_KEY_PREFIX + key;
  const stored = await chrome.storage.session.get(storageKey);
  const payload = stored[storageKey] as ReportPayload | undefined;
  if (!payload) {
    root.innerHTML =
      '<p style="color:#b91c1c">Report data not found (it may have expired or the browser session was cleared). ' +
      'Close this tab and re-open the report from the dashboard.</p>';
    return;
  }

  // Consume one-shot — keep session storage clean.
  void chrome.storage.session.remove(storageKey);

  const { title, bodyHtml } = renderReport(payload);
  document.title = title;
  root.innerHTML = bodyHtml;
}

function wirePrint(): void {
  const btn = document.getElementById('print-btn');
  if (btn) btn.addEventListener('click', () => window.print());
}

wirePrint();
void load();
