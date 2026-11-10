import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { InstantUpdates } from "./InstantUpdates";

const ROWS = [
  { id: "a", label: "Notifications on this device", value: "On", tone: "ok", help: "Shows reminders." },
  { id: "b", label: "Live connection", value: "Not connected", tone: "warn", help: "Later." },
] as const;

describe("InstantUpdates", () => {
  it("shows a row per fact with its value and help", () => {
    render(<InstantUpdates rows={[...ROWS]} />);
    expect(screen.getByRole("heading", { name: "Instant updates" })).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Shows reminders.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("the test button reports what happened and is disabled until notifications are allowed", async () => {
    const onTest = vi.fn().mockResolvedValue("shown");
    const { rerender } = render(<InstantUpdates rows={[...ROWS]} onTest={onTest} testEnabled={false} />);
    expect(screen.getByRole("button", { name: "Show a test notification" })).toBeDisabled();
    expect(screen.getByText("Allow notifications first.")).toBeInTheDocument();
    rerender(<InstantUpdates rows={[...ROWS]} onTest={onTest} testEnabled />);
    fireEvent.click(screen.getByRole("button", { name: "Show a test notification" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/test notification was sent/));
    expect(onTest).toHaveBeenCalledTimes(1);
  });

  it("a denied or failed test says so", async () => {
    render(<InstantUpdates rows={[...ROWS]} onTest={async () => "denied"} />);
    fireEvent.click(screen.getByRole("button", { name: "Show a test notification" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/not allowed/));
  });
});
