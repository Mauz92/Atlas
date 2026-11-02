import { useEffect, useMemo, useState } from "react";

import { tasksApi, type Task } from "../api/client";

/**
 * Parent titles for the subtasks in a list (UX-03 fix, ADR-0052).
 *
 * The server lists a subtask like any other task (ADR-0016: subtasks are tasks, and the views do
 * not hide them), so a row needs its parent's title as context. A parent that is in the same list
 * is named from it; any other is read once with `GET /api/tasks/{id}` and kept for the session
 * (a renamed parent shows its new title once it is listed again or the page is reloaded). A parent
 * that cannot be read (deleted, offline) is simply not named.
 */
const known = new Map<string, string>();
const pending = new Map<string, Promise<void>>();

function load(id: string): Promise<void> {
  let request = pending.get(id);
  if (!request) {
    request = (async () => {
      try {
        const parent = await tasksApi.get(id);
        if (parent?.title) known.set(id, parent.title);
      } catch {
        // Not named; the row still works. A later list may try again.
        pending.delete(id);
      }
    })();
    pending.set(id, request);
  }
  return request;
}

type TitledTask = Pick<Task, "id" | "title"> & { parent_task_id?: string | null };

export function useParentTitles(tasks: readonly TitledTask[]): Map<string, string> {
  const [version, setVersion] = useState(0);

  // Everything in the list is a fresh title for any subtask that points at it.
  for (const task of tasks) {
    if (known.has(task.id)) known.set(task.id, task.title);
  }
  const missing = useMemo(() => {
    const listed = new Map(tasks.map((task) => [task.id, task.title]));
    return [
      ...new Set(
        tasks
          .map((task) => task.parent_task_id)
          .filter((id): id is string => Boolean(id) && !listed.has(id!) && !known.has(id!)),
      ),
    ];
  }, [tasks]);

  useEffect(() => {
    if (missing.length === 0) return;
    let cancelled = false;
    void Promise.all(missing.map(load)).then(() => {
      if (!cancelled) setVersion((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [missing]);

  return useMemo(() => {
    const titles = new Map<string, string>();
    const listed = new Map(tasks.map((task) => [task.id, task.title]));
    for (const task of tasks) {
      const id = task.parent_task_id;
      if (!id) continue;
      const title = listed.get(id) ?? known.get(id);
      if (title) titles.set(id, title);
    }
    return titles;
    // `version` re-reads the cache after a fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, version]);
}

/** Test hook: forget every cached title. */
export function resetParentTitles() {
  known.clear();
  pending.clear();
}
