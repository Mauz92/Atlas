import { fireEvent, render, screen } from "@testing-library/react";

import { makeProviderSyncStatus } from "../test/calendar";
import { SyncStatus } from "./SyncStatus";

const baseProps = {
  error: null,
  actionError: null,
  busyProvider: null,
  onRetry: vi.fn(),
  onSyncNow: vi.fn(),
} as const;

describe("SyncStatus", () => {
  it("renders a loading state", () => {
    render(<SyncStatus {...baseProps} providers={[]} state="loading" />);
    expect(screen.getByText(/Loading sync status/i)).toBeInTheDocument();
  });

  it("renders an empty state when nothing is connected", () => {
    render(<SyncStatus {...baseProps} providers={[]} state="ready" />);
    expect(screen.getByText(/No calendar accounts are connected yet/i)).toBeInTheDocument();
  });

  it("renders the load error with a retry affordance", () => {
    const onRetry = vi.fn();
    render(
      <SyncStatus
        {...baseProps}
        providers={[]}
        state="error"
        error="Server unreachable"
        onRetry={onRetry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Server unreachable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the provider state, last sync and calendar detail", () => {
    render(
      <SyncStatus
        {...baseProps}
        state="ready"
        providers={[makeProviderSyncStatus({ provider: "google", state: "idle" })]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Google Calendar" })).toBeInTheDocument();
    expect(screen.getByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText(/Last synced/)).toBeInTheDocument();
    expect(screen.getByText("cal-primary")).toBeInTheDocument();
    expect(screen.getByText(/Cursor healthy/)).toBeInTheDocument();
  });

  it("renders an error provider with the safe message", () => {
    render(
      <SyncStatus
        {...baseProps}
        state="ready"
        providers={[
          makeProviderSyncStatus({
            provider: "microsoft",
            state: "error",
            last_success_at: null,
            last_error: "simulated provider outage",
            calendars: [],
          }),
        ]}
      />,
    );

    expect(screen.getByRole("heading", { name: "Microsoft Outlook" })).toBeInTheDocument();
    expect(screen.getByText("Sync failed")).toBeInTheDocument();
    expect(screen.getByText("Never synced")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("simulated provider outage");
    expect(screen.getByText(/No calendars synced yet/i)).toBeInTheDocument();
  });

  it("offers a keyboard-focusable Sync now that disables while in flight", () => {
    const onSyncNow = vi.fn();
    const { rerender } = render(
      <SyncStatus
        {...baseProps}
        state="ready"
        providers={[makeProviderSyncStatus({ provider: "google" })]}
        onSyncNow={onSyncNow}
      />,
    );

    const button = screen.getByRole("button", { name: "Sync now" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onSyncNow).toHaveBeenCalledWith("google");

    rerender(
      <SyncStatus
        {...baseProps}
        state="ready"
        providers={[makeProviderSyncStatus({ provider: "google" })]}
        busyProvider="google"
        onSyncNow={onSyncNow}
      />,
    );
    const busyButton = screen.getByRole("button", { name: "Syncing…" });
    expect(busyButton).toBeDisabled();
  });

  it("surfaces a manual-sync failure as an alert without hiding the status", () => {
    render(
      <SyncStatus
        {...baseProps}
        state="ready"
        providers={[makeProviderSyncStatus({ provider: "google" })]}
        actionError="Could not sync Google Calendar: calendar sync is not available"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/Could not sync Google Calendar/);
    expect(screen.getByText("Up to date")).toBeInTheDocument();
  });
});
