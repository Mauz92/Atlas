// Throwaway stack for the spike: database atlas_spike_<random> in the existing Postgres container,
// the real API on its own port, a static+proxy server for the built web UI, and one owner account.
// Usage: node stack.mjs up <webDist> | down      State: $SPIKE_OUT/stack.json
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "../../../services/api");
const bin = path.join(apiDir, ".venv", "bin");
const out = process.env.SPIKE_OUT ?? path.join(tmpdir(), "atlas-spike-out");
const stateFile = path.join(out, "stack.json");
const adminUrl = process.env.SPIKE_ADMIN_DATABASE_URL ?? "postgresql://atlas:atlas@127.0.0.1:5432/postgres";
mkdirSync(out, { recursive: true });

const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const sh = (cmd, args, env = process.env) => { const r = spawnSync(cmd, args, { env, encoding: "utf8", cwd: apiDir }); if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr || r.stdout}`); };
const wait = async (url) => { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); } throw new Error("not ready " + url); };

if (process.argv[2] === "up") {
  const dist = path.resolve(process.argv[3]);
  const name = `atlas_spike_${randomBytes(5).toString("hex")}`;
  sh(path.join(bin, "python"), [path.join(here, "db_admin.py"), "create", adminUrl, name]);
  const notes = mkdtempSync(path.join(tmpdir(), "atlas-spike-notes-"));
  const apiPort = await freePort(), webPort = await freePort();
  const u = new URL(adminUrl); u.pathname = `/${name}`;
  const env = {
    ...process.env, ATLAS_ENV: "test", DATABASE_URL: u.toString().replace(/^postgresql:/, "postgresql+psycopg:"),
    NOTES_ROOT: notes, BACKUP_DIR: path.join(notes, "backups"), EXPORT_DIR: path.join(notes, "exports"),
    PUBLIC_BASE_URL: `http://127.0.0.1:${webPort}`, AUTH_RATE_LIMIT_PER_MINUTE: "1000",
    CORS_ORIGINS: process.env.SPIKE_CORS_ORIGINS ?? "tauri://localhost,http://tauri.localhost",
  };
  sh(path.join(bin, "atlas-migrate"), [], env);
  const log = openSync(path.join(out, "api.log"), "a");
  const api = spawn(path.join(bin, "python"), ["-m", "uvicorn", "atlas.main:app", "--host", "127.0.0.1", "--port", String(apiPort)], { cwd: apiDir, env, detached: true, stdio: ["ignore", log, log] });
  api.unref();
  await wait(`http://127.0.0.1:${apiPort}/health`);
  const web = spawn("node", [path.join(here, "serve.mjs"), dist, String(webPort), String(apiPort)], { detached: true, stdio: "ignore" });
  web.unref();
  await wait(`http://127.0.0.1:${webPort}/`);
  const owner = { email: "spike-owner@example.com", password: "spike-throwaway-password-1", display_name: "Spike Owner" };
  const r = await fetch(`http://127.0.0.1:${apiPort}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
  if (r.status !== 201) throw new Error("setup failed " + r.status + await r.text());
  writeFileSync(stateFile, JSON.stringify({ db: name, notes, apiPort, webPort, apiPid: api.pid, webPid: web.pid, owner, admin: adminUrl }, null, 2));
  console.log(readFileSync(stateFile, "utf8"));
} else if (process.argv[2] === "down") {
  if (!existsSync(stateFile)) { console.log("no stack"); process.exit(0); }
  const s = JSON.parse(readFileSync(stateFile, "utf8"));
  for (const pid of [s.webPid, s.apiPid]) { try { process.kill(pid, "SIGTERM"); } catch {} }
  await new Promise((r) => setTimeout(r, 1500));
  sh(path.join(bin, "python"), [path.join(here, "db_admin.py"), "drop", s.admin, s.db]);
  rmSync(s.notes, { recursive: true, force: true });
  rmSync(stateFile);
  console.log("dropped", s.db);
}
