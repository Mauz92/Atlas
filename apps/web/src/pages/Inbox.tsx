import { tasksApi } from "../api/client";
import { LoadError } from "../components/LoadError";
import { QuickCapture } from "../components/QuickCapture";
import { TaskList } from "../components/TaskList";
import { useTaskView } from "../hooks/useTaskView";

/** Captured tasks that have not been triaged yet, with title-only quick capture. */
export function Inbox() {
  const { tasks, state, error, actionError, timeZone, reload, complete } = useTaskView("inbox");

  async function capture(title: string) {
    await tasksApi.create(title);
    await reload();
  }

  return (
    <section className="page inbox-page">
      <h1>Inbox</h1>
      <p className="muted">Captured tasks waiting to be triaged.</p>
      <QuickCapture onCapture={capture} placeholder="Capture a task…" />

      {actionError ? (
        <p className="error" role="alert">
          {actionError}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <p className="muted">Loading inbox…</p>
      ) : tasks.length === 0 ? (
        <div className="empty-state">Inbox zero — everything has been triaged.</div>
      ) : (
        <TaskList tasks={tasks} timeZone={timeZone} onComplete={(task) => void complete(task)} />
      )}
    </section>
  );
}
