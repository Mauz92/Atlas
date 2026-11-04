import { SyncEngine } from "../engine.ts";
import { fixedClock, seededRandom, sequenceIds } from "../testing/fakes.ts";
import { createFetchTransport, KeyValueLocalStore, legacyQueueSnapshot, type KeyValue } from "./index.ts";

function memoryKv(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    read: async (k) => data.get(k) ?? null,
    write: async (k, v) => void data.set(k, v),
    remove: async (k) => void data.delete(k),
  };
}

describe("KeyValueLocalStore", () => {
  it("survives a restart and loses a failed transaction", async () => {
    const kv = memoryKv();
    const first = new KeyValueLocalStore(kv);
    await first.transaction(async (tx) => tx.setMeta("cursor", 5));
    await expect(first.transaction(async (tx) => { await tx.setMeta("cursor", 9); throw new Error("x"); })).rejects.toThrow();
    const second = new KeyValueLocalStore(kv);
    expect(await second.transaction(async (tx) => tx.getMeta("cursor"))).toBe(5);
  });
  it("aborts the transaction when the write fails", async () => {
    const kv = memoryKv();
    const store = new KeyValueLocalStore(kv);
    kv.write = async () => { throw new Error("quota"); };
    await expect(store.transaction(async (tx) => tx.setMeta("a", 1))).rejects.toThrow("quota");
    expect(await store.transaction(async (tx) => tx.getMeta("a"))).toBeUndefined();
  });
  it("treats unreadable state as empty", async () => {
    const kv = memoryKv();
    kv.data.set("atlas-sync-core-state", "{not json");
    expect(await new KeyValueLocalStore(kv).transaction(async (tx) => tx.listEntities())).toEqual([]);
  });
});

describe("createFetchTransport", () => {
  const fetchOk = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => ({
    status: 200,
    headers: { forEach: (cb: (v: string, k: string) => void) => cb("2", "Retry-After") },
    text: async () => JSON.stringify({ url, init }),
  });
  it("builds the URL, sends JSON and lower-cases header names", async () => {
    const t = createFetchTransport({ baseUrl: "https://atlas.example/", fetch: fetchOk });
    const r = await t.send({ method: "POST", path: "/api/tasks", query: { a: "b c" }, body: { x: 1 }, headers: { "Atlas-Sync": "1" } });
    expect(r.headers["retry-after"]).toBe("2");
    expect(r.body).toMatchObject({ url: "https://atlas.example/api/tasks?a=b%20c", init: { method: "POST", body: '{"x":1}' } });
  });
  it("refuses plain http except loopback", () => {
    expect(() => createFetchTransport({ baseUrl: "http://atlas.example", fetch: fetchOk })).toThrow(/https/);
    expect(() => createFetchTransport({ baseUrl: "http://localhost:8000", fetch: fetchOk })).not.toThrow();
  });
});

describe("legacyQueueSnapshot", () => {
  it("shows pending task operations in the M7 shape", async () => {
    const store = new KeyValueLocalStore(memoryKv());
    const engine = new SyncEngine({ store, transport: { send: async () => { throw new Error("offline"); } }, clock: fixedClock(), ids: sequenceIds(1), random: seededRandom(1) });
    const id = await engine.createEntity("task", { title: "x" });
    const snap = await legacyQueueSnapshot(store);
    expect(snap).toMatchObject({ total: 1, pending: 1, conflicts: 0, failed: 0 });
    expect(snap.operations[0]).toMatchObject({ entityId: id, entityType: "task", mutation: "create", status: "pending" });
  });
});
