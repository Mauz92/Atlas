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
    title: "Tasks",
    items: [
      { keys: "Enter", action: "Open the focused task (on its title)" },
      { keys: "Ctrl/⌘ Enter", action: "Save the open task" },
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
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
