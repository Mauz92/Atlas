import { fireKey, hashKey, idFor } from "./ids.ts";
import { Scheduler } from "./scheduler.ts";
import {
  CrashError,
  FakeActions,
  FakeClock,
  FakeOs,
  FakeSource,
  FakeStore,
  SeqIds,
  iso,
  reminder,
  view,
  zoneOffsetMinutes,
  type FakeOsOptions,
} from "./testing/index.ts";
import { DEFAULT_SETTINGS, emptyState, type NotifySettings, type ReminderView } from "./types.ts";
import type { PlantedBugs } from "./desired.ts";

const T0 = Date.UTC(2026, 5, 10, 6, 0, 0); // 2026-06-10 06:00 UTC
const MIN = 60_000;
const HOUR = 3_600_000;

interface Rig {
  clock: FakeClock;
  os: FakeOs;
  store: FakeStore;
  source: FakeSource;
  actions: FakeActions;
  ids: SeqIds;
  sched: Scheduler;
  /** a fresh Scheduler over the same store/OS: an app restart */
  restart(bugs?: PlantedBugs): Scheduler;
  views(...v: ReminderView[]): void;
}

function rig(os: FakeOsOptions = {}, defaults: Partial<NotifySettings> = {}, bugs?: PlantedBugs): Rig {
  const clock = new FakeClock(T0);
  const fakeOs = new FakeOs(clock, os);
  const store = new FakeStore();
  const source = new FakeSource();
  const actions = new FakeActions();
  const ids = new SeqIds();
  const make = (b?: PlantedBugs) =>
    new Scheduler({ clock, port: fakeOs, store, source, actions, ids, defaults, ...(b ? { plantedBugs: b } : {}) });
  const r: Rig = {
    clock,
    os: fakeOs,
    store,
    source,
    actions,
    ids,
    sched: make(bugs),
    restart: (b) => (r.sched = make(b)),
    views: (...v) => {
      source.list = v;
    },
  };
  return r;
}

const rem = (id: string, at: number, extra: Partial<Parameters<typeof reminder>[0]> = {}) =>
  view(reminder({ id, remindAtMs: at, ...extra }));

