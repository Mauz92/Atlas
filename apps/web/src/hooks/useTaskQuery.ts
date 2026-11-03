import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { tasksApi, type Task } from "../api/client";
import {
  listOptionsFor,
  PAGE_LIMIT,
  sortTasks,
  type TaskFilter,
} from "../lib/taskFilters";
import type { LoadState } from "./useTaskView";

export interface TaskQuery {
  /** The matching tasks, in the filter's sort order. */
  tasks: Task[];
  state: LoadState;
  error: string | null;
  /** True when the server's page limit was reached, so more tasks match than are shown. */
  truncated: boolean;
  reload: () => Promise<void>;
  /** Re-read without the loading state (after an edit or a bulk action). */
  refresh: () => Promise<void>;
}

/** Load the Tasks page list for a filter (MU-03). A late response for an older filter is dropped. */
export function useTaskQuery(filter: TaskFilter): TaskQuery {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const latest = useRef(0);
  // The filter is a fresh object each render; key the effect on its content.
  const key = JSON.stringify(filter);
  const current = useMemo(() => JSON.parse(key) as TaskFilter, [key]);

  const load = useCallback(async () => {
    const request = ++latest.current;
    try {
      const listing = await tasksApi.list(listOptionsFor(current));
      if (request !== latest.current) return;
      setTasks(sortTasks(listing.tasks, current.sort));
      setTruncated(listing.tasks.length >= PAGE_LIMIT);
      setError(null);
      setState("ready");
    } catch (err) {
      if (request !== latest.current) return;
      setError(err instanceof Error ? err.message : "Could not load tasks");
      setState("error");
    }
  }, [current]);

  const reload = useCallback(async () => {
    setState("loading");
    await load();
  }, [load]);

  useEffect(() => {
    void load();
  }, [load]);

  return { tasks, state, error, truncated, reload, refresh: load };
}
