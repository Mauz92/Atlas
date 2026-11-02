import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, tasksApi, type Task, type TaskStatus } from "../api/client";
import {
  STATUS_LABELS,
  boardColumns,
  canMove,
  groupByStatus,
  isStatus,
  type BoardColumn,
} from "../lib/taskStatus";
import { viewerTimeZone } from "../lib/tasks";

export type LoadState = "loading" | "ready" | "error";

export interface BoardResult {
  /** The five columns (status + label + allowed targets). */
  columns: BoardColumn[];
  /** The caller's tasks grouped by status. */
  tasksByStatus: Record<string, Task[]>;
  /** Total number of tasks on the board. */
  total: number;
  state: LoadState;
  /** A failure from loading the board. */
  error: string | null;
  /** A failure from moving a task (a rejected transition, a stale revision, or a network error). */
  actionError: string | null;
  /** The id of the task whose move is in flight, if any. */
  movingId: string | null;
  /** The viewer's IANA zone, forwarded to the API so due states match the server's. */
  timeZone: string | undefined;
  reload: () => Promise<void>;
  /** Re-read the board without the loading state (after an edit made in the detail panel). */
  refresh: () => Promise<void>;
  move: (task: Task, toStatus: string) => Promise<void>;
}

/** The columns never change at runtime, so build them once. */
const COLUMNS = boardColumns();

function moveErrorMessage(err: unknown, task: Task, toStatus: string): string {
  const label = isStatus(toStatus) ? STATUS_LABELS[toStatus] : toStatus;
  if (err instanceof ApiError) {
    if (err.status === 409 && err.currentRevision !== null) {
      return `Could not move "${task.title}": it changed elsewhere. Reload the board and try again.`;
    }
    return `Could not move "${task.title}" to ${label}: ${err.message}.`;
  }
  return err instanceof Error
    ? `Could not move "${task.title}": ${err.message}`
    : `Could not move "${task.title}".`;
}

/**
 * Load the board and move tasks between columns (M4-03).
 *
 * Tasks are read with a single `GET /api/tasks` listing and grouped by status on the client (the
 * columns *are* the statuses, so no per-column request is needed). A move is persisted through
 * `PATCH /api/tasks/{id}` with the task's `base_revision`; on success the returned task replaces
 * the local copy, and on failure the error is surfaced (never silently ignored) while the card
 * stays in its column. Keeping the API calls here means `Board` only renders state.
 */
export function useBoard(projectId?: string): BoardResult {
  const timeZone = useMemo(() => viewerTimeZone(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const listing = await tasksApi.list({ tz: timeZone, projectId });
      setTasks(listing.tasks);
      setError(null);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the board");
      setState("error");
    }
  }, [timeZone, projectId]);

  const reload = useCallback(async () => {
    setState("loading");
    await load();
  }, [load]);

  const move = useCallback(async (task: Task, toStatus: string) => {
    setActionError(null);
    if (!canMove(task.status, toStatus)) {
      setActionError(
        `A task in ${STATUS_LABELS[task.status as TaskStatus] ?? task.status} cannot move here.`,
      );
      return;
    }
    setMovingId(task.id);
    try {
      const updated = await tasksApi.setStatus(task, toStatus as TaskStatus);
      setTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setActionError(moveErrorMessage(err, task, toStatus));
    } finally {
      setMovingId(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tasksByStatus = useMemo(() => groupByStatus(tasks), [tasks]);

  return {
    columns: COLUMNS,
    tasksByStatus,
    total: tasks.length,
    state,
    error,
    actionError,
    movingId,
    timeZone,
    reload,
    refresh: load,
    move,
  };
}
