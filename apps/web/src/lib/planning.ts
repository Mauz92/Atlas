import type { Project, Task, TaskView } from "../api/client";
import { byDue, groupUpcomingByDay, type DayGroup } from "./tasks";

/**
 * Day/week planning rules (M4-06).
 *
 * The server stays authoritative for *what* a task's due state is (`due_state`, computed from the
 * task's own IANA zone or the caller's — ADR-0014) and for the primary views (ADR-0017). This
 * module only turns an instant into the **viewer's local calendar day** and assembles the day and
 * week *windows* the existing `GET /api/tasks` `due_from`/`due_to` filters take, so the planner can
 * show a single day or a week without any new date arithmetic beyond that conversion
 * (ADR-0025). Day keys and labels are produced with `Intl.DateTimeFormat` in a zone, the same
 * approach the Upcoming view already uses (no manual UTC-offset maths, so DST is handled by the
 * platform).
 */

/**
 * The statuses a plan shows: the same "active" set the server's Today/Upcoming views use — a
 * completed or archived task is not open work to plan (ADR-0017). Sent as the `status` filter so
 * the server does the filtering.
 */
export const ACTIVE_STATUSES = ["inbox", "next", "in_progress"] as const;

/** A `due_at` window for `GET /api/tasks`, as ISO instants. Both bounds are inclusive (ADR-0018). */
export interface DueWindow {
  dueFrom: string;
  dueTo: string;
}

/** What a planning view asks the server for: a primary `view`, or a `due_at` window. */
export interface PlanningWindow extends Partial<DueWindow> {
  view?: TaskView;
}

const keyFormats = new Map<string, Intl.DateTimeFormat>();

function dayKeyFormat(timeZone?: string): Intl.DateTimeFormat {
  const cacheKey = timeZone ?? "";
  let format = keyFormats.get(cacheKey);
  if (!format) {
    // `en-CA` with a 2-digit month/day yields a stable, sortable `YYYY-MM-DD` key.
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    keyFormats.set(cacheKey, format);
  }
  return format;
}

const dayLabelFormats = new Map<string, Intl.DateTimeFormat>();

function dayLabelFormat(timeZone?: string): Intl.DateTimeFormat {
  const cacheKey = timeZone ?? "";
  let format = dayLabelFormats.get(cacheKey);
  if (!format) {
    format = new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
    });
    dayLabelFormats.set(cacheKey, format);
  }
  return format;
}

/** The calendar day (`YYYY-MM-DD`) an instant falls on in `timeZone` (the viewer's when unset). */
export function dayKeyOf(instant: Date | string, timeZone?: string): string {
  return dayKeyFormat(timeZone).format(typeof instant === "string" ? new Date(instant) : instant);
}

/** A short label for the day an instant falls on, e.g. "Mon, Oct 26". */
export function dayLabelOf(instant: Date | string, timeZone?: string): string {
  return dayLabelFormat(timeZone).format(typeof instant === "string" ? new Date(instant) : instant);
}

/** A label for a whole week, e.g. "Oct 26 – Nov 1, 2026". */
export function weekLabelOf(weekStart: Date, timeZone?: string): string {
  const start = startOfDay(weekStart);
  const end = addDays(start, 6);
  const format = (date: Date, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(undefined, { timeZone, ...options }).format(date);
  const sameYear = start.getFullYear() === end.getFullYear();
  const head = format(start, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
  return `${head} – ${format(end, { month: "short", day: "numeric", year: "numeric" })}`;
}

/**
 * The local calendar day of `date`, as midnight in the browser's zone — the zone
 * `viewerTimeZone()` reports and therefore the zone the API is told about. Because both the
 * window below and the placement helpers use the same zone, a task is fetched and grouped
 * consistently.
 */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** `date` shifted by `days` calendar days (DST-safe: the local time of day is preserved). */
export function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/** The Monday that starts the ISO week containing `date`, at local midnight. */
export function startOfWeek(date: Date): Date {
  const start = startOfDay(date);
  const weekday = (start.getDay() + 6) % 7; // Monday = 0 … Sunday = 6
  return addDays(start, -weekday);
}

/** The seven local days of the week beginning at `weekStart`, Monday first. */
export function weekDates(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, index) => addDays(startOfDay(weekStart), index));
}

/**
 * The inclusive `due_at` range covering one local day: its midnight to the following midnight.
 * The API's bounds are inclusive, so the closing midnight is *also* the next day's opening one —
 * harmless, because placement is decided by `tasksForDay`/`weekDayGroups` in the same zone, so a
 * task due exactly at midnight is shown on exactly one day.
 */
export function dayWindow(date: Date): DueWindow {
  const start = startOfDay(date);
  return { dueFrom: start.toISOString(), dueTo: addDays(start, 1).toISOString() };
}

/** The inclusive `due_at` range covering the week beginning at `weekStart` (Monday). */
export function weekWindow(weekStart: Date): DueWindow {
  const start = startOfDay(weekStart);
  return { dueFrom: start.toISOString(), dueTo: addDays(start, 7).toISOString() };
}

/**
 * The tasks due on one local calendar day, soonest first. Placement is by the instant's calendar
 * day in `timeZone`, so a task due 23:30 UTC shows on the *next* day for a viewer in Berlin.
 * Tasks without a due date never belong to a day.
 *
 * `timeZone` must be the zone the `date` argument is expressed in — in the app that is always the
 * viewer's zone (`viewerTimeZone()`), the same zone sent to the API, so windows and placement
 * agree. `undefined` means the browser's zone.
 */
export function tasksForDay(tasks: Task[], date: Date, timeZone?: string): Task[] {
  const key = dayKeyOf(date, timeZone);
  return byDue(tasks).filter(
    (task) => task.due_at !== null && dayKeyOf(task.due_at, timeZone) === key,
  );
}

/**
 * Group a week's tasks into its seven local days, Monday first, **including empty days**, so the
 * week view always shows the same shape. Reuses `groupUpcomingByDay` for the placement and only
 * fills in the days with no work.
 */
export function weekDayGroups(tasks: Task[], weekStart: Date, timeZone?: string): DayGroup[] {
  const byKey = new Map(groupUpcomingByDay(tasks, timeZone).map((group) => [group.key, group]));
  return weekDates(weekStart).map((date) => {
    const key = dayKeyOf(date, timeZone);
    return byKey.get(key) ?? { key, label: dayLabelOf(date, timeZone), tasks: [] };
  });
}

/**
 * The distinct projects the given tasks belong to, in first-seen order, with their derived
 * progress (M4-04). A task that is unfiled, or whose project is not in `projectById`, adds
 * nothing.
 */
export function projectsForTasks(tasks: Task[], projectById: Map<string, Project>): Project[] {
  const seen = new Map<string, Project>();
  for (const task of tasks) {
    if (!task.project_id) {
      continue;
    }
    const project = projectById.get(task.project_id);
    if (project && !seen.has(project.id)) {
      seen.set(project.id, project);
    }
  }
  return [...seen.values()];
}

/** Index projects by id for task lookup (project context on a task row and in the summary). */
export function indexProjects(projects: Project[]): Map<string, Project> {
  return new Map(projects.map((project) => [project.id, project]));
}
