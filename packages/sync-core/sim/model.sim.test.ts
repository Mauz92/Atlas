/**
 * Layer B (docs/TESTING.md 10): N real sync-core clients on a model server, seeded, with faults.
 * Defaults are small; `ATLAS_SYNC_SEEDS`/`ATLAS_SYNC_STEPS` scale them (soak), `ATLAS_SYNC_SEED`
 * re-runs one seed (every failure prints its seed).
 */
import { ModelServer } from "./model/server.ts";
import { envInt, runWorld } from "./run.ts";
import { checkInvariants } from "./invariants.ts";
import { DEFAULT_CONFIG, World, type SimConfig } from "./world.ts";

const SEEDS = envInt("ATLAS_SYNC_SEEDS", 12);
const STEPS = envInt("ATLAS_SYNC_STEPS", 120);
const ONE = process.env["ATLAS_SYNC_SEED"];
const seeds = (from: number, count = SEEDS) =>
  ONE ? [Number(ONE)] : Array.from({ length: count }, (_, i) => from + i);

async function many(from: number, config: Partial<SimConfig>, count?: number) {
  const totals = { acks: 0, refusals: 0, merges: 0, revives: 0, copies: 0, resolutions: 0, undos: 0, restarts: 0 };
  for (const seed of seeds(from, count)) {
    const server = new ModelServer();
    const world = await runWorld(seed, server, { steps: STEPS, ...config });
    totals.acks += world.rec.acks.length;
    totals.refusals += world.rec.refusals.length;
    totals.merges += server.history.filter((e) => e.event === "merge").length;
    totals.revives += server.history.filter((e) => e.event === "revive").length;
    totals.copies += world.rec.conflictCopies.length;
    totals.resolutions += server.generated;
    totals.undos += world.rec.undos.length;
    totals.restarts += world.trace.filter((l) => l.includes("RESTART")).length;
  }
  return totals;
}

describe("clients converge under faults (model server)", () => {
  it("tasks and projects", async () => {
    const t = await many(0, { kinds: ["task", "project"] }, SEEDS * 2);
    expect(t.acks).toBeGreaterThan(100);
    expect(t.refusals).toBeGreaterThan(0);
  });

  it("tasks, projects and notes with resolutions and undo, four clients", async () => {
    const t = await many(100, { kinds: ["task", "project", "note"], resolutions: true, clients: 4 });
    // the scenario really produces what the invariants are about
    expect(t.merges + t.revives + t.copies).toBeGreaterThan(0);
    expect(t.resolutions).toBeGreaterThan(0);
    expect(t.restarts).toBeGreaterThan(0);
  });

  it("a late joiner bootstraps from a snapshot while retention purges the feed", async () => {
    await many(200, { kinds: ["task", "project", "note"], resolutions: true, lateJoiner: true, pPurge: 0.1 });
  });

  it("an unsupported client stops at the first 426 and writes nothing", async () => {
    await many(300, { kinds: ["task", "project", "note"], oldClient: true });
  });

  it("a revoked device stops at the first 401 and is never served again", async () => {
    await many(400, { kinds: ["task", "project", "note"], resolutions: true, revokeClient: "c2" });
  });

  it("notes only, with frequent client crashes in the middle of a transaction", async () => {
    await many(500, { kinds: ["note"], pStoreCrash: 0.06, pRestart: 0.06 });
  });
});

describe("determinism and clocks", () => {
  const cfg: Partial<SimConfig> = { steps: 80, kinds: ["task", "project", "note"], resolutions: true };

  it("the same seed gives the same trace", async () => {
    const a = await runWorld(7, new ModelServer(), cfg);
    const b = await runWorld(7, new ModelServer(), cfg);
    expect(b.trace).toEqual(a.trace);
  });

  it("clock skew changes nothing: the final server state is identical with and without it", async () => {
    for (const seed of seeds(600, 8)) {
      const withSkew = new ModelServer();
      const without = new ModelServer();
      await runWorld(seed, withSkew, { ...cfg, skew: true });
      await runWorld(seed, without, { ...cfg, skew: false });
      expect(withSkew.canonical()).toEqual(without.canonical());
    }
  });
});

describe("restore of the server (D12)", () => {
  it("clients stop, wait for confirmation, then adopt the restored server and re-create what it lost", async () => {
    let stopped = 0;
    for (const seed of seeds(700, 6)) {
      const server = new ModelServer();
      const world = new World(seed, { ...DEFAULT_CONFIG, steps: 90, kinds: ["task", "project", "note"], clients: 3 }, server);
      let backup: ModelServer | null = null;
      await world.faultyPhase({
        onStep: async (step) => {
          if (step === 30) backup = server.snapshot();
          if (step === 60 && backup) {
            server.restoreFrom(backup);
            world.restored = true;
            server.rotateEpoch();
            world.trace.push(`t=${world.events.now} OPERATOR restores the server from a backup and rotates the epoch`);
          }
        },
      });
      await world.quiesce(); // halted clients are done: they wait for a person
      const waiting = world.clients.filter((c) => c.engine.debug().halted?.kind === "restore_confirmation");
      for (const client of waiting) {
        const sent = client.sentTotal();
        await world.quiesce();
        expect(client.sentTotal()).toBe(sent); // nothing is sent while it waits
      }
      stopped += waiting.length;
      for (const client of waiting) await client.engine.confirmRestore();
      await world.quiesce();
      for (const client of world.clients) expect(client.engine.debug().halted).toBeNull();
      await checkRestoredConvergence(world);
    }
    expect(stopped).toBeGreaterThan(0); // the scenario really stops clients
  });
});

async function checkRestoredConvergence(world: World): Promise<void> {
  const { serverTruth } = await import("./invariants.ts");
  const truth = await serverTruth(world);
  for (const client of world.clients) {
    const state = client.store.peek();
    for (const [id, want] of truth) {
      const local = state.entities.get(id);
      if (!local || local.deleted || !local.server || local.server.revision !== want.revision)
        throw world.fail("convergence", `${client.cid} disagrees about ${id} after the restore`);
    }
    for (const e of state.entities.values())
      if (!e.deleted && e.server && !truth.has(e.id))
        throw world.fail("convergence", `${client.cid} still shows ${e.id} after the restore`);
  }
  void checkInvariants;
}
