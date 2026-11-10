import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { AtlasDesktopApi, DesktopSnapshot } from "../lib/desktop";
import { shellSyncItem } from "../lib/statusBar";
import { fakeDesktopSync } from "../test/syncUi";
import { Settings } from "./Settings";

// R-69 / R-73: in the desktop shell the sync-core engine is the only sync engine. The browser's
// offline queue and reconciler must never be started there.
const legacy = vi.hoisted(() => ({ queue: vi.fn(), reconcile: vi.fn() }));
vi.mock("../hooks/useOfflineQueue", () => ({ useOfflineQueue: legacy.queue }));
vi.mock("../hooks/useReconciliation", () => ({ useReconciliation: legacy.reconcile }));

const snapshot: DesktopSnapshot = {
  phase: "running", reason: null,
  session: { signedIn: true, baseUrl: "https://a", device: { id: "d", name: "Desk" }, keystoreError: null },
  sync: { state: "offline", pending: 4, failed: 0, conflicts: 0, lastSyncAt: null, online: false },
  notes: null, settings: { remindersEnabled: true, contentMode: "full", closeToTray: true, autostartAsked: true }, live: false, notificationPermission: "granted",
};

afterEach(() => {
  delete window.atlasDesktop;
  vi.clearAllMocks();
});

describe("Settings > Sync inside the desktop shell", () => {
  it("shows the engine's state and never starts the browser's queue or reconciler", async () => {
    window.atlasDesktop = { snapshot: async () => snapshot, subscribe: () => () => undefined, syncNow: async () => undefined, sync: fakeDesktopSync() } as unknown as AtlasDesktopApi;
    render(
      <MemoryRouter initialEntries={["/settings/sync"]}>
        <Routes>
          <Route path="/settings/:section" element={<Settings />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Offline: changes wait on this computer")).toBeInTheDocument();
    expect(legacy.queue).not.toHaveBeenCalled();
    expect(legacy.reconcile).not.toHaveBeenCalled();
  });
});

describe("shellSyncItem", () => {
  const base = { state: "idle", pending: 0, failed: 0, conflicts: 0, online: true };
  it("words the engine's state for the status bar", () => {
    expect(shellSyncItem(base, "running")).toMatchObject({ text: "Synced", tone: "ok" });
    expect(shellSyncItem({ ...base, pending: 3 }, "running").text).toBe("3 queued");
    expect(shellSyncItem({ ...base, online: false, pending: 1 }, "running").text).toMatch(/Offline/);
    expect(shellSyncItem({ ...base, conflicts: 2 }, "running").text).toBe("2 conflicts");
    expect(shellSyncItem({ ...base, state: "restore_confirmation" }, "running")).toMatchObject({ tone: "danger" });
    expect(shellSyncItem(null, "signed_out").text).toBe("Signed out");
    expect(shellSyncItem(null, "update_required").text).toBe("Update required");
    expect(shellSyncItem(null, "starting").text).toBe("Starting");
  });
});
