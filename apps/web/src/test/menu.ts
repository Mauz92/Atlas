import { fireEvent, screen } from "@testing-library/react";

/** The open menu's item (plain or radio) with exactly this name. */
export function menuItem(name: string): HTMLElement {
  const found = [
    ...screen.queryAllByRole("menuitem", { name }),
    ...screen.queryAllByRole("menuitemradio", { name }),
  ];
  if (found.length !== 1) {
    throw new Error(`expected one menu item named "${name}", found ${found.length}`);
  }
  return found[0];
}

/** Open a menu from its trigger, then choose items in order (submenus first). */
export async function choose(trigger: string, ...path: string[]) {
  fireEvent.click(await screen.findByRole("button", { name: trigger }));
  for (const name of path) {
    fireEvent.click(menuItem(name));
  }
}
