import { fireEvent, render, screen } from "@testing-library/react";

import type { QueueCounts } from "../lib/queueStatus";
import { makeCacheEntry, makeQueuedOperation } from "../test/offline";
import { SyncStatusPanel } from "./SyncStatusPanel";

const counts = (overrides: Partial<QueueCounts> = {}): QueueCounts => ({
  total: 0,
  pending: 0,
  conflicts: 0,
  failed: 0,
  ...overrides,
});

const baseProps = {
  counts: counts(),
  operations: [],
  state: "ready" as const,
  error: null,
  conflicts: [],
  online: true,
  onRefresh: vi.fn(),
};

describe("SyncStatusPanel", () => {
  it("renders the up-to-date state when nothing is outstanding", () => {
    render(<SyncStatusPanel {...baseProps} />);

    expect(screen.getByText("Up to date", { selector: ".sync-panel-badge" })).toBeInTheDocument();
    expect(screen.getByText(/saved on the server/i)).toBeInTheDocument();
    // The composed queue surface keeps its own status role.
    expect(screen.getByRole("status")).toHaveTextContent("All synced");
  });

  it("renders the syncing state with the pending count", () => {
    render(
      <SyncStatusPanel
        {...baseProps}
        counts={counts({ total: 2, pending: 2 })}
        operations={[makeQueuedOperation({ id: "op-1" }), makeQueuedOperation({ id: "op-2", seq: 2 })]}
      />,
    );

    expect(screen.getByText("Syncing", { selector: ".sync-panel-badge" })).toBeInTheDocument();
    const pendingCount = screen.getByText("Pending", { selector: "dt" }).closest(".sync-panel-count");
    expect(pendingCount).toHaveTextContent("2");
  });

  it("renders the error state when an operation has permanently failed", () => {
    render(
      <SyncStatusPanel
        {...baseProps}
        counts={counts({ total: 1, failed: 1 })}
        operations={[makeQueuedOperation({ status: "failed" })]}
      />,
    );

    expect(screen.getByText("Sync error", { selector: ".sync-panel-badge" })).toBeInTheDocument();
    const failedCount = screen.getByText("Failed", { selector: "dt" }).closest(".sync-panel-count");
    expect(failedCount).toHaveTextContent("1");
  });

  it("renders the conflicts state with a resolution action per entity", () => {
    const onResolve = vi.fn();
    render(
      <SyncStatusPanel
        {...baseProps}
        counts={counts({ total: 1, conflicts: 1 })}
        conflicts={[
          makeCacheEntry({ entityType: "task", entityId: "task-1", serverRevision: 9 }),
        ]}
        onResolve={onResolve}
      />,
    );

    expect(screen.getByText("Conflicts", { selector: ".sync-panel-badge" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Sync conflicts" })).toBeInTheDocument();
    expect(screen.getByText("task task-1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "task-1" }),
      "keep-mine",
    );
    fireEvent.click(screen.getByRole("button", { name: "Take server" }));
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: "task-1" }),
      "take-server",
    );
  });

  it("reports being offline ahead of outstanding work", () => {
    render(<SyncStatusPanel {...baseProps} online={false} counts={counts({ total: 1, pending: 1 })} />);

    expect(screen.getByText("Offline", { selector: ".sync-panel-badge" })).toBeInTheDocument();
    expect(screen.getByText(/sent when you reconnect/i)).toBeInTheDocument();
  });

  it("surfaces a queue read failure and hides the counts", () => {
    render(<SyncStatusPanel {...baseProps} state="error" error="Storage unavailable" />);

    expect(screen.getByText("Sync error", { selector: ".sync-panel-badge" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Storage unavailable");
    expect(screen.queryByText("Pending", { selector: "dt" })).not.toBeInTheDocument();
  });

  it("surfaces a resolution failure through the conflict surface", () => {
    render(
      <SyncStatusPanel
        {...baseProps}
        counts={counts({ total: 1, conflicts: 1 })}
        conflicts={[makeCacheEntry()]}
        resolveError="Could not resolve the conflict"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not resolve the conflict");
  });

  it("disables the resolution actions while a sync is in flight", () => {
    render(
      <SyncStatusPanel
        {...baseProps}
        busy
        counts={counts({ total: 1, conflicts: 1 })}
        conflicts={[makeCacheEntry()]}
        onResolve={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Keep mine" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Take server" })).toBeDisabled();
  });
});
