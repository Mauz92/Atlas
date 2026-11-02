import type { Task, TaskListOptions } from "../api/client";

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
