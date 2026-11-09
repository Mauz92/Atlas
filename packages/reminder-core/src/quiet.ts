import type { Clock } from "./ports.ts";
import type { QuietHours } from "./types.ts";

const MINUTE = 60_000;

/** Minutes after local midnight at `atMs`, using the device zone's offset at that instant. */
export function localMinute(clock: Clock, atMs: number): number {
  const local = Math.floor(atMs / MINUTE) + clock.utcOffsetMinutes(atMs);
  return ((local % 1440) + 1440) % 1440;
}

export function inQuietHours(clock: Clock, quiet: QuietHours | null, atMs: number): boolean {
  if (!quiet || quiet.startMinute === quiet.endMinute) return false;
  const m = localMinute(clock, atMs);
  return quiet.startMinute < quiet.endMinute
    ? m >= quiet.startMinute && m < quiet.endMinute
    : m >= quiet.startMinute || m < quiet.endMinute;
}

/**
 * The first instant at or after `atMs` outside the window: `atMs` itself when it is not inside.
 * Found by stepping a minute at a time (at most a day), so DST jumps in the device zone cannot
 * produce a wrong answer; a reminder is deferred, never dropped.
 */
export function afterQuietHours(clock: Clock, quiet: QuietHours | null, atMs: number): number {
  if (!inQuietHours(clock, quiet, atMs)) return atMs;
  let t = Math.floor(atMs / MINUTE) * MINUTE;
  for (let i = 0; i < 24 * 60 + 61; i++) {
    t += MINUTE;
    if (!inQuietHours(clock, quiet, t)) return t;
  }
  return atMs; // unreachable for a window shorter than 24 h
}
