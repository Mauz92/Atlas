import { tasksApi } from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { LoadError } from "../components/LoadError";
import { QuickCapture } from "../components/QuickCapture";
import { Skeleton } from "../components/Skeleton";
import { TaskList } from "../components/TaskList";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { useTaskView } from "../hooks/useTaskView";

/**
 * Captured tasks that have not been triaged yet (MU-01, J2). Each row is the shared task row
 * (UX-03): a checkbox and a "…" menu are always shown; "schedule for today", "pick a date" and
 * "move to a project" appear on hover or focus, and the list keys work (`t`, `m`, `p`, `x`). Giving
 * a task a date or a project moves it to `next`, which takes it out of the Inbox. The server
 * validates every change, and a delete can be undone.
 */
export function Inbox() {
  const { tasks, state, error, timeZone, reload, refresh } = useTaskView("inbox");
  const editor = useTaskEditor({ refresh, timeZone });

  async function capture(title: string) {
    await tasksApi.create(title);
    await refresh();
  }

  return (
    <section className="page inbox-page tinted-page">
      <h1>Inbox</h1>
      <p className="muted">Captured tasks waiting to be triaged.</p>
      <QuickCapture onCapture={capture} placeholder="Capture a task…" />

      {editor.error ? (
        <p className="error" role="alert">
          {editor.error}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <Skeleton label="Loading inbox" rows={4} />
      ) : tasks.length === 0 ? (
        <EmptyState icon="inbox">Inbox zero — everything has been triaged.</EmptyState>
      ) : (
        <div className="list-card">
          <TaskList
            tasks={tasks}
            timeZone={timeZone}
            actions={editor.actions}
            filable={editor.projects}
            onOpen={editor.open}
          />
        </div>
      )}
      {editor.overlays}
    </section>
  );
}
