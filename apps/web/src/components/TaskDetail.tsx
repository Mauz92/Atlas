import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MutableRefObject } from "react";

import { tasksApi, type Project, type Task, type TaskPriority, type TaskStatus } from "../api/client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useTaskAutosave } from "../hooks/useTaskAutosave";
import {
  GROUP_LABELS,
  forgetSession,
  type AutosaveSnapshot,
  type EditMode,
  type FieldGroup,
} from "../lib/taskAutosave";
import { PRIORITIES, recurrenceAnchor, type TaskDraft } from "../lib/taskForm";
import { STATUS_LABELS, STATUS_ORDER, canMove } from "../lib/taskStatus";
import { formatDue, sentenceCase, viewerTimeZone } from "../lib/tasks";
import { Icon } from "./Icon";
import { Menu, type MenuEntry } from "./Menu";
import { TaskNotes } from "./TaskNotes";
import {
  AutoGrowTextarea,
  MenuProperty,
  PropertyRow,
  TagsProperty,
  TimeZoneProperty,
} from "./TaskProperties";
import { TaskReminder } from "./TaskReminder";
import { TaskRepeat } from "./TaskRepeat";
import { TaskSubtasks } from "./TaskSubtasks";

/** What the page owning the panel may ask of it (switching to another task flushes first). */
export interface TaskPanelHandle {
  /** Save everything, then run `action`; if something cannot be saved, ask first. */
  guard: (action: () => void) => void;
}

interface TaskDetailProps {
  task: Task;
  /** The viewer's IANA zone, used to render the task's instants when it has no zone of its own. */
  timeZone?: string;
  /** Projects the task can be filed under (archived ones are offered only while the task is in one). */
  projects?: Project[];
  /** Close the panel (called after everything is saved, or the user chose to discard). */
  onClose: () => void;
  /** A property was saved; the lists should refresh. */
  onSaved: (task: Task) => void;
  /** The task was deleted; the owner of the panel offers the undo. */
  onDeleted: (task: Task) => void;
  /** Open another task (a subtask, the parent, the next occurrence) in this panel. */
  onOpenTask?: (task: Task) => void;
  /** Subtasks changed; the lists should refresh. */
  onRefresh?: () => void;
  /** Open a linked note (MU-06); the owner closes the panel and navigates. */
  onOpenNote?: (noteId: string) => void;
  /** Filled in by the panel so its owner can flush before switching to another task. */
  handle?: MutableRefObject<TaskPanelHandle | null>;
}

/** Docked beside the list from this width; an overlay with a scrim below it (UX_AUDIT §3.4). */
export const DOCKED = "(min-width: 1280px)";

const PRIORITY_MENU: TaskPriority[] = [...PRIORITIES].reverse(); // urgent first, none last

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

/**
 * After completing a repeating task the server has created the next occurrence of the series (and
 * only that one). Find it by title and series; `null` with `checked` means the series has ended.
 */
async function findNextOccurrence(
  completed: Task,
): Promise<{ next: Task | null; checked: boolean }> {
  try {
    const head = completed.recurrence_parent_id ?? completed.id;
    const list = await tasksApi.list({
      q: completed.title.slice(0, 200),
      status: ["inbox", "next", "in_progress"],
      limit: 500,
    });
    const next =
      list.tasks
        .filter(
          (task) => task.id !== completed.id && (task.recurrence_parent_id ?? task.id) === head,
        )
        .sort(
          (a, b) =>
            Date.parse(a.due_at ?? a.start_at ?? "") - Date.parse(b.due_at ?? b.start_at ?? ""),
        )[0] ?? null;
    return { next, checked: true };
  } catch {
    return { next: null, checked: false };
  }
}

const SAVE_TEXT: Record<AutosaveSnapshot["state"], string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Not saved yet",
  invalid: "Not saved",
  offline: "Offline — not saved",
  failed: "Couldn’t save",
  conflict: "Conflict",
};

