/**
 * Per-browser preferences of the Notes workspace (UX-05). Storage can be missing or blocked, so
 * every access is guarded and the page works without it.
 */
const PANEL_KEY = "atlas-notes-panel";
const PREVIEW_KEY = "atlas-notes-preview";
const MODE_KEY = "atlas-notes-mode";

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

/** Source shows the Markdown as typed; Live hides the syntax on lines without the cursor (UX-06). */
export type EditorMode = "source" | "live";

/** The mode a note opens in when the person has not chosen one (ADR-0051 section 5, ADR-0056). */
export const DEFAULT_EDITOR_MODE: EditorMode = "live";

export function readEditorMode(): EditorMode {
  const value = read(MODE_KEY);
  return value === "source" || value === "live" ? value : DEFAULT_EDITOR_MODE;
}

export function writeEditorMode(mode: EditorMode) {
  write(MODE_KEY, mode);
}
