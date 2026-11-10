import type { ResolutionLike } from "./resolutionText";
import { undoRefused, undoSucceeded } from "./undoOutcome";

const R: ResolutionLike = {
  id: "r1", entity_type: "task", entity_id: "t1", rule: "simple_later_wins", field: "priority", kept_revision: 3, has_loser: true,
  loser: "low", created_at: "2026-11-10T11:55:00Z", undoable: true,
};

describe("undo outcomes (R-48: refusals are normal)", () => {
  it("success says the earlier value is back; applied=false says nothing changed", () => {
    expect(undoSucceeded(R, true)).toMatchObject({ kind: "undone", safe: true, refresh: true });
    expect(undoSucceeded(R, false)).toMatchObject({ kind: "already_had_value", safe: true });
    expect(undoSucceeded({ ...R, rule: "path_later_wins", field: "path" }, true).message).toMatch(/back where it was/);
  });

  it("'changed again since' is a safe, plain outcome that keeps the entry", () => {
    const out = undoRefused(R, 409, { error: "conflict", conflicts: [{ field: "priority", reason: "changed_since" }], resolution_id: "r1" });
    expect(out).toMatchObject({ kind: "changed_since", safe: true, refresh: false });
    expect(out.message).toMatch(/changed again since/);
    expect(out.message).toMatch(/never overwrites/);
  });

  it.each([
    [{ error: "entity_deleted" }, "entity_deleted", /never brings a deleted item back/],
    [{ error: "path_exists" }, "path_exists", /another note already uses/],
    [{ error: "already_undone" }, "already_undone", /already undone/],
    [{ error: "conflict", detail: "bad step", conflicts: [{ reason: "invalid_transition" }] }, "invalid_value", /not allowed any more \(bad step\)/],
  ])("maps %j", (body, kind, message) => {
    const out = undoRefused(R, 409, body);
    expect(out.kind).toBe(kind);
    expect(out.message).toMatch(message);
    expect(out.safe).toBe(true);
  });

  it("not_undoable carries the follow-up link from the answer", () => {
    const out = undoRefused({ ...R, rule: "note_merged", entity_type: "note", entity_id: "n9" }, 409, {
      error: "not_undoable", reason: "rule_not_undoable", follow_up: { kind: "note_history", href: "/api/notes/n9/history/2" },
    });
    expect(out.kind).toBe("not_undoable");
    expect(out.followUp).toEqual({ label: "Open the note and compare it with the other version", to: "/notes?open=n9" });
  });

  it("404, a lost connection and an unknown failure are told apart; only the last is unsafe", () => {
    expect(undoRefused(R, 404, null)).toMatchObject({ kind: "gone", refresh: true });
    expect(undoRefused(R, 0, null)).toMatchObject({ kind: "unreachable", safe: true });
    expect(undoRefused(R, 429, null).message).toMatch(/slow down/);
    expect(undoRefused(R, 500, { error: "boom" })).toMatchObject({ kind: "failed", safe: false });
  });
});