function SaveIndicator({ state }: { state: AutosaveSnapshot["state"] }) {
  const icon =
    state === "saved"
      ? "check"
      : state === "saving"
        ? "refresh-cw"
        : state === "offline"
          ? "cloud-off"
          : state === "unsaved"
            ? "circle-dot"
            : "triangle-alert";
  return (
    <span className={`save-state save-${state}`} data-save-state={state} aria-live="polite">
      <Icon name={icon} size={14} />
      <span>{SAVE_TEXT[state]}</span>
    </span>
  );
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The single task detail surface (MU-01, rebuilt in UX-04): a property panel that saves itself.
 *
 * - Every property saves on its own through the task's autosave session (`lib/taskAutosave.ts`,
 *   ADR-0053): menus at once, text after a short pause and whenever the field is left, the panel
 *   is closed, another task is opened or the page is hidden. There is no Save button; the header
 *   shows Saving… / Saved / Offline / Conflict. A stale edit never overwrites: the local values stay
 *   and "Load latest version" is offered. A server validation message is shown on its field
 *   verbatim and the text is kept.
 * - Layout: docked beside the list from 1280 px (non-modal, the list stays usable), an overlay with
 *   a scrim and a focus trap below that, a full-screen sheet on phones. Esc closes from anywhere;
 *   the owner returns focus to the row that opened it.
 */
