import AxeBuilder from "@axe-core/playwright";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner, searchButton } from "./helpers";

/**
 * UX-11 — the remaining phone pages (ADR-0064): Tasks select mode and the Filters sheet, the
 * project board column tabs (the standalone Board is gone), the Notes toolbar, Projects cards, the palette sheet, the status bar link,
 * and Settings / Login / Setup under the touch rules. Measured in a real browser against the
 * real API. Not covered here (needs a real device, see TESTING.md): the on-screen keyboard,
 * the notch, real taps and swipes, screen readers.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB" });

const SIZES = [
  { name: "360", width: 360, height: 740, touch: true },
  { name: "390", width: 390, height: 844, touch: true },
  { name: "768", width: 768, height: 1024, touch: true },
  { name: "1440", width: 1440, height: 900, touch: false },
] as const;
type Size = (typeof SIZES)[number];
const LONG = "UX11 review and finalise the quarterly budget spreadsheet together with the accountant before Friday";

let seeded: { projectId: string; noteId: string } | null = null;

async function seed(page: Page) {
  await ensureOwner(page);
  if (seeded) return seeded;
  const known = await apiCall<{ notes: { id: string; path: string }[] }>(page, "GET", "/api/notes");
  const existing = known.notes.find((note) => note.path === "ux11/Folder/Outline.md");
  const projects = await apiCall<{ projects: { id: string; name: string }[] }>(page, "GET", "/api/projects");
  const had = projects.projects.find((project) => project.name === "UX11 Website relaunch");
  if (existing && had) {
    seeded = { projectId: had.id, noteId: existing.id };
    return seeded;
  }
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", {
    name: "UX11 Website relaunch",
    target_date: dateIn(ZONE, 30),
  });
  await apiCall(page, "POST", "/api/projects", { name: "UX11 Kitchen renovation" });
  const when = (days: number, time: string) => ({ due_at: `${dateIn(ZONE, days)}T${time}`, time_zone: ZONE });
  await apiCall(page, "POST", "/api/tasks", { title: LONG, status: "next", priority: "urgent", project_id: project.id, tags: ["finance", "quarterly"], ...when(-2, "09:00:00") });
  await apiCall(page, "POST", "/api/tasks", { title: "UX11 call the plumber", status: "next", priority: "high", project_id: project.id, ...when(1, "10:30:00") });
  await apiCall(page, "POST", "/api/tasks", { title: "UX11 medium task", status: "next", priority: "medium", ...when(2, "23:59:00") });
  await apiCall(page, "POST", "/api/tasks", { title: "UX11 low task", status: "next", priority: "low" });
  // Inbox-status tasks of the project: the project board's first column.
  for (const title of ["UX11 inbox one", "UX11 inbox two", "UX11 inbox three"]) {
    await apiCall(page, "POST", "/api/tasks", { title, project_id: project.id });
  }
  const note = await apiCall<{ id: string }>(page, "POST", "/api/notes", {
    path: "ux11/Folder/Outline.md",
    content: "# UX11 outline\n\nSome text with a [link](https://example.com).\n\n- [ ] UX11 checkbox item\n",
  });
  seeded = { projectId: project.id, noteId: note.id };
  return seeded;
}

async function newPage(browser: Browser, state: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined, size: Size, theme: "light" | "dark") {
  const context = await browser.newContext({
    storageState: state,
    baseURL: process.env.ATLAS_E2E_BASE_URL,
    viewport: { width: size.width, height: size.height },
    hasTouch: size.touch,
    isMobile: size.touch && size.width < 700,
    colorScheme: theme,
    timezoneId: ZONE,
    locale: "en-GB",
  });
  const page = await context.newPage();
  await page.addInitScript((value) => localStorage.setItem("atlas-theme", value), theme);
  return { page, context };
}

async function settle(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0);
  await expect(page.locator("h1")).toHaveCount(1);
}

async function axe(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  return result.violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

/**
 * What a phone user cannot reach or would mis-tap on the current page: document and inner sideways
 * scroll, and every visible control under 44 px (a checkbox or radio inside a label counts as its
 * label; inline text links, the skip link and visually hidden boxes are not counted).
 */
