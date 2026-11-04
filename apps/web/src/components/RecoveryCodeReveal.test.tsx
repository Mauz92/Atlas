import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { RecoveryCodeReveal } from "./RecoveryCodeReveal";

const CODE = "ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("RecoveryCodeReveal", () => {
  it("shows the code and will not continue until the owner says it is saved", () => {
    const onContinue = vi.fn();
    render(<RecoveryCodeReveal code={CODE} continueLabel="Continue to Atlas" onContinue={onContinue} />);
    expect(screen.getByLabelText("Your recovery code")).toHaveTextContent(CODE);
    const go = screen.getByRole("button", { name: "Continue to Atlas" });
    expect(go).toBeDisabled();
    fireEvent.click(go);
    expect(onContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I have saved my recovery code" }));
    expect(go).toBeEnabled();
    fireEvent.click(go);
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("copies the code and says so, or says it could not", async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("no"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<RecoveryCodeReveal code={CODE} continueLabel="Done" onContinue={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByText("Copied to the clipboard.")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(CODE);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByText(/Could not copy/)).toBeInTheDocument();
  });

  it("downloads a text file containing the code", async () => {
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => {
      blob = b;
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<RecoveryCodeReveal code={CODE} continueLabel="Done" onContinue={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Download as file" }));
    expect(click).toHaveBeenCalled();
    await waitFor(() => expect(blob).toBeDefined());
    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob!);
    });
    expect(text).toContain(CODE);
  });

  it("never writes the code to storage", () => {
    render(<RecoveryCodeReveal code={CODE} continueLabel="Done" onContinue={() => {}} />);
    const stored = JSON.stringify([
      ...Object.entries(window.localStorage),
      ...Object.entries(window.sessionStorage),
    ]);
    expect(stored).not.toContain(CODE);
  });
});
