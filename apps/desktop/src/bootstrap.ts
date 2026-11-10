/**
 * Loaded by every page of the shell (`/atlas-desktop.js`, a classic script bundled by esbuild). It builds the
 * platform adapter, the runtime and `window.atlasDesktop`, and starts the runtime. Page logic lives elsewhere:
 * the web UI in `apps/web`, the sign-in page in `welcome.ts`, the sync/notes/reminder policy in `desktop-core`.
 */
import { DesktopRuntime } from "../../../packages/desktop-core/src/index.ts";
import { createBridge } from "./bridge.ts";
import { browserHostEnv, createTauriPlatform, type TauriGlobal } from "./tauriPlatform.ts";

const win = window as Window & typeof globalThis & { __TAURI__?: TauriGlobal; atlasDesktop?: unknown; atlasDesktopReady?: Promise<unknown> };

if (win.__TAURI__) {
  const env = browserHostEnv(win as Window & typeof globalThis & { __TAURI__: TauriGlobal });
  const platform = createTauriPlatform(env);
  const runtime = new DesktopRuntime(platform, {
    logger: { debug() {}, info() {}, warn: (e, f) => console.warn(e, f), error: (e, f) => console.error(e, f) },
  });
  const bridge = createBridge(platform, runtime, (command, args) => env.tauri.core.invoke(command, args));
  win.atlasDesktop = bridge;
  // the runtime keeps running while the window is hidden in the tray: this page must stay loaded
  win.atlasDesktopReady = bridge.start().then((snapshot) => {
    const onWelcome = location.pathname === "/welcome.html";
    if (snapshot.phase === "signed_out" && !onWelcome) location.replace("/welcome.html");
    if (snapshot.phase === "update_required" && !onWelcome) location.replace("/welcome.html?reason=update_required");
    return snapshot;
  });
  // a 401/426 seen by the host on a web-UI request (not by the engine)
  void env.tauri.event.listen<number>("atlas-auth", (e) => {
    if (e.payload === 401) void runtime.noteUnauthorized();
    else if (e.payload === 426) void runtime.noteUpdateRequired();
  });
}
