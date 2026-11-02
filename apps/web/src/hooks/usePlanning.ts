import { useCallback, useEffect, useMemo, useState } from "react";

import { projectsApi, tasksApi, type Project, type Task } from "../api/client";
import { ACTIVE_STATUSES, indexProjects, type PlanningWindow } from "../lib/planning";
import { viewerTimeZone } from "../lib/tasks";
import type { LoadState } from "./useTaskView";

export interface PlanningResult {
  /** The tasks the server returned for the window, in the server's order. */
  tasks: Task[];
  /** Every live project, so a task row can name its project. */
  projects: Project[];
  projectById: Map<string, Project>;
  state: LoadState;
  /** A failure from loading the plan itself (no tasks can be shown). */
  error: string | null;
  /** A non-fatal failure from loading project context; the plan still renders without it. */
  projectsError: string | null;
  /** A failure from an action on the plan (for example completing a task). */
  actionError: string | null;
  /** The viewer's IANA zone, forwarded to the API so placement matches the server's. */
  timeZone: string | undefined;
  reload: () => Promise<void>;
  /** Re-read the plan without the loading state (after an edit made elsewhere on the page). */
  refresh: () => Promise<void>;
  complete: (task: Task) => Promise<void>;
}

/**
 * Load one planning window (M4-06) — either a primary server `view` or a `due_at` range — together
 * with the caller's projects for context.
 *
 * The tasks are authoritative on the server: the hook only forwards the window (and the viewer's
 * zone) to `GET /api/tasks`; the day and week grouping happens in `lib/planning.ts`. Projects are
 * **context only**, so a failure to load them is reported without hiding the plan — never silently
 * ignored, never fatal (AGENTS.md §9/§16). `window` must be memoised by the caller so the plan
 * does not reload on every render.
 */
export function usePlanning(window: PlanningWindow): PlanningResult {
  const { view, dueFrom, dueTo } = window;
  const timeZone = useMemo(() => viewerTimeZone(), []);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const listing = await tasksApi.list({
        view,
        dueFrom,
        dueTo,
        // A window is filtered to open work, exactly as the server's Today/Upcoming views are.
        status: view ? undefined : ACTIVE_STATUSES,
        tz: timeZone,
      });
      setTasks(listing.tasks);
      setError(null);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the plan");
      setState("error");
    }
  }, [view, dueFrom, dueTo, timeZone]);

  const loadProjects = useCallback(async () => {
    try {
      const listing = await projectsApi.list();
      setProjects(listing.projects);
      setProjectsError(null);
    } catch (err) {
      setProjects([]);
      setProjectsError(
        err instanceof Error ? err.message : "Project details are unavailable right now",
      );
    }
  }, []);

  const reload = useCallback(async () => {
    setState("loading");
    await Promise.all([loadTasks(), loadProjects()]);
  }, [loadTasks, loadProjects]);

  const complete = useCallback(
    async (task: Task) => {
      setActionError(null);
      try {
        await tasksApi.complete(task);
        await loadTasks();
      } catch (err) {
        setActionError(err instanceof Error ? err.message : "Could not complete the task");
      }
    },
    [loadTasks],
  );

  useEffect(() => {
    // A new window (or a reload of it) shows the loading state, so a plan is never rendered under
    // the wrong day's heading while the new window is in flight.
    setState("loading");
    void loadTasks();
    void loadProjects();
  }, [loadTasks, loadProjects]);

  const projectById = useMemo(() => indexProjects(projects), [projects]);

  return {
    tasks,
    projects,
    projectById,
    state,
    error,
    projectsError,
    actionError,
    timeZone,
    reload,
    refresh: loadTasks,
    complete,
  };
}
