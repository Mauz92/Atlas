/**
 * Conformance and simulation against the REAL API (docs/TESTING.md 10.1 layer C). Opt-in:
 * `ATLAS_SYNC_REAL=1 npm --prefix packages/sync-core run test:real`. It needs the API virtualenv
 * (`services/api/.venv`), PostgreSQL on 127.0.0.1:5432 and the `atlas-db-1` container (psql is not
 * on the host). It uses a throwaway database `atlas_e2e_<random>` only.
 */
import { ModelServer } from "../model/server.ts";
import { envInt, runWorld } from "../run.ts";
import { runScenario } from "../scenario.ts";
import { runReminderScenario } from "../reminderScenario.ts";
import { RealServer, startStack, type Stack } from "./stack.ts";

const enabled = process.env["ATLAS_SYNC_REAL"] === "1";
const SEEDS = envInt("ATLAS_SYNC_REAL_SEEDS", 3);
const STEPS = envInt("ATLAS_SYNC_STEPS", 100);

describe.skipIf(!enabled)("real API", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  }, 120_000);
  afterAll(async () => {
    await stack?.stop();
  }, 60_000);

  async function fresh(devices: string[]): Promise<RealServer> {
    const server = new RealServer(stack);
    await server.setupOwner().catch(() => undefined);
    for (const cid of devices) await server.addDevice(cid);
    return server;
  }

  it("conformance: the scripted scenario gives the same outcomes on the model and on the real API", async () => {
    const real = await fresh(["A", "B"]);
    const onReal = await runScenario(real);
    const onModel = await runScenario(new ModelServer());
    expect(onReal).toEqual(onModel);
  }, 120_000);

  it("conformance: the reminder entity, actions and acted_at behave the same on the model and on the real API", async () => {
    const own = await startStack();
    try {
      const real = new RealServer(own);
      await real.setupOwner();
      await real.setReminderDefault();
      for (const cid of ["A", "B"]) await real.addDevice(cid);
      const onReal = await runReminderScenario(real);
      const onModel = await runReminderScenario(new ModelServer({}, { reminders: true, clock: () => Date.now() }));
      expect(onReal).toEqual(onModel);
      expect(onReal.length).toBeGreaterThan(10);
    } finally {
      await own.stop();
    }
  }, 180_000);

  it("clients with schedulers converge on the real API and nothing stale or lost is shown (reminders)", async () => {
    for (let seed = 0; seed < Math.max(2, Math.floor(SEEDS / 2)); seed++) {
      const own = await startStack();
      try {
        const real = new RealServer(own);
        await real.setupOwner();
        await real.setReminderDefault();
        for (const cid of ["c1", "c2", "c3"]) await real.addDevice(cid);
        await runWorld(seed, real, { steps: STEPS, kinds: ["task"], reminders: true, realClock: true, timeout: 400 });
      } finally {
        await own.stop();
      }
    }
  }, 900_000);

  it("clients converge on the real API (tasks, projects, notes, resolutions, undo)", async () => {
    // one user per database: every seed reuses the owner and the entities of earlier seeds, so the
    // invariants that count entities (no_duplicates) run on a fresh database per seed instead
    for (let seed = 0; seed < SEEDS; seed++) {
      const own = await startStack();
      try {
        const real = new RealServer(own);
        await real.setupOwner();
        for (const cid of ["c1", "c2", "c3"]) await real.addDevice(cid);
        await runWorld(seed, real, { steps: STEPS, kinds: ["task", "project", "note"], resolutions: true, timeout: 400 });
      } finally {
        await own.stop();
      }
    }
  }, 600_000);

  it("a revoked device stops at the first 401 and is never served again", async () => {
    const own = await startStack();
    try {
      const real = new RealServer(own);
      await real.setupOwner();
      for (const cid of ["c1", "c2", "c3"]) await real.addDevice(cid);
      await runWorld(1, real, { steps: STEPS, kinds: ["task", "project", "note"], resolutions: true, revokeClient: "c2", timeout: 400 });
    } finally {
      await own.stop();
    }
  }, 300_000);
});
