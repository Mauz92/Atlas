/**
 * One simulated reminder device (M8-04b-ii): the REAL sync-core engine of a {@link SimClient}, the
 * REAL `@atlas/reminder-core` Scheduler wired to it through the sync-core adapters, and a simulated
 * OS (alarms, shade, reboot, permission). The harness keeps its own record of what the owner did
 * here (completions, re-dates, dismissals, snoozes) so the invariants judge the shows without
 * asking the code under test.
 */

import type { SyncEngine } from "../src/engine.ts";
import { SyncActionSink, SyncReminderSource, type ReminderActionData, type ReminderEngine } from "../src/reminders.ts";
import type { QueueOp } from "../src/types.ts";
import { Scheduler } from "../../reminder-core/src/scheduler.ts";
import type { PlantedBugs as SchedulerBugs } from "../../reminder-core/src/desired.ts";
import type { ActionSink, ReminderSource } from "../../reminder-core/src/ports.ts";
import { FakeClock, FakeOs, FakeStore, zoneOffsetMinutes } from "../../reminder-core/src/testing/index.ts";
import { sequenceIds } from "../src/testing/fakes.ts";
import type { IdGenerator } from "../src/ports.ts";
import type { Rng } from "./prng.ts";

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** Virtual time zero of the reminder timeline (the days around the Amsterdam DST change). */
export const REM_T0 = Date.UTC(2026, 2, 26, 8, 0);
/** One virtual millisecond of the event queue is this much reminder time (a step is about 40 minutes). */
export const REM_MS_PER_VMS = 5 * MIN;

/** The harness's record of one snooze or dismissal the owner made on this device. */
export interface Tap {
  actionId: string;
  reminderId: string;
  kind: "snooze" | "dismiss";
  seconds: number | null;
  /** the device clock at the tap */
  deviceTime: number;
  /** a dismissal: the fire key of the notification it covered */
  key: string | null;
}

/** An own re-dating of a task: until the server's recomputation arrives, its old instants are stale. */
export interface Redate {
  taskId: string;
  /** keys' instants (ISO) of the reminder as the mirror held it when the owner edited */
  oldInstants: Set<string>;
  acked: boolean;
  /** the number of pulls started when the edit was acknowledged */
  ackedAtPull: number;
  done: boolean;
}

export interface DeviceHost {
  readonly cid: string;
  readonly engine: SyncEngine;
  offset: number;
  readonly rng: Rng;
}

// Compile-time proof that the sync-core adapters satisfy the scheduler's ports (a drift fails to build).
const _ports = (engine: ReminderEngine): [ReminderSource, ActionSink] => [new SyncReminderSource(engine), new SyncActionSink(engine)];
void _ports;

export class ReminderDevice {
  readonly clock: FakeClock;
  readonly os: FakeOs;
  readonly store = new FakeStore();
  readonly ids: IdGenerator;
  readonly desktop: boolean;
  sched!: Scheduler;
  taps = new Map<string, Tap>();
  /** fire keys the owner dismissed on this device */
  dismissed = new Set<string>();
  redates: Redate[] = [];
  /** the key of the notification a dismissal in progress covers (read by the tap record) */
  pendingDismissKey: string | null = null;
  pullsStarted = 0;
  private activePull = 0;
  /** history entries already judged by the step invariants */
  judged = 0;

  constructor(
    private readonly host: DeviceHost,
    private readonly remNow: () => number,
    desktop: boolean,
    private readonly schedulerBugs: SchedulerBugs = {},
    idSeed = 1,
  ) {
    this.desktop = desktop;
    this.clock = new FakeClock(remNow(), (t) => zoneOffsetMinutes("Europe/Amsterdam", t));
    const r = host.rng;
    this.os = new FakeOs(this.clock, {
      osScheduling: !desktop,
      exactAlarms: !desktop && r.next() < 0.8,
      inexactDelayMs: 20 * MIN,
      maxPending: r.pick([8, 64, 500]),
      rebootBehaviour: r.next() < 0.5 ? "restore" : "clear",
    });
    this.ids = sequenceIds(idSeed); // the server wants a UUID as the action id
    this.boot();
  }

