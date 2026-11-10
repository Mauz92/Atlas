import { Link, useLocation } from "react-router-dom";

import { useChangeNotices } from "../hooks/useChangeNotices";
import { noticeSummary } from "../lib/syncUi/resolutionText";
import type { ResolutionsSource } from "../lib/syncUi/source";
import { Icon } from "./Icon";

/**
 * The "Changed on another device" banner (SYNC-11a-1). It appears above the page when another
 * device's change was settled automatically since the person last looked, says how many, and links to
 * the Changes page where each one can be undone. It never blocks anything and is dismissible; it is
 * hidden on the Changes page itself, which marks the entries as seen.
 */
export function ChangedElsewhere({ source }: { source?: ResolutionsSource }) {
  const { notices, dismiss } = useChangeNotices(source);
  const { pathname } = useLocation();
  if (notices.length === 0 || pathname === "/changes") return null;
  return (
    <section className="changed-elsewhere" aria-label="Changed on another device" aria-live="polite">
      <Icon name="monitor-smartphone" size={16} />
      <p>
        <strong>Changed on another device.</strong> {noticeSummary(notices.length)} and Atlas settled it for you.
      </p>
      <Link to="/changes" className="button-link">
        Review
      </Link>
      <button type="button" className="ghost" onClick={dismiss}>
        Dismiss
      </button>
    </section>
  );
}
