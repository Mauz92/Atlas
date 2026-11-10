import { fireEvent, render, screen } from "@testing-library/react";

import { SyncHaltScreen } from "./SyncHaltScreen";

const RESTORE = { kind: "restore_confirmation", reason: "epoch_mismatch", epoch: "e2", head: null } as const;

describe("SyncHaltScreen", () => {
  it("restore: offers both choices, calls nothing by itself, and discard asks again", () => {
    const onReupload = vi.fn();
    const onDiscard = vi.fn();
    render(<SyncHaltScreen halt={RESTORE} info={{ pending: 2, cursor: 9 }} onReupload={onReupload} onDiscard={onDiscard} />);
    expect(screen.getByRole("heading", { name: "The server was restored from a backup" })).toBeInTheDocument();
    expect(onReupload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard local changes and re-download" }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm discarding local changes" })).toHaveTextContent("the 2 unsent changes");
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    fireEvent.click(screen.getByRole("button", { name: "Re-upload my local data" }));
    expect(onReupload).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Discard local changes and re-download" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, discard and re-download" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("the primary action has focus, so the keyboard answer is the safe one", () => {
    render(<SyncHaltScreen halt={RESTORE} info={{ pending: 0, cursor: 0 }} />);
    expect(screen.getByRole("button", { name: "Re-upload my local data" })).toHaveFocus();
  });

  it("signed out: one action, and says nothing was deleted", () => {
    const onSignIn = vi.fn();
    render(<SyncHaltScreen halt={{ kind: "signed_out", code: "token_revoked" }} info={{ pending: 0, cursor: 0 }} onSignIn={onSignIn} />);
    expect(screen.getByText(/Nothing on this device was deleted/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    expect(onSignIn).toHaveBeenCalled();
  });

  it("update required: explains the protocol range and offers Check again", () => {
    const onCheckAgain = vi.fn();
    render(<SyncHaltScreen halt={{ kind: "update_required", min: 1, max: 2 }} info={{ pending: 0, cursor: 0 }} onCheckAgain={onCheckAgain} />);
    expect(screen.getByRole("heading", { name: "Atlas needs to be updated" })).toBeInTheDocument();
    expect(screen.getByText(/protocol 1 to 2/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheckAgain).toHaveBeenCalled();
  });

  it("shows an error from the action", () => {
    render(<SyncHaltScreen halt={RESTORE} info={{ pending: 0, cursor: 0 }} error="Could not start" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Could not start");
  });
});
