import { DesktopRuntime } from "../../../packages/desktop-core/src/index.ts";
import { createBridge, toResponse } from "./bridge.ts";
import { createTauriPlatform, type HostEnv, type TauriGlobal } from "./tauriPlatform.ts";

/** A fake `window.__TAURI__`: records every invoke and lets a test emit host events. */
function fakeTauri() {
  const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = [];
  const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const answers: Record<string, unknown> = {};
  const tauri: TauriGlobal = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (!(command in answers)) throw new Error(`no answer for ${command}`);
        const a = answers[command];
        return (typeof a === "function" ? (a as (x?: unknown) => unknown)(args) : a) as T;
      },
    },
    event: {
      listen: async <T>(name: string, handler: (e: { payload: T }) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), handler as never]);
        return () => listeners.set(name, (listeners.get(name) ?? []).filter((h) => h !== (handler as never)));
      },
    },
  };
  return { tauri, calls, answers, emit: (name: string, payload: unknown) => (listeners.get(name) ?? []).forEach((h) => h({ payload })), listeners };
}

function env(tauri: TauriGlobal, navigated: string[] = []): HostEnv {
  return {
    tauri,
    setTimeout: (fn, ms) => Number(setTimeout(fn, ms)),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => Number(setInterval(fn, ms)),
    clearInterval: (id) => clearInterval(id),
    now: () => 1_800_000_000_000,
    performanceNow: () => 5,
    timezoneOffsetMinutes: () => 60,
    randomUUID: () => "uuid",
    randomFloat: () => 0.5,
    sha256: async () => "hash",
    navigate: (u) => void navigated.push(u),
  };
}

describe("the Tauri adapter maps each port method to one command", () => {
  it("database, session, folder and window ports", async () => {
    const f = fakeTauri();
    Object.assign(f.answers, {
      db_open: { schemaVersion: 1 }, db_get: null, db_list: [], db_commit: null, session_info: { signedIn: false },
      folder_write: { result: "written", hash: "h" }, folder_scan: [], folder_rename: "renamed", folder_trash: "trashed",
      notify_permission: "granted", window_show: null, app_quit: null,
    });
    const nav: string[] = [];
    const p = createTauriPlatform(env(f.tauri, nav));
    await p.db.open();
    await p.db.get("meta", "cursor");
    await p.db.commit([{ op: "del", table: "meta", key: "x" }]);
    await p.folder.write("a.md", "t", null);
    await p.folder.write("a.md", "t", "abc");
    await p.folder.rename("a.md", "b.md", "abc");
    await p.folder.trash("b.md", "abc");
    await p.folder.scan(true);
    await p.notifier.permission();
    await p.lifecycle.gotoSignIn("signed_out");
    await p.lifecycle.gotoSignIn(null);
    expect(f.calls.map((c) => c.command)).toEqual([
      "db_open", "db_get", "db_commit", "folder_write", "folder_write", "folder_rename", "folder_trash", "folder_scan", "notify_permission",
    ]);
    expect(f.calls[1]!.args).toEqual({ table: "meta", key: "cursor" });
    expect(f.calls[3]!.args).toEqual({ path: "a.md", content: "t", expected: { kind: "absent" } });
    expect(f.calls[4]!.args).toEqual({ path: "a.md", content: "t", expected: { kind: "hash", hash: "abc" } });
    expect(f.calls[5]!.args).toEqual({ from: "a.md", to: "b.md", expectedHash: "abc" });
    expect(nav).toEqual(["/welcome.html?reason=signed_out", "/welcome.html"]);
  });

  it("host events reach the listeners and unlisten works", async () => {
    const f = fakeTauri();
    const p = createTauriPlatform(env(f.tauri));
    const seen: string[] = [];
    const off = p.tray.onMenu((i) => seen.push(i));
    const offFolder = p.folder.onChange(() => seen.push("folder"));
    await Promise.resolve();
    f.emit("atlas-tray", "open");
    f.emit("atlas-folder-changed", null);
    off();
    f.emit("atlas-tray", "sync_now");
    offFolder();
    expect(seen).toEqual(["open", "folder"]);
  });

  it("there is no command that could return the token", async () => {
    const f = fakeTauri();
    const p = createTauriPlatform(env(f.tauri));
    const methods = [...Object.values(p.session), ...Object.values(p.http)].map((m) => String(m));
    expect(methods.join("")).not.toMatch(/token_get|get_token|token/i);
  });
});

