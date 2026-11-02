import { tasksApi } from "../api/client";
import { LoadError } from "../components/LoadError";
import { QuickCapture } from "../components/QuickCapture";
import { TaskList } from "../components/TaskList";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { useTaskView } from "../hooks/useTaskView";
import { dueOn, localDate } from "../lib/taskForm";
import { groupToday } from "../lib/tasks";

/** The landing view: overdue and due-today tasks, with title-only quick capture. */
export function Today() {
  const {
    tasks,
    state,
    error,
    actionError,
    timeZone,
    reload,
    refresh,
    complete,
  } = useTaskView("today");
  const editor = useTaskEditor({ refresh, timeZone });
  const { overdue, dueToday } = groupToday(tasks);

  /** Capturing on Today means "today": the task is due on the viewer's current calendar day. */
  async function capture(title: string) {
    await tasksApi.create(title, dueOn(localDate(0, timeZone), timeZone));
    await refresh();
  }

  return (
    <section className="page today-page">
      <h1>Today</h1>
      <QuickCapture onCapture={capture} placeholder="Add a task for today…" />

      {actionError || editor.error ? (
        <p className="error" role="alert">
          {actionError ?? editor.error}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <p className="muted">Loading today…</p>
      ) : tasks.length === 0 ? (
        <div className="empty-state">
          Nothing is due today. Enjoy the clear runway.
        </div>
      ) : (
        <div className="view-sections">
          <section className="view-section">
            <h2>Overdue</h2>
            <TaskList
              tasks={overdue}
              timeZone={timeZone}
              onComplete={(task) => void complete(task)}
              onOpen={editor.open}
              emptyMessage="Nothing overdue."
            />
          </section>
          <section className="view-section">
            <h2>Due today</h2>
            <TaskList
              tasks={dueToday}
              timeZone={timeZone}
              onComplete={(task) => void complete(task)}
              onOpen={editor.open}
              emptyMessage="Nothing else due today."
            />
          </section>
        </div>
      )}
      {editor.overlays}
    </section>
  );
}
