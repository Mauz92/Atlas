import { useEffect, useState } from "react";

import { desktopApi, type DesktopInfo, type DesktopSnapshot } from "../../lib/desktop";
import { formatTime } from "../../lib/settingsFormat";
import { SettingsRow } from "./SettingsRow";

const PERMISSION_TEXT: Record<string, string> = {
  granted: "allowed",
  denied: "blocked by the system",
  prompt: "not asked yet",
  default: "not asked yet",
  unavailable: "not available",
};

/**
 * Settings > Desktop app (SYNC-09d). Rendered only inside the desktop shell (`Settings.tsx` never lists
 * it elsewhere). Everything here is stored on THIS device and never synced: the reminder switch, what a
 * notification shows (ADR-0068 Q5), close-to-tray (Q2), start at log-in, the notes folder and the status
 * of the local sync engine.
 */
export function DesktopSection() {
  const desktop = desktopApi();
  const [snap, setSnap] = useState<DesktopSnapshot | null>(null);
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!desktop) return undefined;
    let active = true;
    void desktop.snapshot().then((s) => active && setSnap(s));
    void desktop.info().then((i) => active && setInfo(i));
    const stop = desktop.subscribe((s) => active && setSnap(s));
    return () => {
      active = false;
      stop();
    };
  }, [desktop]);

  if (!desktop) return null;
  if (!snap) return <p className="muted">Loading…</p>;

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      setMessage(label);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const settings = snap.settings;
  const notes = snap.notes;

  return (
    <>
      <section className="settings-group" aria-labelledby="desktop-reminders">
        <h3 id="desktop-reminders">Reminders on this computer</h3>
        <SettingsRow
          label="Show reminder notifications"
          htmlFor="desktop-reminders-on"
          description="When a task reminder is due, Atlas shows a desktop notification, while the app is running (also in the tray)."
        >
          <input
            id="desktop-reminders-on"
            type="checkbox"
            checked={settings.remindersEnabled}
            disabled={busy}
            onChange={(e) => void run("Saved.", () => desktop.updateSettings({ remindersEnabled: e.target.checked }))}
          />
        </SettingsRow>
        <SettingsRow
          label="Hide the task text in notifications"
          htmlFor="desktop-generic"
          description="Notifications then say only that a reminder is due. Use this if others can see your screen or lock screen."
        >
          <input
            id="desktop-generic"
            type="checkbox"
            checked={settings.contentMode === "generic"}
            disabled={busy}
            onChange={(e) => void run("Saved.", () => desktop.updateSettings({ contentMode: e.target.checked ? "generic" : "full" }))}
          />
        </SettingsRow>
        <SettingsRow
          label="System permission"
          description={`Notifications are ${PERMISSION_TEXT[snap.notificationPermission] ?? snap.notificationPermission}. Reminders fire only while Atlas is running.`}
        >
          <span className="settings-actions">
            {snap.notificationPermission !== "granted" ? (
              <button type="button" disabled={busy} onClick={() => void run("Asked.", () => desktop.requestNotificationPermission())}>
                Allow
              </button>
            ) : null}
            <button type="button" disabled={busy} onClick={() => void run("Test notification sent.", () => desktop.testNotification())}>
              Send a test
            </button>
          </span>
        </SettingsRow>
      </section>

      <section className="settings-group" aria-labelledby="desktop-window">
        <h3 id="desktop-window">Window and start-up</h3>
        <SettingsRow
          label="Keep running in the tray when the window is closed"
          htmlFor="desktop-tray"
          description="The close button then hides the window. Use the tray icon's Quit to stop Atlas; reminders stop with it."
        >
          <input
            id="desktop-tray"
            type="checkbox"
            checked={settings.closeToTray}
            disabled={busy}
            onChange={(e) => void run("Saved.", () => desktop.updateSettings({ closeToTray: e.target.checked }))}
          />
        </SettingsRow>
        <SettingsRow label="Start Atlas when I log in" htmlFor="desktop-autostart" description="Off by default. Atlas then starts in the tray so reminders keep working.">
          <input
            id="desktop-autostart"
            type="checkbox"
            checked={info?.autostart ?? false}
            disabled={busy || !info}
            onChange={(e) =>
              void run("Saved.", async () => {
                await desktop.setAutostart(e.target.checked);
                setInfo(await desktop.info());
              })
            }
          />
        </SettingsRow>
      </section>

      <section className="settings-group" aria-labelledby="desktop-notes">
        <h3 id="desktop-notes">Notes folder</h3>
        <SettingsRow
          label="Folder"
          description="Notes are ordinary Markdown files here. Edit them with any editor; changes are picked up and synced."
        >
          <span className="settings-actions">
            <code>{notes?.root ?? "not chosen"}</code>
            <button type="button" disabled={busy} onClick={() => void run("Folder chosen.", () => desktop.chooseNotesFolder())}>
              {notes?.root ? "Change…" : "Choose…"}
            </button>
          </span>
        </SettingsRow>
        {notes?.lastError ? <p role="alert">The folder cannot be read ({notes.lastError}). Nothing was changed.</p> : null}
        {notes && notes.skipped.length > 0 ? (
          <div>
            <p>{notes.skipped.length} file(s) are left alone and not synced:</p>
            <ul>
              {notes.skipped.slice(0, 20).map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code>: {file.detail}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="settings-group" aria-labelledby="desktop-status">
        <h3 id="desktop-status">This device</h3>
        <dl className="settings-facts">
          <div>
            <dt>Device</dt>
            <dd>{snap.session?.device?.name ?? "unknown"}</dd>
          </div>
          <div>
            <dt>Server</dt>
            <dd>{snap.session?.baseUrl ?? "unknown"}</dd>
          </div>
          <div>
            <dt>Sync</dt>
            <dd>
              {snap.sync ? `${snap.sync.state}${snap.sync.pending ? `, ${snap.sync.pending} waiting to send` : ""}` : snap.phase}
              {snap.live ? ", live" : ""}
            </dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>{snap.sync?.lastSyncAt ? formatTime(new Date(snap.sync.lastSyncAt).toISOString()) : "not yet"}</dd>
          </div>
          <div>
            <dt>App version</dt>
            <dd>
              {info?.version ?? "…"} ({info?.os ?? "…"})
            </dd>
          </div>
          <div>
            <dt>Automatic updates</dt>
            <dd>{info?.updater === "configured" ? "configured by this build" : "off (install a new version yourself)"}</dd>
          </div>
        </dl>
        <p className="settings-actions">
          <button type="button" disabled={busy} onClick={() => void run("Syncing.", () => desktop.syncNow())}>
            Sync now
          </button>
          {info?.updater === "configured" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run("Checked for updates.", async () => {
                  const found = await desktop.checkForUpdate(false);
                  if (found.available && window.confirm(`Install Atlas ${found.available} now? Atlas will restart.`)) await desktop.checkForUpdate(true);
                  else if (!found.available) setMessage("Atlas is up to date.");
                })
              }
            >
              Check for updates
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => void run("Signed out.", () => desktop.signOut())}>
            Sign out of this device
          </button>
        </p>
        {snap.sync && snap.sync.pending > 0 ? (
          <p className="muted">{snap.sync.pending} change(s) are still waiting to be sent. Signing out as another account discards them.</p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
      </section>
    </>
  );
}
