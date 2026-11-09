/**
 * Starts the REAL API against a throwaway database `atlas_e2e_<random>` (never the owner's `atlas`
 * database or dev stack), the same way `apps/web/e2e-real/global-setup.ts` does, and removes it
 * afterwards. `db_admin.py` refuses any other database name.
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Req, Resp } from "../model/common.ts";
import type { ServerPort } from "../engineBridge.ts";

const here = import.meta.dirname;
const root = path.resolve(here, "../../../..");
const apiDir = path.join(root, "services/api");
const binDir = process.env["ATLAS_E2E_API_BIN_DIR"] ?? path.join(apiDir, ".venv/bin");
const adminUrl = process.env["ATLAS_E2E_ADMIN_DATABASE_URL"] ?? "postgresql://atlas:atlas@127.0.0.1:5432/postgres";
const dbAdmin = path.join(root, "apps/web/e2e-real/db_admin.py");
const python = path.join(binDir, "python");
const OWNER = { email: "owner@example.com", password: "sync-core-test-password-1", display_name: "Sim Owner" };

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

export interface Stack {
  baseUrl: string;
  dbName: string;
  stop(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  if (!existsSync(python)) throw new Error(`API interpreter not found at ${python}`);
  const dbName = `atlas_e2e_${randomBytes(6).toString("hex")}`;
  const url = new URL(adminUrl);
  url.pathname = `/${dbName}`;
  const dbUrl = url.toString().replace(/^postgresql:/, "postgresql+psycopg:");
  const run = (cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
    const r = spawnSync(cmd, args, { cwd: apiDir, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`${cmd} ${args[0] ?? ""} failed: ${r.stderr || r.stdout}`);
  };
  run(python, [dbAdmin, "create", adminUrl, dbName]);
  const notesDir = await mkdtemp(path.join(tmpdir(), "atlas-synccore-notes-"));
  let api: ChildProcess | undefined;
  const cleanup = async () => {
    if (api && api.exitCode === null) {
      api.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => (api!.kill("SIGKILL"), resolve()), 5000);
        api!.once("exit", () => (clearTimeout(timer), resolve()));
      });
    }
    run(python, [dbAdmin, "drop", adminUrl, dbName]);
    await rm(notesDir, { recursive: true, force: true });
  };
  try {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env, ATLAS_ENV: "test", DATABASE_URL: dbUrl, NOTES_ROOT: notesDir,
      BACKUP_DIR: path.join(notesDir, "backups"), EXPORT_DIR: path.join(notesDir, "exports"),
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`, AUTH_RATE_LIMIT_PER_MINUTE: "100000",
    };
    run(path.join(binDir, "atlas-migrate"), [], env);
    const logs: string[] = [];
    api = spawn(python, [path.join(here, "serve.py"), String(port)], { cwd: apiDir, env, stdio: ["ignore", "pipe", "pipe"] });
    api.stdout?.on("data", (d) => logs.push(String(d)));
    api.stderr?.on("data", (d) => logs.push(String(d)));
    const baseUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 60_000;
    for (;;) {
      if (api.exitCode !== null) throw new Error(`API exited early:\n${logs.join("")}`);
      try {
        if ((await fetch(`${baseUrl}/health`)).ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) throw new Error(`API did not start:\n${logs.join("")}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    return { baseUrl, dbName, stop: cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** The real API behind the simulation's {@link ServerPort}: every client signs in as its own device. */
export class RealServer implements ServerPort {
  private tokens = new Map<string, string>();
  private deviceIds = new Map<string, string>();
  private cookie = "";
  private csrf = "";
  servedAfterRevoke: string[] = [];
  private revoked = new Set<string>();

  constructor(private readonly stack: Stack) {}

  async setupOwner(): Promise<void> {
    const r = await fetch(`${this.stack.baseUrl}/api/auth/setup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(OWNER),
    });
    if (r.status !== 201) throw new Error(`setup failed: ${r.status} ${await r.text()}`);
    const jar = new Map<string, string>();
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair!.split("=");
      jar.set(k!, v!);
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    this.csrf = jar.get("atlas_csrf") ?? "";
  }

  /** The owner's default reminder timing (09:00 on the due date), so the server derives reminders. */
  async setReminderDefault(): Promise<void> {
    const r = await fetch(`${this.stack.baseUrl}/api/notifications/reminders`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: this.cookie, "X-CSRF-Token": this.csrf },
      body: JSON.stringify({ default: { days_before: 0, at_time: "09:00" } }),
    });
    if (r.status !== 200) throw new Error(`default reminder timing failed: ${r.status} ${await r.text()}`);
  }

  async addDevice(cid: string): Promise<void> {
    const r = await fetch(`${this.stack.baseUrl}/api/devices`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: OWNER.email, password: OWNER.password, name: `sim ${cid}`, platform: "other" }),
    });
    if (r.status !== 201) throw new Error(`device sign-in failed: ${r.status} ${await r.text()}`);
    const body = (await r.json()) as { token: string; device: { id: string } };
    this.tokens.set(cid, body.token);
    this.deviceIds.set(cid, body.device.id);
  }

  async revokeDevice(cid: string): Promise<void> {
    const r = await fetch(`${this.stack.baseUrl}/api/devices/${this.deviceIds.get(cid)}`, {
      method: "DELETE", headers: { Cookie: this.cookie, "X-CSRF-Token": this.csrf },
    });
    if (r.status !== 204) throw new Error(`revoke failed: ${r.status}`);
    this.revoked.add(cid);
  }

  async handle(req: Req): Promise<Resp> {
    const headers: Record<string, string> = {};
    let cid: string | undefined;
    for (const [k, v] of Object.entries(req.headers)) {
      if (k === "X-Sim-Client") cid = v;
      else if (k !== "X-Client-Time") headers[k] = v;
    }
    if (cid && this.tokens.has(cid)) headers["Authorization"] = `Bearer ${this.tokens.get(cid)}`;
    else {
      headers["Cookie"] = this.cookie;
      if (req.method !== "GET") headers["X-CSRF-Token"] = this.csrf;
    }
    const query = Object.keys(req.params).length
      ? "?" + Object.entries(req.params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")
      : "";
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== null) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(req.body);
    }
    const r = await fetch(`${this.stack.baseUrl}${req.path}${query}`, init);
    const text = await r.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (cid && this.revoked.has(cid) && r.status < 300) this.servedAfterRevoke.push(`${cid} ${req.method} ${req.path}`);
    return { status: r.status, body };
  }

  async head(): Promise<number> {
    const r = await this.handle({ method: "GET", path: "/api/changes", params: { since: 2 ** 53 - 1 }, body: null, headers: { "Atlas-Sync": "1" } });
    return Number((r.body as { next_since: number }).next_since);
  }

  async allEntityIds(): Promise<string[]> {
    const sql = "SELECT id::text FROM tasks UNION ALL SELECT id::text FROM projects UNION ALL SELECT id::text FROM notes";
    const out = execFileSync("docker", ["exec", "atlas-db-1", "psql", "-U", "atlas", "-d", this.stack.dbName, "-Atc", sql], { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  }
}
