import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { apiCall, dateIn, ensureOwner } from "./helpers";

/**
 * UX-03 — the shared task row, its menus and the list keys (docs/ROADMAP.md, UX; ADR-0052).
 * Checks the acceptance criteria that only a real browser can measure: row height, the number of
 * persistent controls on an Inbox row, the phone Inbox height, and every row action driven from
 * the keyboard alone. Real API and a fresh database.
 */
const ZONE = "Europe/Stockholm";
test.use({ timezoneId: ZONE, locale: "en-GB", viewport: { width: 1440, height: 900 } });

type Task = { id: string; title: string; status: string; priority: string; revision: number; project_id: string | null; due_at: string | null };

const row = (page: Page, title: string) =>
  page.locator(".task-row").filter({ has: page.getByRole("button", { name: `Open ${title}`, exact: true }) });

async function tasks(page: Page): Promise<Map<string, Task>> {
  const all = await apiCall<{ tasks: Task[] }>(page, "GET", "/api/tasks?limit=500");
  return new Map(all.tasks.map((task) => [task.title, task]));
}

/** Nine Inbox items (one a subtask of a planned task) and nothing else in the Inbox. */
async function seed(page: Page) {
  await ensureOwner(page);
  // Journeys share one database: move earlier specs' leftovers out of the Inbox so it holds
  // exactly the nine items the size criteria are about.
  const inbox = await apiCall<{ tasks: Task[] }>(page, "GET", "/api/tasks?view=inbox&limit=500");
  for (const task of inbox.tasks) {
    await apiCall(page, "PATCH", `/api/tasks/${task.id}`, { status: "next", base_revision: task.revision });
  }
  const project = await apiCall<{ id: string }>(page, "POST", "/api/projects", { name: "UX3 Home" });
  const parent = await apiCall<{ id: string }>(page, "POST", "/api/tasks", {
    title: "UX3 launch the site",
    status: "next",
    due_at: `${dateIn(ZONE, 3)}T12:00:00`,
    time_zone: ZONE,
  });
  await apiCall(page, "POST", "/api/tasks", { title: "UX3 demo script", parent_task_id: parent.id });
  await apiCall(page, "POST", "/api/tasks", {
    title: "UX3 renew passport before the trip to the mountains next spring, with photos",
    priority: "high",
    tags: ["admin"],
    due_at: `${dateIn(ZONE, -2)}T23:59:00`,
    time_zone: ZONE,
  });
  for (const title of ["one", "two", "three", "four", "five", "six", "seven"]) {
    await apiCall(page, "POST", "/api/tasks", { title: `UX3 ${title}` });
  }
  return { projectId: project.id, parentId: parent.id };
}

