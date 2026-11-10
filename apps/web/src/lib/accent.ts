/**
 * Accent colour store (UX-12, ADR-0073).
 *
 * The viewer chooses one accent from a curated palette; Neutral (the default, ADR-0051) is the
 * absence of a choice. Only an explicit non-neutral choice is stored (`localStorage`, this device
 * only) and written to `<html data-accent>`; Neutral removes both, so the base tokens in
 * `styles.css` apply. The CSS defines each accent for Light, System-dark and Dark, so the accent
 * follows the Theme setting without any work here. `public/theme-init.js` applies a stored choice
 * before first paint; it must keep the same storage key and ids as this module.
 */
export type AccentId =
  | "neutral"
  | "blue"
  | "indigo"
  | "violet"
  | "pink"
  | "red"
  | "orange"
  | "amber"
  | "green"
  | "teal";

export const ACCENT_STORAGE_KEY = "atlas-accent";
/** Only an explicit "off" is stored: coloured headings are on by default (and do nothing for Neutral). */
export const HEADINGS_STORAGE_KEY = "atlas-accent-headings";
export const DEFAULT_ACCENT: AccentId = "neutral";

/**
 * The palette, in display order. The colours live in `styles.css` (one set of tokens per accent
 * and theme, plus a `--swatch-<id>` sample colour for the picker's dots); the picker names every
 * swatch in text, so colour is never the only cue.
 */
export const ACCENTS: readonly { id: AccentId; label: string }[] = [
  { id: "neutral", label: "Neutral" },
  { id: "blue", label: "Blue" },
  { id: "indigo", label: "Indigo" },
  { id: "violet", label: "Violet" },
  { id: "pink", label: "Pink" },
  { id: "red", label: "Red" },
  { id: "orange", label: "Orange" },
  { id: "amber", label: "Amber" },
  { id: "green", label: "Green" },
  { id: "teal", label: "Teal" },
];

const EVENT = "atlas-accent-change";

function isAccent(value: unknown): value is AccentId {
  return typeof value === "string" && ACCENTS.some((accent) => accent.id === value);
}

/** The stored accent; anything missing, unknown or unreadable (private mode) means Neutral. */
export function readAccent(): AccentId {
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY);
    if (isAccent(stored)) {
      return stored;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_ACCENT;
}

/** The viewer's choice to colour headings with the accent; on unless explicitly turned off. */
export function readAccentHeadings(): boolean {
  try {
    return localStorage.getItem(HEADINGS_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * Write the attributes: `data-accent` for a non-neutral accent, and `data-accent-text="on"` only when
 * headings are to follow a non-neutral accent (Neutral has no accent colour to lend, so it is never set).
 */
function paint(accent: AccentId): void {
  const root = document.documentElement;
  if (accent === DEFAULT_ACCENT) {
    delete root.dataset.accent;
    delete root.dataset.accentText;
  } else {
    root.dataset.accent = accent;
    if (readAccentHeadings()) {
      root.dataset.accentText = "on";
    } else {
      delete root.dataset.accentText;
    }
  }
}

/** Apply and remember an accent; every subscriber (the picker) is notified. An unknown id is ignored. */
export function applyAccent(accent: AccentId): void {
  if (!isAccent(accent)) {
    return;
  }
  try {
    if (accent === DEFAULT_ACCENT) {
      localStorage.removeItem(ACCENT_STORAGE_KEY);
    } else {
      localStorage.setItem(ACCENT_STORAGE_KEY, accent);
    }
  } catch {
    // the choice still applies for this page view
  }
  paint(accent);
  window.dispatchEvent(new Event(EVENT));
}

/** Apply and remember whether headings follow the accent; subscribers are notified. */
export function applyAccentHeadings(on: boolean): void {
  try {
    if (on) {
      localStorage.removeItem(HEADINGS_STORAGE_KEY);
    } else {
      localStorage.setItem(HEADINGS_STORAGE_KEY, "off");
    }
  } catch {
    // the choice still applies for this page view
  }
  paint(readAccent());
  window.dispatchEvent(new Event(EVENT));
}

/** Make the page match the stored choice (a stale or invalid attribute is corrected). */
export function syncAccent(): void {
  paint(readAccent());
}

/** Notified on a choice made in this page and on a change made in another tab (`storage`). */
export function subscribeAccent(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ACCENT_STORAGE_KEY || event.key === HEADINGS_STORAGE_KEY) {
      syncAccent();
      callback();
    }
  };
  window.addEventListener(EVENT, callback);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener("storage", onStorage);
  };
}
