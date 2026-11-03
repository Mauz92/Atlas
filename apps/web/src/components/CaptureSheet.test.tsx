import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { CaptureFab } from "./CaptureSheet";

/** jsdom has no matchMedia: make the phone query match (or not). */
function setPhone(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

function Page({ onCapture }: { onCapture: (title: string) => Promise<void> }) {
  return (
    <main>
      <section className="page">
        <button type="button">Something on the page</button>
        <CaptureFab onCapture={onCapture} placeholder="Add a task…" destination="Inbox" />
      </section>
    </main>
  );
}

afterEach(() => {
  // @ts-expect-error restore the jsdom default (no matchMedia)
  delete window.matchMedia;
  Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true });
});

describe("CaptureFab", () => {
  it("renders nothing on a wide window (the inline field stays there)", () => {
    setPhone(false);
    render(<Page onCapture={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Capture a task" })).toBeNull();
  });

  it("opens a modal sheet around the shared form, focuses the field and makes the page inert", () => {
    setPhone(true);
    render(<Page onCapture={vi.fn()} />);
    const fab = screen.getByRole("button", { name: "Capture a task" });
    expect(fab).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(fab);
    const dialog = screen.getByRole("dialog", { name: "Capture a task" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // The same accessible name as the inline field.
    expect(screen.getByLabelText("Task title")).toHaveFocus();
    expect(document.querySelector(".page")).toHaveAttribute("inert");
  });

  it("closes with Esc and returns focus to the button, and the page is no longer inert", () => {
    setPhone(true);
    render(<Page onCapture={vi.fn()} />);
    const fab = screen.getByRole("button", { name: "Capture a task" });
    fireEvent.click(fab);
    fireEvent.keyDown(screen.getByLabelText("Task title"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".page")).not.toHaveAttribute("inert");
    expect(fab).toHaveFocus();
  });

  it("closes from the Close button and from the scrim", () => {
    setPhone(true);
    const { container } = render(<Page onCapture={vi.fn()} />);
    const fab = screen.getByRole("button", { name: "Capture a task" });
    fireEvent.click(fab);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(fab);
    fireEvent.click(container.querySelector(".sheet-scrim") as HTMLElement);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fab).toHaveFocus();
  });

  it("keeps Tab inside the sheet", () => {
    setPhone(true);
    render(<Page onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture a task" }));
    const close = screen.getByRole("button", { name: "Close" });
    const input = screen.getByLabelText("Task title");
    // Add is disabled while the field is empty, so Close and the field are the controls.
    input.focus();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(input).toHaveFocus();
  });

  it("adds a task through the page's own function, says where it went and keeps the field ready", async () => {
    setPhone(true);
    const onCapture = vi.fn().mockResolvedValue(undefined);
    render(<Page onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture a task" }));
    const input = screen.getByLabelText("Task title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  Buy milk " } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Added “Buy milk” to Inbox."));
    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith("Buy milk");
    expect(input.value).toBe("");
    expect(input).toHaveFocus();
  });

  it("adds exactly one task when the first attempt fails and is retried, and ignores a double submit", async () => {
    setPhone(true);
    let release: () => void = () => {};
    const onCapture = vi
      .fn<(title: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Server unreachable"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)));
    render(<Page onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture a task" }));
    const input = screen.getByLabelText("Task title") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Call Sam" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(await screen.findByRole("alert")).toHaveTextContent("Server unreachable");
    // The title is kept for the retry; two quick submits start one request.
    expect(input.value).toBe("Call Sam");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(onCapture).toHaveBeenCalledTimes(2);
    await act(async () => release());
    await waitFor(() => expect(input.value).toBe(""));
    expect(onCapture).toHaveBeenCalledTimes(2);
  });

  it("lifts the sheet by the on-screen keyboard (visual viewport inset)", () => {
    setPhone(true);
    const listeners: Record<string, () => void> = {};
    const viewport = {
      height: window.innerHeight,
      offsetTop: 0,
      addEventListener: (type: string, fn: () => void) => (listeners[type] = fn),
      removeEventListener: () => {},
    };
    Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true });
    render(<Page onCapture={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture a task" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.style.getPropertyValue("--kb")).toBe("0px");
    act(() => {
      viewport.height = window.innerHeight - 300;
      listeners.resize();
    });
    expect(dialog.style.getPropertyValue("--kb")).toBe("300px");
  });
});
