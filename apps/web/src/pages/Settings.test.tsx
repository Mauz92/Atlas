import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, api, fetchExport, instanceApi, type InstanceInfo } from "../api/client";
import { Settings } from "./Settings";

const updateDisplayName = vi.fn();
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { display_name: "Owner", email: "o@example.com" }, updateDisplayName }),
}));
vi.mock("../components/NotificationSettings", () => ({
  NotificationSettings: () => <p>notification settings</p>,
}));
vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    api: { changePassword: vi.fn() },
    instanceApi: { get: vi.fn() },
    fetchExport: vi.fn(),
  };
});

const INFO: InstanceInfo = {
  version: "1.2.3",
  environment: "production",
  database: "ok",
  migration_revision: "abc123",
  web_push_configured: false,
  backups: {
    destination_available: true,
    sets: 2,
    latest: {
      backup_id: "b1",
      created_at: "2026-11-01T03:00:00Z",
      atlas_version: "1.2.3",
      database_bytes: 2048,
      notes_bytes: 500,
    },
    incomplete_sets: 1,
    interval_seconds: 86400,
    retain: 7,
    last_job_status: "succeeded",
    last_job_at: "2026-11-01T03:00:05Z",
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(instanceApi.get).mockResolvedValue(INFO);
});

describe("Settings", () => {
  it("shows instance, version and backup facts from the server", async () => {
    render(<Settings />);
    expect(await screen.findByText("1.2.3", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    const backups = screen.getByRole("region", { name: "Backups" });
    expect(within(backups).getByText(/database 2.0 KB, notes 500 B/)).toBeInTheDocument();
    expect(within(backups).getByText(/1 left in staging/)).toBeInTheDocument();
  });

  it("says so when the backup folder is not visible to the API, and retries a failed load", async () => {
    vi.mocked(instanceApi.get).mockRejectedValueOnce(new Error("boom"));
    render(<Settings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    vi.mocked(instanceApi.get).mockResolvedValue({
      ...INFO,
      backups: { ...INFO.backups, destination_available: false, sets: 0, latest: null },
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/not visible to the API/)).toBeInTheDocument();
  });

  it("shows the server's message for a rejected name or password, verbatim", async () => {
    updateDisplayName.mockRejectedValue(new ApiError(422, "display_name: Name must not be blank"));
    vi.mocked(api.changePassword).mockRejectedValue(
      new ApiError(400, "Current password is incorrect"),
    );
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("display_name: Name must not be blank")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "old" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "twelve chars!!" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "different" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("The new passwords do not match")).toBeInTheDocument();
    expect(api.changePassword).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "twelve chars!!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Current password is incorrect")).toBeInTheDocument();
    expect(api.changePassword).toHaveBeenCalledWith("old", "twelve chars!!");
  });

  it("clears the password fields after a successful change", async () => {
    vi.mocked(api.changePassword).mockResolvedValue(undefined);
    render(<Settings />);
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: "twelve chars!!" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/Other devices were signed out/)).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("shows an export failure's message", async () => {
    vi.mocked(fetchExport).mockRejectedValue(new ApiError(500, "Export failed on the server"));
    render(<Settings />);
    fireEvent.click(screen.getByRole("button", { name: "Download export" }));
    await waitFor(() =>
      expect(screen.getByText("Export failed on the server")).toBeInTheDocument(),
    );
  });
});
