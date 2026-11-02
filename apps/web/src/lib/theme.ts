/**
 * Theme store (MU-08, extended in UX-01).
 *
 * The viewer chooses System (the default), Light or Dark. Only an explicit choice is stored and
 * written to `<html data-theme>`; System removes both, so the CSS `prefers-color-scheme` rules in
 * `styles.css` follow the operating system live. `public/theme-init.js` applies a stored choice
 * before first paint (no light flash, also on the login and setup screens); it must keep using the
 * same storage key and values as this module.
 */
export type Theme = "light" | "dark";
export type ThemePreference = "system" | Theme;

export const THEME_STORAGE_KEY = "atlas-theme";
export const THEME_PREFERENCES: readonly ThemePreference[] = ["system", "light", "dark"];

const EVENT = "atlas-theme-change";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** The stored choice; anything missing, unknown or unreadable (private mode) means System. */
export function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
  } catch {
    // fall through to the system preference
  }
  return "system";
}

/** The operating system's theme, light when it cannot be read. */
export function systemTheme(): Theme {
  return window.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** The theme actually shown: the explicit choice, else the system's. */
export function readTheme(): Theme {
  const preference = readThemePreference();
  return preference === "system" ? systemTheme() : preference;
}

/** Apply and remember a choice; every subscriber (toggle button, palette, Settings) is notified. */
export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  try {
    if (preference === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // the choice still applies for this page view
  }
  if (preference === "system") {
    delete root.dataset.theme;
  } else {
    root.dataset.theme = preference;
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Switch to the opposite of what is shown now; the result is an explicit choice. */
export function toggleTheme(): void {
  applyTheme(readTheme() === "dark" ? "light" : "dark");
}

/** Notified on a choice made in this page and when the system theme changes. */
export function subscribeTheme(callback: () => void): () => void {
  window.addEventListener(EVENT, callback);
  const media = window.matchMedia?.(DARK_QUERY);
  media?.addEventListener?.("change", callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    media?.removeEventListener?.("change", callback);
  };
}
