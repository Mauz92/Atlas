import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";

import {
  notesApi,
  projectsApi,
  tasksApi,
  type NoteSummary,
  type Project,
  type Task,
} from "../api/client";
import { Board } from "../components/Board";
import { LoadError } from "../components/LoadError";
import { ProjectForm } from "../components/ProjectForm";
import { ProjectProgressBar } from "../components/ProjectProgressBar";
import { QuickCapture } from "../components/QuickCapture";
import { TaskList } from "../components/TaskList";
import { useBoard } from "../hooks/useBoard";
import { useProjects } from "../hooks/useProjects";
import { useTaskEditor } from "../hooks/useTaskEditor";

type View = "list" | "board";

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * One project (MU-02): description, derived progress (ADR-0023), its tasks as a list or a board,
 * and the notes linked to it (M4-05). Tasks open in the shared detail panel, where they can also be
 * moved to another project. Everything is read from and written to the existing projects API.
 */
export function ProjectPage() {
  const { id = "" } = useParams();
  const { reload: reloadProjects } = useProjects();
  const board = useBoard(id);
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([]);
  const [view, setView] = useState<View>("list");
  const [editing, setEditing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    try {
      const [loaded, linked] = await Promise.all([
        projectsApi.get(id),
        projectsApi.notes(id),
      ]);
      setProject(loaded);
      setNotes(linked.notes);
      setLoadError(null);
    } catch (err) {
      setLoadError(message(err, "Could not load the project"));
    }
  }, [id]);

  useEffect(() => {
    setProject(null);
    setEditing(false);
    void loadProject();
    notesApi
      .list()
      .then((listing) => setAllNotes(listing.notes))
      .catch(() => setAllNotes([]));
  }, [loadProject]);

  const refresh = useCallback(async () => {
    await Promise.all([board.refresh(), loadProject()]);
  }, [board.refresh, loadProject]); // eslint-disable-line react-hooks/exhaustive-deps
  const editor = useTaskEditor({ refresh, timeZone: board.timeZone });

  const tasks = useMemo(
    () => board.columns.flatMap((column) => board.tasksByStatus[column.status] ?? []),
    [board.columns, board.tasksByStatus],
  );

  async function run(action: () => Promise<unknown>, fallback: string) {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(message(err, fallback));
    }
  }

  const setStatus = (status: "active" | "archived") =>
    run(async () => {
      if (!project) return;
      setProject(await projectsApi.update(project, { status }));
      await reloadProjects();
    }, "Could not update the project");

  const complete = (task: Task) =>
    run(async () => {
      await tasksApi.complete(task);
      await refresh();
    }, "Could not complete the task");

  const linkable = allNotes.filter(
    (note) => !notes.some((linked) => linked.id === note.id),
  );

  if (loadError && !project) {
    return (
      <section className="page project-page">
        <p>
          <Link to="/projects">All projects</Link>
        </p>
        <LoadError message={loadError} onRetry={() => void loadProject()} />
      </section>
    );
  }
  if (!project) {
    return (
      <section className="page project-page">
        <p className="muted" role="status">Loading project…</p>
      </section>
    );
  }

  return (
    <section className="page project-page">
      <p>
        <Link to="/projects">All projects</Link>
      </p>
      <h1>{project.name}</h1>
      <p className="project-meta">
        <span className="badge">{project.status}</span>
        <ProjectProgressBar progress={project.progress} />
        {project.start_date ? (
          <span className="muted">Starts {project.start_date}</span>
        ) : null}
        {project.target_date ? (
          <span className="muted">Target {project.target_date}</span>
        ) : null}
      </p>

      {editing ? (
        <ProjectForm
          project={project}
          submitLabel="Save project"
          onCancel={() => setEditing(false)}
          onSubmit={async (name, fields) => {
            setProject(await projectsApi.update(project, { ...fields, name }));
            setEditing(false);
            await reloadProjects();
          }}
        />
      ) : (
        <>
          <p className="project-description">
            {project.description ?? (
              <span className="muted">No description.</span>
            )}
          </p>
          <div className="project-actions">
            <button type="button" className="ghost" onClick={() => setEditing(true)}>
              Edit project
            </button>
            {project.status === "archived" ? (
              <button type="button" className="ghost" onClick={() => void setStatus("active")}>
                Restore project
              </button>
            ) : (
              <button type="button" className="ghost" onClick={() => void setStatus("archived")}>
                Archive project
              </button>
            )}
          </div>
        </>
      )}

      {actionError || board.actionError || editor.error ? (
        <p className="error" role="alert">
          {actionError ?? board.actionError ?? editor.error}
        </p>
      ) : null}

      <h2>Tasks</h2>
      <QuickCapture
        placeholder="Add a task to this project…"
        onCapture={async (title) => {
          await tasksApi.create(title, { project_id: project.id, status: "next" });
          await refresh();
        }}
      />
      <div className="view-toggle" role="group" aria-label="Task view">
        {(["list", "board"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className="ghost"
            aria-pressed={view === option}
            onClick={() => setView(option)}
          >
            {option === "list" ? "List" : "Board"}
          </button>
        ))}
      </div>
      {board.state === "error" ? (
        <LoadError message={board.error} onRetry={() => void board.reload()} />
      ) : board.state === "loading" ? (
        <p className="muted" role="status">Loading tasks…</p>
      ) : view === "list" ? (
        <TaskList
          tasks={tasks}
          timeZone={board.timeZone}
          emptyMessage="No tasks in this project yet."
          onOpen={editor.open}
          onComplete={(task) => void complete(task)}
        />
      ) : (
        <Board
          columns={board.columns}
          tasksByStatus={board.tasksByStatus}
          timeZone={board.timeZone}
          onMove={(task, toStatus) =>
            void board.move(task, toStatus).then(loadProject)
          }
          onOpen={editor.open}
          movingId={board.movingId}
          empty={board.total === 0}
        />
      )}

      <h2>Linked notes</h2>
      {notes.length === 0 ? (
        <p className="muted">No notes linked to this project.</p>
      ) : (
        <ul className="project-notes">
          {notes.map((note) => (
            <li key={note.id}>
              <Link to="/notes">{note.title || note.path}</Link>{" "}
              <span className="muted">{note.path}</span>
              <button
                type="button"
                className="ghost"
                aria-label={`Unlink ${note.path}`}
                onClick={() =>
                  void run(async () => {
                    await projectsApi.unlinkNote(project.id, note.id);
                    await loadProject();
                  }, "Could not unlink the note")
                }
              >
                Unlink
              </button>
            </li>
          ))}
        </ul>
      )}
      {linkable.length > 0 ? (
        <select
          aria-label="Link a note"
          value=""
          onChange={(event) => {
            const noteId = event.target.value;
            if (noteId) {
              void run(async () => {
                await projectsApi.linkNote(project.id, noteId);
                await loadProject();
              }, "Could not link the note");
            }
          }}
        >
          <option value="">Link a note…</option>
          {linkable.map((note) => (
            <option key={note.id} value={note.id}>
              {note.path}
            </option>
          ))}
        </select>
      ) : null}
      {editor.overlays}
    </section>
  );
}
