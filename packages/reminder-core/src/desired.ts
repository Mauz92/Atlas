import { fireKey } from "./ids.ts";
import type { FireKey, LocalOverlay, ReminderView, SchedulerState } from "./types.ts";

export interface DesiredItem {
  key: FireKey;
  view: ReminderView;
  /** the key's instant (`snoozed_until ?? remind_at`, or the optimistic local snooze) */
  effective: number;
}

export interface PlantedBugs {
  /** show first, write the fired key afterwards (a crash in between duplicates) */
  writeFiredAfterShow?: boolean;
  /** a dismissal on another device (acknowledged_at) does not stop the notification */
  ignoreAcknowledged?: boolean;
  /** an OS alarm is left armed when its reminder was cancelled or completed */
  keepAlarmOfCancelled?: boolean;
  /** a past-due, unfired reminder is not caught up */
  skipCatchUp?: boolean;
  /** the key ignores the snooze, so a snoozed reminder never fires again */
  keyIgnoresSnooze?: boolean;
  /** an offline edit of the task does not withdraw the alarm */
  ignoreDirtyTask?: boolean;
  /** the fired set is not loaded after a restart */
  forgetFiredOnRestart?: boolean;
}

export function activeOverlay(
  overlay: LocalOverlay | undefined,
  view: ReminderView,
): LocalOverlay | undefined {
  return overlay && overlay.baseRevision >= view.reminder.revision ? overlay : undefined;
}

/** The instant the reminder is (or would be) shown for, honouring a local optimistic snooze. */
export function effectiveOf(view: ReminderView, overlay: LocalOverlay | undefined): number {
  if (overlay?.kind === "snooze" && overlay.until !== null) return overlay.until;
  return Date.parse(view.reminder.effectiveAt);
}

/** Whether a reminder wants a notification at all right now (ignoring the fired set). */
export function isLive(
  view: ReminderView,
  overlay: LocalOverlay | undefined,
  bugs: PlantedBugs = {},
): boolean {
  const r = view.reminder;
  if (r.state !== "armed" || !view.task.open) return false;
  if (view.task.dirty && !bugs.ignoreDirtyTask) return false;
  if (overlay?.kind === "dismiss") return false;
  if (overlay?.kind === "snooze") return true; // the owner's own, newer instant
  if (r.acknowledgedAt !== null && !bugs.ignoreAcknowledged) {
    if (Date.parse(r.acknowledgedAt) >= Date.parse(r.effectiveAt)) return false;
  }
  return true;
}

export interface Classified {
  /** live, unfired, inside [now - catchUp, now + horizon], earliest first */
  desired: DesiredItem[];
  /** live, unfired, but older than the catch-up window: listed, never pushed */
  missed: DesiredItem[];
}

export function classify(
  views: readonly ReminderView[],
  state: SchedulerState,
  now: number,
  bugs: PlantedBugs = {},
): Classified {
  const { catchUpMs, horizonMs } = state.settings;
  const desired: DesiredItem[] = [];
  const missed: DesiredItem[] = [];
  for (const view of views) {
    const overlay = activeOverlay(state.overlays[view.reminder.id], view);
    if (!isLive(view, overlay, bugs)) continue;
    const effective = effectiveOf(view, overlay);
    if (!Number.isFinite(effective)) continue;
    const key = bugs.keyIgnoresSnooze
      ? fireKey(view.reminder.id, Date.parse(view.reminder.remindAt))
      : fireKey(view.reminder.id, effective);
    if (state.fired[key] !== undefined) continue;
    if (effective < now - catchUpMs) {
      missed.push({ key, view, effective });
      continue;
    }
    if (effective > now + horizonMs) continue;
    desired.push({ key, view, effective });
  }
  const byTime = (a: DesiredItem, b: DesiredItem) =>
    a.effective - b.effective || (a.key < b.key ? -1 : 1);
  desired.sort(byTime);
  missed.sort(byTime);
  return { desired, missed };
}
