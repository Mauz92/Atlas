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

/** A short "date and time" label for a task's due instant, rendered in the viewer's zone. */
export function formatDue(due: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(due));
}
