import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, useLocation } from "react-router-dom";

import App from "./App";

/**
 * The routing table (UX-02): every URL that existed before the new shell still resolves, and `/day`
 * redirects to Today (ADR-0051 §2). Pages and the shell are stubbed; only the routes are under test.
 */
vi.mock("./auth/AuthProvider", () => ({ useAuth: () => ({ state: "authenticated" }) }));
vi.mock("./components/Layout", () => ({
  Layout: () => {
    const location = useLocation();
    return (
      <>
        <p data-testid="location">{location.pathname}</p>
        <Outlet />
      </>
    );
  },
}));

function stub(name: string) {
  return () => <h1>{name}</h1>;
}
vi.mock("./pages/Today", () => ({ Today: stub("Today") }));
vi.mock("./pages/Inbox", () => ({ Inbox: stub("Inbox") }));
vi.mock("./pages/Upcoming", () => ({ Upcoming: stub("Upcoming") }));
vi.mock("./pages/Week", () => ({ Week: stub("Week") }));
vi.mock("./pages/Board", () => ({ BoardPage: stub("Board") }));
vi.mock("./pages/Tasks", () => ({ Tasks: stub("Tasks") }));
vi.mock("./pages/Projects", () => ({ Projects: stub("Projects") }));
vi.mock("./pages/ProjectPage", () => ({ ProjectPage: stub("Project") }));
vi.mock("./pages/Calendar", () => ({ CalendarPage: stub("Calendar") }));
vi.mock("./pages/Sync", () => ({ SyncPage: stub("Sync") }));
vi.mock("./pages/Search", () => ({ SearchPage: stub("Search") }));
vi.mock("./pages/Notifications", () => ({ NotificationsPage: stub("Notifications") }));
vi.mock("./pages/Notes", () => ({ Notes: stub("Notes") }));
vi.mock("./pages/Settings", () => ({ Settings: stub("Settings") }));
vi.mock("./pages/Login", () => ({ Login: stub("Login") }));
vi.mock("./pages/Setup", () => ({ Setup: stub("Setup") }));

describe("routes", () => {
  it.each([
    ["/", "Today", "/"],
    ["/inbox", "Inbox", "/inbox"],
    ["/upcoming", "Upcoming", "/upcoming"],
    ["/day", "Today", "/"],
    ["/day?date=2026-11-02", "Today", "/"],
    ["/week", "Week", "/week"],
    ["/board", "Board", "/board"],
    ["/tasks", "Tasks", "/tasks"],
    ["/projects", "Projects", "/projects"],
    ["/projects/abc", "Project", "/projects/abc"],
    ["/calendar", "Settings", "/settings/calendar"],
    ["/sync", "Settings", "/settings/sync"],
    ["/settings/data", "Settings", "/settings/data"],
    ["/search", "Search", "/search"],
    ["/notifications", "Settings", "/settings/notifications"],
    ["/notes", "Notes", "/notes"],
    ["/settings", "Settings", "/settings"],
  ])("%s shows %s at %s", async (url, heading, finalPath) => {
    render(
      <MemoryRouter initialEntries={[url]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(finalPath);
  });
});
