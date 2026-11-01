import { fireEvent, render, screen } from "@testing-library/react";

import { NotificationConsent } from "./NotificationConsent";

const base = { onEnable: vi.fn(), onDisable: vi.fn() };

describe("NotificationConsent", () => {
  it("shows a loading state while support is determined", () => {
    render(<NotificationConsent {...base} state="prompt" loading />);
    expect(screen.getByRole("status")).toHaveTextContent(/Checking notification support/i);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains an unsupported browser without offering an action", () => {
    render(<NotificationConsent {...base} state="unsupported" />);
    expect(screen.getByRole("heading", { name: /can't show notifications/i })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a server without VAPID keys without offering an action", () => {
    render(<NotificationConsent {...base} state="disabled" />);
    expect(
      screen.getByRole("heading", { name: /aren't available on this server/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a blocked permission without offering an action", () => {
    render(<NotificationConsent {...base} state="denied" />);
    expect(screen.getByRole("heading", { name: /blocked/i })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("offers a keyboard-focusable Enable that fires the callback", () => {
    const onEnable = vi.fn();
    render(<NotificationConsent {...base} onEnable={onEnable} state="prompt" />);
    const button = screen.getByRole("button", { name: "Enable notifications" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onEnable).toHaveBeenCalledTimes(1);
  });

  it("offers Enable when permission is already granted", () => {
    render(<NotificationConsent {...base} state="granted" />);
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
  });

  it("offers Turn off when subscribed and disables it while busy", () => {
    const onDisable = vi.fn();
    const { rerender } = render(
      <NotificationConsent {...base} onDisable={onDisable} state="subscribed" />,
    );
    const button = screen.getByRole("button", { name: "Turn off notifications" });
    fireEvent.click(button);
    expect(onDisable).toHaveBeenCalledTimes(1);

    rerender(<NotificationConsent {...base} onDisable={onDisable} state="subscribed" busy />);
    expect(screen.getByRole("button", { name: "Turning off…" })).toBeDisabled();
  });

  it("surfaces an action error as an alert", () => {
    render(<NotificationConsent {...base} state="prompt" error="Could not enable notifications" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not enable notifications");
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeInTheDocument();
  });
});
