import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Real-stack journey harness (MU-00, ADR-0043).
 *
 * Per run this: creates a uniquely named throwaway PostgreSQL database (`atlas_e2e_<random>`),
 * migrates it with `atlas-migrate`, creates a temporary notes directory, starts the real FastAPI
 * app from `services/api` on a free port, and starts the Vite dev server proxied to it on another
 * free port. Teardown stops both processes, drops the database and removes the notes directory.
 * The app's own databases are never used: `db_admin.py` refuses any name not matching
 * `atlas_e2e_*`.
 *
 * Environment (all optional):
 *  - ATLAS_E2E_ADMIN_DATABASE_URL  libpq URL of a maintenance DB on the server
 *                                  (default postgresql://atlas:atlas@127.0.0.1:5432/postgres)
 *  - ATLAS_E2E_API_BIN_DIR         directory holding `python` and `atlas-migrate`
 *                                  (default services/api/.venv/bin)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, "..");
const apiDir = path.resolve(webDir, "../../services/api");
const binDir = process.env.ATLAS_E2E_API_BIN_DIR ?? path.join(apiDir, ".venv", "bin");
const python = path.join(binDir, "python");
const adminUrl =
  process.env.ATLAS_E2E_ADMIN_DATABASE_URL ?? "postgresql://atlas:atlas@127.0.0.1:5432/postgres";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env, cwd = apiDir) {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args[0] ?? ""} failed (${result.status}): ${result.stderr || result.stdout}`,
    );
  }
}

async function waitFor(url: string, child: ChildProcess, label: string, logs: string[]) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early (${child.exitCode}):\n${logs.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${label} did not become ready at ${url}:\n${logs.join("")}`);
}

function start(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, logs: string[]) {
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false });
  child.stdout?.on("data", (d) => logs.push(String(d)));
  child.stderr?.on("data", (d) => logs.push(String(d)));
  return child;
}

async function stop(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export default async function globalSetup() {
  if (!existsSync(python)) {
    throw new Error(
      `API interpreter not found at ${python}. Create services/api/.venv (pip install -e ".[dev]") ` +
        `or set ATLAS_E2E_API_BIN_DIR.`,
    );
  }

  const dbName = `atlas_e2e_${randomBytes(6).toString("hex")}`;
  const adminParsed = new URL(adminUrl);
  adminParsed.pathname = `/${dbName}`;
  const dbUrl = adminParsed.toString().replace(/^postgresql:/, "postgresql+psycopg:");
  let notesDir: string | undefined;
  let api: ChildProcess | undefined;
  let web: ChildProcess | undefined;
  let created = false;
  const logs: string[] = [];

  const cleanup = async () => {
    await stop(web);
    await stop(api);
    if (created) {
      run(python, [path.join(here, "db_admin.py"), "drop", adminUrl, dbName]);
      created = false;
    }
    if (notesDir) await rm(notesDir, { recursive: true, force: true });
  };

  try {
    run(python, [path.join(here, "db_admin.py"), "create", adminUrl, dbName]);
    created = true;
    notesDir = await mkdtemp(path.join(tmpdir(), "atlas-e2e-notes-"));

    const apiPort = await freePort();
    const webPort = await freePort();
    const apiEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ATLAS_ENV: "test",
      DATABASE_URL: dbUrl,
      NOTES_ROOT: notesDir,
      BACKUP_DIR: path.join(notesDir, "backups"),
      EXPORT_DIR: path.join(notesDir, "exports"),
      PUBLIC_BASE_URL: `http://127.0.0.1:${webPort}`,
      AUTH_RATE_LIMIT_PER_MINUTE: "1000",
    };
    run(path.join(binDir, "atlas-migrate"), [], apiEnv);

    api = start(
      python,
      ["-m", "uvicorn", "atlas.main:app", "--host", "127.0.0.1", "--port", String(apiPort)],
      apiEnv,
      apiDir,
      logs,
    );
    await waitFor(`http://127.0.0.1:${apiPort}/health`, api, "API", logs);

    web = start(
      path.join(webDir, "node_modules", ".bin", "vite"),
      ["--host", "127.0.0.1", "--port", String(webPort), "--strictPort"],
      { ...process.env, ATLAS_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
      webDir,
      logs,
    );
    await waitFor(`http://127.0.0.1:${webPort}/`, web, "web", logs);

    // Workers are spawned after globalSetup and inherit this.
    process.env.ATLAS_E2E_BASE_URL = `http://127.0.0.1:${webPort}`;
  } catch (err) {
    await cleanup();
    throw err;
  }

  return cleanup;
}
