import { act, renderHook, waitFor } from "@testing-library/react";

import { fakeSource, resolution } from "../test/syncUi";
import { mergePages, useResolutions } from "./useResolutions";

describe("mergePages", () => {
  it("replaces by id, keeps older pages and sorts newest first", () => {
    const old = resolution({ id: "a", created_at: "2026-10-01T00:00:00Z" });
    const mid = resolution({ id: "b", created_at: "2026-10-02T00:00:00Z", undone_at: null });
    const midUndone = { ...mid, undone_at: "2026-10-03T00:00:00Z" };
    const fresh = resolution({ id: "c", created_at: "2026-10-04T00:00:00Z" });
    expect(mergePages([mid, old], [fresh, midUndone]).map((r) => [r.id, !!r.undone_at])).toEqual([["c", false], ["b", true], ["a", false]]);
  });
});

describe("useResolutions", () => {
  it("reloads after an undo that changed the entry and shows the new state", async () => {
    let undone = false;
    const source = fakeSource([[]], {
      page: async () => ({ items: [resolution({ id: "r1", undone_at: undone ? "2026-11-10T12:00:00Z" : null })], next: null }),
      undo: async () => {
        undone = true;
        return { kind: "undone", message: "ok", safe: true, refresh: true, followUp: null };
      },
    });
    const { result } = renderHook(() => useResolutions(source));
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.undo(result.current.items[0]!);
    });
    expect(result.current.items[0]!.undone_at).toBeTruthy();
    expect(result.current.outcomes.get("r1")?.kind).toBe("undone");
    expect(result.current.undoing).toBeNull();
  });
});
