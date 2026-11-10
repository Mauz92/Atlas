import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useShellSync } from "../hooks/useShellSync";
import { desktopApi, type DesktopProblem } from "../lib/desktop";
import { formatTime } from "../lib/settingsFormat";
import { describeProblem } from "../lib/syncUi/problemText";
import { TextConflictResolver } from "./TextConflictResolver";

const STATE_TEXT: Record<string, string> = {
  idle: "Up to date",
  syncing: "Syncing",
  offline: "Offline: changes wait on this computer",
  backoff: "Waiting to retry",
  update_required: "Update required",
  signed_out: "Signed out",
  restore_confirmation: "Waiting for your decision about a restored server",
};

/**
 * Settings > Sync inside the desktop shell (SYNC-11c). The sync-core engine owns the queue, the cursor
 * and what it could not apply, so this shows ITS state (not the browser's offline queue, which the
 * shell never starts): status, "Sync now", the problems it kept with the text resolver, and the link to
 * the Changes page. Rendered only where `window.atlasDesktop` exists.
 */
export function ShellSyncSettings() {
  const desktop = desktopApi();
  const snap = useShellSync();
  const [problems, setProblems] = useState<DesktopProblem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const counts = snap?.sync ? `${snap.sync.failed}:${snap.sync.conflicts}` : "";

  const load = useCallback(async () => {
    if (!desktop) return;
    try {
      setProblems(await desktop.sync.problems());
    } catch {
      setProblems([]); // signed out: nothing to show
    }
  }, [desktop]);

  useEffect(() => {
    void load();
  }, [load, counts]);

  if (!desktop) return null;
  if (!snap) return <p className="muted">Loading...</p>;
  const sync = snap.sync;

  const run = async (key: string, work: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await work();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Nothing was changed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="settings-group shell-sync">
      <dl className="settings-facts">
        <div>
          <dt>State</dt>
          <dd>{sync ? (STATE_TEXT[sync.state] ?? sync.state) : "Not running"}</dd>
        </div>
        <div>
          <dt>Waiting to send</dt>
          <dd>{sync ? sync.pending : 0}</dd>
        </div>
        <div>
          <dt>Last synced</dt>
          <dd>{sync?.lastSyncAt ? formatTime(new Date(sync.lastSyncAt).toISOString()) : "not yet"}</dd>
        </div>
      </dl>
      <p className="settings-actions">
        <button type="button" disabled={busy !== null} onClick={() => void run("sync", () => desktop.syncNow())}>
          Sync now
        </button>
        <Link to="/changes">Changes from other devices</Link>
      </p>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {problems && problems.length > 0 ? (
        <ul className="problem-list" aria-label="Changes that need your attention">
          {problems.map((problem) => {
            const text = describeProblem(problem);
            return (
              <li key={problem.id} className="problem-item">
                <p>
                  <strong>{text.title}</strong>
                </p>
                <p className="muted">{text.detail}</p>
                {text.textConflicts.map((c) => (
                  <TextConflictResolver
                    key={c.field}
                    label={c.field}
                    multiline={c.field === "description"}
                    mine={c.mine}
                    theirs={c.theirs}
                    saving={busy === problem.id}
                    onResolve={(chosen, choice) =>
                      void run(problem.id, () =>
                        choice === "theirs" ? desktop.sync.dismissProblem(problem.id) : desktop.sync.resolveText(problem.id, c.field, chosen),
                      )
                    }
                  />
                ))}
                <p className="settings-actions">
                  {text.to ? <Link to={text.to}>Open</Link> : null}
                  <button
                    type="button"
                    disabled={busy !== null}
                    aria-label={`Dismiss: ${text.title}`}
                    onClick={() => void run(problem.id, () => desktop.sync.dismissProblem(problem.id))}
                  >
                    Dismiss
                  </button>
                </p>
              </li>
            );
          })}
        </ul>
      ) : problems ? (
        <p className="muted">Nothing needs your attention.</p>
      ) : null}
    </div>
  );
}
