import { useState } from "react";

import { fetchExport, type InstanceInfo } from "../../api/client";
import { useInstanceInfo } from "../../hooks/useInstanceInfo";
import { errorMessage, formatBytes, formatTime } from "../../lib/settingsFormat";
import { LoadError } from "../LoadError";
import { Skeleton } from "../Skeleton";
import { SettingsRow } from "./SettingsRow";

function ExportRow() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { blob, filename } = await fetchExport();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setDone(filename);
    } catch (err) {
      setError(errorMessage(err, "The export failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-group">
      <SettingsRow
        label="Export your data"
        labelId="settings-export-label"
        description="A zip with your Markdown notes, tasks and projects in open formats. It is for portability, not a backup."
      >
        <button type="button" onClick={() => void download()} disabled={busy}>
          {busy ? "Preparing…" : "Download export"}
        </button>
      </SettingsRow>
      {done || error ? (
        <div className="settings-feedback">
          {done ? <span role="status">Downloaded {done}</span> : null}
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function BackupStatus({ info }: { info: InstanceInfo }) {
  const backups = info.backups;
  const latest = backups.latest;
  return (
    <section className="settings-group" aria-labelledby="settings-backups">
      <h3 id="settings-backups">Backups</h3>
      {!backups.destination_available ? (
        <p className="muted">
          The backup folder is not visible to the API, so Atlas cannot report on it here. Backups are
          written by the background worker; on the host, <code>atlas-backup list</code> shows what
          exists.
        </p>
      ) : backups.sets === 0 ? (
        <p className="muted">
          No backup has been completed yet. The worker makes one every{" "}
          {Math.round(backups.interval_seconds / 3600)} h.
        </p>
      ) : (
        <dl className="settings-facts">
          <div>
            <dt>Last backup</dt>
            <dd>{formatTime(latest?.created_at)}</dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              database {formatBytes(latest?.database_bytes)}, notes {formatBytes(latest?.notes_bytes)}
            </dd>
          </div>
          <div>
            <dt>Sets kept</dt>
            <dd>
              {backups.sets} (newest {backups.retain} are retained)
            </dd>
          </div>
        </dl>
      )}
      <dl className="settings-facts">
        <div>
          <dt>Schedule</dt>
          <dd>every {Math.round(backups.interval_seconds / 3600)} h</dd>
        </div>
        <div>
          <dt>Last scheduled run</dt>
          <dd>
            {backups.last_job_status
              ? `${backups.last_job_status} · ${formatTime(backups.last_job_at)}`
              : "none recorded"}
          </dd>
        </div>
        {backups.incomplete_sets > 0 ? (
          <div>
            <dt>Interrupted runs</dt>
            <dd>{backups.incomplete_sets} left in staging (never counted as backups)</dd>
          </div>
        ) : null}
      </dl>
      <p className="hint">
        This is a read-only summary of the backup manifests; checksums are not re-checked here. Run{" "}
        <code>atlas-backup verify</code> on the host to verify them.
      </p>
    </section>
  );
}

/** Export plus the read-only backup summary. The summary loads on its own; the export never waits. */
export function DataSection() {
  const { info, error, reload } = useInstanceInfo();
  return (
    <>
      <ExportRow />
      {error ? (
        <LoadError message={error} onRetry={() => void reload()} />
      ) : info ? (
        <BackupStatus info={info} />
      ) : (
        <Skeleton label="Loading backup status" rows={3} kind="line" />
      )}
    </>
  );
}
