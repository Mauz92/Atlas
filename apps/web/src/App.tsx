import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

import { useAuth } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Placeholder } from "./pages/Placeholder";
import { Setup } from "./pages/Setup";

// The editor (CodeMirror) and Markdown renderer are only needed on the notes route.
const Notes = lazy(() => import("./pages/Notes").then((module) => ({ default: module.Notes })));

const PAGES = [
  {
    path: "/",
    title: "Today",
    description: "Scheduled tasks, due and overdue work, and upcoming events.",
  },
  { path: "/inbox", title: "Inbox", description: "Capture tasks here and triage them later." },
  {
    path: "/upcoming",
    title: "Upcoming",
    description: "Everything scheduled for the days ahead.",
  },
  {
    path: "/tasks",
    title: "Tasks",
    description: "All tasks, filterable by status, priority and date.",
  },
  { path: "/projects", title: "Projects", description: "Projects, task lists and Kanban boards." },
  {
    path: "/calendar",
    title: "Calendar",
    description: "Google and Outlook calendars in one view.",
  },
  { path: "/search", title: "Search", description: "Full-text search across notes and tasks." },
  {
    path: "/settings",
    title: "Settings",
    description: "Connections, notifications and account preferences.",
  },
] as const;

export default function App() {
  const { state } = useAuth();

  if (state === "loading") {
    return <div className="splash">Loading Atlas…</div>;
  }
  if (state === "setup") {
    return <Setup />;
  }
  if (state === "anonymous") {
    return <Login />;
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          path="/notes"
          element={
            <Suspense fallback={<div className="splash">Loading notes…</div>}>
              <Notes />
            </Suspense>
          }
        />
        {PAGES.map((page) => (
          <Route
            key={page.path}
            path={page.path}
            element={<Placeholder title={page.title} description={page.description} />}
          />
        ))}
      </Route>
    </Routes>
  );
}
