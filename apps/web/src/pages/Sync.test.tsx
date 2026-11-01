import { fireEvent, render, screen } from "@testing-library/react";

import { useConflictResolution } from "../hooks/useConflictResolution";
import { useOfflineQueue } from "../hooks/useOfflineQueue";
import { useReconciliation } from "../hooks/useReconciliation";
import { makeCacheEntry } from "../test/offline";
import { SyncPage } from "./Sync";

vi.mock("../hooks/useOfflineQueue", () => ({ useOfflineQueue: vi.fn() }));
vi.mock("../hooks/useReconciliation", () => ({ useReconciliation: vi.fn() }));
vi.mock("../hooks/useConflictResolution", () => ({ useConflictResolution: vi.fn() }));

const queueMock = vi.mocked(useOfflineQueue);
const reconcileMock = vi.mocked(useReconciliation);
const resolveMock = vi.mocked(useConflictResolution);

beforeEach(() => {
  vi.resetAllMocks();
  reconcileMock.mockReturnValue({
    conflicts: [],
    busy: false,
    error: null,
    online: true,
    reconcile: vi.fn(),
  });
  resolveMock.mockReturnValue({ resolvingKey: null, error: null, resolve: vi.fn() });
});

describe("SyncPage", () => {
  it("renders the offline queue status from the hook", () => {
    queueMock.mockReturnValue({
      counts: { total: 2, pending: 2, conflicts: 0, failed: 0 },
      operations: [],
      state: "ready",
      error: null,
      actionError: null,
      busy: false,
      refresh: vi.fn(),
      flush: vi.fn(),
    });

    render(<SyncPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Sync" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Pending sync");
    expect(screen.getByText("2 changes waiting to sync.")).toBeInTheDocument();
  });

  it("shows the all-synced state when nothing is queued", () => {
    queueMock.mockReturnValue({
      counts: { total: 0, pending: 0, conflicts: 0, failed: 0 },
      operations: [],
      state: "ready",
      error: null,
      actionError: null,
      busy: false,
      refresh: vi.fn(),
      flush: vi.fn(),
    });

    render(<SyncPage />);

    expect(screen.getByRole("status")).toHaveTextContent("All synced");
  });

  it("surfaces a reconciliation conflict", () => {
    queueMock.mockReturnValue({
      counts: { total: 1, pending: 0, conflicts: 1, failed: 0 },
      operations: [],
      state: "ready",
      error: null,
      actionError: null,
      busy: false,
      refresh: vi.fn(),
      flush: vi.fn(),
    });
    reconcileMock.mockReturnValue({
      conflicts: [makeCacheEntry({ entityType: "task", entityId: "task-1", serverRevision: 9 })],
      busy: false,
      error: null,
      online: true,
      reconcile: vi.fn(),
    });

    render(<SyncPage />);

    expect(
      screen.getByRole("heading", { level: 2, name: "Sync conflicts" }),
    ).toBeInTheDocument();
    expect(screen.getByText("task task-1")).toBeInTheDocument();
    expect(screen.getByText(/revision 9/)).toBeInTheDocument();
  });

  it("resolves a conflict through the resolution hook", () => {
    const resolve = vi.fn();
    resolveMock.mockReturnValue({ resolvingKey: null, error: null, resolve });
    queueMock.mockReturnValue({
      counts: { total: 1, pending: 0, conflicts: 1, failed: 0 },
      operations: [],
      state: "ready",
      error: null,
      actionError: null,
      busy: false,
      refresh: vi.fn(),
      flush: vi.fn(),
    });
    reconcileMock.mockReturnValue({
      conflicts: [makeCacheEntry({ entityType: "task", entityId: "task-1", serverRevision: 9 })],
      busy: false,
      error: null,
      online: true,
      reconcile: vi.fn(),
    });

    render(<SyncPage />);

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(resolve).toHaveBeenCalledWith({ entityType: "task", entityId: "task-1" }, "keep-mine");
  });
});
