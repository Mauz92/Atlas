import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { useAuth } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { SETTINGS_REDIRECTS } from "./lib/settingsSections";
import { BoardPage } from "./pages/Board";
import { Inbox } from "./pages/Inbox";
import { Login } from "./pages/Login";
import { ProjectPage } from "./pages/ProjectPage";
import { Projects } from "./pages/Projects";
import { SearchPage } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { Tasks } from "./pages/Tasks";
import { Today } from "./pages/Today";
import { Upcoming } from "./pages/Upcoming";
import { Week } from "./pages/Week";

// The editor (CodeMirror) and Markdown renderer are only needed on the notes route.
const Notes = lazy(() => import("./pages/Notes").then((module) => ({ default: module.Notes })));

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
        {/* Day is no longer a destination (ADR-0051 §2): old links land on Today. */}
        <Route path="/day" element={<Navigate to="/" replace />} />
        <Route path="/week" element={<Week />} />
        <Route path="/board" element={<BoardPage />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectPage />} />
        {/* Calendar, Sync and Notifications are Settings sections now (UX-08): old links land there. */}
        {Object.entries(SETTINGS_REDIRECTS).map(([from, to]) => (
          <Route key={from} path={from} element={<Navigate to={to} replace />} />
        ))}
        <Route path="/search" element={<SearchPage />} />
        <Route
          path="/notes"
          element={
            <Suspense fallback={<div className="splash">Loading notes…</div>}>
              <Notes />
            </Suspense>
          }
        />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:section" element={<Settings />} />
      </Route>
    </Routes>
  );
}
