import { tasksApi } from "../api/client";
import { CaptureFab } from "../components/CaptureSheet";
import { EmptyState } from "../components/EmptyState";
import { LoadError } from "../components/LoadError";
import { Skeleton } from "../components/Skeleton";
import { TaskList } from "../components/TaskList";
import { ViewSection } from "../components/ViewSection";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { useTaskView } from "../hooks/useTaskView";
import { addDays, dayKeyOf } from "../lib/planning";
import { groupUpcomingByDay } from "../lib/tasks";

/** Tasks scheduled for later days, grouped by the calendar day they are due. */
export function Upcoming() {
  const { tasks, state, error, timeZone, reload, refresh } = useTaskView("upcoming");
  const editor = useTaskEditor({ refresh, timeZone });
  const groups = groupUpcomingByDay(tasks, timeZone);
  const tomorrow = dayKeyOf(addDays(new Date(), 1), timeZone);

  // Capture from here lands in the Inbox, like capture anywhere without a date or project.
  async function capture(title: string) {
    await tasksApi.create(title);
    await refresh();
  }

  return (
    <section className="page upcoming-page tinted-page">
      <h1>Upcoming</h1>

      {editor.error ? (
        <p className="error" role="alert">
          {editor.error}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <Skeleton label="Loading upcoming" rows={2} groups={2} />
      ) : groups.length === 0 ? (
        <EmptyState icon="calendar-days">Nothing is scheduled for the days ahead.</EmptyState>
      ) : (
        <div className="view-sections">
          {groups.map((group) => (
            <ViewSection
              key={group.key}
              title={group.key === tomorrow ? `Tomorrow · ${group.label}` : group.label}
              count={group.tasks.length}
            >
              <TaskList
                tasks={group.tasks}
                timeZone={timeZone}
                actions={editor.actions}
                filable={editor.projects}
                onOpen={editor.open}
                day={group.key}
              />
            </ViewSection>
          ))}
        </div>
      )}
      <CaptureFab onCapture={capture} destination="Inbox" />
      {editor.overlays}
    </section>
  );
}
