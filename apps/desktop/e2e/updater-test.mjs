// SYNC-09e: the auto-update path, with a THROWAWAY key, a local server and nothing published (docs/TESTING.md section 13).
//
//   node e2e/updater-test.mjs        (builds two test AppImages, 0.1.0 and 0.2.0, with the `updater` and `e2e` features: ~10 minutes)
//
// Cases (as SYNC-07 S6): a valid 0.2.0 is downloaded, verified and installed in place; a bundle altered by one byte after signing is
// refused; a bundle signed with ANOTHER key is refused; the installed version stays 0.1.0 in both refusals. The product build contains
// none of this: it has no `updater` feature and no endpoint.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, "..");
const work = mkdtempSync(path.join(tmpdir(), "atlas-updater-test-"));
const keys = path.join(work, "keys"); mkdirSync(keys);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: "utf8", cwd: app, ...opts }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`); return r.stdout; };
const results = [];
const PORT = 18778;

function keypair(name) {
  sh("npx", ["tauri", "signer", "generate", "-w", path.join(keys, name), "-p", "", "-f"]);
  return { priv: readFileSync(path.join(keys, name), "utf8"), pub: readFileSync(path.join(keys, `${name}.pub`), "utf8").trim() };
}
function build(version, key, outName) {
  const overlay = JSON.parse(readFileSync(path.join(app, "src-tauri/tauri.updater.conf.json"), "utf8").replace("__PUBLIC_KEY__", key.pub).replace("__UPDATE_ENDPOINT__", `http://127.0.0.1:${PORT}/latest.json`));
  overlay.version = version;
  overlay.plugins.updater.dangerousInsecureTransportProtocol = true; // a local http server: only in this test overlay
  overlay.app = JSON.parse(readFileSync(path.join(app, "src-tauri/tauri.e2e.conf.json"), "utf8")).app;
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: key.priv, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "", NO_STRIP: "1", CARGO_TARGET_DIR: path.join(app, "target-updater") };
  sh("bash", ["-c", `source ~/.cargo/env; npx tauri build -c '${JSON.stringify(overlay)}' --bundles appimage -- --features updater,e2e --locked`], { env });
  const dir = path.join(app, "target-updater/release/bundle/appimage");
  copyFileSync(path.join(dir, `Atlas_${version}_amd64.AppImage`), path.join(work, outName));
  copyFileSync(path.join(dir, `Atlas_${version}_amd64.AppImage.sig`), path.join(work, `${outName}.sig`));
}

async function runCase(name, v1, served, latest) {
  const dir = mkdtempSync(path.join(tmpdir(), "atlas-updater-run-"));
  const installed = path.join(dir, "Atlas.AppImage");
  copyFileSync(v1, installed);
  sh("chmod", ["+x", installed]);
  writeFileSync(path.join(dir, "latest.json"), JSON.stringify(latest));
  const server = createServer((req, res) => {
    const file = req.url === "/latest.json" ? path.join(dir, "latest.json") : served;
    res.writeHead(200); createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  const out = mkdtempSync(path.join(tmpdir(), "atlas-updater-out-"));
  const driver = path.join(out, "driver.js");
  writeFileSync(driver, readFileSync(path.join(here, "driver.js"), "utf8").replace("__E2E_CONFIG__", JSON.stringify({ updaterOnly: true })));
  if (spawnSync("pgrep", ["-x", "atlas-desktop"]).status === 0) throw new Error("an atlas-desktop process is already running: the single-instance lock would make this case meaningless");
  const child = spawn(installed, [], { detached: true, env: { ...process.env, ATLAS_DESKTOP_DATA_DIR: path.join(dir, "data"), ATLAS_E2E_OUT: out, ATLAS_E2E_SCRIPT: driver, APPIMAGE_EXTRACT_AND_RUN: "1" }, stdio: "ignore" });
  const report = path.join(out, "update-result.json");
  for (let i = 0; i < 240 && !existsSync(report); i++) await sleep(500);
  const r = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : { error: "no report (the app may have been replaced and restarted by the installer)" };
  try { process.kill(-child.pid, "SIGKILL"); } catch {} // the AppImage wrapper AND the app it started
  spawnSync("pkill", ["-x", "atlas-desktop"]);
  await sleep(1500);
  server.close();
  const hash = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
  const h = hash(installed);
  const afterVersion = h === hash(v1) ? "still 0.1.0 (file byte-identical)" : h === hash(path.join(work, "v2.AppImage")) ? "now 0.2.0 (file replaced by the signed update)" : "CHANGED to something else";
  results.push({ name, report: r, installedAfter: afterVersion });
  console.log(name, JSON.stringify(r), "| installed binary says:", afterVersion);
  rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
}

try {
  const good = keypair("good"); const other = keypair("other");
  build("0.1.0", good, "v1.AppImage");
  build("0.2.0", good, "v2.AppImage");
  // v2 signed by the OTHER key
  sh("npx", ["tauri", "signer", "sign", "-f", path.join(keys, "other"), "-p", "", path.join(work, "v2.AppImage")]);
  copyFileSync(path.join(work, "v2.AppImage.sig"), path.join(work, "v2-other.sig"));
  sh("npx", ["tauri", "signer", "sign", "-f", path.join(keys, "good"), "-p", "", path.join(work, "v2.AppImage")]); // restore the good signature
  const goodSig = readFileSync(path.join(work, "v2.AppImage.sig"), "utf8");
  const latest = (sig) => ({ version: "0.2.0", notes: "test", pub_date: new Date().toISOString(), platforms: { "linux-x86_64": { signature: sig, url: `http://127.0.0.1:${PORT}/v2.AppImage` } } });
  // a tampered copy: one byte flipped after signing
  const tampered = path.join(work, "v2-tampered.AppImage");
  const bytes = readFileSync(path.join(work, "v2.AppImage")); bytes[bytes.length - 100] ^= 0xff; writeFileSync(tampered, bytes);
  await runCase("valid", path.join(work, "v1.AppImage"), path.join(work, "v2.AppImage"), latest(goodSig));
  await runCase("tampered", path.join(work, "v1.AppImage"), tampered, latest(goodSig));
  await runCase("wrong-key", path.join(work, "v1.AppImage"), path.join(work, "v2.AppImage"), latest(readFileSync(path.join(work, "v2-other.sig"), "utf8")));
} finally {
  rmSync(work, { recursive: true, force: true });
  writeFileSync(path.join(here, "results/updater-last.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}
