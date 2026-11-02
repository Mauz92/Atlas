import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { tasksApi, type Task, type TaskPriority } from "../api/client";
import { LoadError } from "../components/LoadError";
import { TaskList } from "../components/TaskList";
import { UndoToast } from "../components/UndoToast";
import { activeProjects, useProjects } from "../hooks/useProjects";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { useTaskQuery } from "../hooks/useTaskQuery";
import { PRIORITIES } from "../lib/taskForm";
import {
  filterFromParams,
  filterToParams,
  loadSavedFilters,
  MAX_SAVED_FILTERS,
  PAGE_LIMIT,
  SORT_LABELS,
  storeSavedFilters,
  type SavedFilter,
  type SortKey,
  type TaskFilter,
} from "../lib/taskFilters";
import { viewerTimeZone } from "../lib/tasks";

const STATUS_CHOICES: [string, string][] = [
  ["open", "Open"],
  ["all", "All statuses"],
  ["inbox", "Inbox"],
  ["next", "Next"],
  ["in_progress", "In progress"],
  ["completed", "Completed"],
  ["archived", "Archived"],
];

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
 * All tasks (MU-03): the server's filters (status, priority, due range, project, text), a sort,
 * saved filters kept in this browser, and bulk complete / move / delete with undo. The filter lives
 * in the URL, so a view can be linked and survives a reload. Rows open the shared task detail.
 */