test("rows: ≤ 40 px, ≤ 2 persistent controls on Inbox rows, subtasks name their parent, phone Inbox < 1000 px", async ({
  page,
  browser,
  baseURL,
}) => {
  const { projectId } = await seed(page);
  const done = await apiCall<Task>(page, "POST", "/api/tasks", {
    title: "UX3 done in project",
    status: "next",
    project_id: projectId,
    // Overdue once reopened: its card in the off-screen "In progress" column then carries sr-only text.
    due_at: `${dateIn(ZONE, -1)}T12:00:00`,
    time_zone: ZONE,
  });
  await apiCall(page, "PATCH", `/api/tasks/${done.id}`, { status: "completed", base_revision: done.revision });

  await page.goto("/inbox");
  await expect(page.locator(".task-row")).toHaveCount(9);
  await page.locator("h1").click(); // pointer and focus away from every row

  // Persistent controls: visible without hover or focus, the title excluded.
  const persistent = await page.locator(".task-row").evaluateAll((rows) =>
    rows.map((li) =>
      [...li.querySelectorAll<HTMLElement>("button, input")].filter((control) => {
        if (control.classList.contains("task-open")) return false;
        for (let el: HTMLElement | null = control; el && el !== li; el = el.parentElement) {
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
        }
        return true;
      }).length,
    ),
  );
  expect(persistent).toEqual(Array(9).fill(2));

  // The subtask names its parent; the overdue date is in the warning colour (not the body text).
  await expect(row(page, "UX3 demo script")).toContainText("Subtask of UX3 launch the site");
  const passport = row(page, "UX3 renew passport before the trip to the mountains next spring, with photos");
  await expect(passport.locator(".task-due")).toHaveClass(/is-overdue/);

  // The axe sweep (mu08) seeds plain rows; here the meta line is full (overdue, priority, tag,
  // parent, subtask count), in both themes, with a row hovered.
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await row(page, "UX3 demo script").hover();
    const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(result.violations.map((v) => `${theme}: ${v.id} ${v.nodes.map((n) => n.target).join(", ")}`)).toEqual([]);
  }
  await page.emulateMedia({ colorScheme: "light" });

  // Row height on the seeded lists (Week's narrow day columns are cards, not rows).
  const heights: Record<string, number> = {};
  for (const path of ["/", "/inbox", "/upcoming", "/tasks", `/projects/${projectId}`]) {
    await page.goto(path);
    // UX-07: a project's finished tasks are folded; open the group so its row is measured too.
    if (path.startsWith("/projects/")) await page.getByRole("button", { name: /^Completed \(/ }).click();
    await expect(page.locator(".task-row").first()).toBeVisible();
    const tallest = Math.max(
      ...(await page.locator(".task-row").evaluateAll((rows) => rows.map((r) => r.getBoundingClientRect().height))),
    );
    if (tallest > 40) heights[path] = tallest;
  }
  expect(heights, "lists with a row taller than 40px").toEqual({});

  // Project page fix: a completed task shows a checked checkbox (no "Complete" button) and reopens.
  await page.goto(`/projects/${projectId}`);
  await page.getByRole("button", { name: /^Completed \(/ }).click();
  const box = page.getByRole("checkbox", { name: "Complete UX3 done in project" });
  await expect(box).toBeChecked();
  await expect(page.getByRole("button", { name: /^Complete / })).toHaveCount(0);
  await box.click();
  await expect(box).not.toBeChecked();
  // The tick is optimistic, so wait for the server's state.
  await expect.poll(async () => (await tasks(page)).get("UX3 done in project")?.status).toBe("in_progress");

  // Phone: the nine-item Inbox fits in under 1,000 px.
  const phone = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    storageState: await page.context().storageState(),
    timezoneId: ZONE,
  });
  const mobile = await phone.newPage();
  await mobile.goto("/inbox");
  await expect(mobile.locator(".task-row")).toHaveCount(9);
  const height = await mobile.evaluate(() => document.documentElement.scrollHeight);
  expect(height).toBeLessThan(1000);
  // The board's cards carry screen-reader text; it must stay inside the scrolling columns, or a
  // phone widens its layout viewport (found in the UX-03 screenshot review).
  await mobile.goto("/board");
  await expect(mobile.getByRole("button", { name: "Open UX3 demo script" })).toBeVisible();
  expect(await mobile.evaluate(() => window.innerWidth)).toBe(390);
  await phone.close();
});