async function measure(page: Page) {
  return page.evaluate(() => {
    const doc = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const hidden = (el: Element) => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width === 0 || r.height === 0 || style.visibility === "hidden" || (r.width <= 1 && r.height <= 1) || el.closest(".sr-only") !== null;
    };
    const inner = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => {
        if (hidden(el)) return false;
        const overflowX = getComputedStyle(el).overflowX;
        return (overflowX === "auto" || overflowX === "scroll") && el.scrollWidth - el.clientWidth > 1;
      })
      .map((el) => `${el.tagName}.${String(el.className).slice(0, 40)} ${el.scrollWidth}>${el.clientWidth}`);
    const small = [...document.querySelectorAll<HTMLElement>("button, a[href], input, select, textarea, [role=menuitem], [role=menuitemradio], [role=tab], [role=option]")]
      .filter((el) => !hidden(el) && !el.classList.contains("skip-link") && !(el instanceof HTMLInputElement && el.type === "hidden"))
      // A checkbox or link inside a note's own text (editor, preview) is content, like an inline link.
      .filter((el) => !el.closest(".cm-content, .markdown-preview"))
      // A list row opens from its whole body (the title button is its keyboard path, ADR-0062).
      .filter((el) => !el.matches(".task-body .task-open"))
      .filter((el) => !(el.tagName === "A" && el.closest("p, .muted, .section-note, .task-meta") && !el.closest("nav, .bottom-nav")))
      .map((el) => {
        const wrapped = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.closest("label") : null;
        const r = (wrapped ?? el).getBoundingClientRect();
        return { el, r };
      })
      .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
      .map(({ el, r }) => `${el.tagName}.${String(el.className).slice(0, 24)}[${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24)}] ${Math.round(r.width)}x${Math.round(r.height)}`);
    return { doc, inner, small: [...new Set(small)] };
  });
}

const PAGES = (ids: { projectId: string; noteId: string }) => [
  "/tasks",
  `/projects/${ids.projectId}`,
  `/projects/${ids.projectId}?tab=board`,
  "/projects",
  "/notes",
  `/notes?open=${ids.noteId}`,
  "/settings",
  "/settings/appearance",
  "/settings/sync",
  "/settings/calendar",
  "/settings/notifications",
  "/settings/data",
  "/settings/about",
];

test("no sideways scroll, 44 px targets and axe on the touched pages at four sizes in both themes", async ({ page, browser }) => {
  test.setTimeout(900_000);
  const ids = await seed(page);
  const state = await page.context().storageState();
  const problems: Record<string, unknown> = {};

  for (const theme of ["light", "dark"] as const) {
    for (const size of SIZES) {
      const { page: p, context } = await newPage(browser, state, size, theme);
      for (const path of PAGES(ids)) {
        const label = `${path} ${size.name} ${theme}`;
        await settle(p, path);
        if (path.startsWith("/notes?open=")) await expect(p.getByRole("navigation", { name: "Breadcrumb" })).toBeVisible();
        const result = await measure(p);
        if (result.doc > 0) problems[`${label}: document scroll`] = result.doc;
        if (size.touch) {
          // Inner scroll is judged on phones; a tablet's project board keeps its columns scrolling (ADR-0064).
          if (size.width < 700 && result.inner.length > 0) problems[`${label}: inner scroll`] = result.inner;
          // Targets are judged on phones: a tablet-width window without a coarse pointer keeps its desktop sizes.
          if (size.width < 700 && result.small.length > 0) problems[`${label}: small targets`] = result.small;
        }
        const violations = await axe(p);
        if (violations.length > 0) problems[`${label}: axe`] = violations;
      }

      // Overlays on the Tasks page: the Filters sheet and its Due dialog (touch), the palette.
      await settle(p, "/tasks");
      if (size.touch) {
        await p.getByRole("button", { name: /^Filters/ }).click();
        const menu = p.getByRole("menu", { name: "Filters" });
        await expect(menu).toBeVisible();
        const sheet = await measure(p);
        if (size.width < 700 && sheet.small.length > 0) problems[`filters sheet ${size.name} ${theme}: small targets`] = sheet.small;
        const found = await axe(p);
        if (found.length > 0) problems[`filters sheet ${size.name} ${theme}: axe`] = found;
        await p.keyboard.press("Escape");
      }
      await settle(p, "/");
      await searchButton(p).first().click();
      const palette = p.getByRole("dialog", { name: "Command palette" });
      await expect(palette).toBeVisible();
      await palette.getByRole("combobox").fill("UX11");
      await expect(palette.getByRole("option").first()).toBeVisible();
      if (size.touch) {
        const box = (await palette.boundingBox())!;
        if (Math.round(box.height) !== size.height || Math.round(box.width) !== size.width) problems[`palette ${size.name} ${theme}: not full screen`] = box;
        const open = await measure(p);
        if (open.doc > 0) problems[`palette ${size.name} ${theme}: document scroll`] = open.doc;
        if (size.width < 700 && open.small.length > 0) problems[`palette ${size.name} ${theme}: small targets`] = open.small;
        if ((await palette.getByText(/to move/).count()) > 0) problems[`palette ${size.name} ${theme}: key hints on touch`] = true;
      }
      const paletteAxe = await axe(p);
      if (paletteAxe.length > 0) problems[`palette ${size.name} ${theme}: axe`] = paletteAxe;
      await context.close();
    }
  }
  expect(problems).toEqual({});
});

