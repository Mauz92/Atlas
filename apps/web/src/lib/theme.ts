export type Theme = "light" | "dark";

const STORAGE_KEY = "atlas-theme";
const EVENT = "atlas-theme-change";

/** The stored theme, else the system preference. Storage may be unavailable (private mode). */
export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // fall through to the system preference
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Apply and remember a theme; every subscriber (the toggle button, the palette) is notified. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // the choice still applies for this page view
  }
  window.dispatchEvent(new Event(EVENT));
}

export function toggleTheme(): void {
  applyTheme(readTheme() === "dark" ? "light" : "dark");
}

export function subscribeTheme(callback: () => void): () => void {
  window.addEventListener(EVENT, callback);
  return () => window.removeEventListener(EVENT, callback);
}
