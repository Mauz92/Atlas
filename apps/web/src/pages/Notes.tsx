import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";

import {
  notesApi,
  tasksApi,
  type NoteDetail,
  type NoteSummary,
} from "../api/client";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { LoadError } from "../components/LoadError";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { Menu, type MenuEntry } from "../components/Menu";
import { NoteEditor, type NoteEditorHandle } from "../components/NoteEditor";
import { Skeleton } from "../components/Skeleton";
import {
  NoteTree,
  type NoteTreeActions,
  type TemplateChoice,
  type TreeCreation,
  type TreeTarget,
} from "../components/NoteTree";
import { noteSessions, useNoteAutosave } from "../hooks/useNoteAutosave";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { SAVE_LABELS } from "../lib/noteAutosave";
import { taskTitleFromText } from "../lib/noteLinks";
import { templatesOf } from "../lib/dailyNote";
import { buildTree } from "../lib/noteTree";
import {
  type EditorMode,
  readEditorMode,
  readPanelOpen,
  readPreview,
  writeEditorMode,
  writePanelOpen,
  writePreview,
} from "../lib/notesPrefs";
import { localDate } from "../lib/taskForm";
import { STATUS_LABELS } from "../lib/taskStatus";

/** Where a new note, folder or note-from-template goes, and what it is called while being typed. */
type Creation = TreeCreation & {
  kind: "note" | "folder" | "template";
  templateId?: string;
};

type HeaderMenu = { anchor: HTMLElement; kind: "options" | "templates" };

function folderOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

