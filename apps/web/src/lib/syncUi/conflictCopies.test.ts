import { findConflictPairs, parseConflictCopyPath } from "./conflictCopies";

describe("conflict copies", () => {
  it("parses the server's naming, with a folder and a second copy in the same second", () => {
    expect(parseConflictCopyPath("Plan (conflict 2026-11-10 093015).md")).toEqual({ originalPath: "Plan.md", stamp: "2026-11-10 093015" });
    expect(parseConflictCopyPath("work/Plan (conflict 2026-11-10 093015 2).md")?.originalPath).toBe("work/Plan.md");
    expect(parseConflictCopyPath("Plan.md")).toBeNull();
    expect(parseConflictCopyPath("Plan (conflict).md")).toBeNull();
  });

  it("pairs a copy with its original, newest first, and tolerates a missing original", () => {
    const notes = [
      { id: "1", path: "Plan.md" },
      { id: "2", path: "Plan (conflict 2026-11-10 093015).md" },
      { id: "3", path: "Gone (conflict 2026-11-11 080000).md" },
    ];
    const pairs = findConflictPairs(notes);
    expect(pairs.map((p) => [p.copy.id, p.original?.id ?? null])).toEqual([["3", null], ["2", "1"]]);
  });
});