export function Tasks() {
  const [params, setParams] = useSearchParams();
  const filter = useMemo(() => filterFromParams(params), [params]);
  const { tasks, state, error, truncated, reload, refresh } =
    useTaskQuery(filter);
  const timeZone = useMemo(() => viewerTimeZone(), []);
  const editor = useTaskEditor({ refresh, timeZone });
  const { projects } = useProjects();
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  const [text, setText] = useState(filter.q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<Task[]>([]);
  const [saved, setSaved] = useState<SavedFilter[]>(loadSavedFilters);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  // Navigation renders asynchronously, so two quick changes (or a change right after Reset) must
  // build on the URL they just wrote, not on the last committed render.
  const latest = useRef(params);
  latest.current = params;
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

  const completable = shown.filter(
    (task) => task.status !== "completed" && task.status !== "archived",
  );

  async function undoDelete() {
    const restore = deleted;
    setDeleted([]);
    await bulk(restore, (task) => tasksApi.restore(task.id), "Could not undo");
  }

  function saveFilter() {
    const name = saveName.trim();
    if (!name) return;
    if (saved.length >= MAX_SAVED_FILTERS) {
      setSaveError(`You can keep at most ${MAX_SAVED_FILTERS} saved filters.`);
      return;
    }
    const next = [
      ...saved,
      { id: crypto.randomUUID(), name, query: params.toString() },
    ];
    setSaved(next);
    setSaveName("");
    setSaveError(
      storeSavedFilters(next)
        ? null
        : "This browser would not store it; the filter is kept until you leave the page.",
    );
  }

  function removeSaved(id: string) {
    const next = saved.filter((entry) => entry.id !== id);
    setSaved(next);
    storeSavedFilters(next);
  }

  const shownError = bulkError ?? editor.error;

  return (
    <section className="page tasks-page">
      <h1>Tasks</h1>
      <p className="muted">
        Every task, filtered and sorted. The address of this page is the view.
      </p>

      <div className="task-filters" role="search" aria-label="Task filters">
        <label>
          Search
          <input
            aria-label="Search"
            type="search"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Title or description"
          />
        </label>
        <label>
          Status
          <select
            aria-label="Status"
            value={filter.status}
            onChange={(event) => change({ status: event.target.value })}
          >
            {STATUS_CHOICES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select
            aria-label="Priority"
            value={filter.priority}
            onChange={(event) => change({ priority: event.target.value })}
          >
            <option value="">Any</option>
            {PRIORITIES.map((priority: TaskPriority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project
          <select
            aria-label="Project"
            value={filter.project}
            onChange={(event) => change({ project: event.target.value })}
          >
            <option value="">Any</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due from
          <input
            aria-label="Due from"
            type="date"
            value={filter.dueFrom}
            onChange={(event) => change({ dueFrom: event.target.value })}
          />
        </label>
        <label>
          Due to
          <input
            aria-label="Due to"
            type="date"
            value={filter.dueTo}
            onChange={(event) => change({ dueTo: event.target.value })}
          />
        </label>
        <label>
          Sort by
          <select
            aria-label="Sort by"
            value={filter.sort}
            onChange={(event) => change({ sort: event.target.value as SortKey })}
          >
            {Object.entries(SORT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ghost"
          onClick={() => navigate(new URLSearchParams())}
        >
          Reset filters
        </button>
      </div>

      <div className="saved-filters">
        <h2>Saved filters</h2>
        {saved.length > 0 ? (
          <ul aria-label="Saved filters">
            {saved.map((entry) => (
              <li key={entry.id}>
                <Link to={`/tasks${entry.query ? `?${entry.query}` : ""}`}>
                  {entry.name}
                </Link>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Remove saved filter ${entry.name}`}
                  onClick={() => removeSaved(entry.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None yet.</p>
        )}
        <form
          className="save-filter"
          onSubmit={(event) => {
            event.preventDefault();
            saveFilter();
          }}
        >
          <input
            aria-label="Saved filter name"
            value={saveName}
            maxLength={60}
            placeholder="Name this view"
            onChange={(event) => setSaveName(event.target.value)}
          />
          <button type="submit" disabled={!saveName.trim()}>
            Save this view
          </button>
        </form>
        {saveError ? <p className="error">{saveError}</p> : null}
      </div>

      {shown.length > 0 ? (
        <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span>{shown.length} selected</span>
          <button
            type="button"
            disabled={busy || completable.length === 0}
            onClick={() =>
              void bulk(
                completable,
                (task) => tasksApi.complete(task),
                "Could not complete the task",
              )
            }
          >
            Complete selected
          </button>
          <select
            aria-label="Move selected to project"
            value=""
            disabled={busy}
            onChange={(event) => {
              const value = event.target.value;
              if (!value) return;
              const projectId = value === "none" ? null : value;
              void bulk(
                shown,
                (task) => tasksApi.update(task, { project_id: projectId }),
                "Could not move the task",
              );
            }}
          >
            <option value="">Move to project…</option>
            <option value="none">No project</option>
            {activeProjects(projects).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() =>
              void bulk(
                shown,
                (task) => tasksApi.remove(task),
                "Could not delete the task",
                (done) => setDeleted(done),
              )
            }
          >
            Delete selected
          </button>
        </div>
      ) : null}

      {shownError ? (
        <p className="error bulk-error" role="alert">
          {shownError}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <p className="muted" role="status">Loading tasks…</p>
      ) : (
        <>
          <div className="task-count">
            <label>
              <input
                type="checkbox"
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
            <span className="muted" aria-live="polite">
              {tasks.length} {tasks.length === 1 ? "task" : "tasks"}
            </span>
          </div>
          {truncated ? (
            <p className="muted">
              Showing the first {PAGE_LIMIT} matches; narrow the filters to see
              the rest.
            </p>
          ) : null}
          <TaskList
            tasks={tasks}
            timeZone={timeZone}
            projects={projectsById}
            actions={editor.actions}
            filable={editor.projects}
            onOpen={editor.open}
            emptyMessage="No tasks match these filters."
            selection={{
              isSelected: (id) => selected.has(id),
              toggle: (task) => toggle(task.id),
              active: selected.size > 0,
            }}
          />
        </>
      )}

      {deleted.length > 0 ? (
        <UndoToast
          message={`Deleted ${deleted.length} ${deleted.length === 1 ? "task" : "tasks"}.`}
          onUndo={() => void undoDelete()}
          onDismiss={() => setDeleted([])}
        />
      ) : null}
      {editor.overlays}
    </section>
  );
}
