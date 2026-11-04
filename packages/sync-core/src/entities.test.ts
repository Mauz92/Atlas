import { applyAck, applyDeleteAck, applyLive, applyTombstone, newEntity } from "./entities.ts";
import { MemoryStore } from "./testing/memoryStore.ts";

const task = (revision: number, title: string) => ({
  id: "t1", revision, title, deleted_at: null, field_revisions: { title: revision },
});
const opts = {};

async function run<T>(store: MemoryStore, fn: Parameters<MemoryStore["transaction"]>[0]) {
  return store.transaction(fn) as Promise<T>;
}

describe("apply rules", () => {
  it("applies by revision: an older state is a no-op", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await applyLive(tx, "task", "t1", task(3, "new"), opts);
      expect(await applyLive(tx, "task", "t1", task(2, "old"), opts)).toBe(false);
      expect((await tx.getEntity("t1"))!.server!.fields["title"]).toBe("new");
    });
  });
  it("an acknowledgement fills a gap but never overwrites newer state", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await applyAck(tx, "task", "t1", task(1, "first"), opts);
      expect((await tx.getEntity("t1"))!.refetch).toBe(true);
      await applyLive(tx, "task", "t1", task(5, "later"), opts);
      await applyAck(tx, "task", "t1", task(2, "historical replay"), opts);
      expect((await tx.getEntity("t1"))!.server!.fields["title"]).toBe("later");
    });
  });
  it("an acknowledgement never resurrects a tombstone (seed 681)", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await tx.putEntity(newEntity("t1", "task"));
      await applyTombstone(tx, "task", "t1", 2, opts);
      await applyAck(tx, "task", "t1", task(1, "replayed create"), opts);
      const e = (await tx.getEntity("t1"))!;
      expect(e.deleted).toBe(true);
      expect(e.server).toBeNull();
      expect(e.refetch).toBe(true);
    });
  });
  it("a tombstone is remembered for an id never held", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      expect(await applyTombstone(tx, "task", "ghost", 4, opts)).toBe(true);
      expect((await tx.getEntity("ghost"))!.deleted).toBe(true);
    });
  });
  it("a newer live state revives a tombstone; an older one does not (edit wins)", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await applyLive(tx, "task", "t1", task(1, "a"), opts);
      await applyTombstone(tx, "task", "t1", 2, opts);
      expect(await applyLive(tx, "task", "t1", task(2, "stale"), opts)).toBe(false);
      expect(await applyLive(tx, "task", "t1", task(3, "edited elsewhere"), opts)).toBe(true);
      expect((await tx.getEntity("t1"))!.deleted).toBe(false);
    });
  });
  it("a delete acknowledgement tombstones and asks for a re-read", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await applyLive(tx, "task", "t1", task(1, "a"), opts);
      await applyDeleteAck(tx, "task", "t1", opts);
      const e = (await tx.getEntity("t1"))!;
      expect([e.deleted, e.refetch]).toEqual([true, true]);
    });
  });
  it("keeps a note's text when only the metadata changed and the hash is equal", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await applyLive(tx, "note", "n1", { revision: 1, path: "a.md", content: "x", content_hash: "h" }, opts);
      await applyLive(tx, "note", "n1", { revision: 2, path: "b.md", content_hash: "h", deleted_at: null }, opts);
      expect((await tx.getEntity("n1"))!.server!.content).toBe("x");
      await applyLive(tx, "note", "n1", { revision: 3, path: "b.md", content_hash: "other" }, opts);
      expect((await tx.getEntity("n1"))!.server!.content).toBeNull();
    });
  });
  it("refuses a note body that does not match its hash", async () => {
    const store = new MemoryStore();
    await expect(
      run(store, (tx) => applyLive(tx, "note", "n1", { revision: 1, content: "x", content_hash: "bad" }, { sha256: () => "good" })),
    ).rejects.toThrow(/disagree/);
  });
});
