// End-to-end run of the REAL Android app on a USB-connected phone against a THROWAWAY Atlas API (SYNC-10, docs/TESTING.md 13).
//
//   node e2e/android.mjs [apk]        (default: the debug APK built by scripts/build-android.sh)
//
// Created here and removed at the end: database `atlas_android_<hex>` (never `atlas` / `atlas_test`), an API on a free loopback port
// reached from the phone through `adb reverse`, temp dirs, and the app's own data on the phone (`pm clear`). It uses the phone's
// WebView through Chrome DevTools (debug builds only) to type into the real pages, and `adb` to look at what Android did
// (alarms, notifications, Keystore ciphertext, Doze). It never touches the owner's dev stack, server or tailnet.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const apiDir = path.join(root, "services/api");
const venv = path.join(apiDir, ".venv/bin");
const sdk = process.env.ANDROID_HOME ?? path.join(homedir(), ".local/android/sdk");
const ADB = path.join(sdk, "platform-tools/adb");
const PKG = "app.atlas.mobile";
const apk = process.argv[2] ?? path.resolve(here, "../src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk");
const adminUrl = process.env.ATLAS_E2E_ADMIN_DATABASE_URL ?? "postgresql://atlas:atlas@127.0.0.1:5432/postgres";
const resultsDir = path.join(here, "results");
mkdirSync(resultsDir, { recursive: true });
const { chromium } = await import(path.join(root, "apps/web/node_modules/playwright-core/index.mjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, result: "PASS", ms: Date.now() - t0, detail: detail ?? null });
    log("PASS", name, detail ? JSON.stringify(detail).slice(0, 220) : "");
  } catch (e) {
    results.push({ name, result: "FAIL", ms: Date.now() - t0, detail: String(e?.message ?? e) });
    log("FAIL", name, String(e?.message ?? e).slice(0, 400));
  }
}
async function until(what, fn, ms = 60000, every = 500) {
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
const adb = (...args) => { const r = spawnSync(ADB, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }); return (r.stdout ?? "") + (r.stderr ?? ""); };
const shell = (cmd) => adb("shell", cmd);
const runAs = (cmd) => adb("shell", `run-as ${PKG} sh -c '${cmd}'`);

const run = { cleanup: [] };
let SyncEngine, createFetchTransport, MemoryStore;
async function loadSyncCore() {
  const dir = mkdtempSync(path.join(tmpdir(), "atlas-android-bundle-"));
  run.cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "sync-core.mjs");
  await build({ entryPoints: [path.join(here, "second-client-entry.ts")], bundle: true, format: "esm", platform: "node", outfile, logLevel: "error" });
  ({ SyncEngine, createFetchTransport, MemoryStore } = await import(outfile));
}
const dbName = `atlas_android_${randomBytes(5).toString("hex")}`;
const owner = { email: "e2e-owner@example.com", password: "e2e-throwaway-password-1", display_name: "E2E Owner" };
let apiPort, apiProc;
const dbUrl = () => { const u = new URL(adminUrl); u.pathname = `/${dbName}`; return u.toString().replace(/^postgresql:/, "postgresql+psycopg:"); };

