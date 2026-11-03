import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

import type { Project, Task, TaskStatus } from "../api/client";
import { useParentTitles } from "../hooks/useParentTitles";
import { activeProjects, useProjects } from "../hooks/useProjects";
import type { TaskActions } from "../hooks/useTaskActions";
import { isTypingTarget } from "../lib/shortcuts";
import { STATUS_LABELS, adjacentStatus, canMove, type BoardColumn } from "../lib/taskStatus";
import { Icon } from "./Icon";
import { TaskMenu } from "./TaskMenu";
import { TaskMeta } from "./TaskRow";

const labelOf = (status: string) => STATUS_LABELS[status as TaskStatus] ?? status;

interface BoardProps {
  /** The columns to render, in order (each carries its allowed move targets). */
  columns: BoardColumn[];
  /** Tasks grouped by status; every column key may be missing. */
  tasksByStatus: Record<string, Task[]>;
  /** The viewer's zone, used to render due times. */
  timeZone?: string;
  /** Persist a move (the page owns the API call). Called only for an allowed target. */
  onMove: (task: Task, toStatus: string) => void;
  /** The task whose move is in flight; its controls are disabled while it persists. */
  movingId?: string | null;
  /** Open the task detail surface (Enter or click on the card title). */
  onOpen?: (task: Task) => void;
  /** Show a board-level hint when there are no tasks at all. */
  empty?: boolean;
  /** Card menu actions besides "Move to…" (schedule, priority, project, delete). */
  actions?: TaskActions;
  /** Leave the project out of the card meta (a project's own board). */
  hideProject?: boolean;
  /** Keep the Archived column behind a "Show archived" toggle (UX-07). */
  archivedToggle?: boolean;
  /** Shown instead of the first-run hint when `empty` (a filtered board). */
  emptyMessage?: string;
}

/**
 * A Kanban board whose columns are the task statuses (PRODUCT_SPEC §5.3, ADR-0022).
 *
 * Purely presentational: the page supplies the tasks and persists moves. A card can be dragged to
 * another column with native HTML5 drag-and-drop, and each compact card (UX-03) has a "…" menu
 * whose "Move to…" offers the same moves to keyboard and touch users. Both paths offer only the
 * transitions the server allows; the server re-validates every move regardless.
 *
 * Keyboard (UX-07): with focus on a card, `]` moves it to the next column the state machine allows
 * and `[` to the previous one; focus follows the card and the move is announced politely.
 */
