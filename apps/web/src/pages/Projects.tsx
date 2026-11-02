import { useState } from "react";
import { Link } from "react-router-dom";

import { projectsApi, type Project } from "../api/client";
import { LoadError } from "../components/LoadError";
import { ProjectForm } from "../components/ProjectForm";
import { ProjectProgressBar } from "../components/ProjectProgressBar";
import { useProjects } from "../hooks/useProjects";

/**
 * The project list (MU-02): create a project, open one, archive it or bring an archived one back.
 * Progress is derived by the server (ADR-0023); this page only displays it.
 */
export function Projects() {
  const { projects, state, error, reload } = useProjects();
  const [actionError, setActionError] = useState<string | null>(null);

  const live = projects.filter((project) => project.status !== "archived");
  const archived = projects.filter((project) => project.status === "archived");

  async function setStatus(project: Project, status: "active" | "archived") {
    setActionError(null);
    try {
      await projectsApi.update(project, { status });
      await reload();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not update the project",
      );
    }
  }

  return (
    <section className="page projects-page">
      <h1>Projects</h1>
      <p className="muted">Group tasks and notes toward an outcome.</p>

      <details className="project-create">
        <summary>New project</summary>
        <ProjectForm
          submitLabel="Create project"
          onSubmit={async (name, fields) => {
            await projectsApi.create(name, fields);
            await reload();
          }}
        />
      </details>

      {actionError ? (
        <p className="error" role="alert">
          {actionError}
        </p>
      ) : null}

      {state === "error" ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : state === "loading" ? (
        <p className="muted" role="status">Loading projects…</p>
      ) : live.length === 0 ? (
        <div className="empty-state">
          No projects yet — create one to start grouping tasks.
        </div>
      ) : (
        <ul className="project-list">
          {live.map((project) => (
            <li key={project.id} className="project-item">
              <Link to={`/projects/${project.id}`} className="project-name">
                {project.name}
              </Link>
              {project.status === "completed" ? (
                <span className="badge">completed</span>
              ) : null}
              <ProjectProgressBar progress={project.progress} />
              <button
                type="button"
                className="ghost"
                aria-label={`Archive ${project.name}`}
                onClick={() => void setStatus(project, "archived")}
              >
                Archive
              </button>
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <>
          <h2>Archived</h2>
          <ul className="project-list">
            {archived.map((project) => (
              <li key={project.id} className="project-item">
                <Link to={`/projects/${project.id}`} className="project-name">
                  {project.name}
                </Link>
                <button
                  type="button"
                  className="ghost"
                  aria-label={`Restore ${project.name}`}
                  onClick={() => void setStatus(project, "active")}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
