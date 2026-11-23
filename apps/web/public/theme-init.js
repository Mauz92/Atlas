/*
 * Atlas pre-paint theme (UX-01). Loaded as a classic, render-blocking script from <head> so a stored
 * Light or Dark choice is on <html data-theme> before the first paint. With no stored choice
 * (System), nothing is set and styles.css follows prefers-color-scheme. It is a same-origin file,
 * not an inline script, so the production CSP (script-src 'self', apps/web/nginx.conf) allows it.
 * UX-12 adds the accent colour the same way: a stored choice goes on <html data-accent> (Neutral,
 * the default, sets nothing). A stored value that is not in the list is ignored.
 * Keep the keys and values in sync with src/lib/theme.ts and src/lib/accent.ts.
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
  try {
    // The Tavern palette (src/lib/look.ts): a stored choice goes on <html data-palette>.
    if (window.localStorage.getItem("atlas-palette") === "tavern") {
      document.documentElement.setAttribute("data-palette", "tavern");
    }
  } catch (e) {
    // Storage unavailable: the default palette.
  }
  try {
    var accent = window.localStorage.getItem("atlas-accent");
    var accents = ["blue", "indigo", "violet", "pink", "red", "orange", "amber", "green", "teal"];
    if (accents.indexOf(accent) !== -1) {
      document.documentElement.setAttribute("data-accent", accent);
      // Headings follow a non-neutral accent unless the viewer turned that off (UX-12).
      if (window.localStorage.getItem("atlas-accent-headings") !== "off") {
        document.documentElement.setAttribute("data-accent-text", "on");
      }
    }
  } catch (e) {
    // Storage unavailable: Neutral.
  }
})();
