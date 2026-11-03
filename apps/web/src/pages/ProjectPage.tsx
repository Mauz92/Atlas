import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import {
  notesApi,
  projectsApi,
  tasksApi,
  type NoteSummary,
  type Project,
} from "../api/client";
import { Board } from "../components/Board";
import { FoldGroup } from "../components/FoldGroup";
import { Icon } from "../components/Icon";
import { LoadError } from "../components/LoadError";
import type { MenuEntry } from "../components/Menu";
import { MenuButton } from "../components/MenuButton";
import { ProjectForm } from "../components/ProjectForm";
import { ProjectProgressBar } from "../components/ProjectProgressBar";
import { QuickCapture } from "../components/QuickCapture";
import { Skeleton } from "../components/Skeleton";
import { TaskList } from "../components/TaskList";
import { Tabs, panelId, tabId } from "../components/Tabs";
import { useBoard } from "../hooks/useBoard";
import { useProjects } from "../hooks/useProjects";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { formatDay, sentenceCase } from "../lib/tasks";

type Tab = "tasks" | "board" | "notes";
const TABS = [
  { id: "tasks", label: "Tasks" },
  { id: "board", label: "Board" },
  { id: "notes", label: "Notes" },
] as const;

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * One project (MU-02, UX-07): a header (name, status, derived progress per ADR-0023, dates, "…"
 * menu), then tabs Tasks | Board | Notes (`?tab=`). Finished tasks fold into "Completed (n)" and
 * "Archived (n)" groups. Tasks open in the shared detail panel, where they can also be moved to
 * another project. Everything is read from and written to the existing projects API.
 */
export function ProjectPage() {
  const { id = "" } = useParams();
  const { reload: reloadProjects } = useProjects();
  const board = useBoard(id);
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [allNotes, setAllNotes] = useState<NoteSummary[]>([]);
  const [params, setParams] = useSearchParams();
  const requested = params.get("tab");
  const tab: Tab = TABS.some((t) => t.id === requested) ? (requested as Tab) : "tasks";
  const setTab = (next: Tab) =>
    setParams(next === "tasks" ? {} : { tab: next }, { replace: true });
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

  const groups = useMemo(
    () => ({
      open: ["inbox", "next", "in_progress"].flatMap((status) => board.tasksByStatus[status] ?? []),
      completed: board.tasksByStatus.completed ?? [],
      archived: board.tasksByStatus.archived ?? [],
    }),
    [board.tasksByStatus],
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

  const linkable = allNotes.filter(
    (note) => !notes.some((linked) => linked.id === note.id),
  );

  const projectEntries: MenuEntry[] = [
    {
      kind: "item",
      id: "edit",
      label: "Edit project",
      icon: "file-text",
      onSelect: () => setEditing(true),
    },
    project?.status === "archived"
      ? {
          kind: "item",
          id: "restore",
          label: "Restore project",
          icon: "refresh-cw",
          onSelect: () => void setStatus("active"),
        }
      : {
          kind: "item",
          id: "archive",
          label: "Archive project",
          icon: "inbox",
          onSelect: () => void setStatus("archived"),
        },
  ];

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
        <Skeleton label="Loading project" rows={4} kind="line" />
      </section>
    );
  }

  return (
    <section className="page project-page">
      <p>
        <Link to="/projects">All projects</Link>
      </p>
      <div className="project-header">
        <h1>{project.name}</h1>
        <span className={project.status === "completed" ? "pill pill-success" : "pill"}>
          {sentenceCase(project.status)}
        </span>
        <MenuButton
          menuLabel="Project options"
          ariaLabel="Project options"
          title="Project options"
          className="icon-button ghost"
          entries={projectEntries}
        >
          <Icon name="ellipsis" />
        </MenuButton>
      </div>
      <p className="project-meta">
        <ProjectProgressBar progress={project.progress} />
        {project.start_date ? (
          <span className="muted">Starts {formatDay(project.start_date)}</span>
        ) : null}
        {project.target_date ? (
          <span className="muted">Target {formatDay(project.target_date)}</span>
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
        <p className="project-description">
          {project.description ?? (
            <span className="muted">No description.</span>
          )}
        </p>
      )}

      {actionError || board.actionError || editor.error ? (
        <p className="error" role="alert">
          {actionError ?? board.actionError ?? editor.error}
        </p>
      ) : null}

      <Tabs
        label="Project sections"
        tabs={TABS}
        value={tab}
        onChange={setTab}
        idPrefix="project"
      />

      <div
        role="tabpanel"
        id={panelId("project", tab)}
        aria-labelledby={tabId("project", tab)}
        className="tab-panel"
      >
        {tab === "notes" ? (
          <>
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
          </>
        ) : (
          <>
            {tab === "tasks" ? (
              <QuickCapture
                placeholder="Add a task to this project…"
                onCapture={async (title) => {
                  await tasksApi.create(title, { project_id: project.id, status: "next" });
                  await refresh();
                }}
              />
            ) : null}
            {board.state === "error" ? (
              <LoadError message={board.error} onRetry={() => void board.reload()} />
            ) : board.state === "loading" ? (
              <Skeleton label="Loading tasks" rows={3} />
            ) : tab === "tasks" ? (
              <>
                <div className={groups.open.length > 0 ? "list-card" : undefined}>
                  <TaskList
                    tasks={groups.open}
                    timeZone={board.timeZone}
                    emptyMessage={
                      board.total === 0
                        ? "No tasks in this project yet."
                        : "Nothing open in this project."
                    }
                    hideProject
                    actions={editor.actions}
                    filable={editor.projects}
                    onOpen={editor.open}
                  />
                </div>
                {(
                  [
                    ["Completed", groups.completed],
                    ["Archived", groups.archived],
                  ] as const
                ).map(([title, list]) => (
                  <FoldGroup key={title} title={title} count={list.length}>
                    <TaskList
                      tasks={[...list]}
                      timeZone={board.timeZone}
                      hideProject
                      actions={editor.actions}
                      filable={editor.projects}
                      onOpen={editor.open}
                    />
                  </FoldGroup>
                ))}
              </>
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
                actions={editor.actions}
                hideProject
                archivedToggle
              />
            )}
          </>
        )}
      </div>
      {editor.overlays}
    </section>
  );
}
