import type { ReminderRecord, ReminderView, TaskView } from "../types.ts";

export const iso = (ms: number): string => new Date(ms).toISOString();

export interface ReminderInit {
  id: string;
  remindAtMs: number;
  revision?: number;
  taskId?: string;
  state?: ReminderRecord["state"];
  snoozedUntilMs?: number | null;
  acknowledgedAtMs?: number | null;
}

/** A `reminder` entity as the server would send it (`effectiveAt` is derived like the server does). */
export function reminder(init: ReminderInit): ReminderRecord {
  const snoozed = init.snoozedUntilMs ?? null;
  const ack = init.acknowledgedAtMs ?? null;
  return {
    id: init.id,
    revision: init.revision ?? 1,
    taskId: init.taskId ?? `task-${init.id}`,
    state: init.state ?? "armed",
    remindAt: iso(init.remindAtMs),
    snoozedUntil: snoozed === null ? null : iso(snoozed),
    acknowledgedAt: ack === null ? null : iso(ack),
    effectiveAt: iso(snoozed ?? init.remindAtMs),
  };
}

export function view(r: ReminderRecord, task: Partial<TaskView> = {}): ReminderView {
  return { reminder: r, task: { open: true, dirty: false, title: `Title of ${r.id}`, ...task } };
}
