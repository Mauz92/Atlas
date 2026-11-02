import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  ApiError,
  notesApi,
  tasksApi,
  type NoteDetail,
  type NoteSummary,
} from "../api/client";
import { NoteEditor, type NoteEditorHandle } from "../components/NoteEditor";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { LoadError } from "../components/LoadError";
import { NoteTree } from "../components/NoteTree";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { taskTitleFromText } from "../lib/noteLinks";
import { templatesOf } from "../lib/dailyNote";
import { buildTree } from "../lib/noteTree";
import { localDate } from "../lib/taskForm";
import { STATUS_LABELS } from "../lib/taskStatus";

export function Notes() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [selected, setSelected] = useState<NoteDetail | null>(null);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The first read of the note list: shown as "Loading notes…" and, if it fails, with a retry.
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [conflictRevision, setConflictRevision] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSummary[] | null>(null);
  const [newPath, setNewPath] = useState("");
  const [templateId, setTemplateId] = useState("");
  const templateSelect = useRef<HTMLSelectElement | null>(null);
  // "Task from selection" (MU-06): the title being confirmed, or null when the form is closed.
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  const editor = useRef<NoteEditorHandle | null>(null);

  // `/notes?open=<id>` opens that note (the command palette and the Search page link here).
  const [params] = useSearchParams();
  const openId = params.get("open");
  // `/notes?new=template` (the palette's "New note from template") jumps to the template picker.
  const wantsTemplate = params.get("new") === "template";

  const dirty = selected !== null && content !== selected.content;
  const tree = useMemo(() => buildTree(folders, notes), [folders, notes]);
  const templates = useMemo(() => templatesOf(notes), [notes]);

  const refresh = useCallback(async () => {
    const listing = await notesApi.list();
    setNotes(listing.notes);
    setFolders(listing.folders);
  }, []);

  // Tasks and projects linked to the open note can change without the note changing (a task is
  // created, edited or deleted), so re-read only those parts and leave the editor text alone.
  const selectedId = selected?.id ?? null;
  const reloadLinked = useCallback(async () => {
    if (!selectedId) {
      return;
    }
    const fresh = await notesApi.get(selectedId);
    setSelected((current) =>
      current && current.id === fresh.id
        ? {
            ...current,
            tasks: fresh.tasks,
            projects: fresh.projects,
            backlinks: fresh.backlinks,
          }
        : current,
    );
  }, [selectedId]);
  const taskEditor = useTaskEditor({ refresh: reloadLinked });

  const loadList = useCallback(() => {
    setListState("loading");
    setError(null);
    refresh()
      .then(() => setListState("ready"))
      .catch((err: unknown) => {
        setListState("error");
        setError(err instanceof Error ? err.message : "Failed to load");
      });
  }, [refresh]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  async function openNote(id: string) {
    if (dirty && !window.confirm("Discard unsaved changes?")) {
      return;
    }
    setError(null);
    setStatus(null);
    setConflictRevision(null);
    setTaskTitle(null);
    try {
      const detail = await notesApi.get(id);
      setSelected(detail);
      setContent(detail.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to open note");
    }
  }

  const openRequested = useRef(openNote);
  openRequested.current = openNote;
  useEffect(() => {
    if (openId) {
      void openRequested.current(openId);
    }
  }, [openId]);

  useEffect(() => {
    if (wantsTemplate) {
      templateSelect.current?.focus();
    }
  }, [wantsTemplate, templates.length]);

  /** Open today's note, creating `daily/<date>.md` if it is missing (the server never rewrites it). */
  async function openTodaysNote() {
    if (dirty && !window.confirm("Discard unsaved changes?")) {
      return;
    }
    setError(null);
    try {
      const note = await notesApi.openDaily(localDate());
      await refresh();
      setSelected(note);
      setContent(note.content);
      setConflictRevision(null);
      setTaskTitle(null);
      setStatus("Opened today's note");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open today's note");
    }
  }

  async function createFromTemplate() {
    const path = newPath.trim();
    if (!path || !templateId) {
      return;
    }
    if (dirty && !window.confirm("Discard unsaved changes?")) {
      return;
    }
    setError(null);
    try {
      const created = await notesApi.createFromTemplate(path, templateId, localDate());
      setNewPath("");
      await refresh();
      setSelected(created);
      setContent(created.content);
      setConflictRevision(null);
      setTaskTitle(null);
      setStatus("Created from template");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the note");
    }
  }

  async function save() {
    if (!selected) {
      return;
    }
    setError(null);
    try {
      const updated = await notesApi.update(selected.id, content, selected.revision);
      setSelected(updated);
      setContent(updated.content);
      setConflictRevision(null);
      setStatus("Saved");
      await refresh();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConflictRevision(err.currentRevision);
        setError("This note changed elsewhere. Choose how to resolve it.");
        return;
      }
      setError(err instanceof Error ? err.message : "Save failed");
    }
  }

  async function saveAsConflictCopy() {
    if (!selected) {
      return;
    }
    try {
      const copy = await notesApi.saveConflictCopy(selected.id, content);
      setConflictRevision(null);
      setStatus(`Kept your version as “${copy.path}”`);
      await refresh();
      await openNote(selected.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not keep a conflict copy");
    }
  }

  async function reloadFromServer() {
    if (!selected) {
      return;
    }
    setConflictRevision(null);
    setStatus(null);
    await openNote(selected.id);
  }

  async function createNote() {
    const path = newPath.trim();
    if (!path) {
      return;
    }
    try {
      const created = await notesApi.create(path, `# ${path.split("/").pop()?.replace(/\.md$/, "")}\n`);
      setNewPath("");
      await refresh();
      setSelected(created);
      setContent(created.content);
      setStatus("Created");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the note");
    }
  }

  function startTask() {
    setTaskError(null);
    setTaskTitle(taskTitleFromText(editor.current?.selectionOrLine() ?? ""));
  }

  async function createTask() {
    if (!selected || taskTitle === null || taskBusy) {
      return;
    }
    setTaskBusy(true);
    setTaskError(null);
    try {
      // A note filed under exactly one project files its new task there; otherwise it is an
      // Inbox task. Either way the task holds a link to this note.
      const project = selected.projects.length === 1 ? selected.projects[0] : null;
      const created = await notesApi.createTask(
        selected.id,
        taskTitle.trim(),
        project ? { project_id: project.id } : {},
      );
      setTaskTitle(null);
      setStatus(`Created task “${created.title}”`);
      await reloadLinked();
    } catch (err) {
      setTaskError(err instanceof Error ? err.message : "Could not create the task");
    } finally {
      setTaskBusy(false);
    }
  }

  async function openTask(id: string) {
    try {
      taskEditor.open(await tasksApi.get(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the task");
    }
  }

  async function createFolder() {
    const path = newPath.trim();
    if (!path) {
      return;
    }
    try {
      await notesApi.createFolder(path);
      setNewPath("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the folder");
    }
  }

  async function renameSelected() {
    if (!selected) {
      return;
    }
    const target = window.prompt("New path", selected.path);
    if (!target || target === selected.path) {
      return;
    }
    try {
      const moved = await notesApi.move(selected.id, target);
      setSelected(moved);
      await refresh();
      setStatus("Renamed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    }
  }

  async function deleteSelected() {
    if (!selected || !window.confirm(`Delete “${selected.path}”? It moves to the trash folder.`)) {
      return;
    }
    try {
      await notesApi.remove(selected.id);
      setSelected(null);
      setContent("");
      await refresh();
      setStatus("Moved to trash");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    }
  }

  async function runSearch(value: string) {
    setQuery(value);
    if (!value.trim()) {
      setResults(null);
      return;
    }
    try {
      setResults(await notesApi.search(value));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
    }
  }

  return (
    <section className="page notes-page">
      <h1>Notes</h1>
      {error && listState === "error" ? (
        <LoadError message={error} onRetry={loadList} />
      ) : error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {listState === "loading" ? (
        <p className="muted" role="status">
          Loading notes…
        </p>
      ) : null}
      {status ? (
        <p className="muted" role="status">
          {status}
        </p>
      ) : null}

      <div className="notes-layout">
        <aside className="notes-sidebar">
          <input
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
            value={query}
            onChange={(event) => void runSearch(event.target.value)}
          />
          <div className="row">
            <input
              type="text"
              placeholder="Inbox/New note"
              aria-label="New note or folder path"
              value={newPath}
              onChange={(event) => setNewPath(event.target.value)}
            />
            <button type="button" onClick={() => void createNote()}>
              New note
            </button>
            <button type="button" className="ghost" onClick={() => void createFolder()}>
              New folder
            </button>
          </div>
          <div className="row">
            <select
              ref={templateSelect}
              aria-label="Template"
              value={templateId}
              disabled={templates.length === 0}
              onChange={(event) => setTemplateId(event.target.value)}
            >
              <option value="">
                {templates.length === 0 ? "No templates (add notes to templates/)" : "Choose a template"}
              </option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.path.replace(/^templates\//, "").replace(/\.md$/, "")}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ghost"
              disabled={!templateId || !newPath.trim()}
              onClick={() => void createFromTemplate()}
            >
              New from template
            </button>
          </div>
          <button type="button" className="ghost" onClick={() => void openTodaysNote()}>
            {"Today's note"}
          </button>
          {results ? (
            <div>
              <p className="muted">{results.length} result(s)</p>
              <ul className="tree">
                {results.map((note) => (
                  <li key={note.id}>
                    <button type="button" className="tree-note" onClick={() => void openNote(note.id)}>
                      {note.path}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <NoteTree
              tree={tree}
              selectedId={selected?.id ?? null}
              onSelect={(id) => void openNote(id)}
              onSelectFolder={(path) => setNewPath(`${path}/`)}
            />
          )}
        </aside>

        <div className="notes-main">
          {selected ? (
            <>
              <div className="notes-toolbar">
                <span className="muted">
                  {selected.path} · revision {selected.revision}
                  {dirty ? " · unsaved" : ""}
                </span>
                <div className="row">
                  <button type="button" onClick={() => void save()} disabled={!dirty}>
                    Save
                  </button>
                  <button type="button" className="ghost" onClick={startTask}>
                    Task from selection
                  </button>
                  <button type="button" className="ghost" onClick={() => void renameSelected()}>
                    Rename
                  </button>
                  <button type="button" className="ghost" onClick={() => void deleteSelected()}>
                    Delete
                  </button>
                </div>
              </div>

              {conflictRevision !== null ? (
                <div className="conflict-banner">
                  <span>The server has revision {conflictRevision}. Nothing was overwritten.</span>
                  <div className="row">
                    <button type="button" onClick={() => void saveAsConflictCopy()}>
                      Keep my version as a copy
                    </button>
                    <button type="button" className="ghost" onClick={() => void reloadFromServer()}>
                      Reload server version
                    </button>
                  </div>
                </div>
              ) : null}

              {taskTitle !== null ? (
                <form
                  className="note-task-form"
                  aria-label="New task from note"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void createTask();
                  }}
                >
                  <label htmlFor="note-task-title">Task title</label>
                  <input
                    id="note-task-title"
                    type="text"
                    value={taskTitle}
                    autoFocus
                    onChange={(event) => setTaskTitle(event.target.value)}
                  />
                  <p className="muted">
                    {selected.projects.length === 1
                      ? `Will be filed in “${selected.projects[0].name}”. `
                      : ""}
                    The task links back to this note; the note is not changed.
                  </p>
                  {taskError ? (
                    <p className="error" role="alert">
                      {taskError}
                    </p>
                  ) : null}
                  <div className="row">
                    <button type="submit" disabled={taskBusy}>
                      Create task
                    </button>
                    <button type="button" className="ghost" onClick={() => setTaskTitle(null)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}

              <div className="editor-split">
                <NoteEditor ref={editor} value={content} onChange={setContent} notes={notes} />
                <MarkdownPreview content={content} />
              </div>

              {selected.tags.length > 0 ? (
                <p className="muted">Tags: {selected.tags.map((tag) => `#${tag}`).join(", ")}</p>
              ) : null}

              <div className="notes-links">
                <div>
                  <h2>Links</h2>
                  {selected.links.length === 0 ? (
                    <p className="muted">No wiki links.</p>
                  ) : (
                    <ul>
                      {selected.links.map((link) => (
                        <li key={link.target_path}>
                          {link.target_note_id ? (
                            <button
                              type="button"
                              className="link"
                              onClick={() => void openNote(link.target_note_id as string)}
                            >
                              {link.target_path}
                            </button>
                          ) : (
                            <span className="muted">{link.target_path} (unresolved)</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <div>
                  <h2>Backlinks</h2>
                  {selected.backlinks.length + selected.tasks.length + selected.projects.length ===
                  0 ? (
                    <p className="muted">Nothing links here yet.</p>
                  ) : null}
                  {selected.backlinks.length > 0 ? (
                    <ul aria-label="Linked notes">
                      {selected.backlinks.map((note) => (
                        <li key={note.id}>
                          <button type="button" className="link" onClick={() => void openNote(note.id)}>
                            {note.path}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {selected.tasks.length > 0 ? (
                    <ul aria-label="Linked tasks">
                      {selected.tasks.map((task) => (
                        <li key={task.id}>
                          <button
                            type="button"
                            className="link"
                            onClick={() => void openTask(task.id)}
                          >
                            {task.title}
                          </button>{" "}
                          <span className="muted">· {STATUS_LABELS[task.status]}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {selected.projects.length > 0 ? (
                    <ul aria-label="Linked projects">
                      {selected.projects.map((project) => (
                        <li key={project.id}>
                          <Link to={`/projects/${project.id}`}>{project.name}</Link>{" "}
                          <span className="muted">· project</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">Select a note, or create one to get started.</div>
          )}
        </div>
      </div>
      {taskEditor.overlays}
    </section>
  );
}