describe("arming (OS scheduling)", () => {
  it("arms a future reminder once and a second reconcile changes nothing", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    const first = await r.sched.reconcile();
    expect(first.scheduled).toBe(1);
    expect(r.os.alarms.size).toBe(1);
    const writesBefore = r.store.writes;
    const second = await r.sched.reconcile();
    expect(second.scheduled).toBe(0);
    expect(second.cancelled).toBe(0);
    expect(r.os.alarms.size).toBe(1);
    expect(r.store.writes).toBeGreaterThanOrEqual(writesBefore); // state is saved, the OS untouched
  });

  it("the alarm fires at the server-computed instant and is never shown a second time", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.clock.advance(HOUR);
    expect(r.os.fireDueAlarms()).toHaveLength(1);
    await r.sched.reconcile();
    r.restart();
    await r.sched.onBoot();
    r.clock.advance(HOUR);
    await r.sched.reconcile();
    expect(r.os.history).toHaveLength(1);
    expect(r.os.history[0]!.via).toBe("os");
  });

  it("re-arms after a reboot, a force-stop and an app update (idempotent from the store)", async () => {
    const r = rig();
    r.views(rem("a", T0 + 2 * HOUR), rem("b", T0 + 3 * HOUR));
    await r.sched.reconcile();
    for (const wipe of [() => r.os.reboot(), () => r.os.forceStop(), () => r.os.dropAlarms()]) {
      wipe();
      expect(r.os.alarms.size).toBe(0);
      r.restart();
      const out = await r.sched.onBoot();
      expect(out.scheduled).toBe(2);
      expect(r.os.alarms.size).toBe(2);
      expect((await r.sched.onBoot()).scheduled).toBe(0);
    }
  });

  it("a reminder due while the phone was off is caught up once, not twice", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.os.reboot(); // alarm gone (worst case)
    r.clock.advance(3 * HOUR);
    r.restart();
    const out = await r.sched.onBoot();
    expect(out.shown).toBe(1);
    await r.sched.onBoot();
    r.restart();
    await r.sched.onBoot();
    expect(r.os.history).toHaveLength(1);
    expect(r.os.history[0]!.via).toBe("app");
  });

  it("replaces the alarm when the server moves the reminder, without piling up", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.views(view(reminder({ id: "a", remindAtMs: T0 + 5 * HOUR, revision: 2 })));
    const out = await r.sched.reconcile();
    expect(out.scheduled).toBe(1);
    expect(out.cancelled).toBe(1);
    expect([...r.os.alarms.values()].map((a) => a.at)).toEqual([T0 + 5 * HOUR]);
  });

  it("honours the horizon and the cap, nearest first, and reports what it deferred", async () => {
    const r = rig({ maxPending: 10 });
    const list = Array.from({ length: 30 }, (_, i) => rem(`r${i}`, T0 + (i + 1) * HOUR));
    list.push(rem("far", T0 + 30 * 24 * HOUR));
    r.views(...list);
    const out = await r.sched.reconcile();
    expect(out.armed).toBe(10);
    expect(out.deferredByCap).toBe(20);
    const times = [...r.os.alarms.values()].map((a) => a.at).sort((a, b) => a - b);
    expect(times[0]).toBe(T0 + HOUR);
    expect(times[9]).toBe(T0 + 10 * HOUR);
    // as the first ones fire, the next are armed
    r.clock.advance(5 * HOUR);
    r.os.fireDueAlarms();
    const later = await r.sched.reconcile();
    expect(later.armed).toBe(10);
    expect(Math.max(...[...r.os.alarms.values()].map((a) => a.at))).toBe(T0 + 15 * HOUR);
  });

  it("the default cap is 64 and the far reminder (beyond the horizon) is left to a later reconcile", async () => {
    const r = rig();
    r.views(...Array.from({ length: 80 }, (_, i) => rem(`r${i}`, T0 + (i + 1) * MIN)), rem("far", T0 + 20 * 24 * HOUR));
    const out = await r.sched.reconcile();
    expect(out.armed).toBe(64);
    expect(out.deferredByCap).toBe(16);
    expect([...r.os.alarms.values()].some((a) => a.at === T0 + 20 * 24 * HOUR)).toBe(false);
  });

  it("reports that exact alarms are unavailable and still arms", async () => {
    const r = rig({ exactAlarms: false });
    r.views(rem("a", T0 + HOUR));
    const out = await r.sched.reconcile();
    expect(out.exactAlarms).toBe(false);
    expect(out.armed).toBe(1);
  });
});

describe("cancelling", () => {
  it("withdraws the alarm and the shown notification when the task is completed locally", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.views(view(reminder({ id: "a", remindAtMs: T0 + HOUR }), { open: false }));
    const out = await r.sched.reconcile();
    expect(out.cancelled).toBe(1);
    expect(r.os.alarms.size).toBe(0);
  });

  it("clears a notification already on screen when the reminder is completed elsewhere", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.clock.advance(HOUR);
    r.os.fireDueAlarms();
    await r.sched.reconcile();
    expect(r.os.shade.size).toBe(1);
    r.views(view(reminder({ id: "a", remindAtMs: T0 + HOUR, state: "cancelled", revision: 2 })));
    await r.sched.reconcile();
    expect(r.os.shade.size).toBe(0);
  });

  it("an offline re-date withdraws the alarm until the next revision arrives", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.views(view(reminder({ id: "a", remindAtMs: T0 + HOUR }), { dirty: true }));
    await r.sched.reconcile();
    expect(r.os.alarms.size).toBe(0);
    r.clock.advance(2 * HOUR); // the old instant passes: the stale reminder must not appear
    await r.sched.reconcile();
    expect(r.os.history).toHaveLength(0);
    r.views(view(reminder({ id: "a", remindAtMs: T0 + 6 * HOUR, revision: 2 })));
    await r.sched.reconcile();
    expect([...r.os.alarms.values()].map((a) => a.at)).toEqual([T0 + 6 * HOUR]);
  });

  it("a dismissal on another device (acknowledged_at) stops this device's alarm", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.views(view(reminder({ id: "a", remindAtMs: T0 + HOUR, acknowledgedAtMs: T0 + HOUR, revision: 2 })));
    await r.sched.reconcile();
    expect(r.os.alarms.size).toBe(0);
    r.clock.advance(2 * HOUR);
    await r.sched.reconcile();
    expect(r.os.history).toHaveLength(0);
  });

  it("an acknowledgement older than the effective instant does not stop a later one", async () => {
    const r = rig();
    r.views(rem("a", T0 + 3 * HOUR, { acknowledgedAtMs: T0 + HOUR, revision: 2 }));
    await r.sched.reconcile();
    expect(r.os.alarms.size).toBe(1);
  });
});

