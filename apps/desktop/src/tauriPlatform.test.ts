import { DesktopRuntime } from "../../../packages/desktop-core/src/index.ts";
import { createBridge, toResponse } from "./bridge.ts";
import {
  createTauriPlatform,
  type HostEnv,
  type TauriGlobal,
} from "./tauriPlatform.ts";

/** A fake `window.__TAURI__`: records every invoke and lets a test emit host events. */
function fakeTauri() {
  const calls: Array<{
    command: string;
    args: Record<string, unknown> | undefined;
  }> = [];
  const listeners = new Map<string, Array<(e: { payload: unknown }) => void>>();
  const answers: Record<string, unknown> = {};
  const tauri: TauriGlobal = {
    core: {
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        if (!(command in answers)) throw new Error(`no answer for ${command}`);
        const a = answers[command];
        return (
          typeof a === "function" ? (a as (x?: unknown) => unknown)(args) : a
        ) as T;
      },
    },
    event: {
      listen: async <T>(name: string, handler: (e: { payload: T }) => void) => {
        listeners.set(name, [...(listeners.get(name) ?? []), handler as never]);
        return () =>
          listeners.set(
            name,
            (listeners.get(name) ?? []).filter((h) => h !== (handler as never)),
          );
      },
    },
  };
  return {
    tauri,
    calls,
    answers,
    emit: (name: string, payload: unknown) =>
      (listeners.get(name) ?? []).forEach((h) => h({ payload })),
    listeners,
  };
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
      db_open: { schemaVersion: 1 },
      db_get: null,
      db_list: [],
      db_commit: null,
      session_info: { signedIn: false },
      folder_write: { result: "written", hash: "h" },
      folder_scan: [],
      folder_rename: "renamed",
      folder_trash: "trashed",
      notify_permission: "granted",
      window_show: null,
      app_quit: null,
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
      "db_open",
      "db_get",
      "db_commit",
      "folder_write",
      "folder_write",
      "folder_rename",
      "folder_trash",
      "folder_scan",
      "notify_permission",
    ]);
    expect(f.calls[1]!.args).toEqual({ table: "meta", key: "cursor" });
    expect(f.calls[3]!.args).toEqual({
      path: "a.md",
      content: "t",
      expected: { kind: "absent" },
    });
    expect(f.calls[4]!.args).toEqual({
      path: "a.md",
      content: "t",
      expected: { kind: "hash", hash: "abc" },
    });
    expect(f.calls[5]!.args).toEqual({
      from: "a.md",
      to: "b.md",
      expectedHash: "abc",
    });
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
    const methods = [...Object.values(p.session), ...Object.values(p.http)].map(
      (m) => String(m),
    );
    expect(methods.join("")).not.toMatch(/token_get|get_token|token/i);
  });
});

