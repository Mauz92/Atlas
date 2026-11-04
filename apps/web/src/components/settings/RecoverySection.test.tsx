import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ApiError, recoveryApi, type RecoveryStatus } from "../../api/client";
import { RecoverySection } from "./RecoverySection";

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, recoveryApi: { status: vi.fn(), regenerate: vi.fn(), reset: vi.fn() } };
});

const SET: RecoveryStatus = {
  enabled: true,
  configured: true,
  created_at: "2026-11-01T10:00:00Z",
  last_used_at: null,
  failed_attempts: 0,
};
const NEW_CODE = "ZZZZZ-YYYYY-XXXXX-WWWWW-VVVVV-TTTTT";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(recoveryApi.status).mockResolvedValue(SET);
});

describe("RecoverySection", () => {
  it("shows that a code is set, when it was made, and offers Regenerate", async () => {
    render(<RecoverySection />);
    expect(await screen.findByText(/^Set on /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument();
  });

  it("offers to create one for an account that has none", async () => {
    vi.mocked(recoveryApi.status).mockResolvedValue({ ...SET, configured: false, created_at: null });
    render(<RecoverySection />);
    expect(await screen.findByText(/^Not set/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create recovery code" })).toBeInTheDocument();
  });

  it("reports wrong tries and last use to the owner", async () => {
    vi.mocked(recoveryApi.status).mockResolvedValue({
      ...SET,
      last_used_at: "2026-11-02T10:00:00Z",
      failed_attempts: 3,
    });
    render(<RecoverySection />);
    expect(await screen.findByText(/Last used .* 3 wrong tries since\./)).toBeInTheDocument();
  });

  it("has no button when the operator turned recovery off", async () => {
    vi.mocked(recoveryApi.status).mockResolvedValue({ ...SET, enabled: false, configured: false });
    render(<RecoverySection />);
    expect(await screen.findByText(/Turned off by whoever runs this server/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks for the password, shows the new code once and drops it on Done", async () => {
    vi.mocked(recoveryApi.regenerate).mockResolvedValue({ recovery_code: NEW_CODE, created_at: "2026-11-04T00:00:00Z" });
    render(<RecoverySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "my password 123" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a new code" }));
    expect(await screen.findByLabelText("Your recovery code")).toHaveTextContent(NEW_CODE);
    expect(recoveryApi.regenerate).toHaveBeenCalledWith("my password 123");
    expect(screen.queryByLabelText("Your password")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Your recovery code")).toBeNull();
    expect(document.body.textContent).not.toContain(NEW_CODE);
  });

  it("keeps the old code when the password is wrong", async () => {
    vi.mocked(recoveryApi.regenerate).mockRejectedValue(new ApiError(400, "Current password is incorrect"));
    render(<RecoverySection />);
    fireEvent.click(await screen.findByRole("button", { name: "Regenerate" }));
    fireEvent.change(screen.getByLabelText("Your password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a new code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current password is incorrect");
    expect(screen.queryByLabelText("Your recovery code")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument());
  });
});
