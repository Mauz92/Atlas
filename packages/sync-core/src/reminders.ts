/**
 * The device-reminder side of the sync core (M8-04b-ii; SYNC_PROTOCOL 14.2, 14.4, 14.5).
 *
 * A `reminder` is a server-derived feed entity (the fire instant is computed by the server in the
 * task's zone, ADR-0068 D2). The core mirrors it like any entity and offers a device scheduler
 * (`@atlas/reminder-core`) three things, through the two small adapters below:
 *
 *  - the reminders joined with what the device knows about their task (`ReminderViewData`), where
 *    `dirty` means "a local edit may have made the server-computed instant stale" (14.2 rule 2);
 *  - the ids of snooze/dismiss actions still waiting in the outbound queue;
 *  - a durable, idempotent way to queue such an action (`submit`).
 *
 * The shapes are declared here structurally (not imported) so this package stays free of any
 * dependency on the scheduler; the simulation assigns one to the other, so a drift fails to compile.
 */

import type { Json, LocalEntity, QueueOp } from "./types.ts";
import { materialise } from "./view.ts";

/** Task fields whose change makes the server recompute a reminder (`sync_task`, 14.2). */
export const DIRTY_FIELDS: ReadonlySet<string> = new Set(["due_at", "time_zone", "status", "reminder_policy_id"]);

/** Statuses for which a reminder may still fire (mirrors the server's `DELIVERABLE_STATUSES`). */
const OPEN_STATUSES: ReadonlySet<string> = new Set(["inbox", "next", "in_progress"]);

export interface ReminderRecordData {
  id: string;
  revision: number;
  taskId: string;
  state: "armed" | "cancelled";
  remindAt: string;
  snoozedUntil: string | null;
  acknowledgedAt: string | null;
  effectiveAt: string;
}

export interface ReminderViewData {
  reminder: ReminderRecordData;
  task: { open: boolean; dirty: boolean; title: string | null };
}

export type SnoozePresetData = { kind: "seconds"; seconds: 600 | 3600 | 10800 } | { kind: "tomorrow_morning" };

export interface ReminderActionData {
  actionId: string;
  reminderId: string;
  kind: "snooze" | "dismiss";
  snooze?: SnoozePresetData;
  baseRevision: number;
  /** epoch ms by the device clock */
  actedAt?: number;
}

/** What the adapters need from the engine (keeps this module free of an import cycle). */
export interface ReminderEngine {
  reminderViews(): Promise<ReminderViewData[]>;
  pendingReminderActionIds(): Promise<string[]>;
  submitReminderAction(action: ReminderActionData): Promise<void>;
}

/** `ReminderSource` of `@atlas/reminder-core`, backed by the sync-core store. */
export class SyncReminderSource {
  constructor(private readonly engine: ReminderEngine) {}
  views(): Promise<ReminderViewData[]> {
    return this.engine.reminderViews();
  }
  pendingActionIds(): Promise<string[]> {
    return this.engine.pendingReminderActionIds();
  }
}

/** `ActionSink` of `@atlas/reminder-core`: the action becomes a durable queued operation. */
export class SyncActionSink {
  constructor(private readonly engine: ReminderEngine) {}
  submit(action: ReminderActionData): Promise<void> {
    return this.engine.submitReminderAction(action);
  }
}

const str = (value: Json | undefined): string | null => (typeof value === "string" ? value : null);

/** The wire/feed fields of a stored reminder, camel-cased; `null` when it is not usable. */
export function toReminderRecord(entity: LocalEntity): ReminderRecordData | null {
  const server = entity.server;
  if (!server || entity.deleted) return null;
  const f = server.fields;
  const remindAt = str(f["remind_at"]);
  const taskId = str(f["task_id"]);
  const state = f["state"] === "armed" || f["state"] === "cancelled" ? f["state"] : null;
  if (remindAt === null || taskId === null || state === null) return null;
  const snoozedUntil = str(f["snoozed_until"]);
  return {
    id: entity.id,
    revision: server.revision,
    taskId,
    state,
    remindAt,
    snoozedUntil,
    acknowledgedAt: str(f["acknowledged_at"]),
    effectiveAt: str(f["effective_at"]) ?? snoozedUntil ?? remindAt,
  };
}

/** Does a pending (unacknowledged) operation of the task make its reminder possibly stale? */
export function opMakesReminderStale(op: QueueOp): boolean {
  if (op.type !== "task") return false;
  if (op.action === "restore") return true;
  return op.action === "patch" && Object.keys(op.fields).some((k) => DIRTY_FIELDS.has(k));
}

/**
 * The reminders with their tasks, as the device sees them: local edits are laid over the mirror (so
 * a task completed or deleted on this device is closed at once) and a task with an edit that the
 * server has not turned into a new reminder revision is `dirty` (its alarm is withdrawn until it is).
 *
 * `dirtyMeta` is the durable `dirty_tasks` map (task id -> the pull generation that clears it).
 */
export function buildReminderViews(
  entities: readonly LocalEntity[],
  queue: readonly QueueOp[],
  dirtyMeta: Record<string, number>,
  options: { ignoreDirty?: boolean } = {},
): ReminderViewData[] {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const pendingStale = new Set<string>();
  for (const op of queue) if (opMakesReminderStale(op)) pendingStale.add(op.entityId);
  const out: ReminderViewData[] = [];
  for (const entity of entities) {
    if (entity.type !== "reminder") continue;
    const record = toReminderRecord(entity);
    if (!record) continue;
    const taskEntity = byId.get(record.taskId);
    let open = true;
    let title: string | null = null;
    if (taskEntity && taskEntity.type === "task") {
      const view = materialise(taskEntity, queue, undefined);
      const status = str(view.fields["status"]);
      open = !view.deleted && (status === null || OPEN_STATUSES.has(status));
      title = str(view.fields["title"]);
    }
    const dirty =
      !options.ignoreDirty && (pendingStale.has(record.taskId) || dirtyMeta[record.taskId] !== undefined);
    out.push({ reminder: record, task: { open, dirty, title } });
  }
  out.sort((a, b) => (a.reminder.id < b.reminder.id ? -1 : 1));
  return out;
}
