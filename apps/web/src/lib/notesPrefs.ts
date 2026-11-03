/**
 * Per-browser preferences of the Notes workspace (UX-05). Storage can be missing or blocked, so
 * every access is guarded and the page works without it.
 */
const PANEL_KEY = "atlas-notes-panel";
const PREVIEW_KEY = "atlas-notes-preview";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** `true`/`false` once the person has chosen, else `null` (the page picks by screen width). */
export function readPanelOpen(): boolean | null {
  const value = read(PANEL_KEY);
  return value === "open" ? true : value === "closed" ? false : null;
}

export function writePanelOpen(open: boolean) {
  write(PANEL_KEY, open ? "open" : "closed");
}

export function readPreview(): boolean {
  return read(PREVIEW_KEY) === "on";
}

export function writePreview(on: boolean) {
  write(PREVIEW_KEY, on ? "on" : "off");
}
