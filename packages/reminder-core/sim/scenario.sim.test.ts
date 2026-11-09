import { runWorld } from "./world.ts";

const SEEDS = Number(process.env["ATLAS_REMINDER_SEEDS"] ?? 40);
const STEPS = Number(process.env["ATLAS_REMINDER_STEPS"] ?? 120);
const ONLY = process.env["ATLAS_REMINDER_SEED"];

describe("reminder simulation: invariants hold across random multi-device runs", () => {
  const seeds = ONLY ? [Number(ONLY)] : Array.from({ length: SEEDS }, (_, i) => i);
  it(`${seeds.length} seeds x ${STEPS} steps`, async () => {
    for (const seed of seeds) await runWorld(seed, { steps: STEPS });
  }, 600_000);
});
