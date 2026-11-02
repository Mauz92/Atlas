import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { notesApi, tasksApi, type Task } from "../api/client";
import { LoadError } from "../components/LoadError";
import { QuickCapture } from "../components/QuickCapture";
import { TaskList } from "../components/TaskList";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { useTaskView } from "../hooks/useTaskView";
import { dailyPath, excerpt } from "../lib/dailyNote";
import { ACTIVE_STATUSES, addDays, dayKeyOf, startOfDay } from "../lib/planning";
import { dueOn, localDate } from "../lib/taskForm";
import { groupToday } from "../lib/tasks";

interface DailyPreview {
  id: string;
  title: string;
  text: string;
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * The home view (MU-07): what is overdue, due today and scheduled to start today, a preview of
 * today's note and a slot for calendar events (empty until a calendar is connected, M5).
 */
export function Today() {
  const navigate = useNavigate();
  const { tasks, state, error, actionError, timeZone, reload, refresh, complete } =
    useTaskView("today");
  const [scheduled, setScheduled] = useState<Task[]>([]);
  const [scheduledError, setScheduledError] = useState<string | null>(null);
  const [daily, setDaily] = useState<DailyPreview | null>(null);
  const [dailyLoaded, setDailyLoaded] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [dailyBusy, setDailyBusy] = useState(false);
  const day = localDate(0, timeZone);

  const loadScheduled = useCallback(async () => {
    try {
      // Work that starts today and is still open. The window is the viewer's calendar day; the
      // exact day is re-checked below because the server's upper bound is inclusive.
      const from = startOfDay(new Date());
      const listing = await tasksApi.list({
        startFrom: from.toISOString(),
        startTo: addDays(from, 1).toISOString(),
        status: ACTIVE_STATUSES,
        tz: timeZone,
      });
      setScheduled(listing.tasks);
      setScheduledError(null);
    } catch (err) {
      setScheduledError(messageOf(err, "Could not load scheduled work"));
    }
  }, [timeZone]);

  const loadDaily = useCallback(async () => {
    try {
      const listing = await notesApi.list("daily");
      const found = listing.notes.find((note) => note.path === dailyPath(day));
      if (found) {
        const note = await notesApi.get(found.id);
        setDaily({ id: note.id, title: note.title, text: excerpt(note.content) });
      } else {
        setDaily(null);
      }
      setDailyError(null);
    } catch (err) {
      setDailyError(messageOf(err, "Could not load today's note"));
    } finally {
      setDailyLoaded(true);
    }
  }, [day]);

  useEffect(() => {
    void loadScheduled();
    void loadDaily();
  }, [loadScheduled, loadDaily]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), loadScheduled()]);
  }, [refresh, loadScheduled]);
  const editor = useTaskEditor({ refresh: refreshAll, timeZone });
  const { overdue, dueToday } = groupToday(tasks);

  const shown = new Set(tasks.map((task) => task.id));
  const key = dayKeyOf(new Date(), timeZone);
  const startsToday = scheduled.filter(
    (task) =>
      !shown.has(task.id) && task.start_at !== null && dayKeyOf(task.start_at, timeZone) === key,
  );

  /** Capturing on Today means "today": the task is due on the viewer's current calendar day. */
  async function capture(title: string) {
    await tasksApi.create(title, dueOn(day, timeZone));
    await refreshAll();
  }

  async function completeTask(task: Task) {
    await complete(task);
    await loadScheduled();
  }

  async function openTodaysNote() {
    if (dailyBusy) {
      return;
    }
    setDailyBusy(true);
    setDailyError(null);
    try {
      const note = await notesApi.openDaily(day);
      navigate(`/notes?open=${note.id}`);
    } catch (err) {
      setDailyError(messageOf(err, "Could not open today's note"));
      setDailyBusy(false);
    }
  }

  const list = (items: Task[], emptyMessage: string) => (
    <TaskList
      tasks={items}
      timeZone={timeZone}
      onComplete={(task) => void completeTask(task)}
      onOpen={editor.open}
      emptyMessage={emptyMessage}
    />
  );

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
      ) : (
        <div className="view-sections">
          <section className="view-section">
            <h2>Overdue</h2>
            {list(overdue, "Nothing overdue.")}
          </section>
          <section className="view-section">
            <h2>Due today</h2>
            {list(dueToday, "Nothing else due today.")}
          </section>
          <section className="view-section" aria-label="Scheduled work">
            <h2>Scheduled today</h2>
            {scheduledError ? (
              <p className="error" role="alert">
                {scheduledError}
              </p>
            ) : (
              list(startsToday, "No other work is scheduled to start today.")
            )}
          </section>
        </div>
      )}

      <div className="view-sections">
        <section className="view-section" aria-label="Daily note">
          <h2>Daily note</h2>
          {dailyError ? (
            <p className="error" role="alert">
              {dailyError}
            </p>
          ) : null}
          {daily ? (
            <>
              <p>
                <strong>{daily.title}</strong>
              </p>
              {daily.text ? <p className="daily-excerpt muted">{daily.text}</p> : null}
            </>
          ) : dailyLoaded && !dailyError ? (
            <p className="muted">No note for today yet.</p>
          ) : null}
          <button type="button" onClick={() => void openTodaysNote()} disabled={dailyBusy}>
            {daily ? "Open today's note" : "Create today's note"}
          </button>
        </section>
        <section className="view-section" aria-label="Events">
          <h2>Events</h2>
          <p className="muted">
            Calendar events will appear here once a calendar is connected.
          </p>
        </section>
      </div>
      {editor.overlays}
    </section>
  );
}
