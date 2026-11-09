/**
 * Data types of the device scheduler (M8-04b; SYNC_PROTOCOL.md 14.4).
 *
 * Instants are epoch milliseconds inside the core and ISO-8601 UTC strings at the edges (the feed).
 * The core never does wall-clock arithmetic: a reminder's fire instant is computed by the server
 * and arrives as an absolute UTC value (ADR-0068 D2), so a device zone change or a DST transition
 * on the device cannot move it. The only local-time rule is the optional quiet-hours window.
 */

export type ReminderState = "armed" | "cancelled";

/** A `reminder` feed entity as the sync layer stores it (the wire shape, camelCased). */
export interface ReminderRecord {
  id: string;
  revision: number;
  taskId: string;
  state: ReminderState;
  /** ISO UTC */
  remindAt: string;
  snoozedUntil: string | null;
  acknowledgedAt: string | null;
  /** `snoozedUntil ?? remindAt`, computed by the server */
  effectiveAt: string;
}

/**
 * What the scheduler may know about the task behind a reminder, read from the local mirror.
 * The title is only used in `full` content mode and never leaves the device.
 */
export interface TaskView {
  /** false when the task is completed, archived or deleted locally (even before the server knows). */
  open: boolean;
  /**
   * true when the task has a local edit of its due date, zone, status or reminder policy that the
   * server has not seen: the server-computed instant may be stale, so the alarm is withdrawn until
   * the next `reminder` revision arrives (SYNC_PROTOCOL.md 14.2 rule 2).
   */
  dirty: boolean;
  title: string | null;
}

export interface ReminderView {
  reminder: ReminderRecord;
  task: TaskView;
}

export type ContentMode = "full" | "generic";

/** A local quiet window, in minutes after local midnight; `start > end` wraps over midnight. */
export interface QuietHours {
  startMinute: number;
  endMinute: number;
}

/** Per-device notification settings (SYNC_PROTOCOL.md 14.6). */
export interface NotifySettings {
  /** Master switch for this device (Q3: every enabled device fires). */
  enabled: boolean;
  contentMode: ContentMode;
  /** `null` = no quiet hours (Q4 default). */
  quietHours: QuietHours | null;
  /** How far ahead alarms are armed. */
  horizonMs: number;
  /** At most this many future alarms are armed (nearest first). */
  maxScheduled: number;
  /** A reminder this far in the past is still caught up when found unfired; older ones are "missed". */
  catchUpMs: number;
  /** Show at most this many individual notifications per `burstWindowMs`; the rest are grouped. */
  burstLimit: number;
  burstWindowMs: number;
  /** More than this many due at once in a catch-up are shown as one summary. */
  groupThreshold: number;
  /** Fired keys older than this are forgotten (must exceed `catchUpMs`). */
  firedRetentionMs: number;
}

export const DEFAULT_SETTINGS: NotifySettings = {
  enabled: true,
  contentMode: "full",
  quietHours: null,
  horizonMs: 14 * 24 * 3_600_000,
  maxScheduled: 64,
  catchUpMs: 24 * 3_600_000,
  burstLimit: 5,
  burstWindowMs: 60_000,
  groupThreshold: 3,
  firedRetentionMs: 7 * 24 * 3_600_000,
};

/** `reminderId + ":" + effectiveAt (ISO UTC)`: one notification per key per device. */
export type FireKey = string;

export interface ScheduleEntry {
  id: number;
  /** the instant the OS alarm was set for (may differ from the key's instant under quiet hours) */
  at: number;
  reminderId: string;
  mode: ContentMode;
}

/** A snooze or dismissal the owner did on this device that the server has not confirmed yet. */
export interface LocalOverlay {
  kind: "snooze" | "dismiss";
  /** snooze: the optimistic effective instant */
  until: number | null;
  /** the reminder revision the action was based on; a higher revision supersedes the overlay */
  baseRevision: number;
  actionId: string;
  createdAt: number;
  /** snooze only: the optimistic alarm already showed, so the server's copy must not repeat it */
  fired?: boolean;
}

/** Everything the scheduler persists (one record, written atomically by the store). */
export interface SchedulerState {
  version: 1;
  settings: NotifySettings;
  /** key -> when it was fired (epoch ms) */
  fired: Record<FireKey, number>;
  /** key -> alarm armed in the OS */
  schedule: Record<FireKey, ScheduleEntry>;
  /** notification id -> key, for collision-free stable ids */
  ids: Record<string, FireKey>;
  /** reminder id -> the notification currently on screen for it (one per reminder) */
  shown: Record<string, { key: FireKey; id: number }>;
  overlays: Record<string, LocalOverlay>;
  /** recent individual shows, for the burst limit */
  recentShows: number[];
  lastTickAt: number | null;
  lastReconcileAt: number | null;
}

export function emptyState(settings: NotifySettings = DEFAULT_SETTINGS): SchedulerState {
  return {
    version: 1,
    settings,
    fired: {},
    schedule: {},
    ids: {},
    shown: {},
    overlays: {},
    recentShows: [],
    lastTickAt: null,
    lastReconcileAt: null,
  };
}

export type SnoozePreset =
  | { kind: "seconds"; seconds: 600 | 3600 | 10800 }
  | { kind: "tomorrow_morning" };

/** The owner's decision, handed to the sync layer to send as `POST /api/reminders/{id}/actions`. */
export interface ReminderAction {
  actionId: string;
  reminderId: string;
  kind: "snooze" | "dismiss";
  snooze?: SnoozePreset;
  baseRevision: number;
}

export type PermissionStatus = "granted" | "denied" | "prompt";

/** What one reconcile did and found; also the data of a diagnostics screen. */
export interface ReconcileResult {
  permission: PermissionStatus;
  enabled: boolean;
  /** alarms armed in the OS now */
  armed: number;
  /** alarms armed or cancelled by this run */
  scheduled: number;
  cancelled: number;
  /** due and unfired items shown by this run (catch-up) */
  shown: number;
  /** future items not armed because of the cap */
  deferredByCap: number;
  /** false: alarms may be late by up to an hour (inexact) */
  exactAlarms: boolean;
  /** older than the catch-up window, armed, never shown (listed, not pushed) */
  missed: string[];
}
