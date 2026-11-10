import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import type { AtlasDesktopApi, DesktopSnapshot } from "../lib/desktop";
import { fakeDesktopSync, problem } from "../test/syncUi";
import { ShellSyncSettings } from "./ShellSyncSettings";

function snapshot(sync: Partial<NonNullable<DesktopSnapshot["sync"]>> = {}): DesktopSnapshot {
  return {
    phase: "running",
    reason: null,
    session: { signedIn: true, baseUrl: "https://a", device: { id: "d", name: "Desk" }, keystoreError: null },
    sync: { state: "idle", pending: 2, failed: 0, conflicts: 1, lastSyncAt: 1_800_000_000_000, online: true, ...sync },
    notes: null,
    settings: { remindersEnabled: true, contentMode: "full", closeToTray: true, autostartAsked: true },
    live: true,
    notificationPermission: "granted",
  };
}

function install(sync = fakeDesktopSync(), snap = snapshot()) {
  const syncNow = vi.fn(async () => undefined);
  window.atlasDesktop = { snapshot: async () => snap, subscribe: () => () => undefined, syncNow, sync } as unknown as AtlasDesktopApi;
  return { sync, syncNow };
}

afterEach(() => {
  delete window.atlasDesktop;
});

const renderIt = () => render(<MemoryRouter><ShellSyncSettings /></MemoryRouter>);

describe("ShellSyncSettings (engine state in the desktop shell)", () => {
  it("shows the engine's state, Sync now and the Changes link", async () => {
    const { syncNow } = install();
    renderIt();
    expect(await screen.findByText("Up to date")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Changes from other devices" })).toHaveAttribute("href", "/changes");
    fireEvent.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(syncNow).toHaveBeenCalled());
    expect(await screen.findByText("Nothing needs your attention.")).toBeInTheDocument();
  });

  it("a text conflict kept by the engine: keep mine queues an ordinary edit; keep theirs only dismisses", async () => {
    const sync = fakeDesktopSync({ problems: async () => [problem()] });
    install(sync);
    renderIt();
    const resolver = await screen.findByRole("group", { name: /Two versions of the title/ });
    expect(resolver).toHaveTextContent("My title");
    expect(resolver).toHaveTextContent("Their title");
    fireEvent.click(screen.getByRole("button", { name: "Keep mine: title" }));
    await waitFor(() => expect(sync.calls).toContain("resolveText p1 title My title"));
    fireEvent.click(screen.getByRole("button", { name: "Keep theirs: title" }));
    await waitFor(() => expect(sync.calls).toContain("dismiss p1"));
  });

  it("a refused write can be dismissed", async () => {
    const sync = fakeDesktopSync({ problems: async () => [problem({ kind: "failed", reason: "not_found", conflicts: [] })] });
    install(sync);
    renderIt();
    expect(await screen.findByText(/no longer exists on the server/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Dismiss: A change to a task could not be saved/ }));
    await waitFor(() => expect(sync.calls).toContain("dismiss p1"));
  });

  it("an error from the engine is shown and nothing is claimed", async () => {
    const sync = fakeDesktopSync({ problems: async () => [problem({ kind: "failed", reason: "x", conflicts: [] })], dismissProblem: async () => { throw new Error("engine busy"); } });
    install(sync);
    renderIt();
    fireEvent.click(await screen.findByRole("button", { name: /Dismiss:/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("engine busy");
  });
});
