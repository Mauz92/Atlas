import type { ProjectProgress } from "../api/client";

/** A project's derived progress (ADR-0023): "completed/total · percent" plus a bar. */
export function ProjectProgressBar({ progress }: { progress: ProjectProgress }) {
  return (
    <span className="project-progress-bar">
      <progress
        max={100}
        value={progress.percent}
        aria-label={`Progress ${progress.percent}%`}
      />
      <span className="muted">
        {progress.completed}/{progress.total} done · {progress.percent}%
      </span>
    </span>
  );
}
