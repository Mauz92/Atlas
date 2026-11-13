import { useEffect, useState } from "react";

import {
  desktopApi,
  type AndroidStatus,
  type DesktopInfo,
  type DesktopSnapshot,
} from "../../lib/desktop";
import { formatTime } from "../../lib/settingsFormat";
import {
  gatewayRow,
  lastHintRow,
  liveRow,
  type GatewayFacts,
} from "../../lib/syncUi/instantStatus";
import { InstantUpdates } from "../InstantUpdates";
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
  const [android, setAndroid] = useState<AndroidStatus | null>(null);
  const [keepConnected, setKeepConnected] = useState<boolean | null>(null);
  const [location, setLocation] = useState<{
    kind: "private" | "shared";
    sharedPath: string | null;
    allFilesAccess: boolean;
  } | null>(null);
  const [gateway, setGateway] = useState<{
    facts: GatewayFacts | null;
    failed: boolean;
  }>({ facts: null, failed: false });

  useEffect(() => {
    if (!desktop) return undefined;
    void desktop
      .fetch("/api/devices/current/hint")
      .then(async (r) =>
        r.ok
          ? ((await r.json()) as GatewayFacts)
          : Promise.reject(new Error("hint status")),
      )
      .then((facts) => setGateway({ facts, failed: false }))
      .catch(() => setGateway({ facts: null, failed: true }));
    let active = true;
    void desktop.snapshot().then((s) => active && setSnap(s));
    void desktop.info().then((i) => active && setInfo(i));
    const stop = desktop.subscribe((s) => active && setSnap(s));
    // Android only: what the OS lets reminders do (read again whenever the person comes back from a system screen)
    const readAndroid = () =>
      void desktop.android
        ?.status()
        .then((a) => active && setAndroid(a))
        .catch(() => undefined);
    const readLocation = () =>
      void desktop.notesLocation
        ?.get()
        .then((l) => active && setLocation(l))
        .catch(() => undefined);
    void desktop.android?.keepConnected
      .get()
      .then((v) => active && setKeepConnected(v))
      .catch(() => undefined);
    readAndroid();
    readLocation();
    const refresh = () => {
      readAndroid();
      readLocation();
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("atlas-native-resume", refresh);
    return () => {
      active = false;
      stop();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("atlas-native-resume", refresh);
    };
  }, [desktop]);

  if (!desktop) return null;
  if (!snap) return <p className="muted">Loading…</p>;

  const run = async (label: string, work: () => Promise<unknown>) => {
    setBusy(true);
    setMessage(null);
    try {
      const detail = await work();
      setMessage(typeof detail === "string" ? detail : label); // a task may answer with its own sentence
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  };
  const settings = snap.settings;
  const notes = snap.notes;
  const phone = info?.os === "android" || android !== null;
  const where = phone ? "this phone" : "this computer";

  return (
    <>
      <section className="settings-group" aria-labelledby="desktop-reminders">
        <h3 id="desktop-reminders">Reminders on {where}</h3>
        <SettingsRow
          label="Show reminder notifications"
          htmlFor="desktop-reminders-on"
          description={
            phone
              ? "Atlas sets each reminder with Android's alarm clock, so it is shown on time even when Atlas is closed."
              : "When a task reminder is due, Atlas shows a desktop notification, while the app is running (also in the tray)."
          }
        >
          <input
            id="desktop-reminders-on"
            type="checkbox"
            checked={settings.remindersEnabled}
            disabled={busy}
            onChange={(e) =>
              void run("Saved.", () =>
                desktop.updateSettings({ remindersEnabled: e.target.checked }),
              )
            }
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
            onChange={(e) =>
              void run("Saved.", () =>
                desktop.updateSettings({
                  contentMode: e.target.checked ? "generic" : "full",
                }),
              )
            }
          />
        </SettingsRow>
        <SettingsRow
          label="System permission"
          description={`Notifications are ${PERMISSION_TEXT[snap.notificationPermission] ?? snap.notificationPermission}.${phone ? "" : " Reminders fire only while Atlas is running."}`}
        >
          <span className="settings-actions">
            {snap.notificationPermission !== "granted" ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run("Asked.", () =>
                    desktop.requestNotificationPermission(),
                  )
                }
              >
                Allow
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run("Test notification sent.", () =>
                  desktop.testNotification(),
                )
              }
            >
              Send a test
            </button>
          </span>
        </SettingsRow>
      </section>

      <InstantUpdates
        rows={[
          liveRow("desktop", snap.live),
          lastHintRow(snap.lastHintAt ?? null, Date.now()),
          gatewayRow(gateway.facts, gateway.failed, Date.now()),
        ]}
      />

      {phone && android ? (
        <section
          className="settings-group"
          aria-labelledby="android-reliability"
        >
          <h3 id="android-reliability">Reminder reliability</h3>
          <SettingsRow
            label="Notifications"
            description={
              android.notifications === "granted"
                ? "Android lets Atlas show notifications."
                : "Android is blocking Atlas notifications: reminders will not be seen. Allow them in the system settings (also while Do Not Disturb is on, if you want them then)."
            }
          >
            <button
              type="button"
              onClick={() =>
                void desktop.android?.openSettings("notifications")
              }
            >
              Open settings
            </button>
          </SettingsRow>
          <SettingsRow
            label="Exact alarms"
            description={
              android.exactAlarms
                ? "On: reminders fire at the minute they are due."
                : 'Off: Android may delay reminders by several minutes. Allow "Alarms & reminders" for Atlas.'
            }
          >
            {android.exactAlarms ? (
              <span>On</span>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void desktop.android?.openSettings("exact_alarms")
                }
              >
                Allow
              </button>
            )}
          </SettingsRow>
          <SettingsRow
            label="Battery optimisation"
            description={
              android.ignoringBatteryOptimizations
                ? "Atlas is not limited by battery saving."
                : `Android may stop Atlas in the background to save power${/oneplus|xiaomi|oppo|realme|huawei|honor|vivo|samsung/i.test(android.manufacturer) ? ` (${android.manufacturer} phones are strict about this)` : ""}. Alarms already set still fire, but a change made on another device reaches this phone only when you open Atlas. Set Atlas to "Unrestricted" for the best result.`
            }
          >
            {android.ignoringBatteryOptimizations ? (
              <span>Unrestricted</span>
            ) : (
              <button
                type="button"
                onClick={() => void desktop.android?.openSettings("battery")}
              >
                Open settings
              </button>
            )}
          </SettingsRow>
          <SettingsRow
            label="Keep Atlas connected in the background"
            htmlFor="android-keep-connected"
            description="Off by default. Reminders already set always fire, but changes made on another device reach this phone only while Atlas is running. Turning this on keeps Atlas running with a small permanent notification so they arrive with the screen off or another app in front. It uses some battery; after a restart, open Atlas once."
          >
            <input
              id="android-keep-connected"
              type="checkbox"
              checked={keepConnected ?? false}
              disabled={busy || keepConnected === null}
              onChange={(e) =>
                void run("Saved.", async () => {
                  await desktop.android!.keepConnected.set(e.target.checked);
                  setKeepConnected(await desktop.android!.keepConnected.get());
                })
              }
            />
          </SettingsRow>
        </section>
      ) : null}

      {phone ? null : (
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
              onChange={(e) =>
                void run("Saved.", () =>
                  desktop.updateSettings({ closeToTray: e.target.checked }),
                )
              }
            />
          </SettingsRow>
          <SettingsRow
            label="Start Atlas when I log in"
            htmlFor="desktop-autostart"
            description="Off by default. Atlas then starts in the tray so reminders keep working."
          >
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
      )}

      <section className="settings-group" aria-labelledby="desktop-notes">
        <h3 id="desktop-notes">Notes folder</h3>
        <SettingsRow
          label="Folder"
          description={
            phone
              ? location?.kind === "shared"
                ? "Your notes are ordinary Markdown files in Documents/Atlas Notes on this phone: any editor can open and change them, and Atlas picks the changes up (when you come back to Atlas and every few minutes) and syncs them. Your server keeps the master copy."
                : "Your notes are ordinary Markdown files stored inside Atlas on this phone and kept in sync with your server. Other apps cannot open that folder (keep the notes in a shared folder to change that); your server keeps the master copy."
              : "Notes are ordinary Markdown files here. Edit them with any editor; changes are picked up and synced."
          }
        >
          {phone ? (
            <span className="settings-actions">
              <span>
                {location?.kind === "shared"
                  ? "Documents/Atlas Notes"
                  : "Inside Atlas"}
              </span>
              {desktop.notesLocation && location?.kind === "private" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run("Done.", async () => {
                      if (!location.allFilesAccess) {
                        await desktop.android?.openSettings("all_files");
                        return 'Allow "All files access" for Atlas in the screen that opened, come back here and tap again.';
                      }
                      const done = await desktop.notesLocation!.set("shared");
                      setLocation(await desktop.notesLocation!.get());
                      return `${done.copied + done.identical} notes are now in Documents/Atlas Notes (${done.copied} copied). ${done.archivedAs ? `The old folder was kept as "${done.archivedAs}".` : "The copies inside Atlas were kept."}`;
                    })
                  }
                >
                  Keep notes in a shared folder…
                </button>
              ) : null}
              {desktop.notesLocation && location?.kind === "shared" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run("Done.", async () => {
                      const done = await desktop.notesLocation!.set("private");
                      setLocation(await desktop.notesLocation!.get());
                      return `${done.copied + done.identical} notes are inside Atlas again. ${done.archivedAs ? `The old folder was kept as "${done.archivedAs}".` : "The files in Documents/Atlas Notes were kept."}`;
                    })
                  }
                >
                  Move notes back inside Atlas
                </button>
              ) : null}
              {desktop.exportNotes ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      "The notes are zipped: choose where to send them.",
                      () => desktop.exportNotes!(),
                    )
                  }
                >
                  Export notes…
                </button>
              ) : null}
            </span>
          ) : (
            <span className="settings-actions">
              <code>{notes?.root ?? "not chosen"}</code>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run("Folder chosen.", () => desktop.chooseNotesFolder())
                }
              >
                {notes?.root ? "Change…" : "Choose…"}
              </button>
            </span>
          )}
        </SettingsRow>
        {notes?.lastError ? (
          <p role="alert">
            The folder cannot be read ({notes.lastError}). Nothing was changed.
          </p>
        ) : null}
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
              {snap.sync
                ? `${snap.sync.state}${snap.sync.pending ? `, ${snap.sync.pending} waiting to send` : ""}`
                : snap.phase}
              {snap.live ? ", live" : ""}
            </dd>
          </div>
          <div>
            <dt>Last synced</dt>
            <dd>
              {snap.sync?.lastSyncAt
                ? formatTime(new Date(snap.sync.lastSyncAt).toISOString())
                : "not yet"}
            </dd>
          </div>
          <div>
            <dt>App version</dt>
            <dd>
              {info?.version ?? "…"} ({info?.os ?? "…"})
            </dd>
          </div>
          <div>
            <dt>Automatic updates</dt>
            <dd>
              {info?.updater === "configured"
                ? "configured by this build"
                : "off (install a new version yourself)"}
            </dd>
          </div>
        </dl>
        <p className="settings-actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("Syncing.", () => desktop.syncNow())}
          >
            Sync now
          </button>
          {info?.updater === "configured" ? (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run("Checked for updates.", async () => {
                  const found = await desktop.checkForUpdate(false);
                  if (
                    found.available &&
                    window.confirm(
                      `Install Atlas ${found.available} now? Atlas will restart.`,
                    )
                  )
                    await desktop.checkForUpdate(true);
                  else if (!found.available) setMessage("Atlas is up to date.");
                })
              }
            >
              Check for updates
            </button>
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("Signed out.", () => desktop.signOut())}
          >
            Sign out of this device
          </button>
        </p>
        {snap.sync && snap.sync.pending > 0 ? (
          <p className="muted">
            {snap.sync.pending} change(s) are still waiting to be sent. Signing
            out as another account discards them.
          </p>
        ) : null}
        {message ? <p role="status">{message}</p> : null}
      </section>
    </>
  );
}
