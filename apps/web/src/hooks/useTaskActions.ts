import { useCallback, useMemo, useRef, useState } from "react";

import {
  tasksApi,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../api/client";
import { scheduleFields, type ScheduleChoice } from "../lib/taskForm";

/**
 * The quick actions a task row, its menu and the list keys offer (UX-03, ADR-0052). Every action
 * is one existing server call: `PATCH /api/tasks/{id}` with the row's `base_revision` and a fresh
 * idempotency key (via `tasksApi`), so a stale row gets a `409` instead of overwriting a newer
 * edit and a retried request is applied once. The server validates every value and transition.
 */
export interface TaskActions {
  /** Complete an open task, or reopen a completed one (completed → in progress, ADR-0013). */
  toggleComplete: (task: Task) => Promise<void>;
  schedule: (task: Task, when: ScheduleChoice) => Promise<void>;
  setPriority: (task: Task, priority: TaskPriority) => Promise<void>;
  /** File a task under a project (`null` = no project). An Inbox task is triaged to `next`. */
  moveToProject: (task: Task, projectId: string | null) => Promise<void>;
  setStatus: (task: Task, status: TaskStatus) => Promise<void>;
  /** Delete with the page's undo notice. */
  remove: (task: Task) => Promise<void>;
  /** Ids of tasks with a change in flight; their controls are disabled meanwhile. */
  busy: ReadonlySet<string>;
  /** The last failure, in the server's words. */
  error: string | null;
}

interface Options {
  /** Re-read the page's lists (and project progress) after a change. */
  refresh: () => Promise<void>;
  timeZone?: string;
  /** Delete with undo (owned by `useTaskEditor`, which renders the notice). */
  remove: (task: Task) => Promise<void>;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

export function useTaskActions({ refresh, timeZone, remove }: Options): TaskActions {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // A synchronous guard as well as the state: two key presses in one frame must not send two
  // PATCHes with the same base revision.
  const inFlight = useRef(new Set<string>());

  const run = useCallback(
    async (task: Task, action: () => Promise<unknown>, failure: string) => {
      if (inFlight.current.has(task.id)) {
        return;
      }
      inFlight.current.add(task.id);
      setBusy(new Set(inFlight.current));
      setError(null);
      try {
        await action();
        await refresh();
      } catch (err) {
        setError(messageOf(err, failure));
        // A rejected change (for example a stale revision) leaves the row as the server has it.
        await refresh().catch(() => undefined);
      } finally {
        inFlight.current.delete(task.id);
        setBusy(new Set(inFlight.current));
      }
    },
    [refresh],
  );

  const toggleComplete = useCallback(
    (task: Task) =>
      task.status === "completed"
        ? run(task, () => tasksApi.setStatus(task, "in_progress"), "Could not reopen the task")
        : run(task, () => tasksApi.complete(task), "Could not complete the task"),
    [run],
  );

  const schedule = useCallback(
    (task: Task, when: ScheduleChoice) =>
      run(
        task,
        () => tasksApi.update(task, scheduleFields(task, when, timeZone)),
        "Could not schedule the task",
      ),
    [run, timeZone],
  );

  const setPriority = useCallback(
    (task: Task, priority: TaskPriority) =>
      run(task, () => tasksApi.update(task, { priority }), "Could not change the priority"),
    [run],
  );

  const moveToProject = useCallback(
    (task: Task, projectId: string | null) =>
      run(
        task,
        () =>
          tasksApi.update(task, {
            ...(task.status === "inbox" && projectId ? { status: "next" as const } : {}),
            project_id: projectId,
          }),
        "Could not move the task",
      ),
    [run],
  );

  const setStatus = useCallback(
    (task: Task, status: TaskStatus) =>
      run(task, () => tasksApi.setStatus(task, status), "Could not change the status"),
    [run],
  );

  const removeTask = useCallback(
    async (task: Task) => {
      if (inFlight.current.has(task.id)) {
        return;
      }
      inFlight.current.add(task.id);
      try {
        await remove(task);
      } finally {
        inFlight.current.delete(task.id);
      }
    },
    [remove],
  );

  return useMemo(
    () => ({
      toggleComplete,
      schedule,
      setPriority,
      moveToProject,
      setStatus,
      remove: removeTask,
      busy,
      error,
    }),
    [toggleComplete, schedule, setPriority, moveToProject, setStatus, removeTask, busy, error],
  );
}
