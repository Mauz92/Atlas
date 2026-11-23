import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";

import { notesApi, projectsApi, tasksApi, type Task } from "../api/client";
import { useKeyboardInset } from "../hooks/useKeyboardInset";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProjects } from "../hooks/useProjects";
import { useUnifiedSearch } from "../hooks/useUnifiedSearch";
import { useFeatures } from "../lib/features";
import { PALETTE_PAGES, TTRPG_NAV_ITEMS } from "../lib/navigation";
import { SHEET_QUERY } from "../lib/phone";
import { rankByQuery } from "../lib/palette";
import { localDate } from "../lib/taskForm";
import { readTheme, toggleTheme } from "../lib/theme";

const RESULT_LIMIT = 6;

interface Entry {
  id: string;
  group: string;
  label: string;
  /** Secondary text (a status, a path). */
  hint?: string;
  /** The hint is a keyboard shortcut: not shown on touch devices, which have no keyboard to press it on. */
  keys?: boolean;
  /** Creating something never becomes the active entry on its own, so Enter cannot do it by accident. */
  creates?: boolean;
  run: () => Promise<void> | void;
}

interface CommandPaletteProps {
  onClose: () => void;
  /** Open the shared task detail (the host owns it, so it survives the palette closing). */
  onOpenTask: (task: Task) => void;
  /** Open the keyboard shortcut help (the host owns it, so it survives the palette closing). */
  onShowShortcuts: () => void;
  /** Show or hide the sidebar (the shell owns it; Ctrl/Cmd+B does the same). */
  onToggleSidebar?: () => void;
  /** Sign out (the shell owns the session). */
  onSignOut?: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * The command palette / quick switcher (MU-05, Ctrl/Cmd+K). One text box finds notes, tasks and
 * projects through `GET /api/search` and offers commands: go to a view, toggle the theme, and
 * create a task, note or project named by the typed text. It is a modal combobox: the arrows move
 * through the list, Enter runs the active entry, Esc closes, Tab stays inside, and focus returns
 * to where it was.
 */
export function CommandPalette({
  onClose,
  onOpenTask,
  onShowShortcuts,
  onToggleSidebar,
  onSignOut,
}: CommandPaletteProps) {
  const navigate = useNavigate();
  const { reload: reloadProjects } = useProjects();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const search = useUnifiedSearch(query, RESULT_LIMIT);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  const text = query.trim();
  // Phone and touch (UX-11): a full-height sheet with a Close button, 44px rows and no key hints.
  const touch = useMediaQuery(SHEET_QUERY, false);
  const inset = useKeyboardInset();

  // Return focus to whatever had it before the palette opened.
  useEffect(() => {
    const opener = document.activeElement;
    input.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      }
    };
  }, []);

  const { features } = useFeatures();
  const entries = useMemo<Entry[]>(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    const list: Entry[] = [];
    for (const note of search.results?.notes ?? []) {
      list.push({
        id: `note-${note.id}`,
        group: "Notes",
        label: note.title || note.path,
        hint: note.path,
        run: go(`/notes?open=${note.id}`),
      });
    }
    for (const task of search.results?.tasks ?? []) {
      list.push({
        id: `task-${task.id}`,
        group: "Tasks",
        label: task.title,
        hint: task.status.replace("_", " "),
        run: async () => {
          onOpenTask(await tasksApi.get(task.id));
          onClose();
        },
      });
    }
    for (const project of search.results?.projects ?? []) {
      list.push({
        id: `project-${project.id}`,
        group: "Projects",
        label: project.name,
        hint: project.status,
        run: go(`/projects/${project.id}`),
      });
    }

    const pages = features.ttrpg
      ? [...PALETTE_PAGES, ...TTRPG_NAV_ITEMS.map((item) => ({ to: item.to, label: `TTRPG ${item.label.toLowerCase()}` }))]
      : PALETTE_PAGES;
    const commands = [
      ...pages.map((item) => ({
        id: `go-${item.to}`,
        group: "Commands",
        label: `Go to ${item.label}`,
        run: go(item.to),
      })),
      {
        id: "open-today-note",
        group: "Commands",
        label: "Open today's note",
        hint: "creates it if missing",
        run: async () => {
          const note = await notesApi.openDaily(localDate());
          onClose();
          navigate(`/notes?open=${note.id}`);
        },
      },
      {
        id: "new-from-template",
        group: "Commands",
        label: "New note from template",
        run: go("/notes?new=template"),
      },
      {
        id: "show-shortcuts",
        group: "Commands",
        label: "Keyboard shortcuts",
        hint: "?",
        keys: true,
        run: () => {
          onClose();
          onShowShortcuts();
        },
      },
      {
        id: "toggle-theme",
        group: "Commands",
        label: "Toggle theme",
        hint: `now ${readTheme()}`,
        run: () => {
          toggleTheme();
          onClose();
        },
      },
      ...(onToggleSidebar
        ? [
            {
              id: "toggle-sidebar",
              group: "Commands",
              label: "Toggle sidebar",
              hint: "Ctrl B",
              keys: true,
              run: () => {
                onClose();
                onToggleSidebar();
              },
            },
          ]
        : []),
      ...(onSignOut
        ? [
            {
              id: "sign-out",
              group: "Commands",
              label: "Sign out",
              run: () => {
                onClose();
                onSignOut();
              },
            },
          ]
        : []),
    ];
    list.push(...rankByQuery(commands, text, (command) => command.label));

    if (text) {
      list.push(
        {
          id: "create-task",
          group: "Create",
          label: `New task “${text}”`,
          creates: true,
          run: async () => {
            const task = await tasksApi.create(text);
            onOpenTask(task);
            onClose();
          },
        },
        {
          id: "create-note",
          group: "Create",
          label: `New note “${text}”`,
          creates: true,
          run: async () => {
            const note = await notesApi.create(
              text,
              `# ${text.split("/").pop()?.replace(/\.md$/, "") ?? text}\n`,
            );
            onClose();
            navigate(`/notes?open=${note.id}`);
          },
        },
        {
          id: "create-project",
          group: "Create",
          label: `New project “${text}”`,
          creates: true,
          run: async () => {
            const project = await projectsApi.create(text);
            void reloadProjects();
            onClose();
            navigate(`/projects/${project.id}`);
          },
        },
      );
    }
    return list;
  }, [
    search.results,
    text,
    navigate,
    onClose,
    onOpenTask,
    onShowShortcuts,
    onToggleSidebar,
    onSignOut,
    reloadProjects,
    features.ttrpg,
  ]);

  // A new list starts on its best match; with only "create" entries nothing is active.
  const firstSafe = entries.findIndex((entry) => !entry.creates);
  const [forEntries, setForEntries] = useState(entries);
  if (forEntries !== entries) {
    setForEntries(entries);
    setActiveIndex(firstSafe);
  }
  const active = entries[activeIndex] ?? null;

  useEffect(() => {
    if (active) {
      document.getElementById(`${listboxId}-${active.id}`)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [active, listboxId]);

  async function run(entry: Entry) {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await entry.run();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function move(step: number) {
    if (entries.length === 0) {
      return;
    }
    setActiveIndex((index) =>
      index < 0 ? (step > 0 ? 0 : entries.length - 1) : (index + step + entries.length) % entries.length,
    );
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (active) {
        void run(active);
      }
    } else if (event.key === "Escape") {
      // preventDefault also tells the task detail's document-level Esc handler to stand down.
      event.preventDefault();
      onClose();
    } else if (event.key === "Tab") {
      const focusable = dialog.current?.querySelectorAll<HTMLElement>("input, button, a[href]");
      if (!focusable || focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  const groups: { name: string; items: { entry: Entry; index: number }[] }[] = [];
  entries.forEach((entry, index) => {
    const last = groups[groups.length - 1];
    if (last && last.name === entry.group) {
      last.items.push({ entry, index });
    } else {
      groups.push({ name: entry.group, items: [{ entry, index }] });
    }
  });

  const status = search.error
    ? ""
    : search.loading
      ? "Searching…"
      : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;

  return (
    <div
      className={`palette-backdrop${touch ? " is-sheet" : ""}`}
      style={touch ? ({ "--kb": `${inset}px` } as CSSProperties) : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialog}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={onKeyDown}
      >
        <div className="palette-bar">
          <input
            ref={input}
            className="palette-input"
            type="text"
            role="combobox"
            aria-label="Search or run a command"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${listboxId}-${active.id}` : undefined}
            placeholder="Search notes, tasks and projects, or type a command…"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setError(null);
            }}
          />
          {touch ? (
            <button type="button" className="ghost palette-close" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
        <div role="status" className="sr-only">
          {status}
        </div>
        {error || search.error ? (
          <p className="error palette-error" role="alert">
            {error ?? search.error}
          </p>
        ) : null}
        <div id={listboxId} role="listbox" aria-label="Results" className="palette-list">
          {groups.map((group) => (
            <div key={group.name} role="group" aria-label={group.name}>
              <div className="palette-group" aria-hidden="true">
                {group.name}
              </div>
              {group.items.map(({ entry, index }) => (
                <div
                  key={entry.id}
                  id={`${listboxId}-${entry.id}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  className="palette-option"
                  data-active={index === activeIndex}
                  onMouseMove={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => void run(entry)}
                >
                  <span>{entry.label}</span>
                  {entry.hint && !(touch && entry.keys) ? (
                    <span className="muted palette-hint">{entry.hint}</span>
                  ) : null}
                </div>
              ))}
            </div>
          ))}
        </div>
        {touch ? null : (
          <p className="muted palette-footer">
            ↑↓ to move · Enter to open · Esc to close
          </p>
        )}
      </div>
    </div>
  );
}
