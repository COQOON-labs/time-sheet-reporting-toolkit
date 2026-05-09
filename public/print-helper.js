// Loaded by the print-ready HTML report (blob:chrome-extension://...).
// Lives as a separate file so it satisfies the extension's default CSP
// (script-src 'self'), unlike inline <script> which is blocked.
(function () {
  var btn = document.getElementById('print-btn');
  if (btn) btn.addEventListener('click', function () { window.print(); });
})();
