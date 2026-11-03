import type { ProjectProgress } from "../api/client";

/**
 * A project's derived progress (ADR-0023): a tokenised bar plus "completed/total done · percent".
 * The bar is a `progressbar` role element painted from design tokens (a native `<progress>` takes
 * the browser's own colours, UX-07).
 */
export function ProjectProgressBar({ progress }: { progress: ProjectProgress }) {
  return (
    <span className="project-progress-bar">
      <span
        className="progress-track"
        role="progressbar"
        aria-label={`Progress ${progress.percent}%`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
      >
        <span className="progress-fill" style={{ width: `${progress.percent}%` }} />
      </span>
      <span className="muted progress-text">
        {progress.completed}/{progress.total} done · {progress.percent}%
      </span>
    </span>
  );
}
