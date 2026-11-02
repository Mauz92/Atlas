import { useCallback, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { tasksApi, type SearchTask } from "../api/client";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { useUnifiedSearch } from "../hooks/useUnifiedSearch";
import { STATUS_LABELS } from "../lib/taskStatus";
import { formatDue, viewerTimeZone } from "../lib/tasks";

const PAGE_LIMIT = 25;

function taskMeta(task: SearchTask, timeZone: string | undefined): string {
  const parts: string[] = [STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] ?? task.status];
  if (task.due_at) {
    parts.push(`due ${formatDue(task.due_at, timeZone)}`);
  }
  return parts.join(" · ");
}

/**
 * Search across notes, tasks and projects (MU-05): the same `GET /api/search` as the command
 * palette, with a longer list. The text lives in the URL (`?q=`), so a search can be linked and
 * survives a reload. A task opens the shared task detail, a project its page, a note the editor.
 */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const { results, loading, error } = useUnifiedSearch(query, PAGE_LIMIT);
  const timeZone = useMemo(() => viewerTimeZone(), []);
  // The list is a snapshot of an answer; a saved task is not re-searched until the text changes.
  const refresh = useCallback(async () => {}, []);
  const editor = useTaskEditor({ refresh, timeZone });
  const [openError, setOpenError] = useState<string | null>(null);
  const text = query.trim();

  const total = results ? results.notes.length + results.tasks.length + results.projects.length : 0;

  return (
    <section className="page">
      <h1>Search</h1>
      <input
        type="search"
        className="search-input"
        aria-label="Search notes, tasks and projects"
        placeholder="Search notes, tasks and projects…"
        maxLength={200}
        autoFocus
        value={query}
        onChange={(event) => {
          const next = event.target.value;
          setParams(next ? { q: next } : {}, { replace: true });
        }}
      />
      <p className="muted" role="status">
        {!text
          ? "Type to search. Words match the start of a word; every word must match."
          : loading
            ? "Searching…"
            : error
              ? ""
              : `${total} ${total === 1 ? "result" : "results"}`}
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {openError || editor.error ? <p className="error">{openError ?? editor.error}</p> : null}

      {results && results.notes.length > 0 ? (
        <section aria-labelledby="search-notes">
          <h2 id="search-notes">Notes</h2>
          <ul className="search-results">
            {results.notes.map((note) => (
              <li key={note.id}>
                <Link to={`/notes?open=${note.id}`}>{note.title || note.path}</Link>
                <span className="muted"> {note.path}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {results && results.tasks.length > 0 ? (
        <section aria-labelledby="search-tasks">
          <h2 id="search-tasks">Tasks</h2>
          <ul className="search-results">
            {results.tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    setOpenError(null);
                    tasksApi
                      .get(task.id)
                      .then(editor.open)
                      .catch((err: unknown) =>
                        setOpenError(err instanceof Error ? err.message : "Could not open the task"),
                      );
                  }}
                >
                  {task.title}
                </button>
                <span className="muted"> {taskMeta(task, timeZone)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {results && results.projects.length > 0 ? (
        <section aria-labelledby="search-projects">
          <h2 id="search-projects">Projects</h2>
          <ul className="search-results">
            {results.projects.map((project) => (
              <li key={project.id}>
                <Link to={`/projects/${project.id}`}>{project.name}</Link>
                <span className="muted"> {project.status}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {results && total === 0 && !loading ? (
        <div className="empty-state">Nothing matches “{text}”.</div>
      ) : null}
      {editor.overlays}
    </section>
  );
}
