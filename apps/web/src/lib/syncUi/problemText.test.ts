import { problem } from "../../test/syncUi";
import { describeProblem } from "./problemText";

describe("describeProblem", () => {
  it("a text conflict lists each text field with both versions", () => {
    const t = describeProblem(problem());
    expect(t.title).toMatch(/changed on two devices/);
    expect(t.textConflicts).toEqual([{ field: "title", mine: "My title", theirs: "Their title" }]);
    expect(t.to).toBe("/tasks?task=t1");
  });

  it("a conflict of simple fields only says nothing was overwritten", () => {
    const t = describeProblem(problem({ conflicts: [{ field: "priority", reason: "later_wins", serverRevision: 2, theirs: "high", mine: "low" }] }));
    expect(t.textConflicts).toEqual([]);
    expect(t.detail).toMatch(/Nothing was overwritten/);
  });

  it("a note conflict points at its copy", () => {
    const t = describeProblem(problem({ entityType: "note", entityId: "n1", conflicts: [], copy: { id: "c", path: "A (conflict 2026-11-10 090000).md" } }));
    expect(t.detail).toContain("A (conflict 2026-11-10 090000).md");
    expect(t.to).toBe("/notes");
  });

  it("refusals have words per reason and a safe fallback; an undo problem is explained", () => {
    expect(describeProblem(problem({ kind: "failed", reason: "lost_on_restore", conflicts: [] })).detail).toMatch(/backup/);
    expect(describeProblem(problem({ kind: "failed", reason: "weird", code: "weird", conflicts: [] })).detail).toMatch(/refused it \(weird\)/);
    expect(describeProblem(problem({ entityType: "resolution", conflicts: [] })).title).toBe("An undo was not applied");
  });
});
