import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";

import { projectsApi, type Project } from "../api/client";

export interface ProjectsState {
  /** Every live project (active, completed and archived), in capture order. */
  projects: Project[];
  state: "loading" | "ready" | "error";
  error: string | null;
  /** Re-read the projects (after a create/edit/archive, or a task change that moves progress). */
  reload: () => Promise<void>;
}

const EMPTY: ProjectsState = {
  projects: [],
  state: "ready",
  error: null,
  reload: async () => {},
};

const ProjectsContext = createContext<ProjectsState>(EMPTY);

/**
 * The one shared list of projects (MU-02): the sidebar, the Projects page and the task detail's
 * project picker all read it, so a project created or archived anywhere shows up everywhere.
 * Without a provider (isolated component tests) it is simply empty.
 */
export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<ProjectsState["state"]>("loading");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const listing = await projectsApi.list();
      setProjects(listing.projects);
      setError(null);
      setState("ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load projects");
      setState("error");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const value = useMemo(
    () => ({ projects, state, error, reload }),
    [projects, state, error, reload],
  );
  return (
    <ProjectsContext.Provider value={value}>
      {children}
    </ProjectsContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useProjects(): ProjectsState {
  return useContext(ProjectsContext);
}

/** Projects that still take work: everything not archived. */
// eslint-disable-next-line react-refresh/only-export-components
export function activeProjects(projects: Project[]): Project[] {
  return projects.filter((project) => project.status === "active");
}