test("Login and Setup follow the touch rules and stay clean at four sizes in both themes", async ({ page, browser }) => {
  test.setTimeout(240_000);
  await seed(page);
  const problems: Record<string, unknown> = {};
  for (const theme of ["light", "dark"] as const) {
    for (const size of SIZES) {
      for (const [name, heading] of [
        ["login", "Sign in to Atlas"],
        ["setup", "Create your Atlas account"],
      ] as const) {
        const { page: p, context } = await newPage(browser, undefined, size, theme);
        if (name === "setup") await p.route(/\/api\/setup\/status$/, (route) => route.fulfill({ json: { setup_required: true } }));
        await p.goto("/");
        await expect(p.getByRole("heading", { name: heading })).toBeVisible();
        const label = `${name} ${size.name} ${theme}`;
        const result = await measure(p);
        if (result.doc > 0) problems[`${label}: document scroll`] = result.doc;
        if (size.touch && result.small.length > 0) problems[`${label}: small targets`] = result.small;
        if (size.touch) {
          const fonts = await p.evaluate(() => [...document.querySelectorAll<HTMLElement>("input:not([type=checkbox])")].map((el) => getComputedStyle(el).fontSize).filter((fs) => parseFloat(fs) < 16));
          if (fonts.length > 0) problems[`${label}: fields under 16px`] = fonts;
        }
        const violations = await axe(p);
        if (violations.length > 0) problems[`${label}: axe`] = violations;
        await context.close();
      }
    }
  }
  expect(problems).toEqual({});
});

