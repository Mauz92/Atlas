import { fireEvent, render, screen } from "@testing-library/react";

import { makeCacheEntry } from "../test/offline";
import { ConflictNotice } from "./ConflictNotice";

describe("ConflictNotice", () => {
  it("renders nothing when there is nothing to surface", () => {
    const { container } = render(<ConflictNotice conflicts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists each conflicted entity with the server revision, stating the local edit is kept", () => {
    render(
      <ConflictNotice
        conflicts={[makeCacheEntry({ entityType: "task", entityId: "task-1", serverRevision: 9 })]}
      />,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Sync conflicts" })).toBeInTheDocument();
    expect(screen.getByText(/could not be applied/)).toBeInTheDocument();
    expect(screen.getByText("task task-1")).toBeInTheDocument();
    expect(screen.getByText(/revision 9/)).toBeInTheDocument();
    expect(screen.getByText(/your edit was kept/i)).toBeInTheDocument();
  });

  it("copes with an unknown server revision", () => {
    render(<ConflictNotice conflicts={[makeCacheEntry({ serverRevision: null })]} />);
    expect(screen.getByText(/This item changed on the server/i)).toBeInTheDocument();
  });

  it("surfaces a reconciliation failure as an alert", () => {
    render(<ConflictNotice conflicts={[]} error="Could not reach the server" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Could not reach the server");
    expect(screen.getByRole("heading", { level: 2, name: "Sync conflicts" })).toBeInTheDocument();
  });

  it("offers a keyboard-focusable retry that disables while in flight", () => {
    const onReconcile = vi.fn();
    const { rerender } = render(
      <ConflictNotice conflicts={[makeCacheEntry()]} onReconcile={onReconcile} />,
    );

    const button = screen.getByRole("button", { name: "Retry sync" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onReconcile).toHaveBeenCalledTimes(1);

    rerender(<ConflictNotice conflicts={[makeCacheEntry()]} onReconcile={onReconcile} busy />);
    expect(screen.getByRole("button", { name: "Syncing…" })).toBeDisabled();
  });

  it("offers a Keep mine / Take server action per conflicted entity", () => {
    const onResolve = vi.fn();
    const entry = makeCacheEntry({ entityType: "task", entityId: "task-1" });
    render(<ConflictNotice conflicts={[entry]} onResolve={onResolve} />);

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
    expect(onResolve).toHaveBeenCalledWith(entry, "keep-mine");

    fireEvent.click(screen.getByRole("button", { name: "Take server" }));
    expect(onResolve).toHaveBeenCalledWith(entry, "take-server");
  });

  it("explains each resolution action", () => {
    render(<ConflictNotice conflicts={[makeCacheEntry()]} onResolve={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Keep mine" })).toHaveAttribute(
      "title",
      expect.stringMatching(/latest revision/i),
    );
    expect(screen.getByRole("button", { name: "Take server" })).toHaveAttribute(
      "title",
      expect.stringMatching(/server's version/i),
    );
  });

  it("marks the entity being resolved and disables its actions while in flight", () => {
    render(
      <ConflictNotice
        conflicts={[makeCacheEntry({ entityType: "task", entityId: "task-1" })]}
        onResolve={vi.fn()}
        resolvingKey="task:task-1"
      />,
    );

    const keep = screen.getByRole("button", { name: "Saving…" });
    expect(keep).toBeDisabled();
    expect(keep).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Take server" })).toBeDisabled();
  });

  it("does not render resolution actions when no handler is provided", () => {
    render(<ConflictNotice conflicts={[makeCacheEntry()]} />);
    expect(screen.queryByRole("button", { name: "Keep mine" })).not.toBeInTheDocument();
  });
});