describe("desktop engine (no OS scheduling)", () => {
  it("shows what is due on a tick, once, across restarts", async () => {
    const r = rig({ osScheduling: false });
    r.views(rem("a", T0 + 10 * MIN));
    expect((await r.sched.tick()).shown).toBe(0);
    r.clock.advance(10 * MIN);
    expect((await r.sched.tick()).shown).toBe(1);
    expect((await r.sched.tick()).shown).toBe(0);
    r.restart();
    expect((await r.sched.onBoot()).shown).toBe(0);
    expect(r.os.history).toHaveLength(1);
    expect(r.os.alarms.size).toBe(0);
  });

  it("catches up after the app was not running and groups a long list in one summary", async () => {
    const r = rig({ osScheduling: false });
    r.views(...Array.from({ length: 6 }, (_, i) => rem(`r${i}`, T0 + (i + 1) * MIN)));
    r.clock.advance(3 * HOUR);
    const out = await r.sched.tick();
    expect(out.shown).toBe(6);
    expect(r.os.history).toHaveLength(1);
    expect(r.os.history[0]!.body).toBe("6 reminders are due");
    expect(JSON.stringify(r.os.history)).not.toContain("Title of");
    await r.sched.tick();
    expect(r.os.history).toHaveLength(1);
  });

  it("a few fresh reminders are shown one by one, and a burst beyond the limit is grouped", async () => {
    const r = rig({ osScheduling: false });
    r.views(...Array.from({ length: 3 }, (_, i) => rem(`r${i}`, T0 + MIN)));
    r.clock.advance(MIN);
    await r.sched.tick();
    expect(r.os.history).toHaveLength(3);
    const burst = rig({ osScheduling: false });
    burst.views(...Array.from({ length: 9 }, (_, i) => rem(`r${i}`, T0 + MIN)));
    burst.clock.advance(MIN);
    // more than the group threshold but not "late": 5 individually, the other 4 as one summary
    const out = await burst.sched.tick();
    expect(out.shown).toBe(9);
    expect(burst.os.history).toHaveLength(6);
    expect(burst.os.history.filter((h) => h.body.includes("reminders are due"))).toHaveLength(1);
  });

  it("a rejected show is retried on the next run (the key is rolled back)", async () => {
    const r = rig({ osScheduling: false });
    r.views(rem("a", T0));
    let fail = true;
    r.os.hook = (op) => {
      if (op === "show" && fail) throw new Error("notification service unavailable");
    };
    await expect(r.sched.tick()).rejects.toThrow("unavailable");
    fail = false;
    expect((await r.sched.tick()).shown).toBe(1);
    expect(r.os.history).toHaveLength(1);
  });

  it("a crash between persisting the key and showing loses the notification, never duplicates it", async () => {
    const r = rig({ osScheduling: false });
    r.views(rem("a", T0));
    r.os.hook = (op) => {
      if (op === "show") {
        r.store.kill();
        throw new CrashError("show");
      }
    };
    await expect(r.sched.tick()).rejects.toThrow();
    r.store.revive();
    r.os.hook = () => {};
    r.restart();
    await r.sched.onBoot();
    r.clock.advance(HOUR);
    await r.sched.tick();
    expect(r.os.history).toHaveLength(0); // lost, by design; listed nowhere as shown
    expect(r.store.data!.fired[fireKey("a", T0)]).toBeDefined();
  });

  it("a device clock jump back never re-fires and a jump forward catches up once", async () => {
    const r = rig({ osScheduling: false });
    r.views(rem("a", T0 + HOUR), rem("b", T0 + 5 * HOUR));
    r.clock.advance(HOUR);
    await r.sched.tick();
    expect(r.os.history).toHaveLength(1);
    r.clock.set(T0 - 6 * HOUR);
    await r.sched.onClockChange();
    expect(r.os.history).toHaveLength(1);
    r.clock.set(T0 + 2 * HOUR);
    await r.sched.onClockChange();
    expect(r.os.history).toHaveLength(1); // nothing new is due yet, "a" is not repeated
    r.clock.set(T0 + 9 * HOUR);
    await r.sched.onClockChange();
    expect(r.os.history.map((h) => h.reminderId)).toEqual(["a", "b"]);
  });
});

