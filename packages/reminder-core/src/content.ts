import type { NotificationContent } from "./ports.ts";
import type { ContentMode, ReminderView } from "./types.ts";

export const GENERIC_TITLE = "Atlas";
export const GENERIC_BODY = "A task is due";

/**
 * The text of one reminder, chosen when the alarm is scheduled. In `generic` mode the task title is
 * never read, so it cannot reach the OS, the plugin's saved notification JSON or a lock screen
 * (SYNC_PROTOCOL.md 14.4 item 10). A `full` notification without a known title falls back to the
 * generic text.
 */
export function contentFor(
  view: ReminderView,
  mode: ContentMode,
  key: string | null = null,
): NotificationContent {
  const title = mode === "full" ? view.task.title?.trim() : null;
  if (mode === "full" && title) {
    return {
      title: "Reminder",
      body: title,
      mode,
      taskId: view.reminder.taskId,
      reminderId: view.reminder.id,
      key,
    };
  }
  return {
    title: GENERIC_TITLE,
    body: GENERIC_BODY,
    mode: "generic",
    taskId: view.reminder.taskId,
    reminderId: view.reminder.id,
    key,
  };
}

/** One notification for a burst or a catch-up; carries a count only, never any title. */
export function summaryContent(count: number): NotificationContent {
  return {
    title: GENERIC_TITLE,
    body: count === 1 ? GENERIC_BODY : `${count} reminders are due`,
    mode: "generic",
    taskId: null,
    reminderId: null,
    key: null,
  };
}