describe("the bridge", () => {
  it("answers a 204 without a body and keeps status and headers", async () => {
    const r = toResponse({ status: 204, headers: { "x-a": "1" }, body: "" });
    expect(r.status).toBe(204);
    expect(r.headers.get("x-a")).toBe("1");
    expect(await toResponse({ status: 200, headers: {}, body: '{"a":1}' }).json()).toEqual({ a: 1 });
  });

  it("fetch sends a path and string body through the host and tells the runtime about a 401", async () => {
    const f = fakeTauri();
    Object.assign(f.answers, {
      db_open: { schemaVersion: 1 }, db_get: null, db_list: [], db_commit: null,
      session_info: { signedIn: true, baseUrl: "https://a.example", device: { id: "d", name: "n" }, keystoreError: null },
      tray_set_close_to_tray: null, notify_permission: "granted", session_clear: null,
      api_request: (a: { req: { path: string } }) => ({ status: a.req.path.startsWith("/api/revoked") ? 401 : 200, headers: { "content-type": "application/json" }, body: "{}" }),
    });
    const nav: string[] = [];
    const platform = createTauriPlatform(env(f.tauri, nav));
    const runtime = new DesktopRuntime(platform, { tickMs: 1_000_000, schedulerTickMs: 1_000_000, fullScanMs: 1_000_000, liveWaitSeconds: 1 });
    const bridge = createBridge(platform, runtime, (c, a) => f.tauri.core.invoke(c, a));
    const ok = await bridge.fetch("/api/tasks", { method: "post", body: "{}", headers: { "Content-Type": "application/json" } });
    expect(ok.status).toBe(200);
    const sent = f.calls.find((c) => c.command === "api_request")!.args as { req: { method: string; path: string; headers: Record<string, string>; body: string } };
    expect(sent.req).toMatchObject({ method: "POST", path: "/api/tasks", body: "{}" });
    await expect(bridge.fetch("/api/x", { body: new FormData() })).rejects.toThrow(/text bodies/);
    const gone = await bridge.fetch("/api/revoked");
    expect(gone.status).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.some((c) => c.command === "session_clear")).toBe(true);
    expect(nav).toContain("/welcome.html?reason=signed_out");
  });

  it("exposes the engine verbs of the conflict, notice and restore screens, and refuses them while signed out (SYNC-11c)", async () => {
    const f = fakeTauri();
    Object.assign(f.answers, {
      db_open: { schemaVersion: 1 }, db_get: null, db_list: [], db_commit: null,
      session_info: { signedIn: false, baseUrl: null, device: null, keystoreError: null },
      tray_set_close_to_tray: null, notify_permission: "granted",
    });
    const platform = createTauriPlatform(env(f.tauri, []));
    const runtime = new DesktopRuntime(platform, { tickMs: 1_000_000, schedulerTickMs: 1_000_000, fullScanMs: 1_000_000, liveWaitSeconds: 1 });
    const bridge = createBridge(platform, runtime, (c, a) => f.tauri.core.invoke(c, a));
    expect(Object.keys(bridge.sync).sort()).toEqual(
      ["confirmRestore", "discardLocal", "dismissProblem", "problems", "resolutions", "resolveText", "resumeAfterUpdate", "undo"],
    );
    await runtime.start();
    await expect(bridge.sync.resolutions()).rejects.toThrow(/not signed in/);
    await expect(bridge.sync.discardLocal()).rejects.toThrow(/not signed in/);
  });
});
