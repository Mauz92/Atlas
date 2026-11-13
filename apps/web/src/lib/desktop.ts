/**
 * The desktop shell's bridge (SYNC-09c/d, ADR-0069), feature-detected.
 *
 * Inside the Atlas desktop app a script injected before the page (`apps/desktop`) defines
 * `window.atlasDesktop`. In a browser it does not exist, and every function here is a no-op that
 * returns `null`/`false`: the web app behaves exactly as before. The bridge has NO token and no
 * file access: `fetch` asks the host to send `/api/...` requests, and the host attaches the device
 * token, which the page can never read.
 */

import type { Resolution } from "../api/client";

export interface DesktopSettings {
  remindersEnabled: boolean;
  contentMode: "full" | "generic";
  closeToTray: boolean;
  autostartAsked: boolean;
}

/** The engine's halt, as the shell reports it (SYNC_PROTOCOL 7.4, 8.1). */
export type DesktopHalt =
  | { kind: "update_required"; min: number | null; max: number | null }
  | { kind: "signed_out"; code: string }
  | {
      kind: "restore_confirmation";
      reason: "epoch_mismatch" | "cursor_ahead";
      epoch: string | null;
      head: number | null;
    };

export interface DesktopSyncStatus {
  state: string;
  halt?: DesktopHalt | null;
  pending: number;
  failed: number;
  conflicts: number;
  lastSyncAt: number | null;
  online: boolean;
  cursor?: number;
}

/** A write the server refused or only partly applied, kept by the engine until the person dismisses it. */
export interface DesktopProblem {
  id: string;
  kind: "failed" | "conflict";
  reason: string;
  status: number | null;
  code: string | null;
  action: string;
  entityType: string;
  entityId: string;
  at: number;
  detail: string | null;
  conflicts: {
    field: string;
    reason: string;
    serverRevision: number | null;
    theirs: unknown;
    mine: unknown;
  }[];
  copy: { id: string; path: string } | null;
}

export type DesktopUndoAnswer =
  { status: number; body: unknown } | { queued: true };

export interface DesktopSyncApi {
  resolutions(): Promise<Resolution[]>;
  problems(): Promise<DesktopProblem[]>;
  dismissProblem(id: string): Promise<void>;
  undo(resolutionId: string): Promise<DesktopUndoAnswer>;
  confirmRestore(): Promise<void>;
  discardLocal(): Promise<void>;
  resolveText(problemId: string, field: string, text: string): Promise<void>;
  resumeAfterUpdate(): Promise<void>;
}

export interface DesktopSnapshot {
  phase: "starting" | "signed_out" | "running" | "update_required" | "failed";
  reason: string | null;
  session: {
    signedIn: boolean;
    baseUrl: string | null;
    device: { id: string; name: string } | null;
    keystoreError: string | null;
  } | null;
  sync: DesktopSyncStatus | null;
  notes: {
    root: string | null;
    lastScanAt: number | null;
    lastError: string | null;
    skipped: { path: string; reason: string; detail: string }[];
    counts: Record<string, number>;
  } | null;
  settings: DesktopSettings;
  live: boolean;
  lastHintAt?: number | null;
  notificationPermission: string;
}

export interface DesktopInfo {
  version: string;
  os: string;
  autostart: boolean;
  updater: "not_configured" | "configured";
}

/** What Android lets Atlas reminders do (the shell's `android` object; `null` on a computer). */
export interface AndroidStatus {
  notifications: "granted" | "denied" | "prompt";
  exactAlarms: boolean;
  ignoringBatteryOptimizations: boolean;
  allFilesAccess?: boolean;
  manufacturer: string;
  sdk: number;
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
  testNotification(): Promise<{
    shownNow: boolean;
    scheduledAt: number | null;
  }>;
  requestNotificationPermission(): Promise<string>;
  setAutostart(enabled: boolean): Promise<void>;
  signOut(): Promise<void>;
  /** The engine verbs of the conflict, notice and restore screens (SYNC-11c). */
  sync: DesktopSyncApi;
  /** Android only: zip the notes and open the share sheet (the phone's notes folder is private to the app). */
  exportNotes?: (() => Promise<{ files: number; bytes: number }>) | null;
  /** Android only; `null` on a computer. */
  /** Android only: where the notes live (`private` inside the app, `shared` in Documents/Atlas Notes) and moving them (copy, then switch). */
  notesLocation?: {
    get(): Promise<{
      kind: "private" | "shared";
      sharedPath: string | null;
      allFilesAccess: boolean;
    }>;
    set(kind: "private" | "shared"): Promise<{
      copied: number;
      identical: number;
      switched: boolean;
      archivedAs?: string | null;
    }>;
  } | null;
  android?: {
    status(): Promise<AndroidStatus>;
    openSettings(
      which: "app" | "notifications" | "battery" | "exact_alarms" | "all_files",
    ): Promise<void>;
    /** Optional background mode (a foreground service); off by default. */
    keepConnected: { get(): Promise<boolean>; set(on: boolean): Promise<void> };
  } | null;
  /** Updates exist only in a build with the `updater` feature; otherwise this rejects with `not_configured`. */
  checkForUpdate(
    install: boolean,
  ): Promise<{ available: string | null; installed?: boolean }>;
}

declare global {
  interface Window {
    atlasDesktop?: AtlasDesktopApi;
  }
}

/** The bridge, or `null` in a browser. */
export function desktopApi(): AtlasDesktopApi | null {
  return typeof window !== "undefined" && window.atlasDesktop
    ? window.atlasDesktop
    : null;
}

export function isDesktopShell(): boolean {
  return desktopApi() !== null;
}

/** The shell on an Android phone (the user agent says so before any command can). */
export function isAndroidShell(): boolean {
  return (
    isDesktopShell() &&
    typeof navigator !== "undefined" &&
    /Android/i.test(navigator.userAgent)
  );
}
