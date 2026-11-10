// End-to-end run of the REAL desktop app against a THROWAWAY Atlas API (SYNC-09, docs/TESTING.md section 13).
//
//   node e2e/run.mjs [path-to-e2e-binary]
//
// Everything is created here and removed at the end: database `atlas_desktop_<hex>` in the existing Postgres container's
// server (never `atlas` / `atlas_test`, enforced by db_admin.py), an API on a free loopback port (services/api/.venv), a
// loopback proxy that can be switched off to make the app "offline", temp data/notes directories, a throwaway keystore
// entry. It never touches the owner's dev stack, server or tailnet. The app window opens on the current display.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const apiDir = path.join(root, "services/api");
const venv = path.join(apiDir, ".venv/bin");
const binary = process.argv[2] ?? path.resolve(here, "../target/debug/atlas-desktop");
const adminUrl = process.env.ATLAS_E2E_ADMIN_DATABASE_URL ?? "postgresql://atlas:atlas@127.0.0.1:5432/postgres";
const resultsDir = path.join(here, "results");
mkdirSync(resultsDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, result: "PASS", ms: Date.now() - t0, detail: detail ?? null });
    log("PASS", name, detail ? JSON.stringify(detail).slice(0, 200) : "");
  } catch (e) {
    results.push({ name, result: "FAIL", ms: Date.now() - t0, detail: String(e?.message ?? e) });
    log("FAIL", name, String(e?.message ?? e));
  }
}
async function until(what, fn, ms = 60000, every = 250) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}${last instanceof Error ? ": " + last.message : ""}`);
    await sleep(every);
  }
}
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sh = (cmd, args, env = process.env, cwd = apiDir) => { const r = spawnSync(cmd, args, { env, encoding: "utf8", cwd }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr || r.stdout}`); return r.stdout; };

