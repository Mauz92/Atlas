interface SkeletonProps {
  /** What is loading, e.g. "Loading inbox"; read out as "<label>…" and used by specs as text. */
  label: string;
  /** Rows per group. */
  rows?: number;
  /** Groups of rows, each with a heading bar (Today, Upcoming, Week). */
  groups?: number;
  /**
   * `task` mirrors a task row (round box and title), `card` a project row, `line` a plain text
   * line, and `tree` the notes tree.
   */
  kind?: "task" | "card" | "line" | "tree";
}

/**
 * A calm placeholder for a list that is loading (UX-08, ADR-0058). It reserves the height of the
 * rows it stands for so the page does not jump when data arrives, uses token colours only, and its
 * shimmer stops under `prefers-reduced-motion`. It is the page's `role="status"` (as the "Loading…"
 * line it replaces was), with the label as screen-reader text; the bars are decorative.
 */
export function Skeleton({ label, rows = 3, groups = 0, kind = "task" }: SkeletonProps) {
  const rowList = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => (
      <div key={index} className="skeleton-row" data-n={(index + offset) % 4} aria-hidden="true">
        {kind === "task" ? <span className="skeleton-box" /> : null}
        <span className="skeleton-bar" />
      </div>
    ));

  return (
    <div className={`skeleton skeleton-${kind}`} role="status" aria-busy="true">
      <span className="sr-only">{label}…</span>
      {groups > 0
        ? Array.from({ length: groups }, (_, group) => (
            <div key={group} className="skeleton-group" aria-hidden="true">
              <span className="skeleton-bar skeleton-heading" />
              {rowList(rows, group)}
            </div>
          ))
        : rowList(rows)}
    </div>
  );
}
