import type { CacheEntry } from "../lib/localCache";
import {
  conflictRefKey,
  resolutionHint,
  resolutionLabel,
  type ConflictResolution,
} from "../lib/conflictResolution";
import {
  conflictDetailText,
  conflictEntityLabel,
  conflictSummaryText,
} from "../lib/reconciliation";

interface ConflictNoticeProps {
  /** The entities whose local edit could not be applied (the conflict policy keeps them). */
  conflicts: CacheEntry[];
  /** A failure from a reconciliation or resolution, if any. */
  error?: string | null;
  /** Run another reconciliation pass (a retry). */
  onReconcile?: () => void;
  /** Apply a manual resolution to one conflicting entity (M7-05). */
  onResolve?: (entry: CacheEntry, resolution: ConflictResolution) => void;
  /** The entity currently being resolved (`type:id`), so its own actions can show progress. */
  resolvingKey?: string | null;
  /** True while a pass is in flight. */
  busy?: boolean;
}

/**
 * The conflict surface (M7-04) with manual resolution (M7-05).
 *
 * A stale write is **kept and surfaced**, never silently dropped and never allowed to clobber newer
 * data (AGENTS.md §9, ADR-0035). This lists the affected entities, explains that the local edit is
 * being kept, and — when `onResolve` is provided — offers the two documented resolutions per entity:
 * **Keep mine** (re-queue the local edit against the server's current revision) and **Take server**
 * (discard the local edit and adopt the server's version). Semantics live in
 * `lib/conflictResolution.ts`; this component only renders and reports the user's choice.
 *
 * Presentational only — it never touches storage or the API. The list and every action are
 * keyboard-usable buttons, the in-flight entity disables its own actions while a pass or a
 * resolution runs, and the styling reuses the theme variables so it reads in both light and dark.
 */
export function ConflictNotice({
  conflicts,
  error = null,
  onReconcile,
  onResolve,
  resolvingKey = null,
  busy = false,
}: ConflictNoticeProps) {
  // Nothing to surface: no conflicts and no failure means no panel at all.
  if (conflicts.length === 0 && !error) {
    return null;
  }

  const resolving = (entry: CacheEntry) => resolvingKey === conflictRefKey(entry);

  return (
    <section className="conflict-notice" aria-labelledby="conflict-notice-heading">
      <h2 id="conflict-notice-heading">Sync conflicts</h2>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="muted">{conflictSummaryText(conflicts)}</p>
      {conflicts.length > 0 ? (
        <ul className="conflict-list">
          {conflicts.map((entry) => (
            <li key={conflictRefKey(entry)} className="conflict-item">
              <span className="conflict-item-label">{conflictEntityLabel(entry)}</span>
              <span className="muted">{conflictDetailText(entry)}</span>
              {onResolve ? (
                <div className="conflict-actions" role="group" aria-label="Resolve conflict">
                  <button
                    type="button"
                    onClick={() => onResolve(entry, "keep-mine")}
                    disabled={busy || resolving(entry)}
                    aria-busy={resolving(entry)}
                    title={resolutionHint("keep-mine")}
                  >
                    {resolving(entry) ? "Saving…" : resolutionLabel("keep-mine")}
                  </button>
                  <button
                    type="button"
                    onClick={() => onResolve(entry, "take-server")}
                    disabled={busy || resolving(entry)}
                    title={resolutionHint("take-server")}
                  >
                    {resolutionLabel("take-server")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {onReconcile ? (
        <button type="button" onClick={onReconcile} disabled={busy} aria-busy={busy}>
          {busy ? "Syncing…" : "Retry sync"}
        </button>
      ) : null}
    </section>
  );
}
