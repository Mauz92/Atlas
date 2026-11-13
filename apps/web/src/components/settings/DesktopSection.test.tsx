import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { fakeDesktopSync } from "../../test/syncUi";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiFetch } from "../../api/client";
import type { AtlasDesktopApi, DesktopSnapshot } from "../../lib/desktop";
import {
  parseSettingsSection,
  visibleSettingsSections,
} from "../../lib/settingsSections";
import { Settings } from "../../pages/Settings";
import { DesktopSection } from "./DesktopSection";

const snapshot: DesktopSnapshot = {
  phase: "running",
  reason: null,
  session: {
    signedIn: true,
    baseUrl: "https://atlas.example.org",
    device: { id: "d1", name: "Linux desktop" },
    keystoreError: null,
  },
  sync: {
    state: "idle",
    pending: 2,
    failed: 0,
    conflicts: 0,
    lastSyncAt: 1_800_000_000_000,
    online: true,
  },
  notes: {
    root: "/home/me/Atlas Notes",
    lastScanAt: 1,
    lastError: null,
    skipped: [
      { path: "huge.md", reason: "too_large", detail: "larger than 5 MiB" },
    ],
    counts: {},
  },
  settings: {
    remindersEnabled: true,
    contentMode: "full",
    closeToTray: true,
    autostartAsked: true,
  },
  live: true,
  notificationPermission: "granted",
};

function bridge(overrides: Partial<AtlasDesktopApi> = {}): AtlasDesktopApi {
  return {
    fetch: vi.fn(async () => new Response("{}", { status: 200 })),
    snapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(() => () => undefined),
    info: vi.fn(async () => ({
      version: "0.1.0",
      os: "linux",
      autostart: false,
      updater: "not_configured" as const,
    })),
    updateSettings: vi.fn(async (patch) => ({
      ...snapshot.settings,
      ...patch,
    })),
    chooseNotesFolder: vi.fn(async () => "/x"),
    syncNow: vi.fn(async () => undefined),
    testNotification: vi.fn(async () => ({
      shownNow: true,
      scheduledAt: null,
    })),
    requestNotificationPermission: vi.fn(async () => "granted"),
    setAutostart: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    checkForUpdate: vi.fn(async () => ({ available: null })),
    sync: fakeDesktopSync(),
    ...overrides,
  };
}

afterEach(() => {
  delete window.atlasDesktop;
  vi.restoreAllMocks();
});