  /** The process starts (or restarts): a new Scheduler over the persisted scheduler state and the same OS. */
  boot(): void {
    const engine: ReminderEngine = {
      reminderViews: () => this.host.engine.reminderViews(),
      pendingReminderActionIds: () => this.host.engine.pendingReminderActionIds(),
      submitReminderAction: (action: ReminderActionData) => {
        // the harness notes the tap before the action is queued: a crash in between must not hide it
        this.taps.set(action.actionId, {
          actionId: action.actionId,
          reminderId: action.reminderId,
          kind: action.kind,
          seconds: action.snooze?.kind === "seconds" ? action.snooze.seconds : null,
          deviceTime: action.actedAt ?? this.clock.now(),
          key: this.pendingDismissKey,
        });
        return this.host.engine.submitReminderAction(action);
      },
    };
    this.sched = new Scheduler({
      clock: this.clock,
      port: this.os,
      store: this.store,
      source: new SyncReminderSource(engine),
      actions: new SyncActionSink(engine),
      ids: this.ids,
      defaults: { maxScheduled: 12 },
      plantedBugs: this.schedulerBugs,
    });
  }

  /** What a host does after every pull, local edit and tick: reconcile, then let the OS fire what is due. */
  async pump(): Promise<void> {
    this.clock.set(this.remNow() + this.host.offset);
    if (this.desktop) await this.sched.tick();
    else await this.sched.reconcile();
    this.os.fireDueAlarms();
  }

  async onRestart(): Promise<void> {
    this.boot();
    await this.pump();
  }

  async reboot(powerOn: boolean): Promise<void> {
    this.os.reboot();
    if (powerOn) await this.onRestart();
  }

  // --- the owner ------------------------------------------------------------------------------

  /** The owner taps snooze or dismiss on one of the notifications on screen. */
  async ownerActs(): Promise<string | null> {
    const shown = [...this.os.shade.values()].filter((s) => s.reminderId !== null && s.key !== null);
    if (shown.length === 0) return null;
    const pick = this.host.rng.pick(shown);
    const views = await this.host.engine.reminderViews();
    if (!views.some((v) => v.reminder.id === pick.reminderId && v.reminder.state === "armed")) return null;
    if (this.host.rng.next() < 0.5) {
      const seconds = this.host.rng.pick([600, 3600, 10800] as const);
      const ok = await this.sched.snooze(pick.reminderId!, { kind: "seconds", seconds });
      return ok ? `snooze ${seconds}s ${pick.reminderId}` : null;
    }
    this.dismissed.add(pick.key!);
    this.pendingDismissKey = pick.key!;
    const ok = await this.sched.dismiss(pick.reminderId!).finally(() => (this.pendingDismissKey = null));
    if (!ok) this.dismissed.delete(pick.key!);
    return ok ? `dismiss ${pick.reminderId}` : null;
  }

  /** Remember the instants of a task's reminder before the owner re-dates the task. */
  async noteRedate(taskId: string): Promise<void> {
    const views = await this.host.engine.reminderViews();
    const view = views.find((v) => v.reminder.taskId === taskId);
    if (!view) return;
    const old = new Set<string>([view.reminder.remindAt, view.reminder.effectiveAt].map((t) => new Date(Date.parse(t)).toISOString()));
    this.redates.push({ taskId, oldInstants: old, acked: false, ackedAtPull: 0, done: false });
  }

  /**
   * An own re-dating whose write left the queue without being acknowledged (refused, or removed by a
   * delete of the task) can no longer make a reminder stale: nothing was changed on the server.
   */
  settleRedates(queue: readonly QueueOp[]): void {
    for (const rec of this.redates) {
      if (rec.acked || rec.done) continue;
      // an operation that still carries the OLD due date (a create already in flight) is not the re-dating
      const queued = queue.some(
        (o) =>
          o.type === "task" &&
          o.entityId === rec.taskId &&
          typeof o.fields["due_at"] === "string" &&
          !rec.oldInstants.has(new Date(Date.parse(o.fields["due_at"])).toISOString()),
      );
      if (!queued) rec.done = true;
    }
  }

  dropRedate(taskId: string): void {
    const i = this.redates.map((r) => r.taskId).lastIndexOf(taskId);
    if (i >= 0 && !this.redates[i]!.acked) this.redates.splice(i, 1);
  }

  // --- engine events (from the client's observer) -----------------------------------------------

  onPullStarted(): void {
    this.pullsStarted++;
    this.activePull = this.pullsStarted;
  }

  onPullCompleted(): void {
    for (const rec of this.redates) {
      if (rec.acked && !rec.done && this.activePull > rec.ackedAtPull) rec.done = true;
    }
  }

  onAck(op: QueueOp, stillQueued: readonly QueueOp[]): void {
    if (op.type !== "task" || op.action !== "patch" || !("due_at" in op.fields)) return;
    const more = stillQueued.some((o) => o.type === "task" && o.entityId === op.entityId && o.action === "patch" && "due_at" in o.fields);
    if (more) return;
    for (const rec of this.redates) {
      if (rec.taskId === op.entityId && !rec.acked) {
        rec.acked = true;
        rec.ackedAtPull = this.pullsStarted;
      }
    }
  }
}
