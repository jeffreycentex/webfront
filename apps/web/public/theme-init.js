// Apply the saved theme before first paint (no flash). Keep in sync with src/lib/theme.ts.
// A classic, blocking script (not inline) so the Content-Security-Policy needs no
// 'unsafe-inline' for scripts.
(function () {
  try {
    var p = localStorage.getItem('wf.theme');
    var dark =
      p === 'dark' || (p !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
    var r = document.documentElement;
    if (dark) r.classList.add('dark');
    r.style.colorScheme = dark ? 'dark' : 'light';
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', dark ? '#0f0f18' : '#f5f3ee');
  } catch (e) {}
})();
