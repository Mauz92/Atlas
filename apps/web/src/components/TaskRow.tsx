import { useCallback, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import type { Project, Task } from "../api/client";
import type { TaskActions } from "../hooks/useTaskActions";
import { moveRowFocus } from "../lib/listKeys";
import { isTypingTarget } from "../lib/shortcuts";
import { STATUS_LABELS } from "../lib/taskStatus";
import { formatDue, sentenceCase } from "../lib/tasks";
import { Icon } from "./Icon";
import { TaskMenu, type TaskMenuVariant } from "./TaskMenu";

/** The fields a row shows. Search results carry only these; list views pass full tasks. */
export type RowTask = Pick<Task, "id" | "title" | "status" | "priority" | "due_at" | "project_id"> &
  Partial<Omit<Task, "id" | "title" | "status" | "priority" | "due_at" | "project_id">>;

interface TaskMetaProps {
  task: RowTask;
  timeZone?: string;
  project?: Project;
  parentTitle?: string;
  /** Show the status as text (search results, which mix every status). */
  showStatus?: boolean;
}

/**
 * The muted meta line of a task (UX-03): parent (for a subtask), project, due (warning colour when
 * overdue, the shared `formatDue` format), priority flag, subtask progress, tags. Shared by list
 * rows and board cards.
 */
export function TaskMeta({ task, timeZone, project, parentTitle, showStatus }: TaskMetaProps) {
  const total = task.subtasks_total ?? 0;
  const parts = [
    parentTitle ? (
      <span key="parent" className="task-parent" title={`Subtask of ${parentTitle}`}>
        <Icon name="corner-down-right" size={12} />
        <span className="task-parent-title">
          <span className="sr-only">Subtask of </span>
          {parentTitle}
        </span>
      </span>
    ) : null,
    project ? (
      <span key="project" className="task-project project-tag">
        {project.name}
      </span>
    ) : null,
    task.due_at ? (
      <span
        key="due"
        className={`task-due${task.due_state === "overdue" && task.status !== "completed" ? " is-overdue" : ""}`}
      >
        {task.due_state === "overdue" && task.status !== "completed" ? (
          <span className="sr-only">Overdue, due </span>
        ) : null}
        {formatDue(task.due_at, task.time_zone ?? timeZone)}
      </span>
    ) : null,
    task.priority !== "none" ? (
      <span key="priority" className={`task-priority priority-${task.priority}`}>
        <Icon name="flag" size={12} />
        {sentenceCase(task.priority)}
      </span>
    ) : null,
    total > 0 ? (
      <span key="subtasks" className="task-subtasks">
        <Icon name="list-checks" size={12} />
        {task.subtasks_done ?? 0}/{total}
        <span className="sr-only"> subtasks</span>
      </span>
    ) : null,
    ...(task.tags ?? []).map((tag) => (
      <span key={`tag-${tag}`} className="task-tag">
        {tag}
      </span>
    )),
    showStatus ? (
      <span key="status" className="task-status">
        {STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] ?? task.status}
      </span>
    ) : null,
  ].filter(Boolean);
  return parts.length > 0 ? <span className="task-meta">{parts}</span> : null;
}

export interface RowSelection {
  selected: boolean;
  onToggle: () => void;
}

interface TaskRowProps<T extends RowTask> {
  task: T;
  timeZone?: string;
  project?: Project;
  parentTitle?: string;
  /** Quick actions, completion and the "…" menu; given only with full tasks. */
  actions?: T extends Task ? TaskActions : never;
  /** Projects a task can be filed under (the menu's project picker). */
  projects?: Project[];
  onOpen?: (task: T) => void;
  /** Bulk selection (Tasks page, ADR-0052): a square checkbox before the round one. */
  selection?: RowSelection;
  showStatus?: boolean;
  menuVariant?: TaskMenuVariant;
}

type OpenMenu = { anchor: HTMLElement; path: string[] };

/**
 * One task row (UX-03, ADR-0052), used by every task list: a round completion checkbox, the
 * title (opens the detail panel), a muted meta line, quick actions revealed on hover or focus and
 * a "…" menu. Keys while focus is in the row (outside a text field): `j`/`k` next/previous row,
 * `x` complete/reopen (or select, on the Tasks page), `t` schedule for today, `m` project menu,
 * `p` priority menu, Enter opens.
 */
