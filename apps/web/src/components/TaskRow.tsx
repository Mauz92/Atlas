import { useCallback, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";

import type { Project, Task } from "../api/client";
import type { TaskActions } from "../hooks/useTaskActions";
import { moveRowFocus } from "../lib/listKeys";
import { dueChip } from "../lib/dueChip";
import { projectHue } from "../lib/projectColor";
import { isTypingTarget } from "../lib/shortcuts";
import { STATUS_LABELS } from "../lib/taskStatus";
import { sentenceCase } from "../lib/tasks";
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
  /** Board cards (UX-07): project dot, due and a priority flag only. */
  compact?: boolean;
  /**
   * The calendar day (`YYYY-MM-DD`, viewer's zone) of the day group the row sits in (Upcoming,
   * Week, Today). A due on that day drops its date and shows the time only (UX-09).
   */
  day?: string;
}

/** Tags shown in a row; the rest are "+n" (the task panel lists them all). */
const MAX_ROW_TAGS = 2;

interface MetaParts {
  /** Line 2: due chip, priority, subtask count. */
  when: ReactNode[];
  /** Line 3: parent or project, tags (and the status in search results). */
  context: ReactNode[];
}

function metaParts({ task, timeZone, project, parentTitle, showStatus, compact, day }: TaskMetaProps): MetaParts {
  const total = task.subtasks_total ?? 0;
  const chip = dueChip(task, timeZone, day);
  const tags = compact ? [] : task.tags ?? [];
  const due = chip ? (
    <span key="due" className={`task-due due-${chip.kind}${chip.kind === "overdue" ? " is-overdue" : ""}`}>
      {chip.kind === "overdue" ? <Icon name="triangle-alert" size={14} /> : null}
      {chip.kind === "today" ? <Icon name="sun" size={14} /> : null}
      {chip.kind === "later" ? <Icon name="calendar-days" size={14} /> : null}
      <span className="task-due-text">
        {chip.kind === "overdue" ? "Overdue" : chip.kind === "today" ? "Today" : null}
        {chip.kind !== "later" && chip.text ? <span aria-hidden="true"> · </span> : null}
        {chip.kind !== "later" && chip.text ? " " : null}
        {chip.text}
      </span>
    </span>
  ) : null;
  const when = [
    due,
    task.priority !== "none" ? (
      <span key="priority" className={`task-priority priority-${task.priority}`}>
        <Icon name="flag" size={14} />
        {compact ? (
          <span className="sr-only">{sentenceCase(task.priority)} priority</span>
        ) : (
          <span className="priority-word">{sentenceCase(task.priority)}</span>
        )}
      </span>
    ) : null,
    total > 0 && !compact ? (
      <span key="subtasks" className="task-subtasks">
        <Icon name="list-checks" size={14} />
        {task.subtasks_done ?? 0}/{total}
        <span className="sr-only"> subtasks</span>
      </span>
    ) : null,
  ];
  const context = [
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
        <span className={`project-dot project-c${projectHue(project.id)}`} aria-hidden="true" />
        <span className="task-project-name">{project.name}</span>
      </span>
    ) : null,
    ...tags.slice(0, MAX_ROW_TAGS).map((tag) => (
      <span key={`tag-${tag}`} className="task-tag">
        {tag}
      </span>
    )),
    tags.length > MAX_ROW_TAGS ? (
      <span key="tags-more" className="task-tag-more">
        +{tags.length - MAX_ROW_TAGS}
        <span className="sr-only"> more tags</span>
      </span>
    ) : null,
    showStatus ? (
      <span key="status" className="task-status">
        {STATUS_LABELS[task.status as keyof typeof STATUS_LABELS] ?? task.status}
      </span>
    ) : null,
  ];
  return { when: when.filter(Boolean), context: context.filter(Boolean) };
}

/** How many lines the meta takes on a phone (0, 1 or 2); the title gets the rest of the three. */
function metaLineCount(props: TaskMetaProps): number {
  if (props.compact) return 1;
  const { when, context } = metaParts(props);
  return (when.length > 0 ? 1 : 0) + (context.length > 0 ? 1 : 0);
}

/**
 * The muted meta of a task (UX-03, UX-09, ADR-0062), shared by list rows and board cards. Two
 * groups: *when* (due chip with icon + word, priority flag, subtask count) and *what* (parent or
 * project dot + name, at most two tags). On a phone they are lines 2 and 3 of the row; on desktop
 * one line with the due and priority in fixed columns. Due state, priority and project are never
 * conveyed by colour alone: each has an icon or a word.
 */
export function TaskMeta(props: TaskMetaProps) {
  const { when, context } = metaParts(props);
  if (when.length + context.length === 0) return null;
  if (props.compact) {
    return <span className="task-meta is-compact">{[...context, ...when]}</span>;
  }
  return (
    <span className="task-meta">
      {when.length > 0 ? <span className="task-meta-when">{when}</span> : null}
      {context.length > 0 ? <span className="task-meta-context">{context}</span> : null}
    </span>
  );
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
  /** The day group the row sits in (`YYYY-MM-DD`); its date is then left out of the due chip. */
  day?: string;
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
  day,
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
      }${menu ? " has-menu" : ""}${
        task.priority === "urgent" || task.priority === "high" ? ` prio-${task.priority}` : ""
      }`}
      data-task-id={task.id}
      data-meta-lines={metaLineCount({ task, timeZone, project, parentTitle, showStatus, day })}
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
      {/* The whole body opens the task (UX-09): a click anywhere on the title or meta bubbles here;
          the button keeps the keyboard and screen-reader path (Enter or Space click it). */}
      <div
        className={`task-body${onOpen ? " is-openable" : ""}`}
        onClick={onOpen ? () => onOpen(task) : undefined}
      >
        {onOpen ? (
          <button
            type="button"
            className="task-title task-open"
            aria-label={`Open ${task.title}`}
            data-row-focus
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
          day={day}
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
