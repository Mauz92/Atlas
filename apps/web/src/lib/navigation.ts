/** The main views, in sidebar order; the command palette offers the same list as "Go to …". */
export const NAV_ITEMS = [
  { to: "/", label: "Today" },
  { to: "/inbox", label: "Inbox" },
  { to: "/upcoming", label: "Upcoming" },
  { to: "/day", label: "Day" },
  { to: "/week", label: "Week" },
  { to: "/tasks", label: "Tasks" },
  { to: "/board", label: "Board" },
  { to: "/projects", label: "Projects" },
  { to: "/calendar", label: "Calendar" },
  { to: "/sync", label: "Sync" },
  { to: "/notifications", label: "Notifications" },
  { to: "/notes", label: "Notes" },
  { to: "/search", label: "Search" },
  { to: "/settings", label: "Settings" },
] as const;
