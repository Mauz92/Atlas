import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { calendarApi } from "../api/client";
import { makeProviderSyncStatus } from "../test/calendar";
import { CalendarSettings } from "./CalendarSettings";

vi.mock("../api/client", () => ({
  calendarApi: { syncStatus: vi.fn(), syncProvider: vi.fn() },
}));

const statusMock = vi.mocked(calendarApi.syncStatus);
const syncMock = vi.mocked(calendarApi.syncProvider);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("CalendarSettings", () => {
  it("renders the provider sync status and last sync", async () => {
    statusMock.mockResolvedValue({
      providers: [makeProviderSyncStatus({ provider: "google", state: "idle" })],
    });

    render(<CalendarSettings />);

    expect(await screen.findByRole("heading", { name: "Google Calendar" })).toBeInTheDocument();
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(statusMock).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when no calendar account is connected", async () => {
    statusMock.mockResolvedValue({ providers: [] });

    render(<CalendarSettings />);

    expect(
      await screen.findByText(/No calendar accounts are connected yet/i),
    ).toBeInTheDocument();
  });

  it("shows a clear load error and can retry", async () => {
    statusMock.mockRejectedValueOnce(new Error("Server unreachable"));

    render(<CalendarSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");

    statusMock.mockResolvedValueOnce({ providers: [makeProviderSyncStatus()] });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Google Calendar" })).toBeInTheDocument();
  });

  it("triggers a manual sync and reloads the status", async () => {
    statusMock.mockResolvedValue({
      providers: [
        makeProviderSyncStatus({
          provider: "google",
          state: "error",
          last_success_at: null,
          last_error: "simulated provider outage",
          calendars: [],
        }),
      ],
    });
    syncMock.mockResolvedValue({ provider: "google", calendars: [] });

    render(<CalendarSettings />);
    await screen.findByRole("heading", { name: "Google Calendar" });

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    await waitFor(() => expect(syncMock).toHaveBeenCalledWith("google"));
    await waitFor(() => expect(statusMock).toHaveBeenCalledTimes(2));
  });

  it("surfaces a manual-sync failure", async () => {
    statusMock.mockResolvedValue({
      providers: [makeProviderSyncStatus({ provider: "google" })],
    });
    syncMock.mockRejectedValue(new Error("calendar sync is not available for this provider"));

    render(<CalendarSettings />);
    await screen.findByRole("heading", { name: "Google Calendar" });

    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not sync Google Calendar/);
  });
});
