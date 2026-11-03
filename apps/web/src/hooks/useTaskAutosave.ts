import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { tasksApi, type Task } from "../api/client";
import {
  openSession,
  releaseSession,
  type AutosaveSnapshot,
  type SavedListener,
  type TaskAutosave,
} from "../lib/taskAutosave";

interface Options {
  viewerZone?: string;
  /** After every confirmed save (refresh lists, look for a next occurrence). */
  onSaved?: SavedListener;
}

/**
 * Binds the task detail to its autosave session (`lib/taskAutosave.ts`, ADR-0053). The session is
 * shared per task and outlives the panel while it holds unsaved edits; the panel must be keyed by
 * task id (one session per mount). A newer copy of the task from outside (`task` prop) is adopted
 * only when nothing local is pending.
 */
export function useTaskAutosave(
  task: Task,
  { viewerZone, onSaved }: Options = {},
): { session: TaskAutosave; snapshot: AutosaveSnapshot } {
  const [session] = useState(() =>
    openSession({
      task,
      viewerZone,
      send: (base, fields, options) => tasksApi.update(base, fields, options),
    }),
  );
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);

  useEffect(() => () => releaseSession(session), [session]);

  const saved = useRef(onSaved);
  saved.current = onSaved;
  useEffect(
    () => session.onSaved((next, previous) => saved.current?.(next, previous)),
    [session],
  );

  useEffect(() => {
    session.adopt(task);
  }, [session, task]);

  return { session, snapshot };
}
