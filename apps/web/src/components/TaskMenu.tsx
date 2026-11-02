import type { Project, Task, TaskPriority, TaskStatus } from "../api/client";
import type { TaskActions } from "../hooks/useTaskActions";
import { PRIORITIES, scheduleDate } from "../lib/taskForm";
import { STATUS_LABELS, allowedTargets, isStatus } from "../lib/taskStatus";
import { sentenceCase, wallClock } from "../lib/tasks";
import { Menu, type MenuCloseReason, type MenuEntry } from "./Menu";

/** Where a task menu is shown: a list row, or a board card (whose first entry is "Move to…"). */
export type TaskMenuVariant = "list" | "board";

export interface TaskMenuOptions {
  task: Task;
  /** Row actions; without them only the board's status moves are offered. */
  actions?: TaskActions;
  /** Projects a task can be filed under. */
  projects: Project[];
  timeZone?: string;
  variant?: TaskMenuVariant;
  /** The board's own move (it keeps the card in place on failure); defaults to the row action. */
  onMove?: (task: Task, status: TaskStatus) => void;
  now?: Date;
}

const PRIORITY_MENU: TaskPriority[] = [...PRIORITIES].reverse(); // urgent first, none last

function weekday(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, month - 1, day, 12)),
  );
}

/**
 * The entries of a task's menu (UX-03): schedule (Today, Tomorrow, Next week, a picked date, no
 * date), priority, project, status and delete. Statuses offered are the current one plus the
 * transitions the server allows (ADR-0013); a subtask has no project choice because it always
 * shares its parent's project (ADR-0016).
 */
// eslint-disable-next-line react-refresh/only-export-components
export function taskMenuEntries({
  task,
  actions,
  projects,
  timeZone,
  variant = "list",
  onMove,
  now = new Date(),
}: TaskMenuOptions): MenuEntry[] {
  const move = onMove ?? ((t: Task, status: TaskStatus) => void actions?.setStatus(t, status));
  const statuses: TaskStatus[] = isStatus(task.status)
    ? [task.status, ...allowedTargets(task.status)]
    : [];
  const status: MenuEntry = {
    kind: "submenu",
    id: "status",
    label: variant === "board" ? "Move to…" : "Status",
    icon: "square-kanban",
    hint: variant === "board" ? undefined : STATUS_LABELS[task.status as TaskStatus],
    entries: statuses.map((value) => ({
      kind: "item",
      id: `status-${value}`,
      label: STATUS_LABELS[value],
      checked: value === task.status,
      onSelect: () => {
        if (value !== task.status) move(task, value);
      },
    })),
  };
  if (!actions) {
    return [status];
  }

  const at = (when: "today" | "tomorrow" | "next-week") => scheduleDate(when, timeZone, now);
  const current = task.due_at ? wallClock(task.due_at, task.time_zone ?? timeZone).date : undefined;
  const project = projects.find((p) => p.id === task.project_id);
  const entries: MenuEntry[] = [];
  if (variant === "board") {
    entries.push(status, { kind: "separator", id: "sep-board" });
  }
  entries.push(
    {
      kind: "item",
      id: "today",
      label: "Today",
      icon: "sun",
      hint: weekday(at("today")),
      onSelect: () => void actions.schedule(task, "today"),
    },
    {
      kind: "item",
      id: "tomorrow",
      label: "Tomorrow",
      icon: "sunrise",
      hint: weekday(at("tomorrow")),
      onSelect: () => void actions.schedule(task, "tomorrow"),
    },
    {
      kind: "item",
      id: "next-week",
      label: "Next week",
      icon: "calendar-range",
      hint: weekday(at("next-week")),
      onSelect: () => void actions.schedule(task, "next-week"),
    },
    {
      kind: "date",
      id: "date",
      label: "Pick a date…",
      icon: "calendar-days",
      title: `Pick a date for ${task.title}`,
      fieldLabel: "Due date",
      value: current,
      onPick: (date) => void actions.schedule(task, { date }),
    },
  );
  if (task.due_at) {
    entries.push({
      kind: "item",
      id: "no-date",
      label: "No date",
      icon: "x",
      onSelect: () => void actions.schedule(task, null),
    });
  }
  entries.push(
    { kind: "separator", id: "sep-1" },
    {
      kind: "submenu",
      id: "priority",
      label: "Priority",
      icon: "flag",
      hint: task.priority !== "none" ? sentenceCase(task.priority) : undefined,
      entries: PRIORITY_MENU.map((value) => ({
        kind: "item",
        id: `priority-${value}`,
        label: value === "none" ? "No priority" : sentenceCase(value),
        icon: "flag",
        checked: value === task.priority,
        onSelect: () => {
          if (value !== task.priority) void actions.setPriority(task, value);
        },
      })),
    },
  );
  if (!task.parent_task_id) {
    entries.push({
      kind: "submenu",
      id: "project",
      label: "Move to project",
      icon: "folder-input",
      hint: project?.name,
      entries: [
        {
          kind: "item",
          id: "project-none",
          label: "No project",
          checked: task.project_id === null,
          onSelect: () => {
            if (task.project_id !== null) void actions.moveToProject(task, null);
          },
        },
        ...projects.map(
          (p): MenuEntry => ({
            kind: "item",
            id: `project-${p.id}`,
            label: p.name,
            checked: p.id === task.project_id,
            onSelect: () => {
              if (p.id !== task.project_id) void actions.moveToProject(task, p.id);
            },
          }),
        ),
      ],
    });
  }
  if (variant !== "board") {
    entries.push(status);
  }
  entries.push(
    { kind: "separator", id: "sep-2" },
    {
      kind: "item",
      id: "delete",
      label: "Delete",
      icon: "trash-2",
      danger: true,
      onSelect: () => void actions.remove(task),
    },
  );
  return entries;
}

interface TaskMenuProps extends TaskMenuOptions {
  id: string;
  anchor: HTMLElement;
  initialPath?: string[];
  onClose: (reason: MenuCloseReason) => void;
}

/** A task's menu, anchored at the control that opened it. */
export function TaskMenu({ id, anchor, initialPath, onClose, ...options }: TaskMenuProps) {
  return (
    <Menu
      id={id}
      label={`Actions for ${options.task.title}`}
      anchor={anchor}
      entries={taskMenuEntries(options)}
      initialPath={initialPath}
      onClose={onClose}
    />
  );
}
