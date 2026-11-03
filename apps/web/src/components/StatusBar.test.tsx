import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { ProviderSyncStatus } from "../api/client";
import type { OfflineQueueResult } from "../hooks/useOfflineQueue";
import type { SyncStatusResult } from "../hooks/useSyncStatus";
import { StatusBar } from "./StatusBar";

// The status bar is driven entirely by these two hooks plus connectivity; both are mocked.
const queue: { current: OfflineQueueResult } = { current: makeQueue() };
const calendar: { current: SyncStatusResult } = { current: makeCalendar() };
vi.mock("../hooks/useOfflineQueue", () => ({ useOfflineQueue: () => queue.current }));
vi.mock("../hooks/useSyncStatus", () => ({ useSyncStatus: () => calendar.current }));

function makeQueue(overrides: Partial<OfflineQueueResult> = {}, counts = {}): OfflineQueueResult {
  return {
    counts: { total: 0, pending: 0, conflicts: 0, failed: 0, ...counts },
    operations: [],
    state: "ready",
    error: null,
    actionError: null,
    busy: false,
    refresh: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    ...overrides,
  };
}

function provider(overrides: Partial<ProviderSyncStatus> = {}): ProviderSyncStatus {
  return {
    provider: "google",
    connected: true,
    state: "idle",
    last_success_at: null,
    last_error: null,
    last_error_at: null,
    calendars: [],
    ...overrides,
  } as ProviderSyncStatus;
}

function makeCalendar(overrides: Partial<SyncStatusResult> = {}): SyncStatusResult {
  return {
    providers: [],
    state: "ready",
    error: null,
    actionError: null,
    busyProvider: null,
    reload: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    ...overrides,
  };
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => value });
}

function renderBar(onShowShortcuts = vi.fn()) {
  render(
    <MemoryRouter>
      <StatusBar onShowShortcuts={onShowShortcuts} />
    </MemoryRouter>,
  );
  return onShowShortcuts;
}

const syncLink = () => screen.getByRole("link", { name: /Synced|Offline|queued|conflict|failed|unavailable/ });

beforeEach(() => {
  setOnline(true);
  queue.current = makeQueue();
  calendar.current = makeCalendar();
});

describe("StatusBar", () => {
  it("is a labelled footer, not a status role, and links sync to /settings/sync", () => {
    renderBar();
    expect(screen.getByRole("contentinfo", { name: "Status bar" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(syncLink()).toHaveTextContent("Synced");
    expect(syncLink()).toHaveAttribute("href", "/settings/sync");
    expect(syncLink().querySelector("[aria-live='polite']")).not.toBeNull();
  });

  it("shows offline and the queued count", () => {
    setOnline(false);
    queue.current = makeQueue({}, { total: 3, pending: 3 });
    renderBar();
    expect(syncLink()).toHaveTextContent("Offline · 3 queued");
    expect(syncLink()).toHaveClass("tone-warning");
  });

  it("follows the offline and online events", () => {
    renderBar();
    act(() => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(syncLink()).toHaveTextContent("Offline");
    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    expect(syncLink()).toHaveTextContent("Synced");
    // Connectivity changes and focus re-read the queue.
    expect(queue.current.refresh).toHaveBeenCalled();
  });

  it("shows queued changes while online", () => {
    queue.current = makeQueue({}, { total: 2, pending: 2 });
    renderBar();
    expect(syncLink()).toHaveTextContent("2 queued");
  });

  it("puts conflicts first, in the danger tone", () => {
    setOnline(false);
    queue.current = makeQueue({}, { total: 3, pending: 2, conflicts: 1 });
    renderBar();
    expect(syncLink()).toHaveTextContent("1 conflict");
    expect(syncLink()).toHaveClass("tone-danger");
  });

  it("shows failed changes and an unreadable queue", () => {
    queue.current = makeQueue({}, { total: 2, failed: 2 });
    const { unmount } = render(
      <MemoryRouter>
        <StatusBar onShowShortcuts={vi.fn()} />
      </MemoryRouter>,
    );
    expect(syncLink()).toHaveTextContent("2 failed changes");
    unmount();
    queue.current = makeQueue({ state: "error", error: "boom" });
    renderBar();
    expect(syncLink()).toHaveTextContent("Sync status unavailable");
  });

  it.each([
    ["not connected", makeCalendar({ providers: [] }), "Calendar not connected"],
    ["never synced", makeCalendar({ providers: [provider()] }), "Calendar not synced yet"],
    [
      "failed",
      makeCalendar({ providers: [provider({ state: "error", last_error: "token revoked" })] }),
      "Calendar sync failed",
    ],
    ["unavailable", makeCalendar({ state: "error", error: "500" }), "Calendar status unavailable"],
  ])("calendar: %s", (_name, value, text) => {
    calendar.current = value;
    renderBar();
    const link = screen.getByRole("link", { name: new RegExp(text) });
    expect(link).toHaveAttribute("href", "/settings/calendar");
  });

  it("calendar: the latest successful sync time", () => {
    const at = new Date();
    at.setHours(9, 5, 0, 0);
    calendar.current = makeCalendar({
      providers: [
        provider({ last_success_at: new Date(at.getTime() - 3_600_000).toISOString() }),
        provider({ provider: "microsoft", last_success_at: at.toISOString() }),
      ],
    });
    renderBar();
    const time = new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(at);
    expect(screen.getByRole("link", { name: `Calendar ${time}` })).toBeInTheDocument();
  });

  it("shows nothing for the calendar while it loads", () => {
    calendar.current = makeCalendar({ state: "loading" });
    renderBar();
    expect(screen.queryByRole("link", { name: /Calendar/ })).toBeNull();
  });

  it("opens the shortcut help", () => {
    const onShow = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });
});
