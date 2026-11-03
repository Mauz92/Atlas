import { formatDue, isDateOnlyDue, wallClock } from "./tasks";

/** What the due chip of a task row says (UX-09, ADR-0062). */
export interface DueChip {
  /** `overdue` and `today` carry a word, an icon and a colour; `later` is plain muted text. */
  kind: "overdue" | "today" | "later";
  /** The date and/or time part, `""` when the state word says it all ("Today" for a date-only due). */
  text: string;
}

interface DueSource {
  due_at?: string | null;
  due_state?: string | null;
  status: string;
  time_zone?: string | null;
}

/** The clock time of a due instant in `timeZone` ("15:00" in the viewer's locale). */
export function formatDueTime(due: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(due),
  );
}

/**
 * The due chip of a row. The state (overdue, due today) is computed by the server (`due_state`), so
 * it is never re-derived here. Inside a day group (`day`, a `YYYY-MM-DD` in the viewer's zone, as
 * Upcoming, Week and Today group them) a due that falls on that very day drops its date and keeps
 * only the time; a date-only due then says nothing, and a plain "later" chip is omitted.
 */
export function dueChip(task: DueSource, timeZone?: string, day?: string): DueChip | null {
  if (!task.due_at) return null;
  const zone = task.time_zone ?? timeZone;
  const open = task.status !== "completed";
  const sameDay = day !== undefined && wallClock(task.due_at, zone).date === day;
  const dateOnly = isDateOnlyDue(task.due_at, zone);
  const text = sameDay ? (dateOnly ? "" : formatDueTime(task.due_at, zone)) : formatDue(task.due_at, zone);
  if (task.due_state === "overdue" && open) return { kind: "overdue", text };
  if (task.due_state === "today" && open) {
    // "Today" already is the date; only a clock time adds anything.
    return { kind: "today", text: dateOnly ? "" : formatDueTime(task.due_at, zone) };
  }
  return text ? { kind: "later", text } : null;
}
