import { LoadError } from "../components/LoadError";
import { TaskList } from "../components/TaskList";
import { useTaskView } from "../hooks/useTaskView";
import { groupUpcomingByDay } from "../lib/tasks";

/** Tasks scheduled for later days, grouped by the calendar day they are due. */
export function Upcoming() {
  const { tasks, state, error, actionError, timeZone, reload, complete } =
    useTaskView("upcoming");
  const groups = groupUpcomingByDay(tasks, timeZone);

  return (
    <section className="page upcoming-page">
      <h1>Upcoming</h1>

      {actionError ? (
        <p className="error" role="alert">
          {actionError}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <p className="muted">Loading upcoming…</p>
      ) : groups.length === 0 ? (
        <div className="empty-state">Nothing is scheduled for the days ahead.</div>
      ) : (
        <div className="view-sections">
          {groups.map((group) => (
            <section key={group.key} className="view-section">
              <h2>{group.label}</h2>
              <TaskList
                tasks={group.tasks}
                timeZone={timeZone}
                onComplete={(task) => void complete(task)}
              />
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
