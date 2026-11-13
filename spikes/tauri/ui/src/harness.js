// Spike harness page (tauri://localhost). Runs the suites named by SPIKE_SUITE and writes JSON via `report`.
import { probe } from "../probe.js";
import { runSync } from "./sync.js";

const inv = (cmd, args, opts) => window.__TAURI_INTERNALS__.invoke(cmd, args, opts);
const log = document.getElementById("log");
const say = (m) => { log.textContent += "\n" + m; };
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(3); };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout after " + ms + " ms")), ms))]);
const attempt = async (fn) => { try { const v = await fn(); return { ok: true, value: v }; } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 200) }; } };

async function ipc(cfg) {
  const out = {};
  out.open = await attempt(() => inv("db_open", { path: cfg.db }));
  const t = [];
  for (let i = 0; i < 1000; i++) { const a = performance.now(); await inv("db_ping"); t.push(performance.now() - a); }
  out.invoke_roundtrip_ms = { n: t.length, p50: pct(t, 50), p95: pct(t, 95), max: pct(t, 100) };
  const pg = [];
  const base = await inv("db_cursor");
  for (let i = 1; i <= 200; i++) { const a = performance.now(); await inv("db_apply_page", { batch: base + i, rows: 50 }); pg.push(performance.now() - a); }
  out.apply_page_50rows_via_ipc_ms = { n: pg.length, p50: pct(pg, 50), p95: pct(pg, 95), max: pct(pg, 100) };
  out.cursor_after = await inv("db_cursor");
  // The whole-state JSON value that KeyValueLocalStore writes after EVERY transaction.
  out.kv_whole_state_ms = {};
  for (const kb of [10, 100, 1000, 5000, 20000]) {
    const v = "x".repeat(kb * 1024);
    const a = performance.now();
    await inv("kv_write", { key: "state", value: v });
    const w = performance.now() - a;
    const b = performance.now();
    const back = await inv("kv_read", { key: "state" });
    out.kv_whole_state_ms[`${kb}KB`] = { write: +w.toFixed(1), read: +(performance.now() - b).toFixed(1), roundtrip_ok: back.length === v.length };
  }
  await inv("kv_remove", { key: "state" });
  return out;
}

async function fsscope(cfg) {
  const d = cfg.notes;
  const out = {};
  const read = (p) => attempt(async () => (await inv("plugin:fs|read_text_file", { path: p })).byteLength);
  const write = (p, text) => attempt(() => inv("plugin:fs|write_text_file", new TextEncoder().encode(text), { headers: { path: encodeURIComponent(p), options: "{}" } }));
  out.read_inside_before_grant = await read(`${d}/a.md`);
  out.read_dir_before_grant = await attempt(() => inv("plugin:fs|read_dir", { path: d }).then((r) => r.length));
  out.grant = await attempt(() => inv("grant_notes_folder", { path: d }));
  out.read_inside_after_grant = await read(`${d}/a.md`);
  out.read_dir_after_grant = await attempt(() => inv("plugin:fs|read_dir", { path: d }).then((r) => r.length));
  out.plugin_write_inside = await write(`${d}/written-by-plugin.md`, "# plugin write\n");
  out.read_outside_etc_hostname = await read("/etc/hostname");
  out.read_outside_parent_file = await read(`${d}/../outside-secret.txt`);
  out.read_dotdot_traversal = await read(`${d}/sub/../../outside-secret.txt`);
  out.read_symlink_file_to_outside = await read(`${d}/link-to-outside.md`);
  out.read_through_symlinked_dir = await read(`${d}/linkdir/outside-secret.txt`);
  out.read_dotfile_inside = await read(`${d}/.hidden.md`);
  out.read_nested_inside = await read(`${d}/sub/b.md`);
  out.read_sibling_dir_prefix = await read(`${d}-sibling/x.md`);
  out.write_outside = await write(`${d}/../should-not-exist.md`, "x");
  out.own_atomic_ok = await attempt(() => inv("notes_atomic_write", { rel: "sub/atomic.md", content: "# atomic\n" }));
  out.own_atomic_dotdot = await attempt(() => inv("notes_atomic_write", { rel: "../escape.md", content: "x" }));
  out.own_atomic_absolute = await attempt(() => inv("notes_atomic_write", { rel: "/tmp/escape.md", content: "x" }));
  out.own_atomic_symlink_dir = await attempt(() => inv("notes_atomic_write", { rel: "linkdir/escape.md", content: "x" }));
  out.own_scan = await attempt(() => inv("notes_scan"));
  out.undeclared_command = await attempt(() => inv("not_a_command"));
  out.token_get_does_not_exist = await attempt(() => inv("token_get"));
  out.plugin_shell_not_installed = await attempt(() => inv("plugin:shell|execute", {}));
  return out;
}

