import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";

import type { Project } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { noteSessions } from "../hooks/useNoteAutosave";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { ProjectsProvider, activeProjects, useProjects } from "../hooks/useProjects";
import { useTaskEditor } from "../hooks/useTaskEditor";
import {
  NAV_SECTIONS,
  RAIL_ITEMS,
  activeNavKey,
  activeRail,
  projectNavKey,
  readCollapsedSections,
  readSidebarCollapsed,
  sectionsContaining,
  writeCollapsedSections,
  writeSidebarCollapsed,
  type CollapsedSections,
  type NavItem,
  type NavSection,
} from "../lib/navigation";
import { focusEdgeRow, inRowOrPopup } from "../lib/listKeys";
import { isTypingTarget } from "../lib/shortcuts";
import { ChangedElsewhere } from "./ChangedElsewhere";
import { CommandPalette } from "./CommandPalette";
import { Icon } from "./Icon";
import { ShortcutHelp } from "./ShortcutHelp";
import { StatusBar } from "./StatusBar";
import { ThemeToggle } from "./ThemeToggle";

/** Wide screens dock the sidebar; narrower ones show it as a drawer over the page. */
const WIDE = "(min-width: 1024px)";
/**
 * The Notes workspace has its own tree (and a details panel), so the shell's sidebar only docks from
 * 1280px there; below that it is a drawer, like below 1024px elsewhere (UX-05).
 */
const NOTES_WIDE = "(min-width: 1280px)";
/** Phones: no rail, a bottom nav and a header with the menu button instead. */
const NARROW = "(max-width: 720px)";
const SIDEBAR_ID = "app-sidebar";
const MAIN_ID = "main-content";

export function Layout() {
  return (
    <ProjectsProvider>
      <Shell />
    </ProjectsProvider>
  );
}

function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) {
    return [];
  }
  return Array.from(
    root.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, textarea"),
  ).filter((element) => !element.closest("[hidden]"));
}

/**
 * The app shell (UX-02, docs/UX_AUDIT.md §4): an icon rail with the six destinations, a collapsible
 * sectioned sidebar (Ctrl+B), the page, and a status bar. Phones get a header with the menu and
 * search buttons, a bottom nav, and the sidebar as a drawer. Everything is generated from
 * `NAV_SECTIONS` (`lib/navigation.ts`), which the command palette reads too.
 */
