import type { Task, TaskListOptions } from "../api/client";
import { formatDay, sentenceCase } from "./tasks";

/**
 * The Tasks page filter (MU-03). It lives in the URL query string, so a view is linkable and
 * survives a reload; every field is a plain string and an absent parameter means the default.
 * The server validates the values (status, priority, dates, length) and its message is shown
 * verbatim, so unknown values are passed through rather than silently repaired here.
 */

export type SortKey = "urgency" | "due" | "newest" | "title";

export const SORT_LABELS: Record<SortKey, string> = {
  urgency: "Most urgent",
  due: "Due date",
  newest: "Newest",
  title: "Title",
};

/** The status choices of the Status chip: `[value, label]`. */
export const STATUS_CHOICES: [string, string][] = [
  ["open", "Open"],
  ["all", "All statuses"],
  ["inbox", "Inbox"],
  ["next", "Next"],
  ["in_progress", "In progress"],
  ["completed", "Completed"],
  ["archived", "Archived"],
];

/** `open` (the default) is every status that still needs work; `all` adds completed/archived. */
export const OPEN_STATUSES = ["inbox", "next", "in_progress"] as const;
/** The most the page asks for; the server bounds it too (`MAX_LIMIT`). */
export const PAGE_LIMIT = 500;

export interface TaskFilter {
  /** `open`, `all`, or one task status. */
  status: string;
  priority: string;
  /** A project id, or empty for any. */
  project: string;
  /** Local dates, `YYYY-MM-DD`, inclusive. */
  dueFrom: string;
  dueTo: string;
  q: string;
  sort: SortKey;
}

export const DEFAULT_FILTER: TaskFilter = {
  status: "open",
  priority: "",
  project: "",
  dueFrom: "",
  dueTo: "",
  q: "",
  sort: "urgency",
};

const PARAMS: Record<keyof TaskFilter, string> = {
  status: "status",
  priority: "priority",
  project: "project",
  dueFrom: "due_from",
  dueTo: "due_to",
  q: "q",
  sort: "sort",
};

export function filterFromParams(params: URLSearchParams): TaskFilter {
  const read = (key: keyof TaskFilter) =>
    params.get(PARAMS[key]) ?? DEFAULT_FILTER[key];
  const sort = read("sort");
  return {
    status: read("status"),
    priority: read("priority"),
    project: read("project"),
    dueFrom: read("dueFrom"),
    dueTo: read("dueTo"),
    q: read("q"),
    sort: sort in SORT_LABELS ? (sort as SortKey) : DEFAULT_FILTER.sort,
  };
}

/** Only non-default fields are written, so the default view has a clean `/tasks` URL. */
export function filterToParams(filter: TaskFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of Object.keys(PARAMS) as (keyof TaskFilter)[]) {
    if (filter[key] !== DEFAULT_FILTER[key]) {
      params.set(PARAMS[key], filter[key]);
    }
  }
  return params;
}

/** What the Due chip offers besides a custom range (UX-07). */
export type DuePreset = "any" | "overdue" | "today" | "week";

export const DUE_PRESETS: [DuePreset, string][] = [
  ["any", "Any date"],
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["week", "Next 7 days"],
];

/** A local calendar day as `YYYY-MM-DD` (the browser's zone, the one "today" means everywhere). */
export function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shifted(date: Date, days: number): Date {
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  next.setDate(next.getDate() + days);
  return next;
}

/** The inclusive due range of a preset, from `now`'s local day. */
export function dueRangeFor(
  preset: DuePreset,
  now: Date = new Date(),
): Pick<TaskFilter, "dueFrom" | "dueTo"> {
  switch (preset) {
    case "overdue":
      return { dueFrom: "", dueTo: localDay(shifted(now, -1)) };
    case "today":
      return { dueFrom: localDay(now), dueTo: localDay(now) };
    case "week":
      return { dueFrom: localDay(now), dueTo: localDay(shifted(now, 6)) };
    default:
      return { dueFrom: "", dueTo: "" };
  }
}

/** The preset the filter's range equals, `custom` for any other range. */
export function duePresetOf(
  filter: Pick<TaskFilter, "dueFrom" | "dueTo">,
  now: Date = new Date(),
): DuePreset | "custom" {
  for (const [preset] of DUE_PRESETS) {
    const range = dueRangeFor(preset, now);
    if (range.dueFrom === filter.dueFrom && range.dueTo === filter.dueTo) return preset;
  }
  return "custom";
}

