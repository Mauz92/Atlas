import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";

import { useOnlineStatus } from "../hooks/useMediaQuery";
import { useOfflineQueue } from "../hooks/useOfflineQueue";
import { useSyncStatus } from "../hooks/useSyncStatus";
import { settingsPath } from "../lib/settingsSections";
import { calendarStatusItem, syncStatusItem } from "../lib/statusBar";
import { Icon } from "./Icon";

/**
 * The status bar at the bottom of the shell (UX-02): sync state (online/offline, queued changes,
 * conflicts) linking to the Sync page, the calendar's last sync linking to Calendar, and the
 * keyboard shortcut help. It only summarises what `useOfflineQueue`, `useSyncStatus` and the
 * browser's connectivity report; it never replays or changes anything.
 *
 * It is a labelled `<footer>` (not `role="status"`, which pages use for their own messages); the
 * sync text is an `aria-live="polite"` region so a change to offline or a new conflict is announced.
 */
export function StatusBar({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const queue = useOfflineQueue();
  const calendar = useSyncStatus();
  const online = useOnlineStatus();
  const { pathname } = useLocation();
  const { refresh } = queue;

  // The queue lives in IndexedDB and has no change events: re-read it when the page changes, the
  // tab regains focus or connectivity changes, so the counts never stay stale for long.
  useEffect(() => {
    void refresh();
  }, [pathname, online, refresh]);
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const sync = syncStatusItem({ counts: queue.counts, online, loadFailed: queue.state === "error" });
  const cal = calendarStatusItem(calendar.providers, calendar.state);

  return (
    <footer className={`statusbar${sync.tone === "ok" ? " is-quiet" : ""}`} aria-label="Status bar">
      <Link to={settingsPath("sync")} className={`statusbar-item tone-${sync.tone}`} title={sync.label}>
        <Icon name={sync.icon} size={14} />
        <span aria-live="polite">{sync.text}</span>
      </Link>
      {cal ? (
        <Link to={settingsPath("calendar")} className={`statusbar-item tone-${cal.tone} statusbar-calendar`} title={cal.label}>
          <Icon name={cal.icon} size={14} />
          <span>{cal.text}</span>
        </Link>
      ) : null}
      <span className="statusbar-spacer" />
      <button
        type="button"
        className="statusbar-item statusbar-shortcuts"
        aria-label="Keyboard shortcuts"
        onClick={onShowShortcuts}
      >
        <Icon name="keyboard" size={14} />
        <span>Shortcuts</span>
      </button>
    </footer>
  );
}
