import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { tasksApi, type Task } from "../api/client";
import { BulkBar } from "../components/BulkBar";
import { CaptureFab } from "../components/CaptureSheet";
import { EmptyState } from "../components/EmptyState";
import { FilterBar } from "../components/FilterBar";
import { LoadError } from "../components/LoadError";
import { Skeleton } from "../components/Skeleton";
import { TaskList } from "../components/TaskList";
import { UndoToast } from "../components/UndoToast";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { activeProjects, useProjects } from "../hooks/useProjects";
import { useSavedFilters } from "../hooks/useSavedFilters";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { useTaskQuery } from "../hooks/useTaskQuery";
import {
  filterFromParams,
  filterToParams,
  isFiltered,
  PAGE_LIMIT,
  type TaskFilter,
} from "../lib/taskFilters";
import { SHEET_QUERY } from "../lib/phone";
import { viewerTimeZone } from "../lib/tasks";

/** Run one request per task; one failure does not stop the rest, and each failure is reported verbatim. */
async function runForEach(
  tasks: Task[],
  action: (task: Task) => Promise<unknown>,
  failure: string,
): Promise<{ done: Task[]; errors: string[] }> {
  const done: Task[] = [];
  const errors: string[] = [];
  for (const task of tasks) {
    try {
      await action(task);
      done.push(task);
    } catch (err) {
      errors.push(`${task.title}: ${err instanceof Error ? err.message : failure}`);
    }
  }
  return { done, errors };
}

/**
 * All tasks (MU-03, UX-07): the server's filters (status, priority, due range, project, text) in
 * one filter bar, a sort, saved views kept in this browser, and bulk
 * complete / move / delete with undo in a floating bar. The filter (and the view) lives in the URL,
 * so a view can be linked and survives a reload. Rows open the shared task detail.
 */