export function TaskRow<T extends RowTask>({
  task,
  timeZone,
  project,
  parentTitle,
  actions,
  projects = [],
  onOpen,
  selection,
  showStatus,
  menuVariant = "list",
}: TaskRowProps<T>) {
  const row = useRef<HTMLLIElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const full = task as unknown as Task;
  const done = task.status === "completed";
  const archived = task.status === "archived";
  const busy = actions?.busy.has(task.id) ?? false;
  const canFile = !task.parent_task_id && projects.length > 0;

  const openMenu = useCallback((anchor: HTMLElement | null, path: string[] = []) => {
    if (anchor) setMenu({ anchor, path });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  function toggleMenu(anchor: HTMLElement, path: string[] = []) {
    if (menu?.anchor === anchor) {
      setMenu(null);
    } else {
      openMenu(anchor, path);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLLIElement>) {
    const target = event.target as HTMLElement;
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isTypingTarget(target) ||
      // Keys from the menu (a portal) bubble through React; only the row's own controls count.
      !row.current?.contains(target)
    ) {
      return;
    }
    const key = event.key;
    const handled = () => event.preventDefault();
    if (key === "j" || key === "k") {
      handled();
      moveRowFocus(target, key === "j" ? 1 : -1);
    } else if (key === "Enter" && onOpen && target.tagName === "INPUT") {
      handled();
      onOpen(task);
    } else if (!actions) {
      return;
    } else if (key === "x") {
      handled();
      if (selection) selection.onToggle();
      else if (!archived) void actions.toggleComplete(full);
    } else if (key === "t") {
      handled();
      void actions.schedule(full, "today");
    } else if (key === "m" && canFile) {
      handled();
      openMenu(more.current, ["project"]);
    } else if (key === "p") {
      handled();
      openMenu(more.current, ["priority"]);
    }
  }

  const quick = (
    label: string,
    icon: Parameters<typeof Icon>[0]["name"],
    onClick: (button: HTMLButtonElement) => void,
    popup?: "menu" | "dialog",
  ) => (
    <button
      type="button"
      className="icon-button ghost"
      aria-label={label}
      title={label}
      aria-haspopup={popup}
      aria-expanded={popup ? Boolean(menu && menu.anchor.getAttribute("aria-label") === label) : undefined}
      disabled={busy}
      onClick={(event) => onClick(event.currentTarget)}
    >
      <Icon name={icon} />
    </button>
  );

  return (
    <li
      ref={row}
      className={`task-item task-row${done ? " is-done" : ""}${archived ? " is-archived" : ""}${
        selection?.selected ? " is-selected" : ""
      }${menu ? " has-menu" : ""}`}
      data-task-id={task.id}
      onKeyDown={onKeyDown}
    >
      {selection ? (
        <input
          type="checkbox"
          className="task-select"
          aria-label={`Select ${task.title}`}
          checked={selection.selected}
          onChange={selection.onToggle}
        />
      ) : null}
      {actions ? (
        <input
          type="checkbox"
          className="task-check"
          aria-label={`Complete ${task.title}`}
          title={archived ? "Archived" : done ? "Reopen" : "Complete"}
          checked={optimistic ?? done}
          disabled={archived || busy}
          onChange={async () => {
            if (archived) return;
            // Tick at once; the server's answer (or the refreshed row) then takes over.
            setOptimistic(!done);
            await actions.toggleComplete(full);
            setOptimistic(null);
          }}
        />
      ) : null}
      <div className="task-body">
        {onOpen ? (
          <button
            type="button"
            className="task-title task-open"
            aria-label={`Open ${task.title}`}
            data-row-focus
            onClick={() => onOpen(task)}
          >
            {task.title}
          </button>
        ) : (
          <span className="task-title">{task.title}</span>
        )}
        <TaskMeta
          task={task}
          timeZone={timeZone}
          project={project}
          parentTitle={parentTitle}
          showStatus={showStatus}
        />
      </div>
      {actions ? (
        <>
          <div className="task-row-actions">
            {!done && !archived && task.due_state !== "today"
              ? quick(`Schedule ${task.title} for today`, "sun", () => void actions.schedule(full, "today"))
              : null}
            {quick(
              `Pick a date for ${task.title}`,
              "calendar-days",
              (button) => toggleMenu(button, ["date"]),
              "dialog",
            )}
            {canFile
              ? quick(
                  `Move ${task.title} to a project`,
                  "folder-input",
                  (button) => toggleMenu(button, ["project"]),
                  "menu",
                )
              : null}
          </div>
          <button
            ref={more}
            type="button"
            className="icon-button ghost task-more"
            aria-label={`Actions for ${task.title}`}
            title="More actions"
            aria-haspopup="menu"
            aria-expanded={Boolean(menu && menu.anchor === more.current)}
            aria-controls={menu ? menuId : undefined}
            onClick={(event) => toggleMenu(event.currentTarget)}
          >
            <Icon name="ellipsis" />
          </button>
        </>
      ) : null}
      {menu && actions ? (
        <TaskMenu
          id={menuId}
          anchor={menu.anchor}
          initialPath={menu.path}
          task={full}
          actions={actions}
          projects={projects}
          timeZone={timeZone}
          variant={menuVariant}
          onClose={closeMenu}
        />
      ) : null}
    </li>
  );
}
