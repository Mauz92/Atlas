/**
 * The reminder simulation (M8-04b-ii; docs/TESTING.md 12.2): real sync-core clients and real
 * reminder-core schedulers on a model server that derives the `reminder` entity, with faults.
 * `ATLAS_SYNC_SEEDS`/`ATLAS_SYNC_STEPS` scale it, `ATLAS_SYNC_SEED` re-runs one seed.
 */
import { ModelServer } from "./model/server.ts";
import { envInt, runWorld } from "./run.ts";
import { HOUR } from "./reminderDevice.ts";
import { REMINDER_BASE } from "./reminderConfig.ts";
import type { SimConfig } from "./world.ts";

const SEEDS = envInt("ATLAS_SYNC_SEEDS", 12);
const STEPS = envInt("ATLAS_SYNC_STEPS", 120);
const ONE = process.env["ATLAS_SYNC_SEED"];
/** The secondary scenarios run a fifth of the seeds of the main one when the soak scales it up. */
const SECONDARY = Math.max(12, Math.ceil(SEEDS / 5));
const seeds = (from: number, count = SEEDS) => (ONE ? [Number(ONE)] : Array.from({ length: count }, (_, i) => from + i));

const BASE = REMINDER_BASE;

async function many(from: number, config: Partial<SimConfig>, count?: number) {
  const totals = { shown: 0, taps: 0, actions: 0, lateSnoozes: 0, backfills: 0, restarts: 0, reminders: 0, redates: 0, reboots: 0 };
  for (const seed of seeds(from, count)) {
    const server = new ModelServer({}, { reminders: true });
    const world = await runWorld(seed, server, { steps: STEPS, ...BASE, ...config });
    for (const c of world.clients) {
      totals.shown += c.device!.os.history.length;
      totals.taps += c.device!.taps.size;
      totals.redates += c.device!.redates.length;
    }
    totals.actions += server.actions.size;
    totals.lateSnoozes += [...server.actions.values()].filter(
      (a) => a.kind === "snooze" && a.applied && a.actedAtSent !== null && a.serverNow - a.actedAtSent > HOUR / 6,
    ).length;
    totals.reminders += server.reminders.size;
    totals.restarts += world.trace.filter((l) => l.includes("RESTART")).length;
    totals.reboots += world.trace.filter((l) => l.includes("OS reboot")).length;
    totals.backfills += world.rec.logLines.filter((l) => l.event === "types_backfilled").length;
  }
  return totals;
}

describe("reminders on the model server", () => {
  it("devices fire, dismiss, snooze and re-date correctly under faults, restarts and reboots", async () => {
    const t = await many(0, {});
    expect(t.shown).toBeGreaterThan(40);
    expect(t.taps).toBeGreaterThan(10);
    expect(t.actions).toBeGreaterThan(10);
    expect(t.redates).toBeGreaterThan(10);
    expect(t.restarts).toBeGreaterThan(0);
    expect(t.reboots).toBeGreaterThan(0);
  });

  it("a snooze made offline counts from the tap: some actions really arrive late (R-68)", async () => {
    const t = await many(100, { pToggleOnline: 0.1 }, SECONDARY);
    expect(t.lateSnoozes).toBeGreaterThan(0);
  });

  it("an upgrade adds the reminder type to clients with a cursor: it is backfilled without a resync (G7)", async () => {
    const t = await many(200, { reminderUpgrade: true, clients: 4 }, SECONDARY);
    expect(t.backfills).toBeGreaterThan(0);
    expect(t.shown).toBeGreaterThan(10);
  });

  it("a late joiner snapshots the reminders while retention purges the feed", async () => {
    await many(300, { lateJoiner: true, pPurge: 0.1, kinds: ["task", "project"] }, SECONDARY);
  });

  it("a revoked device stops cleanly with reminders on", async () => {
    await many(400, { revokeClient: "c2" }, SECONDARY);
  });
});

describe("determinism", () => {
  it("the same seed gives the same trace and the same notifications", async () => {
    const cfg: Partial<SimConfig> = { ...BASE, steps: 80 };
    const a = await runWorld(7, new ModelServer({}, { reminders: true }), cfg);
    const b = await runWorld(7, new ModelServer({}, { reminders: true }), cfg);
    expect(b.trace).toEqual(a.trace);
    expect(b.clients.map((c) => c.device!.os.history.map((h) => h.key))).toEqual(a.clients.map((c) => c.device!.os.history.map((h) => h.key)));
  });
});
