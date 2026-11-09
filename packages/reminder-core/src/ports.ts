/**
 * Everything the scheduler needs from its host, as interfaces (M8-04b, AGENTS.md 7.4).
 *
 * The core imports nothing from React, the DOM, Tauri or Node and reads the wall clock only through
 * {@link Clock}. A host (Android plugin adapter, desktop shell, a test) injects the ports.
 */

import type {
  PermissionStatus,
  ReminderAction,
  ReminderView,
  SchedulerState,
  ContentMode,
} from "./types.ts";

export interface Clock {
  /** Wall-clock epoch milliseconds. The only time source of the core. */
  now(): number;
  /**
   * The device zone's offset from UTC in minutes at the given instant (positive east). Used only
   * for quiet hours; reminder instants never depend on it.
   */
  utcOffsetMinutes(atMs: number): number;
}

export interface PortCapabilities {
  /**
   * true: the OS fires alarms by itself (Android AlarmManager) and the core arms them with
   * `schedule`; false: the core is the engine and `tick` shows what is due (desktop).
   */
  osScheduling: boolean;
  /** The most alarms the platform keeps for the app (the core stays below it). */
  maxPending: number;
  /** false when the platform may deliver alarms late (no exact-alarm permission). */
  exactAlarms: boolean;
}

/** What is put on screen. The text is final: the port never receives the task title in `generic`. */
export interface NotificationContent {
  title: string;
  body: string;
  mode: ContentMode;
  /** Opens this task when tapped (an id, not text). */
  taskId: string | null;
  reminderId: string | null;
  /**
   * The fire key (`reminderId:effectiveAtISO`), for the adapter's own use (a notification tag or
   * extras so a tap can open the task); `null` on a summary. Not text and never displayed.
   */
  key: string | null;
}

export interface ScheduledNotification extends NotificationContent {
  /** Stable 31-bit id derived from the fire key. */
  id: number;
  /** epoch ms the OS should show it */
  at: number;
}

export interface ShownNotification extends NotificationContent {
  id: number;
}

export interface NotificationPort {
  capabilities(): PortCapabilities;
  permission(): Promise<PermissionStatus>;
  /** Arm an OS alarm (only when `osScheduling`). Replacing an id replaces its alarm. */
  schedule(notification: ScheduledNotification): Promise<void>;
  cancel(id: number): Promise<void>;
  /** Alarms the OS still holds for the app, with their instants. */
  listPending(): Promise<Array<{ id: number; at: number }>>;
  /**
   * Ids the OS has delivered since the app last asked, plus those still in the shade. The native
   * adapter must record deliveries made while the app was closed (a requirement on M8-04d); the
   * core marks these keys fired and does not show them again.
   */
  delivered(): Promise<number[]>;
  /** Show now. */
  show(notification: ShownNotification): Promise<void>;
  /** Remove shown notifications (a dismissal or completion on another device). */
  clearShown(ids: number[]): Promise<void>;
}

/** Persistence of the scheduler state: one atomic record. A crash leaves the old or the new one. */
export interface SchedulerStore {
  read(): Promise<SchedulerState | null>;
  write(state: SchedulerState): Promise<void>;
}

/** The reminders and their tasks as the local mirror holds them (from sync-core). */
export interface ReminderSource {
  views(): Promise<ReminderView[]>;
  /** Action ids still waiting in the outbound queue (optional; none when omitted). */
  pendingActionIds?(): Promise<string[]>;
}

/** Where a snooze or dismissal goes; the host queues it durably and sends it when online. */
export interface ActionSink {
  submit(action: ReminderAction): Promise<void>;
}

export interface IdSource {
  uuid(): string;
}

export interface SchedulerLogger {
  info(event: string, fields?: Record<string, string | number | boolean | null>): void;
  warn(event: string, fields?: Record<string, string | number | boolean | null>): void;
}

export const silentLogger: SchedulerLogger = { info() {}, warn() {} };
