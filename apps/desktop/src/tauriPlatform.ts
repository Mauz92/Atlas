/**
 * The Tauri adapter of the platform port (SYNC-09, ADR-0069): the ONLY file that knows Tauri command names.
 * Every method is one `invoke`. An Electron host would replace this file (and `src-tauri`) and nothing else.
 */
import type {
  CryptoPort,
  DbOp,
  FolderEntry,
  HttpPort,
  HttpPortRequest,
  HttpPortResponse,
  LifecyclePort,
  NotesFolderPort,
  NotifierPort,
  NotifyPermission,
  PlatformPort,
  RenameResult,
  RowDb,
  SessionInfo,
  SessionPort,
  SignInResult,
  Table,
  TimerPort,
  TrashResult,
  TrayPort,
  WriteResult,
  AutostartPort,
} from "../../../packages/desktop-core/src/index.ts";

/** What `window.__TAURI__` (with `withGlobalTauri`) offers. */
export interface TauriGlobal {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: { listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void> };
}

export interface HostEnv {
  tauri: TauriGlobal;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(id: number): void;
  now(): number;
  performanceNow(): number;
  timezoneOffsetMinutes(at: number): number;
  randomUUID(): string;
  randomFloat(): number;
  sha256(text: string): Promise<string>;
  navigate(url: string): void;
}

/** Subscribe to a host event; the unlisten function is available once the promise resolves. */
function listen<T>(tauri: TauriGlobal, name: string, handler: (payload: T) => void): () => void {
  let stop: (() => void) | null = null;
  let cancelled = false;
  void tauri.event.listen<T>(name, (e) => handler(e.payload)).then((unlisten) => {
    if (cancelled) unlisten();
    else stop = unlisten;
  });
  return () => {
    cancelled = true;
    stop?.();
  };
}

export function createTauriPlatform(env: HostEnv): PlatformPort {
  const call = <T>(command: string, args?: Record<string, unknown>) => env.tauri.core.invoke<T>(command, args);

  const db: RowDb = {
    open: () => call<{ schemaVersion: number }>("db_open"),
    get: (table: Table, key: string) => call<string | null>("db_get", { table, key }),
    list: (table: Table) => call<string[]>("db_list", { table }),
    commit: (ops: DbOp[]) => call<void>("db_commit", { ops }),
  };

  const http: HttpPort = {
    request: (req: HttpPortRequest) => call<HttpPortResponse>("api_request", { req }),
  };

  const session: SessionPort = {
    signIn: (args) => call<SignInResult>("session_sign_in", { args }),
    info: () => call<SessionInfo>("session_info"),
    clear: () => call<void>("session_clear"),
    signOut: () => call<void>("session_sign_out"),
  };

  const folder: NotesFolderPort = {
    root: () => call<string | null>("folder_root"),
    choose: () => call<string | null>("folder_choose"),
    scan: (full: boolean) => call<FolderEntry[]>("folder_scan", { full }),
    read: (path: string) => call<string>("folder_read", { path }),
    write: (path: string, content: string, expectedHash: string | null) =>
      call<WriteResult>("folder_write", { path, content, expected: expectedHash === null ? { kind: "absent" } : { kind: "hash", hash: expectedHash } }),
    rename: (from: string, to: string, expectedHash: string) => call<RenameResult>("folder_rename", { from, to, expectedHash }),
    trash: (path: string, expectedHash: string) => call<TrashResult>("folder_trash", { path, expectedHash }),
    onChange: (listener) => listen<null>(env.tauri, "atlas-folder-changed", () => listener()),
  };

  const notifier: NotifierPort = {
    permission: () => call<NotifyPermission>("notify_permission"),
    requestPermission: () => call<NotifyPermission>("notify_request_permission"),
    show: (input) => call<void>("notify_show", { title: input.title, body: input.body }),
  };

  const tray: TrayPort = {
    setCloseToTray: (enabled) => call<void>("tray_set_close_to_tray", { enabled }),
    setStatus: (text) => call<void>("tray_set_status", { text }),
    onMenu: (listener) => listen<"open" | "sync_now">(env.tauri, "atlas-tray", listener),
  };

  const autostart: AutostartPort = {
    isEnabled: () => call<boolean>("autostart_is_enabled"),
    setEnabled: (enabled) => call<void>("autostart_set_enabled", { enabled }),
  };

  const lifecycle: LifecyclePort = {
    onWake: (listener) => listen<null>(env.tauri, "atlas-wake", () => listener()),
    showWindow: () => call<void>("window_show"),
    gotoSignIn: async (reason) => env.navigate(reason ? `/welcome.html?reason=${reason}` : "/welcome.html"),
    quit: () => call<void>("app_quit"),
  };

  const timers: TimerPort = {
    setTimeout: (fn, ms) => {
      const id = env.setTimeout(fn, ms);
      return () => env.clearTimeout(id);
    },
    setInterval: (fn, ms) => {
      const id = env.setInterval(fn, ms);
      return () => env.clearInterval(id);
    },
    monotonic: () => env.performanceNow(),
    wallTime: () => env.now(),
    utcOffsetMinutes: (at) => env.timezoneOffsetMinutes(at),
  };

  const crypto: CryptoPort = {
    uuid: () => env.randomUUID(),
    random: () => env.randomFloat(),
    sha256: (text) => env.sha256(text),
  };

  return { db, http, session, folder, notifier, tray, autostart, lifecycle, timers, crypto };
}

/** `HostEnv` for a real webview. */
export function browserHostEnv(win: Window & typeof globalThis & { __TAURI__: TauriGlobal }): HostEnv {
  return {
    tauri: win.__TAURI__,
    setTimeout: (fn, ms) => win.setTimeout(fn, ms),
    clearTimeout: (id) => win.clearTimeout(id),
    setInterval: (fn, ms) => win.setInterval(fn, ms),
    clearInterval: (id) => win.clearInterval(id),
    now: () => Date.now(),
    performanceNow: () => win.performance.now(),
    timezoneOffsetMinutes: (at) => -new Date(at).getTimezoneOffset(),
    randomUUID: () => win.crypto.randomUUID(),
    randomFloat: () => win.crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296,
    sha256: async (text) => {
      const digest = await win.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    navigate: (url) => win.location.replace(url),
  };
}
