import type { Task } from "../api/client";

/** The viewer's IANA time zone, or `undefined` when the platform cannot report one. */
export function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/** Order tasks by their due instant, soonest first (tasks without a due date keep their place). */
export function byDue(tasks: Task[]): Task[] {
  const instant = (task: Task) => (task.due_at ? Date.parse(task.due_at) : Number.POSITIVE_INFINITY);
  return [...tasks].sort((a, b) => instant(a) - instant(b));
}

/** Split the Today view into overdue and due-today tasks, preserving the server's order. */
export function groupToday(tasks: Task[]): { overdue: Task[]; dueToday: Task[] } {
  const overdue: Task[] = [];
  const dueToday: Task[] = [];
  for (const task of tasks) {
    if (task.due_state === "overdue") {
      overdue.push(task);
    } else if (task.due_state === "today") {
      dueToday.push(task);
    }
  }
  return { overdue, dueToday };
}

export interface DayGroup {
  /** Stable sort key: the ISO calendar day the tasks fall on in the viewer's zone. */
  key: string;
  /** Human label for the day, e.g. "Mon, Oct 26". */
  label: string;
  tasks: Task[];
}

/** Group the Upcoming view by the calendar day each task is due, in the viewer's time zone. */
export function groupUpcomingByDay(tasks: Task[], timeZone?: string): DayGroup[] {
  const keyFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const labelFormat = new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });

  const groups = new Map<string, DayGroup>();
  for (const task of byDue(tasks)) {
    if (!task.due_at) {
      continue;
    }
    const due = new Date(task.due_at);
    const key = keyFormat.format(due);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: labelFormat.format(due), tasks: [] };
      groups.set(key, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The wall-clock time that stands for "no particular time" on a due date. */
export const END_OF_DAY = "23:59";

interface WallClock {
  date: string;
  time: string;
}

/** The wall-clock date and time of an instant in `timeZone` (the viewer's when omitted). */
export function wallClock(instant: string, timeZone?: string): WallClock {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
  } catch {
    // An unknown zone cannot be formatted here; the server will explain it when saved.
    return wallClock(instant, undefined);
  }
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** True when a due instant is a date-only due (end of day in its zone). */
export function isDateOnlyDue(instant: string, timeZone?: string): boolean {
  return wallClock(instant, timeZone).time === END_OF_DAY;
}

/**
 * A short label for a task's due instant, rendered in `timeZone`. A date-only due (end of day,
 * ADR-0044) shows the date without a clock time.
 */
export function formatDue(due: string, timeZone?: string): string {
  const dateOnly = isDateOnlyDue(due, timeZone);
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(dateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
  }).format(new Date(due));
}

/**
 * The one date format of the app (UX-07): weekday, month and day in the viewer's locale
 * ("Wed, Nov 4"), with the year only when it is not the current year. `date` is a calendar day
 * (`YYYY-MM-DD`, as project dates and the due filter are); an unparseable value is shown as is.
 */
export function formatDay(date: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return new Intl.DateTimeFormat(undefined, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(year === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/** Sentence-case display text for a value such as `high` or `on_hold` ("High", "On hold"). */
export function sentenceCase(value: string): string {
  const spaced = value.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The pill tone for a priority (UX-01): colour carries meaning only for the two that need
 * attention; medium is neutral and low is quiet.
 */
export function priorityPillClass(priority: string): string {
  switch (priority) {
    case "urgent":
      return "pill pill-danger";
    case "high":
      return "pill pill-warning";
    case "low":
      return "pill pill-quiet";
    default:
      return "pill";
  }
}
