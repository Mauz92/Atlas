import { useEffect, useRef, useState } from "react";

import { describeHalt, type HaltInfo, type HaltView } from "../lib/syncUi/haltText";
import { Icon } from "./Icon";

interface Props {
  halt: HaltView;
  info: HaltInfo;
  busy?: boolean;
  error?: string | null;
  /** Restore: add back what the server lost (`SyncEngine.confirmRestore`). */
  onReupload?: () => void;
  /** Restore: throw away unsent changes and download the server (`discardLocalAndRedownload`). */
  onDiscard?: () => void;
  onSignIn?: () => void;
  /** Update required: look again (after the app was updated). */
  onCheckAgain?: () => void;
}

/**
 * The full-screen explanation of a stopped sync (SYNC-11a-4): restore confirmation (D12), update
 * required (426) and signed out (401). One heading, the facts, one primary action; destructive
 * choices ask again in place. Nothing here is automatic.
 */
export function SyncHaltScreen({ halt, info, busy = false, error = null, onReupload, onDiscard, onSignIn, onCheckAgain }: Props) {
  const text = describeHalt(halt, info);
  const [asking, setAsking] = useState(false);
  const primary = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    primary.current?.focus();
  }, []);

  return (
    <main className="halt-screen" aria-labelledby="halt-title">
      <div className="halt-card">
        <Icon name={halt.kind === "restore_confirmation" ? "shield-alert" : halt.kind === "signed_out" ? "log-out" : "download"} size={28} />
        <h1 id="halt-title">{text.title}</h1>
        {text.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {text.facts.length > 0 ? (
          <dl className="halt-facts">
            {text.facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}

        {halt.kind === "restore_confirmation" ? (
          asking ? (
            <div className="halt-actions" role="group" aria-label="Confirm discarding local changes">
              <p>
                <strong>
                  Discard {info.pending === 1 ? "the 1 unsent change" : `the ${info.pending} unsent changes`} on this device and download the
                  server&apos;s data?
                </strong>{" "}
                This cannot be undone: tasks and edits that exist only on this device are dropped. Files in your notes folder are never
                deleted; a file the server does not have is added again as a new note by the next scan.
              </p>
              <button type="button" className="danger" disabled={busy} onClick={onDiscard}>
                Yes, discard and re-download
              </button>
              <button type="button" disabled={busy} onClick={() => setAsking(false)}>
                Go back
              </button>
            </div>
          ) : (
            <div className="halt-actions">
              <button ref={primary} type="button" className="primary" disabled={busy} onClick={onReupload}>
                <Icon name="upload" size={16} />
                Re-upload my local data
              </button>
              <p className="muted">Adds back what the server lost, with the same ids. Nothing already on the server is changed.</p>
              <button type="button" className="danger" disabled={busy} onClick={() => setAsking(true)}>
                <Icon name="download" size={16} />
                Discard local changes and re-download
              </button>
              <p className="muted">Makes this device match the restored server exactly.</p>
            </div>
          )
        ) : null}
        {halt.kind === "signed_out" ? (
          <div className="halt-actions">
            <button ref={primary} type="button" className="primary" onClick={onSignIn} disabled={busy}>
              Sign in again
            </button>
          </div>
        ) : null}
        {halt.kind === "update_required" ? (
          <div className="halt-actions">
            <button ref={primary} type="button" className="primary" onClick={onCheckAgain} disabled={busy}>
              Check again
            </button>
          </div>
        ) : null}
      </div>
    </main>
  );
}
