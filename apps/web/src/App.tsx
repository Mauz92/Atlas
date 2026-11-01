import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";

import { useAuth } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { BoardPage } from "./pages/Board";
import { CalendarPage } from "./pages/Calendar";
import { Day } from "./pages/Day";
import { Inbox } from "./pages/Inbox";
import { Login } from "./pages/Login";
import { NotificationsPage } from "./pages/Notifications";
import { Placeholder } from "./pages/Placeholder";
import { Setup } from "./pages/Setup";
import { SyncPage } from "./pages/Sync";
import { Today } from "./pages/Today";
import { Upcoming } from "./pages/Upcoming";
import { Week } from "./pages/Week";

// The editor (CodeMirror) and Markdown renderer are only needed on the notes route.
const Notes = lazy(() => import("./pages/Notes").then((module) => ({ default: module.Notes })));

// Views that are not part of M3-07 yet keep the placeholder screen.
const PAGES = [
  {
    path: "/tasks",
    title: "Tasks",
    description: "All tasks, filterable by status, priority and date.",
  },
  { path: "/projects", title: "Projects", description: "Projects, task lists and Kanban boards." },
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
        <Route path="/" element={<Today />} />
        <Route path="/inbox" element={<Inbox />} />
        <Route path="/upcoming" element={<Upcoming />} />
        <Route path="/day" element={<Day />} />
        <Route path="/week" element={<Week />} />
        <Route path="/board" element={<BoardPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/sync" element={<SyncPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
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