const run = { cleanup: [] };
let SyncEngine, createFetchTransport, MemoryStore;
async function loadSyncCore() {
  const dir = mkdtempSync(path.join(tmpdir(), "atlas-desktop-bundle-"));
  run.cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "sync-core.mjs");
  await build({ entryPoints: [path.join(here, "second-client-entry.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "error" });
  ({ SyncEngine, createFetchTransport, MemoryStore } = await import(outfile));
}
const dbName = `atlas_desktop_${randomBytes(5).toString("hex")}`;
const svc = `atlas-e2e-${randomBytes(4).toString("hex")}`;
const owner = { email: "e2e-owner@example.com", password: "e2e-throwaway-password-1", display_name: "E2E Owner" };
let xdgConfig;
let apiPort, proxyPort, apiProc, app, dbus, notesDir, dataDir, outDir, proxy;
let proxyOffline = false;
const conns = new Set();

// ---------------------------------------------------------------------------------------------------------------------
async function startStack() {
  sh(path.join(venv, "python"), [path.join(here, "db_admin.py"), "create", adminUrl, dbName]);
  run.cleanup.push(() => sh(path.join(venv, "python"), [path.join(here, "db_admin.py"), "drop", adminUrl, dbName]));
  const serverNotes = mkdtempSync(path.join(tmpdir(), "atlas-desktop-server-notes-"));
  run.cleanup.push(() => rmSync(serverNotes, { recursive: true, force: true }));
  apiPort = await freePort();
  const u = new URL(adminUrl); u.pathname = `/${dbName}`;
  const env = {
    ...process.env, ATLAS_ENV: "test", DATABASE_URL: u.toString().replace(/^postgresql:/, "postgresql+psycopg:"),
    NOTES_ROOT: serverNotes, BACKUP_DIR: path.join(serverNotes, "backups"), EXPORT_DIR: path.join(serverNotes, "exports"),
    PUBLIC_BASE_URL: `http://127.0.0.1:${apiPort}`, AUTH_RATE_LIMIT_PER_MINUTE: "1000",
    CORS_ORIGINS: "", // the desktop app needs NO CORS configuration: its requests are sent by the host, not by the page
  };
  sh(path.join(venv, "atlas-migrate"), [], env);
  const logFd = openSync(path.join(resultsDir, "api.log"), "w");
  apiProc = spawn(path.join(venv, "python"), ["-m", "uvicorn", "atlas.main:app", "--host", "127.0.0.1", "--port", String(apiPort)], { cwd: apiDir, env, stdio: ["ignore", logFd, logFd] });
  run.cleanup.push(() => apiProc.kill("SIGTERM"));
  await until("API", async () => (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok, 60000);
  const r = await fetch(`http://127.0.0.1:${apiPort}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  if (r.status !== 201) throw new Error("setup failed " + r.status + (await r.text()));
  // a loopback proxy in front of the API: the app talks to it, and "offline" is a switch
  proxyPort = await freePort();
  proxy = net.createServer((client) => {
    if (proxyOffline) return client.destroy();
    const up = net.connect(apiPort, "127.0.0.1");
    conns.add(client); conns.add(up);
    client.pipe(up); up.pipe(client);
    const done = () => { client.destroy(); up.destroy(); conns.delete(client); conns.delete(up); };
    client.on("error", done); up.on("error", done); client.on("close", done); up.on("close", done);
  });
  await new Promise((res) => proxy.listen(proxyPort, "127.0.0.1", res));
  run.cleanup.push(() => { proxy.close(); for (const c of conns) c.destroy(); });
}
function setOffline(off) { proxyOffline = off; if (off) for (const c of conns) c.destroy(); }

// a second, simulated client: the real sync-core engine in node against the real API (direct, not through the proxy)
async function secondClient(name) {
  const base = `http://127.0.0.1:${apiPort}`;
  const r = await fetch(`${base}/api/devices`, { method: "POST", headers: { "content-type": "application/json", "atlas-sync": "1" }, body: JSON.stringify({ email: owner.email, password: owner.password, name, platform: "other" }) });
  if (r.status !== 201) throw new Error("second device sign-in failed " + r.status);
  const { token, device } = await r.json();
  const engine = new SyncEngine({
    store: new MemoryStore(),
    transport: createFetchTransport({ baseUrl: base, fetch: (url, init) => fetch(url, init) }),
    clock: { monotonic: () => performance.now(), wallTime: () => Date.now() },
    ids: { uuid: () => crypto.randomUUID() }, random: { next: () => Math.random() },
    credentials: { getToken: () => token },
    options: { reminders: true, deviceId: device.id, pullIntervalMs: 1_000_000, pullJitterMs: 0 },
  });
  const sync = async () => { engine.requestPull(); await engine.syncUntilSettled(400); };
  return { engine, sync, token, device, base };
}
async function noteByPath(client, p) { return (await client.engine.views()).find((v) => v.type === "note" && !v.deleted && v.fields.path === p); }

async function sessionLogin() {
  const base = `http://127.0.0.1:${apiPort}`;
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: owner.email, password: owner.password }) });
  if (!r.ok) throw new Error("login " + r.status);
  const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
  const csrf = decodeURIComponent((cookies.find((c) => c.startsWith("atlas_csrf=")) ?? "").split("=")[1] ?? "");
  return (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { ...(init.headers ?? {}), cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" } });
}


// drive the page: send a command and wait for the page to report it done (a fresh report, not an old one)
async function drive(cmd, args = {}, ms = 30000) {
  const t0 = Date.now();
  command({ cmd, ...args });
  const r = await until(`command ${cmd}`, () => { const x = report(`command-${cmd}`); return x && x.at >= t0 ? x : null; }, ms, 200);
  if (!r.ok) throw new Error(`${cmd}: ${r.error}`);
}
async function pageText() {
  const t0 = Date.now();
  await drive("page_text");
  return (await until("page text", () => { const x = report("page-text"); return x && x.t >= t0 ? x : null; }, 10000, 200)).text;
}
const restoreServer = () => sh(path.join(venv, "python"), ["-m", "atlas.auth.cli", "record-restore"], { ...process.env, ATLAS_ENV: "test", DATABASE_URL: dbUrl() });
function dbUrl() { const u = new URL(adminUrl); u.pathname = `/${dbName}`; return u.toString().replace(/^postgresql:/, "postgresql+psycopg:"); }

// ---------------------------------------------------------------------------------------------------------------------
const statusFile = () => path.join(outDir, "status.json");
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const status = () => { try { return readJson(statusFile()); } catch { return null; } };
const report = (name) => { try { return readJson(path.join(outDir, `${name}.json`)); } catch { return null; } };
const command = (cmd) => writeFileSync(path.join(outDir, "command.json"), JSON.stringify(cmd));
const pss = (pid) => { try { const m = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/Pss:\s+(\d+) kB/); return m ? Number(m[1]) : 0; } catch { return 0; } };
const children = (pid) => { try { return readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); } catch { return []; } };
const tree = (pid) => [pid, ...children(pid).flatMap(tree)];
const files = (dir) => { const out = {}; const walk = (d, rel = "") => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith(".")) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p, rel + e.name + "/"); else out[rel + e.name] = readFileSync(p, "utf8"); } }; walk(dir); return out; };

