import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { systemUpdateApi, type UpdateStatus } from "../../api/client";
import { UpdateSection } from "./UpdateSection";

vi.mock("../../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/client")>(
      "../../api/client",
    );
  return {
    ...actual,
    systemUpdateApi: { get: vi.fn(), check: vi.fn(), apply: vi.fn() },
  };
});

const BASE: UpdateStatus = {
  configured: true,
  current_version: "0.1.0",
  state: "idle",
  phase: null,
  latest_version: "0.2.0",
  update_available: true,
  notes: "Fixes",
  checked_at: "2026-11-10T10:00:00+00:00",
  started_at: null,
  finished_at: null,
  message: "",
  log: [],
  request_pending: false,
};

beforeEach(() => vi.resetAllMocks());

describe("UpdateSection", () => {
  it("explains when updating from the web app is not set up", async () => {
    vi.mocked(systemUpdateApi.get).mockResolvedValue({
      ...BASE,
      configured: false,
    });
    render(<UpdateSection />);
    expect(await screen.findByText(/not set up on this server/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /update to/i })).toBeNull();
  });

  it("asks once, says what is protected, then requests exactly the newest version", async () => {
    vi.mocked(systemUpdateApi.get).mockResolvedValue(BASE);
    vi.mocked(systemUpdateApi.apply).mockResolvedValue({
      ...BASE,
      request_pending: true,
    });
    render(<UpdateSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Update to 0.2.0" }),
    );
    expect(screen.getByText(/verified backup/i)).toBeTruthy();
    expect(systemUpdateApi.apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() =>
      expect(systemUpdateApi.apply).toHaveBeenCalledWith("0.2.0"),
    );
    expect(await screen.findByText(/Updating…/)).toBeTruthy();
  });

  it("shows a rolled-back update as an alert with the reason", async () => {
    vi.mocked(systemUpdateApi.get).mockResolvedValue({
      ...BASE,
      state: "rolled_back",
      message: "0.1.0 is running again, with your data as before.",
    });
    render(<UpdateSection />);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /running again/,
    );
  });

  it("offers no update when none is available and can check again", async () => {
    vi.mocked(systemUpdateApi.get).mockResolvedValue({
      ...BASE,
      update_available: false,
      latest_version: "0.1.0",
    });
    vi.mocked(systemUpdateApi.check).mockResolvedValue({
      ...BASE,
      update_available: false,
      request_pending: true,
    });
    render(<UpdateSection />);
    expect(await screen.findByText("Atlas is up to date.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(systemUpdateApi.check).toHaveBeenCalled());
  });

  it("renders release notes as plain text, never as markup", async () => {
    vi.mocked(systemUpdateApi.get).mockResolvedValue({
      ...BASE,
      notes: "<img src=x onerror=alert(1)>",
    });
    const { container } = render(<UpdateSection />);
    await screen.findByText("What is new");
    expect(container.querySelector("img")).toBeNull();
  });
});
