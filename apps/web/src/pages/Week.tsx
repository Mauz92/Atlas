import { useMemo, useState } from "react";

import { EmptyState } from "../components/EmptyState";
import { LoadError } from "../components/LoadError";
import { ProjectSummary } from "../components/ProjectSummary";
import { Skeleton } from "../components/Skeleton";
import { TaskList } from "../components/TaskList";
import { usePlanning } from "../hooks/usePlanning";
import { useTaskEditor } from "../hooks/useTaskEditor";
import {
  addDays,
  projectsForTasks,
  startOfWeek,
  weekDayGroups,
  weekLabelOf,
  weekWindow,
} from "../lib/planning";

/**
 * The **Week** planning view (M4-06): the seven local days of one ISO week (Monday first), with
 * week navigation.
 *
 * The week is read from `GET /api/tasks` as one inclusive `due_from`/`due_to` window for the
 * viewer's zone, filtered to open work; each task is then placed on its local calendar day by the
 * shared grouping helper, so a task due late in the UTC day still lands on the right local day
 * (ADR-0025). Project context (name and derived progress, M4-04) is shown where the week touches a
 * project. Days with no work render as empty sections, so the week keeps a stable shape.
 */
export function Week() {
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const thisWeek = startOfWeek(new Date());
  const isThisWeek = anchor.getTime() === thisWeek.getTime();

  const window = useMemo(() => weekWindow(anchor), [anchor]);

  const {
    tasks,
    projectById,
    state,
    error,
    projectsError,
    timeZone,
    reload,
    refresh,
  } = usePlanning(window);
  const editor = useTaskEditor({ refresh, timeZone });

  const groups = weekDayGroups(tasks, anchor, timeZone);
  const projects = projectsForTasks(tasks, projectById);
  const label = weekLabelOf(anchor, timeZone);

  return (
    <section className="page week-page">
      <header className="planning-header">
        <div aria-live="polite">
          <h1>Week of {label}</h1>
          <p className="muted">The week ahead, day by day, in your local time zone.</p>
        </div>
        <nav className="planning-nav" aria-label="Change week">
          <button type="button" className="ghost" onClick={() => setAnchor(addDays(anchor, -7))}>
            Previous week
          </button>
          <button type="button" className="ghost" onClick={() => setAnchor(thisWeek)} disabled={isThisWeek}>
            This week
          </button>
          <button type="button" className="ghost" onClick={() => setAnchor(addDays(anchor, 7))}>
            Next week
          </button>
        </nav>
      </header>

      {editor.error ? (
        <p className="error" role="alert">
          {editor.error}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <Skeleton label="Loading the week" rows={2} groups={3} />
      ) : (
        <>
          {projectsError ? (
            <p className="muted project-warning" role="status">
              Project names are unavailable right now.
            </p>
          ) : null}
          <ProjectSummary projects={projects} />
          {tasks.length === 0 ? (
            <EmptyState icon="calendar-range">Nothing planned for this week.</EmptyState>
          ) : (
            <div className="week-days">
              {groups.map((group) => (
                <section key={group.key} className="week-day">
                  <h2>
                    {group.label}
                    <span className="muted week-day-count">{group.tasks.length}</span>
                  </h2>
                  <TaskList
                    tasks={group.tasks}
                    timeZone={timeZone}
                    projects={projectById}
                    actions={editor.actions}
                    filable={editor.projects}
                    onOpen={editor.open}
                    emptyMessage="Nothing scheduled."
                  />
                </section>
              ))}
            </div>
          )}
        </>
      )}
      {editor.overlays}
    </section>
  );
}
