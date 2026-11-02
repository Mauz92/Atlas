import { useMemo, useState } from "react";
import type { DragEvent } from "react";

import type { Task } from "../api/client";
import { STATUS_LABELS, STATUS_ORDER, canMove, type BoardColumn } from "../lib/taskStatus";
import { formatDue } from "../lib/tasks";

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
}

/**
 * A Kanban board whose columns are the task statuses (PRODUCT_SPEC §5.3, ADR-0022).
 *
 * Purely presentational: the page supplies the tasks and persists moves. A card can be dragged to
 * another column with native HTML5 drag-and-drop, and each card also carries a status `<select>`
 * for keyboard users. Both paths offer only the transitions the server allows (the select offers
 * every status but disables the forbidden ones); the server re-validates every move regardless.
 */
export function Board({
  columns,
  tasksByStatus,
  timeZone,
  onMove,
  onOpen,
  movingId,
  empty,
}: BoardProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStatus, setOverStatus] = useState<string | null>(null);

  const tasksById = useMemo(() => {
    const byId = new Map<string, Task>();
    for (const column of columns) {
      for (const task of tasksByStatus[column.status] ?? []) {
        byId.set(task.id, task);
      }
    }
    return byId;
  }, [columns, tasksByStatus]);

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
      <div className="board-columns">
        {columns.map((column) => {
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
                      className={`board-card${draggingId === task.id ? " dragging" : ""}`}
                      draggable
                      onDragStart={(event) => onDragStart(event, task)}
                      onDragEnd={onDragEnd}
                    >
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
                      {task.priority !== "none" || task.due_at ? (
                        <div className="board-card-meta">
                          {task.priority !== "none" ? (
                            <span className="badge">{task.priority}</span>
                          ) : null}
                          {task.due_at ? (
                            <span className="muted">{formatDue(task.due_at, task.time_zone ?? timeZone)}</span>
                          ) : null}
                        </div>
                      ) : null}
                      <select
                        className="board-move"
                        aria-label={`Move ${task.title}`}
                        value={task.status}
                        disabled={movingId === task.id}
                        onChange={(event) => onMove(task, event.target.value)}
                      >
                        {STATUS_ORDER.map((status) => (
                          <option
                            key={status}
                            value={status}
                            disabled={status !== task.status && !canMove(task.status, status)}
                          >
                            {STATUS_LABELS[status]}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