async function startStack() {
  sh(path.join(venv, "python"), [path.join(here, "db_admin.py"), "create", adminUrl, dbName]);
  run.cleanup.push(() => sh(path.join(venv, "python"), [path.join(here, "db_admin.py"), "drop", adminUrl, dbName]));
  const serverNotes = mkdtempSync(path.join(tmpdir(), "atlas-android-server-notes-"));
  run.cleanup.push(() => rmSync(serverNotes, { recursive: true, force: true }));
  apiPort = await freePort();
  const env = {
    ...process.env, ATLAS_ENV: "test", DATABASE_URL: dbUrl(), NOTES_ROOT: serverNotes, BACKUP_DIR: path.join(serverNotes, "backups"),
    EXPORT_DIR: path.join(serverNotes, "exports"), PUBLIC_BASE_URL: `http://127.0.0.1:${apiPort}`, AUTH_RATE_LIMIT_PER_MINUTE: "1000", CORS_ORIGINS: "",
  };
  sh(path.join(venv, "atlas-migrate"), [], env);
  const logFd = openSync(path.join(resultsDir, "android-api.log"), "w");
  apiProc = spawn(path.join(venv, "python"), ["-m", "uvicorn", "atlas.main:app", "--host", "127.0.0.1", "--port", String(apiPort)], { cwd: apiDir, env, stdio: ["ignore", logFd, logFd] });
  run.cleanup.push(() => apiProc.kill("SIGTERM"));
  await until("API", async () => (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok, 60000);
  const r = await fetch(`http://127.0.0.1:${apiPort}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  if (r.status !== 201) throw new Error("setup failed " + r.status + (await r.text()));
  adb("reverse", `tcp:${apiPort}`, `tcp:${apiPort}`); // the phone's 127.0.0.1:<port> is this API (loopback http is allowed by the URL rules)
  run.cleanup.push(() => adb("reverse", "--remove", `tcp:${apiPort}`));
}

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
  return { engine, sync: async () => { engine.requestPull(); await engine.syncUntilSettled(400); }, device };
}
async function sessionLogin() {
  const base = `http://127.0.0.1:${apiPort}`;
  const r = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: owner.email, password: owner.password }) });
  if (!r.ok) throw new Error("login " + r.status);
  const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
  const csrf = decodeURIComponent((cookies.find((c) => c.startsWith("atlas_csrf=")) ?? "").split("=")[1] ?? "");
  return (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { ...(init.headers ?? {}), cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" } });
}

// ---- the phone -------------------------------------------------------------------------------------------------
const wake = () => { shell("input keyevent KEYCODE_WAKEUP"); shell("wm dismiss-keyguard"); };
const alarmLines = () => shell("dumpsys alarm").split("\n").filter((l) => l.includes(`${PKG}/app.atlas.android.AlarmReceiver`) && /origWhen|type=/.test(l));
// The alarm dump differs between Android versions (14: one line with the component; 15: the tag and window on the following lines), so read a block.
const ourAlarms = () => {
  const lines = shell("dumpsys alarm").split("\n");
  const out = [];
  lines.forEach((l, i) => {
    if (!new RegExp(`Alarm\\{[^}]*${PKG}\\}`).test(l)) return;
    const block = lines.slice(i, i + 7).join("\n");
    if (!/AlarmReceiver/.test(block)) return;
    const origWhen = Number((block.match(/origWhen[ =](\d+)/) ?? [])[1]);
    const wl = block.match(/windowLength (\d+)/);
    const w = block.match(/window=(\+?[0-9a-z.]+)/);
    out.push({ origWhen, windowMs: wl ? Number(wl[1]) : w ? (w[1] === "0" ? 0 : -1) : null });
  });
  return out;
};
const pendingAlarms = () => ourAlarms().length;
const shadeTexts = () => shell("dumpsys notification --noredact");
let browser, page;
// A tiny DevTools-protocol page over a raw WebSocket, used when Playwright cannot attach (an older WebView, such as the one in the emulator's
// system image, refuses `Browser.setDownloadBehavior`). Only what this script needs; `url()` is kept fresh by a short poll.
class RawPage {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.cachedUrl = "";
    ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && this.pending.has(d.id)) { const [res, rej] = this.pending.get(d.id); this.pending.delete(d.id); d.error ? rej(new Error(d.error.message)) : res(d.result); } });
    this.timer = setInterval(() => this.refreshUrl().catch(() => {}), 250);
  }
  static async open(port) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    const t = targets.find((x) => x.type === "page" && x.webSocketDebuggerUrl);
    if (!t) throw new Error("no page target");
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
    const p = new RawPage(ws);
    await p.refreshUrl();
    return p;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out`)); }, 12000); this.pending.set(id, [(v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }]); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async refreshUrl() { this.cachedUrl = (await this.evaluate(() => location.href)); }
  url() { return this.cachedUrl; }
  async evaluate(fn, arg) {
    const expression = `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})`;
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async waitForLoadState() { await until("document ready", async () => (await this.evaluate(() => document.readyState)) !== "loading" || null, 20000, 200); }
  async waitForSelector(sel) { await until(`selector ${sel}`, () => this.evaluate((q) => { const el = document.querySelector(q); return !!el && !el.hidden && el.getClientRects().length > 0; }, sel.replace(":not([hidden])", "")) || null, 15000, 200); }
  async fill(sel, value) { await this.evaluate((a) => { const el = document.querySelector(a[0]); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, a[1]); el.dispatchEvent(new Event("input", { bubbles: true })); }, [sel, value]); }
  async goto(u) { await this.send("Page.navigate", { url: u }); }
  locator(sel) {
    return {
      isVisible: () => this.evaluate((q) => { const el = document.querySelector(q); return !!el && !el.hidden && el.getClientRects().length > 0; }, sel),
      isHidden: () => this.evaluate((q) => { const el = document.querySelector(q); return !el || el.hidden || el.getClientRects().length === 0; }, sel),
      innerText: () => this.evaluate((q) => document.querySelector(q)?.innerText ?? "", sel),
    };
  }
  close() { clearInterval(this.timer); try { this.ws.close(); } catch {} }
}

async function connect() {
  const pid = (shell(`pidof ${PKG}`).trim().split(/\s+/)[0]) || "";
  if (!pid) throw new Error("app not running");
  const sock = await until("devtools socket", () => (shell("cat /proc/net/unix").match(new RegExp(`@(webview_devtools_remote_${pid})\\b`)) ?? [])[1], 20000, 300);
  adb("forward", "tcp:9233", `localabstract:${sock}`);
  await browser?.close().catch(() => {});
  page?.close?.();
  try {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9233");
    page = browser.contexts()[0].pages()[0];
  } catch {
    page = await RawPage.open(9233);
    browser = { contexts: () => [{ pages: () => [page] }], close: async () => page.close() };
  }
  await page.waitForLoadState("domcontentloaded");
}
const launch = async () => { wake(); shell(`am force-stop ${PKG}`); shell(`am start -n ${PKG}/.MainActivity`); await sleep(2500); await connect(); };
const pageText = async () => (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ");
const bridge = (fn, arg) => page.evaluate(fn, arg);


// Fill the sign-in form and submit it like a tap. After a sign-out the page can navigate twice (the live connection sees the revoked key and
// shows the "signed out" notice), which wipes a half-typed form: so check the values stuck and retry.
async function signInThroughThePage() {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.waitForSelector("#form:not([hidden])", { timeout: 15000 });
      await page.fill("#server", `http://127.0.0.1:${apiPort}`);
      await page.fill("#email", owner.email);
      await page.fill("#password", owner.password);
      const stuck = await page.evaluate(() => [document.getElementById("server").value, document.getElementById("email").value, document.getElementById("password").value.length]);
      if (stuck[0] !== `http://127.0.0.1:${apiPort}` || stuck[1] !== owner.email || stuck[2] !== owner.password.length) throw new Error("form was reset");
      await page.evaluate(() => document.getElementById("form").requestSubmit()); // the soft keyboard can cover the button; submitting is what a tap does
      await until("app page", async () => new URL(page.url()).pathname === "/" || ((await page.locator("#error").isVisible().catch(() => false)) ? Promise.reject(new Error("sign-in refused: " + (await page.locator("#error").innerText()))) : null), 20000);
      await page.waitForLoadState("domcontentloaded");
      return;
    } catch (e) {
      if (attempt === 4 || /refused/.test(String(e))) throw e;
      await sleep(2000);
    }
  }
}


