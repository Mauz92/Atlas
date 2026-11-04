import { seededRandom } from "../src/testing/fakes.ts";

export interface Rng {
  next(): number;
  int(maxExclusive: number): number;
  range(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

function hashSeed(label: string): number {
  let h = 2166136261;
  for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A seeded stream; `label` derives independent streams from one run seed. */
export function rng(seed: number, label = ""): Rng {
  const base = seededRandom(hashSeed(`${seed}:${label}`));
  return {
    next: base.next,
    int: (max) => Math.floor(base.next() * max),
    range: (lo, hi) => lo + Math.floor(base.next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(base.next() * items.length)]!,
  };
}
