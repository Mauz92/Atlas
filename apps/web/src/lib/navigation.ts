/**
 * The app's navigation, in one place (UX-02, ADR-0051, docs/UX_AUDIT.md §4).
 *
 * `NAV_SECTIONS` is the single source: the sidebar renders it section by section, the icon rail and
 * the mobile bottom nav show the items marked `rail`, and the command palette offers every item as
 * "Go to …". Day is not a destination any more (`/day` redirects to Today, ADR-0051 §2); Search and
 * Settings live in the collapsible "More" section. Sync and Notifications are sections of
 * Settings (UX-08, ADR-0058): their old URLs redirect, and the palette still offers each one
 * (`PALETTE_PAGES`).
 */
import type { IconName } from "../components/Icon";
import { SETTINGS_PALETTE, SETTINGS_REDIRECTS } from "./settingsSections";

/** A rail destination: the group a page belongs to. At most six exist (UX-02 acceptance). */
export type RailId = "today" | "inbox" | "tasks" | "projects" | "notes" | "settings";

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** The rail destination this page belongs to (it lights up while the page is open). */
  group: RailId;
  /** True for the page the rail (and the mobile bottom nav) links to for its group. */
  rail?: boolean;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
  /** Collapsed until the viewer opens it (remembered per browser). */
  startsCollapsed?: boolean;
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: "planning",
    label: "Planning",
    items: [
      { to: "/", label: "Today", icon: "sun", group: "today", rail: true },
      { to: "/inbox", label: "Inbox", icon: "inbox", group: "inbox", rail: true },
      { to: "/upcoming", label: "Upcoming", icon: "calendar-days", group: "today" },
      { to: "/week", label: "Week", icon: "calendar-range", group: "today" },
      { to: "/calendar", label: "Calendar", icon: "calendar", group: "today" },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      { to: "/tasks", label: "Tasks", icon: "square-check", group: "tasks", rail: true },
      { to: "/projects", label: "Projects", icon: "folder-kanban", group: "projects", rail: true },
      { to: "/notes", label: "Notes", icon: "file-text", group: "notes", rail: true },
    ],
  },
  {
    id: "more",
    label: "More",
    startsCollapsed: true,
    items: [
      { to: "/search", label: "Search", icon: "search", group: "settings" },
      { to: "/settings", label: "Settings", icon: "settings", group: "settings", rail: true },
    ],
  },
];

/** The optional TTRPG entry (TTRPG-01); shown only while the feature is on. */
export const TTRPG_NAV_ITEM: NavItem = {
  to: "/ttrpg",
  label: "TTRPG",
  icon: "dices",
  group: "projects",
};

/** The rules reference (static SRD text), listed with the TTRPG entry while the module is on. */
export const TTRPG_RULES_NAV_ITEM: NavItem = {
  to: "/ttrpg/rules",
  label: "Rules",
  icon: "book-open",
  group: "projects",
};

/** The sidebar sections for the caller's enabled optional features. */
export function navSectionsFor(features: { ttrpg: boolean }): NavSection[] {
  if (!features.ttrpg) return NAV_SECTIONS;
  return NAV_SECTIONS.map((section) =>
    section.id === "workspace"
      ? { ...section, items: [...section.items, TTRPG_NAV_ITEM, TTRPG_RULES_NAV_ITEM] }
      : section,
  );
}

/** Every page in sidebar order (what the palette offers as "Go to …"). */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

/** What the palette offers as "Go to …": every page plus every Settings section. */
export const PALETTE_PAGES: { to: string; label: string }[] = [
  ...NAV_ITEMS.map((item) => ({ to: item.to, label: item.label })),
  ...SETTINGS_PALETTE,
];

/** The rail destinations, in order; Settings is drawn at the bottom of the rail. */
export const RAIL_ITEMS: NavItem[] = NAV_ITEMS.filter((item) => item.rail);

/** The sidebar key of an active project's own entry. */
export function projectNavKey(projectId: string): string {
  return `project:${projectId}`;
}

/** Old URLs that are no longer pages of their own, mapped to where they now live. */
export const REDIRECTS: Record<string, string> = { "/day": "/", ...SETTINGS_REDIRECTS };

function normalise(pathname: string): string {
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const target = REDIRECTS[trimmed] ?? trimmed;
  // Every Settings section is the one Settings entry.
  return target.startsWith("/settings/") ? "/settings" : target;
}

/**
 * The one sidebar entry that is current for `pathname`: a page's own path, or a project's entry on
 * its page (`/projects/:id`) when the project is listed, else the Projects page. `null` for a path
 * that is not a known page.
 */
export function activeNavKey(pathname: string, listedProjectIds: readonly string[] = []): string | null {
  const path = normalise(pathname);
  const project = /^\/projects\/([^/]+)$/.exec(path);
  if (project) {
    const id = decodeURIComponent(project[1]);
    return listedProjectIds.includes(id) ? projectNavKey(id) : "/projects";
  }
  return NAV_ITEMS.some((item) => item.to === path) ? path : null;
}

/** The rail destination that is current for `pathname`, or `null` for an unknown path. */
export function activeRail(pathname: string): RailId | null {
  const path = normalise(pathname);
  if (path.startsWith("/projects/")) {
    return "projects";
  }
  return NAV_ITEMS.find((item) => item.to === path)?.group ?? null;
}

/**
 * The sidebar sections (and the nested project list, id `projects`) that must be open for the
 * entry `key` to be visible, so the current page is never hidden inside a collapsed section.
 */
export function sectionsContaining(key: string | null): string[] {
  if (!key) {
    return [];
  }
  if (key.startsWith("project:")) {
    const projects = NAV_SECTIONS.find((section) => section.items.some((item) => item.to === "/projects"));
    return projects ? [projects.id, "projects"] : ["projects"];
  }
  return NAV_SECTIONS.filter((section) => section.items.some((item) => item.to === key)).map(
    (section) => section.id,
  );
}

/* -------------------------------------------------------------------------------------------------
 * Per-browser shell preferences. Storage can be missing or throw (private mode, blocked site data),
 * so every access is wrapped and falls back to the default.
 * ------------------------------------------------------------------------------------------------- */

export const SIDEBAR_STORAGE_KEY = "atlas-sidebar";
export const SECTIONS_STORAGE_KEY = "atlas-sidebar-sections";

/** True when the viewer hid the sidebar on this browser (Ctrl+B). */
export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === "collapsed";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, "collapsed");
    } else {
      localStorage.removeItem(SIDEBAR_STORAGE_KEY);
    }
  } catch {
    // the choice still applies for this page view
  }
}

/** Which sidebar sections (and the nested project list, id `projects`) are collapsed. */
export type CollapsedSections = Record<string, boolean>;

export function defaultCollapsedSections(): CollapsedSections {
  return Object.fromEntries(NAV_SECTIONS.map((section) => [section.id, !!section.startsCollapsed]));
}

export function readCollapsedSections(): CollapsedSections {
  const defaults = defaultCollapsedSections();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(SECTIONS_STORAGE_KEY) ?? "{}");
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [id, value] of Object.entries(stored)) {
        if (typeof value === "boolean") {
          defaults[id] = value;
        }
      }
    }
  } catch {
    // unreadable or malformed: keep the defaults
  }
  return defaults;
}

export function writeCollapsedSections(sections: CollapsedSections): void {
  try {
    localStorage.setItem(SECTIONS_STORAGE_KEY, JSON.stringify(sections));
  } catch {
    // the choice still applies for this page view
  }
}
