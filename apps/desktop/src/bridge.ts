import { DesktopRuntime, type DesktopSettings, type RuntimeSnapshot, type SignInResult } from "../../../packages/desktop-core/src/index.ts";
import type { PlatformPort } from "../../../packages/desktop-core/src/index.ts";

/** The `window.atlasDesktop` object (typed in `apps/web/src/lib/desktop.ts`; the sign-in page uses the extras). */
export interface Bridge {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  snapshot(): Promise<RuntimeSnapshot>;
  subscribe(listener: (s: RuntimeSnapshot) => void): () => void;
  info(): Promise<{ version: string; os: string; autostart: boolean; updater: "not_configured" | "configured" }>;
  updateSettings(patch: Partial<DesktopSettings>): Promise<DesktopSettings>;
  chooseNotesFolder(): Promise<string | null>;
  syncNow(): Promise<void>;
  testNotification(): Promise<{ shownNow: boolean; scheduledAt: number | null }>;
  requestNotificationPermission(): Promise<string>;
  setAutostart(enabled: boolean): Promise<void>;
  signOut(): Promise<void>;
  checkForUpdate(install: boolean): Promise<{ available: string | null; installed?: boolean }>;
  // used by the sign-in page only
  signIn(input: { baseUrl: string; email: string; password: string; deviceName: string }): Promise<SignInResult>;
  start(): Promise<RuntimeSnapshot>;
  answerAutostart(enable: boolean): Promise<void>;
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/** Turn the host's answer into a real `Response` (a 204 must not carry a body). */
export function toResponse(r: { status: number; headers: Record<string, string>; body: string }): Response {
  return new Response(NULL_BODY.has(r.status) ? null : r.body, { status: r.status, headers: r.headers });
}

const FORWARD_BODY_TYPES = ["string", "undefined"];

/**
 * Build the bridge over a runtime and a platform. `fetch` is the web app's only way to reach the server:
 * path (never a URL), method, headers, string body; a 401 or 426 also tells the runtime (signed out /
 * update required) so the shell leaves the app page.
 */
export function createBridge(platform: PlatformPort, runtime: DesktopRuntime, call: <T>(command: string, args?: Record<string, unknown>) => Promise<T>): Bridge {
  return {
    async fetch(path, init = {}) {
      if (!FORWARD_BODY_TYPES.includes(typeof init.body)) throw new TypeError("the desktop bridge sends text bodies only");
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
      const info = await call<{ version: string; os: string; updater: "not_configured" | "configured" }>("app_info");
      return { ...info, autostart: await platform.autostart.isEnabled().catch(() => false) };
    },
    updateSettings: (patch) => runtime.updateSettings(patch),
    chooseNotesFolder: () => runtime.chooseNotesFolder(),
    syncNow: () => runtime.syncNow(),
    testNotification: () => runtime.testNotification(),
    requestNotificationPermission: () => runtime.requestNotificationPermission(),
    setAutostart: (enabled) => platform.autostart.setEnabled(enabled),
    signOut: () => runtime.signOut().then(() => platform.lifecycle.gotoSignIn(null)),
    checkForUpdate: (install) => call("update_check", { install }),
    signIn: (input) => runtime.signIn(input),
    start: () => runtime.start(),
    answerAutostart: (enable) => runtime.answerAutostart(enable),
  };
}
