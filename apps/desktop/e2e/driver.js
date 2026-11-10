// Injected into every page of the e2e build (ATLAS_E2E_SCRIPT). Drives the REAL pages: it types into the sign-in form
// and clicks its buttons; everything after that is the app's own code. It reports to the orchestrator through
// `e2e_report` (files) and obeys `command.json` (forwarded by the host as the `e2e-command` event).
(() => {
  const CFG = __E2E_CONFIG__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const T = () => window.__TAURI__;
  const notifyCalls = [];
  const errors = [];
  window.addEventListener("error", (e) => errors.push(String(e.message)));
  window.addEventListener("unhandledrejection", (e) => errors.push("unhandled: " + String(e.reason)));

  async function waitFor(fn, ms = 30000, step = 100) {
    const end = Date.now() + ms;
    for (;;) {
      try { const v = await fn(); if (v) return v; } catch {}
      if (Date.now() > end) return null;
      await sleep(step);
    }
  }
  async function main() {
    await waitFor(() => T() && T().core && window.atlasDesktop, 30000);
    const invoke0 = T().core.invoke.bind(T().core);
    T().core.invoke = (cmd, args) => { if (cmd === "notify_show") notifyCalls.push({ at: Date.now(), title: args.title, body: args.body }); return invoke0(cmd, args); };
    const report = (name, value) => invoke0("e2e_report", { name, value }).catch(() => {});
    const page = location.pathname;
    await report("page-" + Date.now(), { page, search: location.search });

    if (CFG.updaterOnly) {
      // the updater test: no server involved; ask the host to check and install, report the outcome
      const out = { current: (await window.atlasDesktop.info()).version };
      try { out.result = await window.atlasDesktop.checkForUpdate(true); } catch (e) { out.error = String(e); }
      await report("update-result", out);
      return;
    }
    if (page === "/welcome.html") {
      const snap = await window.atlasDesktopReady;
      await report("welcome", { phase: snap.phase, reason: snap.reason, urlReason: new URLSearchParams(location.search).get("reason"), notice: document.getElementById("notice").textContent, visibleForm: !document.getElementById("form").hidden });
      if (snap.phase === "signed_out" && CFG.signIn) {
        const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
        set("server", CFG.baseUrl); set("email", CFG.email); set("password", CFG.password); set("device", CFG.deviceName);
        if (CFG.chooseFolder) { document.getElementById("choose").click(); await waitFor(() => document.getElementById("folder").textContent !== "not chosen (you can choose it later in Settings)", 10000); }
        await report("welcome-filled", { folder: document.getElementById("folder").textContent });
        document.getElementById("form").requestSubmit();
        await sleep(8000);
        await report("welcome-after-submit", { error: document.getElementById("error").textContent, path: location.pathname }); // only reached when sign-in did NOT navigate away
      }
      return;
    }

    // the app page (or any later page): publish status regularly and obey commands
    const status = async () => {
      let win = null;
      try { win = await invoke0("e2e_window_state"); } catch {}
      const snap = await window.atlasDesktop.snapshot();
      await report("status", { t: Date.now(), page: location.pathname, snap, win, notifyCalls, errors, rootChildren: document.getElementById("root")?.children.length ?? null });
    };
    const commands = {
      async close_window() { await invoke0("e2e_close_window"); },
      async tray_open() { await invoke0("e2e_tray", { item: "open" }); },
      async ui_probe() {
        const out = { rootText: (document.getElementById("root")?.innerText || "").slice(0, 300), title: document.title };
        for (const p of ["/api/auth/me", "/api/tasks", "/api/notes", "/api/projects", "/api/instance"]) {
          const r = await window.atlasDesktop.fetch(p);
          out[p] = r.status;
        }
        out.serviceWorker = "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).length : "n/a";
        out.directFetchBlocked = await fetch("http://127.0.0.1:1/").then(() => false, () => true);
        out.tokenInStorage = JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes("Bearer") || document.cookie.includes("atlas");
        const keys = Object.keys(window.__TAURI__.core || {});
        out.tauriKeys = keys;
        try { await invoke0("token_get"); out.tokenCommandExists = true; } catch (e) { out.tokenCommandExists = false; out.tokenCommandError = String(e).slice(0, 120); }
        try { await invoke0("folder_scan", { full: false }); out.folderScanAllowed = true; } catch (e) { out.folderScanAllowed = String(e).slice(0, 80); }
        try { await invoke0("e2e_window_state"); out.e2eAllowedInThisBuild = true; } catch { out.e2eAllowedInThisBuild = false; }
        const refused = async (cmd, args) => { try { await invoke0(cmd, args); return false; } catch (e) { return String(e).slice(0, 100); } };
        out.fsPluginDenied = await refused("plugin:fs|read_text_file", { path: "/etc/hostname" });
        out.shellPluginDenied = await refused("plugin:shell|execute", { program: "id" });
        out.readAbsoluteRefused = await refused("folder_read", { path: "/etc/hostname" });
        out.readTraversalRefused = await refused("folder_read", { path: "../../etc/hostname" });
        out.writeTraversalRefused = await refused("folder_write", { path: "../escape.md", content: "x", expected: { kind: "absent" } });
        out.writeHiddenRefused = await refused("folder_write", { path: ".git/config", content: "x", expected: { kind: "absent" } });
        out.dbUnknownTableRefused = await refused("db_get", { table: "sqlite_master", key: "x" });
        out.apiOtherPathRefused = await refused("api_request", { req: { method: "GET", path: "//evil.example/api/x", headers: {} } });
        await report("ui-probe", out);
      },
      async settings_page() {
        history.pushState({}, "", "/settings/desktop"); window.dispatchEvent(new PopStateEvent("popstate"));
        await sleep(1500);
        await report("settings-desktop", { text: (document.getElementById("root")?.innerText || "").slice(0, 4000) });
      },
      async goto(c) { history.pushState({}, "", c.path); window.dispatchEvent(new PopStateEvent("popstate")); await sleep(1200); },
      async page_text() { await report("page-text", { t: Date.now(), path: location.pathname, text: (document.getElementById("root")?.innerText || "").slice(0, 8000) }); },
      async click(c) {
        const name = (el) => (el.getAttribute("aria-label") || el.textContent || "").trim();
        const el = [...document.querySelectorAll("button, a")].find((e) => name(e).startsWith(c.name) && !e.disabled);
        if (!el) throw new Error("no enabled control starting with: " + c.name);
        el.click();
        await sleep(300);
      },
      async set_settings() { await window.atlasDesktop.updateSettings(CFG.pendingSettings || {}); },
      async autostart(c) { await window.atlasDesktop.setAutostart(!!c.enabled); await report("autostart-state", { enabled: (await window.atlasDesktop.info()).autostart }); },
      async sign_out() { await window.atlasDesktop.signOut(); },
      async sync_now() { await window.atlasDesktop.syncNow(); },
    };
    void T().event.listen("e2e-command", async (e) => {
      const c = e.payload;
      try { await commands[c.cmd](c); await report("command-" + c.cmd, { ok: true, at: Date.now() }); }
      catch (err) { await report("command-" + c.cmd, { ok: false, error: String(err) }); }
    });
    for (;;) { await status(); await sleep(500); }
  }
  void main();
})();