function Shell() {
  const { user, logout } = useAuth();
  const { projects } = useProjects();
  const listed = activeProjects(projects);
  const { pathname } = useLocation();
  const wide = useMediaQuery(pathname.startsWith("/notes") ? NOTES_WIDE : WIDE, true);
  const narrow = useMediaQuery(NARROW, false);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sections, setSections] = useState<CollapsedSections>(readCollapsedSections);
  // A task opened from the palette is edited in a panel owned by the shell; after a change the page
  // behind it is remounted so it shows the new data.
  const [pageVersion, setPageVersion] = useState(0);
  const refreshPage = useCallback(async () => setPageVersion((version) => version + 1), []);
  const editor = useTaskEditor({ refresh: refreshPage });

  const sidebar = useRef<HTMLElement>(null);
  const drawerOpener = useRef<HTMLElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  const focusShowButton = useRef(false);
  const showButton = useRef<HTMLButtonElement>(null);

  const drawer = !wide && drawerOpen;
  const sidebarVisible = wide ? !collapsed : drawerOpen;
  const currentKey = activeNavKey(
    pathname,
    listed.map((project) => project.id),
  );
  const currentRail = activeRail(pathname);

  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const showHelp = useCallback(() => setHelpOpen(true), []);

  const closeDrawer = useCallback((restoreFocus: boolean) => {
    // The opener is inert while the drawer is open, so focus returns after the close renders.
    restoreFocusTo.current = restoreFocus ? drawerOpener.current : null;
    drawerOpener.current = null;
    setDrawerOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => {
    if (wide) {
      const next = !collapsed;
      if (next && sidebar.current?.contains(document.activeElement)) {
        // The focused control is about to disappear: hand focus to the rail's "Show sidebar".
        focusShowButton.current = true;
      }
      writeSidebarCollapsed(next);
      setCollapsed(next);
    } else if (drawerOpen) {
      closeDrawer(true);
    } else {
      drawerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDrawerOpen(true);
    }
  }, [wide, collapsed, drawerOpen, closeDrawer]);

  useEffect(() => {
    if (focusShowButton.current && collapsed) {
      focusShowButton.current = false;
      showButton.current?.focus();
    }
  }, [collapsed]);

  // Opening the drawer moves focus into it, closing it returns focus to the opener; navigating
  // from it closes it.
  useEffect(() => {
    if (drawer) {
      focusables(sidebar.current)[0]?.focus();
    } else {
      const opener = restoreFocusTo.current;
      restoreFocusTo.current = null;
      if (opener?.isConnected) {
        opener.focus();
      }
    }
  }, [drawer]);
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // The current page is never hidden inside a collapsed section.
  useEffect(() => {
    const needed = sectionsContaining(currentKey);
    setSections((current) =>
      needed.some((id) => current[id])
        ? { ...current, ...Object.fromEntries(needed.map((id) => [id, false])) }
        : current,
    );
  }, [currentKey]);

  const toggleSection = useCallback((id: string) => {
    setSections((current) => {
      const next = { ...current, [id]: !current[id] };
      writeCollapsedSections(next);
      return next;
    });
  }, []);

  // Ctrl/Cmd+K toggles the palette and Ctrl/Cmd+B the sidebar, from anywhere (text fields too);
  // "?" opens the shortcut help outside a field.
  const toggleSidebarRef = useRef(toggleSidebar);
  toggleSidebarRef.current = toggleSidebar;
  const logoutRef = useRef(logout);
  logoutRef.current = logout;
  // Stable identities for the palette, whose command list is memoised on its props.
  const paletteToggleSidebar = useCallback(() => toggleSidebarRef.current(), []);
  // Text typed in a note but not yet saved is sent before the session ends (UX-05).
  const signOut = useCallback(
    () => void noteSessions.flushAll(false).finally(() => logoutRef.current()),
    [],
  );
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const modifier = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (modifier && key === "b") {
        event.preventDefault();
        toggleSidebarRef.current();
      } else if (
        event.key === "?" &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !isTypingTarget(event.target)
      ) {
        // "?" is typed with Shift on most layouts, so Shift is allowed; a field gets its own "?".
        event.preventDefault();
        setHelpOpen(true);
      } else if (
        (event.key === "j" || event.key === "k") &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.defaultPrevented &&
        !isTypingTarget(event.target) &&
        !inRowOrPopup(document.activeElement)
      ) {
        // List keys (UX-03): from outside a list, j/k land on its first/last row. Inside a row
        // the row handles them (and prevents the default, so this does not run twice).
        const main = document.getElementById(MAIN_ID);
        if (main && focusEdgeRow(main, event.key === "j" ? "first" : "last")) {
          event.preventDefault();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // The drawer is modal: Esc closes it and Tab stays inside (the rest of the page is inert).
  function onSidebarKeyDown(event: ReactKeyboardEvent) {
    if (!drawer) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeDrawer(true);
    } else if (event.key === "Tab") {
      const list = focusables(sidebar.current);
      if (list.length === 0) {
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  const name = user?.display_name || user?.email || "";

  return (
    <div className={`app-shell${sidebarVisible && wide ? " has-sidebar" : ""}${drawer ? " has-drawer" : ""}${wide ? "" : " compact"}`}>
      <a className="skip-link" href={`#${MAIN_ID}`} inert={drawer}>
        Skip to content
      </a>

      <nav className="rail" aria-label="Destinations" inert={drawer}>
        {!sidebarVisible ? (
          <div className="rail-group">
            <button
              ref={showButton}
              type="button"
              className="ghost icon-button rail-button"
              aria-label="Show sidebar"
              title="Show sidebar (Ctrl+B)"
              aria-expanded={false}
              aria-controls={SIDEBAR_ID}
              onClick={toggleSidebar}
            >
              <Icon name="panel-left" size={18} />
            </button>
            <button
              type="button"
              className="ghost icon-button rail-button"
              aria-label="Search"
              title="Search (Ctrl+K)"
              aria-haspopup="dialog"
              onClick={openPalette}
            >
              <Icon name="search" size={18} />
            </button>
          </div>
        ) : null}
        <ul className="rail-group">
          {RAIL_ITEMS.filter((item) => item.group !== "settings").map((item) => (
            <li key={item.to}>
              <RailLink item={item} pathname={pathname} current={currentRail} />
            </li>
          ))}
        </ul>
        <ul className="rail-group rail-bottom">
          {RAIL_ITEMS.filter((item) => item.group === "settings").map((item) => (
            <li key={item.to}>
              <RailLink item={item} pathname={pathname} current={currentRail} />
            </li>
          ))}
        </ul>
      </nav>

      {drawer ? (
        <div className="drawer-scrim" aria-hidden="true" onClick={() => closeDrawer(true)} />
      ) : null}

      <aside
        ref={sidebar}
        id={SIDEBAR_ID}
        className="sidebar"
        aria-label="Sidebar"
        hidden={!sidebarVisible}
        onKeyDown={onSidebarKeyDown}
      >
        <div className="sidebar-header">
          <span className="sidebar-brand">Atlas</span>
          {drawer ? (
            <button
              type="button"
              className="ghost icon-button"
              aria-label="Close menu"
              onClick={() => closeDrawer(true)}
            >
              <Icon name="x" />
            </button>
          ) : (
            <button
              type="button"
              className="ghost icon-button"
              aria-label="Hide sidebar"
              title="Hide sidebar (Ctrl+B)"
              aria-expanded={true}
              aria-controls={SIDEBAR_ID}
              onClick={toggleSidebar}
            >
              <Icon name="panel-left" />
            </button>
          )}
        </div>
        <button
          type="button"
          className="sidebar-search"
          aria-haspopup="dialog"
          onClick={openPalette}
        >
          <Icon name="search" />
          <span>Search</span>
          <kbd aria-hidden="true">Ctrl K</kbd>
        </button>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {NAV_SECTIONS.map((section) => (
            <SidebarSection
              key={section.id}
              section={section}
              collapsed={!!sections[section.id]}
              projectsCollapsed={!!sections.projects}
              onToggle={toggleSection}
              currentKey={currentKey}
              projects={listed}
            />
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="avatar" aria-hidden="true">
            {name.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <span className="sidebar-user" title={user?.email}>
            {name}
          </span>
          <ThemeToggle />
          <button
            type="button"
            className="ghost icon-button"
            aria-label="Sign out"
            title="Sign out"
            onClick={signOut}
          >
            <Icon name="log-out" />
          </button>
        </div>
      </aside>

      <div className="main-column" inert={drawer}>
        {narrow ? (
          <header className="mobile-header">
            <button
              type="button"
              className="ghost icon-button"
              aria-label="Open menu"
              aria-expanded={drawer}
              aria-controls={SIDEBAR_ID}
              onClick={toggleSidebar}
            >
              <Icon name="menu" size={20} />
            </button>
            <span className="mobile-title">Atlas</span>
            <button
              type="button"
              className="ghost icon-button"
              aria-label="Search"
              aria-haspopup="dialog"
              onClick={openPalette}
            >
              <Icon name="search" size={20} />
            </button>
          </header>
        ) : null}
        <main id={MAIN_ID} className="content" tabIndex={-1}>
          <ChangedElsewhere />
          <Outlet key={pageVersion} />
        </main>
        {paletteOpen ? (
          <CommandPalette
            onClose={closePalette}
            onOpenTask={editor.open}
            onShowShortcuts={showHelp}
            onToggleSidebar={paletteToggleSidebar}
            onSignOut={signOut}
          />
        ) : null}
        {helpOpen ? <ShortcutHelp onClose={closeHelp} /> : null}
        {editor.overlays}
      </div>

      <div className="shell-bottom" inert={drawer}>
        <StatusBar onShowShortcuts={showHelp} />
        {narrow ? (
          <nav className="bottom-nav" aria-label="Bottom navigation">
            <ul>
              {RAIL_ITEMS.filter((item) => item.group !== "settings").map((item) => (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    className={currentRail === item.group ? "active" : undefined}
                    aria-current={railCurrent(item, pathname, currentRail)}
                  >
                    <Icon name={item.icon} size={20} />
                    <span>{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </div>
    </div>
  );
}

/** `page` on the item for the page shown, `true` on the rail entry of its group, else nothing. */
function railCurrent(item: NavItem, pathname: string, current: string | null): "page" | "true" | undefined {
  if (current !== item.group) {
    return undefined;
  }
  return activeNavKey(pathname) === item.to ? "page" : "true";
}

function RailLink({ item, pathname, current }: { item: NavItem; pathname: string; current: string | null }) {
  return (
    <Link
      to={item.to}
      className={`rail-link${current === item.group ? " active" : ""}`}
      aria-label={item.label}
      title={item.label}
      aria-current={railCurrent(item, pathname, current)}
    >
      <Icon name={item.icon} size={20} />
    </Link>
  );
}

function SidebarSection({
  section,
  collapsed,
  projectsCollapsed,
  onToggle,
  currentKey,
  projects,
}: {
  section: NavSection;
  collapsed: boolean;
  projectsCollapsed: boolean;
  onToggle: (id: string) => void;
  currentKey: string | null;
  projects: Project[];
}) {
  const listId = `nav-section-${section.id}`;
  return (
    <div className="sidebar-section">
      <button
        type="button"
        className="sidebar-section-header"
        aria-expanded={!collapsed}
        aria-controls={listId}
        onClick={() => onToggle(section.id)}
      >
        <Icon name="chevron-right" size={12} className="chevron" />
        <span>{section.label}</span>
      </button>
      <ul id={listId} hidden={collapsed}>
        {section.items.map((item) => (
          <li key={item.to}>
            <div className="nav-row">
              <NavEntry to={item.to} label={item.label} icon={item.icon} current={currentKey === item.to} />
              {item.to === "/projects" && projects.length > 0 ? (
                <button
                  type="button"
                  className="ghost icon-button nav-row-toggle"
                  aria-label={projectsCollapsed ? "Show active projects" : "Hide active projects"}
                  aria-expanded={!projectsCollapsed}
                  aria-controls="nav-projects"
                  onClick={() => onToggle("projects")}
                >
                  <Icon name={projectsCollapsed ? "chevron-right" : "chevron-down"} size={14} />
                </button>
              ) : null}
            </div>
            {item.to === "/projects" && projects.length > 0 ? (
              <ul
                id="nav-projects"
                className="sidebar-projects"
                aria-label="Active projects"
                hidden={projectsCollapsed}
              >
                {projects.map((project) => (
                  <li key={project.id}>
                    <NavEntry
                      to={`/projects/${project.id}`}
                      label={project.name}
                      current={currentKey === projectNavKey(project.id)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NavEntry({
  to,
  label,
  icon,
  current,
}: {
  to: string;
  label: string;
  icon?: NavItem["icon"];
  current: boolean;
}) {
  return (
    <Link to={to} className={`nav-link${current ? " active" : ""}`} aria-current={current ? "page" : undefined}>
      {icon ? <Icon name={icon} /> : <span className="nav-dot" aria-hidden="true" />}
      <span className="nav-label">{label}</span>
    </Link>
  );
}
