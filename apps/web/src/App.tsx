import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { HomeTimeZoneDefault } from "./components/HomeTimeZoneDefault";
import { useAuth } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { ShellHalt } from "./components/ShellHalt";
import { useShellSync } from "./hooks/useShellSync";
import { SETTINGS_REDIRECTS } from "./lib/settingsSections";
import { CalendarPage } from "./pages/Calendar";
import { Changes } from "./pages/Changes";
import { Inbox } from "./pages/Inbox";
import { Login } from "./pages/Login";
import { ProjectPage } from "./pages/ProjectPage";
import { Projects } from "./pages/Projects";
import { RecoveryCodeSetup } from "./pages/RecoveryCodeSetup";
import { SearchPage } from "./pages/Search";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";
import { Ttrpg } from "./pages/Ttrpg";
import { Tasks } from "./pages/Tasks";
import { Today } from "./pages/Today";
import { Upcoming } from "./pages/Upcoming";
import { Week } from "./pages/Week";

// The editor (CodeMirror) and Markdown renderer are only needed on the notes route.
const Notes = lazy(() => import("./pages/Notes").then((module) => ({ default: module.Notes })));

export default function App() {
  const { state, pendingRecoveryCode } = useAuth();
  // In the desktop shell the engine can stop and wait for a person (restore, update, sign-in): that screen replaces the app.
  const shell = useShellSync();
  if (shell?.sync?.halt) {
    return <ShellHalt snapshot={shell} />;
  }

  if (state === "loading") {
    return <div className="splash">Loading Atlas…</div>;
  }
  if (state === "setup") {
    return <Setup />;
  }
  if (state === "anonymous") {
    return <Login />;
  }

  if (pendingRecoveryCode) {
    return <RecoveryCodeSetup code={pendingRecoveryCode} />;
  }

  return (
    <>
      <HomeTimeZoneDefault />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Today />} />
          <Route path="/inbox" element={<Inbox />} />
          <Route path="/upcoming" element={<Upcoming />} />
          {/* Day is no longer a destination (ADR-0051 §2): old links land on Today. */}
          <Route path="/day" element={<Navigate to="/" replace />} />
          <Route path="/week" element={<Week />} />
          <Route path="/calendar" element={<CalendarPage />} />
          {/* The standalone Board is gone (ADR-0064): the board lives in each project. Old links land on Projects. */}
          <Route path="/board" element={<Navigate to="/projects" replace />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          {/* Sync and Notifications are Settings sections now (UX-08): old links land there. The Calendar *page* is M5-07. */}
          {Object.entries(SETTINGS_REDIRECTS).map(([from, to]) => (
            <Route key={from} path={from} element={<Navigate to={to} replace />} />
          ))}
          <Route path="/changes" element={<Changes />} />
          <Route path="/search" element={<SearchPage />} />
          <Route
            path="/notes"
            element={
              <Suspense fallback={<div className="splash">Loading notes…</div>}>
                <Notes />
              </Suspense>
            }
          />
          <Route path="/ttrpg/*" element={<Ttrpg />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/:section" element={<Settings />} />
        </Route>
      </Routes>
    </>
  );
}
