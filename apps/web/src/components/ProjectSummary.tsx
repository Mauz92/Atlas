import { useId, useState } from "react";

import type { Project } from "../api/client";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { PHONE_QUERY } from "../lib/phone";
import { Icon } from "./Icon";

interface ProjectSummaryProps {
  /** The projects the current plan touches, in first-seen order. */
  projects: Project[];
}

/**
 * The projects a plan touches, each with its derived progress (M4-04, ADR-0023) — the project
 * context a planning view needs without opening the project. Renders nothing when the tasks are
 * all unfiled, so an empty plan stays quiet.
 *
 * Compact (UX-10): small wrapping chips on a wide window; on a phone one "Projects · n" row that
 * expands on tap, so the chips no longer push the first day down the screen. Nothing scrolls sideways.
 */
export function ProjectSummary({ projects }: ProjectSummaryProps) {
  const phone = useMediaQuery(PHONE_QUERY, false);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (projects.length === 0) {
    return null;
  }
  const shown = !phone || open;

  return (
    <section className="project-summary" aria-label="Projects in this plan">
      <h2>
        {phone ? (
          <button
            type="button"
            className="ghost project-summary-toggle"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((value) => !value)}
          >
            <span>Projects</span>
            <span className="section-count" aria-hidden="true">
              {projects.length}
            </span>
            <Icon name={open ? "chevron-down" : "chevron-right"} size={14} />
          </button>
        ) : (
          "Projects"
        )}
      </h2>
      <ul id={listId} hidden={!shown}>
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
