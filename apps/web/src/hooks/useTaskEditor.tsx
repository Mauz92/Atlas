import { useCallback, useRef, useState } from "react";
import type { ReactElement } from "react";
import { useInRouterContext } from "react-router-dom";

import { tasksApi, type Task } from "../api/client";
import { RoutedTaskDetail } from "../components/RoutedTaskDetail";
import { TaskDetail } from "../components/TaskDetail";
import { UndoToast } from "../components/UndoToast";
import { useProjects } from "./useProjects";

export interface TaskEditorOptions {
  /** Refresh the list that hosts the editor, without a loading flash. */
  refresh: () => Promise<void>;
  timeZone?: string;
}

export interface TaskEditor {
  /** Open the detail panel on a task (every list calls this). */
  open: (task: Task) => void;
  /** Delete a task from a list row, offering undo. */
  remove: (task: Task) => Promise<void>;
  /** An error from a delete/undo started outside the panel. */
  error: string | null;
  /** The panel and the undo notice; render once at the end of the page. */
  overlays: ReactElement;
}

/**
 * Wires the one task detail surface (MU-01) into a list page: which task is open, refreshing the
 * list after a save, and delete with undo. Focus returns to the element that opened the panel when
 * it closes (if that element is still on the page), so keyboard users keep their place.
 */
export function useTaskEditor({
  refresh,
  timeZone,
}: TaskEditorOptions): TaskEditor {
  const [selected, setSelected] = useState<Task | null>(null);
  const [deleted, setDeleted] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const { projects, reload: reloadProjects } = useProjects();
  const routed = useInRouterContext();

  // A task change can move a project's progress (or its membership), so refresh both.
  const refreshAll = useCallback(async () => {
    void reloadProjects();
    await refresh();
  }, [refresh, reloadProjects]);

  const open = useCallback((task: Task) => {
    if (document.activeElement instanceof HTMLElement) {
      opener.current = document.activeElement;
    }
    setSelected(task);
  }, []);

  const close = useCallback(() => {
    setSelected(null);
    const element = opener.current;
    opener.current = null;
    if (element?.isConnected) {
      element.focus();
    }
  }, []);

  const remove = useCallback(
    async (task: Task) => {
      setError(null);
      try {
        await tasksApi.remove(task);
        setDeleted(task);
        await refreshAll();
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not delete the task",
        );
      }
    },
    [refreshAll],
  );

  const undo = useCallback(async () => {
    const task = deleted;
    if (!task) {
      return;
    }
    setDeleted(null);
    try {
      await tasksApi.restore(task.id);
      await refreshAll();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not undo the delete",
      );
    }
  }, [deleted, refreshAll]);

  const dismissToast = useCallback(() => setDeleted(null), []);

  // Outside a router (component tests of a single list) there is nowhere to navigate to.
  const Detail = routed ? RoutedTaskDetail : TaskDetail;

  const overlays = (
    <>
      {selected ? (
        <Detail
          task={selected}
          timeZone={timeZone}
          projects={projects}
          onClose={close}
          onOpenTask={setSelected}
          onRefresh={() => void refreshAll()}
          onSaved={(saved) => {
            setSelected(saved);
            void refreshAll();
          }}
          onDeleted={(task) => {
            // The panel already deleted it; close, show the undo and refresh the list.
            setSelected(null);
            setDeleted(task);
            opener.current = null;
            void refreshAll();
          }}
        />
      ) : null}
      {deleted ? (
        <UndoToast
          message={`Deleted “${deleted.title}”.`}
          onUndo={() => void undo()}
          onDismiss={dismissToast}
        />
      ) : null}
    </>
  );

  return { open, remove, error, overlays };
}
