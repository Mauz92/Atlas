import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, recoveryApi } from "../api/client";
import { ForgotPassword } from "./ForgotPassword";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, recoveryApi: { status: vi.fn(), regenerate: vi.fn(), reset: vi.fn() } };
});

const NEW_CODE = "ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV-TTTTT";

function fill(password = "a brand new passphrase", confirm = password) {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.com" } });
  fireEvent.change(screen.getByLabelText(/^Recovery code/), { target: { value: "abcde fghjk" } });
  fireEvent.change(screen.getByLabelText(/^New password/), { target: { value: password } });
  fireEvent.change(screen.getByLabelText(/^Confirm new password/), { target: { value: confirm } });
}

beforeEach(() => vi.resetAllMocks());

describe("ForgotPassword", () => {
  it("resets, then shows the replacement code once and returns to sign in after the acknowledgement", async () => {
    vi.mocked(recoveryApi.reset).mockResolvedValue({ recovery_code: NEW_CODE, created_at: "2026-11-04T00:00:00Z" });
    const onBack = vi.fn();
    render(<ForgotPassword enabled onBack={onBack} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("heading", { name: "Password changed" })).toBeInTheDocument();
    expect(recoveryApi.reset).toHaveBeenCalledWith("owner@example.com", "abcde fghjk", "a brand new passphrase");
    expect(screen.getByLabelText("Your recovery code")).toHaveTextContent(NEW_CODE);
    expect(screen.getByText(/every browser and app was signed out/)).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "Back to sign in" });
    expect(back).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalled();
  });

  it("says the same thing whatever part was wrong, and keeps the typed email", async () => {
    vi.mocked(recoveryApi.reset).mockRejectedValue(new ApiError(400, "The email or recovery code is not correct"));
    render(<ForgotPassword enabled onBack={() => {}} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That email and recovery code do not match.");
    expect(screen.getByLabelText("Email")).toHaveValue("owner@example.com");
    expect(screen.getByLabelText(/^New password/)).toHaveValue("a brand new passphrase");
  });

  it("explains a rate limit without hinting at the account", async () => {
    vi.mocked(recoveryApi.reset).mockRejectedValue(new ApiError(429, "Too many requests"));
    render(<ForgotPassword enabled onBack={() => {}} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Too many attempts/);
  });

  it("checks the confirmation before calling the server", async () => {
    render(<ForgotPassword enabled onBack={() => {}} />);
    fill("a brand new passphrase", "something else entirely");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The new passwords do not match.");
    expect(recoveryApi.reset).not.toHaveBeenCalled();
  });

  it("points to the operator when recovery is turned off", () => {
    const onBack = vi.fn();
    render(<ForgotPassword enabled={false} onBack={onBack} />);
    expect(screen.getByText(/turned off on this server/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Recovery code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("does not keep the typed code or passwords after a success", async () => {
    vi.mocked(recoveryApi.reset).mockResolvedValue({ recovery_code: NEW_CODE, created_at: "2026-11-04T00:00:00Z" });
    render(<ForgotPassword enabled onBack={() => {}} />);
    fill();
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(screen.queryByLabelText(/^New password/)).toBeNull());
    expect(document.body.textContent).not.toContain("a brand new passphrase");
  });
});
