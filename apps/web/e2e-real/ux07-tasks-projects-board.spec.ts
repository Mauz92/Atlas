import { mkdirSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, chooseFilter, dateIn, ensureOwner, filterBar, openDueFilter } from "./helpers";

/**
 * UX-07 — Tasks, Projects and Board polish (docs/ROADMAP.md, UX; ADR-0057). The things only a real
 * browser can measure or drive: the one-row filter bar, keyboard use of the chips, the floating
 * bulk bar, List | Board, the board keys `[` / `]`, the project rows and page (tabs, folded
 * Completed group), one date format, and no sideways scrolling at four widths in both themes.
 * Real API and a fresh database; screenshots go to $ATLAS_SHOT_DIR when it is set.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB", viewport: { width: 1440, height: 900 } });

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

type Task = { id: string; title: string; status: string; revision: number };
type Seed = { gardenId: string; shedId: string };
let seeded: Seed | null = null;

async function setStatus(page: Page, title: string, status: string) {
  const all = await apiCall<{ tasks: Task[] }>(page, "GET", "/api/tasks?limit=500");
  const task = all.tasks.find((t) => t.title === title);
  if (!task) throw new Error(`no task ${title}`);
  await apiCall(page, "PATCH", `/api/tasks/${task.id}`, { status, base_revision: task.revision });
}

/** A project with tasks in every state, a second project, and 22 loose tasks (for scrolling). */
async function seed(page: Page): Promise<Seed> {
  await ensureOwner(page);
  if (seeded) return seeded;
  // A failed test restarts the worker (module state is lost) but not the database: seed once.
  const existing = await apiCall<{ projects: { id: string; name: string }[] }>(page, "GET", "/api/projects");
  const garden0 = existing.projects.find((p) => p.name === "UX7 Garden");
  const shed0 = existing.projects.find((p) => p.name === "UX7 Shed");
  if (garden0 && shed0) {
    seeded = { gardenId: garden0.id, shedId: shed0.id };
    return seeded;
  }
  const garden = await apiCall<{ id: string }>(page, "POST", "/api/projects", {
    name: "UX7 Garden",
    description: "Plant the orchard",
    start_date: dateIn(ZONE, -3),
    target_date: dateIn(ZONE, 20),
  });
  const shed = await apiCall<{ id: string }>(page, "POST", "/api/projects", { name: "UX7 Shed" });
  const make = (title: string, fields: Record<string, unknown> = {}) =>
    apiCall(page, "POST", "/api/tasks", { title, status: "next", project_id: garden.id, ...fields });
  await make("UX7 dig", { priority: "high", due_at: `${dateIn(ZONE, 1)}T12:00:00`, time_zone: ZONE });
  await make("UX7 sow");
  await make("UX7 water", { status: "in_progress" });
  await make("UX7 plan");
  await make("UX7 old");
  await setStatus(page, "UX7 plan", "completed");
  await setStatus(page, "UX7 old", "archived");
  for (let i = 1; i <= 22; i += 1) {
    await apiCall(page, "POST", "/api/tasks", { title: `UX7 bulk ${String(i).padStart(2, "0")}`, status: "next" });
  }
  seeded = { gardenId: garden.id, shedId: shed.id };
  return seeded;
}

const rows = (page: Page) => page.locator("ul.task-list > li");