describe("the desktop shell bridge", () => {
  it("a browser sees no desktop section and cannot open its URL", () => {
    expect(visibleSettingsSections(false).some((s) => s.id === "desktop")).toBe(
      false,
    );
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
    const send = vi.fn(
      async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    );
    window.atlasDesktop = bridge({ fetch: send });
    document.cookie = "atlas_csrf=abc";
    const globalFetch = vi.spyOn(globalThis, "fetch");
    await apiFetch("/api/tasks", { method: "POST", body: "{}" });
    expect(globalFetch).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    const [path, init] = send.mock.calls[0] as unknown as [
      string,
      RequestInit & { headers: Headers },
    ];
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
    fireEvent.click(
      screen.getByLabelText("Hide the task text in notifications"),
    );
    await waitFor(() =>
      expect(api.updateSettings).toHaveBeenCalledWith({
        contentMode: "generic",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send a test" }));
    await waitFor(() => expect(api.testNotification).toHaveBeenCalled());
    fireEvent.click(screen.getByLabelText("Start Atlas when I log in"));
    await waitFor(() => expect(api.setAutostart).toHaveBeenCalledWith(true));
  });

  it("offers update checks only in a build that has the updater configured", async () => {
    window.atlasDesktop = bridge();
    const { unmount } = render(<DesktopSection />);
    await screen.findByText("Linux desktop");
    expect(
      screen.queryByRole("button", { name: "Check for updates" }),
    ).toBeNull();
    unmount();
    window.atlasDesktop = bridge({
      info: vi.fn(async () => ({
        version: "0.1.0",
        os: "linux",
        autostart: false,
        updater: "configured" as const,
      })),
    });
    render(<DesktopSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Check for updates" }),
    );
    await waitFor(() =>
      expect(window.atlasDesktop!.checkForUpdate).toHaveBeenCalledWith(false),
    );
  });

  it("renders nothing in a browser", () => {
    const { container } = render(<DesktopSection />);
    expect(container.textContent).toBe("");
  });
});

describe("the Android shell (ADR-0075)", () => {
  const androidBridge = (
    status: Partial<import("../../lib/desktop").AndroidStatus> = {},
    openSettings = vi.fn(async () => undefined),
  ) =>
    bridge({
      info: vi.fn(async () => ({
        version: "0.1.0",
        os: "android",
        autostart: false,
        updater: "not_configured" as const,
      })),
      android: {
        status: vi.fn(async () => ({
          notifications: "granted" as const,
          exactAlarms: true,
          ignoringBatteryOptimizations: false,
          manufacturer: "OnePlus",
          sdk: 34,
          ...status,
        })),
        openSettings,
        keepConnected: {
          get: vi.fn(async () => false),
          set: vi.fn(async () => undefined),
        },
      },
    });

  it("speaks of the phone, hides tray and start-up rows, and shows the app-private notes folder", async () => {
    window.atlasDesktop = androidBridge();
    render(<DesktopSection />);
    await screen.findByText("Reminders on this phone");
    expect(screen.queryByText("Window and start-up")).toBeNull();
    expect(screen.queryByText(/tray/i)).toBeNull();
    expect(screen.getByText("Inside Atlas")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Choose|Change/ })).toBeNull();
  });

  it("warns when exact alarms are off and when battery optimisation may stop Atlas, and opens the right system screen", async () => {
    const open = vi.fn(async () => undefined);
    window.atlasDesktop = androidBridge(
      { exactAlarms: false, notifications: "denied" },
      open,
    );
    render(<DesktopSection />);
    await screen.findByText(/Android may delay reminders/);
    expect(screen.getByText(/blocking Atlas notifications/)).toBeTruthy();
    expect(screen.getByText(/OnePlus phones are strict/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(open).toHaveBeenCalledWith("exact_alarms");
    fireEvent.click(
      screen.getAllByRole("button", { name: "Open settings" })[1]!,
    );
    expect(open).toHaveBeenCalledWith("battery");
  });
});

describe("exporting the phone's notes (ADR-0075 D4)", () => {
  it("shows Export notes only when the shell offers it, and runs it", async () => {
    const exportNotes = vi.fn(async () => ({ files: 3, bytes: 2048 }));
    window.atlasDesktop = bridge({
      info: vi.fn(async () => ({
        version: "0.1.0",
        os: "android",
        autostart: false,
        updater: "not_configured" as const,
      })),
      android: {
        status: vi.fn(async () => ({
          notifications: "granted" as const,
          exactAlarms: true,
          ignoringBatteryOptimizations: true,
          manufacturer: "Google",
          sdk: 35,
        })),
        openSettings: vi.fn(async () => undefined),
        keepConnected: {
          get: vi.fn(async () => false),
          set: vi.fn(async () => undefined),
        },
      },
      exportNotes,
    });
    render(<DesktopSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Export notes…" }),
    );
    await waitFor(() => expect(exportNotes).toHaveBeenCalledTimes(1));
    await screen.findByText(/choose where to send them/);
  });

  it("a computer has no export button", async () => {
    window.atlasDesktop = bridge();
    render(<DesktopSection />);
    await screen.findByText(/Reminders on this computer/);
    expect(screen.queryByRole("button", { name: "Export notes…" })).toBeNull();
  });
});

describe("moving the phone's notes to a shared folder (ADR-0075 D4)", () => {
  const withLocation = (
    kind: "private" | "shared",
    allFilesAccess: boolean,
  ) => {
    const set = vi.fn(async () => ({
      copied: 4,
      archivedAs: "notes (previous 1)",
      identical: 1,
      switched: true,
    }));
    const get = vi.fn(async () => ({
      kind,
      sharedPath: "/storage/emulated/0/Documents/Atlas Notes",
      allFilesAccess,
    }));
    const openSettings = vi.fn(async () => undefined);
    window.atlasDesktop = bridge({
      info: vi.fn(async () => ({
        version: "0.1.0",
        os: "android",
        autostart: false,
        updater: "not_configured" as const,
      })),
      android: {
        status: vi.fn(async () => ({
          notifications: "granted" as const,
          exactAlarms: true,
          ignoringBatteryOptimizations: true,
          allFilesAccess,
          manufacturer: "Google",
          sdk: 35,
        })),
        openSettings,
        keepConnected: {
          get: vi.fn(async () => false),
          set: vi.fn(async () => undefined),
        },
      },
      notesLocation: { get, set },
    });
    return { set, get, openSettings };
  };

  it("without All files access the button opens that system screen and moves nothing", async () => {
    const { set, openSettings } = withLocation("private", false);
    render(<DesktopSection />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Keep notes in a shared folder…",
      }),
    );
    await waitFor(() => expect(openSettings).toHaveBeenCalledWith("all_files"));
    expect(set).not.toHaveBeenCalled();
    await screen.findByText(/Allow "All files access"/);
  });

  it("with the permission it copies, says nothing was deleted, and offers the way back", async () => {
    const { set } = withLocation("private", true);
    render(<DesktopSection />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Keep notes in a shared folder…",
      }),
    );
    await waitFor(() => expect(set).toHaveBeenCalledWith("shared"));
    await screen.findByText(
      /5 notes are now in Documents\/Atlas Notes \(4 copied\)\. The old folder was kept as "notes \(previous 1\)"\./,
    );
  });

  it("when the notes are shared it says where, and moving back copies again", async () => {
    const { set } = withLocation("shared", true);
    render(<DesktopSection />);
    await screen.findByText("Documents/Atlas Notes");
    fireEvent.click(
      screen.getByRole("button", { name: "Move notes back inside Atlas" }),
    );
    await waitFor(() => expect(set).toHaveBeenCalledWith("private"));
    await screen.findByText(
      /The old folder was kept as "notes \(previous 1\)"\./,
    );
  });
});