export function Tasks() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => filterFromParams(params), [params]);
  const { tasks, state, error, truncated, reload, refresh } =
    useTaskQuery(filter);
  const timeZone = useMemo(() => viewerTimeZone(), []);
  const editor = useTaskEditor({ refresh, timeZone });
  // "Copy link" in the task detail points here: `/tasks?task=<id>` opens that task once.
  const linked = params.get("task");
  useEffect(() => {
    if (!linked) return;
    void editor.openById(linked);
    const next = new URLSearchParams(params);
    next.delete("task");
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);
  const { projects } = useProjects();
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  // Phone capture (UX-10): a new task lands in the Inbox, whatever the filters show.
  async function captureToInbox(title: string) {
    await tasksApi.create(title);
    await refresh();
  }

  const [text, setText] = useState(filter.q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Touch and phone (UX-11): the select boxes exist only in "Select" mode, entered from the filter
  // menu, so a row has one leading control (the round completion box) the rest of the time.
  const touch = useMediaQuery(SHEET_QUERY, false);
  const [selectMode, setSelectMode] = useState(false);
  const selecting = touch && selectMode;
  const showSelect = !touch || selecting;
  const [busy, setBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<Task[]>([]);
  const views = useSavedFilters();

  // Navigation renders asynchronously, so two quick changes (or a change right after Reset) must
  // build on the URL they just wrote, not on the last committed render.
  const latest = useRef(params);
  latest.current = params;
  const openRoute = useNavigate();
  function navigate(next: URLSearchParams) {
    latest.current = next;
    setParams(next, { replace: true });
  }
  function change(patch: Partial<TaskFilter>) {
    navigate(filterToParams({ ...filterFromParams(latest.current), ...patch }));
  }

  // The search box is applied after a short pause; an external change (a saved filter) replaces it.
  useEffect(() => setText(filter.q), [filter.q]);
  useEffect(() => {
    if (text === filter.q) return;
    const timer = window.setTimeout(() => change({ q: text }), 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const shown = useMemo(
    () => tasks.filter((task) => selected.has(task.id)),
    [tasks, selected],
  );
  const allSelected = tasks.length > 0 && shown.length === tasks.length;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function bulk(
    targets: Task[],
    action: (task: Task) => Promise<unknown>,
    failure: string,
    afterDone?: (done: Task[]) => void,
  ) {
    setBusy(true);
    setBulkError(null);
    const { done, errors } = await runForEach(targets, action, failure);
    afterDone?.(done);
    // Succeeded rows leave the selection; failed ones stay selected so they can be retried.
    setSelected((current) => {
      const next = new Set(current);
      done.forEach((task) => next.delete(task.id));
      return next;
    });
    if (errors.length > 0) setBulkError(errors.join("\n"));
    await refresh();
    setBusy(false);
  }

  function endSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  const completable = shown.filter(
    (task) => task.status !== "completed" && task.status !== "archived",
  );

  async function undoDelete() {
    const restore = deleted;
    setDeleted([]);
    await bulk(restore, (task) => tasksApi.restore(task.id), "Could not undo");
  }

  const shownError = bulkError ?? editor.error;
  // "No results" (a filter is set: offer to clear it) differs from "none yet" (point at capture).
  const filtered = isFiltered(filter);
  const emptyText = filtered ? "No tasks match these filters." : "No open tasks. Capture one in the Inbox.";
  // The filter bar already offers "Reset filters", so a filtered list needs no action of its own.
  const emptyAction = filtered ? undefined : { label: "Go to Inbox", onClick: () => openRoute("/inbox") };

  return (
    <section className="page tasks-page tinted-page">
      <h1>Tasks</h1>

      <FilterBar
        filter={filter}
        text={text}
        onText={setText}
        projects={projects}
        onChange={change}
        onReset={() => navigate(new URLSearchParams())}
        saved={views.saved}
        onSaveView={(name) => views.save(name, params.toString())}
        onApplyView={(entry) => navigate(new URLSearchParams(entry.query))}
        onRemoveView={views.remove}
        onSelectMode={touch && !selecting ? () => setSelectMode(true) : undefined}
      />
      {views.error ? <p className="error">{views.error}</p> : null}

      {shownError ? (
        <p className="error bulk-error" role="alert">
          {shownError}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <Skeleton label="Loading tasks" rows={5} />
      ) : (
        <>
          <div className="task-count">
            {showSelect ? (
              <label>
                <input
                  type="checkbox"
                  className="task-select select-all"
                  checked={allSelected}
                  disabled={tasks.length === 0}
                  onChange={() =>
                    setSelected(
                      allSelected ? new Set() : new Set(tasks.map((t) => t.id)),
                    )
                  }
                />
                Select all
              </label>
            ) : (
              <span />
            )}
            <span className="task-count-end">
              <span className="muted" aria-live="polite">
                {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
              </span>
              {selecting ? (
                <button type="button" className="ghost" aria-label="Done selecting" onClick={endSelectMode}>
                  Done
                </button>
              ) : null}
            </span>
          </div>
          {truncated ? (
            <p className="muted">
              Showing the first {PAGE_LIMIT} matches; narrow the filters to see
              the rest.
            </p>
          ) : null}
          {tasks.length === 0 ? (
            <EmptyState icon="square-check" action={emptyAction}>
              {emptyText}
            </EmptyState>
          ) : (
            <div className="list-card">
              <TaskList
                tasks={tasks}
                timeZone={timeZone}
                projects={projectsById}
                actions={editor.actions}
                filable={editor.projects}
                onOpen={editor.open}
                selection={
                  showSelect
                    ? {
                        isSelected: (id) => selected.has(id),
                        toggle: (task) => toggle(task.id),
                        active: selected.size > 0,
                        // In touch Select mode the square box replaces the round completion box.
                        exclusive: touch,
                      }
                    : undefined
                }
              />
            </div>
          )}
        </>
      )}

      {shown.length > 0 && showSelect ? (
        <BulkBar
          count={shown.length}
          busy={busy}
          canComplete={completable.length > 0}
          projects={activeProjects(projects)}
          onComplete={() =>
            void bulk(
              completable,
              (task) => tasksApi.complete(task),
              "Could not complete the task",
            )
          }
          onMove={(projectId) =>
            void bulk(
              shown,
              (task) => tasksApi.update(task, { project_id: projectId }),
              "Could not move the task",
            )
          }
          onDelete={() =>
            void bulk(
              shown,
              (task) => tasksApi.remove(task),
              "Could not delete the task",
              (done) => setDeleted(done),
            )
          }
          onClear={() => setSelected(new Set())}
        />
      ) : null}

      {deleted.length > 0 ? (
        <UndoToast
          message={`Deleted ${deleted.length} ${deleted.length === 1 ? "task" : "tasks"}.`}
          onUndo={() => void undoDelete()}
          onDismiss={() => setDeleted([])}
        />
      ) : null}
      <CaptureFab onCapture={captureToInbox} destination="Inbox" />
      {editor.overlays}
    </section>
  );
}
