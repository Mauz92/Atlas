import type {
  Clock as SchedulerClock,
  NotificationPort,
  PortCapabilities,
  ScheduledNotification,
  SchedulerStore,
  ShownNotification,
} from "../../reminder-core/src/index.ts";
import type { PermissionStatus, SchedulerState } from "../../reminder-core/src/index.ts";
import type { AlarmPort, NotifierPort, RowDb, TimerPort } from "./ports.ts";

/**
 * The desktop's {@link NotificationPort}: the app is the scheduling engine (`osScheduling: false`),
 * so `schedule`, `cancel`, `listPending` and `delivered` have nothing to do, and `show` goes to the
 * platform notifier. A reminder with the app not running fires only when the app is started again
 * (autostart/tray keep it resident; M8-04c, R-59).
 */
export class DesktopNotificationPort implements NotificationPort {
  constructor(private readonly notifier: NotifierPort) {}

  capabilities(): PortCapabilities {
    return { osScheduling: false, maxPending: 500, exactAlarms: false };
  }
  async permission(): Promise<PermissionStatus> {
    const p = await this.notifier.permission();
    return p === "granted" ? "granted" : p === "default" ? "prompt" : "denied";
  }
  async schedule(): Promise<void> {}
  async cancel(): Promise<void> {}
  async listPending(): Promise<Array<{ id: number; at: number }>> {
    return [];
  }
  async delivered(): Promise<number[]> {
    return [];
  }
  async show(n: ShownNotification): Promise<void> {
    await this.notifier.show({ title: n.title, body: n.body, tag: n.key });
  }
  async clearShown(): Promise<void> {}
}

/**
 * Android's {@link NotificationPort} (ADR-0075): the OS fires the alarms, also when the app is closed, so the core only arms them
 * (`osScheduling: true`) and, whenever it runs, asks which ones were delivered meanwhile. `exactAlarms` is read once at start; when
 * the OS refuses exact alarms the core knows reminders may be late.
 */
export class AndroidNotificationPort implements NotificationPort {
  constructor(
    private readonly notifier: NotifierPort,
    private readonly alarms: AlarmPort,
    private readonly exact: boolean,
  ) {}

  capabilities(): PortCapabilities {
    // AlarmManager allows 500 alarms per app; stay clear of it
    return { osScheduling: true, maxPending: 400, exactAlarms: this.exact };
  }
  async permission(): Promise<PermissionStatus> {
    const p = await this.notifier.permission();
    return p === "granted" ? "granted" : p === "default" ? "prompt" : "denied";
  }
  async schedule(n: ScheduledNotification): Promise<void> {
    await this.alarms.schedule({ id: n.id, at: n.at, title: n.title, body: n.body, taskId: n.taskId, key: n.key });
  }
  cancel(id: number): Promise<void> {
    return this.alarms.cancel(id);
  }
  listPending(): Promise<Array<{ id: number; at: number }>> {
    return this.alarms.list();
  }
  delivered(): Promise<number[]> {
    return this.alarms.delivered();
  }
  async show(n: ShownNotification): Promise<void> {
    await this.notifier.show({ title: n.title, body: n.body, tag: n.key });
  }
  clearShown(ids: number[]): Promise<void> {
    return this.alarms.clearShown(ids);
  }
}

/** The scheduler's one-record state, in the `scheduler` table (one atomic row). */
export class RowSchedulerStore implements SchedulerStore {
  constructor(private readonly db: RowDb) {}
  async read(): Promise<SchedulerState | null> {
    const raw = await this.db.get("scheduler", "state");
    return raw === null ? null : (JSON.parse(raw) as SchedulerState);
  }
  async write(state: SchedulerState): Promise<void> {
    await this.db.commit([{ op: "put", table: "scheduler", key: "state", value: JSON.stringify(state) }]);
  }
}

export function schedulerClock(timers: TimerPort): SchedulerClock {
  return { now: () => timers.wallTime(), utcOffsetMinutes: (at) => timers.utcOffsetMinutes(at) };
}
