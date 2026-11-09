import type { PlantedBugs } from "../src/engine.ts";
import { checkIdempotence, checkInvariants } from "./invariants.ts";
import { checkReminderQuiescent, reminderSweep } from "./reminderInvariants.ts";
import { DEFAULT_CONFIG, World, type SimConfig } from "./world.ts";
import type { ServerPort } from "./engineBridge.ts";

export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  return raw ? Number(raw) : fallback;
}

/** Run one seed: a faulty phase, a fault-free quiescence, optionally an undo wave, then the invariants. */
export async function runWorld(
  seed: number,
  server: ServerPort,
  config: Partial<SimConfig> = {},
  bugs: PlantedBugs = {},
  options: { invariants?: boolean } = {},
): Promise<World> {
  const world = new World(seed, { ...DEFAULT_CONFIG, ...config }, server, bugs);
  await world.faultyPhase();
  await world.quiesce();
  if (world.cfg.resolutions && world.cfg.undoRounds) {
    await world.undoWave();
    await world.quiesce();
  }
  if (options.invariants !== false) {
    await checkInvariants(world);
    await checkIdempotence(world);
    if (world.cfg.reminders) {
      await checkReminderQuiescent(world);
      await reminderSweep(world);
    }
  }
  return world;
}