describe("keeping Atlas connected in the background (ADR-0075 D7)", () => {
  it("is off by default, explains the cost, and saves the choice through the host", async () => {
    let on = false;
    const set = vi.fn(async (v: boolean) => {
      on = v;
    });
    window.atlasDesktop = bridge({
      info: vi.fn(async () => ({
        version: "0.1.0",
        os: "android",
        autostart: false,
        updater: "not_configured" as const,
      })),
      android: {
        status: vi.fn(async () => ({
          notifications: "granted" as const,
          exactAlarms: true,
          ignoringBatteryOptimizations: false,
          manufacturer: "OnePlus",
          sdk: 34,
        })),
        openSettings: vi.fn(async () => undefined),
        keepConnected: { get: vi.fn(async () => on), set },
      },
    });
    render(<DesktopSection />);
    const box = (await screen.findByLabelText(
      "Keep Atlas connected in the background",
    )) as HTMLInputElement;
    await waitFor(() => expect(box.disabled).toBe(false));
    expect(box.checked).toBe(false);
    expect(screen.getByText(/small permanent notification/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(set).toHaveBeenCalledWith(true));
    await waitFor(() =>
      expect(
        (
          screen.getByLabelText(
            "Keep Atlas connected in the background",
          ) as HTMLInputElement
        ).checked,
      ).toBe(true),
    );
  });
});