test("Tasks on a phone: select boxes only in Select mode; complete, move and delete with undo still work", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const ids = await seed(page);
  const title = (n: number) => `UX11 bulk ${n}`;
  for (const n of [1, 2, 3, 4]) await apiCall(page, "POST", "/api/tasks", { title: title(n), status: "next" });
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[1], "light");
  await settle(p, "/tasks");

  // Normal state: a row has the round completion box and no select box; no "Select all".
  await expect(p.getByLabel(`Complete ${title(1)}`)).toBeVisible();
  await expect(p.getByLabel(`Select ${title(1)}`)).toHaveCount(0);
  await expect(p.getByLabel("Select all")).toHaveCount(0);

  // Enter Select mode from the filter "…" menu: boxes replace the completion boxes.
  await p.getByRole("button", { name: "Filter options" }).click();
  await p.getByRole("menuitem", { name: "Select tasks" }).click();
  await expect(p.getByLabel(`Select ${title(1)}`)).toBeVisible();
  await expect(p.getByLabel(`Complete ${title(1)}`)).toHaveCount(0);
  const selectBox = (await p.getByLabel(`Select ${title(1)}`).boundingBox())!;
  expect(selectBox.width).toBeGreaterThanOrEqual(44);
  expect(selectBox.height).toBeGreaterThanOrEqual(44);
  const all = (await p.getByLabel("Select all").boundingBox())!;
  expect(all.width).toBeGreaterThanOrEqual(44);
  expect(all.height).toBeGreaterThanOrEqual(44);
  expect((await p.locator(".task-count label").boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const small = await measure(p);
  expect(small.small).toEqual([]);

  // Move two to a project, complete one, delete one and undo it.
  await p.getByLabel(`Select ${title(1)}`).check();
  await p.getByLabel(`Select ${title(2)}`).check();
  const bar = p.getByRole("toolbar", { name: "Bulk actions" });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: /Move to project/ }).click();
  await p.getByRole("menuitem", { name: "UX11 Kitchen renovation" }).click();
  await expect.poll(async () => (await apiCall<{ tasks: { project_id: string | null }[] }>(p, "GET", `/api/tasks?q=${encodeURIComponent(title(1))}`)).tasks[0]?.project_id).not.toBeNull();
  await expect(p.getByLabel(`Select ${title(1)}`)).not.toBeChecked();

  await p.getByLabel(`Select ${title(3)}`).check();
  await p.getByRole("button", { name: "Complete selected" }).click();
  await expect.poll(async () => (await apiCall<{ tasks: { status: string }[] }>(p, "GET", `/api/tasks?q=${encodeURIComponent(title(3))}&status=completed`)).tasks.length).toBe(1);

  await p.getByLabel(`Select ${title(4)}`).check();
  await p.getByRole("button", { name: "Delete selected" }).click();
  await expect(p.getByText("Deleted 1 task.")).toBeVisible();
  await p.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(p.getByRole("button", { name: `Open ${title(4)}` })).toBeVisible();

  // Done leaves the mode: boxes gone, completion boxes back.
  await p.getByRole("button", { name: "Done selecting" }).click();
  await expect(p.getByLabel(`Select ${title(4)}`)).toHaveCount(0);
  await expect(p.getByLabel(`Complete ${title(4)}`)).toBeVisible();

  // The Filters sheet: Priority > High filters the list and tints the button with a count.
  await p.getByRole("button", { name: "Filters" }).click();
  await p.getByRole("menuitem", { name: "Priority" }).click();
  await p.getByRole("menuitemradio", { name: "High", exact: true }).click();
  await expect(p.getByRole("button", { name: "Filters, 1 active" })).toBeVisible();
  await expect(p.getByRole("button", { name: "Open UX11 call the plumber" })).toBeVisible();
  await expect(p.getByRole("button", { name: `Open ${title(4)}` })).toHaveCount(0);
  await p.getByRole("button", { name: /^Filters/ }).click();
  await p.getByRole("menuitem", { name: "Reset filters" }).click();
  await expect(p.getByRole("button", { name: "Filters", exact: true })).toBeVisible();

  // Medium and low show their word on a phone (a bare flag was ambiguous).
  await settle(p, "/tasks");
  await expect(p.locator(".task-row", { hasText: "UX11 medium task" }).locator(".priority-word")).toBeVisible();
  await expect(p.locator(".task-row", { hasText: "UX11 low task" }).locator(".priority-word")).toBeVisible();
  void ids;
  await context.close();
});

