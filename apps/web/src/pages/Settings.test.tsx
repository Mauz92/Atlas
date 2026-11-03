import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { ApiError, api, fetchExport, instanceApi, type InstanceInfo } from "../api/client";
import { Settings } from "./Settings";

const updateDisplayName = vi.fn();
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { display_name: "Owner", email: "o@example.com" }, updateDisplayName }),
}));
vi.mock("../components/NotificationSettings", () => ({
  NotificationSettings: () => <p>notification settings</p>,
}));
vi.mock("../components/SyncSettings", () => ({ SyncSettings: () => <p>sync settings</p> }));
vi.mock("../components/CalendarSettings", () => ({ CalendarSettings: () => <p>calendar settings</p> }));
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
  sync: {
    protocol: { min: 1, max: 1 },
    entities: { task: 1, project: 1, note: 1, note_project_link: 1, task_note_link: 1 },
    limits: { max_note_bytes: 5242880, feed_page_max: 500, feed_page_max_with_data: 200 },
    tombstone_retention_days: 90,
    idempotency_retention_days: 90,
    epoch: "00000000-0000-4000-8000-000000000000",
  },
};

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:section" element={<Settings />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(instanceApi.get).mockResolvedValue(INFO);
});

describe("Settings", () => {
  it("shows the instance facts in About", async () => {
    renderAt("/settings/about");
    expect(await screen.findByText("1.2.3", { selector: "dd" })).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Instance" })).toBeInTheDocument();
  });

  it("shows backup facts from the server in Data and backups", async () => {
    renderAt("/settings/data");
    const backups = await screen.findByRole("region", { name: "Backups" });
    expect(within(backups).getByText(/database 2.0 KB, notes 500 B/)).toBeInTheDocument();
    expect(within(backups).getByText(/1 left in staging/)).toBeInTheDocument();
  });

  it("says so when the backup folder is not visible to the API, and retries a failed load", async () => {
    vi.mocked(instanceApi.get).mockRejectedValueOnce(new Error("boom"));
    renderAt("/settings/data");
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
    renderAt("/settings/account");
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
    renderAt("/settings/account");
    for (const label of ["Current password", "New password", "Confirm new password"]) {
      fireEvent.change(screen.getByLabelText(label), { target: { value: "twelve chars!!" } });
    }
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/Other devices were signed out/)).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("shows an export failure's message", async () => {
    vi.mocked(fetchExport).mockRejectedValue(new ApiError(500, "Export failed on the server"));
    renderAt("/settings/data");
    fireEvent.click(screen.getByRole("button", { name: "Download export" }));
    await waitFor(() =>
      expect(screen.getByText("Export failed on the server")).toBeInTheDocument(),
    );
  });

  it("keeps the section in the URL and shows one section at a time", async () => {
    renderAt("/settings/sync");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Sync" })).toBeInTheDocument();
    expect(screen.getByText("sync settings")).toBeInTheDocument();
    expect(screen.queryByLabelText("Display name")).toBeNull();
    const list = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(list).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Account",
      "Appearance",
      "Notifications and reminders",
      "Calendar",
      "Sync",
      "Data and backups",
      "About",
    ]);
    expect(within(list).getByRole("link", { name: "Sync" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(list).getByRole("link", { name: "Calendar" }));
    expect(await screen.findByText("calendar settings")).toBeInTheDocument();
    expect(screen.getByTestId("where")).toHaveTextContent("/settings/calendar");
    expect(instanceApi.get).not.toHaveBeenCalled();
  });

  it("shows Account on a plain /settings and sends an unknown section there", async () => {
    renderAt("/settings");
    expect(screen.getByRole("heading", { level: 2, name: "Account" })).toBeInTheDocument();
    expect(screen.getByLabelText("Display name")).toBeInTheDocument();
    const list = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(list).queryByRole("link", { current: "page" })).toBeNull();
  });

  it("redirects an unknown section to /settings", () => {
    renderAt("/settings/nope");
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/settings$/);
  });

  it("has at most one primary button in every section", async () => {
    for (const id of ["account", "appearance", "notifications", "calendar", "sync", "data", "about"]) {
      const view = renderAt(`/settings/${id}`);
      expect(view.container.querySelectorAll("button.primary").length).toBeLessThanOrEqual(1);
      view.unmount();
    }
  });
});
