// S8/S9 footprint: cold start and memory (PSS + RSS of the whole process tree) of the Tauri shell vs headless Chromium,
// both showing the same Atlas UI (signed in, 5 000-line note open) from the throwaway stack. Usage: node scripts/footprint.mjs [idleSeconds=30]
import { spawn, execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.env.SPIKE_OUT ?? path.join(tmpdir(), "atlas-spike-out");
const s = JSON.parse(readFileSync(path.join(out, "stack.json"), "utf8"));
const idle = Number(process.argv[2] ?? 30) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bin = process.env.BIN ?? path.join(here, "../target/release/atlas-spike");

function descendants(root) {
  const rows = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
  const kids = new Map(); for (const [p, pp] of rows) (kids.get(pp) ?? kids.set(pp, []).get(pp)).push(p);
  const all = [root], q = [root];
  while (q.length) for (const k of kids.get(q.shift()) ?? []) { all.push(k); q.push(k); }
  return all;
}
function mem(pids) {
  let pss = 0, rss = 0, n = 0;
  for (const p of pids) {
    try {
      const t = readFileSync(`/proc/${p}/smaps_rollup`, "utf8");
      pss += Number(/^Pss:\s+(\d+)/m.exec(t)[1]); rss += Number(/^Rss:\s+(\d+)/m.exec(t)[1]); n++;
    } catch { /* process gone */ }
  }
  return { processes: n, pss_mb: Math.round(pss / 1024), rss_mb_sum_double_counts_shared: Math.round(rss / 1024) };
}

const result = {};
// 1. Tauri shell: cold start to "page JS ran" (probe suite exits by itself), 5 runs
const starts = [];
for (let i = 0; i < 5; i++) {
  const profile = mkdtempSync(path.join(tmpdir(), "atlas-spike-prof-"));
  const o = mkdtempSync(path.join(tmpdir(), "atlas-spike-fp-"));
  const t = Date.now();
  const child = spawn(bin, [], { env: { ...process.env, SPIKE_SUITE: "probe", SPIKE_OUT: o, XDG_DATA_HOME: profile, XDG_CACHE_HOME: profile, WEBKIT_DISABLE_DMABUF_RENDERER: "1" }, stdio: "ignore" });
  let ready = null;
  while (Date.now() - t < 30000) { if (existsSync(path.join(o, "harness-probe.json"))) { ready = Date.now() - t; break; } await sleep(10); }
  starts.push(ready);
  await new Promise((r) => { child.once("exit", r); setTimeout(() => { child.kill(); r(); }, 5000); });
  rmSync(profile, { recursive: true, force: true }); rmSync(o, { recursive: true, force: true });
}
result.tauri_cold_start_to_page_js_done_ms = starts;

// 2. Tauri shell: Atlas UI signed in, big note open, idle
{
  const profile = mkdtempSync(path.join(tmpdir(), "atlas-spike-prof-"));
  const o = mkdtempSync(path.join(tmpdir(), "atlas-spike-fp-"));
  const child = spawn(bin, [], { env: { ...process.env, SPIKE_SUITE: "atlas", SPIKE_OUT: o, XDG_DATA_HOME: profile, XDG_CACHE_HOME: profile, WEBKIT_DISABLE_DMABUF_RENDERER: "1", SPIKE_ATLAS_SIZE: "1280x800",
    SPIKE_ATLAS_URL: `http://127.0.0.1:${s.webPort}/#hold=1&email=${s.owner.email}&password=${s.owner.password}` }, stdio: "ignore" });
  const t = Date.now();
  while (!existsSync(path.join(o, "scenario-webkit-desktop.json")) && Date.now() - t < 200000) await sleep(500);
  await sleep(idle);
  result.tauri_webkitgtk_atlas_ui = { ...mem(descendants(child.pid)), idle_seconds: idle / 1000 };
  child.kill(); await sleep(500);
  rmSync(profile, { recursive: true, force: true }); rmSync(o, { recursive: true, force: true });
}

// 3. Chromium (headless, started by us so the process tree is known), same UI, same steps, idle
{
  const prof = mkdtempSync(path.join(tmpdir(), "atlas-spike-chrome-"));
  const t = Date.now();
  const proc = spawn("/usr/bin/chromium", ["--headless=new", "--remote-debugging-port=9333", `--user-data-dir=${prof}`, "--no-first-run", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 100 && !browser; i++) { try { browser = await chromium.connectOverCDP("http://127.0.0.1:9333"); } catch { await sleep(100); } }
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${s.webPort}/`);
  result.chromium_launch_to_page_loaded_ms = Date.now() - t;
  await page.addScriptTag({ content: readFileSync(path.join(here, "../ui/scenario.js"), "utf8") });
  await page.evaluate(([email, password]) => window.__atlasScenario({ shot: async () => {}, log() {} }, { email, password }), [s.owner.email, s.owner.password]);
  await sleep(idle);
  result.chromium_headless_atlas_ui = { ...mem(descendants(proc.pid)), idle_seconds: idle / 1000 };
  proc.kill(); await sleep(500); rmSync(prof, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 1));
