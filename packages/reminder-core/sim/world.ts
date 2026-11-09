/**
 * Multi-device reminder simulation (M8-04b; docs/TESTING.md 12.2).
 *
 * A model of the server's `reminder` entity (revisions, snooze/dismiss rules, idempotent actions,
 * a feed cursor) and several simulated devices, each with its own fake OS (alarms, shade, reboot,
 * force-stop, permission), store that can die mid-run, local task state and scheduler. A seeded
 * random walk applies server events, owner actions, sync, offline periods, restarts, reboots, clock
 * and zone changes, permission changes and crashes; named invariants are checked as it goes and at
 * quiescence. A run is fully described by `(seed, SimConfig, PlantedBugs)`; every failure prints
 * the seed and how to repeat it.
 */

import { Scheduler } from "../src/scheduler.ts";
import type { PlantedBugs } from "../src/desired.ts";
import {
  CrashError,
  FakeActions,
  FakeClock,
  FakeOs,
  FakeSource,
  FakeStore,
  SeqIds,
  iso,
  zoneOffsetMinutes,
} from "../src/testing/index.ts";
import type { ReminderAction, ReminderRecord, ReminderView } from "../src/types.ts";
import { rng, type Rng } from "./prng.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export class SimFailure extends Error {
  constructor(
    readonly invariant: string,
    readonly seed: number,
    detail: string,
    trace: string[],
  ) {
    super(
      `[${invariant}] ${detail}\n  seed=${seed}  (repeat: ATLAS_REMINDER_SEED=${seed})\n  last events:\n    ${trace
        .slice(-Number(process.env["ATLAS_REMINDER_TRACE"] ?? 14))
        .join("\n    ")}`,
    );
  }
}

export interface SimConfig {
  steps: number;
  devices: number;
  /** probability that a port operation crashes the process (kills the store) */
  pCrash: number;
  /** probability that a pull/action response is lost */
  pLoss: number;
}

export const DEFAULT_CONFIG: SimConfig = { steps: 120, devices: 3, pCrash: 0.004, pLoss: 0.15 };

// --- the server model ---------------------------------------------------------------------------

interface ServerReminder {
  id: string;
  revision: number;
  taskId: string;
  state: "armed" | "cancelled";
  remindAt: number;
  snoozedUntil: number | null;
  acknowledgedAt: number | null;
  /** the owner has completed the task (a task write); cancels the reminder */
  taskOpen: boolean;
}

class ServerModel {
  reminders = new Map<string, ServerReminder>();
  /** reminder id -> cursor of its latest change (the feed keeps one row per entity) */
  cursors = new Map<string, number>();
  seq = 0;
  private actions = new Map<string, { applied: boolean; revision: number }>();
  constructor(private readonly now: () => number) {}

  private bump(r: ServerReminder): void {
    r.revision += 1;
    this.seq += 1;
    this.cursors.set(r.id, this.seq);
  }

  create(id: string, remindAt: number): void {
    const r: ServerReminder = {
      id,
      revision: 1,
      taskId: `task-${id}`,
      state: "armed",
      remindAt,
      snoozedUntil: null,
      acknowledgedAt: null,
      taskOpen: true,
    };
    this.reminders.set(id, r);
    this.seq += 1;
    this.cursors.set(id, this.seq);
  }

  move(id: string, remindAt: number): void {
    const r = this.reminders.get(id);
    if (!r || r.state !== "armed" || r.remindAt === remindAt) return;
    r.remindAt = remindAt;
    r.snoozedUntil = null; // a moved schedule supersedes the snooze (acknowledgement is kept)
    this.bump(r);
  }

  cancel(id: string): void {
    const r = this.reminders.get(id);
    if (!r || r.state === "cancelled") return;
    r.state = "cancelled";
    r.taskOpen = false;
    this.bump(r);
  }

  rearm(id: string): void {
    const r = this.reminders.get(id);
    if (!r || r.state === "armed") return;
    r.state = "armed";
    r.taskOpen = true;
    this.bump(r);
  }

