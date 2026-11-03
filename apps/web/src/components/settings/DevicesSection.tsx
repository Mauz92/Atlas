import { useState } from "react";
import type { FormEvent } from "react";

import type { SyncDevice } from "../../api/client";
import { useSyncDevices } from "../../hooks/useSyncDevices";
import { formatTime } from "../../lib/settingsFormat";
import { EmptyState } from "../EmptyState";
import { LoadError } from "../LoadError";
import { Skeleton } from "../Skeleton";

const PLATFORM_LABEL: Record<SyncDevice["platform"], string> = {
  windows: "Windows",
  linux: "Linux",
  macos: "macOS",
  android: "Android",
  ios: "iOS",
  web: "Web",
  other: "Other",
};

type Mode = "view" | "rename" | "confirm";

interface RowProps {
  device: SyncDevice;
  busy: boolean;
  onRename: (device: SyncDevice, name: string) => Promise<boolean>;
  onRevoke: (device: SyncDevice) => Promise<boolean>;
}

/** One device: its facts, "Rename" (inline field) and "Sign out" (asks once, in place). */
function DeviceRow({ device, busy, onRename, onRevoke }: RowProps) {
  const [mode, setMode] = useState<Mode>("view");
  const [name, setName] = useState(device.name);

  async function submitRename(event: FormEvent) {
    event.preventDefault();
    if (name.trim() && (await onRename(device, name))) setMode("view");
  }

  return (
    <li className="device-row" data-current={device.current ? "true" : undefined}>
      <div className="device-main">
        {mode === "rename" ? (
          <form className="device-rename" onSubmit={(event) => void submitRename(event)}>
            <label className="sr-only" htmlFor={`device-name-${device.id}`}>
              Name for {device.name}
            </label>
            <input
              id={`device-name-${device.id}`}
              type="text"
              maxLength={80}
              required
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setName(device.name);
                  setMode("view");
                }
              }}
            />
            <button type="submit" className="primary" disabled={busy || !name.trim()}>
              Save name
            </button>
            <button
              type="button"
              onClick={() => {
                setName(device.name);
                setMode("view");
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <span className="device-name">{device.name}</span>
            {device.current ? <span className="device-current">This device</span> : null}
            <span className="device-facts muted">
              {PLATFORM_LABEL[device.platform]} · {device.last_seen_at ? `Last seen ${formatTime(device.last_seen_at)}` : "Not seen yet"}
            </span>
          </>
        )}
      </div>
      {mode === "view" ? (
        <div className="device-actions">
          <button type="button" aria-label={`Rename ${device.name}`} onClick={() => setMode("rename")} disabled={busy}>
            Rename
          </button>
          <button type="button" className="danger" aria-label={`Sign out ${device.name}`} onClick={() => setMode("confirm")} disabled={busy}>
            Sign out
          </button>
        </div>
      ) : null}
      {mode === "confirm" ? (
        <div className="device-confirm" role="group" aria-label={`Sign out ${device.name}?`}>
          <p>
            Sign out <strong>{device.name}</strong>? It stops syncing at once and must sign in again with your password. Data already on it stays there.
          </p>
          <button
            type="button"
            className="danger"
            aria-label={`Confirm: sign out ${device.name}`}
            disabled={busy}
            onClick={() => void onRevoke(device).then((ok) => ok || setMode("view"))}
          >
            Sign out
          </button>
          <button type="button" onClick={() => setMode("view")}>
            Keep signed in
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Settings → Devices (SYNC-06, ADR-0065): the desktop and phone apps signed in to this server.
 * Devices sign themselves in with the account's e-mail and password; this page never shows or
 * creates a key. The owner can rename a device, sign one out, or sign them all out.
 */
export function DevicesSection() {
  const { devices, error, actionError, notice, busy, reload, rename, revoke, revokeAll } = useSyncDevices();
  const [confirmAll, setConfirmAll] = useState(false);

  if (error) return <LoadError message={error} onRetry={() => void reload()} />;
  if (devices === null) return <Skeleton label="Loading devices" rows={3} kind="line" />;

  return (
    <div className="settings-group devices">
      {devices.length === 0 ? (
        <EmptyState icon="refresh-cw" compact>
          No device is signed in. Install an Atlas app and sign in with your email and password; it appears here.
        </EmptyState>
      ) : (
        <ul className="device-list" aria-label="Signed-in devices">
          {devices.map((device) => (
            <DeviceRow key={device.id} device={device} busy={busy !== null} onRename={rename} onRevoke={revoke} />
          ))}
        </ul>
      )}
      <div className="settings-feedback" aria-live="polite">
        {notice ? <span role="status">{notice}</span> : null}
        {actionError ? (
          <p className="error" role="alert">
            {actionError}
          </p>
        ) : null}
      </div>
      {devices.length > 0 ? (
        confirmAll ? (
          <div className="device-confirm" role="group" aria-label="Sign out all devices?">
            <p>Sign out all {devices.length} devices? Each must sign in again with your password.</p>
            <button
              type="button"
              className="danger"
              aria-label="Confirm: sign out all devices"
              disabled={busy !== null}
              onClick={() => void revokeAll().then(() => setConfirmAll(false))}
            >
              Sign out all
            </button>
            <button type="button" onClick={() => setConfirmAll(false)}>
              Keep them signed in
            </button>
          </div>
        ) : (
          <button type="button" className="danger" onClick={() => setConfirmAll(true)} disabled={busy !== null}>
            Sign out all devices
          </button>
        )
      ) : null}
      <p className="hint">
        Browsers are not listed here. Changing your password signs out your other browsers; tick the box there to sign
        out your devices too. If a device is lost or stolen, sign it out here.
      </p>
    </div>
  );
}
