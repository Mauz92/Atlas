import { NavLink, Outlet } from "react-router-dom";

import { useAuth } from "../auth/AuthProvider";
import { ThemeToggle } from "./ThemeToggle";

export const NAV_ITEMS = [
  { to: "/", label: "Today" },
  { to: "/inbox", label: "Inbox" },
  { to: "/upcoming", label: "Upcoming" },
  { to: "/tasks", label: "Tasks" },
  { to: "/projects", label: "Projects" },
  { to: "/calendar", label: "Calendar" },
  { to: "/notes", label: "Notes" },
  { to: "/search", label: "Search" },
  { to: "/settings", label: "Settings" },
] as const;

export function Layout() {
  const { user, logout } = useAuth();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">Atlas</div>
        <nav aria-label="Main navigation">
          <ul>
            {NAV_ITEMS.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.to === "/"}>
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">{user?.display_name ?? user?.email}</span>
          <div className="topbar-actions">
            <ThemeToggle />
            <button type="button" className="ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
