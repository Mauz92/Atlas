/**
 * Durable storage backing tests (M7-03).
 *
 * `fake-indexeddb` installs an in-memory IndexedDB so the *real* IndexedDB wrapper path (the
 * production backing) is exercised, not just the `localStorage` fallback. `jsdom` has no IndexedDB,
 * so without the shim only the fallback could be tested.
 */
import "fake-indexeddb/auto";

import {
  IndexedDbStore,
  LocalStorageStore,
  MemoryStore,
  createKeyValueStore,
} from "./queueStorage";

describe("IndexedDbStore", () => {
  it("round-trips a value and returns null for a missing key", async () => {
    const store = new IndexedDbStore("atlas-test-roundtrip");

    expect(await store.read("missing")).toBeNull();
    await store.write("queue", "hello");
    expect(await store.read("queue")).toBe("hello");
    await store.remove("queue");
    expect(await store.read("queue")).toBeNull();
  });

  it("persists across re-instantiation over the same database (a reload)", async () => {
    const first = new IndexedDbStore("atlas-test-persist");
    await first.write("queue", JSON.stringify({ pending: 2 }));

    // A fresh instance over the same database — the model of a page reload.
    const second = new IndexedDbStore("atlas-test-persist");
    expect(await second.read("queue")).toBe(JSON.stringify({ pending: 2 }));
  });
});

describe("LocalStorageStore", () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it("round-trips a value and persists across re-instantiation", async () => {
    const first = new LocalStorageStore("atlas.test.");
    await first.write("cursor", "42");

    const second = new LocalStorageStore("atlas.test.");
    expect(await second.read("cursor")).toBe("42");

    await second.remove("cursor");
    expect(await first.read("cursor")).toBeNull();
  });
});

describe("MemoryStore", () => {
  it("round-trips values without any browser storage", async () => {
    const store = new MemoryStore();
    await store.write("k", "v");
    expect(await store.read("k")).toBe("v");
    await store.remove("k");
    expect(await store.read("k")).toBeNull();
  });
});

describe("createKeyValueStore", () => {
  it("prefers IndexedDB when it is available", () => {
    expect(createKeyValueStore().kind).toBe("indexeddb");
  });
});