describe("absolute instants: zones and daylight saving of the device", () => {
  it("a device zone change moves nothing", async () => {
    const r = rig();
    r.clock.offset = (t) => zoneOffsetMinutes("Europe/Amsterdam", t);
    r.views(rem("a", T0 + 4 * HOUR));
    await r.sched.reconcile();
    const before = [...r.os.alarms];
    r.clock.offset = (t) => zoneOffsetMinutes("Pacific/Auckland", t);
    const out = await r.sched.onClockChange();
    expect(out.scheduled).toBe(0);
    expect(out.cancelled).toBe(0);
    expect([...r.os.alarms]).toEqual(before);
  });

  it("instants around a spring-forward and a fall-back arm exactly where the server said", async () => {
    // Amsterdam: 2026-03-29 02:00 CET -> 03:00 CEST (gap); 2026-10-25 03:00 CEST -> 02:00 CET (overlap).
    // The server rolled a gap time forward to 03:00 CEST = 01:00 UTC and takes the first overlap.
    const instants = [Date.UTC(2026, 2, 29, 1, 0), Date.UTC(2026, 9, 25, 0, 30), Date.UTC(2026, 9, 25, 1, 30)];
    const r = rig({}, { horizonMs: 400 * 24 * HOUR });
    r.clock.set(Date.UTC(2026, 2, 1));
    r.views(...instants.map((t, i) => rem(`d${i}`, t)));
    await r.sched.reconcile();
    expect([...r.os.alarms.values()].map((a) => a.at).sort((a, b) => a - b)).toEqual(instants);
    for (const t of instants) {
      r.clock.set(t);
      r.os.fireDueAlarms();
      await r.sched.reconcile();
    }
    expect(r.os.history.map((h) => h.at)).toEqual(instants);
  });
});

describe("snooze and dismiss on this device", () => {
  it("a snooze clears the shown notification, arms a local alarm and queues the action", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.clock.advance(HOUR);
    r.os.fireDueAlarms();
    await r.sched.reconcile();
    expect(await r.sched.snooze("a", { kind: "seconds", seconds: 600 })).toBe(true);
    expect(r.os.shade.size).toBe(0);
    expect([...r.os.alarms.values()].map((a) => a.at)).toEqual([r.clock.now() + 10 * MIN]);
    // `actedAt` is the device clock at the tap: the sync layer sends it as `acted_at` (R-68)
    expect(r.actions.queue).toEqual([
      {
        actionId: "act-1", reminderId: "a", kind: "snooze", snooze: { kind: "seconds", seconds: 600 }, baseRevision: 1,
        actedAt: r.clock.now(),
      },
    ]);
    r.clock.advance(10 * MIN);
    r.os.fireDueAlarms();
    await r.sched.reconcile();
    expect(r.os.history).toHaveLength(2);
  });

  it("the server's copy of the snooze replaces the optimistic one", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    r.clock.advance(HOUR);
    r.os.fireDueAlarms();
    await r.sched.reconcile();
    await r.sched.snooze("a", { kind: "seconds", seconds: 3600 });
    r.source.pending = ["act-1"];
    const optimistic = r.clock.now() + HOUR;
    r.views(view(reminder({ id: "a", remindAtMs: T0 + HOUR, revision: 2, snoozedUntilMs: optimistic + 5 * MIN })));
    r.source.pending = [];
    await r.sched.reconcile();
    expect([...r.os.alarms.values()].map((a) => a.at)).toEqual([optimistic + 5 * MIN]);
  });

  it("a lost response replays the same action id and does not change the local schedule", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    await r.sched.snooze("a", { kind: "seconds", seconds: 600 });
    const queued = structuredClone(r.actions.queue);
    r.source.pending = [queued[0]!.actionId]; // still in the outbound queue, replayed by sync-core
    await r.sched.reconcile();
    await r.sched.reconcile();
    expect(r.actions.queue).toEqual(queued);
    expect(r.os.alarms.size).toBe(1);
  });

  it("an optimistic snooze that already fired is not repeated when the server confirms it", async () => {
    const r = rig();
    r.views(rem("a", T0));
    await r.sched.reconcile(); // due now -> catch-up shows
    await r.sched.snooze("a", { kind: "seconds", seconds: 600 });
    r.clock.advance(10 * MIN);
    r.os.fireDueAlarms();
    await r.sched.reconcile(); // the optimistic alarm showed
    const shownBefore = r.os.history.length;
    r.clock.advance(3 * HOUR); // the action syncs much later: the server's instant is "now + 10 min"
    r.source.pending = [];
    r.views(view(reminder({ id: "a", remindAtMs: T0, revision: 2, snoozedUntilMs: r.clock.now() + 10 * MIN })));
    await r.sched.reconcile();
    r.clock.advance(11 * MIN);
    r.os.fireDueAlarms();
    await r.sched.reconcile();
    expect(r.os.history).toHaveLength(shownBefore);
  });

  it("a dismissal removes the notification and prevents any later one; the action is queued", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    expect(await r.sched.dismiss("a")).toBe(true);
    expect(r.os.alarms.size).toBe(0);
    expect(r.actions.queue[0]!.kind).toBe("dismiss");
    r.clock.advance(2 * HOUR);
    await r.sched.reconcile();
    expect(r.os.history).toHaveLength(0);
  });

  it("returns false for an unknown or cancelled reminder and rolls back when the action cannot be queued", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    expect(await r.sched.snooze("zzz", { kind: "seconds", seconds: 600 })).toBe(false);
    r.actions.failing = true;
    await expect(r.sched.dismiss("a")).rejects.toThrow("unavailable");
    const state = await r.sched.snapshot();
    expect(state.overlays).toEqual({});
    r.actions.failing = false;
    await r.sched.reconcile();
    expect(r.os.alarms.size).toBe(1);
  });

  it("tomorrow morning is the next local 09:00 (device zone), optimistically", async () => {
    const r = rig();
    r.clock.offset = (t) => zoneOffsetMinutes("Europe/Amsterdam", t);
    r.clock.set(Date.UTC(2026, 5, 10, 20, 0)); // 22:00 CEST
    r.views(rem("a", r.clock.now() - MIN));
    await r.sched.reconcile();
    await r.sched.snooze("a", { kind: "tomorrow_morning" });
    expect([...r.os.alarms.values()].map((a) => a.at)).toEqual([Date.UTC(2026, 5, 11, 7, 0)]);
  });
});