test("filter bar: one row, chips work from the keyboard, URL state, floating bulk bar", async ({ page }) => {
  await seed(page);
  await page.goto("/tasks?q=UX7");
  await expect.poll(() => rows(page).count()).toBeGreaterThan(20);

  // One row at 1440 px: the bar is a single control tall and every control shares that row.
  const bar = filterBar(page);
  const box = await bar.boundingBox();
  expect(box?.height ?? 999).toBeLessThanOrEqual(48);
  const tops = await bar
    .locator("input, button")
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top / 8)));
  expect(new Set(tops).size, "controls on one row").toBeLessThanOrEqual(2);

  // Keyboard: focus a chip, Enter opens its menu on the current value, ↓ + Enter chooses.
  const status = bar.getByRole("button", { name: "Status: Open" });
  await status.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Status" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitemradio", { name: "Open", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/status=all/);
  await expect(bar.getByRole("button", { name: "Status: All statuses" })).toBeFocused();

  // Priority and Due chips show their values and Reset clears them; the search text stays in the box.
  await chooseFilter(page, "Priority", "High");
  await expect(page).toHaveURL(/priority=high/);
  const due = await openDueFilter(page);
  await due.getByRole("button", { name: "Next 7 days" }).click();
  await expect(bar.getByRole("button", { name: "Due: Next 7 days" })).toBeVisible();
  await expect.poll(() => rows(page).count()).toBe(1);
  await page.keyboard.press("Escape");
  await expect(bar.getByRole("button", { name: /^Due: Next 7 days/ })).toBeFocused();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await page.goto("/tasks?q=UX7");

  // The bulk bar floats: select a row at the top of a long list, scroll to the bottom, still in view.
  await expect.poll(() => rows(page).count()).toBeGreaterThan(20);
  await page.getByLabel("Select UX7 bulk 01").check();
  const toolbar = page.getByRole("toolbar", { name: "Bulk actions" });
  await expect(toolbar).toContainText("1 selected");
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(toolbar).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(toolbar).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect(toolbar).toBeInViewport();
  await toolbar.getByRole("button", { name: "Clear selection" }).click();
  await expect(toolbar).toBeHidden();
  await expect(page.getByLabel("Select UX7 bulk 01")).not.toBeChecked();
});

