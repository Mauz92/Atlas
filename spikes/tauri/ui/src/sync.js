// Real sync round trip from the Tauri webview using packages/sync-core (imported read-only from the repo):
//   LocalStore  = KeyValueLocalStore over the Rust SQLite `kv_*` commands (whole-state JSON per transaction)
//   Transport   = createFetchTransport over the Rust `api_request` command (HTTPS-only check, bearer attached in Rust)
//   Credentials = a placeholder: the real token never reaches the webview
import { SyncEngine } from "../../../../packages/sync-core/src/index.ts";
import { KeyValueLocalStore, createFetchTransport } from "../../../../packages/sync-core/src/adapters/index.ts";

const attempt = async (fn) => { try { return { ok: true, value: await fn() }; } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 300) }; } };

export async function runSync(cfg, inv) {
  const out = {};
  await inv("db_open", { path: cfg.db });
  const kv = {
    read: (key) => inv("kv_read", { key }),
    write: (key, value) => inv("kv_write", { key, value }),
    remove: (key) => inv("kv_remove", { key }),
  };
  let persistedBytes = 0, persistCalls = 0;
  const countingKv = { ...kv, write: async (k, v) => { persistedBytes += v.length; persistCalls++; return kv.write(k, v); } };
  const api = (method, path, body) => inv("api_request", { req: { method, url: `${cfg.api}${path}`, headers: { "Content-Type": "application/json", Accept: "application/json" }, body: body === undefined ? null : JSON.stringify(body) } });

  const signIn = await attempt(() => inv("device_sign_in", { creds: { base: cfg.api, email: cfg.email, password: cfg.password, name: "spike-sync" } }));
  out.sign_in = signIn.ok ? { ok: true, device: signIn.value.name } : signIn;
  if (!signIn.ok) return out;

  const make = (store) => new SyncEngine({
    store,
    transport: createFetchTransport({
      baseUrl: cfg.api,
      fetch: async (url, init) => {
        const r = await inv("api_request", { req: { method: init.method, url, headers: init.headers, body: init.body ?? null } });
        return { status: r.status, headers: { forEach: (cb) => Object.entries(r.headers).forEach(([k, v]) => cb(v, k)) }, text: async () => r.body };
      },
    }),
    clock: { monotonic: () => performance.now(), wallTime: () => Date.now() },
    ids: { uuid: () => crypto.randomUUID() },
    random: { next: Math.random },
    credentials: { getToken: () => "placeholder-the-real-token-lives-in-rust" },
  });

  const engine = make(new KeyValueLocalStore(countingKv));
  let t = performance.now();
  const taskId = await engine.createEntity("task", { title: "Created in the Tauri webview" });
  const noteId = await engine.createNote("spike/from-tauri.md", "# From Tauri\n\nHello.\n");
  out.local_create_ms = +(performance.now() - t).toFixed(1);
  t = performance.now();
  await engine.syncUntilSettled();
  out.push_and_first_pull_ms = +(performance.now() - t).toFixed(1);
  out.status_after_push = await engine.getStatus();

  const tasks = await api("GET", "/api/tasks");
  const notes = await api("GET", "/api/notes");
  out.server_has_task = JSON.parse(tasks.body).items?.some?.((x) => x.id === taskId) ?? JSON.stringify(JSON.parse(tasks.body)).includes(taskId);
  out.server_has_note = JSON.stringify(JSON.parse(notes.body)).includes(noteId);

  // Another client writes through the same API; this engine must pull it.
  const other = await api("POST", "/api/tasks", { title: "Created by another client", id: crypto.randomUUID() });
  out.other_client_create_status = other.status;
  await engine.requestPull?.();
  await engine.syncUntilSettled();
  const views = await engine.views();
  out.pulled_other_clients_task = views.some((v) => JSON.stringify(v).includes("Created by another client"));

  // Persistence: a NEW engine over the same SQLite file sees the same data without the network.
  const engine2 = make(new KeyValueLocalStore(kv));
  const views2 = await engine2.views();
  out.restart_sees_entities = views2.length;
  out.restart_has_task_and_note = views2.some((v) => JSON.stringify(v).includes("Created in the Tauri webview")) && views2.some((v) => JSON.stringify(v).includes("From Tauri"));

  // Cost of the whole-state JSON store: N local creates, every transaction rewrites the state.
  persistedBytes = 0; persistCalls = 0;
  const engine3 = make(new KeyValueLocalStore(countingKv));
  t = performance.now();
  for (let i = 0; i < 300; i++) await engine3.createEntity("task", { title: `bulk ${i}` });
  out.bulk_300_creates_ms = +(performance.now() - t).toFixed(0);
  out.bulk_300_persist_calls = persistCalls;
  out.bulk_300_bytes_written_mb = +(persistedBytes / 1048576).toFixed(1);
  t = performance.now();
  await engine3.syncUntilSettled(2000);
  out.bulk_300_sync_ms = +(performance.now() - t).toFixed(0);
  out.bulk_status = await engine3.getStatus();
  engine.dispose?.(); engine2.dispose?.(); engine3.dispose?.();
  return out;
}