function templateName(note: NoteSummary): string {
  return note.path.replace(/^templates\//, "").replace(/\.md$/, "");
}

/**
 * The Notes workspace (UX-05, ADR-0054): the file tree, the open note with its header, and a
 * details panel for links, backlinks, tasks and projects. The note saves itself through its save
 * session (`lib/noteAutosave.ts`): there is no Save button, and switching notes, renaming,
 * deleting, creating and leaving the page all flush first.
 */
export function Notes() {
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [selected, setSelected] = useState<NoteDetail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The first read of the note list: shown as "Loading notes…" and, if it fails, with a retry.
  const [listState, setListState] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NoteSummary[] | null>(null);
  // Tree state: where new things go, what is being named, which folders are closed.
  const [activeFolder, setActiveFolder] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [creation, setCreation] = useState<Creation | null>(null);
  const [renaming, setRenaming] = useState<TreeTarget | null>(null);
  const [headerRename, setHeaderRename] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<HeaderMenu | null>(null);
  // "Task from selection" (MU-06): the title being confirmed, or null when the form is closed.
  const [taskTitle, setTaskTitle] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);
  // Phones show the tree or the note, not both; wider screens always show the tree.
  const [treeOpen, setTreeOpen] = useState(false);
  const wideEnoughForPanel = useMediaQuery("(min-width: 1440px)", true);
  const [panelChoice, setPanelChoice] = useState<boolean | null>(readPanelOpen);
  // On a phone the panel covers the note, so it starts closed and the choice is not remembered.
  const phone = useMediaQuery("(max-width: 720px)", false);
  const [phonePanel, setPhonePanel] = useState(false);
  const panelOpen = phone ? phonePanel : (panelChoice ?? wideEnoughForPanel);
  const [preview, setPreview] = useState(readPreview);
  const [mode, setMode] = useState<EditorMode>(readEditorMode);
  // A note just created opens with the cursor in it.
  const [focusId, setFocusId] = useState<string | null>(null);

  const editor = useRef<NoteEditorHandle | null>(null);
  const templateButton = useRef<HTMLButtonElement | null>(null);
  const optionsButton = useRef<HTMLButtonElement | null>(null);

  // `/notes?open=<id>` opens that note (the command palette and the Search page link here).
  const [params, setParams] = useSearchParams();
  const openId = params.get("open");
  // `/notes?new=template` (the palette's "New note from template") opens the template menu.
  const wantsTemplate = params.get("new") === "template";

  const tree = useMemo(() => buildTree(folders, notes), [folders, notes]);
  const templates = useMemo(() => templatesOf(notes), [notes]);
  const templateChoices = useMemo<TemplateChoice[]>(
    () =>
      templates.map((template) => ({
        id: template.id,
        name: templateName(template),
      })),
    [templates],
  );

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

  // Every confirmed version (an autosave, "Reload server version") replaces what the page knows
  // of the note and refreshes the tree, whose titles come from the notes' first headings.
  const onSaved = useCallback(
    (version: NoteDetail) => {
      setSelected((current) =>
        current && current.id === version.id ? version : current,
      );
      void refresh().catch(() => undefined);
    },
    [refresh],
  );
  const { session, snapshot } = useNoteAutosave(selected, onSaved);
  // What the page shows. A version the session confirmed that `onSaved` did not deliver (a save that
  // finished before this page was listening) is taken here, so the page never shows an older revision.
  const confirmed = snapshot?.note;
  useEffect(() => {
    if (confirmed) {
      setSelected((now) =>
        now && now.id === confirmed.id && confirmed.revision > now.revision
          ? confirmed
          : now,
      );
    }
  }, [confirmed]);
  const current = selected;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const sessionRef = useRef(session);
  sessionRef.current = session;

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

  const message = (err: unknown, fallback: string) =>
    err instanceof Error ? err.message : fallback;

  /** Show `detail` as the open note; the URL keeps the choice across a reload. */
  const showNote = useCallback(
    (detail: NoteDetail) => {
      setSelected(detail);
      setTaskTitle(null);
      setHeaderRename(false);
      setTreeOpen(false);
      const folder = folderOf(detail.path);
      setActiveFolder(folder);
      setCollapsed((current) => {
        const open = folder
          .split("/")
          .map((_, index, parts) => parts.slice(0, index + 1).join("/"));
        return open.some((path) => current.has(path))
          ? new Set([...current].filter((path) => !open.includes(path)))
          : current;
      });
      setParams(
        (current) =>
          current.get("open") === detail.id ? current : { open: detail.id },
        {
          replace: true,
        },
      );
    },
    [setParams],
  );

  /**
   * Save the open note before something else needs its server state (rename, move). `false` means
   * the text could not be confirmed; the text itself is safe in its session and local draft.
   */
  const settle = useCallback(async (id?: string): Promise<boolean> => {
    const target = id ? noteSessions.get(id) : sessionRef.current;
    if (!target) {
      return true;
    }
    if (await target.flush()) {
      return true;
    }
    setError(
      "The latest changes to this note are not saved yet, so it can't be changed now. They are kept on this device.",
    );
    return false;
  }, []);

  const openNote = useCallback(
    async (id: string) => {
      if (selectedRef.current?.id === id) {
        return;
      }
      setError(null);
      setStatus(null);
      try {
        // The note being left is saved first. If that cannot happen now (offline, conflict) its
        // text stays in its session and its local draft, and is there when the note is reopened.
        await sessionRef.current?.flush();
        showNote(await notesApi.get(id));
      } catch (err) {
        setError(message(err, "Failed to open note"));
      }
    },
    [showNote],
  );

  const openRequested = useRef(openNote);
  openRequested.current = openNote;
  useEffect(() => {
    if (openId) {
      void openRequested.current(openId);
    }
  }, [openId]);

  // The palette's "New note from template": open the template menu once the notes are known.
  useEffect(() => {
    if (wantsTemplate && listState === "ready" && templateButton.current) {
      setHeaderMenu({ anchor: templateButton.current, kind: "templates" });
    }
  }, [wantsTemplate, listState]);

  // Ctrl/⌘ S just saves now (the note also saves by itself); Ctrl/⌘ Alt B toggles the panel.
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      void session?.flush();
    }
  }
  useEffect(() => {
    function onWindowKey(event: globalThis.KeyboardEvent) {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.altKey &&
        event.code === "KeyB"
      ) {
        event.preventDefault();
        if (phone) {
          setPhonePanel((open) => !open);
          return;
        }
        setPanelChoice((current) => {
          const next = !(current ?? wideEnoughForPanel);
          writePanelOpen(next);
          return next;
        });
      }
    }
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  }, [wideEnoughForPanel, phone]);

  function togglePanel() {
    const next = !panelOpen;
    if (phone) {
      setPhonePanel(next);
      return;
    }
    writePanelOpen(next);
    setPanelChoice(next);
  }

  function chooseMode(next: EditorMode) {
    writeEditorMode(next);
    setMode(next);
  }

  function togglePreview() {
    writePreview(!preview);
    setPreview(!preview);
  }

  // --- creating ---------------------------------------------------------------------------------

  function beginCreation(
    kind: Creation["kind"],
    folder: string,
    templateId?: string,
  ) {
    const template = templateChoices.find((choice) => choice.id === templateId);
    setError(null);
    setRenaming(null);
    setTreeOpen(true);
    setCollapsed((current) =>
      current.has(folder)
        ? new Set([...current].filter((p) => p !== folder))
        : current,
    );
    setCreation({
      kind,
      folder,
      templateId,
      label:
        kind === "folder"
          ? "New folder name"
          : kind === "template"
            ? `Name for the new note from ${template?.name ?? "template"}`
            : "New note name",
    });
  }

  async function commitCreation(name: string) {
    const pending = creation;
    setCreation(null);
    if (!pending) {
      return;
    }
    const path = pending.folder
      ? `${pending.folder}/${name.replace(/^\/+/, "")}`
      : name.replace(/^\/+/, "");
    setError(null);
    try {
      if (pending.kind === "folder") {
        await notesApi.createFolder(path);
        await refresh();
        setStatus("Folder created");
        return;
      }
      await sessionRef.current?.flush();
      const created =
        pending.kind === "template" && pending.templateId
          ? await notesApi.createFromTemplate(
              path,
              pending.templateId,
              localDate(),
            )
          : await notesApi.create(
              path,
              `# ${path.split("/").pop()?.replace(/\.md$/, "")}\n`,
            );
      await refresh();
      showNote(created);
      setStatus(
        pending.kind === "template" ? "Created from template" : "Created",
      );
      setFocusId(created.id);
    } catch (err) {
      setError(message(err, "Could not create it"));
    }
  }

  /** Open today's note, creating `daily/<date>.md` if it is missing (the server never rewrites it). */
  async function openTodaysNote() {
    setError(null);
    try {
      await sessionRef.current?.flush();
      const note = await notesApi.openDaily(localDate());
      await refresh();
      showNote(note);
      setStatus("Opened today's note");
    } catch (err) {
      setError(message(err, "Could not open today's note"));
    }
  }

  // --- renaming, moving, deleting ---------------------------------------------------------------

  async function renameNote(id: string, newPath: string) {
    if (!(await settle(id))) {
      return;
    }
    setError(null);
    try {
      const moved = await notesApi.move(id, newPath);
      if (selectedRef.current?.id === id) {
        setSelected(moved);
        setActiveFolder(folderOf(moved.path));
      }
      await refresh();
      setStatus("Renamed");
    } catch (err) {
      setError(message(err, "Rename failed"));
    }
  }

  async function renameFolder(path: string, name: string) {
    if (!(await settle())) {
      return;
    }
    const parent = folderOf(path);
    setError(null);
    try {
      await notesApi.renameFolder(path, parent ? `${parent}/${name}` : name);
      await refresh();
      if (selectedRef.current) {
        // Notes under the folder moved: re-read the open one so its path (and revision) are current.
        setSelected(await notesApi.get(selectedRef.current.id));
      }
      setStatus("Renamed");
    } catch (err) {
      setError(message(err, "Rename failed"));
    }
  }

  async function commitRename(name: string) {
    const target = renaming;
    setRenaming(null);
    setHeaderRename(false);
    if (!target) {
      return;
    }
    if (target.kind === "folder") {
      await renameFolder(target.path, name);
      return;
    }
    const dir = folderOf(target.path);
    const file = /\.md$/i.test(name) ? name : `${name}.md`;
    await renameNote(target.id, dir ? `${dir}/${file}` : file);
  }

  async function deleteNote(id: string, path: string) {
    if (!window.confirm(`Delete “${path}”? It moves to the trash folder.`)) {
      return;
    }
    setError(null);
    try {
      await notesApi.remove(id);
      noteSessions.forget(id);
      if (selectedRef.current?.id === id) {
        setSelected(null);
        setParams({}, { replace: true });
      }
      await refresh();
      setStatus("Moved to trash");
    } catch (err) {
      setError(message(err, "Delete failed"));
    }
  }

  async function deleteFolder(path: string) {
    if (
      !window.confirm(
        `Delete the folder “${path}”? Only an empty folder can be deleted.`,
      )
    ) {
      return;
    }
    setError(null);
    try {
      await notesApi.removeFolder(path);
      await refresh();
      setStatus("Folder deleted");
    } catch (err) {
      setError(message(err, "Could not delete the folder"));
    }
  }

  const treeActions: NoteTreeActions = {
    rename: (target) => {
      setCreation(null);
      setRenaming(target);
    },
    move: (id, folder) => {
      const note = notes.find((candidate) => candidate.id === id);
      if (note) {
        const file = note.path.split("/").pop()!;
        void renameNote(id, folder ? `${folder}/${file}` : file);
      }
    },
    remove: (target) =>
      target.kind === "note"
        ? void deleteNote(target.id, target.path)
        : void deleteFolder(target.path),
    newIn: (kind, folder) => beginCreation(kind, folder),
    newFromTemplate: (templateId, folder) =>
      beginCreation("template", folder, templateId),
  };

  // --- conflict choices -------------------------------------------------------------------------

  async function saveAsConflictCopy() {
    try {
      const path = await session?.keepMineAsCopy();
      setStatus(`Kept your version as “${path}”`);
      await refresh();
    } catch (err) {
      setError(message(err, "Could not keep a conflict copy"));
    }
  }

  async function reloadFromServer() {
    try {
      await session?.reloadFromServer();
      setStatus(null);
    } catch (err) {
      setError(message(err, "Could not load the server's version"));
    }
  }

  // --- task from selection ----------------------------------------------------------------------

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
      const project =
        selected.projects.length === 1 ? selected.projects[0] : null;
      const created = await notesApi.createTask(
        selected.id,
        taskTitle.trim(),
        project ? { project_id: project.id } : {},
      );
      setTaskTitle(null);
      setStatus(`Created task “${created.title}”`);
      await reloadLinked();
    } catch (err) {
      setTaskError(message(err, "Could not create the task"));
    } finally {
      setTaskBusy(false);
    }
  }

  async function openTask(id: string) {
    try {
      taskEditor.open(await tasksApi.get(id));
    } catch (err) {
      setError(message(err, "Could not open the task"));
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
      setError(message(err, "Search failed"));
    }
  }

  // --- menus ------------------------------------------------------------------------------------

  const headerEntries: MenuEntry[] = !headerMenu
    ? []
    : headerMenu.kind === "options"
      ? [
          {
            kind: "item",
            id: "task",
            label: "Task from selection",
            icon: "list-checks",
            onSelect: startTask,
          },
          {
            kind: "item",
            id: "rename",
            label: "Rename",
            onSelect: () => setHeaderRename(true),
          },
          { kind: "separator", id: "s1" },
          {
            kind: "item",
            id: "delete",
            label: "Delete",
            icon: "trash-2",
            danger: true,
            onSelect: () =>
              selected && void deleteNote(selected.id, selected.path),
          },
        ]
      : templateChoices.length === 0
        ? [
            {
              kind: "item",
              id: "none",
              label: "No templates (add notes to templates/)",
              disabled: true,
              onSelect: () => undefined,
            },
          ]
        : templateChoices.map((choice) => ({
            kind: "item" as const,
            id: `template-${choice.id}`,
            label: choice.name,
            onSelect: () => beginCreation("template", activeFolder, choice.id),
          }));

  function toggleHeaderMenu(anchor: HTMLElement, kind: HeaderMenu["kind"]) {
    setHeaderMenu((current) =>
      current?.anchor === anchor && current.kind === kind
        ? null
        : { anchor, kind },
    );
  }

  // --- render -----------------------------------------------------------------------------------

  const state = snapshot?.state ?? "saved";
  const segments = current ? current.path.split("/") : [];
  const fileBase = current
    ? current.path.split("/").pop()!.replace(/\.md$/i, "")
    : "";
  const showTree = treeOpen || !selected;

  return (
    <section
      className="page notes-page"
      data-panel={panelOpen ? "open" : "closed"}
      data-tree={showTree ? "open" : "closed"}
    >
      <h1 className="sr-only">Notes</h1>
      <div className="notes-alerts">
        {error && listState === "error" ? (
          <LoadError message={error} onRetry={loadList} />
        ) : error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        {status ? (
          <p className="muted" role="status">
            {status}
          </p>
        ) : null}
      </div>

      <div className="notes-stage">
        <div className="notes-tree">
          <div className="notes-tree-head">
            <span className="notes-tree-title">Notes</span>
            <div className="notes-tree-actions">
              <button
                type="button"
                className="ghost icon-button"
                aria-label="New note"
                title="New note"
                onClick={() => beginCreation("note", activeFolder)}
              >
                <Icon name="file-plus" />
              </button>
              <button
                type="button"
                className="ghost icon-button"
                aria-label="New folder"
                title="New folder"
                onClick={() => beginCreation("folder", activeFolder)}
              >
                <Icon name="folder-plus" />
              </button>
              <button
                ref={templateButton}
                type="button"
                className="ghost icon-button"
                aria-label="New from template"
                title="New from template"
                aria-haspopup="menu"
                aria-expanded={headerMenu?.kind === "templates"}
                onClick={(event) =>
                  toggleHeaderMenu(event.currentTarget, "templates")
                }
              >
                <Icon name="layout-template" />
              </button>
              <button
                type="button"
                className="ghost icon-button"
                aria-label="Today's note"
                title="Today's note"
                onClick={() => void openTodaysNote()}
              >
                <Icon name="calendar" />
              </button>
              <button
                type="button"
                className="ghost icon-button"
                aria-label="Collapse all folders"
                title="Collapse all folders"
                onClick={() => setCollapsed(new Set(folders))}
              >
                <Icon name="chevrons-down-up" />
              </button>
            </div>
          </div>
          <input
            type="search"
            placeholder="Search notes"
            aria-label="Search notes"
            value={query}
            onChange={(event) => void runSearch(event.target.value)}
          />
          <div className="notes-tree-scroll">
            {listState === "loading" ? (
              <Skeleton label="Loading notes" kind="tree" rows={7} />
            ) : results ? (
              <div>
                <p className="muted">{results.length} result(s)</p>
                <ul className="tree">
                  {results.map((note) => (
                    <li key={note.id}>
                      <div className="tree-row">
                        <button
                          type="button"
                          className="tree-note"
                          onClick={() => void openNote(note.id)}
                        >
                          <Icon name="file-text" />
                          <span className="tree-label">{note.path}</span>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : listState === "ready" && notes.length === 0 ? (
              <EmptyState
                icon="file-text"
                compact
                action={{ label: "Create the first note", onClick: () => beginCreation("note", activeFolder) }}
              >
                No notes yet.
              </EmptyState>
            ) : (
              <NoteTree
                tree={tree}
                selectedId={selected?.id ?? null}
                collapsed={collapsed}
                onToggleFolder={(path) => {
                  setActiveFolder(path);
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (!next.delete(path)) {
                      next.add(path);
                    }
                    return next;
                  });
                }}
                onSelect={(id) => void openNote(id)}
                folderPaths={folders}
                templates={templateChoices}
                actions={treeActions}
                creation={creation}
                onCreate={(name) => void commitCreation(name)}
                onCancelCreate={() => setCreation(null)}
                renaming={renaming}
                onRename={(name) => void commitRename(name)}
                onCancelRename={() => setRenaming(null)}
              />
            )}
          </div>
        </div>

        <div className="notes-main" onKeyDown={onKeyDown}>
          {current ? (
            <>
              <div className="notes-header">
                <button
                  type="button"
                  className="ghost icon-button notes-tree-toggle"
                  aria-label="Show notes list"
                  aria-expanded={treeOpen}
                  onClick={() => setTreeOpen((open) => !open)}
                >
                  <Icon name="panel-left" />
                </button>
                <nav className="note-breadcrumb" aria-label="Breadcrumb">
                  {headerRename ? (
                    <input
                      type="text"
                      className="tree-name-input"
                      aria-label="Note name"
                      defaultValue={fileBase}
                      autoFocus
                      onFocus={(event) => event.currentTarget.select()}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          const name = event.currentTarget.value.trim();
                          setHeaderRename(false);
                          if (name && name !== fileBase) {
                            const dir = folderOf(current.path);
                            const file = /\.md$/i.test(name)
                              ? name
                              : `${name}.md`;
                            void renameNote(
                              current.id,
                              dir ? `${dir}/${file}` : file,
                            );
                          }
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setHeaderRename(false);
                        }
                      }}
                      onBlur={() => setHeaderRename(false)}
                    />
                  ) : (
                    /* The revision is diagnostics, not content: it stays in the tooltip (UX-01). */
                    <span
                      className="note-path"
                      title={`Revision ${current.revision}`}
                    >
                      {segments.map((segment, index) => (
                        <span
                          key={index}
                          className={
                            index === segments.length - 1
                              ? "note-leaf"
                              : undefined
                          }
                        >
                          {index > 0 ? <span aria-hidden="true">/</span> : null}
                          {segment}
                        </span>
                      ))}
                    </span>
                  )}
                </nav>
                <span
                  className="note-save-state"
                  data-save-state={state}
                  aria-live="polite"
                >
                  {SAVE_LABELS[state]}
                </span>
                {state === "failed" ? (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => void session?.retry()}
                  >
                    Retry
                  </button>
                ) : null}
                <div className="notes-header-actions">
                  <div className="mode-switch" role="group" aria-label="Editor mode">
                    {(["source", "live"] as const).map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        className="ghost"
                        aria-pressed={mode === choice}
                        onClick={() => chooseMode(choice)}
                      >
                        {choice === "source" ? "Source" : "Live"}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    aria-pressed={preview}
                    onClick={togglePreview}
                  >
                    Preview
                  </button>
                  <button
                    type="button"
                    className="ghost icon-button"
                    aria-label="Links and details"
                    title="Links and details (Ctrl+Alt+B)"
                    aria-pressed={panelOpen}
                    aria-controls="notes-panel"
                    onClick={togglePanel}
                  >
                    <Icon name="panel-right" />
                  </button>
                  <button
                    ref={optionsButton}
                    type="button"
                    className="ghost icon-button"
                    aria-label="Note options"
                    aria-haspopup="menu"
                    aria-expanded={headerMenu?.kind === "options"}
                    onClick={(event) =>
                      toggleHeaderMenu(event.currentTarget, "options")
                    }
                  >
                    <Icon name="ellipsis" />
                  </button>
                </div>
              </div>

              {snapshot?.restored && state !== "conflict" ? (
                <p className="muted notes-notice">
                  Restored text you typed here before the page was closed.
                </p>
              ) : null}

              {state === "conflict" && snapshot ? (
                <div className="conflict-banner">
                  <span>
                    The server has revision {snapshot.conflictRevision}. Nothing
                    was overwritten.
                  </span>
                  <div className="row">
                    <button
                      type="button"
                      onClick={() => void saveAsConflictCopy()}
                    >
                      Keep my version as a copy
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => void reloadFromServer()}
                    >
                      Reload server version
                    </button>
                  </div>
                </div>
              ) : null}

              {(state === "failed" || state === "rejected") &&
              snapshot?.failure ? (
                <p className="error" role="alert">
                  {state === "failed"
                    ? `Couldn't save: ${snapshot.failure} Your text is kept on this device and will be sent again.`
                    : `Not saved: ${snapshot.failure}`}
                </p>
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
                    {current.projects.length === 1
                      ? `Will be filed in “${current.projects[0].name}”. `
                      : ""}
                    The task links back to this note; the note is not changed.
                  </p>
                  {taskError ? (
                    <p className="error" role="alert">
                      {taskError}
                    </p>
                  ) : null}
                  <div className="row">
                    <button
                      type="submit"
                      className="primary"
                      disabled={taskBusy}
                    >
                      Create task
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => setTaskTitle(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}

              <div className="notes-body" data-preview={preview}>
                <NoteEditor
                  key={current.id}
                  autoFocus={focusId === current.id}
                  ref={editor}
                  value={snapshot?.content ?? ""}
                  onChange={(text) => session?.change(text)}
                  notes={notes}
                  mode={mode}
                  onOpenNote={(id) => void openNote(id)}
                />
                {preview ? (
                  <MarkdownPreview
                    content={snapshot?.content ?? ""}
                    notes={notes}
                    onOpenNote={(id) => void openNote(id)}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <EmptyState
              icon="file-text"
              action={{ label: "Create a note", onClick: () => beginCreation("note", activeFolder) }}
            >
              Select a note, or create one to get started.
            </EmptyState>
          )}
        </div>

        {current ? (
          <div
            id="notes-panel"
            className="notes-panel"
            role="region"
            aria-label="Note details"
            hidden={!panelOpen}
          >
            <div className="notes-panel-scroll">
              <section>
                <h2>Links</h2>
                {current.links.length === 0 ? (
                  <p className="muted">No wiki links.</p>
                ) : (
                  <ul>
                    {current.links.map((link) => (
                      <li key={link.target_path}>
                        {link.target_note_id ? (
                          <button
                            type="button"
                            className="link"
                            onClick={() =>
                              void openNote(link.target_note_id as string)
                            }
                          >
                            {link.target_path}
                          </button>
                        ) : (
                          <span className="muted">
                            {link.target_path} (unresolved)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section>
                <h2>Backlinks</h2>
                {current.backlinks.length +
                  current.tasks.length +
                  current.projects.length ===
                0 ? (
                  <p className="muted">Nothing links here yet.</p>
                ) : null}
                {current.backlinks.length > 0 ? (
                  <ul aria-label="Linked notes">
                    {current.backlinks.map((note) => (
                      <li key={note.id}>
                        <button
                          type="button"
                          className="link"
                          onClick={() => void openNote(note.id)}
                        >
                          {note.path}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {current.tasks.length > 0 ? (
                  <ul aria-label="Linked tasks">
                    {current.tasks.map((task) => (
                      <li key={task.id}>
                        <button
                          type="button"
                          className="link"
                          onClick={() => void openTask(task.id)}
                        >
                          {task.title}
                        </button>{" "}
                        <span className="muted">
                          · {STATUS_LABELS[task.status]}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {current.projects.length > 0 ? (
                  <ul aria-label="Linked projects">
                    {current.projects.map((project) => (
                      <li key={project.id}>
                        <Link to={`/projects/${project.id}`}>
                          {project.name}
                        </Link>{" "}
                        <span className="muted">· project</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
              {current.tags.length > 0 ? (
                <section>
                  <h2>Tags</h2>
                  <p className="muted">
                    {current.tags.map((tag) => `#${tag}`).join(", ")}
                  </p>
                </section>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {headerMenu ? (
        <Menu
          id="notes-header-menu"
          label={
            headerMenu.kind === "options" ? "Note options" : "New from template"
          }
          anchor={headerMenu.anchor}
          entries={headerEntries}
          onClose={() => setHeaderMenu(null)}
        />
      ) : null}
      {taskEditor.overlays}
    </section>
  );
}
