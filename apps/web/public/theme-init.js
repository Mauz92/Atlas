/*
 * Atlas pre-paint theme (UX-01). Loaded as a classic, render-blocking script from <head> so a stored
 * Light or Dark choice is on <html data-theme> before the first paint. With no stored choice
 * (System), nothing is set and styles.css follows prefers-color-scheme. It is a same-origin file,
 * not an inline script, so the production CSP (script-src 'self', apps/web/nginx.conf) allows it.
 * Keep the key and values in sync with src/lib/theme.ts.
 */
(function () {
  try {
    var stored = window.localStorage.getItem("atlas-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (e) {
    // Storage unavailable (private mode, blocked): follow the system theme.
  }
})();
