import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";

import { Menu, type MenuEntry } from "./Menu";

const ENTRIES: MenuEntry[] = [
  { kind: "item", id: "apple", label: "Apple", onSelect: vi.fn() },
  { kind: "item", id: "banana", label: "Banana", onSelect: vi.fn() },
  {
    kind: "submenu",
    id: "colour",
    label: "Colour",
    entries: [{ kind: "item", id: "red", label: "Red", checked: false, onSelect: vi.fn() }],
  },
];

function Harness() {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <main>
      <button ref={trigger} type="button" onClick={() => setOpen(true)}>
        Fruit menu
      </button>
      {open && trigger.current ? (
        <Menu id="m" label="Fruit" anchor={trigger.current} entries={ENTRIES} onClose={() => setOpen(false)} />
      ) : null}
    </main>
  );
}

function matchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  // @ts-expect-error restore the jsdom default (no matchMedia)
  delete window.matchMedia;
});

describe("Menu as a bottom sheet (phone, or no hover)", () => {
  it("keeps the menu roles and adds a scrim and a trailing Cancel", () => {
    matchMedia(true);
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Fruit menu" }));
    const menu = screen.getByRole("menu", { name: "Fruit" });
    expect(menu).toHaveClass("is-sheet");
    expect(container.querySelector(".sheet-scrim")).not.toBeNull();
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Apple",
      "Banana",
      "Colour",
      "Cancel",
    ]);
    expect(screen.getByRole("menuitem", { name: "Apple" })).toHaveFocus();
  });

  it("closes with Esc, Cancel and a press on the scrim, returning focus to the opener each time", async () => {
    matchMedia(true);
    const { container } = render(<Harness />);
    const opener = screen.getByRole("button", { name: "Fruit menu" });

    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("menuitem", { name: "Cancel" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(opener).toHaveFocus();

    fireEvent.click(opener);
    fireEvent.pointerDown(container.querySelector(".sheet-scrim") as HTMLElement);
    expect(screen.queryByRole("menu")).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("traps Tab: it cycles through the items instead of closing", () => {
    matchMedia(true);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Fruit menu" }));
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Cancel" })).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Tab" });
    expect(screen.getByRole("menuitem", { name: "Apple" })).toHaveFocus();
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("has no Cancel inside a submenu (Back is there)", () => {
    matchMedia(true);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Fruit menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Colour" }));
    expect(screen.queryByRole("menuitem", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Back" })).toBeInTheDocument();
  });

  it("stays the anchored popover where there is hover and room (no sheet, no scrim)", () => {
    matchMedia(false);
    const { container } = render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Fruit menu" }));
    expect(screen.getByRole("menu")).not.toHaveClass("is-sheet");
    expect(container.querySelector(".sheet-scrim")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Cancel" })).toBeNull();
  });
});
