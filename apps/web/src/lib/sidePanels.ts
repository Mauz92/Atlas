/**
 * What the right-hand sidebar of a campaign or a fight shows (rules, a campaign note, the party
 * sheet), remembered per browser. Storage can be missing or throw, so the sidebar works without it.
 */
export type PanelKind = "rules" | "note" | "party";

export interface PanelConfig {
  id: string;
  kind: PanelKind;
  /** for a `note` panel: the note it shows */
  noteId?: string;
}

const KEY = "atlas-ttrpg-sidebar";
const KINDS: readonly string[] = ["rules", "note", "party"];
export const DEFAULT_PANELS: PanelConfig[] = [{ id: "rules", kind: "rules" }];

export function readPanels(): PanelConfig[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_PANELS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_PANELS;
    const clean = parsed.filter(
      (item): item is PanelConfig =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as PanelConfig).id === "string" &&
        KINDS.includes((item as PanelConfig).kind) &&
        ((item as PanelConfig).noteId === undefined || typeof (item as PanelConfig).noteId === "string"),
    );
    return clean.slice(0, 8);
  } catch {
    return DEFAULT_PANELS;
  }
}

export function writePanels(panels: PanelConfig[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(panels));
  } catch {
    // not remembered; the sidebar still works for this visit
  }
}

export function newPanelId(): string {
  return `p${Math.random().toString(36).slice(2, 9)}`;
}
