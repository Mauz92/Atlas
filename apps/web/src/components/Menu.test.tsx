import { fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";

import { menuItem } from "../test/menu";
import { Menu, type MenuEntry } from "./Menu";

const onSelect = { apple: vi.fn(), banana: vi.fn(), cherry: vi.fn(), red: vi.fn() };
const onPick = vi.fn();
const onClose = vi.fn();

const ENTRIES: MenuEntry[] = [
  { kind: "item", id: "apple", label: "Apple", onSelect: onSelect.apple },
  { kind: "item", id: "banana", label: "Banana", onSelect: onSelect.banana },
  { kind: "item", id: "off", label: "Disabled", disabled: true, onSelect: vi.fn() },
  { kind: "separator", id: "sep" },
  {
    kind: "submenu",
    id: "colour",
    label: "Colour",
    entries: [
      { kind: "item", id: "red", label: "Red", checked: false, onSelect: onSelect.red },
      { kind: "item", id: "blue", label: "Blue", checked: true, onSelect: vi.fn() },
    ],
  },
  {
    kind: "date",
    id: "date",
    label: "Pick a date…",
    title: "Pick a date for Fruit",
    fieldLabel: "Due date",
    onPick,
  },
  { kind: "item", id: "cherry", label: "Cherry", onSelect: onSelect.cherry },
];

/** A trigger that opens the menu, as the task row does. */
function Harness({ initialPath }: { initialPath?: string[] }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={trigger} type="button" onClick={() => setOpen((o) => !o)}>
        Fruit menu
      </button>
      <button type="button">Elsewhere</button>
      {open && trigger.current ? (
        <Menu
          id="m"
          label="Fruit"
          anchor={trigger.current}
          entries={ENTRIES}
          initialPath={initialPath}
          onClose={(reason) => {
            onClose(reason);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function openMenu(initialPath?: string[]) {
  render(<Harness initialPath={initialPath} />);
  const trigger = screen.getByRole("button", { name: "Fruit menu" });
  fireEvent.click(trigger);
  return trigger;
}

const focused = () => document.activeElement?.textContent;

beforeEach(() => vi.clearAllMocks());

describe("Menu", () => {
  it("opens as a named menu with the first item focused and disabled items marked", () => {
    openMenu();
    expect(screen.getByRole("menu", { name: "Fruit" })).toBeInTheDocument();
    expect(focused()).toBe("Apple");
    expect(menuItem("Disabled")).toHaveAttribute("aria-disabled", "true");
    expect(menuItem("Colour")).toHaveAttribute("aria-haspopup", "menu");
    expect(menuItem("Pick a date…")).toHaveAttribute("aria-haspopup", "dialog");
  });

  it.each([
    [["ArrowDown"], "Banana"],
    // Disabled items are skipped; the separator is not an item.
    [["ArrowDown", "ArrowDown"], "Colour"],
    [["ArrowUp"], "Cherry"], // wraps
    [["End"], "Cherry"],
    [["End", "Home"], "Apple"],
    [["c"], "Colour"], // type-ahead
    [["c", "c"], "Cherry"],
  ])("keys %j move focus to %s", (keys, expected) => {
    openMenu();
    for (const key of keys) {
      fireEvent.keyDown(document.activeElement as Element, { key });
    }
    expect(focused()).toBe(expected);
  });

  it.each([
    ["Escape", "escape"],
    ["Tab", "tab"],
  ])("%s closes it and returns focus to the trigger", (key, reason) => {
    const trigger = openMenu();
    fireEvent.keyDown(document.activeElement as Element, { key });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onClose).toHaveBeenCalledWith(reason);
  });

  it("does not let Escape reach document listeners (the task panel's Esc)", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    openMenu();
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    document.removeEventListener("keydown", outer);
    expect(outer).not.toHaveBeenCalled();
  });

  it("a pointer press outside closes it without moving focus; one inside does not", () => {
    openMenu();
    fireEvent.pointerDown(menuItem("Banana"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledWith("outside");
  });

  it("choosing an item closes it, returns focus, then runs the action; a disabled one does nothing", () => {
    const trigger = openMenu();
    fireEvent.click(menuItem("Disabled"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(menuItem("Banana"));
    expect(onSelect.banana).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it.each([
    ["ArrowRight on the item", (item: HTMLElement) => fireEvent.keyDown(item, { key: "ArrowRight" })],
    ["a click", (item: HTMLElement) => fireEvent.click(item)],
  ])("opens a submenu with %s, focused on the checked choice; Back and ← return", (_, open) => {
    openMenu();
    const colour = menuItem("Colour");
    colour.focus();
    open(colour);
    const sub = screen.getByRole("menu", { name: "Colour" });
    expect(within(sub).getByRole("menuitemradio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
    expect(focused()).toBe("Blue");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowLeft" });
    expect(screen.getByRole("menu", { name: "Fruit" })).toBeInTheDocument();
    fireEvent.click(menuItem("Colour"));
    fireEvent.click(menuItem("Back"));
    expect(screen.getByRole("menu", { name: "Fruit" })).toBeInTheDocument();
  });

  it("opens straight into a submenu from initialPath", () => {
    openMenu(["colour"]);
    fireEvent.click(menuItem("Red"));
    expect(onSelect.red).toHaveBeenCalled();
  });

  it("a date view is a labelled dialog that submits only a complete date", () => {
    const trigger = openMenu(["date"]);
    const dialog = screen.getByRole("dialog", { name: "Pick a date for Fruit" });
    const field = within(dialog).getByLabelText("Due date");
    expect(field).toHaveFocus();
    const set = within(dialog).getByRole("button", { name: "Set date" });
    expect(set).toBeDisabled();
    // Opened directly: no Back button; Tab stays inside the dialog.
    expect(within(dialog).queryByRole("button", { name: "Back" })).not.toBeInTheDocument();
    fireEvent.change(field, { target: { value: "2031-03-04" } });
    fireEvent.keyDown(field, { key: "Tab" });
    expect(set).toHaveFocus();
    fireEvent.click(set);
    expect(onPick).toHaveBeenCalledWith("2031-03-04");
    expect(trigger).toHaveFocus();
  });
});
