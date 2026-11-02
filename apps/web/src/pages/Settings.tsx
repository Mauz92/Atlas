import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { FormEvent } from "react";

import { api, fetchExport, instanceApi, type InstanceInfo } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { LoadError } from "../components/LoadError";
import { NotificationSettings } from "../components/NotificationSettings";
import { applyTheme, readTheme, subscribeTheme, type Theme } from "../lib/theme";

const MIN_PASSWORD = 12;

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "unknown";
}

function AccountSection() {
  const { user, updateDisplayName } = useAuth();
  const [name, setName] = useState(user?.display_name ?? "");
  const [nameState, setNameState] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text?: string }>({
    kind: "idle",
  });

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [passwordState, setPasswordState] = useState<{
    kind: "idle" | "saving" | "saved" | "error";
    text?: string;
  }>({ kind: "idle" });

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setNameState({ kind: "saving" });
    try {
      await updateDisplayName(name);
      setNameState({ kind: "saved" });
    } catch (err) {
      setNameState({ kind: "error", text: message(err, "Could not save the name") });
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (next !== confirm) {
      setPasswordState({ kind: "error", text: "The new passwords do not match" });
      return;
    }
    setPasswordState({ kind: "saving" });
    try {
      await api.changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setPasswordState({ kind: "saved" });
    } catch (err) {
      setPasswordState({ kind: "error", text: message(err, "Could not change the password") });
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-account">
      <h2 id="settings-account">Account</h2>
      <p className="muted">Signed in as {user?.email}.</p>

      <form className="settings-form" onSubmit={(event) => void saveName(event)}>
        <label htmlFor="settings-name">Display name</label>
        <input
          id="settings-name"
          type="text"
          autoComplete="name"
          maxLength={120}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameState({ kind: "idle" });
          }}
        />
        <div className="settings-actions">
          <button type="submit" disabled={nameState.kind === "saving"}>
            Save name
          </button>
          {nameState.kind === "saved" ? <span role="status">Name saved</span> : null}
        </div>
        {nameState.kind === "error" ? (
          <p className="error" role="alert">
            {nameState.text}
          </p>
        ) : null}
      </form>

      <form className="settings-form" onSubmit={(event) => void savePassword(event)}>
        <h3>Change password</h3>
        <label htmlFor="settings-current-password">Current password</label>
        <input
          id="settings-current-password"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
        />
        <label htmlFor="settings-new-password">New password</label>
        <input
          id="settings-new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD}
          aria-describedby="settings-password-hint"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        <p id="settings-password-hint" className="hint">
          At least {MIN_PASSWORD} characters. Changing it signs you out on your other devices.
        </p>
        <label htmlFor="settings-confirm-password">Confirm new password</label>
        <input
          id="settings-confirm-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
        />
        <div className="settings-actions">
          <button type="submit" disabled={passwordState.kind === "saving"}>
            Change password
          </button>
          {passwordState.kind === "saved" ? (
            <span role="status">Password changed. Other devices were signed out.</span>
          ) : null}
        </div>
        {passwordState.kind === "error" ? (
          <p className="error" role="alert">
            {passwordState.text}
          </p>
        ) : null}
      </form>
    </section>
  );
}

function AppearanceSection() {
  const theme = useSyncExternalStore(subscribeTheme, readTheme);
  return (
    <section className="settings-section" aria-labelledby="settings-appearance">
      <h2 id="settings-appearance">Appearance</h2>
      <fieldset className="settings-radio">
        <legend>Theme</legend>
        {(["light", "dark"] as Theme[]).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="theme"
              value={value}
              checked={theme === value}
              onChange={() => applyTheme(value)}
            />
            {value === "light" ? "Light" : "Dark"}
          </label>
        ))}
      </fieldset>
      <p className="hint">Remembered in this browser only.</p>
    </section>
  );
}

function ExportSection() {
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
      setError(message(err, "The export failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-export">
      <h2 id="settings-export">Export your data</h2>
      <p className="muted">
        A zip with your Markdown notes, tasks and projects in open formats. It is for portability,
        not a backup.
      </p>
      <div className="settings-actions">
        <button type="button" onClick={() => void download()} disabled={busy}>
          {busy ? "Preparing…" : "Download export"}
        </button>
        {done ? <span role="status">Downloaded {done}</span> : null}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function BackupStatus({ info }: { info: InstanceInfo }) {
  const backups = info.backups;
  const latest = backups.latest;
  return (
    <section className="settings-section" aria-labelledby="settings-backups">
      <h2 id="settings-backups">Backups</h2>
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

function InstanceSection({ info }: { info: InstanceInfo }) {
  return (
    <section className="settings-section" aria-labelledby="settings-instance">
      <h2 id="settings-instance">Instance</h2>
      <dl className="settings-facts">
        <div>
          <dt>Atlas version</dt>
          <dd>{info.version}</dd>
        </div>
        <div>
          <dt>Environment</dt>
          <dd>{info.environment}</dd>
        </div>
        <div>
          <dt>Database</dt>
          <dd>{info.database}</dd>
        </div>
        <div>
          <dt>Schema revision</dt>
          <dd>{info.migration_revision ?? "unknown"}</dd>
        </div>
        <div>
          <dt>Web Push</dt>
          <dd>{info.web_push_configured ? "configured" : "not configured"}</dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * Settings (MU-08, journey J7): account, appearance, reminders and notifications, export, backup
 * status and instance information. Every message from the server is shown as the server wrote it.
 */
export function Settings() {
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setInfo(await instanceApi.get());
    } catch (err) {
      setError(message(err, "Could not load the instance information"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="page settings-page">
      <h1>Settings</h1>
      <AccountSection />
      <AppearanceSection />
      <section className="settings-section" aria-labelledby="settings-notifications">
        <h2 id="settings-notifications">Reminders and notifications</h2>
        <NotificationSettings />
      </section>
      <ExportSection />
      {error ? (
        <LoadError message={error} onRetry={() => void load()} />
      ) : info ? (
        <>
          <BackupStatus info={info} />
          <InstanceSection info={info} />
        </>
      ) : (
        <p className="muted" role="status">
          Loading instance information…
        </p>
      )}
    </section>
  );
}
