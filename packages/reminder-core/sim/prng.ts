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

/** mulberry32: a small seeded stream; `label` derives independent streams from one run seed. */
export function rng(seed: number, label = ""): Rng {
  let a = hashSeed(`${seed}:${label}`);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (max) => Math.floor(next() * max),
    range: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (items) => items[Math.floor(next() * items.length)]!,
  };
}
