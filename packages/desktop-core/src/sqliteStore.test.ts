import type { LocalEntity, QueueOp } from "../../sync-core/src/index.ts";
import { MemoryStore } from "../../sync-core/src/testing/index.ts";
import { DbCrash, FakeRowDb } from "./testing/index.ts";
import { SqliteLocalStore } from "./sqliteStore.ts";

const entity = (id: string, type: LocalEntity["type"] = "task"): LocalEntity => ({
  id, type, server: null, deleted: false, deletedRevision: null, refetch: false,
});
const op = (id: string, seq: number): QueueOp => ({
  id, seq, key: `k-${id}`, type: "task", action: "create", entityId: `e-${id}`, fields: { title: id },
  userBase: null, chainBase: null, base: null, baseHash: null, content: null, frozen: false, attempts: 0, createdAt: 0,
});

function make() {
  const db = new FakeRowDb();
  return { db, store: new SqliteLocalStore(db) };
}

describe("SqliteLocalStore over the row port", () => {
  it("a transaction is one atomic commit of exactly the rows it changed", async () => {
    const { db, store } = make();
    await store.transaction(async (tx) => {
      await tx.putEntity(entity("a"));
      await tx.putEntity(entity("b"));
      await tx.putOp(op("1", 1));
      await tx.setMeta("cursor", 42);
    });
    expect(db.commits).toBe(1);
    expect([...db.dumpTable("entities").keys()].sort()).toEqual(["a", "b"]);
    // a second transaction touching one row writes one row, not the database
    const seen: number[] = [];
    const original = db.commit.bind(db);
    db.commit = async (ops) => (seen.push(ops.length), original(ops));
    await store.transaction(async (tx) => tx.putEntity({ ...entity("a"), deleted: true }));
    expect(seen).toEqual([1]);
  });

  it("reads inside a transaction see its own writes; an exception discards them all", async () => {
    const { db, store } = make();
    await store.transaction(async (tx) => tx.putEntity(entity("keep")));
    await expect(
      store.transaction(async (tx) => {
        await tx.putEntity(entity("lost"));
        await tx.removeEntity("keep");
        expect((await tx.listEntities()).map((e) => e.id)).toEqual(["lost"]);
        expect(await tx.getEntity("keep")).toBeUndefined();
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect([...db.dumpTable("entities").keys()]).toEqual(["keep"]);
  });

  it("a crash before the commit loses the whole transaction, page and cursor together", async () => {
    const { db, store } = make();
    await store.transaction(async (tx) => tx.setMeta("cursor", 1));
    db.crashBeforeCommit = () => true;
    await expect(
      store.transaction(async (tx) => {
        await tx.putEntity(entity("page-row"));
        await tx.setMeta("cursor", 2);
      }),
    ).rejects.toBeInstanceOf(DbCrash);
    expect(db.dumpTable("meta").get("cursor")).toBe(1);
    expect(db.dumpTable("entities").size).toBe(0);
  });

  it("the queue is ordered by seq, across committed rows and the overlay", async () => {
    const { store } = make();
    await store.transaction(async (tx) => {
      await tx.putOp(op("c", 3));
      await tx.putOp(op("a", 1));
    });
    const order = await store.transaction(async (tx) => {
      await tx.putOp(op("b", 2));
      await tx.removeOp("c");
      return (await tx.listQueue()).map((o) => o.id);
    });
    expect(order).toEqual(["a", "b"]);
  });

  it("clearResolutions hides committed rows from later reads in the same transaction and removes them", async () => {
    const { db, store } = make();
    const r = (id: string) => ({ id } as never);
    await store.transaction(async (tx) => {
      await tx.putResolution(r("r1"));
    });
    await store.transaction(async (tx) => {
      await tx.clearResolutions();
      expect(await tx.listResolutions()).toEqual([]);
      await tx.putResolution(r("r2"));
      expect((await tx.listResolutions()).map((x) => x.id)).toEqual(["r2"]);
    });
    expect([...db.dumpTable("resolutions").keys()]).toEqual(["r2"]);
  });

  it("matches the in-memory reference store on the same sequence of operations", async () => {
    const { store } = make();
    const memory = new MemoryStore();
    const script = async (tx: Parameters<typeof store.transaction>[0] extends (tx: infer T) => unknown ? T : never) => {
      await tx.putEntity(entity("x", "note"));
      await tx.putEntity(entity("y"));
      await tx.putOp(op("2", 2));
      await tx.putOp(op("1", 1));
      await tx.setMeta("types_synced", ["task", "project", "note", "reminder"]);
      await tx.putDraft({ entityId: "x", text: "t", baseRevision: 1, baseHash: "h", baseText: "b", inFlightOp: null, frozenText: null, rebaseFrom: null });
      await tx.removeEntity("y");
    };
    const read = async (s: typeof store | MemoryStore) =>
      s.transaction(async (tx) => ({
        entities: await tx.listEntities(),
        queue: await tx.listQueue(),
        types: await tx.getMeta("types_synced"),
        draft: await tx.getDraft("x"),
      }));
    await store.transaction(script);
    await memory.transaction(script);
    expect(await read(store)).toEqual(await read(memory));
  });

  it("refuses a table the host does not know", async () => {
    const db = new FakeRowDb();
    await expect(db.commit([{ op: "put", table: "nope" as never, key: "k", value: "{}" }])).rejects.toThrow("unknown_table");
  });
});
