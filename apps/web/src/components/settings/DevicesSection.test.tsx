import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { ApiError, devicesApi, type SyncDevice } from "../../api/client";
import { DevicesSection } from "./DevicesSection";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, devicesApi: { list: vi.fn(), rename: vi.fn(), revoke: vi.fn(), revokeAll: vi.fn() } };
});

function device(over: Partial<SyncDevice> = {}): SyncDevice {
  return {
    id: "d1",
    name: "Kim's laptop",
    platform: "linux",
    created_at: "2026-11-01T10:00:00Z",
    last_seen_at: "2026-11-03T08:30:00Z",
    revoked_at: null,
    current: false,
    ...over,
  };
}

const LAPTOP = device();
const PHONE = device({ id: "d2", name: "Pixel", platform: "android", last_seen_at: null });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(devicesApi.list).mockResolvedValue({ items: [LAPTOP, PHONE] });
});

describe("DevicesSection", () => {
  it("lists the devices with their platform, last seen time and named actions", async () => {
    render(<DevicesSection />);
    const list = await screen.findByRole("list", { name: "Signed-in devices" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Kim's laptop")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/Linux · Last seen/)).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Android · Not seen yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename Kim's laptop" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out Pixel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out all devices" })).toBeInTheDocument();
    expect(screen.queryByText("This device")).toBeNull();
  });

  it("marks the device this request belongs to", async () => {
    vi.mocked(devicesApi.list).mockResolvedValue({ items: [device({ current: true })] });
    render(<DevicesSection />);
    expect(await screen.findByText("This device")).toBeInTheDocument();
  });

  it("shows an empty state that says what to do, and no sign-out-all button", async () => {
    vi.mocked(devicesApi.list).mockResolvedValue({ items: [] });
    render(<DevicesSection />);
    expect(await screen.findByText(/No device is signed in/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign out all devices" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Signed-in devices" })).toBeNull();
  });

  it("offers a retry when the list cannot be loaded", async () => {
    vi.mocked(devicesApi.list).mockRejectedValueOnce(new ApiError(500, "boom"));
    render(<DevicesSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Signed-in devices" })).toBeInTheDocument();
  });

  it("renames inline, trims nothing itself and reloads the list", async () => {
    vi.mocked(devicesApi.rename).mockResolvedValue({ ...LAPTOP, name: "Work PC" });
    render(<DevicesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Kim's laptop" }));
    const field = screen.getByLabelText("Name for Kim's laptop");
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "Work PC" } });
    vi.mocked(devicesApi.list).mockResolvedValue({ items: [{ ...LAPTOP, name: "Work PC" }, PHONE] });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByText("Renamed to Work PC")).toBeInTheDocument();
    expect(devicesApi.rename).toHaveBeenCalledWith("d1", "Work PC");
    expect(await screen.findByRole("button", { name: "Rename Work PC" })).toBeInTheDocument();
  });

  it("cancels a rename with Escape or the button, changing nothing", async () => {
    render(<DevicesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Pixel" }));
    fireEvent.keyDown(screen.getByLabelText("Name for Pixel"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Rename Pixel" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename Pixel" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(devicesApi.rename).not.toHaveBeenCalled();
  });

  it("keeps the rename field open and says why when the server refuses", async () => {
    vi.mocked(devicesApi.rename).mockRejectedValue(new ApiError(422, "name: Name must not be blank"));
    render(<DevicesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Rename Pixel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("name: Name must not be blank");
    expect(screen.getByLabelText("Name for Pixel")).toBeInTheDocument();
  });

  it("asks once before signing a device out, and a sign-out is immediate after the answer", async () => {
    vi.mocked(devicesApi.revoke).mockResolvedValue(undefined);
    render(<DevicesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Kim's laptop" }));
    const ask = screen.getByRole("group", { name: "Sign out Kim's laptop?" });
    expect(ask).toHaveTextContent(/stops syncing at once/);
    expect(devicesApi.revoke).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Keep signed in" }));
    expect(screen.queryByRole("group", { name: "Sign out Kim's laptop?" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Sign out Kim's laptop" }));
    vi.mocked(devicesApi.list).mockResolvedValue({ items: [PHONE] });
    fireEvent.click(screen.getByRole("button", { name: "Confirm: sign out Kim's laptop" }));
    expect(await screen.findByText("Kim's laptop was signed out")).toBeInTheDocument();
    expect(devicesApi.revoke).toHaveBeenCalledWith("d1");
    await waitFor(() => expect(screen.queryByText("Kim's laptop")).toBeNull());
  });

  it("shows a failed sign-out and lets the owner try again", async () => {
    vi.mocked(devicesApi.revoke).mockRejectedValue(new ApiError(500, "Internal Server Error"));
    render(<DevicesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Pixel" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm: sign out Pixel" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Internal Server Error");
    expect(screen.getByRole("button", { name: "Sign out Pixel" })).toBeInTheDocument();
  });

  it("signs every device out after one confirmation", async () => {
    vi.mocked(devicesApi.revokeAll).mockResolvedValue({ revoked: 2 });
    render(<DevicesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out all devices" }));
    const ask = screen.getByRole("group", { name: "Sign out all devices?" });
    expect(ask).toHaveTextContent("Sign out all 2 devices?");
    expect(devicesApi.revokeAll).not.toHaveBeenCalled();
    vi.mocked(devicesApi.list).mockResolvedValue({ items: [] });
    fireEvent.click(within(ask).getByRole("button", { name: "Confirm: sign out all devices" }));
    expect(await screen.findByText("2 devices were signed out")).toBeInTheDocument();
    expect(await screen.findByText(/No device is signed in/)).toBeInTheDocument();
  });

  it("never shows or asks for a token", async () => {
    render(<DevicesSection />);
    await screen.findByRole("list", { name: "Signed-in devices" });
    expect(document.body.textContent).not.toMatch(/atd_|token|Bearer/i);
  });
});