test("tasks page board: List | Board toggle, compact cards, [ and ] move the focused card", async ({ page }) => {
  const { gardenId } = await seed(page);
  await page.goto("/tasks?q=UX7+dig");
  await expect.poll(() => rows(page).count()).toBe(1);
  await page.getByRole("group", { name: "View" }).getByRole("button", { name: "Board" }).click();
  await expect(page).toHaveURL(/view=board/);
  await page.reload();
  await expect(page.getByRole("group", { name: "View" }).getByRole("button", { name: "Board" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const column = (name: string) => page.getByRole("region", { name, exact: true });
  const open = (name: string) => column(name).getByRole("button", { name: "Open UX7 dig" });
  await expect(open("Next")).toBeVisible();
  // Archived is behind a toggle; completed work still has its column.
  await expect(page.getByRole("region", { name: "Archived", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Show archived/ })).toBeVisible();

  // Compact card: the title, an icon-only flag and a due date; no tags or counts.
  const card = page.locator(".board-card").filter({ hasText: "UX7 dig" });
  await expect(card.locator(".task-priority")).toContainText("High priority");
  await expect(card.locator(".task-due")).toBeVisible();

  // `]` moves the card one allowed column right, focus follows, the server has it.
  const task = async () => {
    const all = await apiCall<{ tasks: Task[] }>(page, "GET", `/api/tasks?project_id=${gardenId}&limit=500`);
    return all.tasks.find((t) => t.title === "UX7 dig");
  };
  await open("Next").focus();
  await page.keyboard.press("]");
  await expect(open("In progress")).toBeVisible();
  await expect(open("In progress")).toBeFocused();
  await expect.poll(async () => (await task())?.status).toBe("in_progress");
  await page.keyboard.press("[");
  await expect(open("Next")).toBeFocused();
  await expect.poll(async () => (await task())?.status).toBe("next");
  // Inbox is the left edge: one more `[` lands there, the next one only announces it.
  await page.keyboard.press("[");
  await expect(open("Inbox")).toBeFocused();
  await page.keyboard.press("[");
  await expect(open("Inbox")).toBeFocused();
  await expect(page.getByText("UX7 dig cannot move left from Inbox")).toBeAttached();
  await page.keyboard.press("]");
  await expect(open("Next")).toBeFocused();
  await expect.poll(async () => (await task())?.status).toBe("next");
  // The card menu stays the pointer / touch alternative.
  await page.getByRole("button", { name: "Actions for UX7 dig" }).click();
  await page.getByRole("menuitem", { name: "Move to…" }).click();
  await expect(page.getByRole("menuitemradio", { name: "In progress" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("projects: rows with progress, open count and target; archive lives in the menu; one date format", async ({ page }) => {
  const { gardenId, shedId } = await seed(page);
  await page.goto("/projects");
  const garden = page.locator(".project-item").filter({ has: page.getByRole("link", { name: "UX7 Garden" }) });
  await expect(garden).toBeVisible();
  await expect(garden.getByRole("progressbar")).toBeVisible();
  // 5 tasks in the project: sow, dig, water open; plan done; old archived -> "3 open" counts
  // progress.total - completed as the server derives it, so read it back instead of assuming.
  const project = await apiCall<{ progress: { total: number; completed: number } }>(page, "GET", `/api/projects/${gardenId}`);
  await expect(garden).toContainText(`${project.progress.total - project.progress.completed} open`);
  await expect(garden).toContainText("Target ");
  expect(await page.locator("main").innerText()).not.toMatch(ISO_DATE);
  // No visible Archive button; it is in the row menu.
  await expect(page.getByRole("button", { name: /^Archive/ })).toHaveCount(0);

  await page.getByRole("button", { name: "Actions for UX7 Shed" }).click();
  await page.getByRole("menuitem", { name: "Archive project" }).click();
  await expect(page.getByRole("link", { name: "UX7 Shed" })).toHaveCount(0);
  await page.getByRole("button", { name: /^Show archived/ }).click();
  await expect(page.getByRole("link", { name: "UX7 Shed" })).toBeVisible();
  await page.getByRole("button", { name: "Actions for UX7 Shed" }).click();
  await page.getByRole("menuitem", { name: "Restore project" }).click();
  await expect(page.getByRole("button", { name: /^Show archived/ })).toHaveCount(0);
  expect(shedId).toBeTruthy();

  // The project page: header, tabs, folded Completed group, dates in the app's format.
  await page.goto(`/projects/${gardenId}`);
  await expect(page.getByRole("heading", { name: "UX7 Garden", level: 1 })).toBeVisible();
  await expect(page.locator(".project-header .pill")).toHaveText("Active");
  await expect(page.locator(".project-meta")).toContainText("Starts ");
  await expect(page.locator(".project-meta")).toContainText("Target ");
  expect(await page.locator("main").innerText()).not.toMatch(ISO_DATE);
  const tabs = page.getByRole("tablist", { name: "Project sections" });
  await expect(tabs.getByRole("tab")).toHaveText(["Tasks", "Board", "Notes"]);
  await expect(page.getByRole("button", { name: "Open UX7 dig" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open UX7 plan" })).toHaveCount(0);
  await page.getByRole("button", { name: "Completed (1)" }).click();
  await expect(page.getByRole("checkbox", { name: "Complete UX7 plan" })).toBeChecked();
  await page.getByRole("button", { name: "Archived (1)" }).click();
  await expect(page.getByRole("button", { name: "Open UX7 old" })).toBeVisible();

  // Tabs from the keyboard; the tab is in the URL.
  await tabs.getByRole("tab", { name: "Tasks" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/tab=board/);
  await expect(page.getByRole("region", { name: "In progress" })).toBeVisible();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(height, "project board height at 1440 px").toBeLessThanOrEqual(1200);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("heading", { name: "Linked notes" })).toBeVisible();
});

test("layout: no sideways scrolling at four widths in both themes, and screenshots", async ({ page }) => {
  test.setTimeout(120_000);
  const { gardenId } = await seed(page);
  const shots = process.env.ATLAS_SHOT_DIR;
  if (shots) mkdirSync(shots, { recursive: true });
  const targets: [string, string][] = [
    ["tasks", "/tasks?q=UX7"],
    ["tasks-board", "/tasks?q=UX7&view=board"],
    ["projects", "/projects"],
    ["project", `/projects/${gardenId}`],
    ["project-board", `/projects/${gardenId}?tab=board`],
  ];
  const wide: Record<string, number> = {};
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate((value) => localStorage.setItem("atlas-theme", value), theme);
    for (const width of [1440, 1024, 720, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, url] of targets) {
        await page.goto(url);
        await expect(page.getByRole("main")).toBeVisible();
        await expect(page.getByText(/^Loading/)).toHaveCount(0);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 0) wide[`${name} ${theme} ${width}px`] = overflow;
        if (shots && (width === 1440 || width === 390)) {
          await page.screenshot({ path: path.join(shots, `${name}-${theme}-${width}.png`) });
        }
      }
    }
  }
  expect(wide, "pages that scroll sideways (px of overflow)").toEqual({});
});