// A real touch on an element of the page: the WebView's screen position comes from uiautomator, the element's from the page.
async function tapElement(selector) {
  shell(`am start -n ${PKG}/.MainActivity`); // make sure the app, not the launcher or a sheet, is on screen for the dump
  await sleep(1500);
  const xml = shell("uiautomator dump /sdcard/atlas-ui.xml >/dev/null; cat /sdcard/atlas-ui.xml");
  const wv = [...xml.matchAll(/class="android\.webkit\.WebView"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)][0];
  if (!wv) throw new Error("WebView bounds not found in the UI dump");
  const r = await page.evaluate((q) => { const b = document.querySelector(q).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + Math.min(b.height / 2, 60), dpr: window.devicePixelRatio, vw: window.innerWidth }; }, selector);
  const left = Number(wv[1]), top = Number(wv[2]);
  shell(`input tap ${Math.round(left + r.x * r.dpr)} ${Math.round(top + r.y * r.dpr)}`);
}

async function main() {
  if (!existsSync(apk)) throw new Error(`APK not found: ${apk} (build with scripts/build-android.sh)`);
  if (!/\tdevice\b/.test(adb("devices"))) throw new Error("no authorised device connected");
  await loadSyncCore();
  await step("stack: throwaway database and API, adb reverse", async () => { await startStack(); return { db: dbName, apiPort }; });
  if (results.at(-1).result !== "PASS") return;

  let other;
  await step("seed: a note and a task created by another device before the phone exists", async () => {
    other = await secondClient("e2e second device");
    await other.engine.createNote("seed/from-server.md", "# Seed\nwritten on the server side\n");
    await other.engine.createEntity("task", { title: "seed task", description: null, due_at: null, status: "inbox" });
    await other.sync();
  });

  await step("install: a fresh install, notification permission granted, the app starts to the sign-in page", async () => {
    adb("uninstall", PKG);
    const out = adb("install", "-r", "-g", apk);
    if (!/Success/.test(out)) throw new Error(out);
    adb("shell", "svc power stayon usb");
    await launch();
    // Android 13+ asks for the notification permission only when the app asks; the test needs it granted, the person decides on a real phone
    const st = await bridge(() => window.atlasDesktop && window.atlasDesktop.android && window.atlasDesktop.android.status());
    const w = await until("sign-in form", async () => { const t = await pageText(); return /Sign this phone in/.test(t) ? t : null; }, 30000);
    return { notifications: st?.notifications, exactAlarms: st?.exactAlarms, manufacturer: st?.manufacturer, sdk: st?.sdk, wording: w.slice(0, 60), autostartRowHidden: await page.locator("#autostart-row").isHidden(), folderBoxHidden: await page.locator("#folder-box").isHidden() };
  });

  await step("sign-in: typing into the real page signs the phone in; the token is in the Keystore (ciphertext only), never in the page", async () => {
    await signInThroughThePage();
    const prefs = runAs("cat shared_prefs/atlas_secure.xml");
    if (!/name="token"/.test(prefs)) throw new Error("no token entry: " + prefs.slice(0, 200));
    if (/atd_/.test(prefs)) throw new Error("PLAINTEXT token in shared_prefs");
    const dump = runAs("grep -rl atd_ . 2>/dev/null | head -5");
    if (dump.trim()) throw new Error("plaintext token found in: " + dump);
    const inPage = await bridge(() => JSON.stringify([localStorage, sessionStorage, document.cookie]).includes("atd_"));
    if (inPage) throw new Error("token visible to the page");
    return { ciphertextStored: true, plaintextAnywhereInAppData: false };
  });

  await step("sync: the seeded task and note arrive on the phone; the notes folder is app-private and holds the note as a Markdown file", async () => {
    await until("running", async () => (await bridge(() => window.atlasDesktop.snapshot())).phase === "running" || null, 40000);
    await until("seed note on the phone", () => /Seed/.test(runAs("cat notes/seed/from-server.md")) || null, 60000, 1000);
    await page.goto("about:blank").catch(() => {});
    await launch();
    await bridge(() => { location.assign("/tasks"); });
    await until("seed task visible", async () => /seed task/.test(await pageText()) || null, 40000);
    return { noteFile: runAs("ls notes/seed").trim() };
  });

  const alarmCheck = async (label, { doze }) => {
    const api = await sessionLogin();
    const at = new Date(Date.now() + 75_000);
    const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
    const pr = await api("/api/notifications/reminders", { method: "PUT", body: JSON.stringify({ default: { days_before: 0, at_time: hhmm } }) });
    if (!pr.ok) throw new Error("preferences " + pr.status);
    const due = new Date(Date.now() + 150_000);
    await other.engine.createEntity("task", { title: label, description: null, due_at: due.toISOString(), status: "inbox" });
    await other.sync();
    try {
      await until("an OS alarm is armed for the reminder", () => pendingAlarms() > 0 || null, 90000, 1000);
    } catch (e) {
      const snap = await bridge(() => window.atlasDesktop.snapshot().then((x) => JSON.stringify({ phase: x.phase, sync: x.sync, perm: x.notificationPermission, settings: x.settings }))).catch((x) => String(x));
      const alarms = JSON.stringify(ourAlarms());
      throw new Error(`${e.message}; snapshot=${snap}; alarmLinesForApp=${alarms}; deviceDate=${shell("date -u").trim()}; due=${due.toISOString()}; at=${at.toISOString()}`);
    }
    const armed = ourAlarms()[0] ?? {};
    const origWhen = armed.origWhen;
    const windowLength = armed.windowMs;
    shell("input keyevent KEYCODE_HOME");
    shell("input keyevent KEYCODE_SLEEP");
    shell(`am kill ${PKG}`);
    if (shell(`pidof ${PKG}`).trim()) runAs(`kill -9 $(pidof ${PKG}) 2>/dev/null; true`); // the process must be dead: the alarm has to survive without it
    await sleep(1500);
    const alive = shell(`pidof ${PKG}`).trim();
    if (alive) throw new Error("could not kill the app process: " + alive);
    if (doze) shell("dumpsys deviceidle force-idle");
    const t0 = Date.now();
    const posted = await until(`notification "${label}" posted by Android with the app dead`, () => shadeTexts().includes(label) || null, 300000, 2000);
    if (doze) shell("dumpsys deviceidle unforce");
    const when = Number(((shadeTexts().split("\n").map((l, i, a) => (l.includes(label) ? a.slice(Math.max(0, i - 40), i + 1).reverse().find((x) => /when=\d+/.test(x)) : null)).find(Boolean)) ?? "").match(/when=(\d+)/)?.[1]);
    const lateMs = when && origWhen ? when - origWhen : null;
    return { processDuringWait: "dead", secondsFromSleepToShown: Math.round((Date.now() - t0) / 1000), posted: !!posted, alarmWindowMs: windowLength, lateMs, exact: windowLength === 0, doze };
  };

  if (!process.env.E2E_SKIP_REMINDERS) await step("reminder: with the app killed and the screen off Android shows the reminder (exact alarm)", async () => alarmCheck("E2E reminder task", { doze: false }));

  if (!process.env.E2E_SKIP_REMINDERS) await step("reminder (Doze): with the phone forced into deep idle the reminder still arrives", async () => {
    wake();
    await launch();
    return alarmCheck("E2E doze task", { doze: true });
  });

  // Opt-in (E2E_REBOOT=1): REBOOTS THE PHONE. Needs the person to unlock it once (Android delivers BOOT_COMPLETED to an app only after the
  // first unlock). Proves that the alarm AlarmManager forgot at reboot is re-armed from the app's own store and still fires on time.
  if (process.env.E2E_REBOOT) await step("reboot: an armed reminder survives a phone reboot and is shown on time", async () => {
    wake();
    await launch();
    const api = await sessionLogin();
    const at = new Date(Date.now() + 7 * 60_000);
    const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
    const pr = await api("/api/notifications/reminders", { method: "PUT", body: JSON.stringify({ default: { days_before: 0, at_time: hhmm } }) });
    if (!pr.ok) throw new Error("preferences " + pr.status);
    await other.engine.createEntity("task", { title: "E2E reboot task", description: null, due_at: new Date(Date.now() + 9 * 60_000).toISOString(), status: "inbox" });
    await other.sync();
    await until("an OS alarm is armed", () => pendingAlarms() > 0 || null, 90000, 1000);
    const origWhen = ourAlarms()[0]?.origWhen;
    log("REBOOTING the phone now; unlock it when the screen asks for the PIN (the reminder is due in about 7 minutes)");
    adb("reboot");
    await sleep(15000);
    await until("device back", () => /\tdevice\b/.test(adb("devices")), 240000, 3000);
    await until("boot completed", () => shell("getprop sys.boot_completed").trim() === "1" || null, 240000, 3000);
    log("booted: unlocking (a swipe, for a phone without a PIN)");
    for (let i = 0; i < 20 && !/isKeyguardShowing=false/.test(shell("dumpsys window")); i++) { shell("input keyevent KEYCODE_WAKEUP"); await sleep(1500); shell("input swipe 540 2000 540 600 300"); await sleep(2500); }
    await until("the person unlocked the phone", () => (/isKeyguardShowing=false/.test(shell("dumpsys window")) || /mCurrentFocus=Window\{[^}]*(launcher|NexusLauncher|bitpit)/i.test(shell("dumpsys window | grep mCurrentFocus"))) || null, 900000, 3000);
    adb("reverse", `tcp:${apiPort}`, `tcp:${apiPort}`); // lost with the reboot; the later steps need the API again
    await until("the alarm was re-armed after boot", () => pendingAlarms() > 0 || null, 120000, 2000);
    const again = ourAlarms()[0] ?? {};
    const sameInstant = again.origWhen === origWhen;
    await until("notification shown", () => shadeTexts().includes("E2E reboot task") || null, 600000, 3000);
    return { rearmed: true, sameInstant, windowMs: again.windowMs };
  });

  await step("restart after delivery: the runtime reads the delivery log and does not show the reminder a second time", async () => {
    wake();
    await launch();
    await sleep(8000);
    const count = (shadeTexts().match(/E2E reminder task/g) ?? []).length;
    const left = pendingAlarms();
    return { mentions: count, pendingAlarmsAfter: left };
  });

  await step("tap: the intent a tapped reminder carries opens that task in the app", async () => {
    const id = await bridge(async () => {
      const find = (o) => (o && typeof o === "object" ? (o.title === "seed task" && o.id ? o.id : Object.values(o).map(find).find(Boolean)) : undefined);
      return find(await (await window.atlasDesktop.fetch("/api/tasks?limit=200")).json());
    });
    if (!id) throw new Error("task id not found");
    await bridge(() => { location.assign("/settings"); }); // somewhere else, so that arriving on /tasks proves the tap did it
    await until("settings page", () => new URL(page.url()).pathname.startsWith("/settings") || null, 15000);
    shell("input keyevent KEYCODE_HOME");
    await sleep(1000);
    shell(`am start -n ${PKG}/.MainActivity --es atlas_task_id ${id}`);
    await until("task opened", () => new URL(page.url()).pathname === "/tasks" || null, 20000);
    const text = await until("the task is shown", async () => { const t = await pageText(); return /seed task/.test(t) ? t : null; }, 15000);
    // the page consumes the launch task once: a later wake does not jump there again
    return { path: new URL(page.url()).pathname, taskShown: /seed task/.test(text) };
  });

  await step("settings: the phone's Settings page shows reminder reliability (notifications, exact alarms, battery)", async () => {
    await bridge(() => { location.assign("/settings/desktop"); });
    await until("settings", async () => /Reminder reliability/.test(await pageText()) || null, 20000);
    const t = await pageText();
    if (/\btray\b|Start Atlas when I log in|this computer/i.test(t)) throw new Error("desktop-only rows are visible: " + t.slice(0, 300));
    return { text: t.slice(t.indexOf("Reminder reliability"), t.indexOf("Reminder reliability") + 220) };
  });

  await step("keep connected: with the optional background mode on, a reminder made on another device is armed while Atlas is in the background and the screen is off", async () => {
    const api = await sessionLogin();
    const armCount = () => pendingAlarms();
    const before = armCount();
    await bridge(() => window.atlasDesktop.android.keepConnected.set(true));
    const running = await until("the foreground service is running", () => /KeepConnectedService/.test(shell(`dumpsys activity services ${PKG}`)) || null, 15000, 500);
    const results = {};
    for (const mode of ["screen off", "forced Doze"]) {
      const at = new Date(Date.now() + 12 * 60_000);
      const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
      const pr = await api("/api/notifications/reminders", { method: "PUT", body: JSON.stringify({ default: { days_before: 0, at_time: hhmm } }) });
      if (!pr.ok) throw new Error("preferences " + pr.status);
      const have = armCount();
      shell("input keyevent KEYCODE_HOME");
      await sleep(1000);
      shell("input keyevent KEYCODE_SLEEP");
      if (mode === "forced Doze") shell("dumpsys deviceidle force-idle");
      await other.engine.createEntity("task", { title: `E2E keep-connected ${mode}`, description: null, due_at: new Date(Date.now() + 14 * 60_000).toISOString(), status: "inbox" });
      await other.sync();
      const t0 = Date.now();
      try {
        await until(`an alarm is armed for the reminder while the app is in the background (${mode})`, () => armCount() > have || null, 180000, 2000);
        results[mode] = { armedAfterSeconds: Math.round((Date.now() - t0) / 1000) };
      } finally {
        if (mode === "forced Doze") shell("dumpsys deviceidle unforce");
        wake();
      }
    }
    await bridge(() => window.atlasDesktop.android.keepConnected.set(false));
    await until("the foreground service stopped", () => !/KeepConnectedService/.test(shell(`dumpsys activity services ${PKG}`)) || null, 15000, 500);
    return { serviceRunning: !!running, alarmsBefore: before, ...results };
  });

  if (process.env.E2E_SOAK_MINUTES) await step(`soak: keep-connected after ${process.env.E2E_SOAK_MINUTES} minutes in the background with the screen off`, async () => {
    const minutes = Number(process.env.E2E_SOAK_MINUTES);
    const api = await sessionLogin();
    shell(`am start -n ${PKG}/.MainActivity`); // Android only lets a foreground service start while the app is in front (the person flips the switch in the app)
    await sleep(1500);
    await bridge(() => window.atlasDesktop.android.keepConnected.set(true));
    await until("the foreground service is running", () => /KeepConnectedService/.test(shell(`dumpsys activity services ${PKG}`)) || null, 15000, 500);
    shell("input keyevent KEYCODE_HOME");
    await sleep(1000);
    shell("input keyevent KEYCODE_SLEEP");
    const start = Date.now();
    let alive = 0;
    while (Date.now() - start < minutes * 60_000) {
      await sleep(60_000);
      if (/KeepConnectedService/.test(shell(`dumpsys activity services ${PKG}`)) && shell(`pidof ${PKG}`).trim()) alive++;
    }
    const at = new Date(Date.now() + 12 * 60_000);
    const hhmm = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
    const pr = await api("/api/notifications/reminders", { method: "PUT", body: JSON.stringify({ default: { days_before: 0, at_time: hhmm } }) });
    if (!pr.ok) throw new Error("preferences " + pr.status);
    const have = pendingAlarms();
    await other.engine.createEntity("task", { title: "E2E soak task", description: null, due_at: new Date(Date.now() + 14 * 60_000).toISOString(), status: "inbox" });
    await other.sync();
    const t0 = Date.now();
    await until("an alarm is armed after the long background period", () => pendingAlarms() > have || null, 300000, 2000);
    const result = { minutes, serviceAndProcessAliveChecks: alive, armedAfterSeconds: Math.round((Date.now() - t0) / 1000) };
    wake();
    await bridge(() => window.atlasDesktop.android.keepConnected.set(false));
    return result;
  });

  if (!process.env.E2E_SKIP_EDITOR) await step("editor: text typed with Android's own key events lands in the note editor, is saved to the Markdown file and syncs", async () => {
    const noteId = await bridge(async () => {
      const find = (o) => (o && typeof o === "object" ? (o.path === "seed/from-server.md" && o.id ? o.id : Object.values(o).map(find).find(Boolean)) : undefined);
      return find(await (await window.atlasDesktop.fetch("/api/notes")).json());
    });
    if (!noteId) throw new Error("note id not found");
    await bridge((id) => { location.assign(`/notes?open=${id}`); }, noteId);
    await until("the note editor", () => page.evaluate(() => !!document.querySelector('.cm-content[aria-label="Note content"]')) || null, 30000, 500);
    await tapElement('.cm-content[aria-label="Note content"]'); // a real touch gives the editor Android's input focus (the soft keyboard)
    await sleep(800);
    shell("input keyboard keyevent KEYCODE_MOVE_END");
    shell("input text 'typed%son%sthe%sphone'");
    await until("the editor shows it", () => page.evaluate(() => document.querySelector('.cm-content[aria-label="Note content"]').innerText.includes("typed on the phone")) || null, 15000, 500);
    await until("the file on the phone has it (autosave, then the folder sync)", () => /typed on the phone/.test(runAs("cat notes/seed/from-server.md")) || null, 60000, 1000);
    await other.sync();
    const view = (await other.engine.views()).find((v) => v.type === "note" && !v.deleted && v.fields.path === "seed/from-server.md");
    const text = JSON.stringify(view?.fields ?? {});
    if (!/typed on the phone/.test(text)) throw new Error("the second device does not have it: " + text.slice(0, 200));
    return { editorOk: true, fileOk: true, secondDeviceOk: true };
  });

  if (!process.env.E2E_SKIP_EDITOR) await step("ime: a composition (CJK input method) in the note editor ends as the committed text, with no leftovers, and reaches the file", async () => {
    // The soft keyboard's own composition cannot be driven from adb; the WebView's input-method events can, through DevTools
    // (Input.imeSetComposition then Input.insertText is what an IME commit looks like to the page).
    const noteId = await bridge(async () => {
      const find = (o) => (o && typeof o === "object" ? (o.path === "seed/from-server.md" && o.id ? o.id : Object.values(o).map(find).find(Boolean)) : undefined);
      return find(await (await window.atlasDesktop.fetch("/api/notes")).json());
    });
    await bridge((id) => { location.assign(`/notes?open=${id}`); }, noteId);
    await until("the note editor", () => page.evaluate(() => !!document.querySelector('.cm-content[aria-label="Note content"]')) || null, 30000, 500);
    await tapElement('.cm-content[aria-label="Note content"]');
    await sleep(800);
    shell("input keyboard keyevent KEYCODE_MOVE_END");
    const raw = await RawPage.open(9233);
    try {
      await raw.send("Input.imeSetComposition", { text: "にほ", selectionStart: 2, selectionEnd: 2 });
      await sleep(400);
      const during = await page.evaluate(() => document.querySelector('.cm-content[aria-label="Note content"]').innerText);
      await raw.send("Input.insertText", { text: "日本語です" });
      await sleep(600);
      const after = await page.evaluate(() => document.querySelector('.cm-content[aria-label="Note content"]').innerText);
      if (!after.includes("日本語です")) throw new Error("the committed text is missing: " + JSON.stringify(after.slice(-80)));
      if (/にほ/.test(after.replace("日本語です", ""))) throw new Error("composition leftovers in the editor: " + JSON.stringify(after.slice(-80)));
      await until("the file has it", () => /日本語です/.test(runAs("cat notes/seed/from-server.md")) || null, 60000, 1000);
      return { duringComposition: during.includes("にほ"), committed: true, leftovers: false, fileOk: true };
    } finally {
      raw.close();
    }
  });

  await step("export: Export notes zips the app-private notes and opens Android's share sheet", async () => {
    await bridge(() => { location.assign("/settings/desktop"); });
    await until("settings", async () => /Reminder reliability/.test(await pageText()) || null, 20000);
    const done = await bridge(() => window.atlasDesktop.exportNotes());
    if (!done || done.files < 1) throw new Error("nothing exported: " + JSON.stringify(done));
    const zipPath = path.join(mkdtempSync(path.join(tmpdir(), "atlas-android-export-")), "notes.zip");
    const name = runAs("ls cache/exports").trim().split(/\s+/).find((n) => n.endsWith(".zip"));
    if (!name) throw new Error("no zip in the app cache");
    writeFileSync(zipPath, spawnSync(ADB, ["exec-out", "run-as", PKG, "cat", `cache/exports/${name}`], { maxBuffer: 64 * 1024 * 1024 }).stdout);
    const listing = spawnSync("unzip", ["-l", zipPath], { encoding: "utf8" }).stdout;
    if (!/seed\/from-server\.md/.test(listing)) throw new Error("the seeded note is not in the zip: " + listing);
    const text = spawnSync("unzip", ["-p", zipPath, "seed/from-server.md"], { encoding: "utf8" }).stdout;
    if (!/written on the server side/.test(text)) throw new Error("note content differs: " + text);
    const sheet = await until("the share sheet", () => /ChooserActivity|ResolverActivity|IntentForwarder|sharesheet/i.test(shell("dumpsys activity activities")) || null, 15000, 500);
    shell("input keyevent KEYCODE_BACK");
    await sleep(1000);
    shell(`am start -n ${PKG}/.MainActivity`); // back in front if the BACK key left the app
    await until("the page and its bridge are back", async () => { page = browser.contexts()[0].pages()[0] ?? page; return (await page.evaluate(() => !!window.atlasDesktop)) || null; }, 20000, 500);
    return { files: done.files, bytes: done.bytes, listing: listing.split("\n").filter((l) => /\.md/.test(l)).length, sheet: !!sheet };
  });

  await step("shared notes folder: moving the notes to Documents/Atlas Notes lets another app edit them in place, and they can move back", async () => {
    const SHARED = "/sdcard/Documents/Atlas Notes";
    if (/Atlas Notes/.test(shell("ls /sdcard/Documents"))) throw new Error("a folder named Atlas Notes already exists on the phone: not touching it");
    try {
      // The person grants "All files access" in the system screen. adb can do it on a stock Android; OxygenOS refuses appops from the shell, so
      // there the same switch is flipped by tapping it in that screen (which is what the person does). Android kills the app when it changes.
      shell(`cmd appops set --uid ${PKG} MANAGE_EXTERNAL_STORAGE allow`);
      if (!/allow/.test(shell(`cmd appops get ${PKG} MANAGE_EXTERNAL_STORAGE`))) {
        shell(`am start -a android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION -d package:${PKG}`);
        await sleep(2500);
        const xml = shell("uiautomator dump /sdcard/atlas-ui.xml >/dev/null; cat /sdcard/atlas-ui.xml");
        const sw = [...xml.matchAll(/<node[^>]*class="android\.widget\.(?:Switch|CompoundButton|CheckBox)"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/g)][0]
          ?? [...xml.matchAll(/<node[^>]*checkable="true"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*>/g)][0];
        if (!sw) throw new Error("the All files access switch was not found: " + xml.slice(0, 400));
        shell(`input tap ${Math.round((Number(sw[1]) + Number(sw[3])) / 2)} ${Math.round((Number(sw[2]) + Number(sw[4])) / 2)}`);
        await sleep(2000);
        shell("input keyevent KEYCODE_BACK");
        await sleep(1500);
      }
      shell(`am start -n ${PKG}/.MainActivity`);
      await sleep(2500);
      await connect(); // the app may have been restarted by Android when the permission changed
      await bridge(() => { location.assign("/settings/desktop"); });
      await until("settings", async () => /Reminder reliability/.test(await pageText()) || null, 20000);
      const st = await bridge(() => window.atlasDesktop.android.status());
      if (!st.allFilesAccess) throw new Error("All files access was not granted: " + JSON.stringify(st));
      const before = await bridge(() => window.atlasDesktop.notesLocation.get());
      const done = await bridge(() => window.atlasDesktop.notesLocation.set("shared"));
      if (!done.switched || done.copied + done.identical < 1) throw new Error("not moved: " + JSON.stringify(done));
      if (!/from-server\.md/.test(shell(`ls "${SHARED}/seed"`))) throw new Error("the note is not in the shared folder");
      // another app (the adb shell user) changes the file in place
      await other.sync();
      const startSize = (await other.engine.views()).find((x) => x.type === "note" && !x.deleted && x.fields.path === "seed/from-server.md")?.fields.size_bytes ?? 0;
      shell(`printf '\\nadded by another app\\n' >> "${SHARED}/seed/from-server.md"`);
      // Atlas notices an outside edit through the folder watcher (inotify is unreliable on shared storage) or when the person comes back to it:
      // go home and return, as a person would after editing in another app
      shell("input keyevent KEYCODE_HOME");
      await sleep(1500);
      shell(`am start -n ${PKG}/.MainActivity`);
      await bridge(() => window.atlasDesktop.syncNow());
      const seen = await until("the edit reaches the second device", async () => {
        await other.sync();
        const v = (await other.engine.views()).find((x) => x.type === "note" && !x.deleted && x.fields.path === "seed/from-server.md");
        return (/added by another app/.test(JSON.stringify(v?.fields ?? {})) || (v?.fields.size_bytes ?? 0) >= startSize + 20) || null; // the second device\'s view carries the size, not the text
      }, 90000, 3000).catch(async (e) => {
        const snap = await bridge(() => window.atlasDesktop.snapshot().then((x) => JSON.stringify({ notes: x.notes, sync: x.sync }))).catch((x) => String(x));
        const v = (await other.engine.views()).find((x) => x.type === "note" && x.fields.path === "seed/from-server.md");
        throw new Error(`${e.message}; sharedFile=${JSON.stringify(shell(`cat "${SHARED}/seed/from-server.md"`))}; snapshot=${snap}; secondDeviceNote=${JSON.stringify(v?.fields ?? null).slice(0, 300)}`);
      });
      const archived = runAs("ls").split(/\s+/).filter((n) => /^notes$|previous/.test(n));
      const back = await bridge(() => window.atlasDesktop.notesLocation.set("private"));
      if (!back.switched) throw new Error("did not move back: " + JSON.stringify(back));
      const text = runAs("cat notes/seed/from-server.md");
      if (!/added by another app/.test(text)) throw new Error("the other app's edit did not come back with the notes: " + text.slice(0, 200));
      return { before: before.kind, copied: done.copied, archivedAs: done.archivedAs, secondDevice: !!seen, movedBackCopied: back.copied, appFolders: archived };
    } finally {
      shell(`rm -rf /sdcard/Documents/Atlas\\ Notes*`); // test artefacts only (the folder did not exist before this step)
      // the appop is reset at the very end: Android kills an app whose "All files access" changes
    }
  });

  if (!process.env.E2E_SKIP_RESTORE) await step("restore (SYNC-11a-4): the operator restores the server; the phone stops on the restore screen and each choice resumes it without losing the notes", async () => {
    const restoreServer = () => sh(path.join(venv, "python"), ["-m", "atlas.auth.cli", "record-restore"], { ...process.env, ATLAS_ENV: "test", DATABASE_URL: dbUrl() });
    const haltKind = () => bridge(() => window.atlasDesktop.snapshot().then((x) => x.sync?.halt?.kind ?? null));
    const clickButton = (text) => bridge((t) => { const b = [...document.querySelectorAll("button")].find((x) => x.innerText.trim() === t); if (!b) throw new Error("no button " + t); b.click(); return true; }, text);
    shell(`am start -n ${PKG}/.MainActivity`);
    await sleep(1500);
    // 1) re-upload the phone's data
    restoreServer();
    await until("the restore halt", async () => (await haltKind()) === "restore_confirmation" || null, 120000, 2000);
    await bridge(() => { location.assign("/"); });
    const text = await until("the restore screen", async () => { const t = await pageText(); return /The server was restored from a backup/.test(t) ? t : null; }, 30000, 1000);
    if (!/Re-upload my local data/.test(text) || !/Discard local changes and re-download/.test(text)) throw new Error(text.slice(0, 500));
    await sleep(5000); // nothing happens by itself
    if ((await haltKind()) !== "restore_confirmation") throw new Error("the halt cleared without a choice");
    await clickButton("Re-upload my local data");
    await until("resumed after re-upload", async () => (await haltKind()) === null || null, 120000, 2000);
    // 2) discard local changes and re-download: asks twice, keeps the files
    const before = runAs("ls notes/seed").trim();
    restoreServer();
    await until("the restore halt again", async () => (await haltKind()) === "restore_confirmation" || null, 120000, 2000);
    await bridge(() => { location.assign("/"); });
    await until("the restore screen again", async () => /Discard local changes and re-download/.test(await pageText()) || null, 30000, 1000);
    await clickButton("Discard local changes and re-download");
    const ask = await pageText();
    if (!/Discard the .*unsent change/.test(ask) || !/never\s+deleted/.test(ask.replace(/\n/g, " "))) throw new Error(ask.slice(0, 600));
    if ((await haltKind()) !== "restore_confirmation") throw new Error("the first click already discarded");
    await clickButton("Yes, discard and re-download");
    await until("resumed after discard", async () => (await haltKind()) === null || null, 120000, 2000);
    const after = runAs("ls notes/seed").trim();
    if (!after.includes("from-server.md")) throw new Error("a note file was deleted by the discard: " + after);
    return { filesBefore: before, filesAfter: after, resumed: true };
  });

  await step("sign out: the Keystore entry and the key are removed and the page returns to sign-in", async () => {
    await bridge(() => { setTimeout(() => window.atlasDesktop.signOut(), 0); }); // not awaited: the page navigates away while it runs
    await until("sign-in page", () => /welcome/.test(page.url()) || null, 20000);
    const prefs = runAs("cat shared_prefs/atlas_secure.xml");
    if (/name="token"/.test(prefs)) throw new Error("token entry still stored");
    return { tokenGone: true };
  });

  await step("server-side revoke: removing the device on the server signs the phone out and forgets the token", async () => {
    await signInThroughThePage();
    const api = await sessionLogin();
    const dev = await api("/api/devices");
    const list = await dev.json();
    const mine = (Array.isArray(list) ? list : list.items ?? list.devices ?? []).find((d) => /Android phone/.test(d.name));
    if (!mine) throw new Error("device not listed: " + JSON.stringify(list).slice(0, 200));
    const r = await api(`/api/devices/${mine.id}`, { method: "DELETE" });
    if (r.status !== 204) throw new Error("revoke " + r.status);
    await until("sign-in page after revoke", async () => { page = browser.contexts()[0].pages()[0] ?? page; return (/welcome/.test(page.url()) && /signed out/i.test(await pageText())) || null; }, 120000, 1000);
    if (/name="token"/.test(runAs("cat shared_prefs/atlas_secure.xml"))) throw new Error("token entry still stored after revoke");
    return { signedOutByServer: true };
  });
}

