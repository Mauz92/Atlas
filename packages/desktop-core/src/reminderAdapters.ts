import type {
  Clock as SchedulerClock,
  NotificationPort,
  PortCapabilities,
  SchedulerStore,
  ShownNotification,
} from "../../reminder-core/src/index.ts";
import type { PermissionStatus, SchedulerState } from "../../reminder-core/src/index.ts";
import type { NotifierPort, RowDb, TimerPort } from "./ports.ts";

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
