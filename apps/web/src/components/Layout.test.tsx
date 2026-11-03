import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import { SIDEBAR_STORAGE_KEY } from "../lib/navigation";
import { Layout } from "./Layout";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({ user: { display_name: "Owner", email: "o@example.com" }, logout: vi.fn() }),
}));
vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    projectsApi: {
      list: vi.fn().mockResolvedValue({
        projects: [
          { id: "p-garden", name: "Garden", status: "active" },
          { id: "p-old", name: "Old shed", status: "archived" },
        ],
      }),
    },
    searchApi: { search: vi.fn() },
  };
});
// The status bar has its own test; here it only needs quiet, synced hooks.
vi.mock("../hooks/useOfflineQueue", () => ({
  useOfflineQueue: () => ({
    counts: { total: 0, pending: 0, conflicts: 0, failed: 0 },
    operations: [],
    state: "ready",
    error: null,
    actionError: null,
    busy: false,
    refresh: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
  }),
}));
vi.mock("../hooks/useSyncStatus", () => ({
  useSyncStatus: () => ({
    providers: [],
    state: "ready",
    error: null,
    actionError: null,
    busyProvider: null,
    reload: vi.fn(),
    syncNow: vi.fn(),
  }),
}));

async function renderAt(path = "/") {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Layout />
    </MemoryRouter>,
  );
  // Let the projects list resolve so the sidebar settles.
  await act(async () => {});
  return view;
}

const sidebarNav = () => screen.getByRole("navigation", { name: "Main navigation" });
const rail = () => screen.getByRole("navigation", { name: "Destinations" });

beforeEach(() => localStorage.clear());

describe("Layout shortcut", () => {
  it.each([
    ["ctrlKey", { ctrlKey: true }],
    ["metaKey", { metaKey: true }],
  ])("%s + K toggles the command palette from anywhere", async (_name, modifier) => {
    await renderAt();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "k", ...modifier });
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "K", ...modifier });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });

  it("the sidebar's Search button opens it and Esc closes it", async () => {
    await renderAt();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  });
});