test("every row action works from the keyboard alone", async ({ page }) => {
  await ensureOwner(page);
  const inbox = await apiCall<{ tasks: Task[] }>(page, "GET", "/api/tasks?view=inbox&limit=500");
  for (const task of inbox.tasks) {
    await apiCall(page, "PATCH", `/api/tasks/${task.id}`, { status: "next", base_revision: task.revision });
  }
  await apiCall(page, "POST", "/api/projects", { name: "UX3K Garden" });
  for (const title of ["UX3K alpha", "UX3K bravo", "UX3K charlie", "UX3K delta", "UX3K echo"]) {
    await apiCall(page, "POST", "/api/tasks", { title });
  }
  await page.goto("/inbox");
  await expect(page.locator(".task-row")).toHaveCount(5);
  const open = (title: string) => page.getByRole("button", { name: `Open ${title}`, exact: true });
  await page.locator("h1").click();

  // j from outside the list lands on the first row; j/k move.
  await page.keyboard.press("j");
  await expect(open("UX3K alpha")).toBeFocused();
  await page.keyboard.press("j");
  await expect(open("UX3K bravo")).toBeFocused();
  await page.keyboard.press("k");
  await expect(open("UX3K alpha")).toBeFocused();

  // t: today. The row leaves the Inbox and focus moves to the row that took its place.
  await page.keyboard.press("t");
  await expect(open("UX3K alpha")).toBeHidden();
  await expect(open("UX3K bravo")).toBeFocused();

  // m: the project menu opens focused; a letter jumps to the project; Enter files it.
  await page.keyboard.press("m");
  const projectMenu = page.getByRole("menu", { name: "Move to project" });
  await expect(projectMenu).toBeVisible();
  await page.keyboard.type("ux3k"); // type-ahead: "UX3K Garden"
  await expect(page.getByRole("menuitemradio", { name: "UX3K Garden" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(open("UX3K bravo")).toBeHidden();
  await expect(open("UX3K charlie")).toBeFocused();

  // p: the priority menu, opened on the current value; Esc closes it and focus returns to the row.
  await page.keyboard.press("p");
  await expect(page.getByRole("menuitemradio", { name: "No priority" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await page.keyboard.press("p");
  await page.keyboard.press("Home"); // Back (a submenu starts with it)
  await page.keyboard.press("ArrowDown"); // Urgent
  await page.keyboard.press("ArrowDown"); // High
  await page.keyboard.press("Enter");
  await expect(row(page, "UX3K charlie").locator(".task-priority")).toHaveText("High");

  // The "…" menu from Tab: Tomorrow (the row leaves for Upcoming).
  await expect(page.getByRole("button", { name: "Actions for UX3K charlie" })).toBeVisible();
  await page.getByRole("button", { name: "Actions for UX3K charlie" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu", { name: "Actions for UX3K charlie" })).toBeVisible();
  await page.keyboard.press("ArrowDown"); // Tomorrow
  await expect(page.getByRole("menuitem", { name: "Tomorrow" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(open("UX3K charlie")).toBeHidden();

  // Pick a date from the hover/focus quick action: Tab reaches it from the row.
  await page.getByRole("checkbox", { name: "Complete UX3K delta" }).focus();
  await page.keyboard.press("Tab"); // title
  await page.keyboard.press("Tab"); // Schedule for today
  await page.keyboard.press("Tab"); // Pick a date
  await expect(page.getByRole("button", { name: "Pick a date for UX3K delta" })).toBeFocused();
  await page.keyboard.press("Enter");
  const picker = page.getByRole("dialog", { name: "Pick a date for UX3K delta" });
  await expect(picker.getByLabel("Due date")).toBeFocused();
  await picker.getByLabel("Due date").fill(dateIn(ZONE, 12));
  await page.keyboard.press("Enter");
  await expect(open("UX3K delta")).toBeHidden();

  // x completes; Enter opens the detail; Esc closes it and focus returns to the row.
  await open("UX3K echo").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Task details" })).toBeHidden();
  await expect(open("UX3K echo")).toBeFocused();
  await page.keyboard.press("x");
  await expect(page.getByText("Inbox zero")).toBeVisible();

  // Delete from the menu, with undo, all from the keyboard (on Upcoming, where charlie went).
  await page.goto("/upcoming");
  await open("UX3K charlie").focus();
  await page.keyboard.press("Tab"); // Schedule for today
  await page.keyboard.press("Tab"); // Pick a date
  await page.keyboard.press("Tab"); // Move to a project
  await page.keyboard.press("Tab"); // More actions
  await expect(page.getByRole("button", { name: "Actions for UX3K charlie" })).toBeFocused();
  await page.keyboard.press("Enter");
  await page.keyboard.press("End"); // Delete
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Deleted “UX3K charlie”");
  await page.getByRole("button", { name: "Undo" }).focus();
  await page.keyboard.press("Enter");
  await expect(open("UX3K charlie")).toBeVisible();

  const after = await tasks(page);
  expect(after.get("UX3K alpha")).toMatchObject({ status: "next" });
  expect(after.get("UX3K bravo")?.project_id).not.toBeNull();
  expect(after.get("UX3K charlie")).toMatchObject({ status: "next", priority: "high" });
  expect(after.get("UX3K delta")?.due_at).not.toBeNull();
  expect(after.get("UX3K echo")).toMatchObject({ status: "completed" });

  // Tasks page: x selects (bulk selection, MU-03) instead of completing.
  await page.goto("/tasks?q=UX3K");
  await expect(page.locator(".task-row")).toHaveCount(4);
  await page.locator("h1").click();
  await page.keyboard.press("j");
  await page.keyboard.press("x");
  await expect(page.getByText("1 selected")).toBeVisible();
  await page.keyboard.press("x");
  await expect(page.getByText("1 selected")).toBeHidden();
});
