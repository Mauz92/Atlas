import type { Random } from "./ports.ts";

export interface BackoffOptions {
  /** First delay ceiling in ms (SYNC_PROTOCOL 8.2: 2 s). */
  baseMs: number;
  factor: number;
  /** Ceiling (5 min). */
  capMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 2_000, factor: 2, capMs: 300_000 };

/**
 * Exponential backoff with full jitter: a uniform delay in `[0, min(cap, base * factor^(n-1))]`
 * for the n-th consecutive failure (n >= 1). Bounded by construction.
 */
export function backoffDelay(failures: number, random: Random, options: BackoffOptions): number {
  const n = Math.max(1, Math.floor(failures));
  const ceiling = Math.min(options.capMs, options.baseMs * Math.pow(options.factor, n - 1));
  return Math.floor(random.next() * (ceiling + 1));
}

/** `Retry-After` in seconds (delta) or an HTTP date; returns ms, `null` if absent or unusable. */
export function parseRetryAfter(value: string | undefined, nowWallMs: number): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Math.min(Number(trimmed) * 1000, 3_600_000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - nowWallMs), 3_600_000);
}
