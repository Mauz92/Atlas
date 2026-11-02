import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

import { ProjectsProvider, activeProjects, useProjects } from "../hooks/useProjects";

import { useAuth } from "../auth/AuthProvider";
import { useTaskEditor } from "../hooks/useTaskEditor";
import { NAV_ITEMS } from "../lib/navigation";
import { CommandPalette } from "./CommandPalette";
import { ThemeToggle } from "./ThemeToggle";

function SidebarProjects() {
  const { projects } = useProjects();
  const active = activeProjects(projects);
  if (active.length === 0) {
    return null;
  }
  return (
    <ul className="sidebar-projects" aria-label="Active projects">
      {active.map((project) => (
        <li key={project.id}>
          <NavLink to={`/projects/${project.id}`}>{project.name}</NavLink>
        </li>
      ))}
    </ul>
  );
}

export function Layout() {
  return (
    <ProjectsProvider>
      <Shell />
    </ProjectsProvider>
  );
}

function Shell() {
  const { user, logout } = useAuth();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // A task opened from the palette is edited in a panel owned by the shell; after a change the page
  // behind it is remounted so it shows the new data.
  const [pageVersion, setPageVersion] = useState(0);
  const refreshPage = useCallback(async () => setPageVersion((version) => version + 1), []);
  const editor = useTaskEditor({ refresh: refreshPage });
  const closePalette = useCallback(() => setPaletteOpen(false), []);

  // Ctrl/Cmd+K toggles the command palette from anywhere, including text fields.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
                {item.to === "/projects" ? <SidebarProjects /> : null}
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">{user?.display_name ?? user?.email}</span>
          <div className="topbar-actions">
            <button
              type="button"
              className="ghost"
              aria-haspopup="dialog"
              onClick={() => setPaletteOpen(true)}
            >
              Search · Ctrl K
            </button>
            <ThemeToggle />
            <button type="button" className="ghost" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        <main className="content">
          <Outlet key={pageVersion} />
        </main>
        {paletteOpen ? (
          <CommandPalette onClose={closePalette} onOpenTask={editor.open} />
        ) : null}
        {editor.overlays}
      </div>
    </div>
  );
}