export function Board({
  columns,
  tasksByStatus,
  timeZone,
  onMove,
  onOpen,
  movingId,
  empty,
  actions,
  hideProject,
  archivedToggle,
  emptyMessage,
}: BoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ task: Task; anchor: HTMLElement } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState("");
  // After a keyboard move the card is re-created in its new column: focus it again there.
  const refocus = useRef<{ id: string; status: string; until: number } | null>(null);
  const menuId = useId();
  const { projects } = useProjects();
  const projectById = useMemo(
    () => new Map<string, Project>(projects.map((project) => [project.id, project])),
    [projects],
  );
  const filable = useMemo(() => activeProjects(projects), [projects]);

  const tasksById = useMemo(() => {
    const byId = new Map<string, Task>();
    for (const column of columns) {
      for (const task of tasksByStatus[column.status] ?? []) {
        byId.set(task.id, task);
      }
    }
    return byId;
  }, [columns, tasksByStatus]);

  const allTasks = useMemo(() => [...tasksById.values()], [tasksById]);
  const parents = useParentTitles(allTasks);

  const visible = useMemo(
    () => (archivedToggle && !showArchived ? columns.filter((c) => c.status !== "archived") : columns),
    [columns, archivedToggle, showArchived],
  );
  const archivedCount = tasksByStatus.archived?.length ?? 0;

  useLayoutEffect(() => {
    const pending = refocus.current;
    if (!pending) return;
    const task = tasksById.get(pending.id);
    if (Date.now() > pending.until) {
      refocus.current = null;
    } else if (task && task.status === pending.status) {
      refocus.current = null;
      document
        .querySelector<HTMLElement>(`[data-task-id="${CSS.escape(pending.id)}"] .board-card-title`)
        ?.focus();
      setNotice(`Moved ${task.title} to ${labelOf(task.status)}`);
    }
  }, [tasksById]);

  // The notice is for a screen reader; clear it so the same move announces again later.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function onCardKeyDown(event: ReactKeyboardEvent<HTMLLIElement>, task: Task) {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      (event.key !== "[" && event.key !== "]") ||
      isTypingTarget(event.target)
    ) {
      return;
    }
    event.preventDefault();
    const target = adjacentStatus(
      task.status,
      event.key === "]" ? 1 : -1,
      visible.map((column) => column.status),
    );
    if (!target) {
      setNotice(`${task.title} cannot move ${event.key === "]" ? "right" : "left"} from ${
        labelOf(task.status)
      }`);
      return;
    }
    refocus.current = { id: task.id, status: target, until: Date.now() + 5000 };
    onMove(task, target);
  }

  function taskFor(id: string | null): Task | undefined {
    return id ? tasksById.get(id) : undefined;
  }

  function onDragStart(event: DragEvent<HTMLLIElement>, task: Task) {
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.effectAllowed = "move";
    setDraggingId(task.id);
  }

  function onDragOver(event: DragEvent<HTMLElement>, column: BoardColumn) {
    const dragging = taskFor(draggingId);
    if (dragging && canMove(dragging.status, column.status)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setOverStatus(column.status);
    } else {
      event.dataTransfer.dropEffect = "none";
    }
  }

  function onDrop(event: DragEvent<HTMLElement>, column: BoardColumn) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/plain") || draggingId;
    const task = taskFor(id);
    setDraggingId(null);
    setOverStatus(null);
    if (task && canMove(task.status, column.status)) {
      onMove(task, column.status);
    }
  }

  function onDragEnd() {
    setDraggingId(null);
    setOverStatus(null);
  }

  return (
    <div className="board">
      {empty ? (
        <p className="muted board-hint">
          {emptyMessage ?? "Nothing on the board yet — capture a task and it will appear in Inbox."}
        </p>
      ) : null}
      {archivedToggle ? (
        <div className="board-toolbar">
          <button
            type="button"
            className="ghost"
            aria-pressed={showArchived}
            onClick={() => setShowArchived((open) => !open)}
          >
            {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
          </button>
        </div>
      ) : null}
      <div className="sr-only" aria-live="polite">
        {notice}
      </div>
      <div
        className="board-columns"
        style={{ "--board-cols": visible.length } as CSSProperties}
      >
        {visible.map((column) => {
          const columnTasks = tasksByStatus[column.status] ?? [];
          return (
            <section
              key={column.status}
              className={`board-column${overStatus === column.status ? " drop-target" : ""}`}
              aria-labelledby={`board-col-${column.status}`}
              onDragOver={(event) => onDragOver(event, column)}
              onDrop={(event) => onDrop(event, column)}
            >
              <header className="board-column-header">
                <h2 id={`board-col-${column.status}`}>{column.label}</h2>
                <span className="muted board-count">{columnTasks.length}</span>
              </header>
              {columnTasks.length === 0 ? (
                <p className="muted board-empty">No tasks</p>
              ) : (
                <ul className="board-cards">
                  {columnTasks.map((task) => (
                    <li
                      key={task.id}
                      className={`board-card${draggingId === task.id ? " dragging" : ""}${
                        task.status === "completed" ? " is-done" : ""
                      }`}
                      data-task-id={task.id}
                      draggable
                      onDragStart={(event) => onDragStart(event, task)}
                      onDragEnd={onDragEnd}
                      onKeyDown={(event) => onCardKeyDown(event, task)}
                    >
                      <div className="board-card-head">
                        {onOpen ? (
                          <button
                            type="button"
                            className="board-card-title task-open"
                            aria-label={`Open ${task.title}`}
                            onClick={() => onOpen(task)}
                          >
                            {task.title}
                          </button>
                        ) : (
                          <span className="board-card-title">{task.title}</span>
                        )}
                        <button
                          type="button"
                          className="icon-button ghost task-more"
                          aria-label={`Actions for ${task.title}`}
                          title="More actions"
                          aria-haspopup="menu"
                          aria-expanded={menu?.task.id === task.id}
                          aria-controls={menu?.task.id === task.id ? menuId : undefined}
                          disabled={movingId === task.id}
                          onClick={(event) => {
                            const anchor = event.currentTarget;
                            setMenu((open) => (open?.task.id === task.id ? null : { task, anchor }));
                          }}
                        >
                          <Icon name="ellipsis" />
                        </button>
                      </div>
                      <TaskMeta
                        task={task}
                        timeZone={timeZone}
                        compact
                        project={
                          task.project_id && !hideProject ? projectById.get(task.project_id) : undefined
                        }
                        parentTitle={task.parent_task_id ? parents.get(task.parent_task_id) : undefined}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
      {menu ? (
        <TaskMenu
          id={menuId}
          anchor={menu.anchor}
          task={menu.task}
          actions={actions}
          projects={filable}
          timeZone={timeZone}
          variant="board"
          onMove={(task: Task, status: TaskStatus) => onMove(task, status)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
