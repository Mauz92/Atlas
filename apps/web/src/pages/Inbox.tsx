import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { projectsApi, tasksApi, type Project, type Task } from "../api/client";
import { InboxActions } from "../components/InboxActions";
import { LoadError } from "../components/LoadError";
import { QuickCapture } from "../components/QuickCapture";
import { TaskList } from "../components/TaskList";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { useTaskView } from "../hooks/useTaskView";
import { dueOn, localDate } from "../lib/taskForm";

/**
 * Captured tasks that have not been triaged yet. Each row can be scheduled, filed to a project or
 * deleted in place (MU-01, J2); scheduling or filing moves the task to `next`, which takes it out
 * of the Inbox. The server validates every change, and a delete can be undone.
 */
export function Inbox() {
  const {
    tasks,
    state,
    error,
    actionError,
    timeZone,
    reload,
    refresh,
    complete,
  } = useTaskView("inbox");
  const editor = useTaskEditor({ refresh, timeZone });
  const [projects, setProjects] = useState<Project[]>([]);
  const [triageError, setTriageError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const page = useRef<HTMLElement>(null);

  useEffect(() => {
    // Projects are only needed for the "File to…" control; the Inbox works without them.
    let cancelled = false;
    projectsApi
      .list()
      .then((listing) => {
        if (!cancelled) setProjects(listing.projects);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function capture(title: string) {
    await tasksApi.create(title);
    await refresh();
  }

  /**
   * Keep the keyboard in the list after a row leaves it. The focus moves in a layout effect, in the
   * same commit that removes the row, so it can never land after the user has moved on.
   */
  const [focusRequest, setFocusRequest] = useState(0);
  useLayoutEffect(() => {
    if (focusRequest > 0) {
      page.current?.querySelector<HTMLElement>(".task-open")?.focus();
    }
  }, [focusRequest]);
  const focusFirstRow = () => setFocusRequest((n) => n + 1);

  async function triage(action: () => Promise<unknown>, failure: string) {
    setTriageError(null);
    setBusy(true);
    try {
      await action();
      await refresh();
      focusFirstRow();
    } catch (err) {
      setTriageError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  function schedule(task: Task, when: "today" | "tomorrow" | { date: string }) {
    const date =
      typeof when === "object"
        ? when.date
        : localDate(when === "today" ? 0 : 1, timeZone);
    return triage(
      () => tasksApi.update(task, { status: "next", ...dueOn(date, timeZone) }),
      "Could not schedule the task",
    );
  }

  function file(task: Task, projectId: string) {
    return triage(
      () => tasksApi.update(task, { status: "next", project_id: projectId }),
      "Could not file the task",
    );
  }

  async function remove(task: Task) {
    setBusy(true);
    await editor.remove(task);
    setBusy(false);
    focusFirstRow();
  }

  const shownError = actionError ?? triageError ?? editor.error;

  return (
    <section className="page inbox-page" ref={page}>
      <h1>Inbox</h1>
      <p className="muted">Captured tasks waiting to be triaged.</p>
      <QuickCapture onCapture={capture} placeholder="Capture a task…" />

      {shownError ? (
        <p className="error" role="alert">
          {shownError}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <p className="muted" role="status">Loading inbox…</p>
      ) : tasks.length === 0 ? (
        <div className="empty-state">
          Inbox zero — everything has been triaged.
        </div>
      ) : (
        <TaskList
          tasks={tasks}
          timeZone={timeZone}
          onComplete={(task) => void complete(task)}
          onOpen={editor.open}
          renderActions={(task) => (
            <InboxActions
              task={task}
              projects={projects}
              disabled={busy}
              onSchedule={(t, when) => void schedule(t, when)}
              onFile={(t, projectId) => void file(t, projectId)}
              onDelete={(t) => void remove(t)}
            />
          )}
        />
      )}
      {editor.overlays}
    </section>
  );
}
