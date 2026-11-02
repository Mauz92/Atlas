import type { Task, TaskFields, TaskPriority, TaskStatus } from "../api/client";
import { END_OF_DAY, viewerTimeZone, wallClock } from "./tasks";

/**
 * Form-side helpers for the task detail panel (MU-01).
 *
 * The server stays authoritative for every rule (AGENTS.md §7.4): a due date is sent as the naive
 * wall-clock time plus the IANA zone and the **server** converts it to an instant, validates the
 * zone and rejects a time the zone skipped. This module only splits an instant into the date/time
 * the inputs show (with `Intl`, so DST is the platform's job) and builds the minimal `PATCH`.
 *
 * Convention (ADR-0044): a task has no "all-day" flag, so a due *date* without a time is stored as
 * the **end of that local day** (`23:59`). The form shows an empty time for such a task and the
 * lists omit the clock time, so a date-only task round-trips unchanged.
 */

export const PRIORITIES: readonly TaskPriority[] = [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
];

/** What the form fields hold. Everything is a string so an input can be edited freely. */
export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  /** `YYYY-MM-DD`, or empty for no due date. */
  dueDate: string;
  /** `HH:mm`, or empty for "end of the day". */
  dueTime: string;
  /** An IANA zone name, or empty to use the viewer's zone. */
  timeZone: string;
  /** `YYYY-MM-DDTHH:mm`, or empty for no start. */
  start: string;
  /** Comma-separated tag names. */
  tags: string;
  /** The project's id, or empty for no project. */
  projectId: string;
  /** An RFC 5545 RRULE (no `RRULE:` prefix), or empty for a task that does not repeat. */
  recurrenceRule: string;
}

/** The ready-made repeat choices; anything else is a custom RRULE the server validates. */
export const REPEAT_PRESETS = [
  { id: "daily", label: "Daily", rule: "FREQ=DAILY" },
  { id: "weekly", label: "Weekly", rule: "FREQ=WEEKLY" },
  { id: "monthly", label: "Monthly", rule: "FREQ=MONTHLY" },
] as const;

/** Which repeat choice a rule corresponds to: "" (none), a preset id, or "custom". */
export function repeatChoice(rule: string): string {
  const trimmed = rule.trim();
  if (trimmed === "") return "";
  return (
    REPEAT_PRESETS.find((preset) => preset.rule === trimmed)?.id ?? "custom"
  );
}

/**
 * The naive wall-clock instant a series is anchored on, for the server's preview. Mirrors the
 * server's anchor precedence (due date before start) without doing any date maths.
 */
export function recurrenceAnchor(draft: TaskDraft): string | null {
  if (draft.dueDate)
    return `${draft.dueDate}T${draft.dueTime || END_OF_DAY}:00`;
  if (draft.start) return `${draft.start}:00`;
  return null;
}

/** Today's calendar date (`YYYY-MM-DD`) in `timeZone`, offset by `days`. */
export function localDate(
  days = 0,
  timeZone: string | undefined = viewerTimeZone(),
  now = new Date(),
) {
  const base = wallClock(now.toISOString(), timeZone).date;
  if (days === 0) {
    return base;
  }
  // Calendar arithmetic on the date only (noon UTC avoids any DST edge).
  const [year, month, day] = base.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return shifted.toISOString().slice(0, 10);
}

/** The fields that make a task due on `date` (a date-only due, in the viewer's zone). */
export function dueOn(date: string, timeZone?: string): TaskFields {
  return {
    due_at: `${date}T${END_OF_DAY}:00`,
    ...(timeZone ? { time_zone: timeZone } : {}),
  };
}

/** The initial form values for a task, rendering its instants in the task's own zone. */
export function draftFromTask(
  task: Task,
  viewerZone: string | undefined,
): TaskDraft {
  const zone = task.time_zone ?? viewerZone;
  const due = task.due_at ? wallClock(task.due_at, zone) : null;
  const start = task.start_at ? wallClock(task.start_at, zone) : null;
  return {
    title: task.title,
    description: task.description ?? "",
    status: task.status as TaskStatus,
    priority: task.priority as TaskPriority,
    dueDate: due?.date ?? "",
    dueTime: due && due.time !== END_OF_DAY ? due.time : "",
    timeZone: task.time_zone ?? "",
    start: start ? `${start.date}T${start.time}` : "",
    tags: (task.tags ?? []).join(", "),
    projectId: task.project_id ?? "",
    recurrenceRule: task.recurrence_rule ?? "",
  };
}

/** Parse the comma-separated tag input into names (the server normalises and validates them). */
export function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
}

export function draftsEqual(a: TaskDraft, b: TaskDraft): boolean {
  return (Object.keys(a) as (keyof TaskDraft)[]).every(
    (key) => a[key] === b[key],
  );
}

/**
 * The minimal `PATCH` body for edits made to `draft` since `initial`: only changed fields are sent,
 * so an edit can never clobber a field the user did not touch. Date, time and zone are sent
 * together whenever any of them changed, because they jointly define the instant.
 */
export function changesFromDraft(
  initial: TaskDraft,
  draft: TaskDraft,
  viewerZone: string | undefined,
): TaskFields {
  const changes: TaskFields = {};
  if (draft.title !== initial.title) changes.title = draft.title;
  if (draft.description !== initial.description) {
    changes.description =
      draft.description.trim() === "" ? null : draft.description;
  }
  if (draft.status !== initial.status) changes.status = draft.status;
  if (draft.priority !== initial.priority) changes.priority = draft.priority;

  const zoneChanged = draft.timeZone !== initial.timeZone;
  // A zone change re-interprets an existing wall-clock value, so it only touches fields that are set.
  const dueChanged =
    draft.dueDate !== initial.dueDate ||
    draft.dueTime !== initial.dueTime ||
    (zoneChanged && draft.dueDate !== "");
  const startChanged =
    draft.start !== initial.start || (zoneChanged && draft.start !== "");
  if (zoneChanged) {
    changes.time_zone =
      draft.timeZone.trim() === "" ? null : draft.timeZone.trim();
  }
  const zone = draft.timeZone.trim() || viewerZone;
  if (dueChanged) {
    if (draft.dueDate === "") {
      changes.due_at = null;
    } else {
      changes.due_at = `${draft.dueDate}T${draft.dueTime || END_OF_DAY}:00`;
      if (!("time_zone" in changes) && !draft.timeZone.trim() && zone) {
        // A task with no zone of its own is pinned to the viewer's zone once it gets a due time.
        changes.time_zone = zone;
      }
    }
  }
  if (startChanged) {
    changes.start_at = draft.start === "" ? null : `${draft.start}:00`;
    if (
      draft.start !== "" &&
      !("time_zone" in changes) &&
      !draft.timeZone.trim() &&
      zone
    ) {
      changes.time_zone = zone;
    }
  }
  if (draft.tags !== initial.tags) changes.tags = parseTags(draft.tags);
  if (draft.projectId !== initial.projectId) {
    changes.project_id = draft.projectId === "" ? null : draft.projectId;
  }
  if (draft.recurrenceRule.trim() !== initial.recurrenceRule.trim()) {
    changes.recurrence_rule =
      draft.recurrenceRule.trim() === "" ? null : draft.recurrenceRule.trim();
    if (
      changes.recurrence_rule &&
      !("time_zone" in changes) &&
      !draft.timeZone.trim() &&
      zone
    ) {
      // Occurrences keep their wall-clock time in the series' zone, so the series needs one.
      changes.time_zone = zone;
    }
  }
  return changes;
}
