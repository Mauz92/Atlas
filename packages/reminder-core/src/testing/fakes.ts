/**
 * Test doubles for the scheduler ports (M8-04b): a controllable clock, a simulated operating
 * system (alarms, notification shade, reboot, force-stop, inexact delay, permission), a store that
 * can die mid-run, a reminder source and an action queue. Used by the unit tests and the simulation;
 * they live in the package so a host's adapter tests can reuse them.
 */

import type {
  ActionSink,
  Clock,
  IdSource,
  NotificationPort,
  PortCapabilities,
  ReminderSource,
  SchedulerStore,
  ScheduledNotification,
  ShownNotification,
} from "../ports.ts";
import type { PermissionStatus, ReminderAction, ReminderView, SchedulerState } from "../types.ts";

/** The device zone offset at an instant, from the engine's tz database (used for quiet hours). */
export function zoneOffsetMinutes(timeZone: string, atMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(atMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(atMs / 1000) * 1000) / 60_000);
}

export class FakeClock implements Clock {
  private t: number;
  /** replace to change the device zone (a zone change must not move any fire instant) */
  offset: (atMs: number) => number;

  constructor(start: number, offset: (atMs: number) => number = () => 0) {
    this.t = start;
    this.offset = offset;
  }
  now(): number {
    return this.t;
  }
  utcOffsetMinutes(atMs: number): number {
    return this.offset(atMs);
  }
  set(ms: number): void {
    this.t = ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface ShownRecord {
  id: number;
  at: number;
  via: "os" | "app";
  title: string;
  body: string;
  reminderId: string | null;
  key: string | null;
}

export interface FakeOsOptions {
  osScheduling?: boolean;
  exactAlarms?: boolean;
  maxPending?: number;
  /** extra delay applied to every alarm when exact alarms are unavailable */
  inexactDelayMs?: number;
  permission?: PermissionStatus;
  /** what a reboot does to armed alarms: `clear` (worst case) or `restore` past-due ones ~15 s later */
  rebootBehaviour?: "clear" | "restore";
}

/** A simulated Android-like OS plus notification centre. `osScheduling:false` = a desktop engine. */
export class FakeOs implements NotificationPort {
  alarms = new Map<number, { at: number; title: string; body: string; reminderId: string | null; key: string | null }>();
  shade = new Map<number, ShownRecord>();
  history: ShownRecord[] = [];
  private undelivered: number[] = [];
  permissionState: PermissionStatus;
  caps: PortCapabilities;
  inexactDelayMs: number;
  rebootBehaviour: "clear" | "restore";
  /** called before each port operation: throw to simulate a crash or a transient failure */
  hook: (op: string) => void = () => {};
  /** persisted copy the "plugin" restores after a reboot */
  private saved = new Map<number, { at: number; title: string; body: string; reminderId: string | null; key: string | null }>();
  powered = true;

  constructor(
    private readonly clock: FakeClock,
    options: FakeOsOptions = {},
  ) {
    this.caps = {
      osScheduling: options.osScheduling ?? true,
      maxPending: options.maxPending ?? 500,
      exactAlarms: options.exactAlarms ?? true,
    };
    this.inexactDelayMs = options.inexactDelayMs ?? 0;
    this.permissionState = options.permission ?? "granted";
    this.rebootBehaviour = options.rebootBehaviour ?? "clear";
  }

  capabilities(): PortCapabilities {
    return this.caps;
  }
  async permission(): Promise<PermissionStatus> {
    return this.permissionState;
  }
  async schedule(n: ScheduledNotification): Promise<void> {
    this.hook("schedule");
    if (!this.caps.osScheduling) throw new Error("this platform cannot schedule");
    const entry = { at: n.at, title: n.title, body: n.body, reminderId: n.reminderId, key: n.key };
    this.alarms.set(n.id, entry);
    this.saved.set(n.id, entry);
  }
  async cancel(id: number): Promise<void> {
    this.hook("cancel");
    this.alarms.delete(id);
    this.saved.delete(id);
  }
  async listPending(): Promise<Array<{ id: number; at: number }>> {
    return [...this.alarms].map(([id, a]) => ({ id, at: a.at }));
  }
  async delivered(): Promise<number[]> {
    const ids = new Set([...this.shade.keys(), ...this.undelivered]);
    this.undelivered = [];
    return [...ids];
  }
  async show(n: ShownNotification): Promise<void> {
    this.hook("show");
    this.record(n.id, "app", n.title, n.body, n.reminderId, n.key);
    this.hook("show:after"); // a crash after the notification is on screen, before the caller moves on
  }
  async clearShown(ids: number[]): Promise<void> {
    this.hook("clearShown");
    for (const id of ids) this.shade.delete(id);
  }

  private record(
    id: number,
    via: "os" | "app",
    title: string,
    body: string,
    reminderId: string | null,
    key: string | null,
  ) {
    const rec: ShownRecord = { id, at: this.clock.now(), via, title, body, reminderId, key };
    this.shade.set(id, rec);
    this.history.push(rec);
  }

  /** The OS fires every alarm that is due (after its inexact delay). Call after moving the clock. */
  fireDueAlarms(): ShownRecord[] {
    if (!this.powered || this.permissionState !== "granted") return [];
    const fired: ShownRecord[] = [];
    const delay = this.caps.exactAlarms ? 0 : this.inexactDelayMs;
    const ready = [...this.alarms].filter(([, a]) => a.at + delay <= this.clock.now());
    ready.sort((x, y) => x[1].at - y[1].at || x[0] - y[0]);
    for (const [id, a] of ready) {
      this.alarms.delete(id);
      this.saved.delete(id);
      this.record(id, "os", a.title, a.body, a.reminderId, a.key);
      this.undelivered.push(id);
      fired.push(this.history[this.history.length - 1]!);
    }
    return fired;
  }

  /** The user swipes a notification away (it stays "delivered" in the OS log). */
  swipe(id: number): void {
    this.shade.delete(id);
  }

  reboot(): void {
    this.alarms.clear();
    this.shade.clear();
    if (this.rebootBehaviour === "restore") {
      for (const [id, a] of this.saved) {
        this.alarms.set(id, { ...a, at: Math.max(a.at, this.clock.now() + 15_000) });
      }
    } else {
      this.saved.clear();
    }
  }
  forceStop(): void {
    this.alarms.clear();
    this.saved.clear();
  }
  /** The platform may drop alarms the app armed (a vendor battery manager, an update). */
  dropAlarms(): void {
    this.alarms.clear();
    this.saved.clear();
  }
}

export class CrashError extends Error {
  constructor(where: string) {
    super(`simulated crash at ${where}`);
  }
}

/** An atomic single-record store that can be killed: later writes throw, the last good one stays. */
export class FakeStore implements SchedulerStore {
  data: SchedulerState | null = null;
  dead = false;
  writes = 0;
  /** called before every write: throw to simulate a crash before it lands */
  beforeWrite: (n: number) => void = () => {};

  async read(): Promise<SchedulerState | null> {
    return this.data ? structuredClone(this.data) : null;
  }
  async write(state: SchedulerState): Promise<void> {
    if (this.dead) throw new CrashError("store (process is dead)");
    this.beforeWrite(this.writes);
    this.data = structuredClone(state);
    this.writes += 1;
  }
  kill(): void {
    this.dead = true;
  }
  revive(): void {
    this.dead = false;
  }
}

export class FakeSource implements ReminderSource {
  list: ReminderView[] = [];
  pending: string[] = [];
  async views(): Promise<ReminderView[]> {
    return structuredClone(this.list);
  }
  async pendingActionIds(): Promise<string[]> {
    return [...this.pending];
  }
}

export class FakeActions implements ActionSink {
  queue: ReminderAction[] = [];
  failing = false;
  async submit(action: ReminderAction): Promise<void> {
    if (this.failing) throw new Error("queue unavailable");
    this.queue.push(action);
  }
}

export class SeqIds implements IdSource {
  private n = 0;
  constructor(private readonly prefix = "act") {}
  uuid(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}