test("project Board on a phone: one column at a time with a tab strip; arrows and [ ] work; help is behind a ? button", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const ids = await seed(page);
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[1], "light");
  await settle(p, `/projects/${ids.projectId}?tab=board`);

  const strip = p.getByRole("tablist", { name: "Board columns" });
  await expect(strip.getByRole("tab")).toHaveCount(4);
  await expect(strip.getByRole("tab", { name: /^Inbox\b.*\d+ tasks?$/ })).toHaveAttribute("aria-selected", "true");
  // One full-width column, not five side-scrolling ones.
  await expect(p.locator(".board-column")).toHaveCount(1);
  const column = (await p.locator(".board-column").boundingBox())!;
  expect(column.width).toBeGreaterThan(390 - 40);
  expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  expect((await measure(p)).inner).toEqual([]);

  // The help is a "?" button on touch, and says nothing about keys.
  await expect(p.getByText(/press \] and \[/)).toHaveCount(0);
  const help = p.getByRole("button", { name: "About the board" });
  await expect(help).toHaveAttribute("aria-expanded", "false");
  await help.click();
  await expect(p.getByText(/Pick a column above/)).toBeVisible();
  await help.click();
  await expect(p.getByText(/Pick a column above/)).toHaveCount(0);

  // Arrow keys move between the tabs and show that column; Archived is a fifth tab behind the toggle.
  await strip.getByRole("tab", { name: /^Inbox/ }).focus();
  await p.keyboard.press("ArrowRight");
  await expect(strip.getByRole("tab", { name: /^Next/ })).toHaveAttribute("aria-selected", "true");
  await expect(p.locator(".board-column[role=tabpanel]")).toBeVisible();
  await p.getByRole("button", { name: /^Show archived/ }).click();
  await expect(strip.getByRole("tab")).toHaveCount(5);
  await strip.getByRole("tab", { name: /^Next/ }).focus();
  await p.keyboard.press("End");
  await expect(strip.getByRole("tab", { name: /^Archived/ })).toHaveAttribute("aria-selected", "true");
  await p.keyboard.press("Home");
  await expect(strip.getByRole("tab", { name: /^Inbox/ })).toHaveAttribute("aria-selected", "true");
  await p.getByRole("button", { name: /^Hide archived/ }).click();
  await expect(strip.getByRole("tab")).toHaveCount(4);

  // "]" moves the focused card to the next column, the tab follows it and the move is announced.
  await p.getByRole("button", { name: "Open UX11 inbox one" }).focus();
  await p.keyboard.press("]");
  await expect(strip.getByRole("tab", { name: /^Next/ })).toHaveAttribute("aria-selected", "true");
  await expect(p.getByText("Moved UX11 inbox one to Next")).toBeAttached();
  await expect(p.getByRole("button", { name: "Open UX11 inbox one" })).toBeFocused();
  await p.keyboard.press("[");
  await expect(strip.getByRole("tab", { name: /^Inbox/ })).toHaveAttribute("aria-selected", "true");
  await expect(p.getByRole("button", { name: "Open UX11 inbox one" })).toBeFocused();

  // The card menu moves it without leaving the column and announces it.
  await p.getByRole("button", { name: "Actions for UX11 inbox two" }).click();
  await p.getByRole("menuitem", { name: "Move to…" }).click();
  await p.getByRole("menuitemradio", { name: "Next", exact: true }).click();
  await expect(p.getByText("Moved UX11 inbox two to Next")).toBeAttached();
  await expect(p.getByRole("button", { name: "Open UX11 inbox two" })).toHaveCount(0);
  await expect(p.getByRole("button", { name: "Open UX11 inbox one" })).toBeVisible();
  await context.close();
});

test("Notes on a phone: name and folder in the toolbar, one Source | Live | Preview control, the rest in the menu", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const ids = await seed(page);
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[1], "light");
  await p.addInitScript(() => localStorage.setItem("atlas-notes-preview", "off"));
  await settle(p, `/notes?open=${ids.noteId}`);
  const crumb = p.getByRole("navigation", { name: "Breadcrumb" });
  await expect(crumb).toContainText("Outline");
  await expect(crumb).toContainText("ux11 / Folder");
  expect((await crumb.textContent())!.trim()).not.toMatch(/^\/?…/);
  const header = p.locator(".notes-header");
  const buttons = await header.getByRole("button").allTextContents();
  expect(buttons.map((text) => text.trim()).filter(Boolean)).toEqual(["Source", "Live", "Preview"]);

  const modes = p.getByRole("group", { name: "Editor mode" });
  await modes.getByRole("button", { name: "Source" }).click();
  await expect(modes.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "true");
  await expect(modes.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "false");
  await modes.getByRole("button", { name: "Preview" }).click();
  await expect(modes.getByRole("button", { name: "Preview" })).toHaveAttribute("aria-pressed", "true");
  await expect(modes.getByRole("button", { name: "Source" })).toHaveAttribute("aria-pressed", "false");
  await expect(p.getByTestId("markdown-preview")).toBeVisible();
  await modes.getByRole("button", { name: "Live" }).click();
  await expect(modes.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "true");
  await expect(p.getByTestId("markdown-preview")).toHaveCount(0);

  // Everything else is in "…": details, task from selection, rename, delete.
  await p.getByRole("button", { name: "Note options" }).click();
  for (const name of ["Show links and details", "Task from selection", "Rename", "Delete"]) {
    await expect(p.getByRole("menuitem", { name })).toBeVisible();
  }
  await p.getByRole("menuitem", { name: "Show links and details" }).click();
  await expect(p.getByRole("region", { name: "Note details" })).toBeVisible();
  expect((await measure(p)).small).toEqual([]);

  // The tree and the note still take turns.
  await p.getByRole("button", { name: "Show notes list" }).click();
  await expect(p.getByRole("searchbox", { name: "Search notes" })).toBeVisible();
  await context.close();
});