describe("Shortcut help", () => {
  it("opens with ? outside a text field and closes with Esc", async () => {
    await renderAt();
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const help = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(within(help).getByText("Ctrl/⌘ B")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("does not open while typing in a field", async () => {
    await renderAt();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
  });

  it("opens from the command palette and from the status bar", async () => {
    await renderAt();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(screen.getByRole("option", { name: /Keyboard shortcuts/ }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });
});

describe("Shell navigation", () => {
  it("has landmarks, a skip link and at most six rail destinations", async () => {
    await renderAt();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("contentinfo", { name: "Status bar" })).toBeInTheDocument();
    const destinations = within(rail()).getAllByRole("link").map((link) => link.getAttribute("aria-label"));
    expect(destinations).toEqual(["Today", "Inbox", "Tasks", "Projects", "Notes", "Settings"]);
    // No Day destination any more, and no topbar.
    expect(screen.queryByRole("link", { name: "Day" })).toBeNull();
    expect(document.querySelector(".topbar")).toBeNull();
  });

  it.each([
    ["/", "Today", "Today"],
    ["/inbox", "Inbox", "Inbox"],
    ["/upcoming", "Upcoming", "Today"],
    ["/week", "Week", "Today"],
    ["/day", "Today", "Today"],
    ["/tasks", "Tasks", "Tasks"],
    ["/projects", "Projects", "Projects"],
    ["/projects/p-garden", "Garden", "Projects"],
    ["/projects/p-old", "Projects", "Projects"],
    ["/notes", "Notes", "Notes"],
    ["/search", "Search", "Settings"],
    ["/settings", "Settings", "Settings"],
    ["/settings/sync", "Settings", "Settings"],
    ["/calendar", "Settings", "Settings"],
  ])("at %s exactly one sidebar item (%s) and one rail item (%s) are active", async (path, item, dest) => {
    await renderAt(path);
    const current = sidebarNav().querySelectorAll("[aria-current]");
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAttribute("aria-current", "page");
    expect(current[0]).toHaveTextContent(item);
    // The More section opens by itself when it holds the current page.
    expect(current[0]).toBeVisible();
    const railCurrent = rail().querySelectorAll("[aria-current]");
    expect(railCurrent).toHaveLength(1);
    expect(railCurrent[0]).toHaveAttribute("aria-label", dest);
  });

  it("lists active projects (not archived ones) and the list collapses", async () => {
    await renderAt("/inbox");
    const list = screen.getByRole("list", { name: "Active projects" });
    expect(within(list).getByRole("link", { name: "Garden" })).toHaveAttribute("href", "/projects/p-garden");
    expect(within(list).queryByRole("link", { name: "Old shed" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Hide active projects" }));
    expect(screen.queryByRole("list", { name: "Active projects" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show active projects" }));
    expect(screen.getByRole("list", { name: "Active projects" })).toBeVisible();
  });

  it("a section collapses and the choice is remembered", async () => {
    const view = await renderAt("/inbox");
    const header = screen.getByRole("button", { name: "Workspace" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(within(sidebarNav()).queryByRole("link", { name: "Tasks" })).toBeNull();
    view.unmount();
    await renderAt("/inbox");
    expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-expanded", "false");
  });

  it("More starts collapsed", async () => {
    await renderAt("/inbox");
    expect(screen.getByRole("button", { name: "More" })).toHaveAttribute("aria-expanded", "false");
    expect(within(sidebarNav()).queryByRole("link", { name: "Settings" })).toBeNull();
  });
});

describe("Sidebar collapse", () => {
  it("Ctrl+B hides and shows the sidebar and the choice survives a reload", async () => {
    const view = await renderAt("/inbox");
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
    fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("collapsed");
    // Collapsed, the rail offers Show sidebar and Search instead.
    expect(within(rail()).getByRole("button", { name: "Show sidebar" })).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(within(rail()).getByRole("button", { name: "Search" }));
    expect(screen.getByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });

    view.unmount();
    await renderAt("/inbox");
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
    fireEvent.keyDown(document.body, { key: "B", metaKey: true });
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it("hiding from the sidebar's own button moves focus to Show sidebar", async () => {
    await renderAt("/inbox");
    const hide = screen.getByRole("button", { name: "Hide sidebar" });
    hide.focus();
    fireEvent.click(hide);
    expect(screen.getByRole("button", { name: "Show sidebar" })).toHaveFocus();
  });

  it("still works when storage throws", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      await renderAt("/inbox");
      fireEvent.keyDown(document.body, { key: "b", ctrlKey: true });
      expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
    } finally {
      spy.mockRestore();
      set.mockRestore();
    }
  });

  it("the palette offers Toggle sidebar and Sign out", async () => {
    await renderAt("/inbox");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("option", { name: /Sign out/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /Toggle sidebar/ }));
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
  });
});

describe("Phone layout", () => {
  const original = window.matchMedia;
  beforeEach(() => {
    // A 375px phone: the wide query fails, the narrow one matches.
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width: 720px"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = original;
  });

  it("shows a bottom nav and opens the sidebar as a modal drawer", async () => {
    await renderAt("/inbox");
    const bottom = screen.getByRole("navigation", { name: "Bottom navigation" });
    expect(within(bottom).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Today",
      "Inbox",
      "Tasks",
      "Projects",
      "Notes",
    ]);
    expect(within(bottom).getByRole("link", { name: "Inbox" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();

    const menu = screen.getByRole("button", { name: "Open menu" });
    menu.focus();
    fireEvent.click(menu);
    expect(screen.getByRole("complementary", { name: "Sidebar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveFocus();
    expect(document.querySelector(".main-column")).toHaveAttribute("inert");
    // Esc closes it, focus returns to the menu button, and the desktop choice is untouched.
    fireEvent.keyDown(screen.getByRole("button", { name: "Close menu" }), { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
    expect(menu).toHaveFocus();
    expect(document.querySelector(".main-column")).not.toHaveAttribute("inert");
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it("closes the drawer when a page is chosen", async () => {
    await renderAt("/inbox");
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(within(sidebarNav()).getByRole("link", { name: "Notes" }));
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
  });
});
