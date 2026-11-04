// Engine-agnostic scenario for the EXISTING Atlas web UI. The same source runs inside the Tauri/WebKitGTK webview
// (ui/atlas-driver.js) and inside Chromium (scripts/chromium.mjs), so screenshots and facts are comparable.
// h = { shot(name), log(key, value) }.
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const label = (e) => (e.getAttribute("aria-label") || e.textContent || "").trim();
  const visible = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== "hidden";
  const CLICKABLE = "a,button,[role=button],[role=menuitem],[role=tab],[role=option],summary";
  const find = (name, sel = CLICKABLE) => $$(sel).filter(visible).find((e) => label(e) === name) || $$(sel).filter(visible).find((e) => label(e).startsWith(name));
  const waitFor = async (fn, what, ms = 10000) => {
    const t = Date.now();
    while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(50); }
    throw new Error("timeout waiting for " + what);
  };
  const setValue = (el, v) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const click = async (name, sel) => { const e = await waitFor(() => find(name, sel), `"${name}"`); e.click(); await sleep(350); return e; };
  const go = async (path) => {
    const a = $$("a").filter(visible).find((x) => x.getAttribute("href") === path);
    if (a) a.click(); else { history.pushState({}, "", path); dispatchEvent(new PopStateEvent("popstate")); }
    await sleep(700);
  };
  const key = (k, opts = {}) => {
    const t = document.activeElement || document.body;
    t.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
    t.dispatchEvent(new KeyboardEvent("keyup", { key: k, bubbles: true, cancelable: true, ...opts }));
  };
  const rect = (sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; };
  const css = (sel, props) => { const e = document.querySelector(sel); if (!e) return null; const c = getComputedStyle(e); return Object.fromEntries(props.map((p) => [p, c.getPropertyValue(p)])); };

  window.__atlasScenario = async function (h, opts = {}) {
    const size = innerWidth > 720 ? "desktop" : "phone";
    const steps = {};
    const step = async (name, fn) => {
      try { const facts = await fn(); steps[name] = { ok: true, facts: facts ?? null }; }
      catch (e) { steps[name] = { ok: false, error: String(e?.message ?? e) }; }
      try { await sleep(250); await h.shot(`${size}-${name}`); } catch (e) { steps[name].shotError = String(e); }
    };
    await step("login", async () => {
      await waitFor(() => $$("h1,h2").some((e) => /Sign in to Atlas|Today/.test(e.textContent)), "login or Today");
      if (/Sign in to Atlas/.test(document.body.innerText)) {
        setValue(await waitFor(() => $$("input").find((i) => i.type === "email" || /email/i.test(i.name + i.id + (i.labels?.[0]?.textContent ?? ""))), "email input"), opts.email);
        setValue($$("input").find((i) => i.type === "password"), opts.password);
        await sleep(100);
        (await waitFor(() => find("Sign in", "button"), "sign in")).click();
        await waitFor(() => !/Sign in to Atlas/.test(document.body.innerText), "signed in", 15000);
      }
      await sleep(800);
      return { sidebar: rect("nav") };
    });
    await step("today", async () => ({ main: rect("main"), body: css("body", ["font-family", "font-size", "color", "background-color"]) }));
    for (const [name, path] of [["inbox", "/inbox"], ["tasks", "/tasks"], ["week", "/week"], ["projects", "/projects"], ["settings", "/settings"]]) {
      await step(name, async () => { await go(path); return { main: rect("main") }; });
    }
    await step("task-panel", async () => {
      await go("/tasks");
      const row = await waitFor(() => find("Open Task", "button,a"), "a task row");
      row.click(); await sleep(700);
      return { dialogs: $$("[role=dialog]").length, panel: rect("[role=dialog], aside") };
    });
    await step("task-priority-menu", async () => {
      const b = find("Priority", "button,[role=button],summary");
      if (b) { b.click(); await sleep(400); }
      return { popoversOpen: $$(":popover-open").length, menu: $$("[role=listbox],[role=menu]").length, clicked: !!b };
    });
    key("Escape"); await sleep(200);
    await step("project-board", async () => {
      await go("/projects");
      const p = await waitFor(() => find("Launch plan", "a"), "project link");
      p.click(); await sleep(900);
      const board = find("Board", "button,[role=tab],a"); if (board) { board.click(); await sleep(700); }
      return { boardTab: !!board };
    });
    await step("notes-list", async () => { await go("/notes"); await sleep(500); return { main: rect("main") }; });
    await step("note-live", async () => {
      await click("Rich note", "button,a");
      await waitFor(() => document.querySelector(".cm-content"), "CodeMirror content", 15000);
      const live = find("Live", "button");
      if (live) { live.click(); await sleep(500); }
      return { cmContent: rect(".cm-content"), liveStrong: $$(".cm-live-strong").length, hasTable: $$(".cm-content table, .cm-live-table").length, editor: css(".cm-content", ["font-family", "font-size", "line-height"]) };
    });
    await step("note-source", async () => { (await waitFor(() => find("Source", "button"), "Source")).click(); await sleep(500); return { liveStrong: $$(".cm-live-strong").length, text: document.querySelector(".cm-content")?.textContent.includes("**bold**") }; });
    await step("note-preview", async () => { (await waitFor(() => find("Preview", "button"), "Preview")).click(); await sleep(600); return { links: $$("a").length }; });
    await step("note-live-again", async () => { const l = find("Live", "button"); if (l) l.click(); await sleep(500); return null; });
    await step("note-actions-menu", async () => {
      const b = find("Actions for Rich note", "button") || find("Note options", "button") || find("More", "button");
      if (b) b.click();
      await sleep(500);
      return { clicked: !!b, popoversOpen: $$(":popover-open").length, menus: $$("[role=menu]").length };
    });
    key("Escape"); await sleep(250);
    await step("palette", async () => {
      const b = find("Search", "button");
      if (b) b.click(); else key("k", { ctrlKey: true });
      await sleep(600);
      return { dialog: $$("[role=dialog],dialog").length, input: !!document.querySelector("[role=dialog] input, dialog input") };
    });
    key("Escape"); await sleep(250);
    await step("theme-toggled", async () => {
      const b = find("Switch to dark theme", "button") || find("Switch to light theme", "button");
      const before = label(b ?? document.body).slice(0, 40);
      if (b) { b.click(); await sleep(600); }
      return { clicked: !!b, button: before, bg: css("body", ["background-color", "color"]) };
    });
    await step("big-note", async () => {
      await go("/notes");
      await click("Big note", "button,a");
      await waitFor(() => document.querySelector(".cm-content"), "CodeMirror big note", 20000);
      await sleep(800);
      return { lines: $$(".cm-line").length, scroller: !!document.querySelector(".cm-scroller") };
    });
    await step("theme-restored", async () => { const b = find("Switch to dark theme", "button") || find("Switch to light theme", "button"); if (b) b.click(); await sleep(500); return { clicked: !!b }; });
    return { size, steps, ua: navigator.userAgent, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio };
  };

  // Editing latency in the 5 000-line note. Three samples per run, because no single one is the user's experience:
  //  - dispatch: CodeMirror transaction (state + DOM update) via the EditorView found on the DOM node; no browser input path
  //  - input:    document.execCommand("insertText"): goes through beforeinput/input and CodeMirror's DOM observation
  //  - floor:    the same execCommand on a plain contenteditable, to show the engine's own timer/frame floor
  // Real key events, IME composition and caret keys are NOT covered (no native input injection tool installed).
  window.__editorPerf = async function (mode) {
    const content = await waitFor(() => document.querySelector(".cm-content"), "editor");
    const scroller = document.querySelector(".cm-scroller");
    if (mode) { const b = find(mode, "button"); if (b) { b.click(); await sleep(500); } }
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const stats = (xs) => { const s = [...xs].sort((x, y) => x - y); const q = (p) => +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1); return { n: s.length, p50: q(0.5), p95: q(0.95), max: q(1) }; };
    const view = content.cmTile?.view ?? content.cmView?.view;
    const out = { mode: mode ?? "current", docLines: view?.state.doc.lines ?? null };
    if (view) {
      const t = [], s = [], l = [];
      const budget = performance.now() + 12000;
      for (let i = 0; i < 200 && performance.now() < budget; i++) {
        const pos = Math.floor(Math.random() * view.state.doc.length);
        view.dispatch({ selection: { anchor: pos }, scrollIntoView: true }); await frame();
        const a = performance.now();
        view.dispatch({ changes: { from: pos, insert: "x" }, selection: { anchor: pos + 1 } });
        t.push(performance.now() - a);        // synchronous cost of state + DOM update
        content.getBoundingClientRect(); document.body.offsetHeight;
        l.push(performance.now() - a);        // + forced style/layout (not affected by compositor frame callbacks)
        await frame();
        s.push(performance.now() - a);        // until the frame after
      }
      out.dispatch_sync_ms = stats(t); out.dispatch_plus_layout_ms = stats(l); out.dispatch_to_frame_ms = stats(s);
    } else out.dispatch = "EditorView not reachable from the DOM node";
    content.focus();
    const sel = getSelection(), times = [];
    const budget2 = performance.now() + 12000;
    for (let i = 0; i < 100 && performance.now() < budget2; i++) {
      scroller.scrollTop = Math.floor(Math.random() * (scroller.scrollHeight - scroller.clientHeight)); await frame();
      const ls = $$(".cm-line"); const line = ls[Math.floor(ls.length / 2)];
      sel.collapse(line.firstChild ?? line, 0);
      const a = performance.now(); document.execCommand("insertText", false, "x"); await frame(); times.push(performance.now() - a);
    }
    out.input_path_ms = stats(times);
    const ce = document.createElement("div"); ce.contentEditable = "true"; ce.textContent = "floor"; ce.style.cssText = "position:fixed;top:0;left:0;z-index:99999;background:#fff;color:#000";
    document.body.appendChild(ce); ce.focus(); getSelection().collapse(ce.firstChild, 5);
    const fl = [];
    for (let i = 0; i < 100; i++) { const a = performance.now(); document.execCommand("insertText", false, "x"); await frame(); fl.push(performance.now() - a); }
    ce.remove();
    out.plain_contenteditable_floor_ms = stats(fl);
    const undo = [];
    content.focus();
    for (let i = 0; i < 20; i++) { const a = performance.now(); document.execCommand("undo"); await frame(); undo.push(performance.now() - a); }
    out.undo_ms = stats(undo);
    return out;
  };
})();
