import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { QuickCapture } from "./QuickCapture";

describe("QuickCapture", () => {
  it("only asks for a title and ignores an empty submission", () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<QuickCapture onCapture={onCapture} />);

    // Title is the only field.
    expect(screen.getAllByRole("textbox")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("trims the title, clears the input and reports the capture", async () => {
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<QuickCapture onCapture={onCapture} />);

    const input = screen.getByLabelText("Task title");
    fireEvent.change(input, { target: { value: "  Call the vet  " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith("Call the vet"));
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("surfaces a capture failure with a clear message", async () => {
    const onCapture = vi.fn().mockRejectedValue(new Error("Offline"));
    render(<QuickCapture onCapture={onCapture} />);

    fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "Something" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
  });
});
