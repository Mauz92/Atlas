import { makeTask } from "../test/tasks";
import {
  STATUS_ORDER,
  allowedTargets,
  boardColumns,
  canMove,
  groupByStatus,
  isStatus,
} from "./taskStatus";

describe("task status board model", () => {
  it("has exactly the server's five statuses, in column order", () => {
    expect(STATUS_ORDER).toEqual(["inbox", "next", "in_progress", "completed", "archived"]);
  });

  it("mirrors the canonical server transition table (atlas/tasks/state.py)", () => {
    expect([...allowedTargets("inbox")].sort()).toEqual([
      "archived",
      "completed",
      "in_progress",
      "next",
    ]);
    expect([...allowedTargets("next")].sort()).toEqual([
      "archived",
      "completed",
      "in_progress",
      "inbox",
    ]);
    expect([...allowedTargets("in_progress")].sort()).toEqual([
      "archived",
      "completed",
      "inbox",
      "next",
    ]);
    expect([...allowedTargets("completed")].sort()).toEqual(["archived", "in_progress"]);
    expect([...allowedTargets("archived")].sort()).toEqual(["inbox", "next"]);
  });

  it("never allows a move to the same status or from an unknown status", () => {
    for (const status of STATUS_ORDER) {
      expect(allowedTargets(status)).not.toContain(status);
      expect(canMove(status, status)).toBe(false);
    }
    expect(allowedTargets("bogus")).toEqual([]);
    expect(canMove("bogus", "inbox")).toBe(false);
    expect(canMove("inbox", "bogus")).toBe(false);
  });

  it("recognises only the canonical statuses", () => {
    for (const status of STATUS_ORDER) {
      expect(isStatus(status)).toBe(true);
    }
    expect(isStatus("bogus")).toBe(false);
    expect(isStatus("")).toBe(false);
  });

  it("groups tasks by status and ignores an unknown status", () => {
    const grouped = groupByStatus([
      makeTask({ id: "a", status: "inbox" }),
      makeTask({ id: "b", status: "in_progress" }),
      makeTask({ id: "c", status: "inbox" }),
      makeTask({ id: "d", status: "bogus" }),
    ]);

    expect(grouped.inbox.map((task) => task.id)).toEqual(["a", "c"]);
    expect(grouped.in_progress.map((task) => task.id)).toEqual(["b"]);
    expect(grouped.completed).toEqual([]);
    expect(grouped.archived).toEqual([]);
  });

  it("builds one column per status with a label and its targets", () => {
    const columns = boardColumns();
    expect(columns.map((column) => column.status)).toEqual(STATUS_ORDER);
    expect(columns.every((column) => column.label.length > 0)).toBe(true);
    expect(columns.find((column) => column.status === "completed")?.targets).toEqual([
      "in_progress",
      "archived",
    ]);
  });
});
