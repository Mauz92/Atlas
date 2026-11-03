import { useMemo, useState } from "react";

import { tasksApi } from "../api/client";
import { CaptureFab } from "../components/CaptureSheet";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { LoadError } from "../components/LoadError";
import { ProjectSummary } from "../components/ProjectSummary";
import { Skeleton } from "../components/Skeleton";
import { TaskList } from "../components/TaskList";
import { ViewSection } from "../components/ViewSection";
import { usePlanning } from "../hooks/usePlanning";
import { useTaskEditor } from "../hooks/useTaskEditor";
import {
  addDays,
  dayKeyOf,
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
 * project. Days with no work render as one-line cards, so the week keeps a stable shape.
 *
 * Layout (UX-10, ADR-0063): an agenda of day cards in an auto-fit grid (one column on a phone, two or
 * more as the container allows, seven only on an ultrawide container), so nothing scrolls sideways at
 * any width. Today's card is highlighted and says "Today".
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
  const todayKey = dayKeyOf(new Date(), timeZone);

  // Phone capture (UX-10): a new task lands in the Inbox, like capture anywhere without a date.
  async function capture(title: string) {
    await tasksApi.create(title);
    await refresh();
  }
  const projects = projectsForTasks(tasks, projectById);
  const label = weekLabelOf(anchor, timeZone);

  return (
    <section className="page week-page tinted-page">
      <header className="planning-header">
        <div aria-live="polite">
          <h1>Week of {label}</h1>
          <p className="muted">The week ahead, day by day, in your local time zone.</p>
        </div>
        <nav className="planning-nav segmented" aria-label="Change week">
          <button type="button" onClick={() => setAnchor(addDays(anchor, -7))}>
            <Icon name="chevron-left" size={16} />
            <span className="segmented-label">Previous week</span>
          </button>
          <button type="button" onClick={() => setAnchor(thisWeek)} disabled={isThisWeek}>
            This week
          </button>
          <button type="button" onClick={() => setAnchor(addDays(anchor, 7))}>
            <span className="segmented-label">Next week</span>
            <Icon name="chevron-right" size={16} />
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
            <div className="week-agenda">
              <div className="week-days">
                {groups.map((group) => {
                  const today = group.key === todayKey;
                  const empty = group.tasks.length === 0;
                  return (
                    <ViewSection
                      key={group.key}
                      title={today ? `Today · ${group.label}` : group.label}
                      count={empty ? undefined : group.tasks.length}
                      tone={today ? "today" : undefined}
                      muted={empty && !today}
                      className={`week-day${today ? " is-today" : ""}${empty ? " is-empty" : ""}`}
                    >
                      <TaskList
                        tasks={group.tasks}
                        timeZone={timeZone}
                        projects={projectById}
                        actions={editor.actions}
                        filable={editor.projects}
                        onOpen={editor.open}
                        emptyMessage="Nothing scheduled."
                        day={group.key}
                      />
                    </ViewSection>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
      <CaptureFab onCapture={capture} destination="Inbox" />
      {editor.overlays}
    </section>
  );
}