describe("per-device settings", () => {
  it("a disabled device arms nothing and shows nothing, and enabling catches up", async () => {
    const r = rig({}, { enabled: false });
    r.views(rem("a", T0 + HOUR), rem("past", T0 - HOUR));
    const out = await r.sched.reconcile();
    expect(out.enabled).toBe(false);
    expect(r.os.alarms.size).toBe(0);
    expect(r.os.history).toHaveLength(0);
    await r.sched.updateSettings({ enabled: true });
    expect(r.os.alarms.size).toBe(1);
    expect(r.os.history).toHaveLength(1);
  });

  it("permission denied arms nothing and marks nothing fired; granting later catches up", async () => {
    const r = rig({ permission: "denied" });
    r.views(rem("a", T0 + HOUR), rem("past", T0 - HOUR));
    const out = await r.sched.reconcile();
    expect(out.permission).toBe("denied");
    expect(r.os.alarms.size).toBe(0);
    expect(Object.keys((await r.sched.snapshot()).fired)).toEqual([]);
    r.os.permissionState = "granted";
    await r.sched.reconcile();
    expect(r.os.alarms.size).toBe(1);
    expect(r.os.history.map((h) => h.reminderId)).toEqual(["past"]);
  });

  it("disabling removes the alarms the OS holds", async () => {
    const r = rig();
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    await r.sched.updateSettings({ enabled: false });
    expect(r.os.alarms.size).toBe(0);
  });

  it("generic mode never hands a title to the OS; switching modes re-arms with the new text", async () => {
    const r = rig({}, { contentMode: "generic" });
    r.views(rem("a", T0 + HOUR));
    await r.sched.reconcile();
    const hold = JSON.stringify([...r.os.alarms.values()]);
    expect(hold).not.toContain("Title of");
    expect(hold).toContain("A task is due");
    const out = await r.sched.updateSettings({ contentMode: "full" });
    expect(out.scheduled).toBe(1);
    expect(JSON.stringify([...r.os.alarms.values()])).toContain("Title of a");
    await r.sched.updateSettings({ contentMode: "generic" });
    expect(JSON.stringify([...r.os.alarms.values()])).not.toContain("Title of");
  });

  it("a full notification without a title falls back to the generic text", async () => {
    const r = rig({ osScheduling: false });
    r.views(view(reminder({ id: "a", remindAtMs: T0 }), { title: null }));
    await r.sched.tick();
    expect(r.os.history[0]!.body).toBe("A task is due");
  });

  it("quiet hours defer the alarm to the end of the window and never drop it", async () => {
    // 23:00 UTC-based device (offset 0): quiet 22:00-07:00
    const r = rig({}, { quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } });
    r.clock.set(Date.UTC(2026, 5, 10, 18, 0));
    r.views(rem("a", Date.UTC(2026, 5, 10, 23, 30)), rem("b", Date.UTC(2026, 5, 10, 20, 0)));
    await r.sched.reconcile();
    const ats = [...r.os.alarms.values()].map((a) => a.at).sort((x, y) => x - y);
    expect(ats).toEqual([Date.UTC(2026, 5, 10, 20, 0), Date.UTC(2026, 5, 11, 7, 0)]);
    r.clock.set(Date.UTC(2026, 5, 11, 7, 0));
    r.os.fireDueAlarms();
    await r.sched.reconcile();
    expect(r.os.history.map((h) => h.reminderId)).toEqual(["b", "a"]);
  });

  it("quiet hours in the desktop engine hold the notification until the window ends", async () => {
    const r = rig({ osScheduling: false }, { quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 } });
    r.clock.set(Date.UTC(2026, 5, 10, 21, 0));
    r.views(rem("a", Date.UTC(2026, 5, 10, 23, 0)));
    r.clock.set(Date.UTC(2026, 5, 10, 23, 30));
    await r.sched.tick();
    expect(r.os.history).toHaveLength(0);
    r.clock.set(Date.UTC(2026, 5, 11, 7, 0));
    await r.sched.tick();
    expect(r.os.history).toHaveLength(1);
  });
});

