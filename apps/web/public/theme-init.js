// Apply the saved theme before first paint (no flash). Keep in sync with src/lib/theme.ts.
// A classic, blocking script (not inline) so the Content-Security-Policy needs no
// 'unsafe-inline' for scripts. Never throws. The app writes `wf.theme.boot` ({l, d}: [id, mode,
// chrome] to use when the OS is light / dark) on every theme change; without it (first visit or
// before upgrade) the stored 'light' | 'dark' | 'system' preference picks the default themes.
(function () {
  try {
    var ls = localStorage;
    var dark = matchMedia('(prefers-color-scheme: dark)').matches;
    var t = null;
    try {
      var b = JSON.parse(ls.getItem('wf.theme.boot'));
      t = b && b[dark ? 'd' : 'l'];
      if (!t || typeof t[0] !== 'string' || !/^#[0-9a-f]{6}$/i.test(t[2])) t = null;
    } catch (e) {}
    if (!t) {
      var p = ls.getItem('wf.theme');
      var d = p === 'dark' || (p !== 'light' && dark);
      t = d ? ['dark', 'dark', '#0f0f18'] : ['light', 'light', '#f5f3ee'];
    }
    var r = document.documentElement;
    r.setAttribute('data-theme', t[0]);
    if (t[1] === 'dark') r.classList.add('dark');
    r.style.colorScheme = t[1] === 'dark' ? 'dark' : 'light';
    r.style.backgroundColor = t[2];
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t[2]);
  } catch (e) {}
})();
