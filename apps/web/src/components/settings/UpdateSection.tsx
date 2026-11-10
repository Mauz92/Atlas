import { useCallback, useEffect, useRef, useState } from "react";

import { systemUpdateApi, type UpdateStatus } from "../../api/client";
import { errorMessage, formatTime } from "../../lib/settingsFormat";

const POLL_MS = 3000;

const PHASE_TEXT: Record<string, string> = {
  validating: "Checking the request",
  preparing: "Getting ready",
  download: "Downloading the release files",
  pull: "Downloading the new version (Atlas keeps running)",
  stop: "Stopping Atlas",
  backup: "Taking a verified backup of your data",
  switch: "Switching to the new version",
  health: "Starting the new version",
  rollback: "Something went wrong: going back to the previous version",
};

/**
 * Settings > About > Server updates (REL-01, ADR-0074). The browser asks, the host updater does the work: the
 * server takes a verified backup, switches to the new release and goes back by itself if the new version does not
 * start. This component only shows the state and sends the request; it never sees a credential or a file path.
 */
export function UpdateSection() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const wasRunning = useRef(false);
  const [finished, setFinished] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await systemUpdateApi.get());
      setError(null);
    } catch (err) {
      // While the server restarts the page cannot reach it; that is part of an update, not an error.
      if (wasRunning.current) return;
      setError(errorMessage(err, "Could not read the update status"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running =
    status?.state === "updating" || status?.request_pending === true;
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
    } else if (wasRunning.current && status) {
      wasRunning.current = false;
      setFinished(true);
    }
  }, [running, status]);

  useEffect(() => {
    if (!running && !wasRunning.current) return undefined;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  async function run(action: () => Promise<UpdateStatus>) {
    setBusy(true);
    setError(null);
    setFinished(false);
    try {
      setStatus(await action());
    } catch (err) {
      setError(errorMessage(err, "The request failed"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!status) {
    return error ? (
      <section className="settings-group" aria-labelledby="settings-updates">
        <h3 id="settings-updates">Server updates</h3>
        <p className="muted">{error}</p>
      </section>
    ) : null;
  }

  return (
    <section className="settings-group" aria-labelledby="settings-updates">
      <h3 id="settings-updates">Server updates</h3>
      {!status.configured ? (
        <p className="muted">
          Updating from here is not set up on this server. Follow “Update from
          the web app” in the deployment guide (docs/DEPLOYMENT.md, section 12)
          once, and this page will offer updates.
        </p>
      ) : (
        <>
          <dl className="settings-facts">
            <div>
              <dt>Running</dt>
              <dd>{status.current_version}</dd>
            </div>
            <div>
              <dt>Newest release</dt>
              <dd>{status.latest_version ?? "not checked yet"}</dd>
            </div>
            <div>
              <dt>Last checked</dt>
              <dd>
                {status.checked_at ? formatTime(status.checked_at) : "never"}
              </dd>
            </div>
          </dl>

          {running ? (
            <div role="status" aria-live="polite">
              <p>
                <strong>Updating…</strong>{" "}
                {PHASE_TEXT[status.phase ?? ""] ?? "Working"}. Atlas is
                unavailable for a few minutes while your data is backed up and
                the new version starts; this page reconnects by itself. Nothing
                is lost.
              </p>
              {(status.log ?? []).length ? (
                <pre className="update-log">{(status.log ?? []).join("\n")}</pre>
              ) : null}
            </div>
          ) : (
            <>
              {finished && status.state === "idle" ? (
                <p role="status">
                  The update finished.{" "}
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                  >
                    Reload Atlas
                  </button>
                </p>
              ) : null}
              {status.state === "rolled_back" || status.state === "failed" ? (
                <p className="error" role="alert">
                  {status.message}
                </p>
              ) : null}
              {status.update_available && status.latest_version ? (
                confirming ? (
                  <div role="group" aria-label="Confirm the update">
                    <p>
                      Update Atlas to {status.latest_version}? It is unavailable
                      for a few minutes. A verified backup is taken first and
                      your notes, tasks and settings are kept. If the new
                      version does not start, the current one is restored
                      automatically.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          systemUpdateApi.apply(status.latest_version ?? ""),
                        )
                      }
                    >
                      Update now
                    </button>{" "}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirming(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button type="button" onClick={() => setConfirming(true)}>
                    Update to {status.latest_version}
                  </button>
                )
              ) : (
                <p className="muted">
                  {status.checked_at
                    ? "Atlas is up to date."
                    : "Check to see whether a newer release exists."}
                </p>
              )}{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => systemUpdateApi.check())}
              >
                Check for updates
              </button>
              {status.notes && status.update_available ? (
                <details>
                  <summary>What is new</summary>
                  <pre className="update-notes">{status.notes}</pre>
                </details>
              ) : null}
            </>
          )}
        </>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
