import type { Task, TaskStatus } from "../api/client";

/**
 * Kanban board columns and the status state machine (M4-03).
 *
 * The five columns are exactly the task statuses, and every rule here mirrors the canonical
 * server table `services/api/atlas/tasks/state.py::TRANSITIONS` so the board can steer the user
 * away from a move that would be rejected. The **server remains authoritative**: it re-validates
 * every transition and an out-of-date client simply receives a `409`.
 */

/** The canonical status set, in board-column order (matches `state.py`). */
export const STATUS_ORDER: readonly TaskStatus[] = [
  "inbox",
  "next",
  "in_progress",
  "completed",
  "archived",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: "Inbox",
  next: "Next",
  in_progress: "In progress",
  completed: "Completed",
  archived: "Archived",
};

/** Allowed transitions — a client-side copy of the server's canonical table. */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  inbox: ["next", "in_progress", "completed", "archived"],
  next: ["inbox", "in_progress", "completed", "archived"],
  in_progress: ["inbox", "next", "completed", "archived"],
  completed: ["in_progress", "archived"],
  archived: ["inbox", "next"],
};

/** Whether a raw string is one of the canonical statuses. */
export function isStatus(value: string): value is TaskStatus {
  return (STATUS_ORDER as readonly string[]).includes(value);
}

/** The statuses a task in `status` may move to (empty for an unknown status). */
export function allowedTargets(status: string): TaskStatus[] {
  return isStatus(status) ? [...TRANSITIONS[status]] : [];
}

/** Whether the board may move a task from `from` to `to`. The server re-checks this. */
export function canMove(from: string, to: string): boolean {
  return isStatus(to) && allowedTargets(from).includes(to);
}

export interface BoardColumn {
  status: TaskStatus;
  label: string;
  /** The statuses a task in this column may move to (its own status is never a target). */
  targets: TaskStatus[];
}

/** The five board columns, in order. Pure and cheap; callers may cache the result. */
export function boardColumns(): BoardColumn[] {
  return STATUS_ORDER.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    targets: allowedTargets(status),
  }));
}

/** Group tasks by status; every canonical status is present (possibly with an empty list). */
export function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const grouped = Object.fromEntries(STATUS_ORDER.map((status) => [status, [] as Task[]])) as Record<
    TaskStatus,
    Task[]
  >;
  for (const task of tasks) {
    if (isStatus(task.status)) {
      grouped[task.status].push(task);
    }
  }
  return grouped;
}
