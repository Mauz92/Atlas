/**
 * The multi-client simulation (docs/TESTING.md 10) with the DESKTOP store: every client's durable
 * store is the per-row SQLite adapter over the row port (`SqliteLocalStore` + `FakeRowDb`), so the
 * engine's invariants (convergence, cursor safety, idempotent retries, no lost writes) are judged on
 * the store the desktop app ships, under dropped and duplicated requests, restarts, clock jumps and
 * "kill -9 between the statements of a transaction" (`pStoreCrash`, which loses the whole commit).
 *
 * A planted defect (a database that commits each row on its own, so a page and its cursor are no longer
 * atomic) must FAIL the same invariants: proof that the simulation can see what the store exists to prevent.
 */
import { ModelServer } from "../../sync-core/sim/model/server.ts";
import { envInt, runWorld } from "../../sync-core/sim/run.ts";
import { REMINDER_BASE } from "../../sync-core/sim/reminderConfig.ts";
import type { SimConfig } from "../../sync-core/sim/world.ts";
import type { DbOp, RowDb } from "../src/ports.ts";
import { DesktopSimStore } from "../src/testing/index.ts";

const SEEDS = envInt("ATLAS_DESKTOP_SEEDS", 10);
const STEPS = envInt("ATLAS_DESKTOP_STEPS", 120);
const ONE = process.env["ATLAS_DESKTOP_SEED"];
const seeds = (from: number, count = SEEDS) => (ONE ? [Number(ONE)] : Array.from({ length: count }, (_, i) => from + i));
const desktop: Partial<SimConfig> = { storeFactory: () => new DesktopSimStore() };

describe("clients on the desktop SQLite store converge under faults (model server)", () => {
  it("tasks, projects and notes with resolutions, four clients, store crashes", async () => {
    let restarts = 0;
    for (const seed of seeds(1000)) {
      const world = await runWorld(seed, new ModelServer(), { steps: STEPS, kinds: ["task", "project", "note"], resolutions: true, clients: 4, pStoreCrash: 0.05, ...desktop });
      restarts += world.trace.filter((l) => l.includes("RESTART")).length;
    }
    expect(restarts).toBeGreaterThan(0);
  });

  it("a late joiner bootstraps from a snapshot while retention purges the feed", async () => {
    for (const seed of seeds(1100, Math.max(4, SEEDS / 2))) {
      await runWorld(seed, new ModelServer(), { steps: STEPS, kinds: ["task", "project", "note"], lateJoiner: true, pPurge: 0.1, ...desktop });
    }
  });

  it("sync-core reminders and the device scheduler on the desktop store (reminder entity, queued actions, upgrade backfill)", async () => {
    let shown = 0;
    for (const seed of seeds(1200, Math.max(6, SEEDS))) {
      const world = await runWorld(seed, new ModelServer({}, { reminders: true }), { steps: STEPS, ...REMINDER_BASE, reminderUpgrade: seed % 2 === 0, ...desktop });
      for (const c of world.clients) shown += c.device!.os.history.length;
    }
    expect(shown).toBeGreaterThan(5);
  });
});

/** A database that applies every row of a batch as its own commit: "apply the page, then store the cursor" is no longer atomic. */
function nonAtomic(db: RowDb): RowDb {
  return {
    open: () => db.open(),
    get: (t, k) => db.get(t, k),
    list: (t) => db.list(t),
    async commit(ops: DbOp[]) {
      for (const op of ops) await db.commit([op]);
    },
  };
}

describe("planted defect: a store without an atomic page+cursor commit", () => {
  it("is caught by the invariants", async () => {
    let caught = 0;
    for (const seed of seeds(1300, 16)) {
      try {
        await runWorld(seed, new ModelServer(), {
          steps: STEPS,
          kinds: ["task", "project", "note"],
          pStoreCrash: 0.25,
          storeFactory: () => new DesktopSimStore(nonAtomic),
        });
      } catch {
        caught++;
      }
    }
    expect(caught).toBeGreaterThan(0);
  });
});