describe("the bridge", () => {
  it("answers a 204 without a body and keeps status and headers", async () => {
    const r = toResponse({ status: 204, headers: { "x-a": "1" }, body: "" });
    expect(r.status).toBe(204);
    expect(r.headers.get("x-a")).toBe("1");
    expect(
      await toResponse({ status: 200, headers: {}, body: '{"a":1}' }).json(),
    ).toEqual({ a: 1 });
  });

  it("fetch sends a path and string body through the host and tells the runtime about a 401", async () => {
    const f = fakeTauri();
    Object.assign(f.answers, {
      db_open: { schemaVersion: 1 },
      db_get: null,
      db_list: [],
      db_commit: null,
      session_info: {
        signedIn: true,
        baseUrl: "https://a.example",
        device: { id: "d", name: "n" },
        keystoreError: null,
      },
      tray_set_close_to_tray: null,
      notify_permission: "granted",
      session_clear: null,
      api_request: (a: { req: { path: string } }) => ({
        status: a.req.path.startsWith("/api/revoked") ? 401 : 200,
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    });
    const nav: string[] = [];
    const platform = createTauriPlatform(env(f.tauri, nav));
    const runtime = new DesktopRuntime(platform, {
      tickMs: 1_000_000,
      schedulerTickMs: 1_000_000,
      fullScanMs: 1_000_000,
      liveWaitSeconds: 1,
    });
    const bridge = createBridge(platform, runtime, (c, a) =>
      f.tauri.core.invoke(c, a),
    );
    const ok = await bridge.fetch("/api/tasks", {
      method: "post",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    expect(ok.status).toBe(200);
    const sent = f.calls.find((c) => c.command === "api_request")!.args as {
      req: {
        method: string;
        path: string;
        headers: Record<string, string>;
        body: string;
      };
    };
    expect(sent.req).toMatchObject({
      method: "POST",
      path: "/api/tasks",
      body: "{}",
    });
    await expect(
      bridge.fetch("/api/x", { body: new FormData() }),
    ).rejects.toThrow(/text bodies/);
    const gone = await bridge.fetch("/api/revoked");
    expect(gone.status).toBe(401);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.some((c) => c.command === "session_clear")).toBe(true);
    expect(nav).toContain("/welcome.html?reason=signed_out");
  });

  it("exposes the engine verbs of the conflict, notice and restore screens, and refuses them while signed out (SYNC-11c)", async () => {
    const f = fakeTauri();
    Object.assign(f.answers, {
      db_open: { schemaVersion: 1 },
      db_get: null,
      db_list: [],
      db_commit: null,
      session_info: {
        signedIn: false,
        baseUrl: null,
        device: null,
        keystoreError: null,
      },
      tray_set_close_to_tray: null,
      notify_permission: "granted",
    });
    const platform = createTauriPlatform(env(f.tauri, []));
    const runtime = new DesktopRuntime(platform, {
      tickMs: 1_000_000,
      schedulerTickMs: 1_000_000,
      fullScanMs: 1_000_000,
      liveWaitSeconds: 1,
    });
    const bridge = createBridge(platform, runtime, (c, a) =>
      f.tauri.core.invoke(c, a),
    );
    expect(Object.keys(bridge.sync).sort()).toEqual([
      "confirmRestore",
      "discardLocal",
      "dismissProblem",
      "problems",
      "resolutions",
      "resolveText",
      "resumeAfterUpdate",
      "undo",
    ]);
    await runtime.start();
    await expect(bridge.sync.resolutions()).rejects.toThrow(/not signed in/);
    await expect(bridge.sync.discardLocal()).rejects.toThrow(/not signed in/);
  });
});

describe("the Android additions of the Tauri adapter (ADR-0075)", () => {
  it("a desktop platform has no alarm port; an Android one maps each method to one command", async () => {
    const f = fakeTauri();
    expect(createTauriPlatform(env(f.tauri)).alarms).toBeUndefined();
    Object.assign(f.answers, {
      alarm_schedule: null,
      alarm_cancel: null,
      alarm_list: [{ id: 5, at: 1 }],
      alarm_delivered: [5],
      alarm_clear_shown: null,
      android_status: {
        notifications: "granted",
        exactAlarms: true,
        ignoringBatteryOptimizations: false,
        manufacturer: "OnePlus",
        sdk: 34,
      },
      android_open_settings: null,
      android_take_launch_task: "t1",
      notify_show: null,
    });
    const p = createTauriPlatform(env(f.tauri), { android: true });
    const alarm = {
      id: 5,
      at: 9,
      title: "T",
      body: "B",
      taskId: "t1",
      key: "k",
    };
    await p.alarms!.schedule(alarm);
    await p.alarms!.cancel(5);
    expect(await p.alarms!.list()).toEqual([{ id: 5, at: 1 }]);
    expect(await p.alarms!.delivered()).toEqual([5]);
    await p.alarms!.clearShown([5]);
    expect((await p.alarms!.status()).exactAlarms).toBe(true);
    await p.alarms!.openSettings("battery");
    expect(await p.alarms!.takeLaunchTask()).toBe("t1");
    await p.notifier.show({ title: "x", body: "y", tag: "key" });
    expect(f.calls.map((c) => c.command)).toEqual([
      "alarm_schedule",
      "alarm_cancel",
      "alarm_list",
      "alarm_delivered",
      "alarm_clear_shown",
      "android_status",
      "android_open_settings",
      "android_take_launch_task",
      "notify_show",
    ]);
    expect(f.calls[0]!.args).toEqual({ alarm });
    expect(f.calls[6]!.args).toEqual({ which: "battery" });
    expect(f.calls[8]!.args).toEqual({ title: "x", body: "y", tag: "key" });
  });

  it("coming back to the front counts as a wake-up on Android, and only there", async () => {
    const f = fakeTauri();
    let visible: (() => void) | null = null;
    const e = {
      ...env(f.tauri),
      onVisible: (l: () => void) => {
        visible = l;
        return () => {
          visible = null;
        };
      },
    };
    let wakes = 0;
    const phone = createTauriPlatform(e, { android: true });
    const stop = phone.lifecycle.onWake(() => wakes++);
    visible!();
    expect(wakes).toBe(1);
    stop();
    expect(visible).toBeNull();
    visible = (() => wakes++) as never;
    createTauriPlatform(e).lifecycle.onWake(() => wakes++); // a desktop does not listen to page visibility
    expect(visible).not.toBeNull();
  });

  it("the bridge exposes the Android object only when the platform has alarms", async () => {
    const f = fakeTauri();
    Object.assign(f.answers, {
      android_status: {
        notifications: "denied",
        exactAlarms: false,
        ignoringBatteryOptimizations: false,
        manufacturer: "X",
        sdk: 31,
      },
      android_open_settings: null,
    });
    const mk = (android: boolean) => {
      const p = createTauriPlatform(env(f.tauri), { android });
      return createBridge(p, new DesktopRuntime(p, {}), (c, a) =>
        f.tauri.core.invoke(c, a),
      );
    };
    expect(mk(false).android).toBeNull();
    const b = mk(true);
    expect((await b.android!.status()).notifications).toBe("denied");
    await b.android!.openSettings("exact_alarms");
    expect(f.calls.at(-1)).toEqual({
      command: "android_open_settings",
      args: { which: "exact_alarms" },
    });
  });
});

describe("the notes export of the Tauri adapter", () => {
  it("exists only on Android and is one command", async () => {
    const f = fakeTauri();
    Object.assign(f.answers, { notes_export: { files: 2, bytes: 100 } });
    expect(createTauriPlatform(env(f.tauri)).folder.export).toBeUndefined();
    const p = createTauriPlatform(env(f.tauri), { android: true });
    expect(await p.folder.export!()).toEqual({ files: 2, bytes: 100 });
    expect(f.calls.at(-1)).toEqual({
      command: "notes_export",
      args: undefined,
    });
    const bridge = createBridge(p, new DesktopRuntime(p, {}), (c, a) =>
      f.tauri.core.invoke(c, a),
    );
    expect(await bridge.exportNotes!()).toEqual({ files: 2, bytes: 100 });
    expect(
      createBridge(
        createTauriPlatform(env(f.tauri)),
        new DesktopRuntime(createTauriPlatform(env(f.tauri)), {}),
        (c, a) => f.tauri.core.invoke(c, a),
      ).exportNotes,
    ).toBeNull();
  });
});

describe("the notes place and the background mode of the Tauri adapter (ADR-0075 D4, D7)", () => {
  it("each is one command, Android only", async () => {
    const f = fakeTauri();
    Object.assign(f.answers, {
      notes_location_get: {
        kind: "private",
        sharedPath: "/s",
        allFilesAccess: false,
      },
      notes_location_set: {
        copied: 1,
        identical: 0,
        switched: true,
        archivedAs: "notes (previous 1)",
      },
      keep_connected_get: false,
      keep_connected_set: null,
    });
    expect(createTauriPlatform(env(f.tauri)).folder.place).toBeUndefined();
    const p = createTauriPlatform(env(f.tauri), { android: true });
    expect((await p.folder.place!.get()).kind).toBe("private");
    expect((await p.folder.place!.set("shared")).switched).toBe(true);
    expect(await p.alarms!.keepConnected.get()).toBe(false);
    await p.alarms!.keepConnected.set(true);
    expect(f.calls.map((c) => c.command)).toEqual([
      "notes_location_get",
      "notes_location_set",
      "keep_connected_get",
      "keep_connected_set",
    ]);
    expect(f.calls[1]!.args).toEqual({ kind: "shared" });
    expect(f.calls[3]!.args).toEqual({ on: true });
  });
});