export function TaskDetail({
  task,
  timeZone,
  projects = [],
  onClose,
  onSaved,
  onDeleted,
  onOpenTask,
  onRefresh,
  onOpenNote,
  handle,
}: TaskDetailProps) {
  const ids = useId();
  const panel = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);
  const docked = useMediaQuery(DOCKED, true);
  const [completion, setCompletion] = useState<{ next: Task | null; checked: boolean } | null>(
    null,
  );
  const [leaving, setLeaving] = useState<{ confirm: string; run: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const { session, snapshot } = useTaskAutosave(task, {
    viewerZone: timeZone,
    onSaved: (saved, previous) => {
      const completedRepeat =
        saved.status === "completed" &&
        previous.status !== "completed" &&
        saved.recurrence_rule !== null;
      if (saved.status !== previous.status) setCompletion(null);
      if (completedRepeat) {
        // The server generated exactly the next occurrence; look it up so it can be shown.
        void findNextOccurrence(saved).then((found) => {
          if (mounted.current) setCompletion(found);
        });
      }
      onSaved(saved);
    },
  });
  const { draft, errors } = snapshot;
  const current = snapshot.task;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // Docked: the page leaves room for the panel so the list stays visible beside it.
  useEffect(() => {
    if (!docked) return;
    const root = document.documentElement;
    root.setAttribute("data-task-panel", "docked");
    return () => root.removeAttribute("data-task-panel");
  }, [docked]);

  const edit = useCallback(
    (patch: Partial<TaskDraft>, mode: EditMode) => {
      setLeaving(null);
      session.edit(patch, mode);
    },
    [session],
  );

  /** Save everything, then run `action`; if anything is left unsaved, ask before throwing it away. */
  const guard = useCallback(
    async (action: () => void, confirm = "Discard changes") => {
      const ok = await session.flush();
      if (!mounted.current) return;
      if (ok) {
        setLeaving(null);
        action();
      } else {
        setLeaving({ confirm, run: action });
      }
    },
    [session],
  );

  const requestClose = useCallback(() => void guard(onClose, "Discard and close"), [guard, onClose]);

  useEffect(() => {
    if (!handle) return;
    handle.current = { guard: (action) => void guard(action, "Discard and switch") };
    return () => {
      handle.current = null;
    };
  }, [handle, guard]);

  // Esc closes from anywhere (when docked, focus may be in the list). Menus and the zone list
  // handle their own Esc and stop it.
  const closeRef = useRef(requestClose);
  closeRef.current = requestClose;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        closeRef.current();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // As an overlay the panel is modal: Tab stays inside it.
  function onPanelKeyDown(event: ReactKeyboardEvent) {
    // Saving is automatic; Ctrl/⌘ Enter or Ctrl/⌘ S just saves now (ADR-0051 §4).
    if ((event.ctrlKey || event.metaKey) && (event.key === "Enter" || event.key === "s")) {
      event.preventDefault();
      void session.flush();
      return;
    }
    trapFocus(event);
  }

  function trapFocus(event: ReactKeyboardEvent) {
    if (docked || event.key !== "Tab" || !panel.current) return;
    // Rendered controls only; menu items (tabIndex -1) manage their own keys.
    const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.tabIndex >= 0 && !element.closest("[hidden]"),
    );
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function loadLatest() {
    setLoading(true);
    setError(null);
    try {
      const latest = await tasksApi.get(current.id);
      session.loadLatest(latest);
      onSaved(latest);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function remove() {
    setError(null);
    try {
      await tasksApi.remove(session.getSnapshot().task);
      forgetSession(current.id);
      onDeleted(session.getSnapshot().task);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function copyLink() {
    const url = new URL(`/tasks?task=${encodeURIComponent(current.id)}`, window.location.origin)
      .href;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Link copied.");
    } catch {
      // No clipboard (an insecure context, a denied permission): show it to copy by hand.
      setNotice(`Copy this link: ${url}`);
    }
  }

  const blurField = () => {
    session.setFocus(null);
    void session.flush();
  };
  const focusField = (field: keyof TaskDraft) => () => session.setFocus(field);
  const fieldError = (group: FieldGroup) =>
    errors[group]?.shown ? errors[group]!.message : null;

  const zone = draft.timeZone.trim() || timeZone || viewerTimeZone();

  const statusEntries: MenuEntry[] = STATUS_ORDER.map((status) => ({
    kind: "item",
    id: `status-${status}`,
    label: STATUS_LABELS[status],
    checked: status === draft.status,
    // The server owns the transition rules; the menu only steers away from moves it will refuse.
    disabled: status !== current.status && !canMove(current.status, status),
    onSelect: () => {
      if (status !== draft.status) edit({ status }, "now");
    },
  }));

  const priorityEntries: MenuEntry[] = PRIORITY_MENU.map((priority) => ({
    kind: "item",
    id: `priority-${priority}`,
    label: priority === "none" ? "No priority" : sentenceCase(priority),
    icon: "flag",
    checked: priority === draft.priority,
    onSelect: () => {
      if (priority !== draft.priority) edit({ priority }, "now");
    },
  }));

  const filable = projects.filter(
    (project) => project.status !== "archived" || project.id === current.project_id,
  );
  const projectEntries: MenuEntry[] = [
    {
      kind: "item",
      id: "project-none",
      label: "No project",
      checked: draft.projectId === "",
      onSelect: () => {
        if (draft.projectId !== "") edit({ projectId: "" }, "now");
      },
    },
    ...filable.map(
      (project): MenuEntry => ({
        kind: "item",
        id: `project-${project.id}`,
        label: project.status === "archived" ? `${project.name} (archived)` : project.name,
        checked: project.id === draft.projectId,
        onSelect: () => {
          if (project.id !== draft.projectId) edit({ projectId: project.id }, "now");
        },
      }),
    ),
  ];
  const project = projects.find((p) => p.id === draft.projectId);

  const optionEntries: MenuEntry[] = [
    { kind: "item", id: "copy-link", label: "Copy link", icon: "link", onSelect: () => void copyLink() },
    { kind: "separator", id: "sep" },
    {
      kind: "item",
      id: "delete",
      label: "Delete task",
      icon: "trash-2",
      danger: true,
      onSelect: () => void guard(() => void remove(), "Discard and delete"),
    },
  ];

  const unsavedNames = snapshot.unsaved.map((group) => GROUP_LABELS[group]).join(", ");
  const modal = !docked;

  return (
    <>
      {modal ? <div className="task-detail-scrim" aria-hidden="true" onClick={requestClose} /> : null}
      <div
        ref={panel}
        className={`task-detail${docked ? " is-docked" : " is-overlay"}`}
        role="dialog"
        aria-label="Task details"
        aria-modal={modal ? true : undefined}
        onKeyDown={onPanelKeyDown}
      >
        <div className="task-detail-header">
          {/* Keeps the heading order for the sections below (Subtasks, Reminder, …). */}
          <h2 className="sr-only">Task details</h2>
          <SaveIndicator state={snapshot.state} />
          <div className="task-detail-header-actions">
            <button
              ref={optionsButton}
              type="button"
              className="ghost icon-button"
              aria-label="Task options"
              aria-haspopup="menu"
              aria-expanded={optionsOpen}
              aria-controls={optionsOpen ? `${ids}-options` : undefined}
              onClick={() => setOptionsOpen((open) => !open)}
            >
              <Icon name="ellipsis" />
            </button>
            <button type="button" className="ghost icon-button" aria-label="Close" onClick={requestClose}>
              <Icon name="x" />
            </button>
          </div>
          {optionsOpen && optionsButton.current ? (
            <Menu
              id={`${ids}-options`}
              label="Task options"
              anchor={optionsButton.current}
              entries={optionEntries}
              onClose={() => setOptionsOpen(false)}
            />
          ) : null}
        </div>

        <div className="task-detail-notices">
          {snapshot.conflict ? (
            <div className="task-notice tone-danger" role="alert">
              <p>
                This task was changed somewhere else since you opened it. Your edits were not
                saved{unsavedNames ? ` (${unsavedNames})` : ""}.
              </p>
              <button type="button" onClick={() => void loadLatest()} disabled={loading}>
                Load latest version
              </button>
            </div>
          ) : null}
          {snapshot.stash ? (
            <div className="task-notice" role="status" aria-live="polite">
              <p>
                Showing the latest version. Your unsaved changes were set aside:{" "}
                {Object.keys(snapshot.stash)
                  .map((field) => describeStash(field as keyof TaskDraft, snapshot.stash!))
                  .join("; ")}
                .
              </p>
              <div className="task-notice-actions">
                <button type="button" onClick={() => session.reapply()}>
                  Reapply my changes
                </button>
                <button type="button" className="ghost" onClick={() => session.dismissStash()}>
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          {snapshot.state === "failed" ? (
            <div className="task-notice tone-danger" role="alert">
              <p>Couldn’t save: {snapshot.failure}. Your changes are kept here.</p>
              <button type="button" onClick={() => void session.retry()}>
                Retry
              </button>
            </div>
          ) : null}
          {snapshot.state === "offline" ? (
            <div className="task-notice tone-warning">
              <p>
                You’re offline. Your changes are kept in this panel and saved when the connection
                is back.
              </p>
            </div>
          ) : null}
          {leaving ? (
            <div className="task-notice tone-warning" role="alert">
              <p>Some changes are not saved yet{unsavedNames ? `: ${unsavedNames}` : ""}.</p>
              <div className="task-notice-actions">
                <button type="button" onClick={() => setLeaving(null)}>
                  Keep editing
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => {
                    const run = leaving.run;
                    setLeaving(null);
                    session.discard();
                    run();
                  }}
                >
                  {leaving.confirm}
                </button>
              </div>
            </div>
          ) : null}
          {error ? (
            <p className="task-notice tone-danger" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="task-notice" aria-live="polite">
              {notice}
            </p>
          ) : null}
        </div>

        <div className="task-detail-body">
          {current.parent_task_id && onOpenTask ? (
            <button
              type="button"
              className="ghost task-detail-parent"
              onClick={() =>
                void guard(() => {
                  void tasksApi
                    .get(current.parent_task_id!)
                    .then(onOpenTask)
                    .catch((err: unknown) => setError(errorMessage(err)));
                })
              }
            >
              <Icon name="corner-down-right" size={14} />
              Open parent task
            </button>
          ) : null}

          <AutoGrowTextarea
            className="task-detail-title"
            aria-label="Title"
            placeholder="Untitled"
            value={draft.title}
            onFocus={focusField("title")}
            onBlur={blurField}
            onChange={(event) =>
              edit({ title: event.target.value.replace(/[\r\n]+/g, " ") }, "debounce")
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // A title is one line: Enter saves now instead of adding a line break.
                event.preventDefault();
                void session.flush();
              }
            }}
            textareaRef={titleRef}
          />
          {fieldError("title") ? (
            <p className="task-prop-error" role="alert">
              {fieldError("title")}
            </p>
          ) : null}

          <div className="task-props">
            <MenuProperty
              icon="square-kanban"
              label="Status"
              value={STATUS_LABELS[draft.status] ?? draft.status}
              entries={statusEntries}
              error={fieldError("status")}
            />
            <MenuProperty
              icon="flag"
              label="Priority"
              value={
                draft.priority === "none" ? (
                  "Empty"
                ) : (
                  <span className={`task-prop-priority priority-${draft.priority}`}>
                    <Icon name="flag" size={14} />
                    {sentenceCase(draft.priority)}
                  </span>
                )
              }
              empty={draft.priority === "none"}
              entries={priorityEntries}
              error={fieldError("priority")}
            />
            <PropertyRow
              icon="calendar-days"
              label="Due"
              labelId={`${ids}-due`}
              error={fieldError("schedule")}
            >
              <input
                type="date"
                className={`task-prop-input${draft.dueDate ? "" : " is-empty"}`}
                aria-label="Due date"
                value={draft.dueDate}
                onFocus={focusField("dueDate")}
                onBlur={blurField}
                onChange={(event) =>
                  edit(
                    event.target.value
                      ? { dueDate: event.target.value }
                      : { dueDate: "", dueTime: "" },
                    "debounce",
                  )
                }
              />
              {draft.dueDate ? (
                <>
                  <input
                    type="time"
                    className={`task-prop-input task-prop-time${draft.dueTime ? "" : " is-empty"}`}
                    aria-label="Due time"
                    title="Leave empty for the end of the day"
                    value={draft.dueTime}
                    onFocus={focusField("dueTime")}
                    onBlur={blurField}
                    onChange={(event) => edit({ dueTime: event.target.value }, "debounce")}
                  />
                  <button
                    type="button"
                    className="ghost icon-button task-prop-clear"
                    aria-label="Clear due date"
                    onClick={() => edit({ dueDate: "", dueTime: "" }, "now")}
                  >
                    <Icon name="x" size={14} />
                  </button>
                </>
              ) : null}
            </PropertyRow>
            <PropertyRow icon="clock" label="Start" labelId={`${ids}-start`}>
              <input
                type="datetime-local"
                className={`task-prop-input${draft.start ? "" : " is-empty"}`}
                aria-label="Start"
                value={draft.start}
                onFocus={focusField("start")}
                onBlur={blurField}
                onChange={(event) => edit({ start: event.target.value }, "debounce")}
              />
              {draft.start ? (
                <button
                  type="button"
                  className="ghost icon-button task-prop-clear"
                  aria-label="Clear start"
                  onClick={() => edit({ start: "" }, "now")}
                >
                  <Icon name="x" size={14} />
                </button>
              ) : null}
            </PropertyRow>
            <TimeZoneProperty
              value={draft.timeZone}
              viewerZone={timeZone ?? viewerTimeZone()}
              onChoose={(value) => edit({ timeZone: value }, "now")}
            />
            <MenuProperty
              icon="folder-kanban"
              label="Project"
              value={project ? project.name : "Empty"}
              empty={!project}
              entries={projectEntries}
              error={fieldError("project")}
            />
            <TagsProperty
              value={draft.tags}
              onChange={(tags) => edit({ tags }, "now")}
              error={fieldError("tags")}
            />
          </div>

          <AutoGrowTextarea
            className="task-detail-description"
            aria-label="Description"
            placeholder="Add a description…"
            value={draft.description}
            onFocus={focusField("description")}
            onBlur={blurField}
            onChange={(event) => edit({ description: event.target.value }, "debounce")}
          />
          {fieldError("description") ? (
            <p className="task-prop-error" role="alert">
              {fieldError("description")}
            </p>
          ) : null}

          {completion ? (
            <div className="task-notice" role="status">
              {completion.next ? (
                <>
                  <p>
                    Completed. Next occurrence:{" "}
                    {formatDue(
                      (completion.next.due_at ?? completion.next.start_at)!,
                      completion.next.time_zone ?? timeZone,
                    )}
                  </p>
                  {onOpenTask ? (
                    <button
                      type="button"
                      onClick={() => void guard(() => onOpenTask(completion.next!))}
                    >
                      Open next occurrence
                    </button>
                  ) : null}
                </>
              ) : completion.checked ? (
                <p>Completed. This was the last occurrence of the series.</p>
              ) : (
                <p>Completed. The next occurrence has been created.</p>
              )}
            </div>
          ) : null}

          <div className="task-detail-sections">
            <TaskRepeat
              value={draft.recurrenceRule}
              onChange={(rule, mode) => edit({ recurrenceRule: rule }, mode)}
              onCommit={() => void session.flush()}
              anchor={recurrenceAnchor(draft)}
              timeZone={zone}
              readOnly={current.recurrence_parent_id !== null}
              error={fieldError("repeat")}
            />
            <TaskSubtasks
              parent={current}
              openDisabled={!onOpenTask}
              onOpen={(sub) => void guard(() => onOpenTask?.(sub))}
              onChanged={() => onRefresh?.()}
            />
            <TaskReminder taskId={current.id} />
            <TaskNotes
              taskId={current.id}
              openDisabled={!onOpenNote}
              onOpen={(noteId) => void guard(() => onOpenNote?.(noteId))}
            />
          </div>
        </div>
      </div>
    </>
  );
}

const STASH_LABELS: Partial<Record<keyof TaskDraft, string>> = {
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  dueDate: "due date",
  dueTime: "due time",
  timeZone: "time zone",
  start: "start",
  tags: "tags",
  projectId: "project",
  recurrenceRule: "repeat",
};

function describeStash(field: keyof TaskDraft, stash: Partial<TaskDraft>): string {
  const value = stash[field] ?? "";
  const shown =
    field === "status"
      ? STATUS_LABELS[value as TaskStatus] ?? value
      : field === "projectId"
        ? value
          ? "another project"
          : "no project"
        : value === ""
          ? "empty"
          : `“${value.length > 40 ? `${value.slice(0, 40)}…` : value}”`;
  return `${STASH_LABELS[field] ?? field} ${shown}`;
}
