import { makeQueuedOperation } from "../test/offline";
import {
  formatQueuedAt,
  operationLabel,
  operationStatusLabel,
  overallSyncDescription,
  overallSyncLabel,
  overallSyncState,
  queueStatusKind,
  queueStatusLabel,
  queueSummaryText,
  type OverallSyncInput,
  type QueueCounts,
} from "./queueStatus";

const counts = (overrides: Partial<QueueCounts> = {}): QueueCounts => ({
  total: 0,
  pending: 0,
  conflicts: 0,
  failed: 0,
  ...overrides,
});

describe("queueStatusLabel", () => {
  it("reports the most severe state first", () => {
    expect(queueStatusLabel(counts())).toBe("All synced");
    expect(queueStatusLabel(counts({ total: 2, pending: 2 }))).toBe("Pending sync");
    expect(queueStatusLabel(counts({ total: 2, pending: 1, failed: 1 }))).toBe("Sync failed");
    expect(queueStatusLabel(counts({ total: 1, conflicts: 1 }))).toBe("Sync conflict");
  });
});

describe("queueStatusKind", () => {
  it("maps counts to a badge class, most severe first", () => {
    expect(queueStatusKind(counts())).toBe("all");
    expect(queueStatusKind(counts({ total: 1, pending: 1 }))).toBe("pending");
    expect(queueStatusKind(counts({ total: 1, failed: 1 }))).toBe("failed");
    expect(queueStatusKind(counts({ total: 1, conflicts: 1 }))).toBe("conflict");
  });
});

describe("queueSummaryText", () => {
  it("says nothing is waiting when the queue is empty", () => {
    expect(queueSummaryText(counts())).toBe("Nothing waiting to sync.");
  });

  it("pluralises the count", () => {
    expect(queueSummaryText(counts({ total: 1, pending: 1 }))).toBe("1 change waiting to sync.");
    expect(queueSummaryText(counts({ total: 3, pending: 3 }))).toBe("3 changes waiting to sync.");
  });
});

describe("operationLabel", () => {
  it("describes the mutation and the entity type", () => {
    expect(operationLabel(makeQueuedOperation({ mutation: "update", entityType: "task" }))).toBe(
      "Update task",
    );
    expect(operationLabel(makeQueuedOperation({ mutation: "create", entityType: "project" }))).toBe(
      "Create project",
    );
    expect(operationLabel(makeQueuedOperation({ mutation: "delete", entityType: "task" }))).toBe(
      "Delete task",
    );
  });
});

describe("operationStatusLabel", () => {
  it("labels each disposition", () => {
    expect(operationStatusLabel("pending")).toBe("Waiting");
    expect(operationStatusLabel("conflict")).toBe("Conflict");
    expect(operationStatusLabel("failed")).toBe("Failed");
  });
});

describe("formatQueuedAt", () => {
  it("returns null for an unparseable instant", () => {
    expect(formatQueuedAt("not-a-date")).toBeNull();
  });

  it("formats a valid instant", () => {
    expect(formatQueuedAt("2026-10-27T09:00:00.000Z")).toContain("2026");
  });
});

describe("overallSyncState", () => {
  const input = (overrides: Partial<OverallSyncInput> = {}): OverallSyncInput => ({
    counts: counts(),
    online: true,
    busy: false,
    loadFailed: false,
    ...overrides,
  });

  it("is up-to-date when nothing is outstanding", () => {
    expect(overallSyncState(input())).toBe("up-to-date");
  });

  it("is syncing while a pass is in flight or work is pending", () => {
    expect(overallSyncState(input({ busy: true }))).toBe("syncing");
    expect(overallSyncState(input({ counts: counts({ total: 1, pending: 1 }) }))).toBe("syncing");
  });

  it("is offline ahead of pending work", () => {
    expect(overallSyncState(input({ online: false }))).toBe("offline");
    expect(overallSyncState(input({ online: false, counts: counts({ total: 1, pending: 1 }) }))).toBe(
      "offline",
    );
  });

  it("is error when the queue cannot be read or an operation permanently failed", () => {
    expect(overallSyncState(input({ loadFailed: true }))).toBe("error");
    expect(overallSyncState(input({ counts: counts({ total: 1, failed: 1 }) }))).toBe("error");
  });

  it("surfaces conflicts ahead of being offline or failed", () => {
    expect(
      overallSyncState(input({ counts: counts({ total: 1, conflicts: 1, failed: 1 }), online: false })),
    ).toBe("conflicts");
  });

  it("labels and describes every state", () => {
    const states = ["up-to-date", "syncing", "offline", "error", "conflicts"] as const;
    for (const state of states) {
      expect(overallSyncLabel(state)).toBeTruthy();
      expect(overallSyncDescription(state)).toBeTruthy();
    }
    expect(overallSyncLabel("up-to-date")).toBe("Up to date");
    expect(overallSyncLabel("conflicts")).toBe("Conflicts");
  });
});
