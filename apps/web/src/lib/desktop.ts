/**
 * The desktop shell's bridge (SYNC-09c/d, ADR-0069), feature-detected.
 *
 * Inside the Atlas desktop app a script injected before the page (`apps/desktop`) defines
 * `window.atlasDesktop`. In a browser it does not exist, and every function here is a no-op that
 * returns `null`/`false`: the web app behaves exactly as before. The bridge has NO token and no
 * file access: `fetch` asks the host to send `/api/...` requests, and the host attaches the device
 * token, which the page can never read.
 */

export interface DesktopSettings {
  remindersEnabled: boolean;
  contentMode: "full" | "generic";
  closeToTray: boolean;
  autostartAsked: boolean;
}

export interface DesktopSnapshot {
  phase: "starting" | "signed_out" | "running" | "update_required" | "failed";
  reason: string | null;
  session: { signedIn: boolean; baseUrl: string | null; device: { id: string; name: string } | null; keystoreError: string | null } | null;
  sync: { state: string; pending: number; failed: number; conflicts: number; lastSyncAt: number | null; online: boolean } | null;
  notes: {
    root: string | null;
    lastScanAt: number | null;
    lastError: string | null;
    skipped: { path: string; reason: string; detail: string }[];
    counts: Record<string, number>;
  } | null;
  settings: DesktopSettings;
  live: boolean;
  notificationPermission: string;
}

export interface DesktopInfo {
  version: string;
  os: string;
  autostart: boolean;
  updater: "not_configured" | "configured";
}

export interface AtlasDesktopApi {
  /** `/api/...` request through the host (which attaches the device token). */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  snapshot(): Promise<DesktopSnapshot>;
  subscribe(listener: (snapshot: DesktopSnapshot) => void): () => void;
  info(): Promise<DesktopInfo>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  chooseNotesFolder(): Promise<string | null>;
  syncNow(): Promise<void>;
  testNotification(): Promise<{ shownNow: boolean; scheduledAt: number | null }>;
  requestNotificationPermission(): Promise<string>;
  setAutostart(enabled: boolean): Promise<void>;
  signOut(): Promise<void>;
  /** Updates exist only in a build with the `updater` feature; otherwise this rejects with `not_configured`. */
  checkForUpdate(install: boolean): Promise<{ available: string | null; installed?: boolean }>;
}

declare global {
  interface Window {
    atlasDesktop?: AtlasDesktopApi;
  }
}

/** The bridge, or `null` in a browser. */
export function desktopApi(): AtlasDesktopApi | null {
  return typeof window !== "undefined" && window.atlasDesktop ? window.atlasDesktop : null;
}

export function isDesktopShell(): boolean {
  return desktopApi() !== null;
}
