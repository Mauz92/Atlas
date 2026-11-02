import { useId } from "react";

import type { Project, Task } from "../api/client";

interface InboxActionsProps {
  task: Task;
  /** Projects a task can be filed to; the "File" control is omitted when there are none. */
  projects: Project[];
  disabled?: boolean;
  onSchedule: (
    task: Task,
    when: "today" | "tomorrow" | { date: string },
  ) => void;
  onFile: (task: Task, projectId: string) => void;
  onDelete: (task: Task) => void;
}

/**
 * The Inbox triage controls on one row (MU-01, journey J2): schedule (today / tomorrow / a date),
 * file to a project, or delete. Each is a single control, so a task is triaged in one or two
 * keyboard interactions. The component only reports the choice; the page calls the API.
 */
export function InboxActions({
  task,
  projects,
  disabled,
  onSchedule,
  onFile,
  onDelete,
}: InboxActionsProps) {
  const dateId = useId();
  return (
    <span className="inbox-actions">
      <button
        type="button"
        className="ghost"
        disabled={disabled}
        aria-label={`Schedule ${task.title} for today`}
        onClick={() => onSchedule(task, "today")}
      >
        Today
      </button>
      <button
        type="button"
        className="ghost"
        disabled={disabled}
        aria-label={`Schedule ${task.title} for tomorrow`}
        onClick={() => onSchedule(task, "tomorrow")}
      >
        Tomorrow
      </button>
      <input
        id={dateId}
        type="date"
        disabled={disabled}
        aria-label={`Pick a date for ${task.title}`}
        value=""
        onChange={(event) => {
          if (event.target.value) {
            onSchedule(task, { date: event.target.value });
          }
        }}
      />
      {projects.length > 0 ? (
        <select
          disabled={disabled}
          aria-label={`File ${task.title} to a project`}
          value=""
          onChange={(event) => {
            if (event.target.value) {
              onFile(task, event.target.value);
            }
          }}
        >
          <option value="">File to…</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      ) : null}
      <button
        type="button"
        className="ghost danger"
        disabled={disabled}
        aria-label={`Delete ${task.title}`}
        onClick={() => onDelete(task)}
      >
        Delete
      </button>
    </span>
  );
}