async function main() {
  if (!existsSync(binary)) throw new Error(`binary not found: ${binary} (build with scripts/build-linux.sh e2e)`);
  notesDir = mkdtempSync(path.join(tmpdir(), "atlas-desktop-notes-")); run.cleanup.push(() => rmSync(notesDir, { recursive: true, force: true }));
  dataDir = mkdtempSync(path.join(tmpdir(), "atlas-desktop-data-")); run.cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  outDir = mkdtempSync(path.join(tmpdir(), "atlas-desktop-out-")); run.cleanup.push(() => rmSync(outDir, { recursive: true, force: true }));
  // The app runs with a throwaway HOME so that its autostart entry (the plugin ignores XDG_CONFIG_HOME) and WebKit's caches never land in the owner's home.
  xdgConfig = mkdtempSync(path.join(tmpdir(), "atlas-desktop-home-")); run.cleanup.push(() => rmSync(xdgConfig, { recursive: true, force: true }));
  const realAutostart = path.join(process.env.HOME, ".config/autostart");
  const realBefore = existsSync(realAutostart) ? readdirSync(realAutostart).sort().join(",") : "";
  let seeder, other;
  await loadSyncCore();

  await step("stack: throwaway database, API, proxy", async () => { await startStack(); return { db: dbName, apiPort, proxyPort }; });
  if (results.at(-1).result !== "PASS") return;

  await step("seed: a note and a task created by another device before the desktop exists", async () => {
    seeder = await secondClient("e2e seeder");
    await seeder.engine.createNote("seed/from-server.md", "# Seed\nwritten on the server side\n");
    await seeder.engine.createEntity("task", { title: "seed task", description: null, due_at: null, status: "inbox" });
    await seeder.sync();
    return { pending: (await seeder.engine.getStatus()).pending };
  });

  // the driver
  const cfg = { signIn: true, baseUrl: `http://127.0.0.1:${proxyPort}`, email: owner.email, password: owner.password, deviceName: "E2E Linux desktop", chooseFolder: true };
  const driverPath = path.join(outDir, "driver.js");
  writeFileSync(driverPath, readFileSync(path.join(here, "driver.js"), "utf8").replace("__E2E_CONFIG__", JSON.stringify(cfg)));
  dbus = spawn("dbus-monitor", ["--session", "type='method_call',interface='org.freedesktop.Notifications',member='Notify'"], { stdio: ["ignore", "pipe", "ignore"] });
  let dbusText = ""; dbus.stdout.on("data", (d) => (dbusText += d)); run.cleanup.push(() => dbus.kill());

  const launched = Date.now();
  app = spawn(binary, [], {
    stdio: ["ignore", openSync(path.join(resultsDir, "app.log"), "w"), openSync(path.join(resultsDir, "app.log"), "a")],
    env: { ...process.env, ATLAS_DESKTOP_DATA_DIR: dataDir, ATLAS_E2E_OUT: outDir, ATLAS_E2E_NOTES_ROOT: notesDir, ATLAS_E2E_SCRIPT: driverPath, ATLAS_KEYSTORE_SERVICE: svc, HOME: xdgConfig, XDG_CONFIG_HOME: path.join(xdgConfig, ".config"), XDG_DATA_HOME: path.join(xdgConfig, ".local/share"), XDG_CACHE_HOME: path.join(xdgConfig, ".cache") },
  });
  run.cleanup.push(() => { try { app.kill("SIGKILL"); } catch {} });

  await step("launch: the sign-in page opens (signed out, form visible)", async () => {
    const w = await until("welcome report", () => report("welcome"), 40000);
    if (w.phase !== "signed_out" || !w.visibleForm) throw new Error(JSON.stringify(w));
    return { ...w, msToWelcome: Date.now() - launched };
  });

  await step("sign-in: the real form (server, e-mail, password, folder) signs this device in", async () => {
    const st = await until("running status on the app page", () => { const s = status(); return s?.snap?.phase === "running" && s.page === "/" ? s : null; }, 60000);
    if (report("welcome-after-submit")) throw new Error("the form stayed on the sign-in page: " + JSON.stringify(report("welcome-after-submit")));
    return { folder: report("welcome-filled")?.folder, device: st.snap.session?.device?.name };
  });

  await step("keystore: the token is in the OS keystore under the throwaway name, and not in any file or webview storage", async () => {
    const r = spawnSync("secret-tool", ["search", "--all", "service", svc], { encoding: "utf8" });
    const present = /secret = /.test(r.stdout) || /attribute\.service/.test(r.stdout + r.stderr);
    if (!present) throw new Error("no keystore entry found: " + r.stdout + r.stderr);
    const token = /secret = (\S+)/.exec(r.stdout)?.[1];
    const hit = spawnSync("grep", ["-rIl", "--", token ?? "NO-TOKEN", dataDir, notesDir, outDir], { encoding: "utf8" }).stdout.trim();
    if (hit) throw new Error("token string found in files: " + hit);
    return { entryFound: true, tokenInFiles: false };
  });

  await step("initial sync: the server's note appears as a file and the task is in the local database", async () => {
    const got = await until("seed file", () => files(notesDir)["seed/from-server.md"], 60000);
    const st = await until("sync status", () => { const s = status(); return s?.snap?.sync?.lastSyncAt ? s : null; });
    return { content: got, sync: st.snap.sync, live: st.snap.live };
  });

  await step("ui: the existing web UI renders inside the shell and talks through the host (no token, no cookie)", async () => {
    command({ cmd: "ui_probe" });
    const p = await until("ui-probe", () => report("ui-probe"), 30000);
    if (!(p["/api/auth/me"] === 200 && p["/api/tasks"] === 200 && p["/api/notes"] === 200 && p["/api/projects"] === 200)) throw new Error(JSON.stringify(p));
    if (p.tokenCommandExists !== false || p.tokenInStorage) throw new Error("token reachable? " + JSON.stringify(p));
    if (p.serviceWorker !== 0) throw new Error("service worker registered: " + p.serviceWorker);
    if (p.directFetchBlocked !== true) throw new Error("the page could fetch a foreign origin (CSP)");
    if (p.e2eAllowedInThisBuild !== true) throw new Error("e2e capability not active in this build");
    for (const k of ["fsPluginDenied", "shellPluginDenied", "readAbsoluteRefused", "readTraversalRefused", "writeTraversalRefused", "writeHiddenRefused", "dbUnknownTableRefused", "apiOtherPathRefused"])
      if (!p[k]) throw new Error(`${k}: the call was not refused`);
    if (existsSync(path.join(notesDir, "..", "escape.md"))) throw new Error("a file escaped the notes folder");
    return p;
  });

  await step("ui: Settings > Desktop app is present only in the shell and shows this device", async () => {
    command({ cmd: "settings_page" });
    const s = await until("settings-desktop", () => report("settings-desktop"), 30000);
    if (!/reminders on this computer/i.test(s.text) || !/E2E Linux desktop/.test(s.text) || /\bDevices\b/.test(s.text)) throw new Error(s.text);
    return { text: s.text.slice(0, 200) };
  });

  await step("external create: a new .md file in the folder becomes a note on the server and on a second device", async () => {
    other = await secondClient("e2e second device");
    mkdirSync(path.join(notesDir, "ext"), { recursive: true });
    writeFileSync(path.join(notesDir, "ext/hello.md"), "line one\nline two\nline three\nline four\nline five\n");
    const t0 = Date.now();
    await until("note on the second device", async () => { await other.sync(); return noteByPath(other, "ext/hello.md"); }, 60000, 1000);
    const v = await noteByPath(other, "ext/hello.md");
    if (v.content !== "line one\nline two\nline three\nline four\nline five\n") throw new Error("content differs: " + JSON.stringify(v.content));
    return { seconds: (Date.now() - t0) / 1000 };
  });

  await step("remote edit: an edit on the second device reaches the file through the live connection", async () => {
    const v = await noteByPath(other, "ext/hello.md");
    await other.engine.editNote(v.id, "line one\nline two\nline three\nline four\nline five\nadded elsewhere\n");
    await other.sync();
    const t0 = Date.now();
    await until("file updated", () => files(notesDir)["ext/hello.md"]?.includes("added elsewhere"), 40000, 250);
    return { seconds: (Date.now() - t0) / 1000 };
  });

  await step("conflict: offline on both sides, the same line edited differently, then reconnect: nothing is lost, a conflict copy file exists", async () => {
    setOffline(true);
    await sleep(1500);
    const v = await noteByPath(other, "ext/hello.md");
    await other.engine.editNote(v.id, "LINE ONE FROM THE OTHER DEVICE\nline two\nline three\nline four\nline five\nadded elsewhere\n");
    await other.sync();
    writeFileSync(path.join(notesDir, "ext/hello.md"), "line one changed locally\nline two\nline three\nline four\nline five\nadded elsewhere\n");
    await until("local edit noticed offline", () => status()?.snap?.notes?.counts?.edited >= 1 && status()?.snap?.sync?.pending >= 1, 30000);
    setOffline(false);
    await until("both versions present as files", () => { const f = files(notesDir); const all = Object.values(f).join("\n--\n"); return all.includes("FROM THE OTHER DEVICE") && all.includes("changed locally") ? f : null; }, 90000, 500);
    const f = files(notesDir);
    const names = Object.keys(f).filter((n) => /conflict/i.test(n));
    if (names.length < 1) throw new Error("no conflict-copy file: " + Object.keys(f).join(", "));
    await other.sync();
    const serverSide = (await other.engine.views()).filter((x) => x.type === "note" && !x.deleted).map((x) => x.fields.path).sort();
    return { files: Object.keys(f).sort(), conflictCopies: names, serverSide };
  });

  await step("offline edit then reconnect: an edit made with no connection is sent when the connection returns", async () => {
    writeFileSync(path.join(notesDir, "plain.md"), "plain note\n");
    await until("plain note synced", async () => { await other.sync(); return noteByPath(other, "plain.md"); }, 60000, 1000);
    setOffline(true);
    await sleep(1500);
    writeFileSync(path.join(notesDir, "plain.md"), "plain note\nedited while offline\n");
    await until("offline edit queued", () => status()?.snap?.sync?.pending >= 1, 30000);
    setOffline(false);
    await until("edit on the second device", async () => { await other.sync(); const v = await noteByPath(other, "plain.md"); return v?.content?.includes("edited while offline"); }, 90000, 1000);
  });

  await step("rename and delete in the folder reach the server", async () => {
    const { renameSync, unlinkSync } = await import("node:fs");
    renameSync(path.join(notesDir, "plain.md"), path.join(notesDir, "plain renamed.md"));
    unlinkSync(path.join(notesDir, "seed/from-server.md"));
    await until("rename + delete seen by the second device", async () => { await other.sync(); return (await noteByPath(other, "plain renamed.md")) && !(await noteByPath(other, "seed/from-server.md")); }, 90000, 1000);
  });

  await step("notices (SYNC-11c): a conflict between two other devices shows as a banner and on the Changes page, and Undo goes through the engine", async () => {
    const task = (await seeder.engine.views()).find((v) => v.type === "task" && !v.deleted && v.fields.title === "seed task");
    await seeder.sync(); await other.sync();
    await seeder.engine.updateEntity("task", task.id, { priority: "high" });
    await seeder.engine.syncUntilSettled(400);
    await other.engine.updateEntity("task", task.id, { priority: "urgent" }); // from the old revision: the later write wins and is logged
    await other.engine.syncUntilSettled(400);
    await drive("goto", { path: "/" });
    const banner = await until("banner text", async () => { const t = await pageText(); return /Changed on another device/.test(t) ? t : null; }, 90000, 1500);
    await drive("goto", { path: "/changes" });
    const list = await pageText();
    if (!/Replaced priority/.test(list) || !/High/.test(list)) throw new Error(list.slice(0, 600));
    await drive("click", { name: "Undo the change to the priority" });
    const done = await until("undo outcome", async () => { const t = await pageText(); return /Undone: the priority has its earlier value again|Not undone/.test(t) ? t : null; }, 60000, 1000);
    if (!/Undone: the priority has its earlier value again/.test(done)) throw new Error(done.slice(0, 800));
    await until("server has the earlier value", async () => { await other.sync(); return (await other.engine.view(task.id))?.fields.priority === "high"; }, 60000, 1000);
    return { banner: /Changed on another device/.test(banner), priorityAfterUndo: "high" };
  });

  await step("settings (SYNC-11b/c): Sync shows the engine's state and Desktop app shows the live connection", async () => {
    await drive("goto", { path: "/settings/sync" });
    const sync = await pageText();
    if (!/Waiting to send/.test(sync) || !/Changes from other devices/.test(sync)) throw new Error(sync.slice(0, 500));
    await drive("goto", { path: "/settings/desktop" });
    const desk = await pageText();
    if (!/Instant updates/.test(desk) || !/Live connection/.test(desk) || !/Connected/.test(desk) || !/Server push gateway/.test(desk)) throw new Error(desk.slice(0, 900));
    return { liveConnected: true };
  });

  await step("reminder: a reminder created on another device fires a desktop notification (D-Bus Notify) once", async () => {
    const api = await sessionLogin();
    const now = new Date();
    const at = new Date(now.getTime() + 60_000);
    const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
    const pr = await api("/api/notifications/reminders", { method: "PUT", body: JSON.stringify({ default: { days_before: 0, at_time: hhmm } }) });
    if (!pr.ok) throw new Error("preferences " + pr.status + (await pr.text()));
    await other.engine.createEntity("task", { title: "E2E reminder task", description: null, due_at: new Date(now.getTime() + 150_000).toISOString(), status: "inbox" });
    await other.sync();
    const t0 = Date.now();
    await until("notification", () => /E2E reminder task/.test(dbusText), 240000, 1000);
        await sleep(70000); // the same key must not be shown again
    const again = (dbusText.match(/E2E reminder task/g) ?? []).length;
    return { secondsUntilNotify: Math.round((Date.now() - t0) / 1000), dbusMentions: again, hhmm };
  });

  await step("tray: closing the window hides it and the app keeps running and syncing; the tray 'open' brings it back", async () => {
    command({ cmd: "close_window" });
    const hidden = await until("hidden", () => { const s = status(); return s?.win && s.win.visible === false ? s : null; }, 15000);
    const t1 = hidden.t;
    // while hidden: a change from the second device must still arrive (the runtime lives on)
    const v = await noteByPath(other, "plain renamed.md");
    await other.engine.editNote(v.id, "plain note\nedited while offline\nedited while the window was hidden\n");
    await other.sync();
    await until("file updated while hidden", () => files(notesDir)["plain renamed.md"]?.includes("while the window was hidden"), 60000, 500);
    const later = status();
    if (!(later.t > t1)) throw new Error("status stopped while hidden");
    if (app.exitCode !== null) throw new Error("app exited");
    command({ cmd: "tray_open" });
    const shown = await until("visible again", () => { const s = status(); return s?.win?.visible === true ? s : null; }, 15000);
    return { hiddenVisible: hidden.win.visible, shownVisible: shown.win.visible };
  });

  await step("autostart: off by default; opting in writes one start-up entry that starts hidden; opting out removes it", async () => {
    const dir = path.join(xdgConfig, ".config/autostart");
    const entries = () => (existsSync(dir) ? readdirSync(dir) : []);
    if (entries().length) throw new Error("autostart was on by default: " + entries());
    command({ cmd: "autostart", enabled: true });
    await until("entry written", () => entries().length === 1, 15000, 300);
    const body = readFileSync(path.join(dir, entries()[0]), "utf8");
    if (!/--background/.test(body)) throw new Error(body);
    command({ cmd: "autostart", enabled: false });
    await until("entry removed", () => entries().length === 0, 15000, 300);
    const realAfter = existsSync(realAutostart) ? readdirSync(realAutostart).sort().join(",") : "";
    if (realAfter !== realBefore) throw new Error("the owner's ~/.config/autostart changed: " + realBefore + " -> " + realAfter);
    return { name: entries.name ?? "Atlas.desktop", exec: /Exec=.*/.exec(body)?.[0], ownersAutostartUntouched: true };
  });

  await step("single instance: a second launch exits at once and the first keeps running", async () => {
    const before = tree(app.pid).length;
    const t0 = Date.now();
    const second = spawn(binary, [], { stdio: "ignore", env: { ...process.env, ATLAS_DESKTOP_DATA_DIR: dataDir, ATLAS_E2E_OUT: path.join(outDir, "second"), ATLAS_KEYSTORE_SERVICE: svc, HOME: xdgConfig, XDG_CONFIG_HOME: path.join(xdgConfig, ".config"), XDG_DATA_HOME: path.join(xdgConfig, ".local/share"), XDG_CACHE_HOME: path.join(xdgConfig, ".cache") } });
    const code = await new Promise((res) => { second.on("exit", res); setTimeout(() => res("still running"), 15000); });
    if (code === "still running") { second.kill("SIGKILL"); throw new Error("the second instance did not exit"); }
    if (app.exitCode !== null) throw new Error("the first instance died");
    return { secondExitCode: code, ms: Date.now() - t0, processesBefore: before, processesAfter: tree(app.pid).length };
  });

  await step("footprint: RSS/PSS of the app process tree and startup", async () => {
    const pids = tree(app.pid);
    const total = pids.reduce((s, p) => s + pss(p), 0);
    return { processes: pids.length, pssMB: Math.round(total / 1024), binaryMB: Math.round(statSync(binary).size / 1048576) };
  });

  await step("restore (SYNC-11a-4): the operator restores the server; the app stops on the restore screen and Re-upload my local data resumes it", async () => {
    restoreServer(); // `atlas-admin record-restore`: a new epoch
    const halted = await until("halt", () => { const s = status(); return s?.snap?.sync?.halt?.kind === "restore_confirmation" ? s : null; }, 90000, 1000);
    await drive("goto", { path: "/" });
    const text = await pageText();
    if (!/The server was restored from a backup/.test(text) || !/Re-upload my local data/.test(text) || !/Discard local changes and re-download/.test(text)) throw new Error(text.slice(0, 600));
    await sleep(5000); // nothing happens by itself
    if (status()?.snap?.sync?.halt?.kind !== "restore_confirmation") throw new Error("the halt cleared without a choice");
    await drive("click", { name: "Re-upload my local data" });
    await until("resumed", () => { const s = status(); return s && !s.snap.sync.halt && s.snap.sync.state !== "restore_confirmation" ? s : null; }, 90000, 1000);
    return { reason: halted.snap.sync.halt.reason };
  });

  await step("restore (SYNC-11a-4): Discard local changes and re-download asks twice, drops the unsent change and keeps the files", async () => {
    writeFileSync(path.join(notesDir, "after-restore.md"), "written after the first restore\n");
    restoreServer();
    await until("halt again", () => status()?.snap?.sync?.halt?.kind === "restore_confirmation" ? true : null, 90000, 1000);
    await drive("goto", { path: "/" });
    await drive("click", { name: "Discard local changes and re-download" });
    const ask = await pageText();
    if (!/Discard the .*unsent change/.test(ask) || !/never\s+deleted/.test(ask.replace(/\n/g, " "))) throw new Error(ask.slice(0, 700));
    if (status()?.snap?.sync?.halt?.kind !== "restore_confirmation") throw new Error("the first click already discarded");
    await drive("click", { name: "Yes, discard and re-download" });
    const after = await until("resumed after discard", () => { const s = status(); return s && !s.snap.sync.halt ? s : null; }, 90000, 1000);
    if (!existsSync(path.join(notesDir, "after-restore.md"))) throw new Error("a file in the notes folder was deleted by the discard");
    return { pendingAfter: after.snap.sync.pending, fileKept: true };
  });

  await step("server-side revoke: removing the device on the server signs the app out and forgets the token", async () => {
    const api = await sessionLogin();
    const id = status().snap.session.device.id;
    const r = await api(`/api/devices/${id}`, { method: "DELETE" });
    if (r.status !== 204) throw new Error("revoke " + r.status);
    await until("keystore entry gone", () => !/service/.test(spawnSync("secret-tool", ["search", "--all", "service", svc], { encoding: "utf8" }).stdout), 60000, 1000);
    const wel = await until("sign-in page after revoke", () => { const r2 = report("welcome"); return r2 && r2.urlReason === "signed_out" ? r2 : null; }, 60000);
    if (!/signed out/i.test(wel.notice) || !wel.visibleForm) throw new Error(JSON.stringify(wel));
    return { notice: wel.notice.slice(0, 120), visibleForm: wel.visibleForm };
  });
}

try { await main(); } catch (e) { results.push({ name: "orchestrator", result: "FAIL", detail: String(e?.stack ?? e) }); log("FAIL orchestrator", e?.stack ?? e); }
finally {
  try { app?.kill("SIGTERM"); } catch {}
  await sleep(1500);
  spawnSync("secret-tool", ["clear", "service", svc]);
  for (const fn of run.cleanup.reverse()) { try { await fn(); } catch (e) { log("cleanup error", e.message); } }
  const pass = results.filter((r) => r.result === "PASS").length, fail = results.filter((r) => r.result === "FAIL").length;
  writeFileSync(path.join(resultsDir, "e2e-last.json"), JSON.stringify({ at: new Date().toISOString(), binary, pass, fail, results }, null, 2));
  log(`e2e: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
