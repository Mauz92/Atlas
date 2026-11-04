import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ApiError, api } from "../api/client";
import App from "../App";
import { AuthProvider } from "./AuthProvider";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, api: { setupStatus: vi.fn(), me: vi.fn(), setup: vi.fn(), login: vi.fn(), logout: vi.fn() } };
});
vi.mock("../components/Layout", () => ({ Layout: () => <h1>The app</h1> }));
vi.mock("../pages/Today", () => ({ Today: () => <h1>Today</h1> }));

const CODE = "ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567";

function renderApp() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("recovery code at first-run setup", () => {
  it("holds the app back until the owner has saved the code", async () => {
    vi.mocked(api.setupStatus).mockResolvedValue({ setup_required: true, recovery_enabled: true });
    vi.mocked(api.setup).mockResolvedValue({ id: "u", email: "o@example.com", display_name: "O", recovery_code: CODE });
    renderApp();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "O" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "o@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "a long enough password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "Save your recovery code" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your recovery code")).toHaveTextContent(CODE);
    expect(screen.queryByRole("heading", { name: "The app" })).toBeNull();
    const go = screen.getByRole("button", { name: "Continue to Atlas" });
    expect(go).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(go);
    expect(await screen.findByRole("heading", { name: "The app" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(CODE);
  });

  it("goes straight in when the server issued no code", async () => {
    vi.mocked(api.setupStatus).mockResolvedValue({ setup_required: true, recovery_enabled: false });
    vi.mocked(api.setup).mockResolvedValue({ id: "u", email: "o@example.com", display_name: "O", recovery_code: null });
    renderApp();
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "O" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "o@example.com" } });
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "a long enough password" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("heading", { name: "The app" })).toBeInTheDocument();
  });
});

describe("Forgot password on the sign-in page", () => {
  it("opens the form from a link and returns to sign in", async () => {
    vi.mocked(api.setupStatus).mockResolvedValue({ setup_required: false, recovery_enabled: true });
    vi.mocked(api.me).mockRejectedValue(new ApiError(401, "Not authenticated"));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
    expect(screen.getByRole("heading", { name: "Forgot your password?" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to sign in" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in to Atlas" })).toBeInTheDocument());
  });

  it("tells the owner to ask the operator when recovery is off", async () => {
    vi.mocked(api.setupStatus).mockResolvedValue({ setup_required: false, recovery_enabled: false });
    vi.mocked(api.me).mockRejectedValue(new ApiError(401, "Not authenticated"));
    renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Forgot password?" }));
    expect(screen.getByText(/turned off on this server/)).toBeInTheDocument();
  });
});