/** The Due chip's value text: empty for no range, a preset name, or the range's dates. */
export function dueLabel(
  filter: Pick<TaskFilter, "dueFrom" | "dueTo">,
  now: Date = new Date(),
): string {
  const preset = duePresetOf(filter, now);
  if (preset === "any") return "";
  if (preset !== "custom") return DUE_PRESETS.find(([key]) => key === preset)?.[1] ?? "";
  const { dueFrom, dueTo } = filter;
  if (dueFrom && dueTo) return `${formatDay(dueFrom, now)} – ${formatDay(dueTo, now)}`;
  return dueFrom ? `From ${formatDay(dueFrom, now)}` : `Until ${formatDay(dueTo, now)}`;
}

/** The text after the colon of each chip; empty when the chip is at its default (unset). */
export function chipValues(
  filter: TaskFilter,
  projectName: (id: string) => string | undefined,
  now: Date = new Date(),
): Record<"status" | "priority" | "project" | "due" | "sort", string> {
  return {
    status: STATUS_CHOICES.find(([value]) => value === filter.status)?.[1] ?? filter.status,
    priority: filter.priority ? sentenceCase(filter.priority) : "",
    project: filter.project ? (projectName(filter.project) ?? "Unknown project") : "",
    due: dueLabel(filter, now),
    sort: SORT_LABELS[filter.sort],
  };
}

/** True when anything but the default view is set (what "Reset filters" would change). */
export function isFiltered(filter: TaskFilter): boolean {
  return (Object.keys(DEFAULT_FILTER) as (keyof TaskFilter)[]).some(
    (key) => filter[key] !== DEFAULT_FILTER[key],
  );
}

/** The start (`end` false) or end of a local calendar day as an instant; unparseable text is kept. */
function dayBound(date: string, end: boolean): string {
  const instant = new Date(`${date}T${end ? "23:59:59.999" : "00:00:00"}`);
  return Number.isNaN(instant.getTime()) ? date : instant.toISOString();
}

export function listOptionsFor(filter: TaskFilter): TaskListOptions {
  const status =
    filter.status === "all"
      ? undefined
      : filter.status === "open"
        ? OPEN_STATUSES
        : (filter.status as TaskListOptions["status"]);
  return {
    status,
    priority: filter.priority || undefined,
    projectId: filter.project || undefined,
    dueFrom: filter.dueFrom ? dayBound(filter.dueFrom, false) : undefined,
    dueTo: filter.dueTo ? dayBound(filter.dueTo, true) : undefined,
    q: filter.q.trim() || undefined,
    limit: PAGE_LIMIT,
  };
}

const PRIORITY_RANK: Record<string, number> = {
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

function dueTime(task: Task): number {
  return task.due_at ? Date.parse(task.due_at) : Number.POSITIVE_INFINITY;
}

function byCreated(a: Task, b: Task): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at);
}

/** A stable client-side ordering; the server has no sort parameter (filtered lists arrive urgent-first). */
export function sortTasks(tasks: readonly Task[], sort: SortKey): Task[] {
  const compare: Record<SortKey, (a: Task, b: Task) => number> = {
    urgency: (a, b) =>
      (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0) ||
      compare.due(a, b),
    due: (a, b) => {
      const [x, y] = [dueTime(a), dueTime(b)];
      return x === y ? byCreated(a, b) : x < y ? -1 : 1;
    },
    newest: (a, b) => byCreated(b, a),
    title: (a, b) => a.title.localeCompare(b.title) || byCreated(a, b),
  };
  return [...tasks].sort(compare[sort]);
}

/** Saved filters (client-side shortcuts, stored in localStorage; the server knows nothing of them). */
export interface SavedFilter {
  id: string;
  name: string;
  /** The URL query string of the view, without the leading `?`. */
  query: string;
}

export const SAVED_FILTERS_KEY = "atlas.savedTaskFilters";
export const MAX_SAVED_FILTERS = 20;

function isSavedFilter(value: unknown): value is SavedFilter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.query === "string"
  );
}

/** Storage can be unavailable or corrupt (private windows, cleared data); the page works without it. */
export function loadSavedFilters(): SavedFilter[] {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(SAVED_FILTERS_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter(isSavedFilter).slice(0, MAX_SAVED_FILTERS)
      : [];
  } catch {
    return [];
  }
}

/** Returns false when the list could not be persisted. */
export function storeSavedFilters(filters: SavedFilter[]): boolean {
  try {
    window.localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(filters));
    return true;
  } catch {
    return false;
  }
}
