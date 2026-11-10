import { Link } from "react-router-dom";

import { EmptyState } from "../components/EmptyState";
import { LoadError } from "../components/LoadError";
import { ResolutionCard } from "../components/ResolutionCard";
import { Skeleton } from "../components/Skeleton";
import { useEntityTitles } from "../hooks/useEntityTitles";
import { useResolutions } from "../hooks/useResolutions";
import { markChangesSeen } from "../lib/syncUi/seen";
import { useEffect } from "react";

/**
 * "Changes from other devices" (SYNC-11a-1): the server's log of automatic decisions, newest first,
 * 20 at a time. Each entry says what changed and where, and offers Undo when the server can do it
 * safely (`POST /api/sync/resolutions/{id}/undo`) or says what to do instead. Opening the page marks
 * the banner as seen.
 */
export function Changes() {
  const state = useResolutions();
  const titles = useEntityTitles(state.items);
  const { items } = state;

  useEffect(() => {
    markChangesSeen();
  }, []);

  return (
    <section className="page changes-page" aria-labelledby="changes-title">
      <h1 id="changes-title">Changes from other devices</h1>
      <p className="muted changes-blurb">
        When two devices change the same thing, Atlas keeps one result and records the decision here for 90 days. You can undo a
        change when nothing has touched it since; otherwise Atlas says why not. These entries never contain your text.
      </p>
      {state.error ? <LoadError message={state.error} onRetry={() => void state.reload()} /> : null}
      {state.loading ? <Skeleton label="Loading changes" rows={4} kind="line" /> : null}
      {!state.loading && !state.error && items.length === 0 ? (
        <EmptyState icon="arrow-left-right" compact>
          No automatic decisions yet. When two devices change the same thing, the result appears here.
        </EmptyState>
      ) : null}
      {items.length > 0 ? (
        <ul className="resolution-list" aria-label="Changes from other devices">
          {items.map((item) => (
            <ResolutionCard
              key={item.id}
              resolution={item}
              names={state.names}
              title={titles.get(item.entity_id)}
              outcome={state.outcomes.get(item.id)}
              busy={state.undoing === item.id}
              disabled={state.undoing !== null}
              onUndo={(r) => void state.undo(r)}
            />
          ))}
        </ul>
      ) : null}
      {state.hasMore ? (
        <button type="button" onClick={() => void state.loadMore()} disabled={state.loadingMore} aria-busy={state.loadingMore}>
          {state.loadingMore ? "Loading..." : "Load older changes"}
        </button>
      ) : null}
      <p className="muted">
        <Link to="/settings/sync">Back to Sync settings</Link>
      </p>
    </section>
  );
}
