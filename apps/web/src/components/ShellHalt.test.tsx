import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { AtlasDesktopApi, DesktopSnapshot } from "../lib/desktop";
import { fakeDesktopSync } from "../test/syncUi";
import { ShellHalt } from "./ShellHalt";

function snap(halt: NonNullable<DesktopSnapshot["sync"]>["halt"]): DesktopSnapshot {
  return {
    phase: "running", reason: null, session: null,
    sync: { state: "restore_confirmation", halt, pending: 3, failed: 0, conflicts: 0, lastSyncAt: null, online: true, cursor: 7 },
    notes: null, settings: { remindersEnabled: true, contentMode: "full", closeToTray: true, autostartAsked: true }, live: false, notificationPermission: "granted",
  };
}

afterEach(() => {
  delete window.atlasDesktop;
});

describe("ShellHalt", () => {
  it("restore: the two buttons call the engine verbs, discard only after asking twice", async () => {
    const sync = fakeDesktopSync();
    window.atlasDesktop = { sync } as unknown as AtlasDesktopApi;
    render(<ShellHalt snapshot={snap({ kind: "restore_confirmation", reason: "epoch_mismatch", epoch: "e2", head: null })} />);
    fireEvent.click(screen.getByRole("button", { name: "Discard local changes and re-download" }));
    expect(sync.calls).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Yes, discard and re-download" }));
    await waitFor(() => expect(sync.calls).toEqual(["discardLocal"]));
  });

  it("re-upload calls confirmRestore; a failure is shown", async () => {
    const sync = fakeDesktopSync({ confirmRestore: async () => { throw new Error("no restore to confirm"); } });
    window.atlasDesktop = { sync } as unknown as AtlasDesktopApi;
    render(<ShellHalt snapshot={snap({ kind: "restore_confirmation", reason: "cursor_ahead", epoch: null, head: 4 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Re-upload my local data" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no restore to confirm");
    expect(screen.getByText("change 4")).toBeInTheDocument();
  });

  it("update required: Check again resumes the engine", async () => {
    const sync = fakeDesktopSync();
    window.atlasDesktop = { sync } as unknown as AtlasDesktopApi;
    render(<ShellHalt snapshot={snap({ kind: "update_required", min: 1, max: 1 })} />);
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(sync.calls).toEqual(["resumeAfterUpdate"]));
  });
});