  /** `POST /api/reminders/{id}/actions` (SYNC_PROTOCOL 14.5), idempotent by action id. */
  act(a: ReminderAction, serverSnoozeMs: number | null): { applied: boolean; revision: number } {
    const done = this.actions.get(a.actionId);
    if (done) return done;
    const r = this.reminders.get(a.reminderId);
    let applied = false;
    if (r && r.state === "armed") {
      if (a.kind === "snooze") {
        const target = serverSnoozeMs ?? this.now() + 10 * MIN;
        r.snoozedUntil = target;
        r.acknowledgedAt = null;
        applied = true;
      } else {
        const due = r.snoozedUntil ?? r.remindAt;
        if (r.acknowledgedAt === null || r.acknowledgedAt < due) {
          r.snoozedUntil = null;
          r.acknowledgedAt = Math.max(this.now(), due);
          applied = true;
        }
      }
      if (applied) this.bump(r);
    }
    const out = { applied, revision: r?.revision ?? 0 };
    this.actions.set(a.actionId, out);
    return out;
  }

  record(r: ServerReminder): ReminderRecord {
    return {
      id: r.id,
      revision: r.revision,
      taskId: r.taskId,
      state: r.state,
      remindAt: iso(r.remindAt),
      snoozedUntil: r.snoozedUntil === null ? null : iso(r.snoozedUntil),
      acknowledgedAt: r.acknowledgedAt === null ? null : iso(r.acknowledgedAt),
      effectiveAt: iso(r.snoozedUntil ?? r.remindAt),
    };
  }

  pull(since: number): { head: number; changes: ReminderRecord[] } {
    const changes = [...this.reminders.values()]
      .filter((r) => (this.cursors.get(r.id) ?? 0) > since)
      .sort((a, b) => this.cursors.get(a.id)! - this.cursors.get(b.id)!)
      .map((r) => this.record(r));
    return { head: this.seq, changes };
  }
}

// --- a device -----------------------------------------------------------------------------------

interface LocalTask {
  open: boolean;
  /** the owner completed it on this device; reaches the server at the next successful push */
  completeQueued: boolean;
  /** an offline due-date edit: the scheduler must withdraw the alarm until a pull follows the push */
  edit: { target: number; pushed: boolean } | null;
}

interface LocalOverlay {
  kind: "snooze" | "dismiss";
  until: number | null;
  baseRevision: number;
}

const OPEN_TASK: LocalTask = { open: true, completeQueued: false, edit: null };

class Device {
  clock: FakeClock;
  os: FakeOs;
  store = new FakeStore();
  source = new FakeSource();
  actions = new FakeActions();
  ids: SeqIds;
  sched!: Scheduler;
  mirror = new Map<string, ReminderRecord>();
  cursor = 0;
  tasks = new Map<string, LocalTask>();
  online = true;
  powered = true;
  /** the app process is up (a closed desktop app, a force-stopped phone: nothing runs) */
  appRunning = true;
  skew = 0;
  /** the harness's own record of the owner's local actions (independent of the scheduler's) */
  overlays = new Map<string, LocalOverlay>();
  excused = new Set<string>();
  /** keys the design deliberately does not repeat: the server copy of a snooze that already rang here */
  suppressed = new Set<string>();
  crashes = 0;
  crashArmed = false;

  constructor(
    readonly name: string,
    readonly desktop: boolean,
    start: number,
    private readonly world: World,
  ) {
    this.clock = new FakeClock(start, (t) => zoneOffsetMinutes("Europe/Amsterdam", t));
    this.os = new FakeOs(this.clock, {
      osScheduling: !desktop,
      exactAlarms: !desktop && world.rng.next() < 0.8,
      inexactDelayMs: 20 * MIN,
      maxPending: world.rng.pick([8, 64, 500]),
      rebootBehaviour: world.rng.next() < 0.5 ? "restore" : "clear",
    });
    this.ids = new SeqIds(name);
    this.os.hook = (op) => this.crashHook(op);
    this.boot();
  }

  boot(): void {
    this.sched = new Scheduler({
      clock: this.clock,
      port: this.os,
      store: this.store,
      source: this.source,
      actions: this.actions,
      ids: this.ids,
      defaults: { maxScheduled: 12 },
      plantedBugs: this.world.bugs,
    });
  }

  private crashHook(op: string): void {
    if (!this.crashArmed || !["show", "show:after", "schedule", "cancel"].includes(op)) return;
    if (this.world.rng.next() >= 0.35) return;
    this.crashes += 1;
    this.crashArmed = false;
    this.store.kill();
    this.world.log(`${this.name}: CRASH during ${op}`);
    throw new CrashError(op);
  }

