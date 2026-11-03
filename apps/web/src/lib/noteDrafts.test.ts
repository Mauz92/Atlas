import { DRAFT_PREFIX, localStorageDraftStore } from "./noteDrafts";

describe("localStorageDraftStore", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips a draft under one key per note and clears it", () => {
    const store = localStorageDraftStore();
    store.write("n1", { content: "ünï ✓", baseRevision: 3, savedAt: 5, attempted: "x" });
    expect(localStorage.getItem(`${DRAFT_PREFIX}n1`)).toContain("ünï");
    expect(store.read("n1")).toEqual({ content: "ünï ✓", baseRevision: 3, savedAt: 5, attempted: "x" });
    store.clear("n1");
    expect(store.read("n1")).toBeNull();
  });

  it("ignores corrupt entries and survives a failing storage", () => {
    localStorage.setItem(`${DRAFT_PREFIX}bad`, "{not json");
    localStorage.setItem(`${DRAFT_PREFIX}wrong`, JSON.stringify({ content: 1 }));
    const store = localStorageDraftStore();
    expect(store.read("bad")).toBeNull();
    expect(store.read("wrong")).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    const failing = localStorageDraftStore(broken);
    expect(() => failing.write("n1", { content: "a", baseRevision: 1, savedAt: 1 })).not.toThrow();
    expect(failing.read("n1")).toBeNull();
    expect(() => failing.clear("n1")).not.toThrow();
  });
});
