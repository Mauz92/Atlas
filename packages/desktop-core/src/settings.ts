import type { RowDb } from "./ports.ts";

/** Per-device settings (never synced; SYNC_PROTOCOL 14.6, ADR-0068 Q2 and Q5). */
export interface DesktopSettings {
  /** Fire reminder notifications on this device. */
  remindersEnabled: boolean;
  /** `full`: title shown; `generic`: no task text anywhere (Q5; the desktop has no lock-screen channel, so this is the one switch). */
  contentMode: "full" | "generic";
  /** The close button hides the window and the app keeps running (Q2: default on). */
  closeToTray: boolean;
  /** The first-run question about start-at-login was asked (the answer is the OS autostart entry itself). */
  autostartAsked: boolean;
}

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  remindersEnabled: true,
  contentMode: "full",
  closeToTray: true,
  autostartAsked: false,
};

const KEY = "desktop";

export async function loadSettings(db: RowDb): Promise<DesktopSettings> {
  const raw = await db.get("settings", KEY);
  if (raw === null) return { ...DEFAULT_DESKTOP_SETTINGS };
  try {
    const stored = JSON.parse(raw) as Partial<DesktopSettings>;
    return {
      remindersEnabled: typeof stored.remindersEnabled === "boolean" ? stored.remindersEnabled : DEFAULT_DESKTOP_SETTINGS.remindersEnabled,
      contentMode: stored.contentMode === "generic" ? "generic" : "full",
      closeToTray: typeof stored.closeToTray === "boolean" ? stored.closeToTray : DEFAULT_DESKTOP_SETTINGS.closeToTray,
      autostartAsked: stored.autostartAsked === true,
    };
  } catch {
    return { ...DEFAULT_DESKTOP_SETTINGS };
  }
}

export async function saveSettings(db: RowDb, settings: DesktopSettings): Promise<void> {
  await db.commit([{ op: "put", table: "settings", key: KEY, value: JSON.stringify(settings) }]);
}
