/**
 * Style palette store. "default" is the neutral Atlas look (nothing stored, no attribute);
 * "tavern" is the warm parchment-and-oxblood look first built for the TTRPG area. It only changes
 * colour and heading type through `src/tavern.css` (tokens under `<html data-palette="tavern">`), and
 * follows the Theme setting (light = parchment, dark = lamplit wood). Remembered in this browser only.
 * `public/theme-init.js` applies a stored choice before first paint and must keep the same key/values.
 */
export type PaletteId = "default" | "tavern";

export const PALETTE_STORAGE_KEY = "atlas-palette";
export const PALETTES: readonly { id: PaletteId; label: string; description: string }[] = [
  { id: "default", label: "Neutral", description: "The calm black-and-white look." },
  { id: "tavern", label: "Tavern", description: "Warm parchment and oxblood, brass and a serif for headings." },
];

const EVENT = "atlas-palette-change";

function isPalette(value: unknown): value is PaletteId {
  return value === "default" || value === "tavern";
}

export function readPalette(): PaletteId {
  try {
    const stored = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (isPalette(stored)) return stored;
  } catch {
    // fall through to the default
  }
  return "default";
}

function paint(palette: PaletteId): void {
  const root = document.documentElement;
  if (palette === "default") delete root.dataset.palette;
  else root.dataset.palette = palette;
}

export function applyPalette(palette: PaletteId): void {
  if (!isPalette(palette)) return;
  try {
    if (palette === "default") localStorage.removeItem(PALETTE_STORAGE_KEY);
    else localStorage.setItem(PALETTE_STORAGE_KEY, palette);
  } catch {
    // the choice still applies for this page view
  }
  paint(palette);
  window.dispatchEvent(new Event(EVENT));
}

export function syncPalette(): void {
  paint(readPalette());
}

export function subscribePalette(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PALETTE_STORAGE_KEY) {
      syncPalette();
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
