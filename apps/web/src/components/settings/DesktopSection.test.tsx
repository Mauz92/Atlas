import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../../api/client";
import type { AtlasDesktopApi, DesktopSnapshot } from "../../lib/desktop";
import { parseSettingsSection, visibleSettingsSections } from "../../lib/settingsSections";
import { Settings } from "../../pages/Settings";
import { DesktopSection } from "./DesktopSection";

const snapshot: DesktopSnapshot = {
  phase: "running",
  reason: null,
  session: { signedIn: true, baseUrl: "https://atlas.example.org", device: { id: "d1", name: "Linux desktop" }, keystoreError: null },
  sync: { state: "idle", pending: 2, failed: 0, conflicts: 0, lastSyncAt: 1_800_000_000_000, online: true },
  notes: { root: "/home/me/Atlas Notes", lastScanAt: 1, lastError: null, skipped: [{ path: "huge.md", reason: "too_large", detail: "larger than 5 MiB" }], counts: {} },
  settings: { remindersEnabled: true, contentMode: "full", closeToTray: true, autostartAsked: true },
  live: true,
  notificationPermission: "granted",
};

function bridge(overrides: Partial<AtlasDesktopApi> = {}): AtlasDesktopApi {
  return {
    fetch: vi.fn(async () => new Response("{}", { status: 200 })),
    snapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(() => () => undefined),
    info: vi.fn(async () => ({ version: "0.1.0", os: "linux", autostart: false, updater: "not_configured" as const })),
    updateSettings: vi.fn(async (patch) => ({ ...snapshot.settings, ...patch })),
    chooseNotesFolder: vi.fn(async () => "/x"),
    syncNow: vi.fn(async () => undefined),
    testNotification: vi.fn(async () => ({ shownNow: true, scheduledAt: null })),
    requestNotificationPermission: vi.fn(async () => "granted"),
    setAutostart: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    checkForUpdate: vi.fn(async () => ({ available: null })),
    ...overrides,
  };
}

afterEach(() => {
  delete window.atlasDesktop;
  vi.restoreAllMocks();
});

describe("the desktop shell bridge", () => {
  it("a browser sees no desktop section and cannot open its URL", () => {
    expect(visibleSettingsSections(false).some((s) => s.id === "desktop")).toBe(false);
    expect(parseSettingsSection("desktop", false)).toBeNull();
  });

  it("inside the shell only usable sections are listed, with the desktop section first", () => {
    const ids = visibleSettingsSections(true).map((s) => s.id);
    expect(ids).toEqual(["desktop", "appearance", "sync", "about"]);
  });

  it("the Settings page lists the desktop section in the shell and hides the browser-only ones", () => {
    window.atlasDesktop = bridge();
    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <Routes>
          <Route path="/settings/:section?" element={<Settings />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getAllByText("Desktop app").length).toBeGreaterThan(0);
    expect(screen.queryByText("Devices")).toBeNull();
    expect(screen.queryByText("Account")).toBeNull();
  });

  it("apiFetch goes through the host with no cookie, no CSRF header and no credentials", async () => {
    const send = vi.fn(async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    window.atlasDesktop = bridge({ fetch: send });
    document.cookie = "atlas_csrf=abc";
    const globalFetch = vi.spyOn(globalThis, "fetch");
    await apiFetch("/api/tasks", { method: "POST", body: "{}" });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const [path, init] = send.mock.calls[0] as unknown as [string, RequestInit & { headers: Headers }];
    expect(path).toBe("/api/tasks");
    expect(init.headers.has("X-CSRF-Token")).toBe(false);
    expect(init.credentials).toBeUndefined();
  });
});

describe("<DesktopSection />", () => {
  it("shows the device facts, the skipped files and saves a setting on this device", async () => {
    const api = bridge();
    window.atlasDesktop = api;
    render(<DesktopSection />);
    await screen.findByText("Linux desktop");
    expect(screen.getByText("/home/me/Atlas Notes")).toBeTruthy();
    expect(screen.getByText(/huge.md/)).toBeTruthy();
    expect(screen.getByText(/2 change\(s\) are still waiting/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Hide the task text in notifications"));
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ contentMode: "generic" }));
    fireEvent.click(screen.getByRole("button", { name: "Send a test" }));
    await waitFor(() => expect(api.testNotification).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText("Start Atlas when I log in"));
    await waitFor(() => expect(api.setAutostart).toHaveBeenCalledWith(true));
  });

  it("offers update checks only in a build that has the updater configured", async () => {
    window.atlasDesktop = bridge();
    const { unmount } = render(<DesktopSection />);
    await screen.findByText("Linux desktop");
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
    unmount();
    window.atlasDesktop = bridge({ info: vi.fn(async () => ({ version: "0.1.0", os: "linux", autostart: false, updater: "configured" as const })) });
    render(<DesktopSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    await waitFor(() => expect(window.atlasDesktop!.checkForUpdate).toHaveBeenCalledWith(false));
  });

  it("renders nothing in a browser", () => {
    const { container } = render(<DesktopSection />);
    expect(container.textContent).toBe("");
  });
});
