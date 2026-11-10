import { describeResolution, deviceLabel, formatFieldValue, isFromOtherDevice, unseenNotices, type Names, type ResolutionLike } from "./resolutionText";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const NAMES: Names = { devices: new Map([["d-laptop", "Kim's laptop"]]), ownDeviceId: "d-me" };

function entry(over: Partial<ResolutionLike> = {}): ResolutionLike {
  return {
    id: "r1",
    entity_type: "task",
    entity_id: "t1",
    rule: "simple_later_wins",
    field: "status",
    kept_revision: 4,
    has_loser: true,
    loser: "in_progress",
    detail: null,
    device_id: "d-laptop",
    undoes_id: null,
    undone_at: null,
    created_at: "2026-11-10T11:55:00Z",
    undoable: true,
    undo_blocked: null,
    follow_up: null,
    ...over,
  };
}

describe("describeResolution", () => {
  it("names the device, the field, the replaced value and when, and offers Undo", () => {
    const text = describeResolution(entry(), NAMES, NOW);
    expect(text.headline).toContain("Kim's laptop");
    expect(text.headline).toContain("status");
    expect(text.values).toEqual([{ label: "Replaced status", value: "In progress" }]);
    expect(text.when).toMatch(/5 minutes ago/);
    expect(text.undo).toEqual({ kind: "available" });
    expect(text.entityTo).toBe("/tasks?task=t1");
  });

  it("falls back to generic wording when the device is unknown, and says 'the web app' for a browser session", () => {
    expect(describeResolution(entry({ device_id: "d-other" }), NAMES, NOW).headline).toContain("another device");
    expect(describeResolution(entry({ device_id: null }), NAMES, NOW).headline).toContain("the web app");
    expect(deviceLabel(entry({ device_id: "d-me" }), NAMES)).toBe("this device");
  });

  it("shows no values when the earlier value was not stored", () => {
    const text = describeResolution(entry({ has_loser: false, loser: null, undoable: false, undo_blocked: "value_not_stored" }), NAMES, NOW);
    expect(text.values).toEqual([]);
    expect(text.undo.kind).toBe("blocked");
    expect(text.undo.kind === "blocked" && text.undo.reason).toMatch(/too large/);
  });

  it("explains each kind that cannot be undone and points at what to do instead", () => {
    const del = describeResolution(
      entry({ rule: "edit_wins_over_delete", field: null, has_loser: false, undoable: false, undo_blocked: "rule_not_undoable", follow_up: { kind: "delete_again", href: null } }),
      NAMES,
      NOW,
    );
    expect(del.undo.kind === "blocked" && del.undo.followUp?.label).toBe("Delete the task again");
    expect(del.undo.kind === "blocked" && del.undo.followUp?.to).toBe("/tasks?task=t1");

    const merged = describeResolution(
      entry({ rule: "note_merged", entity_type: "note", entity_id: "n1", field: null, has_loser: false, undoable: false, undo_blocked: "rule_not_undoable", follow_up: { kind: "note_history", href: "/api/notes/n1/history/3" } }),
      NAMES,
      NOW,
    );
    expect(merged.undo.kind === "blocked" && merged.undo.followUp?.to).toBe("/notes?open=n1");
    expect(merged.undo.kind === "blocked" && merged.undo.reason).toMatch(/merged/);

    const clash = describeResolution(
      entry({ rule: "path_collision", entity_type: "note", entity_id: "n1", field: null, detail: "a.md -> a 2.md", has_loser: false, undoable: false, undo_blocked: "rule_not_undoable", follow_up: { kind: "rename", href: null } }),
      NAMES,
      NOW,
    );
    expect(clash.values).toEqual([{ label: "Names", value: "a.md -> a 2.md" }]);
    expect(clash.undo.kind === "blocked" && clash.undo.followUp?.label).toBe("Rename the note");
  });

  it("marks an undone entry and an undo record", () => {
    expect(describeResolution(entry({ undone_at: "2026-11-10T11:58:00Z", undoable: false, undo_blocked: "already_undone" }), NAMES, NOW).undo.kind).toBe("undone");
    const record = describeResolution(entry({ rule: "undo", undoable: false, undo_blocked: "is_undo" }), NAMES, NOW);
    expect(record.isUndoEntry).toBe(true);
  });

  it("never puts text fields in the wording: only simple fields have values", () => {
    const text = describeResolution(entry({ field: "priority", loser: "high" }), NAMES, NOW);
    expect(JSON.stringify(text)).not.toMatch(/title|description/i);
    expect(text.values[0]!.value).toBe("High");
  });
});

describe("formatFieldValue", () => {
  it("formats per field", () => {
    expect(formatFieldValue("status", "todo")).toBe("To do");
    expect(formatFieldValue("due_at", null)).toBe("empty");
    expect(formatFieldValue("project_id", "p1", { projects: new Map([["p1", "Home"]]) })).toBe("Home");
    expect(formatFieldValue("project_id", "p2")).toBe("another project");
    expect(formatFieldValue("duration_minutes", 30)).toBe("30 min");
    expect(formatFieldValue("path", "notes/a.md")).toBe("notes/a.md");
    expect(formatFieldValue("due_at", "2026-11-12T09:00:00Z")).not.toBe("2026-11-12T09:00:00Z");
  });
});

describe("notices", () => {
  const items = [
    entry({ id: "a" }),
    entry({ id: "b", device_id: "d-me" }),
    entry({ id: "c", rule: "undo" }),
    entry({ id: "d", undone_at: "2026-11-10T11:59:00Z" }),
    entry({ id: "e", created_at: "2026-11-01T00:00:00Z" }),
    entry({ id: "f", device_id: null }),
  ];

  it("keeps other devices' unseen, not-undone entries", () => {
    const since = Date.parse("2026-11-09T00:00:00Z");
    expect(unseenNotices(items, "d-me", since).map((r) => r.id)).toEqual(["a", "f"]);
  });

  it("in a browser (no device id) only entries written by a device count", () => {
    const since = Date.parse("2026-11-09T00:00:00Z");
    expect(unseenNotices(items, null, since).map((r) => r.id)).toEqual(["a", "b"]);
    expect(isFromOtherDevice({ device_id: null }, null)).toBe(false);
  });
});
