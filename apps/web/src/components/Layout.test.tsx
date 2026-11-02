import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { Layout } from "./Layout";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { display_name: "Owner", email: "o@example.com" }, logout: vi.fn() }),
}));
vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    projectsApi: { list: vi.fn().mockResolvedValue({ projects: [] }) },
    searchApi: { search: vi.fn() },
  };
});

describe("Layout shortcut", () => {
  it.each([
    ["ctrlKey", { ctrlKey: true }],
    ["metaKey", { metaKey: true }],
  ])("%s + K toggles the command palette from anywhere", (_name, modifier) => {
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "k", ...modifier });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "K", ...modifier });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("the topbar button opens it and Esc closes it", () => {
    render(
      <MemoryRouter>
        <Layout />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Search · Ctrl K/ }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});
