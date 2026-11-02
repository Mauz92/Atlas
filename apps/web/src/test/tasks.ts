import type { Project, Task } from "../api/client";

/** A complete `Task` with sensible defaults, for component tests. */
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task",
    description: null,
    status: "inbox",
    priority: "none",
    project_id: null,
    parent_task_id: null,
    subtasks_total: 0,
    subtasks_done: 0,
    start_at: null,
    due_at: null,
    due_state: "none",
    time_zone: null,
    duration_minutes: null,
    completed_at: null,
    recurrence_rule: null,
    recurrence_parent_id: null,
    external_provider: null,
    external_id: null,
    tags: [],
    revision: 1,
    created_at: "2026-10-26T08:00:00+00:00",
    updated_at: "2026-10-26T08:00:00+00:00",
    ...overrides,
  };
}

/** A complete `Project` with sensible defaults, for planning/context component tests. */
export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Project",
    description: null,
    status: "active",
    start_date: null,
    target_date: null,
    progress: { total: 0, completed: 0, percent: 0 },
    revision: 1,
    created_at: "2026-10-26T08:00:00+00:00",
    updated_at: "2026-10-26T08:00:00+00:00",
    ...overrides,
  };
}
