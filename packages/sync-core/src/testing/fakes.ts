import type { Clock, IdGenerator, Logger, LogFields, Random } from "../ports.ts";

/** A clock that only moves when a test says so. */
export function fixedClock(start = 0): Clock & { advance(ms: number): void; wall: number } {
  const clock = {
    t: start,
    wall: 1_700_000_000_000,
    monotonic() {
      return this.t;
    },
    wallTime() {
      return this.wall;
    },
    advance(ms: number) {
      this.t += ms;
      this.wall += ms;
    },
  };
  return clock;
}

/** mulberry32: a small deterministic PRNG. */
export function seededRandom(seed: number): Random & { int(max: number): number } {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (max) => Math.floor(next() * max) };
}

/** Deterministic UUID-shaped ids drawn from a seeded stream. */
export function sequenceIds(seed: number): IdGenerator {
  const rng = seededRandom(seed);
  return {
    uuid() {
      const hex = (n: number) =>
        Array.from({ length: n }, () => Math.floor(rng.next() * 16).toString(16)).join("");
      const variant = "89ab"[Math.floor(rng.next() * 4)]!;
      return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
    },
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface LogLine {
  level: string;
  event: string;
  fields: LogFields;
}

export function recordingLogger(): Logger & { lines: LogLine[] } {
  const lines: LogLine[] = [];
  const log = (level: string) => (event: string, fields: LogFields = {}) =>
    void lines.push({ level, event, fields });
  return {
    lines,
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
}