  task(taskId: string): LocalTask {
    return this.tasks.get(taskId) ?? OPEN_TASK;
  }

  refreshSource(): void {
    const views: ReminderView[] = [];
    for (const rec of this.mirror.values()) {
      const task = this.task(rec.taskId);
      views.push({
        reminder: structuredClone(rec),
        task: { open: task.open, dirty: task.edit !== null, title: `T-${rec.id}` },
      });
    }
    this.source.list = views;
    this.source.pending = this.actions.queue.map((a) => a.actionId);
  }

  /** What the device believed about a key, for failure messages. */
  explain(key: string): string {
    const rid = key.slice(0, key.indexOf(":"));
    const rec = this.mirror.get(rid);
    return JSON.stringify({
      mirror: rec ?? null,
      task: rec ? this.task(rec.taskId) : null,
      overlay: this.overlays.get(rid) ?? null,
      now: iso(this.clock.now()),
      permission: this.os.permissionState,
    });
  }

  /** The harness's legitimacy oracle for a notification key now (see the invariants). */
  legit(key: string): boolean {
    const idx = key.indexOf(":");
    const rid = key.slice(0, idx);
    const instant = Date.parse(key.slice(idx + 1));
    const rec = this.mirror.get(rid);
    if (!rec || rec.state !== "armed") return false;
    const task = this.task(rec.taskId);
    if (!task.open || task.edit !== null) return false;
    const overlay = this.overlays.get(rid);
    const live = overlay && overlay.baseRevision >= rec.revision ? overlay : undefined;
    if (live?.kind === "dismiss") return false;
    const effective =
      live?.kind === "snooze" && live.until !== null ? live.until : Date.parse(rec.effectiveAt);
    if (effective !== instant) return false;
    if (!live && rec.acknowledgedAt !== null && Date.parse(rec.acknowledgedAt) >= effective) return false;
    return true;
  }
}

// --- the world ----------------------------------------------------------------------------------

export class World {
  readonly rng: Rng;
  readonly trace: string[] = [];
  readonly server: ServerModel;
  readonly devices: Device[] = [];
  t: number;
  private nextId = 0;
  private checked = new Map<Device, number>();
  private lossless = false;

  constructor(
    readonly seed: number,
    readonly cfg: SimConfig,
    readonly bugs: PlantedBugs = {},
  ) {
    this.rng = rng(seed, "world");
    this.t = Date.UTC(2026, 2, 26, 8, 0); // the days around the Amsterdam DST change
    this.server = new ServerModel(() => this.t);
    for (let i = 0; i < cfg.devices; i++) {
      this.devices.push(new Device(`d${i}`, i === cfg.devices - 1 && cfg.devices > 1, this.t, this));
    }
  }

  log(line: string): void {
    this.trace.push(`t=${iso(this.t)} ${line}`);
  }

  fail(invariant: string, detail: string): never {
    throw new SimFailure(invariant, this.seed, detail, this.trace);
  }

  async run(): Promise<void> {
    for (let i = 0; i < this.cfg.steps; i++) await this.step();
    await this.quiesce();
  }

  private advance(ms: number): void {
    this.t += ms;
    for (const d of this.devices) d.clock.set(this.t + d.skew);
  }

