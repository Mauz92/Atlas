import { useLayoutEffect, useMemo, useRef } from "react";

import type { Project, Task } from "../api/client";
import { useParentTitles } from "../hooks/useParentTitles";
import { activeProjects, useProjects } from "../hooks/useProjects";
import type { TaskActions } from "../hooks/useTaskActions";
import { focusRow } from "../lib/listKeys";
import { TaskRow } from "./TaskRow";

interface TaskListProps {
  tasks: Task[];
  /** The zone used to render due times (the viewer's, matching the server's classification). */
  timeZone?: string;
  /** Project lookup for the meta line; defaults to the shared project list. */
  projects?: Map<string, Project>;
  /** Row actions (completion, quick actions, "…" menu, list keys). Omitted = read-only rows. */
  actions?: TaskActions;
  /** Projects a task can be filed under; defaults to the active shared projects. */
  filable?: Project[];
  /** Open the task detail surface (Enter or click on the title). */
  onOpen?: (task: Task) => void;
  /** Bulk selection (Tasks page, MU-03): a square checkbox per row and `x` selects. */
  selection?: {
    isSelected: (id: string) => boolean;
    toggle: (task: Task) => void;
    /** Any row selected: the selection boxes stay visible. */
    active: boolean;
  };
  /** Shown in place of the list when it is empty; omitted means nothing is rendered. */
  emptyMessage?: string;
  /** Leave the project out of the meta line (a project's own page). */
  hideProject?: boolean;
  /** The day group these rows belong to (`YYYY-MM-DD`, viewer's zone): rows drop that date (UX-09). */
  day?: string;
}

/**
 * A list of task rows (UX-03). All data comes from the API; the rows only report choices.
 *
 * When the focused row leaves the list (completed, scheduled away, deleted), focus moves to the
 * row that took its place, so a keyboard user can keep triaging without starting over.
 */
export function TaskList({
  tasks,
  timeZone,
  projects,
  actions,
  filable,
  onOpen,
  selection,
  emptyMessage,
  hideProject,
  day,
}: TaskListProps) {
  const shared = useProjects().projects;
  const lookup = useMemo(
    () => projects ?? new Map(shared.map((project) => [project.id, project])),
    [projects, shared],
  );
  const choices = useMemo(() => filable ?? activeProjects(shared), [filable, shared]);
  const parents = useParentTitles(tasks);
  const list = useRef<HTMLUListElement>(null);
  const lastFocus = useRef<{ id: string; index: number } | null>(null);

  useLayoutEffect(() => {
    const last = lastFocus.current;
    if (!last || tasks.some((task) => task.id === last.id)) return;
    lastFocus.current = null;
    const active = document.activeElement;
    if (tasks.length > 0 && (!active || active === document.body)) {
      const rows = list.current?.querySelectorAll<HTMLElement>(".task-row");
      focusRow(rows?.[Math.min(last.index, tasks.length - 1)]);
    }
  }, [tasks]);

  if (tasks.length === 0) {
    return emptyMessage ? <p className="muted">{emptyMessage}</p> : null;
  }

  return (
    <ul
      ref={list}
      className={`task-list${selection?.active ? " is-selecting" : ""}`}
      onFocus={(event) => {
        const row = (event.target as HTMLElement).closest<HTMLElement>(".task-row");
        const id = row?.dataset.taskId;
        if (id) lastFocus.current = { id, index: tasks.findIndex((task) => task.id === id) };
      }}
      onBlur={(event) => {
        // Focus moving somewhere else on purpose ends the tracking; a menu of the row does not.
        const next = event.relatedTarget as HTMLElement | null;
        if (next && !list.current?.contains(next) && !next.closest('[role="menu"], [role="dialog"]')) {
          lastFocus.current = null;
        }
      }}
    >
      {tasks.map((task) => (
        <TaskRow
          key={task.id}
          task={task}
          timeZone={timeZone}
          project={task.project_id && !hideProject ? lookup.get(task.project_id) : undefined}
          parentTitle={task.parent_task_id ? parents.get(task.parent_task_id) : undefined}
          actions={actions}
          day={day}
          projects={choices}
          onOpen={onOpen}
          selection={
            selection
              ? {
                  selected: selection.isSelected(task.id),
                  onToggle: () => selection.toggle(task),
                }
              : undefined
          }
        />
      ))}
    </ul>
  );
}
