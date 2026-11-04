import { InjectedCrash, MemoryStore } from "./testing/memoryStore.ts";
import { newEntity } from "./entities.ts";

describe("MemoryStore", () => {
  it("commits a transaction atomically and loses a failed one", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => {
      await tx.putEntity(newEntity("a", "task"));
      await tx.setMeta("cursor", 3);
    });
    await expect(
      store.transaction(async (tx) => {
        await tx.putEntity(newEntity("b", "task"));
        await tx.setMeta("cursor", 9);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const seen = await store.transaction(async (tx) => ({ ids: (await tx.listEntities()).map((e) => e.id), c: await tx.getMeta("cursor") }));
    expect(seen).toEqual({ ids: ["a"], c: 3 });
  });
  it("loses the writes of an injected crash but not a read", async () => {
    const store = new MemoryStore();
    store.crashBeforeCommit = () => true;
    await expect(store.transaction(async (tx) => tx.setMeta("x", 1))).rejects.toBeInstanceOf(InjectedCrash);
    expect(await store.transaction(async (tx) => tx.getMeta("x"))).toBeUndefined();
  });
  it("copies on read, so forgetting to put is visible", async () => {
    const store = new MemoryStore();
    await store.transaction(async (tx) => tx.putEntity(newEntity("a", "task")));
    await store.transaction(async (tx) => {
      const e = (await tx.getEntity("a"))!;
      e.deleted = true; // not put
    });
    expect((await store.transaction(async (tx) => tx.getEntity("a")))!.deleted).toBe(false);
  });
});