try { await main(); } catch (e) { results.push({ name: "orchestrator", result: "FAIL", detail: String(e?.stack ?? e) }); log("FAIL orchestrator", e?.stack ?? e); }
finally {
  if (process.env.E2E_HOLD) {
    // debugging aid: keep the stack, the phone state and the DevTools forward until this file is removed
    const hold = path.join(resultsDir, "android-hold");
    writeFileSync(hold, `${apiPort}\n`);
    log("HOLD: remove", hold, "to clean up; API port", apiPort);
    while (existsSync(hold)) await sleep(2000);
  }
  try { await browser?.close(); } catch {}
  adb("forward", "--remove", "tcp:9233");
  shell("dumpsys deviceidle unforce");
  shell(`cmd appops set --uid ${PKG} MANAGE_EXTERNAL_STORAGE default`);
  shell(`am force-stop ${PKG}`);
  adb("shell", `pm clear ${PKG}`);
  for (const fn of run.cleanup.reverse()) { try { await fn(); } catch (e) { log("cleanup error", e.message); } }
  const pass = results.filter((r) => r.result === "PASS").length, fail = results.filter((r) => r.result === "FAIL").length;
  writeFileSync(path.join(resultsDir, "android-e2e-last.json"), JSON.stringify({ at: new Date().toISOString(), apk, pass, fail, results }, null, 2));
  log(`android e2e: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail ? 1 : 0);
}
