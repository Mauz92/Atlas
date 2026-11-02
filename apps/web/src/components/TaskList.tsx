import type { ReactNode } from "react";

import type { Project, Task } from "../api/client";
import { formatDue } from "../lib/tasks";

interface TaskListProps {
  tasks: Task[];
  /** The zone used to render due times (the viewer's, matching the server's classification). */
  timeZone?: string;
  /** Optional project lookup, so a filed task can name its project (planning views, M4-06). */
  projects?: Map<string, Project>;
  onComplete?: (task: Task) => void;
  /** Open the task detail surface (Enter or click on the title). */
  onOpen?: (task: Task) => void;
  /** A control at the start of each row, for example a selection checkbox (MU-03). */
  renderLead?: (task: Task) => ReactNode;
  /** Extra per-row controls, for example the Inbox triage actions. */
  renderActions?: (task: Task) => ReactNode;
  /** Shown in place of the list when it is empty; omitted means nothing is rendered. */
  emptyMessage?: string;
}

/** A presentational list of tasks. All data comes from the API; no date logic lives here. */
export function TaskList({
  tasks,
  timeZone,
  projects,
  onComplete,
  onOpen,
  renderLead,
  renderActions,
  emptyMessage,
}: TaskListProps) {
  if (tasks.length === 0) {
    return emptyMessage ? <p className="muted">{emptyMessage}</p> : null;
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => {
        const project = task.project_id
          ? projects?.get(task.project_id)
          : undefined;
        return (
          <li key={task.id} className="task-item">
            {renderLead ? renderLead(task) : null}
            {onOpen ? (
              <button
                type="button"
                className="task-title task-open"
                aria-label={`Open ${task.title}`}
                onClick={() => onOpen(task)}
              >
                {task.title}
              </button>
            ) : (
              <span className="task-title">{task.title}</span>
            )}
            {task.priority !== "none" ? (
              <span className="badge">{task.priority}</span>
            ) : null}
            {project ? (
              <span className="badge project-tag">{project.name}</span>
            ) : null}
            {task.subtasks_total > 0 ? (
              <span className="muted">
                {task.subtasks_done}/{task.subtasks_total} subtasks
              </span>
            ) : null}
            {(task.tags ?? []).map((tag) => (
              <span key={tag} className="badge tag">
                {tag}
              </span>
            ))}
            {task.due_at ? (
              <span className="muted">
                {formatDue(task.due_at, task.time_zone ?? timeZone)}
              </span>
            ) : null}
            {renderActions ? renderActions(task) : null}
            {onComplete ? (
              <button
                type="button"
                className="ghost"
                aria-label={`Complete ${task.title}`}
                onClick={() => onComplete(task)}
              >
                Complete
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