async function keystore() {
  const out = {};
  out.exists_initial = await attempt(() => inv("token_exists"));
  out.set = await attempt(() => inv("token_set", { token: "atd_spike_not_a_real_token" }));
  out.exists_after_set = await attempt(() => inv("token_exists"));
  out.get_command_exists = await attempt(() => inv("token_get"));
  out.delete = await attempt(() => inv("token_delete"));
  out.exists_after_delete = await attempt(() => inv("token_exists"));
  return out;
}

async function fetchChecks(cfg) {
  const out = { origin: location.origin };
  const f = async (url, init) => { try { const r = await fetch(url, init); return { status: r.status, body: (await r.text()).slice(0, 80) }; } catch (e) { return { error: String(e).slice(0, 120) }; } };
  out.direct_health = await f(`${cfg.api}/health`);
  out.direct_bearer_preflight = await f(`${cfg.api}/api/devices/current`, { headers: { Authorization: "Bearer atd_fake" } });
  out.direct_to_other_host_csp = await f("http://example.invalid/", {});
  out.sign_in = await attempt(() => inv("device_sign_in", { creds: { base: cfg.api, email: cfg.email, password: cfg.password, name: "spike-tauri" } }));
  const call = (url, headers = {}) => attempt(async () => { const r = await inv("api_request", { req: { method: "GET", url, headers, body: null } }); return { status: r.status, body: r.body.slice(0, 120) }; });
  out.rust_proxy_device_current = await call(`${cfg.api}/api/devices/current`, { Authorization: "Bearer placeholder-from-webview" });
  out.rust_proxy_other_origin = await call("http://127.0.0.1:9/api/devices/current");
  out.rust_proxy_http_nonloopback = await call("http://192.0.2.1/api/devices/current");
  out.rust_proxy_https_other_host = await call("https://example.com/");
  out.token_in_webview_storage = (() => { try { return JSON.stringify(localStorage).includes("atd_"); } catch { return "n/a"; } })();
  return out;
}

async function https(cfg) {
  // A self-signed HTTPS server (untrusted certificate): the Rust client must refuse the connection, not fall back to http.
  const sign = await attempt(() => inv("device_sign_in", { creds: { base: cfg.https_base, email: "x@example.com", password: "x", name: "tls" } }));
  const plain = await attempt(() => inv("device_sign_in", { creds: { base: cfg.https_base.replace("https:", "http:"), email: "x@example.com", password: "x", name: "tls" } }));
  return { untrusted_cert_sign_in: sign, http_to_non_loopback_name: plain };
}

async function sw() {
  const out = {};
  out.register = await attempt(async () => { const r = await navigator.serviceWorker.register("/sw-probe.js"); return r.scope; });
  out.controller = !!navigator.serviceWorker.controller;
  return out;
}

// S5: schedule a local notification `delay` seconds ahead through the real plugin (AlarmManager on Android).
async function s5(cfg) {
  const out = {};
  out.permission_before = await attempt(() => withTimeout(inv("plugin:notification|is_permission_granted"), 8000));
  out.request = await attempt(() => withTimeout(inv("plugin:notification|request_permission"), 8000));
  const delay = Number(cfg.delay || 60), idle = cfg.idle !== "0";
  const id = Number(cfg.nid || 4242);
  const at = new Date(Date.now() + delay * 1000);
  out.scheduled_for = at.toISOString();
  out.allow_while_idle = idle;
  out.schedule = await attempt(() => inv("plugin:notification|notify", { options: { id, title: "Atlas S5", body: `scheduled ${delay}s ahead, idle=${idle}`, schedule: { at: { date: at.toISOString(), repeating: false, allowWhileIdle: idle } } } }));
  out.pending = await attempt(() => inv("plugin:notification|get_pending"));
  return out;
}

async function main() {
  const ctx = await inv("ctx");
  const cfg = ctx.cfg;
  say(`suite=${cfg.suite} webkit=${ctx.webkitgtk} pid=${ctx.pid}`);
  const out = { ctx: { ...ctx, cfg: { ...cfg, password: undefined } }, probe: probe() };
  const suites = (cfg.suite || "probe").split(",");
  for (const s of suites) {
    say("running " + s);
    try {
      if (s === "ipc") out.ipc = await ipc(cfg);
      if (s === "fsscope") out.fsscope = await fsscope(cfg);
      if (s === "keystore") out.keystore = await keystore();
      if (s === "fetch") out.fetch = await fetchChecks(cfg);
      if (s === "sync") out.sync = await runSync(cfg, inv);
      if (s === "https") out.https = await https(cfg);
      if (s === "sw") out.sw = await sw();
      if (s === "s5") out.s5 = await s5(cfg);
      if (s === "notify") out.notify = await attempt(() => inv("notify_test"));
    } catch (e) { out[s] = { crashed: String(e?.stack ?? e) }; }
  }
  await inv("report", { name: `harness-${(cfg.suite || "probe").replace(/,/g, "_")}`, value: out });
  say("done");
  if (!suites.includes("hold")) await inv("exit_app");
}
main().catch(async (e) => { say("FAILED " + e); try { await inv("report", { name: "harness-error", value: String(e?.stack ?? e) }); await inv("exit_app"); } catch {} });