describe("misc", () => {
  it("lists reminders older than the catch-up window as missed and does not push them", async () => {
    const r = rig();
    r.views(rem("old", T0 - 3 * 24 * HOUR));
    const out = await r.sched.reconcile();
    expect(out.missed).toEqual(["old"]);
    expect(r.os.history).toHaveLength(0);
    expect(await r.sched.missed()).toEqual(["old"]);
  });

  it("serialises overlapping calls", async () => {
    const r = rig({ osScheduling: false });
    r.views(rem("a", T0));
    await Promise.all([r.sched.tick(), r.sched.tick(), r.sched.reconcile(), r.sched.onBoot()]);
    expect(r.os.history).toHaveLength(1);
  });

  it("the test notification shows now and arms one a minute ahead on OS platforms", async () => {
    const r = rig();
    expect(await r.sched.testNotification()).toEqual({ shownNow: true, scheduledAt: T0 + MIN });
    expect(r.os.alarms.size).toBe(1);
    const d = rig({ osScheduling: false });
    expect(await d.sched.testNotification()).toEqual({ shownNow: true, scheduledAt: null });
  });

  it("notification ids are stable per key and collisions get distinct ids", () => {
    const state = emptyState();
    const a = fireKey("r1", 1);
    expect(idFor(state, a)).toBe(idFor(state, a));
    expect(hashKey(a)).toBeGreaterThan(0);
    expect(hashKey(a)).toBeLessThanOrEqual(0x7fffffff);
    const b = fireKey("r2", 1);
    state.ids[String(hashKey(b))] = a; // force a collision with another live key
    const id = idFor(state, b);
    expect(id).not.toBe(hashKey(b));
    expect(idFor(state, b)).toBe(id);
    expect(state.ids[String(id)]).toBe(b);
  });

  it("a fired key is forgotten after the retention window, never earlier", async () => {
    const r = rig({ osScheduling: false });
    r.views(rem("a", T0));
    await r.sched.tick();
    r.clock.advance(DEFAULT_SETTINGS.firedRetentionMs - HOUR);
    await r.sched.tick();
    expect(Object.keys((await r.sched.snapshot()).fired)).toHaveLength(1);
    r.views(); // the reminder left the mirror
    r.os.shade.clear(); // and the user cleared the shade (a notification still on screen stays fired)
    r.clock.advance(2 * HOUR);
    await r.sched.tick();
    expect(Object.keys((await r.sched.snapshot()).fired)).toHaveLength(0);
  });

  it("the ISO helper and key format are what the docs say", () => {
    expect(fireKey("abc", T0)).toBe(`abc:${iso(T0)}`);
  });
});
