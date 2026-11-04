// Chromium baseline for the S1 scenario: same ui/scenario.js, same throwaway stack, screenshots to $SPIKE_OUT/shots.
// Usage: node scripts/chromium.mjs [desktop|phone]   (system Chromium via playwright-core; headless)
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

const out = process.env.SPIKE_OUT ?? path.join(tmpdir(), "atlas-spike-out");
const s = JSON.parse(readFileSync(path.join(out, "stack.json"), "utf8"));
const size = process.argv[2] ?? "desktop";
const viewport = size === "phone" ? { width: 390, height: 800 } : { width: 1280, height: 800 };
const shots = path.join(out, "shots"); mkdirSync(shots, { recursive: true });
const scenario = readFileSync(new URL("../ui/scenario.js", import.meta.url), "utf8");

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", headless: true });
const ctx = await browser.newContext({ colorScheme: "dark", viewport, hasTouch: size === "phone", isMobile: size === "phone" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await page.exposeFunction("__shot", (name) => page.screenshot({ path: path.join(shots, `${name.replace(/^(desktop|phone)-/, "$1-chromium-")}.png`) }));
await page.addInitScript(scenario);
await page.goto(`http://127.0.0.1:${s.webPort}/`);
await page.waitForFunction(() => typeof window.__atlasScenario === "function");
const result = await page.evaluate(([email, password]) => window.__atlasScenario({ shot: (n) => window.__shot(n), log() {} }, { email, password }), [s.owner.email, s.owner.password]);
result.consoleErrors = errors.slice(0, 20);
if (size === "desktop") {
  await page.evaluate(() => { const l = [...document.querySelectorAll("a,button")].find((e) => (e.textContent || "").trim() === "Notes"); l?.click(); });
  await page.waitForTimeout(500);
  await page.evaluate(() => [...document.querySelectorAll("button,a")].find((e) => (e.getAttribute("aria-label") || e.textContent || "").trim() === "Big note")?.click());
  await page.waitForSelector(".cm-content", { timeout: 20000 });
  result.perf = {};
  for (const mode of ["Live", "Source"]) result.perf[mode] = await page.evaluate((m) => window.__editorPerf(m), mode);
}
writeFileSync(path.join(out, `scenario-chromium-${size}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ size, ok: Object.entries(result.steps).filter(([, v]) => v.ok).length, failed: Object.entries(result.steps).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.error}`), perf: result.perf, errors: errors.length }, null, 1));
await browser.close();