  private async guarded(d: Device, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      if (!(error instanceof CrashError)) throw error;
      await this.afterCrash(d);
    }
  }

  private async step(): Promise<void> {
    const r = this.rng;
    const kind = r.pick([
      "time", "time", "time", "server", "server", "server", "owner", "owner", "sync", "sync", "sync",
      "restart", "reboot", "forcestop", "clock", "zone", "perm", "enable", "offline", "crash",
      "complete", "edit", "settings",
    ]);
    const d = r.pick(this.devices);
    this.log(`${d.name}: ${kind}`);
    await this.guarded(d, () => this.apply(kind, d));
    for (const dev of this.devices) {
      await this.guarded(dev, () => this.settle(dev));
      this.check(dev);
    }
  }

  private async apply(kind: string, d: Device): Promise<void> {
    const r = this.rng;
    const running = d.powered && d.appRunning;
    switch (kind) {
      case "time": {
        this.advance(r.next() < 0.08 ? r.range(DAY, 3 * DAY) : r.range(MIN, 90 * MIN));
        for (const dev of this.devices) this.fireOs(dev);
        return;
      }
      case "server": {
        const ids = [...this.server.reminders.keys()];
        const roll = r.next();
        if (ids.length < 3 || roll < 0.4) this.server.create(`r${this.nextId++}`, this.t + r.range(-3 * HOUR, 60 * HOUR));
        else if (roll < 0.65) this.server.move(r.pick(ids), this.t + r.range(-1 * HOUR, 72 * HOUR));
        else if (roll < 0.85) this.server.cancel(r.pick(ids));
        else this.server.rearm(r.pick(ids));
        return;
      }
      case "owner":
        if (running) await this.owner(d);
        return;
      case "sync":
        if (running) this.sync(d);
        return;
      case "restart":
        if (!d.powered) return;
        d.appRunning = true;
        d.boot();
        d.crashArmed = r.next() < 0.5;
        d.refreshSource();
        await d.sched.onBoot();
        return;
      case "reboot":
        d.os.reboot();
        d.powered = r.next() < 0.7;
        d.os.powered = d.powered;
        d.appRunning = d.powered;
        if (d.powered) {
          d.boot();
          d.crashArmed = r.next() < 0.3;
          d.refreshSource();
          await d.sched.onBoot();
        }
        return;
      case "forcestop":
        d.os.forceStop();
        d.appRunning = false;
        return;
      case "clock": {
        const jump = r.range(-2 * HOUR, 3 * HOUR);
        d.skew += jump;
        d.clock.set(this.t + d.skew);
        this.log(`${d.name}: clock jump ${jump / MIN} min`);
        if (running) {
          d.refreshSource();
          await d.sched.onClockChange();
        }
        return;
      }
      case "zone": {
        const zone = r.pick(["Europe/Amsterdam", "America/New_York", "Asia/Tokyo", "Pacific/Auckland"]);
        d.clock.offset = (t) => zoneOffsetMinutes(zone, t);
        if (running) {
          d.refreshSource();
          await d.sched.onClockChange();
        }
        return;
      }
      case "perm":
        d.os.permissionState = d.os.permissionState === "granted" ? "denied" : "granted";
        if (running) {
          d.refreshSource();
          await d.sched.reconcile();
        }
        return;
      case "enable":
        if (running) {
          d.refreshSource();
          const now = await d.sched.settings();
          await d.sched.updateSettings({ enabled: !now.enabled });
        }
        return;
      case "settings":
        if (running) {
          d.refreshSource();
          await d.sched.updateSettings({ contentMode: r.pick(["full", "generic"]) });
        }
        return;
      case "offline":
        d.online = !d.online;
        return;
      case "crash":
        d.crashArmed = true;
        return;
      case "complete": {
        const open = [...d.mirror.values()].filter((m) => d.task(m.taskId).open);
        if (open.length > 0 && running) {
          const pick = r.pick(open);
          d.tasks.set(pick.taskId, { open: false, completeQueued: true, edit: null });
          this.log(`${d.name}: completes ${pick.id} locally`);
        }
        return;
      }
      case "edit": {
        const open = [...d.mirror.values()].filter((m) => d.task(m.taskId).open);
        if (open.length > 0 && running) {
          const pick = r.pick(open);
          d.tasks.set(pick.taskId, {
            open: true,
            completeQueued: false,
            edit: { target: this.t + r.range(HOUR, 48 * HOUR), pushed: false },
          });
          this.log(`${d.name}: re-dates ${pick.id} offline`);
        }
        return;
      }
    }
  }

  private async owner(d: Device): Promise<void> {
    const shown = [...d.os.shade.values()].filter((s) => s.reminderId !== null);
    if (shown.length === 0) return;
    const rid = this.rng.pick(shown).reminderId!;
    const rec = d.mirror.get(rid);
    if (!rec) return;
    d.refreshSource();
    // The owner's intent is durable once the action is queued, even if the process crashes in the
    // reconcile that follows; record it first and withdraw only when the scheduler refused.
    const queued = d.actions.queue.length;
    if (this.rng.next() < 0.5) {
      const seconds = this.rng.pick([600, 3600, 10800] as const);
      d.overlays.set(rid, { kind: "snooze", until: d.clock.now() + seconds * 1000, baseRevision: rec.revision });
      const ok = await d.sched.snooze(rid, { kind: "seconds", seconds }).catch((error: unknown) => {
        if (d.actions.queue.length === queued) d.overlays.delete(rid);
        throw error;
      });
      if (!ok) d.overlays.delete(rid);
    } else {
      d.overlays.set(rid, { kind: "dismiss", until: null, baseRevision: rec.revision });
      const ok = await d.sched.dismiss(rid).catch((error: unknown) => {
        if (d.actions.queue.length === queued) d.overlays.delete(rid);
        throw error;
      });
      if (!ok) d.overlays.delete(rid);
    }
    this.log(`${d.name}: owner acts on ${rid} rev=${rec.revision} overlay=${JSON.stringify(d.overlays.get(rid) ?? null)}`);
  }

  /** Push local writes and queued actions, then pull; responses can be lost (an action replays). */
  private sync(d: Device): void {
    if (!d.online || !d.powered || !d.appRunning) return;
    const loss = (): boolean => !this.lossless && this.rng.next() < this.cfg.pLoss;
    const pushedTasks: string[] = [];
    for (const [taskId, task] of d.tasks) {
      const rid = taskId.replace("task-", "");
      if (task.completeQueued) {
        this.server.cancel(rid);
        pushedTasks.push(taskId);
      } else if (task.edit) {
        if (!task.edit.pushed) this.server.move(rid, task.edit.target);
        task.edit.pushed = true;
        pushedTasks.push(taskId);
      }
    }
    for (const action of [...d.actions.queue]) {
      const own = action.snooze?.kind === "seconds" ? action.snooze.seconds * 1000 : 12 * HOUR;
      this.server.act(action, this.t + own);
      if (!loss()) d.actions.queue = d.actions.queue.filter((a) => a.actionId !== action.actionId);
    }
    if (loss()) return; // the pull response was lost
    const page = this.server.pull(d.cursor);
    for (const rec of page.changes) {
      this.log(`${d.name}: pulls ${rec.id} rev=${rec.revision} eff=${rec.effectiveAt} ack=${rec.acknowledgedAt} ${rec.state}`);
      d.mirror.set(rec.id, rec);
      const task = d.task(rec.taskId);
      if (!task.completeQueued && !task.edit) {
        d.tasks.set(rec.taskId, { open: rec.state === "armed", completeQueued: false, edit: null });
      }
      const overlay = d.overlays.get(rec.id);
      if (
        overlay?.kind === "snooze" &&
        overlay.until !== null &&
        rec.revision === overlay.baseRevision + 1 &&
        rec.snoozedUntil !== null &&
        d.os.history.some((h) => h.key === `${rec.id}:${iso(overlay.until!)}`)
      ) {
        d.suppressed.add(`${rec.id}:${rec.effectiveAt}`);
      }
      if (overlay && rec.revision > overlay.baseRevision && !d.actions.queue.some((a) => a.reminderId === rec.id)) {
        d.overlays.delete(rec.id);
      }
    }
    d.cursor = page.head;
    // a pull after the push: the server's view of the edited/completed task is now in the mirror
    for (const taskId of pushedTasks) {
      const task = d.tasks.get(taskId);
      if (task && (task.completeQueued || task.edit?.pushed)) {
        const rec = [...d.mirror.values()].find((m) => m.taskId === taskId);
        d.tasks.set(taskId, { open: rec ? rec.state === "armed" : task.open, completeQueued: false, edit: null });
      }
    }
  }

  /** After every step each device reconciles (as a host would after a pull / tick). */
  private async settle(d: Device): Promise<void> {
    if (!d.powered || !d.appRunning) return;
    d.refreshSource();
    if (d.desktop) await d.sched.tick();
    else await d.sched.reconcile();
    this.fireOs(d);
  }

  private fireOs(d: Device): void {
    if (d.powered) d.os.fireDueAlarms();
  }

  private async afterCrash(d: Device): Promise<void> {
    // The process died: the store keeps its last durable write. A key persisted as fired but never
    // shown is the one legitimate loss ("fired before show": lose rather than duplicate).
    const shown = new Set(d.os.history.map((h) => h.key));
    for (const key of Object.keys(d.store.data?.fired ?? {})) if (!shown.has(key)) d.excused.add(key);
    d.store.revive();
    d.boot();
    d.refreshSource();
    d.appRunning = true;
    await d.sched.onBoot();
  }

  // --- invariants -------------------------------------------------------------------------------

  private check(d: Device): void {
    const cap = Math.min(12, d.os.caps.maxPending);
    if (d.os.alarms.size > cap) this.fail("bounded_alarms", `${d.name} holds ${d.os.alarms.size} alarms (cap ${cap})`);
    const seen = new Map<number, number>();
    for (const rec of d.os.history) seen.set(rec.id, (seen.get(rec.id) ?? 0) + 1);
    for (const [id, n] of seen) {
      if (n > 1) {
        const rec = d.os.history.find((h) => h.id === id)!;
        this.fail("at_most_once", `${d.name} showed ${rec.key ?? "a summary"} ${n} times`);
      }
    }
    for (const rec of d.os.history.slice(this.checked.get(d) ?? 0)) {
      if (rec.key !== null && !d.legit(rec.key)) {
        this.fail(
          "no_stale_show",
          `${d.name} showed ${rec.key} via ${rec.via} although it was cancelled, dismissed, completed, re-dated or moved\n  ${d.explain(rec.key)}`,
        );
      }
    }
    this.checked.set(d, d.os.history.length);
  }

  private async quiesce(): Promise<void> {
    this.log("quiesce");
    this.lossless = true;
    for (const d of this.devices) {
      d.online = true;
      d.powered = true;
      d.os.powered = true;
      d.appRunning = true;
      d.os.permissionState = "granted";
      d.crashArmed = false;
      d.skew = 0;
      d.clock.set(this.t);
      d.clock.offset = (t) => zoneOffsetMinutes("Europe/Amsterdam", t);
      d.store.revive();
      d.boot();
      d.refreshSource();
      await d.sched.updateSettings({ enabled: true });
      this.check(d); // judged against the view it was shown from, before the next sync
    }
    for (let round = 0; round < 3; round++) {
      for (const d of this.devices) {
        this.sync(d);
        await this.settle(d);
        this.check(d);
      }
    }
    // no orphan alarms; and what every device owes: each armed, open, un-dismissed reminder due
    // from a day ago to the horizon must have been shown by the time the clock has passed it
    const expected = new Map<Device, string[]>();
    for (const d of this.devices) {
      for (const a of d.os.alarms.values()) {
        if (a.key !== null && !d.legit(a.key)) this.fail("no_orphan_alarm", `${d.name} holds an alarm for ${a.key}`);
      }
      const keys: string[] = [];
      for (const rec of d.mirror.values()) {
        const key = `${rec.id}:${iso(Date.parse(rec.effectiveAt))}`;
        const instant = Date.parse(rec.effectiveAt);
        if (d.legit(key) && instant >= this.t - 24 * HOUR && instant <= this.t + 10 * DAY) keys.push(key);
      }
      expected.set(d, keys);
    }
    for (let i = 0; i < 11 * 24; i++) {
      this.advance(HOUR);
      for (const d of this.devices) {
        this.fireOs(d);
        d.refreshSource();
        if (d.desktop) await d.sched.tick();
        else await d.sched.reconcile();
        this.fireOs(d);
        this.check(d);
      }
    }
    for (const d of this.devices) {
      const shownKeys = new Set(d.os.history.map((h) => h.key));
      const owed = (expected.get(d) ?? []).filter((k) => !shownKeys.has(k) && !d.excused.has(k) && !d.suppressed.has(k));
      const summarised = d.os.history.reduce((n, h) => {
        const m = /^(\d+) reminders are due$/.exec(h.body);
        return n + (h.key === null && m ? Number(m[1]) : 0);
      }, 0);
      if (owed.length > summarised) {
        this.fail("nothing_lost", `${d.name} never showed ${owed.length - summarised} of: ${owed.join(", ")}`);
      }
    }
  }
}

export async function runWorld(
  seed: number,
  config: Partial<SimConfig> = {},
  bugs: PlantedBugs = {},
): Promise<World> {
  const world = new World(seed, { ...DEFAULT_CONFIG, ...config }, bugs);
  await world.run();
  return world;
}

