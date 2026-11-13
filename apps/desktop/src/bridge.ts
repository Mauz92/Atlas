import {
  DesktopRuntime,
  type DesktopSettings,
  type RuntimeSnapshot,
  type SignInResult,
  type UndoAnswer,
} from "../../../packages/desktop-core/src/index.ts";
import type {
  Problem,
  ResolutionRecord,
} from "../../../packages/sync-core/src/index.ts";
import type {
  AlarmStatus,
  PlatformPort,
} from "../../../packages/desktop-core/src/index.ts";

/** The `window.atlasDesktop` object (typed in `apps/web/src/lib/desktop.ts`; the sign-in page uses the extras). */
export interface Bridge {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  snapshot(): Promise<RuntimeSnapshot>;
  subscribe(listener: (s: RuntimeSnapshot) => void): () => void;
  info(): Promise<{
    version: string;
    os: string;
    autostart: boolean;
    updater: "not_configured" | "configured";
  }>;
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
  checkForUpdate(
    install: boolean,
  ): Promise<{ available: string | null; installed?: boolean }>;
  /** The few engine verbs the conflict, notice and restore screens use (SYNC-11c). The page never gets the engine. */
  sync: {
    resolutions(): Promise<ResolutionRecord[]>;
    problems(): Promise<Problem[]>;
    dismissProblem(id: string): Promise<void>;
    undo(resolutionId: string): Promise<UndoAnswer>;
    confirmRestore(): Promise<void>;
    discardLocal(): Promise<void>;
    resolveText(problemId: string, field: string, text: string): Promise<void>;
    resumeAfterUpdate(): Promise<void>;
  };
  /** Android only (`null` elsewhere): zip the notes and open the share sheet. */
  exportNotes: (() => Promise<{ files: number; bytes: number }>) | null;
  /** Android only (`null` elsewhere): where the notes live, and moving them (copy, then switch). */
  notesLocation: NonNullable<PlatformPort["folder"]["place"]> | null;
  /** Android only (`null` elsewhere): what the OS lets reminders do, and shortcuts to the system screens that change it. */
  android: {
    status(): Promise<AlarmStatus>;
    openSettings(
      which: "app" | "notifications" | "battery" | "exact_alarms" | "all_files",
    ): Promise<void>;
    keepConnected: { get(): Promise<boolean>; set(on: boolean): Promise<void> };
  } | null;
  // used by the sign-in page only
  signIn(input: {
    baseUrl: string;
    email: string;
    password: string;
    deviceName: string;
  }): Promise<SignInResult>;
  start(): Promise<RuntimeSnapshot>;
  answerAutostart(enable: boolean): Promise<void>;
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/** Turn the host's answer into a real `Response` (a 204 must not carry a body). */
export function toResponse(r: {
  status: number;
  headers: Record<string, string>;
  body: string;
}): Response {
  return new Response(NULL_BODY.has(r.status) ? null : r.body, {
    status: r.status,
    headers: r.headers,
  });
}

const FORWARD_BODY_TYPES = ["string", "undefined"];

/**
 * Build the bridge over a runtime and a platform. `fetch` is the web app's only way to reach the server:
 * path (never a URL), method, headers, string body; a 401 or 426 also tells the runtime (signed out /
 * update required) so the shell leaves the app page.
 */
export function createBridge(
  platform: PlatformPort,
  runtime: DesktopRuntime,
  call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>,
): Bridge {
  return {
    async fetch(path, init = {}) {
      if (!FORWARD_BODY_TYPES.includes(typeof init.body))
        throw new TypeError("the desktop bridge sends text bodies only");
      if (init.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const headers: Record<string, string> = {};
      new Headers(init.headers).forEach((value, key) => (headers[key] = value));
      const response = await platform.http.request({
        method: (init.method ?? "GET").toUpperCase() as "GET",
        path,
        headers,
        ...(typeof init.body === "string" ? { body: init.body } : {}),
      });
      if (response.status === 401) void runtime.noteUnauthorized();
      if (response.status === 426) void runtime.noteUpdateRequired();
      return toResponse(response);
    },
    snapshot: () => runtime.snapshot(),
    subscribe: (l) => runtime.subscribe(l),
    info: async () => {
      const info = await call<{
        version: string;
        os: string;
        updater: "not_configured" | "configured";
      }>("app_info");
      return {
        ...info,
        autostart: await platform.autostart.isEnabled().catch(() => false),
      };
    },
    updateSettings: (patch) => runtime.updateSettings(patch),
    chooseNotesFolder: () => runtime.chooseNotesFolder(),
    syncNow: () => runtime.syncNow(),
    testNotification: () => runtime.testNotification(),
    requestNotificationPermission: () =>
      runtime.requestNotificationPermission(),
    setAutostart: (enabled) => platform.autostart.setEnabled(enabled),
    signOut: () =>
      runtime.signOut().then(() => platform.lifecycle.gotoSignIn(null)),
    checkForUpdate: (install) => call("update_check", { install }),
    sync: {
      resolutions: () => runtime.uiResolutions(),
      problems: () => runtime.uiProblems(),
      dismissProblem: (id) => runtime.uiDismissProblem(id),
      undo: (id) => runtime.uiUndo(id),
      confirmRestore: () => runtime.uiConfirmRestore(),
      discardLocal: () => runtime.uiDiscardLocal(),
      resolveText: (problemId, field, text) =>
        runtime.uiResolveText(problemId, field, text),
      resumeAfterUpdate: () => runtime.uiResumeAfterUpdate(),
    },
    notesLocation: platform.folder.place ?? null,
    exportNotes: platform.folder.export
      ? () => platform.folder.export!()
      : null,
    android: platform.alarms
      ? {
          status: () => platform.alarms!.status(),
          openSettings: (which) => platform.alarms!.openSettings(which),
          keepConnected: platform.alarms.keepConnected,
        }
      : null,
    signIn: (input) => runtime.signIn(input),
    start: () => runtime.start(),
    answerAutostart: (enable) => runtime.answerAutostart(enable),
  };
}
