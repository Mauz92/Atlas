import { useMemo, useState } from "react";

import { LoadError } from "../components/LoadError";
import { ProjectSummary } from "../components/ProjectSummary";
import { TaskList } from "../components/TaskList";
import { usePlanning } from "../hooks/usePlanning";
import {
  addDays,
  dayLabelOf,
  dayWindow,
  projectsForTasks,
  startOfDay,
  tasksForDay,
  type PlanningWindow,
} from "../lib/planning";
import { groupToday } from "../lib/tasks";

/**
 * The **Day** planning view (M4-06): one local calendar day at a time, with day navigation.
 *
 * It reuses the server's own views rather than re-deriving dates (ADR-0017/ADR-0025): the current
 * day is the server's `today` view (overdue work carried forward plus what is due today, classified
 * from each task's own zone), while any other day is an inclusive `due_from`/`due_to` window for
 * that local day. Placement on the day is decided by `tasksForDay` in the viewer's zone. Project
 * context (name and derived progress, M4-04) is shown where the plan touches a project.
 */
export function Day() {
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const today = startOfDay(new Date());
  const isToday = selected.getTime() === today.getTime();

  const window = useMemo<PlanningWindow>(
    () => (isToday ? { view: "today" } : dayWindow(selected)),
    [isToday, selected],
  );

  const {
    tasks,
    projectById,
    state,
    error,
    projectsError,
    actionError,
    timeZone,
    reload,
    complete,
  } = usePlanning(window);

  const label = dayLabelOf(selected, timeZone);
  const { overdue, dueToday } = groupToday(tasks);
  const dayTasks = tasksForDay(tasks, selected, timeZone);
  const projects = projectsForTasks(tasks, projectById);

  return (
    <section className="page day-page">
      <header className="planning-header">
        <div aria-live="polite">
          <h1>{isToday ? `Today · ${label}` : label}</h1>
          <p className="muted">One day at a time, in your local time zone.</p>
        </div>
        <nav className="planning-nav" aria-label="Change day">
          <button type="button" onClick={() => setSelected(addDays(selected, -1))}>
            Previous day
          </button>
          <button type="button" onClick={() => setSelected(today)} disabled={isToday}>
            Today
          </button>
          <button type="button" onClick={() => setSelected(addDays(selected, 1))}>
            Next day
          </button>
        </nav>
      </header>

      {actionError ? (
        <p className="error" role="alert">
          {actionError}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <p className="muted">Loading the day…</p>
      ) : (
        <>
          {projectsError ? (
            <p className="muted project-warning" role="status">
              Project names are unavailable right now.
            </p>
          ) : null}
          <ProjectSummary projects={projects} />
          {tasks.length === 0 ? (
            <div className="empty-state">Nothing planned for this day.</div>
          ) : isToday ? (
            <div className="view-sections">
              <section className="view-section">
                <h2>Overdue</h2>
                <TaskList
                  tasks={overdue}
                  timeZone={timeZone}
                  projects={projectById}
                  onComplete={(task) => void complete(task)}
                  emptyMessage="Nothing overdue."
                />
              </section>
              <section className="view-section">
                <h2>Due today</h2>
                <TaskList
                  tasks={dueToday}
                  timeZone={timeZone}
                  projects={projectById}
                  onComplete={(task) => void complete(task)}
                  emptyMessage="Nothing else due today."
                />
              </section>
            </div>
          ) : (
            <div className="view-sections">
              <section className="view-section">
                <h2>{`Due ${label}`}</h2>
                <TaskList
                  tasks={dayTasks}
                  timeZone={timeZone}
                  projects={projectById}
                  onComplete={(task) => void complete(task)}
                  emptyMessage="Nothing due this day."
                />
              </section>
            </div>
          )}
        </>
      )}
    </section>
  );
}
