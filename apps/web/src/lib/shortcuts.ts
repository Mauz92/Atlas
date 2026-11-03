/** The keyboard shortcuts that exist, in one place: the help overlay (MU-08) lists exactly these. */
export interface ShortcutGroup {
  title: string;
  items: { keys: string; action: string }[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    items: [
      { keys: "Ctrl/⌘ K", action: "Open or close the command palette (search and commands)" },
      { keys: "Ctrl/⌘ B", action: "Show or hide the sidebar" },
      { keys: "?", action: "Show this list (when you are not typing in a field)" },
      { keys: "Esc", action: "Close the open panel, palette or this list" },
    ],
  },
  {
    title: "Command palette",
    items: [
      { keys: "↑ ↓", action: "Move through the results" },
      { keys: "Enter", action: "Run the highlighted entry" },
    ],
  },
  {
    title: "Task lists (when you are not typing in a field)",
    items: [
      { keys: "j / k", action: "Move to the next / previous task (from outside a list: the first / last)" },
      { keys: "Enter", action: "Open the focused task" },
      {
        keys: "x",
        action:
          "Complete the focused task, or reopen it if it is completed. On the Tasks page: select or deselect it for bulk actions",
      },
      { keys: "t", action: "Schedule the focused task for today" },
      { keys: "m", action: "Move the focused task to a project (opens the project menu)" },
      { keys: "p", action: "Set the focused task's priority (opens the priority menu)" },
      { keys: "Space", action: "On a checkbox: complete or select" },
    ],
  },
  {
    title: "Board (a card focused)",
    items: [
      { keys: "]", action: "Move the card to the next column Atlas allows" },
      { keys: "[", action: "Move the card to the previous column Atlas allows" },
    ],
  },
  {
    title: "Menus",
    items: [
      { keys: "↑ ↓  Home End", action: "Move through the items (a letter jumps to the next item starting with it)" },
      { keys: "Enter", action: "Choose the item (→ opens a submenu, ← goes back)" },
      { keys: "Esc", action: "Close the menu and return to where you were" },
    ],
  },
  {
    title: "Task details",
    items: [{ keys: "Ctrl/⌘ Enter", action: "Save the open task now (it also saves by itself)" }],
  },
  {
    title: "Notes",
    items: [
      { keys: "Ctrl/⌘ S", action: "Save the open note now (it also saves by itself)" },
      { keys: "Ctrl/⌘ Alt B", action: "Show or hide the links and tasks panel" },
    ],
  },
];

/** True when a key press is going into a text field, so a bare-letter shortcut must not fire. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable || target.closest("[contenteditable='true'], .cm-editor")) {
    return true;
  }
  if (target instanceof HTMLInputElement) {
    // A checkbox, radio or button takes no text, so list keys (UX-03) and "?" still apply there.
    return !["checkbox", "radio", "button", "submit", "reset"].includes(target.type);
  }
  const tag = target.tagName;
  return tag === "TEXTAREA" || tag === "SELECT";
}
