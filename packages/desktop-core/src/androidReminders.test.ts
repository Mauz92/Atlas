import { SyncEngine } from "../../sync-core/src/index.ts";
import { ModelServer } from "../../sync-core/sim/model/server.ts";
import { DesktopRuntime } from "./runtime.ts";
import { SqliteLocalStore } from "./sqliteStore.ts";
import { createPortTransport } from "./transport.ts";
import { createFakePlatform, FakeRowDb, modelHttp, type FakePlatform } from "./testing/index.ts";

const HOUR = 3_600_000;

/** Android: the OS fires the alarms, also with the app closed (ADR-0075). The same runtime, an `alarms` port, a fake OS. */
function rig(options: { exactAlarms?: boolean } = {}) {
  const p = createFakePlatform(31, { android: true }) as FakePlatform;
  const alarms = p.alarms!;
  if (options.exactAlarms === false) alarms.statusValue = { ...alarms.statusValue, exactAlarms: false };
  const server = new ModelServer({}, { reminders: true, clock: () => p.timers.wall });
  p.http.handler = (req) => modelHttp(server).request(req);
  const rt = new DesktopRuntime(p, { tickMs: 1000, schedulerTickMs: 30_000, fullScanMs: 5 * 60_000, liveWaitSeconds: 25, debounceMs: 50 });
  return { p, alarms, server, rt };
}

async function otherDevice(p: FakePlatform, server: ModelServer): Promise<SyncEngine> {
  const q = createFakePlatform(99);
  q.timers = p.timers;
  return new SyncEngine({
    store: new SqliteLocalStore(new FakeRowDb()),
    transport: createPortTransport(modelHttp(server)),
    clock: p.timers,
    ids: q.crypto,
    random: { next: () => 0.5 },
    options: { reminders: true },
  });
}

const signIn = (rt: DesktopRuntime) => rt.signIn({ baseUrl: "https://atlas.example.org", email: "me@example.org", password: "pw", deviceName: "Android phone" });

describe("Android reminders over an OS alarm port", () => {
  it("arms an OS alarm for a synced reminder instead of waiting to tick it, and never shows it from the runtime", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r.rt);
    const other = await otherDevice(r.p, r.server);
    const due = r.p.timers.wall + 3 * HOUR;
    await other.createEntity("task", { title: "Pay the rent", description: null, due_at: new Date(due).toISOString(), status: "inbox" });
    await other.syncUntilSettled();
    await r.p.timers.advance(40_000);
    expect(r.alarms.pending.size).toBe(1);
    const alarm = [...r.alarms.pending.values()][0]!;
    expect(alarm.at).toBeLessThanOrEqual(due);
    expect(alarm.title + alarm.body).toContain("Pay the rent");
    expect(alarm.id).toBeGreaterThan(0);
    expect(alarm.id).toBeLessThanOrEqual(2 ** 31 - 1);
    expect(r.p.notifier.shown).toHaveLength(0);
    await r.rt.stop();
  });

  it("a reminder that fired while the app was closed is recorded as delivered on the next start and not shown again", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r.rt);
    const other = await otherDevice(r.p, r.server);
    await other.createEntity("task", { title: "Call the bank", description: null, due_at: new Date(r.p.timers.wall + 2 * HOUR).toISOString(), status: "inbox" });
    await other.syncUntilSettled();
    await r.p.timers.advance(40_000);
    expect(r.alarms.pending.size).toBe(1);
    await r.rt.stop(); // the app is closed ...
    await r.p.timers.advance(3 * HOUR, { wallOnly: true });
    expect(r.alarms.osTick()).toHaveLength(1); // ... and the OS shows the notification by itself
    const again = new DesktopRuntime(r.p, { tickMs: 1000, schedulerTickMs: 30_000 });
    await again.start();
    await r.p.timers.advance(40_000);
    expect(r.p.notifier.shown).toHaveLength(0); // the core marked it fired from the delivery log: no duplicate
    expect(r.alarms.pending.size).toBe(0);
    await again.stop();
  });

  it("generic content mode puts no task text into the alarm", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r.rt);
    await r.rt.updateSettings({ contentMode: "generic" });
    const other = await otherDevice(r.p, r.server);
    await other.createEntity("task", { title: "Secret errand", description: null, due_at: new Date(r.p.timers.wall + 2 * HOUR).toISOString(), status: "inbox" });
    await other.syncUntilSettled();
    await r.p.timers.advance(40_000);
    expect(r.alarms.pending.size).toBe(1);
    expect(JSON.stringify([...r.alarms.pending.values()])).not.toContain("Secret errand");
    await r.rt.stop();
  });

  it("turning reminders off cancels the armed alarms", async () => {
    const r = rig();
    await r.rt.start();
    await signIn(r.rt);
    const other = await otherDevice(r.p, r.server);
    await other.createEntity("task", { title: "Water the plants", description: null, due_at: new Date(r.p.timers.wall + 2 * HOUR).toISOString(), status: "inbox" });
    await other.syncUntilSettled();
    await r.p.timers.advance(40_000);
    expect(r.alarms.pending.size).toBe(1);
    await r.rt.updateSettings({ remindersEnabled: false });
    await r.p.timers.advance(40_000);
    expect(r.alarms.pending.size).toBe(0);
    await r.rt.stop();
  });
});
