import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";

import type { Project, Task, TaskStatus } from "../api/client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useParentTitles } from "../hooks/useParentTitles";
import { activeProjects, useProjects } from "../hooks/useProjects";
import type { TaskActions } from "../hooks/useTaskActions";
import { PHONE_QUERY, SHEET_QUERY } from "../lib/phone";
import { isTypingTarget } from "../lib/shortcuts";
import { STATUS_LABELS, adjacentStatus, canMove, type BoardColumn } from "../lib/taskStatus";
import { Icon } from "./Icon";
import { Tabs, panelId, tabId } from "./Tabs";
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
}

const HELP =
  "Drag a task between columns, use “Move to…” in its menu, or press ] and [ on a focused card, to change its status. Only the transitions Atlas allows are offered, and a rejected move is reported here.";
const TOUCH_HELP =
  "Pick a column above. Use “Move to…” in a card’s menu to change its status. Only the transitions Atlas allows are offered, and a rejected move is reported here.";

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
}: BoardProps) {
  // Phone (UX-11): one full-width column at a time, chosen from a tab strip with counts.
  const phone = useMediaQuery(PHONE_QUERY, false);
  // Touch and phone: the help is behind a "?" button and says nothing about keys.
  const touch = useMediaQuery(SHEET_QUERY, false);
  const [activeStatus, setActiveStatus] = useState<TaskStatus>("inbox");
  const [helpOpen, setHelpOpen] = useState(false);
  const helpId = useId();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ task: Task; anchor: HTMLElement } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [notice, setNotice] = useState("");
  // After a move the card is re-created in its new column: a keyboard move focuses it again there
  // (`focus`), any move announces it.
  const refocus = useRef<{ id: string; status: string; until: number; focus: boolean } | null>(null);
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
  // The Archived tab disappears with its toggle: fall back to the first column.
  const current = visible.some((column) => column.status === activeStatus)
    ? activeStatus
    : (visible[0]?.status ?? "inbox");
  const shownColumns = phone ? visible.filter((column) => column.status === current) : visible;

  useLayoutEffect(() => {
    const pending = refocus.current;
    if (!pending) return;
    const task = tasksById.get(pending.id);
    if (Date.now() > pending.until) {
      refocus.current = null;
    } else if (task && task.status === pending.status) {
      refocus.current = null;
      if (pending.focus) {
        document
          .querySelector<HTMLElement>(`[data-task-id="${CSS.escape(pending.id)}"] .board-card-title`)
          ?.focus();
      }
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
    refocus.current = { id: task.id, status: target, until: Date.now() + 5000, focus: true };
    // One column is shown on a phone: follow the card so it keeps focus there.
    if (phone) setActiveStatus(target);
    onMove(task, target);
  }

  /** A move chosen in a card's menu: announced once the server has confirmed it. */
  function moveFromMenu(task: Task, status: TaskStatus) {
    refocus.current = { id: task.id, status, until: Date.now() + 5000, focus: false };
    onMove(task, status);
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
          Nothing on the board yet — capture a task and it will appear in Inbox.
        </p>
      ) : null}
      {archivedToggle || touch ? (
        <div className="board-toolbar">
          {touch ? (
            <button
              type="button"
              className="ghost board-help-button"
              aria-label="About the board"
              aria-expanded={helpOpen}
              aria-controls={helpId}
              onClick={() => setHelpOpen((open) => !open)}
            >
              ?
            </button>
          ) : null}
          {archivedToggle ? (
            <button
              type="button"
              className="ghost"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((open) => !open)}
            >
              {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
            </button>
          ) : null}
        </div>
      ) : null}
      {touch ? (
        helpOpen ? (
          <p id={helpId} className="muted board-help">
            {TOUCH_HELP}
          </p>
        ) : null
      ) : (
        <p className="muted board-help">{HELP}</p>
      )}
      {phone ? (
        <Tabs
          label="Board columns"
          className="board-tabs"
          idPrefix="board"
          value={current}
          onChange={setActiveStatus}
          tabs={visible.map((column) => ({
            id: column.status,
            label: column.label,
            count: (tasksByStatus[column.status] ?? []).length,
          }))}
        />
      ) : null}
      <div className="sr-only" aria-live="polite">
        {notice}
      </div>
      <div
        className="board-columns"
        style={{ "--board-cols": shownColumns.length } as CSSProperties}
      >
        {shownColumns.map((column) => {
          const columnTasks = tasksByStatus[column.status] ?? [];
          return (
            <section
              key={column.status}
              className={`board-column${overStatus === column.status ? " drop-target" : ""}`}
              {...(phone
                ? { role: "tabpanel", id: panelId("board", column.status), "aria-labelledby": tabId("board", column.status) }
                : { "aria-labelledby": `board-col-${column.status}` })}
              onDragOver={(event) => onDragOver(event, column)}
              onDrop={(event) => onDrop(event, column)}
            >
              <header className={`board-column-header${phone ? " sr-only" : ""}`}>
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
          onMove={moveFromMenu}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  );
}