test("Projects on a phone are cards with a colour dot, one summary line and a 44 px menu; capture is one control", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const ids = await seed(page);
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[0], "dark");
  await settle(p, "/projects");
  const card = p.locator(".project-item", { hasText: "UX11 Website relaunch" });
  await expect(card.locator(".project-dot")).toBeVisible();
  await expect(card).toContainText(/done · \d+%/);
  await expect(card).toContainText(/\d+ open/);
  await expect(card).toContainText("Target");
  const more = (await card.getByRole("button", { name: "Actions for UX11 Website relaunch" }).boundingBox())!;
  expect(more.width).toBeGreaterThanOrEqual(44);
  expect(more.height).toBeGreaterThanOrEqual(44);
  // The summary and the target date share a line, the date at the right.
  const summary = (await card.locator(".progress-text").boundingBox())!;
  const target = (await card.locator(".project-target").boundingBox())!;
  expect(Math.abs(summary.y - target.y)).toBeLessThan(8);
  expect(target.x).toBeGreaterThan(summary.x);
  // A tap anywhere on the card opens the project.
  await card.click({ position: { x: 150, y: 70 } });
  await expect(p).toHaveURL(new RegExp(`/projects/${ids.projectId}`));

  // Inbox and a project's Tasks tab: the capture button, not also an inline field.
  await settle(p, "/inbox");
  await expect(p.getByRole("button", { name: "Capture a task" })).toBeVisible();
  await expect(p.getByLabel("Task title")).toHaveCount(0);
  await settle(p, `/projects/${ids.projectId}`);
  await expect(p.getByRole("button", { name: "Capture a task" })).toBeVisible();
  await expect(p.getByLabel("Task title")).toHaveCount(0);
  await context.close();
});

test("the status bar link is a 44 px target on a phone when it shows (offline)", async ({ page, browser }) => {
  await seed(page);
  const { page: p, context } = await newPage(browser, await page.context().storageState(), SIZES[1], "light");
  await settle(p, "/inbox");
  await context.setOffline(true);
  const link = p.getByRole("contentinfo", { name: "Status bar" }).getByRole("link");
  await expect(link).toContainText(/Offline/);
  const box = (await link.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  const bar = (await p.getByRole("contentinfo", { name: "Status bar" }).boundingBox())!;
  const nav = (await p.getByRole("navigation", { name: "Bottom navigation" }).boundingBox())!;
  expect(bar.y + bar.height).toBeLessThanOrEqual(nav.y + 1);
  await context.setOffline(false);
  await context.close();
});

test("the standalone Board is gone: /board lands on Projects, view=board is ignored, no Board in the navigation", async ({ page }) => {
  await seed(page);
  await page.goto("/board");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole("heading", { name: "Projects", level: 1 })).toBeVisible();
  await expect(page.getByRole("link", { name: "Board", exact: true })).toHaveCount(0);
  await page.goto("/tasks?view=board");
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(page.locator(".task-row").first()).toBeVisible();
  await expect(page.getByRole("group", { name: "View" })).toHaveCount(0);
  await expect(page.locator(".board")).toHaveCount(0);
  await searchButton(page).first().click();
  await page.getByRole("combobox").fill("board");
  await expect(page.getByRole("option", { name: "Go to Board" })).toHaveCount(0);
});
