import { fireEvent, render, screen } from "@testing-library/react";

import { makeQueuedOperation } from "../test/offline";
import type { QueueCounts } from "../lib/queueStatus";
import { OfflineQueueStatus } from "./OfflineQueueStatus";

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
  onRefresh: vi.fn(),
};

describe("OfflineQueueStatus", () => {
  it("renders a loading state", () => {
    render(<OfflineQueueStatus {...baseProps} state="loading" />);
    expect(screen.getByText(/Loading offline queue/i)).toBeInTheDocument();
  });

  it("renders the load error with a retry affordance", () => {
    const onRefresh = vi.fn();
    render(
      <OfflineQueueStatus
        {...baseProps}
        state="error"
        error="Storage unavailable"
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Storage unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("reports that everything is synced when the queue is empty", () => {
    render(<OfflineQueueStatus {...baseProps} />);
    expect(screen.getByRole("status")).toHaveTextContent("All synced");
    expect(screen.getByText("Nothing waiting to sync.")).toBeInTheDocument();
    expect(screen.getByText(/up to date/i)).toBeInTheDocument();
  });

  it("shows the pending count and lists the queued operations", () => {
    render(
      <OfflineQueueStatus
        {...baseProps}
        counts={counts({ total: 2, pending: 2 })}
        operations={[
          makeQueuedOperation({ id: "op-1", entityType: "task", mutation: "update" }),
          makeQueuedOperation({ id: "op-2", entityType: "project", mutation: "create" }),
        ]}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Pending sync");
    expect(screen.getByText("2 changes waiting to sync.")).toBeInTheDocument();
    expect(screen.getByText("Update task")).toBeInTheDocument();
    expect(screen.getByText("Create project")).toBeInTheDocument();
    expect(screen.getAllByText("Waiting")).toHaveLength(2);
  });

  it("surfaces a conflict without hiding the operation", () => {
    render(
      <OfflineQueueStatus
        {...baseProps}
        counts={counts({ total: 1, conflicts: 1 })}
        operations={[makeQueuedOperation({ id: "op-1", status: "conflict" })]}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Sync conflict");
    expect(screen.getByText("1 change waiting to sync.")).toBeInTheDocument();
    expect(screen.getByText("Conflict")).toBeInTheDocument();
  });

  it("surfaces a failed operation", () => {
    render(
      <OfflineQueueStatus
        {...baseProps}
        counts={counts({ total: 1, failed: 1 })}
        operations={[makeQueuedOperation({ id: "op-1", status: "failed" })]}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Sync failed");
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });

  it("offers a keyboard-focusable Sync now that disables while in flight", () => {
    const onSyncNow = vi.fn();
    const { rerender } = render(
      <OfflineQueueStatus
        {...baseProps}
        counts={counts({ total: 1, pending: 1 })}
        operations={[makeQueuedOperation()]}
        onSyncNow={onSyncNow}
      />,
    );

    const button = screen.getByRole("button", { name: "Sync now" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onSyncNow).toHaveBeenCalledTimes(1);

    rerender(
      <OfflineQueueStatus
        {...baseProps}
        counts={counts({ total: 1, pending: 1 })}
        operations={[makeQueuedOperation()]}
        onSyncNow={onSyncNow}
        busy
      />,
    );
    expect(screen.getByRole("button", { name: "Syncing…" })).toBeDisabled();
  });

  it("does not offer Sync now when nothing is pending", () => {
    render(
      <OfflineQueueStatus {...baseProps} counts={counts({ total: 1, failed: 1 })} onSyncNow={vi.fn()} />,
    );
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
  });

  it("surfaces a failed replay as an alert without hiding the counts", () => {
    render(
      <OfflineQueueStatus
        {...baseProps}
        counts={counts({ total: 1, pending: 1 })}
        actionError="Could not sync queued changes"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Could not sync queued changes");
    expect(screen.getByRole("status")).toHaveTextContent("Pending sync");
  });
});
