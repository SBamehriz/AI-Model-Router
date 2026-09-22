// Runs before the first paint, so the page never shows the wrong theme for a
// moment and then corrects itself. The provider in the app reads the same key
// and takes over once it mounts; this only decides what the first frame is.
//
// A separate file rather than an inline script because the server's content
// security policy allows scripts only from its own origin, which is the right
// policy and not worth a hash exception for eleven lines.
(function () {
  try {
    var stored = localStorage.getItem('ai-model-router.theme');
    var dark = stored === 'dark' ||
      ((!stored || stored === 'system') && matchMedia('(prefers-color-scheme: dark)').matches);
    // Swap only the two theme classes, so anything else on <html> survives.
    document.documentElement.classList.remove('light', 'dark');
    document.documentElement.classList.add(dark ? 'dark' : 'light');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    // The browser chrome on a phone takes its colour from this tag, and a
    // single fixed value meant a dark address bar over a light page for as
    // long as the page was open. The values are the two page backgrounds.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0E1015' : '#F6F7F9');
  } catch (e) {
    // Storage or matchMedia unavailable: the class already on <html> stands.
  }
})();
