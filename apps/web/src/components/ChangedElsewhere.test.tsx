import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { ChangedElsewhere } from "./ChangedElsewhere";
import { fakeSource, resolution } from "../test/syncUi";

beforeEach(() => window.localStorage.clear());

function renderAt(path: string, source = fakeSource([[resolution(), resolution({ id: "r2", device_id: "d-laptop" })]])) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ChangedElsewhere source={source} />
    </MemoryRouter>,
  );
}

describe("ChangedElsewhere banner", () => {
  it("counts new entries from other devices, links to the page and can be dismissed for good", async () => {
    const { unmount } = renderAt("/");
    const banner = await screen.findByRole("region", { name: "Changed on another device" });
    expect(banner).toHaveTextContent("2 changes were made on another device");
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute("href", "/changes");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "Changed on another device" })).toBeNull();
    unmount();
    renderAt("/");
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("region", { name: "Changed on another device" })).toBeNull();
  });

  it("is hidden on the Changes page, and a failing source shows nothing", async () => {
    renderAt("/changes");
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("region", { name: "Changed on another device" })).toBeNull();
    renderAt("/", fakeSource([[]], { page: async () => { throw new Error("offline"); } }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("region", { name: "Changed on another device" })).toBeNull();
  });
});
