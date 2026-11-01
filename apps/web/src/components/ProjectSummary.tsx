import type { Project } from "../api/client";

interface ProjectSummaryProps {
  /** The projects the current plan touches, in first-seen order. */
  projects: Project[];
}

/**
 * The projects a plan touches, each with its derived progress (M4-04, ADR-0023) — the project
 * context a planning view needs without opening the project. Renders nothing when the tasks are
 * all unfiled, so an empty plan stays quiet.
 */
export function ProjectSummary({ projects }: ProjectSummaryProps) {
  if (projects.length === 0) {
    return null;
  }

  return (
    <section className="project-summary" aria-label="Projects in this plan">
      <h2>Projects</h2>
      <ul>
        {projects.map((project) => (
          <li key={project.id}>
            <span className="project-name">{project.name}</span>
            <span className="muted project-progress">
              {project.progress.completed}/{project.progress.total} · {project.progress.percent}%
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
