/**
 * When the person last looked at "changes from other devices" (a per-browser convenience, never
 * required: storage may be missing or blocked, and then the last 7 days are offered again).
 */
const KEY = "atlas.changes.seenAt";
const FALLBACK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function seenSince(now: number = Date.now()): number {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value = raw === null ? NaN : Number(raw);
    if (Number.isFinite(value)) return value;
  } catch {
    // fall through
  }
  return now - FALLBACK_WINDOW_MS;
}

export function markChangesSeen(now: number = Date.now()): void {
  try {
    window.localStorage.setItem(KEY, String(now));
  } catch {
    // a blocked store only means the banner may show again
  }
}
