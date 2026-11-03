import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import { projectsApi, type Project } from "../api/client";
import { Icon } from "../components/Icon";
import { LoadError } from "../components/LoadError";
import type { MenuEntry } from "../components/Menu";
import { MenuButton } from "../components/MenuButton";
import { ProjectForm } from "../components/ProjectForm";
import { ProjectProgressBar } from "../components/ProjectProgressBar";
import { useProjects } from "../hooks/useProjects";
import { formatDay } from "../lib/tasks";

/**
 * The project list (MU-02, UX-07): one row per project — name, status, derived progress (ADR-0023),
 * open count, target date and a "…" menu holding Open and Archive / Restore. Archived projects sit
 * behind a toggle. This page only displays progress; the server derives it.
 */
export function Projects() {
  const { projects, state, error, reload } = useProjects();
  const navigate = useNavigate();
  const [actionError, setActionError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

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

  function row(project: Project) {
    const isArchived = project.status === "archived";
    const open = project.progress.total - project.progress.completed;
    const entries: MenuEntry[] = [
      {
        kind: "item",
        id: "open",
        label: "Open project",
        icon: "folder-kanban",
        onSelect: () => navigate(`/projects/${project.id}`),
      },
      { kind: "separator", id: "sep" },
      isArchived
        ? {
            kind: "item",
            id: "restore",
            label: "Restore project",
            icon: "refresh-cw",
            onSelect: () => void setStatus(project, "active"),
          }
        : {
            kind: "item",
            id: "archive",
            label: "Archive project",
            icon: "inbox",
            onSelect: () => void setStatus(project, "archived"),
          },
    ];
    return (
      <li key={project.id} className="project-item">
        <Link to={`/projects/${project.id}`} className="project-name">
          {project.name}
        </Link>
        {project.status === "completed" ? (
          <span className="pill pill-success">Completed</span>
        ) : null}
        {isArchived ? (
          <span className="project-open muted">Archived</span>
        ) : (
          <>
            <ProjectProgressBar progress={project.progress} />
            <span className="project-open muted">{open} open</span>
          </>
        )}
        <span className="project-target muted">
          {project.target_date ? `Target ${formatDay(project.target_date)}` : ""}
        </span>
        <MenuButton
          menuLabel={`Actions for ${project.name}`}
          ariaLabel={`Actions for ${project.name}`}
          title="More actions"
          className="icon-button ghost"
          entries={entries}
        >
          <Icon name="ellipsis" />
        </MenuButton>
      </li>
    );
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
        <ul className="project-list">{live.map(row)}</ul>
      )}

      {archived.length > 0 ? (
        <>
          <button
            type="button"
            className="ghost archived-toggle"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((open) => !open)}
          >
            <Icon name={showArchived ? "chevron-down" : "chevron-right"} size={14} />
            {showArchived ? "Hide archived" : "Show archived"} ({archived.length})
          </button>
          {showArchived ? (
            <>
              <h2>Archived</h2>
              <ul className="project-list">{archived.map(row)}</ul>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
