import { useCallback, useEffect, useMemo, useState } from "react";

import { tasksApi, type Task, type TaskView } from "../api/client";
import { viewerTimeZone } from "../lib/tasks";

export type LoadState = "loading" | "ready" | "error";

export interface TaskViewResult {
  tasks: Task[];
  state: LoadState;
  /** A failure from loading the view. */
  error: string | null;
  /** A failure from an action on the view (for example completing a task). */
  actionError: string | null;
  /** The viewer's IANA zone, forwarded to the API so "today" is the caller's calendar day. */
  timeZone: string | undefined;
  reload: () => Promise<void>;
  complete: (task: Task) => Promise<void>;
}

/**
 * Load one of the primary task views from the server (views are server-authoritative) and complete
 * tasks within it. Keeping the API calls here means the view components only render state.
 */
export function useTaskView(view: TaskView): TaskViewResult {
  const timeZone = useMemo(() => viewerTimeZone(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const listing = await tasksApi.list({ view, tz: timeZone });
      setTasks(listing.tasks);
      setError(null);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tasks");
      setState("error");
    }
  }, [view, timeZone]);

  const reload = useCallback(async () => {
    setState("loading");
    await load();
  }, [load]);

  const complete = useCallback(
    async (task: Task) => {
      setActionError(null);
      try {
        await tasksApi.complete(task);
        await load();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Could not complete the task");
      }
    },
    [load],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return { tasks, state, error, actionError, timeZone, reload, complete };
}
