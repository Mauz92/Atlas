// Injected (initialization script) into the "atlas" window that loads the existing web UI from the local stack.
// It runs ui/scenario.js, takes WebKitGTK snapshots through the Rust `snapshot` command, measures editing latency,
// and tries commands the window must NOT be allowed to call (capability isolation of a remote origin).
(function () {
  if (window.top !== window || !/^http:\/\/127\.0\.0\.1/.test(location.href) || window.__driverStarted) return;
  window.__driverStarted = true;
  const params = new URLSearchParams(location.hash.slice(1));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    while (!window.__TAURI_INTERNALS__ || typeof window.__atlasScenario !== "function") await sleep(100);
    const inv = (c, a) => window.__TAURI_INTERNALS__.invoke(c, a);
    const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 160) }; } };
    const email = params.get("email"), password = params.get("password");
    const size = innerWidth > 720 ? "desktop" : "phone";
    const result = {};
    try {
      result.scenario = await window.__atlasScenario({ shot: (n) => inv("snapshot", { name: n.replace(/^(desktop|phone)-/, "$1-webkit-") }), log() {} }, { email, password });
      if (size === "desktop") {
        // open the big note
        const open = [...document.querySelectorAll("a,button")].find((e) => (e.textContent || "").trim() === "Notes");
        open?.click(); await sleep(700);
        [...document.querySelectorAll("button,a")].find((e) => (e.getAttribute("aria-label") || e.textContent || "").trim() === "Big note")?.click();
        const t = Date.now();
        while (!document.querySelector(".cm-content") && Date.now() - t < 20000) await sleep(100);
        result.perf = {};
        for (const mode of ["Live", "Source"]) result.perf[mode] = await window.__editorPerf(mode);
      }
    } catch (e) { result.crashed = String(e?.stack ?? e); }
    // Commands the remote origin was NOT granted, and ones it was.
    result.acl = {
      origin: location.origin,
      token_exists: await attempt(() => inv("token_exists")),
      db_open: await attempt(() => inv("db_open", { path: "/tmp/x.db" })),
      api_request: await attempt(() => inv("api_request", { req: { method: "GET", url: "http://127.0.0.1:1/", headers: {}, body: null } })),
      fs_read: await attempt(() => inv("plugin:fs|read_text_file", { path: "/etc/hostname" })),
      window_eval_probe: await attempt(() => inv("window_eval_probe")),
      ctx: await attempt(() => inv("ctx").then((c) => !!c)),
    };
    await inv("report", { name: `scenario-webkit-${size}`, value: result });
    if (!params.has("hold")) await inv("exit_app");
  })();
})();
