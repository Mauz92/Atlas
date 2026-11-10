import { fireEvent, render, screen } from "@testing-library/react";

import { TextConflictResolver } from "./TextConflictResolver";

describe("TextConflictResolver", () => {
  it("shows both versions and sends nothing until a choice is made", () => {
    const onResolve = vi.fn();
    render(<TextConflictResolver label="title" mine="Buy milk today" theirs="Buy oat milk" onResolve={onResolve} />);
    expect(screen.getByText("Buy milk today")).toBeInTheDocument();
    expect(screen.getByText("Buy oat milk")).toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("keep mine / keep theirs report that text", () => {
    const onResolve = vi.fn();
    render(<TextConflictResolver label="title" mine="A" theirs="B" onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep mine: title" }));
    fireEvent.click(screen.getByRole("button", { name: "Keep theirs: title" }));
    expect(onResolve.mock.calls).toEqual([["A", "mine"], ["B", "theirs"]]);
  });

  it("edit merged starts from mine, saves the edited text, and a title cannot be empty", () => {
    const onResolve = vi.fn();
    render(<TextConflictResolver label="title" mine="A" theirs="B" onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit merged title" }));
    const field = screen.getByLabelText("Merged title");
    expect(field).toHaveValue("A");
    fireEvent.change(field, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Save merged title" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "A and B" } });
    fireEvent.click(screen.getByRole("button", { name: "Save merged title" }));
    expect(onResolve).toHaveBeenCalledWith("A and B", "merged");
  });

  it("a multiline merge starts with both texts so nothing has to be retyped", () => {
    render(<TextConflictResolver label="description" multiline mine="mine" theirs="theirs" onResolve={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit merged description" }));
    expect(screen.getByLabelText("Merged description")).toHaveValue("mine\n\ntheirs");
  });

  it("disables everything while saving and shows an error", () => {
    render(<TextConflictResolver label="title" mine="A" theirs="B" saving error="Could not save" onResolve={() => {}} />);
    expect(screen.getByRole("button", { name: "Keep mine: title" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("Could not save");
  });
});
